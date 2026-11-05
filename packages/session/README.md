# @iirc/session

Hosts one Network with Effect: dials Ircds, records every Line before acting on it, steps the lifecycle machine, reconnects, rejoins, and keeps Credentials out of what it records. Storage is someone else's: it records through a `Recorder`.

- **Depends on:** `@iirc/protocol`, `@iirc/state`, `@iirc/lifecycle`, `effect`.
- **Used by:** `@iirc/log` (the durable `Recorder`), `@iirc/daemon` (one host per Network), and any library user who wants a bot.
- **Lineage:** ircrobots.

## Public surface

| Path | Main exports | Role |
| --- | --- | --- |
| `./network` | `hostNetwork`, `constantNetwork`, `NetworkSettings`, `NetworkHost`, `NetworkStatus`, `NotInSession`, `LaneFull`, `LineDropped`, `WriteFailed` | Stays on a Network for as long as a Scope lasts, with `send` and `status` |
| `./recorder` | `Recorder`, `Committed`, `MemoryEntries`, `Watched`, `Overflowed`, `RecordFailed`, `makeWatchers` | Records Entries before anything acts on them, and watches them as they commit |
| `./entry` | `Entry`, `NewEntry`, `Ircd`, `TlsDetails`, `IfFieldsOfEntry` | The Entry kinds, which this package owns |
| `./standing` | `Standing`, `reduceStanding`, `foldStandings`, `nextAttempt`, `joinPlan`, `candidateNicks`, `Gap` | A Network's past as a pure fold, and the decisions made from it |
| `./events` | `toEvent`, `stepEntry` | The one mapping from an Entry to a machine event |
| `./transport` | `Transport`, `ConnectFailed` | Dials TCP or TLS, verifies or pins, and reads with backpressure |
| `./credentials` | `passLine`, `identifyLine`, `connectCommandLine`, `keyedJoins`, `missingCredentials` | Lines built from Credentials, marked sensitive where they are built |
| `./testing` | `fakeIrcd`, `scriptedIrcd`, `testWire`, `testAuthority`, `eventually` | Ircds and certificates for tests, with no real network |

## Usage

A bot needs only a host, the memory Recorder, and a watch.

```ts
import { defaultTuning } from "@iirc/lifecycle/tuning";
import { constantNetwork, hostNetwork } from "@iirc/session/network";
import type { NetworkSettings } from "@iirc/session/network";
import { Committed, Recorder } from "@iirc/session/recorder";
import { Transport } from "@iirc/session/transport";
import { Effect, Layer, Stream } from "effect";

const settings: NetworkSettings = {
  channels: [{ name: "#iirc" }],
  connectCommands: [],
  credentials: {},
  enabled: true,
  identity: { alternates: [], nick: "iircbot", realname: "A bot", username: "bot" },
  ircds: [{ host: "irc.libera.chat", port: 6697, tls: true }],
  quitReason: "bye",
  secrets: new Map(),
  services: [],
  tuning: defaultTuning,
};

const program = Effect.gen(function* () {
  const { watch } = yield* Committed;
  const committed = yield* watch(); // subscribe first, so nothing is missed

  const network = yield* hostNetwork(constantNetwork("libera", settings));
  // network.send(line, "my-cause") queues a Line; network.status says where it stands

  yield* committed.pipe(
    Stream.runForEach((item) =>
      item._tag === "Line" && item.direction === "inbound"
        ? Effect.log(new TextDecoder().decode(item.bytes))
        : Effect.void
    )
  );
});

Effect.runFork(
  program.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(Recorder.memory, Transport.layer)))
);
```

Closing the Scope says `QUIT` and waits up to `quitWaitMillis`.

## Key ideas

- **Record, then act.** `Recorder.record(entries, within)` appends atomically and runs `within` in the same transaction. The host steps the machine there, and runs its Commands after commit (LOG-4).
- **`Standing` is everything a host needs from the past:** the Connection under way and its machine, recent outcomes, any refusal, `@iirc/state` for the Session, kicks, `JOIN` failures, lag, and the latest Gap. Both Recorders update it in the same transaction, and the host holds no copy, not even of the machine: a commit steps the machine Standing holds, and the loop waits on its deadline. Reading it cannot fail.
- **Decisions are pure functions of `Standing`.** `nextAttempt` gives backoff, jitter seeded by sequence, and Ircd rotation (LIVE-4, LIVE-5). `joinPlan` gives what to `JOIN` now and when to look again (LIVE-7, LIVE-8).
- **A host reads its settings; nothing pushes them.** `settings` is read whenever the host decides something, and `changes` wakes it. Ircds, Identity, and Tuning apply at the next `attempt`, and the rest at once (CONF-2).
- **One Connection, three lanes, one pump.** Control, interactive, and background, in strict priority (SEND-1). The pump records each Line as it leaves, then writes it. When the Connection ends, what is queued becomes Dropped Entries in the same commit as `closed` (SEND-4).
- **Sensitive Lines are marked where they are built** (LOG-6): a Line built from Credentials arrives at the Recorder already as the Log holds it, with its values `<redacted>` and their names. Nothing searches Lines for a Credential's value ([ADR 0008](../../docs/adr/0008-credentials-are-held-not-hunted.md)). The host acts on the Entry as recorded.

## Watching what commits

`Committed.watch` gives a Stream of `Entry | Overflowed`.

- **Ordering:** Entries come in sequence order, each only once its commit has landed. A rolled-back `record` publishes nothing.
- **Timing:** a watch gives everything committed after `watch` returns. It subscribes then, in the caller's Scope, not when the Stream first runs.
- **No replay:** a caller who needs the past subscribes first, then reads by cursor from `MemoryEntries` or the Log, and skips a sequence it already has.
- **Overflow:** each watcher holds at most `capacity` Entries, 4096 by default. Past that it misses Entries until it has taken all it holds, then gets one `Overflowed { missedFrom, missedTo }`. Other watchers are not affected, and no watcher can hold up a commit (HOST-5).

## Invariants

- A Line is never sent unrecorded. At most 1024 Lines go in one commit, and what is pulled but unrecorded stays under 16 KB plus one pull, which `Transport.layer` keeps to 16 KB. What the socket stream holds unpulled is the Transport's own bound (LOG-4).
- Nothing outlives its Connection: no Line queued on one is sent on the next.
- A defect during a Connection becomes a `closed` Entry and a normal backoff. A failed `record` backs off the same way, and `status` shows the fault until one succeeds (LOG-9).
- `Standing` holds at most 64 Connection outcomes and 1024 Channels per map.

## Field vocabulary

`Entry` in `./entry` owns the Entry kinds and their fields. Every other list of them is checked against it at compile time, so adding a field fails to compile wherever it must be handled.

| Vocabulary | Owner | Checked in |
| --- | --- | --- |
| Entry kinds and their fields | `Entry` here | `EntryRow` in `@iirc/log`, and `toLogEntry` in `@iirc/daemon`, each with `IfFieldsOfEntry` |
| `Ircd` and `TlsDetails` | Here | The row codec in `@iirc/log` |
| Tuning numbers | `Tuning` in `@iirc/lifecycle` | `TuningSettings` in `@iirc/api`, and the row codec in `@iirc/log` |

- `IfFieldsOfEntry<Codec, Checked, Added>` is `Checked` when each kind's field names match, and otherwise a type naming what is missing and what is unknown, by kind. `Added` is what an adapter adds, such as `text` and `reason` in `LogEntry`.

## Traps

- **`BunSocket.makeTls` cannot pin** (CONN-1): with `rejectUnauthorized: false`, `checkServerIdentity` never ran. So `Transport` dials with `node:net` and `node:tls`.
- **Bun's `Socket.prototype.read` resumes the socket on every call,** whatever `highWaterMark` says, so a flood drained into the process at 120 MB a second. `Transport` reads through `Readable.prototype.read` in pieces of at most 16 KB, so the stream holds at most 64 KB and one 512 KB read of the kernel, and the rest waits in the kernel (LOG-4).
- **When a write counts as written:** over plaintext, once its callback fires. Over TLS, Bun fires the callback once a record is sealed, possibly still in the process, so a TLS write counts once the next write is taken, or once the pump has nothing to write. If a later write stalls, the one before it is Dropped as one that may not have reached the Ircd.
- **Wait with `Queue.peek` under a timeout.** A timed `take` can lose its item to the timer.
- **Lanes are three `TxQueue`s,** not a `TxPriorityQueue`, which has one bound where SEND-3 needs one per lane. Flood control is the pure token bucket from `@iirc/protocol`, because `RateLimiter`'s delay would break strict priority.
- **`Committed` is not a `PubSub`.** A bounded one would stall the writer, and a dropping or sliding one would lose Entries silently, for every subscriber at once.
- **The host catches defects,** including a transition that throws, so bad input never takes it down (HOST-1).
- Per-Line code uses `Effect.fnUntraced`.

## Requirements

[The Log](../../docs/requirements.md#the-log) (LOG-2, LOG-4 to LOG-6, LOG-8, LOG-9), [Credentials](../../docs/requirements.md#credentials) (CRED-4), [Connecting](../../docs/requirements.md#connecting), [Staying connected](../../docs/requirements.md#staying-connected), [Sending](../../docs/requirements.md#sending), and [Hostile input](../../docs/requirements.md#hostile-input).
