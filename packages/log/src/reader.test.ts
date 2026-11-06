import { Database } from "bun:sqlite";
import { existsSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import type { Entry, NewEntry } from "@iirc/session/entry";
import { Recorder } from "@iirc/session/recorder";
import { attemptInput, eventually } from "@iirc/session/testing";
import {
  Array as Arr,
  Context,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Order,
  pipe,
  Schema,
  Scope,
} from "effect";
import type { Duration } from "effect";

import { allowBudgets } from "./budget.ts";
import { ReaderBusy } from "./errors.ts";
import { formatActivity, formatMessage } from "./formatted.ts";
import { Log, LogReader, ReadTimedOut } from "./log.ts";
import type {
  ActivityCursor,
  ActivityQuery,
  EntryQuery,
  LoggedActivity,
  LoggedMessage,
  LogReaderOptions,
  ReadActivity,
} from "./log.ts";
import { pageBytes, spanBytes, statements } from "./reads.ts";
import { inProcessReader } from "./testing.ts";

// LOG-11 from the outside: a Worker with its own connection serves every read, keeps to
// a budget, and leaves the writer alone however slow it is.

const encoder = new TextEncoder();
const ircd = { host: "irc.example", port: 6697, tls: true };
const networks = ["libera", "oftc", "ergo"] as const;
const kinds = ["Connection", "Daemon", "Deadline", "Dropped", "Line"] as const;
const everything = { after: 0, limit: 1000 };
const allActivity = { after: { sequence: 0 }, limit: 1000 };

// The fixture makes every row a statement looks at cost 5 ms, so a read of N rows takes
// 5N ms unless its budget stops it first. With a marker, it also creates that file when
// its first row is costed, which `untilReading` waits for.
const slowRows = (marker?: string) =>
  new Worker(new URL("slow-reader.fixture.ts", import.meta.url), {
    env: { ...process.env, ...(marker !== undefined && { IIRC_READING_MARKER: marker }) },
  });

// A marker for the next read to announce itself by, removed with the scope.
const readingMarker = Effect.acquireRelease(
  Effect.sync(() => path.join(tmpdir(), `iirc-reading-${crypto.randomUUID()}`)),
  (marker) =>
    Effect.sync(() => {
      rmSync(marker, { force: true });
    })
);

// Waits until a read is running in the Worker, which is what the fixture's marker says, and
// not for a time that a busy machine could make too short.
const untilReading = (marker: string) =>
  eventually(
    Effect.sync(() => existsSync(marker)),
    (found) => found
  );

const report = (text: string) => {
  writeSync(process.stdout.fd, `${text}\n`);
};

const line = (
  text: string,
  network: string,
  direction: "inbound" | "outbound",
  connection = 1
): NewEntry => ({
  _tag: "Line",
  bytes: encoder.encode(text),
  connection,
  direction,
  network,
  ...(direction === "outbound" && { cause: "test" }),
});

const record = (entries: Arr.NonEmptyReadonlyArray<NewEntry>) =>
  Recorder.use(({ record }) => record(entries, (recorded) => recorded));

// One Session on a Network, touching every kind of Entry, and so a Message, and a Gap
// once it ends.
const session = Effect.fnUntraced(function* (network: string) {
  const [{ sequence: connection }] = yield* record([
    { _tag: "Connection", ircd, network, nicks: ["alice"], phase: "attempt", ...attemptInput },
  ]);

  yield* record([
    { _tag: "Connection", connection, ircd, network, phase: "opened" },
    line(":ircd 001 alice :Welcome", network, "inbound", connection),
    line(":bob!u@h PRIVMSG #iirc :hi", network, "inbound", connection),
    line("PRIVMSG #iirc :hello", network, "outbound", connection),
    { _tag: "Deadline", name: "burst", network },
    {
      _tag: "Dropped",
      bytes: encoder.encode("PRIVMSG #iirc :late"),
      cause: "api",
      connection,
      network,
      reason: "the Connection ended",
    },
    { _tag: "Connection", connection, ircd, network, phase: "closed", reason: "gone" },
  ]);
});

// Three Sessions on each of three Networks, interleaved, between a start and a stop.
const seedMixed = Effect.gen(function* () {
  yield* record([{ _tag: "Daemon", phase: "started", version: "1" }]);

  yield* Effect.forEach(networks, session, { discard: true }).pipe(Effect.repeat({ times: 2 }));

  yield* record([{ _tag: "Daemon", phase: "stopped", version: "1" }]);
});

// Many plain Lines, in batches, as a busy Network would leave them.
const seedLines = (count: number) =>
  Effect.forEach(
    Arr.chunksOf(Arr.range(1, count), 500),
    (batch) =>
      record(
        pipe(
          batch,
          Arr.map((index) => line(`:bob!u@h PRIVMSG #iirc :${index}`, "libera", "inbound"))
        )
      ),
    { discard: true }
  );

const dataDirectory = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;

  // Not `/tmp`, because that is tmpfs here, where fsync means nothing.
  return yield* fileSystem.makeTempDirectoryScoped({
    directory: "/var/tmp",
    prefix: "iirc-reader-",
  });
}).pipe(Effect.provide(BunServices.layer));

type Reader = typeof LogReader.layer;

const logAndReader = (
  dataDir: string,
  options: Omit<LogReaderOptions, "dataDir"> = {},
  reader: Reader = LogReader.layer
) => reader({ dataDir, ...options }).pipe(Layer.provideMerge(Log.layer({ dataDir })));

const withReader = <A, E>(
  test: (dataDir: string) => Effect.Effect<A, E, Log | LogReader | Recorder | Scope.Scope>,
  options?: Omit<LogReaderOptions, "dataDir">,
  reader?: Reader
) =>
  Effect.gen(function* () {
    const dataDir = yield* dataDirectory;

    return yield* test(dataDir).pipe(Effect.provide(logAndReader(dataDir, options, reader)));
  }).pipe(Effect.scoped);

// The reader that tests not about the Worker read through instead, which must read what
// the Worker's does.
const readers: readonly (readonly [string, Reader])[] = [
  ["on its Worker", LogReader.layer],
  ["in process, for tests", inProcessReader],
];

// A reader whose Worker costs every row 5 ms, and announces when it starts to, so that the
// test is given the moment a read is running.
const withSlowReader = <A, E>(
  budget: Duration.Input,
  test: (
    dataDir: string,
    untilReading: Effect.Effect<boolean>
  ) => Effect.Effect<A, E, Log | LogReader | Recorder | Scope.Scope>
) =>
  Effect.gen(function* () {
    const marker = yield* readingMarker;

    return yield* withReader((dataDir) => test(dataDir, untilReading(marker)), {
      budget,
      spawn: () => slowRows(marker),
    });
  }).pipe(Effect.scoped);

// Follows a cursor to the end, one page at a time, as a Frontend would.
const pageThrough = <A extends { readonly sequence: number }, E>(
  read: (after: number) => Effect.Effect<readonly A[], E>,
  limit: number
) =>
  Effect.gen(function* () {
    const all: A[] = [];
    let page: readonly A[] = [];

    do {
      page = yield* read(all.at(-1)?.sequence ?? 0);

      assert.isAtMost(page.length, limit);
      all.push(...page);
    } while (page.length > 0);

    return all;
  });

// What an Activity row costs a page to carry, about as the reader counts it: its details
// as the Log holds them, and each span its text makes (MSG-3).
const sizeOfRow = (row: LoggedActivity) =>
  JSON.stringify(row.details).length + formatActivity(row).spans * spanBytes;

// What a read gives for what the writer holds: the same rows, formatted on the Worker.
const formattedActivity = (rows: readonly LoggedActivity[]) =>
  rows.map((row) => formatActivity(row).row);

const formattedMessages = (rows: readonly LoggedMessage[]) =>
  rows.map((row) => formatMessage(row).row);

// Follows Activity's cursor to the end, one page at a time, passing back the last row's
// `sequence` and `ordinal` as a Frontend would, and checking each page keeps to `limit`.
const pageActivity = <E>(
  read: (after: ActivityCursor) => Effect.Effect<readonly ReadActivity[], E>,
  limit: number
) =>
  Effect.gen(function* () {
    const all: ReadActivity[] = [];
    let page = yield* read({ sequence: 0 });

    while (page.length > 0) {
      assert.isAtMost(page.length, limit);
      all.push(...page);

      const { ordinal, sequence } = page.at(-1) ?? { ordinal: 0, sequence: 0 };

      page = yield* read({ ordinal, sequence });
    }

    return all;
  });

// Activity on two Networks: joins, a QUIT in three Channels at once, and a Direct Message
// partner's NICK.
const seedActivity = Effect.forEach(
  ["libera", "oftc"] as const,
  Effect.fnUntraced(function* (network) {
    const [{ sequence: connection }] = yield* record([
      { _tag: "Connection", ircd, network, nicks: ["alice"], phase: "attempt", ...attemptInput },
    ]);

    const heard = (text: string) => line(text, network, "inbound", connection);

    yield* record([
      { _tag: "Connection", connection, ircd, network, phase: "opened" },
      heard(":ircd 001 alice :Welcome"),
      ...["#a", "#b", "#c"].flatMap((channel) => [
        heard(`:alice!a@h JOIN ${channel}`),
        heard(`:ircd 353 alice = ${channel} :alice bob carol dave`),
        heard(`:ircd 366 alice ${channel} :End of /NAMES list.`),
      ]),
      heard(":bob!b@h PRIVMSG alice :hi"),
    ]);

    for (const nick of ["carol", "dave"]) {
      yield* record([heard(`:${nick}!u@h QUIT :split`)]);
    }

    yield* record([heard(":bob!b@h NICK robert")]);
  }),
  { discard: true }
);

const sizeOf = (entry: Entry) => ("bytes" in entry ? entry.bytes.length : 0);

const networkOf = (entry: Entry) => ("network" in entry ? entry.network : undefined);

const elapsedSince = (started: number) => performance.now() - started;

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = performance.now();
    const result = yield* effect;

    return [result, elapsedSince(started)] as const;
  });

const appendLatencies = (count: number) =>
  Effect.forEach(Arr.range(1, count), (index) =>
    Effect.map(
      timed(record([line(`PRIVMSG #iirc :append ${index}`, "libera", "outbound")])),
      ([, millis]) => millis
    )
  );

const percentile = (values: readonly number[], fraction: number) => {
  const sorted = Arr.sort(values, Order.Number);

  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
};

const describeLatencies = (values: readonly number[]) =>
  `p50 ${percentile(values, 0.5).toFixed(2)} ms, p99 ${percentile(values, 0.99).toFixed(2)} ms, max ${Math.max(...values).toFixed(2)} ms`;

describe("the Log's reader", () => {
  describe("reading", () => {
    for (const [where, readerLayer] of readers) {
      it.live(
        `LOG-11: reads only what has committed, and every commit as soon as it lands, ${where}`,
        () =>
          withReader(
            (dataDir) =>
              Effect.gen(function* () {
                const reader = yield* LogReader;
                const [first] = yield* record([line("one", "libera", "inbound")]);

                // Another connection's transaction, open and holding a row the reader must not see.
                const intruder = yield* Effect.acquireRelease(
                  Effect.sync(() => {
                    const database = new Database(`${dataDir}/iirc.sqlite`);

                    database.run("BEGIN IMMEDIATE");
                    database.run(
                      "INSERT INTO entries (sequence, at, kind, phase, version) VALUES (2, 0, 'Daemon', 'started', 'uncommitted')"
                    );

                    return database;
                  }),
                  (database) =>
                    Effect.sync(() => {
                      database.close();
                    })
                );

                assert.deepStrictEqual(yield* reader.entries(everything), [first]);

                intruder.run("ROLLBACK");

                // The very next read after each commit has it, with no wait in between.
                for (const index of Arr.range(1, 25)) {
                  const [entry] = yield* record([line(`line ${index}`, "oftc", "inbound")]);

                  assert.deepStrictEqual(
                    yield* reader.entries({ after: entry.sequence - 1, limit: 10 }),
                    [entry],
                    `commit ${index}`
                  );
                }

                const [message] = yield* reader.messages({ after: first.sequence, limit: 1 });

                assert.isUndefined(message, "no Line here was a Message");
              }),
            {},
            readerLayer
          )
      );

      it.live(
        `LOG-11: returns exactly what the writer holds, Entries, Messages, and Gaps, ${where}`,
        () =>
          withReader(
            () =>
              Effect.gen(function* () {
                yield* seedMixed;

                const log = yield* Log;
                const reader = yield* LogReader;

                assert.deepStrictEqual(
                  yield* reader.entries(everything),
                  yield* log.entries(everything)
                );
                assert.deepStrictEqual(
                  yield* reader.messages(everything),
                  formattedMessages(yield* log.messages(everything))
                );
                assert.deepStrictEqual(yield* reader.gaps(everything), yield* log.gaps(everything));
                assert.lengthOf(yield* reader.gaps(everything), 9);
              }),
            {},
            readerLayer
          )
      );
    }

    it.live("LOG-11: filters by Network and kind exactly, paging by `after`", () =>
      withReader(() =>
        Effect.gen(function* () {
          yield* seedMixed;

          const log = yield* Log;
          const reader = yield* LogReader;
          const all = yield* log.entries(everything);
          const limit = 4;

          const kindFilters: readonly (EntryQuery["kinds"] | undefined)[] = [
            undefined,
            ["Line"],
            ["Daemon"],
            ["Connection", "Daemon"],
            ["Line", "Dropped", "Deadline"],
            ["Line", "Line"],
            kinds,
          ];

          for (const network of [undefined, "libera", "oftc", "nowhere"]) {
            for (const kindFilter of kindFilters) {
              const query = {
                ...(network !== undefined && { network }),
                ...(kindFilter !== undefined && { kinds: kindFilter }),
              };

              const paged = yield* pageThrough(
                (after) => reader.entries({ ...query, after, limit }),
                limit
              );

              const expected = all.filter(
                (entry) =>
                  (network === undefined || networkOf(entry) === network) &&
                  (kindFilter === undefined || kindFilter.includes(entry._tag))
              );

              assert.deepStrictEqual(paged, expected, JSON.stringify(query));
            }
          }

          // Daemon Entries are no Network's, and only they are.
          assert.lengthOf(yield* reader.entries({ ...everything, kinds: ["Daemon"] }), 2);
          assert.deepStrictEqual(
            yield* reader.entries({ ...everything, kinds: ["Daemon"], network: "libera" }),
            []
          );

          for (const network of [undefined, "libera", "ergo", "nowhere"]) {
            const filter = network === undefined ? {} : { network };
            const messages = yield* log.messages(everything);
            const gaps = yield* log.gaps(everything);

            assert.deepStrictEqual(
              yield* pageThrough((after) => reader.messages({ ...filter, after, limit }), limit),
              formattedMessages(
                messages.filter((message) => network === undefined || message.network === network)
              )
            );
            assert.deepStrictEqual(
              yield* pageThrough((after) => reader.gaps({ ...filter, after, limit }), limit),
              gaps.filter((gap) => network === undefined || gap.network === network)
            );
          }
        })
      )
    );

    for (const [where, readerLayer] of readers) {
      it.live(`MSG-5, LOG-11: reads Activity by Network and place, by its cursor, ${where}`, () =>
        withReader(
          () =>
            Effect.gen(function* () {
              yield* seedMixed;
              yield* seedActivity;

              const log = yield* Log;
              const reader = yield* LogReader;
              const all = formattedActivity(yield* log.activity(allActivity));

              // Each QUIT is a row in each Channel it leaves, so Entries span pages.
              assert.isAbove(all.length, 40);
              assert.deepStrictEqual(yield* reader.activity(allActivity), all);

              const start = { sequence: 0 };

              const queries: readonly ActivityQuery[] = [
                { after: start, limit: 1 },
                { after: start, limit: 3 },
                { after: start, limit: 3, network: "libera" },
                { after: start, limit: 3, network: "nowhere" },
                { after: start, limit: 2, network: "libera", place: { _tag: "Network" } },
                {
                  after: start,
                  limit: 2,
                  network: "libera",
                  place: { _tag: "Channel", name: "#A" },
                },
                { after: start, limit: 2, network: "oftc", place: { _tag: "Channel", name: "#a" } },
                { after: start, limit: 1, network: "libera", place: { _tag: "User", name: "Bob" } },
              ];

              for (const query of queries) {
                const expected = all.filter(
                  ({ network, place }) =>
                    (query.network === undefined || network === query.network) &&
                    (!("place" in query) ||
                      (place._tag === query.place._tag &&
                        ("key" in place ? place.key : "") ===
                          ("name" in query.place ? query.place.name.toLowerCase() : "")))
                );

                const paged = yield* pageActivity(
                  (after) => reader.activity({ ...query, after }),
                  query.limit
                );

                assert.deepStrictEqual(paged, expected, JSON.stringify(query));
              }

              // A page can end inside an Entry, and the next resumes inside it.
              const storm = all.filter(({ details }) => details.kind === "quit");
              const [first] = storm;

              assert.lengthOf(
                storm.filter(({ sequence }) => sequence === first?.sequence),
                3,
                "a QUIT in three Channels"
              );

              const page = yield* reader.activity({
                after: { sequence: (first?.sequence ?? 1) - 1 },
                limit: 2,
              });

              assert.deepStrictEqual(page, storm.slice(0, 2));
              assert.deepStrictEqual(
                yield* reader.activity({
                  after: { ordinal: 1, sequence: first?.sequence ?? 0 },
                  limit: 1,
                }),
                storm.slice(2, 3)
              );
              // With only a sequence, the cursor is after the whole of that Entry.
              assert.deepStrictEqual(
                (yield* reader.activity({
                  after: { sequence: first?.sequence ?? 0 },
                  limit: 1,
                })).map(({ sequence }) => sequence),
                [storm[3]?.sequence]
              );
            }),
          {},
          readerLayer
        )
      );
    }

    it.live(
      "LOG-11, KNOW-8: a page of Activity stops at about `pageBytes` inside an Entry, and resumes",
      () =>
        withReader(() =>
          Effect.gen(function* () {
            const channels = Arr.range(1, 1024).map((index) => `#c${index}`);

            const [{ sequence: connection }] = yield* record([
              {
                _tag: "Connection",
                ircd,
                network: "libera",
                nicks: ["alice"],
                phase: "attempt",
                ...attemptInput,
              },
            ]);

            const heard = (text: string) => line(text, "libera", "inbound", connection);

            yield* record([
              { _tag: "Connection", connection, ircd, network: "libera", phase: "opened" },
              heard(":ircd 001 alice :Welcome"),
            ]);

            const joins = channels.flatMap((channel) => [
              heard(`:alice!a@h JOIN ${channel}`),
              heard(`:ircd 353 alice = ${channel} :alice big`),
              heard(`:ircd 366 alice ${channel} :End of /NAMES list.`),
            ]);

            yield* Effect.forEach(Arr.chunksOf(joins, 768), record, { discard: true });

            // One Line, a row in each of 1,024 Channels, each holding its 8,000 character reason.
            const [quit] = yield* record([heard(`:big!b@h QUIT :${"q".repeat(8000)}`)]);
            const log = yield* Log;
            const reader = yield* LogReader;

            const rows = (yield* log.activity({ after: { sequence: 0 }, limit: 100_000 })).filter(
              ({ sequence }) => sequence === quit.sequence
            );

            assert.lengthOf(rows, 1024);

            const before = { sequence: quit.sequence - 1 };
            const first = yield* reader.activity({ after: before, limit: 100_000 });

            assert.isBelow(first.length, 1024, "the page ended inside the Entry");
            assert.isAtMost(
              rows.slice(0, first.length - 1).reduce((total, row) => total + sizeOfRow(row), 0),
              pageBytes
            );
            assert.deepStrictEqual(
              yield* pageActivity((after) => reader.activity({ after, limit: 100_000 }), 100_000),
              formattedActivity(yield* log.activity({ after: { sequence: 0 }, limit: 100_000 }))
            );

            // A page of one row is one row, however many its Entry has.
            assert.lengthOf(yield* reader.activity({ after: before, limit: 1 }), 1);
          })
        )
    );

    it.live(
      "LOG-11: a page stops at about `pageBytes`, and a cursor still reaches everything",
      () =>
        withReader(() =>
          Effect.gen(function* () {
            const long = (index: number, network: string) =>
              line(`:bob!u@h PRIVMSG #iirc :${index} ${"y".repeat(8000)}`, network, "inbound");

            yield* seedMixed;
            yield* Effect.forEach(
              Arr.chunksOf(Arr.range(1, 300), 50),
              (batch) =>
                record(
                  pipe(
                    batch,
                    Arr.map((index) => long(index, index % 2 === 0 ? "libera" : "oftc"))
                  )
                ),
              { discard: true }
            );
            // One Line bigger than a page, which a page still holds.
            yield* record([
              line(`PRIVMSG #iirc :${"z".repeat(2 * pageBytes)}`, "libera", "outbound"),
            ]);

            const log = yield* Log;
            const reader = yield* LogReader;
            const all = yield* log.entries({ after: 0, limit: 10_000 });
            const first = yield* reader.entries(everything);

            assert.isBelow(first.length, all.length);
            assert.isAtMost(
              first.slice(0, -1).reduce((total, entry) => total + sizeOf(entry), 0),
              pageBytes
            );

            const huge = all.at(-1);
            const alone = yield* reader.entries({ after: (huge?.sequence ?? 1) - 1, limit: 10 });

            assert.deepStrictEqual(alone, huge === undefined ? [] : [huge]);

            const queries: readonly Omit<EntryQuery, "after" | "limit">[] = [
              {},
              { network: "libera" },
              { kinds: ["Line", "Dropped"] },
              { kinds: ["Connection", "Line"], network: "oftc" },
            ];

            for (const query of queries) {
              assert.deepStrictEqual(
                yield* pageThrough(
                  (after) => reader.entries({ ...query, after, limit: 1000 }),
                  1000
                ),
                all.filter(
                  (entry) =>
                    (query.network === undefined || networkOf(entry) === query.network) &&
                    (query.kinds === undefined || query.kinds.includes(entry._tag))
                ),
                JSON.stringify(query)
              );
            }

            const messages = yield* log.messages({ after: 0, limit: 10_000 });

            assert.isBelow((yield* reader.messages(everything)).length, 100);
            assert.deepStrictEqual(
              yield* pageThrough((after) => reader.messages({ after, limit: 1000 }), 1000),
              formattedMessages(messages)
            );
          })
        )
    );

    it.live("LOG-11: every filter is a range over an index, never a scan or a sort", () =>
      withReader((dataDir) =>
        Effect.sync(() => {
          const database = new Database(`${dataDir}/iirc.sqlite`, { readonly: true });

          allowBudgets(database);

          const plans = Object.entries(statements).map(([name, sql]) => [
            name,
            database
              .query<{ readonly detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`)
              .all()
              .map(({ detail }) => detail),
          ]);

          database.close();

          assert.deepStrictEqual(Object.fromEntries(plans), {
            activity: ["SEARCH activity USING PRIMARY KEY ((sequence,ordinal)>(?,?))"],
            activityOfNetwork: [
              "SEARCH activity USING INDEX activity_by_network (network=? AND (sequence,ordinal)>(?,?))",
            ],
            activityOfPlace: [
              "SEARCH activity USING INDEX activity_by_place (network=? AND place_kind=? AND casemapping=? AND place_key=? AND (sequence,ordinal)>(?,?))",
            ],
            attemptTuning: ["SEARCH entries USING INTEGER PRIMARY KEY (rowid=?)"],
            entries: ["SEARCH entries USING INTEGER PRIMARY KEY (rowid>?)"],
            entriesOfKind: ["SEARCH entries USING INDEX entries_by_kind (kind=? AND sequence>?)"],
            entriesOfNetwork: [
              "SEARCH entries USING INDEX entries_by_network (network=? AND sequence>?)",
            ],
            entriesOfNetworkAndKind: [
              "SEARCH entries USING INDEX entries_by_network_and_kind (network=? AND kind=? AND sequence>?)",
            ],
            gaps: ["SEARCH gaps USING INTEGER PRIMARY KEY (rowid>?)"],
            gapsOfNetwork: ["SEARCH gaps USING INDEX gaps_by_network (network=? AND sequence>?)"],
            messages: ["SEARCH messages USING INTEGER PRIMARY KEY (rowid>?)"],
            messagesOfNetwork: [
              "SEARCH messages USING INDEX messages_by_network (network=? AND sequence>?)",
            ],
          });
        })
      )
    );
  });

  describe("keeping to time", () => {
    it.live("LOG-11: a read cannot delay an append", () =>
      withSlowReader("3 seconds", (_dataDir, untilReading) =>
        Effect.gen(function* () {
          const reader = yield* LogReader;

          yield* seedLines(1000);

          const alone = yield* appendLatencies(100);

          // 1000 rows at 5 ms each, stopped by its 3 second budget.
          const reading = yield* Effect.forkChild(timed(Effect.exit(reader.entries(everything))));

          yield* untilReading;

          const beside = yield* appendLatencies(100);

          assert.isUndefined(reading.pollUnsafe(), "the read was still running after every append");

          const [exit, readMillis] = yield* Fiber.join(reading);

          report(`LOG-11 appends alone: ${describeLatencies(alone)}`);
          report(
            `LOG-11 appends beside a ${readMillis.toFixed(0)} ms read: ${describeLatencies(beside)}`
          );

          assert.deepStrictEqual(exit, Exit.fail(new ReadTimedOut({ budgetMillis: 3000 })));
          assert.isAtLeast(readMillis, 3000);
          // An append that waited on the read would wait for it to end, up to 3 seconds,
          // so no append may take as long as a third of that, and the usual one may not
          // take twice as long as it did alone.
          assert.isBelow(Math.max(...beside), 1000, "no append waited on the read");
          assert.isBelow(
            percentile(beside, 0.5),
            percentile(alone, 0.5) * 2 + 10,
            "appends kept their usual latency"
          );
        })
      )
    );

    it.live("LOG-11: a read past its budget fails with ReadTimedOut, and the next is served", () =>
      withSlowReader("300 millis", () =>
        Effect.gen(function* () {
          const reader = yield* LogReader;

          // Enough rows that a read to the end would take 5 seconds, far past the budget.
          yield* seedMixed;
          yield* seedLines(1000);
          // And Activity, an unknown Line each, which would take one.
          yield* record(
            Arr.map(Arr.range(1, 200), (index) =>
              line(`:ircd WALLOPS :${index}`, "libera", "inbound")
            )
          );

          const timedOut = Exit.fail(new ReadTimedOut({ budgetMillis: 300 }));

          // One statement, stopped from inside by its budget.
          const [plain, plainMillis] = yield* timed(Effect.exit(reader.entries(everything)));

          // Several statements, one for each kind, each well within budget alone.
          const [paged, pagedMillis] = yield* timed(
            Effect.exit(reader.entries({ ...everything, kinds, network: "libera" }))
          );

          assert.deepStrictEqual(plain, timedOut);
          assert.deepStrictEqual(paged, timedOut);

          for (const millis of [plainMillis, pagedMillis]) {
            assert.isAtLeast(millis, 300);
            assert.isBelow(millis, 1300, "the read stopped near its budget, not at its end");
          }

          assert.deepStrictEqual(yield* Effect.exit(reader.messages(everything)), timedOut);
          assert.deepStrictEqual(yield* Effect.exit(reader.activity(allActivity)), timedOut);
          assert.deepStrictEqual(
            yield* Effect.exit(reader.activity({ ...allActivity, network: "libera" })),
            timedOut
          );
          assert.lengthOf(yield* reader.entries({ after: 0, limit: 3 }), 3);
          assert.lengthOf(yield* reader.gaps({ after: 0, limit: 1 }), 1);
        })
      )
    );

    it.live(
      "LOG-11: a read that waits behind others for too long fails with ReaderBusy, unrun",
      () =>
        withSlowReader("300 millis", () =>
          Effect.gen(function* () {
            const reader = yield* LogReader;
            const reads = 16;

            yield* seedLines(200);

            // Each takes its whole 300 ms budget, one at a time, so the later ones wait
            // longer than a caller would for them to start.
            const [exits, millis] = yield* timed(
              Effect.forEach(Arr.range(1, reads), () => Effect.exit(reader.entries(everything)), {
                concurrency: "unbounded",
              })
            );

            const tags = exits.map((exit) =>
              Exit.findErrorOption(exit).pipe(
                Option.map(({ _tag }) => _tag),
                Option.getOrElse(() => "success")
              )
            );

            report(
              `LOG-11 ${reads} reads behind each other: ${tags.join(", ")} in ${millis.toFixed(0)} ms`
            );

            assert.strictEqual(tags[0], "ReadTimedOut");
            assert.include(tags, "ReaderBusy");

            const waits = exits.flatMap((exit) =>
              Exit.findErrorOption(exit).pipe(
                Option.filter(Schema.is(ReaderBusy)),
                Option.match({ onNone: () => [], onSome: ({ waitedMillis }) => [waitedMillis] })
              )
            );

            assert.deepStrictEqual(
              tags.filter((tag) => tag !== "ReadTimedOut" && tag !== "ReaderBusy"),
              []
            );
            assert.isAbove(Math.min(...waits), 1000, "only a wait past what a caller waits");
            // The ones refused cost the Worker nothing, so the queue drained at once. Run one
            // after another they would take all of `reads * 300`.
            assert.isBelow(millis, (reads * 300) / 2);
            assert.lengthOf(yield* reader.entries({ after: 0, limit: 1 }), 1);
          })
        )
    );
  });

  describe("living and dying", () => {
    it.live("LOG-11: closing with a read in flight waits no longer than its budget", () =>
      Effect.gen(function* () {
        const marker = yield* readingMarker;
        const dataDir = yield* dataDirectory;
        const scope = yield* Scope.make();

        const services = yield* Layer.buildWithScope(
          logAndReader(dataDir, { budget: "1 second", spawn: () => slowRows(marker) }),
          scope
        );

        yield* seedLines(1000).pipe(Effect.provideContext(services));

        const reader = Context.get(services, LogReader);
        const reading = yield* Effect.forkChild(Effect.exit(reader.entries(everything)));

        yield* untilReading(marker);

        const [, closeMillis] = yield* timed(Scope.close(scope, Exit.void));
        const exit = yield* Fiber.join(reading).pipe(Effect.timeout("3 seconds"));

        report(`LOG-11 closed with a read in flight in ${closeMillis.toFixed(0)} ms`);

        // Left to run, the read would take 5 seconds, so the close may not wait past its
        // budget by more than a busy machine needs to stop a Worker in.
        assert.isBelow(closeMillis, 2000, "the close waited at most for the budget");
        assert.isTrue(Exit.isFailure(exit), "the read did not pretend to finish");
      }).pipe(Effect.scoped)
    );

    it.live("LOG-11: a Worker that dies is reported, fails its reads, and is started again", () =>
      Effect.gen(function* () {
        const marker = yield* readingMarker;
        const workers: globalThis.Worker[] = [];
        const logged: string[] = [];

        const spawn = () => {
          const worker = slowRows(marker);

          workers.push(worker);

          return worker;
        };

        const logger = Logger.layer([
          Logger.make(({ message }) => {
            logged.push(String(message));
          }),
        ]);

        yield* withReader(
          () =>
            Effect.gen(function* () {
              const reader = yield* LogReader;

              yield* seedLines(1000);

              const reading = yield* Effect.forkChild(Effect.exit(reader.entries(everything)));

              yield* untilReading(marker);

              const terminated = performance.now();

              workers[0]?.terminate();

              const lost = yield* Fiber.join(reading);
              const lostMillis = elapsedSince(terminated);

              const after = yield* eventually(
                Effect.exit(reader.entries({ after: 0, limit: 1 })),
                Exit.isSuccess
              );

              report(`LOG-11 a read on a Worker that died failed in ${lostMillis.toFixed(0)} ms`);

              assert.strictEqual(
                Exit.isFailure(lost)
                  ? Exit.findErrorOption(lost).pipe(
                      Option.map(({ _tag }) => _tag),
                      Option.getOrUndefined
                    )
                  : "success",
                "StorageFailed"
              );
              // The read was sent to a Worker that had just begun, so left to its budget
              // it would fail at 3 seconds. What is asserted is that it did not.
              assert.isBelow(lostMillis, 1500, "it failed when the Worker died, not at its budget");
              assert.isTrue(Exit.isSuccess(after));
              assert.lengthOf(workers, 2, "a second Worker took over");
            }),
          { budget: "3 seconds", spawn }
        ).pipe(Effect.provide(logger));

        // Said once for the death, and not again for the close the test asked for.
        assert.deepStrictEqual(logged, ["The Log's reader exited with code 0"]);
      })
    );
  });
});
