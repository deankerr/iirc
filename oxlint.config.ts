import { strict as effect } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";
import type { DummyRuleMap, OxlintOverride } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { selectJsPlugins } from "ultracite/oxlint/js-plugins";
import vitest from "ultracite/oxlint/vitest";

const jsPlugins = selectJsPlugins(["jsdoc-js", "tsdoc"]);

// The lint fence catches what is cheap to catch by name: dependencies that point the wrong
// way, test kits in production code, and the obvious clocks, randomness, and I/O in the core
// and the Runtime. It is not a proof of purity. AGENTS.md states the rule, and review and the
// replay law hold the rest. Keep it this small: a gap it misses goes to review, not here.
//
// An override replaces a rule's options, so each file group lists every pattern it needs.
interface Pattern {
  readonly group: string[];
  readonly message: string;
}

type Imports = NonNullable<DummyRuleMap["no-restricted-imports"]>;

// Another package is reached by its name, never by a relative path into its `src`.
const outOfPackage: Pattern = {
  group: ["**/src", "**/src/**"],
  message: "Import another package by its name, such as `@iirc/protocol/line`.",
};

const testKit: Pattern = {
  group: ["**/testing", "**/testing/**", "effect/testing", "effect/testing/*"],
  message: "Production code never imports a test kit.",
};

const adapters: Pattern = {
  group: ["bun", "bun:*", "node:*", "@effect/*", "effect/unstable/*"],
  message: "Adapters live in their own packages, and the core and Runtime reach none of them.",
};

// `@iirc/*` matches one segment only, so subpaths such as `@iirc/runtime/journal` need `/**`.
const ours = (allowed: readonly string[], message: string): Pattern => ({
  group: ["@iirc/*", "@iirc/*/**", ...allowed.map((name) => `!${name}`)],
  message,
});

const pure = "The core is pure: time arrives on inputs, and effects leave as outputs.";

// What runs, reads time or randomness, or reaches out, from the `effect` barrel or by subpath.
const effectful = ["Clock", "Console", "DateTime", "Effect", "FileSystem", "Random"];

const imports = (production: boolean, ...patterns: readonly Pattern[]): Imports => [
  "error",
  { patterns: [outOfPackage, ...patterns, ...(production ? [testKit] : [])] },
];

const coreImports = (production: boolean, ...patterns: readonly Pattern[]): Imports => [
  "error",
  {
    paths: [{ importNames: effectful, message: pure, name: "effect" }],
    patterns: [
      outOfPackage,
      adapters,
      { group: effectful.map((name) => `effect/${name}`), message: pure },
      ...patterns,
      ...(production ? [testKit] : []),
    ],
  },
];

const globals = (message: string): NonNullable<DummyRuleMap["no-restricted-globals"]> => [
  "error",
  ...[
    "Date",
    "setTimeout",
    "setInterval",
    "performance",
    "Intl",
    "crypto",
    "fetch",
    "process",
    "Bun",
    "console",
  ].map((name) => ({ message, name })),
];

const noMathRandom = (message: string): NonNullable<DummyRuleMap["no-restricted-properties"]> => [
  "error",
  { message, object: "Math", property: "random" },
];

const throughPorts =
  "The Runtime reaches the world through its ports, time through Effect's Clock, and randomness through Effect's Random.";

const toNothing = ours([], "`@iirc/protocol` depends on no other package of ours.");
const toProtocol = ours(["@iirc/protocol/*"], "`@iirc/client` depends only on `@iirc/protocol`.");

const outboxToProtocol = ours(
  ["@iirc/protocol/*"],
  "`@iirc/outbox` depends only on `@iirc/protocol`."
);

// A negation un-blocks every group, so the Runtime's allowed subpaths are listed exactly,
// and only its tests may import the scripted Client.
const toClient = (production: boolean) =>
  ours(
    [
      "@iirc/client",
      "@iirc/client/known",
      "@iirc/outbox",
      "@iirc/protocol/*",
      ...(production ? [] : ["@iirc/client/testing"]),
    ],
    "`@iirc/runtime` depends only on `@iirc/client`, `@iirc/outbox`, and `@iirc/protocol`."
  );

const tests = ["**/*.test.ts", "**/testing/**"];

// Each layer's rules, once for every file and once more, with the test kits refused, for
// production code.
const layer = (files: string[], rules: (production: boolean) => DummyRuleMap): OxlintOverride[] => [
  { files, rules: rules(false) },
  { excludeFiles: tests, files, rules: rules(true) },
];

const coreRules = (to: Pattern) => (production: boolean) => ({
  "no-restricted-globals": globals(pure),
  "no-restricted-imports": coreImports(production, to),
  "no-restricted-properties": noMathRandom(pure),
});

const coreFence: OxlintOverride[] = [
  ...layer(["packages/*/src/**", "apps/*/src/**"], (production) => ({
    "no-restricted-imports": imports(production),
  })),
  ...layer(["packages/protocol/src/**"], coreRules(toNothing)),
  ...layer(["packages/client/src/**"], coreRules(toProtocol)),
  ...layer(["packages/outbox/src/**"], coreRules(outboxToProtocol)),
  ...layer(["packages/api/src/**"], (production) => ({
    "no-restricted-imports": imports(
      production,
      adapters,
      ours(
        ["@iirc/client", "@iirc/protocol/*"],
        "`@iirc/api` is the contract alone: it never imports the Runtime or an adapter."
      )
    ),
  })),
  ...layer(["packages/runtime/src/**"], (production) => ({
    "no-restricted-globals": globals(throughPorts),
    "no-restricted-imports": imports(production, adapters, toClient(production)),
    "no-restricted-properties": noMathRandom(throughPorts),
  })),
  {
    // Views read `known` alone, so it imports nothing but ids.
    files: ["packages/client/src/known.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["*", "**", "./*", "./**", "../*", "../**", "!./ids.ts"],
              message: "`known` imports nothing but ids.",
            },
          ],
        },
      ],
    },
  },
];

export default defineConfig({
  ...(core.env && { env: core.env }),
  extends: [core, antiSlop, jsPlugins, vitest, effect],
  ignorePatterns: core.ignorePatterns ?? [],
  jsPlugins: jsPlugins.jsPlugins,
  options: { typeAware: true, typeCheck: true },
  overrides: coreFence,
  rules: {
    // `effect/cli` and the platform runtimes are still marked unstable, and we
    // use them on purpose.
    "effecttsgo/experimental-api-usage": "off",
    "effecttsgo/unstable-api-usage": "off",

    // Ultracite rules that clash with idiomatic Effect:
    // `Effect.gen(function* () {})` and `Effect.fn("name")(function* () {})`
    // take anonymous generators.
    "func-names": "off",
    // Tagged errors live next to the service that raises them.
    "max-classes-per-file": "off",
    // Schemas and tagged enums share a name between their value and type.
    "no-redeclare": "off",
    // Pipelines routinely reuse a name in nested callbacks.
    "no-shadow": "off",
    // Reads `Effect.catch` and `(error) => ...` as Node-style callbacks.
    "promise/prefer-await-to-callbacks": "off",
    // `effecttsgo/unnecessary-effect-gen` covers generators with no `yield`.
    "require-yield": "off",
    // Fires on `.pipe(..., BunRuntime.runMain)`, which ends in a void sink.
    "typescript/strict-void-return": "off",
    // Mistakes `Schema.TaggedError<Self>()(...)` for a thrown error call.
    "unicorn/throw-new-error": "off",
  },
});
