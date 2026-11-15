/**
 * The fake link fetch: answers recorded responses by link, and records what was asked.
 *
 * @packageDocumentation
 */
import { Effect, Ref, Stream } from "effect";

import { LinkUnreachable } from "../link-fetch.ts";
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

const normalised = (link: string) => URL.parse(link)?.href ?? link;

const isFailure = (answer: Answer): answer is LinkFetchFailure => "_tag" in answer;

const encoder = new TextEncoder();

const answered = (link: string, recorded: Recorded): Fetched => {
  const body = recorded.body ?? new Uint8Array();

  return {
    body: Stream.make(body instanceof Uint8Array ? new Uint8Array(body) : encoder.encode(body)),
    headers: { "content-type": recorded.type, ...recorded.headers },
    link: recorded.link ?? link,
    status: recorded.status ?? 200,
    type: recorded.type,
  };
};

/**
 * Makes a fake link fetch. A link is matched as the URL parser normalises it, and one with no
 * answer is unreachable.
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

          return answered(key, answer);
        }),
    };

    return { asked: Ref.get(asked), service };
  });
