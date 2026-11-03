#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

import { BunRuntime, BunServices } from "@effect/platform-bun";
import type { Configuration, LogEntry, NetworkSettings, NetworkStatus as Status } from "@iirc/api";
import type { Tuning } from "@iirc/lifecycle/tuning";
import { testAuthority } from "@iirc/session/testing";
import type { Certificate } from "@iirc/session/testing";
import {
  Cause,
  Console,
  Data,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Ref,
  Result,
  Schedule,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  appRoot,
  createKey,
  freePort,
  healthyClient,
  logTail,
  networkStatus,
  settingsFor,
  startBinary,
} from "./binary.ts";
import type { Client, TestNetwork } from "./binary.ts";
import {
  configurationToToml,
  describeIssue,
  parseConfigurationFile,
} from "./configuration-file.ts";

// Proves steps 3 and 4 on a real Ircd: private ngircds started here, each on a loopback port of
// its own, driven only through the built binary, its API, signals, and raw IRC clients. It
// never touches the ngircd anyone else is using. Every process is started by exact PID, in
// a Scope that takes it down again on success, failure, or interrupt, and every temporary
// file goes with the Scope too.

const binary = `${appRoot}/dist/iirc`;

// Where this machine keeps ngircd. Set `IIRC_NGIRCD` to use another.
const ngircd = process.env.IIRC_NGIRCD ?? path.join(homedir(), ".local/opt/ngircd/ngircd");

const serverName = "floor.proof.test";
const password = "opensesame";
const nickLength = 16;
const loopback = "127.0.0.1";

const floor = "#floor";
const kicked = "#kick";
const flood = "#flood";

const network = "floor";
const quitReason = "floor proof says goodbye";

// Past `registrationTimeoutMillis`, because a Connection may come up inside an outage.
const settleLimit = "30 seconds";
const checkLimit = "120 seconds";
const pollEvery = "20 millis";

// How far a time on the wire or in the Log may stray from what was asked for: one turn of
// a busy event loop on a machine doing other things.
const slackMillis = 400;

// Quick to react, so the proof is mostly about what ngircd does, and not about waiting.
const brisk: Partial<Tuning> = {
  drainMillis: 300,
  quitWaitMillis: 1000,
  reconnectInitialMillis: 300,
  reconnectMaxMillis: 1500,
};

class ProofFailed extends Data.TaggedError("ProofFailed")<{ readonly reason: string }> {
  // So that a failure the runtime logs says what it was.
  override get message() {
    return this.reason;
  }
}

/** A check that could not run here, and says why rather than pass for one that did. */
class Skipped extends Data.TaggedClass("Skipped")<{ readonly reason: string }> {}

type FloorServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Scope.Scope;

/** One check: what it observed, if all was as it should be. */
type Check = Effect.Effect<string | Skipped, ProofFailed, FloorServices>;

// Anything else going wrong fails the check the same way, and says what it was.
const toCheck = <E>(proof: Effect.Effect<string | Skipped, E, FloorServices>): Check =>
  Effect.mapError(proof, (error) =>
    error instanceof ProofFailed ? error : new ProofFailed({ reason: String(error) })
  );

const ensure = (condition: boolean, reason: string) =>
  condition ? Effect.void : Effect.fail(new ProofFailed({ reason }));

const waitFor = <A, E, R>(
  what: string,
  check: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  limit: Duration.Input = settleLimit
) =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced(pollEvery), until: done }),
    Effect.timeoutOrElse({
      duration: limit,
      orElse: () => Effect.fail(new ProofFailed({ reason: `timed out waiting for ${what}` })),
    })
  );

const signalPid = (pid: number, signal: NodeJS.Signals) =>
  Effect.sync(() => {
    process.kill(pid, signal);
  });

/** One private ngircd, restartable on the same port, which speaks TLS too if given a key. */
const floorIrcd = Effect.fnUntraced(function* (
  options: { readonly password?: string; readonly tls?: Certificate } = {}
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "iirc-floor-ircd-" });
  const port = yield* freePort;
  const tlsPort = options.tls === undefined ? undefined : yield* freePort;
  const config = path.join(directory, "ngircd.conf");
  const certFile = path.join(directory, "cert.pem");
  const keyFile = path.join(directory, "key.pem");
  const logged = yield* Ref.make("");

  if (options.tls !== undefined) {
    yield* fileSystem.writeFileString(certFile, options.tls.cert);
    yield* fileSystem.writeFileString(keyFile, options.tls.key);
  }

  yield* fileSystem.writeFileString(
    config,
    [
      "[Global]",
      `Name = ${serverName}`,
      "Info = iirc floor proof",
      `Listen = ${loopback}`,
      `Ports = ${port}`,
      ...(options.password === undefined ? [] : [`Password = ${options.password}`]),
      "AdminInfo1 = iirc floor proof",
      "AdminInfo2 = loopback only",
      "AdminEMail = nobody@floor.proof.test",
      'MotdPhrase = "floor proof"',
      "[Limits]",
      "MaxConnectionsIP = 0",
      `MaxNickLength = ${nickLength}`,
      "[Options]",
      "DNS = no",
      "Ident = no",
      "PAM = no",
      ...(tlsPort === undefined
        ? []
        : ["[SSL]", `CertFile = ${certFile}`, `KeyFile = ${keyFile}`, `Ports = ${tlsPort}`]),
      "",
    ].join("\n")
  );

  const configCode = yield* spawner.exitCode(
    ChildProcess.make(ngircd, ["--configtest", "--config", config], {
      cwd: directory,
      stdin: "ignore",
    })
  );

  yield* ensure(Number(configCode) === 0, `ngircd refused its configuration: exit ${configCode}`);

  const start = Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make(ngircd, ["--nodaemon", "--config", config], {
        cwd: directory,
        // Takes a stopped process too, which SIGTERM would leave waiting for ever.
        killSignal: "SIGKILL",
        stdin: "ignore",
      })
    );

    const before = (yield* Ref.get(logged)).length;

    yield* child.all.pipe(
      Stream.decodeText(),
      Stream.runForEach((text) => Ref.update(logged, (held) => `${held}${text}`)),
      Effect.ignore,
      Effect.forkScoped
    );

    yield* waitFor("ngircd to listen", Ref.get(logged), (text) =>
      text.slice(before).includes(`Server "${serverName}"`)
    );

    return child;
  });

  const started = yield* Ref.make(yield* start);

  const accepted = Effect.map(
    Ref.get(logged),
    (text) => text.match(/Accepted connection/gu)?.length ?? 0
  );

  return {
    /** How many Connections ngircd itself says reached it, in its own log. */
    accepted,
    kill: Effect.gen(function* () {
      const child = yield* Ref.get(started);

      yield* signalPid(child.pid, "SIGKILL");
      yield* Effect.ignore(child.exitCode);
    }),
    /** What ngircd has written to its log so far. */
    logged: Ref.get(logged),
    pause: Effect.flatMap(Ref.get(started), ({ pid }) => signalPid(pid, "SIGSTOP")),
    port,
    restart: start.pipe(Effect.flatMap((child) => Ref.set(started, child))),
    resume: Effect.flatMap(Ref.get(started), ({ pid }) => signalPid(pid, "SIGCONT")),
    tlsPort,
  };
});

interface Heard {
  readonly at: number;
  readonly text: string;
}

/** A plain IRC client, for what the API cannot do yet. Answers `PING`, and does no more. */
const rawClient = Effect.fnUntraced(function* (port: number) {
  const heard: Heard[] = [];

  const socket = yield* Effect.acquireRelease(
    Effect.callback<Socket, ProofFailed>((resume) => {
      const opening = connect({ host: loopback, port });

      opening.once("connect", () => {
        resume(Effect.succeed(opening));
      });
      opening.once("error", (cause) => {
        resume(Effect.fail(new ProofFailed({ reason: `raw client: ${cause.message}` })));
      });
    }),
    (open) =>
      Effect.sync(() => {
        open.destroy();
      })
  );

  let pending = "";

  const send = (line: string) =>
    Effect.sync(() => {
      socket.write(`${line}\r\n`);
    });

  socket.on("error", () => {
    // Going is fine, and is what a killed ngircd does.
  });

  socket.on("data", (data) => {
    const lines = `${pending}${data.toString("latin1")}`.split("\r\n");

    pending = lines.pop() ?? "";

    for (const text of lines) {
      heard.push({ at: Date.now(), text });

      if (text.startsWith("PING ")) {
        socket.write(`PONG ${text.slice("PING ".length)}\r\n`);
      }
    }
  });

  // Only what arrived after `from`, which `mark` gave, so that an old Line cannot answer
  // for a new one.
  const until = (what: string, match: (text: string) => boolean, from = 0) =>
    waitFor(
      what,
      Effect.sync(() => heard.slice(from).find(({ text }) => match(text))),
      (found) => found !== undefined
    ).pipe(
      Effect.filterOrFail(
        (found) => found !== undefined,
        () => new ProofFailed({ reason: `nothing heard for ${what}` })
      )
    );

  return {
    heard: () => [...heard],
    mark: () => heard.length,
    send,
    until,
  };
});

const registeredClient = Effect.fnUntraced(function* (port: number, nick: string, pass?: string) {
  const client = yield* rawClient(port);

  if (pass !== undefined) {
    yield* client.send(`PASS ${pass}`);
  }

  yield* client.send(`NICK ${nick}`);
  yield* client.send("USER raw 0 * :raw client");
  yield* client.until(`${nick} to register`, (text) => text.includes(` 001 ${nick} `));

  return client;
});

/** A registered raw client in a Channel, which sees whatever happens there. */
const watcherIn = Effect.fnUntraced(function* (
  port: number,
  nick: string,
  channel: string,
  pass?: string
) {
  const client = yield* registeredClient(port, nick, pass);

  yield* client.send(`JOIN ${channel}`);
  yield* client.until(`${nick} in ${channel}`, (text) => text.includes(` 366 ${nick} ${channel}`));

  return client;
});

// What a raw client sees a nick do, as ngircd relays it: a command from that nick, then
// its parameters, the last of them after a colon.
const isFrom = (nick: string, command: string, rest: string) => (text: string) =>
  text.startsWith(`:${nick}!`) && text.includes(` ${command} `) && text.endsWith(rest);

// ngircd puts a `QUIT` reason in quotes of its own.
const isQuit = (nick: string) => isFrom(nick, "QUIT", `:"${quitReason}"`);

/** A data directory, and the key `iirc key create` made there before any Daemon ran. */
interface Home {
  readonly dataDir: string;
  readonly key: string;
}

// On real disk, because `/tmp` is tmpfs on fserv, where fsync means nothing.
const dataDirs = path.join(appRoot, "../../.cache/floor-proof");

const newDataDir = FileSystem.FileSystem.pipe(
  Effect.tap((fileSystem) => fileSystem.makeDirectory(dataDirs, { recursive: true })),
  Effect.flatMap((fileSystem) =>
    fileSystem.makeTempDirectoryScoped({ directory: dataDirs, prefix: "iirc-floor-" })
  )
);

// AUTH-4: the first key needs the data directory to itself, so it comes before the Daemon.
const newHome = Effect.gen(function* () {
  const dataDir = yield* newDataDir;

  return { dataDir, key: yield* createKey(binary, dataDir) } satisfies Home;
});

const pageSize = 1000;

const allEntries = (client: Client, id?: string) =>
  Effect.gen(function* () {
    const all: LogEntry[] = [];
    let page: readonly LogEntry[] = [];

    do {
      page = yield* client.daemon.entries({
        query: {
          after: all.at(-1)?.sequence ?? 0,
          limit: pageSize,
          ...(id !== undefined && { network: id }),
        },
      });
      all.push(...page);
    } while (page.length === pageSize);

    return all;
  });

/**
 * Runs `iirc daemon` on a home, which takes only a data directory and a listen address
 * (CONF-4), and waits for its API. Whatever Networks the Log already holds come back.
 * @param home - Where the Log is, and the key made there.
 * @returns The Daemon, and ways to ask it about one Network.
 */
const runDaemon = Effect.fnUntraced(function* (home: Home) {
  const httpPort = yield* freePort;

  const running = yield* startBinary(
    binary,
    ["daemon", "--data-dir", home.dataDir, "--http-port", String(httpPort)],
    {}
  );

  // A binary that cannot start says why, rather than leave this waiting for its API.
  const client = yield* Effect.raceFirst(
    healthyClient(httpPort, home.key),
    running.child.exitCode.pipe(
      Effect.flatMap((code) =>
        Effect.fail(
          new ProofFailed({ reason: `the Daemon exited with ${code}:\n${running.output()}` })
        )
      )
    )
  );

  return {
    apiUrl: `http://${loopback}:${httpPort}`,
    client,
    entriesOf: (id: string) => allEntries(client, id),
    home,
    pid: running.child.pid,
    running,
    sayOn: (id: string, target: string, text: string) =>
      client.daemon.send({ payload: { network: id, target, text } }),
    statusOf: (id: string) => networkStatus(client, id),
  };
});

type Running = Effect.Success<ReturnType<typeof runDaemon>>;

// One Network on a private ngircd, with the proof's quit reason and brisk Tuning.
const floorNetwork = (
  options: Omit<TestNetwork, "host" | "quitReason"> & { readonly host?: string }
): NetworkSettings =>
  settingsFor({
    host: loopback,
    quitReason,
    ...options,
    tuning: { ...brisk, ...options.tuning },
  });

const addNetwork = (running: Running, settings: NetworkSettings) =>
  running.client.networks.add({ payload: settings });

/** What step 2's flags said, which the checks that came from it still say. */
interface Identity {
  readonly alternates?: readonly string[];
  readonly channels: readonly string[];
  readonly home: Home;
  readonly nick: string;
  readonly port: number;
  readonly tuning?: Partial<Tuning>;
}

// Adds the Network through the API unless an earlier run on this Log already has, since
// Configuration outlives a restart.
const startDaemon = Effect.fnUntraced(function* ({ home, ...identity }: Identity) {
  const running = yield* runDaemon(home);
  const configured = yield* running.client.networks.list();

  if (!configured.some(({ settings }) => settings.id === network)) {
    yield* addNetwork(running, floorNetwork({ ...identity, id: network }));
  }

  return {
    ...running,
    daemon: running.client.daemon,
    entries: allEntries(running.client),
    say: (target: string, text: string) => running.sayOn(network, target, text),
    status: running.statusOf(network),
  };
});

type Daemon = Effect.Success<ReturnType<typeof startDaemon>>;

const stopDaemon = (running: Running, signal: NodeJS.Signals = "SIGTERM") =>
  Effect.gen(function* () {
    const stopping = Date.now();

    yield* signalPid(running.pid, signal);

    const code = yield* Effect.exit(running.running.child.exitCode);

    return { code: Exit.isSuccess(code) ? Number(code.value) : -1, millis: Date.now() - stopping };
  });

const untilJoined = <E, R>(status: Effect.Effect<Status, E, R>, channel: string) =>
  waitFor(`${channel} to be joined`, status, ({ joined, phase }) => {
    const isIn = joined.includes(channel);

    return phase === "session" && isIn;
  });

const untilInChannel = (running: Daemon, channel: string) => untilJoined(running.status, channel);

const untilHeard = (running: Daemon, sender: string, text: string) =>
  waitFor(
    `${text} to arrive`,
    running.daemon.messages({ query: { after: 0, limit: pageSize } }),
    (messages) => messages.some((said) => said.sender === sender && said.text === text)
  );

const connectionEntries = (entries: readonly LogEntry[]) =>
  entries.flatMap((entry) => (entry._tag === "Connection" ? [entry] : []));

const lineEntries = (entries: readonly LogEntry[]) =>
  entries.flatMap((entry) => (entry._tag === "Line" ? [entry] : []));

const changeEntries = (entries: readonly LogEntry[]) =>
  entries.flatMap((entry) => (entry._tag === "Change" ? [entry] : []));

const attempts = (entries: readonly LogEntry[]) =>
  connectionEntries(entries).flatMap((entry) => (entry.phase === "attempt" ? [entry] : []));

const closes = (entries: readonly LogEntry[]) =>
  connectionEntries(entries).flatMap((entry) => (entry.phase === "closed" ? [entry] : []));

const joinsOf = (entries: readonly LogEntry[], after: number) =>
  lineEntries(entries).filter(
    ({ direction, sequence, text }) =>
      direction === "outbound" && sequence > after && text.startsWith("JOIN ")
  );

const isOut = ({ phase }: Status) => phase !== "session";

const isRefused = ({ nextAttemptAt, refused }: Status) => refused && nextAttemptAt !== null;

// The first Connection, then this many failed redials while the Ircd is down.
const hasRedialed = (times: number) => (entries: readonly LogEntry[]) =>
  attempts(entries).length > times + 1;

// LIVE-4: each wait from a close to the next `attempt` falls in the upper half of the delay
// for that many failures in a row, doubling from the first to the longest. The Log stamps
// both ends from one clock, so the lower bound is exact and only the upper needs slack.
const backoffFaults = (entries: readonly LogEntry[], tuning: Partial<Tuning>) => {
  const initial = tuning.reconnectInitialMillis ?? 0;
  const longest = tuning.reconnectMaxMillis ?? 0;

  const ends = connectionEntries(entries).filter(
    ({ phase }) => phase === "closed" || phase === "attempt"
  );

  return ends.flatMap((entry, index) => {
    const next = ends[index + 1];
    const failures = ends.slice(0, index + 1).filter(({ phase }) => phase === "closed").length;

    if (entry.phase !== "closed" || next?.phase !== "attempt") {
      return [];
    }

    const delay = Math.min(initial * 2 ** (failures - 1), longest);
    const waited = next.at - entry.at;

    return waited >= Math.ceil(delay / 2) && waited <= delay + slackMillis
      ? []
      : [`after failure ${failures} it waited ${waited} ms, against ${delay / 2} to ${delay} ms`];
  });
};

const latestGap = (running: Daemon) =>
  Effect.map(running.daemon.gaps({ query: { after: 0, limit: 10 } }), (gaps) => gaps.at(-1));

// LIVE-4, LIVE-6, LIVE-7, LIVE-10
const reconnect = toCheck(
  Effect.gen(function* () {
    const ircd = yield* floorIrcd();
    const channels = [floor];

    const a = yield* startDaemon({
      channels,
      home: yield* newHome,
      nick: "floora",
      port: ircd.port,
    });

    const b = yield* startDaemon({
      channels,
      home: yield* newHome,
      nick: "floorb",
      port: ircd.port,
    });

    yield* untilInChannel(a, floor);
    yield* untilInChannel(b, floor);
    yield* a.say(floor, "before the kill");
    yield* untilHeard(b, "floora", "before the kill");

    yield* ircd.kill;

    yield* waitFor("A to notice", a.status, isOut);
    yield* waitFor("B to notice", b.status, isOut);

    // Long enough for each to be refused by a port with nothing on it, and back off as far
    // as delays that no busy event loop could pass for.
    yield* waitFor("A to redial and fail", a.entries, hasRedialed(3));
    yield* waitFor("B to redial and fail", b.entries, hasRedialed(3));

    yield* ircd.restart;

    yield* untilInChannel(a, floor);
    yield* untilInChannel(b, floor);
    yield* a.say(floor, "after A");
    yield* b.say(floor, "after B");
    yield* untilHeard(b, "floora", "after A");
    yield* untilHeard(a, "floorb", "after B");

    const gapA = yield* latestGap(a);
    const gapB = yield* latestGap(b);

    yield* ensure(gapA?.ended !== undefined, "A shows no closed Gap");
    yield* ensure(gapB?.ended !== undefined, "B shows no closed Gap");

    const waitsA = backoffFaults(yield* a.entries, brisk);
    const waitsB = backoffFaults(yield* b.entries, brisk);

    yield* ensure(waitsA.length === 0, `A did not back off: ${waitsA.join("; ")}`);
    yield* ensure(waitsB.length === 0, `B did not back off: ${waitsB.join("; ")}`);

    const lengthOf = (gap: typeof gapA) => (gap?.ended?.at ?? 0) - (gap?.at ?? 0);

    return (
      `A rejoined after a ${lengthOf(gapA)} ms Gap ("${gapA?.reason}"), B after a ` +
      `${lengthOf(gapB)} ms Gap, each backing off by doubling waits, and each heard the other again`
    );
  })
);

// LIVE-2
const silence = toCheck(
  Effect.gen(function* () {
    const silenceMillis = 1500;
    const ircd = yield* floorIrcd();

    const running = yield* startDaemon({
      channels: [floor],
      home: yield* newHome,
      nick: "floors",
      port: ircd.port,
      // Short enough that a dial into a stopped process gives up inside the check.
      tuning: { lagCheckMillis: 400, registrationTimeoutMillis: 2000, silenceMillis },
    });

    yield* untilInChannel(running, floor);

    yield* ircd.pause;

    const paused = Date.now();

    const entries = yield* waitFor(
      "the silence limit",
      running.entries,
      (all) => closes(all).length === 1
    );

    const [closed] = closes(entries);
    const lastHeard = lineEntries(entries).findLast(({ direction }) => direction === "inbound");
    const heardFor = (closed?.at ?? 0) - (lastHeard?.at ?? 0);

    const deadlines = entries.flatMap((entry) =>
      entry._tag === "Deadline" && entry.name === "silence" ? [entry] : []
    );

    yield* ensure(deadlines.length === 1, "no Deadline Entry says why it gave up");
    yield* ensure(closed?.reason === "heard nothing for 1.5 seconds", `closed: ${closed?.reason}`);
    yield* ensure(heardFor >= silenceMillis, `gave up after only ${heardFor} ms`);
    yield* ensure(heardFor <= silenceMillis + slackMillis, `gave up only after ${heardFor} ms`);

    const noticed = (closed?.at ?? 0) - paused;

    yield* ensure(noticed <= silenceMillis + slackMillis, `noticed only after ${noticed} ms`);

    // Long enough for it to redial into a process that accepts in the kernel and says nothing.
    yield* waitFor(
      "a dial into the stopped Ircd",
      running.entries,
      (all) => attempts(all).length > 1
    );

    yield* ircd.resume;

    const recovered = yield* untilInChannel(running, floor);

    return (
      `declared dead ${heardFor} ms after the last Line (limit ${silenceMillis} ms), ` +
      `"${closed?.reason}", and back in ${floor} as ${recovered.self} after SIGCONT`
    );
  })
);

// LIVE-5
const refusal = toCheck(
  Effect.gen(function* () {
    const refusalBackoffMillis = 6000;
    const nick = "floorr";
    const ircd = yield* floorIrcd({ password });

    const refusedAs = Effect.fnUntraced(function* (lines: readonly string[]) {
      const client = yield* rawClient(ircd.port);

      yield* Effect.forEach(lines, client.send, { discard: true });

      return yield* Effect.map(
        client.until("a refusal", (text) => text.startsWith("ERROR ")),
        ({ text }) => text
      );
    });

    const register = [`NICK ${nick}`, "USER iirc 0 * :iirc"];
    const withoutPass = yield* refusedAs(register);
    const withWrongPass = yield* refusedAs(["PASS not-the-password", ...register]);

    yield* ensure(withoutPass === withWrongPass, `ngircd answered: ${withWrongPass}`);

    const verbatim = withoutPass.replace(/^ERROR :/u, "");
    const home = yield* newHome;

    const identity = {
      channels: [floor],
      home,
      nick,
      port: ircd.port,
      tuning: { refusalBackoffMillis },
    };

    const first = yield* startDaemon(identity);
    const status = yield* waitFor("the refusal", first.status, isRefused);
    const entries = yield* first.entries;
    const [closed] = closes(entries);

    yield* ensure(status.refusal === verbatim, `status says: ${status.refusal}`);
    yield* ensure(closed?.phase === "closed" && closed.refused === true, "`closed` is no refusal");
    yield* ensure(
      status.nextAttemptAt === (closed?.at ?? 0) + refusalBackoffMillis,
      `next attempt ${status.nextAttemptAt}, closed at ${closed?.at}`
    );

    const stopped = yield* stopDaemon(first);

    yield* ensure(stopped.code === 0, `SIGTERM during the wait gave exit ${stopped.code}`);

    const reached = yield* ircd.accepted;

    yield* ensure(reached === 3, `ngircd's log shows ${reached} Connections, not 3`);

    // Restarts with the wait still running, one after a clean stop and one after a kill.
    const second = yield* startDaemon(identity);
    const secondStatus = yield* waitFor("the refusal again", second.status, isRefused);

    yield* stopDaemon(second, "SIGKILL");

    const third = yield* startDaemon(identity);
    const thirdStatus = yield* waitFor("the refusal again", third.status, isRefused);

    yield* ensure(secondStatus.refusal === verbatim, `after a stop: ${secondStatus.refusal}`);
    yield* ensure(thirdStatus.refusal === verbatim, `after a kill: ${thirdStatus.refusal}`);
    yield* ensure(
      secondStatus.nextAttemptAt === status.nextAttemptAt &&
        thirdStatus.nextAttemptAt === status.nextAttemptAt,
      "a restart moved the wait"
    );

    const waited = (status.nextAttemptAt ?? 0) - Date.now();

    yield* ensure(waited > 0, "this check took too long to prove anything");
    yield* Effect.sleep(Duration.millis(Math.max(waited - slackMillis, 0)));

    const during = yield* ircd.accepted;

    yield* ensure(during === reached, `ngircd saw ${during - reached} dials during the wait`);

    const after = yield* waitFor(
      "the wait to end",
      third.entries,
      (all) => attempts(all).length > 1
    );

    const redial = attempts(after).at(-1)?.at ?? 0;

    yield* ensure(redial >= (status.nextAttemptAt ?? 0), "it dialed before the wait was over");

    return `ngircd said ${JSON.stringify(withoutPass)}, status showed it verbatim, and two restarts dialed nothing for the ${refusalBackoffMillis} ms wait`;
  })
);

// CONN-3, CONN-4
const nickFallback = toCheck(
  Effect.gen(function* () {
    const taken = "floorn";
    const alternate = "floorn2";
    const fallback = "floorn3";
    const padded = "floorfull";
    const ircd = yield* floorIrcd();

    const holder = yield* startDaemon({
      channels: [],
      home: yield* newHome,
      nick: taken,
      port: ircd.port,
    });

    yield* waitFor("the holder", holder.status, ({ phase }) => phase === "session");

    const alternateHolder = yield* registeredClient(ircd.port, alternate);

    yield* ensure(alternateHolder.heard().length > 0, "the raw client registered with nothing");

    const second = yield* startDaemon({
      alternates: [alternate, fallback],
      channels: [],
      home: yield* newHome,
      nick: taken,
      port: ircd.port,
    });

    const status = yield* waitFor("a nick", second.status, ({ phase }) => phase === "session");
    const entries = yield* second.entries;
    const rejections = lineEntries(entries).filter(({ text }) => text.includes(" 433 "));

    const tried = lineEntries(entries).filter(
      ({ cause, direction, text }) =>
        direction === "outbound" && (cause === "nick-fallback" || text.startsWith("NICK "))
    );

    yield* ensure(status.self === fallback, `ended up as ${status.self}`);
    yield* ensure(rejections.length === 2, `saw ${rejections.length} real 433s`);
    yield* ensure(
      tried.map(({ text }) => text).join(",") ===
        `NICK ${taken},NICK ${alternate},NICK ${fallback}`,
      `tried ${tried.map(({ text }) => text).join(",")}`
    );

    // NICKLEN: learned in one Session, and spent on a nick the first could not have tried.
    const home = yield* newHome;
    const identity = { channels: [], home, nick: padded, port: ircd.port };
    const learner = yield* startDaemon(identity);

    yield* waitFor("the learner", learner.status, ({ self }) => self === padded);
    yield* waitFor("its burst", learner.entries, (all) =>
      lineEntries(all).some(({ text }) => text.includes(`NICKLEN=${nickLength}`))
    );

    const firstNicks = attempts(yield* learner.entries).at(0)?.nicks ?? [];
    const firstContact = 9;

    yield* ensure(
      firstNicks.every((nick) => nick.length <= firstContact),
      `first contact tried past 9: ${firstNicks.join(",")}`
    );

    yield* stopDaemon(learner);
    yield* registeredClient(ircd.port, padded);

    const returning = yield* startDaemon(identity);

    const back = yield* waitFor(
      "a longer nick",
      returning.status,
      ({ phase }) => phase === "session"
    );

    const secondNicks = attempts(yield* returning.entries).at(-1)?.nicks ?? [];

    yield* ensure(
      secondNicks.some((nick) => nick.length === nickLength),
      "NICKLEN was not used"
    );
    yield* ensure((back.self?.length ?? 0) > firstContact, `came back as ${back.self}`);

    const welcome = lineEntries(entries).find(({ text }) => text.includes(" 001 "));
    const registeredAfter = (welcome?.at ?? 0) - (tried[0]?.at ?? 0);

    return (
      `${status.self} after two real 433s (${rejections[0]?.text}), welcomed ${registeredAfter} ms ` +
      `after the first NICK, and with NICKLEN=${nickLength} remembered, ${back.self} ` +
      `(${back.self?.length} bytes, past the first-contact 9)`
    );
  })
);

// LIVE-8
const kick = toCheck(
  Effect.gen(function* () {
    const ircd = yield* floorIrcd();
    const operator = yield* registeredClient(ircd.port, "floorop");

    // First in the Channel, so ngircd makes it the Channel operator.
    yield* operator.send(`JOIN ${kicked}`);
    yield* operator.until("the operator's names", (text) => text.includes(":@floorop"));

    const channels = [floor, kicked];
    const home = yield* newHome;

    // Short, so that a kick which failed to block would show as a rejoin inside the check.
    const kickRejoinMillis = 500;
    const outlasted = Duration.millis(kickRejoinMillis + 4 * slackMillis);

    const victim = yield* startDaemon({
      channels,
      home,
      nick: "floorv",
      port: ircd.port,
      tuning: { kickRejoinMillis },
    });

    const witness = yield* startDaemon({
      channels,
      home: yield* newHome,
      nick: "floorw",
      port: ircd.port,
    });

    yield* untilInChannel(victim, kicked);
    yield* untilInChannel(witness, kicked);

    yield* operator.send(`KICK ${kicked} floorv :out you go`);

    const afterKick = yield* waitFor(
      "the kick",
      victim.status,
      (status) => status.kicked.length === 1
    );

    yield* ensure(
      !afterKick.joined.includes(kicked),
      `still joined: ${afterKick.joined.join(",")}`
    );

    const entries = yield* victim.entries;
    const kickLine = lineEntries(entries).findLast(({ text }) => text.includes(" KICK "));

    yield* ensure(kickLine?.text.includes("floorop") === true, `kicked by: ${kickLine?.text}`);

    // Past the rejoin wait, so a kick that did not block would have gone back by now.
    yield* Effect.sleep(outlasted);

    const sameSession = joinsOf(yield* victim.entries, kickLine?.sequence ?? 0);

    yield* ensure(
      sameSession.every(({ text }) => !text.includes(kicked)),
      `it went back in the same Session: ${sameSession.map(({ text }) => text).join(",")}`
    );

    yield* ircd.kill;
    yield* waitFor("the Connection to end", victim.status, ({ phase }) => phase !== "session");
    yield* ircd.restart;

    // Nothing stops the witness going back to the same Channel, which shows it could be done.
    yield* untilInChannel(witness, kicked);

    yield* untilInChannel(victim, floor);
    yield* Effect.sleep(outlasted);

    const after = yield* victim.status;
    const later = yield* victim.entries;
    const rejoins = joinsOf(later, kickLine?.sequence ?? 0);

    yield* ensure(rejoins.length > 0, "the victim never rejoined anything");
    yield* ensure(
      rejoins.every(({ text }) => !text.includes(kicked)),
      `it went back: ${rejoins.map(({ text }) => text).join(",")}`
    );
    yield* ensure(
      !after.joined.includes(kicked) && after.kicked.some(({ channel }) => channel === kicked),
      `status after the reconnect: ${JSON.stringify(after.kicked)}`
    );

    return (
      `${kickLine?.text}; across a reconnect it sent only "${rejoins.at(-1)?.text}", ` +
      `while a Daemon not kicked rejoined ${kicked}`
    );
  })
);

// LIVE-3
const lag = toCheck(
  Effect.gen(function* () {
    const lagCheckMillis = 600;
    const pausedMillis = 1000;
    const idleMillis = 100;
    const ircd = yield* floorIrcd();

    const running = yield* startDaemon({
      channels: [],
      home: yield* newHome,
      nick: "floorl",
      port: ircd.port,
      tuning: { lagCheckMillis, silenceMillis: 60_000 },
    });

    // ngircd holds a new client's first commands back as a penalty, which is real lag too,
    // so this waits for it to settle and the two below can be told apart.
    const measured = yield* waitFor(
      "an idle measurement",
      running.status,
      ({ lagMillis }) => lagMillis !== null && lagMillis < idleMillis
    );

    const pongsIn = (entries: readonly LogEntry[]) =>
      lineEntries(entries).filter(
        ({ direction, text }) => direction === "inbound" && text.includes(" PONG ")
      );

    const answered = pongsIn(yield* running.entries).length;

    // Straight after an answer, so that one check goes out inside this pause, and the Ircd
    // really does hold up its round trip. The next one is the only thing that overwrites it.
    yield* waitFor("a fresh answer", running.entries, (all) => pongsIn(all).length > answered);
    yield* ircd.pause;
    yield* Effect.sleep(Duration.millis(pausedMillis));
    yield* ircd.resume;

    const shortest = pausedMillis - lagCheckMillis - slackMillis / 2;

    const held = yield* waitFor(
      "a slow round trip",
      running.status,
      ({ lagMillis }) => (lagMillis ?? 0) >= shortest
    );

    const entries = yield* running.entries;

    const checks = lineEntries(entries).filter(
      ({ cause, direction }) => direction === "outbound" && cause === "lag-check"
    );

    const pongs = pongsIn(entries);

    yield* ensure(checks.length > 1, "no lag checks went out");
    yield* ensure(pongs.length > 1, "no `PONG` came back");

    return (
      `${measured.lagMillis} ms on an idle ngircd, ${held.lagMillis} ms with it held up, ` +
      `from ${checks.length} checks ("${checks[0]?.text}" answered by "${pongs[0]?.text}")`
    );
  })
);

// SEND-2
const floodControl = toCheck(
  Effect.gen(function* () {
    const floodBurst = 2;
    const floodIntervalMillis = 500;
    const burstSize = 8;
    const ircd = yield* floorIrcd();
    const listener = yield* registeredClient(ircd.port, "floorobs");

    yield* listener.send(`JOIN ${flood}`);
    yield* listener.until("the listener's names", (text) =>
      text.includes(` 366 floorobs ${flood}`)
    );

    const running = yield* startDaemon({
      channels: [flood],
      home: yield* newHome,
      nick: "floorf",
      port: ircd.port,
      tuning: { floodBurst, floodIntervalMillis, lagCheckMillis: 60_000, sendWaitMillis: 20_000 },
    });

    yield* untilInChannel(running, flood);

    // The `JOIN` spent a token, and this gives it back.
    yield* Effect.sleep(Duration.millis(floodBurst * floodIntervalMillis));

    const texts = Array.from({ length: burstSize }, (_unused, index) => `burst ${index}`);

    const sends = yield* Effect.forEach(texts, (text) => running.say(flood, text), {
      concurrency: "unbounded",
    });

    yield* ensure(
      sends.every(({ status }) => status === "written"),
      `sends came to ${JSON.stringify(sends)}`
    );

    const isBurst = ({ text }: Heard) => text.includes(`PRIVMSG ${flood} :burst `);

    const arrived = yield* waitFor(
      "the burst to arrive",
      Effect.sync(() => listener.heard().filter(isBurst)),
      (heard) => heard.length === burstSize
    );

    const first = arrived[0]?.at ?? 0;
    const offsets = arrived.map(({ at }) => at - first);

    for (const [index, offset] of offsets.entries()) {
      const earliest = Math.max(index - floodBurst + 1, 0) * floodIntervalMillis;

      yield* ensure(
        offset >= earliest - slackMillis,
        `Line ${index + 1} of ${burstSize} arrived after ${offset} ms, before ${earliest} ms`
      );
    }

    const spent = offsets.at(-1) ?? 0;
    const expected = (burstSize - floodBurst) * floodIntervalMillis;

    yield* ensure(
      spent <= expected + floodIntervalMillis + slackMillis,
      `${burstSize} Lines took ${spent} ms at a rate that needs ${expected} ms`
    );

    return `${burstSize} sends at once reached a listener at ${offsets.join(", ")} ms, against a burst of ${floodBurst} then ${floodIntervalMillis} ms each`;
  })
);

// LIVE-9
const stop = toCheck(
  Effect.gen(function* () {
    const ircd = yield* floorIrcd();
    const channels = [floor];
    const home = yield* newHome;
    const leaver = yield* startDaemon({ channels, home, nick: "floorq", port: ircd.port });

    const stayer = yield* startDaemon({
      channels,
      home: yield* newHome,
      nick: "floort",
      port: ircd.port,
    });

    yield* untilInChannel(leaver, floor);
    yield* untilInChannel(stayer, floor);

    const { code, millis } = yield* stopDaemon(leaver);

    yield* ensure(code === 0, `SIGTERM gave exit ${code}`);
    yield* ensure(millis <= (brisk.quitWaitMillis ?? 0) + 1000, `stopping took ${millis} ms`);

    const entries = yield* waitFor("the QUIT to reach the other Daemon", stayer.entries, (all) =>
      lineEntries(all).some(({ text }) => text.includes(" QUIT "))
    );

    const quit = lineEntries(entries).find(({ text }) => text.includes(" QUIT "));

    yield* ensure(quit?.text.includes(quitReason) === true, `it saw: ${quit?.text}`);

    // ngircd says goodbye between these, with a `NOTICE` and an `ERROR` of its own.
    const tail = yield* logTail(home.dataDir, 8);
    const closing = tail.indexOf("Connection closing");

    yield* ensure(
      closing !== -1 &&
        tail[closing + 1] === `QUIT :${quitReason}` &&
        tail.at(-2) === "Connection closed" &&
        tail.at(-1) === "Daemon stopped",
      `the Log ends: ${tail.join(" | ")}`
    );

    return `exit 0 in ${millis} ms, the other Daemon's Log has ${JSON.stringify(quit?.text)}, and this one ends in closed then stopped`;
  })
);

// HOST-5, CONF-3
const twoNetworks = toCheck(
  Effect.gen(function* () {
    const failing = yield* floorIrcd();
    const steady = yield* floorIrcd();
    const listener = yield* watcherIn(steady.port, "floorlb", floor);
    const running = yield* runDaemon(yield* newHome);

    yield* addNetwork(
      running,
      floorNetwork({ channels: [floor], id: "alpha", nick: "floora", port: failing.port })
    );
    yield* addNetwork(
      running,
      floorNetwork({ channels: [floor], id: "beta", nick: "floorb", port: steady.port })
    );

    yield* untilJoined(running.statusOf("alpha"), floor);
    yield* untilJoined(running.statusOf("beta"), floor);

    const gapsBefore = yield* running.client.daemon.gaps({
      query: { after: 0, limit: 10, network: "beta" },
    });

    yield* failing.kill;
    yield* waitFor("alpha to notice", running.statusOf("alpha"), isOut);

    // Each Send waits for the raw client to hear it, and they go on until alpha has failed
    // to redial three times, so every one of them crossed beta during alpha's outage.
    const delivered = yield* Ref.make(0);

    const sendOnBeta = Effect.gen(function* () {
      const count = yield* Ref.getAndUpdate(delivered, (sent) => sent + 1);
      const text = `during the outage ${count}`;

      yield* running.sayOn("beta", floor, text);
      yield* listener.until(`${text} to arrive`, isFrom("floorb", "PRIVMSG", `${floor} :${text}`));

      return yield* running.entriesOf("alpha");
    });

    yield* waitFor("alpha to redial and fail, while beta sends", sendOnBeta, hasRedialed(3));

    const sends = yield* Ref.get(delivered);
    const outage = yield* running.statusOf("alpha");

    yield* ensure(isOut(outage), "alpha came back while its Ircd was down");
    yield* ensure(sends >= 3, `only ${sends} Sends crossed beta during the outage`);

    yield* failing.restart;
    yield* untilJoined(running.statusOf("alpha"), floor);

    const alpha = yield* running.entriesOf("alpha");
    const beta = yield* running.entriesOf("beta");

    const [gapAlpha] = (yield* running.client.daemon.gaps({
      query: { after: 0, limit: 10, network: "alpha" },
    })).slice(-1);

    const gapsAfter = yield* running.client.daemon.gaps({
      query: { after: 0, limit: 10, network: "beta" },
    });

    yield* ensure(gapAlpha?.ended !== undefined, "alpha shows no closed Gap");
    yield* ensure(
      attempts(beta).length === 1 && closes(beta).length === 0,
      `beta's Connections: ${connectionEntries(beta)
        .map(({ phase }) => phase)
        .join(",")}`
    );
    yield* ensure(
      gapsAfter.length === gapsBefore.length,
      `beta has ${gapsAfter.length - gapsBefore.length} new Gaps`
    );

    const waits = backoffFaults(alpha, brisk);

    yield* ensure(waits.length === 0, `alpha did not back off: ${waits.join("; ")}`);

    return (
      `alpha made ${attempts(alpha).length - 1} redials and recorded a ` +
      `${(gapAlpha?.ended?.at ?? 0) - (gapAlpha?.at ?? 0)} ms Gap ("${gapAlpha?.reason}"), ` +
      `while beta kept its one Connection, recorded no Gap, and a raw client heard all ${sends} ` +
      "of its Sends"
    );
  })
);

const join = (running: Running, id: string, channel: string, remember = true) =>
  running.client.networks.join({ params: { id }, payload: { channel, remember } });

// CONF-2, CONF-5
const joinAndPart = toCheck(
  Effect.gen(function* () {
    const kept = "#keep";
    const gone = "#gone";
    const passing = "#passing";
    const nick = "floorj";
    const reason = "parting words";
    const ircd = yield* floorIrcd();
    const watcher = yield* watcherIn(ircd.port, "floorwj", kept);

    yield* watcher.send(`JOIN ${gone},${passing}`);
    yield* watcher.until("the watcher in every Channel", (text) =>
      text.includes(` 366 floorwj ${passing}`)
    );

    const home = yield* newHome;
    const first = yield* runDaemon(home);

    yield* addNetwork(first, floorNetwork({ id: network, nick, port: ircd.port }));
    yield* waitFor("a Session", first.statusOf(network), ({ phase }) => phase === "session");

    yield* join(first, network, kept);
    yield* watcher.until(`${nick} to join ${kept}`, isFrom(nick, "JOIN", kept));

    yield* join(first, network, gone);
    yield* watcher.until(`${nick} to join ${gone}`, isFrom(nick, "JOIN", gone));

    const parted = yield* first.client.networks.part({
      params: { id: network },
      payload: { channel: gone, reason },
    });

    const partLine = yield* watcher.until(
      `${nick} to part ${gone}`,
      isFrom(nick, "PART", `${gone} :${reason}`)
    );

    yield* ensure(parted.line?.status === "written", `the Part came to ${JSON.stringify(parted)}`);

    const passed = yield* join(first, network, passing, false);

    yield* watcher.until(`${nick} to join ${passing}`, isFrom(nick, "JOIN", passing));
    yield* ensure(!("change" in passed), "a Join not to be remembered recorded a Change");

    const before = yield* untilJoined(first.statusOf(network), passing);
    const { settings } = yield* first.client.networks.get({ params: { id: network } });

    yield* ensure(
      settings.channels.map(({ name }) => name).join(",") === kept,
      `Configuration holds ${settings.channels.map(({ name }) => name).join(",")}`
    );

    const stopped = yield* stopDaemon(first);

    yield* ensure(stopped.code === 0, `SIGTERM gave exit ${stopped.code}`);
    yield* watcher.until(`${nick} to quit`, isQuit(nick));

    const restarted = watcher.mark();
    const second = yield* runDaemon(home);
    const startedAt = (yield* second.client.daemon.status()).head ?? 0;

    yield* untilJoined(second.statusOf(network), kept);
    yield* watcher.until(`${nick} to rejoin ${kept}`, isFrom(nick, "JOIN", kept), restarted);

    // A Message after the rejoin comes back through the watcher, which puts everything the
    // Daemon sent before it in front of the check below.
    yield* second.sayOn(network, kept, "back again");
    yield* watcher.until(
      "the Message after the rejoin",
      isFrom(nick, "PRIVMSG", `${kept} :back again`),
      restarted
    );

    // The reconciler plans every wanted Channel at once, so its one `JOIN` names them all.
    const rejoins = joinsOf(yield* second.entriesOf(network), startedAt);

    const strays = watcher
      .heard()
      .slice(restarted)
      .filter(({ text }) => text.startsWith(`:${nick}!`) && text.includes(" JOIN "));

    const after = yield* second.statusOf(network);

    yield* ensure(
      rejoins.map(({ cause, text }) => `${cause} ${text}`).join(",") === `rejoin JOIN ${kept}`,
      `after the restart it sent ${rejoins.map(({ text }) => text).join(",")}`
    );
    yield* ensure(
      strays.length === 1,
      `the watcher saw ${strays.map(({ text }) => text).join(",")}`
    );
    yield* ensure(
      after.joined.join(",") === kept,
      `joined after the restart: ${after.joined.join(",")}`
    );

    return (
      `joined ${kept} and ${gone} through the API, a raw client saw "${partLine.text}", ` +
      `then with ${before.joined.join(",")} joined a restart sent only "${rejoins[0]?.text}"`
    );
  })
);

// LIVE-8
const kickThenJoin = toCheck(
  Effect.gen(function* () {
    const nick = "floork";
    const ircd = yield* floorIrcd();
    const operator = yield* registeredClient(ircd.port, "floorko");

    // First in the Channel, so ngircd makes it the Channel operator.
    yield* operator.send(`JOIN ${kicked}`);
    yield* operator.until("the operator's names", (text) => text.includes(":@floorko"));

    const running = yield* runDaemon(yield* newHome);

    yield* addNetwork(
      running,
      floorNetwork({ channels: [floor, kicked], id: network, nick, port: ircd.port })
    );
    yield* untilJoined(running.statusOf(network), kicked);
    yield* operator.send(`KICK ${kicked} ${nick} :out you go`);

    const afterKick = yield* waitFor(
      "the kick",
      running.statusOf(network),
      ({ joined, kicked: kicks }) => kicks.length === 1 && !joined.includes(kicked)
    );

    const kickedAt = operator.mark();

    // A new Connection, by the Owner's own disconnect and connect.
    const { change: disconnected } = yield* running.client.networks.disconnect({
      params: { id: network },
    });

    yield* waitFor("the disconnect", running.statusOf(network), ({ phase }) => phase === "closed");
    yield* running.client.networks.connect({ params: { id: network } });
    yield* untilJoined(running.statusOf(network), floor);

    // Past the wait before rejoining, so a kick that failed to block would show by now.
    const settled = (brisk.drainMillis ?? 0) + 1000 + 4 * slackMillis;

    yield* Effect.sleep(Duration.millis(settled));

    const reconnected = yield* running.statusOf(network);
    const rejoins = joinsOf(yield* running.entriesOf(network), disconnected);

    yield* ensure(rejoins.length > 0, "nothing was rejoined after the reconnect");
    yield* ensure(
      rejoins.every(({ text }) => !text.includes(kicked)),
      `it went back: ${rejoins.map(({ text }) => text).join(",")}`
    );
    yield* ensure(
      !reconnected.joined.includes(kicked) && reconnected.kicked.length === 1,
      `status after the reconnect: ${JSON.stringify(reconnected.kicked)}`
    );

    const joinedAgain = yield* join(running, network, kicked);
    const change = "change" in joinedAgain ? joinedAgain.change : 0;

    yield* ensure(change > 0, "the Owner's Join recorded no Change");
    yield* operator.until(`${nick} back in ${kicked}`, isFrom(nick, "JOIN", kicked), kickedAt);

    const back = yield* untilJoined(running.statusOf(network), kicked);
    const sent = joinsOf(yield* running.entriesOf(network), change).at(0);

    yield* ensure(back.kicked.length === 0, `still kicked: ${JSON.stringify(back.kicked)}`);
    yield* ensure(sent?.cause === "rejoin", `the JOIN went as ${sent?.cause}`);

    return (
      `kicked from ${afterKick.kicked[0]?.channel}, stayed out across a disconnect and connect ` +
      `(rejoined only "${rejoins.at(-1)?.text}"), and the Owner's Join, Change ${change}, ` +
      `sent "${sent?.text}" which the operator saw`
    );
  })
);

// LIVE-9, LIVE-4
const disconnectAndConnect = toCheck(
  Effect.gen(function* () {
    const nick = "floord";
    const quietMillis = 2 * (brisk.reconnectMaxMillis ?? 0);
    const ircd = yield* floorIrcd();
    const locked = yield* floorIrcd({ password });
    const watcher = yield* watcherIn(ircd.port, "floorwd", floor);
    const running = yield* runDaemon(yield* newHome);

    yield* addNetwork(
      running,
      floorNetwork({ channels: [floor], id: network, nick, port: ircd.port })
    );
    yield* untilJoined(running.statusOf(network), floor);

    const { change: disconnected } = yield* running.client.networks.disconnect({
      params: { id: network },
    });

    const quit = yield* watcher.until(`${nick} to quit`, isQuit(nick));

    const off = yield* waitFor(
      "the Network to be off",
      running.statusOf(network),
      ({ enabled, phase }) => phase === "closed" && !enabled
    );

    const reached = yield* ircd.accepted;

    // Twice the longest backoff, so a reconnect that was going to happen would have.
    yield* Effect.sleep(Duration.millis(quietMillis));

    const quiet = yield* running.entriesOf(network);
    const still = yield* running.statusOf(network);

    yield* ensure(
      attempts(quiet).every(({ sequence }) => sequence < disconnected),
      "it redialed after the disconnect"
    );
    yield* ensure(off.nextAttemptAt === null && still.nextAttemptAt === null, "a redial is due");
    yield* ensure((yield* ircd.accepted) === reached, "ngircd saw a dial after the disconnect");

    const rejoined = watcher.mark();

    const { change: connected } = yield* running.client.networks.connect({
      params: { id: network },
    });

    yield* watcher.until(`${nick} to come back`, isFrom(nick, "JOIN", floor), rejoined);

    const back = yield* running.entriesOf(network);
    const connectedAt = changeEntries(back).find(({ sequence }) => sequence === connected)?.at ?? 0;
    const redial = attempts(back).find(({ sequence }) => sequence > connected);
    const returnedIn = (redial?.at ?? Number.POSITIVE_INFINITY) - connectedAt;

    yield* ensure(returnedIn <= slackMillis, `the redial came ${returnedIn} ms after connect`);

    // A refusal waits 30 minutes, which is its default here, and connect overrides it.
    yield* addNetwork(running, floorNetwork({ id: "locked", nick: "floorpw", port: locked.port }));

    const refused = yield* waitFor("the refusal", running.statusOf("locked"), isRefused);
    const lockedEntries = yield* running.entriesOf("locked");
    const closedAt = closes(lockedEntries).at(-1)?.at ?? 0;
    const thirtyMinutes = 30 * 60 * 1000;

    yield* ensure(
      refused.nextAttemptAt === closedAt + thirtyMinutes,
      `next attempt ${refused.nextAttemptAt}, closed at ${closedAt}`
    );

    const dialed = yield* locked.accepted;

    const { change: retried } = yield* running.client.networks.connect({
      params: { id: "locked" },
    });

    const retriedEntries = yield* waitFor("the redial", running.entriesOf("locked"), (entries) =>
      attempts(entries).some(({ sequence }) => sequence > retried)
    );

    const retriedAt = changeEntries(retriedEntries).find(
      ({ sequence }) => sequence === retried
    )?.at;

    const dial = attempts(retriedEntries).find(({ sequence }) => sequence > retried);
    const dialedIn = (dial?.at ?? 0) - (retriedAt ?? 0);

    yield* ensure(dialedIn <= 1000, `connect dialed ${dialedIn} ms into the refusal's wait`);
    yield* waitFor("ngircd to see it", locked.accepted, (count) => count > dialed);

    return (
      `a raw client saw "${quit.text}", then nothing dialed for ${quietMillis} ms; connect ` +
      `dialed ${returnedIn} ms after its Change, and ${dialedIn} ms after it during a ` +
      `refusal's ${thirtyMinutes / 60_000} minute wait`
    );
  })
);

// Runs a command of the binary to its end, for commands that are not the Daemon.
const runToEnd = (flags: readonly string[], environment: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const running = yield* startBinary(binary, flags, environment);
    const code = Number(yield* running.child.exitCode);

    yield* Fiber.join(running.reader);

    return { code, output: running.output() };
  }).pipe(Effect.scoped);

// What the Owner does to an exported file before importing it: changes what it says, and
// writes it out again.
const editFile = (text: string, edit: (configuration: Configuration) => Configuration) =>
  Result.match(parseConfigurationFile(text), {
    onFailure: (issues) =>
      Effect.fail(
        new ProofFailed({
          reason: `the export does not read back: ${issues.map(describeIssue).join("; ")}`,
        })
      ),
    onSuccess: (configuration) => Effect.succeed(configurationToToml(edit(configuration))),
  });

const editNetwork =
  (id: string, edit: (settings: NetworkSettings) => NetworkSettings) =>
  ({ networks }: Configuration): Configuration => ({
    networks: networks.map((settings) => (settings.id === id ? edit(settings) : settings)),
  });

// The last thing a command printed, which is what it found wrong.
const lastLine = (output: string) => output.trim().split("\n").at(-1)?.trim();

// CONF-6
const configurationFile = toCheck(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const ircd = yield* floorIrcd();
    const watcher = yield* watcherIn(ircd.port, "floorwc", floor);
    const running = yield* runDaemon(yield* newHome);
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "iirc-floor-toml-" });
    const environment = { IIRC_KEY: running.home.key };

    yield* addNetwork(
      running,
      floorNetwork({ channels: [floor], id: network, nick: "floorc", port: ircd.port })
    );
    yield* addNetwork(
      running,
      floorNetwork({ channels: [floor], id: "other", nick: "flooro", port: ircd.port })
    );
    yield* untilJoined(running.statusOf(network), floor);
    yield* untilJoined(running.statusOf("other"), floor);

    const configuration = running.client.configuration.get();

    const importFile = (name: string, text: string) =>
      Effect.gen(function* () {
        const file = path.join(directory, name);

        yield* fileSystem.writeFileString(file, text);

        return yield* runToEnd(
          ["config", "import", "--api-url", running.apiUrl, file],
          environment
        );
      });

    const exported = yield* runToEnd(
      ["config", "export", "--api-url", running.apiUrl],
      environment
    );

    yield* ensure(exported.code === 0, `export exited ${exported.code}: ${exported.output}`);

    const before = yield* configuration;
    const head = (yield* running.client.daemon.status()).head ?? 0;
    const same = yield* importFile("same.toml", exported.output);

    yield* ensure(same.code === 0, `import exited ${same.code}: ${same.output}`);

    const unchanged = yield* configuration;
    const since = (yield* allEntries(running.client)).filter(({ sequence }) => sequence > head);

    yield* ensure(
      JSON.stringify(unchanged) === JSON.stringify(before),
      "the round trip changed Configuration"
    );
    yield* ensure(changeEntries(since).length === 1, "the round trip was not one Change");
    yield* ensure(connectionEntries(since).length === 0, "the round trip touched a Connection");

    const withoutOther = yield* editFile(exported.output, ({ networks }) => ({
      networks: networks.filter(({ id }) => id !== "other"),
    }));

    const removed = yield* importFile("without-other.toml", withoutOther);

    yield* ensure(removed.code === 0, `import exited ${removed.code}: ${removed.output}`);
    yield* ensure(removed.output.includes("removed: other"), `import said: ${removed.output}`);

    const quit = yield* watcher.until("other to quit", isQuit("flooro"));

    const remaining = yield* waitFor(
      "other to leave status",
      Effect.map(running.client.daemon.status(), ({ networks }) => networks.map(({ id }) => id)),
      (ids) => !ids.includes("other")
    );

    const kept = yield* configuration;
    const keptHead = (yield* running.client.daemon.status()).head ?? 0;

    const badPin = yield* importFile(
      "pin.toml",
      yield* editFile(
        withoutOther,
        editNetwork(network, (settings) => ({
          ...settings,
          ircds: [{ host: loopback, pin: "sha256/not-a-pin", port: ircd.port, tls: true }],
        }))
      )
    );

    const badTuning = yield* importFile(
      "tuning.toml",
      yield* editFile(
        withoutOther,
        editNetwork(network, (settings) => ({
          ...settings,
          tuning: { ...settings.tuning, quitWaitMillis: 60_000 },
        }))
      )
    );

    yield* ensure(badPin.code !== 0, `a bad pin was imported: ${badPin.output}`);
    yield* ensure(
      badPin.output.includes("networks.floor.ircds[0].pin: "),
      `a bad pin gave: ${badPin.output}`
    );
    yield* ensure(badTuning.code !== 0, `bad Tuning was imported: ${badTuning.output}`);
    yield* ensure(
      badTuning.output.includes(
        "networks.floor.tuning.quitWaitMillis: Expected a value between 1 and 10000"
      ),
      `bad Tuning gave: ${badTuning.output}`
    );

    const refusedSince = (yield* allEntries(running.client)).filter(
      ({ sequence }) => sequence > keptHead
    );

    yield* ensure(changeEntries(refusedSince).length === 0, "a refused file recorded a Change");
    yield* ensure(
      JSON.stringify(yield* configuration) === JSON.stringify(kept),
      "a refused file changed Configuration"
    );

    return (
      `export then import left Configuration as it was, in one Change; leaving other out made ` +
      `a raw client see "${quit.text}" and status list ${remaining.join(",")}; refused ` +
      `"${lastLine(badPin.output)}" and "${lastLine(badTuning.output)}"`
    );
  })
);

/** A Send, as `POST /messages` takes it. */
interface Message {
  readonly network: string;
  readonly target: string;
  readonly text: string;
}

// What the check reads of an answer: the scope a 403 needed, or the sequence of a Line.
const Answer = Schema.Struct({
  needed: Schema.optionalKey(Schema.String),
  sequence: Schema.optionalKey(Schema.Int),
});

/**
 * Makes a request by hand rather than through the client, so that what comes back is the
 * HTTP status itself.
 * @param running - The Daemon.
 * @param route - The path under `/api`.
 * @param key - The key to send, if any.
 * @param message - A Send to post, or nothing for a `GET`.
 * @returns The status, and what the answer says.
 */
const request = Effect.fnUntraced(function* (
  running: Running,
  route: string,
  key?: string,
  message?: Message
) {
  const http = yield* HttpClient.HttpClient;
  const url = `${running.apiUrl}/api${route}`;

  const asked =
    message === undefined
      ? HttpClientRequest.get(url)
      : HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), message);

  const response = yield* http.execute(
    key === undefined ? asked : HttpClientRequest.bearerToken(asked, key)
  );

  return {
    body: yield* HttpClientResponse.schemaBodyJson(Answer)(response),
    status: response.status,
  };
});

// AUTH-1, AUTH-2, AUTH-3
const keys = toCheck(
  Effect.gen(function* () {
    const nick = "floorkey";
    const text = "from the chat key";
    const ircd = yield* floorIrcd();
    const watcher = yield* watcherIn(ircd.port, "floorwk", floor);
    const running = yield* runDaemon(yield* newHome);

    yield* addNetwork(
      running,
      floorNetwork({ channels: [floor], id: network, nick, port: ircd.port })
    );
    yield* untilJoined(running.statusOf(network), floor);

    const { key: reader } = yield* running.client.keys.create({
      payload: { name: "reader", scope: "read" },
    });

    const { key: chatter } = yield* running.client.keys.create({
      payload: { name: "chatter", scope: "chat" },
    });

    const message = { network, target: floor, text };
    const health = yield* request(running, "/health");
    const anonymous = yield* request(running, "/status");
    const read = yield* request(running, "/status", reader);
    const readSend = yield* request(running, "/messages", reader, message);
    const chatSend = yield* request(running, "/messages", chatter, message);

    yield* ensure(health.status === 200, `/health without a key gave ${health.status}`);
    yield* ensure(anonymous.status === 401, `/status without a key gave ${anonymous.status}`);
    yield* ensure(read.status === 200, `a read key's /status gave ${read.status}`);
    yield* ensure(
      readSend.status === 403 && readSend.body.needed === "chat",
      `a read key's Send gave ${readSend.status} ${JSON.stringify(readSend.body)}`
    );
    yield* ensure(chatSend.status === 200, `a chat key's Send gave ${chatSend.status}`);

    const heard = yield* watcher.until("the chat key's Message", isFrom(nick, "PRIVMSG", text));
    const { sequence } = chatSend.body;

    const line = lineEntries(yield* running.entriesOf(network)).find(
      (entry) => entry.sequence === sequence
    );

    yield* ensure(line?.cause === "key:chatter", `the Line's cause is ${line?.cause}`);

    yield* running.client.keys.revoke({ params: { name: "chatter" } });

    const revoked = yield* request(running, "/messages", chatter, message);

    yield* ensure(revoked.status === 401, `a revoked key's Send gave ${revoked.status}`);

    return (
      `no key: ${anonymous.status}; read key's Send: ${readSend.status} needing ` +
      `${readSend.body.needed ?? ""}; chat key's Send reached a raw client as "${heard.text}", ` +
      `Line ${sequence ?? 0} caused by ${line?.cause}; after revoking it: ${revoked.status}`
    );
  })
);

// The pin as `curl --pinnedpubkey` would want it, worked out by OpenSSL alone, so that it
// owes nothing to how the Daemon reads a certificate.
const opensslPin = (cert: string) => {
  const { exitCode, stdout } = Bun.spawnSync(
    [
      "sh",
      "-c",
      "openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64",
    ],
    { stdin: Buffer.from(cert) }
  );

  return exitCode === 0
    ? Effect.succeed(`sha256/${stdout.toString().trim()}`)
    : Effect.fail(new ProofFailed({ reason: "openssl could not work out a pin" }));
};

// ngircd says what it was built with in its version, as `+SSL`.
const ngircdSpeaksTls = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const version = yield* spawner.string(ChildProcess.make(ngircd, ["--version"]));

  return { speaks: /\+SSL\b/u.test(version), version: version.split("\n")[0] ?? "" };
});

// CONN-1
const pinning = toCheck(
  Effect.gen(function* () {
    const { speaks, version } = yield* ngircdSpeaksTls;

    if (!speaks) {
      return new Skipped({ reason: `this ngircd has no TLS: ${version}` });
    }

    const authority = yield* testAuthority("iirc floor proof");
    const certificate = authority.selfSigned(`DNS:${serverName}`);
    const pin = yield* opensslPin(certificate.cert);
    const elsewhere = yield* opensslPin(authority.selfSigned(`DNS:${serverName}`).cert);
    const ircd = yield* floorIrcd({ tls: certificate });
    const tlsPort = ircd.tlsPort ?? 0;
    const watcher = yield* watcherIn(ircd.port, "floorwt", floor);
    const running = yield* runDaemon(yield* newHome);

    // No authority trusts this certificate, and it is not for 127.0.0.1, so only the pin
    // can let it through.
    yield* addNetwork(
      running,
      floorNetwork({
        channels: [floor],
        id: "pinned",
        nick: "floortls",
        pin,
        port: tlsPort,
        tls: true,
      })
    );

    yield* untilJoined(running.statusOf("pinned"), floor);
    yield* running.sayOn("pinned", floor, "over TLS");
    yield* watcher.until(
      "the Message over TLS",
      isFrom("floortls", "PRIVMSG", `${floor} :over TLS`)
    );

    const opened = connectionEntries(yield* running.entriesOf("pinned")).find(
      (entry) => entry.phase === "opened"
    );

    const tls = opened?.phase === "opened" ? opened.tls : undefined;

    yield* ensure(
      tls?.pin === pin && tls.verifiedBy === "pin",
      `opened with ${JSON.stringify(tls)}`
    );

    yield* addNetwork(
      running,
      floorNetwork({
        id: "mispinned",
        nick: "floormis",
        pin: elsewhere,
        port: tlsPort,
        tls: true,
      })
    );

    const refused = yield* waitFor(
      "the wrong pin to be refused",
      running.statusOf("mispinned"),
      ({ closeReason }) => closeReason !== null
    );

    const mispinned = yield* running.entriesOf("mispinned");

    yield* ensure(
      refused.closeReason ===
        `${loopback}:${tlsPort} presented the key ${pin}, which is not its pin ${elsewhere}`,
      `closed: ${refused.closeReason}`
    );
    yield* ensure(lineEntries(mispinned).length === 0, "a Line crossed the wrong pin");
    yield* ensure(!refused.refused, "a wrong pin counted as a refusal");

    return (
      `a self-signed certificate reached a Session by its pin over ${tls?.protocol} ` +
      `(${tls?.cipher}), and the wrong pin closed with "${refused.closeReason}"`
    );
  })
);

// Every byte of the Log's files: the database, and its WAL, where a fresh commit sits until
// a checkpoint. A page can be in the WAL more than once, so a check counts what it finds
// against what may hold it, rather than expecting each to be there once.
const logFiles = (dataDir: string) =>
  Effect.sync(() =>
    ["iirc.sqlite", "iirc.sqlite-wal"]
      .map((file) => {
        try {
          return readFileSync(path.join(dataDir, file)).toString("latin1");
        } catch {
          return "";
        }
      })
      .join("")
  );

const occurrences = (text: string, part: string) => text.split(part).length - 1;

// LOG-6: what a Credential's value may never be found in.
const ensureNotInLog = Effect.fnUntraced(function* (dataDir: string, value: string, what: string) {
  const found = occurrences(yield* logFiles(dataDir), value);

  yield* ensure(found === 0, `${what} is in the Log's files ${found} times`);
});

// CRED-2: a value goes in on stdin, never in argv, and only its Change comes back.
const setCredential = Effect.fnUntraced(function* (running: Running, name: string, value: string) {
  const ran = yield* startBinary(
    binary,
    ["credential", "set", name, "--api-url", running.apiUrl],
    { IIRC_KEY: running.home.key },
    value
  );

  const code = Number(yield* ran.child.exitCode);

  yield* Fiber.join(ran.reader);

  const output = ran.output();

  yield* ensure(code === 0, `iirc credential set exited with ${code}: ${output}`);
  yield* ensure(!output.includes(value), "iirc credential set printed the value");

  return Number(/Change (?<change>\d+)/u.exec(output)?.groups?.change ?? 0);
}, Effect.scoped);

// What kind of Change a Change Entry holds, which the API gives as JSON.
const decodeKind = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }));

const tagOf = (change: Schema.Json) =>
  Option.match(decodeKind(change), { onNone: () => "", onSome: ({ _tag }) => _tag });

const changeAt = (entries: readonly LogEntry[], sequence: number) =>
  changeEntries(entries).find((entry) => entry.sequence === sequence);

// CRED-1, CONN-2, LOG-6
const serverPassword = toCheck(
  Effect.gen(function* () {
    const secret = `pass-${randomUUID()}`;
    const nick = "floorp";
    const ircd = yield* floorIrcd({ password: secret });
    const watcher = yield* watcherIn(ircd.port, "floorwp", floor, secret);
    const running = yield* runDaemon(yield* newHome);

    yield* addNetwork(running, {
      ...floorNetwork({ channels: [floor], id: network, nick, port: ircd.port }),
      credentials: { password: "floor.pass" },
    });

    const waiting = yield* waitFor(
      "status to name the missing Credential",
      running.statusOf(network),
      ({ missingCredentials }) => missingCredentials.length > 0
    );

    // Long enough for any `attempt` to have been made, which would also reach ngircd.
    yield* Effect.sleep("1 second");

    const reachedBefore = (yield* ircd.accepted) - 1;
    const before = yield* running.entriesOf(network);

    yield* ensure(
      waiting.missingCredentials.join(",") === "floor.pass" && waiting.nextAttemptAt === null,
      `status said ${JSON.stringify(waiting)}`
    );
    yield* ensure(
      attempts(before).length === 0,
      "an `attempt` was made with the Credential missing"
    );
    yield* ensure(reachedBefore === 0, `ngircd saw ${reachedBefore} Connections from the Daemon`);

    const change = yield* setCredential(running, "floor.pass", secret);
    const joined = yield* untilJoined(running.statusOf(network), floor);

    // A Credential's value is scrubbed from any Line, whatever the command (LOG-6).
    yield* watcher.send(`PRIVMSG ${floor} :the password is ${secret}`);
    yield* waitFor("the pasted password to be recorded", running.entriesOf(network), (all) =>
      lineEntries(all).some(({ text }) => text.includes("the password is"))
    );

    const entries = yield* running.entriesOf(network);
    const all = yield* allEntries(running.client);
    const set = changeAt(all, change);
    const [attempt] = attempts(entries);
    const pass = lineEntries(entries).find(({ text }) => text.startsWith("PASS"));
    const pasted = lineEntries(entries).find(({ text }) => text.includes("the password is"));
    const dialedMillis = (attempt?.at ?? 0) - (set?.at ?? 0);

    yield* ensure(
      set !== undefined && (attempt?.sequence ?? 0) > change && dialedMillis <= slackMillis,
      `the Credential was set at ${set?.at} and the attempt made at ${attempt?.at}`
    );
    yield* ensure(
      pass?.text === "PASS <redacted>" && pass.redacted?.join(",") === "floor.pass",
      `PASS was recorded as ${JSON.stringify(pass)}`
    );
    yield* ensure(
      pasted?.text.endsWith(":the password is <redacted>") === true,
      `the pasted password was recorded as ${pasted?.text}`
    );
    yield* ensureNotInLog(running.home.dataDir, secret, "the server password");

    const stopped = yield* stopDaemon(running);

    yield* ensure(stopped.code === 0, `SIGTERM gave exit ${stopped.code}`);
    yield* ensureNotInLog(running.home.dataDir, secret, "after the stop, the server password");

    return (
      `status named ${waiting.missingCredentials.join(",")} and ngircd saw no Connection for 1 s; ` +
      `\`iirc credential set\` recorded Change ${change}, the attempt followed ${dialedMillis} ms ` +
      `later, and "${pass?.text}" reached a Session in ${joined.joined.join(",")}; a pasted ` +
      `copy was recorded as "...${pasted?.text.slice(-24)}", and the password is in neither ` +
      "iirc.sqlite nor its WAL"
    );
  })
);

// CONN-6, LOG-6
const loginWait = toCheck(
  Effect.gen(function* () {
    const loginWaitMillis = 1500;
    const secret = `nickserv-${randomUUID()}`;
    const nick = "floorl";
    const ircd = yield* floorIrcd();
    const watcher = yield* watcherIn(ircd.port, "floorwl", floor);
    const running = yield* runDaemon(yield* newHome);

    yield* setCredential(running, "floor.nickserv", secret);
    yield* addNetwork(running, {
      ...floorNetwork({
        channels: [floor],
        id: network,
        nick,
        port: ircd.port,
        tuning: { loginWaitMillis },
      }),
      credentials: { service: { nick: "NickServ", password: "floor.nickserv" } },
    });

    yield* watcher.until(`${nick} to join ${floor}`, isFrom(nick, "JOIN", floor));

    const status = yield* waitFor(
      "the login wait to end",
      running.statusOf(network),
      ({ login }) => login.state !== "none" && login.state !== "waiting"
    );

    const entries = yield* running.entriesOf(network);
    const lines = lineEntries(entries);
    const identify = lines.find(({ cause }) => cause === "identify");

    const join = lines.find(
      ({ direction, text }) => direction === "outbound" && text.startsWith("JOIN")
    );

    const noService = lines.find(({ text }) => / 401 \S+ NickServ /u.test(text));

    const deadline = entries.find((entry) => entry._tag === "Deadline" && entry.name === "login");

    const waited = (deadline?.at ?? 0) - (identify?.at ?? 0);

    yield* ensure(
      identify?.text === "PRIVMSG NickServ :IDENTIFY <redacted>" &&
        identify.redacted?.join(",") === "floor.nickserv",
      `IDENTIFY was recorded as ${JSON.stringify(identify)}`
    );
    yield* ensure(noService !== undefined, "ngircd did not say it has no NickServ");
    yield* ensure(
      deadline !== undefined &&
        waited >= loginWaitMillis &&
        waited <= loginWaitMillis + slackMillis,
      `the login Deadline came ${waited} ms after IDENTIFY, not ${loginWaitMillis}`
    );
    yield* ensure(
      (join?.sequence ?? 0) > (deadline?.sequence ?? Infinity),
      `JOIN ${join?.sequence} went before the login Deadline ${deadline?.sequence}`
    );
    yield* ensure(status.login.state === "timedOut", `login is ${status.login.state}`);
    yield* ensureNotInLog(running.home.dataDir, secret, "the service password");

    return (
      `"${identify?.text}" went out, ngircd answered "${noService?.text}", the login Deadline ` +
      `came ${waited} ms later, then "${join?.text}", and status shows the login ${status.login.state}`
    );
  })
);

// CONN-6, LOG-6
const connectCommand = toCheck(
  Effect.gen(function* () {
    const secret = `token-${randomUUID()}`;
    const nick = "floorc";
    const target = "floorwc";
    const ircd = yield* floorIrcd();
    const watcher = yield* watcherIn(ircd.port, target, floor);
    const running = yield* runDaemon(yield* newHome);

    yield* setCredential(running, "floor.token", secret);
    yield* addNetwork(running, {
      ...floorNetwork({ channels: [floor], id: network, nick, port: ircd.port }),
      connectCommands: [`PRIVMSG ${target} :token {{floor.token}}`],
    });

    const heard = yield* watcher.until(
      "the connect command",
      isFrom(nick, "PRIVMSG", `${target} :token ${secret}`)
    );

    yield* watcher.until(`${nick} to join ${floor}`, isFrom(nick, "JOIN", floor));

    const lines = lineEntries(yield* running.entriesOf(network));
    const burst = lines.find(({ text }) => / (?:376|422) /u.test(text));
    const command = lines.find(({ cause }) => cause === "connect-command");

    const join = lines.find(
      ({ direction, text }) => direction === "outbound" && text.startsWith("JOIN")
    );

    yield* ensure(
      command?.text === `PRIVMSG ${target} :token <redacted>` &&
        command.redacted?.join(",") === "floor.token",
      `the connect command was recorded as ${JSON.stringify(command)}`
    );
    yield* ensure(
      (burst?.sequence ?? Infinity) < (command?.sequence ?? 0) &&
        (command?.sequence ?? Infinity) < (join?.sequence ?? 0),
      `burst ${burst?.sequence}, connect command ${command?.sequence}, JOIN ${join?.sequence}`
    );
    yield* ensureNotInLog(running.home.dataDir, secret, "the connect command's Credential");

    return (
      `a raw client heard "${heard.text.replace(secret, "<its value>")}" after the burst ` +
      `ended at "${burst?.text}" and before "${join?.text}", and the Log has "${command?.text}"`
    );
  })
);

// CRED-4, CONF-5, LOG-6
const channelKey = toCheck(
  Effect.gen(function* () {
    const keyed = "#keyed";
    const nick = "floork";
    const keeper = "floorwk";
    const firstKey = `first-${randomUUID()}`;
    const secondKey = `second-${randomUUID()}`;
    const ircd = yield* floorIrcd();
    const owner = yield* watcherIn(ircd.port, keeper, keyed);

    yield* owner.send(`MODE ${keyed} +k ${firstKey}`);
    yield* owner.until("the first key", isFrom(keeper, "MODE", firstKey));

    const home = yield* newHome;
    const first = yield* runDaemon(home);

    yield* addNetwork(first, floorNetwork({ id: network, nick, port: ircd.port }));
    yield* waitFor("a Session", first.statusOf(network), ({ phase }) => phase === "session");
    yield* first.client.networks.join({
      params: { id: network },
      payload: { channel: keyed, key: Redacted.make(firstKey), remember: true },
    });
    yield* untilJoined(first.statusOf(network), keyed);
    yield* stopDaemon(first);

    // A restart rejoins with the key it stored.
    const restarted = owner.mark();
    const second = yield* runDaemon(home);
    const startedAt = (yield* second.client.daemon.status()).head ?? 0;

    yield* untilJoined(second.statusOf(network), keyed);
    yield* owner.until(`${nick} to rejoin`, isFrom(nick, "JOIN", keyed), restarted);

    const [rejoin] = joinsOf(yield* second.entriesOf(network), startedAt);

    // ngircd replaces a key, and an Ircd that wants the old one taken away first says
    // `467`, so this does that then.
    const replacing = owner.mark();

    yield* owner.send(`MODE ${keyed} +k ${secondKey}`);

    const replaced = yield* owner.until(
      "the second key",
      (text) => isFrom(keeper, "MODE", secondKey)(text) || / 467 /u.test(text),
      replacing
    );

    if (/ 467 /u.test(replaced.text)) {
      yield* owner.send(`MODE ${keyed} -k ${firstKey}`);
      yield* owner.send(`MODE ${keyed} +k ${secondKey}`);
      yield* owner.until("the second key", isFrom(keeper, "MODE", secondKey), replacing);
    }

    const kept = yield* waitFor("the second key to be kept", allEntries(second.client), (all) =>
      changeEntries(all).some(({ by, sequence }) => by === "mode" && sequence > startedAt)
    );

    const byMode = changeEntries(kept).filter(({ by }) => by === "mode");

    yield* stopDaemon(second);

    const again = owner.mark();
    const third = yield* runDaemon(home);
    const thirdAt = (yield* third.client.daemon.status()).head ?? 0;

    yield* untilJoined(third.statusOf(network), keyed);
    yield* owner.until(`${nick} to rejoin with the second key`, isFrom(nick, "JOIN", keyed), again);

    const [lastRejoin] = joinsOf(yield* third.entriesOf(network), thirdAt);
    const { settings } = yield* third.client.networks.get({ params: { id: network } });
    const named = settings.channels.find(({ name }) => name === keyed)?.key;

    yield* stopDaemon(third);

    const files = yield* logFiles(home.dataDir);

    yield* ensure(
      rejoin?.text === `JOIN ${keyed} <redacted>` &&
        lastRejoin?.text === `JOIN ${keyed} <redacted>`,
      `the rejoins were recorded as "${rejoin?.text}" and "${lastRejoin?.text}"`
    );
    yield* ensure(
      named !== undefined &&
        byMode.some(
          ({ change }) =>
            JSON.stringify(change) === JSON.stringify({ _tag: "CredentialSet", name: named })
        ),
      `the Changes by mode were ${JSON.stringify(byMode.map(({ change }) => change))}`
    );
    yield* ensure(occurrences(files, firstKey) === 0, "the Join's key is in the Log's files");
    yield* ensure(
      occurrences(files, secondKey) === occurrences(files, `+k ${secondKey}`),
      "the second key is in the Log's files outside the `MODE` that first set it"
    );

    return (
      `a Join with the key got into ${keyed}, a restart rejoined with "${rejoin?.text}", ` +
      `the raw client's \`MODE +k\` was kept as ${named} by ${byMode
        .map(({ change }) => tagOf(change))
        .join(", ")}, and the next restart rejoined with it; neither key is in the Log's ` +
      "files but for that first `+k`"
    );
  })
);

const quickCheck = (file: string) => {
  const database = new Database(file, { readonly: true });

  try {
    return database
      .query<{ readonly quick_check: string }, []>("PRAGMA quick_check")
      .all()
      .map(({ quick_check: result }) => result)
      .join(",");
  } finally {
    database.close();
  }
};

// RUN-2, CRED-1
const backup = toCheck(
  Effect.gen(function* () {
    const secret = `backup-${randomUUID()}`;
    const nick = "floorb";
    const ircd = yield* floorIrcd();
    const watcher = yield* watcherIn(ircd.port, "floorwb", floor);
    const running = yield* runDaemon(yield* newHome);

    // The value goes over the wire, so a backup that kept what was sent would hold it.
    yield* setCredential(running, "floor.backup", secret);
    yield* addNetwork(running, {
      ...floorNetwork({ channels: [floor], id: network, nick, port: ircd.port }),
      connectCommands: ["PRIVMSG floorwb :{{floor.backup}}"],
    });
    yield* watcher.until(
      "the Credential on the wire",
      isFrom(nick, "PRIVMSG", `floorwb :${secret}`)
    );
    yield* untilJoined(running.statusOf(network), floor);

    const ran = yield* runToEnd(["backup", "--api-url", running.apiUrl], {
      IIRC_KEY: running.home.key,
    });

    const file = /in (?<file>\S+) \(/u.exec(ran.output)?.groups?.file ?? "";

    yield* ensure(
      ran.code === 0 && file !== "",
      `iirc backup exited with ${ran.code}: ${ran.output}`
    );

    const checked = quickCheck(file);
    const bytes = readFileSync(file).toString("latin1");

    yield* ensure(checked === "ok", `quick_check said ${checked}`);
    yield* ensure(!bytes.includes(secret), "the backup holds the Credential's value");
    yield* ensure(bytes.includes("floor.backup"), "the backup does not hold the Credential's name");

    return `\`iirc backup\` wrote ${path.basename(file)} (${bytes.length} bytes), quick_check said "${checked}", and it names floor.backup and holds no value`;
  })
);

// The SHA-256 and SHA-1 of a certificate, in hex, worked out by OpenSSL alone.
const fingerprints = (cert: string) =>
  ["sha256", "sha1"].map((digest) =>
    Bun.spawnSync(["openssl", "x509", "-noout", "-fingerprint", `-${digest}`], {
      stdin: Buffer.from(cert),
    })
      .stdout.toString()
      .replace(/^.*=/u, "")
      .replaceAll(":", "")
      .trim()
      .toLowerCase()
  );

// CRED-1, CONN-1
const clientCertificate = toCheck(
  Effect.gen(function* () {
    const { speaks, version } = yield* ngircdSpeaksTls;

    if (!speaks) {
      return new Skipped({ reason: `this ngircd has no TLS: ${version}` });
    }

    const authority = yield* testAuthority("iirc floor proof client");
    const certificate = authority.selfSigned(`DNS:${serverName}`);
    const pin = yield* opensslPin(certificate.cert);
    const client = authority.selfSigned("DNS:floor.client.test");
    const ircd = yield* floorIrcd({ tls: certificate });
    const running = yield* runDaemon(yield* newHome);
    const nick = "floorcert";

    yield* setCredential(running, "floor.cert", `${client.cert}${client.key}`);
    yield* addNetwork(running, {
      ...floorNetwork({ id: network, nick, pin, port: ircd.tlsPort ?? 0, tls: true }),
      credentials: { clientCertificate: "floor.cert" },
    });
    yield* waitFor("a Session", running.statusOf(network), ({ phase }) => phase === "session");

    // ngircd tells a client the fingerprint of the certificate it presented, if it asked.
    const told = yield* waitFor("the burst", running.entriesOf(network), (all) =>
      lineEntries(all).some(({ text }) => / (?:376|422) /u.test(text))
    ).pipe(
      Effect.map((all) =>
        lineEntries(all).find(({ text }) => text.includes("client certificate fingerprint"))
      )
    );

    const keyBody = client.key.split("\n")[1] ?? client.key;

    yield* ensureNotInLog(running.home.dataDir, keyBody, "the client certificate's key");

    if (told === undefined) {
      return new Skipped({
        reason: `the Daemon reached a Session over TLS presenting a client certificate, and this ngircd (${version}) never said whether it saw one`,
      });
    }

    const said = told.text
      .replace(/^.*: */u, "")
      .replaceAll(":", "")
      .trim()
      .toLowerCase();

    const [sha256 = "", sha1 = ""] = fingerprints(client.cert);

    yield* ensure(
      said === sha256 || said === sha1,
      `ngircd saw ${said}, and the certificate is ${sha256} (SHA-256) or ${sha1} (SHA-1)`
    );

    return `ngircd said "${told.text.replace(/^:\S+ /u, "")}", which is the ${said === sha256 ? "SHA-256" : "SHA-1"} fingerprint of the certificate in floor.cert, and its key is not in the Log`;
  })
);

const checks: readonly (readonly [string, Check])[] = [
  ["Reconnect (LIVE-4, LIVE-6, LIVE-7, LIVE-10)", reconnect],
  ["Silence (LIVE-2)", silence],
  ["Refusal (LIVE-5)", refusal],
  ["Nick fallback (CONN-4)", nickFallback],
  ["Kick (LIVE-8)", kick],
  ["Lag (LIVE-3)", lag],
  ["Flood control (SEND-2)", floodControl],
  ["Stop (LIVE-9)", stop],
  ["Two Networks (HOST-5, CONF-3)", twoNetworks],
  ["Join and Part (CONF-2, CONF-5)", joinAndPart],
  ["A kick, then the Owner's Join (LIVE-8)", kickThenJoin],
  ["Disconnect and connect (LIVE-9, LIVE-4)", disconnectAndConnect],
  ["Configuration as a file (CONF-6)", configurationFile],
  ["Keys (AUTH-1, AUTH-2, AUTH-3)", keys],
  ["TLS pinning (CONN-1)", pinning],
  ["Server password, set while missing (CRED-1, CONN-2, LOG-6)", serverPassword],
  ["Login wait (CONN-6, LOG-6)", loginWait],
  ["Connect command (CONN-6, LOG-6)", connectCommand],
  ["Channel key (CRED-4, CONF-5, LOG-6)", channelKey],
  ["Backup (RUN-2, CRED-1)", backup],
  ["TLS client certificate (CRED-1, CONN-1)", clientCertificate],
];

type Outcome = "failed" | "passed" | "skipped";

const reportOutcome = (outcome: Outcome, line: string) => Effect.as(Console.log(line), outcome);

const describeFailure = (cause: Cause.Cause<ProofFailed>) => {
  const error = Cause.squash(cause);

  return error instanceof ProofFailed ? error.reason : Cause.pretty(cause);
};

// Each in its own Scope, so a failure leaves nothing behind for the next. An interrupt is
// not a failure of the check, and has to carry on up so that the proof stops.
const runCheck = ([name, proof]: readonly [string, Check]) =>
  Effect.scoped(proof).pipe(
    Effect.timeoutOrElse({
      duration: checkLimit,
      orElse: () => Effect.fail(new ProofFailed({ reason: `over ${checkLimit}` })),
    }),
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : reportOutcome("failed", `FAIL ${name}: ${describeFailure(cause)}`),
      onSuccess: (observed) =>
        observed instanceof Skipped
          ? reportOutcome("skipped", `SKIP ${name}: ${observed.reason}`)
          : reportOutcome("passed", `PASS ${name}: ${observed}`),
    })
  );

const proof = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const started = Date.now();

  for (const [name, file] of [
    ["The binary", binary],
    ["ngircd", ngircd],
  ] as const) {
    yield* ensure(yield* fileSystem.exists(file), `${name} is not at ${file}`);
  }

  const outcomes = yield* Effect.forEach(checks, runCheck, { concurrency: 1 });
  const count = (outcome: Outcome) => outcomes.filter((each) => each === outcome).length;
  const seconds = Math.round((Date.now() - started) / 1000);

  yield* Console.log(
    `${count("passed")} of ${outcomes.length} checks passed, ${count("skipped")} skipped, ` +
      `in ${seconds} s`
  );
  yield* ensure(count("failed") === 0, `${count("failed")} checks failed`);
});

// `runMain` hears SIGINT and SIGTERM. A closed terminal is an interrupt as well.
process.on("SIGHUP", () => {
  process.kill(process.pid, "SIGTERM");
});

proof.pipe(
  Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  BunRuntime.runMain
);
