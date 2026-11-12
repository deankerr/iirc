# @iirc/transport-bun

The production adapter of the Transport port, over TCP and TLS on Bun. It keeps every law in `transportLaws`, which its tests run over both TLS and plain TCP against real loopback listeners.

```ts
import { layer } from "@iirc/transport-bun";

const TransportLive = layer(); // production: every option at its default
```

`makeBunTransport(options)` gives the bare `TransportService`, and `layer(options)` provides it as the `Transport` service.

## How it is built

It uses Effect's socket from `@effect/platform-bun` (`BunSocket.fromDuplex`, Effect's Node socket over Bun's `node:net` and `node:tls`), as ADR 0005 asks. Effect reads only when pulled and makes writes wait for `drain`.

`src/open.ts` opens the socket itself, with `node:net` and then `node:tls`, and hands it to `fromDuplex`. Effect's own TLS upgrade takes only `servername` as the identity, and SNI may not carry an IP. Without a `servername`, a routed IP would be checked against the address it reached rather than the address dialled. Opening TLS directly lets the dialled host go to `host` and `checkServerIdentity`, apart from SNI. Nothing calls `Bun.connect` directly.

## What it guarantees beyond the port

- **A Line ends at CR or at LF, and empty Lines are skipped.** So CRLF, a bare LF, and a bare CR each end a Line, including a CRLF split across reads, which yields the Line and then an empty Line that is skipped. An Ircd that ends Lines with a bare CR does not have two Lines merged into one.

- **Reading is pulled.** The socket is read only when the `events` stream asks for more. While nothing reads the events, a flooding Ircd waits in the kernel, so memory does not grow. Within a Line, the framer keeps at most `maxReceivedBytes` bytes, however the bytes arrive.
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

- **TLS is verified, always.** It verifies against the system's trust store (`tls.getCACertificates("system")`), or against Bun's bundled Mozilla roots where the system has none, plus any `trust` roots. `rejectUnauthorized` is always on. The certificate is always checked against the host that was dialled (`IrcdAddress.host`), never against where `route` sent the dial. SNI carries that host too, except for an IP, which SNI may not carry (RFC 6066). Then no SNI is sent, and the certificate must still name that IP. A TLS failure never falls back to plaintext.
- **`Opened` over TLS comes after the handshake.** The handshake has its own timer, which starts once TCP is open.
- **`hangup` is a bounded graceful close.** It ends the socket's write side and waits until everything already sent has been written, so a `QUIT` sent just before it arrives. Then it destroys the socket. The wait lasts at most `hangupTimeout`, so a peer that has stopped reading cannot hold it longer. The Connection still ends with one `Closed HungUp`, which is reported as soon as `hangup` starts. Interrupting a `hangup` cuts only the wait short, and the socket is destroyed anyway.
- **Every other ending destroys the socket at once.** An error, a timer, or the closing of the Scope destroys the socket without waiting for unsent bytes, because a peer that never reads would never let them flush. No socket outlives its Connection. The tests check this after every way a Connection can end. Where the far end is paused, they check that our socket was destroyed while the far end was still paused, not merely that the far end later saw an end.
- **`send` applies backpressure.** It returns once the socket has taken the bytes. When the far end has stopped reading, it waits for up to `writeTimeout`. If the wait runs out, the Connection ends as `TimedOut`, and `send` returns. A `send` after the Connection has ended returns at once.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `connectTimeout` | 30 seconds | How long reaching the Ircd may take: `route`, resolving the name, and the TCP connect. |
| `handshakeTimeout` | 30 seconds | How long the TLS handshake may take once TCP is open. |
| `writeTimeout` | 60 seconds | How long one `send` may wait for a far end that has stopped reading. |
| `hangupTimeout` | 2 seconds | How long `hangup` may wait for what was sent to be written before it destroys the socket. |
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

`bun run test` runs every `transportLaws` law over TLS, with a self-signed certificate that `openssl` makes for the run, and again over plain TCP. It uses only loopback.
