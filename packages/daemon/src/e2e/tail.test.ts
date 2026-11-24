/**
 * The Tail, end to end: a real Daemon logs an option's change into it, and a Daemon started
 * again on the same data directory has a Tail of its own, from its own start line.
 */
import { Effect } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import { startDaemon } from "../testing/running.ts";
import { makeKey, temporaryDirectory } from "../testing/world.ts";

const run = async <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(test));

describe("the Tail across a restart", () => {
  it("holds an option's change, and starts again from the start line when the Daemon does", async () => {
    const result = await run(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);

        const first = yield* startDaemon({ dataDir }, key);

        yield* first.api.ui.set({
          params: { option: "timeline.timeFormat" },
          payload: { value: "none" },
          query: {},
        });

        const before = yield* first.api.tail.read();

        yield* first.stop;

        const second = yield* startDaemon({ dataDir }, key);
        const after = yield* second.api.tail.read();

        yield* second.stop;

        return { after, before };
      })
    );

    const optionLines = (lines: typeof result.before.lines) =>
      lines.filter(
        (line) =>
          line.message.startsWith("Changed ui option") &&
          line.message.includes('"timeline.timeFormat"')
      );

    const [first] = result.before.lines;
    const [again] = result.after.lines;

    expect([first, again]).toMatchObject([
      { annotations: { version: "0.0.0" }, level: "Info", n: 1 },
      { annotations: { version: "0.0.0" }, level: "Info", n: 1 },
    ]);
    expect([
      optionLines(result.before.lines).length,
      optionLines(result.after.lines).length,
    ]).toStrictEqual([1, 0]);
    expect(result.after.started).toBeGreaterThan(result.before.started);
  });
});
