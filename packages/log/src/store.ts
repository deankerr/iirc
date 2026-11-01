import type { Entry } from "@iirc/session/entry";
import { RecordFailed } from "@iirc/session/recorder";
import type { Recorder } from "@iirc/session/recorder";
import { Clock, Effect, Ref, Semaphore } from "effect";
import { SqlSchema } from "effect/sql";
import type { SqlClient } from "effect/sql";
import { isSqlError } from "effect/sql/SqlError";

import { StorageFailed } from "./errors.ts";
import { foldEntries, noSessions } from "./fold.ts";
import type { LoggedMessage, Sessions } from "./fold.ts";
import { EntryRow, MessageRow, Page } from "./rows.ts";

// How many Entries a replay holds in memory at once.
const replayPageSize = 1000;

const toStorageFailed = (cause: unknown) => new StorageFailed({ cause });

/**
 * Builds what the Log does over an open database, replaying Entries to pick up
 * where the last process left off.
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

  const replay = Effect.fnUntraced(function* <E>(
    onMessages: (messages: readonly LoggedMessage[]) => Effect.Effect<void, E>
  ) {
    let sessions = noSessions;
    let after = 0;
    let page: readonly Entry[] = [];

    do {
      page = yield* readEntries({ after, limit: replayPageSize });

      const folded = foldEntries(sessions, page);

      yield* onMessages(folded.messages);

      ({ sessions } = folded);
      after = page.at(-1)?.sequence ?? after;
    } while (page.length === replayPageSize);

    return sessions;
  });

  const sessions = yield* replay(() => Effect.void).pipe(
    Effect.flatMap(Ref.make),
    Effect.mapError(toStorageFailed)
  );

  // One writer at a time, so that the Sessions a transaction folds from are the ones
  // the last commit left. The client's own lock is no use here, because it is
  // released before `sessions` is set, and the next writer would read stale state.
  const writer = yield* Semaphore.make(1);

  // Runs a transaction that yields new Sessions, and publishes them only once they
  // are durable, so that a rollback has nothing to undo. Nothing here can be
  // interrupted, so `sessions` never misses a commit, and what `within` saw is
  // always either committed or reported as a failure.
  const commit = <A, E>(
    transaction: (current: Sessions) => Effect.Effect<readonly [A, Sessions], E>
  ) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(sessions);
      const [result, next] = yield* sql.withTransaction(transaction(current));

      yield* Ref.set(sessions, next);

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

        const recorded = entries.map((entry, index): Entry => ({
          ...entry,
          at,
          sequence: head + index + 1,
        }));

        yield* Effect.forEach(recorded, insertEntry, { discard: true });

        const folded = foldEntries(current, recorded);

        yield* insertMessages(folded.messages);

        const result = yield* Effect.sync(() => within(recorded));

        return [result, folded.sessions] as const;
      })
    ).pipe(Effect.mapError((cause) => new RecordFailed({ cause })));

  // Unlike a record, a rebuild can run long, and abandoning one loses nothing.
  const rebuild = commit(() =>
    Effect.gen(function* () {
      yield* sql`DELETE FROM messages`;

      const rebuilt = yield* replay(insertMessages);

      return [undefined, rebuilt] as const;
    }).pipe(Effect.interruptible)
  ).pipe(Effect.mapError(toStorageFailed));

  return {
    entries: (query: Page): Effect.Effect<readonly Entry[], StorageFailed> =>
      readEntries(query).pipe(Effect.mapError(toStorageFailed)),
    head: readHead.pipe(Effect.mapError(toStorageFailed)),
    messages: (query: Page): Effect.Effect<readonly LoggedMessage[], StorageFailed> =>
      readMessages(query).pipe(Effect.mapError(toStorageFailed)),
    rebuild,
    record,
  };
});
