import { limits, pacing } from "@iirc/link-fetch";
import type { Purpose } from "@iirc/link-fetch";
import { loopbackPolicy } from "@iirc/link-fetch/testing";
import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeBunLinkFetch } from "../link-fetch-bun.ts";
import { closes, scripted, serve } from "../testing/sites.ts";
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

        const service = yield* makeBunLinkFetch({
          policy: loopbackPolicy(site.port),
          version: "1.2.3",
        });

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

        return {
          closed: yield* closes(site),
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

/**
 * A site where `/play` streams for twelve seconds and ends, `/page` answers a page at once,
 * and `/to/…` redirects to the link its path names.
 * @param request - The request.
 * @param response - Its response.
 */
const playing: Handler = (request, response) => {
  const url = request.url ?? "";

  if (url.startsWith("/to/")) {
    response.writeHead(302, { location: decodeURIComponent(url.slice("/to/".length)) });
    response.end();
  } else if (url === "/play") {
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
  } else {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><head><title>page</title></head><body>x</body></html>");
  }
};

/**
 * Plays a stream in each of one name's places, and while they play, fetches a page from the link given,
 * which reaches that name, timing it from the start.
 * @param link - The page's link, from the site's port.
 * @returns How the page's fetch ended, and after how many seconds.
 */
const behindAll = async (link: (port: number) => string) =>
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const site = yield* serve(playing);
        const names = scripted({ "a.test": [["127.0.0.1"]], "b.test": [["127.0.0.1"]] });

        const service = yield* makeBunLinkFetch({
          policy: loopbackPolicy(site.port),
          resolver: names.resolver,
          version: "1.2.3",
        });

        const play = Effect.scoped(
          Effect.flatMap(
            service.fetch(`http://b.test:${site.port}/play`, { kind: "stream" }),
            (answer) => Stream.runDrain(answer.body)
          )
        );

        for (const _ of Array.from({ length: pacing.perName })) {
          yield* Effect.forkChild(play);
        }

        yield* Effect.sleep("500 millis");

        const started = performance.now();

        const end = yield* Effect.scoped(
          service.fetch(link(site.port), { kind: "page" }).pipe(
            Effect.flatMap((answer) => Stream.runDrain(answer.body)),
            Effect.match({ onFailure: (failure) => failure._tag, onSuccess: () => "ended" })
          )
        );

        return { end, seconds: (performance.now() - started) / 1000 };
      })
    )
  );

describe.concurrent("a fetch never fails for waiting its turn", () => {
  it("a fetch to a name whose places are all held longer than 10 s is answered", async () => {
    const result = await behindAll((port) => `http://b.test:${port}/page`);

    expect(result.end).toBe("ended");
    expect(result.seconds).toBeGreaterThan(limit);
  });

  it("a redirect that waits longer than 10 s at the name it goes to is answered", async () => {
    const result = await behindAll(
      (port) => `http://a.test:${port}/to/${encodeURIComponent(`http://b.test:${port}/page`)}`
    );

    expect(result.end).toBe("ended");
    expect(result.seconds).toBeGreaterThan(limit);
  });
});
