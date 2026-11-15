import { Effect, Exit, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { LinkRefused, LinkUnreachable } from "../link-fetch.ts";
import { makeFakeLinkFetch } from "./fake.ts";

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
});
