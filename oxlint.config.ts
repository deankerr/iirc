import { strict as effect } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";
import type { DummyRuleMap, OxlintOverride } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { selectJsPlugins } from "ultracite/oxlint/js-plugins";
import vitest from "ultracite/oxlint/vitest";

const jsPlugins = selectJsPlugins(["jsdoc-js", "tsdoc"]);

// The fence around the core. `@iirc/protocol` and `@iirc/client` are pure: time and
// randomness arrive on inputs, effects leave as outputs, and no adapter is reachable.
// An override replaces a rule's options, so each file group lists every pattern it needs.
interface Pattern {
  readonly group: string[];
  readonly message: string;
}

const pure = "The core is pure: time arrives on inputs and effects leave as outputs.";

// Effect's services, which the core may not use whether imported from `effect` or by path.
const services = [
  "Clock",
  "Context",
  "Effect",
  "Fiber",
  "Layer",
  "Queue",
  "Random",
  "Ref",
  "Schedule",
  "Scope",
  "Stream",
] as const;

const impureModules: Pattern = {
  group: [
    "bun",
    "bun:*",
    "node:*",
    "@effect/*",
    "effect/unstable/*",
    ...services.map((name) => `effect/${name}`),
  ],
  message: pure,
};

const noRandomOrNow: NonNullable<DummyRuleMap["no-restricted-properties"]> = [
  "error",
  { message: pure, object: "Math", property: "random" },
  { message: pure, object: "DateTime", property: "nowUnsafe" },
  { message: pure, object: "DateTime", property: "unsafeNow" },
];

const ours = (allowed: readonly string[], message: string): Pattern => ({
  group: ["@iirc/*", ...allowed.map((name) => `!${name}`)],
  message,
});

const testKit: Pattern = {
  group: ["@iirc/client/testing", "./testing/*", "../testing/*"],
  message: "Production code never imports the test kit.",
};

const imports = (
  ...patterns: readonly Pattern[]
): NonNullable<DummyRuleMap["no-restricted-imports"]> => ["error", { patterns: [...patterns] }];

const pureImports = (
  ...patterns: readonly Pattern[]
): NonNullable<DummyRuleMap["no-restricted-imports"]> => [
  "error",
  {
    paths: [
      {
        importNames: [...services],
        message: pure,
        name: "effect",
      },
    ],
    patterns: [impureModules, ...patterns],
  },
];

const noClock: NonNullable<DummyRuleMap["no-restricted-globals"]> = [
  "error",
  ...[
    "Date",
    "setTimeout",
    "setInterval",
    "queueMicrotask",
    "performance",
    "crypto",
    "fetch",
    "process",
    "Bun",
  ].map((name) => ({ message: pure, name })),
];

const toClient = "`@iirc/client` depends only on `@iirc/protocol`.";
const tests = ["**/*.test.ts", "**/testing/**"];

const coreFence: OxlintOverride[] = [
  {
    excludeFiles: tests,
    files: ["packages/*/src/**", "apps/*/src/**"],
    rules: { "no-restricted-imports": imports(testKit) },
  },
  {
    files: ["packages/protocol/src/**"],
    rules: {
      "no-restricted-globals": noClock,
      "no-restricted-imports": pureImports(
        ours([], "`@iirc/protocol` depends on no other package of ours.")
      ),
      "no-restricted-properties": noRandomOrNow,
    },
  },
  {
    files: ["packages/client/src/**"],
    rules: {
      "no-restricted-globals": noClock,
      "no-restricted-imports": pureImports(ours(["@iirc/protocol/*"], toClient)),
      "no-restricted-properties": noRandomOrNow,
    },
  },
  {
    excludeFiles: tests,
    files: ["packages/client/src/**"],
    rules: { "no-restricted-imports": pureImports(ours(["@iirc/protocol/*"], toClient), testKit) },
  },
  {
    // Views read `known` alone, so it cannot reach the Client's inputs, outputs, or Features.
    files: ["packages/client/src/known.ts"],
    rules: {
      "no-restricted-imports": pureImports(ours([], "`known` imports nothing of ours but ids."), {
        group: ["./*", "../*", "!./ids.ts"],
        message: "`known` imports nothing of ours but ids.",
      }),
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
