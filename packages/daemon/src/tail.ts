import type { TailDaemon, TailLine, TailRead } from "@iirc/api";
import { TailLevel } from "@iirc/api";
/**
 * The Tail: the most recent of what the Daemon logged, in its memory. It is made of the
 * Daemon's own loggers' lines and nothing else, so nothing is journaled for it, and a
 * restart starts it again from the line the Daemon logs as it starts.
 *
 * @packageDocumentation
 */
import { Instant } from "@iirc/client";
import {
  Cause,
  Clock,
  Context,
  Effect,
  Formatter,
  Layer,
  Logger,
  Predicate,
  PubSub,
  References,
  Schema,
  Stream,
} from "effect";

/** How many lines the Tail holds. One more drops the oldest. */
export const tailCapacity = 4096;

/**
 * The words of a logged value, as text.
 * @param value - Whatever was logged, which may be anything.
 * @returns A string as it is, and anything else formatted on one line.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a log call takes any value, and this is where it becomes text
const textOf = (value: unknown): string =>
  Predicate.isString(value) ? value : Formatter.format(value, { space: 0 });

const decodeLevel = Schema.decodeUnknownOption(TailLevel);

/**
 * The Tail's Logger: it keeps every line from `Debug` up, with its words, its fiber's
 * annotations, and its cause as text.
 * @param keep - Where a line goes.
 * @returns The Logger.
 */
const loggerKeeping = (keep: (line: Omit<TailLine, "n">) => void) =>
  Logger.make(({ cause, date, fiber, logLevel, message }: Logger.Options<unknown>) => {
    const level = decodeLevel(logLevel);

    if (level._tag === "None") {
      return;
    }

    const annotations = fiber.getRef(References.CurrentLogAnnotations);

    const line = {
      annotations: Object.fromEntries(
        Object.entries(annotations).map(([name, value]) => [name, textOf(value)])
      ),
      at: Instant.make(date.getTime()),
      level: level.value,
      message: (Array.isArray(message) ? message : [message]).map(textOf).join(" "),
    };

    keep(cause.reasons.length > 0 ? { ...line, cause: Cause.pretty(cause) } : line);
  });

/** The Tail, which a Frontend reads and follows. */
export class Tail extends Context.Service<
  Tail,
  {
    /** Which Daemon it is of: its version, and the instant it started. */
    readonly daemon: TailDaemon;
    /** The Tail whole, oldest first. */
    readonly read: Effect.Effect<TailRead>;
    /**
     * The lines held after `after`, every line held without it, and then each line as it
     * is logged, none missed or doubled across the two.
     */
    readonly follow: (after?: number) => Stream.Stream<TailLine>;
    /** The Logger that keeps what is logged in the Tail. */
    readonly logger: Logger.Logger<unknown, unknown>;
  }
>()("@iirc/daemon/Tail") {}

/**
 * Makes the Tail, empty, of a Daemon that starts now.
 * @param version - The Daemon's version.
 * @returns The Tail.
 */
const make = (version: string) =>
  Effect.gen(function* () {
    const started = Instant.make(yield* Clock.currentTimeMillis);

    const live = yield* Effect.acquireRelease(
      PubSub.sliding<TailLine>(tailCapacity),
      PubSub.shutdown
    );

    // Both are changed together, by a Logger that runs without yielding, so a reader sees
    // the lines held and the last number as they were at one moment.
    const held: TailLine[] = [];
    let last = 0;

    const logger = loggerKeeping((line) => {
      last += 1;

      const kept: TailLine = { ...line, n: last };

      held.push(kept);

      if (held.length > tailCapacity) {
        held.shift();
      }

      PubSub.publishUnsafe(live, kept);
    });

    const follow = (after?: number) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribed before the lines held are read, so a line logged in between is in
          // both, and the live ones are told apart by their numbers.
          const subscription = yield* PubSub.subscribe(live);
          const through = Math.max(last, after ?? 0);
          const missed = held.filter((line) => after === undefined || line.n > after);

          return Stream.fromIterable(missed).pipe(
            Stream.concat(
              Stream.fromSubscription(subscription).pipe(Stream.filter((line) => line.n > through))
            )
          );
        })
      );

    return {
      daemon: { started, version },
      follow,
      logger,
      read: Effect.sync(() => ({ lines: [...held], started, version })),
    };
  });

/**
 * The Tail alone, empty, of a Daemon that starts when the Layer is built. It keeps
 * nothing until its `logger` is in force.
 * @param version - The Daemon's version.
 * @returns The Layer.
 */
export const layerTail = (version: string) => Layer.effect(Tail)(make(version));

/**
 * The Tail, with everything the Daemon logs from here on kept in it: its Logger added to
 * those in force, every level from `Debug` up let through, and the line the Daemon logs as
 * it starts, which is the Tail's first. Whatever Logger is in force outside still gets
 * only the levels it asks for, as `layerLogger` asks for `Info` and above.
 * @param version - The Daemon's version.
 * @returns The Layer, which what it provides to is logged into the Tail.
 */
export const layerTailLogging = (version: string) =>
  Layer.effectDiscard(
    Effect.logInfo("Starting daemon").pipe(Effect.annotateLogs({ version }))
  ).pipe(
    Layer.provideMerge(
      Layer.merge(
        Layer.unwrap(
          Tail.useSync((tail) => Logger.layer([tail.logger], { mergeWithExisting: true }))
        ),
        Layer.succeed(References.MinimumLogLevel, "Debug")
      )
    ),
    Layer.provideMerge(layerTail(version))
  );
