import { strict as effect } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";
import type { DummyRuleMap, OxlintOverride } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { selectJsPlugins } from "ultracite/oxlint/js-plugins";
import react from "ultracite/oxlint/react";
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
  readonly allowTypeImports?: boolean;
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

const globals = (
  message: string,
  more: readonly string[] = []
): NonNullable<DummyRuleMap["no-restricted-globals"]> => [
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
    ...more,
  ].map((name) => ({ message, name })),
];

// What a browser page reaches, which the web frontend's core never does.
const browser = [
  "window",
  "document",
  "location",
  "history",
  "navigator",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "EventSource",
  "WebSocket",
  "XMLHttpRequest",
  "requestAnimationFrame",
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

// The fold may read the Client's News and casemapping, and its tests may play a Client.
const toTimelines = (production: boolean) =>
  ours(
    [
      "@iirc/client",
      "@iirc/client/known",
      "@iirc/protocol/*",
      ...(production ? [] : ["@iirc/client/testing"]),
    ],
    "`@iirc/timelines` depends only on `@iirc/client` and `@iirc/protocol`."
  );

// Its laws are checked with the Runtime's `holds`, so only its test kit reaches the Runtime's.
const toTimelineStore = (production: boolean) =>
  ours(
    [
      "@iirc/client",
      "@iirc/client/known",
      "@iirc/timelines",
      ...(production ? [] : ["@iirc/runtime/testing"]),
    ],
    "`@iirc/timeline-store` depends only on `@iirc/timelines` and `@iirc/client`."
  );

const storeAlone = "A Timeline store reaches the world only through an adapter of its own.";

const viewless =
  "The web frontend's core is pure: no React, no DOM, no Effect services, and no clock. Its state is plain data, and React renders it from `apps/web`.";

const noView: Pattern = {
  group: ["react", "react/**", "react-dom", "react-dom/**", "react-aria-components"],
  message: viewless,
};

// The core reads mIRC formatting and casemapping from the protocol, positions from the
// fold, and the Configuration's Schema from the Client and the `ui` options' from the
// contract, to derive its options, which are pure. It takes the API's types for what the
// runtime parsed, and never its values, which are the HTTP contract.
const frontendToPure = ours(
  [
    "@iirc/protocol/format",
    "@iirc/protocol/casemapping",
    "@iirc/client/configuration",
    "@iirc/timelines",
    "@iirc/api",
    "@iirc/api/ui",
  ],
  "`@iirc/frontend` depends only on `@iirc/protocol`'s formatting and casemapping, the Client's Configuration Schema, `@iirc/timelines`, `@iirc/api`'s types, and the `ui` options' Schema in `@iirc/api/ui`."
);

const apiTypesOnly: Pattern = {
  allowTypeImports: true,
  group: ["@iirc/api"],
  message: "The web frontend's core takes the API's types, never its values: `import type`.",
};

const webToApi = ours(
  ["@iirc/api", "@iirc/frontend/*"],
  "The web frontend reaches the Daemon only through `@iirc/api`, as every Frontend does, and its core through `@iirc/frontend`."
);

const tests = ["**/*.test.ts", "**/*.test.tsx", "**/testing/**"];

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
  ...layer(["packages/timelines/src/**"], (production) =>
    coreRules(toTimelines(production))(production)
  ),
  ...layer(["packages/timeline-store/src/**"], (production) => ({
    "no-restricted-globals": globals(storeAlone),
    "no-restricted-imports": imports(production, adapters, toTimelineStore(production)),
    "no-restricted-properties": noMathRandom(storeAlone),
  })),
  ...layer(["packages/frontend/src/**"], (production) => ({
    "no-restricted-globals": globals(viewless, browser),
    "no-restricted-imports": coreImports(
      production,
      frontendToPure,
      noView,
      ...(production ? [apiTypesOnly] : [])
    ),
    "no-restricted-properties": noMathRandom(viewless),
  })),
  ...layer(["apps/web/src/**"], (production) => ({
    "no-restricted-imports": imports(production, webToApi),
  })),
  ...layer(["packages/api/src/**"], (production) => ({
    "no-restricted-imports": imports(
      production,
      adapters,
      ours(
        ["@iirc/client", "@iirc/protocol/*", "@iirc/timelines"],
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

// React's rules, for the one package that renders with it.
const reactRules: OxlintOverride = {
  files: ["apps/web/**"],
  ...(react.plugins && { plugins: react.plugins }),
  ...(react.rules && { rules: react.rules }),
};

export default defineConfig({
  ...(core.env && { env: core.env }),
  extends: [core, antiSlop, jsPlugins, vitest, effect],
  ignorePatterns: core.ignorePatterns ?? [],
  jsPlugins: jsPlugins.jsPlugins,
  options: { typeAware: true, typeCheck: true },
  overrides: [reactRules, ...coreFence],
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
