import { Effect, Exit, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { LinkTooLarge, LinkWrongType, limits } from "../link-fetch.ts";
import type { Purpose } from "../link-fetch.ts";
import type { Answer } from "./fake.ts";
import { makeFakeLinkFetch } from "./fake.ts";

/**
 * Fetches a link of a fake answering as given, and reads its body.
 * @param answers - What each link answers.
 * @param link - The link.
 * @param purpose - What it is fetched for.
 * @returns How the fetch ended: the type and the size of the body, or why it failed.
 */
const fetching = async (
  answers: Readonly<Record<string, Answer>>,
  link: string,
  purpose: Purpose
) =>
  await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFakeLinkFetch(answers);
        const fetched = yield* fake.service.fetch(link, purpose);
        const body = yield* Stream.runCollect(fetched.body);

        return {
          size: body.reduce((sum, chunk) => sum + chunk.length, 0),
          type: fetched.type,
        };
      })
    )
  );

describe("the fake link fetch", () => {
  it("a link's fragment is dropped, as the guard drops it", async () => {
    const fetched = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(
          makeFakeLinkFetch({ "https://example.com/a": { type: "text/html" } }),
          (fake) => fake.service.fetch("https://example.com/a#section", { kind: "page" })
        )
      )
    );

    expect(fetched).toMatchObject({ link: "https://example.com/a", status: 200 });
  });

  describe("serves a stream as a host serving ranges would", () => {
    const link = "https://example.com/v.mp4";
    const bytes = Uint8Array.from({ length: 100 }, (_, at) => at);

    /**
     * Fetches the video as a stream and reads what came of it, whole or until it failed.
     * @param answer - What the link answers.
     * @param range - The range asked, if any.
     * @returns The answer's status and headers, how many bytes were read and the first of them,
     * and why reading stopped, if it did.
     */
    const streaming = async (answer: Answer, range?: { start: number; end?: number }) =>
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fake = yield* makeFakeLinkFetch({ [link]: answer });

            const fetched = yield* fake.service.fetch(
              link,
              range === undefined ? { kind: "stream" } : { kind: "stream", range }
            );

            // Only the first bytes are held, so a body of the stream limit is never collected.
            const first: number[] = [];
            let size = 0;

            const failure = yield* Stream.runForEach(fetched.body, (chunk) =>
              Effect.sync(() => {
                size += chunk.length;

                if (first.length < 1000) {
                  first.push(...chunk.subarray(0, 1000));
                }
              })
            ).pipe(
              Effect.as(undefined),
              Effect.catch((error) => Effect.succeed(error._tag))
            );

            return {
              asked: yield* fake.asked,
              failure,
              first,
              headers: fetched.headers,
              size,
              status: fetched.status,
              type: fetched.type,
            };
          })
        )
      );

    it("answers a range with no end to the end of the bytes, and an end past it as to the end", async () => {
      const open = await streaming({ body: bytes, type: "video/mp4" }, { start: 90 });
      const past = await streaming({ body: bytes, type: "video/mp4" }, { end: 500, start: 95 });

      expect([open.status, open.headers["content-range"], open.size]).toStrictEqual([
        206,
        "bytes 90-99/100",
        10,
      ]);
      expect([past.status, past.headers["content-range"], past.size]).toStrictEqual([
        206,
        "bytes 95-99/100",
        5,
      ]);
    });

    it("answers a recorded 416 to a stream whatever its type, as the guard does", async () => {
      const result = await streaming(
        { headers: { "content-range": "bytes */100" }, status: 416, type: "text/html" },
        { start: 500 }
      );

      expect(result).toMatchObject({ headers: { "content-range": "bytes */100" }, status: 416 });
    });

    it("answers a recorded status as recorded, a host that ignores the range, whole", async () => {
      const result = await streaming(
        { body: bytes, status: 200, type: "video/mp4" },
        { end: 20, start: 10 }
      );

      expect(result.status).toBe(200);
      expect(result.size).toBe(100);
    });

    it("gives a range of a body over the limit up to the limit from where it begins, and then fails it", async () => {
      const result = await streaming(
        { type: "video/mp4", zeros: limits.stream + 1000 },
        { start: 500 }
      );

      expect(result).toMatchObject({ failure: "LinkTooLarge", size: limits.stream });
    });
  });

  describe("answers as the guard would for the purpose", () => {
    it("refuses an html answer fetched as an image as the wrong type", async () => {
      const exit = await fetching(
        { "https://example.com/a.png": { type: "text/html; charset=utf-8" } },
        "https://example.com/a.png",
        { kind: "image" }
      );

      expect(exit).toStrictEqual(
        Exit.fail(
          new LinkWrongType({ link: "https://example.com/a.png", status: 200, type: "text/html" })
        )
      );
    });

    it("refuses a page fetched as an oEmbed, and a page fetched as a stream", async () => {
      const answers = { "https://example.com/": { type: "text/html" } };

      await expect(
        fetching(answers, "https://example.com/", { kind: "oembed" })
      ).resolves.toStrictEqual(
        Exit.fail(
          new LinkWrongType({ link: "https://example.com/", status: 200, type: "text/html" })
        )
      );
      await expect(
        fetching(answers, "https://example.com/", { kind: "stream" })
      ).resolves.toStrictEqual(
        Exit.fail(
          new LinkWrongType({ link: "https://example.com/", status: 200, type: "text/html" })
        )
      );
    });

    it("answers an image of a type an image takes, as its type without parameters, image/jpg as image/jpeg", async () => {
      const exit = await fetching(
        { "https://example.com/a.jpg": { body: "jpeg", type: "image/JPG; q=1" } },
        "https://example.com/a.jpg",
        { kind: "image" }
      );

      expect(exit).toStrictEqual(Exit.succeed({ size: 4, type: "image/jpeg" }));
    });

    it("answers a raster image at its limit whole", async () => {
      const exit = await fetching(
        {
          "https://example.com/full.png": {
            body: new Uint8Array(limits.raster),
            type: "image/png",
          },
        },
        "https://example.com/full.png",
        { kind: "image" }
      );

      expect(exit).toStrictEqual(Exit.succeed({ size: limits.raster, type: "image/png" }));
    });

    it("fails an SVG over the SVG limit as too large", async () => {
      const body = new Uint8Array(limits.svg + 1);

      const exit = await fetching(
        { "https://example.com/a.svg": { body, type: "image/svg+xml" } },
        "https://example.com/a.svg",
        { kind: "image" }
      );

      expect(exit).toStrictEqual(Exit.fail(new LinkTooLarge({ limit: limits.svg })));
    });

    it("fails an oEmbed over its limit as too large", async () => {
      const exit = await fetching(
        {
          "https://example.com/o": {
            body: new Uint8Array(limits.oembed + 1),
            type: "application/json",
          },
        },
        "https://example.com/o",
        { kind: "oembed" }
      );

      expect(exit).toStrictEqual(Exit.fail(new LinkTooLarge({ limit: limits.oembed })));
    });

    it("ends a page over its limit cleanly at the limit", async () => {
      const exit = await fetching(
        { "https://example.com/": { body: new Uint8Array(limits.page + 10), type: "text/html" } },
        "https://example.com/",
        { kind: "page" }
      );

      expect(exit).toStrictEqual(Exit.succeed({ size: limits.page, type: "text/html" }));
    });
  });
});
