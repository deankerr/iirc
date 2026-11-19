/**
 * The Activity of Users coming and going: a join, a part, a quit, or a change of nick. A
 * Timeline folds a run of these into one line, and `ui.activity` may hide those of Users who
 * did not speak. Which of them are Self's is worked out here, since no item says so.
 *
 * @packageDocumentation
 */
import type { Activity, ItemContent, TimelineItem } from "@iirc/api";
import { casefold, defaultCasemapping } from "@iirc/protocol/casemapping";

/** A join, a part, a quit, or a change of nick: what a run of them folds. A kick is not one. */
export type Churn = Extract<
  Activity,
  { readonly _tag: "Joined" | "Parted" | "Quit" | "NickChanged" }
>;

/**
 * The Activity an item holds, if it is churn.
 * @param content - What the item holds.
 * @returns The churn, or none.
 */
export const churnOf = (content: ItemContent): Churn | undefined => {
  if (content._tag !== "Activity") {
    return undefined;
  }

  const { activity } = content;

  return activity._tag === "Joined" ||
    activity._tag === "Parted" ||
    activity._tag === "Quit" ||
    activity._tag === "NickChanged"
    ? activity
    : undefined;
};

/**
 * Who churn is about: the one who joined, left, or quit, or, for a change of nick, the nick
 * they had before.
 * @param churn - The churn.
 * @returns The nick.
 */
export const churnNick = (churn: Churn): string =>
  churn._tag === "NickChanged" ? churn.from : churn.nick;

/**
 * A nick folded as the Frontend compares them.
 * @param nick - The nick.
 * @returns The folded nick.
 */
export const foldNick = (nick: string): string => casefold(defaultCasemapping, nick);

/**
 * The items of a window that are Self's churn. Walking from the newest, Self's nick starts
 * as the one given, and a change of nick to Self's nick says Self went by the one before it
 * for every item earlier. An item is Self's when it is about Self's nick at that point, or
 * is the change of nick itself. With no nick known, none is Self's.
 * @param items - The window's items, in order.
 * @param self - Self's nick now, if known.
 * @returns The items that are Self's.
 */
export const selfChurn = (
  items: readonly TimelineItem[],
  self: string | undefined
): ReadonlySet<TimelineItem> => {
  const ours = new Set<TimelineItem>();

  if (self === undefined) {
    return ours;
  }

  let nick = foldNick(self);

  for (const item of items.toReversed()) {
    const churn = churnOf(item.content);

    if (churn === undefined) {
      continue;
    }

    if (churn._tag === "NickChanged" && foldNick(churn.to) === nick) {
      ours.add(item);
      nick = foldNick(churn.from);
    } else if (foldNick(churnNick(churn)) === nick) {
      ours.add(item);
    }
  }

  return ours;
};
