/**
 * One Network's driver: a fiber that takes its inputs one at a time from one queue,
 * journals each, steps the Client, journals the outputs, and carries them out through
 * the ports.
 *
 * @packageDocumentation
 */
import { timers } from "@iirc/client";
import type {
  Client,
  ConnectionId,
  Input,
  Instant,
  Output,
  TimerId,
  TimerTable,
  UnfilledReason,
} from "@iirc/client";
import { encode, fillSecret, isRejected } from "@iirc/protocol/line";
import type { OutboundLine, SecretLine } from "@iirc/protocol/line";
import { Cause, Deferred, Effect, Exit, FiberMap, Queue, Ref, Schema, Scope, Stream } from "effect";

import { now, sleepUntil } from "./clock.ts";
import { JournalFailed } from "./journal.ts";
import type { JournalService, NetworkId, Sequence } from "./journal.ts";
import { ClientThrew, stepContained } from "./replay.ts";
import type { Folded } from "./replay.ts";
import type { Link, LinkEvent, TransportService } from "./transport.ts";
import type { VaultService } from "./vault.ts";

/** Whether a Network's driver is running, or why it stopped. */
export type NetworkStatus =
  | { readonly _tag: "Running" }
  | { readonly _tag: "Stopped"; readonly reason: string };

/** The Network has stopped, so it takes no more inputs until the Runtime starts again. */
export class NetworkStopped extends Schema.TaggedError<
  NetworkStopped,
  { readonly brand: unique symbol }
>()("NetworkStopped", { network: Schema.String, reason: Schema.String }) {}

/** Why every Network stops when the Runtime's Scope closes. */
export const runtimeClosed = "The Runtime closed";

/** What waits in a Network's queue, before it is given its `at` and journaled. */
type Pending =
  | {
      readonly _tag: "Owner";
      readonly input: (at: Instant) => Input;
      readonly done: Deferred.Deferred<Sequence>;
    }
  | { readonly _tag: "Link"; readonly connection: ConnectionId; readonly event: LinkEvent }
  | { readonly _tag: "Due"; readonly timer: TimerId; readonly due: Instant };

/** A Connection the Runtime holds, with the Scope that ends it. */
interface Live {
  readonly link: Link;
  readonly scope: Scope.Closeable;
}

/** One Network, as the Runtime holds it. */
export interface Network<S> {
  readonly id: NetworkId;
  readonly queue: Queue.Queue<Pending>;
  /** The Client's state, and the timer table projected from every step. */
  readonly current: Ref.Ref<{ readonly state: S; readonly table: TimerTable }>;
  readonly links: Ref.Ref<ReadonlyMap<ConnectionId, Live>>;
  readonly status: Ref.Ref<NetworkStatus>;
  /** Fails once the Network stops, so an Owner input waiting on it does not hang. */
  readonly stopped: Deferred.Deferred<never, NetworkStopped>;
}

/** The ports and the Client a driver uses. */
export interface Ports<S> {
  readonly client: Client<S>;
  readonly journal: JournalService;
  readonly transport: TransportService;
  readonly vault: VaultService;
}

/**
 * How many inputs may wait for one Network. A full queue holds back whoever offers, so a
 * flooding Ircd waits on its own socket rather than growing memory.
 */
const queueCapacity = 1024;

/** A `SendSecret` that could not be filled, to be stepped as `Unfilled`. */
interface Unfilled {
  readonly connection: ConnectionId;
  readonly line: SecretLine;
  readonly reason: UnfilledReason;
}

const toInput = (pending: Exclude<Pending, { _tag: "Owner" }>, at: Instant): Input => {
  if (pending._tag === "Due") {
    return { _tag: "Fired", at, due: pending.due, timer: pending.timer };
  }

  const { connection, event } = pending;

  switch (event._tag) {
    case "Opened": {
      return { _tag: "Opened", at, connection };
    }

    case "Received": {
      return { _tag: "Received", at, bytes: event.bytes, connection };
    }

    case "Closed": {
      return { _tag: "Closed", at, connection, reason: event.reason };
    }

    default: {
      return event satisfies never;
    }
  }
};

const without = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => {
  const next = new Map(map);

  next.delete(key);

  return next;
};

// Every Line, filled or not, goes through `encode`, the last guard on what leaves. A
// filled Line it rejects makes the whole Credential unsendable, so none of it is sent.
const encodeAll = (lines: readonly OutboundLine[]): readonly Uint8Array[] | undefined => {
  const encoded: Uint8Array[] = [];

  for (const line of lines) {
    const bytes = encode(line);

    if (isRejected(bytes)) {
      return undefined;
    }

    encoded.push(bytes);
  }

  return encoded;
};

const stoppedReason = (cause: Cause.Cause<JournalFailed | ClientThrew>): string => {
  const failure = Cause.squash(cause);

  if (failure instanceof JournalFailed) {
    return `The Journal failed: ${failure.reason}`;
  }

  if (failure instanceof ClientThrew) {
    return `The Client threw: ${failure.reason}`;
  }

  return `A defect: ${Cause.pretty(cause)}`;
};

/**
 * Makes a Network's handle, stopped or ready to drive.
 * @param id - The Network.
 * @param folded - Its Client so far.
 * @returns The handle.
 */
const makeNetwork = <S>(id: NetworkId, folded: Folded<S>) =>
  Effect.gen(function* () {
    const network: Network<S> = {
      current: yield* Ref.make({ state: folded.state, table: folded.table }),
      id,
      links: yield* Ref.make<ReadonlyMap<ConnectionId, Live>>(new Map()),
      queue: yield* Queue.bounded<Pending>(queueCapacity),
      status: yield* Ref.make<NetworkStatus>({ _tag: "Running" }),
      stopped: yield* Deferred.make<never, NetworkStopped>(),
    };

    return network;
  });

const stop = <S>(network: Network<S>, reason: string) =>
  Effect.andThen(
    Ref.set(network.status, { _tag: "Stopped", reason }),
    Deferred.fail(network.stopped, new NetworkStopped({ network: network.id, reason }))
  );

/**
 * The driver's loop, in the Network's own Scope: closing it hangs up every Connection
 * and stops every timer.
 * @param ports - The Client and the ports.
 * @param network - The Network to drive.
 * @param restarted - Whether to set its timers and step a `Started` first.
 * @returns An Effect that runs until the Network fails or is interrupted.
 */
const drive = <S>(
  ports: Ports<S>,
  network: Network<S>,
  restarted: boolean
): Effect.Effect<never, JournalFailed | ClientThrew, Scope.Scope> =>
  Effect.gen(function* () {
    const { client, journal, transport, vault } = ports;
    const { current, id, links, queue } = network;
    const scope = yield* Effect.scope;
    const wakes = yield* FiberMap.make<TimerId>();

    // Runs last, once every Connection's Scope is closed.
    yield* Effect.addFinalizer(() => Ref.set(links, new Map()));

    // One fiber per timer id. Setting it again replaces the fiber, so a reset timer fires
    // once, and a cancelled one never.
    const wake = (timer: TimerId, at: Instant | null) =>
      at === null
        ? FiberMap.remove(wakes, timer)
        : FiberMap.run(
            wakes,
            timer,
            Effect.andThen(sleepUntil(at), Queue.offer(queue, { _tag: "Due", due: at, timer }))
          ).pipe(Effect.asVoid);

    const live = (connection: ConnectionId) =>
      Effect.map(Ref.get(links), (held) => held.get(connection));

    const dial = (connection: ConnectionId, output: Extract<Output, { _tag: "Dial" }>) =>
      Effect.gen(function* () {
        const own = yield* Scope.fork(scope);
        const link = yield* transport.dial(output.ircd).pipe(Scope.provide(own));

        // Added after the dial, so it runs before the Transport lets go: shutdown hangs up.
        yield* Scope.addFinalizer(own, link.hangup);
        yield* Effect.forkIn(
          Stream.runForEach(link.events, (event) =>
            Queue.offer(queue, { _tag: "Link", connection, event })
          ),
          own
        );
        yield* Ref.update(links, (held) => new Map(held).set(connection, { link, scope: own }));
        yield* Effect.logInfo("Dialling", { connection, ircd: output.ircd });
      });

    // Ends the Runtime's hold on a Connection once its `Closed` has been stepped.
    const forget = (connection: ConnectionId) =>
      Effect.flatMap(
        Ref.modify(links, (held) => [held.get(connection), without(held, connection)]),
        (gone) => (gone === undefined ? Effect.void : Scope.close(gone.scope, Exit.void))
      );

    const send = (connection: ConnectionId, line: OutboundLine) =>
      Effect.gen(function* () {
        const held = yield* live(connection);

        if (held === undefined) {
          return yield* Effect.logDebug("Not sent: no such Connection", { connection });
        }

        const bytes = encode(line);

        if (isRejected(bytes)) {
          return yield* Effect.logError("Not sent: encode rejected a Line, a bug upstream", {
            command: line.command,
            connection,
            reason: bytes.reason,
          });
        }

        return yield* held.link.send(bytes);
      });

    // The value is revealed at the last moment, filled, sent, and let go of. Nothing here
    // logs or journals it, and a refusal names only the reason.
    const sendSecret = (connection: ConnectionId, line: SecretLine) =>
      Effect.gen(function* () {
        const held = yield* live(connection);

        if (held === undefined) {
          yield* Effect.logDebug("Not sent: no such Connection", { connection });

          return [];
        }

        const refused = (reason: UnfilledReason) =>
          ({ _tag: "Refused", unfilled: { connection, line, reason } }) as const;

        const revealed = yield* vault.reveal(line.credential).pipe(
          Effect.map((value) => ({ _tag: "Revealed", value }) as const),
          Effect.catchTags({
            CredentialMissing: () => Effect.succeed(refused("Missing")),
            VaultFailed: (error) =>
              Effect.as(
                Effect.logWarning("The Vault failed", { reason: error.reason }),
                refused("Unavailable")
              ),
          })
        );

        if (revealed._tag === "Refused") {
          return [revealed.unfilled];
        }

        const filled = fillSecret(line, revealed.value);
        const encoded = isRejected(filled) ? undefined : encodeAll(filled);

        if (encoded === undefined) {
          return [refused("Unsendable").unfilled];
        }

        for (const bytes of encoded) {
          yield* held.link.send(bytes);
        }

        return [];
      });

    // Each output, carried out, with the `SendSecret` it could not fill, if any.
    const carryOut = (output: Output): Effect.Effect<readonly Unfilled[]> => {
      switch (output._tag) {
        case "Dial": {
          return Effect.as(dial(output.connection, output), []);
        }

        case "Send": {
          return Effect.as(send(output.connection, output.line), []);
        }

        case "SendSecret": {
          return sendSecret(output.connection, output.line);
        }

        case "Hangup": {
          return Effect.as(
            Effect.flatMap(live(output.connection), (held) => held?.link.hangup ?? Effect.void),
            []
          );
        }

        case "Wake": {
          return Effect.as(wake(output.timer, output.at), []);
        }

        default: {
          return output satisfies never;
        }
      }
    };

    // The order for each input: give it its `at`, append it, step, append the outputs
    // with `of`, then carry them out. A `SendSecret` that could not be filled is stepped
    // as `Unfilled` after the rest, in order.
    const once = (make: (at: Instant) => Input) =>
      Effect.gen(function* () {
        const input = make(yield* now);
        const sequence = yield* journal.append({ _tag: "Input", input, network: id });
        const before = yield* Ref.get(current);
        const step = yield* stepContained(client, before.state, input);
        const unfilled: Unfilled[] = [];

        yield* Ref.set(current, {
          state: step.state,
          table: timers(before.table, input, step.outputs),
        });

        if (step.outputs.length > 0) {
          yield* journal.append({
            _tag: "Outputs",
            network: id,
            of: sequence,
            outputs: step.outputs,
          });
        }

        for (const output of step.outputs) {
          for (const refused of yield* carryOut(output)) {
            yield* Effect.logWarning("A Credential could not be filled", {
              connection: refused.connection,
              credential: refused.line.credential,
              reason: refused.reason,
            });
            unfilled.push(refused);
          }
        }

        return { sequence, unfilled };
      });

    const advance = (first: (at: Instant) => Input) =>
      Effect.gen(function* () {
        const stepped = yield* once(first);
        const work = [...stepped.unfilled];

        for (let next = work.shift(); next !== undefined; next = work.shift()) {
          const refused = next;
          const more = yield* once((at) => ({ _tag: "Unfilled", at, ...refused }));

          work.push(...more.unfilled);
        }

        return stepped.sequence;
      });

    const take = (pending: Pending) => {
      if (pending._tag === "Owner") {
        return Effect.flatMap(advance(pending.input), (sequence) =>
          Deferred.succeed(pending.done, sequence)
        );
      }

      const advanced = advance((at) => toInput(pending, at));

      return pending._tag === "Link" && pending.event._tag === "Closed"
        ? Effect.andThen(advanced, forget(pending.connection))
        : advanced;
    };

    if (restarted) {
      for (const [timer, at] of (yield* Ref.get(current)).table) {
        yield* wake(timer, at);
      }

      yield* advance((at) => ({ _tag: "Started", at }));
    }

    return yield* Effect.forever(Effect.flatMap(Queue.take(queue), take));
  });

/**
 * Starts driving a Network in the Scope in context. Closing that Scope stops it. A
 * failure or defect stops only this Network, and is logged.
 * @param ports - The Client and the ports.
 * @param id - The Network.
 * @param folded - Its Client so far, from `initial` or refolded from the Journal.
 * @param restarted - Whether to set its timers and step a `Started` first.
 * @returns The Network's handle.
 */
export const startNetwork = <S>(
  ports: Ports<S>,
  id: NetworkId,
  folded: Folded<S>,
  restarted: boolean
): Effect.Effect<Network<S>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const network = yield* makeNetwork(id, folded);

    if (folded._tag === "Broken") {
      yield* Effect.logError("The Network stopped on restart", { reason: folded.reason });
      yield* stop(network, `The Client threw: ${folded.reason}`);

      return network;
    }

    yield* Effect.scoped(drive(ports, network, restarted)).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.andThen(
            Effect.logError("The Network stopped", cause),
            stop(network, stoppedReason(cause))
          )
      ),
      // Shutdown is no failure, so it is not logged as one, but an Owner input still
      // waiting is told the Network has stopped.
      Effect.onInterrupt(() => stop(network, runtimeClosed)),
      Effect.annotateLogs({ network: id }),
      Effect.forkScoped
    );

    return network;
  });

/**
 * Gives a Network an Owner input, and waits until it is journaled and stepped.
 * @param network - The Network.
 * @param input - The input, given its `at` when its turn comes.
 * @returns The input's sequence, or `NetworkStopped`.
 */
export const tell = <S>(
  network: Network<S>,
  input: (at: Instant) => Input
): Effect.Effect<Sequence, NetworkStopped> =>
  Effect.flatMap(Deferred.make<Sequence>(), (done) =>
    Effect.raceFirst(
      Effect.andThen(
        Queue.offer(network.queue, { _tag: "Owner", done, input }),
        Deferred.await(done)
      ),
      Deferred.await(network.stopped)
    )
  );
