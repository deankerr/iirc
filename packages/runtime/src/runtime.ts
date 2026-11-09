/**
 * The Runtime: one Client per Network, driven through the ports. Owner inputs come in,
 * News goes out derived from the Journal, and what each Client knows can be read.
 *
 * @packageDocumentation
 */
import { IntentId } from "@iirc/client";
import type {
  Client,
  ConnectionId,
  Inspection,
  NetworkConfiguration,
  SayKind,
  TimerTable,
} from "@iirc/client";
import type { Knowledge } from "@iirc/client/known";
import { FallbackEncoding, missingDecoders } from "@iirc/protocol/line";
import { Context, Effect, Layer, Random, Ref, Schema, Scope, Semaphore } from "effect";
import type { Stream } from "effect";

import { Journal, NetworkId } from "./journal.ts";
import type { JournalFailed, Sequence } from "./journal.ts";
import { NetworkStopped, runtimeClosed, startNetwork, tell } from "./network.ts";
import type { Network, NetworkStatus, Ports } from "./network.ts";
import { fresh, newsAfter, refold } from "./replay.ts";
import type { Happened } from "./replay.ts";
import { Transport } from "./transport.ts";
import { Vault } from "./vault.ts";

export { NetworkStopped } from "./network.ts";

export type { NetworkStatus } from "./network.ts";

export type { Happened } from "./replay.ts";

/** No Network by this id has been configured. */
export class UnknownNetwork extends Schema.TaggedError<
  UnknownNetwork,
  { readonly brand: unique symbol }
>()("UnknownNetwork", { network: NetworkId }) {}

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
}

/** A Network as the Runtime holds it, for agents and debugging. */
export interface NetworkInspection {
  readonly status: NetworkStatus;
  /** The Client's own inspection. */
  readonly client: Inspection;
  /** The Connections the Runtime holds a Link for. */
  readonly connections: readonly ConnectionId[];
  /** The timers the Runtime has set, projected with `timers` from every step. */
  readonly timers: TimerTable;
}

/** What the Runtime offers. */
export interface RuntimeService {
  /** Journals a `Configured`, and waits until it is stepped. The first one for an id adds the Network. */
  readonly configure: (
    network: NetworkId,
    configuration: NetworkConfiguration
  ) => Effect.Effect<Sequence, NetworkStopped>;
  /** Journals a `Say`, with an intent id the Runtime names, and waits until it is stepped. */
  readonly say: (
    network: NetworkId,
    saying: Saying
  ) => Effect.Effect<
    { readonly intent: IntentId; readonly sequence: Sequence },
    UnknownNetwork | NetworkStopped
  >;
  /** Journals a `Retry`, and waits until it is stepped. */
  readonly retry: (network: NetworkId) => Effect.Effect<Sequence, UnknownNetwork | NetworkStopped>;
  /** What the Network's Client knows now. */
  readonly known: (network: NetworkId) => Effect.Effect<Knowledge, UnknownNetwork>;
  /** The Network's Client and the Runtime's hold on it. */
  readonly inspect: (network: NetworkId) => Effect.Effect<NetworkInspection, UnknownNetwork>;
  /** Every Network, in the order it was added, with whether it is running. */
  readonly networks: Effect.Effect<ReadonlyMap<NetworkId, NetworkStatus>>;
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
 * @param missing - The fallback encodings this runtime cannot decode. A seam for tests.
 * @returns The Runtime's service.
 */
export const makeRuntime = <S>(
  client: Client<S>,
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
      transport: yield* Transport,
      vault: yield* Vault,
    };

    const scope = yield* Effect.scope;
    const held = yield* Ref.make<ReadonlyMap<NetworkId, Network<S>>>(new Map());
    const adding = yield* Semaphore.make(1);

    const folded = yield* refold(client, ports.journal);

    for (const [id, network] of folded) {
      const started = yield* startNetwork(ports, id, network, true);

      yield* Ref.update(held, (networks) => new Map(networks).set(id, started));
    }

    // Set first on shutdown, before any Network stops, so no Network is added after.
    const closed = yield* Ref.make(false);

    yield* Effect.addFinalizer(() => Ref.set(closed, true));

    const find = (id: NetworkId) =>
      Effect.flatMap(Ref.get(held), (networks) => {
        const network = networks.get(id);

        return network === undefined
          ? Effect.fail(new UnknownNetwork({ network: id }))
          : Effect.succeed(network);
      });

    const findOrAdd = (id: NetworkId) =>
      adding.withPermit(
        Effect.flatMap(Effect.all([Ref.get(held), Ref.get(closed)]), ([networks, over]) => {
          const network = networks.get(id);

          if (network !== undefined) {
            return Effect.succeed(network);
          }

          if (over) {
            return Effect.fail(new NetworkStopped({ network: id, reason: runtimeClosed }));
          }

          return startNetwork(ports, id, fresh(client), false).pipe(
            Scope.provide(scope),
            Effect.tap((added) => Ref.update(held, (all) => new Map(all).set(id, added))),
            Effect.tap(() => Effect.logInfo("Added a Network", { network: id }))
          );
        })
      );

    const service: RuntimeService = {
      configure: (id, configuration) =>
        Effect.flatMap(findOrAdd(id), (network) =>
          tell(network, (at) => ({ _tag: "Configured", at, configuration }))
        ),
      inspect: (id) =>
        Effect.gen(function* () {
          const network = yield* find(id);
          const { state, table } = yield* Ref.get(network.current);
          const status = yield* Ref.get(network.status);

          return {
            client: client.inspect(state),
            connections: [...(yield* Ref.get(network.links)).keys()],
            status,
            // A stopped Network's timers were stopped with it.
            timers: status._tag === "Running" ? table : new Map(),
          };
        }),
      known: (id) =>
        Effect.map(
          Effect.flatMap(find(id), (network) => Ref.get(network.current)),
          ({ state }) => client.known(state)
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
      retry: (id) =>
        Effect.flatMap(find(id), (network) => tell(network, (at) => ({ _tag: "Retry", at }))),
      say: (id, saying) =>
        Effect.gen(function* () {
          const network = yield* find(id);
          const intent = yield* intentId;
          const sequence = yield* tell(network, (at) => ({ _tag: "Say", at, intent, ...saying }));

          return { intent, sequence };
        }),
    };

    return service;
  });

/**
 * The Runtime as a Layer, which needs the Transport, the Journal, and the Vault, and
 * takes time from Effect's `Clock`.
 * @param client - The Client to drive, one per Network.
 * @returns The Layer.
 */
export const layerRuntime = <S>(
  client: Client<S>
): Layer.Layer<Runtime, DecodersMissing | JournalFailed, Journal | Transport | Vault> =>
  Layer.effect(Runtime, makeRuntime(client));
