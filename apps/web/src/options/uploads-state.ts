/**
 * The Uploads the options list, as the core folds them, apart from what reads and follows
 * them, so the one changes stream of the Timelines can learn where one was said without
 * depending on either. Saying a Message makes no Upload Change, so an Upload held whose
 * link a Message of ours in a change holds is read again, and the Daemon's answer folded in.
 *
 * @packageDocumentation
 */
import type { TimelineItem } from "@iirc/api";
import { initialUploads, reduceUploads, saidIn } from "@iirc/frontend/uploads";
import type { UploadsEvent } from "@iirc/frontend/uploads";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { signedIn } from "../sign-in/atoms.ts";

/** The Uploads held, newest first, as the core folds them. */
export const uploadsState = Atom.make(initialUploads).pipe(Atom.keepAlive);

/**
 * Folds one event into the Uploads held, unless the page is signed out, so what signing
 * out forgot stays forgotten whatever lands after it.
 * @param registry - The registry.
 * @param event - What happened.
 */
export const uploadsHappened = (registry: AtomRegistry.AtomRegistry, event: UploadsEvent) => {
  if (event._tag === "Forgotten" || registry.get(signedIn)) {
    registry.set(uploadsState, reduceUploads(registry.get(uploadsState), event));
  }
};

/**
 * Reads again each Upload held whose link a Message of ours among a change's items holds,
 * and folds in where it was said, as the Daemon now answers. A read that fails changes
 * nothing: the next change, or the next page, says it again.
 * @param registry - The registry.
 * @param items - The items the change gave.
 * @returns Once each was read.
 */
export const saidChanged = (registry: AtomRegistry.AtomRegistry, items: readonly TimelineItem[]) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;

    yield* Effect.forEach(
      saidIn(registry.get(uploadsState), items),
      (id) =>
        client.uploads.read({ params: { id } }).pipe(
          Effect.flatMap((upload) =>
            Effect.sync(() => {
              uploadsHappened(registry, { _tag: "Answered", upload });
            })
          ),
          Effect.ignore
        ),
      { discard: true }
    );
  });
