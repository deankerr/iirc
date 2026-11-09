// ADR 0005 prefers Effect's SQL, and it is enough here: `@effect/sql-sqlite-bun` runs on
// `bun:sqlite`, serializes access to the one connection, and starts transactions with
// `BEGIN IMMEDIATE`. Its only gap is that `executeStream` is not implemented, so `read`
// pages through the table by sequence instead of streaming one statement.
import { SqliteClient } from "@effect/sql-sqlite-bun";
import {
  Journal,
  JournalFailed,
  JournalRecord,
  JournalVersionMismatch,
  Sequence,
  journalVersion,
} from "@iirc/runtime/journal";
import type { Entry, JournalService, Position } from "@iirc/runtime/journal";
import { Effect, Layer, Option, PubSub, Schema, Semaphore, Stream } from "effect";
import type { Scope } from "effect";
import { Reactivity } from "effect/reactivity";
import type { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/** How many Entries one statement reads. A bound on memory, not on what a stream gives. */
const pageSize = 500;

// A record is stored as the JSON text of its Schema encoding, so the file can be read by
// anything that reads JSON, and a parser fix never needs a rewrite of history.
const recordText = Schema.fromJsonString(Schema.toCodecJson(JournalRecord));
const rowSchema = Schema.Struct({ record: recordText, sequence: Sequence });

const failed = (what: string) => (cause: { readonly message: string }) =>
  new JournalFailed({ reason: `${what}: ${cause.message}` });

const matches = (from: Position) => (entry: Entry) =>
  entry.sequence > (from.after ?? 0) &&
  (from.network === undefined || entry.record.network === from.network);

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

/**
 * Opens a Journal in a SQLite file, creating it if it does not exist. It is closed when
 * the Scope ends.
 * @param filename - The path of the database file.
 * @returns The Journal.
 */
export const makeSqliteJournal = (
  filename: string
): Effect.Effect<JournalService, JournalFailed | JournalVersionMismatch, Scope.Scope> =>
  Effect.gen(function* () {
    const sql = yield* SqliteClient.make({ filename }).pipe(
      Effect.provide(Reactivity.layer),
      Effect.mapError(failed(`cannot open ${filename}`))
    );

    // Each commit waits for the WAL to reach the disk, so an append that has returned
    // survives a crash of the process and of the machine.
    yield* sql`PRAGMA synchronous = FULL`.pipe(Effect.mapError(failed("cannot configure")));
    yield* openJournal(sql).pipe(
      Effect.catchTag("SqlError", (error: SqlError) =>
        Effect.fail(failed("cannot open the Journal")(error))
      )
    );

    const appended = yield* Effect.acquireRelease(PubSub.unbounded<Entry>(), PubSub.shutdown);
    const lock = yield* Semaphore.make(1);

    const decodeRows = (rows: readonly (typeof rowSchema.Encoded)[]) =>
      // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes the iterable first; it has no thisArg.
      Effect.forEach(rows, (row) =>
        Schema.decodeEffect(rowSchema)(row).pipe(Effect.mapError(failed("cannot decode an Entry")))
      );

    const last = sql<{
      readonly last: number;
    }>`SELECT coalesce(max(sequence), 0) AS last FROM journal`.pipe(
      Effect.map((rows) => rows[0]?.last ?? 0),
      Effect.mapError(failed("cannot read the Journal"))
    );

    // Pages through the Entries after a position, up to a sequence that was settled before
    // the first page, so the stream ends where the Journal stood and no later.
    const upTo = (from: Position, end: number): Stream.Stream<Entry, JournalFailed> =>
      Stream.paginate(from.after ?? 0, (cursor) =>
        sql<typeof rowSchema.Encoded>`
          SELECT sequence, record FROM journal
          WHERE sequence > ${cursor} AND sequence <= ${end}
          ${from.network === undefined ? sql`` : sql`AND network = ${from.network}`}
          ORDER BY sequence LIMIT ${pageSize}
        `.pipe(
          Effect.mapError(failed("cannot read the Journal")),
          Effect.flatMap(decodeRows),
          Effect.map((entries) => {
            const final = entries.at(-1);

            return [
              entries,
              final !== undefined && entries.length === pageSize
                ? Option.some<number>(final.sequence)
                : Option.none<number>(),
            ] as const;
          })
        )
      );

    return {
      // One append at a time, so Entries are published in the order they are numbered. The
      // insert and the publish cannot be interrupted apart, or a follower would miss an
      // Entry that a read would give. The record is decoded back before it is inserted, so
      // nothing is kept that could not be read.
      append: (record: JournalRecord) =>
        Effect.gen(function* () {
          const text = yield* Schema.encodeEffect(recordText)(record).pipe(
            Effect.mapError(failed("cannot encode the record"))
          );

          const stored = yield* Schema.decodeEffect(recordText)(text).pipe(
            Effect.mapError(failed("cannot decode the record"))
          );

          return yield* lock.withPermit(
            Effect.uninterruptible(
              Effect.gen(function* () {
                const rows = yield* sql<{ readonly sequence: number }>`
                  INSERT INTO journal (record) VALUES (${text}) RETURNING sequence
                `.pipe(Effect.mapError(failed("cannot append")));

                const sequence = yield* Schema.decodeEffect(Sequence)(rows[0]?.sequence ?? 0).pipe(
                  Effect.mapError(failed("cannot number the Entry"))
                );

                yield* PubSub.publish(appended, { record: stored, sequence });

                return sequence;
              })
            )
          );
        }),
      // Subscribes before settling where the past ends, so an Entry appended in between is
      // in the past or in the subscription, and the sequence cut keeps it from being in both.
      follow: (from: Position) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const live = yield* PubSub.subscribe(appended);
            const end = yield* last;

            return Stream.concat(
              upTo(from, end),
              Stream.fromSubscription(live).pipe(
                Stream.filter((entry) => entry.sequence > end && matches(from)(entry))
              )
            );
          })
        ),
      read: (from: Position) => Stream.unwrap(last.pipe(Effect.map((end) => upTo(from, end)))),
    } satisfies JournalService;
  });

/**
 * The Journal port, in a SQLite file.
 * @param filename - The path of the database file.
 * @returns A Layer providing the Journal, which refuses a file of another version.
 */
export const layerSqliteJournal = (filename: string) =>
  Layer.effect(Journal)(makeSqliteJournal(filename));
