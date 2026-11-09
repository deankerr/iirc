# @iirc/fence

Regression tests for the lint fence in [`oxlint.config.ts`](../../oxlint.config.ts). Each test writes probe files into the packages it fences, lints them with the repository's own configuration, and checks that every line that should be refused is, and every line that should be allowed is. Each run names its probes for itself and creates them exclusively, so it never overwrites a file or another run's probe, and it removes only what it created, even when a test fails.

It has no source of its own. Run it with `bun run test`, which `pre-push` does after `check` and `knip`, one job at a time, so no other job sees the probes.
