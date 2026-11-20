/**
 * The Tail, as atoms: read whole, then followed after its last line, while a Pane shows
 * it, and the lines the view shows, derived from what is held. A Daemon that restarted is
 * another Daemon, whose Tail is read again from its start.
 *
 * @packageDocumentation
 */
import type { TailLevel } from "@iirc/api";
import { lastNumber, linesShown, reduceTail } from "@iirc/frontend/tail";
import type { HeldTail, TailEvent } from "@iirc/frontend/tail";
import { Effect, Option, Ref, Schedule, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { signedIn } from "../sign-in/atoms.ts";
import { retrying, Waits } from "../timelines/atoms.ts";

/** The least level the view shows, until the Owner can choose it. */
const least: TailLevel = "Info";

/**
 * The Tail held, each time it changes, while the page is signed in and something reads
 * it. With nothing held, the Tail is read whole, and then followed after its last line.
 * Whenever the stream ends, as when the Daemon restarts, or gives nothing for longer than
 * three heartbeats, it is followed again from the last line held. A stream of another
 * Daemon than the one held lets go of what is held, so the Tail is read again. A failure
 * is tried again, a refusal too, until what follows the other streams signs the page out.
 */
const followed = runtime.atom((get) =>
  get(signedIn)
    ? Stream.unwrap(
        Effect.gen(function* () {
          const client = yield* DaemonClient;
          const { idle, reconnect } = yield* Waits;
          const schedule = yield* retrying;
          const held = yield* Ref.make<HeldTail | undefined>(undefined);

          const step = (event: TailEvent) =>
            Ref.updateAndGet(held, (before) => reduceTail(before, event));

          // Once: the Tail read when none is held, then the stream after its last line, until
          // it is of another Daemon, which lets go of what is held.
          const once = Effect.gen(function* () {
            const before = yield* Ref.get(held);

            const start =
              before ??
              (yield* client.tail.read().pipe(
                Effect.timeout(idle),
                Effect.flatMap((read) => step({ _tag: "Read", read }))
              ));

            const after = start === undefined ? undefined : lastNumber(start);

            // The stream is opened only once what was read is given, so a stream that cannot
            // open never hides the Tail read, and its retries follow from the read's last line.
            const live = Stream.unwrap(
              client.tail
                .changes({ headers: {}, query: after === undefined ? {} : { after } })
                .pipe(Effect.timeout(idle))
            ).pipe(
              Stream.timeout(idle),
              Stream.map((event): TailEvent | undefined => {
                if (event.event === "daemon") {
                  return { _tag: "Opened", daemon: event.data };
                }

                return event.event === "line" ? { _tag: "Logged", line: event.data } : undefined;
              }),
              Stream.filter((event): event is TailEvent => event !== undefined),
              Stream.mapEffect(step),
              Stream.takeWhile((now) => now !== undefined)
            );

            return before === undefined ? Stream.concat(Stream.make(start), live) : live;
          });

          return Stream.unwrap(once).pipe(
            Stream.retry(schedule),
            Stream.repeat(Schedule.spaced(reconnect)),
            Stream.filter((now): now is HeldTail => now !== undefined),
            Stream.changes
          );
        })
      )
    : Stream.empty
);

/** The Tail held, or none until it is read. */
const tailHeld = Atom.make((get): HeldTail | undefined =>
  Option.getOrUndefined(AsyncResult.value(get(followed)))
);

/** The Daemon's version, once the Tail is read. */
export const tailVersion = Atom.make((get) => get(tailHeld)?.version);

/** The lines the view shows, oldest first: those at Info and above. */
export const tailShown = Atom.make((get) => {
  const held = get(tailHeld);

  return held === undefined ? [] : linesShown(held, least);
});
