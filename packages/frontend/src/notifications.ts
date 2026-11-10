/**
 * Which items the changes stream adds call for a notification, and what it says. Only
 * something said live to the Owner, a Highlight or a Direct Message from someone else,
 * that the Owner is not already looking at and has not read. The runtime shows them, when
 * the Owner turned notifications on for the device.
 *
 * @packageDocumentation
 */
import type { NetworkId, Timeline, TimelineChange, TimelineId, TimelineItem } from "@iirc/api";

import { lookingAt } from "./activity.ts";
import type { Page } from "./activity.ts";
import { plainText } from "./render.ts";
import type { Timelines } from "./timelines.ts";

/**
 * A notification to show: its title, the Network and the Timeline's name, its body, the
 * Message as plain text, and its tag, one per Timeline, so a newer one replaces the last
 * rather than piling up. Choosing it opens `timeline`.
 */
export interface Notify {
  readonly network: NetworkId;
  readonly timeline: TimelineId;
  readonly title: string;
  readonly body: string;
  readonly tag: string;
}

/**
 * A Timeline as the state lists it, after the change.
 * @param state - The state.
 * @param item - An item of it.
 * @returns The Timeline, or none while it is not listed.
 */
const timelineOf = (state: Timelines, item: TimelineItem): Timeline | undefined =>
  state.networks.get(item.network)?.timelines.get(item.timeline);

/**
 * A Message as a notification's body: the sender and the text, each plain and isolated, as
 * an IRC client writes each kind.
 * @param content - The Message.
 * @returns The body.
 */
const bodyOf = (content: Extract<TimelineItem["content"], { readonly _tag: "Message" }>) => {
  const sender = plainText(content.sender, 64);
  const text = plainText(content.text);

  switch (content.kind) {
    case "Action": {
      return `* ${sender} ${text}`;
    }

    case "Notice": {
      return `-${sender}- ${text}`;
    }

    case "Privmsg": {
      return `<${sender}> ${text}`;
    }

    default: {
      return content.kind satisfies never;
    }
  }
};

/**
 * The notification an item calls for, if any: one made by the step the change is of, a
 * Message said live, not ours, a Highlight or a Direct Message, in a Timeline the Owner is
 * not looking at, after its Read Marker.
 * @param after - The state with the change folded.
 * @param change - The change.
 * @param page - The page.
 * @param item - The item.
 * @returns The notification, or none.
 */
const notifyOf = (
  after: Timelines,
  change: TimelineChange,
  page: Page,
  item: TimelineItem
): Notify | undefined => {
  const { content } = item;
  const timeline = timelineOf(after, item);

  if (
    item.sequence !== change.sequence ||
    content._tag !== "Message" ||
    !content.live ||
    content.ours !== null ||
    (item.level !== "Highlight" && item.level !== "Direct") ||
    timeline === undefined ||
    (timeline.read !== null && item.position.at <= timeline.read) ||
    lookingAt(after, page, timeline.id)
  ) {
    return undefined;
  }

  return {
    body: bodyOf(content),
    network: item.network,
    tag: `iirc:${timeline.id}`,
    timeline: timeline.id,
    title: `${plainText(timeline.name, 64)} \u00B7 ${item.network}`,
  };
};

/**
 * The notifications a change of the stream calls for, once folded. A change the state did
 * not take, as one given twice is, calls for none, nor does a step at or below the highest
 * one considered before, as a reset replays, nor anything read, said before, or in history.
 * @param before - The state before the change.
 * @param after - The state with it folded.
 * @param change - The change.
 * @param page - The page.
 * @returns The notifications, at most one per Timeline, the latest.
 */
export const notificationsOf = (
  before: Timelines,
  after: Timelines,
  change: TimelineChange,
  page: Page
): readonly Notify[] => {
  // A step at or below the boundary was considered before, as when a reset replays it, and
  // one the state did not take, as one given twice, moves no boundary.
  if (change.sequence <= before.considered || after.considered < change.sequence) {
    return [];
  }

  const latest = new Map<TimelineId, Notify>();

  for (const item of change.items) {
    const notify = notifyOf(after, change, page, item);

    if (notify !== undefined) {
      latest.set(notify.timeline, notify);
    }
  }

  return [...latest.values()];
};
