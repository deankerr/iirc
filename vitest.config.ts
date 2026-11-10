import { configDefaults, defineConfig } from "vitest/config";

// One Vitest run, so one worker pool serves every package, rather than a pool per package
// competing for the same cores. Each package is a project, so it keeps its own root, its own
// config file where it has one (`apps/web` has its plugins), and its own `bun run test`.
//
// The end-to-end suites drive a real Daemon and are never part of this run: `bun run e2e` runs
// them from their packages.
const endToEnd = (name: string, root: string) => ({
  test: {
    exclude: [...configDefaults.exclude, "src/e2e/**"],
    name,
    root,
  },
});

export default defineConfig({
  test: {
    projects: [
      "apps/web",
      endToEnd("iirc", "apps/iirc"),
      endToEnd("@iirc/daemon", "packages/daemon"),
      "packages/!(daemon)",
    ],
  },
});
