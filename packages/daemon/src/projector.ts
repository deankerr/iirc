/**
 * The projector: keeps the Timeline store folded up to the Journal, by following the
 * Runtime's News as any other reader does and stepping the Timelines fold over it, with
 * each Change that marks a Timeline by its id folded in its place among the steps.
 *
 * @packageDocumentation
 */
import { Runtime } from "@iirc/runtime";
import type { Happening } from "@iirc/runtime";
import { Sequence } from "@iirc/runtime/journal";
import type { JournalFailed } from "@iirc/runtime/journal";
import { TimelineStore, TimelineStoreFailed } from "@iirc/timeline-store";
import { TimelineId, emptyDirectory, projectionVersion, step, stepMarking } from "@iirc/timelines";
import type { Directory, Marking, Stepped } from "@iirc/timelines";
import { Cause, Context, Effect, Layer, Option, Schema, Stream, SubscriptionRef } from "effect";

/**
 * Whether the store is being kept up to date. `Running` while it follows News, and
 * `Stopped` once a failure stopped it, which a restart of the Daemon retries.
 */
export type ProjectorStatus =
  | { readonly _tag: "Running" }
  | { readonly _tag: "Stopped"; readonly reason: string };

/**
 * How far the store has been folded, as the projector last said: the projection version it
 * folds by, and the last sequence folded, each `undefined` before it is known.
 */
export interface Progress {
  readonly version: number | undefined;
  readonly through: number | undefined;
}

/**
 * The projector, as the Daemon holds it: whether it is still running, and how far it has
 * folded, for a reader to wait on rather than poll.
 */
export class Projector extends Context.Service<
  Projector,
  {
    readonly status: Effect.Effect<ProjectorStatus>;
    /** Whether it is running, given now and again when it stops. */
    readonly statuses: Stream.Stream<ProjectorStatus>;
    /**
     * The version and the last sequence folded into the store, together, given now and
     * again each time either changes: when the store is reset to a version, which takes its
     * `through` back to `undefined`, and each time a step is applied.
     */
    readonly folded: Stream.Stream<Progress>;
  }
>()("@iirc/daemon/Projector") {}

const decodeAfter = Schema.decodeUnknownEffect(Schema.UndefinedOr(Sequence));

const timelineOf = Schema.decodeUnknownOption(TimelineId);

/**
 * A Change that marks a Timeline by its id, as the fold takes it, or `undefined` for any
 * other Change, or one whose id is no Timeline's, which marks nothing.
 * @param happening - A Change, and its sequence.
 * @returns The marking.
 */
const markingOf = (
  happening: Extract<Happening, { readonly _tag: "Changed" }>
): Marking | undefined => {
  const { change, sequence } = happening;

  if (change._tag !== "TimelineRead" && change._tag !== "TimelineClosed") {
    return undefined;
  }

  return Option.getOrUndefined(
    Option.map(timelineOf(change.timeline), (timeline): Marking =>
      change._tag === "TimelineRead"
        ? { _tag: change._tag, network: change.network, read: change.read, sequence, timeline }
        : { _tag: change._tag, network: change.network, sequence, timeline }
    )
  );
};

/**
 * What one happening gives the store: a step's News folded, or a Change that marks a
 * Timeline folded, with the sequence it folds through, or `undefined` for a Change the
 * Timelines take no part in.
 * @param before - The directory before it.
 * @param happening - What happened.
 * @returns The fold's result and its sequence.
 */
const folding = (
  before: Directory,
  happening: Happening
): { readonly stepped: Stepped; readonly through: number } | undefined => {
  if (happening._tag === "Stepped") {
    return { stepped: step(before, happening.happened), through: happening.happened.sequence };
  }

  const marking = markingOf(happening);

  return marking === undefined
    ? undefined
    : { stepped: stepMarking(before, marking), through: happening.sequence };
};

/**
 * Where folding starts: after the last step the store folded, with the directory it kept,
 * or from the start, empty, when the store was built by another projection version or none.
 * @returns The sequence to follow News after, and the directory to fold from.
 */
const resume = Effect.gen(function* () {
  const store = yield* TimelineStore;
  const folded = yield* store.folded;

  if (folded.version === projectionVersion) {
    const after = yield* decodeAfter(folded.through).pipe(
      Effect.mapError(
        () => new TimelineStoreFailed({ reason: `it says it folded through ${folded.through}` })
      )
    );

    return { after, directory: yield* store.directory };
  }

  yield* Effect.logInfo("Folding the Timelines again from the start of the Journal").pipe(
    Effect.annotateLogs({ found: folded.version ?? "none", version: projectionVersion })
  );
  yield* store.reset(projectionVersion);

  return { after: undefined, directory: emptyDirectory };
});

/**
 * Folds each step the Runtime's News gives, and each Change that marks a Timeline, into the
 * store in Journal order, for as long as it runs, and says how far it has folded: once it
 * has resumed or reset the store, and once each is kept.
 * @param progress - Where it says how far it has folded, and by which version.
 * @returns The fold, which never ends but by failing or being interrupted.
 */
const project = (progress: SubscriptionRef.SubscriptionRef<Progress>) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime;
    const store = yield* TimelineStore;
    const { after, directory } = yield* resume;

    // Resumed, or reset to the version and folding from the start.
    yield* SubscriptionRef.set(progress, { through: after, version: projectionVersion });
    yield* runtime.happenings({ after }).pipe(
      Stream.runFoldEffect(
        () => directory,
        (before, happening) => {
          const folded = folding(before, happening);

          if (folded === undefined) {
            return Effect.succeed(before);
          }

          const { stepped, through } = folded;

          return store
            .apply({ changes: stepped.changes, directory: stepped.directory, through })
            .pipe(
              Effect.andThen(
                SubscriptionRef.set(progress, { through, version: projectionVersion })
              ),
              Effect.as(stepped.directory)
            );
        }
      )
    );
  });

/**
 * The projector, for as long as the Layer lives. It reads News as an independent reader,
 * so it never holds up the Runtime or a Network, and says how far it has folded without
 * knowing who waits on it. A failure stops it, is logged, and shows
 * in its status, and the Daemon goes on. Closing the Layer interrupts it, and an apply in
 * flight is kept whole or not at all.
 */
export const layerProjector = Layer.effect(Projector)(
  Effect.gen(function* () {
    const status = yield* SubscriptionRef.make<ProjectorStatus>({ _tag: "Running" });

    const folded = yield* SubscriptionRef.make<Progress>({
      through: undefined,
      version: undefined,
    });

    // A failure says why in its reason. Anything else is a defect, said in full.
    const stopped = (cause: Cause.Cause<TimelineStoreFailed | JournalFailed>) =>
      Effect.gen(function* () {
        const reason = Option.match(Cause.findErrorOption(cause), {
          onNone: () => Cause.pretty(cause),
          onSome: (error) => `${error._tag}: ${error.reason}`,
        });

        yield* SubscriptionRef.set(status, { _tag: "Stopped", reason });
        yield* Effect.logError(
          "The Timelines stopped being folded, until the Daemon restarts"
        ).pipe(Effect.annotateLogs({ reason }));
      });

    yield* project(folded).pipe(
      Effect.catchCauseIf((cause) => !Cause.hasInterruptsOnly(cause), stopped),
      Effect.forkScoped
    );

    return {
      folded: SubscriptionRef.changes(folded),
      status: SubscriptionRef.get(status),
      statuses: SubscriptionRef.changes(status),
    };
  })
);
