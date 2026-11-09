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

// Effect is fenced by allowlist, because it is large and grows: platform services such
// as FileSystem, randomness such as SecureRandom, and whole packages such as `effect/sql`
// sit beside its pure modules. Each layer names the modules it may use, from the `effect`
// barrel or by subpath, and every other one is refused.
//
// The core may use pure data and Schema, and nothing that runs, waits, or reaches out.
// `DateTime` is left out: besides reading the clock, its zoned constructors default to
// the machine's time zone, so the same input could give a different result elsewhere.
const pureEffect = [
  "Array",
  "BigDecimal",
  "BigInt",
  "Boolean",
  "Brand",
  "Chunk",
  "Data",
  "Duration",
  "Equal",
  "Equivalence",
  "Filter",
  "Function",
  "Hash",
  "HashMap",
  "HashSet",
  "Inspectable",
  "Iterable",
  "Match",
  "NonEmptyIterable",
  "Number",
  "Option",
  "Order",
  "Ordering",
  "Pipeable",
  "Predicate",
  "Record",
  "Redacted",
  "RegExp",
  "Result",
  "Schema",
  "SchemaAST",
  "SchemaGetter",
  "SchemaIssue",
  "SchemaParser",
  "SchemaTransformation",
  "String",
  "Struct",
  "Trie",
  "Tuple",
  "Types",
  "UndefinedOr",
];

// SASL PLAIN is base64, so the core may encode it.
const pureSubpaths = ["effect/encoding/Base64"];

// The Runtime may also run, wait for, and compose Effects. It may not use a platform
// service, read configuration from the environment, or use Cron, whose schedule starts
// from the wall clock unless told otherwise. `DateTime` and `Clock` read time, so only
// `clock.ts` and tests have them.
const runtimeEffect = [
  ...pureEffect,
  "Cause",
  "Context",
  "Deferred",
  "Effect",
  "Exit",
  "Fiber",
  "FiberHandle",
  "FiberMap",
  "FiberSet",
  "Latch",
  "Layer",
  "LogLevel",
  "Logger",
  "Metric",
  "PubSub",
  "Queue",
  "Random",
  "Ref",
  "References",
  "Schedule",
  "Scheduler",
  "Scope",
  "Semaphore",
  "Sink",
  "Stream",
  "SubscriptionRef",
  "SynchronizedRef",
  "Take",
  "Tracer",
];

const timeModules = ["Clock", "DateTime"];

const effectPath = (allowed: readonly string[], message: string) => ({
  allowImportNames: [...allowed],
  message,
  name: "effect",
});

const effectSubpaths = (
  allowed: readonly string[],
  subpaths: readonly string[],
  message: string
): Pattern => ({
  group: [
    "effect/**",
    ...allowed.map((name) => `!effect/${name}`),
    ...subpaths.map((subpath) => `!${subpath}`),
  ],
  message,
});

const impureModules: Pattern = {
  group: ["bun", "bun:*", "node:*", "@effect/*"],
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

interface Property {
  readonly message: string;
  readonly object?: string;
  readonly property: string;
}

const restrictProperties = (
  clock: string,
  randomness: string,
  ...more: readonly Property[]
): NonNullable<DummyRuleMap["no-restricted-properties"]> => [
  "error",
  ...wallClock.map((property) => ({ message: clock, property })),
  { message: randomness, property: "random" },
  ...more,
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

// `**/testing` covers a test kit at every depth, by package name or by relative path.
const testKit: Pattern = {
  group: ["**/testing", "**/testing/**", "./testing", "./testing/*", "../testing", "../testing/*"],
  message: "Production code never imports the test kit.",
};

// Another package is reached by its name and its exports, never by a relative path into
// it, so the fences on package names cannot be walked around. All code lives in `src/`,
// so a relative path into another package names a `src`, and one within a package never
// does, however deep the file.
const outOfPackage: Pattern = {
  group: ["**/src", "**/src/**"],
  message: "Import another package by its name, such as `@iirc/protocol/line`.",
};

// Production code never reaches Effect's test kit, such as `TestClock`.
const effectTesting: Pattern = {
  group: ["effect/testing", "effect/testing/*"],
  message: "Production code never imports a test kit.",
};

interface Path {
  readonly allowImportNames?: string[];
  readonly importNames?: string[];
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

// `Hash.random` hashes by a random number. The `random` property is refused everywhere,
// and this refuses it as a named import.
const randomHashImport = { importNames: ["random"], message: pure, name: "effect/Hash" };

const pureImports = (...patterns: readonly Pattern[]) =>
  restrictImports(
    [effectPath(pureEffect, pure), wallClockImport(pure), randomHashImport],
    [impureModules, effectSubpaths(pureEffect, pureSubpaths, pure), ...patterns]
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
    "Intl",
    "Temporal",
    "navigator",
    "console",
    ...globalObjects,
  ],
});

const toClient = "`@iirc/client` depends only on `@iirc/protocol`.";
const toNothing = ours([], "`@iirc/protocol` depends on no other package of ours.");

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
    // `Intl` and `Temporal` read the wall clock, the time zone, or the locale.
    names: [
      "Date",
      "setTimeout",
      "setInterval",
      "setImmediate",
      "queueMicrotask",
      "performance",
      "Intl",
      "Temporal",
    ],
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
      "navigator",
      // The Runtime logs through Effect, so a test can see and silence it.
      "console",
      ...globalObjects,
    ],
  }
);

const runtimeProperties = restrictProperties(
  throughClock,
  "The Runtime takes randomness from Effect's Random.",
  { message: throughClock, property: "clockWith" },
  { message: throughPorts, property: "toFile" }
);

// `Logger.toFile` opens a file through FileSystem, around the ports.
const toFileImport = { importNames: ["toFile"], message: throughPorts, name: "effect/Logger" };

// Every Runtime file, tests included, reaches no adapter and reads no wall clock.
const clockWithImport = {
  importNames: ["clockWith"],
  message: throughClock,
  name: "effect/Effect",
};

const runtimeImports = (...patterns: readonly Pattern[]) =>
  restrictImports(
    [
      wallClockImport(throughClock),
      clockWithImport,
      toFileImport,
      effectPath([...runtimeEffect, ...timeModules], throughPorts),
    ],
    [
      adapters,
      effectSubpaths(
        [...runtimeEffect, ...timeModules],
        ["effect/testing", "effect/testing/*"],
        throughPorts
      ),
      ...patterns,
    ]
  );

// Production code reads time only in `clock.ts`: Effect's `Clock`, and `DateTime`, whose
// `now` reads it too, are imported nowhere else. Nor is `effect/testing`.
const runtimeProduction = (clock: "allowed" | "refused", ...patterns: readonly Pattern[]) => {
  const allowed = clock === "allowed" ? [...runtimeEffect, ...timeModules] : runtimeEffect;

  return restrictImports(
    [
      wallClockImport(throughClock),
      clockWithImport,
      toFileImport,
      effectPath(allowed, throughPorts),
    ],
    [adapters, effectSubpaths(allowed, [], throughPorts), ...patterns, effectTesting]
  );
};

const tests = ["**/*.test.ts", "**/testing/**"];

const coreFence: OxlintOverride[] = [
  {
    // The import rules see a module only by name, so fenced code imports statically.
    files: ["packages/protocol/src/**", "packages/client/src/**", "packages/runtime/src/**"],
    rules: { "fence/no-dynamic-import": "error" },
  },
  {
    // Tests too reach another package only by its name.
    files: ["packages/*/src/**", "apps/*/src/**"],
    rules: { "no-restricted-imports": imports() },
  },
  {
    excludeFiles: tests,
    files: ["packages/*/src/**", "apps/*/src/**"],
    rules: { "no-restricted-imports": imports(testKit, effectTesting) },
  },
  {
    files: ["packages/protocol/src/**"],
    rules: {
      "no-restricted-globals": noClock,
      "no-restricted-imports": pureImports(toNothing),
      "no-restricted-properties": noRandomOrNow,
    },
  },
  {
    excludeFiles: tests,
    files: ["packages/protocol/src/**"],
    rules: { "no-restricted-imports": pureImports(toNothing, testKit, effectTesting) },
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
    rules: {
      "no-restricted-imports": pureImports(
        ours(["@iirc/protocol/*"], toClient),
        testKit,
        effectTesting
      ),
    },
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
    // The fence test lints its probes for `known` under the second name.
    files: ["packages/client/src/known.ts", "packages/client/src/known-fence-probe-*.ts"],
    rules: {
      "no-restricted-imports": pureImports(
        ours([], "`known` imports nothing of ours but ids."),
        {
          // An allowlist: every import is refused but `./ids.ts`.
          group: ["*", "**", "./*", "./**", "../*", "../**", "!./ids.ts"],
          message: "`known` imports nothing but ids.",
        },
        testKit,
        effectTesting
      ),
    },
  },
];

export default defineConfig({
  ...(core.env && { env: core.env }),
  extends: [core, antiSlop, jsPlugins, vitest, effect],
  ignorePatterns: core.ignorePatterns ?? [],
  jsPlugins: [
    ...jsPlugins.jsPlugins,
    { name: "fence", specifier: "./packages/fence/src/plugin.ts" },
  ],
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
