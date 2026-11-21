/**
 * The fake link fetch: answers recorded responses by link, as the guard would for the
 * purpose asked, paced as the guard is, and records what was fetched.
 *
 * @packageDocumentation
 */
import { Effect, Latch, Ref, Stream } from "effect";

import { LinkTooLarge, LinkUnreachable, LinkWrongType, limits } from "../link-fetch.ts";
import type { Fetched, LinkFetchFailure, LinkFetchService, Purpose } from "../link-fetch.ts";
import { makePacer } from "../pacer.ts";
import type { Precedence } from "../pacer.ts";

/**
 * A response to answer, with the status 200 and no headers beyond its type unless given. Given
 * no status, a stream with a range is answered as a host serving ranges would: `206` and the
 * part asked, or `416` for a range past the end. Given a status, it is answered as recorded, whole.
 */
export interface Recorded {
  readonly type: string;
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | string;
  /**
   * In place of a body, this many bytes of zeros, made as they are read, so a body as large
   * as the stream limit is never held.
   */
  readonly zeros?: number;
  /** The link it answers as, as after a redirect. Defaults to the link asked for. */
  readonly link?: string;
}

/** What a link answers: a response, or a failure. */
export type Answer = Recorded | LinkFetchFailure;

/** One fetch made by the fake, once its turn came. */
export interface Asked {
  readonly link: string;
  readonly purpose: Purpose;
  readonly precedence: Precedence;
}

/** The fake, and what it has fetched, in order. */
export interface FakeLinkFetch {
  readonly service: LinkFetchService;
  /** Each fetch made, once its turn came, in the order they were made. */
  readonly asked: Effect.Effect<readonly Asked[]>;
  /** Lets a held link answer, now and from then on. */
  readonly release: (link: string) => Effect.Effect<void>;
}

/** How the fake answers beyond what each link answers. */
export interface FakeOptions {
  /**
   * Links whose fetches are made but answer nothing until {@link FakeLinkFetch}'s `release`,
   * holding their place with the pacer meanwhile.
   */
  readonly held?: readonly string[];
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

/** Bytes a recorded response holds, and how to read part of them. */
interface Content {
  readonly total: number;
  /** The bytes from `start` up to but not including `end`, as they arrive. */
  readonly slice: (start: number, end: number) => Stream.Stream<Uint8Array>;
}

const zeroChunk = new Uint8Array(1024 * 1024);

/**
 * The bytes of a recorded response.
 * @param recorded - The response.
 * @returns Its bytes.
 */
const contentOf = ({ body, zeros }: Recorded): Content => {
  if (zeros !== undefined) {
    return {
      slice: (start, end) =>
        Stream.unfold(Math.max(0, end - start), (left) =>
          Effect.succeed(
            left <= 0
              ? undefined
              : ([
                  zeroChunk.subarray(0, Math.min(left, zeroChunk.length)),
                  left - zeroChunk.length,
                ] as const)
          )
        ),
      total: zeros,
    };
  }

  const bytes = body instanceof Uint8Array ? body : encoder.encode(body);

  return {
    slice: (start, end) => Stream.make(bytes.slice(start, end)),
    total: bytes.length,
  };
};

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
 * body over its limit giving its bytes up to the limit and then failing with `LinkTooLarge`
 * as it is read. Its leading bytes are not read, so an image is taken by its declared type
 * alone. A stream with a range, of a response with no status recorded, is answered as a host
 * serving ranges would.
 * @param link - The link asked, normalised.
 * @param purpose - What it is fetched for.
 * @param recorded - The response.
 * @returns The answer, or why there is none.
 */
const answered = (link: string, purpose: Purpose, recorded: Recorded) => {
  const content = contentOf(recorded);
  const answeredAs = recorded.link === undefined ? link : normalised(recorded.link);
  const declared = recorded.type.split(";")[0]?.trim().toLowerCase() ?? "";

  // A stream's 416 carries no media, so its type is taken as it is, as the guard takes it.
  const type =
    purpose.kind === "stream" && recorded.status === 416 ? declared : takes[purpose.kind](declared);

  if (type === undefined) {
    return Effect.fail(new LinkWrongType({ link: answeredAs, type: declared }));
  }

  const limit = caps[purpose.kind](type);

  const range =
    purpose.kind === "stream" && recorded.status === undefined ? purpose.range : undefined;

  const answer = (status: number, headers: Record<string, string>, body: Fetched["body"]) =>
    Effect.succeed({
      body,
      headers: { "content-type": recorded.type, ...headers, ...recorded.headers },
      link: answeredAs,
      status,
      type,
    } satisfies Fetched);

  if (range !== undefined && range.start >= content.total) {
    return answer(416, { "content-range": `bytes */${content.total}` }, Stream.empty);
  }

  const start = range?.start ?? 0;
  const end = Math.min(range?.end ?? content.total, content.total);
  const page = purpose.kind === "page";

  const body: Fetched["body"] =
    end - start > limit && !page
      ? Stream.concat(content.slice(start, start + limit), Stream.fail(new LinkTooLarge({ limit })))
      : content.slice(start, Math.min(end, start + limit));

  return answer(
    range === undefined ? (recorded.status ?? 200) : 206,
    range === undefined
      ? {}
      : {
          "content-length": String(end - start),
          "content-range": `bytes ${start}-${end - 1}/${content.total}`,
        },
    body
  );
};

/**
 * Makes a fake link fetch. A link is matched as the URL parser normalises it, and one with no
 * answer is unreachable. A recorded response is answered as the guard would for the purpose:
 * of a type the purpose takes, and bounded for it. Each fetch is paced as the guard paces it,
 * as one hop to the name of the link asked, holding its place until the caller's Scope closes.
 * @param answers - What each link answers.
 * @param options - Which links are held.
 * @returns The fake.
 */
export const makeFakeLinkFetch = (
  answers: Readonly<Record<string, Answer>>,
  options: FakeOptions = {}
): Effect.Effect<FakeLinkFetch> =>
  Effect.gen(function* () {
    const asked = yield* Ref.make<readonly Asked[]>([]);
    const pacer = yield* makePacer;

    const byLink = new Map(
      Object.entries(answers).map(([link, answer]) => [normalised(link), answer])
    );

    const holds = new Map<string, Latch.Latch>();

    for (const link of options.held ?? []) {
      holds.set(normalised(link), yield* Latch.make(false));
    }

    const service: LinkFetchService = {
      fetch: (link, purpose, precedence = "first") =>
        Effect.gen(function* () {
          const key = normalised(link);
          const turn = yield* pacer.ask(precedence);

          yield* turn.start;
          yield* turn.hop(URL.parse(key)?.hostname ?? key);
          yield* Ref.update(asked, (all) => [...all, { link, precedence, purpose }]);

          const hold = holds.get(key);

          if (hold !== undefined) {
            yield* hold.await;
          }

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

    const release = (link: string) => {
      const hold = holds.get(normalised(link));

      return hold === undefined ? Effect.void : Effect.asVoid(hold.open);
    };

    return { asked: Ref.get(asked), release, service };
  });
