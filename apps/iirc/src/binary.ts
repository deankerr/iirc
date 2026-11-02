import { Database } from "bun:sqlite";

import { DaemonApi, defaultServices } from "@iirc/api";
import type { NetworkSettings, NetworkStatus } from "@iirc/api";
import type { Tuning } from "@iirc/lifecycle/tuning";
import { Effect, Fiber, Schedule, Stream } from "effect";
import { constVoid } from "effect/Function";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** Where this package's sources sit above. */
export const appRoot = `${import.meta.dirname}/..`;

/** Asks the kernel for a port nothing is using. */
export const freePort = Effect.acquireUseRelease(
  Effect.sync(() => Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: constVoid } })),
  ({ port }) => Effect.succeed(port),
  (listening) =>
    Effect.sync(() => {
      listening.stop(true);
    })
);

/**
 * Starts a binary in the enclosing scope, which kills whatever is left of it, and keeps
 * everything it prints, on each stream and both together. The environment is empty so that nothing leaks in.
 * @param binary - The binary to run.
 * @param flags - Its arguments.
 * @param environment - All of its environment, but for `PATH`.
 * @param stdin - What to give it on stdin, which it then reads to its end, if anything.
 * @returns The child, and what it has printed so far.
 */
export const startBinary = Effect.fnUntraced(function* (
  binary: string,
  flags: readonly string[],
  environment: Readonly<Record<string, string>>,
  stdin?: string
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];

  const child = yield* spawner.spawn(
    ChildProcess.make(binary, flags, {
      env: { PATH: process.env.PATH, ...environment },
      extendEnv: false,
      ...(stdin !== undefined && { stdin: Stream.make(new TextEncoder().encode(stdin)) }),
    })
  );

  // Each stream on its own, because only a key may go to stdout (AUTH-4), and both
  // together in the order they came.
  const keep = (stream: typeof child.stdout, own: string[]) =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runForEach((text) =>
        Effect.sync(() => {
          output.push(text);
          own.push(text);
        })
      ),
      Effect.ignore
    );

  const reader = yield* Effect.all([keep(child.stdout, stdout), keep(child.stderr, stderr)], {
    concurrency: "unbounded",
    discard: true,
  }).pipe(Effect.forkScoped);

  return {
    child,
    output: () => output.join(""),
    reader,
    stderr: () => stderr.join(""),
    stdout: () => stdout.join(""),
  };
});

/**
 * Reads the end of a Log no Daemon has open, one word for each Entry: a Line's text, or
 * an Entry's kind and phase. What a stopped Daemon left is out of reach of its API.
 * @param dataDir - The Daemon's data directory.
 * @param length - How many Entries to read.
 * @returns The last Entries, oldest first.
 */
export const logTail = (dataDir: string, length: number) =>
  Effect.sync(() => {
    const database = new Database(`${dataDir}/iirc.sqlite`, { readonly: true });

    const rows = database
      .query<{ bytes: Uint8Array | null; kind: string; phase: string | null }, [number]>(
        "SELECT bytes, kind, phase FROM entries ORDER BY sequence DESC LIMIT ?"
      )
      .all(length);

    database.close();

    return rows
      .toReversed()
      .map(({ bytes, kind, phase }) =>
        kind === "Line" ? Buffer.from(bytes ?? []).toString("latin1") : `${kind} ${phase}`
      );
  });

/** The name of the key a test makes first, which its actions are recorded under (LOG-5). */
export const ownerKey = "owner";

/**
 * Makes the first key with `iirc key create`, as the Owner would before the first start
 * (AUTH-4), and reads it from stdout.
 * @param binary - The binary.
 * @param dataDir - The Daemon's data directory, which no Daemon may hold.
 * @returns The key.
 */
export const createKey = (binary: string, dataDir: string) =>
  Effect.gen(function* () {
    const running = yield* startBinary(
      binary,
      ["key", "create", "--data-dir", dataDir, "--name", ownerKey],
      {}
    );

    const code = Number(yield* running.child.exitCode);

    yield* Fiber.join(running.reader);

    const output = running.output().trim();

    return code === 0 && /^iirc_[A-Za-z0-9_-]{43}$/u.test(output)
      ? output
      : yield* Effect.die(new Error(`iirc key create exited with ${code}:\n${output}`));
  }).pipe(Effect.scoped);

/** One Network's settings, as a binary test wants them, with everything else defaulted. */
export interface TestNetwork {
  readonly alternates?: readonly string[];
  readonly channels?: readonly string[];
  readonly connectCommands?: readonly string[];
  readonly credentials?: NetworkSettings["credentials"];
  readonly host: string;
  readonly id: string;
  readonly nick: string;
  readonly pin?: string;
  readonly port: number;
  readonly quitReason?: string;
  readonly realname?: string;
  readonly tls?: boolean;
  readonly tuning?: Partial<Tuning>;
  readonly username?: string;
}

/**
 * Settings for a Network, as `POST /networks` takes them. Plaintext unless asked, because
 * most test Ircds speak it.
 * @param network - What the test cares about.
 * @returns The whole settings.
 */
export const settingsFor = (network: TestNetwork): NetworkSettings => ({
  channels: (network.channels ?? []).map((name) => ({ autojoin: true, name, rejoinOnKick: false })),
  connectCommands: network.connectCommands ?? [],
  credentials: network.credentials ?? {},
  enabled: true,
  id: network.id,
  identity: {
    alternates: network.alternates ?? [],
    nick: network.nick,
    realname: network.realname ?? "iirc",
    username: network.username ?? "iirc",
  },
  ircds: [
    {
      host: network.host,
      port: network.port,
      tls: network.tls ?? false,
      ...(network.pin !== undefined && { pin: network.pin }),
    },
  ],
  name: network.id,
  quitReason: network.quitReason ?? "iirc",
  services: [...defaultServices],
  tuning: network.tuning ?? {},
});

/**
 * Builds a client for a Daemon's API that sends a key with every request (AUTH-6), once
 * that API is answering.
 * @param httpPort - The Daemon's API port.
 * @param key - The key.
 * @returns The client.
 */
export const healthyClient = (httpPort: number, key: string) =>
  Effect.tap(
    HttpApiClient.make(DaemonApi, {
      baseUrl: `http://127.0.0.1:${httpPort}`,
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(key)),
    }),
    ({ health }) =>
      health
        .health()
        .pipe(Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 250 }), Effect.orDie)
  );

/** A client of a Daemon's API. */
export type Client = Effect.Success<ReturnType<typeof healthyClient>>;

/**
 * One Network's part of `/status`.
 * @param client - The client.
 * @param id - The Network.
 * @returns Its status, which a test that has added it can rely on being there.
 */
export const networkStatus = (client: Client, id: string) =>
  Effect.flatMap(client.daemon.status(), ({ networks }) => {
    const found = networks.find((network) => network.id === id);

    return found === undefined
      ? Effect.die(new Error(`${id} is not in /status`))
      : Effect.succeed<NetworkStatus>(found);
  });
