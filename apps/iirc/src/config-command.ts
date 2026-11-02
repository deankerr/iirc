import { DaemonApi } from "@iirc/api";
import type {
  Configuration,
  Forbidden,
  InvalidRequest,
  LogUnavailable,
  Stopping,
  Unauthorized,
} from "@iirc/api";
import { Config, Console, Effect, Option, Redacted, Result } from "effect";
import type { Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientError } from "effect/http";
import { HttpApiClient } from "effect/http-api";

import { failed, reportedOnStderr } from "./command-failed.ts";
import type { CommandFailed } from "./command-failed.ts";
import {
  configurationToToml,
  describeIssue,
  inFile,
  parseConfigurationFile,
} from "./configuration-file.ts";
import type { FileIssue } from "./configuration-file.ts";

// CONF-6: `iirc config` is a Frontend like any other (API-1). It reaches the Daemon only
// through the API, with a key, and knows nothing a script could not.

/** Exit code for a command run wrongly, rather than one that failed. */
const usageExitCode = 2;

// CONF-4: a flag, or else the environment, or else where `iirc daemon` listens by default.
const apiUrl = Flag.String("api-url").pipe(
  Flag.withDescription("Where the Daemon's API listens (IIRC_API_URL)"),
  Flag.withFallbackConfig(Config.String("IIRC_API_URL")),
  Flag.withDefault("http://127.0.0.1:7667")
);

// Only from the environment, because a flag would show the key to anyone running `ps`.
const presentedKey = Effect.gen(function* () {
  const key = yield* Config.option(Config.Redacted("IIRC_KEY")).pipe(Effect.orDie);

  return Option.isSome(key) && Redacted.value(key.value) !== ""
    ? key.value
    : yield* failed(
        "No key: set IIRC_KEY to an API key, such as one `iirc key create` printed. It is read only from the environment, so that it never shows in `ps`.",
        usageExitCode
      );
});

const clientOf = (baseUrl: string) =>
  presentedKey.pipe(
    Effect.flatMap((key) =>
      HttpApiClient.make(DaemonApi, {
        baseUrl,
        transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(key)),
      })
    )
  );

const listed = (issues: readonly FileIssue[]) =>
  issues.map((issue) => `  ${describeIssue(issue)}`).join("\n");

/** Every way a call through the client can come back refused. */
type ApiFailure =
  | Forbidden
  | HttpClientError.HttpClientError
  | InvalidRequest
  | LogUnavailable
  | Schema.SchemaError
  | Stopping
  | Unauthorized;

/**
 * Puts a refusal in words that say what to do about it.
 * @param baseUrl - Where the Daemon was asked.
 * @param ids - The Networks of the file sent, in its order, so that a bad request can point
 * into the file rather than into the request made from it.
 * @returns The refusal, ready to print.
 */
const explain =
  (baseUrl: string, ids: readonly string[] = []) =>
  (error: ApiFailure): CommandFailed => {
    switch (error._tag) {
      case "Forbidden": {
        return failed(
          `The key in IIRC_KEY may not do this (403): it needs a key with the ${error.needed} scope.`
        );
      }

      case "HttpClientError": {
        return error.reason._tag === "TransportError"
          ? failed(
              `Could not reach the Daemon at ${baseUrl}. Is it running, and is --api-url right? (${error.message})`
            )
          : failed(
              `The Daemon at ${baseUrl} gave an answer this iirc cannot use: ${error.message}`
            );
      }

      case "InvalidRequest": {
        return failed(
          `The Daemon refused the request (400), so nothing changed:\n${listed(
            error.issues.map(({ message, path }) => ({
              message,
              path:
                path[0] === "payload" && path[1] === "networks" ? inFile(path.slice(2), ids) : path,
            }))
          )}`
        );
      }

      case "LogUnavailable": {
        return failed("The Daemon's Log is not available (503), so nothing changed.");
      }

      case "SchemaError": {
        return failed(
          `The Daemon at ${baseUrl} gave an answer this iirc cannot read: ${error.message}`
        );
      }

      case "Stopping": {
        return failed("The Daemon is stopping (503), so nothing changed.");
      }

      case "Unauthorized": {
        return failed(
          "The Daemon does not accept the key in IIRC_KEY (401). It may be mistyped, or revoked."
        );
      }

      default: {
        return error satisfies never;
      }
    }
  };

// Printed here, once and plainly, and the exit code follows the error.
const reported = <A, R>(command: Effect.Effect<A, CommandFailed, R>) =>
  command.pipe(reportedOnStderr, Effect.provide(FetchHttpClient.layer));

const configExport = Command.make("export", { apiUrl }, ({ apiUrl: baseUrl }) =>
  Effect.gen(function* () {
    const client = yield* clientOf(baseUrl);
    const configuration = yield* Effect.mapError(client.configuration.get(), explain(baseUrl));

    yield* Console.log(configurationToToml(configuration).trimEnd());
  }).pipe(reported)
).pipe(
  Command.withDescription(
    "Print all of Configuration as TOML, which `iirc config import` takes back (CONF-6)"
  )
);

const importedNetworks = ({ networks }: Configuration) => networks.map(({ id }) => id);

const configImport = Command.make(
  "import",
  {
    apiUrl,
    file: Argument.FileText("file").pipe(
      Argument.withDescription("A TOML file, such as one `iirc config export` printed")
    ),
  },
  ({ apiUrl: baseUrl, file }) =>
    Effect.gen(function* () {
      // Read and checked before anything is sent, so a mistake costs nothing.
      const configuration = yield* Result.match(parseConfigurationFile(file), {
        onFailure: (issues) =>
          Effect.fail(
            failed(`The file is not Configuration, so nothing was sent:\n${listed(issues)}`)
          ),
        onSuccess: Effect.succeed,
      });

      const ids = importedNetworks(configuration);
      const client = yield* clientOf(baseUrl);

      const before = importedNetworks(
        yield* Effect.mapError(client.configuration.get(), explain(baseUrl))
      );

      const { change } = yield* Effect.mapError(
        client.configuration.replace({ payload: configuration }),
        explain(baseUrl, ids)
      );

      const removed = before.filter((id) => !ids.includes(id));

      yield* Console.log(`Change ${change} replaced all of Configuration with the file.`);
      yield* Console.log(
        removed.length === 0
          ? "A file is the whole Configuration, and this one left out no Network there was."
          : `A file is the whole Configuration, so the Networks it left out were removed: ${removed.join(", ")}.`
      );
    }).pipe(reported)
).pipe(
  Command.withDescription(
    "Replace all of Configuration with a TOML file, as one Change. A file is the whole Configuration, so importing one removes every Network it leaves out (CONF-6)"
  )
);

/** `iirc config`, which reads and writes Configuration as a file through the API. */
export const config = Command.make("config").pipe(
  Command.withDescription(
    "Export or import Configuration as TOML through the API, with the key in IIRC_KEY"
  ),
  Command.withSubcommands([configExport, configImport])
);
