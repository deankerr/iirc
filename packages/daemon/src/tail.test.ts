/** The Tail: how many lines it holds, and where each line goes. */
import { Effect, Layer, Logger } from "effect";
import { TestConsole } from "effect/testing";
import { describe, expect, it } from "vitest";

import { layerLogger } from "./daemon.ts";
import { Tail, layerTail, layerTailLogging, tailCapacity } from "./tail.ts";

describe("the Tail's size", () => {
  it("holds the last 4096 lines, dropping the oldest, and numbers on", async () => {
    const lines = await Effect.runPromise(
      Effect.gen(function* () {
        const tail = yield* Tail;

        yield* Effect.forEach(
          Array.from({ length: tailCapacity + 1 }, (_, index) => index + 1),
          (number) => Effect.logInfo(`line ${number}`)
        ).pipe(Effect.provide(Logger.layer([tail.logger])));

        return (yield* tail.read).lines;
      }).pipe(Effect.provide(layerTail("0.0.0")))
    );

    expect(tailCapacity).toBe(4096);
    expect(lines).toHaveLength(4096);
    expect([lines[0]?.n, lines[0]?.message, lines.at(-1)?.n, lines.at(-1)?.message]).toStrictEqual([
      2,
      "line 2",
      4097,
      "line 4097",
    ]);
  });
});

describe("where a line goes", () => {
  it("sends Debug to the Tail only, and Info to both, to stderr as logfmt", async () => {
    const { errors, expected, lines } = await Effect.runPromise(
      Effect.gen(function* () {
        const tail = yield* Tail;
        const expected: string[] = [];

        // What logfmt makes of each Info line, from the same options the loggers are given.
        const oracle = Logger.make((options) => {
          if (options.logLevel === "Info") {
            expected.push(Logger.formatLogFmt.log(options));
          }
        });

        yield* Effect.gen(function* () {
          yield* Effect.logDebug("quiet");
          yield* Effect.logInfo("loud").pipe(Effect.annotateLogs({ it: "is" }));
        }).pipe(Effect.provide(Logger.layer([oracle], { mergeWithExisting: true })));

        return {
          errors: yield* TestConsole.errorLines,
          expected,
          lines: (yield* tail.read).lines,
        };
      }).pipe(
        // As the Daemon is run: its logger is the one in force outside the Tail's.
        Effect.provide(
          layerTailLogging("0.0.0").pipe(
            Layer.provideMerge(layerLogger),
            Layer.provideMerge(TestConsole.layer)
          )
        )
      )
    );

    expect(lines.map(({ level, message }) => [level, message])).toStrictEqual([
      ["Info", expect.any(String)],
      ["Debug", "quiet"],
      ["Info", "loud"],
    ]);

    // The start line, then the Info line, and not the Debug one between them.
    expect(errors).toHaveLength(2);
    expect(errors.at(-1)).toBe(expected[0]);
  });
});
