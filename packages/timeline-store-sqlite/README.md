# @iirc/timeline-store-sqlite

The production adapter of the Timeline store port ([`packages/timeline-store/README.md`](../timeline-store/README.md)), on SQLite. It keeps every Network's Timelines in one file, which the Daemon calls `views.sqlite`, and provides `TimelineStore` as a Layer given that file's path. Everything in it is derived from the Journal ([ADR 0002](../../docs/adr/0002-the-journal-holds-bytes.md)), so it is never the only copy of anything.

```ts
import { layerSqliteTimelineStore, makeSqliteTimelineStore } from "@iirc/timeline-store-sqlite";

layerSqliteTimelineStore(path): Layer<TimelineStore, TimelineStoreFailed, FileSystem>
makeSqliteTimelineStore(path, { busyTimeout? }): Effect<TimelineStoreService, TimelineStoreFailed, Scope | FileSystem>
```

Both open the file, creating it when it does not exist, and close it when their Scope ends. `makeSqliteTimelineStore` is what the port's laws run against. The `FileSystem` is for removing a file it cannot use.

## The file

One row of how far it has folded, and four tables, each with the indexes its reads need, in a file of its own.

```sql
CREATE TABLE folded (only INTEGER PRIMARY KEY CHECK (only = 1), version INTEGER, through INTEGER,
  directory TEXT NOT NULL) STRICT;
CREATE TABLE timelines (id TEXT PRIMARY KEY, network TEXT NOT NULL, kind TEXT NOT NULL,
  name TEXT NOT NULL, key TEXT, changed INTEGER NOT NULL) STRICT;
CREATE TABLE items (timeline TEXT NOT NULL, cursor TEXT NOT NULL, network TEXT NOT NULL,
  step INTEGER NOT NULL, message_id TEXT, intent TEXT, content TEXT NOT NULL,
  changed INTEGER NOT NULL, PRIMARY KEY (timeline, cursor)) STRICT;
CREATE TABLE tombstones (id TEXT PRIMARY KEY, network TEXT NOT NULL, into_id TEXT NOT NULL,
  changed INTEGER NOT NULL) STRICT;
CREATE TABLE gaps (network TEXT NOT NULL, from_cursor TEXT NOT NULL, to_cursor TEXT,
  changed INTEGER NOT NULL, PRIMARY KEY (network, from_cursor)) STRICT;
PRAGMA user_version = 1;  -- the layout's version
```

- **`folded`** holds the projection version, the last sequence folded, and the directory, in one row, so they are written together.
- **A position is kept as its cursor,** text that sorts as positions do, so every order by position is an order by text. It is read back with `parseCursor`, and text that is not a cursor does not decode.
- **The directory and each item's content** are the JSON text of their Schema encoding (`Schema.toCodecJson`), from Schemas in `src/codec.ts` that are checked against the fold's own types, so a field the fold adds fails to compile there. Maps are kept as their entries. Every read decodes what it gives.
- **Text compares as `BINARY`,** which on UTF-8 is by code point, the order the port's tie-break asks of Network ids.

| Read | Served by |
| --- | --- |
| `window` | the primary key `(timeline, cursor)`, from the position in either direction, with the Timeline and any tombstone found by id |
| one item per message id, as `Added` and `Merged` keep it | `items_by_message_id`, unique on `(timeline, message_id)` where there is one |
| `Confirmed` and `Unsent` | `items_by_intent` on `(network, intent)` |
| `locate` | `items_by_step` on `(network, step, cursor, timeline)` |
| `timelines` | `timelines_by_network` on `(network, id)`, and the primary key of `items` for each one's latest position |
| `gaps` | the primary key `(network, from_cursor)` |
| `changedAfter` | `timelines_by_changed`, `items_by_changed`, `tombstones_by_changed`, and `gaps_by_changed`, each on `changed` and then the tie-break the port gives |
| a tombstone moved on by a later merge | `tombstones_by_into` |

## Settings

| Setting | Value | Why |
| --- | --- | --- |
| `journal_mode` | `WAL` | Reads never block the projector's writes, nor an inspector with `sqlite3`. Set once the file is known to be a store. |
| `synchronous` | `NORMAL` | In WAL mode a commit does not wait for the disk, and a power failure may lose the last commits, but never part of one. That is all a derived store needs: it may lag the Journal after a crash, and folds the rest again on start. It is never ahead of what it records as folded, because `through` commits in the same transaction as the rows it describes. The Journal's own `FULL` is what makes the Journal durable. |
| One connection | serialized by the client | `@effect/sql-sqlite-bun` runs every statement on one connection, and a transaction holds it, so a read never sees part of an apply. |

## Whole or absent

`apply` is one transaction, `BEGIN IMMEDIATE` to `COMMIT`, run uninterruptibly from encoding its changes to its commit, so an interrupted `apply` waits for its end, and one that fails rolls back. A crash leaves SQLite's last commit. `reset` is one transaction too. A read of more than one statement, `changedAfter`, runs in a transaction, and a `window` is one statement, unless the id it is given is a merged one, when finding where it went and reading that Timeline share a transaction.

## A file it cannot use is made again

The store is derived, so it never refuses a file. When it opens one, it reads, changing nothing:

- A file with nothing in it is new. The tables are made and `user_version` is set.
- A file whose `user_version` is the layout's, whose tables and their columns, by name and declared type as SQLite's `table_info` describes them, are exactly the layout's, and whose `folded` row decodes, directory included, is opened as it is. The columns are read before any table is queried by them.
- A file that is not a store of this layout, or is damaged, is removed, with its `-wal`, `-shm`, and `-journal`, and made again from nothing, with a warning in the log: one of another `user_version`, one whose tables or columns are not exactly the layout's, one whose `folded` row or directory does not decode, a database that is not a store, and a file that SQLite says is not a database or is corrupt. SQLite says so with `SQLITE_NOTADB` or `SQLITE_CORRUPT`, read from the native error's result code, never its text.
- Any other failure while reading it fails with `TimelineStoreFailed`, and leaves the file as it was: a lock another connection holds past the busy timeout (5 seconds unless `busyTimeout` says otherwise), a failed read, a full disk, or a file it may not read. A file that cannot be read now is not a file that is wrong.

The store made again has no projection version, so whatever starts it folds the Journal into it from the start. A path that cannot be opened at all, such as one in a directory that does not exist, fails with `TimelineStoreFailed`, and nothing is removed. The layout's version is not the projection's: `folded.version` is the projection version, which the Daemon compares with `projectionVersion` and resets by.

## Failure

`TimelineStoreFailed` is any failure to open, read, or write: a path that cannot be opened, a lock held too long, a full disk, or a row that does not decode. Its reason says what SQLite said, from the native error inside the SQL error, such as `unable to open database file` or `database is locked`. A row damaged after the file was opened fails the read that reaches it. Removing the file while the Daemon is stopped rebuilds it.

## Tests

`bun run test` runs the port's laws against a fresh file each, and then: applying steps of every kind, closing the file, and opening it again reads exactly the same; the Layer keeps what it was given; a file of another layout, one of this layout's version whose `folded` table lacks a column, one whose directory does not decode, a database that is not a store, and a file that is not a database are each made again and then keep what they are given; a path that cannot be opened fails, removes nothing, and says SQLite's own reason; a store another connection holds locked fails to open, and keeps its file and everything in it; and the file is in WAL mode, with each read's query plan using an index, never a scan of a table or a sort.

## Choices

- **Effect SQL, not `bun:sqlite` directly** ([ADR 0005](../../docs/adr/0005-effect-wins-where-it-overlaps-bun.md)), as the Journal does. `@effect/sql-sqlite-bun` is pinned to the same version as `effect`.

## Not yet

- **Search.** Items are read by position and by step, not by what they say.
- **Pruning.** Every item folded is kept, however old.
