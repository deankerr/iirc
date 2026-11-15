import { limits } from "@iirc/link-fetch";
import type { Purpose } from "@iirc/link-fetch";
import { loopbackPolicy } from "@iirc/link-fetch/testing";
import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeBunLinkFetch } from "../link-fetch-bun.ts";
import { serve } from "../testing/sites.ts";
import type { Handler } from "../testing/sites.ts";

// Each of these waits out the real ten seconds a fetch is held to, which is why they run in
// `bun run e2e` and never in `bun run test`.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Writes a byte every 200 ms for as long as the client reads.
 * @param type - The answer's type.
 * @returns The handler.
 */
const drip =
  (type: string): Handler =>
  (_, response) => {
    response.writeHead(200, { "content-type": type });
    response.write("<");

    const timer = setInterval(() => response.write(" "), 200);

    response.on("close", () => {
      clearInterval(timer);
    });
  };

/**
 * Fetches from a site and reads the body, timing it from the start.
 * @param handler - The site.
 * @param purpose - What the link is fetched for.
 * @returns How it ended, after how many seconds, and how much body there was.
 */
const timed = async (handler: Handler, purpose: Purpose) =>
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const site = yield* serve(handler);
        const service = makeBunLinkFetch({ policy: loopbackPolicy(site.port), version: "1.2.3" });
        const started = performance.now();
        let size = 0;

        const end = yield* service.fetch(`http://127.0.0.1:${site.port}/`, purpose).pipe(
          Effect.flatMap((answer) =>
            Stream.runForEach(answer.body, (chunk) =>
              Effect.sync(() => {
                size += chunk.length;
              })
            )
          ),
          Effect.match({ onFailure: (failure) => failure._tag, onSuccess: () => "ended" })
        );

        yield* Effect.sleep("200 millis");

        return {
          closed: site.connections.closed,
          end,
          seconds: (performance.now() - started) / 1000,
          size,
        };
      })
    )
  );

const limit = limits.milliseconds / 1000;

describe.concurrent("each fetch is held to ten seconds", () => {
  it("a body that drips is cut at 10 s, and its connection closed", async () => {
    const result = await timed(drip("text/html"), { kind: "page" });

    expect(result.end).toBe("LinkTimedOut");
    expect(result.seconds).toBeGreaterThanOrEqual(limit);
    expect(result.seconds).toBeLessThan(limit + 2);
    expect(result.size).toBeGreaterThan(10);
    expect(result.closed).toBe(1);
  });

  it("an answer that never comes is cut at 10 s", async () => {
    const result = await timed(() => null, { kind: "image" });

    expect(result.end).toBe("LinkTimedOut");
    expect(result.seconds).toBeGreaterThanOrEqual(limit);
    expect(result.seconds).toBeLessThan(limit + 2);
  });

  it("a stream whose first byte never comes is cut at 10 s", async () => {
    const result = await timed(
      (_, response) => {
        response.writeHead(200, { "content-type": "video/mp4" });
        response.flushHeaders();
      },
      { kind: "stream" }
    );

    expect(result.end).toBe("LinkTimedOut");
    expect(result.seconds).toBeGreaterThanOrEqual(limit);
    expect(result.seconds).toBeLessThan(limit + 2);
  });

  it("a stream that has begun is not cut at 10 s", async () => {
    const result = await timed(
      (_, response) => {
        response.writeHead(200, { "content-type": "audio/ogg" });
        response.write("OggS");

        const timer = setInterval(() => response.write("."), 500);

        setTimeout(
          () => {
            clearInterval(timer);
            response.end();
          },
          (limit + 2) * 1000
        );
      },
      { kind: "stream" }
    );

    expect(result.end).toBe("ended");
    expect(result.seconds).toBeGreaterThan(limit + 1);
  });
});
