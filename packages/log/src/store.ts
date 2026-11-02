import type { Entry } from "@iirc/session/entry";
import { RecordFailed } from "@iirc/session/recorder";
import type { Recorder } from "@iirc/session/recorder";
import { noStanding, noStandings } from "@iirc/session/standing";
import type { Gap, Standings } from "@iirc/session/standing";
import { Array as Arr, Clock, Effect, pipe, Ref, Schema, Semaphore } from "effect";
import { SqlSchema } from "effect/sql";
import type { SqlClient } from "effect/sql";
import { isSqlError } from "effect/sql/SqlError";

import { StorageFailed } from "./errors.ts";
import { foldEntries } from "./fold.ts";
import type { Folded, LoggedMessage } from "./fold.ts";
import { EntryRow, GapPage, GapRow, MessageRow, Page } from "./rows.ts";

// How many Entries a replay holds in memory at once.
const replayPageSize = 1000;

// How many Messages a rebuild inserts with one statement. At seven columns that is under
// the 999 bound parameters of the smallest limit SQLite has shipped with, so no build of
// it can refuse one, whatever a page of Entries turns out to hold.
const rebuildBatchSize = 128;

const toStorageFailed = (cause: unknown) => new StorageFailed({ cause });

/**
 * Builds what the Log does over an open database. It rebuilds first, which is the one
 * pass over Entries at startup: it makes every derived table whole, and it leaves the
 * Standings to pick up from where the last process left off (LOG-10).
 * @param sql - The migrated client, which must have no other writer.
 * @returns The operations of both `Log` and `Recorder`.
 */
export const makeStore = Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
  const readHead = Effect.map(
    sql<{ readonly head: number | null }>`SELECT MAX(sequence) AS head FROM entries`,
    ([row]) => row?.head ?? 0
  );

  const readEntries = SqlSchema.findAll({
    Request: Page,
    Result: EntryRow,
    execute: ({ after, limit }) =>
      sql`SELECT * FROM entries WHERE sequence > ${after} ORDER BY sequence LIMIT ${limit}`,
  });

  const readMessages = SqlSchema.findAll({
    Request: Page,
    Result: MessageRow,
    execute: ({ after, limit }) =>
      sql`SELECT * FROM messages WHERE sequence > ${after} ORDER BY sequence LIMIT ${limit}`,
  });

  // `network` is NULL to ask for every Network, which the table is small enough to scan.
  const readGaps = SqlSchema.findAll({
    Request: GapPage,
    Result: GapRow,
    execute: ({ after, limit, network = null }) => sql`
      SELECT * FROM gaps
      WHERE sequence > ${after} AND (${network} IS NULL OR network = ${network})
      ORDER BY sequence LIMIT ${limit}
    `,
  });

  // One statement per row, because a socket read can hold more Lines than a single
  // statement can bind, and those Lines are chosen by the Network.
  const insertEntry = SqlSchema.void({
    Request: EntryRow,
    execute: (row) => sql`INSERT INTO entries ${sql.insert(row)}`,
  });

  const insertMessage = SqlSchema.void({
    Request: MessageRow,
    execute: (row) => sql`INSERT INTO messages ${sql.insert(row)}`,
  });

  const insertMessages = (messages: readonly LoggedMessage[]) =>
    Effect.forEach(messages, insertMessage, { discard: true });

  // Keyed by where a Gap began, so a Gap's end replaces its own row.
  const writeGap = SqlSchema.void({
    Request: GapRow,
    execute: (row) => sql`INSERT OR REPLACE INTO gaps ${sql.insert(row)}`,
  });

  const writeGaps = (gaps: readonly Gap[]) => Effect.forEach(gaps, writeGap, { discard: true });

  // Only a rebuild, which has a known page size and a whole table to fill, does this.
  const insertMessageBatch = SqlSchema.void({
    Request: Schema.NonEmptyArray(MessageRow),
    execute: (rows) => sql`INSERT INTO messages ${sql.insert(rows)}`,
  });

  const insertMessageBatches = (messages: readonly LoggedMessage[]) =>
    Effect.forEach(Arr.chunksOf(messages, rebuildBatchSize), insertMessageBatch, { discard: true });

  const replay = Effect.fnUntraced(function* <E>(
    onPage: (folded: Folded) => Effect.Effect<void, E>
  ) {
    let standings = noStandings;
    let after = 0;
    let page: readonly Entry[] = [];

    do {
      page = yield* readEntries({ after, limit: replayPageSize });

      const folded = foldEntries(standings, page);

      yield* onPage(folded);

      ({ standings } = folded);
      after = page.at(-1)?.sequence ?? after;
    } while (page.length === replayPageSize);

    return standings;
  });

  const standings = yield* Ref.make(noStandings);

  // One writer at a time, so that the Standings a transaction folds from are the ones
  // the last commit left. The client's own lock is no use here, because it is
  // released before `standings` is set, and the next writer would read stale state.
  const writer = yield* Semaphore.make(1);

  // Runs a transaction that yields new Standings, and publishes them only once they
  // are durable, so that a rollback has nothing to undo. Nothing here can be
  // interrupted, so `standings` never misses a commit, and what `within` saw is
  // always either committed or reported as a failure.
  const commit = <A, E>(
    transaction: (current: Standings) => Effect.Effect<readonly [A, Standings], E>
  ) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(standings);
      const [result, next] = yield* sql.withTransaction(transaction(current));

      yield* Ref.set(standings, next);

      return result;
    }).pipe(
      // A COMMIT that fails and cannot be cleaned up dies, but it is still storage.
      Effect.catchDefect((defect) =>
        isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect)
      ),
      Effect.uninterruptible,
      writer.withPermits(1)
    );

  const record: Recorder["Service"]["record"] = (entries, within) =>
    commit((current) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        const head = yield* readHead;

        const recorded = pipe(
          entries,
          Arr.map((entry, index): Entry => ({ ...entry, at, sequence: head + index + 1 }))
        );

        yield* Effect.forEach(recorded, insertEntry, { discard: true });

        const folded = foldEntries(current, recorded);

        yield* insertMessages(folded.messages);
        yield* writeGaps(folded.gaps);

        const result = yield* Effect.sync(() => within(recorded));

        return [result, folded.standings] as const;
      })
    ).pipe(Effect.mapError((cause) => new RecordFailed({ cause })));

  // Unlike a record, a rebuild can run long, and abandoning one loses nothing.
  const rebuild = commit(() =>
    Effect.gen(function* () {
      yield* sql`DELETE FROM messages`;
      yield* sql`DELETE FROM gaps`;

      const rebuilt = yield* replay(({ gaps, messages }) =>
        Effect.andThen(insertMessageBatches(messages), writeGaps(gaps))
      );

      return [undefined, rebuilt] as const;
    }).pipe(Effect.interruptible)
  ).pipe(Effect.mapError(toStorageFailed));

  yield* rebuild;

  return {
    entries: (query: Page): Effect.Effect<readonly Entry[], StorageFailed> =>
      readEntries(query).pipe(Effect.mapError(toStorageFailed)),
    gaps: (query: GapPage): Effect.Effect<readonly Gap[], StorageFailed> =>
      readGaps(query).pipe(Effect.mapError(toStorageFailed)),
    head: readHead.pipe(Effect.mapError(toStorageFailed)),
    messages: (query: Page): Effect.Effect<readonly LoggedMessage[], StorageFailed> =>
      readMessages(query).pipe(Effect.mapError(toStorageFailed)),
    rebuild,
    record,
    standing: (network: string) =>
      Effect.map(Ref.get(standings), (held) => held.get(network) ?? noStanding),
  };
});
