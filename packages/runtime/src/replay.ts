/**
 * Folding the Journal through a Client. Restart and the News stream both derive what
 * they need this way, from the Inputs alone: journaled Outputs are never read back, so a
 * parser fix repairs history on replay (ADR 0002).
 *
 * @packageDocumentation
 */
import { timers } from "@iirc/client";
import type {
  Client,
  Input,
  Instant,
  IntentId,
  LookResult,
  NetworkConfiguration,
  News,
  Step,
  TimerTable,
} from "@iirc/client";
import { Effect, Schema, Stream } from "effect";

import type { JournalFailed, JournalService, NetworkId, Sequence } from "./journal.ts";

/** The Configuration in force for a Network: the last `Configured` stepped, and its sequence. */
export interface InForce {
  readonly configuration: NetworkConfiguration;
  readonly sequence: Sequence;
}

/** A Network the Owner removed, and whether its Timelines are kept. */
interface Removal {
  readonly keep: boolean;
}

/**
 * One Network's Client, as far as its Inputs have been folded, the Configuration in force,
 * and its removal, once a `Removed` was stepped. A Client that threw is `Broken`, and keeps
 * the state from before the input that broke it, so one Network's defect never stops
 * another's fold.
 */
export type Folded<S> =
  | {
      readonly _tag: "Folded";
      readonly state: S;
      readonly table: TimerTable;
      readonly configured: InForce | undefined;
      readonly life: Sequence | undefined;
      readonly removed: Removal | undefined;
      readonly unforgotten: readonly NetworkConfiguration[];
    }
  | {
      readonly _tag: "Broken";
      readonly state: S;
      readonly table: TimerTable;
      readonly configured: InForce | undefined;
      readonly life: Sequence | undefined;
      readonly removed: Removal | undefined;
      readonly unforgotten: readonly NetworkConfiguration[];
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
  /**
   * Which life of the Network it belongs to: the sequence of the `Configured` that began
   * it, the first after the Network was created or after a `Removed`. It only increases for
   * an id, and a rebuild gives the same. A removal's own steps belong to the life it ends.
   */
  readonly life: Sequence;
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
  configured: undefined,
  life: undefined,
  removed: undefined,
  state: client.initial,
  table: new Map(),
  unforgotten: [],
});

/**
 * The Configurations of removals whose Credentials are not yet known to be forgotten,
 * after one more removal: the first `Removed` of a life adds the Configuration in force,
 * and another, which only drops kept Timelines, adds nothing. They outlive the life, so a
 * Network given the id again does not lose them, and a `Forgotten` clears them.
 * @param folded - The Network before the `Removed`.
 * @returns What is left to forget after it.
 */
const unforgottenAfter = <S>(folded: Folded<S>): readonly NetworkConfiguration[] =>
  folded.removed === undefined && folded.configured !== undefined
    ? [...folded.unforgotten, folded.configured.configuration]
    : folded.unforgotten;

/**
 * A Network's life after one more Input: the sequence of the `Configured` that began it.
 * @param life - Its life so far, or `undefined` before its first `Configured`.
 * @param input - The Input.
 * @param sequence - The Input's sequence.
 * @returns Its life after it.
 */
export const lifeAfter = (
  life: Sequence | undefined,
  input: Input,
  sequence: Sequence
): Sequence | undefined => life ?? (input._tag === "Configured" ? sequence : undefined);

/**
 * Folds one more Input. A `Broken` Network stays broken. A `Configured` stepped is the
 * Configuration in force from its sequence on.
 *
 * A `Removed` ends the Network's life in the Journal. The Inputs that trail it, such as its
 * Connection's `Closed`, are stepped and give no News, and another `Removed` gives its own.
 * A `Configured` after it begins a new Network under the same id, from `initial`, so
 * nothing of the removed one reaches it. A `Removed` ends even a `Broken` Network, or one
 * whose Client throws on it, with the News the Client gives of a removal, so a Network
 * whose Client has a bug can still be removed.
 * @param client - The Client.
 * @param folded - The Network so far.
 * @param input - The next Input.
 * @param sequence - The Input's sequence.
 * @returns The Network after it, and the News of the step.
 */
const foldOne = <S>(
  client: Client<S>,
  folded: Folded<S>,
  input: Input,
  sequence: Sequence
): Effect.Effect<readonly [Folded<S>, readonly News[]]> => {
  const begun: Folded<S> =
    folded.removed !== undefined && input._tag === "Configured"
      ? { ...fresh(client), unforgotten: folded.unforgotten }
      : folded;

  // Removed whatever its Client could step: the Client reports a removal so, and nothing
  // of a removed Network is stepped again but another removal.
  const endedBroken = (broken: Extract<Folded<S>, { readonly _tag: "Broken" }>, keep: boolean) =>
    [
      { ...broken, removed: { keep }, unforgotten: unforgottenAfter(broken) },
      [{ _tag: "NetworkRemoved", keep } as const],
    ] as const;

  // A life begins with its `Configured` whether or not the Client could step it.
  if (begun._tag === "Broken") {
    const living = { ...begun, life: lifeAfter(begun.life, input, sequence) };

    return Effect.succeed(
      input._tag === "Removed" ? endedBroken(living, input.keep) : ([living, []] as const)
    );
  }

  const told = begun.removed === undefined || input._tag === "Removed";

  return stepContained(client, begun.state, input).pipe(
    Effect.map(
      (step) =>
        [
          {
            _tag: "Folded",
            configured:
              input._tag === "Configured"
                ? { configuration: input.configuration, sequence }
                : begun.configured,
            life: lifeAfter(begun.life, input, sequence),
            removed: input._tag === "Removed" ? { keep: input.keep } : begun.removed,
            state: step.state,
            table: timers(begun.table, input, step.outputs),
            unforgotten: input._tag === "Removed" ? unforgottenAfter(begun) : begun.unforgotten,
          },
          told ? step.news : [],
        ] as const
    ),
    Effect.catch((error) => {
      const broken = {
        ...begun,
        _tag: "Broken",
        life: lifeAfter(begun.life, input, sequence),
        reason: error.reason,
      } as const;

      return Effect.succeed(
        input._tag === "Removed" ? endedBroken(broken, input.keep) : ([broken, []] as const)
      );
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
        const { record } = entry;

        // The Credentials of every removal before it were forgotten.
        if (record._tag === "Forgotten") {
          const folded = networks.get(record.network);

          return Effect.succeed(
            folded === undefined
              ? networks
              : networks.set(record.network, { ...folded, unforgotten: [] })
          );
        }

        if (record._tag !== "Input") {
          return Effect.succeed(networks);
        }

        const { input, network } = record;

        return foldOne(client, networks.get(network) ?? fresh(client), input, entry.sequence).pipe(
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

        return foldOne(client, networks.get(network) ?? fresh(client), input, entry.sequence).pipe(
          Effect.map(([folded, news]) => {
            networks.set(network, folded);

            const wanted = news.length > 0 && entry.sequence > (after ?? 0);

            // A step before any `Configured`, which the Runtime never journals, is its own.
            const happened: Happened = {
              at: input.at,
              life: folded.life ?? entry.sequence,
              network,
              news,
              sequence: entry.sequence,
            };

            return [networks, wanted ? [happened] : []] as const;
          })
        );
      }
    )
  );

/** What the Journal says of a Lookup: the sequence of its `Look`, and its result once a step reported it. */
export interface LookFound {
  readonly sequence: Sequence;
  readonly result: LookResult | undefined;
}

/** How far a search for a Lookup has folded: the Network so far, and its `Look` once found. */
interface LookFold<S> {
  readonly folded: Folded<S>;
  readonly found: LookFound | undefined;
}

/**
 * A Lookup of one Network, found by its intent: the Network's Inputs are folded from
 * `initial`, to the Journal's end as it stood, until a step reports `LookedUp` for it.
 * @param client - The Client.
 * @param journal - The Journal.
 * @param network - The Network.
 * @param intent - The Lookup's intent.
 * @returns Its `Look` and result, or `undefined` when no `Look` under the intent was journaled.
 */
export const lookedUp = <S>(
  client: Client<S>,
  journal: JournalService,
  network: NetworkId,
  intent: IntentId
): Effect.Effect<LookFound | undefined, JournalFailed> =>
  journal.read({ network }).pipe(
    Stream.runFoldEffect(
      (): LookFold<S> => ({ folded: fresh(client), found: undefined }),
      (fold, entry) => {
        if (entry.record._tag !== "Input" || fold.found?.result !== undefined) {
          return Effect.succeed(fold);
        }

        const { input } = entry.record;

        const look =
          fold.found ??
          (input._tag === "Look" && input.intent === intent
            ? { result: undefined, sequence: entry.sequence }
            : undefined);

        return foldOne(client, fold.folded, input, entry.sequence).pipe(
          Effect.map(([folded, news]) => {
            const reported = news.find((one) => one._tag === "LookedUp" && one.intent === intent);

            return {
              folded,
              found:
                look === undefined || reported?._tag !== "LookedUp"
                  ? look
                  : { result: reported.result, sequence: look.sequence },
            };
          })
        );
      }
    ),
    Effect.map(({ found }) => found)
  );
