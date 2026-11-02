import { writeSync } from "node:fs";

import { BunServices } from "@effect/platform-bun";
import { assert, beforeAll, describe, it } from "@effect/vitest";
import { InvalidRequest } from "@iirc/api";
import type { LogEntry, NetworkSettings } from "@iirc/api";
import { defaultTuning } from "@iirc/lifecycle/tuning";
import type { Tuning } from "@iirc/lifecycle/tuning";
import { eventually, scriptedIrcd, testWire, welcoming } from "@iirc/session/testing";
import type { ScriptedIrcd } from "@iirc/session/testing";
import { Effect, Fiber, FileSystem, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import {
  appRoot,
  createKey,
  freePort,
  healthyClient,
  logTail,
  networkStatus,
  ownerKey,
  settingsFor,
  startBinary,
} from "./binary.ts";
import type { Client } from "./binary.ts";
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

/** Where a test's Daemon keeps its Log, and the key made there before it first ran. */
interface Home {
  readonly dataDir: string;
  readonly key: string;
}

// What `--channel`, `--nick`, and the rest used to say, as settings (CONF-4).
const networkAt = (
  ircd: Reached,
  tuning: Partial<Tuning>,
  more: { readonly alternates?: readonly string[]; readonly channels?: readonly string[] } = {}
) =>
  settingsFor({
    alternates: more.alternates ?? [],
    channels: [channel, ...(more.channels ?? [])],
    host: ircd.host ?? ircdAddress,
    id: network,
    nick,
    port: ircd.port,
    quitReason,
    tuning,
  });

// CONF-4: a data directory and a listen address, and nothing else.
const daemonFlags = (httpPort: number) => ["daemon", "--http-port", String(httpPort)];

const startIn = (dataDir: string) =>
  Effect.gen(function* () {
    const httpPort = yield* freePort;

    return yield* startBinary(binary, daemonFlags(httpPort), { IIRC_DATA_DIR: dataDir }).pipe(
      Effect.map((running) => ({ ...running, httpPort }))
    );
  });

type Running = Effect.Success<ReturnType<typeof startIn>>;

// Waits for the API, and fails at once with what the binary said if it exits first, so a
// binary that cannot start says why instead of timing out.
const answering = (running: Running, key: string) =>
  Effect.raceFirst(
    healthyClient(running.httpPort, key),
    running.child.exitCode.pipe(
      Effect.flatMap((code) =>
        Effect.die(
          `The binary exited with ${Number(code)} before it answered:\n${running.output()}`
        )
      )
    )
  );

// Adds the Network through the API unless an earlier run on this Log already has, since
// Configuration outlives a restart.
const configure = (daemon: Client, settings: NetworkSettings) =>
  Effect.gen(function* () {
    const configured = yield* daemon.networks.list();

    if (!configured.some(({ settings: held }) => held.id === settings.id)) {
      yield* daemon.networks.add({ payload: settings });
    }
  });

const startDaemon = Effect.fnUntraced(function* (
  { dataDir, key }: Home,
  ircd: Reached,
  tuning: Partial<Tuning>,
  more?: { readonly alternates?: readonly string[]; readonly channels?: readonly string[] }
) {
  const running = yield* startIn(dataDir);
  const daemon = yield* answering(running, key);

  yield* configure(daemon, networkAt(ircd, tuning, more));

  return { daemon, running };
});

const statusOf = (daemon: Client) => networkStatus(daemon, network);

const signal = (
  running: { readonly child: Running["child"]; readonly reader: Running["reader"] },
  name: NodeJS.Signals
) =>
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

// AUTH-4: a fresh Daemon can authenticate nobody, so the first key comes before it starts.
const home = Effect.gen(function* () {
  const dataDir = yield* dataDirectory;

  return { dataDir, key: yield* createKey(binary, dataDir) } satisfies Home;
});

const inSession = ({ phase }: { readonly phase: string }) => phase === "session";

const welcomingIrcd = scriptedIrcd(welcoming(nick), { hostname: ircdAddress });

const joined = (ircd: ScriptedIrcd) =>
  eventually(ircd.received, (lines) => lines.includes(`JOIN ${channel}`), settleLimit);

const entriesOf = (daemon: Client) => daemon.daemon.entries({ query: { after: 0, limit: 1000 } });

const attemptsIn = (entries: readonly LogEntry[]) =>
  entries.filter((entry) => entry._tag === "Connection" && entry.phase === "attempt");

// Runs the binary to its end, for commands that are not the Daemon.
const runToEnd = (flags: readonly string[], environment: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const running = yield* startBinary(binary, flags, environment);
    const code = Number(yield* running.child.exitCode);

    yield* Fiber.join(running.reader);

    return {
      code,
      output: running.output(),
      stderr: running.stderr(),
      stdout: running.stdout(),
    };
  }).pipe(Effect.scoped);

// A refusal as `config-command` prints one: a line on stderr, with nothing on stdout.
const assertRefusedPlainly = (
  { code, stderr, stdout }: { code: number; stderr: string; stdout: string },
  ...saying: readonly string[]
) => {
  assert.notStrictEqual(code, 0);
  assert.strictEqual(stdout, "", "a refusal went to stdout");
  assert.lengthOf(stderr.trimEnd().split("\n"), 1, stderr);
  assert.notInclude(stderr, "    at ", "a refusal came with a stack trace");

  for (const words of saying) {
    assert.include(stderr, words);
  }
};

const layers = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);

describe("the compiled binary, stopping and starting", () => {
  beforeAll(async () => {
    await Effect.runPromise(buildBinary(binary));
  }, buildTimeout);

  it.live(
    "LOG-11: answers `/api/entries` from the reader's Worker, which it carries",
    () =>
      Effect.gen(function* () {
        const where = yield* home;
        const { dataDir } = where;
        const ircd = yield* welcomingIrcd;
        const running = yield* startIn(dataDir);

        // A binary without the Worker stops here, saying the reader could not start.
        const daemon = yield* answering(running, where.key);

        yield* configure(daemon, networkAt(ircd, {}));

        yield* eventually(statusOf(daemon), inSession, settleLimit);
        yield* joined(ircd);

        const entries = yield* entriesOf(daemon);

        const filtered = yield* daemon.daemon.entries({
          query: { after: 0, kind: ["Daemon", "Connection"], limit: 1000, network },
        });

        assert.deepInclude(entries[0], { _tag: "Change", by: "local", sequence: 1 });
        assert.deepInclude(entries[1], { _tag: "Daemon", phase: "started", sequence: 2 });
        assert.deepStrictEqual(
          filtered,
          entries.filter(({ _tag }) => _tag === "Connection"),
          "the Daemon's own Entries are no Network's"
        );
        assert.isNotEmpty(filtered);

        const { code } = yield* signal(running, "SIGTERM");

        assert.strictEqual(code, 0, running.output());
        assert.notInclude(running.output(), "ERROR");
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  for (const name of ["SIGTERM", "SIGINT"] as const) {
    it.live(
      `LIVE-9: on ${name}, says QUIT, exits 0, and the Log ends in \`closed\` then \`stopped\``,
      () =>
        Effect.gen(function* () {
          const where = yield* home;
          const { dataDir } = where;
          const ircd = yield* welcomingIrcd;
          const { daemon, running } = yield* startDaemon(where, ircd, {});

          yield* eventually(statusOf(daemon), inSession, settleLimit);
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
        const where = yield* home;
        const { dataDir } = where;
        const ircd = yield* welcomingIrcd;
        const { daemon, running } = yield* startDaemon(where, ircd, { quitWaitMillis });

        yield* eventually(statusOf(daemon), inSession, settleLimit);
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
        const where = yield* home;
        const { dataDir } = where;
        const ircd = yield* welcomingIrcd;
        const { daemon, running } = yield* startDaemon(where, ircd, { quitWaitMillis });

        yield* eventually(statusOf(daemon), inSession, settleLimit);
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
        const where = yield* home;
        const { dataDir } = where;
        const ircd = yield* welcomingIrcd;
        const wire = yield* testWire(ircd.port, ircdAddress);

        const { daemon, running } = yield* startDaemon(
          where,
          { port: wire.port },
          { floodBurst: 1, floodIntervalMillis: 60_000, quitWaitMillis }
        );

        yield* eventually(statusOf(daemon), inSession, settleLimit);
        yield* joined(ircd);
        yield* wire.stall;

        const send = daemon.daemon.send({
          payload: { network, target: channel, text: "caught in it" },
        });

        const caught = yield* Effect.forkChild(Effect.exit(send));

        yield* eventually(statusOf(daemon), ({ lanes }) => lanes.interactive === 1, settleLimit);

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
        const where = yield* home;
        const { dataDir } = where;

        const { daemon, running } = yield* startDaemon(
          where,
          { port: yield* freePort },
          { reconnectInitialMillis: 60_000 }
        );

        yield* eventually(
          statusOf(daemon),
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
        const where = yield* home;
        const ircd = yield* welcomingIrcd;
        const tuning = { quitWaitMillis: 50, reconnectInitialMillis: 60_000 };

        const untilInSession = Effect.gen(function* () {
          const started = yield* startDaemon(where, ircd, tuning);

          yield* eventually(statusOf(started.daemon), inSession, settleLimit);

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

        const after = yield* startDaemon(where, ircd, tuning);

        yield* Effect.sleep(dialMillis);

        assert.strictEqual(yield* ircd.accepted, 2, "a kill is a failure, so it must wait");
        assert.isAbove(
          (yield* statusOf(after.daemon)).nextAttemptAt ?? 0,
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
        const where = yield* home;
        const { dataDir } = where;
        const ircd = yield* welcomingIrcd;
        const tuning = { reconnectInitialMillis: 500, reconnectMaxMillis: 2000 };
        const tuned = { ...defaultTuning, ...tuning };

        const crash = (lifeMillis: number) =>
          Effect.gen(function* () {
            const running = yield* startIn(dataDir);

            yield* Effect.sleep(lifeMillis);
            yield* sigkill(running);
          }).pipe(Effect.scoped);

        // The first must get through, or nothing below would have anything to space. It adds
        // the Network, which every run after finds in the Log.
        const first = yield* startDaemon(where, ircd, tuning);

        yield* eventually(ircd.accepted, (accepted) => accepted === 1, settleLimit);
        yield* sigkill(first.running);

        yield* Effect.forEach(
          Array.from({ length: crashRestarts }, (_unused, index) => index),
          (index) => crash(crashLifeMillis + (index % 3) * 40),
          { discard: true }
        );

        const reached = yield* ircd.accepted;

        report(`crash loop: ${crashRestarts + 1} runs reached the Ircd ${reached} times`);

        const { daemon } = yield* startDaemon(where, ircd, tuning);

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
        const where = yield* home;

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
          const { daemon, running } = yield* startDaemon(where, ircd, tuning);

          const status = yield* eventually(
            statusOf(daemon),
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
    "CONN-4: tries the alternate nicks in its settings, in order",
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

        const where = yield* home;

        const { daemon } = yield* startDaemon(
          where,
          ircd,
          {},
          { alternates: ["first", "second"], channels: ["#other"] }
        );

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
    "CONF-4: listens on IIRC_HTTP_PORT when no flag says where",
    () =>
      Effect.gen(function* () {
        const { dataDir, key } = yield* home;
        const httpPort = yield* freePort;

        yield* startBinary(binary, ["daemon"], {
          IIRC_DATA_DIR: dataDir,
          IIRC_HTTP_PORT: String(httpPort),
        });

        const daemon = yield* healthyClient(httpPort, key);

        assert.deepStrictEqual((yield* daemon.daemon.status()).networks, []);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "AUTH-4: refuses to start in one line on stderr, on a held data directory or a taken port",
    () =>
      Effect.gen(function* () {
        const { dataDir, key } = yield* home;
        const running = yield* startIn(dataDir);

        yield* answering(running, key);

        const otherPort = String(yield* freePort);

        const held = yield* runToEnd(["daemon", "--http-port", otherPort], {
          IIRC_DATA_DIR: dataDir,
        });

        const taken = yield* runToEnd(["daemon", "--http-port", String(running.httpPort)], {
          IIRC_DATA_DIR: (yield* home).dataDir,
        });

        assertRefusedPlainly(held, `The data directory ${dataDir} is locked`);
        assertRefusedPlainly(taken, String(running.httpPort));
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "CONF-4: takes no Network flags, and refuses one before it touches anything",
    () =>
      Effect.gen(function* () {
        const dataDir = yield* dataDirectory;
        const fileSystem = yield* FileSystem.FileSystem;
        const ircd = yield* welcomingIrcd;
        const httpPort = String(yield* freePort);

        for (const flags of [
          ["--host", ircdAddress, "--port", String(ircd.port), "--nick", nick],
          ["--tuning", "{}"],
          ["--channel", channel],
        ]) {
          const { code, output } = yield* runToEnd(["daemon", "--http-port", httpPort, ...flags], {
            IIRC_DATA_DIR: `${dataDir}/never`,
          });

          assert.notStrictEqual(code, 0, flags.join(" "));
          assert.include(output, flags[0] ?? "", "it must say which flag it refused");
        }

        assert.isFalse(yield* fileSystem.exists(`${dataDir}/never`), "it made a data directory");
        assert.strictEqual(yield* ircd.accepted, 0);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "API-3: refuses a bad Tuning through the API, saying where, and dials nothing",
    () =>
      Effect.gen(function* () {
        const where = yield* home;
        const ircd = yield* welcomingIrcd;
        const running = yield* startIn(where.dataDir);
        const daemon = yield* answering(running, where.key);
        const httpClient = yield* HttpClient.HttpClient;

        const refused = (tuning: Readonly<Record<string, number>>) =>
          Effect.flip(daemon.networks.add({ payload: { ...networkAt(ircd, {}), tuning } }));

        const misspelt = yield* refused({ silenceMilis: 5000 });
        const outOfRange = yield* refused({ silenceMillis: -1 });

        const notNumbers = yield* httpClient.execute(
          HttpClientRequest.post(`http://127.0.0.1:${running.httpPort}/api/networks`).pipe(
            HttpClientRequest.bearerToken(where.key),
            HttpClientRequest.bodyJsonUnsafe({ ...networkAt(ircd, {}), tuning: "soon" })
          )
        );

        assert.instanceOf(misspelt, InvalidRequest);
        assert.include(JSON.stringify(misspelt), "not a Tuning key: silenceMilis");
        assert.instanceOf(outOfRange, InvalidRequest);
        assert.include(JSON.stringify(outOfRange), "silenceMillis");
        assert.strictEqual(notNumbers.status, 400);
        assert.include(yield* notNumbers.text, '["payload","tuning"]');
        assert.deepStrictEqual(yield* daemon.networks.list(), []);

        yield* Effect.sleep(dialMillis);

        assert.strictEqual(yield* ircd.accepted, 0);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );
});

describe("the compiled binary's `iirc key create` (AUTH-4)", () => {
  beforeAll(async () => {
    await Effect.runPromise(buildBinary(binary));
  }, buildTimeout);

  it.live(
    "prints a key that works, records only its Change as `local`, and starts no Daemon",
    () =>
      Effect.gen(function* () {
        const { dataDir, key } = yield* home;

        assert.deepStrictEqual(yield* logTail(dataDir, 10), ["Change null"]);

        const running = yield* startIn(dataDir);
        const daemon = yield* answering(running, key);
        const [created] = yield* daemon.keys.list();

        assert.deepInclude(created, { name: ownerKey, scope: "admin" });
        assert.isFalse((yield* entriesOf(daemon)).some((entry) => "key" in entry));
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "refuses while a Daemon holds the data directory, saying what to do instead",
    () =>
      Effect.gen(function* () {
        const { dataDir, key } = yield* home;
        const running = yield* startIn(dataDir);

        yield* answering(running, key);

        const refused = yield* runToEnd([
          "key",
          "create",
          "--data-dir",
          dataDir,
          "--name",
          "second",
        ]);

        // On stderr, so that `KEY=$(iirc key create …)` can never hold a refusal.
        assertRefusedPlainly(
          refused,
          `The data directory ${dataDir} is locked`,
          "Stop the Daemon",
          "through the API"
        );
        assert.notMatch(refused.output, /iirc_[A-Za-z0-9_-]{43}/u);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "refuses a name a key already has, and one that is no name",
    () =>
      Effect.gen(function* () {
        const { dataDir } = yield* home;

        const taken = yield* runToEnd(["key", "create", "--data-dir", dataDir, "--name", ownerKey]);
        const local = yield* runToEnd(["key", "create", "--data-dir", dataDir, "--name", "local"]);

        assertRefusedPlainly(taken, `A key named ${ownerKey} already exists`);
        assert.notStrictEqual(local.code, 0);
        assert.include(local.output, "reserved");
        assert.deepStrictEqual(yield* logTail(dataDir, 10), ["Change null"]);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "AUTH-3: makes a key of the scope asked for",
    () =>
      Effect.gen(function* () {
        const { dataDir, key } = yield* home;

        const { code, output } = yield* runToEnd([
          "key",
          "create",
          "--data-dir",
          dataDir,
          "--name",
          "reader",
          "--scope",
          "read",
        ]);

        assert.strictEqual(code, 0, output);

        const running = yield* startIn(dataDir);
        const reader = yield* answering(running, output.trim());
        const owner = yield* healthyClient(running.httpPort, key);

        assert.isEmpty((yield* reader.daemon.status()).networks);
        assert.include(String(yield* Effect.flip(reader.keys.list())), "Forbidden");
        assert.deepStrictEqual(
          (yield* owner.keys.list()).map(({ name, scope }) => [name, scope]),
          [
            [ownerKey, "admin"],
            ["reader", "read"],
          ]
        );
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );
});
