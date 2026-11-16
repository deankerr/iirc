import { Effect, Exit, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  LinkRefused,
  LinkTooLarge,
  LinkUnreachable,
  LinkWrongType,
  limits,
} from "../link-fetch.ts";
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
  it("answers a recorded response by link, and records what was asked", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeFakeLinkFetch({
            "https://example.com/a": { body: "<title>A</title>", type: "text/html" },
          });

          const fetched = yield* fake.service.fetch("https://EXAMPLE.com/a", { kind: "page" });
          const body = yield* Stream.mkString(Stream.decodeText(fetched.body));

          return { asked: yield* fake.asked, body, fetched };
        })
      )
    );

    expect(result.body).toBe("<title>A</title>");
    expect(result.fetched).toMatchObject({
      headers: { "content-type": "text/html" },
      link: "https://example.com/a",
      status: 200,
      type: "text/html",
    });
    expect(result.asked).toStrictEqual([
      { link: "https://EXAMPLE.com/a", purpose: { kind: "page" } },
    ]);
  });

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

  it("answers a recorded failure", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.flatMap(
          makeFakeLinkFetch({ "https://example.com/": new LinkRefused({ reason: "private" }) }),
          (fake) => fake.service.fetch("https://example.com/", { kind: "image" })
        )
      )
    );

    expect(exit).toStrictEqual(Exit.fail(new LinkRefused({ reason: "private" })));
  });

  it("an unrecorded link is unreachable", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.flatMap(makeFakeLinkFetch({}), (fake) =>
          fake.service.fetch("https://nowhere.test/", { kind: "oembed" })
        )
      )
    );

    expect(exit).toStrictEqual(Exit.fail(new LinkUnreachable({ reason: "no recorded answer" })));
  });

  describe("answers as the guard would for the purpose", () => {
    it("refuses an image answer fetched as a page as the wrong type, naming the link that answered", async () => {
      const exit = await fetching(
        { "https://example.com/a": { link: "https://cdn.example/a.png", type: "image/png" } },
        "https://example.com/a",
        { kind: "page" }
      );

      expect(exit).toStrictEqual(
        Exit.fail(new LinkWrongType({ link: "https://cdn.example/a.png", type: "image/png" }))
      );
    });

    it("refuses an html answer fetched as an image as the wrong type", async () => {
      const exit = await fetching(
        { "https://example.com/a.png": { type: "text/html; charset=utf-8" } },
        "https://example.com/a.png",
        { kind: "image" }
      );

      expect(exit).toStrictEqual(
        Exit.fail(new LinkWrongType({ link: "https://example.com/a.png", type: "text/html" }))
      );
    });

    it("refuses a page fetched as an oEmbed, and a page fetched as a stream", async () => {
      const answers = { "https://example.com/": { type: "text/html" } };

      await expect(
        fetching(answers, "https://example.com/", { kind: "oembed" })
      ).resolves.toStrictEqual(
        Exit.fail(new LinkWrongType({ link: "https://example.com/", type: "text/html" }))
      );
      await expect(
        fetching(answers, "https://example.com/", { kind: "stream" })
      ).resolves.toStrictEqual(
        Exit.fail(new LinkWrongType({ link: "https://example.com/", type: "text/html" }))
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

    it("fails a raster image over its limit as too large as its body is read", async () => {
      const exit = await fetching(
        {
          "https://example.com/big.png": {
            body: new Uint8Array(limits.raster + 1),
            type: "image/png",
          },
        },
        "https://example.com/big.png",
        { kind: "image" }
      );

      expect(exit).toStrictEqual(Exit.fail(new LinkTooLarge({ limit: limits.raster })));
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
