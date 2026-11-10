/**
 * The Client's State: plain data, one discriminated union per machine of the
 * statecharts in `docs/architecture.md`. Timers are not held here: each state
 * names the instants it is waiting for, and `timers.ts` derives the timer table from them.
 *
 * @packageDocumentation
 */
import type { CredentialName } from "@iirc/protocol/line";

import type { StsPolicy } from "./client.ts";
import type { IrcdAddress, NetworkConfiguration } from "./configuration.ts";
import type { CapName, Instant, IntentId } from "./ids.ts";
import type { Casemapping, Fact, Topic } from "./known.ts";
import type { EndReason } from "./news.ts";
import type { Seam } from "./seam.ts";

/** Cap negotiation, which runs for a whole Connection. */
export type Caps =
  /** `CAP LS 302` is sent, and the list is arriving. */
  | { readonly _tag: "Listing"; readonly offered: ReadonlyMap<CapName, string> }
  /** `CAP REQ` is sent, and answers are still to come. */
  | ({ readonly _tag: "Requesting" } & Asking & Negotiated)
  /** Features hold registration open before `CAP END`. */
  | ({ readonly _tag: "Holding" } & Negotiated)
  /** Negotiation is over. */
  | ({ readonly _tag: "Steady" } & Negotiated)
  /** After registration, `CAP REQ` is sent for caps `CAP NEW` offered, or to give some up. */
  | ({ readonly _tag: "Changing" } & Asking & Negotiated)
  /** The Ircd has no cap negotiation. */
  | { readonly _tag: "None" };

/** Requests awaiting their answers. Each part is bounded by what was asked. */
export interface Asking {
  /** How many `CAP REQ` Lines are still to be answered. */
  readonly asked: number;
  /** Every change still to be answered, such as `sasl` or `-echo-message`. */
  readonly requested: ReadonlySet<string>;
  /** What an `ACK` spread over several Lines has acknowledged so far, applied at its last. */
  readonly acked: ReadonlySet<string>;
  /** How many Lines that `ACK` has spread over so far. */
  readonly continued: number;
}

/** What negotiation has established. */
export interface Negotiated {
  readonly offered: ReadonlyMap<CapName, string>;
  readonly enabled: ReadonlySet<CapName>;
}

/** The silence check: one timer, against when we last heard something. */
interface Keepalive {
  /** When the last Line arrived. */
  readonly heard: Instant;
  /** Whether a lag `PING` has gone out since then. */
  readonly pinged: boolean;
  /** When the timer is due. */
  readonly check: Instant;
}

/** Where Self is with the Network. */
type Presence =
  | {
      readonly _tag: "Registering";
      /** Which nick is on offer: an index into the configured nicks, and past them the fallbacks. */
      readonly offer: number;
      /** The nick on offer, as `NICK` sent it, whatever the Configuration says since. */
      readonly nick: string | undefined;
      /** The realname, as `USER` sent it, whatever the Configuration says since. */
      readonly realname: string;
      readonly deadline: Instant;
      /** Self's account, if a login said so before `001`. */
      readonly account: Fact<string | null>;
      /** While Features hold registration, when the hold runs out. */
      readonly hold: Instant | undefined;
    }
  | {
      readonly _tag: "Session";
      readonly began: Instant;
      readonly nick: string;
      /** The Ircd's name, from `001`'s source. */
      readonly server: string;
      readonly mask: Fact<{ readonly user: string; readonly host: string }>;
      readonly account: Fact<string | null>;
      /** Self's realname, as registration sent it. */
      readonly realname: Fact<string>;
      /** Whether Self is away, as the Ircd confirmed it: not away as the Session begins. */
      readonly away: Fact<{ readonly message: string } | null>;
      readonly keepalive: Keepalive;
    };

/** One Connection, from `Dial` to `Closed`. */
export interface Link {
  readonly id: number;
  readonly ircd: IrcdAddress;
  readonly dialled: Instant;
  /** Set once we have hung up, or are about to, and why. The Client waits for `Closed`. */
  readonly closing: EndReason | undefined;
  readonly phase: LinkPhase;
}

/** A Connection is dialling, or open. */
type LinkPhase =
  | { readonly _tag: "Dialing" }
  | {
      readonly _tag: "Open";
      readonly opened: Instant;
      readonly caps: Caps;
      readonly presence: Presence;
      readonly isupport: ReadonlyMap<string, string>;
      readonly seam: Seam;
      /** Whether the Ircd has sent `ERROR`, which says it is closing the Connection. */
      readonly error: boolean;
      /** Whether a `903` arrived, live, on this Connection: Self logged in. */
      readonly loggedIn: boolean;
      /** What Lines have shown of other Users, by folded nick, while they share a Channel with Self. */
      readonly users: ReadonlyMap<string, Seen>;
      /**
       * The intents the Ircd has confirmed on this Connection, the latest last, at most
       * {@link maxConfirmed}. An `Unsent` for one of them refuses nothing.
       */
      readonly confirmed: readonly IntentId[];
      /**
       * The Owner's actions sent on this Connection that an error numeric could still be
       * tied to by its parameters, oldest first, at most {@link maxActing}.
       */
      readonly acting: readonly Acting[];
      /**
       * The message of the last `AWAY` sent on this Connection, `null` for one that came
       * back, or `undefined` before any, which a `306` confirms.
       */
      readonly asked: string | null | undefined;
    };

/**
 * One target of a Line of an action, awaiting its own answer: a nick of a `KICK`, or a
 * change of a `MODE`, by its sign and letter, such as `+o`, and its parameter, if any.
 * Names are kept as said, and folded by the Connection's casemapping when compared, so a
 * casemapping declared since still matches them.
 */
export interface Awaiting {
  readonly name: string | undefined;
  readonly mode: string | undefined;
}

/**
 * One Line of an Owner's action, awaiting what the Ircd says of it, so an error numeric
 * that names what it names can be tied to its intent.
 */
export interface Acting {
  readonly intent: IntentId;
  /** Its command, such as `KICK`, which `421` and `461` name. */
  readonly command: string;
  /** What the whole Line is about, such as a `KICK`'s Channel or a `MODE`'s target, as said. */
  readonly names: readonly string[];
  /**
   * The Line's targets the Ircd has not yet answered, each answered by its own success or
   * failure, one occurrence at a time. The Line is awaited until every one is.
   */
  readonly targets: readonly Awaiting[];
  /** Whether a refusal was already reported for its intent, by another of its Lines. */
  readonly reported: boolean;
}

/** How many Lines of actions a Connection keeps awaiting an answer. */
export const maxActing = 64;

/** How many confirmed intents a Connection remembers. */
export const maxConfirmed = 64;

/** What Lines have shown of a User. A fact no Feature keeps any longer is held as stale. */
export interface Seen {
  readonly nick: string;
  readonly mask: Fact<{ readonly user: string; readonly host: string }>;
  readonly away: Fact<{ readonly message: string } | null>;
}

/** The Network: whether it is wanted, and the Connection or the wait for one. */
export type Network =
  | { readonly _tag: "Unconfigured" }
  /** Disabled. */
  | { readonly _tag: "Idle"; readonly since: Instant | undefined }
  /** Waiting to redial after a Connection closed. */
  | { readonly _tag: "Waiting"; readonly since: Instant; readonly until: Instant }
  | { readonly _tag: "Connection"; readonly link: Link };

/** A member of a Channel. */
export interface Member {
  readonly nick: string;
  readonly prefixes: Fact<ReadonlySet<string>>;
  /**
   * Whether a Feature made the prefixes complete, where the floor would know them only in
   * part. They are known only while such a Feature is on.
   */
  readonly complete: boolean;
}

/**
 * A `NAMES` listing that has begun and not yet ended. Each `353` adds its part to
 * `parts`, and the parts are folded into `members` only every so often, so a `353` costs
 * what it lists rather than all the listing holds. A change to a member folds them first.
 */
export interface Listing {
  /** The members listed, as of the last fold. Keyed by folded nick. */
  readonly members: ReadonlyMap<string, Member>;
  /** Each part listed since, oldest first, as members keyed by folded nick. */
  readonly parts: readonly (readonly (readonly [string, Member])[])[];
}

/** What is known of a Channel Self is in. */
export interface Joined {
  readonly _tag: "Joined";
  readonly synced: boolean;
  /** Keyed by folded nick. */
  readonly members: ReadonlyMap<string, Member>;
  /** A `NAMES` listing that has begun and not yet ended. */
  readonly listing: Listing | undefined;
  readonly topic: Fact<Topic | null>;
  readonly modes: Fact<ReadonlyMap<string, string | null>>;
  /** Whether the replies to our `JOIN` are still arriving: no topic by their end means none. */
  readonly burst: boolean;
}

/** Where Self is with a Channel the Owner wants. */
export type ChannelPhase =
  | { readonly _tag: "Wanted" }
  | { readonly _tag: "Joining" }
  | Joined
  /** The Ircd refused us. With no `retry`, we wait for the next Session or Configuration. */
  | { readonly _tag: "Refused"; readonly retry: Instant | undefined }
  | { readonly _tag: "Kicked"; readonly retry: Instant };

/**
 * A Channel the Owner wants, or one Self was put in without asking, such as by an
 * oper's `SAJOIN` or another session of the same account.
 */
export interface Channel {
  /** Its name as the Owner wrote it. */
  readonly name: string;
  readonly key: CredentialName | undefined;
  /** Whether the Owner wants it. One that is not is modelled while Self is in it, and never joined again. */
  readonly wanted: boolean;
  /** How many joins in a row have failed, for the backoff. */
  readonly attempt: number;
  readonly phase: ChannelPhase;
}

/** A Read Marker of a Channel or a Direct Message partner: the name it is folded from, and how far the Owner has read. */
export interface Marker {
  /**
   * The name it was first marked by, or the nick a Direct Message partner took since,
   * which a new casemapping folds again.
   */
  readonly name: string;
  readonly read: Instant;
}

/**
 * The Owner's Read Markers, by Timeline. Channels and Direct Message partners are keyed
 * apart, by name folded with the casemapping the Network last declared, as `where` keys
 * them. Only the Owner adds one, so they are bounded by what the Owner marks.
 */
export interface ReadMarkers {
  readonly network: Instant | undefined;
  readonly channels: ReadonlyMap<string, Marker>;
  readonly directs: ReadonlyMap<string, Marker>;
}

/** The whole Client. */
export interface State {
  readonly configuration: NetworkConfiguration | undefined;
  readonly network: Network;
  /** The last Connection id given out, or 0. */
  readonly dialled: number;
  /** Which Ircd to dial next, as a count of dials. */
  readonly rotation: number;
  /** How many Connections in a row have failed, for the backoff. */
  readonly attempt: number;
  /**
   * How this Connection folds names: `rfc1459` until its Ircd says otherwise. Channel,
   * member, and User keys are folded by it.
   */
  readonly casemapping: Casemapping;
  /**
   * How the Network folds names, as an Ircd last declared it, on any Connection, or
   * `undefined` until one has, when `where` folds by `rfc1459`. It outlives Connections,
   * and the keys of `where` are folded by it, so a Timeline keeps one key while the
   * Network keeps one mapping.
   */
  readonly declared: Casemapping | undefined;
  /** Keyed by folded name. */
  readonly channels: ReadonlyMap<string, Channel>;
  /** STS policies, keyed by host as `hostKey` folds it. They outlive Connections. */
  readonly policies: ReadonlyMap<string, StsPolicy>;
  /** Set by `Stopping`: nothing is dialled until the next `Started`. */
  readonly stopping: boolean;
  /** How far the Owner has read each Timeline. They outlive Connections. */
  readonly markers: ReadMarkers;
  /**
   * The Owner's away message, or `undefined` while the Owner is not away. It outlives
   * Sessions, and each Session begins by sending it again.
   */
  readonly away: string | undefined;
}

/** Before anything has happened. */
export const initialState: State = {
  attempt: 0,
  away: undefined,
  casemapping: "rfc1459",
  channels: new Map(),
  configuration: undefined,
  declared: undefined,
  dialled: 0,
  markers: { channels: new Map(), directs: new Map(), network: undefined },
  network: { _tag: "Unconfigured" },
  policies: new Map(),
  rotation: 0,
  stopping: false,
};

/** An open Connection's phase. */
export type Open = Extract<LinkPhase, { readonly _tag: "Open" }>;

/** A Session's presence. */
export type InSession = Extract<Presence, { readonly _tag: "Session" }>;
