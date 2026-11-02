import { Configuration } from "@iirc/api";
import type { NetworkSettings } from "@iirc/api";
import { Effect, Predicate, Result, Schema, SchemaIssue } from "effect";
import { Toml } from "effect/encoding";

// CONF-6: TOML is a view of Configuration and never its truth (ADR 0004). A file holds
// one table per Network, named by its ID, so the ID is written once and two Networks
// cannot share it.

/** One thing wrong with a file, or with the request made from it, and where. */
export interface FileIssue {
  readonly message: string;
  readonly path: readonly (string | number)[];
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

const issuesOf = ({ issue }: { readonly issue: SchemaIssue.Issue }): readonly FileIssue[] =>
  formatIssues(issue).issues.map(({ message, path = [] }) => ({
    message,
    path: path.map((segment) => {
      const key = Predicate.hasProperty(segment, "key") ? segment.key : segment;

      return Predicate.isNumber(key) ? key : String(key);
    }),
  }));

// Only the shape here, so that each Network is then decoded by the published Schema. An
// unknown key anywhere is an error rather than nothing, because a file is written by hand
// and a misspelt setting would otherwise be dropped without a word.
const Tables = Schema.Struct({
  networks: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({}))
  ),
});

const strictly = { errors: "all", onExcessProperty: "error" } as const;

const decodeTables = Schema.decodeUnknownResult(Tables, strictly);

const decodeConfiguration = Schema.decodeUnknownResult(Configuration, strictly);

/**
 * Says where an issue is in the file, given where it is in the request made from it. The
 * request lists Networks in the file's order, so an index there is an ID here.
 * @param path - Where the issue is in the request's `networks`, such as `[0, "tuning"]`.
 * @param ids - The IDs, in the file's order.
 * @returns The path in the file, such as `["networks", "libera", "tuning"]`.
 */
export const inFile = (
  path: readonly (string | number)[],
  ids: readonly string[]
): readonly (string | number)[] => {
  const [index, ...rest] = path;
  const id = Predicate.isNumber(index) ? ids[index] : undefined;

  return id === undefined ? ["networks", ...path] : ["networks", id, ...rest];
};

/**
 * Reads a file as Configuration, with every setting decoded by the API's own Schema, so
 * that a mistake is found, with its path, before anything is sent.
 * @param text - The file.
 * @returns The Configuration it describes, or everything wrong with it.
 */
export const parseConfigurationFile = (
  text: string
): Result.Result<Configuration, readonly FileIssue[]> =>
  Toml.parse(text).pipe(
    Result.mapError(({ message }): readonly FileIssue[] => [{ message, path: [] }]),
    Result.flatMap((parsed) => Result.mapError(decodeTables(parsed), issuesOf)),
    Result.flatMap(({ networks }) => {
      const ids = Object.keys(networks);

      // The table's name is the ID, and an `id` inside it would be a second, which could
      // disagree.
      const named = ids.filter((id) => Object.hasOwn(networks[id] ?? {}, "id"));

      if (named.length > 0) {
        return Result.fail(
          named.map((id) => ({
            message: "is the table's name, and cannot be set inside it",
            path: ["networks", id, "id"],
          }))
        );
      }

      return Result.mapError(
        decodeConfiguration({
          networks: ids.map((id) => ({ ...networks[id], id })),
        }),
        (error) =>
          issuesOf(error).map(({ message, path }) => ({
            message,
            path: inFile(path.slice(1), ids),
          }))
      );
    })
  );

// What a Network's table holds: everything but the ID, which names it, and Tuning only
// when the Owner changed some, since only changes are stored (CONF-3).
const toTable = (settings: NetworkSettings) => ({
  channels: settings.channels,
  enabled: settings.enabled,
  identity: settings.identity,
  ircds: settings.ircds,
  name: settings.name,
  quitReason: settings.quitReason,
  ...(Object.keys(settings.tuning).length > 0 && { tuning: settings.tuning }),
});

const header = [
  "# iirc Configuration (CONF-6).",
  "# A file is the whole Configuration: importing it removes every Network it leaves out.",
  "",
  "",
].join("\n");

/**
 * Writes Configuration as TOML, which `parseConfigurationFile` reads back as the same
 * Configuration. Bun writes it, because Effect's TOML only parses (ADR 0004).
 * @param configuration - Configuration, as the API gives it.
 * @returns The file.
 */
export const configurationToToml = ({ networks }: Configuration) =>
  `${header}${Bun.TOML.stringify({
    networks: Object.fromEntries(networks.map((settings) => [settings.id, toTable(settings)])),
  })}`;

/**
 * Says where an issue is as a reader would write it, such as `networks.libera.ircds[0].pin`.
 * @param issue - The issue.
 * @returns One line.
 */
export const describeIssue = ({ message, path }: FileIssue) => {
  const where = path
    .map((segment, index) =>
      Predicate.isNumber(segment) ? `[${segment}]` : `${index === 0 ? "" : "."}${segment}`
    )
    .join("");

  return where === "" ? message : `${where}: ${message}`;
};
