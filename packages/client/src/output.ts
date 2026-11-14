import { OutboundLine, SecretLine } from "@iirc/protocol/line";
import { Schema } from "effect";

import { IrcdAddress } from "./configuration.ts";
import { ConnectionId, Instant, IntentId, TimerId } from "./ids.ts";
import type { Input } from "./input.ts";

/**
 * The CTCP request a `Send` answers: who asked, where they sent it, and its command, so an
 * `Unsent` of the answer can be reported where the request was. `channels` are the Channels
 * the request was placed in, as named, fixed as it arrived, and empty for one placed by who
 * asked, which `answer` numbers among Self's answers, so the Client can tell where that
 * partner's Timeline has moved since. Both are absent from an answer recorded before they
 * were, which is placed from the rest as the `Unsent` arrives.
 */
export const Answers = Schema.Struct({
  answer: Schema.Int,
  channels: Schema.Array(Schema.String),
  command: Schema.String,
  nick: Schema.String,
  target: Schema.String,
});

/** The decoded form of {@link Answers}. */
export type Answers = typeof Answers.Type;

/**
 * Everything a Client can ask the Runtime to do. Outputs are journaled with the input
 * that caused them, and carried out in order.
 */
export const Output = Schema.TaggedUnion({
  /**
   * Open a new Connection, numbered by the Client. The address is worked out, not copied:
   * while an STS policy holds for the host, it is TLS on the policy's port, whatever
   * Configuration says. A failed TLS Connection is never retried in plaintext.
   */
  Dial: { connection: ConnectionId, ircd: IrcdAddress },
  /** End a Connection. The Client still waits for its `Closed`. */
  Hangup: { connection: ConnectionId },
  /**
   * Send a Line. It counts as sent unless an `Unsent` input says otherwise. `intent` is set
   * on every Line of a `Say` or an action, and `answers` on a CTCP answer, so an `Unsent`
   * can be tied back to what it was for.
   */
  Send: {
    answers: Schema.optionalKey(Answers),
    connection: ConnectionId,
    intent: Schema.optionalKey(IntentId),
    line: OutboundLine,
  },
  /** Send a Line with a Credential filled in by the Runtime, which the Journal records by name. */
  SendSecret: { connection: ConnectionId, line: SecretLine },
  /** Set a timer to fire at an instant, replacing any earlier one with the same id, or cancel it with `null`. */
  Wake: { at: Schema.NullOr(Instant), timer: TimerId },
});

/** The decoded form of {@link Output}. */
export type Output = typeof Output.Type;

/** The timers that are set, and when each is due. */
export type TimerTable = ReadonlyMap<TimerId, Instant>;

/**
 * The timer table is a projection of the Journal's inputs and outputs. A timer is set by
 * the last `Wake` for its id, and is one-shot: a `Fired` input whose `due` matches the
 * table consumes it, so the timer is gone unless that step's outputs set it again. A
 * stale `Fired`, whose `due` does not match, changes nothing. The Runtime folds this
 * over every step while replaying the Journal, and so does the test kit.
 * @param table - The timers set before this step.
 * @param input - The step's input.
 * @param outputs - The step's outputs, in order.
 * @returns The timers set after it.
 */
export const timers = (table: TimerTable, input: Input, outputs: readonly Output[]): TimerTable => {
  const next = new Map(table);

  if (input._tag === "Fired" && next.get(input.timer) === input.due) {
    next.delete(input.timer);
  }

  for (const output of outputs) {
    if (output._tag === "Wake") {
      if (output.at === null) {
        next.delete(output.timer);
      } else {
        next.set(output.timer, output.at);
      }
    }
  }

  return next;
};
