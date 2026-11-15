/**
 * Uploading from the composer, as atoms: the files the Owner added, sent each in a fiber of
 * its own through the `Uploader` port, and what each came to folded back into the core,
 * which puts a kept file's link into the draft where the caret was. Whether Uploads are on
 * is read from the Daemon as the files are added, never kept. A file is cancelled by
 * letting it go from what is pending: its fiber sees that and stops, which aborts its
 * request.
 *
 * @packageDocumentation
 */
import type { Place } from "@iirc/frontend/composer";
import { draftOf } from "@iirc/frontend/composer";
import {
  anchorAfter,
  caretAfter,
  checking,
  initialUploading,
  reduceUploading,
  sending,
  uploaded,
} from "@iirc/frontend/uploading";
import type { AddedFile, Readiness, UploadingEvent } from "@iirc/frontend/uploading";
import { thumbnailed } from "@iirc/frontend/uploads";
import { Effect, Random, Stream } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { signedOut } from "../options/atoms.ts";
import { signedIn } from "../sign-in/atoms.ts";
import { composerState, placeOf } from "./atoms.ts";
import { cancelCompletion } from "./completion-state.ts";
import { composerInput } from "./input.ts";
import { answerOf, uploadUrl, Uploader } from "./uploader.ts";
import type { Answer } from "./uploader.ts";
import { caretAsked, uploadingState } from "./uploading-state.ts";

/**
 * The preview of each file pending that is an image every browser draws, by its key: a URL
 * of its own bytes, read in the page, made as it is added and let go of once it is not
 * pending. A URL of bytes is no plain data, so the core never holds one.
 */
export const previews = Atom.make<ReadonlyMap<string, string>>(new Map()).pipe(Atom.keepAlive);

/**
 * Lets go of the preview of each file no longer pending.
 * @param registry - The registry.
 */
const letGoOfPreviews = (registry: AtomRegistry.AtomRegistry) => {
  const keys = new Set(registry.get(uploadingState).pending.map((one) => one.key));
  const held = registry.get(previews);
  const gone = [...held].filter(([key]) => !keys.has(key));

  if (gone.length > 0) {
    for (const [, url] of gone) {
      URL.revokeObjectURL(url);
    }

    registry.set(previews, new Map([...held].filter(([key]) => keys.has(key))));
  }
};

/**
 * Folds one event into what is pending, and lets go of the preview of each file no longer
 * pending.
 * @param registry - The registry.
 * @param event - What happened.
 */
const happened = (registry: AtomRegistry.AtomRegistry, event: UploadingEvent) => {
  registry.set(uploadingState, reduceUploading(registry.get(uploadingState), event));
  letGoOfPreviews(registry);
};

/**
 * Waits until a file is no longer to be sent: cancelled, or let go another way.
 * @param registry - The registry.
 * @param key - The file's key.
 * @returns Once it is.
 */
const lettingGo = (registry: AtomRegistry.AtomRegistry, key: string) =>
  AtomRegistry.toStream(registry, uploadingState).pipe(
    Stream.filter((state) => !sending(state).has(key)),
    Stream.take(1),
    Stream.runDrain
  );

/**
 * Waits until none of the files added together is still checking: each was cancelled, or
 * let go another way, as on signing out.
 * @param registry - The registry.
 * @param keys - The files' keys.
 * @returns Once none is.
 */
const noneChecking = (registry: AtomRegistry.AtomRegistry, keys: readonly string[]) =>
  AtomRegistry.toStream(registry, uploadingState).pipe(
    Stream.filter((state) => {
      const still = checking(state);

      return keys.every((key) => !still.has(key));
    }),
    Stream.take(1),
    Stream.runDrain
  );

/**
 * A file kept: its link goes into its draft, and the caret, when the Owner is writing
 * there, stays where it was in the text around the link.
 * @param registry - The registry.
 * @param key - The file's key.
 * @param link - Its link, or `null` without a public URL.
 */
const kept = (registry: AtomRegistry.AtomRegistry, key: string, link: string | null) => {
  const step = uploaded(registry.get(uploadingState), registry.get(composerState), key, link);
  const { inserted } = step;
  const input = composerInput(document);

  // The caret is read before the text changes under it.
  const caret =
    inserted !== undefined &&
    input !== undefined &&
    document.activeElement === input &&
    placeOf(registry) === inserted.place
      ? caretAfter(input.selectionStart, inserted)
      : undefined;

  // The core moved every other anchor past the link already, so the composers are set
  // as they are, not followed again.
  if (inserted !== undefined) {
    cancelCompletion(registry);
  }

  registry.set(composerState, step.composers);
  registry.set(uploadingState, step.state);
  letGoOfPreviews(registry);

  if (caret !== undefined) {
    registry.set(caretAsked, { asked: registry.get(caretAsked).asked + 1, caret });
  }
};

/**
 * Folds in what a file sent came to.
 * @param registry - The registry.
 * @param key - The file's key.
 * @param answer - What it came to.
 */
const answered = (registry: AtomRegistry.AtomRegistry, key: string, answer: Answer) => {
  switch (answer._tag) {
    case "Kept": {
      kept(registry, key, answer.link);
      break;
    }

    case "Off": {
      happened(registry, { _tag: "Off", key, missing: answer.missing });
      break;
    }

    case "Failed": {
      happened(registry, { _tag: "Failed", failure: answer.failure, key });
      break;
    }

    case "SignedOut": {
      happened(registry, { _tag: "Dropped", key });
      signedOut(registry);
      break;
    }

    default: {
      answer satisfies never;
    }
  }
};

/**
 * Sends one file, until it is answered or let go, which aborts its request.
 * @param registry - The registry.
 * @param key - The file's key.
 * @param file - Its bytes.
 * @param name - Its name.
 * @returns Once answered or let go.
 */
const sendOne = (registry: AtomRegistry.AtomRegistry, key: string, file: Blob, name: string) =>
  Effect.gen(function* () {
    const uploader = yield* Uploader;

    const sent = uploader
      .send(file, uploadUrl(name), (loaded, total) => {
        happened(registry, { _tag: "Progressed", key, loaded, total });
      })
      .pipe(
        Effect.map(answerOf),
        Effect.catchTag("NoAnswer", () =>
          Effect.succeed<Answer>({ _tag: "Failed", failure: { _tag: "NoAnswer", sent: true } })
        ),
        Effect.flatMap((answer) =>
          Effect.sync(() => {
            answered(registry, key, answer);
          })
        )
      );

    yield* Effect.raceFirst(sent, lettingGo(registry, key));
  });

/**
 * Whether Uploads are on, as the Daemon says now. A refused sign-in signs the page out.
 * @param registry - The registry.
 * @returns Whether they are, or none once signed out.
 */
const readiness = (registry: AtomRegistry.AtomRegistry) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;

    return yield* client.uploads.status().pipe(
      Effect.map((status): Readiness | undefined => status),
      Effect.catchTag("Unauthorized", () =>
        Effect.sync((): undefined => {
          signedOut(registry);
        })
      ),
      Effect.orElseSucceed((): Readiness => ({ _tag: "NoAnswer" }))
    );
  });

/** Files the Owner added to a composer, with its caret where it was. */
export interface Adding {
  readonly place: Place;
  /** Where the caret was in the draft's text, as it was then. */
  readonly anchor: number;
  readonly text: string;
  readonly files: readonly File[];
}

/**
 * Adds files to a composer: each is pending at once, checking, its place in the draft fixed
 * as it is added and following every edit from then, and the Daemon is asked whether
 * Uploads are on. If they are, each file the core did not refuse is sent, each in a fiber
 * of its own, so cancelling one stops it alone. While they are off, nothing is sent and
 * the composer notes it. Cancelling every file, or signing out, stops the asking.
 */
export const addFiles = runtime
  .fn(
    ({ anchor, files, place, text }: Adding, get) =>
      Effect.gen(function* () {
        const { registry } = get;

        if (files.length === 0) {
          return;
        }

        const named: { readonly added: AddedFile; readonly file: File }[] = [];

        for (const file of files) {
          // oxlint-disable-next-line no-await-in-loop -- one key each, in order
          const key = `upload-${yield* Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER)}`;

          named.push({ added: { key, name: file.name, size: file.size, type: file.type }, file });
        }

        const keys = named.map((one) => one.added.key);

        registry.set(
          previews,
          new Map([
            ...registry.get(previews),
            ...named.flatMap(({ added, file }) =>
              thumbnailed(added.type) ? [[added.key, URL.createObjectURL(file)] as const] : []
            ),
          ])
        );
        happened(registry, {
          _tag: "Added",
          // The files are added before anything else happens, so the text is as the caret
          // was read in, and this moves nothing unless the composer changed it meanwhile.
          anchor: anchorAfter(anchor, text, draftOf(registry.get(composerState), place).text),
          files: named.map((one) => one.added),
          place,
        });

        const ready = yield* Effect.raceFirst(
          readiness(registry),
          noneChecking(registry, keys).pipe(Effect.as(undefined))
        );

        if (ready === undefined) {
          return;
        }

        happened(registry, { _tag: "Checked", keys, readiness: ready });

        const toSend = sending(registry.get(uploadingState));

        yield* Effect.forEach(
          named.filter((one) => toSend.has(one.added.key)),
          ({ added, file }) => sendOne(registry, added.key, file, added.name),
          { concurrency: "unbounded", discard: true }
        );
      }),
    { concurrent: true }
  )
  .pipe(Atom.keepAlive);

/** Cancels a file checking or being sent, which aborts its request, or lets go of one that failed. */
export const dropUpload = Atom.fnSync((key: string, get) => {
  happened(get.registry, { _tag: "Dropped", key });
}).pipe(Atom.keepAlive);

/** Lets go of the note under a composer that Uploads are off. */
export const dismissUploadNote = Atom.fnSync((place: Place, get) => {
  happened(get.registry, { _tag: "NoteDismissed", place });
}).pipe(Atom.keepAlive);

/**
 * Signing out lets go of every file pending and every note, which stops each asking and
 * aborts each request, and of every preview, so none comes back on signing in again.
 * Mounted once for the page.
 */
export const uploadsSignedOut = Atom.make((get) => {
  if (!get(signedIn)) {
    get.registry.set(uploadingState, initialUploading);
    letGoOfPreviews(get.registry);
  }
}).pipe(Atom.keepAlive);
