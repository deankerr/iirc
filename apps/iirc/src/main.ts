#!/usr/bin/env bun
/**
 * `iirc`: one executable whose arguments choose what it runs (ADR 0007).
 *
 * @packageDocumentation
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  createKey,
  DataDirectoryFailed,
  holdDataDirectory,
  KeyName,
  layerDaemon,
  layerLogger,
  version,
} from "@iirc/daemon";
import type { Beside } from "@iirc/daemon";
import { Cause, Console, Effect, Exit, FileSystem, Layer, Option, Redacted, Runtime } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { Digest, SecureRandom } from "effect/crypto";

import { failed, reportedOnStderr } from "./command-failed.ts";
import { health } from "./health.ts";
import { listenFlag } from "./listen.ts";
import { layerWeb } from "./web.ts";
import type { WebSource } from "./web.ts";

const dataDir = Flag.String("data-dir").pipe(
  Flag.withDescription("Directory that holds the journal, credentials, and API keys")
);

/**
 * Makes the data directory if it is missing, owner-only.
 * @param directory - The data directory.
 * @returns An Effect that makes it.
 */
const makeDataDirectory = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    yield* fs
      .makeDirectory(directory, { mode: 0o700, recursive: true })
      .pipe(
        Effect.mapError(
          (error) => new DataDirectoryFailed({ dataDir: directory, reason: error.message })
        )
      );
  });

const daemon = Command.make(
  "daemon",
  {
    dataDir,
    listen: listenFlag("Address the API listens on. Use loopback unless a proxy sits in front"),
    web: Flag.String("web").pipe(
      // A bare `--web` reads as `--web=`, an empty path, which names no directory: the
      // build compiled into this executable.
      Flag.withOptionalValue(""),
      Flag.map((value): WebSource =>
        value === "" ? { _tag: "Embedded" } : { _tag: "Directory", directory: value }
      ),
      Flag.withMetavar("dir"),
      Flag.withDescription(
        "Also serve the web app on the API's address: the built-in one, or the one in =<dir>"
      ),
      Flag.optional
    ),
  },
  ({ dataDir: directory, listen, web }) =>
    Effect.gen(function* () {
      // The web frontend's directory is checked before anything else is opened.
      const beside: Beside<never> = Option.isSome(web) ? yield* layerWeb(web.value) : Layer.empty;

      return yield* Layer.launch(layerDaemon({ dataDir: directory }, listen, beside));
    }).pipe(
      Effect.mapError((error) => {
        switch (error._tag) {
          case "WebFrontendUnusable": {
            return failed(
              `The web app in ${error.directory} could not be served: ${error.reason}.`
            );
          }

          case "WebFrontendNotEmbedded": {
            return failed(
              "This build of iirc has no built-in web app, so --web needs a directory, such as --web=apps/web/dist."
            );
          }

          case "DataDirectoryLocked": {
            return failed(
              `The data directory ${directory} is in use by another process, most likely another daemon. Only one daemon can use it.`
            );
          }

          case "DataDirectoryFailed": {
            return failed(`Could not use the data directory ${directory}: ${error.reason}`);
          }

          case "KeysUnreadable": {
            return failed(`Could not read the API keys in ${error.path}: ${error.reason}`);
          }

          case "SignInsUnreadable": {
            return failed(`Could not read the sign-ins in ${error.path}: ${error.reason}`);
          }

          case "SignInsUnwritable": {
            return failed(`Could not write the sign-ins in ${error.path}: ${error.reason}`);
          }

          case "JournalFailed": {
            return failed(`Could not open or read the journal in ${directory}: ${error.reason}`);
          }

          case "JournalVersionMismatch": {
            return failed(
              `The journal in ${directory} is version ${error.found}, but this iirc reads version ${error.expected}. Nothing was changed.`
            );
          }

          case "TimelineStoreFailed": {
            return failed(
              `Could not open the conversation history in ${directory}/views.sqlite: ${error.reason}. It is rebuilt from the journal, so you can remove the file.`
            );
          }

          case "PreviewCacheFailed": {
            return failed(
              `Could not open the preview cache in ${directory}/previews.sqlite: ${error.reason}. You can remove the file; previews are fetched again.`
            );
          }

          case "DecodersMissing": {
            return failed(
              `This runtime cannot decode ${error.missing.join(", ")}, so it would read the journal incorrectly.`
            );
          }

          case "ServeError": {
            return failed(`Could not listen on ${listen.host}:${listen.port}.`);
          }

          default: {
            return error satisfies never;
          }
        }
      }),
      // Bun's server throws when it cannot listen, such as on a port in use.
      Effect.catchDefect(() =>
        Effect.fail(failed(`Could not listen on ${listen.host}:${listen.port}.`))
      ),
      reportedOnStderr
    )
).pipe(Command.withDescription("Stay connected to every configured network and serve the API"));

const keyCreate = Command.make(
  "create",
  {
    dataDir,
    name: Argument.String("name").pipe(
      Argument.withSchema(KeyName),
      Argument.withDescription("Name for the key, such as `phone` or `agent`")
    ),
  },
  ({ dataDir: directory, name }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* makeDataDirectory(directory);
        yield* holdDataDirectory(directory);

        return yield* createKey(directory, name);
      })
    ).pipe(
      Effect.provide(Layer.mergeAll(Digest.layerWebCrypto, SecureRandom.layerWebCrypto)),
      // Every refusal goes to stderr, so `KEY=$(iirc key create …)` never holds one.
      Effect.mapError((error) => {
        switch (error._tag) {
          case "DataDirectoryLocked": {
            return failed(
              `The data directory ${directory} is in use, most likely by a running daemon. Stop the daemon first: you can only create keys while it is stopped.`
            );
          }

          case "DataDirectoryFailed": {
            return failed(`Could not use the data directory ${directory}: ${error.reason}`);
          }

          case "KeyExists": {
            return failed(`A key named ${error.key} already exists. Choose another name.`);
          }

          case "KeysUnreadable": {
            return failed(
              `Could not read the API keys in ${error.path}, so no key was created: ${error.reason}`
            );
          }

          case "KeysUnwritable": {
            return failed(
              `Could not write the API keys in ${error.path}, so no key was created: ${error.reason}`
            );
          }

          default: {
            return error satisfies never;
          }
        }
      }),
      // The key alone on stdout, because nothing will show it again.
      Effect.flatMap((key) => Console.log(Redacted.value(key))),
      reportedOnStderr
    )
).pipe(Command.withDescription("Create an API key and print it once. The daemon must be stopped."));

const key = Command.make("key").pipe(
  Command.withDescription("Manage API keys"),
  Command.withSubcommands([keyCreate])
);

const iirc = Command.make("iirc").pipe(
  Command.withDescription("An always-on IRC client"),
  Command.withSubcommands([daemon, health, key])
);

// `runMain` interrupts main on SIGINT and SIGTERM, which is how a Daemon is asked to stop,
// so an interrupt is a clean exit, where the default would say 130.
const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
    onExit(0);
  } else {
    Runtime.defaultTeardown(exit, onExit);
  }
};

Command.run(iirc, { version }).pipe(
  Effect.provide(Layer.merge(BunServices.layer, layerLogger)),
  BunRuntime.runMain({ teardown })
);
