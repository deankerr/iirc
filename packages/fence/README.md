# @iirc/fence

Regression tests for the lint fence in [`oxlint.config.ts`](../../oxlint.config.ts). Each test writes probe files into the packages it fences, lints them with the repository's own configuration, and checks that every line that should be refused is, and every line that should be allowed is. The probes are removed afterwards, even when a test fails.

It has no source of its own. Run it with `bun run test`, which `pre-push` does after `check` and `knip`, one job at a time, so no other job sees the probes.
