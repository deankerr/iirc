/**
 * The Owner's options under `store` and `uploads`, as a projection of the Journal's Changes,
 * as the `ui` options are (ADR 0015, ADR 0016): the latest Change of each option wins, an
 * unset one is back to its default, or to none, and a restart folds them again from the
 * Journal. A change is checked against the options it was made from and journaled in one
 * turn, so two Frontends changing at once cannot both pass.
 *
 * @packageDocumentation
 */
import {
  OwnerOptionName,
  OwnerOptions,
  credentialsNamed,
  ownerDefaults,
  ownerValueKept,
} from "@iirc/api";
import type { OwnerInForce, OwnerOptionValue } from "@iirc/api";
import type { CredentialName } from "@iirc/protocol/line";
import type { Spared } from "@iirc/runtime";
import { Journal } from "@iirc/runtime/journal";
import type { Change, JournalFailed, Sequence } from "@iirc/runtime/journal";
import { Context, Effect, Layer, Option, Schema, Semaphore, Stream, SubscriptionRef } from "effect";

/**
 * What the Changes folded so far hold: each option set, by its full name, and the sequence
 * of the last Change of one, `0` before any.
 */
export interface OptionsHeld {
  readonly set: ReadonlyMap<OwnerOptionName, OwnerOptionValue>;
  readonly sequence: number;
}

/** No Change yet: every option at its default, or none. */
export const nothingSet: OptionsHeld = { sequence: 0, set: new Map() };

const optionName = Schema.decodeUnknownOption(OwnerOptionName);

/**
 * An option's value as JSON, as a Change journals it.
 * @param option - The option.
 * @param value - Its value, decoded.
 * @returns The JSON.
 */
export const optionValueJson = (option: OwnerOptionName, value: OwnerOptionValue): Schema.Json =>
  Schema.encodeSync(Schema.toCodecJson(OwnerOptions.fields[option]))(value);

/**
 * Folds one Change of an option under `store` or `uploads`, and passes over any other. The
 * whole value of one option wins over what it held, and an unset returns it to its default,
 * or to none. A Change of an option this Daemon does not have, or of a value its Schema does
 * not take, changes no option, though its sequence is the last.
 * @param held - What was held.
 * @param change - The Change.
 * @param sequence - Its sequence.
 * @returns What is held after it.
 */
export const foldOption = (held: OptionsHeld, change: Change, sequence: number): OptionsHeld => {
  if (change._tag !== "OptionSet" && change._tag !== "OptionUnset") {
    return held;
  }

  const option = optionName(change.option);

  if (Option.isNone(option)) {
    return { ...held, sequence };
  }

  const set = new Map(held.set);

  if (change._tag === "OptionUnset") {
    set.delete(option.value);
  } else {
    const value = ownerValueKept(option.value, change.value);

    if (value !== undefined) {
      set.set(option.value, value);
    }
  }

  return { sequence, set };
};

/**
 * The options in force: each option set, every other with a default at it, and the rest
 * absent.
 * @param held - What is held.
 * @returns The options, and the sequence of the last Change of one.
 */
export const ownerInForceOf = (held: OptionsHeld): OwnerInForce => ({
  options: { ...ownerDefaults, ...Object.fromEntries(held.set) },
  sequence: held.sequence,
});

/** A change was made from other options than those in force, which `sequence` names. */
export class OptionsChangedSince extends Schema.TaggedError<
  OptionsChangedSince,
  { readonly brand: unique symbol }
>()("OptionsChangedSince", { sequence: Schema.Int }) {}

/** The options under `store` and `uploads`, as the Daemon holds them. */
export class OwnerConfiguration extends Context.Service<
  OwnerConfiguration,
  {
    /** The options in force, and the sequence of the last Change of one. */
    readonly inForce: Effect.Effect<OwnerInForce>;
    /**
     * Journals a Change and holds it, if `ifSequence`, when given, is still the sequence of
     * the last Change of one. The check and the append are one turn.
     */
    readonly change: (
      change: Change,
      ifSequence: number | undefined
    ) => Effect.Effect<Sequence, OptionsChangedSince | JournalFailed>;
    /** The options in force now, then again each time a Change is held. */
    readonly changes: Stream.Stream<OwnerInForce>;
    /** The Credentials the options in force name now, such as the bucket's keys. */
    readonly credentialsNamed: Effect.Effect<ReadonlySet<CredentialName>>;
    /**
     * Runs `decide` with the Credentials the options in force name, while no change of an
     * option is made, as the Runtime's `spared` takes it: a change waits for `decide` to
     * finish, and one made before it began is named in what it reads.
     */
    readonly spared: Spared;
  }
>()("@iirc/daemon/OwnerConfiguration") {}

/**
 * The options under `store` and `uploads` folded from every Change in the Journal as it
 * starts, and kept as each Change is journaled through it, which is the only way one is.
 */
export const layerOwnerConfiguration = Layer.effect(OwnerConfiguration)(
  Effect.gen(function* () {
    const journal = yield* Journal;

    const folded = yield* journal.read({}).pipe(
      Stream.runFold(
        () => nothingSet,
        (held, { record, sequence }) =>
          record._tag === "Change" ? foldOption(held, record.change, sequence) : held
      )
    );

    const held = yield* SubscriptionRef.make(folded);
    const turn = yield* Semaphore.make(1);
    const inForce = Effect.map(SubscriptionRef.get(held), ownerInForceOf);

    // The check, the append, and holding what was appended are one turn, and an append is
    // whole or absent, so what is held never differs from the Journal.
    const change = (one: Change, ifSequence: number | undefined) =>
      turn.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const before = yield* SubscriptionRef.get(held);

            if (ifSequence !== undefined && ifSequence !== before.sequence) {
              return yield* new OptionsChangedSince({ sequence: before.sequence });
            }

            const sequence = yield* journal.append({ _tag: "Change", change: one });

            yield* SubscriptionRef.set(held, foldOption(before, one, sequence));
            yield* Effect.logInfo("Changed an option", { option: one.option });

            return sequence;
          })
        )
      );

    // The change's own turn, so a removal deciding which Credentials to forget, and
    // forgetting them, and a change naming one, cannot interleave. Its permit is the last
    // the Runtime takes, and nothing in a turn takes another.
    const spared: Spared = (decide) =>
      turn.withPermit(
        inForce.pipe(Effect.flatMap(({ options }) => decide(credentialsNamed(options))))
      );

    return {
      change,
      changes: SubscriptionRef.changes(held).pipe(Stream.map(ownerInForceOf)),
      credentialsNamed: inForce.pipe(Effect.map(({ options }) => credentialsNamed(options))),
      inForce,
      spared,
    };
  })
);
