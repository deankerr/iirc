/**
 * The Uploads the options list beside them, as atoms: followed from the Daemon while the
 * page is signed in and the options show, so another device's Upload shows without a
 * reload, read a page at a time, and forgotten on signing out. The first page says how far
 * it was read, and the stream is followed after that, or after the last Change folded in
 * when following again, so nothing is missed and nothing is given twice. An Upload's link
 * is derived from the public URL in force as it is drawn, never held, so a new public URL
 * changes every link copied from then on.
 *
 * @packageDocumentation
 */
import type { UploadId } from "@iirc/api";
import { initialUploads, linkOf, reduceUploads } from "@iirc/frontend/uploads";
import type { UploadsEvent } from "@iirc/frontend/uploads";
import { Effect, Schedule, Stream } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { signedIn } from "../sign-in/atoms.ts";
import { retrying, Waits } from "../timelines/atoms.ts";
import { optionsShown, optionsState, signedOut, told } from "./atoms.ts";

/** The Uploads held, newest first, as the core folds them. */
export const uploadsState = Atom.make(initialUploads).pipe(Atom.keepAlive);

/** The public URL in force, which every Upload's link is made from, or none while unset. */
export const publicUrl = Atom.make(
  (get): string | undefined => get(optionsState).owner?.options["uploads.publicUrl"]
);

/** The link last copied, which the list says was, while it is still that Upload's link. */
export const copiedLink = Atom.make<string | undefined>(undefined).pipe(Atom.keepAlive);

/**
 * Folds one event into the Uploads held, unless the page is signed out, so what signing
 * out forgot stays forgotten whatever lands after it.
 * @param registry - The registry.
 * @param event - What happened.
 */
const happened = (registry: AtomRegistry.AtomRegistry, event: UploadsEvent) => {
  if (event._tag === "Forgotten" || registry.get(signedIn)) {
    registry.set(uploadsState, reduceUploads(registry.get(uploadsState), event));
  }
};

/**
 * Reads a page of the Uploads, from just after an Upload or from the newest, and folds it in
 * only when the page stayed signed in the whole time the read took.
 * @param registry - The registry.
 * @param after - Where the page begins, or none for the first.
 * @returns Once read.
 */
const readPage = (registry: AtomRegistry.AtomRegistry, after: UploadId | undefined) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    let stayed = registry.get(signedIn);

    const page = yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        registry.subscribe(signedIn, (now) => {
          stayed &&= now;
        })
      ),
      () => client.uploads.list({ query: after === undefined ? {} : { after } }),
      (unsubscribe) => Effect.sync(unsubscribe)
    );

    if (stayed) {
      happened(registry, { _tag: "Paged", after, page });
    }
  });

/**
 * While the browser is signed in and the options show, reads the first page, unless one
 * was, then follows the Uploads' Changes after the last folded in, so another device's
 * Upload shows. Whenever the stream ends, or gives nothing for longer than three
 * heartbeats, it is followed again from there, and what is held stays valid, `next` too,
 * since the Daemon sends exactly the Changes after it. A refusal signs the page out, and
 * signed out, the Uploads are forgotten. Mounted once.
 */
export const uploadsSync = runtime
  .atom((get) =>
    Effect.gen(function* () {
      const { registry } = get;

      if (!get(signedIn)) {
        happened(registry, { _tag: "Forgotten" });
        registry.set(copiedLink, undefined);

        return;
      }

      if (!get(optionsShown)) {
        return;
      }

      const client = yield* DaemonClient;
      const { idle, reconnect } = yield* Waits;
      const schedule = yield* retrying;

      const follow = Effect.gen(function* () {
        // Bounded as the stream is, so a page read that stalls is given up and tried again.
        if (registry.get(uploadsState).through === undefined) {
          yield* readPage(registry, undefined).pipe(Effect.timeout(idle));
        }

        const { through } = registry.get(uploadsState);

        // The page was not folded, as signing out meanwhile leaves it, so there is nothing
        // to follow from yet.
        if (through === undefined) {
          return;
        }

        const events = yield* client.uploads
          .changes({ headers: {}, query: { after: through } })
          .pipe(Effect.timeout(idle));

        yield* events.pipe(
          Stream.timeout(idle),
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.event === "changed") {
                happened(registry, { _tag: "Changed", sequence: event.id, upload: event.data });
              }
            })
          )
        );
      });

      yield* follow.pipe(
        Effect.retry({ schedule, while: (error) => error._tag !== "Unauthorized" }),
        Effect.repeat(Schedule.spaced(reconnect)),
        Effect.catchTag("Unauthorized", () =>
          Effect.sync(() => {
            signedOut(registry);
          })
        )
      );
    })
  )
  .pipe(Atom.keepAlive);

/** Reads the next page of the Uploads, after those held, and says in the view if it could not. */
export const moreUploads = runtime
  .fn((_: undefined, get) =>
    Effect.gen(function* () {
      const { next } = get.registry.get(uploadsState);

      if (next === undefined || next === null) {
        return;
      }

      yield* readPage(get.registry, next).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            told(
              get.registry,
              error._tag === "Unauthorized"
                ? { _tag: "SignedOut" }
                : {
                    _tag: "NotDone",
                    message: "The Daemon did not give the next page of Uploads. Try again.",
                  }
            );
          })
        )
      );
    })
  )
  .pipe(Atom.keepAlive);

/**
 * Copies an Upload's link, made from the public URL in force, to the clipboard, and says
 * it was, or that the browser refused it. Nothing is copied while no public URL is set.
 */
export const copyLink = runtime
  .fn((upload: { readonly id: UploadId; readonly safeName: string }, get) =>
    Effect.gen(function* () {
      const link = linkOf(get.registry.get(publicUrl), upload);

      if (link === undefined) {
        return;
      }

      yield* Effect.tryPromise(async () => {
        await navigator.clipboard.writeText(link);
      }).pipe(
        Effect.match({
          onFailure: () => {
            told(get.registry, {
              _tag: "NotDone",
              message: "This browser would not copy the link, so it was not copied.",
            });
          },
          onSuccess: () => {
            get.registry.set(copiedLink, link);
          },
        })
      );
    })
  )
  .pipe(Atom.keepAlive);
