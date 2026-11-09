# @iirc/journal-sqlite

The production adapter of the Journal port ([`packages/runtime/README.md`](../runtime/README.md), "Journal"), on SQLite. It keeps every Network's Entries in one file, and provides `Journal` as a Layer given that file's path. Its Entries are the Journal's, as ADR 0002 describes them: the Line Entries hold the bytes that crossed the Connection.

```ts
import { layerSqliteJournal, makeSqliteJournal } from "@iirc/journal-sqlite";

layerSqliteJournal(path): Layer<Journal, JournalFailed | JournalVersionMismatch>
makeSqliteJournal(path): Effect<JournalService, JournalFailed | JournalVersionMismatch, Scope>
```

Both open the file, creating it when it does not exist, and close it when their Scope ends. `makeSqliteJournal` is what the Journal's laws run against.

## The file

One table and one index, in a file of its own. Nothing else lives in it.

```sql
CREATE TABLE journal (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  record   TEXT NOT NULL CHECK (json_valid(record)),
  network  TEXT NOT NULL GENERATED ALWAYS AS (json_extract(record, '$.network')) VIRTUAL
) STRICT;
CREATE INDEX journal_by_network ON journal (network);
PRAGMA user_version = 1;  -- journalVersion
```

- **`sequence`** is the Entry's `Sequence`. The database numbers it, `AUTOINCREMENT` never reuses a number, and appends are serialized, so sequences increase in the order appends complete. The port allows skipped numbers, and this adapter has none unless the file is changed by hand.
- **`record`** is the JSON text of the `JournalRecord`'s Schema encoding (`Schema.toCodecJson`), so the Journal can be read with `sqlite3` or anything else that reads JSON, and Credentials appear only as names (a `SendSecret` holds a `CredentialName`). Bytes are in whatever form that encoding gives them. It is written as given and never rewritten.
- **`network`** is derived from `record`, so it cannot disagree with it. It exists for `journal_by_network`, which serves reading one Network after a sequence. Nothing writes it.

Reading is filtered in SQL: `read` and `follow` ask for `sequence > after`, and `network = ?` when a Network is named, in sequence order, a page of 500 at a time. A stream's memory is a page, not the Journal.

## Settings

| Setting | Value | Why |
| --- | --- | --- |
| `journal_mode` | `WAL` | Appends are one small write each, and readers (an inspector with `sqlite3`, for instance) never block the Daemon's writes. Set by `@effect/sql-sqlite-bun`. |
| `synchronous` | `FULL` | Every commit syncs the WAL to the disk before it returns. With `NORMAL` the last commits could be lost on power failure, which would break "durable before `append` returns". |
| `busy_timeout` | 5 seconds | The default of `@effect/sql-sqlite-bun`. One Daemon owns the file, so it matters only if something else holds a write lock. |
| One connection | serialized by the client | `@effect/sql-sqlite-bun` runs every statement on one connection. Appends also take a lock of our own, described below. |

## Durable

An `append` that has returned has been committed by SQLite with `synchronous = FULL` in WAL mode, which means the WAL has been synced to the storage device. It survives the Daemon being killed and the machine losing power, so far as the device honors a sync. A record that cannot be encoded, or would not decode again, is refused with `JournalFailed` before anything is written, so nothing is kept that cannot be read.

## Whole or absent, and `follow`

An append is one `INSERT` statement, which SQLite makes atomic, followed by publishing the Entry to followers. Both run inside one uninterruptible region under a lock, so an interrupted append is either kept and followed, or never started. The lock also means Entries are published in the order they are numbered.

`follow` subscribes to the publisher first, then reads the highest sequence, then reads the past up to that sequence, then gives the live Entries after it. An Entry appended in between is in the past or in the subscription, and the cut by sequence keeps it from being in both. `read` settles the same sequence first, so it ends where the Journal stood when reading began.

Followers see the appends made through the same Layer. Another process appending to the file is not followed. One Daemon owns the file.

## The version check

`journalVersion` is stored in SQLite's `user_version`. When a file is opened, in one transaction:

- A file with nothing in it is a new Journal. The table is created and `user_version` is set.
- A file with `user_version` equal to `journalVersion` is opened.
- Anything else, including a file of another version and a database that is not a Journal at all (`found: 0`), is refused with `JournalVersionMismatch { expected, found }`, and the file is left as it was. Nothing is migrated.

## Failure

`JournalFailed` is any failure to open, read, or write that is not a version mismatch: a path that cannot be opened, a file that is not a database, a full disk, or a record that is damaged or no longer decodes as a `JournalRecord`. A stream that reaches a damaged record gives the Entries before it, then fails. None of these is a defect.

## Choices

- **Effect SQL, not `bun:sqlite` directly** (ADR 0005). `@effect/sql-sqlite-bun` is pinned to the same version as `effect`. Its one gap is that `executeStream` is not implemented, which is why reads page by sequence.
