import path from "node:path";

import { Clock, Console, Effect, FileSystem, Option } from "effect";

import { failed, unableExitCode, verdictExitCode } from "./command-failed.ts";
import { describeFailure } from "./failure.ts";
import { heardFrom } from "./folding.ts";
import { readLog, sourceOf } from "./log-reading.ts";
import type { Client } from "./log-reading.ts";
import type { CheckPair } from "./pair.ts";
import { pairLabel, reportLine, summaryLine, unableLine } from "./render.ts";
import { judge } from "./verdict.ts";
import type { Tolerances } from "./verdict.ts";

// PROOF-5, the checking half. It keeps nothing between runs: each one reads both Logs in
// full and judges them again, so a verdict is always about everything that happened, and
// a restored Log or a missed run changes no state that could drift.

/** One Daemon the check reads. */
interface Side {
  readonly client: Client;
  readonly url: string;
}

/** What `check` is asked to do. */
export interface CheckInput {
  readonly pairs: readonly CheckPair[];
  /** A file to add one line of JSON to, for each run. */
  readonly report: Option.Option<string>;
  readonly receiver: Side;
  readonly sender: Side;
  readonly tolerances: Tolerances;
}

// The receiver is read before the sender. Whatever the receiver heard, the sender had
// already recorded, so reading in this order can show a Message as not yet received but
// never as received and never sent. A Message in that window is too recent to count as
// missing, which `settleMillis` covers.
const judgePair = Effect.fnUntraced(function* (
  { receiver, sender, tolerances }: Pick<CheckInput, "receiver" | "sender" | "tolerances">,
  pair: CheckPair,
  now: number
) {
  const readSide = (
    side: Side,
    network: CheckPair["sender"],
    kind: readonly ["Line", "Dropped"] | readonly ["Line"]
  ) =>
    Effect.mapError(
      readLog(sourceOf(side.client, network, kind), pair.target),
      describeFailure(side.url)
    );

  const atReceiver = yield* readSide(receiver, pair.receiver, ["Line"]);
  const atSender = yield* readSide(sender, pair.sender, ["Line", "Dropped"]);

  return judge({
    gaps: { receiver: atReceiver.gaps, sender: atSender.gaps },
    now,
    receipts: heardFrom(atReceiver.heard, atSender.nicks),
    sends: atSender.sends,
    tolerances,
  });
});

const appendTo = (file: string, line: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(file, `${line}\n`, { flag: "a" });
  }).pipe(
    Effect.mapError((error) =>
      failed(
        `iirc-soak check: could not write the report to ${file}: ${error.message}`,
        unableExitCode
      )
    )
  );

const report = (file: Option.Option<string>, line: string) =>
  Option.isSome(file) ? appendTo(file.value, line) : Effect.void;

/**
 * Reads both Daemons' Logs, judges every pair, prints one line for each, and adds a line
 * to the report file if there is one. It fails if any pair fails (exit 1), and if it
 * could not read a Log (exit 3), because a check that could not look has proven nothing.
 * @param input - The Daemons, the pairs, and the tolerances.
 * @returns Nothing, if every pair is sound.
 */
export const check = (input: CheckInput) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    const results = yield* Effect.forEach(
      input.pairs,
      (pair) => Effect.map(judgePair(input, pair, now), (verdict) => [pair, verdict] as const),
      { concurrency: 1 }
    ).pipe(
      Effect.tapError((reason) => Effect.ignore(report(input.report, unableLine(now, reason)))),
      Effect.mapError((reason) =>
        failed(`iirc-soak check: could not check: ${reason}`, unableExitCode)
      )
    );

    for (const [pair, verdict] of results) {
      yield* Console.log(summaryLine(pair, verdict, now));
    }

    yield* report(input.report, reportLine(now, results));

    const failing = results.filter(([, verdict]) => !verdict.ok);

    return failing.length === 0
      ? undefined
      : yield* failed(
          `iirc-soak check: FAILED: ${failing.map(([pair]) => pairLabel(pair)).join(", ")}`,
          verdictExitCode
        );
  });
