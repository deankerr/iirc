import { BunHttpServer } from "@effect/platform-bun";
import { DaemonApi, defaultServices } from "@iirc/api";
import type { KeyScope, LoggedMessage, NetworkSettings } from "@iirc/api";
import { createLocalKey, Daemon, DaemonCore } from "@iirc/daemon";
import { ApiRoutes } from "@iirc/daemon/routes";
import { eventually } from "@iirc/session/testing";
import { Effect, FileSystem, Layer, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

import { freePort, privateNgircd } from "./ngircd.fixture.ts";
import { send } from "./send.ts";

// Two real Daemons on one private ngircd, in this process, each with a Log of its own, and
// the soak commands run as the processes they are on a timer.

/** The network both Daemons configure, and the Channel they share. */
export const network = "floor";
export const channel = "#soak";

// From source by default. `IIRC_SOAK_BINARY` runs the compiled `iirc-soak` instead, which
// is how to prove the build keeps working.
const [program, ...programArguments] =
  process.env.IIRC_SOAK_BINARY === undefined
    ? [process.execPath, `${import.meta.dirname}/main.ts`]
    : [process.env.IIRC_SOAK_BINARY];

// Quick to reconnect and to leave, and quick to join after the burst, so that no test
// here waits on the spec's numbers.
const brisk = {
  drainMillis: 50,
  quitWaitMillis: 100,
  reconnectInitialMillis: 50,
  reconnectMaxMillis: 50,
  rejoinSettleMillis: 0,
};

// No keyring, as on fserv, so that a test keeps Credentials in a file and never touches
// the Owner's own keyring.
const noKeyring = {
  get: async () => await Promise.reject(new Error("no keyring here")),
  set: async () => {
    await Promise.reject(new Error("no keyring here"));
  },
};

const settingsFor = (nick: string, ircd: { host: string; port: number }): NetworkSettings => ({
  channels: [{ autojoin: true, name: channel, rejoinOnKick: false }],
  connectCommands: [],
  credentials: {},
  enabled: true,
  id: network,
  identity: { alternates: [], nick, realname: "iirc soak", username: "soak" },
  ircds: [{ host: ircd.host, port: ircd.port, tls: false }],
  name: network,
  quitReason: "soak test over",
  services: [...defaultServices],
  tuning: brisk,
});

const limit = "30 seconds";

/** One Daemon of the world: its API, the key the commands use, and an `admin` client. */
const daemonNamed = Effect.fnUntraced(function* (
  name: string,
  scope: KeyScope,
  ircd: { host: string; port: number }
) {
  const fileSystem = yield* FileSystem.FileSystem;

  // Not `/tmp`, which is tmpfs here, where fsync means nothing.
  const dataDir = yield* fileSystem.makeTempDirectoryScoped({
    directory: "/var/tmp",
    prefix: `iirc-soak-${name}-`,
  });

  // The test drives its Daemons with an `admin` key, and the commands run with the least
  // scope each needs, as the units do: `chat` to send, and `read` to read.
  const owner = yield* Effect.orDie(createLocalKey({ dataDir, name: "owner", scope: "admin" }));
  const key = yield* Effect.orDie(createLocalKey({ dataDir, name: "soak", scope }));
  const port = yield* freePort;

  // In the order `apps/iirc` has, with the Daemon outside the router that serves it.
  yield* Layer.build(
    Daemon.stopsFirst.pipe(
      Layer.provide(
        HttpRouter.serve(ApiRoutes, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port }))
        )
      ),
      Layer.provide(DaemonCore({ dataDir, version: "0.0.0-soak-test" }, { keyring: noKeyring }))
    )
  );

  const url = `http://127.0.0.1:${port}`;

  const client = yield* HttpApiClient.make(DaemonApi, {
    baseUrl: url,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(owner)),
  }).pipe(Effect.provide(FetchHttpClient.layer));

  yield* client.networks.add({ payload: settingsFor(name, ircd) });

  const status = Effect.map(client.daemon.status(), ({ networks }) =>
    networks.find(({ id }) => id === network)
  );

  const joined = eventually(
    status,
    (found) => found?.phase === "session" && found.joined.includes(channel),
    limit
  );

  // Off the Network for good, not on the way: while it is `closing`, its `QUIT` has not
  // reached the Ircd, which still routes the Channel's Messages to it.
  const left = eventually(
    status,
    (found) => found?.phase === "closed" || found?.phase === "idle",
    limit
  );

  return { client, joined, key, left, name, status, url };
});

/** A Daemon of the world. */
export type World = Effect.Success<ReturnType<typeof daemonNamed>>;

/**
 * Two Daemons, `soak-a` the sender and `soak-b` the receiver, each in the Channel on one
 * private ngircd.
 * @returns Both, once they have joined.
 */
export const twoDaemons = Effect.gen(function* () {
  const ircd = yield* privateNgircd;
  const sender = yield* daemonNamed("soak-a", "chat", ircd);
  const receiver = yield* daemonNamed("soak-b", "read", ircd);

  yield* sender.joined;
  yield* receiver.joined;

  return { receiver, sender };
});

const collect = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString, Effect.orDie);

/** What a command printed, and how it ended. */
interface Ran {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

/**
 * Runs `iirc-soak` as a process with only the environment it is given.
 * @param flags - Its arguments.
 * @param environment - All of its environment, but for `PATH`.
 * @returns How it ended and what it said.
 */
export const soak = (flags: readonly string[], environment: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const child = yield* spawner.spawn(
      ChildProcess.make(program ?? process.execPath, [...programArguments, ...flags], {
        env: { PATH: process.env.PATH, ...environment },
        extendEnv: false,
        stdin: "ignore",
      })
    );

    const [stdout, stderr, code] = yield* Effect.all(
      [collect(child.stdout), collect(child.stderr), child.exitCode],
      { concurrency: "unbounded" }
    );

    return { code: Number(code), stderr, stdout } satisfies Ran;
  }).pipe(Effect.scoped, Effect.orDie);

/**
 * `iirc-soak send` to the Channel on the Network both Daemons share.
 * @param sender - The sender.
 * @returns How it ended and what it said.
 */
export const sendOnce = (sender: Pick<World, "key" | "url">) =>
  soak(["send", "--daemon", sender.url, "--pair", `${network}=${channel}`], {
    IIRC_KEY: sender.key,
  });

/**
 * Runs `send` in this process as if the minute were `minute`, which is what a timer a
 * minute apart does, without waiting for the minutes to pass.
 * @param sender - The sender.
 * @param minute - The Unix minute the run takes to be its own.
 * @returns Nothing, once the Message is sent.
 */
export const sendInMinute = (sender: Pick<World, "client" | "url">, minute: number) =>
  Effect.andThen(
    TestClock.setTime(minute * 60_000),
    send(sender.client, sender.url, [{ network, target: channel }])
  ).pipe(Effect.provide(TestClock.layer()), Effect.orDie);

/**
 * The Unix minute it is now.
 * @returns The minute.
 */
export const currentMinute = () => Math.floor(Date.now() / 60_000);

/**
 * `iirc-soak check` of the Channel, with nothing given time to arrive, because a test
 * waits for each Message instead.
 * @param receiver - The receiver.
 * @param sender - The sender.
 * @param more - More flags.
 * @returns How it ended and what it said.
 */
export const checkOnce = (
  receiver: Pick<World, "key" | "url">,
  sender: Pick<World, "key" | "url">,
  more: readonly string[] = []
) =>
  soak(
    [
      "check",
      "--sender",
      sender.url,
      "--receiver",
      receiver.url,
      "--pair",
      `${network}:${network}=${channel}`,
      "--settle",
      "0",
      ...more,
    ],
    { IIRC_RECEIVER_KEY: receiver.key, IIRC_SENDER_KEY: sender.key }
  );

/**
 * Whether a Message is one of the sender's counted ones: a `PRIVMSG`, never an `ACTION`
 * that happens to read like one (MSG-1).
 * @param message - A Message from `/messages`.
 * @returns Whether it counts.
 */
export const isCounted = ({ kind, text }: LoggedMessage) =>
  kind === "PRIVMSG" && text.startsWith("soak ");

/**
 * Waits for the receiver's Log to hold this many counted Messages from the sender.
 * @param receiver - The receiver.
 * @param count - How many.
 * @returns Nothing, once it does.
 */
export const heardCount = (receiver: Pick<World, "client">, count: number) =>
  eventually(
    Effect.map(
      receiver.client.daemon.messages({ query: { after: 0, limit: 1000, network } }),
      (messages) => messages.filter(isCounted).length
    ),
    (heard) => heard >= count,
    limit
  );
