/**
 * The options under `ui`: Configuration that belongs to the Owner rather than to any
 * Network, such as how Frontends look, shared by every device (ADR 0013, ADR 0015). Each
 * field says what it is and what it starts as in its annotations, which a Frontend reads
 * to offer every field as an option, so a new field is a new option with no work in any
 * Frontend. This module is the Schema alone, so a Frontend's pure core can derive its
 * options from it without the HTTP contract.
 *
 * @packageDocumentation
 */
import { Schema, SchemaAST, Struct } from "effect";

/**
 * The theme a Frontend draws in, by name: `system` follows the device's light or dark
 * setting. A name is plain text on the wire, so the built-ins can grow into named palettes
 * and every name journaled before still decodes.
 */
export const ThemeName = Schema.Literals(["system", "dark", "light"]).annotate({
  default: "system",
  description: "The theme to draw in: system, which follows the device's setting, dark, or light.",
});

/** The decoded form of {@link ThemeName}. */
export type ThemeName = typeof ThemeName.Type;

/** How a line's time shows: hours and minutes, with seconds too, or not at all. */
export const TimeShown = Schema.Literals(["HH:mm", "HH:mm:ss", "none"]).annotate({
  default: "HH:mm",
  description: "How a line's time shows: HH:mm, HH:mm:ss, or none.",
});

/** The decoded form of {@link TimeShown}. */
export type TimeShown = typeof TimeShown.Type;

/**
 * Which Activity a Channel's Timeline shows: all of it, all but joins, parts, and quits
 * (`quiet`), or none. It changes what is drawn, never what is counted.
 */
export const ActivityShown = Schema.Literals(["all", "quiet", "none"]).annotate({
  default: "all",
  description:
    "Which Activity a Channel shows: all, quiet to hide joins, parts, and quits, or none. Unread counts are unchanged.",
});

/** The decoded form of {@link ActivityShown}. */
export type ActivityShown = typeof ActivityShown.Type;

/** The options under `ui`, each with its description and what it starts as. */
export const UiOptions = Schema.Struct({
  activity: ActivityShown,
  theme: ThemeName,
  time: TimeShown,
});

/** The decoded form of {@link UiOptions}. */
export type UiOptions = typeof UiOptions.Type;

/** An option's name under `ui`, such as `time`: one of {@link UiOptions}' fields. */
export const UiOptionName = Schema.Literals(Struct.keys(UiOptions.fields)).annotate({
  description: "An option under ui, such as time.",
  identifier: "UiOptionName",
});

/** The decoded form of {@link UiOptionName}. */
export type UiOptionName = typeof UiOptionName.Type;

/** Every option's name under `ui`, in the Schema's order. */
export const uiOptionNames: readonly UiOptionName[] = UiOptionName.literals;

/** What every option under `ui` starts as, from each field's `default` annotation. */
export const uiDefaults: UiOptions = Schema.decodeUnknownSync(UiOptions)(
  Object.fromEntries(
    uiOptionNames.map((name) => [name, SchemaAST.resolve(UiOptions.fields[name].ast)?.default])
  )
);

/**
 * How far the `ui` options have been changed: the sequence of the last Change, or `0`
 * before any, to send back as `ifSequence` with a change made from it.
 */
export const UiSequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** The `ui` options in force, every one with a value, and the sequence of the last Change. */
export const UiInForce = Schema.Struct({ options: UiOptions, sequence: UiSequence });

/** The decoded form of {@link UiInForce}. */
export type UiInForce = typeof UiInForce.Type;
