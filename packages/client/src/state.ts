/**
 * The Client's State: plain data, one discriminated union per machine of the
 * statecharts in the architecture proposal (§3). Timers are not held here: each state
 * names the instants it is waiting for, and `timers.ts` derives the timer table from them.
 *
 * @packageDocumentation
 */
import type { CredentialName } from "@iirc/protocol/line";

import type { IrcdAddress, NetworkConfiguration } from "./configuration.ts";
import type { CapName, Instant } from "./ids.ts";
import type { Casemapping, Fact, Topic } from "./known.ts";
import type { EndReason } from "./news.ts";
import type { Seam } from "./seam.ts";

/** Cap negotiation, which runs for a whole Connection. */
export type Caps =
  /** `CAP LS 302` is sent, and the list is arriving. */
  | { readonly _tag: "Listing"; readonly offered: ReadonlyMap<CapName, string> }
  /** `CAP REQ` is sent, and `asked` answers are still to come. */
  | ({ readonly _tag: "Requesting"; readonly asked: number } & Negotiated)
  /** Features hold registration open before `CAP END`. */
  | ({ readonly _tag: "Holding" } & Negotiated)
  /** Negotiation is over. */
  | ({ readonly _tag: "Steady" } & Negotiated)
  /** After registration, `CAP REQ` is sent for caps `CAP NEW` offered. */
  | ({ readonly _tag: "Changing"; readonly asked: number } & Negotiated)
  /** The Ircd has no cap negotiation. */
  | { readonly _tag: "None" };

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
      /** What Lines have shown of other Users, by folded nick, while they share a Channel with Self. */
      readonly users: ReadonlyMap<string, Seen>;
    };

/** What Lines have shown of a User. */
export interface Seen {
  readonly nick: string;
  readonly mask: Mask | undefined;
  readonly away:
    | { readonly value: { readonly message: string } | null; readonly at: Instant }
    | undefined;
}

/** A User's mask, and when a Line showed it. */
interface Mask {
  readonly user: string;
  readonly host: string;
  readonly at: Instant;
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
}

/** What is known of a Channel Self is in. */
export interface Joined {
  readonly _tag: "Joined";
  readonly synced: boolean;
  /** Keyed by folded nick. */
  readonly members: ReadonlyMap<string, Member>;
  /** A `NAMES` listing that has begun and not yet ended. */
  readonly listing: ReadonlyMap<string, Member> | undefined;
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
  /** How the Network folds names, as last announced. Channel and member keys are folded by it. */
  readonly casemapping: Casemapping;
  /** Keyed by folded name. */
  readonly channels: ReadonlyMap<string, Channel>;
}

/** Before anything has happened. */
export const initialState: State = {
  attempt: 0,
  casemapping: "rfc1459",
  channels: new Map(),
  configuration: undefined,
  dialled: 0,
  network: { _tag: "Unconfigured" },
  rotation: 0,
};

/** An open Connection's phase. */
export type Open = Extract<LinkPhase, { readonly _tag: "Open" }>;

/** A Session's presence. */
export type InSession = Extract<Presence, { readonly _tag: "Session" }>;
