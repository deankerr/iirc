/**
 * Folding the Journal through a Client. Restart and the News stream both derive what
 * they need this way, from the Inputs alone: journaled Outputs are never read back, so a
 * parser fix repairs history on replay (ADR 0002).
 *
 * @packageDocumentation
 */
import { timers } from "@iirc/client";
import type { Client, Input, Instant, News, Step, TimerTable } from "@iirc/client";
import { Effect, Schema, Stream } from "effect";

import type { JournalFailed, JournalService, NetworkId, Sequence } from "./journal.ts";

/**
 * One Network's Client, as far as its Inputs have been folded. A Client that threw is
 * `Broken`, and keeps the state from before the input that broke it, so one Network's
 * defect never stops another's fold.
 */
export type Folded<S> =
  | { readonly _tag: "Folded"; readonly state: S; readonly table: TimerTable }
  | {
      readonly _tag: "Broken";
      readonly state: S;
      readonly table: TimerTable;
      readonly reason: string;
    };

/** What one Input to one Network made happen, as the News stream gives it. */
export interface Happened {
  readonly network: NetworkId;
  /** The sequence of the Input that made it. */
  readonly sequence: Sequence;
  /** The Input's `at`. */
  readonly at: Instant;
  /** The News of that step, in order, and never empty. */
  readonly news: readonly News[];
}

/** A Client threw, which a total Client never does: a bug, contained to its Network. */
export class ClientThrew extends Schema.TaggedError<
  ClientThrew,
  { readonly brand: unique symbol }
>()("ClientThrew", { reason: Schema.String }) {}

/**
 * Steps a Client, with a throw turned into a reason. The Client is total, so a throw is a
 * bug, and it is contained to its Network.
 * @param client - The Client.
 * @param state - Its state.
 * @param input - The input.
 * @returns The step, or why it threw.
 */
export const stepContained = <S>(
  client: Client<S>,
  state: S,
  input: Input
): Effect.Effect<Step<S>, ClientThrew> =>
  Effect.sync(() => client.step(state, input)).pipe(
    Effect.catchDefect((defect) =>
      Effect.fail(
        new ClientThrew({
          reason: defect instanceof Error ? `${defect.name}: ${defect.message}` : String(defect),
        })
      )
    )
  );

/**
 * A Network before anything has happened to it.
 * @param client - The Client.
 * @returns Its `initial` state, with no timers.
 */
export const fresh = <S>(client: Client<S>): Folded<S> => ({
  _tag: "Folded",
  state: client.initial,
  table: new Map(),
});

/**
 * Folds one more Input. A `Broken` Network stays broken.
 * @param client - The Client.
 * @param folded - The Network so far.
 * @param input - The next Input.
 * @returns The Network after it, and the News of the step.
 */
const foldOne = <S>(
  client: Client<S>,
  folded: Folded<S>,
  input: Input
): Effect.Effect<readonly [Folded<S>, readonly News[]]> => {
  if (folded._tag === "Broken") {
    return Effect.succeed([folded, []] as const);
  }

  return stepContained(client, folded.state, input).pipe(
    Effect.map(
      (step) =>
        [
          {
            _tag: "Folded",
            state: step.state,
            table: timers(folded.table, input, step.outputs),
          },
          step.news,
        ] as const
    ),
    Effect.catch((error) => {
      const broken: Folded<S> = { ...folded, _tag: "Broken", reason: error.reason };

      return Effect.succeed([broken, []] as const);
    })
  );
};

/**
 * Every Network in the Journal, each folded from `initial` over its Inputs, as they
 * stood when reading began.
 * @param client - The Client.
 * @param journal - The Journal.
 * @returns Each Network by id, in the order its first Entry was appended.
 */
export const refold = <S>(
  client: Client<S>,
  journal: JournalService
): Effect.Effect<ReadonlyMap<NetworkId, Folded<S>>, JournalFailed> =>
  journal.read({}).pipe(
    Stream.runFoldEffect(
      () => new Map<NetworkId, Folded<S>>(),
      (networks, entry) => {
        if (entry.record._tag !== "Input") {
          return Effect.succeed(networks);
        }

        const { input, network } = entry.record;

        return foldOne(client, networks.get(network) ?? fresh(client), input).pipe(
          Effect.map(([folded]) => networks.set(network, folded))
        );
      }
    )
  );

/**
 * The News of every Network, derived from the Journal: each Network's Inputs are folded
 * from `initial`, and what each step after `after` made happen is given, in Journal
 * order, and then live as Inputs are appended.
 * @param client - The Client.
 * @param journal - The Journal.
 * @param after - The last sequence the reader has, if any.
 * @returns A stream that never ends.
 */
export const newsAfter = <S>(
  client: Client<S>,
  journal: JournalService,
  after: Sequence | undefined
): Stream.Stream<Happened, JournalFailed> =>
  journal.follow({}).pipe(
    Stream.mapAccumEffect(
      () => new Map<NetworkId, Folded<S>>(),
      (networks, entry) => {
        if (entry.record._tag !== "Input") {
          return Effect.succeed([networks, []] as const);
        }

        const { input, network } = entry.record;

        return foldOne(client, networks.get(network) ?? fresh(client), input).pipe(
          Effect.map(([folded, news]) => {
            networks.set(network, folded);

            const wanted = news.length > 0 && entry.sequence > (after ?? 0);
            const happened: Happened = { at: input.at, network, news, sequence: entry.sequence };

            return [networks, wanted ? [happened] : []] as const;
          })
        );
      }
    )
  );
