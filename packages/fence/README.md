# @iirc/fence

Regression tests for the lint fence in [`oxlint.config.ts`](../../oxlint.config.ts). Each test writes probe files into the packages it fences, lints them with the repository's own configuration, and checks that every line that should be refused is, and every line that should be allowed is. Each run names its probes for itself and creates them exclusively, so it never overwrites a file or another run's probe, and it removes only what it created, even when a test fails.

It also holds `src/plugin.ts`, the fence's own lint rules, which oxlint loads as the `fence` plugin. Today it has one: `no-dynamic-import`, because the import rules see a module only by name, and `import("effect")` would load all of Effect.

The tests have no source to test of their own. Run it with `bun run test`, which `pre-push` does after `check` and `knip`, one job at a time, so no other job sees the probes.
