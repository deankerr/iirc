import { OutboundLine, SecretLine } from "@iirc/protocol/line";
import { Schema } from "effect";

import { NetworkConfiguration } from "./configuration.ts";
import { ConnectionId, Instant, IntentId, TimerId } from "./ids.ts";

/**
 * How a Connection ended, as the Transport saw it. `HungUp` is the end the Client asked
 * for with a `Hangup`.
 */
export const CloseReason = Schema.Literals([
  "Ended",
  "Reset",
  "Refused",
  "Unreachable",
  "TimedOut",
  "Tls",
  "HungUp",
]);

/** The decoded form of {@link CloseReason}. */
export type CloseReason = typeof CloseReason.Type;

/**
 * Why the Runtime could not fill a `SecretLine`: the Vault holds no such Credential, the
 * Vault could not be read, or the Credential's value cannot be sent in that Line, such as
 * a password with a line break.
 */
export const UnfilledReason = Schema.Literals(["Missing", "Unavailable", "Unsendable"]);

/** The decoded form of {@link UnfilledReason}. */
export type UnfilledReason = typeof UnfilledReason.Type;

/** The kinds of Message the Owner can say. */
export const SayKind = Schema.Literals(["Privmsg", "Notice", "Action"]);

/** The decoded form of {@link SayKind}. */
export type SayKind = typeof SayKind.Type;

/**
 * A Line the Client output that never left: a `Send` or a `SendSecret`, as it was output.
 * It is the same shape as those outputs, so the Runtime gives back exactly what it was
 * given.
 */
export const UnsentLine = Schema.TaggedUnion({
  Send: {
    connection: ConnectionId,
    intent: Schema.optionalKey(IntentId),
    line: OutboundLine,
  },
  SendSecret: { connection: ConnectionId, line: SecretLine },
});

/** The decoded form of {@link UnsentLine}. */
export type UnsentLine = typeof UnsentLine.Type;

/**
 * Everything that can happen to a Client. Each input is journaled before it is stepped,
 * and carries the instant it happened as the Runtime saw it.
 */
export const Input = Schema.TaggedUnion({
  /** A Connection is over. */
  Closed: { at: Instant, connection: ConnectionId, reason: CloseReason },
  /** The Owner's Configuration for this Network, whole. */
  Configured: { at: Instant, configuration: NetworkConfiguration },
  /**
   * A timer the Client asked for is due. `due` is the instant its `Wake` set, so a
   * firing from an earlier setting of the same timer is told apart and ignored.
   */
  Fired: { at: Instant, due: Instant, timer: TimerId },
  /** A Connection the Client dialled is open. */
  Opened: { at: Instant, connection: ConnectionId },
  /** One Line's bytes, without its line ending, framed by the Transport. */
  Received: { at: Instant, bytes: Schema.Uint8Array, connection: ConnectionId },
  /** The Owner wants to try connecting now, cutting a wait short. */
  Retry: { at: Instant },
  /** The Owner wants to say something to a Target. */
  Say: { at: Instant, intent: IntentId, kind: SayKind, target: Schema.String, text: Schema.String },
  /** The Runtime has started. A Connection the Client believed open is over. */
  Started: { at: Instant },
  /**
   * The Runtime is shutting down. The Client says `QUIT` on its Connection and hangs it
   * up, and dials nothing until the next `Started`.
   */
  Stopping: { at: Instant },
  /**
   * The Runtime could not fill a `SendSecret`, so nothing was sent. It is stepped after
   * the rest of that step's outputs are carried out.
   */
  Unfilled: { at: Instant, connection: ConnectionId, line: SecretLine, reason: UnfilledReason },
  /**
   * Lines the Client output on a Connection that never left, in the order they were
   * output: the Runtime's queue for that Connection dropped them, because the Connection
   * ended or its hang-up ran out of time. A `Send` counts as sent unless an `Unsent` says
   * otherwise.
   */
  Unsent: { at: Instant, connection: ConnectionId, outputs: Schema.Array(UnsentLine) },
});

/** The decoded form of {@link Input}. */
export type Input = typeof Input.Type;
