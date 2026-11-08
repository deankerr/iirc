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
  | { readonly _tag: "Restarted" };

/** Why the Client did not carry out something the Owner asked for. */
export type RefusedReason = "Offline" | "Unsendable";

/** Why an input changed nothing. Each is recorded, and none ends a Connection. */
export type IgnoredReason =
  | { readonly _tag: "Unparseable"; readonly reason: UnparseableReason }
  | { readonly _tag: "Malformed"; readonly command: string }
  | { readonly _tag: "StaleConnection"; readonly connection: ConnectionId }
  | { readonly _tag: "StaleTimer"; readonly timer: TimerId }
  | { readonly _tag: "NotNow"; readonly input: Input["_tag"] }
  | { readonly _tag: "FeatureFailed"; readonly feature: string };

/** What happened in one step, in order. */
export type News =
  | {
      readonly _tag: "Message";
      readonly at: Fact<Instant>;
      readonly id: Fact<MessageId>;
      readonly sender: string;
      readonly target: string;
      readonly text: string;
      readonly kind: SayKind;
      readonly ours: boolean;
    }
  | { readonly _tag: "Activity"; readonly at: Fact<Instant>; readonly activity: Activity }
  | { readonly _tag: "SessionBegan"; readonly at: Instant; readonly nick: string }
  | { readonly _tag: "SessionEnded"; readonly at: Instant; readonly reason: EndReason }
  | { readonly _tag: "Refused"; readonly intent: IntentId; readonly reason: RefusedReason }
  | { readonly _tag: "Ignored"; readonly reason: IgnoredReason };
