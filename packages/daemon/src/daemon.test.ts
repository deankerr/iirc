/** The whole Daemon, on no Network, as it stops. */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { startDaemon } from "./testing/running.ts";
import { makeKey, temporaryDirectory } from "./testing/world.ts";

/**
 * Reads a response's body to its end, and says whether it ended or broke.
 * @param reader - The body's reader.
 * @returns `"ended"`, or `"broke"` if a read failed.
 */
const readToEnd = async (reader: { readonly read: () => Promise<{ readonly done: boolean }> }) => {
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- reading a stream in order
      const chunk = await reader.read();

      if (chunk.done) {
        return "ended";
      }
    }
  } catch {
    return "broke";
  }
};

describe("the Daemon, as it stops", () => {
  it("ends every stream a Frontend has open, rather than cutting it", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* temporaryDirectory;
          const key = yield* makeKey(dataDir);
          const daemon = yield* startDaemon({ dataDir, heartbeat: "20 millis" }, key);

          // Each is read until its first heartbeat, so it is open and flowing at the stop.
          const readers = yield* Effect.promise(
            async () =>
              await Promise.all(
                ["/api/news", "/api/timelines/changes", "/api/ui/changes"].map(async (path) => {
                  const response = await fetch(`${daemon.base}${path}`, {
                    headers: { authorization: `Bearer ${key}` },
                  });

                  const body: ReadableStream<Uint8Array> | null = response.body;

                  if (body === null) {
                    throw new Error(`${path} answered ${response.status} with no body`);
                  }

                  const reader = body.getReader();

                  await reader.read();

                  return reader;
                })
              )
          );

          yield* daemon.stop;

          return yield* Effect.promise(async () => await Promise.all(readers.map(readToEnd)));
        })
      )
    );

    expect(result).toStrictEqual(["ended", "ended", "ended"]);
  });
});
