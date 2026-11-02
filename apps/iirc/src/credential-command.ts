import { CredentialName, CredentialValue } from "@iirc/api";
import { Console, Effect, Redacted, Result, Schema, SchemaIssue, Stdio, Stream } from "effect";
import { Argument, Command, Prompt } from "effect/cli";

import { apiUrl, clientOf, explain, reported } from "./api-command.ts";
import { failed } from "./command-failed.ts";

// CRED-2: Credentials go in through the API and never come out. A value is read from
// stdin, never from argv, which anyone running `ps` can see, and it is Redacted from the
// moment it is read until the request carries it (CRED-3).

const name = Argument.String("name").pipe(
  Argument.withSchema(CredentialName),
  Argument.withDescription("The Credential's name, which Configuration refers to it by")
);

/**
 * Takes off the one line ending that `echo`, or a file's last line, leaves on what a pipe
 * carries, which is no part of the value. A PEM keeps every line but that last ending.
 * @param text - Everything stdin held.
 * @returns The value.
 */
export const withoutFinalLineEnding = (text: string) => text.replace(/\r?\n$/u, "");

const decodeValue = Schema.decodeUnknownResult(CredentialValue);

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

// Parsed here, by the API's own Schema, so that a value the Daemon would refuse is never
// sent. Only the checks' own words are shown, which never repeat the value.
const parseValue = (text: string) =>
  Result.match(decodeValue(text), {
    onFailure: ({ issue }) =>
      Effect.fail(
        failed(
          `The value ${formatIssues(issue)
            .issues.map(({ message }) => message)
            .join(", and ")}, so nothing was set.`
        )
      ),
    onSuccess: Effect.succeed,
  });

// At a terminal the value is typed and never echoed. Anywhere else stdin is read to its
// end, so that a certificate and key can be piped in whole.
const readValue = (credential: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;

    if (yield* stdio.stdinIsTerminal) {
      const typed = yield* Prompt.Hidden({ message: `Value for ${credential} (not shown)` }).pipe(
        Effect.mapError(() => failed("Nothing was typed, so nothing was set."))
      );

      return yield* parseValue(Redacted.value(typed));
    }

    const text = yield* stdio.stdin.pipe(
      Stream.decodeText(),
      Stream.mkString,
      Effect.mapError((error) => failed(`stdin could not be read: ${error.message}`))
    );

    return yield* parseValue(withoutFinalLineEnding(text));
  });

const credentialSet = Command.make(
  "set",
  { apiUrl, name },
  ({ apiUrl: baseUrl, name: credential }) =>
    Effect.gen(function* () {
      const value = yield* readValue(credential);
      const client = yield* clientOf(baseUrl);

      const { change } = yield* Effect.mapError(
        client.credentials.set({ params: { name: credential }, payload: { value } }),
        explain(baseUrl)
      );

      yield* Console.log(`Change ${change} set the Credential ${credential}.`);
    }).pipe(reported)
).pipe(
  Command.withDescription(
    "Set or replace a Credential, reading its value from stdin, or typed unseen at a terminal (CRED-2)"
  )
);

const credentialDelete = Command.make(
  "delete",
  { apiUrl, name },
  ({ apiUrl: baseUrl, name: credential }) =>
    Effect.gen(function* () {
      const client = yield* clientOf(baseUrl);

      const { change } = yield* Effect.mapError(
        client.credentials.delete({ params: { name: credential } }),
        explain(baseUrl)
      );

      yield* Console.log(`Change ${change} deleted the Credential ${credential}.`);
    }).pipe(reported)
).pipe(Command.withDescription("Delete a Credential (CRED-2)"));

const credentialList = Command.make("list", { apiUrl }, ({ apiUrl: baseUrl }) =>
  Effect.gen(function* () {
    const client = yield* clientOf(baseUrl);

    const { credentials, store } = yield* Effect.mapError(
      client.credentials.list(),
      explain(baseUrl)
    );

    yield* Console.log(
      `Credentials are kept in the ${store === "file" ? "file" : "system keyring"}.`
    );

    for (const { name: credential, set } of credentials) {
      yield* Console.log(`${credential}\tset ${new Date(set).toISOString()}`);
    }
  }).pipe(reported)
).pipe(
  Command.withDescription(
    "List every Credential by name, with when it was set and where they are kept, never a value (CRED-2)"
  )
);

/** `iirc credential`, which sets, deletes, and lists Credentials through the API. */
export const credential = Command.make("credential").pipe(
  Command.withDescription(
    "Set, delete, or list Credentials through the API, with the key in IIRC_KEY. A value is never shown"
  ),
  Command.withSubcommands([credentialSet, credentialDelete, credentialList])
);

/** `iirc backup`, which asks the running Daemon to back up its Log (RUN-2). */
export const backup = Command.make("backup", { apiUrl }, ({ apiUrl: baseUrl }) =>
  Effect.gen(function* () {
    const client = yield* clientOf(baseUrl);
    const taken = yield* Effect.mapError(client.daemon.backup(), explain(baseUrl));

    yield* Console.log(
      `Backed up the Log to sequence ${taken.head} in ${taken.path} (${taken.bytes} bytes).`
    );
  }).pipe(reported)
).pipe(
  Command.withDescription(
    "Back up the running Daemon's Log into backups/ in its data directory, through the API (RUN-2). Credentials are never part of it"
  )
);
