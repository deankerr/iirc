/**
 * What happened, for Timelines. News is derived: replaying the Journal makes it again,
 * so it is never journaled.
 *
 * @packageDocumentation
 */
import type { UnparseableReason } from "@iirc/protocol/line";

import type { ConnectionId, Instant, IntentId, MessageId, TimerId } from "./ids.ts";
import type { CloseReason, Input, SayKind } from "./input.ts";
import type { Casemapping, Fact, Topic } from "./known.ts";

/** Something that changed on the Network, rather than something said. */
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
    };

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
 * Connection ended first.
 */
export type RefusedReason =
  | { readonly _tag: "Offline" }
  | { readonly _tag: "Unsendable" }
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
 * - `Invite`: a nick to a Channel.
 * - `Nick`: Self's nick.
 * - `Away`: away, or back with `away` false.
 * - `Raw`: a Line written as text, by its command, or `null` when it did not parse.
 */
export type Attempted =
  | { readonly _tag: "Topic"; readonly channel: string }
  | { readonly _tag: "Kick"; readonly channel: string; readonly nicks: readonly string[] }
  | { readonly _tag: "Mode"; readonly target: string; readonly modes: string }
  | { readonly _tag: "Invite"; readonly nick: string; readonly channel: string }
  | { readonly _tag: "Nick"; readonly nick: string }
  | { readonly _tag: "Away"; readonly away: boolean }
  | { readonly _tag: "Raw"; readonly command: string | null };

/**
 * Where an action of the Owner's belongs, to show its refusal: the Channel it was about,
 * when the Client held that Channel as it was asked for, and otherwise, and for a nick,
 * away, a raw Line, and Self's own modes, the Network's own Timeline.
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
  /** A `Read` whose Target names no one Timeline, such as a list or a mask. */
  | { readonly _tag: "NoTimeline" };

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
      /** Client-only tags, such as `+draft/reply`, as data. */
      readonly tags: ReadonlyMap<string, string>;
      /** Set when we said it, as the Owner's intent. A Message from Self said elsewhere has none. */
      readonly ours: Ours | undefined;
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
    }
  | { readonly _tag: "SessionBegan"; readonly at: Instant; readonly nick: string }
  | { readonly _tag: "SessionEnded"; readonly at: Instant; readonly reason: EndReason }
  | { readonly _tag: "ConnectionFailed"; readonly at: Instant; readonly reason: EndReason }
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
  | { readonly _tag: "Ignored"; readonly reason: IgnoredReason };

/**
 * News as the core reads it from a Line, before the step works out where it belongs,
 * whether a Message is a Highlight, and whether Self said it.
 */
export type Unrouted<T extends News = News> = T extends { readonly where: readonly Where[] }
  ? Omit<T, "where" | "highlight" | "self">
  : T;
