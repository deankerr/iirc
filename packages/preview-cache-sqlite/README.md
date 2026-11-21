# @iirc/preview-cache-sqlite

The production adapter of the Preview cache port, on SQLite. It keeps every link's record in one file, which the Daemon calls `previews.sqlite`. The cache holds nothing the Daemon cannot fetch again, so deleting the file loses nothing but fetches.

```ts
import { layerSqlitePreviewCache, makeSqlitePreviewCache } from "@iirc/preview-cache-sqlite";

layerSqlitePreviewCache(path): Layer<PreviewCache, PreviewCacheFailed, FileSystem>
makeSqlitePreviewCache(path, { busyTimeout? }): Effect<PreviewCacheService, PreviewCacheFailed, Scope | FileSystem>
```

Both open the file, creating it when it does not exist, and close it when their Scope ends. `makeSqlitePreviewCache` is what the port's laws run against. The `FileSystem` is for removing a file it cannot use.

## The file

```sql
CREATE TABLE previews (link TEXT PRIMARY KEY, state TEXT NOT NULL, image TEXT,
  fetched INTEGER NOT NULL, shown INTEGER NOT NULL) STRICT;
CREATE INDEX previews_image ON previews (image) WHERE image IS NOT NULL;
PRAGMA user_version = 6;  -- the layout's version
```

- **`state` is the JSON text of `Settled`'s encoding.** Every read decodes it, and a row that does not decode fails that read with `PreviewCacheFailed`.
- **`image` is a hash, or `NULL`,** indexed, so `refers` is one lookup. `fetched` and `shown` are milliseconds since the epoch.
- **`images` and `evict` are one statement each.** `images` groups the rows by `image`, reading each size from the state with `json_extract`, and `evict` is one `UPDATE` that clears `image`, sets `fetched` to `0`, and clears the Preview's `image` in `state` with `json_set`. The layout is unchanged.
- **`shown` is one statement,** `UPDATE ... SET shown = max(shown, ?) ... RETURNING`, so it never moves backward and a read after it sees it.
- **`journal_mode` is `WAL` and `synchronous` is `NORMAL`.** A power failure may lose the last commits, which costs only fetches, never part of one.
- **`temp_store` is `MEMORY`,** so SQLite's temporary files stay in memory and the cache needs no writable directory but its own.

## A file it cannot use is made again

When it opens a file, it reads, changing nothing:

- A file with nothing in it is new: the table is made and `user_version` is set.
- A file of the layout's `user_version` whose table and columns, by name and declared type, are exactly the layout's is opened as it is.
- A file of `user_version` 5 or 4 whose table and columns are exactly the layout's is an earlier version, brought up in the same transaction that would make the table, so every record is read as it was. From 5, whose Previews' images stated no size, one `UPDATE` sets `dimensions` to `null` in each row whose `image` in `state` is an object, with `json_set`, so the Preview is answered without a size and gains it when it is fetched again. From 4, whose Previews named their stream `media`, one `UPDATE` first renames each Preview's `media` to `stream` with `json_set`, and then the step from 5 is taken. A `state` that is not JSON is left as it is, to fail its own read. Then `user_version` becomes 6.
- Any other file is removed, with its `-wal`, `-shm`, and `-journal`, and made again from nothing, with a warning in the log: one of another `user_version`, one whose table or columns differ, and one SQLite says is not a database or is corrupt, which it says with `SQLITE_NOTADB` or `SQLITE_CORRUPT`, read from the native error's result code, never its text.
- Any other failure fails with `PreviewCacheFailed` and leaves the file as it was: a lock another connection holds past the busy timeout (5 seconds unless `busyTimeout` says otherwise), a failed read, or a file it may not read. A path that cannot be opened at all, such as one in a directory that does not exist, fails the same way and removes nothing.

## Not yet

- **Forgetting records.** Every record kept stays, however old. Only an image is dropped, by `evict`.
