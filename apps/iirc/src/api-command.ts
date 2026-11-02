import { DaemonApi } from "@iirc/api";
import type {
  BackupFailed,
  CredentialNotFound,
  CredentialsUnavailable,
  Forbidden,
  InvalidRequest,
  LogUnavailable,
  Stopping,
  Unauthorized,
} from "@iirc/api";
import { Config, Effect, Option, Redacted } from "effect";
import type { Schema } from "effect";
import { Flag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientError } from "effect/http";
import { HttpApiClient } from "effect/http-api";

import { failed, reportedOnStderr } from "./command-failed.ts";
import type { CommandFailed } from "./command-failed.ts";
import { describeIssue } from "./configuration-file.ts";
import type { FileIssue } from "./configuration-file.ts";

// API-1: a command here is a Frontend like any other. It reaches the Daemon only through
// the API, with a key, and knows nothing a script could not.

/** Exit code for a command run wrongly, rather than one that failed. */
const usageExitCode = 2;

/** Where the Daemon's API is: a flag, or else the environment, or else where `iirc daemon` listens by default (CONF-4). */
export const apiUrl = Flag.String("api-url").pipe(
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

/**
 * A client of the Daemon's API that sends the key in IIRC_KEY with every request.
 * @param baseUrl - Where the API is.
 * @returns The client, or a refusal if there is no key.
 */
export const clientOf = (baseUrl: string) =>
  presentedKey.pipe(
    Effect.flatMap((key) =>
      HttpApiClient.make(DaemonApi, {
        baseUrl,
        transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(key)),
      })
    )
  );

/**
 * Each issue on a line of its own, indented under what says they were refused.
 * @param issues - What was wrong, and where.
 * @returns The lines.
 */
export const listed = (issues: readonly FileIssue[]) =>
  issues.map((issue) => `  ${describeIssue(issue)}`).join("\n");

/** Every way a call through the client can come back refused. */
type ApiFailure =
  | BackupFailed
  | CredentialNotFound
  | CredentialsUnavailable
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
 * @param pathOf - Where a bad request's issue is, in the words of what was sent, which a
 * command that sent a file uses to point into the file.
 * @returns The refusal, ready to print.
 */
export const explain =
  (
    baseUrl: string,
    pathOf: (path: readonly (string | number)[]) => readonly (string | number)[] = (path) => path
  ) =>
  (error: ApiFailure): CommandFailed => {
    switch (error._tag) {
      case "BackupFailed": {
        return failed(`The Daemon could not back up its Log: ${error.reason}`);
      }

      case "CredentialNotFound": {
        return failed(`There is no Credential named ${error.credential}, so nothing changed.`);
      }

      case "CredentialsUnavailable": {
        return failed(
          `The Daemon could not keep Credentials (503), so nothing changed: ${error.reason}`
        );
      }

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
            error.issues.map(({ message, path }) => ({ message, path: pathOf(path) }))
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

/**
 * Prints a refusal once and plainly, lets the exit code follow it, and gives the command
 * an HTTP client.
 * @param command - The command.
 * @returns The same command, ready to run.
 */
export const reported = <A, R>(command: Effect.Effect<A, CommandFailed, R>) =>
  command.pipe(reportedOnStderr, Effect.provide(FetchHttpClient.layer));
