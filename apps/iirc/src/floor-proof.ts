#!/usr/bin/env bun
import { connect } from "node:net";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

import { BunRuntime, BunServices } from "@effect/platform-bun";
import type { LogEntry, Status } from "@iirc/api";
import type { Tuning } from "@iirc/lifecycle/tuning";
import {
  Cause,
  Console,
  Data,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Ref,
  Schedule,
  Stream,
} from "effect";
import type { Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import type { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { appRoot, freePort, healthyClient, logTail, startBinary } from "./binary.ts";

// Proves step 2 on a real Ircd: a private ngircd started here, on a loopback port of its
// own, driven only through the built binary, signals, and a raw IRC client. It never
// touches the ngircd anyone else is using. Every process is started by exact PID, in a
// Scope that takes it down again on success, failure, or interrupt, and every temporary
// file goes with the Scope too.

const binary = `${appRoot}/dist/iirc`;

// Where this machine keeps ngircd. Set `IIRC_NGIRCD` to use another.
const ngircd = process.env.IIRC_NGIRCD ?? path.join(homedir(), ".local/opt/ngircd/ngircd");

const serverName = "floor.proof.test";
const password = "opensesame";
const nickLength = 16;

const floor = "#floor";
const kicked = "#kick";
const flood = "#flood";

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

class ProofFailed extends Data.TaggedError("ProofFailed")<{ readonly reason: string }> {}

type FloorServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Scope.Scope;

/** One check: what it observed, if all was as it should be. */
type Check = Effect.Effect<string, ProofFailed, FloorServices>;

// Anything else going wrong fails the check the same way, and says what it was.
const toCheck = <E>(proof: Effect.Effect<string, E, FloorServices>): Check =>
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

/** One private ngircd, restartable on the same port. */
const floorIrcd = Effect.fnUntraced(function* (options: { readonly password?: string } = {}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "iirc-floor-ircd-" });
  const port = yield* freePort;
  const config = path.join(directory, "ngircd.conf");
  const logged = yield* Ref.make("");

  yield* fileSystem.writeFileString(
    config,
    [
      "[Global]",
      `Name = ${serverName}`,
      "Info = iirc floor proof",
      "Listen = 127.0.0.1",
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
    pause: Effect.flatMap(Ref.get(started), ({ pid }) => signalPid(pid, "SIGSTOP")),
    port,
    restart: start.pipe(Effect.flatMap((child) => Ref.set(started, child))),
    resume: Effect.flatMap(Ref.get(started), ({ pid }) => signalPid(pid, "SIGCONT")),
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
      const opening = connect({ host: "127.0.0.1", port });

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

  const until = (what: string, match: (text: string) => boolean) =>
    waitFor(
      what,
      Effect.sync(() => heard.find(({ text }) => match(text))),
      (found) => found !== undefined
    );

  return { heard: () => [...heard], send, until };
});

const registeredClient = Effect.fnUntraced(function* (port: number, nick: string) {
  const client = yield* rawClient(port);

  yield* client.send(`NICK ${nick}`);
  yield* client.send("USER raw 0 * :raw client");
  yield* client.until(`${nick} to register`, (text) => text.includes(` 001 ${nick} `));

  return client;
});

/** What it takes to run a Daemon, which survives it, so that it can be run again. */
interface Identity {
  readonly alternates?: readonly string[];
  readonly channels: readonly string[];
  readonly dataDir: string;
  readonly nick: string;
  readonly port: number;
  readonly tuning?: Partial<Tuning>;
}

// On real disk, because `/tmp` is tmpfs on fserv, where fsync means nothing.
const dataDirs = path.join(appRoot, "../../.cache/floor-proof");

const newDataDir = FileSystem.FileSystem.pipe(
  Effect.tap((fileSystem) => fileSystem.makeDirectory(dataDirs, { recursive: true })),
  Effect.flatMap((fileSystem) =>
    fileSystem.makeTempDirectoryScoped({ directory: dataDirs, prefix: "iirc-floor-" })
  )
);

const pageSize = 1000;

const startDaemon = Effect.fnUntraced(function* ({
  alternates = [],
  channels,
  dataDir,
  nick,
  port,
  tuning,
}: Identity) {
  const httpPort = yield* freePort;

  const running = yield* startBinary(
    binary,
    [
      "daemon",
      "--no-tls",
      "--network",
      "floor",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--nick",
      nick,
      "--quit-reason",
      quitReason,
      "--http-port",
      String(httpPort),
      "--tuning",
      JSON.stringify({ ...brisk, ...tuning }),
      ...alternates.flatMap((alternate) => ["--alternate-nick", alternate]),
      ...channels.flatMap((channel) => ["--channel", channel]),
    ],
    { IIRC_DATA_DIR: dataDir }
  );

  const { daemon } = yield* healthyClient(httpPort);

  const entries = Effect.gen(function* () {
    const all: LogEntry[] = [];
    let page: readonly LogEntry[] = [];

    do {
      page = yield* daemon.entries({
        query: { after: all.at(-1)?.sequence ?? 0, limit: pageSize },
      });
      all.push(...page);
    } while (page.length === pageSize);

    return all;
  });

  return {
    daemon,
    entries,
    pid: running.child.pid,
    running,
    say: (target: string, text: string) => daemon.send({ payload: { target, text } }),
    status: daemon.status(),
  };
});

type Daemon = Effect.Success<ReturnType<typeof startDaemon>>;

const stopDaemon = (running: Daemon, signal: NodeJS.Signals = "SIGTERM") =>
  Effect.gen(function* () {
    const stopping = Date.now();

    yield* signalPid(running.pid, signal);

    const code = yield* Effect.exit(running.running.child.exitCode);

    return { code: Exit.isSuccess(code) ? Number(code.value) : -1, millis: Date.now() - stopping };
  });

const untilInChannel = (running: Daemon, channel: string) =>
  waitFor(`${channel} to be joined`, running.status, ({ joined, phase }) => {
    const isIn = joined.includes(channel);

    return phase === "session" && isIn;
  });

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
      dataDir: yield* newDataDir,
      nick: "floora",
      port: ircd.port,
    });

    const b = yield* startDaemon({
      channels,
      dataDir: yield* newDataDir,
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
      dataDir: yield* newDataDir,
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
        (found) => found?.text ?? ""
      );
    });

    const register = [`NICK ${nick}`, "USER iirc 0 * :iirc"];
    const withoutPass = yield* refusedAs(register);
    const withWrongPass = yield* refusedAs(["PASS not-the-password", ...register]);

    yield* ensure(withoutPass === withWrongPass, `ngircd answered: ${withWrongPass}`);

    const verbatim = withoutPass.replace(/^ERROR :/u, "");
    const dataDir = yield* newDataDir;

    const identity = {
      channels: [floor],
      dataDir,
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
      dataDir: yield* newDataDir,
      nick: taken,
      port: ircd.port,
    });

    yield* waitFor("the holder", holder.status, ({ phase }) => phase === "session");

    const alternateHolder = yield* registeredClient(ircd.port, alternate);

    yield* ensure(alternateHolder.heard().length > 0, "the raw client registered with nothing");

    const second = yield* startDaemon({
      alternates: [alternate, fallback],
      channels: [],
      dataDir: yield* newDataDir,
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
    const dataDir = yield* newDataDir;
    const identity = { channels: [], dataDir, nick: padded, port: ircd.port };
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
    const dataDir = yield* newDataDir;

    // Short, so that a kick which failed to block would show as a rejoin inside the check.
    const kickRejoinMillis = 500;
    const outlasted = Duration.millis(kickRejoinMillis + 4 * slackMillis);

    const victim = yield* startDaemon({
      channels,
      dataDir,
      nick: "floorv",
      port: ircd.port,
      tuning: { kickRejoinMillis },
    });

    const witness = yield* startDaemon({
      channels,
      dataDir: yield* newDataDir,
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
      dataDir: yield* newDataDir,
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
      dataDir: yield* newDataDir,
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
    const dataDir = yield* newDataDir;
    const leaver = yield* startDaemon({ channels, dataDir, nick: "floorq", port: ircd.port });

    const stayer = yield* startDaemon({
      channels,
      dataDir: yield* newDataDir,
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
    const tail = yield* logTail(dataDir, 8);
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

const checks: readonly (readonly [string, Check])[] = [
  ["Reconnect (LIVE-4, LIVE-6, LIVE-7, LIVE-10)", reconnect],
  ["Silence (LIVE-2)", silence],
  ["Refusal (LIVE-5)", refusal],
  ["Nick fallback (CONN-4)", nickFallback],
  ["Kick (LIVE-8)", kick],
  ["Lag (LIVE-3)", lag],
  ["Flood control (SEND-2)", floodControl],
  ["Stop (LIVE-9)", stop],
];

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
          : Effect.as(Console.log(`FAIL ${name}: ${describeFailure(cause)}`), false),
      onSuccess: (observed) => Effect.as(Console.log(`PASS ${name}: ${observed}`), true),
    })
  );

const proof = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;

  for (const [name, file] of [
    ["The binary", binary],
    ["ngircd", ngircd],
  ] as const) {
    yield* ensure(yield* fileSystem.exists(file), `${name} is not at ${file}`);
  }

  const passed = yield* Effect.forEach(checks, runCheck, { concurrency: 1 });
  const failures = passed.filter((check) => !check).length;

  yield* Console.log(`${passed.length - failures} of ${passed.length} checks passed`);
  yield* ensure(failures === 0, `${failures} checks failed`);
});

// `runMain` hears SIGINT and SIGTERM. A closed terminal is an interrupt as well.
process.on("SIGHUP", () => {
  process.kill(process.pid, "SIGTERM");
});

proof.pipe(
  Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  BunRuntime.runMain
);
