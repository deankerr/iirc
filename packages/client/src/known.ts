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

/**
 * How the Network folds names, from `CASEMAPPING` and `UTF8MAPPING`, named as
 * `@iirc/protocol/casemapping` names them. Until it says, `rfc1459`. A mapping the
 * Client does not know folds as `ascii`, which can split one name in two but never
 * merges two.
 */
export type Casemapping = "ascii" | "rfc1459" | "rfc1459-strict" | "rfc8265";

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
  /** The realname from registration, which `setname` keeps up to date. */
  readonly realname: Fact<string>;
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
  /**
   * Whether the Owner wants Self in it. Self can be put in a Channel without asking,
   * such as by an oper's `SAJOIN` or another session of the same account. Such a
   * Channel is known while Self is in it, and never joined again.
   */
  readonly wanted: boolean;
  readonly standing: Standing;
  readonly topic: Fact<Topic | null>;
  /** Each mode set, with its parameter. A key shows as set, with `null`, never its value. */
  readonly modes: Fact<ReadonlyMap<string, string | null>>;
  /** Keyed by nick, folded by the Network's casemapping. */
  readonly members: ReadonlyMap<string, MemberKnowledge>;
}

/** A membership prefix from `PREFIX`: the mode a member holds, and the symbol shown before a nick. */
export interface Rank {
  readonly mode: string;
  readonly symbol: string;
}

/**
 * How each Channel mode takes a parameter, from `CHANMODES`, or RFC 1459 and 2812's
 * until an Ircd says. Membership modes, from `PREFIX`, are apart, and always take one.
 */
export interface ChannelModeKinds {
  /** Type A: a list, such as bans, with a parameter whenever it is changed. */
  readonly list: string;
  /** Type B: a parameter whenever it is changed, such as a key. */
  readonly always: string;
  /** Type C: a parameter only when it is set, such as a limit. */
  readonly whenSet: string;
  /** Type D: never a parameter. */
  readonly flags: string;
}

/**
 * One Channel as known, for a View that shows it alone, built from that Channel without
 * the rest of the Network.
 */
export interface ChannelView {
  /** The Channel's key, its name folded with `casemapping`. */
  readonly key: string;
  /** How the Connection folds names, which folds `key` and the members' keys. */
  readonly casemapping: Casemapping;
  /** The membership prefixes, from `PREFIX`, most privileged first. */
  readonly ranks: readonly Rank[];
  /** How the Network's other Channel modes take a parameter, from `CHANMODES`. */
  readonly chanmodes: ChannelModeKinds;
  /** What starts a Channel's name on the Network, from `CHANTYPES`. */
  readonly chantypes: string;
  readonly channel: ChannelKnowledge;
  /** Each member as a User, Self included, keyed as the members are. */
  readonly users: ReadonlyMap<string, UserKnowledge>;
}

/** Everything a Client knows of its Network. Keys are folded by the Network's casemapping. */
export interface Knowledge {
  readonly session: SessionKnowledge;
  readonly casemapping: Casemapping;
  /**
   * How the Network folds names as an Ircd last declared it, on any Connection, which
   * outlives Connections and folds the keys of `where`, or `undefined` until one has.
   */
  readonly declared: Casemapping | undefined;
  /** `CHANTYPES`, what a Channel's name starts with, while a Session has said, or `undefined`. */
  readonly chantypes: string | undefined;
  readonly self: UserKnowledge | undefined;
  readonly channels: ReadonlyMap<string, ChannelKnowledge>;
  readonly users: ReadonlyMap<string, UserKnowledge>;
}
