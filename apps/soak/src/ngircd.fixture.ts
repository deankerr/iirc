import { homedir } from "node:os";
import path from "node:path";

import { assert } from "@effect/vitest";
import { eventually } from "@iirc/session/testing";
import { Effect, FileSystem, Stream } from "effect";
import { constVoid } from "effect/Function";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// PROOF-5 on a real Ircd: a private ngircd on a loopback port of its own, started by this
// test and killed with its scope. It is never the ngircd anyone else is using, and it
// cannot be, because it listens only where the kernel just said nothing does.

/** Where this machine keeps ngircd. Set `IIRC_NGIRCD` to use another. */
const ngircd = process.env.IIRC_NGIRCD ?? path.join(homedir(), ".local/opt/ngircd/ngircd");

const serverName = "soak.test";

const loopback = "127.0.0.1";

const listenLimit = "30 seconds";

/** Asks the kernel for a port nothing is using. */
export const freePort = Effect.acquireUseRelease(
  Effect.sync(() => Bun.listen({ hostname: loopback, port: 0, socket: { data: constVoid } })),
  ({ port }) => Effect.succeed(port),
  (listening) =>
    Effect.sync(() => {
      listening.stop(true);
    })
);

/**
 * Starts a private ngircd that takes plain connections on loopback.
 * @returns Where it listens, once it does, for as long as the scope lasts.
 */
export const privateNgircd = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "iirc-soak-ircd-" });
  const port = yield* freePort;
  const config = path.join(directory, "ngircd.conf");
  const logged: string[] = [];

  yield* fileSystem.writeFileString(
    config,
    [
      "[Global]",
      `Name = ${serverName}`,
      "Info = iirc soak test",
      `Listen = ${loopback}`,
      `Ports = ${port}`,
      "AdminInfo1 = iirc soak test",
      "AdminInfo2 = loopback only",
      "AdminEMail = nobody@soak.test",
      'MotdPhrase = "soak"',
      "[Limits]",
      "MaxConnectionsIP = 0",
      "[Options]",
      "DNS = no",
      "Ident = no",
      "PAM = no",
      "",
    ].join("\n")
  );

  const configured = yield* spawner.exitCode(
    ChildProcess.make(ngircd, ["--configtest", "--config", config], {
      cwd: directory,
      stdin: "ignore",
    })
  );

  assert.strictEqual(Number(configured), 0, `ngircd refused its configuration: exit ${configured}`);

  const child = yield* spawner.spawn(
    ChildProcess.make(ngircd, ["--nodaemon", "--config", config], {
      cwd: directory,
      killSignal: "SIGKILL",
      stdin: "ignore",
    })
  );

  yield* child.all.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) =>
      Effect.sync(() => {
        logged.push(text);
      })
    ),
    Effect.ignore,
    Effect.forkScoped
  );

  yield* eventually(
    Effect.sync(() => logged.join("")),
    (text) => text.includes(`Server "${serverName}"`),
    listenLimit
  );

  return { host: loopback, port };
});
