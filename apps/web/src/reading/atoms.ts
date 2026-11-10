/**
 * What is new, as atoms: the page's title, derived from the Daemon's counts, and marking
 * read. The core decides when the open Timeline is due to be marked read and up to what,
 * and the runtime waits until that has held for a moment, then asks the Daemon, which
 * keeps every Read Marker for every Frontend (ADR 0014).
 *
 * @packageDocumentation
 */
import { markDue, titleOf } from "@iirc/frontend/activity";
import type { MarkRead } from "@iirc/frontend/commands";
import { Effect, Option, Schedule, Stream } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import type { Outcome } from "../options/atoms.ts";
import { signedOut } from "../options/atoms.ts";
import { pageState } from "../page/atoms.ts";
import { signedIn } from "../sign-in/atoms.ts";
import { sidebarNetworks, timelinesState, Waits } from "../timelines/atoms.ts";

/** The page's title: how many Highlights and Direct Messages are unread, such as `(3) iirc`. */
export const documentTitle = Atom.make((get) => titleOf(get(sidebarNetworks)));

/** Whether the open Timeline is due to be marked read, and up to what, as the core says. */
const dueMark = Atom.make((get) => markDue(get(timelinesState), get(pageState)));

/**
 * Why the Daemon did not mark a Timeline read, in words, from its error's tag.
 * @param tag - The error's tag.
 * @param mark - The mark.
 * @returns What it came to.
 */
const refusedWith = (tag: string, mark: MarkRead): Outcome => {
  if (tag === "Unauthorized") {
    return { _tag: "SignedOut" };
  }

  // Marking read can be asked again freely, so the words only say it was not done.
  return {
    _tag: "NotDone",
    message:
      tag === "UnknownNetwork"
        ? `The Daemon has no Network ${mark.network}.`
        : `The Daemon did not mark ${mark.target ?? mark.network} read. Try /read again.`,
  };
};

/**
 * Asks the Daemon to mark a Timeline read.
 * @param mark - The Timeline, and how far.
 * @returns What it came to, in words when it was not done.
 */
export const markRead = (mark: MarkRead): Effect.Effect<Outcome, never, DaemonClient> =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;

    return yield* client.networks
      .read({
        params: { network: mark.network },
        payload: { read: mark.read, target: mark.target },
      })
      .pipe(
        Effect.as<Outcome>({ _tag: "Done" }),
        Effect.catch((error) => Effect.succeed(refusedWith(error._tag, mark)))
      );
  });

const sameMark = (left: MarkRead | undefined, right: MarkRead | undefined) =>
  left?.timeline === right?.timeline && left?.read === right?.read;

/**
 * Waits until what is due holds a condition, as it is now or once it changes.
 * @param registry - The registry.
 * @param holds - The condition.
 * @returns What was due when it held.
 */
const dueWhen = (
  registry: AtomRegistry.AtomRegistry,
  holds: (mark: MarkRead | undefined) => boolean
) =>
  AtomRegistry.toStream(registry, dueMark).pipe(
    Stream.filter(holds),
    Stream.take(1),
    Stream.runHead,
    Effect.map(Option.getOrUndefined)
  );

/**
 * Marks a Timeline read, and once the Daemon has, waits until what is due is something
 * else, as it is once the Daemon's Read Marker comes back on the changes.
 * @param registry - The registry.
 * @param mark - What is due.
 * @returns Once done, failing with what the Daemon said when it was not.
 */
const made = (registry: AtomRegistry.AtomRegistry, mark: MarkRead) =>
  markRead(mark).pipe(
    Effect.flatMap((outcome) => {
      switch (outcome._tag) {
        case "NotDone": {
          return Effect.fail(outcome);
        }

        case "SignedOut": {
          return Effect.sync(() => {
            signedOut(registry);
          });
        }

        case "Done": {
          return dueWhen(registry, (due) => !sameMark(due, mark)).pipe(Effect.asVoid);
        }

        default: {
          return outcome satisfies never;
        }
      }
    })
  );

/**
 * One round of marking read: wait until a mark is due, wait the moment out while it stays
 * due for the same Timeline, and make what is due then. Once made, wait until what is due
 * is something else, as it is once the Daemon's Read Marker comes back on the changes.
 * @param registry - The registry.
 * @returns Once the round is over, failing with what the Daemon said when it was not done.
 */
const markOnce = (registry: AtomRegistry.AtomRegistry) =>
  Effect.gen(function* () {
    const { settle } = yield* Waits;
    const first = yield* dueWhen(registry, (mark) => mark !== undefined);
    const timeline = first?.timeline;

    // Passing through a Timeline, it changes or stops being seen within the moment.
    const passed = yield* dueWhen(registry, (mark) => mark?.timeline !== timeline).pipe(
      Effect.as(true),
      Effect.timeoutOrElse({ duration: settle, orElse: () => Effect.succeed(false) })
    );

    const mark = registry.get(dueMark);

    if (!passed && mark !== undefined) {
      yield* made(registry, mark);
    }
  });

/**
 * Marks the open Timeline read whenever the core says it is due, round after round. A round
 * the Daemon did not do waits, longer each time, and is tried again.
 * @param registry - The registry.
 * @returns The marker, which runs until it is interrupted.
 */
const marker = (registry: AtomRegistry.AtomRegistry) =>
  Effect.gen(function* () {
    const { longest, retry } = yield* Waits;
    const backoff = Schedule.min([Schedule.exponential(retry), Schedule.spaced(longest)]);

    return yield* markOnce(registry).pipe(Effect.retry(backoff), Effect.forever);
  });

/**
 * While the browser is signed in, the open Timeline is marked read once the Owner has seen
 * its latest for a moment. Mounted once for the page.
 */
export const marking = runtime
  .atom((get) => (get(signedIn) ? marker(get.registry) : Effect.void))
  .pipe(Atom.keepAlive);
