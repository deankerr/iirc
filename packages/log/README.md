# @iirc/log

The Daemon's durable Log, in SQLite. It is the durable `Recorder` and `Committed` for `@iirc/session`, keeps derived tables in the same transaction as each append, and serves reads from a Worker so that no read can delay an append.

- **Depends on:** `@iirc/session`, `@iirc/state`, `@iirc/protocol`, `effect`, `@effect/sql-sqlite-bun`, `@effect/platform-bun`.
- **Used by:** `@iirc/daemon`.

## Public surface

| Export | Role |
| --- | --- |
| `Log` | The writer. `Log.layer({ dataDir })` provides `Log`, `Recorder`, and `Committed`, and holds the data directory's lock |
| `Log` operations | `entries`, `changes`, `messages`, `activity`, `gaps`, `head`, `rebuild` (LOG-10), and `redact` (LOG-7). These read on the writer's connection, so only startup and tests use them |
| `LogReader` | Reads for Frontends: `entries`, `encodings`, `messages`, `activity`, `gaps`, and `backup`, each from a Worker. The reads have a time budget; `backup` has none, and runs as long as the Log's size needs. `activity` filters by Network, and by a place on it, and pages by an `ActivityCursor`. `encodings` gives the fallback label each Connection's `attempt` recorded, one primary-key lookup a Connection, so `/entries` decodes a Line's bytes as `Standing` did (MSG-4) |
| `LogReader.layer({ dataDir, budget? })` | Starts the reader's Worker. Needs `Log` |
| `inProcessReader({ dataDir, budget? })`, from `./testing` | A `LogReader` for tests not about the Worker: the same reads on its own read-only connection, on the caller's thread, with no Worker to start. Needs `Log` |
| `longestReadMillis` | The longest a read waits under the default budget, for anything that waits on reads in flight |
| Errors | `StorageFailed`, `DataDirectoryLocked`, `LogTooNew`, `ReadTimedOut`, `ReaderBusy`, `EntryNotFound`, `EntryNotRedactable`, `EntryAlreadyRedacted` |
| Types | `LoggedMessage`, `LoggedActivity`, `ActivityDetails`, `ActivityKind`, `Place`, `Gap`, `Backup`, `EntryQuery`, `NetworkPage`, `ActivityQuery`, `ActivityPage`, `ActivityCursor`, `PlaceKey`, `ChangeEntry` |

## Usage

Swap the memory Recorder for the Log, and a host's Entries become durable.

```ts
import { Log } from "@iirc/log";
import { Transport } from "@iirc/session/transport";
import { Layer } from "effect";

// In place of Recorder.memory in the @iirc/session example:
const storage = Layer.mergeAll(Log.layer({ dataDir: "/tmp/iirc" }), Transport.layer);
```

## Storage

- **One file,** `iirc.sqlite` in the data directory, in WAL mode with `synchronous=FULL` (LOG-4).
- **An `attempt` keeps its whole Tuning as JSON.** One written before the encoding, the casemapping, and CTCP replies were Tuning reads as no fallback, the Ircd's mapping, and the CTCP defaults, written out in the row codec so that a new default cannot rewrite history (CONF-1). Fields were only added, so this needed no migration: a binary before it ignores them.
- **One `entries` table** for every kind of Entry, `STRICT`, with indexes by Network, by kind, and by both, so each reader filter is a range over an index.
- **Derived tables:** `messages`, `activity`, and `gaps`. They are created at startup and not by a migration, because anyone may drop them, and the startup rebuild fills them again (LOG-10). A derived table whose columns are not this binary's is dropped first, so a table's shape can change with the code and never needs a migration.
- **Startup is one pass over Entries:** it rebuilds every derived table, every Network's `Standing`, and every Network's Direct Message partners through `foldEntries`, the same fold `record` uses, so a rebuilt table can only differ from a live one if the code did.
- **The writer** is `SqlClient` on the main thread, one transaction per `record`.
- **The reader** is a Worker with a read-only `bun:sqlite` connection, reached over Effect RPC. A read of several kinds runs in one transaction, so it sees one snapshot.
- **Time budgets:** a running query cannot be interrupted, even by terminating its Worker. So each statement calls `iirc_in_budget(deadline)`, a `db.function()`, on every row, and stops itself by throwing. A read that waited in the queue past what its caller waits for fails with `ReaderBusy`.
- **Backup** is `VACUUM INTO` on a Worker of its own, so it holds up no append and no read. It is written under a temporary name, synced, and renamed into `backups/` (RUN-2).
- **The lock** is a held `BEGIN EXCLUSIVE` on a sidecar `iirc.lock` with an in-memory journal. A second process gets `SQLITE_BUSY`, and `SIGKILL` releases it (RUN-4).
- **Migrations** use `Migrator.fromRecord`, because a compiled binary has no migration files to read. A Log with a migration this binary does not know is refused as `LogTooNew`, and one with migrations to run is backed up first (RUN-5).
- **The format is frozen** since the soak test began. `1_initial` is the whole of a Log, and any change is a new migration, `2_<name>`, never an edit.
- **Search is not built.** FTS5 and `/search` come with VIEW-6 in milestone 4.

### Storage measurements

Taken on fserv, on synthetic data.

| What | Measured |
| --- | --- |
| One Line plus an FTS row and a derived row, `synchronous=FULL` | 0.97 ms p50, 2.5 ms p99, 26 ms p99.9 |
| `SqlClient` per transaction, against raw `bun:sqlite` | 62 µs against 2.7 µs, which an fsync dwarfs |
| Search by recency over 2 million rows | About 0 ms, against 1.9 s for `ORDER BY rank` |
| `VACUUM INTO` of 250 MB from a Worker | 2.4 s, and it passed `quick_check` |
| `db.serialize()` of 250 MB | Blocked the main thread for 265 ms, so it is not used |
| A query in a terminated Worker | A 13 s query ended only when it finished |

So the writer stays on the main thread until real traffic says otherwise (LOG-11).

## Timelines

The fold places each Line and says what it means as a Message or as Activity, inside the append transaction, from the state before the Line and from `@iirc/state`'s changes, so that there is one interpretation of what a Line meant. `derive.ts` holds it.

- **Places (MSG-2).** `@iirc/state/place` gives each Line its place: the Network's Timeline, a Channel's, or a Direct Message partner's, keyed by its name casefolded under the mapping in force at that Entry (KNOW-3), with its spelling beside it. A place is three columns, `place_kind`, `place_key`, and `place_name`, and the Network's has `''` for the last two.
- **Messages (MSG-1, PROT-2).** A `PRIVMSG` or `NOTICE` with a sender is a Message of kind `PRIVMSG`, `NOTICE`, or `ACTION`, as `/messages` names them, with its text raw, formatting codes and all (MSG-3), and its `STATUSMSG` prefix kept as `statusmsg`. An `ACTION`'s text is the action's own. Self's come from outbound Lines, as who Self was before them, placed by their Target. Any other CTCP is no Message.
- **Activity (MSG-5).** One row per place a Line belongs to, numbered by `ordinal` within its Entry, with an `actor` and typed `details` as JSON:

| Kind | From | Place |
| --- | --- | --- |
| `join`, `part`, `kick`, `topic` | Self's and others', from `@iirc/state`'s changes | The Channel |
| `mode` | A Channel's `MODE`, with its changes when it added up, and raw when it did not (KNOW-6). Self's user modes | The Channel, or the Network |
| `quit`, `nick` | `UserQuit`, `UserRenamed`, `NickChanged` | Each Channel shared just before the Line, and each partner's Timeline it concerns, or the Network's with neither (KNOW-8) |
| `invite` | `INVITE`, recorded and never followed (LIVE-8) | By MSG-2: an inviter's Direct Message place |
| `ctcp` | A CTCP other than `ACTION` and `DCC`, `reply` when a `NOTICE` carries it. Never answered here (PROT-2) | Where a Message would be |
| `dcc` | A DCC offer, recorded and never acted on (PROT-5) | Where a Message would be |
| `reply` | `FAIL`, `WARN`, and `NOTE`, by shape (PROT-6) | The Network |
| `line` | Any other Line of a command the Daemon handles, numerics and the MOTD included (MSG-6) | The Network |
| `unknown` | A Line of any command the Daemon does not handle, such as `WALLOPS` or `CAP` (PROT-1) | The Network |

- **One rule for the rest.** Every inbound Line that is no Message and says nothing above is a `line` or an `unknown` on the Network's Timeline, so nothing a Network sends is invisible. It is one row per Line, so a `NAMES` reply is a row per `353`, never one per member. Three things are in no Timeline: `PING` and `PONG`, which lag and silence already account for, a Line that does not parse or was cut (HOST-2), and Self's outbound Lines other than Messages, because a Timeline shows what the Network says.
- **Direct Message partners (KNOW-8).** A partner is anyone with a User place in the Log so far, this Session or earlier: a Message to or from them, or a CTCP, DCC, or invite placed with them. The fold carries them as `Partners` beside the Standings, in two persistent generations of 4,096 per Network, as `@iirc/state` holds Users, and a startup rebuilds them in the same pass that writes the rows, so they are no second source of truth. Each is held by their nick as spelled, keyed by it casefolded under the mapping the generations were keyed under, and before a Line that reads or adds a partner, the generations are keyed again from the spellings if the mapping in force has changed since, mid-Session or with a new Session (KNOW-3). Two partners the new mapping folds alike become one. A partner whose Timeline gains no row while 4,096 others begin one is forgotten, which costs their Timeline only a later `QUIT` or `NICK`. A partner's new nick has no Timeline until something is placed there: grouping by person is a Frontend's concern.
- **Activity pages by `(sequence, ordinal)`.** One Entry can be many rows, such as a `QUIT` in a thousand Channels, so a page stops at `limit` rows or about `pageBytes`, inside an Entry if it must. An `ActivityCursor` is `{ sequence }`, after the whole of that Entry, as every other read's `after` and `/stream`'s sequence mean, or `{ sequence, ordinal }`, after that one row. A reader passes back the last row's `sequence` and `ordinal`. Each read is `(sequence, ordinal) > (?, ?)`, a range over the primary key or an index. An HTTP read can carry it as `after=123` or `after=123.4`, and hand back the next as one opaque value, so a Frontend never reads an ordinal.

### Fold measurements

Taken on fserv with Bun 1.4.4, by `bun packages/log/bench/fold.ts`: Self in 20 Channels of 500, with 50 partners.

| What | Measured |
| --- | --- |
| A `PRIVMSG` in a Channel, through `foldStandings` alone, then through `foldEntries` | 3.9 µs p50, 16 µs p99, then 5.0 µs p50, 19 µs p99 |
| A `PRIVMSG` from a partner, the same two ways | 3.1 µs p50, 10 µs p99, then 5.5 µs p50, 16 µs p99 |
| A numeric, the same two ways | 2.0 µs p50, 8.8 µs p99, then 3.0 µs p50, 11 µs p99 |
| One commit of 1,000 `PRIVMSG`s, a Message each, inserted a row a statement | 44 ms p50 of 5 |
| One commit of 1,000 numerics, an Activity each, inserted 64 rows a statement | 34 ms p50 of 5 |
| One commit of a 1,000 `QUIT` netsplit, 4,050 Activity rows | 80 ms p50 of 5 |

So placing and deriving costs about 1 to 2.5 µs a Line beside the Standings fold, and Activity rows go in batches, which cost less a row than a Message's single inserts.

## Invariants

- Sequences start at 1, have no gaps, and are never reused (LOG-1).
- A watcher sees a commit only after `COMMIT` and after the Standings are set. A rolled-back `record` publishes nothing.
- `redact` empties bytes, records its Change, and derives every table again, in one transaction. The Standings hosts read are left as they were, apart from the Change itself.
- A row that will not decode is named by its sequence, because nothing that reads the whole Log can go past it.

## Traps

- `sql.unsafe` with several statements runs only the first and reports success. Use one statement per call in every migration.
- `sql.stream` is not implemented on Bun. Page by cursor.
- `busyTimeout` blocks the event loop, for up to 5 seconds by default. It is 50 ms here.
- `PRAGMA synchronous=FULL` must be stated, because the client has no option for it. Check the answer: SQLite may keep the old mode silently.
- A Bun Worker that exits, or is terminated, fires `close` and no `error`, and `dispatchEvent` on it after that reaches no listener. `BunWorker.layerPlatform` hears only `error`, so its reads would wait for ever. The reader uses its own `Worker.makePlatform` that treats an exit as a death.
- The reader Worker must be a second entrypoint of the compiled binary, under `--root packages/log/src`. In a compiled binary every module's `import.meta.url` is the binary's own, so with the root at the Worker's own directory, `new URL("reader-worker.ts", import.meta.url)` names the same file from source and from the binary.
- `recording-child.ts`, `reader-worker.ts`, and the fixtures are spawned by path, and `bench/` is run by hand, so `knip.jsonc` lists them as entries.
- A batch insert takes its columns from its first row, so a row Schema encodes a missing field as NULL, never by leaving its key out.

## Requirements

[The Log](../../docs/requirements.md#the-log) (LOG-1 to LOG-4, LOG-7, LOG-9 to LOG-11), [Staying connected](../../docs/requirements.md#staying-connected) (LIVE-10's Gaps), [Messages and Activity](../../docs/requirements.md#messages-and-activity) (MSG-1, MSG-2, MSG-5, MSG-6), KNOW-8's attribution, [Protocol behaviour](../../docs/requirements.md#protocol-behaviour) (PROT-1, PROT-2, PROT-5, PROT-6), [Running it](../../docs/requirements.md#running-it) (RUN-2, RUN-4, RUN-5), and PROOF-4 in [Proof](../../docs/requirements.md#proof).
