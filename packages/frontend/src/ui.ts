/**
 * The options under `ui` as they take effect on this device: each one this device
 * overrides for itself, else the one every device shares, else its default, derived and
 * never kept (ADR 0013, ADR 0015). A device keeps its overrides as text, parsed here
 * option by option, so one it cannot read is dropped rather than the rest. What the
 * options decide that is not drawing, such as which items a Timeline shows, is here too.
 *
 * @packageDocumentation
 */
import type { ItemContent } from "@iirc/api";
import { UiOptionName, UiOptions, uiDefaults } from "@iirc/api/ui";
import type { ActivityShown, UiInForce } from "@iirc/api/ui";
import { Option, Schema } from "effect";

/** The options this device overrides for itself, each with its own value. */
export type DeviceUi = Partial<UiOptions>;

/** A device that overrides nothing. */
export const noOverrides: DeviceUi = {};

/** Where a device keeps its overrides, as `localStorage` names it. */
export const deviceUiKey = "iirc.ui";

/** The longest text of overrides read, so a device's storage can hold up nothing. */
const deviceUiLimit = 4096;

const decodeObject = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
);

const decodeName = Schema.decodeUnknownOption(UiOptionName);

/**
 * The overrides a device kept, from their text: every option it names that `ui` has, with
 * a value its Schema takes. Anything else, and text that is not an object or is too long,
 * is dropped.
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
      const name = decodeName(key);

      const parsed = name.pipe(
        Option.flatMap((option) =>
          Schema.decodeOption(Schema.toCodecJson(UiOptions.fields[option]))(value)
        )
      );

      return Option.isSome(name) && Option.isSome(parsed) ? [[name.value, parsed.value]] : [];
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

/**
 * The options in effect on this device: each one it overrides, else the shared one, else
 * its default, which holds until the shared ones are read.
 * @param shared - The shared options, once read.
 * @param device - This device's overrides.
 * @returns The options.
 */
export const effectiveUi = (shared: UiInForce | undefined, device: DeviceUi): UiOptions => ({
  ...uiDefaults,
  ...shared?.options,
  ...device,
});

/** The Activity `quiet` leaves out: a User coming or going. */
const comings: ReadonlySet<string> = new Set(["Joined", "Parted", "Quit"]);

/**
 * Whether a Timeline shows an item, as `activity` says: in a Channel's, all Activity,
 * all but joins, parts, and quits, or none. Every other item, and every item of another
 * kind of Timeline, shows. It decides what is drawn, never what is counted.
 * @param activity - Which Activity a Channel shows.
 * @param kind - The Timeline's kind.
 * @param content - What the item holds.
 * @returns Whether it shows.
 */
export const showsItem = (
  activity: ActivityShown,
  kind: "Network" | "Channel" | "Direct" | undefined,
  content: ItemContent
): boolean => {
  if (kind !== "Channel" || content._tag !== "Activity" || activity === "all") {
    return true;
  }

  return activity === "quiet" && !comings.has(content.activity._tag);
};
