import type { Entry, NewEntry } from "@iirc/session/entry";
import { makeWatchers, RecordFailed } from "@iirc/session/recorder";
import type { Recorder } from "@iirc/session/recorder";
import { foldStandings, noStanding } from "@iirc/session/standing";
import type { Gap, Standing, Standings } from "@iirc/session/standing";
import { Array as Arr, Clock, Data, Effect, pipe, Ref, Result, Schema, Semaphore } from "effect";
import { SqlSchema } from "effect/sql";
import type { SqlClient } from "effect/sql";
import { isSqlError } from "effect/sql/SqlError";

import {
  EntryAlreadyRedacted,
  EntryNotFound,
  EntryNotRedactable,
  StorageFailed,
} from "./errors.ts";
import { foldEntries, noProjection } from "./fold.ts";
import type { Folded, LoggedActivity, LoggedMessage, Projection } from "./fold.ts";
import {
  ActivityPage,
  ActivityRow,
  afterCursor,
  EntryRow,
  GapPage,
  GapRow,
  MessageRow,
  Page,
} from "./rows.ts";

// How many Entries a replay holds in memory at once.
const replayPageSize = 1000;

// How many Messages a rebuild inserts with one statement. At eleven columns that is under
// the 999 bound parameters of the smallest limit SQLite has shipped with, so no build of
// it can refuse one, whatever a page of Entries turns out to hold.
const rebuildBatchSize = 64;

// How many Activity rows go in one statement, live or rebuilding, at ten columns each, for
// the same reason. A `QUIT` in many Channels is many rows, and one statement for them all
// costs about what one row does.
const activityBatchSize = 64;

// See `held` in `makeStore`.
interface Held {
  /** The sequence of the last Entry committed, which every Standing here reflects. */
  readonly head: number;
  readonly host: Standings;
  readonly projection: Projection;
}

/**
 * A Network's Standing as of a commit, and that commit's last sequence, read together from
 * one snapshot, so that what the Standing says is true as of `at` (API-6).
 */
export interface StandingAt {
  readonly at: number;
  readonly standing: Standing;
}

const toStorageFailed = (cause: unknown) => new StorageFailed({ cause });

/** A Change Entry, which the Daemon folds into Configuration (CONF-1). */
export type ChangeEntry = Extract<Entry, { readonly _tag: "Change" }>;

/**
 * An Entry whose row no longer decodes, such as a Change that is not JSON. Nothing that
 * reads the whole Log can go past it, so it says which Entry it is.
 */
class UnreadableEntry extends Data.TaggedError("UnreadableEntry")<{
  readonly reason: string;
  readonly sequence: unknown;
}> {
  override readonly message = `The Entry at sequence ${String(this.sequence)} cannot be read: ${this.reason}`;
}

const decodeEntryRow = Schema.decodeUnknownResult(EntryRow);

// Row by row, so that a row that will not decode is named by its sequence.
const decodeRows = (
  rows: readonly { readonly sequence?: unknown }[]
): Effect.Effect<readonly Entry[], UnreadableEntry> => {
  const entries: Entry[] = [];

  for (const row of rows) {
    const decoded = decodeEntryRow(row);

    if (Result.isFailure(decoded)) {
      return Effect.fail(
        new UnreadableEntry({ reason: decoded.failure.message, sequence: row.sequence })
      );
    }

    entries.push(decoded.success);
  }

  return Effect.succeed(entries);
};

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

  const readEntries = ({ after, limit }: Page) =>
    sql<{ readonly sequence: number }>`
      SELECT * FROM entries WHERE sequence > ${after} ORDER BY sequence LIMIT ${limit}
    `.pipe(Effect.flatMap(decodeRows));

  // A range over `entries_by_kind`.
  const readChanges = ({ after, limit }: Page) =>
    sql<{ readonly sequence: number }>`
      SELECT * FROM entries WHERE kind = 'Change' AND sequence > ${after}
      ORDER BY sequence LIMIT ${limit}
    `.pipe(
      Effect.flatMap(decodeRows),
      Effect.map((entries) =>
        entries.flatMap((entry): readonly ChangeEntry[] => (entry._tag === "Change" ? [entry] : []))
      )
    );

  const readMessages = SqlSchema.findAll({
    Request: Page,
    Result: MessageRow,
    execute: ({ after, limit }) =>
      sql`SELECT * FROM messages WHERE sequence > ${after} ORDER BY sequence LIMIT ${limit}`,
  });

  // The writer's own read, for startup and tests, so it takes no filter. It pages by the
  // same cursor as the reader's.
  const readActivity = SqlSchema.findAll({
    Request: ActivityPage,
    Result: ActivityRow,
    execute: ({ after, limit }) => {
      const [sequence, ordinal] = afterCursor(after);

      return sql`
        SELECT * FROM activity WHERE (sequence, ordinal) > (${sequence}, ${ordinal})
        ORDER BY sequence, ordinal LIMIT ${limit}
      `;
    },
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

  const insertActivityBatch = SqlSchema.void({
    Request: Schema.NonEmptyArray(ActivityRow),
    execute: (rows) => sql`INSERT INTO activity ${sql.insert(rows)}`,
  });

  const insertActivity = (activity: readonly LoggedActivity[]) =>
    Effect.forEach(Arr.chunksOf(activity, activityBatchSize), insertActivityBatch, {
      discard: true,
    });

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
    let projection = noProjection;
    let after = 0;
    let page: readonly Entry[] = [];

    do {
      page = yield* readEntries({ after, limit: replayPageSize });

      const folded = foldEntries(projection, page);

      yield* onPage(folded);

      ({ projection } = folded);
      after = page.at(-1)?.sequence ?? after;
    } while (page.length === replayPageSize);

    return projection;
  });

  // What the Log holds of each Network's Standing, apart in two. `host` is what the
  // hosts read, and a redaction leaves it as the host knew it (LOG-7). `projection` is
  // what the derived tables are written from, and a redaction replaces it with what
  // the rebuild it ran derived, so that a row appended after one is the row a rebuild
  // would write (LOG-10). Until a redaction they are one and the same.
  const held = yield* Ref.make<Held>({
    head: 0,
    host: noProjection.standings,
    projection: noProjection,
  });

  const watchers = makeWatchers();

  // One writer at a time, so that the Standings a transaction folds from are the ones
  // the last commit left. The client's own lock is no use here, because it is
  // released before `held` is set, and the next writer would read stale state.
  const writer = yield* Semaphore.make(1);

  // Runs a transaction that yields new Standings and the Entries it recorded, and
  // publishes both only once they are durable, so that a rollback has nothing to undo.
  // Nothing here can be interrupted, so `held` never misses a commit, and what `within`
  // saw is always either committed or reported as a failure. Watchers are told under the
  // writer's permit, so they hear of commits in sequence order.
  const commit = <A, E>(
    transaction: (current: Held) => Effect.Effect<readonly [A, Held, readonly Entry[]], E>
  ) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(held);
      const [result, next, recorded] = yield* sql.withTransaction(transaction(current));

      yield* Ref.set(held, next);
      yield* Effect.sync(() => {
        watchers.publish(recorded);
      });

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
    commit(({ host, projection }) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        const head = yield* readHead;

        const recorded = pipe(
          entries,
          Arr.map((entry, index): Entry => ({ ...entry, at, sequence: head + index + 1 }))
        );

        yield* Effect.forEach(recorded, insertEntry, { discard: true });

        const folded = foldEntries(projection, recorded);

        yield* insertMessages(folded.messages);
        yield* insertActivity(folded.activity);
        yield* writeGaps(folded.gaps);

        const result = yield* Effect.sync(() => within(recorded));
        const { standings } = folded.projection;

        return [
          result,
          {
            head: Arr.lastNonEmpty(recorded).sequence,
            host: host === projection.standings ? standings : foldStandings(host, recorded),
            projection: folded.projection,
          },
          recorded,
        ] as const;
      })
    ).pipe(Effect.mapError((cause) => new RecordFailed({ cause })));

  // Every derived table again, from the Log as it now stands, which gives the Standings
  // that a start would have (LOG-10).
  const deriveTablesAgain = Effect.gen(function* () {
    yield* sql`DELETE FROM messages`;
    yield* sql`DELETE FROM activity`;
    yield* sql`DELETE FROM gaps`;

    return yield* replay(({ activity, gaps, messages }) =>
      Effect.all([insertMessageBatches(messages), insertActivity(activity), writeGaps(gaps)], {
        discard: true,
      })
    );
  });

  // Unlike a record, a rebuild can run long, and abandoning one loses nothing.
  const rebuild = commit(() =>
    Effect.all([deriveTablesAgain, readHead]).pipe(
      Effect.map(
        ([rebuilt, head]) =>
          [undefined, { head, host: rebuilt.standings, projection: rebuilt }, []] as const
      ),
      Effect.interruptible
    )
  ).pipe(Effect.mapError(toStorageFailed));

  // What stands in the way of redacting the Entry at `sequence`, if anything (LOG-7).
  const refusalToRedact = Effect.fnUntraced(function* (sequence: number) {
    // `kind` is only ever written from an Entry's tag.
    const [row] = yield* sql<{
      readonly kind: Entry["_tag"];
      readonly redacted_by: number | null;
    }>`
      SELECT kind, redacted_by FROM entries WHERE sequence = ${sequence}
    `;

    if (row === undefined) {
      return new EntryNotFound({ sequence });
    }

    const { kind, redacted_by: change } = row;

    // Only these carry bytes, so any other kind, a new one included, is refused.
    if (kind !== "Dropped" && kind !== "Line") {
      return new EntryNotRedactable({ kind, sequence });
    }

    return change === null ? undefined : new EntryAlreadyRedacted({ change, sequence });
  });

  // Empties a Line or a Dropped Entry's bytes and records the Change that did, in one
  // transaction, then derives every table again (LOG-7). The Standings the hosts read keep
  // what they knew, because a Connection under way acted on the Line as it was, and the
  // next start replays the Line as one with no bytes, which says nothing.
  const redact = <A>(
    sequence: number,
    change: Extract<NewEntry, { readonly _tag: "Change" }>,
    within: (recorded: ChangeEntry) => A
  ) =>
    commit(({ host }) =>
      Effect.gen(function* () {
        const refused = yield* refusalToRedact(sequence);

        if (refused !== undefined) {
          return yield* refused;
        }

        const at = yield* Clock.currentTimeMillis;
        const recorded: ChangeEntry = { ...change, at, sequence: (yield* readHead) + 1 };

        yield* insertEntry(recorded);
        yield* sql`
          UPDATE entries SET bytes = x'', redacted_by = ${recorded.sequence}
          WHERE sequence = ${sequence}
        `;

        // The rebuild's own Standings stand for the projection, and the host's take only
        // the Change, which is how the host comes to keep what it knew.
        const projection = yield* deriveTablesAgain;
        const result = yield* Effect.sync(() => within(recorded));

        return [
          result,
          { head: recorded.sequence, host: foldStandings(host, [recorded]), projection },
          [recorded],
        ] as const;
      })
    ).pipe(
      Effect.catchTags({
        SchemaError: (cause) => Effect.fail(toStorageFailed(cause)),
        SqlError: (cause) => Effect.fail(toStorageFailed(cause)),
        UnreadableEntry: (cause) => Effect.fail(toStorageFailed(cause)),
      })
    );

  yield* rebuild;

  return {
    activity: (query: ActivityPage): Effect.Effect<readonly LoggedActivity[], StorageFailed> =>
      readActivity(query).pipe(Effect.mapError(toStorageFailed)),
    changes: (query: Page): Effect.Effect<readonly ChangeEntry[], StorageFailed> =>
      readChanges(query).pipe(Effect.mapError(toStorageFailed)),
    entries: (query: Page): Effect.Effect<readonly Entry[], StorageFailed> =>
      readEntries(query).pipe(Effect.mapError(toStorageFailed)),
    gaps: (query: GapPage): Effect.Effect<readonly Gap[], StorageFailed> =>
      readGaps(query).pipe(Effect.mapError(toStorageFailed)),
    head: readHead.pipe(Effect.mapError(toStorageFailed)),
    messages: (query: Page): Effect.Effect<readonly LoggedMessage[], StorageFailed> =>
      readMessages(query).pipe(Effect.mapError(toStorageFailed)),
    rebuild,
    record,
    redact,
    standing: (network: string) =>
      Effect.map(Ref.get(held), ({ host }) => host.get(network) ?? noStanding),
    // One read of `held`, which a commit sets whole once it is durable, so the Standing and
    // its sequence are always from the same commit, and no commit waits for it.
    standingAt: (network: string): Effect.Effect<StandingAt> =>
      Effect.map(Ref.get(held), ({ head, host }) => ({
        at: head,
        standing: host.get(network) ?? noStanding,
      })),
    watch: watchers.watch,
  };
});
