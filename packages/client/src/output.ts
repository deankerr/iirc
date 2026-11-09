import { OutboundLine, SecretLine } from "@iirc/protocol/line";
import { Schema } from "effect";

import { IrcdAddress } from "./configuration.ts";
import { ConnectionId, Instant, TimerId } from "./ids.ts";

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
  /** Send a Line. It counts as sent once it is output. */
  Send: { connection: ConnectionId, line: OutboundLine },
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
 * The timer table is a projection of outputs: the last `Wake` for each id. The Runtime
 * folds it while replaying the Journal, and so does the test kit.
 * @param table - The timers set before these outputs.
 * @param outputs - One step's outputs, in order.
 * @returns The timers set after them.
 */
export const timers = (table: TimerTable, outputs: readonly Output[]): TimerTable => {
  const next = new Map(table);

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
