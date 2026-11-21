/**
 * What each fetch for a Preview came to, logged once it settles, so the Tail shows why a
 * Preview looks as it does: the link, what it was fetched as, what answered, and, for a
 * page, which of its parts it gave. Nothing of a body's contents is logged, and every
 * stranger's word in a line is contained.
 *
 * @packageDocumentation
 */
import type {
  BodyFailure,
  Fetched,
  LinkFetchFailure,
  LinkFetchService,
  Purpose,
} from "@iirc/link-fetch";
import { Clock, Effect, Ref, Stream } from "effect";
import type { Scope } from "effect";

import type { PageRead } from "./read.ts";

// C0 and C1 controls, DEL, the Unicode line and paragraph separators, and bidirectional
// controls: what would break a line, drive a terminal, or reorder what it says.
const controls = /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/gu;

/** The most of a stranger's words a line holds, so no host's redirect swells the Tail. */
const longest = 2048;

/**
 * A stranger's words as a line holds them: each control written as its code point, so it
 * can neither end the line nor hide, and cut at {@link longest}.
 * @param text - The words.
 * @returns Them, on one line.
 */
export const contained = (text: string): string => {
  const escaped = text.replaceAll(
    controls,
    (control) => `\\u{${control.codePointAt(0)?.toString(16) ?? ""}}`
  );

  return escaped.length > longest ? `${escaped.slice(0, longest)}…` : escaped;
};

/** What is known of a fetch so far. */
interface Known {
  readonly answer?: Pick<Fetched, "link" | "status" | "type">;
  readonly bytes: number;
  readonly failure?: LinkFetchFailure;
  readonly said?: PageRead;
}

/** A fetch whose line is logged as its Scope closes, and how a page's reading joins it. */
export interface Logged {
  /** What answered, its body counted as it is read. */
  readonly fetched: Fetched;
  /** Adds what a page said of itself to the line: which parts it gave, never their words. */
  readonly said: (page: PageRead) => Effect.Effect<void>;
}

/**
 * What a link was fetched as.
 * @param purpose - The purpose.
 * @returns Its kind, and for a stream its range, from its start up to but not including its end.
 */
const asOf = (purpose: Purpose): string =>
  purpose.kind === "stream" && purpose.range !== undefined
    ? `stream [${purpose.range.start}, ${purpose.range.end ?? ""})`
    : purpose.kind;

/** Why a fetch failed, as its line says it. */
interface Why {
  readonly failed: LinkFetchFailure["_tag"];
  readonly why?: string;
  readonly answered?: string;
  readonly type?: string;
}

/**
 * Why a fetch failed, in the words of its reason.
 * @param failure - The failure.
 * @returns Its annotations.
 */
const whyOf = (failure: LinkFetchFailure): Why => {
  switch (failure._tag) {
    case "LinkRefused":
    case "LinkUnreachable": {
      return { failed: failure._tag, why: contained(failure.reason) };
    }

    case "LinkTimedOut": {
      return { failed: failure._tag };
    }

    case "LinkTooLarge": {
      return { failed: failure._tag, why: `over ${failure.limit} bytes` };
    }

    case "LinkWrongType": {
      return {
        answered: contained(failure.link),
        failed: failure._tag,
        type: contained(failure.type),
      };
    }

    default: {
      return failure satisfies never;
    }
  }
};

const yesOrNo = (given: boolean): "no" | "yes" => (given ? "yes" : "no");

/**
 * A fetch's line, as annotations, in the order they are read.
 * @param link - The link asked for.
 * @param purpose - What it was fetched as.
 * @param known - What it came to.
 * @param took - How long it took, in milliseconds.
 * @returns The annotations.
 */
const annotationsOf = (link: string, purpose: Purpose, known: Known, took: number) => {
  const { answer, failure, said } = known;

  // oxlint-disable-next-line sort-keys -- the keys are in the order the line reads.
  return {
    link: contained(link),
    as: asOf(purpose),
    ...(answer !== undefined && {
      answered: contained(answer.link),
      status: String(answer.status),
      type: contained(answer.type),
    }),
    bytes: String(known.bytes),
    took: `${took}ms`,
    // oxlint-disable-next-line sort-keys -- the keys are in the order the line reads.
    ...(said !== undefined && {
      title: yesOrNo(said.title !== undefined),
      description: yesOrNo(said.description !== undefined),
      image: yesOrNo(said.image !== undefined),
      player: yesOrNo((said.players ?? []).length > 0),
      video: yesOrNo(said.video !== undefined),
      oembed: yesOrNo(said.oembed !== undefined),
    }),
    ...(failure !== undefined && whyOf(failure)),
  };
};

/**
 * Fetches a link for a Preview, logging at `Debug` what it came to as its Scope closes: the
 * link, what it was fetched as, the link that answered, its status and type, how many bytes
 * of its body were read, how long it took, waiting for its turn included, and, if it failed
 * before or while its body was read, why.
 * @param links - The link fetch.
 * @param link - The link.
 * @param purpose - What it is fetched as.
 * @returns The fetch, and how a page's reading joins its line.
 */
export const logged = (
  links: LinkFetchService,
  link: string,
  purpose: Purpose
): Effect.Effect<Logged, LinkFetchFailure, Scope.Scope> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const known = yield* Ref.make<Known>({ bytes: 0 });

    const failed = (failure: LinkFetchFailure) => Ref.update(known, (now) => ({ ...now, failure }));

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const took = (yield* Clock.currentTimeMillis) - started;

        yield* Effect.logDebug("Fetched a link for a Preview").pipe(
          Effect.annotateLogs(annotationsOf(link, purpose, yield* Ref.get(known), took))
        );
      })
    );

    const fetched = yield* links
      .fetch(link, purpose)
      .pipe(Effect.tapError((failure) => failed(failure)));

    yield* Ref.update(known, (now) => ({ ...now, answer: fetched }));

    const body: Stream.Stream<Uint8Array, BodyFailure> = fetched.body.pipe(
      Stream.tap((chunk) =>
        Ref.update(known, (now) => ({ ...now, bytes: now.bytes + chunk.length }))
      ),
      Stream.tapError((failure) => failed(failure))
    );

    return {
      fetched: { ...fetched, body },
      said: (page) => Ref.update(known, (now) => ({ ...now, said: page })),
    };
  });

/**
 * The link fetch, each fetch logged as {@link logged} logs it.
 * @param links - The link fetch.
 * @returns It, logging.
 */
export const logging = (links: LinkFetchService): LinkFetchService => ({
  fetch: (link, purpose) => Effect.map(logged(links, link, purpose), ({ fetched }) => fetched),
});
