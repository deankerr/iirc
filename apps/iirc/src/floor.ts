import { connect } from "node:net";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

import type { LogEntry, NetworkSettings, NetworkStatus as Status } from "@iirc/api";
import type { Tuning } from "@iirc/lifecycle/tuning";
import type { Certificate } from "@iirc/session/testing";
import { Data, Effect, FileSystem, Ref, Schedule, Stream } from "effect";
import type { Scope, Duration } from "effect";
import type { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  appRoot,
  createKey,
  freePort,
  healthyClient,
  networkStatus,
  settingsFor,
  startBinary,
} from "./binary.ts";
import type { Client, TestNetwork } from "./binary.ts";

// What every check of the floor proof shares: private ngircds, raw IRC clients, and the
// built binary as a Daemon, each held by a Scope.

/** The binary `proof:floor` builds. */
export const binary = `${appRoot}/dist/iirc`;

/** Where this machine keeps ngircd. Set `IIRC_NGIRCD` to use another. */
export const ngircd = process.env.IIRC_NGIRCD ?? path.join(homedir(), ".local/opt/ngircd/ngircd");

/** The name a private ngircd goes by unless given another. */
export const serverName = "floor.proof.test";

/** The server password of a private ngircd that wants one. */
export const password = "opensesame";

/** Where every private ngircd and every Daemon listens. */
export const loopback = "127.0.0.1";

/** The ID of the Network most checks add. */
export const network = "floor";

/** The reason every Network the proof adds quits with. */
export const quitReason = "floor proof says goodbye";

/** Past `registrationTimeoutMillis`, because a Connection may come up inside an outage. */
const settleLimit = "30 seconds";

/** The longest one check may take. */
export const checkLimit = "120 seconds";
const pollEvery = "20 millis";

/**
 * How far a time on the wire or in the Log may stray from what was asked for: one turn of
 * a busy event loop on a machine doing other things.
 */
export const slackMillis = 400;

/** Quick to react, so the proof is mostly about what ngircd does, and not about waiting. */
export const brisk: Partial<Tuning> = {
  drainMillis: 300,
  quitWaitMillis: 1000,
  reconnectInitialMillis: 300,
  reconnectMaxMillis: 1500,
};

/** A check that found something other than what it should have, and says what. */
export class ProofFailed extends Data.TaggedError("ProofFailed")<{ readonly reason: string }> {
  /**
   * So that a failure the runtime logs says what it was.
   * @returns The reason.
   */
  override get message() {
    return this.reason;
  }
}

/** A check that could not run here, and says why rather than pass for one that did. */
export class Skipped extends Data.TaggedClass("Skipped")<{ readonly reason: string }> {}

/** What every check runs on. */
export type FloorServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Scope.Scope;

/** One check: what it observed, if all was as it should be. */
export type Check = Effect.Effect<string | Skipped, ProofFailed, FloorServices>;

/**
 * Makes a check of a proof, so that anything else going wrong fails it the same way, and
 * says what it was.
 * @param proof - What the check does.
 * @returns The check.
 */
export const toCheck = <E>(proof: Effect.Effect<string | Skipped, E, FloorServices>): Check =>
  Effect.mapError(proof, (error) =>
    error instanceof ProofFailed ? error : new ProofFailed({ reason: String(error) })
  );

/**
 * Fails the check, saying why, unless a condition holds.
 * @param condition - What should be true.
 * @param reason - What the failure says.
 * @returns Nothing, or the failure.
 */
export const ensure = (condition: boolean, reason: string) =>
  condition ? Effect.void : Effect.fail(new ProofFailed({ reason }));

/**
 * Asks again and again until an answer will do, or fails once the limit has passed.
 * @param what - What is waited for, for the failure to name.
 * @param check - What to ask.
 * @param done - Whether an answer will do.
 * @param limit - How long to wait at most.
 * @returns The answer that would do.
 */
export const waitFor = <A, E, R>(
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

/**
 * Sends a signal to one process, by its exact PID.
 * @param pid - The process.
 * @param signal - The signal.
 * @returns Nothing, once it is sent.
 */
export const signalPid = (pid: number, signal: NodeJS.Signals) =>
  Effect.sync(() => {
    process.kill(pid, signal);
  });

/**
 * A server link to another private ngircd: `port` to dial it, or none to wait for it to
 * dial, and the passwords each side gives the other.
 */
interface Link {
  readonly name: string;
  readonly peerPassword: string;
  readonly myPassword: string;
  readonly port?: number;
}

/** What a private ngircd is, beyond a port: its name, an IRC operator, and a link. */
export interface IrcdOptions {
  readonly link?: Link;
  readonly name?: string;
  readonly operator?: { readonly name: string; readonly password: string };
  readonly password?: string;
  readonly tls?: Certificate;
}

/**
 * One private ngircd, restartable on the same port, which speaks TLS too if given a key,
 * and links to another if given a link.
 * @param options - What it is, beyond a port.
 * @returns Its ports and name, and ways to kill, restart, pause, and resume it.
 */
export const floorIrcd = Effect.fnUntraced(function* (options: IrcdOptions = {}) {
  const name = options.name ?? serverName;
  const { link, operator } = options;
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
      `Name = ${name}`,
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
      "MaxNickLength = 16",
      // The shortest ngircd allows, so that a link which drops on its own comes back soon.
      ...(link === undefined ? [] : ["ConnectRetry = 5"]),
      "[Options]",
      "DNS = no",
      "Ident = no",
      "PAM = no",
      ...(tlsPort === undefined
        ? []
        : ["[SSL]", `CertFile = ${certFile}`, `KeyFile = ${keyFile}`, `Ports = ${tlsPort}`]),
      ...(operator === undefined
        ? []
        : ["[Operator]", `Name = ${operator.name}`, `Password = ${operator.password}`]),
      ...(link === undefined
        ? []
        : [
            "[Server]",
            `Name = ${link.name}`,
            `Host = ${loopback}`,
            `MyPassword = ${link.myPassword}`,
            `PeerPassword = ${link.peerPassword}`,
            ...(link.port === undefined ? ["Passive = yes"] : [`Port = ${link.port}`]),
          ]),
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

  // ngircd prints the configuration it read, so a link it would not make is missing there.
  const linkable =
    link === undefined ||
    (yield* spawner.string(
      ChildProcess.make(ngircd, ["--configtest", "--config", config], {
        cwd: directory,
        stdin: "ignore",
      })
    )).includes(`[SERVER]\n  Name = ${link.name}\n`);

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
      text.slice(before).includes(`Server "${name}"`)
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
    /** Whether ngircd read the link it was given, which one built without links would not. */
    linkable,
    /** What ngircd has written to its log so far. */
    logged: Ref.get(logged),
    name,
    pause: Effect.flatMap(Ref.get(started), ({ pid }) => signalPid(pid, "SIGSTOP")),
    port,
    restart: start.pipe(Effect.flatMap((child) => Ref.set(started, child))),
    resume: Effect.flatMap(Ref.get(started), ({ pid }) => signalPid(pid, "SIGCONT")),
    tlsPort,
  };
});

/** One Line a raw client heard, and when. */
export interface Heard {
  readonly at: number;
  readonly text: string;
}

/**
 * A plain IRC client, for what the API cannot do yet. Answers `PING`, and does no more.
 * @param port - The Ircd's port.
 * @returns What it heard, and ways to send and to wait for a Line.
 */
export const rawClient = Effect.fnUntraced(function* (port: number) {
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

/**
 * A raw client that has registered with ngircd.
 * @param port - The Ircd's port.
 * @param nick - Its nick.
 * @param pass - The server password, if the Ircd wants one.
 * @returns The client, once welcomed.
 */
export const registeredClient = Effect.fnUntraced(function* (
  port: number,
  nick: string,
  pass?: string
) {
  const client = yield* rawClient(port);

  if (pass !== undefined) {
    yield* client.send(`PASS ${pass}`);
  }

  yield* client.send(`NICK ${nick}`);
  yield* client.send("USER raw 0 * :raw client");
  yield* client.until(`${nick} to register`, (text) => text.includes(` 001 ${nick} `));

  return client;
});

/**
 * A registered raw client in a Channel, which sees whatever happens there.
 * @param port - The Ircd's port.
 * @param nick - Its nick.
 * @param channel - The Channel.
 * @param pass - The server password, if the Ircd wants one.
 * @returns The client, once its `NAMES` has ended.
 */
export const watcherIn = Effect.fnUntraced(function* (
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

/**
 * What a raw client sees a nick do, as ngircd relays it: a command from that nick, then
 * its parameters, the last of them after a colon.
 * @param nick - Who did it.
 * @param command - The command.
 * @param rest - How the Line ends.
 * @returns Whether a Line heard is that.
 */
export const isFrom = (nick: string, command: string, rest: string) => (text: string) =>
  text.startsWith(`:${nick}!`) && text.includes(` ${command} `) && text.endsWith(rest);

/**
 * A `QUIT` with the proof's reason, which ngircd puts in quotes of its own.
 * @param nick - Who quit.
 * @returns Whether a Line heard is that.
 */
export const isQuit = (nick: string) => isFrom(nick, "QUIT", `:"${quitReason}"`);

/** A data directory, and the key `iirc key create` made there before any Daemon ran. */
export interface Home {
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

/**
 * A new data directory, and its first key. AUTH-4: the first key needs the data
 * directory to itself, so it comes before the Daemon.
 */
export const newHome = Effect.gen(function* () {
  const dataDir = yield* newDataDir;

  return { dataDir, key: yield* createKey(binary, dataDir) } satisfies Home;
});

/** The most Entries one read asks for. */
export const pageSize = 1000;

/**
 * Every Entry in the Log, page by page.
 * @param client - The Daemon's client.
 * @param id - The Network to read, or none for all of them.
 * @returns The Entries, oldest first.
 */
export const allEntries = (client: Client, id?: string) =>
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
export const runDaemon = Effect.fnUntraced(function* (home: Home) {
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

/** A Daemon that {@link runDaemon} started. */
export type Running = Effect.Success<ReturnType<typeof runDaemon>>;

/**
 * One Network on a private ngircd, with the proof's quit reason and brisk Tuning.
 * @param options - What the check cares about.
 * @returns The whole settings.
 */
export const floorNetwork = (
  options: Omit<TestNetwork, "host" | "quitReason"> & { readonly host?: string }
): NetworkSettings =>
  settingsFor({
    host: loopback,
    quitReason,
    ...options,
    tuning: { ...brisk, ...options.tuning },
  });

/**
 * Adds a Network through the API.
 * @param running - The Daemon.
 * @param settings - The Network.
 * @returns The Change that added it.
 */
export const addNetwork = (running: Running, settings: NetworkSettings) =>
  running.client.networks.add({ payload: settings });

/**
 * Waits for a Session that is in a Channel.
 * @param status - How to read the Network's status.
 * @param channel - The Channel.
 * @returns The status once it shows that.
 */
export const untilJoined = <E, R>(status: Effect.Effect<Status, E, R>, channel: string) =>
  waitFor(`${channel} to be joined`, status, ({ joined, phase }) => {
    const isIn = joined.includes(channel);

    return phase === "session" && isIn;
  });

/**
 * The Lines among some Entries.
 * @param entries - The Entries.
 * @returns Only the Lines.
 */
export const lineEntries = (entries: readonly LogEntry[]) =>
  entries.flatMap((entry) => (entry._tag === "Line" ? [entry] : []));
