/**
 * What a Client knows, for Views. Nothing here names a cap, a Feature, or a machine:
 * a View learns how a fact is known, and never why.
 *
 * @packageDocumentation
 */
import type { Instant } from "./ids.ts";

/**
 * Where a fact came from.
 *
 * - `ircd`: the Ircd said so as it happened, such as a `JOIN` or a `NAMES` listing on joining.
 * - `replied`: the Ircd said so in reply to a Lookup, which is true as of the reply.
 * - `receipt`: we inferred it from when a Line arrived, such as a Message's time without `server-time`.
 * - `ours`: we said or set it ourselves.
 */
export type Provenance = "ircd" | "replied" | "receipt" | "ours";

/** A fact known to be true, from a source, as of an instant. */
export interface KnownFact<T> {
  readonly _tag: "Known";
  readonly value: T;
  readonly from: Provenance;
  readonly at: Instant;
}

/** A set known to hold at least these members. There may be more. */
export interface PartialFact<T> {
  readonly _tag: "Partial";
  readonly atLeast: T;
  readonly from: Provenance;
  readonly at: Instant;
}

/** A fact that was known, and is no longer kept up to date. */
export interface StaleFact<T> {
  readonly _tag: "Stale";
  readonly was: T;
  readonly since: Instant;
}

/** A fact that nothing has told us. */
export interface UnknownFact {
  readonly _tag: "Unknown";
}

/**
 * A fact with how it is known. Only a set can be partial, because only a set has a
 * lower bound.
 */
export type Fact<T> =
  | KnownFact<T>
  | ([T] extends [ReadonlySet<unknown>] ? PartialFact<T> : never)
  | StaleFact<T>
  | UnknownFact;

/** How the Network folds names, from `CASEMAPPING`. Until it says, `rfc1459`. */
export type Casemapping = "ascii" | "rfc1459" | "strict-rfc1459" | "rfc7613";

/** Where the Client is with the Network. */
export type SessionKnowledge =
  | { readonly _tag: "Offline"; readonly since: Instant | undefined }
  | { readonly _tag: "Connecting"; readonly since: Instant }
  | { readonly _tag: "Registering"; readonly since: Instant }
  | { readonly _tag: "Registered"; readonly since: Instant; readonly ircd: string };

/** A User as we know them. Self is one too. */
export interface UserKnowledge {
  readonly nick: string;
  readonly mask: Fact<{ readonly user: string; readonly host: string }>;
  readonly account: Fact<string | null>;
  readonly away: Fact<{ readonly message: string } | null>;
}

/** A member of a Channel, with the prefix modes they hold, such as `o` and `v`. */
export interface MemberKnowledge {
  readonly nick: string;
  readonly prefixes: Fact<ReadonlySet<string>>;
}

/** A Channel's topic. */
export interface Topic {
  readonly text: string;
  readonly setBy: string | undefined;
  readonly setAt: Instant | undefined;
}

/** Where Self stands with a Channel the Owner wants, or was in. */
export type Standing = "Wanted" | "Joining" | "Joined" | "Refused" | "Kicked";

/** A Channel as we know it. */
export interface ChannelKnowledge {
  readonly name: string;
  readonly standing: Standing;
  readonly topic: Fact<Topic | null>;
  /** Each mode set, with its parameter. A key shows as set, with `null`, never its value. */
  readonly modes: Fact<ReadonlyMap<string, string | null>>;
  /** Keyed by nick, folded by the Network's casemapping. */
  readonly members: ReadonlyMap<string, MemberKnowledge>;
}

/** Everything a Client knows of its Network. Keys are folded by the Network's casemapping. */
export interface Knowledge {
  readonly session: SessionKnowledge;
  readonly casemapping: Casemapping;
  readonly self: UserKnowledge | undefined;
  readonly channels: ReadonlyMap<string, ChannelKnowledge>;
  readonly users: ReadonlyMap<string, UserKnowledge>;
}
