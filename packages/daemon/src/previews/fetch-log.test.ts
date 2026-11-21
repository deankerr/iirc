import type { Fetched, LinkFetchService, Purpose } from "@iirc/link-fetch";
import { LinkUnreachable, LinkWrongType, limits } from "@iirc/link-fetch";
import type { Answer } from "@iirc/link-fetch/testing";
import { makeFakeLinkFetch } from "@iirc/link-fetch/testing";
import { Effect, Fiber, Layer, Logger, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { Tail, layerTailLogging } from "../tail.ts";
import { contained, logged } from "./fetch-log.ts";
import { readPage } from "./read.ts";

// The Tail keeps every line from Debug up, and no other Logger prints any of them.
const tailed = layerTailLogging("0.0.0").pipe(Layer.provideMerge(Logger.layer([])));

/**
 * The lines the Tail holds after its start line, as a Frontend reads them.
 * @param test - What logs them.
 * @returns The lines.
 */
const linesAfter = async <E>(test: Effect.Effect<void, E>) =>
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* test;
      const tail = yield* Tail;

      return (yield* tail.read).lines.slice(1);
    }).pipe(Effect.provide(Layer.merge(tailed, TestClock.layer())))
  );

/**
 * Fetches a link from a fake answering as told, reading its body whole and, for a page, its
 * head, as Previews do.
 * @param answers - What each link answers.
 * @param link - The link.
 * @param purpose - What it is fetched as.
 * @returns An Effect that fetches it.
 */
const fetchOne = (answers: Readonly<Record<string, Answer>>, link: string, purpose: Purpose) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeLinkFetch(answers);

    yield* Effect.scoped(
      Effect.gen(function* () {
        const { fetched, said } = yield* logged(fake.service, link, purpose);
        const chunks = yield* Stream.runCollect(fetched.body);

        if (purpose.kind === "page") {
          const head = new Uint8Array(chunks.flatMap((chunk) => [...chunk]));

          yield* said(readPage({ contentType: fetched.type, head, link: fetched.link }));
        }
      })
    ).pipe(Effect.ignore);
  });

const secret = "The Owner must never read this in a log";

describe(logged, () => {
  it("logs a page that gave a title and no player at Debug, with which parts it gave and none of their words", async () => {
    const body = `<html><head><title>${secret}</title></head><body>`;

    const lines = await linesAfter(
      fetchOne({ "https://cats.example/": { body, type: "text/html" } }, "https://cats.example/", {
        kind: "page",
      })
    );

    expect(lines).toStrictEqual([
      expect.objectContaining({
        annotations: {
          answered: "https://cats.example/",
          as: "page",
          bytes: String(body.length),
          description: "no",
          image: "no",
          link: "https://cats.example/",
          oembed: "no",
          player: "no",
          status: "200",
          title: "yes",
          took: "0ms",
          type: "text/html",
          video: "no",
        },
        level: "Debug",
        message: "Fetched a link for a Preview",
      }),
    ]);
    expect(JSON.stringify(lines)).not.toContain(secret);
  });

  it("logs the link that answered after a redirect, and an image's bytes with no page's parts", async () => {
    const lines = await linesAfter(
      fetchOne(
        {
          "https://cats.example/cat": {
            body: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2]),
            link: "https://img.example/cat.gif",
            type: "image/gif",
          },
        },
        "https://cats.example/cat",
        { kind: "image" }
      )
    );

    expect(lines.map((line) => line.annotations)).toStrictEqual([
      {
        answered: "https://img.example/cat.gif",
        as: "image",
        bytes: "8",
        link: "https://cats.example/cat",
        status: "200",
        took: "0ms",
        type: "image/gif",
      },
    ]);
  });

  it("logs a fetch that failed by its reason, with nothing answered", async () => {
    const lines = await linesAfter(
      fetchOne(
        { "https://gone.example/": new LinkUnreachable({ reason: "gone.example has no address" }) },
        "https://gone.example/",
        { kind: "oembed" }
      )
    );

    expect(lines.map((line) => line.annotations)).toStrictEqual([
      {
        as: "oembed",
        bytes: "0",
        failed: "LinkUnreachable",
        link: "https://gone.example/",
        took: "0ms",
        why: "gone.example has no address",
      },
    ]);
  });

  it("logs a body that failed as it was read, with the bytes read before it did", async () => {
    const lines = await linesAfter(
      fetchOne(
        { "https://big.example/a.png": { type: "image/png", zeros: limits.raster + 1 } },
        "https://big.example/a.png",
        { kind: "image" }
      )
    );

    expect(lines.map((line) => line.annotations)).toStrictEqual([
      expect.objectContaining({
        bytes: String(limits.raster),
        failed: "LinkTooLarge",
        status: "200",
        why: `over ${limits.raster} bytes`,
      }),
    ]);
  });

  it("logs a stream's range as it was asked", async () => {
    const lines = await linesAfter(
      fetchOne(
        { "https://media.example/a.mp4": { body: "0123456789", type: "video/mp4" } },
        "https://media.example/a.mp4",
        { kind: "stream", range: { end: 4, start: 2 } }
      )
    );

    expect(lines.map((line) => line.annotations)).toStrictEqual([
      expect.objectContaining({ as: "stream [2, 4)", bytes: "2", status: "206" }),
    ]);
  });

  it("contains a stranger's words, so no link or reason can forge a line of its own", async () => {
    const forged = "\n2026-11-22 Error The Daemon was taken";

    const lines = await linesAfter(
      Effect.all([
        fetchOne(
          {
            "https://evil.example/": new LinkWrongType({
              link: `https://evil.example/${forged}`,
              status: 200,
              type: `text/plain${forged}`,
            }),
          },
          "https://evil.example/",
          { kind: "page" }
        ),
        fetchOne(
          { "https://evil.example/": new LinkUnreachable({ reason: `refused\r${forged}\u2028` }) },
          "https://evil.example/",
          { kind: "page" }
        ),
      ])
    );

    const words = lines.flatMap((line) => [line.message, ...Object.values(line.annotations)]);

    expect(words.filter((word) => /[\r\n\u2028]/u.test(word))).toStrictEqual([]);
    expect(
      lines.map(({ annotations }) => [annotations.answered, annotations.type, annotations.why])
    ).toStrictEqual([
      [
        String.raw`https://evil.example/\u{a}2026-11-22 Error The Daemon was taken`,
        String.raw`text/plain\u{a}2026-11-22 Error The Daemon was taken`,
        undefined,
      ],
      [
        undefined,
        undefined,
        String.raw`refused\u{d}\u{a}2026-11-22 Error The Daemon was taken\u{2028}`,
      ],
    ]);
  });

  it("logs how long a fetch took, from its ask to its end", async () => {
    // A link fetch that answers after 250 milliseconds, on a clock only the test moves.
    const slow: LinkFetchService = {
      fetch: () =>
        Effect.as(Effect.sleep("250 millis"), {
          body: Stream.empty,
          headers: {},
          link: "https://slow.example/",
          status: 200,
          type: "image/png",
        } satisfies Fetched),
    };

    const lines = await linesAfter(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.scoped(logged(slow, "https://slow.example/", { kind: "image" }))
        );

        yield* TestClock.adjust("250 millis");
        yield* Fiber.join(fiber);
      })
    );

    expect(lines.map((line) => line.annotations.took)).toStrictEqual(["250ms"]);
  });
});

describe(contained, () => {
  it.each([
    ["a line feed", "a\nb", String.raw`a\u{a}b`],
    ["a carriage return", "a\rb", String.raw`a\u{d}b`],
    ["a line separator", "a\u2028b", String.raw`a\u{2028}b`],
    ["a paragraph separator", "a\u2029b", String.raw`a\u{2029}b`],
    ["an escape, which drives a terminal", "a\u001B[2Jb", String.raw`a\u{1b}[2Jb`],
    ["a C1 control", "a\u0085b", String.raw`a\u{85}b`],
    ["a right-to-left override", "a\u202Eb", String.raw`a\u{202e}b`],
    ["plain words", "https://cats.example/?q=a b", "https://cats.example/?q=a b"],
  ])("writes %s so it cannot break or reorder the line", (_, text, written) => {
    expect(contained(text)).toBe(written);
  });

  it("cuts words past 2048 characters", () => {
    expect(contained("a".repeat(3000))).toBe(`${"a".repeat(2048)}…`);
  });
});
