/**
 * What one step tells a store to do. Everything that grows with history is the store's,
 * so each change is keyed, and the store's laws pin down what it means.
 *
 * @packageDocumentation
 */
import type { Instant, IntentId, MessageId } from "@iirc/client";
import type { Fact } from "@iirc/client/known";

import type { Content } from "./content.ts";
import type { Position } from "./position.ts";
import type { Descriptor, TimelineId } from "./timeline.ts";

/**
 * One change. Each carries `sequence`, the step that made it, so a store records, for each
 * Timeline, item, and Gap, the last sequence that changed it.
 *
 * - `Described`: a Timeline was opened, or its name or key changed, or it was detached.
 *   The store holds `timeline` as given.
 * - `Added`: an item, at `position` in `timeline`. A Timeline keeps one item per message
 *   id: when `messageId` is already there, or an item already stands at `position`, the
 *   first is kept and this one dropped. An item with no `messageId` is always kept.
 * - `Confirmed`: the Ircd echoed the Message for `intent`. Its items in `network` are
 *   confirmed in place, with the Ircd's time, id, and text, and never move.
 * - `Unsent`: the Message for `intent` never left. Its items in `network` are marked so,
 *   unless already confirmed.
 * - `Merged`: two Timelines' keys met when the Network's casemapping changed. `from`'s
 *   items move into `into`, by the same rule as `Added`, and `from` is left as a tombstone
 *   that says where it went.
 * - `Gap`: a period when the Network was not on, from `from`, to `to` once it is back on.
 */
export type Change =
  | { readonly _tag: "Described"; readonly sequence: number; readonly timeline: Descriptor }
  | {
      readonly _tag: "Added";
      readonly sequence: number;
      readonly network: string;
      readonly timeline: TimelineId;
      readonly position: Position;
      readonly content: Content;
      /** The Ircd's id for the item, when one is known, which a Timeline keeps once. */
      readonly messageId: MessageId | undefined;
      /** The Owner's intent, for one of our Messages. */
      readonly intent: IntentId | undefined;
    }
  | {
      readonly _tag: "Confirmed";
      readonly sequence: number;
      readonly network: string;
      readonly intent: IntentId;
      readonly at: Fact<Instant>;
      readonly id: Fact<MessageId>;
      readonly text: string;
      /** The Ircd's id, when known: the item is kept under it from now on. */
      readonly messageId: MessageId | undefined;
    }
  | {
      readonly _tag: "Unsent";
      readonly sequence: number;
      readonly network: string;
      readonly intent: IntentId;
    }
  | {
      readonly _tag: "Merged";
      readonly sequence: number;
      readonly network: string;
      readonly from: TimelineId;
      readonly into: TimelineId;
    }
  | {
      readonly _tag: "Gap";
      readonly sequence: number;
      readonly network: string;
      readonly from: Position;
      readonly to: Position | undefined;
    };
