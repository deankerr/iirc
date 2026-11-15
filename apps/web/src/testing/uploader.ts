/**
 * An Uploader for tests: it hands each file to the fake Daemon's `fetch`, as the browser's
 * would send it, and lets a test hold each request before it reaches the Daemon, say how
 * much of it was sent, and see whether it was aborted.
 *
 * @packageDocumentation
 */
import { Effect } from "effect";

import { NoAnswer } from "../composer/uploader.ts";
import type { Sent, UploaderPort } from "../composer/uploader.ts";

/** One file a test's Uploader was given to send. */
interface Sending {
  /** The URL it was sent to, relative to the page. */
  readonly url: string;
  readonly size: number;
  /** Says the browser sent this much of it. */
  readonly progress: (loaded: number) => void;
  /** Lets a held request go on to the Daemon. */
  readonly release: () => void;
  /** Whether it was aborted. */
  aborted: boolean;
}

/**
 * A test's Uploader.
 * @param fetch - The fake Daemon's `fetch`.
 * @returns What it holds, and its port.
 */
export const testUploader = (fetch: typeof globalThis.fetch) => {
  const sending: Sending[] = [];

  const held = {
    /** Whether each request waits, once given, until a test releases it. */
    hold: false,
    /** Each file given to send, in order. */
    sending,
  };

  const port: UploaderPort = {
    send: (file, url, progress) =>
      Effect.callback<Sent, NoAnswer>((resume) => {
        const controller = new AbortController();

        const go = async () => {
          try {
            const response = await fetch(new URL(url, "http://daemon.test"), {
              body: file,
              headers: { "content-type": "application/octet-stream" },
              method: "POST",
              signal: controller.signal,
            });

            resume(Effect.succeed({ body: await response.text(), status: response.status }));
          } catch {
            resume(Effect.fail(new NoAnswer()));
          }
        };

        const one: Sending = {
          aborted: false,
          progress: (loaded) => {
            progress(loaded, file.size);
          },
          release: () => {
            if (!one.aborted) {
              void go();
            }
          },
          size: file.size,
          url,
        };

        held.sending.push(one);

        if (!held.hold) {
          void go();
        }

        return Effect.sync(() => {
          one.aborted = true;
          controller.abort();
        });
      }),
  };

  return { held, port };
};
