/**
 * The Client's State: plain data, one discriminated union per machine of the
 * statecharts in `ARCHITECTURE.md`. Timers are not held here: each state
 * names the instants it is waiting for, and `timers.ts` derives the timer table from them.
 *
 * @packageDocumentation
 */
import type { CredentialName } from "@iirc/protocol/line";

import type { StsPolicy } from "./client.ts";
import type { IrcdAddress, NetworkConfiguration } from "./configuration.ts";
import { Instant } from "./ids.ts";
import type { CapName, IntentId } from "./ids.ts";
import type { Lookup } from "./input.ts";
import type { Casemapping, Fact, Topic } from "./known.ts";
import type {
  ChannelEntry,
  EndReason,
  MaskEntry,
  NamesEntry,
  Notes,
  Profile,
  RefusedAction,
  WhoEntry,
} from "./news.ts";
import type { Seam } from "./seam.ts";
import type { Users } from "./users.ts";

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
      /**
       * Whether the Owner has sent a `NICK` in this Session: from then Self's nick is theirs,
       * and never taken back.
       */
      readonly chosen: boolean;
      /**
       * Whether the Network renamed Self off the first configured nick in this Session,
       * with no `NICK` of ours asking, as services do: from then that nick is not taken
       * back, so the Client never asks for it in a loop with them.
       */
      readonly yielded: boolean;
      /**
       * While Channels wait on a service login, when they are joined anyway, or
       * `undefined` once they need not wait.
       */
      readonly identifying: Instant | undefined;
      /** Whether an `OPER` sent as the Session began still awaits the Ircd's answer. */
      readonly opering: boolean;
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
      readonly users: Users;
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
       * The Owner's Lookups sent on this Connection whose replies are still coming, oldest
       * first, at most {@link maxLookups}.
       */
      readonly lookups: readonly Looking[];
      /**
       * For each Channel, by folded name, how many `NAMES` answers a forgotten Lookup began
       * on the floor, each read to its `366` and kept by no one, so no part of one replaces
       * the members. At most {@link maxForgotten} Channels.
       */
      readonly forgotten: ReadonlyMap<string, number>;
      /**
       * The one `MODE` query the Client sent of its own, to learn a Channel's modes on
       * joining it, whose answer has not come, or `undefined` for none.
       */
      readonly modesQuery: ModesQuery | undefined;
      /**
       * The one `WHO` query the Client sent of its own that holds the slot, until its
       * answer ends or its deadline passes, or `undefined` for none.
       */
      readonly whoQuery: WhoQuery | undefined;
      /**
       * The Channels a `WHO` query was sent for in this Session, by folded name, oldest
       * first, at most {@link maxWhoAsked}. None is asked twice in a Session, so a Channel
       * parted and joined again is not asked again.
       */
      readonly whoAsked: ReadonlyMap<string, WhoAsked>;
      /**
       * The `NICK`s the Client sent of its own to take a nick back, whose answers have not
       * come, oldest first, at most {@link maxReclaims}. The Ircd answers every `NICK`, so one
       * lingers only until the Connection ends if nothing answers it.
       */
      readonly reclaims: readonly Reclaiming[];
      /**
       * How many Lines awaiting an answer by their parameters, the Owner's actions' and
       * Lookups' and the Client's own asks for a nick alike, have been sent on this Connection: each takes the next as its
       * `order`, so a reply tied to neither by label goes to the one sent first.
       */
      readonly awaited: number;
      /**
       * The message of the last `AWAY` sent on this Connection, `null` for one that came
       * back, or `undefined` before any, which a `306` confirms.
       */
      readonly asked: string | null | undefined;
      /**
       * The Target of the latest `Say` sent on this Connection with no label, as the Owner
       * named it, for each command a `Say` sends. Without labels nothing says which Message
       * a standard reply answers, so one that names `PRIVMSG` or `NOTICE` is shown with the
       * latest. It is one Target for each command, so it is bounded by construction, and it
       * ends with the Connection.
       */
      readonly lastSaid: LastSaid;
      /**
       * The CTCP `PING`s the Owner sent on this Connection whose replies have not come,
       * oldest first, at most {@link maxActions}: who each went to, its token, and when it
       * was sent, so a reply that matches one tells its round trip. Nothing waits on them:
       * the oldest is forgotten past the bound, a reply forgets its own, and the rest end
       * with the Connection.
       */
      readonly pings: readonly Pinged[];
      /** How many `PING`s the Owner has sent on this Connection, which numbers their tokens. */
      readonly pingsSent: number;
      /** What `MONITOR` or `WATCH` has asked of the Ircd on this Connection, and what it told. */
      readonly monitoring: Monitoring;
      /** The message of the day this Connection is receiving, or `undefined` outside one. */
      readonly motd: MotdCollecting | undefined;
    };

/**
 * A message of the day between its `375` and its `376`: its lines so far, at most
 * {@link maxMotdLines}, and when its `375` came, or `Spent` once it ran past its bound
 * and was shown cut, when its lines are dropped until its `376`.
 */
export type MotdCollecting =
  | { readonly _tag: "Collecting"; readonly at: Fact<Instant>; readonly lines: readonly string[] }
  | { readonly _tag: "Spent" };

/** How many lines of a message of the day are kept. Past it, the rest is cut. */
export const maxMotdLines = 200;

/** The commands that keep a monitor list: `MONITOR`, or the older `WATCH` where only it is offered. */
export type MonitorCommand = "MONITOR" | "WATCH";

/**
 * What a Connection asked of `MONITOR` or `WATCH`, and what it heard. The list asked for
 * is derived from the State, and this is only what was sent, so the next step sends the
 * difference.
 */
export interface Monitoring {
  /** Whether the Ircd refused the command itself, so nothing more is sent on this Connection. */
  readonly off: boolean;
  /** The command `watched` was sent with, or `undefined` before anything was. */
  readonly command: MonitorCommand | undefined;
  /**
   * Each nick added and not since taken off, keyed by folded nick, oldest first, with
   * whether the Ircd says it is online. Bounded by the list derived.
   */
  readonly watched: ReadonlyMap<string, Watched>;
  /**
   * The nicks a `734` or `512` refused, by folded nick, which are never sent again on this
   * Connection. Only a nick that was watched can be refused, so they are bounded too.
   */
  readonly refused: ReadonlySet<string>;
}

/** A nick on the monitor list: as it was sent, and whether its holder is online. */
export interface Watched {
  readonly nick: string;
  /** Unknown until the Ircd first tells of it on this Connection. */
  readonly here: Fact<boolean>;
}

/** Nothing asked of `MONITOR` or `WATCH` yet. */
export const unmonitored: Monitoring = {
  command: undefined,
  off: false,
  refused: new Set(),
  watched: new Map(),
};

/** A CTCP `PING` the Owner sent: who to, as said, its token, and the instant it was sent. */
export interface Pinged {
  readonly nick: string;
  readonly token: string;
  readonly at: Instant;
}

/** The commands a `Say` sends. */
type SayCommand = "NOTICE" | "PRIVMSG";

/** The Target of the latest unlabelled `Say` for each command, or `undefined` for none yet. */
type LastSaid = Readonly<Record<SayCommand, string | undefined>>;

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
  /** When it was sent among the Lines awaiting an answer on the Connection, from {@link Open}'s `awaited`. */
  readonly order: number;
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

/**
 * A `NICK` the Client sent of its own to take a nick back, awaiting its answer. It takes
 * an `order` as the Owner's Lines do, so whichever was sent first takes a reply that could
 * answer either.
 */
export interface Reclaiming {
  /** The nick asked for, as it was sent. */
  readonly nick: string;
  /** When it was sent among the Lines awaiting an answer on the Connection, as an action's `order` is. */
  readonly order: number;
}

/**
 * A `MODE` query the Client sent of its own, awaiting its answer: a `324`, or an error
 * that names its Channel or its command. It takes an `order` as the Owner's Lines do, so
 * whichever was sent first takes a reply that could answer either.
 */
export interface ModesQuery {
  /** The Channel, as it was sent. */
  readonly channel: string;
  /** When it was sent among the Lines awaiting an answer on the Connection, as an action's `order` is. */
  readonly order: number;
  /** When it stops waiting, and the next Channel is asked. */
  readonly deadline: Instant;
}

/**
 * The `WHO` query that holds the slot: the next Channel waits until its answer ends or its
 * deadline passes. It answers only by structure, so it waits among no other Lines.
 */
interface WhoQuery {
  /** The Channel, as it was sent. */
  readonly channel: string;
  /** When it frees the slot, and the next Channel is asked. Its answer is still read after. */
  readonly deadline: Instant;
}

/** A Channel asked who is in it in this Session. */
export interface WhoAsked {
  /** The Channel, as it was sent. */
  readonly name: string;
  /** Whether its answer has ended, so nothing more of it is read. */
  readonly ended: boolean;
  /** Whether its answer has described anyone, so its end reports the Channel learned. */
  readonly replied: boolean;
}

/** How many Channels a Session remembers asking `WHO` of. */
export const maxWhoAsked = 512;

/**
 * A Lookup whose reply is being collected: what it asked, how its reply is tied to it,
 * and what has come so far.
 */
export interface Looking {
  readonly intent: IntentId;
  /** When it was sent among the Lines awaiting an answer on the Connection, as an action's `order` is. */
  readonly order: number;
  readonly lookup: Lookup;
  /** Whether its Line was labelled, so its reply is collected by label alone, never by the names it holds. */
  readonly labelled: boolean;
  /** When it gives up waiting for the end, and reports what it has. */
  readonly deadline: Instant;
  /** How many Lines of its reply have come, counted up to {@link maxLookupLines}. */
  readonly lines: number;
  /** The Users the reply has described so far, in order, for a `WHOIS` or `WHOWAS`. */
  readonly profiles: readonly Profile[];
  /** The masks the reply has listed so far, in order, for a Channel's list. */
  readonly masks: readonly MaskEntry[];
  /** The members a `NAMES` reply has listed so far, in order, up to {@link maxLookupEntries}. */
  readonly members: readonly NamesEntry[];
  /**
   * A `NAMES` reply's own listing, bounded as a Channel's is, apart from the Channel's own,
   * which it replaces the members by only when its `366` comes.
   */
  readonly listing: Listing | undefined;
  /**
   * Whether its time ran out, and it reported what it had. A `NAMES` still reads its
   * answer, to its `366` or its labelled answer's end, and a `LIST` to its `323` or its
   * labelled answer's end, keeping nothing, and each reports nothing more.
   */
  readonly lapsed: boolean;
  /** The Users a `WHO` reply has described so far, in order, up to {@link maxLookupEntries}. */
  readonly users: readonly WhoEntry[];
  /**
   * The Channels a `LIST` reply has described so far that match what was asked, the
   * {@link maxDirectory} with the most members, most first, then by name.
   */
  readonly channels: readonly ChannelEntry[];
  /** How many Channels a `LIST` reply has described that match what was asked, kept or not. */
  readonly seen: number;
  /**
   * Whether a `LIST` reply's rows have begun, with a `321` or a `322`, after which nothing
   * but its `323` or its Connection's end ends it.
   */
  readonly begun: boolean;
  /**
   * What a `LIST` asked that the Ircd was not asked to filter by, which the Client does:
   * a glob of the Channels' names, and the least members.
   */
  readonly sift: { readonly mask: string | undefined; readonly least: number | undefined };
  /** The mode a Channel's list was asked by, which a `472` names, or `undefined` for a User's. */
  readonly mode: string | undefined;
  /** The error its reply held, which it reports at its end. */
  readonly error: { readonly _tag: "NotFound" | "Failed"; readonly reply: string } | undefined;
  /** The `WARN` and `NOTE` standard replies its reply held, in order. */
  readonly notes: Notes;
  /** Whether its end numeric came, inside a labelled answer, which ends only with that answer. */
  readonly ended: boolean;
  /**
   * Whether its reply ran past {@link maxLookupLines}, or past {@link maxLookupEntries}
   * members or Users, so what came after was not kept.
   */
  readonly bounded: boolean;
  /**
   * For each fact of Knowledge its reply spoke of, the time of the Line that said it, and
   * the fact as Knowledge held it then, so it refreshes only a fact nothing changed since.
   */
  readonly heard: ReadonlyMap<Refreshed, Heard>;
}

/** A fact of a User's that a `WHOIS` refreshes. */
export type Refreshed = "account" | "away" | "mask" | "realname";

/** When a reply spoke of a fact, and what Knowledge held of it then. */
interface Heard {
  readonly at: Instant;
  readonly was: Fact<unknown>;
}

/** How many Lookups may await their replies on a Connection at once. */
export const maxLookups = 8;

/** How many Channels a Connection counts forgotten `NAMES` answers of. */
export const maxForgotten = 64;

/** How many Lines of one Lookup's reply are kept. */
export const maxLookupLines = 64;

/**
 * How many members of a `NAMES` reply, or Users of a `WHO` reply, one Lookup keeps. Each
 * one's strings come from one Line, which the parser bounds, and its notes still count
 * against {@link maxLookupLines}.
 */
export const maxLookupEntries = 500;

/**
 * How many Channels a `LIST` reply keeps: those with the most members. A reply may describe
 * tens of thousands, and none counts against {@link maxLookupLines}, so this alone bounds it.
 */
export const maxDirectory = 1000;

/** How many Lines of actions a Connection keeps awaiting an answer. */
export const maxActing = 64;

/** How many of the Client's own asks for a nick a Connection keeps awaiting an answer. */
export const maxReclaims = 8;

/** How many confirmed intents a Connection remembers. */
export const maxConfirmed = 64;

/** What Lines have shown of a User. A fact no Feature keeps any longer is held as stale. */
export interface Seen {
  readonly nick: string;
  readonly mask: Fact<{ readonly user: string; readonly host: string }>;
  readonly away: Fact<{ readonly message: string } | null>;
  /** The account they are logged in to, or `null` when known to be logged out. */
  readonly account: Fact<string | null>;
  readonly realname: Fact<string>;
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
  /** Whether the Client has asked for its modes since Self joined it. It asks once a join. */
  readonly queried: boolean;
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
  /**
   * The Owner's latest actions that left, by intent, oldest first, at most
   * {@link maxActions}: what each tried and where it belongs, so a refusal that comes
   * later, `Rejected` or `Unsent`, says where to show it. They outlive Connections, since
   * an `Unsent` can come after its Connection ended.
   */
  readonly actions: ReadonlyMap<IntentId, RefusedAction>;
  /**
   * The Owner's latest `Say`s sent with a label, by intent, oldest first, at most
   * {@link maxActions}: the Target as the Owner named it, so a `WARN` or `NOTE` the Ircd
   * labels for one is shown where its Message stands.
   */
  readonly said: ReadonlyMap<IntentId, string>;
  /**
   * When the budget for CTCP answers is full again: each answer moves it on by one
   * interval from now or from where it stood, whichever is later, and an answer is sent
   * only while it is no more than the burst less one interval ahead of now. It outlives
   * Connections, so reconnecting refills nothing.
   */
  readonly answersFullAt: Instant;
  /** How many CTCP answers Self has sent, which numbers the next. */
  readonly answered: number;
  /**
   * The latest CTCP answers to a request placed by who asked, by number, oldest first, at
   * most {@link maxActions}: that partner's nick now, as their Timeline follows it, or
   * `null` once another User took the nick and the Timeline is no longer theirs. An
   * `Unsent` of one reports it there. They outlive Connections, as an `Unsent` can.
   */
  readonly answering: ReadonlyMap<number, string | null>;
  /**
   * The open Direct Message partners, by the key `where` gives their Timeline, least
   * recently messaged first, at most {@link maxPartners}: each nick as their Timeline is
   * named. They are folded from the Client's own News, as a projection folds Timelines,
   * so they outlive Connections and replaying the Journal rebuilds them.
   */
  readonly partners: ReadonlyMap<string, string>;
}

/** How many open Direct Message partners the Client keeps, dropping the least recently messaged. */
export const maxPartners = 256;

/**
 * How many of the Owner's actions, labelled `Say`s, and CTCP answers the Client remembers,
 * to place what answers them, or what became of them.
 */
export const maxActions = 64;

/** Before anything has happened. */
export const initialState: State = {
  actions: new Map(),
  answered: 0,
  answering: new Map(),
  answersFullAt: Instant.make(0),
  attempt: 0,
  away: undefined,
  casemapping: "rfc1459",
  channels: new Map(),
  configuration: undefined,
  declared: undefined,
  dialled: 0,
  markers: { channels: new Map(), directs: new Map(), network: undefined },
  network: { _tag: "Unconfigured" },
  partners: new Map(),
  policies: new Map(),
  rotation: 0,
  said: new Map(),
  stopping: false,
};

/** An open Connection's phase. */
export type Open = Extract<LinkPhase, { readonly _tag: "Open" }>;

/** A Session's presence. */
export type InSession = Extract<Presence, { readonly _tag: "Session" }>;
