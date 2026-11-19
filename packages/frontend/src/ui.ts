/**
 * The options under `ui` as they take effect on this device: each one this device
 * overrides for itself, else the one every device shares, else its default, derived and
 * never kept (ADR 0013, ADR 0015). A device keeps its overrides as text, parsed here
 * option by option, so one it cannot read is dropped rather than the rest, and so is one
 * of an option every device shares only, such as `previews`. What the
 * options decide that is not drawing, such as which items a Timeline shows, is here too.
 *
 * @packageDocumentation
 */
import type { TimelineItem } from "@iirc/api";
import {
  FontShown,
  UiOptionName,
  ansiCount,
  fontFamilyMaxLength,
  isFontName,
  themesCap,
  uiDefaults,
  uiSharedOnly,
  uiValueKept,
} from "@iirc/api/ui";
import type { UiOptions, ActivityShown, ReadRule, UiInForce } from "@iirc/api/ui";
import { Option, Schema } from "effect";

import { churnOf, foldNick, selfChurn } from "./churn.ts";

/** The options this device overrides for itself, each with its own value. */
export type DeviceUi = Partial<UiOptions>;

/** A device that overrides nothing. */
export const noOverrides: DeviceUi = {};

/** Where a device keeps its overrides, as `localStorage` names it. */
export const deviceUiKey = "iirc.ui";

/**
 * The longest a device's overrides can be as `deviceUiText` writes them: every option
 * overridden, with the longest font's family, themes' longest names, and `themesCap` themes of the longest names,
 * each with every colour.
 */
const longestOverrides = JSON.stringify({
  ...uiDefaults,
  dark: "x".repeat(32),
  font: "x".repeat(fontFamilyMaxLength),
  light: "x".repeat(32),
  theme: "x".repeat(32),
  themes: Array.from({ length: themesCap }, (_, index) => ({
    name: `${index}`.padEnd(32, "x"),
    palette: {
      ansi: Array.from({ length: ansiCount }, () => "#000000"),
      background: "#000000",
      cursor: "#000000",
      foreground: "#000000",
      selection: "#000000",
    },
  })),
}).length;

/**
 * The longest text of overrides read: twice the longest a device writes, so any it kept is
 * read, while a device's storage can hold up nothing.
 */
export const deviceUiLimit = longestOverrides * 2;

const decodeObject = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
);

const decodeName = Schema.decodeUnknownOption(UiOptionName);

/**
 * Whether a device may override an option for itself: any but those every device shares
 * only, which the Daemon acts on.
 * @param option - The option.
 * @returns Whether it may.
 */
export const isOverridable = (option: UiOptionName): boolean => !uiSharedOnly.has(option);

/**
 * The overrides a device kept, from their text: every option it names that `ui` has and a
 * device may override, with a value its Schema takes, each option on its own, and each
 * theme of `themes` on its own. Anything else, and text that is not an object or is longer
 * than `deviceUiLimit`, is dropped.
 * @param text - The text kept, or none.
 * @returns The overrides.
 */
export const deviceUiOf = (text: string | undefined): DeviceUi => {
  const kept =
    text === undefined || text.length > deviceUiLimit ? Option.none() : decodeObject(text);

  if (Option.isNone(kept)) {
    return noOverrides;
  }

  return Object.fromEntries(
    Object.entries(kept.value).flatMap(([key, value]) => {
      const name = Option.filter(decodeName(key), isOverridable);

      const parsed = Option.isSome(name) ? uiValueKept(name.value, value) : undefined;

      return Option.isSome(name) && parsed !== undefined ? [[name.value, parsed]] : [];
    })
  );
};

/**
 * The text a device keeps its overrides as, which `deviceUiOf` reads back, or none when it
 * overrides nothing, so it keeps nothing.
 * @param device - The overrides.
 * @returns The text, or none.
 */
export const deviceUiText = (device: DeviceUi): string | undefined =>
  Object.keys(device).length === 0 ? undefined : JSON.stringify(device);

/**
 * A device's overrides with one option overridden, or no longer, parsed again whole, so a
 * value its Schema does not take is never kept.
 * @param device - The overrides.
 * @param option - The option.
 * @param value - Its value here, as JSON, or none to follow the shared one again.
 * @returns The overrides after.
 */
export const overridden = (
  device: DeviceUi,
  option: UiOptionName,
  value: Schema.Json | undefined
): DeviceUi => {
  const others = Object.entries(device).filter(([key]) => key !== option);
  const entries = value === undefined ? others : [...others, [option, value] as const];

  return deviceUiOf(JSON.stringify(Object.fromEntries(entries)));
};

const decodeFont = Schema.decodeUnknownOption(FontShown);

/**
 * Whether a change of an option under `ui` is written as this device's own value, rather
 * than the one every device shares. A font's family is always a device's own, since each
 * device has its own fonts. Any other value is the shared one's, unless this device
 * overrides the option already, since its override would win over the change here. One
 * every device shares only is never a device's own.
 * @param option - The option.
 * @param value - The value it is set to, as JSON, or none to unset it.
 * @param overridden - Whether this device overrides the option.
 * @returns Whether this device's value is the one written.
 */
export const writtenOnDevice = (
  option: UiOptionName,
  value: Schema.Json | undefined,
  overridden: boolean
): boolean => {
  if (!isOverridable(option)) {
    return false;
  }

  if (overridden || option !== "font") {
    return overridden;
  }

  const font = decodeFont(value);

  return Option.isSome(font) && !isFontName(font.value);
};

/**
 * A device's overrides with any of an option every device shares only left out, so one
 * kept by hand or before the option was shared only never takes effect.
 * @param device - The overrides.
 * @returns Those a device may hold.
 */
export const overridesHeld = (device: DeviceUi): DeviceUi =>
  Object.fromEntries(
    Object.entries(device).filter(([key]) => Option.exists(decodeName(key), isOverridable))
  );

/**
 * The options in effect on this device: each one it overrides, but those every device
 * shares only, else the shared one, else its default, which holds until the shared ones
 * are read.
 * @param shared - The shared options, once read.
 * @param device - This device's overrides.
 * @returns The options.
 */
export const effectiveUi = (shared: UiInForce | undefined, device: DeviceUi): UiOptions => ({
  ...uiDefaults,
  ...shared?.options,
  ...overridesHeld(device),
});

/**
 * When a Timeline is marked read on this device: its override, else the shared rule once
 * read, and none before, since a default taken then could mark read what the Owner's own
 * rule never would.
 * @param shared - The shared options, once read.
 * @param device - This device's overrides.
 * @returns The rule, or none while it is not yet known.
 */
export const readRuleOf = (shared: UiInForce | undefined, device: DeviceUi): ReadRule | undefined =>
  device.read ?? shared?.options.read;

/** The Activity `quiet` leaves out: a User coming or going. */
const comings: ReadonlySet<string> = new Set(["Joined", "Parted", "Quit"]);

/** How long before a join, part, or quit a User must have spoken for `spoke` to show it: five minutes. */
export const spokeSpan = 300_000;

/**
 * The comings and goings `spoke` shows: Self's own, and those of a User who said a Message
 * in the window no more than {@link spokeSpan} before, by the items' own times, as the
 * window's order has it. A User is followed across a change of nick.
 * @param items - The window's items, in order.
 * @param self - Self's nick, if known.
 * @returns The items it shows.
 */
const spokenComings = (
  items: readonly TimelineItem[],
  self: string | undefined
): ReadonlySet<TimelineItem> => {
  const ours = selfChurn(items, self);
  const shown = new Set<TimelineItem>();
  // When each User last spoke, by their nick folded.
  const spoke = new Map<string, number>();

  for (const item of items) {
    const { content } = item;

    if (content._tag === "Message") {
      spoke.set(foldNick(content.sender), item.position.at);

      continue;
    }

    const churn = churnOf(content);

    if (churn === undefined) {
      continue;
    }

    if (churn._tag === "NickChanged") {
      const was = spoke.get(foldNick(churn.from));

      if (was !== undefined) {
        spoke.delete(foldNick(churn.from));
        spoke.set(foldNick(churn.to), was);
      }

      continue;
    }

    const last = spoke.get(foldNick(churn.nick));

    if (ours.has(item) || (last !== undefined && item.position.at - last <= spokeSpan)) {
      shown.add(item);
    }
  }

  return shown;
};

/**
 * Which items of a Timeline's window it shows, as `activity` says: in a Channel's, all
 * Activity, all but the joins, parts, and quits of Users who did not speak shortly before
 * (Self's always shown), all but joins, parts, and quits, or none. Every other item, and
 * every item of another kind of Timeline, shows. It decides what is drawn, never what is
 * counted, and is worked out once for a window.
 * @param activity - Which Activity a Channel shows.
 * @param kind - The Timeline's kind.
 * @param items - The window's items, in order.
 * @param self - Self's nick, if known, which `spoke` shows the joins, parts, and quits of.
 * @returns Whether each of the window's items shows.
 */
export const showsIn = (
  activity: ActivityShown,
  kind: "Network" | "Channel" | "Direct" | undefined,
  items: readonly TimelineItem[],
  self: string | undefined
): ((item: TimelineItem) => boolean) => {
  if (kind !== "Channel" || activity === "all") {
    return () => true;
  }

  // With Self's nick unknown, any of them could be Self's, so `spoke` hides none.
  if (activity === "spoke" && self === undefined) {
    return () => true;
  }

  const spoken = activity === "spoke" ? spokenComings(items, self) : undefined;

  return (item) => {
    const { content } = item;

    if (content._tag !== "Activity") {
      return true;
    }

    if (!comings.has(content.activity._tag)) {
      return activity !== "none";
    }

    return spoken?.has(item) === true;
  };
};
