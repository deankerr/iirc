import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import type { Entry, NewEntry } from "@iirc/session/entry";
import { Recorder } from "@iirc/session/recorder";
import { foldStandings, noStandings } from "@iirc/session/standing";
import { attemptInput } from "@iirc/session/testing";
import { Array as Arr, Effect, FileSystem, Layer } from "effect";

import { openDatabase } from "./database.ts";
import { Log, LogReader } from "./log.ts";
import { inProcessReader } from "./testing.ts";

// MSG-4, KNOW-3, PROT-3, CONF-1, and LOG-10: what an `attempt` records of Tuning is what
// its Connection is read with, live and on every rebuild, whatever the Owner changes after.

type Tuning = Extract<NewEntry, { readonly phase: "attempt" }>["tuning"];

// The spec's defaults, as a host records them.
const defaultTuning: Tuning = attemptInput.tuning;

const encoder = new TextEncoder();
const ircd = { host: "irc.example", port: 6697, tls: true };
const network = "libera";

// "Привет" in windows-1251, which is not UTF-8.
const cp1251 = [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2];

const record = (entries: readonly NewEntry[]) =>
  Recorder.use(({ record: recorded }) =>
    Arr.isReadonlyArrayNonEmpty(entries)
      ? recorded(entries, (all): readonly Entry[] => all)
      : Effect.succeed<readonly Entry[]>([])
  );

// One Connection with its own Tuning: opened, welcomed, and one Message in bytes.
const connection = (tuning: Tuning, bytes: readonly number[]) =>
  Effect.gen(function* () {
    const [attempt] = yield* record([
      {
        _tag: "Connection",
        ircd,
        network,
        nicks: ["alice"],
        ...attemptInput,
        phase: "attempt",
        tuning,
      },
    ]);

    const id = attempt?.sequence ?? 0;

    const line = (text: Uint8Array): NewEntry => ({
      _tag: "Line",
      bytes: text,
      connection: id,
      direction: "inbound",
      network,
    });

    yield* record([
      { _tag: "Connection", connection: id, ircd, network, phase: "opened" },
      line(encoder.encode(":irc.example 001 alice :Welcome")),
      line(Uint8Array.of(...encoder.encode(":bob!u@h PRIVMSG #iirc :"), ...bytes)),
      { _tag: "Connection", connection: id, ircd, network, phase: "closed", reason: "gone" },
    ]);

    return id;
  });

const everything = { after: 0, limit: 1_000_000 };

const texts = Log.use(({ messages }) =>
  Effect.map(messages(everything), (all) => all.map(({ text }) => text))
);

const inTempDirectory = <A, E, R>(test: (dataDir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    // Not `/tmp`, because that is tmpfs on fserv, where fsync means nothing.
    return yield* test(
      yield* fileSystem.makeTempDirectoryScoped({ directory: "/var/tmp", prefix: "iirc-log-" })
    );
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

// One start of a Daemon on the data directory: the Log, and a reader beside it.
const started = <A, E>(dataDir: string, test: Effect.Effect<A, E, Log | LogReader | Recorder>) =>
  test.pipe(
    Effect.provide(inProcessReader({ dataDir }).pipe(Layer.provideMerge(Log.layer({ dataDir })))),
    Effect.scoped
  );

describe("MSG-4: each Connection decodes with the fallback its attempt recorded", () => {
  it.effect(
    "LOG-10: recording live and rebuilding agree after the Owner changes the encoding",
    () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const live = yield* started(
            dataDir,
            Effect.gen(function* () {
              yield* connection({ ...defaultTuning, encoding: "windows-1251" }, cp1251);
              // The Owner took the encoding away before the next Connection.
              yield* connection(defaultTuning, cp1251);

              return yield* texts;
            })
          );

          assert.deepStrictEqual(live, ["Привет", "Ïðèâåò"]);

          // A rebuild on the same start, and a later start, which rebuilds as well.
          const rebuilt = yield* started(
            dataDir,
            Effect.gen(function* () {
              yield* Log.use(({ rebuild }) => rebuild);

              return yield* texts;
            })
          );

          assert.deepStrictEqual(rebuilt, live);
        })
      )
  );

  it.effect("MSG-4: the reader finds each Connection's encoding, for /entries", () =>
    inTempDirectory((dataDir) =>
      started(
        dataDir,
        Effect.gen(function* () {
          const first = yield* connection({ ...defaultTuning, encoding: "koi8-r" }, cp1251);
          const second = yield* connection(defaultTuning, cp1251);

          const found = yield* LogReader.use(({ encodings }) =>
            encodings([first, second, first, 9999])
          );

          assert.deepStrictEqual(found, [{ connection: first, encoding: "koi8-r" }]);
        })
      )
    )
  );
});

describe("CONF-1: an attempt recorded before this Tuning existed", () => {
  // Exactly what an `attempt` held before the encoding, the casemapping, and CTCP replies
  // were Tuning: numbers alone.
  const numbersOnly = JSON.stringify({
    burstMillis: 10_000,
    connectTimeoutMillis: 15_000,
    controlLaneLimit: 64,
    drainMillis: 5000,
    floodBurst: 5,
    floodIntervalMillis: 2000,
    joinRetryMillis: 60_000,
    kickRejoinMillis: 10_000,
    lagCheckMillis: 60_000,
    laneLimit: 1000,
    loginWaitMillis: 2000,
    quitWaitMillis: 2000,
    reconnectInitialMillis: 5000,
    reconnectMaxMillis: 300_000,
    registrationTimeoutMillis: 60_000,
    rejoinSettleMillis: 1000,
    sendWaitMillis: 10_000,
    silenceMillis: 90_000,
    stableAfterMillis: 300_000,
    writeTimeoutMillis: 10_000,
  });

  it.effect("CONF-1: reads as the defaults, and folds as a Connection with them", () =>
    inTempDirectory((dataDir) =>
      Effect.gen(function* () {
        const id = yield* started(dataDir, connection(defaultTuning, cp1251));

        // As an older Daemon wrote it.
        yield* Effect.gen(function* () {
          const sql = yield* openDatabase(dataDir);

          yield* sql`UPDATE entries SET tuning = ${numbersOnly} WHERE sequence = ${id}`;
        }).pipe(Effect.scoped);

        const {
          entries,
          standing,
          texts: said,
        } = yield* started(
          dataDir,
          Effect.gen(function* () {
            return {
              entries: yield* Log.use((log) => log.entries(everything)),
              standing: yield* Recorder.use((recorder) => recorder.standing(network)),
              texts: yield* texts,
            };
          })
        );

        const [attempt] = entries;

        assert.deepInclude(attempt, { phase: "attempt", tuning: defaultTuning });
        assert.deepStrictEqual(standing.attempt?.tuning, defaultTuning);
        assert.isUndefined(standing.attempt?.fallback);
        assert.deepStrictEqual(
          foldStandings(noStandings, entries).get(network)?.attempt?.tuning,
          defaultTuning
        );
        assert.deepStrictEqual(said, ["Ïðèâåò"]);
      })
    )
  );
});
