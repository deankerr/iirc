# @iirc/runtime

The Runtime drives one Client per Network. It journals each input, steps the Client, journals the outputs, and carries them out through its ports. This package defines those ports. The Runtime itself is built from its brief, after the Client.

This README is the ports' written interface. The types are in `src/`, the in-memory adapters and the laws are in `src/testing/`, and [the proposal](../../docs/notes/2026-11-07-architecture-proposal.md#1-the-system-as-a-hexagon) says why the hexagon has this shape.

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
- **Versioned, not migrated.** `journalVersion` is 1. An adapter that finds another version refuses to open with `JournalVersionMismatch`. Nothing is migrated until the shape has settled.
- **`JournalFailed`** means the Journal could not be written or read. The Runtime stops that Network rather than step an input it did not keep.

The Runtime's order for each input is: append the `Input`, step the Client, append its `Outputs` with `of` set to the input's sequence, then carry them out. Every Line goes through `@iirc/protocol`'s `encode`, the last guard on what is sent: a `Rejected` from it means a bug upstream, which the Runtime logs, and that Line is not sent. A `SendSecret` it cannot fill becomes an `Unfilled` input, appended and stepped once the rest of those outputs are carried out. On restart it reads every `Input` for a Network, folds them from `initial`, keeps only the timer table, which `timers` projects from each step's input and outputs, so a timer whose `Fired` was stepped is gone, sets those timers, and steps a `Started`.

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

A Transport's laws need the far end too, so their harness is the Transport with a `TestIrcd` that accepts each dial as a `TestCall`. The Bun adapter's harness plays it with a local listener. Production code may not import `@iirc/runtime/testing`.
