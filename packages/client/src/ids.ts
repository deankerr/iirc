import { Schema } from "effect";

/** An instant, in milliseconds since the Unix epoch. The Client reads time only from these. */
export const Instant = Schema.Int.pipe(Schema.brand("Instant"));

/** The decoded form of {@link Instant}. */
export type Instant = typeof Instant.Type;

/** A Connection, numbered by the Client when it asks for one, so a late input from an old one is told apart. */
export const ConnectionId = Schema.Int.pipe(Schema.brand("ConnectionId"));

/** The decoded form of {@link ConnectionId}. */
export type ConnectionId = typeof ConnectionId.Type;

/** A timer, named by the Client. The Runtime only holds it and gives it back when due. */
export const TimerId = Schema.String.pipe(Schema.brand("TimerId"));

/** The decoded form of {@link TimerId}. */
export type TimerId = typeof TimerId.Type;

/** Something the Owner asked for, named by the Runtime, so an answer can be matched to it. */
export const IntentId = Schema.String.pipe(Schema.brand("IntentId"));

/** The decoded form of {@link IntentId}. */
export type IntentId = typeof IntentId.Type;

/** An IRCv3 capability, as an Ircd names it in `CAP LS`. */
export const CapName = Schema.String.pipe(Schema.brand("CapName"));

/** The decoded form of {@link CapName}. */
export type CapName = typeof CapName.Type;

/** A Feature, by the name it has in the Client's registry. */
export const FeatureName = Schema.String.pipe(Schema.brand("FeatureName"));

/** The decoded form of {@link FeatureName}. */
export type FeatureName = typeof FeatureName.Type;

/** A Message's id, as an Ircd gives it with `msgid`. */
export const MessageId = Schema.String.pipe(Schema.brand("MessageId"));

/** The decoded form of {@link MessageId}. */
export type MessageId = typeof MessageId.Type;
