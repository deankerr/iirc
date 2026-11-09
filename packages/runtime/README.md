# @iirc/runtime

The Runtime drives one Client per Network. It journals each input, steps the Client, journals the outputs, and carries them out through its ports. This package holds the Runtime and the ports it drives through.

This README is the written interface of both. The types are in `src/`, the in-memory adapters and the laws are in `src/testing/`, and [the proposal](../../docs/notes/2026-11-07-architecture-proposal.md#1-the-system-as-a-hexagon) says why the hexagon has this shape.

## The Runtime

```ts
layerRuntime(client): Layer<Runtime, DecodersMissing | JournalFailed, Journal | Transport | Vault>

configure(network, configuration): Effect<Sequence, NetworkStopped>      // the first one adds the Network
say(network, { kind, target, text, intent? }): Effect<{ intent, sequence }, UnknownNetwork | NetworkStopped>
retry(network): Effect<Sequence, UnknownNetwork | NetworkStopped>
known(network): Effect<Knowledge, UnknownNetwork>
inspect(network): Effect<NetworkInspection, UnknownNetwork>             // { status, client, connections, timers }
networks: Effect<ReadonlyMap<NetworkId, NetworkStatus>>                 // Running | Stopped { reason }
news({ after? }): Stream<Happened, JournalFailed>                        // { network, sequence, at, news }, never ends
```

`Runtime` is an Effect service, imported from `@iirc/runtime`. `layerRuntime` takes the Client to drive, which is `client` from `@iirc/client` in the Daemon and a scripted Client in tests, and needs the Transport, the Journal, and the Vault. It reads time from Effect's `Clock`, and names intents with Effect's `Random`. Closing the Layer's Scope is shutdown.

- **Owner inputs wait until they are stepped.** `configure`, `say`, and `retry` give the Input's sequence once it is journaled, stepped, and its outputs carried out. `say` names the intent, so its `Refused`, `Message`, and `Confirmed` News can be matched to it. A Network that has stopped fails them with `NetworkStopped`, at once or as it stops, so none waits forever. Closing the Runtime stops every Network with the reason `The Runtime closed`, and fails every call made after, including a `configure` that would add a Network.
- **`NetworkStopped` does not mean the input was refused.** The Network may have stopped, by a failure or by shutdown, after the Input was durably appended and before the caller heard back. Then the Input is in the Journal, a restart folds it, and some of its outputs may already have been carried out, so a `say` may have been sent. A restart rebuilds state from the journaled Inputs and never carries out a past step's outputs again, so it may equally not have been sent. The outcome is uncertain, and saying it again can send a Message twice. To tell, name the intent: pass `intent` to `say`, and after a `NetworkStopped`, read `news` once the Runtime is running again. The Client reports every `Say` it steps under its intent, as a `Message` with `ours`, or a `Refused`. If one is there, the `Say` was journaled and stepped, though whether its Line left before shutdown is unknown. If none is there by the Journal's end, it never was, and saying it again is safe. `configure` and `retry` can be given again freely: a `Configured` is the whole Configuration, and a second `Retry` changes nothing a first did not.
- **`known` and `inspect` read the Client as it is now.** `inspect` adds what the Runtime holds: whether the Network is running, the Connections it holds a Link for, and the timers it has set.
- **News is derived from the Journal.** `news` follows the Journal from the start, folds each Network's Inputs from `initial`, and gives each step's News with its Network, the sequence of its Input, and its `at`, for steps after `after`, and then live. A reader that resumes after the last sequence it has misses nothing, and sees exactly what the Runtime's own fold saw. Each reader folds from the start, which is simple and costs time on a long Journal. Snapshots or a shared projection can come when one is slow.

### Driving a Network

Each Network has one fiber, which takes its inputs one at a time from one queue: Owner inputs, Transport events, and timer firings. The queue is bounded, so a flooding Ircd waits on its own socket rather than growing memory. For each input, in order:

1. Give it its `at`, from the Clock, sampled when processing of the input begins.
2. Append the `Input`.
3. Step the Client.
4. Append its `Outputs` with `of` set to the Input's sequence. A step with no outputs appends none.
5. Carry out the outputs, in order.
6. Step each `SendSecret` that could not be filled as an `Unfilled`, in order, the same way.

The sequence alone orders the Journal. Networks run side by side, so one may sample its `at` before another and append after it, and a Clock may move backwards, so `at` is not ordered by sequence. A Timeline orders by `at` within its Network, as [the Client's README](../client/README.md#news) says.

Carrying out each output:

| Output | What the Runtime does |
| --- | --- |
| `Dial` | Opens a Scope for the Connection and `dial`s in it. Its events become `Opened`, `Received`, and `Closed` inputs with that Connection's id. Once its `Closed` is stepped, the Scope is closed. |
| `Send` | `encode`s the Line and sends it. A `Rejected` is a bug upstream: it is logged, and nothing is sent. A Line for a Connection the Runtime holds no Link for is dropped, because the Client is authoritative and judges stale Connections itself. |
| `SendSecret` | `reveal`s the Credential, `fillSecret`s the Line, `encode`s each Line, and sends them. Nothing is sent if any step fails, and the input that follows is `Unfilled`: `Missing` for `CredentialMissing`, `Unavailable` for `VaultFailed`, `Unsendable` when `fillSecret` or `encode` refuses. The value is never logged or journaled. |
| `Hangup` | Calls `hangup` on the Link. The `Closed` that follows is stepped like any other. |
| `Wake` | Sets one timer per `TimerId`, replacing the earlier one, with `sleepUntil`, or cancels it for `null`. When it is due, `Fired { at, due, timer }` is queued, with `due` as the `Wake` set it. A firing that went stale while it waited is stepped all the same, and the Client ignores it. |

The timer table `inspect` shows is projected with `timers` from every step's input and outputs, the same projection a restart folds.

### Restart

On start, the Runtime refuses with `DecodersMissing` unless `missingDecoders()` is empty. Then it reads every Entry once. For each Network, it folds the Inputs from `initial`, keeping only the state and the timer table that `timers` projects from each step. Journaled Outputs are never read back: the outputs come from the refold, so a parser fix repairs history (ADR 0002), and a fixed Client asks for what it would have asked for. It then sets every timer in the table, appends and steps a `Started`, and drives the Network as before. A timer already due fires at once.

A Connection open at shutdown is over, and the `Started` says so to the Client. It does not get a `Closed`, as closing a Connection's Scope gives none.

### Failure

- **A `JournalFailed` stops its Network.** The Runtime does not step an input it did not keep, or carry out outputs it did not keep. The Network's Connections are hung up and its timers stopped, it reports `Stopped` with the reason, the failure is logged, and other Networks carry on. It stays stopped until the Runtime starts again.
- **A defect stops only its Network.** The Client is total, so one that throws has a bug. That Network stops as above. On restart its refold stops at the same input, so it stays stopped, with the state from before that input, and the other Networks start.
- **An Ircd reaches only its own Network.** Its bytes go to its own Client through its own queue.
- **Shutdown** stops every Network's fiber, hangs up every Connection, and stops every timer. Nothing that happens after is journaled. Each Network reports `Stopped` with `The Runtime closed`, which is not logged as an error, and an Owner input still waiting fails with `NetworkStopped`. A graceful `QUIT` on shutdown can come later, as an input the Client answers.

Every log goes through `Effect.log*`, annotated with the Network.

### Not yet

- **Flood pacing.** The Runtime sends each Line as soon as it is carried out. A burst, such as many joins or a long `say`, can get the Connection killed for flooding. Pacing belongs to the Outbox, a later module that sits between the Runtime and the Transport.
- **The Owner API and the Daemon.** The HTTP API and the composition root that wires the production adapters together are the Daemon's.
- **End-to-end runs against real Ircds.** They will live in the Daemon's package. This package's tests run the real Client on the in-memory ports, on a `TestClock`.

| Port | Its job | Imports | In-memory adapter |
| --- | --- | --- | --- |
| Transport | Dial an Ircd, carry Lines both ways, say how it ended | `@iirc/runtime/transport` | `makeMemoryTransport`, an in-memory pair |
| Journal | Append records durably, read them back, follow the tail | `@iirc/runtime/journal` | `makeMemoryJournal` |
| Vault | Hold Credentials, give a value at the last moment | `@iirc/runtime/vault` | `makeMemoryVault` |
| Clock | Tell the time, and wake at a time | `@iirc/runtime/clock` | `TestClock` from `effect/testing` |

Each port is an Effect service. An adapter provides it as a Layer, from its own package, which the Runtime never imports. So the Runtime uses no platform service, such as `FileSystem`, `Config`, or a socket, reads no wall clock, such as `DateTime.nowUnsafe`, and builds no Logger: it logs with `Effect.log*`, and the composition root builds the Logger. The lint fence catches the obvious cases, such as Bun, Node, `@effect/*`, `effect/unstable/*`, `Date`, `fetch`, `process`, `console`, and `Math.random`, and another package reached by a relative path. Review catches the rest.

## Transport

```ts
dial(address: IrcdAddress): Effect<Link, never, Scope>
Link = { events: Stream<LinkEvent>, send(bytes): Effect<void>, hangup: Effect<void> }
LinkEvent = Opened | Received { bytes } | Closed { reason: CloseReason }
```

- **It never fails.** A refused, unreachable, or timed-out dial, a TLS failure, a reset, and a stalled write all end as `Closed` with a reason. The Runtime journals that as a `Closed` input.
- **Events come in order.** At most one `Opened`, then any number of `Received`, then exactly one `Closed`, and then the stream ends. A failed dial gives `Closed` with no `Opened`. Over TLS, `Opened` comes after the handshake. `events` is read once.
- **It frames Lines.** `Received` holds one Line's bytes without its line ending. A Line ends at CR or LF, and empty Lines are skipped, so CRLF, a bare LF, and a bare CR each end one, as Ircds differ. A Line longer than `maxReceivedBytes` (8191 tag bytes plus 510) is cut to that length, and the rest of it is dropped. An unfinished Line when the Connection ends is dropped. The laws check skipping and cutting through `TestCall.say`. A byte-level adapter also tests its framing directly: each line ending, CRLF split across reads, several Lines in one read, and an unfinished Line at the end.
- **It decodes nothing.** Bytes go to the Client as they came, so a parser fix repairs history on replay (ADR 0002).
- **`send` writes one Line's bytes,** line ending included. Before `Opened` or after `Closed`, it does nothing.
- **`hangup` ends the Connection** with `Closed` `HungUp`, unless it had already ended for another reason. It first lets what was already sent reach the Ircd, within a bound, so a `QUIT` arrives, and a peer that never reads cannot hold it past the bound. An interrupted `hangup` either ended it or did nothing, so another `hangup` still works.
- **Closing the Scope** ends the Connection without a `Closed`, because nothing is left to read it.
- **TLS is verified.** Certificates are checked against the system roots, and SNI is sent. Falling back to plaintext is the Client's decision, and under STS it never does.
- **Socket timers are the Transport's.** Connecting, the TLS handshake, and a stalled write each end as `Closed` `TimedOut`. A TLS failure, such as a certificate that is not trusted or names another host, ends as `Closed` `Tls`. Timers about Lines, such as silence, are the Client's.

## Journal

```ts
append(record: JournalRecord): Effect<Sequence, JournalFailed>
read({ after?, network? }): Stream<Entry, JournalFailed>    // up to the end as it stood
follow({ after?, network? }): Stream<Entry, JournalFailed>  // and then each new Entry
Entry = { sequence: Sequence, record: JournalRecord }
JournalRecord = Input { network, input } | Outputs { network, of, outputs }
```

- **One Journal for the Daemon.** Every Network's Entries share one sequence, and each record names its Network.
- **Appends are durable** before `append` returns, and are numbered in the order they complete. Sequences only increase, and may skip numbers.
- **An append is whole or absent.** One interrupted is either kept, and read and followed like any other, or not kept at all.
- **`read` and `follow` give each Entry once, in order.** `follow` gives the past and then each new Entry as it is appended, with no gap between them, and never ends.
- **Records are Schemas.** Every adapter stores their encoding, so the in-memory one does too, and a record that cannot be stored fails in tests. A `SendSecret` is recorded with the Credential's name, never its value.
- **Versioned, not migrated.** `journalVersion` is 1. An adapter that finds another version refuses to open with `JournalVersionMismatch`. Nothing is migrated until the shape has settled. No Daemon has written a Journal yet, so until the first one does, the records' shape changes freely under version 1. From then on, any change that an earlier Journal would not decode under bumps the version.
- **`JournalFailed`** means the Journal could not be written or read. The Runtime stops that Network rather than step an input it did not keep.

Before it reads a Journal, the Runtime checks that `missingDecoders()` from `@iirc/protocol/line` is empty, and refuses to start otherwise. Replay is exact on the Bun pinned in the root `package.json`. Another runtime, or another version of Bun, may decode some fallback bytes differently, as a parser fix would (ADR 0002).

The Runtime's order for each input, and how it restarts, are in [Driving a Network](#driving-a-network) and [Restart](#restart).

## Vault

```ts
reveal(name): Effect<Redacted<string>, CredentialMissing | VaultFailed>
hold(name, value: Redacted<string>): Effect<void, VaultFailed>
forget(name): Effect<void, VaultFailed>
names: Effect<ReadonlySet<CredentialName>, VaultFailed>
```

- **Values are always `Redacted`,** so a value cannot be logged or journaled by accident. Only `fillSecret` in `@iirc/protocol` unwraps one, and its result is sent, never kept.
- **The Runtime reveals at the last moment,** for each `SendSecret`, and lets go of the value once the Line is sent.
- **A Credential that cannot be revealed sends nothing.** The Runtime steps an `Unfilled` input naming the `SecretLine`, so the Client decides what follows. Its reason is `Missing` for `CredentialMissing`, which the Owner must fix, `Unavailable` for `VaultFailed`, which may pass, or `Unsendable` when `fillSecret` refuses the value, such as a password with a line break, which the Owner must fix. The `Unfilled` input never holds the value or the refused Lines.
- **`VaultFailed` can come from any call,** `reveal` and `names` included, whenever the Vault cannot be read, such as when its file's directory is missing.
- **`names` lists names, never values.** The Owner API holds and forgets Credentials, and can list them, but never reads one back.
- **Only passwords for now.** SASL `EXTERNAL` would add a client certificate as a kind of Credential, which `Dial` names.

## Clock

```ts
now: Effect<Instant>
sleepUntil(at: Instant): Effect<void>
```

The Clock port is Effect's own `Clock`. Its live adapter is the default Clock, and its test adapter is `TestClock`. Every input's `at` comes from `now`, and every timer in the timer table is waited for with `sleepUntil`. The Runtime reads time no other way, so a test drives all of it with `TestClock.adjust`.

## The laws

`@iirc/runtime/testing` holds the laws every adapter of a port keeps, as data: `journalLaws`, `vaultLaws`, and `transportLaws`. The Journal's laws follow from three positions while appends for two Networks run concurrently, and interrupt appends at every point between two operations. The Transport's laws interrupt a hangup the same way, and check that the Connection still ends once. A law is an Effect that fails with `LawBroken`, so the module needs no test runner. `holds(law, make)` checks one against a fresh harness, in its own Scope, and fails after two seconds rather than hanging.

```ts
it.each(journalLaws)("$name", async (law) => {
  await Effect.runPromise(holds(law, makeSqliteJournal(temporaryFile)));
});
```

A Transport's laws need the far end too, so their harness is the Transport with a `TestIrcd` that accepts each dial as a `TestCall`. The Bun adapter's harness plays it with a local listener. Production code may not import `@iirc/runtime/testing`. `src/testing/harness.ts` is the Runtime's own test harness, and not part of the kit.
