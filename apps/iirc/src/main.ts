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
  defaultListen,
  holdDataDirectory,
  KeyName,
  layerDaemon,
  layerLogger,
} from "@iirc/daemon";
import type { Beside, Listen } from "@iirc/daemon";
import {
  Cause,
  Console,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Runtime,
  Schema,
  SchemaGetter,
} from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { Digest, SecureRandom } from "effect/crypto";

import { failed, reportedOnStderr } from "./command-failed.ts";
import { layerWeb } from "./web.ts";
import type { WebSource } from "./web.ts";

/** `host:port`, with an IPv6 host in brackets, such as `[::1]:7667`. */
const ListenAddress = Schema.String.check(
  Schema.isPattern(/^(?:\[[0-9A-Fa-f:.]+\]|[^\s:[\]]+):\d{1,5}$/u, {
    message: "must be host:port, such as 127.0.0.1:7667 or [::1]:7667",
  })
).pipe(
  Schema.decodeTo(
    Schema.Struct({
      host: Schema.String,
      port: Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 0 })),
    }),
    {
      decode: SchemaGetter.transform((text: string) => {
        const colon = text.lastIndexOf(":");

        return {
          host: text.slice(0, colon).replace(/^\[(?<inner>.*)\]$/u, "$<inner>"),
          port: Number(text.slice(colon + 1)),
        };
      }),
      encode: SchemaGetter.transform(({ host, port }: Listen) =>
        host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`
      ),
    }
  )
);

const dataDir = Flag.String("data-dir").pipe(
  Flag.withDescription("Directory holding the Journal, the Credentials, and the API keys")
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
    listen: Flag.String("listen").pipe(
      Flag.withSchema(ListenAddress),
      Flag.withDescription("Where the API listens, loopback unless a proxy fronts it"),
      Flag.withDefault(defaultListen)
    ),
    web: Flag.String("web").pipe(
      // A bare `--web` reads as `--web=`, an empty path, which names no directory: the
      // build compiled into this executable.
      Flag.withOptionalValue(""),
      Flag.map((value): WebSource =>
        value === "" ? { _tag: "Embedded" } : { _tag: "Directory", directory: value }
      ),
      Flag.withMetavar("dir"),
      Flag.withDescription(
        "Also serve the web frontend on the API's origin: the one built in, or the one built into =<dir>"
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
              `The web frontend in ${error.directory} could not be served: ${error.reason}. Build it with bun run build:web.`
            );
          }

          case "WebFrontendNotEmbedded": {
            return failed(
              "This iirc carries no web frontend of its own, so --web needs a directory, such as --web=apps/web/dist."
            );
          }

          case "DataDirectoryLocked": {
            return failed(
              `The data directory ${directory} is held by another process, most likely another Daemon. Only one may run on it.`
            );
          }

          case "DataDirectoryFailed": {
            return failed(`The data directory ${directory} could not be used: ${error.reason}`);
          }

          case "KeysUnreadable": {
            return failed(`The API keys in ${error.path} could not be read: ${error.reason}`);
          }

          case "SignInsUnreadable": {
            return failed(`The sign-ins in ${error.path} could not be read: ${error.reason}`);
          }

          case "SignInsUnwritable": {
            return failed(`The sign-ins in ${error.path} could not be written: ${error.reason}`);
          }

          case "JournalFailed": {
            return failed(
              `The Journal in ${directory} could not be opened or read: ${error.reason}`
            );
          }

          case "JournalVersionMismatch": {
            return failed(
              `The Journal in ${directory} is version ${error.found}, and this iirc reads version ${error.expected}. Nothing was changed.`
            );
          }

          case "TimelineStoreFailed": {
            return failed(
              `The Timelines in ${directory}/views.sqlite could not be opened: ${error.reason}. They are derived from the Journal, so removing the file rebuilds them.`
            );
          }

          case "DecodersMissing": {
            return failed(
              `This runtime cannot decode ${error.missing.join(", ")}, so it would read the Journal wrongly. Run iirc on the Bun it was built for.`
            );
          }

          case "ServeError": {
            return failed(`The API could not listen on ${listen.host}:${listen.port}.`);
          }

          default: {
            return error satisfies never;
          }
        }
      }),
      // Bun's server throws when it cannot listen, such as on a port in use.
      Effect.catchDefect(() =>
        Effect.fail(failed(`The API could not listen on ${listen.host}:${listen.port}.`))
      ),
      reportedOnStderr
    )
).pipe(Command.withDescription("Stay on every configured Network, and serve the API"));

const keyCreate = Command.make(
  "create",
  {
    dataDir,
    name: Argument.String("name").pipe(
      Argument.withSchema(KeyName),
      Argument.withDescription("Whose key it is, such as `phone` or `agent`")
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
              `The data directory ${directory} is held, most likely by a running Daemon. Stop it first: keys are created only while it is stopped.`
            );
          }

          case "DataDirectoryFailed": {
            return failed(`The data directory ${directory} could not be used: ${error.reason}`);
          }

          case "KeyExists": {
            return failed(`A key named ${error.key} already exists. Choose another name.`);
          }

          case "KeysUnreadable": {
            return failed(
              `The API keys in ${error.path} could not be read, so no key was made: ${error.reason}`
            );
          }

          case "KeysUnwritable": {
            return failed(
              `The API keys in ${error.path} could not be written, so no key was made: ${error.reason}`
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
).pipe(Command.withDescription("Create an API key and print it once. The Daemon must be stopped."));

const key = Command.make("key").pipe(
  Command.withDescription("Manage API keys"),
  Command.withSubcommands([keyCreate])
);

const iirc = Command.make("iirc").pipe(
  Command.withDescription("An always-on IRC client"),
  Command.withSubcommands([daemon, key])
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

Command.run(iirc, { version: "0.0.0" }).pipe(
  Effect.provide(Layer.merge(BunServices.layer, layerLogger)),
  BunRuntime.runMain({ teardown })
);
