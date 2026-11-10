// ADR 0005 prefers Effect's SQL, and it is enough here: `@effect/sql-sqlite-bun` runs on
// `bun:sqlite`, serializes access to the one connection, and starts transactions with
// `BEGIN IMMEDIATE`. Its only gap is that `executeStream` is not implemented, so `read`
// pages through the table by sequence instead of streaming one statement.
//
// Followers never hold Entries. An append says only "look again" on a signal that keeps
// nothing but one pending wake-up, and a follower fetches what it has not yet delivered
// from the table, a page at a time. A slow follower therefore costs a wake-up, not a backlog.
import { SqliteClient } from "@effect/sql-sqlite-bun";
import {
  Journal,
  JournalFailed,
  JournalRecord,
  JournalVersionMismatch,
  Sequence,
  journalVersion,
} from "@iirc/runtime/journal";
import type { JournalService, Position } from "@iirc/runtime/journal";
import { Effect, Layer, Option, PubSub, Schema, Semaphore, Stream } from "effect";
import type { Scope } from "effect";
import { Reactivity } from "effect/reactivity";
import type { SqlClient } from "effect/sql/SqlClient";
import { SqlError } from "effect/sql/SqlError";

/** How many Entries one statement reads. A bound on memory, not on what a stream gives. */
const pageSize = 500;

// A record is stored as the JSON text of its Schema encoding, so the file can be read by
// anything that reads JSON, and a parser fix never needs a rewrite of history.
const recordText = Schema.fromJsonString(Schema.toCodecJson(JournalRecord));
const rowSchema = Schema.Struct({ record: recordText, sequence: Sequence });

// What SQLite itself said, when the error carries it. An SQL error's own message is
// generic, and keeps SQLite's error in its reason's cause. Another error may keep one in
// its cause. The text is only carried into the reason to be read, never decided from.
const failed =
  (what: string) => (error: { readonly message: string; readonly cause?: unknown }) => {
    const native = error instanceof SqlError ? error.reason.cause : error.cause;

    return new JournalFailed({
      reason: `${what}: ${native instanceof Error ? native.message : error.message}`,
    });
  };

// The one place the table is created. `network` is derived from the record, so it cannot
// disagree with it, and the index makes reading one Network cheap.
const createJournal = (sql: SqlClient) =>
  Effect.gen(function* () {
    yield* sql`
      CREATE TABLE journal (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        record TEXT NOT NULL CHECK (json_valid(record)),
        network TEXT NOT NULL GENERATED ALWAYS AS (json_extract(record, '$.network')) VIRTUAL
      ) STRICT
    `;
    yield* sql`CREATE INDEX journal_by_network ON journal (network)`;
    yield* sql.unsafe(`PRAGMA user_version = ${journalVersion}`);
  });

const mustBeThisVersion = (found: number) =>
  found === journalVersion
    ? Effect.void
    : Effect.fail(new JournalVersionMismatch({ expected: journalVersion, found }));

// A file with nothing in it is a new Journal. Anything else must carry this version.
const openJournal = (sql: SqlClient) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const versions = yield* sql<{
        readonly version: number;
      }>`SELECT user_version AS version FROM pragma_user_version`;

      const objects = yield* sql<{
        readonly count: number;
      }>`SELECT count(*) AS count FROM sqlite_master`;

      const found = versions[0]?.version ?? 0;
      const empty = found === 0 && objects[0]?.count === 0;

      yield* empty ? createJournal(sql) : mustBeThisVersion(found);
    })
  );

/** A Journal, and how many signals its slowest follower has yet to take. */
export interface OpenedJournal {
  readonly journal: JournalService;
  /** At most one however many appends a follower has missed. Not part of the port. */
  readonly backlog: Effect.Effect<number>;
}

/** How far a stream has delivered, and how far the Journal is known to be committed. */
interface Progress {
  readonly delivered: number;
  readonly committed: number;
}

/** Seams for tests. */
export interface OpenOptions {
  /** Runs after an Entry is inserted and before it is signalled, to make the scheduler yield there. */
  readonly afterInsert?: Effect.Effect<void> | undefined;
}

/**
 * Opens a Journal in a SQLite file, creating it if it does not exist, and gives it with
 * the size of its followers' backlog, which tests check. It is closed when the Scope ends.
 * @param filename - The path of the database file.
 * @param options - Seams for tests.
 * @returns The Journal and its backlog.
 */
export const openSqliteJournal = (
  filename: string,
  options: OpenOptions = {}
): Effect.Effect<OpenedJournal, JournalFailed | JournalVersionMismatch, Scope.Scope> =>
  Effect.gen(function* () {
    // The file is opened as it is. Nothing that persists in it is changed until it is known
    // to be a Journal, so a file that is refused is left exactly as it was found.
    const sql = yield* SqliteClient.make({ disableWAL: true, filename }).pipe(
      Effect.provide(Reactivity.layer),
      Effect.mapError(failed(`cannot open ${filename}`))
    );

    // Each commit waits for the log to reach the disk, so an append that has returned
    // survives a crash of the process and of the machine. This is per connection.
    yield* sql`PRAGMA synchronous = FULL`.pipe(Effect.mapError(failed("cannot configure")));
    yield* openJournal(sql).pipe(
      Effect.catchTag("SqlError", (error) => Effect.fail(failed("cannot open the Journal")(error)))
    );
    yield* sql`PRAGMA journal_mode = WAL`.pipe(Effect.mapError(failed("cannot configure")));

    // "Look again", and nothing else. Capacity 1 and sliding means a subscriber that is not
    // taking holds one signal, whatever is appended meanwhile.
    const committed = yield* Effect.acquireRelease(PubSub.sliding<undefined>(1), PubSub.shutdown);
    const lock = yield* Semaphore.make(1);

    const decodeRow = (row: typeof rowSchema.Encoded) =>
      Schema.decodeEffect(rowSchema)(row).pipe(Effect.mapError(failed("cannot decode an Entry")));

    const last = sql<{
      readonly last: number;
    }>`SELECT coalesce(max(sequence), 0) AS last FROM journal`.pipe(
      Effect.map((rows) => rows[0]?.last ?? 0),
      Effect.mapError(failed("cannot read the Journal"))
    );

    // One page of rows after what has been delivered, up to what is committed. A page that
    // is not full has everything up to `committed` that matches, so that is where the
    // stream has got to, whichever Entries it skipped for another Network.
    const page = (from: Position, progress: Progress) =>
      sql<typeof rowSchema.Encoded>`
        SELECT sequence, record FROM journal
        WHERE sequence > ${progress.delivered} AND sequence <= ${progress.committed}
        ${from.network === undefined ? sql`` : sql`AND network = ${from.network}`}
        ORDER BY sequence LIMIT ${pageSize}
      `.pipe(
        Effect.mapError(failed("cannot read the Journal")),
        Effect.map((rows) => {
          const final = rows.at(-1);

          return [
            rows,
            {
              committed: progress.committed,
              delivered:
                final !== undefined && rows.length === pageSize
                  ? final.sequence
                  : progress.committed,
            },
          ] as const;
        })
      );

    // Rows are decoded one at a time as they are given, so those before a damaged record
    // reach the reader, and then the stream fails.
    const entries = (rows: Stream.Stream<typeof rowSchema.Encoded, JournalFailed>) =>
      rows.pipe(Stream.mapEffect(decodeRow));

    const read = (from: Position, end: number) =>
      entries(
        Stream.paginate<Progress, typeof rowSchema.Encoded, JournalFailed>(
          { committed: end, delivered: from.after ?? 0 },
          (progress) =>
            page(from, progress).pipe(
              Effect.map(([rows, next]) => [
                rows,
                next.delivered < next.committed ? Option.some(next) : Option.none(),
              ])
            )
        )
      );

    return {
      backlog: PubSub.size(committed),
      journal: {
        // The record is decoded back before it is inserted, so nothing is kept that could not
        // be read. One append at a time, from insert to signal, so Entries are committed,
        // completed and signalled in the order they are numbered. The scheduler may yield
        // between the insert and the signal, and the one connection does not prevent that. The
        // insert and the signal cannot be interrupted apart, or a follower could sleep through
        // an Entry.
        append: (record: JournalRecord) =>
          Effect.gen(function* () {
            const text = yield* Schema.encodeEffect(recordText)(record).pipe(
              Effect.mapError(failed("cannot encode the record"))
            );

            yield* Schema.decodeEffect(recordText)(text).pipe(
              Effect.mapError(failed("cannot decode the record"))
            );

            return yield* lock.withPermit(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const rows = yield* sql<{ readonly sequence: number }>`
                  INSERT INTO journal (record) VALUES (${text}) RETURNING sequence
                `.pipe(Effect.mapError(failed("cannot append")));

                  const sequence = yield* Schema.decodeEffect(Sequence)(
                    rows[0]?.sequence ?? 0
                  ).pipe(Effect.mapError(failed("cannot number the Entry")));

                  yield* options.afterInsert ?? Effect.void;
                  yield* PubSub.publish(committed, undefined);

                  return sequence;
                })
              )
            );
          }),
        // Subscribes before settling where the past ends, so an Entry appended in between is
        // covered by the past or by a signal. Then it pages from the table whenever the
        // Journal is committed further than it has delivered. When it has caught up it waits
        // for a signal, which only tells it to look again: it reads where the Journal ends now
        // and trusts no number from a signal.
        follow: (from: Position) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const signal = yield* PubSub.subscribe(committed);
              const end = yield* last;

              return entries(
                Stream.paginate<Progress, typeof rowSchema.Encoded, JournalFailed>(
                  { committed: end, delivered: from.after ?? 0 },
                  (progress) =>
                    progress.delivered < progress.committed
                      ? page(from, progress).pipe(
                          Effect.map(([rows, next]) => [rows, Option.some(next)])
                        )
                      : PubSub.take(signal).pipe(
                          Effect.andThen(last),
                          Effect.map((end) => [
                            [],
                            Option.some({
                              committed: Math.max(progress.committed, end),
                              delivered: progress.delivered,
                            }),
                          ])
                        )
                )
              );
            })
          ),
        read: (from: Position) => Stream.unwrap(last.pipe(Effect.map((end) => read(from, end)))),
      } satisfies JournalService,
    };
  });

/**
 * Opens a Journal in a SQLite file, creating it if it does not exist. It is closed when
 * the Scope ends.
 * @param filename - The path of the database file.
 * @returns The Journal.
 */
export const makeSqliteJournal = (
  filename: string
): Effect.Effect<JournalService, JournalFailed | JournalVersionMismatch, Scope.Scope> =>
  openSqliteJournal(filename).pipe(Effect.map(({ journal }) => journal));

/**
 * The Journal port, in a SQLite file.
 * @param filename - The path of the database file.
 * @returns A Layer providing the Journal, which refuses a file of another version.
 */
export const layerSqliteJournal = (filename: string) =>
  Layer.effect(Journal)(makeSqliteJournal(filename));
