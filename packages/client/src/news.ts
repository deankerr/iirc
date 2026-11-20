/**
 * What happened, for Timelines. News is derived: replaying the Journal makes it again,
 * so it is never journaled.
 *
 * @packageDocumentation
 */
import type { UnparseableReason } from "@iirc/protocol/line";
import type { IgnoreMask } from "@iirc/protocol/mask";

import type { IrcdAddress } from "./configuration.ts";
import type { ConnectionId, Instant, IntentId, MessageId, TimerId } from "./ids.ts";
import type { CloseReason, Input, Lookup, SayKind } from "./input.ts";
import type { Casemapping, Fact, Topic } from "./known.ts";

/**
 * A standard reply, by IRCv3: a `FAIL`, `WARN`, or `NOTE`, read by structure alone. Its
 * `command` is the one it is about, or `*` for none, and its `code` says what happened,
 * in a word a program reads. `context` is the parameters between the code and the
 * description, and `description` is text for people, which nothing is decided from.
 */
export interface StandardReply {
  readonly kind: "FAIL" | "WARN" | "NOTE";
  readonly command: string;
  readonly code: string;
  readonly context: readonly string[];
  readonly description: string;
}

/**
 * Why Self did not answer a CTCP request: it was read from history (`History`), it is not
 * one Self answers (`Unknown`), the Configuration turns answers off (`Off`), its sender
 * is no User a reply can safely go to (`Unreachable`), the answer could not be built or
 * sent whole (`Unsendable`), or the budget for answers was spent (`Limited`).
 */
export type Unanswered = "History" | "Unknown" | "Off" | "Unreachable" | "Unsendable" | "Limited";

/**
 * The numerics that refuse an `OPER`: a wrong password (`464`), no operator block for
 * Self's host (`491`), or too few parameters (`461`).
 */
export type OperRefusal = "461" | "464" | "491";

/** What became of a CTCP request: the answer Self sent, as its arguments, or why none. */
export type CtcpAnswer =
  | { readonly _tag: "Answered"; readonly text: string }
  | { readonly _tag: "Unanswered"; readonly reason: Unanswered };

/**
 * Something that changed on the Network, rather than something said. A `CtcpRequest` is
 * a CTCP request in a `PRIVMSG` from a User other than Self, other than `ACTION` and
 * `DCC`, with what became of it, and a `CtcpReply` one in a `NOTICE`. `nick` is who sent
 * it, `target` where it was sent, and `args` everything after the command, as text to
 * show and nothing more. A `CtcpReply` to a `PING` Self sent carries `roundTrip`, the
 * milliseconds between the instants the request and the reply were journaled, and every
 * other reply `null`. A `CtcpSent` is a request the Owner sent to a User, by their nick, its
 * command, and its arguments, placed where that User's replies are. A `CtcpUnsent` is an
 * answer Self reported as `Answered` that never left, placed where its request was, which
 * it names by who asked, where, and the command.
 * A `StandardReply`
 * is what the Network said of something sent, or of nothing: a `WARN` or a `NOTE`, or a
 * `FAIL` that refused no intent. `OperGranted` and `OperRefused` answer the `OPER` Self
 * sent as its Session began, by the numeric alone: Self, by `nick`, is now an IRC
 * operator, or the Ircd refused with `reply`. An `Invited` is an `INVITE` that names Self: `by`
 * is who invited, and `channel` where to, as said, which Self has not joined and may.
 * `CameOnline` and `WentOffline` are a monitored Direct Message partner coming onto the
 * Network or leaving it, as `MONITOR` or `WATCH` tells, by the nick monitored. A `Numeric`
 * is a numeric the Ircd sent that nothing else reports, such as its welcome or its counts of
 * Users, kept as it came. A `Motd` is the Ircd's message of the day, collected by its
 * numerics alone: the text of each `372` between a `375` and a `376`, as it came, at most
 * {@link maxMotdLines} of them. `cut` says it was cut short: by its bound, by the next `375`,
 * or by its Connection ending before its `376`.
 */
export type Activity =
  | { readonly _tag: "Joined"; readonly channel: string; readonly nick: string }
  | {
      readonly _tag: "Parted";
      readonly channel: string;
      readonly nick: string;
      readonly reason: string | undefined;
    }
  | { readonly _tag: "Quit"; readonly nick: string; readonly reason: string | undefined }
  | {
      readonly _tag: "Kicked";
      readonly channel: string;
      readonly nick: string;
      readonly by: string;
      readonly reason: string | undefined;
    }
  | { readonly _tag: "NickChanged"; readonly from: string; readonly to: string }
  | {
      readonly _tag: "ModeChanged";
      readonly target: string;
      readonly by: string;
      readonly changes: readonly ModeChange[];
    }
  | {
      readonly _tag: "TopicChanged";
      readonly channel: string;
      readonly by: string;
      readonly topic: Topic | null;
    }
  | {
      readonly _tag: "AwayChanged";
      readonly nick: string;
      readonly away: { readonly message: string } | null;
    }
  /** A User logged in to `account`, or out of theirs with `null`, as an `ACCOUNT` Line says. */
  | { readonly _tag: "AccountChanged"; readonly nick: string; readonly account: string | null }
  /** A User's user and host changed to `user` and `host`, as a `CHGHOST` Line says: no quit or join. */
  | {
      readonly _tag: "HostChanged";
      readonly nick: string;
      readonly user: string;
      readonly host: string;
    }
  /** A User set their realname to `realname`, as a `SETNAME` Line says. */
  | { readonly _tag: "RealnameChanged"; readonly nick: string; readonly realname: string }
  | { readonly _tag: "Invited"; readonly channel: string; readonly by: string }
  /** `by` invited `nick`, another User, to `channel`, as `invite-notify` tells its members. */
  | {
      readonly _tag: "UserInvited";
      readonly channel: string;
      readonly nick: string;
      readonly by: string;
    }
  /**
   * A split of the Network in one Channel, as a `netsplit` batch tells it: `servers` are the
   * two that parted, as the batch named them, and `nicks` the Channel's members who went,
   * in the order they quit. A `Netjoin` is its healing, as a `netjoin` batch tells it: the
   * members who came back, in the order they joined.
   */
  | ({ readonly _tag: "Netsplit" } & Split)
  | ({ readonly _tag: "Netjoin" } & Split)
  | { readonly _tag: "CameOnline"; readonly nick: string }
  | { readonly _tag: "WentOffline"; readonly nick: string }
  | { readonly _tag: "OperGranted"; readonly nick: string }
  | { readonly _tag: "OperRefused"; readonly nick: string; readonly reply: OperRefusal }
  | ({ readonly _tag: "StandardReply" } & StandardReply)
  | ({ readonly _tag: "Numeric" } & OtherReply)
  | { readonly _tag: "Motd"; readonly lines: readonly string[]; readonly cut: boolean }
  | ({ readonly _tag: "CtcpRequest"; readonly answer: CtcpAnswer } & Ctcp)
  | ({ readonly _tag: "CtcpReply"; readonly roundTrip: number | null } & Ctcp)
  | ({ readonly _tag: "CtcpSent" } & Omit<Ctcp, "target">)
  | ({ readonly _tag: "CtcpUnsent" } & Omit<Ctcp, "args">);

/**
 * An Activity that is addressed to Self and belongs to the Network's own Timeline alone: an
 * answer to the `OPER` Self sent as its Session began, an invitation, a numeric nothing
 * else reports, or the message of the day. It settles nothing and changes no Channel.
 */
export type NetworkOnly = Extract<
  Activity,
  { readonly _tag: "OperGranted" | "OperRefused" | "Invited" | "Numeric" | "Motd" }
>;

/**
 * Whether an Activity is {@link NetworkOnly}.
 * @param activity - The Activity.
 * @returns Whether it is.
 */
export const isNetworkOnly = (activity: Activity): activity is NetworkOnly =>
  activity._tag === "OperGranted" ||
  activity._tag === "OperRefused" ||
  activity._tag === "Invited" ||
  activity._tag === "Numeric" ||
  activity._tag === "Motd";

/** A monitored partner coming onto the Network or leaving it, which changes no Channel. */
export type PresenceChange = Extract<Activity, { readonly _tag: "CameOnline" | "WentOffline" }>;

/**
 * Whether an Activity is a {@link PresenceChange}.
 * @param activity - The Activity.
 * @returns Whether it is.
 */
export const isPresenceChange = (activity: Activity): activity is PresenceChange =>
  activity._tag === "CameOnline" || activity._tag === "WentOffline";

/** What a User's Line changed of them, which Self's own says of Self: away, account, mask, or realname. */
export type UserChange = Extract<
  Activity,
  { readonly _tag: "AwayChanged" | "AccountChanged" | "HostChanged" | "RealnameChanged" }
>;

/**
 * Whether an Activity is a {@link UserChange}.
 * @param activity - The Activity.
 * @returns Whether it is.
 */
export const isUserChange = (activity: Activity): activity is UserChange =>
  activity._tag === "AwayChanged" ||
  activity._tag === "AccountChanged" ||
  activity._tag === "HostChanged" ||
  activity._tag === "RealnameChanged";

/** Another User's invitation, which `invite-notify` tells a Channel's members of. */
export type OthersInvitation = Extract<Activity, { readonly _tag: "UserInvited" }>;

/** A split, or its healing, shown for quits and joins each read on its own. */
export type SplitShown = Extract<Activity, { readonly _tag: "Netsplit" | "Netjoin" }>;

/**
 * Whether an Activity changes no Channel and answers nothing Self sent: one that is
 * {@link NetworkOnly}, a {@link PresenceChange}, another User's invitation, or a split.
 * @param activity - The Activity.
 * @returns Whether it does.
 */
export const changesNothingHere = (
  activity: Activity
): activity is NetworkOnly | PresenceChange | OthersInvitation | SplitShown =>
  isNetworkOnly(activity) ||
  isPresenceChange(activity) ||
  activity._tag === "UserInvited" ||
  activity._tag === "Netsplit" ||
  activity._tag === "Netjoin";

/** What a `Netsplit` or a `Netjoin` says of one Channel. */
interface Split {
  readonly channel: string;
  /** The two servers the batch named, as it named them. */
  readonly servers: readonly [string, string];
  /** The Channel's members who went, or came back, by nick, in the order of their Lines. */
  readonly nicks: readonly string[];
}

/** A CTCP request or reply: who sent it, where, its command, upper-cased, and its arguments. */
export interface Ctcp {
  readonly nick: string;
  readonly target: string;
  readonly command: string;
  readonly args: string;
}

/**
 * A name as it was said, and its key: the name folded by the casemapping the Network last
 * declared, which `Refolded` reports.
 */
export interface Named {
  /** The name folded, as Knowledge keys Channels and Users. */
  readonly key: string;
  /** The name as it was said, to show. */
  readonly name: string;
}

/**
 * A Timeline a Message or an Activity touches. The Client works it out from what it
 * knows at that step, before the step changes anything, so a projection can fold News
 * into Timelines without knowing the casemapping, Self's nick, or who shares a Channel.
 *
 * - `Network`: the Network's own Timeline.
 * - `Channel`: a Channel's.
 * - `Direct`: a Direct Message partner's: the other participant, and Self only for a
 *   Message Self sent to itself. With `existing` set, it touches only a Timeline that
 *   already exists, and never starts one: a Quit or an away change is worth showing
 *   where Self and the User talked, and is no reason to start a Timeline.
 * - `DirectRenamed`: a Direct Message partner changed nick. It touches only a Timeline
 *   that already exists, keyed `key`, which takes this item and is keyed and named by `to`
 *   from then on. Only a live rename carries it, since a rename read from history may name
 *   a nick someone else has now.
 */
export type Where =
  | { readonly _tag: "Network" }
  | ({ readonly _tag: "Channel" } & Named)
  | ({ readonly _tag: "Direct"; readonly existing: boolean } & Named)
  | ({ readonly _tag: "DirectRenamed"; readonly to: Named } & Named);

/** A Timeline a Read Marker belongs to: the Network's own, a Channel's, or a Direct Message partner's. */
export type Marked = Exclude<Where, { readonly _tag: "DirectRenamed" }>;

/** A Timeline the Owner can close: a Channel's, or a Direct Message partner's, never the Network's own. */
export type Closable = Exclude<Marked, { readonly _tag: "Network" }>;

/** One mode set or unset. A key's parameter is never shown. */
export interface ModeChange {
  readonly set: boolean;
  readonly mode: string;
  readonly param: string | undefined;
}

/** Why a Session ended. None of these is read from an Ircd's text. */
export type EndReason =
  | { readonly _tag: "Closed"; readonly reason: CloseReason }
  | { readonly _tag: "Silent" }
  | { readonly _tag: "Error" }
  | { readonly _tag: "LoginFailed" }
  | { readonly _tag: "Disabled" }
  | { readonly _tag: "Restarted" }
  /** An STS policy said to connect over TLS, so this plaintext Connection ends and a secure one follows at once. */
  | { readonly _tag: "Upgrading"; readonly port: number };

/**
 * Why the Client did not carry out something the Owner asked for. `Rejected` comes after
 * sending, when the Ircd's reply is tied to the intent, as `labeled-response` ties it:
 * `reply` is the numeric, or a standard reply's code, never the reply's text. `Unsent`
 * comes after the Message was reported: at least part of it never left, because its
 * Connection ended first. `AccountUnknown` and `NoAccount` refuse a ban by account: the Client
 * does not know the User's account, or knows they are logged in to none.
 */
export type RefusedReason =
  | { readonly _tag: "Offline" }
  | { readonly _tag: "Unsendable" }
  | { readonly _tag: "AccountUnknown" }
  | { readonly _tag: "NoAccount" }
  | { readonly _tag: "Unsent" }
  | { readonly _tag: "Rejected"; readonly reply: string };

/**
 * What the Owner tried to do with an `Act`, in short, to show beside its refusal: the kind
 * of action and what it named, and nothing else. It never holds a topic, a reason, an
 * away message, a mode's parameter, or the rest of a raw Line, so no Credential, such as a
 * Channel key given with `+k`, and no text but names the Owner typed is ever in it.
 *
 * - `Topic`: a Channel's topic.
 * - `Kick`: nicks from a Channel.
 * - `Mode`: a Channel's or Self's modes, as each change's sign and letter, such as `+o-v`.
 *   A ban by account is one too, as `+b` on its Channel.
 * - `Invite`: a nick to a Channel.
 * - `Nick`: Self's nick.
 * - `Away`: away, or back with `away` false.
 * - `Setname`: Self's realname, never the realname itself.
 * - `Raw`: a Line written as text, by its command, or `null` when it did not parse.
 * - `Ctcp`: a CTCP request to a nick, by its command, upper-cased.
 * - `Ping`: a CTCP `PING` to a nick.
 * - `Part`: one Channel.
 */
export type Attempted =
  | { readonly _tag: "Topic"; readonly channel: string }
  | { readonly _tag: "Kick"; readonly channel: string; readonly nicks: readonly string[] }
  | { readonly _tag: "Mode"; readonly target: string; readonly modes: string }
  | { readonly _tag: "Invite"; readonly nick: string; readonly channel: string }
  | { readonly _tag: "Nick"; readonly nick: string }
  | { readonly _tag: "Away"; readonly away: boolean }
  | { readonly _tag: "Setname" }
  | { readonly _tag: "Raw"; readonly command: string | null }
  | { readonly _tag: "Ctcp"; readonly nick: string; readonly command: string }
  | { readonly _tag: "Ping"; readonly nick: string }
  | { readonly _tag: "Part"; readonly channel: string };

/**
 * Where an action of the Owner's belongs, to show its refusal: the Channel it was about,
 * when the Client held that Channel as it was asked for, and otherwise, and for a nick, a
 * realname, away, a raw Line, and Self's own modes, the Network's own Timeline.
 */
export type ActionWhere = Extract<Where, { readonly _tag: "Network" | "Channel" }>;

/** An action of the Owner's that was refused: what was tried, and where it belongs. */
export interface RefusedAction {
  readonly attempted: Attempted;
  readonly where: ActionWhere;
}

/** That we said a Message ourselves, as the Owner's intent. */
export interface Ours {
  readonly intent: IntentId;
  /** Whether the Ircd will echo it back, which a `Confirmed` then reports. */
  readonly echo: boolean;
}

/** A Channel a User is in, as a Lookup's reply named it, with the membership modes its prefixes stand for, by `PREFIX`. */
export interface ProfileChannel {
  readonly name: string;
  /** The modes, such as `o` and `v`, in the order the prefixes came. Without `multi-prefix`, only the highest. */
  readonly prefixes: readonly string[];
}

/** A reply numeric the Client does not model, kept as it came: its parameters after the first, which names Self. */
export interface OtherReply {
  readonly numeric: string;
  readonly params: readonly string[];
}

/** Where a User actually connects from, by `338`: a `user@host` mask, an IP address, or both. */
export interface ProfileActual {
  readonly mask: string | undefined;
  readonly ip: string | undefined;
}

/**
 * One User as a Lookup's reply describes them: a `WHOIS`'s, or one entry of a `WHOWAS`'s.
 * Every field is what the Network said, read by structure, and `undefined` or empty when
 * it said nothing of it. Nothing is read from the Network's free text.
 */
export interface Profile {
  /** The nick, as the reply named it. */
  readonly nick: string;
  /** From `311` or `314`. */
  readonly user: string | undefined;
  readonly host: string | undefined;
  readonly realname: string | undefined;
  /** From `312`: the server the User is on, or was, and the Network's text about it. */
  readonly server: { readonly name: string; readonly info: string } | undefined;
  /** From `313`. */
  readonly operator: boolean;
  /** Seconds idle, from `317`. */
  readonly idle: number | undefined;
  /** When the User signed on, from `317`, when the Ircd says. */
  readonly signon: Instant | undefined;
  /** From `319`, over as many Lines as it took. */
  readonly channels: readonly ProfileChannel[];
  /** The away message, from `301`, or `undefined` when none came. */
  readonly away: string | undefined;
  /** The account, from `330`'s third parameter. */
  readonly account: string | undefined;
  /** From `671`. */
  readonly secure: boolean;
  /**
   * Where the User actually connects from, from `338`'s parameters between the nick and its
   * text: a `user@host` mask, an IP address, or both, as the Ircd shows them.
   */
  readonly actual: ProfileActual | undefined;
  /** The User's modes, such as `+Zi`, from `379`, when its text holds them as one word. */
  readonly modes: string | undefined;
  /** Whether the User is a bot, from `335`, read only while the Ircd names a bot mode. */
  readonly bot: boolean;
  /** Every other numeric of the reply that named this User, in order, so nothing is lost. */
  readonly other: readonly OtherReply[];
}

/**
 * One mask on a Channel's list, as a Lookup's reply gave it: the mask, and who set it and
 * when, where the Ircd says.
 */
export interface MaskEntry {
  readonly mask: string;
  /** A nick, a nick's mask, or a server's name, as the Ircd gave it. */
  readonly setBy: string | undefined;
  readonly setAt: Instant | undefined;
}

/** One member as a `NAMES` reply lists them: the nick, and the modes its prefixes stand for, by `PREFIX`, in the order they came. */
export interface NamesEntry {
  readonly nick: string;
  readonly prefixes: readonly string[];
}

/** One Channel as a `LIST` reply (`322`) describes it: its name, how many members it has, and its topic, `""` when the Ircd gave none. */
export interface ChannelEntry {
  readonly channel: string;
  readonly members: number;
  readonly topic: string;
}

/** One User as a `WHO` reply (`352`) describes them. */
export interface WhoEntry {
  readonly nick: string;
  readonly user: string;
  readonly host: string;
  /** From the flags: `G` true, `H` false, else undefined. */
  readonly away: boolean | undefined;
  /** After the hop count in the last parameter, or undefined when there is none. */
  readonly realname: string | undefined;
}

/** The standard replies a Lookup's reply held besides its result: each `WARN` and `NOTE`, and each `FAIL` after the first. */
export type Notes = readonly StandardReply[];

/**
 * Why a Lookup ended with only part of its reply: no end came within its time limit
 * (`TimedOut`), its Connection ended first (`Ended`), or the reply ran past the Lines,
 * or the members, Users, or Channels, one Lookup collects (`Bounded`).
 */
export type PartialReason = "TimedOut" | "Ended" | "Bounded";

/**
 * Why a Lookup was not sent: no Session (`Offline`), no Line can carry it (`Unsendable`),
 * too many Lookups await their replies on the Connection, or another `Channels` does (`Busy`), or the Network keeps no
 * such list, by its ISUPPORT (`NotOffered`).
 */
export type LookRefusal = "Offline" | "Unsendable" | "Busy" | "NotOffered";

/**
 * What a Lookup found.
 *
 * - `Found`: of a `WHOIS` or `WHOWAS`, the whole reply, up to its end, `318` or `369`, or
 *   its labelled batch's end.
 * - `Partial`: of a `WHOIS` or `WHOWAS`, what had come when it stopped, and why.
 * - `Listed`: of a Channel's list, its masks, in the order they came, with `cut` saying why
 *   it stopped short of its end, `368`, `349`, or `347`, or its labelled batch's end, or
 *   `undefined` when it did not. An empty list is `Listed` with no masks.
 * - `Members`: of a `NAMES`, each member listed, in order, and `Users`: of a `WHO`, each
 *   User a `352` described, in order, each with `cut` as for a list, stopped short of its
 *   end, `366` or `315`. An end with nothing before it is an empty list.
 * - `Channels`: of a `LIST`, the Channels it described that match what was asked, most
 *   members first, then by name, at most `maxDirectory`, with `seen` how many matched,
 *   kept or not, and `cut` as for a list, `Bounded` when `seen` is more than were kept.
 * - `NotFound`: the Network has no such User, by `401` or `406`, or ended its reply with
 *   no User in it, by the end numeric, or no such Channel, by `401` or `403`.
 * - `Failed`: another error numeric, such as `402`, `431`, or `482`, a `FAIL` by its code,
 *   or a labelled answer that ended saying nothing the Client reads, such as a lone
 *   `NOTICE`, by the command of the Line that ended it.
 * - `Refused`: not sent, and why, as {@link LookRefusal} says.
 * - `Unsent`: its Line never left, because its Connection ended first.
 *
 * A result the Network answered keeps in `notes` each `WARN` and `NOTE` of its reply, and
 * each `FAIL` after the first, which gave its result, in order. They say something of it
 * and end nothing.
 */
export type LookResult =
  | { readonly _tag: "Found"; readonly profiles: readonly Profile[]; readonly notes: Notes }
  | {
      readonly _tag: "Partial";
      readonly profiles: readonly Profile[];
      readonly reason: PartialReason;
      readonly notes: Notes;
    }
  | {
      readonly _tag: "Listed";
      readonly masks: readonly MaskEntry[];
      readonly cut: PartialReason | undefined;
      readonly notes: Notes;
    }
  | {
      readonly _tag: "Members";
      readonly members: readonly NamesEntry[];
      readonly cut: PartialReason | undefined;
      readonly notes: Notes;
    }
  | {
      readonly _tag: "Users";
      readonly users: readonly WhoEntry[];
      readonly cut: PartialReason | undefined;
      readonly notes: Notes;
    }
  | {
      readonly _tag: "Channels";
      readonly channels: readonly ChannelEntry[];
      readonly seen: number;
      readonly cut: PartialReason | undefined;
      readonly notes: Notes;
    }
  | { readonly _tag: "NotFound"; readonly reply: string; readonly notes: Notes }
  | { readonly _tag: "Failed"; readonly reply: string; readonly notes: Notes }
  | { readonly _tag: "Refused"; readonly reason: LookRefusal }
  | { readonly _tag: "Unsent" };

/** Why an input changed nothing. Each is recorded, and none ends a Connection. */
export type IgnoredReason =
  | { readonly _tag: "Unparseable"; readonly reason: UnparseableReason }
  | { readonly _tag: "Malformed"; readonly command: string }
  | { readonly _tag: "StaleConnection"; readonly connection: ConnectionId }
  | { readonly _tag: "StaleTimer"; readonly timer: TimerId }
  | { readonly _tag: "NotNow"; readonly input: Input["_tag"] }
  | { readonly _tag: "FeatureFailed"; readonly feature: string }
  /** A Line the Client meant to send that a Feature refused, such as bytes not UTF-8 under `UTF8ONLY`. */
  | { readonly _tag: "Unsendable"; readonly command: string }
  /** An answer spread over more Lines than the Client reads, taken as a refusal. */
  | { readonly _tag: "Endless"; readonly command: string }
  /** An echo of what Self said that nothing can tie to what we sent, while `echo-message` is being given up. */
  | { readonly _tag: "UnmatchedEcho" }
  /** A `Read` or a `CloseTimeline` whose Target names no one Timeline, such as a list or a mask. */
  | { readonly _tag: "NoTimeline" }
  /**
   * A `CloseTimeline` of a Channel Self is in, which stays open while Self is there. It
   * names the Channel as the Client checked it, with a status prefix taken off, which is
   * what leaving it takes.
   */
  | { readonly _tag: "Joined"; readonly channel: string };

/**
 * What happened in one step, in order.
 *
 * A Message or Activity can arrive twice: live, and again later from the Ircd's history.
 * `live` tells them apart, and a Timeline keeps one per id and orders by `at`, not by
 * when the News came.
 *
 * A Message or Activity carries `where`, the Timelines it belongs to, and nothing else
 * does: a `Confirmed` or a `Refused` names the intent of a Message already placed, and
 * the rest belongs to the Network. A `Refused` for an action says where it belongs in its
 * `action` instead.
 */
export type News =
  | {
      readonly _tag: "Message";
      readonly at: Fact<Instant>;
      readonly id: Fact<MessageId>;
      /** False when the Ircd sent it later, from its history. It fills a Gap and calls for no Highlight. */
      readonly live: boolean;
      readonly sender: string;
      readonly target: string;
      readonly text: string;
      readonly kind: SayKind;
      /** Client-only tags, such as `+reply`, as data. */
      readonly tags: ReadonlyMap<string, string>;
      /** The id of the Message it answers, from a `+reply` tag that names one. */
      readonly answers: MessageId | undefined;
      /**
       * The Channel a Direct Message was said in the context of, from a `+channel-context`
       * tag. Set only on a Message to a User whose tag names a Channel by the Network's
       * naming, as the tag's spec says.
       */
      readonly context: string | undefined;
      /** Set when we said it, as the Owner's intent. A Message from Self said elsewhere has none. */
      readonly ours: Ours | undefined;
      /**
       * Whether its sender said it as a bot: its Line carried the `bot` tag while the Ircd
       * names a bot mode. A projection may leave it out of what calls for the Owner.
       */
      readonly bot: boolean;
      /**
       * Whether it calls for the Owner: said live by a User other than Self, naming Self's
       * nick or one of the Configuration's `highlights` as a whole word.
       */
      readonly highlight: boolean;
      /**
       * Whether Self said it, by the source: ours, Self's echo, or Self said elsewhere, as
       * from another IRC client. A projection counts none of these as unread.
       */
      readonly self: boolean;
      /** The Timelines it belongs to. Never empty. */
      readonly where: readonly Where[];
      /**
       * The Owner's ignore masks its sender matched when it arrived, folded by the casemapping
       * then in force and in the Configuration's order, each once. Absent when none matched,
       * and always for Self's own. Nothing is dropped: a projection hides what is stamped.
       */
      readonly ignored?: readonly IgnoreMask[];
    }
  | {
      /**
       * The Ircd echoed back the Message for an intent. Its time, id, and text are the
       * Ircd's, and the text may differ from what we sent.
       */
      readonly _tag: "Confirmed";
      readonly intent: IntentId;
      readonly at: Fact<Instant>;
      readonly id: Fact<MessageId>;
      readonly text: string;
    }
  | {
      readonly _tag: "Activity";
      readonly at: Fact<Instant>;
      readonly id: Fact<MessageId>;
      readonly live: boolean;
      readonly activity: Activity;
      /** The Timelines it touches. Never empty. */
      readonly where: readonly Where[];
      /**
       * The Owner's ignore masks the User it came from matched, as a Message's `ignored` is:
       * the one who joined, quit, was kicked by, or set a mode or topic. Absent when none
       * matched, and always for Self's own.
       */
      readonly ignored?: readonly IgnoreMask[];
    }
  /**
   * The Owner stopped ignoring masks: each is a canonical mask, folded as `ignored` is, that
   * the Configuration held and no longer does. A projection shows again what only these
   * masks hid. A mask respelt in another case is the same mask, and is no news.
   */
  | { readonly _tag: "Unignored"; readonly masks: readonly IgnoreMask[] }
  /** The Owner removed the Network, and `keep` is whether its Timelines stay readable. */
  | { readonly _tag: "NetworkRemoved"; readonly keep: boolean }
  | { readonly _tag: "SessionBegan"; readonly at: Instant; readonly nick: string }
  | { readonly _tag: "SessionEnded"; readonly at: Instant; readonly reason: EndReason }
  /** A Connection ended before its Session began, with the Ircd it was dialled to. */
  | {
      readonly _tag: "ConnectionFailed";
      readonly at: Instant;
      readonly reason: EndReason;
      readonly ircd: IrcdAddress;
      /** Whether the Connection was open, the Transport having reached the Ircd, before it ended. */
      readonly opened: boolean;
    }
  | {
      readonly _tag: "Refused";
      readonly intent: IntentId;
      readonly reason: RefusedReason;
      /**
       * For an `Act`, what it tried and where it belongs, so a projection can show its
       * refusal there. `undefined` for a `Say`, whose Message already stands where it
       * belongs, and for an action too old for the Client to remember.
       */
      readonly action: RefusedAction | undefined;
    }
  /**
   * An Ircd declared a casemapping other than the one the Network last declared, so keys
   * in `where` are folded by `casemapping` from here on. A projection folds each Timeline's
   * name again by it, and of Timelines whose keys now meet, keeps the first. A mapping the
   * Client does not know folds as `ascii`, and is reported as `ascii`.
   */
  | { readonly _tag: "Refolded"; readonly casemapping: Casemapping }
  /**
   * The Owner's Read Marker of a Timeline moved forward, to `read`. `where` is keyed as
   * a Message's is, and a `Direct` is `existing`, since marking read starts no Timeline.
   */
  | { readonly _tag: "ReadMarker"; readonly where: Marked; readonly read: Instant }
  /**
   * The Owner closed a Timeline, putting it out of the Sidebar until something arrives in
   * it again. `where` is keyed as a Message's is, and a `Direct` is `existing`, since
   * closing starts no Timeline. The Client keeps nothing of it: whether a Timeline is
   * closed is the projection's to derive.
   */
  | { readonly _tag: "TimelineClosed"; readonly where: Closable }
  /**
   * What is known of a Channel Self is in changed in a way no Activity reports: a reply
   * gave its modes or its topic, a `NAMES` listing of its members ended, or a Line gave or changed a member's bot mark. A projection
   * tells a Frontend to read the Channel again. `channel` is keyed as a Message's `where`.
   */
  | { readonly _tag: "ChannelLearned"; readonly channel: Named }
  /**
   * Whether a Direct Message partner is on the Network, as `Knowledge.partners` says, changed
   * in a way no Activity reports: the first status `MONITOR` gave, their joining or leaving
   * a Channel Self shares, or the Session ending. A projection tells a Frontend to read
   * again. `partner` is keyed as a Direct Message's `where` is.
   */
  | { readonly _tag: "PartnerLearned"; readonly partner: Named }
  /**
   * A Lookup the Owner asked for, under its intent, is over, and this is all it found.
   * Exactly one comes for each `Look`.
   */
  | {
      readonly _tag: "LookedUp";
      readonly intent: IntentId;
      readonly lookup: Lookup;
      readonly result: LookResult;
    }
  | { readonly _tag: "Ignored"; readonly reason: IgnoredReason };

/**
 * News as the core reads it from a Line, before the step works out where it belongs,
 * whether a Message is a Highlight, whether Self said it, and which ignore masks its sender matches.
 */
export type Unrouted<T extends News = News> = T extends { readonly where: readonly Where[] }
  ? Omit<T, "where" | "highlight" | "self" | "ignored">
  : T;
