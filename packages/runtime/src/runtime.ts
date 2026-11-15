/**
 * The Runtime: one Client per Network, driven through the ports. Owner inputs come in,
 * News goes out derived from the Journal, and what each Client knows can be read.
 *
 * @packageDocumentation
 */
import { credentialsOf, IntentId } from "@iirc/client";
import type {
  Action,
  Client,
  Inspection,
  Instant,
  Lookup,
  LookResult,
  NetworkConfiguration,
  News,
  RefusedReason,
  SayKind,
  TimerTable,
} from "@iirc/client";
import type { ChannelView, Knowledge } from "@iirc/client/known";
import { defaultCapacity, defaultPacing } from "@iirc/outbox";
import type { Pacing } from "@iirc/outbox";
import { FallbackEncoding, missingDecoders } from "@iirc/protocol/line";
import type { CredentialName } from "@iirc/protocol/line";
import {
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Random,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";

import { now } from "./clock.ts";
import { Journal, NetworkId, Sequence } from "./journal.ts";
import type { JournalFailed } from "./journal.ts";
import {
  awaitLookup,
  changedSince,
  halt,
  heldConnections,
  NetworkStopped,
  retire,
  runtimeClosed,
  startNetwork,
  stopGracefully,
  tell,
  tellConfiguration,
  tellRemoved,
} from "./network.ts";
import type {
  ConfiguredAt,
  HeldConnection,
  Network,
  NetworkStatus,
  Ports,
  ConfigurationChanged,
} from "./network.ts";
import { fresh, lookedUp, newsAfter, refold } from "./replay.ts";
import type { Happened, InForce } from "./replay.ts";
import { Transport } from "./transport.ts";
import { Vault } from "./vault.ts";
import type { VaultFailed } from "./vault.ts";

export { ConfigurationChanged, NetworkStopped } from "./network.ts";

export type { ConfiguredAt, HeldConnection, NetworkStatus } from "./network.ts";

export type { Happened, InForce } from "./replay.ts";

/** No Network by this id has been configured, or it was removed. */
export class UnknownNetwork extends Schema.TaggedError<
  UnknownNetwork,
  { readonly brand: unique symbol }
>()("UnknownNetwork", { network: NetworkId }) {}

/**
 * A removal named the life of the Network it was made from, and the Network holds another:
 * `life`, live or kept, or `null` while one added has no life yet. It was removed, or added
 * again, since. Nothing was journaled.
 */
export class LifeChanged extends Schema.TaggedError<
  LifeChanged,
  { readonly brand: unique symbol }
>()("LifeChanged", { life: Schema.NullOr(Sequence), network: NetworkId }) {}

/**
 * A Network removed under this id keeps its Timelines, so no Network can take the id until
 * it is removed again without them. Nothing was journaled.
 */
export class TimelinesKept extends Schema.TaggedError<
  TimelinesKept,
  { readonly brand: unique symbol }
>()("TimelinesKept", { network: NetworkId }) {}

/**
 * This runtime cannot decode some fallback encodings, so it would read a Journal's bytes
 * as other text than they were. The Runtime refuses to start.
 */
export class DecodersMissing extends Schema.TaggedError<
  DecodersMissing,
  { readonly brand: unique symbol }
>()("DecodersMissing", { missing: Schema.Array(FallbackEncoding) }) {}

/** What the Owner can say to a Target. */
export interface Saying {
  readonly kind: SayKind;
  readonly target: string;
  readonly text: string;
  /**
   * The intent id to say it under. Left out, the Runtime names one. A caller that names
   * its own knows it before the `Say` is stepped, so after a `NetworkStopped` it can ask
   * `said` rather than say it again. It must be unique for the Network across its whole
   * Journal, calls in flight included: the Runtime correlates by it, and never
   * deduplicates.
   */
  readonly intent?: IntentId | undefined;
}

/** What the Owner does on a Network besides saying something. */
export interface Acting {
  readonly action: Action;
  /**
   * The intent id to act under. Left out, the Runtime names one. It is the caller's to
   * keep unique for the Network across its whole Journal, as a `say`'s is, and `said`
   * finds it the same way.
   */
  readonly intent?: IntentId | undefined;
}

/**
 * What an `act` answers: the `Act` stepped and its Lines sent, or refused by the Client
 * in that same step. Either way it was journaled at `sequence`. What comes later, the
 * Ircd's error tied to it as `Rejected`, or `Unsent`, comes as News.
 */
export type ActOutcome =
  | { readonly _tag: "Acted"; readonly intent: IntentId; readonly sequence: Sequence }
  | {
      readonly _tag: "Refused";
      readonly intent: IntentId;
      readonly sequence: Sequence;
      readonly reason: StepRefusal;
    };

/** What the Owner looks up on a Network. */
export interface Looking {
  readonly lookup: Lookup;
  /**
   * The intent id to look up under. Left out, the Runtime names one. It is the caller's to
   * keep unique for the Network across its whole Journal, as a `say`'s is, and `looked`
   * finds it.
   */
  readonly intent?: IntentId | undefined;
}

/**
 * What a `look` answers: the `Look` was journaled at `sequence`, and its result came, as
 * `LookedUp`, with whatever the Client found or why it refused, or did not come within
 * the bound, or before the Network stopped, as `Pending`, which `looked` can ask after.
 */
export type LookOutcome =
  | {
      readonly _tag: "LookedUp";
      readonly intent: IntentId;
      readonly sequence: Sequence;
      readonly result: LookResult;
    }
  | { readonly _tag: "Pending"; readonly intent: IntentId; readonly sequence: Sequence };

/** How far the Owner has read a Timeline. */
export interface Reading {
  /** The Channel or Direct Message partner, named as a `Say`'s Target is, or `null` for the Network's own. */
  readonly target: string | null;
  /** The instant read up to. */
  readonly read: Instant;
}

/** Why the Client refused a `Say` or an `Act` in the step that took it: no Session, or no Line can carry it. */
export type StepRefusal = Extract<RefusedReason, { readonly _tag: "Offline" | "Unsendable" }>;

/**
 * What a `say` answers: the `Say` stepped and its Message reported, or refused by the
 * Client in that same step. Either way it was journaled at `sequence`. A refusal that
 * comes later, `Rejected` or `Unsent`, comes as News.
 */
export type SayOutcome =
  | { readonly _tag: "Said"; readonly intent: IntentId; readonly sequence: Sequence }
  | {
      readonly _tag: "Refused";
      readonly intent: IntentId;
      readonly sequence: Sequence;
      readonly reason: StepRefusal;
    };

/**
 * The refusal of a `Say` in its own step's News, if any.
 * @param news - The step's News.
 * @param intent - The `Say`'s intent.
 * @returns Its refusal, or none.
 */
const refusalIn = (news: readonly News[], intent: IntentId): StepRefusal | undefined => {
  for (const one of news) {
    if (
      one._tag === "Refused" &&
      one.intent === intent &&
      (one.reason._tag === "Offline" || one.reason._tag === "Unsendable")
    ) {
      return one.reason;
    }
  }

  return undefined;
};

/** A Network as the Runtime holds it, for agents and debugging. */
export interface NetworkInspection {
  readonly status: NetworkStatus;
  /** The Client's own inspection. */
  readonly client: Inspection;
  /** The Connections the Runtime holds a Link for, each with how many Lines wait to leave, and when the next may. */
  readonly connections: readonly HeldConnection[];
  /** The timers the Runtime has set, projected with `timers` from every step. */
  readonly timers: TimerTable;
}

/** How the Runtime paces Lines, and how long endings may take. Each has a default. */
export interface RuntimeOptions {
  /** How fast Lines may leave each Connection. By default a burst of 5, then one every 2 s. */
  readonly pacing?: Pacing | undefined;
  /** How many Lines may wait for one Connection. By default 1,000. */
  readonly outboxCapacity?: number | undefined;
  /** How long a `Hangup` lets queued Lines leave at pace before it hangs up anyway. By default 5 s. */
  readonly hangupDrain?: Duration.Input | undefined;
  /** How long shutdown waits for each Network's Connections to close. By default 5 s. */
  readonly stopTimeout?: Duration.Input | undefined;
  /**
   * How long a `look` waits for its result once the `Look` is stepped, before it answers
   * `Pending`. By default 35 s, past the Client's own 30 s for a reply to end, so a reply
   * that never ends still answers with what came.
   */
  readonly lookTimeout?: Duration.Input | undefined;
}

/** How long a `Hangup` drains by default. */
export const defaultHangupDrain: Duration.Duration = Duration.seconds(5);

/** How long shutdown waits for Connections to close by default. */
export const defaultStopTimeout: Duration.Duration = Duration.seconds(5);

/** How long a `look` waits for its result by default. */
export const defaultLookTimeout: Duration.Duration = Duration.seconds(35);

const millisOf = (input: Duration.Input | undefined, fallback: Duration.Duration): number =>
  Duration.toMillis(input === undefined ? fallback : Duration.fromInputUnsafe(input));

/**
 * A life of a Network: the sequence of the `Configured` that began it, the first after the
 * Network was created or after a `Removed`. It only increases for an id, and a rebuild
 * gives the same.
 */
export type Life = Sequence;

/** A removal: the sequence of its `Removed`, and the life it ended. */
export interface Removal {
  readonly sequence: Sequence;
  readonly life: Life;
}

/** What a Network's Client knows now, and the life it belongs to. */
export interface Known {
  readonly knowledge: Knowledge;
  readonly life: Life;
}

/**
 * A Network the Runtime holds, with its life: `Live`, configured, and whether it is
 * running, or `Kept`, removed with its Timelines kept.
 */
export type Living =
  | { readonly _tag: "Live"; readonly status: NetworkStatus; readonly life: Life }
  | { readonly _tag: "Kept"; readonly life: Life };

/** What the Runtime offers. */
export interface RuntimeService {
  /**
   * Journals a `Configured`, and waits until it is stepped. The first one for an id adds
   * the Network. With `ifSequence`, the sequence of the `Configured` it was made from, or
   * `0` for none, it is journaled only if that is still the one in force when its turn
   * comes, and is otherwise `ConfigurationChanged`, with nothing journaled and no Network
   * added. An id whose removed Network keeps its Timelines is `TimelinesKept`.
   */
  readonly configure: (
    network: NetworkId,
    configuration: NetworkConfiguration,
    ifSequence?: ConfiguredAt
  ) => Effect.Effect<Sequence, NetworkStopped | ConfigurationChanged | TimelinesKept>;
  /**
   * Journals a `Removed`, and waits until it is stepped, which ends a Session with a
   * `QUIT`, then for the Network's Connections to close, within `stopTimeout`, and stops
   * it. The Network is then unknown, and the Credentials its Configuration names are
   * forgotten, but those another Network's names. A Network removed with its Timelines
   * kept can be removed again, which journals another `Removed`, to drop them, and fails
   * with `JournalFailed` when it cannot be.
   */
  readonly remove: (
    network: NetworkId,
    removal: { readonly keep: boolean; readonly life?: Life | undefined }
  ) => Effect.Effect<
    Removal,
    UnknownNetwork | LifeChanged | NetworkStopped | JournalFailed | VaultFailed
  >;
  /**
   * Every removed Network whose Timelines are kept, which no Network can take the id of,
   * with the life that was removed.
   */
  readonly kept: Effect.Effect<ReadonlyMap<NetworkId, Sequence>>;
  /** The Configuration in force, and the sequence of the `Configured` that set it. */
  readonly configuration: (network: NetworkId) => Effect.Effect<InForce, UnknownNetwork>;
  /**
   * Journals a `Say`, under the caller's intent id or one the Runtime names, and waits
   * until it is stepped. It answers with what that step already knew: `Said`, or `Refused`
   * when the Client refused it in the same step, as `Offline` or `Unsendable`.
   */
  readonly say: (
    network: NetworkId,
    saying: Saying
  ) => Effect.Effect<SayOutcome, UnknownNetwork | NetworkStopped>;
  /**
   * Journals an `Act`, under the caller's intent id or one the Runtime names, and waits
   * until it is stepped. It answers with what that step already knew: `Acted`, or
   * `Refused` when the Client refused it in the same step, as `Offline` or `Unsendable`.
   */
  readonly act: (
    network: NetworkId,
    acting: Acting
  ) => Effect.Effect<ActOutcome, UnknownNetwork | NetworkStopped>;
  /**
   * Whether a `Say` or an `Act` under this intent was journaled for the Network, by its
   * sequence. It reads the Network's Inputs once, to the Journal's end as it stood, and
   * ends. One journaled is stepped on restart, but its Lines may not have been sent.
   */
  readonly said: (
    network: NetworkId,
    intent: IntentId
  ) => Effect.Effect<Option.Option<Sequence>, JournalFailed>;
  /**
   * Journals a `Look`, under the caller's intent id or one the Runtime names, waits until
   * it is stepped, and then for its result, for at most `lookTimeout`. It answers with the
   * result the Network's own fiber reported for the intent, `LookedUp`, which may say the
   * Client refused it, or `Pending` when none came within the bound or the Network
   * stopped first.
   */
  readonly look: (
    network: NetworkId,
    looking: Looking
  ) => Effect.Effect<LookOutcome, UnknownNetwork | NetworkStopped>;
  /**
   * A Lookup by its intent, from the Journal: `LookedUp` once a step reported its result,
   * `Pending` while none has, or `None` when no `Look` under the intent was journaled. It
   * folds the Network's Inputs from `initial` once, to the Journal's end as it stood, and
   * ends, so it answers the same on this Runtime or one started after it.
   */
  readonly looked: (
    network: NetworkId,
    intent: IntentId
  ) => Effect.Effect<Option.Option<LookOutcome>, JournalFailed>;
  /**
   * Journals a `Read`: the Owner has read a Timeline up to the instant `read`, of a
   * Target, or with `target` null, the Network's own. It waits until it is stepped. The
   * Client moves the Read Marker only forward, and reports it as News when it moves.
   */
  readonly read: (
    network: NetworkId,
    reading: Reading
  ) => Effect.Effect<Sequence, UnknownNetwork | NetworkStopped>;
  /**
   * Journals a `CloseTimeline`: the Owner closed the Timeline of a Target, a Channel or a
   * Direct Message partner named as a `Say`'s Target is. It waits until it is stepped. The
   * Client reports it as News unless Self is in that Channel, and keeps nothing of it.
   */
  readonly close: (
    network: NetworkId,
    target: string
  ) => Effect.Effect<Sequence, UnknownNetwork | NetworkStopped>;
  /** Journals a `Retry`, and waits until it is stepped. */
  readonly retry: (network: NetworkId) => Effect.Effect<Sequence, UnknownNetwork | NetworkStopped>;
  /** What the Network's Client knows now. */
  readonly known: (network: NetworkId) => Effect.Effect<Known, UnknownNetwork>;
  /**
   * What the Network's Client knows now of one Channel, by its name as the Connection's
   * casemapping folds it, or `None` when it holds no such Channel. It reads that Channel
   * alone, so it costs what the Channel holds, not what the Network does.
   */
  readonly channel: (
    network: NetworkId,
    name: string
  ) => Effect.Effect<Option.Option<ChannelView>, UnknownNetwork>;
  /** The Network's Client and the Runtime's hold on it. */
  readonly inspect: (network: NetworkId) => Effect.Effect<NetworkInspection, UnknownNetwork>;
  /** Every Network, in the order it was added, with whether it is running. */
  readonly networks: Effect.Effect<ReadonlyMap<NetworkId, NetworkStatus>>;
  /**
   * Every Network held, live in the order it was added and then each kept, with its life,
   * read together: a Network removed with its Timelines kept is always one or the other,
   * never neither, however a removal falls between the reads.
   */
  readonly lives: Effect.Effect<ReadonlyMap<NetworkId, Living>>;
  /**
   * The News of every Network, derived from the Journal: from just after `after`, or from
   * the start, then live. Each element is one step's News, with its Network and the
   * sequence of its Input, so a reader that resumes after the last sequence it has
   * misses nothing. It never ends.
   */
  readonly news: (from?: {
    readonly after?: Sequence | undefined;
  }) => Stream.Stream<Happened, JournalFailed>;
}

/** The Runtime. */
export class Runtime extends Context.Service<Runtime, RuntimeService>()("@iirc/runtime/Runtime") {}

// A map without one key.
const without = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => {
  const next = new Map(map);

  next.delete(key);

  return next;
};

// 128 bits from Effect's Random, as hex. An intent id is unique, not secret.
const intentId = Effect.map(
  Effect.all(Array.from({ length: 8 }, () => Random.nextIntBetween(0, 0xff_ff))),
  (parts) => IntentId.make(parts.map((part) => part.toString(16).padStart(4, "0")).join(""))
);

/**
 * Makes the Runtime: checks the decoders, refolds every Network in the Journal, sets
 * its timers, steps a `Started`, and drives it. Closing the Scope hangs up every
 * Connection and stops every timer.
 * @param client - The Client to drive, one per Network.
 * @param options - Pacing, and how long endings may take.
 * @param missing - The fallback encodings this runtime cannot decode. A seam for tests.
 * @returns The Runtime's service.
 */
export const makeRuntime = <S>(
  client: Client<S>,
  options: RuntimeOptions = {},
  missing: () => readonly FallbackEncoding[] = missingDecoders
) =>
  Effect.gen(function* () {
    const absent = missing();

    if (absent.length > 0) {
      return yield* new DecodersMissing({ missing: absent });
    }

    const ports: Ports<S> = {
      client,
      journal: yield* Journal,
      timing: {
        capacity: options.outboxCapacity ?? defaultCapacity,
        hangupDrain: millisOf(options.hangupDrain, defaultHangupDrain),
        pacing: options.pacing ?? defaultPacing,
        stopTimeout: millisOf(options.stopTimeout, defaultStopTimeout),
      },
      transport: yield* Transport,
      vault: yield* Vault,
    };

    const lookTimeout = millisOf(options.lookTimeout, defaultLookTimeout);
    const held = yield* Ref.make<ReadonlyMap<NetworkId, Network<S>>>(new Map());
    // Admission and shutdown take the same permit, so a Network is either added before
    // shutdown is done, and stopped by it, or refused.
    const adding = yield* Semaphore.make(1);
    const closed = yield* Ref.make(false);
    // Every driver lives here. Shutdown closes it under the permit, whatever order the
    // Layer's other finalizers run in.
    const drivers = yield* Scope.make();

    // Every running Network stops at once: it steps a `Stopping` and waits, within the
    // bound, for its Connections to close, and then its driver stops, which closes any
    // Connection left without waiting on it. So the whole stop takes the bound, and no
    // more than the time to close Scopes after it.
    //
    // The waiting is bounded by interrupting it, which a finalizer cannot do, so it runs
    // in a fiber of its own. Making this fiber interruptible instead would end the waiting
    // at once whenever the fiber closing the Runtime had itself been interrupted, which is
    // how a signal stops a process: no `Stopping` would be stepped, and no `QUIT` said.
    const stopEach = (networks: Iterable<Network<S>>) =>
      Effect.flatMap(
        Effect.forkDetach(
          Effect.forEach(
            networks,
            (network) =>
              Effect.andThen(stopGracefully(network, ports.timing.stopTimeout), halt(network)),
            { concurrency: "unbounded", discard: true }
          )
        ),
        Fiber.await
      );

    // Shutdown refuses what comes after it, and stops the Networks held before it waits on
    // what was admitted already, such as a removal waiting on a `Configured` whose driver
    // only stopping ends. Under the permit, it then stops any Network an admission in
    // flight added, and closes every driver.
    const stopAll = Effect.gen(function* () {
      yield* Ref.set(closed, true);
      yield* stopEach((yield* Ref.get(held)).values());
      yield* adding.withPermit(
        Effect.gen(function* () {
          yield* stopEach((yield* Ref.get(held)).values());
          yield* Scope.close(drivers, Exit.void);
        })
      );
    });

    yield* Effect.addFinalizer(() => stopAll);

    // Every removed Network whose Timelines are kept, which holds its id.
    const kept = yield* Ref.make<ReadonlyMap<NetworkId, Life>>(new Map());

    // The Configurations of removals whose Credentials are not yet known to be forgotten,
    // by Network, folded from the Journal, so a removal cut short by a crash or a Vault that
    // failed is finished on the next start.
    const unforgotten = yield* Ref.make<ReadonlyMap<NetworkId, readonly NetworkConfiguration[]>>(
      new Map()
    );

    const folded = yield* refold(client, ports.journal);

    for (const [id, network] of folded) {
      if (network.unforgotten.length > 0) {
        yield* Ref.update(unforgotten, (all) => new Map(all).set(id, network.unforgotten));
      }

      if (network.removed !== undefined) {
        if (network.removed.keep) {
          const { life } = network;

          if (life !== undefined) {
            yield* Ref.update(kept, (all) => new Map(all).set(id, life));
          }
        }

        continue;
      }

      const started = yield* startNetwork(ports, id, network, true).pipe(Scope.provide(drivers));

      yield* Ref.update(held, (networks) => new Map(networks).set(id, started));
    }

    const find = (id: NetworkId) =>
      Effect.flatMap(Ref.get(held), (networks) => {
        const network = networks.get(id);

        return network === undefined
          ? Effect.fail(new UnknownNetwork({ network: id }))
          : Effect.succeed(network);
      });

    // A Network that does not exist is added only by a `configure` made from none, so a
    // refused precondition adds nothing. The caller holds the permit.
    const findOrAdd = (id: NetworkId, ifSequence: ConfiguredAt | undefined) =>
      Effect.flatMap(
        Effect.all([Ref.get(held), Ref.get(closed), Ref.get(kept)]),
        ([networks, over, keeping]): Effect.Effect<
          Network<S>,
          NetworkStopped | ConfigurationChanged | TimelinesKept
        > => {
          const network = networks.get(id);

          if (network !== undefined) {
            return Effect.succeed(network);
          }

          if (over) {
            return Effect.fail(new NetworkStopped({ network: id, reason: runtimeClosed }));
          }

          if (keeping.has(id)) {
            return Effect.fail(new TimelinesKept({ network: id }));
          }

          const changed = changedSince(id, undefined, ifSequence);

          if (changed !== undefined) {
            return Effect.fail(changed);
          }

          return startNetwork(ports, id, fresh(client), false).pipe(
            Scope.provide(drivers),
            Effect.tap((added) => Ref.update(held, (all) => new Map(all).set(id, added))),
            Effect.tap(() => Effect.logInfo("Added a Network", { network: id }))
          );
        }
      );

    // Held by a `configure` until its `Configured` is stepped, and by forgetting a removed
    // Network's Credentials, so no Configuration changes while that checks which a Network
    // still names. Taken after `adding`, never before it.
    const configuring = yield* Semaphore.make(1);

    // Forgets the Credentials the Network's removals named, but those a Network still held
    // names, and journals that it did.
    const forgetCredentials = (id: NetworkId) =>
      configuring.withPermit(
        Effect.gen(function* () {
          const configurations = (yield* Ref.get(unforgotten)).get(id);

          if (configurations === undefined) {
            return;
          }

          const still = new Set<CredentialName>();

          for (const network of (yield* Ref.get(held)).values()) {
            const { configured } = yield* Ref.get(network.current);

            for (const name of configured === undefined
              ? []
              : credentialsOf(configured.configuration)) {
              still.add(name);
            }
          }

          const named = new Set(configurations.flatMap((each) => [...credentialsOf(each)]));
          const forgotten = [...named].filter((each) => !still.has(each)).toSorted();

          for (const name of forgotten) {
            yield* ports.vault.forget(name);
            yield* Effect.logInfo("Forgot a Credential", { credential: name, network: id });
          }

          yield* ports.journal.append({ _tag: "Forgotten", credentials: forgotten, network: id });
          yield* Ref.update(unforgotten, (all) => without(all, id));
        })
      );

    // The sequence of the `Removed` that ended the Network's last life in the Journal, if
    // one did: a `Removed` after its last `Configured`.
    const removedAt = (id: NetworkId) =>
      ports.journal.read({ network: id }).pipe(
        Stream.runFold(
          () => ({ configured: 0, removed: 0 }),
          (last, { record, sequence }) => {
            if (record._tag !== "Input") {
              return last;
            }

            if (record.input._tag === "Configured") {
              return { ...last, configured: sequence };
            }

            return record.input._tag === "Removed" ? { ...last, removed: sequence } : last;
          }
        ),
        Effect.map(({ configured, removed }) =>
          removed > configured ? Sequence.make(removed) : undefined
        )
      );

    const appendRemoved = (id: NetworkId, keep: boolean) =>
      Effect.gen(function* () {
        const at = yield* now;

        return yield* ports.journal.append({
          _tag: "Input",
          input: { _tag: "Removed", at, keep },
          network: id,
        });
      });

    // A running Network is told, and its driver steps the `Removed`. One stopped, before
    // it was told or by the step itself, has its `Removed` journaled here, unless the
    // Journal already holds it, and a restart folds it as any other. Either way it is then
    // held no more, drained within the bound, and its Credentials forgotten, by the
    // Configuration in force when it was removed.
    const removeHeld = (id: NetworkId, network: Network<S>, keep: boolean) =>
      Effect.gen(function* () {
        const running = (yield* Ref.get(network.status))._tag === "Running";

        const told = running
          ? yield* tellRemoved(network, keep).pipe(
              Effect.map(({ sequence }) => sequence),
              Effect.catchTag("NetworkStopped", () => Effect.void)
            )
          : undefined;

        const sequence = told ?? (yield* removedAt(id)) ?? (yield* appendRemoved(id, keep));
        const current = yield* Ref.get(network.current);
        const { configured } = current;
        // One removed before its first `Configured` was stepped has a life of its own.
        const life = current.life ?? sequence;

        // Kept before it is held no more, so `lives`, which reads what is held first, finds
        // it as one or the other.
        if (keep) {
          yield* Ref.update(kept, (all) => new Map(all).set(id, life));
        }

        yield* Ref.update(held, (all) => without(all, id));

        if (configured !== undefined) {
          yield* Ref.update(unforgotten, (all) =>
            new Map(all).set(id, [...(all.get(id) ?? []), configured.configuration])
          );
        }

        yield* Effect.logInfo("Removed a Network", { keep, network: id });
        yield* retire(network, ports.timing.stopTimeout);
        yield* forgetCredentials(id);

        return { life, sequence };
      });

    // A removed Network whose Timelines are kept has no driver, so its `Removed` is
    // journaled alone, and folded as any input is on restart.
    const removeKept = (id: NetworkId, keep: boolean, life: Life) =>
      Effect.gen(function* () {
        const sequence = yield* appendRemoved(id, keep);

        if (!keep) {
          yield* Ref.update(kept, (all) => without(all, id));
          yield* Effect.logInfo("Dropped a removed Network's Timelines", { network: id });
        }

        yield* forgetCredentials(id);

        return { life, sequence };
      });

    // Once admitted, a removal runs to its end in a fiber of its own, holding the permit
    // that adds a Network, so a caller that goes away never leaves one journaled and half
    // done, and no `configure` takes the id or changes a Configuration meanwhile.
    // The life a removal was made from, when it names one, is checked in the same turn that
    // removes, so no other removal or `configure` comes between.
    const remove = (id: NetworkId, keep: boolean, from: Life | undefined) =>
      Effect.flatMap(
        Effect.forkDetach(
          adding.withPermit(
            Effect.gen(function* () {
              if (yield* Ref.get(closed)) {
                return yield* new NetworkStopped({ network: id, reason: runtimeClosed });
              }

              const network = (yield* Ref.get(held)).get(id);

              if (network !== undefined) {
                const { life } = yield* Ref.get(network.current);

                if (from !== undefined && from !== life) {
                  return yield* new LifeChanged({ life: life ?? null, network: id });
                }

                return yield* removeHeld(id, network, keep);
              }

              const life = (yield* Ref.get(kept)).get(id);

              if (life === undefined) {
                return yield* new UnknownNetwork({ network: id });
              }

              if (from !== undefined && from !== life) {
                return yield* new LifeChanged({ life, network: id });
              }

              return yield* removeKept(id, keep, life);
            })
          )
        ),
        Fiber.join
      );

    // A removal cut short before its Credentials were forgotten is finished now, once
    // every Network is held, so those a Network names are spared.
    for (const id of (yield* Ref.get(unforgotten)).keys()) {
      yield* adding.withPermit(forgetCredentials(id)).pipe(
        Effect.catchTags({
          JournalFailed: (error) =>
            Effect.logWarning("A removed Network's Credentials were not forgotten", {
              network: id,
              reason: error.reason,
            }),
          VaultFailed: (error) =>
            Effect.logWarning("A removed Network's Credentials were not forgotten", {
              network: id,
              reason: error.reason,
            }),
        })
      );
    }

    const service: RuntimeService = {
      act: (id, acting) =>
        Effect.gen(function* () {
          const network = yield* find(id);
          const intent = acting.intent ?? (yield* intentId);
          const { action } = acting;

          const { news, sequence } = yield* tell(network, (at) => ({
            _tag: "Act",
            action,
            at,
            intent,
          }));

          const reason = refusalIn(news, intent);

          return reason === undefined
            ? ({ _tag: "Acted", intent, sequence } as const)
            : ({ _tag: "Refused", intent, reason, sequence } as const);
        }),
      channel: (id, name) =>
        Effect.map(
          Effect.flatMap(find(id), (network) => Ref.get(network.current)),
          ({ state }) => Option.fromUndefinedOr(client.channel(state, name))
        ),
      close: (id, target) =>
        Effect.flatMap(find(id), (network) =>
          Effect.map(
            tell(network, (at) => ({ _tag: "CloseTimeline", at, target })),
            ({ sequence }) => sequence
          )
        ),
      configuration: (id) =>
        Effect.flatMap(find(id), (network) =>
          Effect.flatMap(Ref.get(network.current), ({ configured }) =>
            configured === undefined
              ? Effect.fail(new UnknownNetwork({ network: id }))
              : Effect.succeed(configured)
          )
        ),
      // `configuring` is held until the `Configured` is stepped, refused, or its driver
      // stops, so a removal's check of which Credentials a Network still names never races
      // a change of Configuration. It is held in a fiber of its own, which the caller only
      // waits on, so a caller that goes away while its `Configured` is queued never lets go
      // of it early.
      configure: (id, configuration, ifSequence) =>
        Effect.flatMap(adding.withPermit(findOrAdd(id, ifSequence)), (network) =>
          Effect.flatMap(
            Effect.forkDetach(
              configuring.withPermit(
                Effect.map(
                  tellConfiguration(network, configuration, ifSequence),
                  ({ sequence }) => sequence
                )
              )
            ),
            Fiber.join
          )
        ),
      inspect: (id) =>
        Effect.gen(function* () {
          const network = yield* find(id);
          const { state, table } = yield* Ref.get(network.current);
          const status = yield* Ref.get(network.status);

          return {
            client: client.inspect(state),
            connections: yield* heldConnections(network),
            status,
            // A stopped Network's timers were stopped with it.
            timers: status._tag === "Running" ? table : new Map(),
          };
        }),
      kept: Ref.get(kept),
      // Read from one state of the Network, so what is known and its life go together.
      known: (id) =>
        Effect.flatMap(
          Effect.flatMap(find(id), (network) => Ref.get(network.current)),
          ({ life, state }) =>
            life === undefined
              ? Effect.fail(new UnknownNetwork({ network: id }))
              : Effect.succeed({ knowledge: client.known(state), life })
        ),
      // A Network added whose first `Configured` is not yet stepped has no life yet, and is
      // left out, as `configuration` leaves it out. What is held is read before what is
      // kept, and a removal keeps a Network before it lets go of it, so one removed between
      // the two reads is found kept, or in both, where it is kept, and never in neither.
      lives: Effect.gen(function* () {
        const networks = yield* Ref.get(held);

        const live = yield* Effect.forEach([...networks.values()], (network) =>
          Effect.map(
            Effect.all([Ref.get(network.status), Ref.get(network.current)]),
            ([status, { life }]) =>
              life === undefined ? [] : [[network.id, { _tag: "Live", life, status }] as const]
          )
        );

        const keeping = yield* Ref.get(kept);
        const all = new Map<NetworkId, Living>(live.flat());

        for (const [id, life] of keeping) {
          all.set(id, { _tag: "Kept", life });
        }

        return all;
      }),
      look: (id, looking) =>
        Effect.gen(function* () {
          const network = yield* find(id);
          const intent = looking.intent ?? (yield* intentId);
          const { lookup } = looking;

          const { stepped, result } = yield* awaitLookup(
            network,
            intent,
            tell(network, (at) => ({ _tag: "Look", at, intent, lookup })),
            lookTimeout
          );

          const { sequence } = stepped;

          return result === undefined
            ? ({ _tag: "Pending", intent, sequence } as const)
            : ({ _tag: "LookedUp", intent, result, sequence } as const);
        }),
      looked: (id, intent) =>
        Effect.map(lookedUp(client, ports.journal, id, intent), (found) =>
          Option.map(Option.fromUndefinedOr(found), ({ result, sequence }) =>
            result === undefined
              ? ({ _tag: "Pending", intent, sequence } as const)
              : ({ _tag: "LookedUp", intent, result, sequence } as const)
          )
        ),
      networks: Effect.flatMap(Ref.get(held), (networks) =>
        Effect.map(
          Effect.forEach([...networks.values()], (network) =>
            Effect.map(Ref.get(network.status), (status) => [network.id, status] as const)
          ),
          (statuses) => new Map(statuses)
        )
      ),
      news: (from = {}) => newsAfter(client, ports.journal, from.after),
      read: (id, reading) =>
        Effect.flatMap(find(id), (network) =>
          Effect.map(
            tell(network, (at) => ({
              _tag: "Read",
              at,
              read: reading.read,
              target: reading.target,
            })),
            ({ sequence }) => sequence
          )
        ),
      remove: (id, { keep, life }) => remove(id, keep, life),
      retry: (id) =>
        Effect.flatMap(find(id), (network) =>
          Effect.map(
            tell(network, (at) => ({ _tag: "Retry", at })),
            ({ sequence }) => sequence
          )
        ),
      said: (id, intent) =>
        ports.journal.read({ network: id }).pipe(
          Stream.filter(
            ({ record }) =>
              record._tag === "Input" &&
              (record.input._tag === "Say" || record.input._tag === "Act") &&
              record.input.intent === intent
          ),
          Stream.runHead,
          Effect.map(Option.map(({ sequence }) => sequence))
        ),
      say: (id, saying) =>
        Effect.gen(function* () {
          const network = yield* find(id);
          const intent = saying.intent ?? (yield* intentId);
          const { kind, target, text } = saying;

          const { news, sequence } = yield* tell(network, (at) => ({
            _tag: "Say",
            at,
            intent,
            kind,
            target,
            text,
          }));

          const reason = refusalIn(news, intent);

          return reason === undefined
            ? ({ _tag: "Said", intent, sequence } as const)
            : ({ _tag: "Refused", intent, reason, sequence } as const);
        }),
    };

    return service;
  });

/**
 * The Runtime as a Layer, which needs the Transport, the Journal, and the Vault, and
 * takes time from Effect's `Clock`.
 * @param client - The Client to drive, one per Network.
 * @param options - Pacing, and how long endings may take.
 * @returns The Layer.
 */
export const layerRuntime = <S>(
  client: Client<S>,
  options: RuntimeOptions = {}
): Layer.Layer<Runtime, DecodersMissing | JournalFailed, Journal | Transport | Vault> =>
  Layer.effect(Runtime, makeRuntime(client, options));
