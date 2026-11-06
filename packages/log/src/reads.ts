import { Database } from "bun:sqlite";

import { casefold } from "@iirc/state";
import { Array as Arr, Effect, Schema } from "effect";
import { flow } from "effect/Function";

import { allowBudgets, inBudget, withinBudget } from "./budget.ts";
import { ReadFailed } from "./errors.ts";
import { formatActivity, formatMessage } from "./formatted.ts";
import type { FormattedRow } from "./formatted.ts";
import type {
  ActivityQuery,
  ConnectionEncoding,
  EntryQuery,
  NetworkPage,
} from "./reader-protocol.ts";
import { ActivityRow, afterCursor, casemappings, EntryRow, GapRow, MessageRow } from "./rows.ts";

const within = `${inBudget}(?)`;

/**
 * Every statement the reader runs. Each is a range over the primary key or an index,
 * so a filter never makes it look at rows it will not return (LOG-11).
 */
export const statements = {
  activity: `
    SELECT * FROM activity WHERE (sequence, ordinal) > (?, ?) AND ${within}
    ORDER BY sequence, ordinal LIMIT ?
  `,
  activityOfNetwork: `
    SELECT * FROM activity WHERE network = ? AND (sequence, ordinal) > (?, ?) AND ${within}
    ORDER BY sequence, ordinal LIMIT ?
  `,
  // One mapping's rows of a place, a range over `activity_by_place`.
  activityOfPlace: `
    SELECT * FROM activity
    WHERE network = ? AND place_kind = ? AND casemapping = ? AND place_key = ?
      AND (sequence, ordinal) > (?, ?) AND ${within}
    ORDER BY sequence, ordinal LIMIT ?
  `,
  // A Connection's `attempt` is its own sequence, so this is one row by the primary key.
  attemptTuning: `
    SELECT tuning FROM entries
    WHERE sequence = ? AND kind = 'Connection' AND phase = 'attempt' AND ${within}
  `,
  entries: `SELECT * FROM entries WHERE sequence > ? AND ${within} ORDER BY sequence LIMIT ?`,
  entriesOfKind: `
    SELECT * FROM entries WHERE kind = ? AND sequence > ? AND ${within}
    ORDER BY sequence LIMIT ?
  `,
  entriesOfNetwork: `
    SELECT * FROM entries WHERE network = ? AND sequence > ? AND ${within}
    ORDER BY sequence LIMIT ?
  `,
  entriesOfNetworkAndKind: `
    SELECT * FROM entries WHERE network = ? AND kind = ? AND sequence > ? AND ${within}
    ORDER BY sequence LIMIT ?
  `,
  gaps: `SELECT * FROM gaps WHERE sequence > ? AND ${within} ORDER BY sequence LIMIT ?`,
  gapsOfNetwork: `
    SELECT * FROM gaps WHERE network = ? AND sequence > ? AND ${within}
    ORDER BY sequence LIMIT ?
  `,
  messages: `SELECT * FROM messages WHERE sequence > ? AND ${within} ORDER BY sequence LIMIT ?`,
  messagesOfNetwork: `
    SELECT * FROM messages WHERE network = ? AND sequence > ? AND ${within}
    ORDER BY sequence LIMIT ?
  `,
} as const;

const toReadFailed = ({ message }: Schema.SchemaError) => new ReadFailed({ reason: message });

const parseEntries = flow(
  Schema.decodeUnknownEffect(Schema.Array(EntryRow)),
  Effect.mapError(toReadFailed)
);

const parseGaps = flow(
  Schema.decodeUnknownEffect(Schema.Array(GapRow)),
  Effect.mapError(toReadFailed)
);

// Only the label of an `attempt`'s Tuning, as it was recorded (MSG-4).
const AttemptEncoding = Schema.Struct({
  tuning: Schema.fromJsonString(Schema.Struct({ encoding: Schema.optionalKey(Schema.String) })),
});

const parseEncoding = Schema.decodeUnknownSync(AttemptEncoding);

// How a page's rows are read: decoded, then formatted. A row that does not decode throws,
// and its read fails with ReadFailed.
interface Reading<Logged, Row> {
  readonly format: (logged: Logged) => FormattedRow<Row>;
  readonly schema: Schema.Decoder<Logged>;
}

const readMessage = { format: formatMessage, schema: MessageRow };

const readActivity = { format: formatActivity, schema: ActivityRow };

/**
 * LOG-11: about the most a page holds, in the bytes and text of its rows. A page of a
 * thousand 8 KB Lines cost the main thread 10 to 18 ms to receive, decode, and encode,
 * which held appends back. A page stops at the first row that reaches this, so it always
 * holds at least one row, and a cursor carries on from its last.
 */
export const pageBytes = 256 * 1024;

/**
 * LOG-11: what each span a page's text was parsed into counts toward {@link pageBytes},
 * beside the text it holds, because the main thread decodes and encodes each one as an
 * object. A Network can put a code before every character, which makes one Line about
 * 4,300 spans, so a page of such Lines holds one of them rather than thirty (MSG-3).
 */
export const spanBytes = 128;

// What a row costs to carry, which is its bytes and its text, and where it falls. Numbers
// are too small to count. Every table read here is keyed by `sequence`.
const Carried = Schema.Struct({
  bytes: Schema.optionalKey(Schema.NullOr(Schema.Uint8Array)),
  change: Schema.optionalKey(Schema.NullOr(Schema.String)),
  details: Schema.optionalKey(Schema.String),
  ordinal: Schema.optionalKey(Schema.Int),
  sequence: Schema.Int,
  text: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const carried = Schema.decodeUnknownSync(Carried);

const sizeOf = ({ bytes, change, details, text }: typeof Carried.Type) =>
  (bytes?.byteLength ?? 0) + (change?.length ?? 0) + (details?.length ?? 0) + (text?.length ?? 0);

interface Sized<Row = unknown> {
  readonly ordinal: number;
  readonly row: Row;
  readonly sequence: number;
  readonly size: number;
}

// Takes rows until they reach `pageBytes`, and says whether it stopped short of the end.
const upToPageBytes = <Row>(rows: Iterable<Sized<Row>>) => {
  const page: Sized<Row>[] = [];
  let total = 0;

  for (const row of rows) {
    page.push(row);
    total += row.size;

    if (total >= pageBytes) {
      return { cut: true, page };
    }
  }

  return { cut: false, page };
};

// Sizes each row as the statement steps to it, so a page stops reading where it is full.
const sizing = function* sizing(rows: Iterable<unknown>): Generator<Sized> {
  for (const row of rows) {
    const carrying = carried(row);

    yield {
      ordinal: carrying.ordinal ?? 0,
      row,
      sequence: carrying.sequence,
      size: sizeOf(carrying),
    };
  }
};

// Reads, formats, and sizes each row as the statement steps to it, counting its spans, so
// a page stops reading where what the main thread will carry is full (MSG-3, LOG-11).
const formattedSizing = function* formattedSizing<Logged, Row>(
  rows: Iterable<unknown>,
  { format, schema }: Reading<Logged, Row>
): Generator<Sized<Row>> {
  const decode = Schema.decodeUnknownSync(schema);

  for (const raw of rows) {
    const carrying = carried(raw);
    const { row, spans } = format(decode(raw));

    yield {
      ordinal: carrying.ordinal ?? 0,
      row,
      sequence: carrying.sequence,
      size: sizeOf(carrying) + spans * spanBytes,
    };
  }
};

const rowsOf = <Row>(page: readonly Sized<Row>[]) => page.map(({ row }) => row);

const inOrder = (left: Sized, right: Sized) =>
  left.sequence - right.sequence || left.ordinal - right.ordinal;

// Pages of several ranges, merged. A range cut short by bytes has rows past its last that
// another range's page could jump, so the merge stops at the earliest such last row.
const mergePages = <Row>(
  pages: readonly { readonly cut: boolean; readonly page: Sized<Row>[] }[]
) => {
  const bound = pages
    .flatMap(({ cut, page }) => {
      const last = page.at(-1);

      return cut && last !== undefined ? [last] : [];
    })
    .toSorted(inOrder)
    .at(0);

  return pages
    .flatMap(({ page }) => page)
    .filter((row) => bound === undefined || inOrder(row, bound) <= 0)
    .toSorted(inOrder);
};

// A reader never waits on the writer in WAL mode, but SQLite can still answer busy while
// the WAL index is rebuilt, and that wait is outside any budget, so it is short.
const busyTimeoutMillis = 50;

/**
 * Opens a connection of the reader's own to the Log, until the enclosing scope closes. It
 * is read-only, so nothing on it can ever take the writer's lock, and in WAL mode it sees
 * only what has committed (LOG-11).
 * @param filename - The Log's database.
 * @returns The connection, which allows budgets.
 */
export const openReadConnection = (filename: string) =>
  Effect.acquireRelease(
    Effect.try({
      catch: (cause) => new ReadFailed({ reason: String(cause) }),
      try: () => {
        const database = new Database(filename, { readonly: true });

        database.run(`PRAGMA busy_timeout = ${busyTimeoutMillis}`);
        allowBudgets(database);

        return database;
      },
    }),
    (database) =>
      Effect.sync(() => {
        database.close();
      })
  );

/**
 * The Log's reads, over a connection that allows budgets and is never written.
 * @param database - The connection.
 * @param budgetMillis - How long each read may take.
 * @returns Each read, parsed, or ReadTimedOut when it ran out of time.
 */
export const makeReads = (database: Database, budgetMillis: number) => {
  const prepare = (sql: string) => database.query<unknown, (string | number)[]>(sql);

  const entries = prepare(statements.entries);
  const entriesOfKind = prepare(statements.entriesOfKind);
  const entriesOfNetwork = prepare(statements.entriesOfNetwork);
  const entriesOfNetworkAndKind = prepare(statements.entriesOfNetworkAndKind);
  const gaps = prepare(statements.gaps);
  const gapsOfNetwork = prepare(statements.gapsOfNetwork);
  const messages = prepare(statements.messages);
  const activity = prepare(statements.activity);
  const activityOfNetwork = prepare(statements.activityOfNetwork);
  const activityOfPlace = prepare(statements.activityOfPlace);

  const messagesOfNetwork = prepare(statements.messagesOfNetwork);
  const attemptTuning = prepare(statements.attemptTuning);

  // The encoding each Connection's `attempt` recorded, for those with one. An `attempt`
  // never changes, so this needs no snapshot shared with the page it decodes.
  const encodings = ({ connections }: { readonly connections: readonly number[] }) =>
    withinBudget(budgetMillis, ({ check, deadline }) =>
      Arr.dedupe(connections).flatMap((connection): ConnectionEncoding[] => {
        check();

        const row = attemptTuning.get(connection, deadline);
        const encoding = row === null ? undefined : parseEncoding(row).tuning.encoding;

        return encoding === undefined ? [] : [{ connection, encoding }];
      })
    );

  // A read of several statements sees one snapshot, or a commit landing between two of
  // them could give a page that skips an Entry below its last sequence, and a cursor
  // resuming from that page would never see it (LOG-1).
  const inSnapshot = <A>(read: () => A): A => database.transaction(read)();

  // One range for each kind, merged, because one statement over several kinds would
  // have to sort every row of those kinds before it could apply the limit.
  const entriesOfKinds = (kinds: readonly string[], { after, limit, network }: EntryQuery) =>
    withinBudget(budgetMillis, ({ check, deadline }) =>
      inSnapshot(() =>
        Arr.dedupe(kinds).map((kind) => {
          check();

          return upToPageBytes(
            sizing(
              network === undefined
                ? entriesOfKind.iterate(kind, after, deadline, limit)
                : entriesOfNetworkAndKind.iterate(network, kind, after, deadline, limit)
            )
          );
        })
      )
    ).pipe(
      Effect.map((pages) => rowsOf(upToPageBytes(Arr.take(mergePages(pages), limit)).page)),
      Effect.flatMap(parseEntries)
    );

  // A page of Activity, by bytes and `limit` as other reads are. One Entry can be many rows,
  // such as a `QUIT` in a thousand Channels, so a page can end inside one, and its last row's
  // `(sequence, ordinal)` is where the next resumes. A place is one range for each mapping,
  // its name casefolded under it, so rows keyed under an earlier mapping are found too
  // (KNOW-3), and the ranges are merged.
  const activityPage = (query: ActivityQuery) =>
    withinBudget(budgetMillis, ({ check, deadline }) => {
      const { limit } = query;
      const [sequence, ordinal] = afterCursor(query.after);

      if (!("place" in query)) {
        const rows =
          query.network === undefined
            ? activity.iterate(sequence, ordinal, deadline, limit)
            : activityOfNetwork.iterate(query.network, sequence, ordinal, deadline, limit);

        return rowsOf(upToPageBytes(formattedSizing(rows, readActivity)).page);
      }

      const { network, place } = query;

      const pages = inSnapshot(() =>
        casemappings.map((casemapping) => {
          check();

          const key = place._tag === "Network" ? "" : casefold(casemapping, place.name);

          return upToPageBytes(
            formattedSizing(
              activityOfPlace.iterate(
                network,
                place._tag,
                casemapping,
                key,
                sequence,
                ordinal,
                deadline,
                limit
              ),
              readActivity
            )
          );
        })
      );

      return rowsOf(upToPageBytes(Arr.take(mergePages(pages), limit)).page);
    });

  return {
    activity: activityPage,
    encodings,
    entries: (query: EntryQuery) => {
      const { after, kinds, limit, network } = query;

      return kinds === undefined
        ? withinBudget(budgetMillis, ({ deadline }) =>
            rowsOf(
              upToPageBytes(
                sizing(
                  network === undefined
                    ? entries.iterate(after, deadline, limit)
                    : entriesOfNetwork.iterate(network, after, deadline, limit)
                )
              ).page
            )
          ).pipe(Effect.flatMap(parseEntries))
        : entriesOfKinds(kinds, query);
    },
    gaps: ({ after, limit, network }: NetworkPage) =>
      withinBudget(budgetMillis, ({ deadline }) =>
        network === undefined
          ? gaps.all(after, deadline, limit)
          : gapsOfNetwork.all(network, after, deadline, limit)
      ).pipe(Effect.flatMap(parseGaps)),
    messages: ({ after, limit, network }: NetworkPage) =>
      withinBudget(budgetMillis, ({ deadline }) =>
        rowsOf(
          upToPageBytes(
            formattedSizing(
              network === undefined
                ? messages.iterate(after, deadline, limit)
                : messagesOfNetwork.iterate(network, after, deadline, limit),
              readMessage
            )
          ).page
        )
      ),
  };
};
