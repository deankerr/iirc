/**
 * What happened, for Timelines. News is derived: replaying the Journal makes it again,
 * so it is never journaled.
 *
 * @packageDocumentation
 */
import type { UnparseableReason } from "@iirc/protocol/line";

import type { ConnectionId, Instant, IntentId, MessageId, TimerId } from "./ids.ts";
import type { CloseReason, Input, SayKind } from "./input.ts";
import type { Fact, Topic } from "./known.ts";

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
 * `reply` is the numeric, or a standard reply's code, never the reply's text.
 */
export type RefusedReason =
  | { readonly _tag: "Offline" }
  | { readonly _tag: "Unsendable" }
  | { readonly _tag: "Rejected"; readonly reply: string };

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
  /** An echo of what Self said that nothing can tie to what we sent, while `echo-message` is being given up. */
  | { readonly _tag: "UnmatchedEcho" };

/**
 * What happened in one step, in order.
 *
 * A Message or Activity can arrive twice: live, and again later from the Ircd's history.
 * `live` tells them apart, and a Timeline keeps one per id and orders by `at`, not by
 * when the News came.
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
    }
  | { readonly _tag: "SessionBegan"; readonly at: Instant; readonly nick: string }
  | { readonly _tag: "SessionEnded"; readonly at: Instant; readonly reason: EndReason }
  | { readonly _tag: "ConnectionFailed"; readonly at: Instant; readonly reason: EndReason }
  | { readonly _tag: "Refused"; readonly intent: IntentId; readonly reason: RefusedReason }
  | { readonly _tag: "Ignored"; readonly reason: IgnoredReason };
