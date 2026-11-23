/**
 * Marking a Timeline read, or closing it, by its id (ADR 0018). A Timeline a Network's
 * Client can name is given to that Client as the projection holds it, so it is decided and
 * reported as a Target's is. One no Client can name, a detached Direct Message Timeline or
 * one a removed Network kept, is marked by a Change the Timelines projection folds.
 *
 * @packageDocumentation
 */
import type { Instant, Resolved } from "@iirc/client";
import { Runtime } from "@iirc/runtime";
import type { CloseOutcome, Living, NetworkStopped, UnknownNetwork } from "@iirc/runtime";
import { Journal, NetworkId } from "@iirc/runtime/journal";
import type { Change, JournalFailed, Sequence } from "@iirc/runtime/journal";
import { TimelineStore } from "@iirc/timeline-store";
import type { Summary, TimelineStoreFailed } from "@iirc/timeline-store";
import { TimelineId } from "@iirc/timelines";
import { Effect, Schema } from "effect";

/** No Timeline has the id: it was never given, or its Network was removed and it was dropped. */
export class TimelineUnknown extends Schema.TaggedError<
  TimelineUnknown,
  { readonly brand: unique symbol }
>()("TimelineUnknown", { timeline: TimelineId }) {}

/** Why a Timeline could not be marked or closed by its id. */
export type MarkingFailed = TimelineUnknown | NetworkStopped | TimelineStoreFailed | JournalFailed;

/**
 * How a Timeline is marked, by what the Runtime holds of its Network now rather than what the
 * store last folded, which may lag a removal: through its Client, as the Timeline's `where`,
 * by a Change, for one detached or of a removed Network that kept it, or not at all, for one
 * whose Network was removed without keeping it, or given its id again.
 */
export type Route =
  | { readonly _tag: "Client"; readonly target: Resolved }
  | { readonly _tag: "Change" }
  | { readonly _tag: "Unknown" };

/**
 * How a Timeline is marked, given what the Runtime holds of its Network now.
 * @param summary - The Timeline, as the store holds it.
 * @param living - Its Network as the Runtime holds it now, or `undefined` when it holds none.
 * @returns The route.
 */
export const routeOf = (summary: Summary, living: Living | undefined): Route => {
  if (living === undefined || living.life !== summary.life) {
    return { _tag: "Unknown" };
  }

  if (living._tag === "Kept") {
    return { _tag: "Change" };
  }

  if (summary.kind === "Network") {
    return { _tag: "Client", target: { _tag: "Network" } };
  }

  return summary.key === null
    ? { _tag: "Change" }
    : { _tag: "Client", target: { _tag: summary.kind, key: summary.key, name: summary.name } };
};

const livingOf = (network: NetworkId) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime;
    const lives = yield* runtime.lives;

    return lives.get(network);
  });

// The Timeline the id names, a merged one's being the one it went to.
const found = (id: TimelineId) =>
  TimelineStore.use((store) => store.timeline(id)).pipe(
    Effect.flatMap((summary) =>
      Effect.fromOption(summary).pipe(Effect.mapError(() => new TimelineUnknown({ timeline: id })))
    )
  );

// Journals a Change for a Timeline no Client can name.
const journaled = (change: Change) =>
  Journal.use((journal) => journal.append({ _tag: "Change", change }));

/**
 * Marks the Timeline an id names, through its Client or by a Change. A Network removed
 * while its Client is stepped is found again: one that kept its Timelines has them marked by
 * a Change, and one that did not leaves the id unknown.
 * @param id - The Timeline's id.
 * @param byClient - Marks it through its Network's Client, as the Timeline's `where`.
 * @param byChange - Marks it by a Change.
 * @returns What marking it came to.
 */
const marking = <A>(
  id: TimelineId,
  byClient: (
    network: NetworkId,
    target: Resolved
  ) => Effect.Effect<A, UnknownNetwork | NetworkStopped>,
  byChange: (summary: Summary, network: NetworkId) => Effect.Effect<A, JournalFailed, Journal>
): Effect.Effect<A, MarkingFailed, Runtime | TimelineStore | Journal> =>
  Effect.gen(function* () {
    const summary = yield* found(id);
    const network = NetworkId.make(summary.network);
    const unknown = new TimelineUnknown({ timeline: summary.id });
    const route = routeOf(summary, yield* livingOf(network));

    // A Client step that failed finds the Network again: removed keeping the Timeline, it is
    // marked by a Change, still live in its life, the failure stands, and otherwise the
    // Timeline is unknown.
    const afterFailing = (failure: MarkingFailed) =>
      Effect.flatMap(livingOf(network), (living): Effect.Effect<A, MarkingFailed, Journal> => {
        if (living === undefined || living.life !== summary.life) {
          return Effect.fail(unknown);
        }

        return living._tag === "Kept" ? byChange(summary, network) : Effect.fail(failure);
      });

    switch (route._tag) {
      case "Unknown": {
        return yield* unknown;
      }

      case "Change": {
        return yield* byChange(summary, network);
      }

      case "Client": {
        return yield* byClient(network, route.target).pipe(
          Effect.catchTags({
            NetworkStopped: (stopped) => afterFailing(stopped),
            UnknownNetwork: () => afterFailing(unknown),
          })
        );
      }

      default: {
        return route satisfies never;
      }
    }
  });

/**
 * Marks a Timeline read up to an instant, by its id. A Read Marker moves only forward,
 * whichever way it is marked.
 * @param id - The Timeline's id.
 * @param read - The instant read up to.
 * @returns The sequence it was journaled at.
 */
export const readTimeline = (
  id: TimelineId,
  read: Instant
): Effect.Effect<Sequence, MarkingFailed, Runtime | TimelineStore | Journal> =>
  Effect.gen(function* () {
    const runtime = yield* Runtime;

    return yield* marking(
      id,
      (network, target) => runtime.read(network, { read, target }),
      (summary, network) => journaled({ _tag: "TimelineRead", network, read, timeline: summary.id })
    );
  });

/**
 * Closes a Timeline, by its id. The Network's own is never closed, and a Channel Self is
 * in is refused by its Client as `Joined`.
 * @param id - The Timeline's id.
 * @returns What it came to, and the sequence it was journaled at.
 */
export const closeTimeline = (
  id: TimelineId
): Effect.Effect<CloseOutcome, MarkingFailed, Runtime | TimelineStore | Journal> =>
  Effect.gen(function* () {
    const runtime = yield* Runtime;

    return yield* marking(
      id,
      (network, target) => runtime.close(network, target),
      (summary, network) =>
        // The fold closes nothing of a Network's own Timeline, so this is journaled and refused.
        Effect.map(
          journaled({ _tag: "TimelineClosed", network, timeline: summary.id }),
          (sequence): CloseOutcome =>
            summary.kind === "Network"
              ? { _tag: "Refused", reason: { _tag: "NoTimeline" }, sequence }
              : { _tag: "Closed", sequence }
        )
    );
  });
