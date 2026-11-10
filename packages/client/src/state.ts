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
    };

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
}

/** Before anything has happened. */
export const initialState: State = {
  attempt: 0,
  casemapping: "rfc1459",
  channels: new Map(),
  configuration: undefined,
  declared: undefined,
  dialled: 0,
  network: { _tag: "Unconfigured" },
  policies: new Map(),
  rotation: 0,
  stopping: false,
};

/** An open Connection's phase. */
export type Open = Extract<LinkPhase, { readonly _tag: "Open" }>;

/** A Session's presence. */
export type InSession = Extract<Presence, { readonly _tag: "Session" }>;
