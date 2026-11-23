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
import type { CloseOutcome, NetworkStopped } from "@iirc/runtime";
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
 * The Timeline as its Network's Client can name it, or `undefined` when none can: its
 * Network was removed, or it is detached, with no key.
 * @param summary - The Timeline.
 * @returns It, resolved.
 */
const resolvedOf = (summary: Summary): Resolved | undefined => {
  if (summary.removed) {
    return undefined;
  }

  if (summary.kind === "Network") {
    return { _tag: "Network" };
  }

  return summary.key === null
    ? undefined
    : { _tag: summary.kind, key: summary.key, name: summary.name };
};

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
 * Marks a Timeline read up to an instant, by its id. A Read Marker moves only forward,
 * whichever way it is marked. A Network removed between finding the Timeline and stepping
 * its Client is marked by a Change, as its kept Timelines are.
 * @param id - The Timeline's id.
 * @param read - The instant read up to.
 * @returns The sequence it was journaled at.
 */
export const readTimeline = (
  id: TimelineId,
  read: Instant
): Effect.Effect<Sequence, MarkingFailed, Runtime | TimelineStore | Journal> =>
  Effect.gen(function* () {
    const summary = yield* found(id);
    const network = NetworkId.make(summary.network);
    const byChange = journaled({ _tag: "TimelineRead", network, read, timeline: summary.id });
    const target = resolvedOf(summary);

    if (target === undefined) {
      return yield* byChange;
    }

    const runtime = yield* Runtime;

    return yield* runtime
      .read(network, { read, target })
      .pipe(Effect.catchTag("UnknownNetwork", () => byChange));
  });

/**
 * Closes a Timeline, by its id. The Network's own is never closed, and a Channel Self is
 * in is refused by its Client as `Joined`. A Network removed between finding the Timeline
 * and stepping its Client is closed by a Change, as its kept Timelines are.
 * @param id - The Timeline's id.
 * @returns What it came to, and the sequence it was journaled at.
 */
export const closeTimeline = (
  id: TimelineId
): Effect.Effect<CloseOutcome, MarkingFailed, Runtime | TimelineStore | Journal> =>
  Effect.gen(function* () {
    const summary = yield* found(id);
    const network = NetworkId.make(summary.network);

    // The fold closes nothing of a Network's own Timeline, so this is journaled and refused.
    const byChange = Effect.map(
      journaled({ _tag: "TimelineClosed", network, timeline: summary.id }),
      (sequence): CloseOutcome =>
        summary.kind === "Network"
          ? { _tag: "Refused", reason: { _tag: "NoTimeline" }, sequence }
          : { _tag: "Closed", sequence }
    );

    const target = resolvedOf(summary);

    if (target === undefined) {
      return yield* byChange;
    }

    const runtime = yield* Runtime;

    return yield* runtime
      .close(network, target)
      .pipe(Effect.catchTag("UnknownNetwork", () => byChange));
  });
