import { Database } from "bun:sqlite";
import { writeSync } from "node:fs";

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

import { allowBudgets } from "./budget.ts";
import { ReaderBusy } from "./errors.ts";
import { Log, LogReader, ReadTimedOut } from "./log.ts";
import type { EntryQuery, LogReaderOptions } from "./log.ts";
import { pageBytes, statements } from "./reads.ts";

// LOG-11 from the outside: a Worker with its own connection serves every read, keeps to
// a budget, and leaves the writer alone however slow it is.

const encoder = new TextEncoder();
const ircd = { host: "irc.example", port: 6697, tls: true };
const networks = ["libera", "oftc", "ergo"] as const;
const kinds = ["Connection", "Daemon", "Deadline", "Dropped", "Line"] as const;
const everything = { after: 0, limit: 1000 };

// The fixture makes every row a statement looks at cost 5 ms, so a read of N rows takes
// 5N ms unless its budget stops it first.
const slowRows = () => new Worker(new URL("slow-reader.fixture.ts", import.meta.url));

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

const logAndReader = (dataDir: string, options: Omit<LogReaderOptions, "dataDir"> = {}) =>
  LogReader.layer({ dataDir, ...options }).pipe(Layer.provideMerge(Log.layer({ dataDir })));

const withReader = <A, E>(
  test: (dataDir: string) => Effect.Effect<A, E, Log | LogReader | Recorder | Scope.Scope>,
  options?: Omit<LogReaderOptions, "dataDir">
) =>
  Effect.gen(function* () {
    const dataDir = yield* dataDirectory;

    return yield* test(dataDir).pipe(Effect.provide(logAndReader(dataDir, options)));
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
    it.live("LOG-11: reads only what has committed, and every commit as soon as it lands", () =>
      withReader((dataDir) =>
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
        })
      )
    );

    it.live("LOG-11: returns exactly what the writer holds, Entries, Messages, and Gaps", () =>
      withReader(() =>
        Effect.gen(function* () {
          yield* seedMixed;

          const log = yield* Log;
          const reader = yield* LogReader;

          assert.deepStrictEqual(yield* reader.entries(everything), yield* log.entries(everything));
          assert.deepStrictEqual(
            yield* reader.messages(everything),
            yield* log.messages(everything)
          );
          assert.deepStrictEqual(yield* reader.gaps(everything), yield* log.gaps(everything));
          assert.lengthOf(yield* reader.gaps(everything), 9);
        })
      )
    );

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
              messages.filter((message) => network === undefined || message.network === network)
            );
            assert.deepStrictEqual(
              yield* pageThrough((after) => reader.gaps({ ...filter, after, limit }), limit),
              gaps.filter((gap) => network === undefined || gap.network === network)
            );
          }
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
              messages
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
    it.live(
      "LOG-11: a read cannot delay an append",
      () =>
        withReader(
          () =>
            Effect.gen(function* () {
              const reader = yield* LogReader;

              yield* seedLines(1000);

              const alone = yield* appendLatencies(100);

              // 1000 rows at 5 ms each, stopped by its 3 second budget.
              const reading = yield* Effect.forkChild(
                timed(Effect.exit(reader.entries(everything)))
              );

              yield* Effect.sleep("100 millis");

              const beside = yield* appendLatencies(100);

              assert.isUndefined(
                reading.pollUnsafe(),
                "the read was still running after every append"
              );

              const [exit, readMillis] = yield* Fiber.join(reading);

              report(`LOG-11 appends alone: ${describeLatencies(alone)}`);
              report(
                `LOG-11 appends beside a ${readMillis.toFixed(0)} ms read: ${describeLatencies(beside)}`
              );

              assert.deepStrictEqual(exit, Exit.fail(new ReadTimedOut({ budgetMillis: 3000 })));
              assert.isAtLeast(readMillis, 3000);
              assert.isBelow(Math.max(...beside), 250, "no append waited on the read");
              assert.isBelow(
                percentile(beside, 0.5),
                percentile(alone, 0.5) + 5,
                "appends kept their usual latency"
              );
            }),
          { budget: "3 seconds", spawn: slowRows }
        ),
      { timeout: 30_000 }
    );

    it.live(
      "LOG-11: a read past its budget fails with ReadTimedOut, and the next is served",
      () =>
        withReader(
          () =>
            Effect.gen(function* () {
              const reader = yield* LogReader;

              yield* seedMixed;
              yield* seedLines(200);

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
                assert.isBelow(millis, 300 + 500, "the read stopped near its budget");
              }

              assert.deepStrictEqual(yield* Effect.exit(reader.messages(everything)), timedOut);
              assert.lengthOf(yield* reader.entries({ after: 0, limit: 3 }), 3);
              assert.lengthOf(yield* reader.gaps({ after: 0, limit: 1 }), 1);
            }),
          { budget: "300 millis", spawn: slowRows }
        ),
      { timeout: 20_000 }
    );
    it.live(
      "LOG-11: a read that waits behind others for too long fails with ReaderBusy, unrun",
      () =>
        withReader(
          () =>
            Effect.gen(function* () {
              const reader = yield* LogReader;

              yield* seedLines(200);

              // Each takes its whole 300 ms budget, one at a time, so the later ones wait
              // longer than a caller would for them to start.
              const [exits, millis] = yield* timed(
                Effect.forEach(Arr.range(1, 8), () => Effect.exit(reader.entries(everything)), {
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
                `LOG-11 eight reads behind each other: ${tags.join(", ")} in ${millis.toFixed(0)} ms`
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
              // The ones refused cost the Worker nothing, so the queue drained at once.
              assert.isBelow(millis, 8 * 300);
              assert.lengthOf(yield* reader.entries({ after: 0, limit: 1 }), 1);
            }),
          { budget: "300 millis", spawn: slowRows }
        ),
      { timeout: 20_000 }
    );
  });

  describe("living and dying", () => {
    it.live(
      "LOG-11: closing with a read in flight waits no longer than its budget",
      () =>
        Effect.gen(function* () {
          const dataDir = yield* dataDirectory;
          const scope = yield* Scope.make();

          const services = yield* Layer.buildWithScope(
            logAndReader(dataDir, { budget: "1 second", spawn: slowRows }),
            scope
          );

          yield* seedLines(1000).pipe(Effect.provideContext(services));

          const reader = Context.get(services, LogReader);
          const reading = yield* Effect.forkChild(Effect.exit(reader.entries(everything)));

          yield* Effect.sleep("100 millis");

          const [, closeMillis] = yield* timed(Scope.close(scope, Exit.void));
          const exit = yield* Fiber.join(reading).pipe(Effect.timeout("2 seconds"));

          report(`LOG-11 closed with a read in flight in ${closeMillis.toFixed(0)} ms`);

          assert.isBelow(closeMillis, 1000 + 500, "the close waited at most for the budget");
          assert.isTrue(Exit.isFailure(exit), "the read did not pretend to finish");
        }).pipe(Effect.scoped),
      { timeout: 20_000 }
    );

    it.live(
      "LOG-11: a Worker that dies is reported, fails its reads, and is started again",
      () =>
        Effect.gen(function* () {
          const workers: globalThis.Worker[] = [];
          const logged: string[] = [];

          const spawn = () => {
            const worker = slowRows();

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

                const reading = yield* Effect.forkChild(
                  timed(Effect.exit(reader.entries(everything)))
                );

                yield* Effect.sleep("100 millis");
                workers[0]?.terminate();

                const [lost, lostMillis] = yield* Fiber.join(reading);

                const after = yield* eventually(
                  Effect.exit(reader.entries({ after: 0, limit: 1 })),
                  Exit.isSuccess,
                  "5 seconds"
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
                assert.isBelow(
                  lostMillis,
                  3000,
                  "it failed when the Worker died, not at its budget"
                );
                assert.isTrue(Exit.isSuccess(after));
                assert.lengthOf(workers, 2, "a second Worker took over");
              }),
            { budget: "3 seconds", spawn }
          ).pipe(Effect.provide(logger));

          // Said once for the death, and not again for the close the test asked for.
          assert.deepStrictEqual(logged, ["The Log's reader exited with code 0"]);
        }),
      { timeout: 20_000 }
    );
  });
});
