/**
 * The Uploads the options list beside them, as atoms: followed from the Daemon while the
 * page is signed in and the options show, so another device's Upload shows without a
 * reload, read a page at a time, and forgotten on signing out. The stream also says which
 * Uploads' bytes the Daemon found gone, whole, and a row asks only whether its own is. The
 * first page says how far it was read, and the stream is followed after that, or after the
 * last Change folded in when following again, so nothing is missed and nothing is given twice. An Upload's link
 * is derived from the public URL in force as it is drawn, never held, so a new public URL
 * changes every link copied from then on. Renaming and deleting one are sent from here,
 * from the list and from the composer alike, and the Daemon's answer goes to the list at
 * once, ahead of the Change the stream gives for it.
 *
 * @packageDocumentation
 */
import type { Upload, UploadId, UploadsQuery } from "@iirc/api";
import {
  initialUploadEdits,
  initialUploads,
  linkOf,
  reduceUploadEdits,
  reduceUploads,
} from "@iirc/frontend/uploads";
import type { EditFailure, UploadEditsEvent, UploadsEvent } from "@iirc/frontend/uploads";
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

/**
 * Whether the deleted Uploads show, which the Uploads held say, so it lives in one place.
 * It changes only when the Owner switches it, so what depends on it is not run again for
 * any other change of the Uploads.
 */
export const deletedShown = Atom.make((get) => get(uploadsState).showDeleted);

/**
 * Whether the Daemon found one Upload's bytes gone, which the Uploads held say, so a row
 * redraws only when its own answer changes, not for any other change of the Uploads.
 */
export const uploadMissing = Atom.family((id: UploadId) =>
  Atom.make((get) => get(uploadsState).missing.has(id))
);

/** What the Owner asked of the Uploads listed, as the core folds it. */
export const uploadEditsState = Atom.make(initialUploadEdits).pipe(Atom.keepAlive);

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
 * Folds one event into what the Owner asked of the Uploads listed.
 * @param registry - The registry.
 * @param event - What happened.
 */
const edited = (registry: AtomRegistry.AtomRegistry, event: UploadEditsEvent) => {
  registry.set(uploadEditsState, reduceUploadEdits(registry.get(uploadEditsState), event));
};

/** What the Owner asked of an Upload: a new name, or that it be deleted. */
type Edit = { readonly of: "Rename"; readonly name: string } | { readonly of: "Delete" };

/**
 * What a rename or a delete came to: `Done`, with the Upload as the Daemon answered it,
 * `Failed`, or `SignedOut`, the sign-in refused.
 */
type Edited =
  | { readonly _tag: "Done"; readonly upload: Upload }
  | { readonly _tag: "Failed"; readonly failure: EditFailure }
  | { readonly _tag: "SignedOut" };

// A gateway in front of the Daemon answers these when it could not reach it.
const gatewayStatuses: ReadonlySet<number> = new Set([502, 504]);

/**
 * A rename or a delete that failed.
 * @param failure - Why.
 * @returns What it came to.
 */
const failed = (failure: EditFailure): Effect.Effect<Edited> =>
  Effect.succeed({ _tag: "Failed", failure });

/**
 * Sends a rename or a delete of an Upload, and says what it came to, from the error's tag
 * and status, never its text. Done, the list takes the Upload as answered at once. A
 * refused sign-in signs the page out.
 * @param registry - The registry.
 * @param id - The Upload.
 * @param edit - What was asked.
 * @returns What it came to.
 */
export const sendEdit = (registry: AtomRegistry.AtomRegistry, id: UploadId, edit: Edit) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;

    const sent =
      edit.of === "Rename"
        ? client.uploads.rename({ params: { id }, payload: { name: edit.name } })
        : client.uploads.delete({ params: { id } });

    const answer = yield* sent.pipe(
      Effect.map((upload): Edited => ({ _tag: "Done", upload })),
      Effect.catch((error) => {
        switch (error._tag) {
          case "Unauthorized": {
            return Effect.succeed<Edited>({ _tag: "SignedOut" });
          }

          case "UnknownUpload":
          case "JournalFailed": {
            return failed({ _tag: error._tag });
          }

          case "HttpClientError": {
            return failed({
              _tag:
                error.reason._tag === "TransportError" ||
                (error.response !== undefined && gatewayStatuses.has(error.response.status))
                  ? "NoAnswer"
                  : "Unexpected",
            });
          }

          // A rename or a delete done, whose Upload's Timelines could not be read, is as
          // unknown as an answer that could not be.
          case "CrossOrigin":
          case "InvalidRequest":
          case "SchemaError":
          case "TimelinesFailed": {
            return failed({ _tag: "Unexpected" });
          }

          default: {
            return error satisfies never;
          }
        }
      })
    );

    if (answer._tag === "Done") {
      happened(registry, { _tag: "Answered", upload: answer.upload });
    }

    if (answer._tag === "SignedOut") {
      signedOut(registry);
    }

    return answer;
  });

/**
 * Sends what the Owner asked of an Upload in the list, and folds in what it came to.
 * @param registry - The registry.
 * @param id - The Upload.
 * @param edit - What was asked.
 * @returns Once answered.
 */
const editFromList = (registry: AtomRegistry.AtomRegistry, id: UploadId, edit: Edit) =>
  Effect.gen(function* () {
    edited(registry, { _tag: "Sent", id, of: edit.of });

    const answer = yield* sendEdit(registry, id, edit);

    if (answer._tag !== "SignedOut") {
      edited(registry, {
        _tag: "Answered",
        failure: answer._tag === "Failed" ? answer.failure : undefined,
        id,
      });
    }
  });

/** Renames an Upload from the list. */
export const renameUpload = runtime
  .fn(
    ({ id, name }: { readonly id: UploadId; readonly name: string }, get) =>
      editFromList(get.registry, id, { name, of: "Rename" }),
    { concurrent: true }
  )
  .pipe(Atom.keepAlive);

/** Chooses whether the deleted Uploads show, which reads the list again from its first page. */
export const showDeleted = Atom.fnSync((shown: boolean, get) => {
  happened(get.registry, { _tag: "DeletedShown", shown });
}).pipe(Atom.keepAlive);

/** Asks the Owner to confirm deleting an Upload, which sends nothing yet. */
export const askToDelete = Atom.fnSync((id: UploadId, get) => {
  edited(get.registry, { _tag: "AskedToDelete", id });
}).pipe(Atom.keepAlive);

/** The Owner let the question go, deleting nothing. */
export const closeDelete = Atom.fnSync((_: undefined, get) => {
  edited(get.registry, { _tag: "Closed" });
}).pipe(Atom.keepAlive);

/** Deletes the Upload the Owner confirmed deleting, once, which closes the question. */
export const confirmDelete = runtime
  .fn(
    (_: undefined, get) =>
      Effect.gen(function* () {
        const id = get.registry.get(uploadEditsState).asking;

        if (id !== undefined) {
          yield* editFromList(get.registry, id, { of: "Delete" });
        }
      }),
    { concurrent: true }
  )
  .pipe(Atom.keepAlive);

/**
 * What a read of a page asks, from where it begins and whether it takes the deleted too.
 * @param after - Where the page begins, or none for the first.
 * @param deleted - Whether the deleted Uploads are asked for.
 * @returns The query.
 */
const pageQuery = (after: UploadId | undefined, deleted: boolean): UploadsQuery => {
  if (deleted) {
    return after === undefined ? { deleted: "true" } : { after, deleted: "true" };
  }

  return after === undefined ? {} : { after };
};

/**
 * Reads a page of the Uploads, from just after an Upload or from the newest, with the
 * deleted ones too while they show, and folds it in only when the page stayed signed in and
 * kept showing or hiding the deleted as it was asked, the whole time the read took.
 * @param registry - The registry.
 * @param after - Where the page begins, or none for the first.
 * @returns Once read.
 */
const readPage = (registry: AtomRegistry.AtomRegistry, after: UploadId | undefined) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const deleted = registry.get(deletedShown);
    let stayed = registry.get(signedIn);

    const page = yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        registry.subscribe(signedIn, (now) => {
          stayed &&= now;
        })
      ),
      () => client.uploads.list({ query: pageQuery(after, deleted) }),
      (unsubscribe) => Effect.sync(unsubscribe)
    );

    if (stayed && registry.get(deletedShown) === deleted) {
      happened(registry, { _tag: "Paged", after, page });
    }
  });

/**
 * While the browser is signed in and the options show, reads the first page, unless one
 * was, then follows the Uploads' Changes after the last folded in, so another device's
 * Upload shows. Whenever the stream ends, or gives nothing for longer than three
 * heartbeats, it is followed again from there, and what is held stays valid, `next` too,
 * since the Daemon sends exactly the Changes after it. A refusal signs the page out, and
 * signed out, the Uploads are forgotten. It depends on whether the deleted show, so
 * switching that starts it again: the list was started over, so the first page is read
 * with or without the deleted, and the stream followed from its `through`. Mounted once.
 */
export const uploadsSync = runtime
  .atom((get) =>
    Effect.gen(function* () {
      const { registry } = get;

      if (!get(signedIn)) {
        happened(registry, { _tag: "Forgotten" });
        edited(registry, { _tag: "Forgotten" });
        registry.set(copiedLink, undefined);

        return;
      }

      if (!get(optionsShown)) {
        return;
      }

      // Read for the dependency alone: the list says what it shows, and this runs again
      // when that changes.
      get(deletedShown);

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

              if (event.event === "missing") {
                happened(registry, { _tag: "Missing", ids: event.data.uploads });
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
