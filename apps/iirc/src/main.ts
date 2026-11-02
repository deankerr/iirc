#!/usr/bin/env bun
import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import { KeyName, KeyScope } from "@iirc/api";
import { createLocalKey, Daemon, DaemonCore, frontendWaitMillis } from "@iirc/daemon";
import { ApiRoutes } from "@iirc/daemon/routes";
import { Cause, Config, Console, Duration, Effect, Exit, Layer, Runtime, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { HttpRouter } from "effect/http";

import { version } from "../package.json";
import { described, failed, reportedOnStderr } from "./command-failed.ts";
import { config } from "./config-command.ts";
import { backup, credential } from "./credential-command.ts";

// AUTH-5: the API listens on loopback, and remote access goes through a proxy.
const apiHost = "127.0.0.1";

const Port = Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 1 }));

// CONF-4: the process needs only somewhere to keep the Log and somewhere to listen.
const dataDir = Flag.String("data-dir").pipe(
  Flag.withDescription("Directory holding the Log"),
  Flag.withFallbackConfig(Config.String("IIRC_DATA_DIR"))
);

const daemon = Command.make(
  "daemon",
  {
    dataDir,
    httpPort: Flag.Int("http-port").pipe(
      Flag.withFallbackConfig(Config.Int("IIRC_HTTP_PORT")),
      Flag.withSchema(Port),
      Flag.withDescription("Loopback port the API listens on (IIRC_HTTP_PORT)"),
      Flag.withDefault(7667)
    ),
  },
  ({ dataDir: directory, httpPort }) =>
    Daemon.stopsFirst.pipe(
      Layer.provide(
        HttpRouter.serve(ApiRoutes, { disableLogger: true }).pipe(
          Layer.provide(
            BunHttpServer.layer({
              gracefulShutdownTimeout: Duration.millis(frontendWaitMillis),
              hostname: apiHost,
              port: httpPort,
            })
          )
        )
      ),
      // Outside `serve`, which forks the MemoMap.
      Layer.provide(DaemonCore({ dataDir: directory, version })),
      Layer.launch,
      // A refusal to start is one line on stderr, and an exit that says it failed.
      Effect.mapError((error) => {
        switch (error._tag) {
          case "DataDirectoryLocked": {
            return failed(`${error.message}, most likely another Daemon. Only one may run on it.`);
          }

          case "StorageFailed": {
            return failed(
              `The Log in ${directory} could not be opened or read: ${described(error.cause)}`
            );
          }

          case "CredentialsUnreadable":
          case "LogTooNew":
          case "UndecodableChange": {
            return failed(described(error));
          }

          case "ServeError": {
            return failed(
              `The API could not listen on ${apiHost}:${httpPort}: ${described(error.cause ?? error)}`
            );
          }

          default: {
            return error satisfies never;
          }
        }
      }),
      // Bun's server throws when it cannot listen, such as on a port in use.
      Effect.catchDefect((defect) =>
        Effect.fail(failed(`The Daemon failed: ${described(defect)}`))
      ),
      reportedOnStderr
    )
).pipe(Command.withDescription("Stay on every configured Network and expose them over the API"));

const keyCreate = Command.make(
  "create",
  {
    dataDir,
    name: Flag.String("name").pipe(
      Flag.withSchema(KeyName),
      Flag.withDescription("Name the key's actions are recorded under, such as `phone`")
    ),
    scope: Flag.Literals("scope", KeyScope.literals).pipe(
      Flag.withDescription("What the key may do: read, chat, or admin"),
      Flag.withDefault("admin")
    ),
  },
  ({ dataDir: directory, name, scope }) =>
    createLocalKey({ dataDir: directory, name, scope }).pipe(
      // Every refusal goes to stderr, so `KEY=$(iirc key create …)` never holds one.
      Effect.mapError((error) => {
        switch (error._tag) {
          case "DataDirectoryLocked": {
            return failed(
              `The data directory ${directory} is locked, most likely by a running Daemon. Stop the Daemon first, or create the key through the API with an admin key.`
            );
          }

          case "KeyExists": {
            return failed(
              `A key named ${name} already exists. Choose another name, or revoke that key through the API first.`
            );
          }

          case "LogTooNew": {
            return failed(`${error.message} No key was made.`);
          }

          case "StorageFailed": {
            return failed(
              `The Log in ${directory} could not be read or written, so no key was made: ${described(error.cause)}`
            );
          }

          case "UndecodableChange": {
            return failed(
              `The Log in ${directory} holds a Change at sequence ${error.sequence} that this iirc cannot read, so no key was made: ${described(error.reason)}`
            );
          }

          default: {
            return error satisfies never;
          }
        }
      }),
      // The key itself, alone on stdout, because nothing will ever show it again (AUTH-2).
      Effect.flatMap((key) => Console.log(key)),
      reportedOnStderr
    )
).pipe(
  Command.withDescription(
    "Create an API key straight into the Log, which needs the Daemon stopped (AUTH-4)"
  )
);

const key = Command.make("key").pipe(
  Command.withDescription("Manage API keys"),
  Command.withSubcommands([keyCreate])
);

const iirc = Command.make("iirc").pipe(
  Command.withDescription("An always-on IRC client"),
  Command.withSubcommands([backup, config, credential, daemon, key])
);

// `runMain` interrupts main on SIGINT and SIGTERM, which is how a Daemon is asked to stop,
// so here an interrupt is a clean exit, and the default would call it 130.
const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
    onExit(0);
  } else {
    Runtime.defaultTeardown(exit, onExit);
  }
};

Command.run(iirc, { version }).pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain({ teardown })
);
