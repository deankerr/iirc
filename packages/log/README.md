# @iirc/log

The Daemon's durable Log, in SQLite. It is the durable `Recorder` and `Committed` for `@iirc/session`, keeps derived tables in the same transaction as each append, and serves reads from a Worker so that no read can delay an append.

- **Depends on:** `@iirc/session`, `@iirc/state`, `effect`, `@effect/sql-sqlite-bun`, `@effect/platform-bun`.
- **Used by:** `@iirc/daemon`.

## Public surface

| Export | Role |
| --- | --- |
| `Log` | The writer. `Log.layer({ dataDir })` provides `Log`, `Recorder`, and `Committed`, and holds the data directory's lock |
| `Log` operations | `entries`, `changes`, `messages`, `gaps`, `head`, `rebuild` (LOG-10), and `redact` (LOG-7). These read on the writer's connection, so only startup and tests use them |
| `LogReader` | Reads for Frontends: `entries`, `messages`, `gaps`, and `backup`, each from a Worker. The three reads have a time budget; `backup` has none, and runs as long as the Log's size needs |
| `LogReader.layer({ dataDir, budget? })` | Starts the reader's Worker. Needs `Log` |
| `inProcessReader({ dataDir, budget? })`, from `./testing` | A `LogReader` for tests not about the Worker: the same reads on its own read-only connection, on the caller's thread, with no Worker to start. Needs `Log` |
| `longestReadMillis` | The longest a read waits under the default budget, for anything that waits on reads in flight |
| Errors | `StorageFailed`, `DataDirectoryLocked`, `LogTooNew`, `ReadTimedOut`, `ReaderBusy`, `EntryNotFound`, `EntryNotRedactable`, `EntryAlreadyRedacted` |
| Types | `LoggedMessage`, `Gap`, `Backup`, `EntryQuery`, `NetworkPage`, `ChangeEntry` |

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
- **One `entries` table** for every kind of Entry, `STRICT`, with indexes by Network, by kind, and by both, so each reader filter is a range over an index.
- **Derived tables:** `messages` and `gaps`. They are created at startup and not by a migration, because anyone may drop them, and the startup rebuild fills them again (LOG-10).
- **Startup is one pass over Entries:** it rebuilds every derived table and every Network's `Standing` through `foldEntries`, the same fold `record` uses, so a rebuilt table can only differ from a live one if the code did.
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
- `recording-child.ts`, `reader-worker.ts`, and the fixtures are spawned by path, so `knip.jsonc` lists them as entries.

## Requirements

[The Log](../../docs/requirements.md#the-log) (LOG-1 to LOG-4, LOG-7, LOG-9 to LOG-11), [Staying connected](../../docs/requirements.md#staying-connected) (LIVE-10's Gaps), [Running it](../../docs/requirements.md#running-it) (RUN-2, RUN-4, RUN-5), and PROOF-4 in [Proof](../../docs/requirements.md#proof).
