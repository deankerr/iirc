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

// What reads the wall clock or the system's time zone without an Effect. Each is refused
// as a property of any object, so an alias of `DateTime` or a namespace import cannot
// reach it, and as a named import from `effect/DateTime`.
const wallClock = [
  "nowUnsafe",
  "unsafeNow",
  "isFutureUnsafe",
  "isPastUnsafe",
  "zoneMakeLocal",
  "formatLocal",
];

const restrictProperties = (
  clock: string,
  randomness: string
): NonNullable<DummyRuleMap["no-restricted-properties"]> => [
  "error",
  ...wallClock.map((property) => ({ message: clock, property })),
  { message: randomness, property: "random" },
];

const noRandomOrNow = restrictProperties(pure, pure);

const wallClockImport = (message: string) => ({
  importNames: wallClock,
  message,
  name: "effect/DateTime",
});

const ours = (allowed: readonly string[], message: string): Pattern => ({
  // `@iirc/*` matches one segment only, so subpaths such as `@iirc/runtime/journal` need `/**`.
  group: ["@iirc/*", "@iirc/*/**", ...allowed.map((name) => `!${name}`)],
  message,
});

const testKit: Pattern = {
  group: [
    "@iirc/*/testing",
    "@iirc/*/testing/**",
    "./testing",
    "./testing/*",
    "../testing",
    "../testing/*",
  ],
  message: "Production code never imports the test kit.",
};

// Another package is reached by its name and its exports, never by a relative path into
// it, so the fences on package names cannot be walked around. Code sits at most one
// directory below `src/`, so `../../` always leaves the package.
const outOfPackage: Pattern = {
  group: ["../../*", "../../**", "**/src/**"],
  message: "Import another package by its name, such as `@iirc/protocol/line`.",
};

interface Path {
  readonly importNames: string[];
  readonly message: string;
  readonly name: string;
}

const restrictImports = (
  paths: readonly Path[],
  patterns: readonly Pattern[]
): NonNullable<DummyRuleMap["no-restricted-imports"]> => [
  "error",
  { paths: [...paths], patterns: [...patterns, outOfPackage] },
];

const imports = (...patterns: readonly Pattern[]) => restrictImports([], patterns);

const pureImports = (...patterns: readonly Pattern[]) =>
  restrictImports(
    [{ importNames: [...services], message: pure, name: "effect" }, wallClockImport(pure)],
    [impureModules, ...patterns]
  );

// The global object itself is refused too, so `globalThis.Date` or an alias of
// `globalThis` cannot reach what is refused by name.
const globalObjects = ["globalThis", "self", "window", "global"];

const restrictGlobals = (
  ...groups: readonly { readonly message: string; readonly names: readonly string[] }[]
): NonNullable<DummyRuleMap["no-restricted-globals"]> => [
  "error",
  {
    checkGlobalObject: true,
    globalObjects,
    globals: groups.flatMap(({ message, names }) => names.map((name) => ({ message, name }))),
  },
];

const noClock = restrictGlobals({
  message: pure,
  names: [
    "Date",
    "setTimeout",
    "setInterval",
    "setImmediate",
    "queueMicrotask",
    "performance",
    "crypto",
    "fetch",
    "WebSocket",
    "XMLHttpRequest",
    "EventSource",
    "process",
    "Bun",
    "require",
    ...globalObjects,
  ],
});

const toClient = "`@iirc/client` depends only on `@iirc/protocol`.";

// The Runtime may use Effect's services, but reads time only through the Clock port, so
// that `TestClock` drives it, and reaches no adapter.
const adapters: Pattern = {
  group: ["bun", "bun:*", "node:*", "@effect/*", "effect/unstable/*"],
  message:
    "The Runtime reaches the world only through its ports. Adapters live in their own packages.",
};

const toRuntime = "`@iirc/runtime` depends only on `@iirc/client` and `@iirc/protocol`.";
const runtimeOurs = ours(["@iirc/client", "@iirc/client/known", "@iirc/protocol/*"], toRuntime);

// The Runtime's tests and test kit may also drive it with the scripted Client.
const runtimeTestOurs = ours(
  ["@iirc/client", "@iirc/client/known", "@iirc/client/testing", "@iirc/protocol/*"],
  toRuntime
);

const throughClock = "The Runtime reads time only through the Clock port.";
const throughPorts = "The Runtime reaches the world only through its ports.";

const runtimeGlobals = restrictGlobals(
  {
    message: throughClock,
    names: ["Date", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "performance"],
  },
  {
    message: throughPorts,
    names: [
      "fetch",
      "WebSocket",
      "XMLHttpRequest",
      "EventSource",
      "crypto",
      "process",
      "Bun",
      "require",
      ...globalObjects,
    ],
  }
);

const runtimeProperties = restrictProperties(
  throughClock,
  "The Runtime takes randomness from Effect's Random."
);

// Every Runtime file, tests included, reaches no adapter and reads no wall clock.
const runtimeImports = (...patterns: readonly Pattern[]) =>
  restrictImports([wallClockImport(throughClock)], [adapters, ...patterns]);

// Production code reads the Clock only in `clock.ts`, and never reaches `TestClock`.
const effectTesting: Pattern = {
  group: ["effect/testing", "effect/testing/*"],
  message: "Production code never imports a test kit.",
};

const runtimeProduction = (clock: "allowed" | "refused", ...patterns: readonly Pattern[]) =>
  restrictImports(
    [
      wallClockImport(throughClock),
      ...(clock === "allowed"
        ? []
        : [{ importNames: ["Clock"], message: throughClock, name: "effect" }]),
    ],
    [
      adapters,
      ...patterns,
      effectTesting,
      ...(clock === "allowed" ? [] : [{ group: ["effect/Clock"], message: throughClock }]),
    ]
  );

const tests = ["**/*.test.ts", "**/testing/**"];

const coreFence: OxlintOverride[] = [
  {
    // Tests too reach another package only by its name.
    files: ["packages/*/src/**", "apps/*/src/**"],
    rules: { "no-restricted-imports": imports() },
  },
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
    files: ["packages/runtime/src/**"],
    rules: {
      "no-restricted-globals": runtimeGlobals,
      "no-restricted-imports": runtimeImports(runtimeTestOurs),
      "no-restricted-properties": runtimeProperties,
    },
  },
  {
    excludeFiles: tests,
    files: ["packages/runtime/src/**"],
    rules: {
      "no-restricted-imports": runtimeProduction("refused", runtimeOurs, testKit),
    },
  },
  {
    // The Clock port's helpers are the one place the Runtime reads Effect's Clock.
    files: ["packages/runtime/src/clock.ts"],
    rules: {
      "no-restricted-imports": runtimeProduction("allowed", runtimeOurs, testKit),
    },
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
