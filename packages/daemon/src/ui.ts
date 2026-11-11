/**
 * The options under `ui`, as a projection of the Journal's Changes (ADR 0015): the latest
 * Change of each option wins, an unset one is back to its default, and a restart folds them
 * again from the Journal. A change is checked against the options it was made from and
 * journaled in one turn, so two Frontends changing at once cannot both pass.
 *
 * @packageDocumentation
 */
import { UiOptionName, UiOptions, uiDefaults, uiValueKept } from "@iirc/api";
import type { UiInForce } from "@iirc/api";
import { Journal } from "@iirc/runtime/journal";
import type { Change, JournalFailed, Sequence } from "@iirc/runtime/journal";
import { Context, Effect, Layer, Option, Schema, Semaphore, Stream, SubscriptionRef } from "effect";

/** A `ui` option's value, decoded by its Schema. */
type UiValue = UiOptions[UiOptionName];

/**
 * What the Changes folded so far hold: each option set, by name, and the sequence of the
 * last Change, `0` before any.
 */
export interface Held {
  readonly set: ReadonlyMap<UiOptionName, UiValue>;
  readonly sequence: number;
}

/** No Change yet: every option at its default. */
export const nothingHeld: Held = { sequence: 0, set: new Map() };

const optionName = Schema.decodeUnknownOption(UiOptionName);

/**
 * A `ui` option's value parsed from JSON by its Schema, or none when it is not one.
 * @param option - The option.
 * @param value - Its value, as JSON.
 * @returns The value, decoded.
 */
export const parseUiValue = (option: UiOptionName, value: Schema.Json): Option.Option<UiValue> =>
  Schema.decodeOption(Schema.toCodecJson(UiOptions.fields[option]))(value);

/**
 * A `ui` option's value as JSON, as a Change journals it.
 * @param option - The option.
 * @param value - Its value, decoded.
 * @returns The JSON.
 */
export const uiValueJson = (option: UiOptionName, value: UiValue): Schema.Json =>
  Schema.encodeSync(Schema.toCodecJson(UiOptions.fields[option]))(value);

/**
 * Folds one Change. The whole value of one option wins over what it held, and an unset
 * returns it to its default. A Change of an option this Daemon does not have, or of a value
 * its Schema does not take, changes no option, though its sequence is the last, but for
 * `themes`, whose entries are read one by one, so a theme it cannot take is dropped alone.
 * @param held - What was held.
 * @param change - The Change.
 * @param sequence - Its sequence.
 * @returns What is held after it.
 */
export const foldChange = (held: Held, change: Change, sequence: number): Held => {
  const option = optionName(change.option);

  if (Option.isNone(option)) {
    return { ...held, sequence };
  }

  const set = new Map(held.set);

  if (change._tag === "UiUnset") {
    set.delete(option.value);
  } else {
    const value = uiValueKept(option.value, change.value);

    if (value !== undefined) {
      set.set(option.value, value);
    }
  }

  return { sequence, set };
};

/**
 * The options in force: each option set, and every other at its default.
 * @param held - What is held.
 * @returns The options, and the sequence of the last Change.
 */
export const inForceOf = (held: Held): UiInForce => ({
  options: { ...uiDefaults, ...Object.fromEntries(held.set) },
  sequence: held.sequence,
});

/** A change was made from other options than those in force, which `sequence` names. */
export class UiChangedSince extends Schema.TaggedError<
  UiChangedSince,
  { readonly brand: unique symbol }
>()("UiChangedSince", { sequence: Schema.Int }) {}

/** The options under `ui`, as the Daemon holds them. */
export class UiConfiguration extends Context.Service<
  UiConfiguration,
  {
    /** The options in force, and the sequence of the last Change. */
    readonly inForce: Effect.Effect<UiInForce>;
    /**
     * Journals a Change and holds it, if `ifSequence`, when given, is still the sequence of
     * the last Change. The check and the append are one turn.
     */
    readonly change: (
      change: Change,
      ifSequence: number | undefined
    ) => Effect.Effect<Sequence, UiChangedSince | JournalFailed>;
    /** The options in force now, then again each time a Change is held. */
    readonly changes: Stream.Stream<UiInForce>;
  }
>()("@iirc/daemon/UiConfiguration") {}

/**
 * The `ui` options folded from every Change in the Journal as it starts, and kept as each
 * Change is journaled through it, which is the only way one is.
 */
export const layerUiConfiguration = Layer.effect(UiConfiguration)(
  Effect.gen(function* () {
    const journal = yield* Journal;

    const folded = yield* journal.read({}).pipe(
      Stream.runFold(
        () => nothingHeld,
        (held, { record, sequence }) =>
          record._tag === "Change" ? foldChange(held, record.change, sequence) : held
      )
    );

    const held = yield* SubscriptionRef.make(folded);
    const turn = yield* Semaphore.make(1);

    // The check, the append, and holding what was appended are one turn, and an append is
    // whole or absent, so what is held never differs from the Journal.
    const change = (one: Change, ifSequence: number | undefined) =>
      turn.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const before = yield* SubscriptionRef.get(held);

            if (ifSequence !== undefined && ifSequence !== before.sequence) {
              return yield* new UiChangedSince({ sequence: before.sequence });
            }

            const sequence = yield* journal.append({ _tag: "Change", change: one });

            yield* SubscriptionRef.set(held, foldChange(before, one, sequence));
            yield* Effect.logInfo("Changed a ui option", { option: one.option });

            return sequence;
          })
        )
      );

    return {
      change,
      changes: SubscriptionRef.changes(held).pipe(Stream.map(inForceOf)),
      inForce: Effect.map(SubscriptionRef.get(held), inForceOf),
    };
  })
);
