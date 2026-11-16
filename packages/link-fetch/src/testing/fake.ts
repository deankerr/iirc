/**
 * The fake link fetch: answers recorded responses by link, as the guard would for the
 * purpose asked, and records what was asked.
 *
 * @packageDocumentation
 */
import { Effect, Ref, Stream } from "effect";

import { LinkTooLarge, LinkUnreachable, LinkWrongType, limits } from "../link-fetch.ts";
import type { Fetched, LinkFetchFailure, LinkFetchService, Purpose } from "../link-fetch.ts";

/** A response to answer, with the status 200 and no headers beyond its type unless given. */
export interface Recorded {
  readonly type: string;
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | string;
  /** The link it answers as, as after a redirect. Defaults to the link asked for. */
  readonly link?: string;
}

/** What a link answers: a response, or a failure. */
export type Answer = Recorded | LinkFetchFailure;

/** One fetch asked of the fake. */
export interface Asked {
  readonly link: string;
  readonly purpose: Purpose;
}

/** The fake, and what has been asked of it, in order. */
export interface FakeLinkFetch {
  readonly service: LinkFetchService;
  readonly asked: Effect.Effect<readonly Asked[]>;
}

/**
 * A link as the guard reads it: as the URL parser normalises it, without its fragment.
 * @param link - The link.
 * @returns The link, normalised.
 */
const normalised = (link: string) => {
  const url = URL.parse(link);

  if (url === null) {
    return link;
  }

  url.hash = "";

  return url.href;
};

const isFailure = (answer: Answer): answer is LinkFetchFailure => "_tag" in answer;

const encoder = new TextEncoder();

// The image types the guard takes, `image/jpg` standing for `image/jpeg` as it does there.
const imageTypes = new Map([
  ["image/png", "image/png"],
  ["image/jpeg", "image/jpeg"],
  ["image/jpg", "image/jpeg"],
  ["image/gif", "image/gif"],
  ["image/webp", "image/webp"],
  ["image/avif", "image/avif"],
  ["image/svg+xml", "image/svg+xml"],
]);

const pageTypes = new Set(["text/html", "application/xhtml+xml"]);

/** The type a purpose takes a declared type as, or nothing when it does not take it. */
const takes: Record<Purpose["kind"], (type: string) => string | undefined> = {
  image: (type) => imageTypes.get(type),
  oembed: (type) => (type === "application/json" || type.endsWith("+json") ? type : undefined),
  page: (type) => (pageTypes.has(type) ? type : undefined),
  stream: (type) => (type.startsWith("video/") || type.startsWith("audio/") ? type : undefined),
};

/** The most a body of a purpose and type may give. */
const caps: Record<Purpose["kind"], (type: string) => number> = {
  image: (type) => (type === "image/svg+xml" ? limits.svg : limits.raster),
  oembed: () => limits.oembed,
  page: () => limits.page,
  stream: () => limits.stream,
};

/**
 * A recorded response as the guard answers it for a purpose: refused as `LinkWrongType`
 * when the purpose does not take its type, a page cut cleanly at its limit, and any other
 * body over its limit failing with `LinkTooLarge` as it is read. Its leading bytes are not
 * read, so an image is taken by its declared type alone.
 * @param link - The link asked, normalised.
 * @param purpose - What it is fetched for.
 * @param recorded - The response.
 * @returns The answer, or why there is none.
 */
const answered = (link: string, purpose: Purpose, recorded: Recorded) => {
  const raw = recorded.body ?? new Uint8Array();
  const body = raw instanceof Uint8Array ? new Uint8Array(raw) : encoder.encode(raw);
  const answeredAs = recorded.link === undefined ? link : normalised(recorded.link);
  const declared = recorded.type.split(";")[0]?.trim().toLowerCase() ?? "";
  const type = takes[purpose.kind](declared);

  if (type === undefined) {
    return Effect.fail(new LinkWrongType({ link: answeredAs, type: declared }));
  }

  const limit = caps[purpose.kind](type);

  const over = body.length > limit;
  const page = purpose.kind === "page";

  const bounded: Fetched["body"] =
    over && !page ? Stream.fail(new LinkTooLarge({ limit })) : Stream.make(body.slice(0, limit));

  return Effect.succeed({
    body: bounded,
    headers: { "content-type": recorded.type, ...recorded.headers },
    link: answeredAs,
    status: recorded.status ?? 200,
    type,
  } satisfies Fetched);
};

/**
 * Makes a fake link fetch. A link is matched as the URL parser normalises it, and one with no
 * answer is unreachable. A recorded response is answered as the guard would for the purpose:
 * of a type the purpose takes, and bounded for it.
 * @param answers - What each link answers.
 * @returns The fake.
 */
export const makeFakeLinkFetch = (
  answers: Readonly<Record<string, Answer>>
): Effect.Effect<FakeLinkFetch> =>
  Effect.gen(function* () {
    const asked = yield* Ref.make<readonly Asked[]>([]);

    const byLink = new Map(
      Object.entries(answers).map(([link, answer]) => [normalised(link), answer])
    );

    const service: LinkFetchService = {
      fetch: (link, purpose) =>
        Effect.gen(function* () {
          yield* Ref.update(asked, (all) => [...all, { link, purpose }]);

          const key = normalised(link);
          const answer = byLink.get(key);

          if (answer === undefined) {
            return yield* new LinkUnreachable({ reason: "no recorded answer" });
          }

          if (isFailure(answer)) {
            return yield* answer;
          }

          return yield* answered(key, purpose, answer);
        }),
    };

    return { asked: Ref.get(asked), service };
  });
