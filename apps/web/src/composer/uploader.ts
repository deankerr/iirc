/**
 * Sending a file's bytes to the Daemon, through a port: the browser's adapter is
 * `XMLHttpRequest`, since `fetch` says nothing of how much of a body was sent, and a test
 * gives its own. The port only carries bytes and hands back what came back. What that
 * answer means is read here, from the API's own Schemas, for every adapter alike.
 *
 * @packageDocumentation
 */
import { JournalFailed, StoreUnavailable, Upload, UploadsOff, UploadTooLarge } from "@iirc/api";
import type { OwnerOptionName } from "@iirc/api";
import type { UploadFailure } from "@iirc/frontend/uploading";
import { Context, Data, Effect, Option, Schema } from "effect";

/** What the Daemon sent back: its status and its body, as text. */
export interface Sent {
  readonly status: number;
  readonly body: string;
}

/** The request got no answer: the network failed, or nothing was listening. */
export class NoAnswer extends Data.TaggedError("NoAnswer") {}

/** The host's side of sending a file. */
export interface UploaderPort {
  /**
   * Sends a file's bytes as the body of a `POST` to a URL, saying how much was sent as the
   * browser says it, and gives back what came back. Interrupting it aborts the request.
   */
  readonly send: (
    file: Blob,
    url: string,
    progress: (loaded: number, total: number) => void
  ) => Effect.Effect<Sent, NoAnswer>;
}

/**
 * The browser's adapter: one `XMLHttpRequest` per file, to a URL relative to the page, so
 * it goes to the origin that served it with its sign-in cookie, as every request of the
 * page does. Its body is the file itself, as `application/octet-stream`, and its upload
 * events say how much was sent.
 */
const browserUploader: UploaderPort = {
  send: (file, url, progress) =>
    Effect.callback<Sent, NoAnswer>((resume) => {
      const request = new XMLHttpRequest();

      request.open("POST", url);
      request.setRequestHeader("Content-Type", "application/octet-stream");
      request.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          progress(event.loaded, event.total);
        }
      });
      request.addEventListener("load", () => {
        resume(Effect.succeed({ body: request.responseText, status: request.status }));
      });
      request.addEventListener("error", () => {
        resume(Effect.fail(new NoAnswer()));
      });
      request.addEventListener("timeout", () => {
        resume(Effect.fail(new NoAnswer()));
      });
      request.send(file);

      return Effect.sync(() => {
        request.abort();
      });
    }),
};

/** The host's sender of files: the browser's, unless a test gives its own. */
export class Uploader extends Context.Reference<UploaderPort>("@iirc/web/Uploader", {
  defaultValue: () => browserUploader,
}) {}

/** The longest name an Upload may be given, as the contract bounds it. */
const nameMax = 1024;

/**
 * Where a file is sent: `POST /api/uploads`, with its name when it has one the contract
 * takes, and with none otherwise, so the Daemon gives it a neutral one.
 * @param name - The file's name.
 * @returns The URL, relative to the page.
 */
export const uploadUrl = (name: string): string =>
  name === "" || name.length > nameMax
    ? "/api/uploads"
    : `/api/uploads?${new URLSearchParams({ name }).toString()}`;

/**
 * What a file sent came to, as the Daemon answered.
 *
 * - `Kept`: it was kept as `upload`, its link `null` while no public URL is set.
 * - `Off`: Uploads are off, so it was not kept.
 * - `Failed`: it was not kept, or might not have been.
 * - `SignedOut`: the Daemon refused the sign-in.
 */
export type Answer =
  | { readonly _tag: "Kept"; readonly upload: Upload }
  | { readonly _tag: "Off"; readonly missing: readonly OwnerOptionName[] }
  | { readonly _tag: "Failed"; readonly failure: UploadFailure }
  | { readonly _tag: "SignedOut" };

const decodeUpload = Schema.decodeUnknownOption(Schema.fromJsonString(Upload));

const decodeRefusal = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([UploadsOff, UploadTooLarge, StoreUnavailable, JournalFailed]))
);

// A gateway in front of the Daemon answers these when it could not reach it.
const gatewayStatuses: ReadonlySet<number> = new Set([502, 504]);

/**
 * What the Daemon's answer to a file sent says, read from the contract's Schemas and the
 * status, never its text.
 * @param sent - What came back.
 * @returns What it came to.
 */
export const answerOf = (sent: Sent): Answer => {
  if (sent.status === 401) {
    return { _tag: "SignedOut" };
  }

  if (sent.status === 200) {
    return Option.match(decodeUpload(sent.body), {
      onNone: (): Answer => ({ _tag: "Failed", failure: { _tag: "Unexpected" } }),
      onSome: (upload): Answer => ({ _tag: "Kept", upload }),
    });
  }

  if (gatewayStatuses.has(sent.status)) {
    return { _tag: "Failed", failure: { _tag: "NoAnswer", sent: true } };
  }

  return Option.match(decodeRefusal(sent.body), {
    onNone: (): Answer => ({ _tag: "Failed", failure: { _tag: "Unexpected" } }),
    onSome: (refusal): Answer => {
      switch (refusal._tag) {
        case "UploadsOff": {
          return { _tag: "Off", missing: refusal.missing };
        }

        case "UploadTooLarge": {
          return {
            _tag: "Failed",
            failure: { _tag: "OverLimit", before: false, maxSize: refusal.maxSize },
          };
        }

        case "StoreUnavailable": {
          return { _tag: "Failed", failure: { _tag: "StoreUnavailable" } };
        }

        case "JournalFailed": {
          return { _tag: "Failed", failure: { _tag: "JournalFailed" } };
        }

        default: {
          return refusal satisfies never;
        }
      }
    },
  });
};
