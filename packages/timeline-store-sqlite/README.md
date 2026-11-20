# @iirc/timeline-store-sqlite

The production adapter of the Timeline store port, on SQLite. It keeps every Network's Timelines in one file, which the Daemon calls `views.sqlite`, and provides `TimelineStore` as a Layer given that file's path. Everything in it is derived from the Journal, so it is never the only copy of anything.

```ts
import { layerSqliteTimelineStore, makeSqliteTimelineStore } from "@iirc/timeline-store-sqlite";

layerSqliteTimelineStore(path): Layer<TimelineStore, TimelineStoreFailed, FileSystem>
makeSqliteTimelineStore(path, { busyTimeout? }): Effect<TimelineStoreService, TimelineStoreFailed, Scope | FileSystem>
```

Both open the file, creating it when it does not exist, and close it when their Scope ends. `makeSqliteTimelineStore` is what the port's laws run against. The `FileSystem` is for removing a file it cannot use.

## The file

One row of how far it has folded, six tables, each with the indexes its reads need, and a full-text index of what Messages say, in a file of its own.

```sql
CREATE TABLE folded (only INTEGER PRIMARY KEY CHECK (only = 1), version INTEGER, through INTEGER,
  directory TEXT NOT NULL, folding TEXT NOT NULL) STRICT;
CREATE TABLE timelines (id TEXT PRIMARY KEY, network TEXT NOT NULL, kind TEXT NOT NULL,
  name TEXT NOT NULL, key TEXT, changed INTEGER NOT NULL, read INTEGER, head INTEGER,
  unread_highlights INTEGER NOT NULL, unread_direct INTEGER NOT NULL,
  unread_messages INTEGER NOT NULL, unread_activity INTEGER NOT NULL,
  unread_bot_direct INTEGER NOT NULL, unread_bot_messages INTEGER NOT NULL,
  removed INTEGER NOT NULL, life INTEGER NOT NULL, closed INTEGER) STRICT;
CREATE TABLE items (id INTEGER PRIMARY KEY, timeline TEXT NOT NULL, cursor TEXT NOT NULL,
  network TEXT NOT NULL, step INTEGER NOT NULL, message_id TEXT, intent TEXT,
  content TEXT NOT NULL, changed INTEGER NOT NULL, level TEXT, sender TEXT, answers TEXT,
  ignored TEXT, bot INTEGER NOT NULL, UNIQUE (timeline, cursor)) STRICT;
CREATE TABLE tombstones (id TEXT PRIMARY KEY, network TEXT NOT NULL, into_id TEXT NOT NULL,
  changed INTEGER NOT NULL) STRICT;
CREATE TABLE gaps (network TEXT NOT NULL, from_cursor TEXT NOT NULL, to_cursor TEXT,
  changed INTEGER NOT NULL, PRIMARY KEY (network, from_cursor)) STRICT;
CREATE TABLE dropped (id TEXT PRIMARY KEY, network TEXT NOT NULL, changed INTEGER NOT NULL,
  life INTEGER NOT NULL) STRICT;
CREATE TABLE removals (network TEXT PRIMARY KEY, keep INTEGER NOT NULL, changed INTEGER NOT NULL,
  life INTEGER NOT NULL) STRICT;
CREATE VIRTUAL TABLE search USING fts5(text, content = '', contentless_delete = 1,
  tokenize = 'trigram case_sensitive 1');
PRAGMA user_version = 11;  -- the layout's version
```

- **`folded`** holds the projection version, the last sequence folded, the directory, and `folding`, the `searchFolding` that `search` and `sender` were folded by, in one row, so they are written together.
- **A position is kept as its cursor,** text that sorts as positions do, so every order by position is an order by text. It is read back with `parseCursor`, and text that is not a cursor does not decode.
- **The directory and each item's content** are the JSON text of their Schema encoding (`Schema.toCodecJson`), from Schemas in `src/codec.ts` that are checked against the fold's own types, so a field the fold adds fails to compile there. Maps are kept as their entries. Every read decodes what it gives.
- **Text compares as `BINARY`,** which on UTF-8 is by code point, the order the port's tie-break asks of Network ids.
- **An item's `id` is its row,** which it keeps when a merge moves it, since a merge moves items in place, so the search index, which knows an item only by its row, still finds it. It is an `INTEGER PRIMARY KEY`, so no `VACUUM` renumbers it. `(timeline, cursor)` is unique beside it, as the key it was.
- **`sender` is a Message's sender, folded** by `foldForSearch`, for a search kept to one sender, and `NULL` for anything but a Message, which a search never finds.
- **`answers` is the message id a Message answers,** from its content, so the item it answers is found in its Timeline by `items_by_message_id` without reading the content.
- **`bot` is 1 for a bot's Message of the `Direct` or `Message` level,** as `botUnread` says, and 0 for anything else, so a bot's are counted apart without reading the content.
- **`ignored` is the masks that hide an item,** the JSON text of their array, and `NULL` while it is shown. Every read of items asks for `ignored IS NULL`, and the indexes those reads use are partial on it, ending in `ignored` so the condition is checked from the index alone: a hidden item is in none of them, so it costs a read nothing. It stays in the unique key and `items_by_message_id`, so it holds its position and id, in `items_by_step` and `items_by_intent`, and in `search`, so it is found once shown.
- **`search` holds each Message's text, folded,** as `searchableOf` gives it, under its item's `id`. It is contentless, so it keeps the index and not a second copy of the text, and `contentless_delete` lets a row leave it.

| Read | Served by |
| --- | --- |
| `window` | `items_shown`, partial on `(timeline, cursor, ignored)` where shown, from the position in either direction, with the Timeline and any tombstone found by id |
| `range` | `items_shown`, one seek to the later of `since` and `after`, then a page forward in cursor order, with the Timeline and any tombstone found by id |
| one item per message id, as `Added` and `Merged` keep it | `items_by_message_id`, unique on `(timeline, message_id)` where there is one |
| what a reply answers, on every read that gives items, and as `Added` gives its level | `items_by_message_id`, one seek for each item given, by its Timeline and `answers`. A search seeks for its page alone, once it is kept |
| `Confirmed`, `Unsent`, and `Rejected` | `items_by_intent` on `(network, intent)` |
| `locate` | `items_by_step` on `(network, step, cursor, timeline)`, from the page's `after` by the row value `(cursor, timeline)`, each row checked shown, so a page reads at most the step's hidden items beside it |
| `timeline` | the primary key of `tombstones` for where a merged id went, then the primary key of `timelines`, and `items_shown` for its latest position |
| `timelines` | `timelines_by_network` on `(network, id)`, from the page's `after`, and `items_shown` for each one's latest position, and for whether a Direct Message Timeline shows anything, one seek each. Each row holds its Read Marker and unread counts |
| whether a Timeline is closed, on every read of one | `items_by_arrival`, partial on `(timeline, step, ignored)` where shown: one seek for an item from a later step than the sequence `closed` keeps |
| counting a level again, after a Read Marker moves, a merge, or a mask dropped | `items_by_level`, partial on `(timeline, level, cursor, ignored)` where there is a level and it is shown, above `cursorsAfter` of the Read Marker, `LIMIT unreadCap + 1`, from the index alone, and a bot's the same way by `items_by_bot`, partial on `(timeline, level, cursor, ignored, bot)` where `bot` is 1 too |
| `Unignored` | `items_hidden`, partial on `(network)` where hidden: it reads the Network's hidden items and nothing shown, then writes each by its row |
| `gaps`, and each run of `collapsedGaps` | the primary key `(network, from_cursor)`, bounded below. A Network's Gaps do not overlap, except that one may begin exactly where the one before it ended, so one seek finds the last Gap that began strictly before the range's start, which is kept if it reaches the start, and every Gap that began at or after the start is in. Every other condition is on the key, except for a page read before a cursor, which keeps only the Gaps that ended before it: that run is bounded above on the key too, by the cursor, since a Gap that ended before it began before it, and only then filtered on `to_cursor` for which Gaps are the page's, so it never reads the Gaps after the cursor. A run is one statement that counts its Gaps from the index alone, and takes the first's start and the last's end from either end of the key's range |
| `changedAfter` | `timelines_by_changed`, with a seek of `items_shown` for each Direct Message Timeline, `items_by_changed`, partial where shown, `tombstones_by_changed`, `dropped_by_changed`, `removals_by_changed`, and `gaps_by_changed`, each on `changed` and then the tie-break the port gives |
| where a page of `changedAfter` ends | the same indexes: the next sequence by one seek each, and how much it changed by a count that stops at what the page has left, so a page costs at most `limit + 1` of each however big a step is |
| an overflowed step's Timelines | `timelines_by_changed`, `tombstones_by_changed`, and `dropped_by_changed`, up to the limit, and `items_by_changed` one seek from each Timeline to the next, never reading its items |
| a tombstone moved on by a later merge | `tombstones_by_into` |
| `search` | `search`, by the phrase, and each Message it finds by its item's `id`, then ordered newest first, only the page kept, below |

## Searching

`search` is SQLite's FTS5 with its `trigram` tokenizer: it indexes every run of three characters of a Message's text, so a phrase is found wherever it stands in the text, inside a word or across words, as the port asks, and a search of three characters or more is served by the index. `SearchText` holds at least three, so no search falls back to reading every Message, and none is refused here.

- **The store folds the text, not SQLite.** The tokenizer is `case_sensitive 1`, which keeps text as it is given, and both the text and the search are folded by `foldForSearch` first, from a table pinned to one Unicode version. SQLite's own folding, `case_sensitive 0`, follows tables of its own that differ from that one beyond ASCII, so the memory adapter and this one would find different things. For the same reason `remove_diacritics`, which the trigram tokenizer offers only with SQLite's folding, is not used: diacritics are kept, as the port says.
- **A file folded another way is folded again.** When the store opens a file whose `folding` is not `searchFolding`, as after the table was generated for another Unicode version, it folds again in the transaction that opens it: it empties the index, folds each item's sender and text again from its content, a thousand items at a time, and records the new folding, with a warning in the log. So no index ever holds text folded two ways, and the Journal need not be folded again.
- **No text is ever part of a query.** The search's text is bound as a parameter, as one FTS5 string, a phrase, inside double quotes with each double quote doubled, so `"`, `*`, `NEAR`, `AND`, `OR`, `NOT`, `^`, `+`, `-`, parentheses, and a column filter such as `text:` are characters to find, never operators. NUL and line breaks cannot reach it, since `SearchText` holds neither.
- **It is kept with every `apply`, in its transaction.** `Added` adds a row for each Message kept, under the `id` it was given, and nothing for one dropped as a duplicate. `Confirmed` replaces the row of one of ours whose confirmed text differs from ours, since that is what it is found by from then on. `Unsent` and `Rejected` change no text, so nothing. `Removed` without `keep` takes each of the Network's Messages out of it before their items go, found by `items_by_step`. `Merged` moves items in place, `UPDATE OR IGNORE`, so each moved keeps its row, and each the merge drops, by message id or position, leaves the index before it leaves `items`. An item added hidden is indexed as any other, and a search keeps only those shown, so `Unignored` changes nothing in it. `reset` empties it with FTS5's `delete-all`. A store of an older layout is made again, which folds the Journal into it from the start.
- **What a search costs.** One statement: the index gives every Message holding the phrase, each is found in `items` by its `id`, the filters are checked on that row, a merged id found through `tombstones` once, and the matches are ordered by `(cursor, timeline)` with only `LIMIT` of them kept, the page and one more. `CROSS JOIN` keeps the index first, so a search kept to one Timeline never becomes a walk of its items. So a search costs one step for each Message that holds the phrase, and reads nothing else: measured with 100,000 Messages that hold it, some 60 to 75 ms, and 2 ms for a phrase that one holds. No ranks or ordered copies are kept to make the common phrase cheaper, since a page of a search is a read the Owner asks for, not one made on every change.

## Counting Gaps

A window's Gaps cost one seek, then one statement for each run between two of its items. Counting a run walks the Gaps in it, in the index alone. A Gap needs a disconnect and then a reconnect, and the one backoff paces reconnects: a Session that ends inside 5 minutes makes the next wait double, up to 5 minutes, so even an Ircd that drops every Session as it begins makes a few hundred Gaps a day. A run spanning a year of that is about a hundred thousand index entries, which SQLite counts in a few tens of milliseconds, and a run over a week of ordinary use is a handful. There are no ranks or running counts kept to make it faster.

## Counting unread

Each Timeline's row keeps its Read Marker, `read`, and a count for each level, so a read of Timelines reads no items to give them. Keeping an item adds one to its level's count, and to `botDirect` or `botMessages` for a bot's, by its primary key, when it stands after the Read Marker and is shown, and stops at `unreadCap + 1`. A Read Marker that moves, a merge, and a mask dropped that shows an item count the Timeline again: one statement, six counts, each a search of `items_by_level`, or of `items_by_bot` for a bot's, above `cursorsAfter` of the Read Marker, from `@iirc/timelines`, so `at` alone decides and no instant after the Read Marker is ever made, which the largest has not, that stops after `unreadCap + 1` entries. A Timeline with no Read Marker is counted with no bound on the cursor. So counting again reads at most six thousand index entries however long the Timeline is, and a Timeline with no Read Marker and a million items costs the same to keep as an empty one.

## Settings

| Setting | Value | Why |
| --- | --- | --- |
| `journal_mode` | `WAL` | Reads never block the projector's writes, nor an inspector with `sqlite3`. Set once the file is known to be a store. |
| `temp_store` | `MEMORY` | SQLite's temporary files stay in memory, so the store needs no writable directory but its own. An apply's `INSERT INTO items … RETURNING id` keeps a statement journal, which SQLite otherwise spills to a temporary file past 64 KiB, as when several of the items' indexes split at once, and which fails with `SQLITE_IOERR_GETTEMPPATH` where there is no temporary directory. |
| `synchronous` | `NORMAL` | In WAL mode a commit does not wait for the disk, and a power failure may lose the last commits, but never part of one. That is all a derived store needs: it may lag the Journal after a crash, and folds the rest again on start. It is never ahead of what it records as folded, because `through` commits in the same transaction as the rows it describes. The Journal's own `FULL` is what makes the Journal durable. |
| One connection | serialised by the client | `@effect/sql-sqlite-bun` runs every statement on one connection, and a transaction holds it, so a read never sees part of an apply. |

## Whole or absent

`apply` is one transaction, `BEGIN IMMEDIATE` to `COMMIT`, run uninterruptibly from encoding its changes to its commit, so an interrupted `apply` waits for its end, and one that fails rolls back. A crash leaves SQLite's last commit. `reset` is one transaction too. A read of more than one statement, `changedAfter`, runs in a transaction, and a `window` is one statement, its first row naming the Timeline and its Network, unless the id it is given is a merged one, when finding where it went and reading that Timeline share a transaction. `timeline` finds where an id went and reads that Timeline in one transaction. `consistent` runs its reads and reads `through` and `version` in one transaction, which holds the one connection, so no `apply` runs until it ends, and the reads inside it nest in it.

## A file it cannot use is made again

The store is derived, so it never refuses a file. When it opens one, it reads, changing nothing:

- A file with nothing in it is new. The tables are made and `user_version` is set.
- A file whose `user_version` is the layout's, whose tables and their columns, by name and declared type as SQLite's `table_info` describes them, are exactly the layout's, the search index among them by its one column, and the tables SQLite keeps for that index, which `table_list` calls shadow tables, aside as SQLite's own, and whose `folded` row decodes, directory included, is opened as it is. The columns are read before any table is queried by them.
- A file that is not a store of this layout, or is damaged, is removed, with its `-wal`, `-shm`, and `-journal`, and made again from nothing, with a warning in the log: one of another `user_version`, one whose tables or columns are not exactly the layout's, one whose `folded` row or directory does not decode, a database that is not a store, and a file that SQLite says is not a database or is corrupt. SQLite says so with `SQLITE_NOTADB` or `SQLITE_CORRUPT`, read from the native error's result code, never its text.
- Any other failure while reading it fails with `TimelineStoreFailed`, and leaves the file as it was: a lock another connection holds past the busy timeout (5 seconds unless `busyTimeout` says otherwise), a failed read, a full disk, or a file it may not read. A file that cannot be read now is not a file that is wrong.

The store made again has no projection version, so whatever starts it folds the Journal into it from the start. A path that cannot be opened at all, such as one in a directory that does not exist, fails with `TimelineStoreFailed`, and nothing is removed. The layout's version is not the projection's: `folded.version` is the projection version, which the Daemon compares with `projectionVersion` and resets by.

## Failure

`TimelineStoreFailed` is any failure to open, read, or write: a path that cannot be opened, a lock held too long, a full disk, or a row that does not decode. Its reason says what SQLite said, from the native error inside the SQL error, with its extended result code, such as `unable to open database file (SQLITE_CANTOPEN)` or `database is locked (SQLITE_BUSY)`. A row damaged after the file was opened fails the read that reaches it. Removing the file while the Daemon is stopped rebuilds it.

## Tests

`bun run test` runs the port's laws against a fresh file each. It also checks the query plan of every statement the store itself emits, captured as the SQL client compiles it, so a read that stops using the index named above fails.

## Choices

- **Effect SQL, not `bun:sqlite` directly**, as the Journal does. `@effect/sql-sqlite-bun` is pinned to the same version as `effect`.

## Not yet

- **Pruning.** Every item folded is kept, however old.
