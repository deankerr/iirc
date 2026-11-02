import { writeSync } from "node:fs";

import { BunServices } from "@effect/platform-bun";
import { assert, beforeAll, describe, it } from "@effect/vitest";
import type { LogEntry } from "@iirc/api";
import { defaultTuning } from "@iirc/lifecycle/tuning";
import type { Tuning } from "@iirc/lifecycle/tuning";
import { eventually, scriptedIrcd, testWire, welcoming } from "@iirc/session/testing";
import type { ScriptedIrcd } from "@iirc/session/testing";
import { Effect, Fiber, FileSystem, Layer } from "effect";
import { FetchHttpClient } from "effect/http";

import { appRoot, freePort, healthyClient, logTail, startBinary } from "./binary.ts";
import { assertBackoff, buildBinary, buildTimeout, shortestWait } from "./testing.ts";

// RUN-3 and LIVE-9 against the real thing: the minified binary, under signals, on a real
// socket, with the Ircd counting what actually reached it.

const binary = `${appRoot}/dist/iirc-run`;

const testTimeout = 20_000;

const network = "run";
const channel = "#run";
const nick = "iirc";
const quitReason = "going away";

// Other software on this machine dials 127.0.0.1, and nothing dials this.
const ircdAddress = "127.77.1.1";

const settleLimit = "10 seconds";

// How long a Daemon that means to dial would take, by far.
const dialMillis = 1000;

// What `hostNetwork` allows past `quitWaitMillis`, and a little for the process to go.
const stopMarginMillis = 1000 + 500;

// How much later the Ircd's clock can read an `accept` than the Daemon's read the `attempt`.
const clockSlackMillis = 5;

const crashRestarts = 10;
const crashLifeMillis = 120;

const report = (text: string) => {
  writeSync(process.stdout.fd, `${text}\n`);
};

interface Reached {
  readonly host?: string;
  readonly port: number;
}

const flagsWith = (
  ircd: Reached,
  httpPort: number,
  tuning: string,
  extra: readonly string[] = []
) => [
  "daemon",
  "--no-tls",
  "--network",
  network,
  "--host",
  ircd.host ?? ircdAddress,
  "--port",
  String(ircd.port),
  "--nick",
  nick,
  "--channel",
  channel,
  "--quit-reason",
  quitReason,
  "--tuning",
  tuning,
  "--http-port",
  String(httpPort),
  ...extra,
];

const daemonFlags = (
  ircd: Reached,
  httpPort: number,
  tuning: Partial<Tuning>,
  extra?: readonly string[]
) => flagsWith(ircd, httpPort, JSON.stringify(tuning), extra);

const startIn = (
  dataDir: string,
  ircd: Reached,
  tuning: Partial<Tuning>,
  extra?: readonly string[]
) =>
  Effect.gen(function* () {
    const httpPort = yield* freePort;

    return yield* startBinary(binary, daemonFlags(ircd, httpPort, tuning, extra), {
      IIRC_DATA_DIR: dataDir,
    }).pipe(Effect.map((running) => ({ ...running, httpPort })));
  });

type Running = Effect.Success<ReturnType<typeof startIn>>;

const startDaemon = Effect.fnUntraced(function* (
  dataDir: string,
  ircd: Reached,
  tuning: Partial<Tuning>,
  extra?: readonly string[]
) {
  const running = yield* startIn(dataDir, ircd, tuning, extra);
  const { daemon } = yield* healthyClient(running.httpPort);

  return { daemon, running };
});

const signal = (running: Running, name: NodeJS.Signals) =>
  Effect.gen(function* () {
    const stopping = Date.now();

    process.kill(running.child.pid, name);

    const code = Number(yield* running.child.exitCode);

    yield* Fiber.join(running.reader);

    return { code, millis: Date.now() - stopping };
  });

const sigkill = (running: Running) => Effect.ignore(signal(running, "SIGKILL"));

const dataDirectory = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;

  // Not `/tmp`, because that is tmpfs here, where fsync means nothing.
  return yield* fileSystem.makeTempDirectoryScoped({ directory: "/var/tmp", prefix: "iirc-run-" });
});

const inSession = ({ phase }: { readonly phase: string }) => phase === "session";

const welcomingIrcd = scriptedIrcd(welcoming(nick), { hostname: ircdAddress });

const joined = (ircd: ScriptedIrcd) =>
  eventually(ircd.received, (lines) => lines.includes(`JOIN ${channel}`), settleLimit);

const entriesOf = (daemon: Effect.Success<ReturnType<typeof startDaemon>>["daemon"]) =>
  daemon.entries({ query: { after: 0, limit: 1000 } });

const attemptsIn = (entries: readonly LogEntry[]) =>
  entries.filter((entry) => entry._tag === "Connection" && entry.phase === "attempt");

const layers = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);

describe("the compiled binary, stopping and starting", () => {
  beforeAll(async () => {
    await Effect.runPromise(buildBinary(binary));
  }, buildTimeout);

  for (const name of ["SIGTERM", "SIGINT"] as const) {
    it.live(
      `LIVE-9: on ${name}, says QUIT, exits 0, and the Log ends in \`closed\` then \`stopped\``,
      () =>
        Effect.gen(function* () {
          const dataDir = yield* dataDirectory;
          const ircd = yield* welcomingIrcd;
          const { daemon, running } = yield* startDaemon(dataDir, ircd, {});

          yield* eventually(daemon.status(), inSession, settleLimit);
          yield* joined(ircd);

          const stopped = yield* Effect.forkChild(signal(running, name));

          yield* eventually(
            ircd.received,
            (lines) => lines.includes(`QUIT :${quitReason}`),
            settleLimit
          );
          yield* ircd.finish;

          const { code, millis } = yield* Fiber.join(stopped);

          assert.strictEqual(code, 0, running.output());
          assert.isBelow(
            millis,
            defaultTuning.quitWaitMillis,
            "an Ircd that hangs up is not waited for"
          );
          assert.deepStrictEqual(yield* logTail(dataDir, 4), [
            "Connection closing",
            `QUIT :${quitReason}`,
            "Connection closed",
            "Daemon stopped",
          ]);
          assert.notInclude(running.output(), "ERROR");
        }).pipe(Effect.scoped, Effect.provide(layers)),
      { timeout: testTimeout }
    );
  }

  it.live(
    "LIVE-9: gives an Ircd that says nothing `quitWaitMillis` and no longer",
    () =>
      Effect.gen(function* () {
        const quitWaitMillis = 300;
        const dataDir = yield* dataDirectory;
        const ircd = yield* welcomingIrcd;
        const { daemon, running } = yield* startDaemon(dataDir, ircd, { quitWaitMillis });

        yield* eventually(daemon.status(), inSession, settleLimit);
        yield* joined(ircd);

        const { code, millis } = yield* signal(running, "SIGTERM");

        assert.strictEqual(code, 0, running.output());
        assert.isAtLeast(millis, quitWaitMillis, "it must give the Ircd its chance to hang up");
        assert.isBelow(millis, quitWaitMillis + stopMarginMillis);
        assert.include(yield* ircd.received, `QUIT :${quitReason}`);
        assert.deepStrictEqual(yield* logTail(dataDir, 2), ["Connection closed", "Daemon stopped"]);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "LIVE-9: an impatient second signal changes nothing about how it stops",
    () =>
      Effect.gen(function* () {
        const quitWaitMillis = 400;
        const dataDir = yield* dataDirectory;
        const ircd = yield* welcomingIrcd;
        const { daemon, running } = yield* startDaemon(dataDir, ircd, { quitWaitMillis });

        yield* eventually(daemon.status(), inSession, settleLimit);
        yield* joined(ircd);

        const stopped = yield* Effect.forkChild(signal(running, "SIGTERM"));

        yield* eventually(
          ircd.received,
          (lines) => lines.includes(`QUIT :${quitReason}`),
          settleLimit
        );

        process.kill(running.child.pid, "SIGINT");

        const { code, millis } = yield* Fiber.join(stopped);

        assert.strictEqual(code, 0, running.output());
        assert.isAtLeast(millis, quitWaitMillis, "the second signal cut the Ircd's chance short");
        assert.deepStrictEqual(yield* logTail(dataDir, 2), ["Connection closed", "Daemon stopped"]);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "LIVE-9: stops on a stalled socket, and answers a Send caught in it first",
    () =>
      Effect.gen(function* () {
        const quitWaitMillis = 300;
        const dataDir = yield* dataDirectory;
        const ircd = yield* welcomingIrcd;
        const wire = yield* testWire(ircd.port, ircdAddress);

        const { daemon, running } = yield* startDaemon(
          dataDir,
          { port: wire.port },
          { floodBurst: 1, floodIntervalMillis: 60_000, quitWaitMillis }
        );

        yield* eventually(daemon.status(), inSession, settleLimit);
        yield* joined(ircd);
        yield* wire.stall;

        const send = daemon.send({ payload: { target: channel, text: "caught in it" } });
        const caught = yield* Effect.forkChild(Effect.exit(send));

        yield* eventually(daemon.status(), ({ lanes }) => lanes.interactive === 1, settleLimit);

        const { code, millis } = yield* signal(running, "SIGTERM");
        const answer = yield* Fiber.join(caught);

        assert.strictEqual(code, 0, running.output());
        assert.isBelow(millis, quitWaitMillis + stopMarginMillis, "a Send held up the stop");
        assert.isTrue(answer._tag === "Failure", "a Line that never left cannot be `written`");
        assert.include(String(answer), "LineDropped");
        assert.deepStrictEqual(yield* logTail(dataDir, 2), ["Connection closed", "Daemon stopped"]);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "LIVE-9: stops at once with nothing to leave, while waiting to reconnect to a dead Ircd",
    () =>
      Effect.gen(function* () {
        const dataDir = yield* dataDirectory;

        const { daemon, running } = yield* startDaemon(
          dataDir,
          { port: yield* freePort },
          { reconnectInitialMillis: 60_000 }
        );

        yield* eventually(
          daemon.status(),
          ({ nextAttemptAt, phase }) => phase === "closed" && nextAttemptAt !== null,
          settleLimit
        );

        const { code, millis } = yield* signal(running, "SIGTERM");

        assert.strictEqual(code, 0, running.output());
        assert.isBelow(millis, stopMarginMillis);
        assert.deepStrictEqual(yield* logTail(dataDir, 1), ["Daemon stopped"]);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "RUN-3: a restart after a clean stop connects at once, and one after a kill does not",
    () =>
      Effect.gen(function* () {
        const dataDir = yield* dataDirectory;
        const ircd = yield* welcomingIrcd;
        const tuning = { quitWaitMillis: 50, reconnectInitialMillis: 60_000 };

        const untilInSession = Effect.gen(function* () {
          const started = yield* startDaemon(dataDir, ircd, tuning);

          yield* eventually(started.daemon.status(), inSession, settleLimit);

          return started;
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const { running } = yield* untilInSession;
            const { code } = yield* signal(running, "SIGTERM");

            assert.strictEqual(code, 0, running.output());
          })
        );

        const { daemon, running } = yield* untilInSession;

        assert.strictEqual(yield* ircd.accepted, 2, "a clean stop owes the Network no wait");

        const [, stoppedAt] = (yield* entriesOf(daemon)).flatMap((entry) =>
          entry._tag === "Daemon" ? [entry.at] : []
        );

        const [, secondAttempt] = attemptsIn(yield* entriesOf(daemon));

        assert.isBelow((secondAttempt?.at ?? 0) - (stoppedAt ?? 0), dialMillis);

        yield* sigkill(running);

        const after = yield* startDaemon(dataDir, ircd, tuning);

        yield* Effect.sleep(dialMillis);

        assert.strictEqual(yield* ircd.accepted, 2, "a kill is a failure, so it must wait");
        assert.isAbove(
          (yield* after.daemon.status()).nextAttemptAt ?? 0,
          Date.now(),
          "and status must say until when"
        );
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "LIVE-4: a crash loop reaches the Ircd spaced by backoff, however often it restarts",
    () =>
      Effect.gen(function* () {
        const dataDir = yield* dataDirectory;
        const ircd = yield* welcomingIrcd;
        const tuning = { reconnectInitialMillis: 500, reconnectMaxMillis: 2000 };
        const tuned = { ...defaultTuning, ...tuning };

        const crash = (lifeMillis: number) =>
          Effect.gen(function* () {
            const running = yield* startIn(dataDir, ircd, tuning);

            yield* Effect.sleep(lifeMillis);
            yield* sigkill(running);
          }).pipe(Effect.scoped);

        // The first must get through, or nothing below would have anything to space.
        const first = yield* startIn(dataDir, ircd, tuning);

        yield* eventually(ircd.accepted, (accepted) => accepted === 1, settleLimit);
        yield* sigkill(first);

        yield* Effect.forEach(
          Array.from({ length: crashRestarts }, (_unused, index) => index),
          (index) => crash(crashLifeMillis + (index % 3) * 40),
          { discard: true }
        );

        const reached = yield* ircd.accepted;

        report(`crash loop: ${crashRestarts + 1} runs reached the Ircd ${reached} times`);

        const { daemon } = yield* startDaemon(dataDir, ircd, tuning);

        yield* eventually(ircd.accepted, (accepted) => accepted > reached, settleLimit);

        const acceptedAt = yield* ircd.acceptedAt;
        const entries = yield* entriesOf(daemon);

        report(
          `crash loop: Connections accepted at ${acceptedAt.map((at) => at - (acceptedAt[0] ?? 0)).join(", ")} ms`
        );

        assert.isAtMost(reached, Math.ceil(crashRestarts / 2), "that is hammering");

        for (const [index, at] of acceptedAt.slice(1).entries()) {
          const before = acceptedAt[index] ?? 0;

          assert.isAtLeast(
            at - before + clockSlackMillis,
            shortestWait(index + 1, tuned),
            `Connection ${index + 2} followed too soon`
          );
        }

        assert.isAtLeast(attemptsIn(entries).length, acceptedAt.length);
        assertBackoff(entries, () => tuned);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "LIVE-5: a refusal outlives restarts, none of which dial during the wait",
    () =>
      Effect.gen(function* () {
        const text = "You are banned from this Network (scripted)";
        const refusalBackoffMillis = 3000;
        const dataDir = yield* dataDirectory;

        // Far shorter than the wait, so that only the refusal can be what holds it back.
        const tuning = {
          drainMillis: 20,
          quitWaitMillis: 50,
          reconnectInitialMillis: 50,
          reconnectMaxMillis: 50,
          refusalBackoffMillis,
        };

        const ircd = yield* scriptedIrcd(
          (line) => (line.startsWith("USER ") ? [`:ircd 465 ${nick} :${text}`] : []),
          { hostname: ircdAddress }
        );

        const refused = Effect.gen(function* () {
          const { daemon, running } = yield* startDaemon(dataDir, ircd, tuning);

          const status = yield* eventually(
            daemon.status(),
            ({ nextAttemptAt, refused: isRefused }) => isRefused && nextAttemptAt !== null,
            settleLimit
          );

          return { daemon, running, status };
        });

        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const { running, status } = yield* refused;
            const { code } = yield* signal(running, "SIGTERM");

            assert.strictEqual(code, 0, running.output());

            return status;
          })
        );

        const dueAt = first.nextAttemptAt ?? 0;

        assert.strictEqual(first.refusal, text);
        assert.strictEqual(first.closeReason, text);
        assert.strictEqual(first.consecutiveFailures, 1);

        const second = yield* Effect.scoped(
          Effect.gen(function* () {
            const { running, status } = yield* refused;

            yield* sigkill(running);

            return status;
          })
        );

        const { daemon, status: third } = yield* refused;

        assert.strictEqual(second.refusal, text);
        assert.strictEqual(third.refusal, text);
        assert.strictEqual(second.nextAttemptAt, dueAt, "a restart must not move the wait");
        assert.strictEqual(third.nextAttemptAt, dueAt, "nor must a kill");
        assert.isBelow(Date.now(), dueAt, "this test took too long to prove anything");
        assert.strictEqual(yield* ircd.accepted, 1, "a restart dialed during the wait");

        yield* eventually(ircd.accepted, (accepted) => accepted === 2, settleLimit);

        const [, attempt] = attemptsIn(yield* entriesOf(daemon));

        assert.isAtLeast(attempt?.at ?? 0, dueAt, "it dialed before the wait was over");
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "CONN-4: tries `--alternate-nick`s in order, and joins every `--channel` in one Line",
    () =>
      Effect.gen(function* () {
        const taken = new Set([nick, "first"]);

        const ircd = yield* scriptedIrcd(
          (line) => {
            const [command, wanted = ""] = line.split(" ");

            if (command === "NICK" && taken.has(wanted)) {
              return [`:ircd 433 * ${wanted} :Nickname already in use`];
            }

            return line.startsWith("USER ")
              ? [":ircd 433 * iirc :Nickname already in use"]
              : welcoming("second")(line);
          },
          { hostname: ircdAddress }
        );

        const dataDir = yield* dataDirectory;

        const { daemon } = yield* startDaemon(dataDir, ircd, {}, [
          "--alternate-nick",
          "first",
          "--alternate-nick",
          "second",
          "--channel",
          "#other",
        ]);

        const [attempt] = attemptsIn(
          yield* eventually(entriesOf(daemon), (entries) => attemptsIn(entries).length > 0)
        );

        assert.deepInclude(attempt, { phase: "attempt" });
        assert.deepStrictEqual(
          attempt?._tag === "Connection" && attempt.phase === "attempt"
            ? attempt.nicks.slice(0, 3)
            : [],
          [nick, "first", "second"]
        );

        yield* eventually(ircd.received, (lines) => lines.includes("NICK second"), settleLimit);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "refuses a bad `--tuning` before it touches anything",
    () =>
      Effect.gen(function* () {
        const dataDir = yield* dataDirectory;
        const fileSystem = yield* FileSystem.FileSystem;
        const ircd = yield* welcomingIrcd;

        const refused = (json: string) =>
          Effect.gen(function* () {
            const running = yield* startBinary(binary, flagsWith(ircd, yield* freePort, json), {
              IIRC_DATA_DIR: `${dataDir}/never`,
            });

            const code = Number(yield* running.child.exitCode);

            yield* Fiber.join(running.reader);

            return { code, output: running.output() };
          }).pipe(Effect.scoped);

        const misspelt = yield* refused('{"silenceMilis":5000}');
        const outOfRange = yield* refused('{"silenceMillis":-1}');
        const notJson = yield* refused("soon");

        assert.notStrictEqual(misspelt.code, 0);
        assert.include(misspelt.output, "not a Tuning key: silenceMilis");
        assert.notStrictEqual(outOfRange.code, 0);
        assert.include(outOfRange.output, "silenceMillis");
        assert.notStrictEqual(notJson.code, 0);
        assert.include(notJson.output, "--tuning");
        assert.isFalse(yield* fileSystem.exists(`${dataDir}/never`), "it made a data directory");
        assert.strictEqual(yield* ircd.accepted, 0);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );
});
