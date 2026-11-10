/**
 * One Network's driver: a fiber that takes its inputs one at a time from one queue,
 * journals each, steps the Client, journals the outputs, and carries them out through
 * the ports.
 *
 * @packageDocumentation
 */
import { Instant, timers } from "@iirc/client";
import type {
  Client,
  ConnectionId,
  Input,
  News,
  Output,
  TimerId,
  TimerTable,
  UnfilledReason,
  UnsentLine,
} from "@iirc/client";
import { depth, makeOutbox, nextAt, offer, spend, take as takeLine, takeAll } from "@iirc/outbox";
import type { Outbox, Pacing } from "@iirc/outbox";
import { encode, fillSecret, isRejected } from "@iirc/protocol/line";
import type { OutboundLine, SecretLine } from "@iirc/protocol/line";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Latch,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";

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

/** A `SendSecret` that could not be filled, to be stepped as `Unfilled`. */
interface Unfilled {
  readonly connection: ConnectionId;
  readonly line: SecretLine;
  readonly reason: UnfilledReason;
}

/** An Owner input once stepped: its sequence, and the News its own step gave. */
export interface Stepped {
  readonly sequence: Sequence;
  readonly news: readonly News[];
}

/** What waits in a Network's queue, before it is given its `at` and journaled. */
type Pending =
  | {
      readonly _tag: "Owner";
      readonly input: (at: Instant) => Input;
      readonly done: Deferred.Deferred<Stepped>;
    }
  | { readonly _tag: "Link"; readonly connection: ConnectionId; readonly event: LinkEvent }
  | { readonly _tag: "Due"; readonly timer: TimerId; readonly due: Instant }
  /** A pump could not fill a `SendSecret` when its turn came. */
  | ({ readonly _tag: "Unfilled" } & Unfilled)
  /**
   * A pump dropped Lines when a hang-up ran out of time. They wait in the Connection's
   * `dropped` until the Network's fiber steps them, here or with its `Closed`.
   */
  | { readonly _tag: "Dropped"; readonly connection: ConnectionId }
  /** The Runtime is closing. */
  | { readonly _tag: "Stopping" };

/** A Connection the Runtime holds, with the Scope that ends it, and its Outbox. */
interface Live {
  readonly link: Link;
  readonly scope: Scope.Closeable;
  /** The Lines waiting to leave on this Connection. Never journaled. */
  readonly outbox: Ref.Ref<Outbox<UnsentLine>>;
  /** Set by a `Hangup`: when the drain runs out, and every Line left but a `QUIT` is dropped. */
  readonly hangup: Ref.Ref<Instant | undefined>;
  /** Wakes the pump when there may be something new to do. It holds one signal at most. */
  readonly wake: Queue.Queue<true>;
  /**
   * A `SendSecret` the pump has taken and not yet written in full: it is revealing its
   * Credential, or pacing its filled Lines, which only the pump holds.
   */
  readonly unfinished: Ref.Ref<UnsentLine | undefined>;
  /**
   * Lines the pump dropped at a hang-up's cutoff, until the Network's fiber steps them as
   * `Unsent`. Whichever of a `Dropped` and the `Closed` comes first takes them, so they
   * are stepped once, and before the `Closed`.
   */
  readonly dropped: Ref.Ref<readonly UnsentLine[]>;
  /** The fiber that carries this Connection's Lines out at pace. */
  readonly pump: Fiber.Fiber<void>;
}

/** What a pump works with: the Connection as held, before its pump and Scope exist. */
type Pumped = Omit<Live, "pump" | "scope">;

/** How a Network paces its Connections, and how long its endings may take. */
interface Timing {
  readonly pacing: Pacing;
  /** How many ordinary Lines may wait for one Connection. */
  readonly capacity: number;
  /** How long a `Hangup` lets queued Lines leave at pace before it hangs up anyway, in milliseconds. */
  readonly hangupDrain: number;
  /** How long shutdown waits for a Network's Connections to close, in milliseconds. */
  readonly stopTimeout: number;
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
  /** Set once its `Stopping` is taken: Owner inputs after it are never stepped. */
  readonly stopping: Ref.Ref<boolean>;
  /** Succeeds once a `Stopping` has been stepped and every Connection's `Closed` with it. */
  readonly drained: Latch.Latch;
  /** The driver's fiber, once it is forked, so shutdown can stop it. */
  readonly driver: Ref.Ref<Fiber.Fiber<unknown, unknown> | undefined>;
}

/** The ports and the Client a driver uses. */
export interface Ports<S> {
  readonly client: Client<S>;
  readonly journal: JournalService;
  readonly transport: TransportService;
  readonly vault: VaultService;
  readonly timing: Timing;
}

/**
 * How many inputs may wait for one Network. A full queue holds back whoever offers, so a
 * flooding Ircd waits on its own socket rather than growing memory.
 */
const queueCapacity = 1024;

const linkInput = (connection: ConnectionId, event: LinkEvent, at: Instant): Input => {
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

// Each Pending but an Owner's, a `Stopping`, and a `Dropped`, as the input it becomes.
const toInput = (
  pending: Exclude<Pending, { _tag: "Owner" | "Stopping" | "Dropped" }>,
  at: Instant
): Input => {
  switch (pending._tag) {
    case "Due": {
      return { _tag: "Fired", at, due: pending.due, timer: pending.timer };
    }

    case "Link": {
      return linkInput(pending.connection, pending.event, at);
    }

    case "Unfilled": {
      const { connection, line, reason } = pending;

      return { _tag: "Unfilled", at, connection, line, reason };
    }

    default: {
      return pending satisfies never;
    }
  }
};

// The command of a Line waiting, which decides whether it goes first.
const commandOf = (line: UnsentLine): string =>
  line._tag === "Send" ? line.line.command : line.line._tag;

const isQuit = (line: UnsentLine): boolean => line._tag === "Send" && line.line.command === "QUIT";

// `encode` is the last guard on what leaves. A Line it rejects is a bug upstream.
const sendLine = (connection: ConnectionId, link: Link, line: OutboundLine) => {
  const bytes = encode(line);

  return isRejected(bytes)
    ? Effect.logError("Not sent: encode rejected a Line, a bug upstream", {
        command: line.command,
        connection,
        reason: bytes.reason,
      })
    : link.send(bytes);
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

// Takes the next Line. A secret taken is unfinished from the moment it leaves the Outbox.
const takeNext = (held: Pumped, at: Instant) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const next = yield* Ref.modify(held.outbox, (waiting) => {
        const taken = takeLine(waiting, at);

        return [taken, taken.outbox];
      });

      if (next._tag === "Taken" && next.item._tag === "SendSecret") {
        yield* Ref.set(held.unfinished, next.item);
      }

      return next;
    })
  );

// Waits until a token is free or the drain runs out. Woken early by a new Line or a
// `Hangup`'s deadline, the pump looks again.
const waitUntil = (held: Pumped, until: number, deadline: Instant | undefined) =>
  Effect.raceFirst(
    sleepUntil(Instant.make(deadline === undefined ? until : Math.min(until, deadline))),
    Queue.take(held.wake)
  );

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
      drained: yield* Latch.make(),
      driver: yield* Ref.make<Fiber.Fiber<unknown, unknown> | undefined>(undefined),
      id,
      links: yield* Ref.make<ReadonlyMap<ConnectionId, Live>>(new Map()),
      queue: yield* Queue.bounded<Pending>(queueCapacity),
      status: yield* Ref.make<NetworkStatus>({ _tag: "Running" }),
      stopped: yield* Deferred.make<never, NetworkStopped>(),
      stopping: yield* Ref.make(false),
    };

    return network;
  });

// The first reason stands: stopping a stopped Network does nothing.
const stop = <S>(network: Network<S>, reason: string) =>
  Effect.flatMap(
    Deferred.fail(network.stopped, new NetworkStopped({ network: network.id, reason })),
    (first) => (first ? Ref.set(network.status, { _tag: "Stopped", reason }) : Effect.void)
  );

/**
 * The driver's loop, in the Network's own Scope: closing it hangs up every Connection
 * and stops every timer and pump.
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
    const { client, journal, timing, transport, vault } = ports;
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

    // The value is revealed when the Line's turn comes, and filled. The filled Lines stay
    // with the pump, which paces them and lets go of them once sent. Nothing here logs or
    // journals them, and a refusal names only the reason, and is queued to be stepped as
    // `Unfilled`.
    const fill = (
      connection: ConnectionId,
      line: SecretLine
    ): Effect.Effect<readonly Uint8Array[] | undefined> =>
      Effect.gen(function* () {
        const refuse = (reason: UnfilledReason) =>
          Effect.as(
            Effect.andThen(
              Effect.logWarning("A Credential could not be filled", {
                connection,
                credential: line.credential,
                reason,
              }),
              Queue.offer(queue, { _tag: "Unfilled", connection, line, reason })
            ),
            undefined
          );

        const revealed = yield* vault.reveal(line.credential).pipe(
          Effect.map((value) => ({ _tag: "Revealed", value }) as const),
          Effect.catchTags({
            CredentialMissing: () =>
              Effect.succeed({ _tag: "Refused", reason: "Missing" } as const),
            VaultFailed: (error) =>
              Effect.as(Effect.logWarning("The Vault failed", { reason: error.reason }), {
                _tag: "Refused",
                reason: "Unavailable",
              } as const),
          })
        );

        if (revealed._tag === "Refused") {
          return yield* refuse(revealed.reason);
        }

        const filled = fillSecret(line, revealed.value);
        const encoded = isRejected(filled) ? undefined : encodeAll(filled);

        return encoded ?? (yield* refuse("Unsendable"));
      });

    // The drain has run out: every Line still waiting is dropped, but a `QUIT`, which is
    // what leaving asked for, and goes even past the bucket. A `SendSecret` not yet
    // written in full is dropped with them, as the Output it was. What was dropped moves
    // to `dropped` at once, so the `Closed` that follows finds it even if the `Dropped`
    // cannot be queued, and the `Dropped` is queued without waiting for room.
    const cutOff = (connection: ConnectionId, held: Pumped): Effect.Effect<void> =>
      Effect.gen(function* () {
        const cut = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const unfinished = yield* Ref.getAndSet(held.unfinished, undefined);

            const left = yield* Ref.modify(held.outbox, (waiting) => {
              const emptied = takeAll(waiting);

              return [emptied.items, emptied.outbox];
            });

            const dropped = [
              ...(unfinished === undefined ? [] : [unfinished]),
              ...left.filter((line) => !isQuit(line)),
            ];

            yield* Ref.update(held.dropped, (already) => [...already, ...dropped]);

            return { dropped: dropped.length, quits: left.filter(isQuit) };
          })
        );

        if (cut.dropped > 0) {
          yield* Effect.logWarning("Lines dropped at hang-up", {
            connection,
            dropped: cut.dropped,
          });
          yield* Effect.sync(() => Queue.offerUnsafe(queue, { _tag: "Dropped", connection }));
        }

        for (const line of cut.quits) {
          if (line._tag === "Send") {
            yield* sendLine(connection, held.link, line.line);
          }
        }

        yield* held.link.hangup;
      });

    // Carries one Connection's Lines out at pace, waiting on the Clock until each may
    // leave, or until it is woken. Each wire Line spends a token, so a `SendSecret` filled
    // to several Lines is paced like any others. After a `Hangup`, it drains what is
    // waiting, then hangs up.
    const pump = (connection: ConnectionId, held: Pumped): Effect.Effect<void> =>
      Effect.gen(function* () {
        // The filled Lines of the `SendSecret` being written, held only here.
        let filled: readonly Uint8Array[] = [];

        // Writes the next filled Line. Before the last, the `SendSecret` stops being
        // unfinished: a Line being written counts as sent.
        const writeFilled = Effect.gen(function* () {
          const [bytes, ...rest] = filled;

          filled = rest;

          if (rest.length === 0) {
            yield* Ref.set(held.unfinished, undefined);
          }

          if (bytes !== undefined) {
            yield* held.link.send(bytes);
          }
        });

        for (;;) {
          const at = yield* now;
          const deadline = yield* Ref.get(held.hangup);

          if (deadline !== undefined && at >= deadline) {
            return yield* cutOff(connection, held);
          }

          // A `PING` or `PONG` waiting goes before the next filled Line, as it would before
          // any other: a long SASL response must not hold a keepalive past its timeout.
          if (filled.length > 0 && (yield* Ref.get(held.outbox)).ahead.length === 0) {
            const spent = yield* Ref.modify(held.outbox, (waiting) => {
              const result = spend(waiting, at);

              return [result, result.outbox];
            });

            yield* spent._tag === "Spent" ? writeFilled : waitUntil(held, spent.until, deadline);
            continue;
          }

          const next = yield* takeNext(held, at);

          switch (next._tag) {
            case "Taken": {
              const { item } = next;

              if (item._tag === "Send") {
                yield* sendLine(connection, held.link, item.line);
                break;
              }

              const encoded = yield* fill(connection, item.line);

              if (encoded === undefined || encoded.length === 0) {
                yield* Ref.set(held.unfinished, undefined);
                break;
              }

              filled = encoded;
              yield* writeFilled;
              break;
            }

            case "Wait": {
              yield* waitUntil(held, next.until, deadline);
              break;
            }

            case "Empty": {
              if (deadline !== undefined) {
                return yield* held.link.hangup;
              }

              yield* Queue.take(held.wake);
              break;
            }

            default: {
              return next satisfies never;
            }
          }
        }
      });

    const dial = (connection: ConnectionId, output: Extract<Output, { _tag: "Dial" }>) =>
      Effect.gen(function* () {
        const own = yield* Scope.fork(scope);
        const link = yield* transport.dial(output.ircd).pipe(Scope.provide(own));

        // Closing the Scope ends the Connection at once, with no hang-up to wait for: a
        // graceful end comes before it, from the Client's `Hangup`.
        yield* Effect.forkIn(
          Stream.runForEach(link.events, (event) =>
            Queue.offer(queue, { _tag: "Link", connection, event })
          ),
          own
        );

        const held: Pumped = {
          dropped: yield* Ref.make<readonly UnsentLine[]>([]),
          hangup: yield* Ref.make<Instant | undefined>(undefined),
          link,
          outbox: yield* Ref.make(
            makeOutbox<UnsentLine>({ capacity: timing.capacity, pacing: timing.pacing })
          ),
          unfinished: yield* Ref.make<UnsentLine | undefined>(undefined),
          wake: yield* Queue.dropping<true>(1),
        };

        const pumping = yield* Effect.forkIn(pump(connection, held), own);

        yield* Ref.update(links, (all) =>
          new Map(all).set(connection, { ...held, pump: pumping, scope: own })
        );
        yield* Effect.logInfo("Dialling", { connection, ircd: output.ircd });
      });

    // Ends the Runtime's hold on a Connection once its `Closed` has been stepped.
    const forget = (connection: ConnectionId) =>
      Effect.flatMap(
        Ref.modify(links, (held) => [held.get(connection), without(held, connection)]),
        (gone) => (gone === undefined ? Effect.void : Scope.close(gone.scope, Exit.void))
      );

    // Queues a Line for its Connection, and wakes the pump without waiting for it. A Line
    // the Outbox refuses as full is given back, to be stepped as `Unsent`.
    const enqueue = (line: UnsentLine): Effect.Effect<readonly UnsentLine[]> =>
      Effect.gen(function* () {
        const held = yield* live(line.connection);

        if (held === undefined) {
          yield* Effect.logDebug("Not sent: no such Connection", { connection: line.connection });

          return [];
        }

        const queued = yield* Ref.modify(held.outbox, (waiting) => {
          const offered = offer(waiting, line, commandOf(line));

          return [offered._tag, offered._tag === "Queued" ? offered.outbox : waiting];
        });

        if (queued === "Full") {
          yield* Effect.logWarning("Not sent: the Connection's queue is full", {
            connection: line.connection,
          });

          return [line];
        }

        yield* Queue.offer(held.wake, true);

        return [];
      });

    // The pump drains before it hangs up. While the Network stops, the drain takes at most
    // half of the stop's bound, so the `QUIT` and the Transport's own close fit in the rest.
    const hangup = (connection: ConnectionId) =>
      Effect.gen(function* () {
        const held = yield* live(connection);

        if (held === undefined) {
          return;
        }

        const stopping = yield* Ref.get(network.stopping);

        const drain = stopping
          ? Math.min(timing.hangupDrain, timing.stopTimeout / 2)
          : timing.hangupDrain;

        const at = yield* now;

        yield* Ref.update(held.hangup, (set) => set ?? Instant.make(at + drain));
        yield* Queue.offer(held.wake, true);
      });

    // Each output, carried out, with any Line the Outbox refused.
    const carryOut = (output: Output): Effect.Effect<readonly UnsentLine[]> => {
      switch (output._tag) {
        case "Dial": {
          return Effect.as(dial(output.connection, output), []);
        }

        case "Send":
        case "SendSecret": {
          return enqueue(output);
        }

        case "Hangup": {
          return Effect.as(hangup(output.connection), []);
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
    // with `of`, then carry them out. Lines the Outbox refused are given back, one
    // `Unsent` for each Connection, in order.
    const once = (make: (at: Instant) => Input) =>
      Effect.gen(function* () {
        const input = make(yield* now);
        const sequence = yield* journal.append({ _tag: "Input", input, network: id });
        const before = yield* Ref.get(current);
        const step = yield* stepContained(client, before.state, input);
        const refused: UnsentLine[] = [];

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
          refused.push(...(yield* carryOut(output)));
        }

        const unsent = Map.groupBy(refused, (line) => line.connection);

        return {
          more: [...unsent].map(([connection, outputs]) => (at: Instant): Input => ({
            _tag: "Unsent",
            at,
            connection,
            outputs,
          })),
          news: step.news,
          sequence,
        };
      });

    const advance = (first: (at: Instant) => Input) =>
      Effect.gen(function* () {
        const stepped = yield* once(first);
        const work = [...stepped.more];

        for (let next = work.shift(); next !== undefined; next = work.shift()) {
          work.push(...(yield* once(next)).more);
        }

        return { news: stepped.news, sequence: stepped.sequence };
      });

    // Once a `Stopping` has been stepped, the Network is drained when it holds no
    // Connection.
    const checkDrained = Effect.gen(function* () {
      const stopping = yield* Ref.get(network.stopping);
      const held = yield* Ref.get(links);

      if (stopping && held.size === 0) {
        yield* network.drained.open;
      }
    });

    // A Connection that ended: its pump stops, and what never left is stepped as
    // `Unsent` while the Connection is still current, then its `Closed`.
    const closed = (connection: ConnectionId, event: LinkEvent) =>
      Effect.gen(function* () {
        const held = yield* live(connection);

        if (held !== undefined) {
          yield* Fiber.interrupt(held.pump);

          // What the cutoff dropped, the secret half written, and what still waits, at once.
          const left = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const cut = yield* Ref.getAndSet(held.dropped, []);
              const unfinished = yield* Ref.getAndSet(held.unfinished, undefined);

              const waiting = yield* Ref.modify(held.outbox, (outbox) => {
                const emptied = takeAll(outbox);

                return [emptied.items, emptied.outbox];
              });

              return [...cut, ...(unfinished === undefined ? [] : [unfinished]), ...waiting];
            })
          );

          if (left.length > 0) {
            yield* advance((at) => ({ _tag: "Unsent", at, connection, outputs: left }));
          }
        }

        yield* advance((at) => linkInput(connection, event, at));
        yield* forget(connection);
        yield* checkDrained;
      });

    // What a cutoff dropped, stepped as `Unsent`, unless the `Closed` took it first.
    const dropped = (connection: ConnectionId) =>
      Effect.gen(function* () {
        const held = yield* live(connection);
        const left = held === undefined ? [] : yield* Ref.getAndSet(held.dropped, []);

        if (left.length > 0) {
          yield* advance((at) => ({ _tag: "Unsent", at, connection, outputs: left }));
        }
      });

    const take = (pending: Pending) => {
      switch (pending._tag) {
        // Once stopping, an Owner input is never stepped. Its caller waits until the
        // Network stops, and hears `NetworkStopped`.
        case "Owner": {
          return Effect.flatMap(Ref.get(network.stopping), (stopping) =>
            stopping
              ? Effect.void
              : Effect.flatMap(advance(pending.input), (stepped) =>
                  Deferred.succeed(pending.done, stepped)
                )
          );
        }

        case "Stopping": {
          return Effect.andThen(
            Ref.set(network.stopping, true),
            Effect.andThen(
              advance((at) => ({ _tag: "Stopping", at })),
              checkDrained
            )
          );
        }

        case "Link": {
          return pending.event._tag === "Closed"
            ? closed(pending.connection, pending.event)
            : advance((at) => toInput(pending, at));
        }

        case "Dropped": {
          return dropped(pending.connection);
        }

        case "Due":
        case "Unfilled": {
          return advance((at) => toInput(pending, at));
        }

        default: {
          return pending satisfies never;
        }
      }
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

    const driver = yield* Effect.scoped(drive(ports, network, restarted)).pipe(
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

    yield* Ref.set(network.driver, driver);

    // A driver forked into a Scope already closing is interrupted before it starts, so
    // its `onInterrupt` never runs. A driver that has ended by now has stopped either way.
    if (driver.pollUnsafe() !== undefined) {
      yield* stop(network, runtimeClosed);
    }

    return network;
  });

/**
 * Gives a Network an Owner input, and waits until it is journaled and stepped.
 * @param network - The Network.
 * @param input - The input, given its `at` when its turn comes.
 * @returns The input's sequence and its own step's News, or `NetworkStopped`.
 */
export const tell = <S>(
  network: Network<S>,
  input: (at: Instant) => Input
): Effect.Effect<Stepped, NetworkStopped> =>
  Effect.flatMap(Deferred.make<Stepped>(), (done) =>
    Effect.raceFirst(
      Effect.andThen(
        Queue.offer(network.queue, { _tag: "Owner", done, input }),
        Deferred.await(done)
      ),
      Deferred.await(network.stopped)
    )
  );

/**
 * Stops a running Network gracefully: steps a `Stopping`, which the Client answers with a
 * `QUIT` and a `Hangup` on each Connection, and waits for every Connection's `Closed`,
 * for at most `stopTimeout`. A Network already stopped gets no `Stopping`. The caller
 * then closes the Network's Scope.
 * @param network - The Network.
 * @param stopTimeout - How long to wait, in milliseconds.
 * @returns An Effect that completes once the Network is drained, has stopped, or the
 * bound has run out.
 */
export const stopGracefully = <S>(network: Network<S>, stopTimeout: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    const status = yield* Ref.get(network.status);

    if (status._tag === "Stopped") {
      return;
    }

    const drained = Effect.andThen(
      Queue.offer(network.queue, { _tag: "Stopping" }),
      network.drained.await
    );

    const finished = yield* Effect.raceFirst(
      Effect.as(drained, true),
      Effect.as(Effect.ignore(Deferred.await(network.stopped)), true)
    ).pipe(Effect.timeoutOption(stopTimeout));

    if (finished._tag === "None") {
      yield* Effect.logWarning("A Connection did not close in time, so it is cut off", {
        network: network.id,
        stopTimeout,
      });
    }
  });

/**
 * Stops a Network's driver: its pumps and timers stop, and its Connections' Scopes close,
 * which ends each Connection at once, with no hang-up to wait for.
 * @param network - The Network.
 * @returns An Effect that completes once the driver has stopped.
 */
export const halt = <S>(network: Network<S>): Effect.Effect<void> =>
  Effect.flatMap(Ref.get(network.driver), (driver) =>
    driver === undefined ? Effect.void : Fiber.interrupt(driver)
  );

/** One Connection the Runtime holds, and how its queue stands. */
export interface HeldConnection {
  readonly connection: ConnectionId;
  /** How many Lines wait to leave. */
  readonly queued: number;
  /** When the next Line may leave, or `undefined` if none is waiting. */
  readonly nextAt: Instant | undefined;
}

/**
 * The Connections a Network holds, each with its queue.
 * @param network - The Network.
 * @returns Them, in the order they were dialled.
 */
export const heldConnections = <S>(network: Network<S>): Effect.Effect<readonly HeldConnection[]> =>
  Effect.gen(function* () {
    const at = yield* now;
    const held = yield* Ref.get(network.links);

    return yield* Effect.forEach([...held], ([connection, { outbox }]) =>
      Effect.map(Ref.get(outbox), (waiting) => {
        const next = nextAt(waiting, at);

        return {
          connection,
          nextAt: next === undefined ? undefined : Instant.make(next),
          queued: depth(waiting),
        };
      })
    );
  });
