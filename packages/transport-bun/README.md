# @iirc/transport-bun

The production adapter of the Transport port, over TCP and TLS on Bun. It keeps every promise in [the port's written interface](../runtime/README.md#transport) and every law in `transportLaws`, which its tests run over both TLS and plain TCP against real loopback listeners.

```ts
import { layer } from "@iirc/transport-bun";

const TransportLive = layer(); // production: every option at its default
```

`makeBunTransport(options)` gives the bare `TransportService`, and `layer(options)` provides it as the `Transport` service.

## How it is built

It uses Effect's socket from `@effect/platform-bun` (`BunSocket.makeNet`, which is Effect's Node socket over Bun's `node:net` and `node:tls`), as [ADR 0005](../../docs/adr/0005-effect-wins-where-it-overlaps-bun.md) asks. Effect covers every need: it connects, upgrades to TLS with SNI, trust anchors, and hostname checks, reads only when pulled, and makes writes wait for `drain`. Nothing calls `Bun.connect` directly.

## What it guarantees beyond the port

- **Reading is pulled.** The socket is read only when the `events` stream asks for more. While nothing reads the events, a flooding Ircd waits in the kernel, so memory does not grow. Within a Line, the framer keeps at most `maxReceivedBytes + 1` bytes, however the bytes arrive.
- **Every way it ends is decided by error kind and code, never by error message.**

  | What happened | `Closed` reason |
  | --- | --- |
  | The far end closed cleanly | `Ended` |
  | `ECONNRESET`, `EPIPE`, or any other read or write error | `Reset` |
  | `ECONNREFUSED` | `Refused` |
  | A name that does not resolve, an unreachable network or host, or any other connect error | `Unreachable` |
  | The connect, handshake, or write timer ran out, or `ETIMEDOUT` | `TimedOut` |
  | Any TLS failure: an untrusted certificate, a wrong name, an Ircd that answers in plaintext, or a closed handshake | `Tls` |
  | `hangup` | `HungUp` |

- **TLS is verified, always.** It verifies against the system's trust store (`tls.getCACertificates("system")`), or against Bun's bundled Mozilla roots where the system has none, plus any `trust` roots. `rejectUnauthorized` is always on. SNI carries the address's host. For an address given as an IP, which SNI may not carry (RFC 6066), the certificate is verified against that IP. A TLS failure never falls back to plaintext.
- **`Opened` over TLS comes after the handshake.** The handshake has its own timer, which starts once TCP is open.
- **Ending destroys the socket at once.** `hangup`, an error, a timer, and closing the Scope all destroy the socket immediately, without waiting for unsent bytes to flush, because a peer that never reads would never let them flush. The kernel still delivers whatever it has already accepted. So a `QUIT` that `send` has returned from survives a `hangup` right after it, unless the far end had already stopped reading. No socket outlives its Connection. The tests check this from the far end after every way a Connection can end.
- **`send` applies backpressure.** It returns once the socket has taken the bytes. When the far end has stopped reading, it waits for up to `writeTimeout`. If the wait runs out, the Connection ends as `TimedOut`, and `send` returns. A `send` after the Connection has ended returns at once.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `connectTimeout` | 30 seconds | How long reaching the Ircd may take: `route`, resolving the name, and the TCP connect. |
| `handshakeTimeout` | 30 seconds | How long the TLS handshake may take once TCP is open. |
| `writeTimeout` | 60 seconds | How long one `send` may wait for a far end that has stopped reading. |
| `route` | the address itself | Where to connect for an `IrcdAddress`, as `{ host, port }`. SNI and the certificate are still checked against the address's own host, so a route can redirect a dial without weakening TLS. The loopback harness uses it. |
| `trust` | none | Extra certificate authorities, as PEM, added to the system roots. A test trusts its own self-signed certificate this way. |

## What it does not do

- It does not decode, parse, or check Lines in either direction. `send` writes whatever bytes it is given.
- It has no timers about Lines, such as silence or ping. Those belong to the Client.
- It does not reconnect, choose another Ircd, or try plaintext after TLS fails. Those decisions belong to the Client.
- It does not present client certificates (SASL `EXTERNAL`), use a proxy, or support STARTTLS. Nothing needs them yet.
- It does not pick an address family or race addresses (Happy Eyeballs) beyond what Bun's `node:net` does.
- A real SYN that is never answered is not tested, since loopback always answers one. The connect timer is tested with a `route` that never finishes, and it covers both cases.

## Tests

`bun run test` runs the following, using only loopback and no external network, in under a second:

- `src/laws.test.ts`: every `transportLaws` law, over TLS with a self-signed certificate for `irc.test` made by `openssl` for the run, and again over plain TCP. The harness in `src/testing/loopback.ts` plays `TestIrcd`. It opens a listener for each call and routes the dial there, or routes it to a refusing port or an `.invalid` name when the call is refused.
- `src/framer.test.ts`: framing byte by byte. It covers a Line split across reads, CRLF split between reads, several Lines in one read, an unfinished Line at the end, and a long Line over many reads cut at `maxReceivedBytes`.
- `src/transport.test.ts`: the failures and edge cases the laws cannot see. These are a refused dial, an unknown host, a connect timeout, SNI, an untrusted certificate, a wrong-name certificate, a plaintext answer to TLS, a handshake timeout, a reset over TCP and TLS, a stalled write, a flood that waits in the kernel, a `send` before `Opened`, a hangup while connecting, and the closing of the Scope.
