import { Clock, Console, Effect } from "effect";

import { failed, verdictExitCode } from "./command-failed.ts";
import { describeFailure } from "./failure.ts";
import type { Client } from "./log-reading.ts";
import type { SendPair } from "./pair.ts";
import { soakText } from "./soak-text.ts";

// PROOF-5, the sending half: one counted Message to each pair, and nothing else. It says
// `soak <minute> <millis>` of the moment the run began, so it needs no state that could lag,
// be lost, or race a second run. The minute is skipped only in a minute the sender did not
// run, and two Messages of one minute, which a clock stepped back can make, are told
// apart by their milliseconds.

const sendOne = (client: Client, daemon: string, { network, target }: SendPair, millis: number) =>
  Effect.gen(function* () {
    const text = soakText(millis);
    const sent = yield* client.daemon.send({ payload: { network, target, text } });

    yield* Console.log(
      `soak ${network}=${target}: sent "${text}" (${
        sent.status === "written" ? `written, Entry ${sent.sequence}` : "still queued"
      })`
    );
  }).pipe(
    Effect.mapError(
      (error) => `soak ${network}=${target}: not sent, ${describeFailure(daemon)(error)}`
    )
  );

/**
 * Sends the counted Message of this moment to each pair, and fails if any send did not
 * succeed. A pair that fails does not stop the others.
 * @param client - A client of the sender, with a `chat` key.
 * @param daemon - The sender's URL, for the words of a failure.
 * @param pairs - Where to send.
 * @returns Nothing, once every send succeeded.
 */
export const send = (client: Client, daemon: string, pairs: readonly SendPair[]) =>
  Effect.gen(function* () {
    // Read before anything is sent, so that every pair of a run has the moment it began.
    const millis = yield* Clock.currentTimeMillis;

    const results = yield* Effect.forEach(
      pairs,
      (pair) => Effect.result(sendOne(client, daemon, pair, millis)),
      { concurrency: 1 }
    );

    const refusals = results.flatMap((result) =>
      result._tag === "Failure" ? [result.failure] : []
    );

    return refusals.length === 0
      ? undefined
      : yield* failed(
          `${refusals.join("\n")}\niirc-soak send: ${refusals.length} of ${pairs.length} sends failed`,
          verdictExitCode
        );
  });
