import { readdirSync } from "node:fs";

import { configDefaults, defineConfig } from "vitest/config";

// A test's own limit is for a hang, never for a slow machine: two runs at once, or anything
// else busy, make a test several times slower, and that is not a failure.
const testTimeout = 60_000;

// Half the machine's threads, which is its cores where each core runs two: the other half
// adds no speed, and costs twice the memory and a machine with nothing left over. CI's runner
// is small and has only this to run, so it uses all of its own.
const maxWorkers = process.env.CI === undefined ? "50%" : "100%";

// The end-to-end suites need what this run does not have, or wait out real time limits, and
// are never part of it: `bun run e2e` runs them from their packages.
const endToEnd = { exclude: [...configDefaults.exclude, "src/e2e/**"] };

// A pure package's test files share a worker's modules rather than each loading its own,
// which is safe where no module holds state, and saves a third of what their tests cost.
const pure = { isolate: false };

// What a package's project sets that the others do not.
const differing = new Map<string, typeof endToEnd | typeof pure>([
  ["client", pure],
  ["daemon", endToEnd],
  ["frontend", pure],
  ["link-fetch-bun", endToEnd],
  ["protocol", pure],
  ["timelines", pure],
]);

// One Vitest run, so one worker pool serves every package, rather than a pool per package
// competing for the same cores. Each package is a project, so it keeps its own root, and
// `apps/web` its own config file for its plugins. A package's own `bun run test` finds none of
// this, and runs with Vitest's defaults.
export default defineConfig({
  test: {
    maxWorkers,
    projects: [
      {
        extends: "apps/web/vite.config.ts",
        root: "apps/web",
        test: { maxWorkers, name: "@iirc/web", testTimeout },
      },
      { extends: true, test: { ...endToEnd, name: "iirc", root: "apps/iirc" } },
      ...readdirSync("packages").map((name) => ({
        extends: true as const,
        test: { ...differing.get(name), name: `@iirc/${name}`, root: `packages/${name}` },
      })),
    ],
    testTimeout,
  },
});
