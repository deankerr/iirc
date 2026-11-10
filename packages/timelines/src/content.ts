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
  | { readonly _tag: "Unsent" };

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
