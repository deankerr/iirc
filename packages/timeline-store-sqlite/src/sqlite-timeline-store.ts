// The store is derived (ADR 0002), so this adapter never refuses a file: one it cannot use
// is removed and made again, and the Daemon folds the Journal into it from the start.
//
// Every apply is one transaction, run uninterruptibly, so an interrupted apply is kept whole
// or never begun, and a crash leaves SQLite's last commit, which holds `through` and the
// directory with the rows they describe. `@effect/sql-sqlite-bun` runs every statement on
// one connection, and a transaction holds it, so a read never sees part of an apply.
import { SqliteClient } from "@effect/sql-sqlite-bun";
import type { MessageId } from "@iirc/client";
import { TimelineStore, TimelineStoreFailed } from "@iirc/timeline-store";
import type { Anchor, Applied, Changed, Folded, TimelineStoreService } from "@iirc/timeline-store";
import { TimelineId, cursorOf, emptyDirectory } from "@iirc/timelines";
import type { Change, Content, Directory, Position } from "@iirc/timelines";
import { Effect, Exit, FileSystem, Layer, Option, Schema } from "effect";
import type { Duration, Scope } from "effect";
import { Reactivity } from "effect/reactivity";
import type { SqlClient } from "effect/sql/SqlClient";
import { SqlError } from "effect/sql/SqlError";
import type { Fragment } from "effect/sql/Statement";

import {
  ContentText,
  DirectoryRow,
  DirectoryText,
  FoldedRow,
  GapRow,
  ItemRow,
  OursRow,
  SummaryRow,
  TombstoneRow,
} from "./codec.ts";

/**
 * The version of the file's layout, in SQLite's `user_version`. A file of any other is
 * made again. It is not the projection's version, which `folded` gives.
 */
const layoutVersion = 1;

// What SQLite itself said, when the error carries it. An SQL error's own message is
// generic, and keeps SQLite's error in its reason's cause. Another error may keep one in
// its cause.
const failed =
  (what: string) => (error: { readonly message: string; readonly cause?: unknown }) => {
    const native = error instanceof SqlError ? error.reason.cause : error.cause;

    return new TimelineStoreFailed({
      reason: `${what}: ${native instanceof Error ? native.message : error.message}`,
    });
  };

const decodeErrno = Schema.decodeUnknownOption(Schema.Struct({ errno: Schema.Int }));

// SQLite's primary result codes that say a file is not a database, or is damaged. Each is
// read from the native error's number, never its text. Extended codes keep the primary
// code in their low byte.
const damaged = new Set([11, 26]);

/**
 * Whether an SQL failure says the file is damaged or not a database at all, rather than
 * that it could not be reached now, as a lock, a full disk, or a failed read says.
 * @param error - The failure.
 * @returns Whether a store made again is the remedy.
 */
const isDamage = (error: SqlError) =>
  Option.match(decodeErrno(error.reason.cause), {
    onNone: () => false,
    onSome: ({ errno }) => damaged.has(errno % 256),
  });

// The one place the layout is made. Each read is served by an index, named by what it finds.
const layout = [
  `CREATE TABLE folded (
    only INTEGER PRIMARY KEY CHECK (only = 1),
    version INTEGER,
    through INTEGER,
    directory TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE timelines (
    id TEXT PRIMARY KEY,
    network TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    key TEXT,
    changed INTEGER NOT NULL
  ) STRICT`,
  "CREATE INDEX timelines_by_network ON timelines (network, id)",
  "CREATE INDEX timelines_by_changed ON timelines (changed, id)",
  `CREATE TABLE items (
    timeline TEXT NOT NULL,
    cursor TEXT NOT NULL,
    network TEXT NOT NULL,
    step INTEGER NOT NULL,
    message_id TEXT,
    intent TEXT,
    content TEXT NOT NULL,
    changed INTEGER NOT NULL,
    PRIMARY KEY (timeline, cursor)
  ) STRICT`,
  "CREATE UNIQUE INDEX items_by_message_id ON items (timeline, message_id) WHERE message_id IS NOT NULL",
  "CREATE INDEX items_by_intent ON items (network, intent) WHERE intent IS NOT NULL",
  "CREATE INDEX items_by_step ON items (network, step, cursor, timeline)",
  "CREATE INDEX items_by_changed ON items (changed, timeline, cursor)",
  `CREATE TABLE tombstones (
    id TEXT PRIMARY KEY,
    network TEXT NOT NULL,
    into_id TEXT NOT NULL,
    changed INTEGER NOT NULL
  ) STRICT`,
  "CREATE INDEX tombstones_by_into ON tombstones (into_id)",
  "CREATE INDEX tombstones_by_changed ON tombstones (changed, id)",
  `CREATE TABLE gaps (
    network TEXT NOT NULL,
    from_cursor TEXT NOT NULL,
    to_cursor TEXT,
    changed INTEGER NOT NULL,
    PRIMARY KEY (network, from_cursor)
  ) STRICT`,
  "CREATE INDEX gaps_by_changed ON gaps (changed, network, from_cursor)",
];

const emptyDirectoryText = Schema.encodeSync(DirectoryText)(emptyDirectory);

const createLayout = (sql: SqlClient) =>
  Effect.gen(function* () {
    for (const statement of layout) {
      yield* sql.unsafe(statement);
    }

    yield* sql`INSERT INTO folded (only, version, through, directory) VALUES (1, NULL, NULL, ${emptyDirectoryText})`;
    yield* sql.unsafe(`PRAGMA user_version = ${layoutVersion}`);
  });

/** What a file was found to be. */
type Found = "Empty" | "Ready" | "Unusable";

/**
 * The layout's tables and their columns, each with its declared type, as SQLite's
 * `table_info` gives them, tables by name and columns in the order they were declared.
 */
const columns = [
  "folded.only INTEGER",
  "folded.version INTEGER",
  "folded.through INTEGER",
  "folded.directory TEXT",
  "gaps.network TEXT",
  "gaps.from_cursor TEXT",
  "gaps.to_cursor TEXT",
  "gaps.changed INTEGER",
  "items.timeline TEXT",
  "items.cursor TEXT",
  "items.network TEXT",
  "items.step INTEGER",
  "items.message_id TEXT",
  "items.intent TEXT",
  "items.content TEXT",
  "items.changed INTEGER",
  "timelines.id TEXT",
  "timelines.network TEXT",
  "timelines.kind TEXT",
  "timelines.name TEXT",
  "timelines.key TEXT",
  "timelines.changed INTEGER",
  "tombstones.id TEXT",
  "tombstones.network TEXT",
  "tombstones.into_id TEXT",
  "tombstones.changed INTEGER",
].join("\n");

const decodeFolded = Schema.decodeUnknownExit(FoldedRow);
const decodeDirectoryRow = Schema.decodeUnknownExit(DirectoryRow);

// Reads only, so it changes nothing in the file and takes no write lock. A file is unusable
// when its layout or its `folded` row is not this store's, or when SQLite says it is not a
// database or is damaged. Any other failure, such as a lock held too long, fails, and
// leaves the file as it is.
const inspect = (sql: SqlClient): Effect.Effect<Found, SqlError> =>
  Effect.gen(function* () {
    const versions = yield* sql<{
      readonly version: number;
    }>`SELECT user_version AS version FROM pragma_user_version`;

    const objects = yield* sql<{
      readonly count: number;
    }>`SELECT count(*) AS count FROM sqlite_master`;

    const version = versions[0]?.version ?? 0;

    if (version === 0 && objects[0]?.count === 0) {
      return "Empty" as const;
    }

    if (version !== layoutVersion) {
      return "Unusable" as const;
    }

    // Every table and its columns, read from SQLite's own description of them, before any
    // table is queried by the columns the layout gives it.
    const found = yield* sql<{ readonly column: string }>`
      SELECT tables.name || '.' || info.name || ' ' || info.type AS "column"
      FROM sqlite_master AS tables, pragma_table_info(tables.name) AS info
      WHERE tables.type = 'table'
      ORDER BY tables.name, info.cid
    `;

    if (found.map(({ column }) => column).join("\n") !== columns) {
      return "Unusable" as const;
    }

    const rows = yield* sql`SELECT version, through, directory FROM folded WHERE only = 1`;

    return Exit.isSuccess(decodeFolded(rows[0])) && Exit.isSuccess(decodeDirectoryRow(rows[0]))
      ? ("Ready" as const)
      : ("Unusable" as const);
  }).pipe(Effect.catchIf(isDamage, () => Effect.succeed("Unusable" as const)));

const companions = ["", "-wal", "-shm", "-journal"];

// Removes the file and what SQLite keeps beside it, so it is made again from nothing.
const remove = (filename: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    for (const suffix of companions) {
      yield* fs
        .remove(`${filename}${suffix}`, { force: true })
        .pipe(Effect.mapError(failed(`cannot remove ${filename}${suffix}`)));
    }
  });

/** Seams for tests. */
export interface OpenOptions {
  /** How long a statement waits on a lock another connection holds. 5 seconds unless given. */
  readonly busyTimeout?: Duration.Input | undefined;
}

const open = (filename: string, options: OpenOptions) =>
  SqliteClient.make({
    busyTimeout: options.busyTimeout ?? "5 seconds",
    disableWAL: true,
    filename,
  }).pipe(Effect.provide(Reactivity.layer), Effect.mapError(failed(`cannot open ${filename}`)));

/** A step's change, with an item's content encoded before its transaction begins. */
type Prepared =
  | { readonly _tag: "Other"; readonly change: Exclude<Change, { readonly _tag: "Added" }> }
  | {
      readonly _tag: "Added";
      readonly change: Extract<Change, { readonly _tag: "Added" }>;
      readonly content: string;
    };

const textOrNull = (value: string | undefined) => value ?? null;

const cursorOrNull = (position: Position | undefined) =>
  position === undefined ? null : cursorOf(position);

/**
 * The content a confirmation or an `Unsent` leaves of one of ours.
 * @param content - The item's content.
 * @param change - The confirmation, or the news that it never left.
 * @returns The content after it, or `undefined` when it changes nothing.
 */
const delivered = (
  content: Content,
  change: Extract<Change, { readonly _tag: "Confirmed" | "Unsent" }>
): Content | undefined => {
  if (
    content._tag !== "Message" ||
    content.ours === undefined ||
    content.ours.delivery._tag === "Confirmed" ||
    (change._tag === "Unsent" && content.ours.delivery._tag === "Unsent")
  ) {
    return undefined;
  }

  const delivery =
    change._tag === "Confirmed"
      ? { _tag: "Confirmed" as const, at: change.at, id: change.id, text: change.text }
      : { _tag: "Unsent" as const };

  return { ...content, ours: { ...content.ours, delivery } };
};

// Rows are decoded in one go, as one operation, since the Schemas need no services.
const decodeAll = <S extends Schema.Codec<unknown, unknown>>(schema: S, what: string) => {
  const decode = Schema.decodeUnknownExit(Schema.Array(schema));

  return (rows: readonly unknown[]) =>
    Effect.suspend(() => decode(rows)).pipe(Effect.mapError(failed(`cannot decode ${what}`)));
};

// Each decoder is made once, since making one compiles its Schema.
const decodeOurs = decodeAll(OursRow, "one of ours");
const decodeItems = decodeAll(ItemRow, "an item");
const decodeSummaries = decodeAll(SummaryRow, "a Timeline");
const decodeDirectory = decodeAll(DirectoryRow, "the directory");
const decodeTombstones = decodeAll(TombstoneRow, "a tombstone");
const decodeGaps = decodeAll(GapRow, "a Gap");

const decodeHead = Schema.decodeUnknownExit(
  Schema.Struct({ beyond: Schema.Literals([0, 1]), timeline: Schema.NullOr(TimelineId) })
);

const decodeInto = Schema.decodeUnknownExit(Schema.Struct({ into: Schema.NullOr(TimelineId) }));

/** A row of a window: its first names the Timeline, and the rest are items on a side. */
interface WindowText {
  readonly side: unknown;
  readonly beyond: unknown;
  readonly timeline: unknown;
}

/** Which items of a Timeline a read takes, by cursor. */
type Bound =
  | { readonly _tag: "All" }
  | { readonly _tag: "Below" | "AtOrBelow" | "Above" | "AtOrAbove"; readonly cursor: string };

/** One side of a window: the items it reads, nearest the position first, and how many. */
interface Side {
  readonly bound: Bound;
  readonly descending: boolean;
  readonly limit: number;
}

/**
 * How a window is read. `Before` and `After` read the side they show, one past what they
 * show, so they know whether more lie beyond it, and with a position, whether any lie on
 * the other side. `Around` reads both sides one past what it can show of each.
 */
type Plan =
  | {
      readonly _tag: "OneSide";
      readonly anchor: Extract<Anchor, { readonly _tag: "Before" | "After" }>;
      readonly shown: Side;
      readonly other: Bound | undefined;
    }
  | { readonly _tag: "BothSides"; readonly before: Side; readonly from: Side };

const all: Bound = { _tag: "All" };

const planOf = (anchor: Anchor, size: number): Plan => {
  const cursor = anchor.position === undefined ? undefined : cursorOf(anchor.position);

  switch (anchor._tag) {
    case "Before": {
      return {
        _tag: "OneSide",
        anchor,
        other: cursor === undefined ? undefined : { _tag: "AtOrAbove", cursor },
        shown: {
          bound: cursor === undefined ? all : { _tag: "Below", cursor },
          descending: true,
          limit: size + 1,
        },
      };
    }

    case "After": {
      return {
        _tag: "OneSide",
        anchor,
        other: cursor === undefined ? undefined : { _tag: "AtOrBelow", cursor },
        shown: {
          bound: cursor === undefined ? all : { _tag: "Above", cursor },
          descending: false,
          limit: size + 1,
        },
      };
    }

    case "Around": {
      const at = cursorOf(anchor.position);

      return {
        _tag: "BothSides",
        before: { bound: { _tag: "Below", cursor: at }, descending: true, limit: size + 1 },
        from: { bound: { _tag: "AtOrAbove", cursor: at }, descending: false, limit: size + 1 },
      };
    }

    default: {
      return anchor satisfies never;
    }
  }
};

/** A window's items in position order, and whether more lie beyond each end. */
interface Read<T> {
  readonly items: readonly T[];
  readonly earlier: boolean;
  readonly later: boolean;
}

/**
 * A `Before` or `After` window from the side it shows.
 * @param anchor - The window's anchor.
 * @param size - How many items it shows.
 * @param shown - The side it shows, nearest the position first, one past `size` if there are more.
 * @param beyond - Whether any items lie on the other side of the position.
 * @returns The window.
 */
const oneSide = <T>(
  anchor: Extract<Anchor, { readonly _tag: "Before" | "After" }>,
  size: number,
  shown: readonly T[],
  beyond: boolean
): Read<T> =>
  anchor._tag === "Before"
    ? { earlier: shown.length > size, items: shown.slice(0, size).toReversed(), later: beyond }
    : { earlier: beyond, items: shown.slice(0, size), later: shown.length > size };

/**
 * An `Around` window: as many items from the position on as before it, and more from either
 * side when the other runs out. Each side was read one past `size`, which is all this needs.
 * @param size - How many items it shows.
 * @param before - The items before the position, nearest first.
 * @param from - The items from the position on, nearest first.
 * @returns The window.
 */
const bothSides = <T>(size: number, before: readonly T[], from: readonly T[]): Read<T> => {
  const later = Math.min(from.length, size - Math.min(before.length, Math.floor(size / 2)));
  const earlier = Math.min(before.length, size - later);

  return {
    earlier: before.length > earlier,
    items: [...before.slice(0, earlier).toReversed(), ...from.slice(0, later)],
    later: from.length > later,
  };
};

const query = <A>(what: string, rows: Effect.Effect<A, SqlError | TimelineStoreFailed>) =>
  rows.pipe(
    Effect.catchTag("SqlError", (error) => Effect.fail(failed(`cannot read ${what}`)(error)))
  );

const prepare = (changes: readonly Change[]) =>
  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes the iterable first; it has no thisArg.
  Effect.forEach(changes, (change) =>
    change._tag === "Added"
      ? Schema.encodeEffect(ContentText)(change.content).pipe(
          Effect.map((content): Prepared => ({ _tag: "Added", change, content })),
          Effect.mapError(failed("cannot encode an item"))
        )
      : Effect.succeed<Prepared>({ _tag: "Other", change })
  );

const encodeDirectory = (directory: Directory) =>
  Schema.encodeEffect(DirectoryText)(directory).pipe(
    Effect.mapError(failed("cannot encode the directory"))
  );

/**
 * Opens a Timeline store in a SQLite file, creating it when it does not exist, and making
 * it again when it is not a store of this layout or does not decode. It is closed when the
 * Scope ends.
 * @param filename - The path of the database file.
 * @param options - Seams for tests.
 * @returns The store.
 */
export const makeSqliteTimelineStore = (
  filename: string,
  options: OpenOptions = {}
): Effect.Effect<TimelineStoreService, TimelineStoreFailed, Scope.Scope | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    // A path that cannot be opened, or a file that cannot be read now, is a failure, and
    // nothing is removed. A file that is not a store of this layout, or is damaged, is
    // derived, so it is made again.
    const found = yield* Effect.scoped(
      open(filename, options).pipe(
        Effect.flatMap((sql) =>
          inspect(sql).pipe(Effect.mapError(failed(`cannot read ${filename}`)))
        )
      )
    );

    if (found === "Unusable") {
      yield* Effect.logWarning(
        "The Timeline store is not of this layout, so it is made again"
      ).pipe(Effect.annotateLogs({ file: filename }));
      yield* remove(filename);
    }

    const sql = yield* open(filename, options);

    // A derived store may lag after a power failure, never run ahead of what it says it
    // folded: `through` commits with the rows it describes. So commits need not wait for
    // the disk, as the Journal's do.
    yield* sql`PRAGMA synchronous = NORMAL`.pipe(Effect.mapError(failed("cannot configure")));
    yield* sql
      .withTransaction(
        inspect(sql).pipe(
          Effect.flatMap((now): Effect.Effect<void, SqlError | TimelineStoreFailed> => {
            switch (now) {
              case "Empty": {
                return createLayout(sql);
              }

              case "Ready": {
                return Effect.void;
              }

              case "Unusable": {
                return Effect.fail(
                  new TimelineStoreFailed({ reason: `${filename} changed while it was opened` })
                );
              }

              default: {
                return now satisfies never;
              }
            }
          })
        )
      )
      .pipe(
        Effect.catchTag("SqlError", (error) => Effect.fail(failed("cannot make the store")(error)))
      );
    yield* sql`PRAGMA journal_mode = WAL`.pipe(Effect.mapError(failed("cannot configure")));

    // A read that takes more than one statement holds the connection, so it reads one state.
    const reading = <A>(what: string, effect: Effect.Effect<A, SqlError | TimelineStoreFailed>) =>
      sql
        .withTransaction(effect)
        .pipe(
          Effect.catchTag("SqlError", (error) => Effect.fail(failed(`cannot read ${what}`)(error)))
        );

    const foldedRow = query(
      "how far it has folded",
      sql`SELECT version, through FROM folded WHERE only = 1`
    ).pipe(
      Effect.flatMap((rows) =>
        Schema.decodeUnknownEffect(FoldedRow)(rows[0]).pipe(
          Effect.mapError(failed("cannot decode how far it has folded"))
        )
      )
    );

    // Timelines, each with the position of its last item, which the primary key finds.
    const summaries = (where: Fragment, order: Fragment) => sql`
      SELECT id, network, kind, name, key, changed,
        (SELECT max(cursor) FROM items WHERE items.timeline = timelines.id) AS latest
      FROM timelines ${where} ${order}
    `;

    const itemColumns = sql`timeline, cursor AS position, network, content, changed`;

    const touch = (timeline: TimelineId, sequence: number) =>
      sql`UPDATE timelines SET changed = ${sequence} WHERE id = ${timeline}`;

    const deliver = (change: Extract<Change, { readonly _tag: "Confirmed" | "Unsent" }>) =>
      Effect.gen(function* () {
        const rows = yield* sql`
          SELECT timeline, cursor, message_id AS messageId, content FROM items
          WHERE network = ${change.network} AND intent = ${change.intent}
          ORDER BY timeline, cursor
        `.pipe(Effect.flatMap(decodeOurs));

        for (const row of rows) {
          const content = delivered(row.content, change);

          if (content === undefined) {
            continue;
          }

          const text = yield* Schema.encodeEffect(ContentText)(content).pipe(
            Effect.mapError(failed("cannot encode an item"))
          );

          let messageId: MessageId | undefined = row.messageId;

          if (change._tag === "Confirmed" && change.messageId !== undefined) {
            const taken = yield* sql`
              SELECT 1 FROM items WHERE timeline = ${row.timeline} AND message_id = ${change.messageId}
            `;

            messageId = taken.length > 0 ? row.messageId : change.messageId;
          }

          yield* sql`
            UPDATE items SET content = ${text}, changed = ${change.sequence},
              message_id = ${textOrNull(messageId)}
            WHERE timeline = ${row.timeline} AND cursor = ${row.cursor}
          `;
          yield* touch(row.timeline, change.sequence);
        }
      });

    const added = (change: Extract<Change, { readonly _tag: "Added" }>, content: string) =>
      Effect.gen(function* () {
        const kept = yield* sql`
          INSERT INTO items (timeline, cursor, network, step, message_id, intent, content, changed)
          VALUES (${change.timeline}, ${cursorOf(change.position)}, ${change.network},
            ${change.position.sequence}, ${textOrNull(change.messageId)},
            ${textOrNull(change.intent)}, ${content}, ${change.sequence})
          ON CONFLICT DO NOTHING
          RETURNING 1 AS kept
        `;

        if (kept.length > 0) {
          yield* touch(change.timeline, change.sequence);
        }
      });

    const applyOne = (prepared: Prepared) =>
      Effect.gen(function* () {
        if (prepared._tag === "Added") {
          yield* added(prepared.change, prepared.content);

          return;
        }

        const { change } = prepared;

        switch (change._tag) {
          case "Described": {
            const { timeline } = change;

            yield* sql`
              INSERT INTO timelines (id, network, kind, name, key, changed)
              VALUES (${timeline.id}, ${timeline.network}, ${timeline.kind}, ${timeline.name},
                ${timeline.key}, ${change.sequence})
              ON CONFLICT (id) DO UPDATE SET network = excluded.network, kind = excluded.kind,
                name = excluded.name, key = excluded.key, changed = excluded.changed
            `;
            break;
          }

          case "Confirmed":
          case "Unsent": {
            yield* deliver(change);
            break;
          }

          case "Merged": {
            // Each item moves by the rule `Added` keeps: one whose position or message id
            // `into` already has is dropped. `from`'s items share neither among themselves.
            yield* sql`
              INSERT INTO items (timeline, cursor, network, step, message_id, intent, content, changed)
              SELECT ${change.into}, cursor, network, step, message_id, intent, content, ${change.sequence}
              FROM items WHERE timeline = ${change.from}
              ON CONFLICT DO NOTHING
            `;
            yield* sql`DELETE FROM items WHERE timeline = ${change.from}`;
            yield* sql`DELETE FROM timelines WHERE id = ${change.from}`;
            yield* sql`
              UPDATE tombstones SET into_id = ${change.into}, changed = ${change.sequence}
              WHERE into_id = ${change.from}
            `;
            yield* sql`
              INSERT INTO tombstones (id, network, into_id, changed)
              VALUES (${change.from}, ${change.network}, ${change.into}, ${change.sequence})
              ON CONFLICT (id) DO UPDATE SET network = excluded.network,
                into_id = excluded.into_id, changed = excluded.changed
            `;
            yield* touch(change.into, change.sequence);
            break;
          }

          case "Gap": {
            yield* sql`
              INSERT INTO gaps (network, from_cursor, to_cursor, changed)
              VALUES (${change.network}, ${cursorOf(change.from)}, ${cursorOrNull(change.to)},
                ${change.sequence})
              ON CONFLICT (network, from_cursor) DO UPDATE SET to_cursor = excluded.to_cursor,
                changed = excluded.changed
            `;
            break;
          }

          default: {
            change satisfies never;
            break;
          }
        }
      });

    // The first `count` sequences after `since` that changed anything, in order.
    const sequencesAfter = (since: number, count: number) =>
      sql<{ readonly changed: number }>`
        SELECT changed FROM (
          SELECT * FROM (SELECT DISTINCT changed FROM timelines WHERE changed > ${since} ORDER BY changed LIMIT ${count})
          UNION SELECT * FROM (SELECT DISTINCT changed FROM items WHERE changed > ${since} ORDER BY changed LIMIT ${count})
          UNION SELECT * FROM (SELECT DISTINCT changed FROM tombstones WHERE changed > ${since} ORDER BY changed LIMIT ${count})
          UNION SELECT * FROM (SELECT DISTINCT changed FROM gaps WHERE changed > ${since} ORDER BY changed LIMIT ${count})
        ) ORDER BY changed LIMIT ${count}
      `.pipe(Effect.map((rows) => rows.map(({ changed }) => changed)));

    // How many things each sequence in `(since, upTo]` changed.
    const countsUpTo = (since: number, upTo: number) =>
      sql<{ readonly changed: number; readonly count: number }>`
        SELECT changed, count(*) AS count FROM (
          SELECT changed FROM timelines WHERE changed > ${since} AND changed <= ${upTo}
          UNION ALL SELECT changed FROM items WHERE changed > ${since} AND changed <= ${upTo}
          UNION ALL SELECT changed FROM tombstones WHERE changed > ${since} AND changed <= ${upTo}
          UNION ALL SELECT changed FROM gaps WHERE changed > ${since} AND changed <= ${upTo}
        ) GROUP BY changed
      `.pipe(Effect.map((rows) => new Map(rows.map(({ changed, count }) => [changed, count]))));

    const lastChanged = (since: number) =>
      sql<{ readonly last: number | null }>`
        SELECT max(last) AS last FROM (
          SELECT max(changed) AS last FROM timelines WHERE changed > ${since}
          UNION ALL SELECT max(changed) FROM items WHERE changed > ${since}
          UNION ALL SELECT max(changed) FROM tombstones WHERE changed > ${since}
          UNION ALL SELECT max(changed) FROM gaps WHERE changed > ${since}
        )
      `.pipe(Effect.map((rows) => rows[0]?.last ?? undefined));

    // The last sequence a page gives: whole sequences, until at least `limit` things.
    const pageThrough = (since: number, limit: number | undefined) =>
      Effect.gen(function* () {
        if (limit === undefined || Number.isNaN(limit)) {
          return yield* lastChanged(since);
        }

        const sequences = yield* sequencesAfter(since, Math.max(0, Math.ceil(limit)));
        const upTo = sequences.at(-1);

        if (upTo === undefined) {
          return upTo;
        }

        const counts = yield* countsUpTo(since, upTo);
        let through: number | undefined;
        let given = 0;

        for (const sequence of sequences) {
          if (given >= limit) {
            break;
          }

          through = sequence;
          given += counts.get(sequence) ?? 0;
        }

        return through;
      });

    const changedAfter = (after: number | undefined, limit: number | undefined) =>
      Effect.gen(function* () {
        const since = after ?? 0;
        const through = yield* pageThrough(since, limit);
        const upTo = through ?? since;

        // Without a limit, a page gives everything, so nothing more is left.
        const more =
          limit !== undefined && !Number.isNaN(limit) && (yield* lastChanged(upTo)) !== undefined;

        const timelines = yield* summaries(
          sql`WHERE changed > ${since} AND changed <= ${upTo}`,
          sql`ORDER BY changed, id`
        ).pipe(Effect.flatMap(decodeSummaries));

        const items = yield* sql`
          SELECT ${itemColumns} FROM items WHERE changed > ${since} AND changed <= ${upTo}
          ORDER BY changed, timeline, cursor
        `.pipe(Effect.flatMap(decodeItems));

        const merged = yield* sql`
          SELECT id, network, into_id AS "into", changed FROM tombstones
          WHERE changed > ${since} AND changed <= ${upTo}
          ORDER BY changed, id
        `.pipe(Effect.flatMap(decodeTombstones));

        // Network ids compare as BINARY text, which is UTF-8 bytes, so by code point.
        const gaps = yield* sql`
          SELECT network, from_cursor AS "from", to_cursor AS "to", changed FROM gaps
          WHERE changed > ${since} AND changed <= ${upTo}
          ORDER BY changed, network, from_cursor
        `.pipe(Effect.flatMap(decodeGaps));

        // With nothing more to give, everything through the last step folded has been.
        const folded = [(yield* foldedRow).through, after].filter((each) => each !== undefined);

        return {
          gaps,
          items,
          merged,
          more,
          through: more || folded.length === 0 ? through : Math.max(...folded),
          timelines,
        } satisfies Changed;
      });

    const bound = (each: Bound) => {
      switch (each._tag) {
        case "All": {
          return sql``;
        }

        case "Below": {
          return sql`AND cursor < ${each.cursor}`;
        }

        case "AtOrBelow": {
          return sql`AND cursor <= ${each.cursor}`;
        }

        case "Above": {
          return sql`AND cursor > ${each.cursor}`;
        }

        case "AtOrAbove": {
          return sql`AND cursor >= ${each.cursor}`;
        }

        default: {
          return each satisfies never;
        }
      }
    };

    const side = (name: string, timeline: TimelineId, each: Side) => sql`
      UNION ALL SELECT * FROM (
        SELECT ${name}, 0, ${itemColumns} FROM items
        WHERE timeline = ${timeline} ${bound(each.bound)}
        ORDER BY cursor ${each.descending ? sql`DESC` : sql`ASC`} LIMIT ${each.limit}
      )
    `;

    // A window of a Timeline is one statement, so it reads one state without a transaction.
    // Its first row says whether the Timeline exists, and whether any items lie on the side
    // it does not show. The rows after it are each side's items, nearest first.
    const windowRows = (timeline: TimelineId, plan: Plan) => {
      const other =
        plan._tag === "OneSide" && plan.other !== undefined
          ? sql`EXISTS (SELECT 1 FROM items WHERE timeline = ${timeline} ${bound(plan.other)})`
          : sql`0`;

      const sides =
        plan._tag === "OneSide"
          ? side("shown", timeline, plan.shown)
          : sql`${side("before", timeline, plan.before)} ${side("from", timeline, plan.from)}`;

      return sql<WindowText>`
        SELECT 'head' AS side, ${other} AS beyond,
          (SELECT id FROM timelines WHERE id = ${timeline}) AS timeline,
          NULL AS position, NULL AS network, NULL AS content, NULL AS changed
        ${sides}
      `;
    };

    // The window of a Timeline, or none when no Timeline has the id.
    const windowOn = (timeline: TimelineId, anchor: Anchor, size: number) =>
      Effect.gen(function* () {
        const plan = planOf(anchor, size);
        const rows = yield* windowRows(timeline, plan);

        const head = yield* Effect.suspend(() =>
          decodeHead(rows.find((row) => row.side === "head"))
        ).pipe(Effect.mapError(failed("cannot decode a window")));

        if (head.timeline === null) {
          return Option.none();
        }

        const on = (name: string) => decodeItems(rows.filter((row) => row.side === name));

        const read =
          plan._tag === "OneSide"
            ? oneSide(plan.anchor, size, yield* on("shown"), head.beyond === 1)
            : bothSides(size, yield* on("before"), yield* on("from"));

        return Option.some({ timeline: head.timeline, ...read });
      });

    // A merged id reads the Timeline its tombstone names, in one transaction with finding it.
    const window = (timeline: TimelineId, anchor: Anchor, limit: number) =>
      Effect.gen(function* () {
        const size = Math.max(0, Math.floor(limit));
        const found = yield* query("a window", windowOn(timeline, anchor, size));

        if (Option.isSome(found)) {
          return found;
        }

        return yield* reading(
          "a merged Timeline's window",
          Effect.gen(function* () {
            const into =
              yield* sql`SELECT into_id AS "into" FROM tombstones WHERE id = ${timeline}`;

            const merged = yield* Effect.suspend(() => decodeInto(into[0] ?? { into: null })).pipe(
              Effect.mapError(failed("cannot decode a tombstone"))
            );

            return merged.into === null
              ? Option.none()
              : yield* windowOn(merged.into, anchor, size);
          })
        );
      });

    return {
      // Once begun, an apply runs to its end, encoding included, and an interruption waits
      // for it. A failure rolls the transaction back, so nothing of it is kept.
      apply: (applied: Applied) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const prepared = yield* prepare(applied.changes);
            const directory = yield* encodeDirectory(applied.directory);

            yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  const rows = yield* sql<{
                    readonly through: number | null;
                  }>`SELECT through FROM folded WHERE only = 1`;

                  const through = rows[0]?.through ?? undefined;

                  if (through !== undefined && applied.through <= through) {
                    return;
                  }

                  for (const each of prepared) {
                    yield* applyOne(each);
                  }

                  yield* sql`
                    UPDATE folded SET through = ${applied.through}, directory = ${directory}
                    WHERE only = 1
                  `;
                })
              )
              .pipe(
                Effect.catchTag("SqlError", (error) => Effect.fail(failed("cannot apply")(error)))
              );
          })
        ),
      changedAfter: (after, limit) => reading("what changed", changedAfter(after, limit)),
      directory: query(
        "the directory",
        sql`SELECT directory FROM folded WHERE only = 1`.pipe(Effect.flatMap(decodeDirectory))
      ).pipe(
        Effect.flatMap(([row]) =>
          row === undefined
            ? Effect.fail(new TimelineStoreFailed({ reason: "it holds no directory" }))
            : Effect.succeed(row.directory)
        )
      ),
      folded: foldedRow.pipe(Effect.map(({ through, version }): Folded => ({ through, version }))),
      gaps: (network, range) =>
        query(
          "the Gaps",
          sql`
          SELECT network, from_cursor AS "from", to_cursor AS "to", changed FROM gaps
          WHERE network = ${network}
            ${range.to === undefined ? sql`` : sql`AND from_cursor <= ${cursorOf(range.to)}`}
            ${range.from === undefined ? sql`` : sql`AND (to_cursor IS NULL OR to_cursor >= ${cursorOf(range.from)})`}
          ORDER BY from_cursor
        `
        ).pipe(Effect.flatMap(decodeGaps)),
      locate: (network, sequence) =>
        query(
          "a step's items",
          sql`
          SELECT ${itemColumns} FROM items WHERE network = ${network} AND step = ${sequence}
          ORDER BY cursor, timeline
        `
        ).pipe(Effect.flatMap(decodeItems)),
      reset: (version) =>
        Effect.uninterruptible(
          sql.withTransaction(
            Effect.gen(function* () {
              for (const table of ["items", "timelines", "tombstones", "gaps"]) {
                yield* sql.unsafe(`DELETE FROM ${table}`);
              }

              yield* sql`
                UPDATE folded SET version = ${version}, through = NULL,
                  directory = ${emptyDirectoryText}
                WHERE only = 1
              `;
            })
          )
        ).pipe(Effect.mapError(failed("cannot reset"))),
      timelines: (network) =>
        query("the Timelines", summaries(sql`WHERE network = ${network}`, sql`ORDER BY id`)).pipe(
          Effect.flatMap(decodeSummaries)
        ),
      window,
    } satisfies TimelineStoreService;
  });

/**
 * The Timeline store port, in a SQLite file.
 * @param filename - The path of the database file.
 * @returns A Layer providing the store, which makes a file it cannot use again.
 */
export const layerSqliteTimelineStore = (filename: string) =>
  Layer.effect(TimelineStore)(makeSqliteTimelineStore(filename));
