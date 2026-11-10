/**
 * What an item shows: a Message, an Activity, or a Session's start or end, as a Frontend
 * draws it. It is plain data, and keyed by nothing a Network chose.
 *
 * @packageDocumentation
 */
import type { Activity, EndReason, Instant, IntentId, MessageId, SayKind } from "@iirc/client";
import type { Fact } from "@iirc/client/known";

/**
 * Where one of our Messages stands with the Ircd.
 *
 * - `Pending`: sent, and the Ircd will echo it, which has not come yet.
 * - `Unconfirmed`: sent, and the Ircd will not echo it, so delivery is unknown.
 * - `Confirmed`: the Ircd echoed it, with its own time, id, and final text, which may differ from ours.
 * - `Unsent`: at least part of it never left, because its Connection ended first.
 * - `Rejected`: the Ircd refused it, with `reply`, the numeric or standard reply's code,
 *   never the reply's text.
 */
export type Delivery =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Unconfirmed" }
  | {
      readonly _tag: "Confirmed";
      readonly at: Fact<Instant>;
      readonly id: Fact<MessageId>;
      readonly text: string;
    }
  | { readonly _tag: "Unsent" }
  | { readonly _tag: "Rejected"; readonly reply: string };

/** That we said a Message, as the Owner's intent, and where it stands. */
export interface OursItem {
  readonly intent: IntentId;
  readonly delivery: Delivery;
}

/** What an item shows. */
export type Content =
  | {
      readonly _tag: "Message";
      readonly at: Fact<Instant>;
      readonly id: Fact<MessageId>;
      readonly live: boolean;
      readonly sender: string;
      readonly target: string;
      readonly text: string;
      readonly kind: SayKind;
      /** Client-only tags, as `[name, value]` pairs in the order they came. */
      readonly tags: readonly (readonly [string, string])[];
      readonly ours: OursItem | undefined;
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
  | { readonly _tag: "ConnectionFailed"; readonly at: Instant; readonly reason: EndReason };

/**
 * How much an item calls for the Owner, as WeeChat ranks activity, which unread counts are
 * kept by:
 *
 * - `Highlight`: a Message that is a Highlight, wherever it stands.
 * - `Direct`: any other Message in a Direct Message Timeline.
 * - `Message`: any other Message in a Channel's Timeline.
 * - `Activity`: an Activity, a Session's start or end, a failed Connection, or a Message
 *   in the Network's own Timeline.
 *
 * Our own Messages, and every Message Self said, have no level, and never count.
 */
export type Level = "Highlight" | "Direct" | "Message" | "Activity";

/** Every level, from the one that calls for the Owner most. */
export const levels: readonly Level[] = ["Highlight", "Direct", "Message", "Activity"];

/**
 * The most an unread count says exactly. A count of `unreadCap + 1` means more than
 * `unreadCap`, so counting never reads more than `unreadCap + 1` items of a level.
 */
export const unreadCap = 999;
