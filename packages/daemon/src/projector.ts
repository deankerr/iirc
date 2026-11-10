/**
 * The projector: keeps the Timeline store folded up to the Journal, by following the
 * Runtime's News as any other reader does and stepping the Timelines fold over it.
 *
 * @packageDocumentation
 */
import { Runtime } from "@iirc/runtime";
import { Sequence } from "@iirc/runtime/journal";
import type { JournalFailed } from "@iirc/runtime/journal";
import { TimelineStore, TimelineStoreFailed } from "@iirc/timeline-store";
import { emptyDirectory, projectionVersion, step } from "@iirc/timelines";
import { Cause, Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect";

/**
 * Whether the store is being kept up to date. `Running` while it follows News, and
 * `Stopped` once a failure stopped it, which a restart of the Daemon retries.
 */
export type ProjectorStatus =
  | { readonly _tag: "Running" }
  | { readonly _tag: "Stopped"; readonly reason: string };

/** The projector, as the Daemon holds it: whether it is still running. */
export class Projector extends Context.Service<
  Projector,
  { readonly status: Effect.Effect<ProjectorStatus> }
>()("@iirc/daemon/Projector") {}

const decodeAfter = Schema.decodeUnknownEffect(Schema.UndefinedOr(Sequence));

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

/** Folds each step the Runtime's News gives into the store, for as long as it runs. */
const project = Effect.gen(function* () {
  const runtime = yield* Runtime;
  const store = yield* TimelineStore;
  const { after, directory } = yield* resume;

  yield* runtime.news({ after }).pipe(
    Stream.runFoldEffect(
      () => directory,
      (before, happened) => {
        const stepped = step(before, happened);

        return store
          .apply({
            changes: stepped.changes,
            directory: stepped.directory,
            through: happened.sequence,
          })
          .pipe(Effect.as(stepped.directory));
      }
    )
  );
});

/**
 * The projector, for as long as the Layer lives. It reads News as an independent reader,
 * so it never holds up the Runtime or a Network. A failure stops it, is logged, and shows
 * in its status, and the Daemon goes on. Closing the Layer interrupts it, and an apply in
 * flight is kept whole or not at all.
 */
export const layerProjector = Layer.effect(Projector)(
  Effect.gen(function* () {
    const status = yield* Ref.make<ProjectorStatus>({ _tag: "Running" });

    // A failure says why in its reason. Anything else is a defect, said in full.
    const stopped = (cause: Cause.Cause<TimelineStoreFailed | JournalFailed>) =>
      Effect.gen(function* () {
        const reason = Option.match(Cause.findErrorOption(cause), {
          onNone: () => Cause.pretty(cause),
          onSome: (error) => `${error._tag}: ${error.reason}`,
        });

        yield* Ref.set(status, { _tag: "Stopped", reason });
        yield* Effect.logError(
          "The Timelines stopped being folded, until the Daemon restarts"
        ).pipe(Effect.annotateLogs({ reason }));
      });

    yield* project.pipe(
      Effect.catchCauseIf((cause) => !Cause.hasInterruptsOnly(cause), stopped),
      Effect.forkScoped
    );

    return { status: Ref.get(status) };
  })
);
