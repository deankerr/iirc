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

/** One mode to set or unset, with its parameter, or `null` for none. */
export const ModeRequest = Schema.Struct({
  mode: Schema.String,
  param: Schema.NullOr(Schema.String),
  set: Schema.Boolean,
});

/** The decoded form of {@link ModeRequest}. */
export type ModeRequest = typeof ModeRequest.Type;

/**
 * What the Owner can do on a Network besides saying something. Each is built only
 * through `@iirc/protocol`'s builders, and checked against what the Client knows of the
 * Network before it is sent.
 */
export const Action = Schema.TaggedUnion({
  /** Mark Self away with a message, or back with `null`. It outlives Sessions. */
  Away: { message: Schema.NullOr(Schema.String) },
  /** Invite a nick to a Channel. */
  Invite: { channel: Schema.String, nick: Schema.String },
  /** Kick one or more nicks from a Channel, with a reason or none. */
  Kick: {
    channel: Schema.String,
    nicks: Schema.NonEmptyArray(Schema.String),
    reason: Schema.NullOr(Schema.String),
  },
  /** Change a Channel's modes, or Self's. */
  Mode: { changes: Schema.NonEmptyArray(ModeRequest), target: Schema.String },
  /** Change Self's nick for this Session. */
  Nick: { nick: Schema.String },
  /** A Line written as text, sent as it reads, as `/quote` sends it. */
  Raw: { line: Schema.String },
  /** Set a Channel's topic, or clear it with `""`. */
  Topic: { channel: Schema.String, text: Schema.String },
});

/** The decoded form of {@link Action}. */
export type Action = typeof Action.Type;

/**
 * What the Owner can ask a Network, and collect the reply to: a Lookup. Each is built
 * through `@iirc/protocol`'s builders, and its reply, which may span many Lines, is read
 * by structure into one result.
 */
export const Lookup = Schema.TaggedUnion({
  /** `WHOIS` of one nick: what the Network says of that User now. */
  Whois: { nick: Schema.String },
  /** `WHOWAS` of one nick: who held it before. */
  Whowas: { nick: Schema.String },
});

/** The decoded form of {@link Lookup}. */
export type Lookup = typeof Lookup.Type;

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
  /** The Owner wants to act on the Network, with an intent id from the Runtime. */
  Act: { action: Action, at: Instant, intent: IntentId },
  /** A Connection is over. */
  Closed: { at: Instant, connection: ConnectionId, reason: CloseReason },
  /** The Owner's Configuration for this Network, whole. */
  Configured: { at: Instant, configuration: NetworkConfiguration },
  /**
   * A timer the Client asked for is due. `due` is the instant its `Wake` set, so a
   * firing from an earlier setting of the same timer is told apart and ignored.
   */
  Fired: { at: Instant, due: Instant, timer: TimerId },
  /**
   * The Owner wants to look something up on the Network, with an intent id from the
   * Runtime. Its result is one `LookedUp` News for that intent.
   */
  Look: { at: Instant, intent: IntentId, lookup: Lookup },
  /** A Connection the Client dialled is open. */
  Opened: { at: Instant, connection: ConnectionId },
  /**
   * The Owner has read a Timeline up to the instant `read`: a Target's, a Channel or a
   * Direct Message partner named as `Say` names one, or with `target` null, the Network's
   * own. A Read Marker only moves forward, so an instant no later than the one held
   * changes nothing.
   */
  Read: { at: Instant, read: Instant, target: Schema.NullOr(Schema.String) },
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
