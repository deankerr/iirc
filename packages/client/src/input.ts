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

/** The kinds of Message the Owner can say. */
export const SayKind = Schema.Literals(["Privmsg", "Notice", "Action"]);

/** The decoded form of {@link SayKind}. */
export type SayKind = typeof SayKind.Type;

/**
 * Everything that can happen to a Client. Each input is journaled before it is stepped,
 * and carries the instant it happened as the Runtime saw it.
 */
export const Input = Schema.TaggedUnion({
  /** A Connection is over. */
  Closed: { at: Instant, connection: ConnectionId, reason: CloseReason },
  /** The Owner's Configuration for this Network, whole. */
  Configured: { at: Instant, configuration: NetworkConfiguration },
  /** A timer the Client asked for is due. */
  Fired: { at: Instant, timer: TimerId },
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
});

/** The decoded form of {@link Input}. */
export type Input = typeof Input.Type;
