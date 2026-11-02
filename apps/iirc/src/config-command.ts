import type { Configuration } from "@iirc/api";
import { Console, Effect, Result } from "effect";
import { Argument, Command } from "effect/cli";

import { apiUrl, clientOf, explain, listed, reported } from "./api-command.ts";
import { failed } from "./command-failed.ts";
import { configurationToToml, inFile, parseConfigurationFile } from "./configuration-file.ts";

// CONF-6: `iirc config` is a Frontend like any other (API-1). It reaches the Daemon only
// through the API, with a key, and knows nothing a script could not.

// A bad request points into the file sent, by each Network's ID, rather than into the
// request made from it.
const inFileOf =
  (ids: readonly string[]) =>
  (path: readonly (string | number)[]): readonly (string | number)[] =>
    path[0] === "payload" && path[1] === "networks" ? inFile(path.slice(2), ids) : path;

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
        explain(baseUrl, inFileOf(ids))
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
