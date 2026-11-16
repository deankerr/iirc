/**
 * Previews: a Message's links, fetched through the link fetch when a Frontend asks, read
 * into a Preview, and kept in memory by link, so one link in many Messages is fetched once.
 * A Preview is a cache outside the Journal (ADR 0017): nothing here is journaled, and a
 * restart forgets every one.
 *
 * @packageDocumentation
 */
import { createHash } from "node:crypto";

import { PreviewId, PreviewsOff, UnknownMessage, UnknownTimeline } from "@iirc/api";
import type { PreviewFailure, PreviewItem, PreviewState } from "@iirc/api";
import { LinkFetch } from "@iirc/link-fetch";
import type { Fetched, LinkFetchFailure } from "@iirc/link-fetch";
import { previewableLinksOf } from "@iirc/protocol/links";
import { TimelineStore } from "@iirc/timeline-store";
import type { TimelineStoreFailed } from "@iirc/timeline-store";
import { comparePositions } from "@iirc/timelines";
import type { Position, TimelineId } from "@iirc/timelines";
import { Context, Effect, Layer, Option, PubSub, Ref, Schema, Scope, Stream } from "effect";

import { UiConfiguration } from "../ui.ts";
import { readMedia, readPage } from "./read.ts";

/** What the Daemon offers of Previews. */
export class Previews extends Context.Service<
  Previews,
  {
    /**
     * The Previews of the Message at a position in a Timeline, one for each link that may be
     * previewed, starting a fetch for each link not yet fetched or being fetched.
     */
    readonly ask: (
      timeline: TimelineId,
      position: Position
    ) => Effect.Effect<
      readonly PreviewItem[],
      UnknownTimeline | UnknownMessage | PreviewsOff | TimelineStoreFailed
    >;
    /** Each link's item, every time its Preview's state changes, from now on. */
    readonly changes: Stream.Stream<PreviewItem>;
  }
>()("@iirc/daemon/Previews") {}

const decodeId = Schema.decodeSync(PreviewId);

/**
 * The link a Preview is kept under: as the URL parser wrote it, without its fragment, which
 * never reaches the host.
 * @param href - The link, as the URL parser wrote it.
 * @returns The link it is kept under.
 */
const keyOf = (href: string): string => {
  const url = URL.parse(href);

  if (url === null) {
    return href;
  }

  url.hash = "";

  return url.href;
};

/**
 * A Preview's id: the first 128 bits of the SHA-256 of the link it is kept under, so it is
 * the same for the link wherever it is posted, and says nothing of it.
 * @param key - The link it is kept under.
 * @returns The id.
 */
const idOf = (key: string): PreviewId =>
  decodeId(createHash("sha256").update(key).digest("hex").slice(0, 32));

/**
 * The host of a link, as its site when the page names none.
 * @param link - The link.
 * @returns Its host, or the link when it has none.
 */
const hostOf = (link: string): string => URL.parse(link)?.host ?? link;

const failed = (reason: PreviewFailure): PreviewState => ({ _tag: "Failed", reason });

/**
 * A text Preview of a link to media itself, from its type alone: its body is never read.
 * @param link - The link it answered as.
 * @param type - Its media type.
 * @returns The state, or nothing to show when the type is not media.
 */
const mediaPreview = (link: string, type: string): PreviewState => {
  const kind = readMedia(type);

  return kind === undefined
    ? failed("NothingToShow")
    : {
        _tag: "Ready",
        preview: { description: null, kind, link, site: hostOf(link), title: null, type },
      };
};

/**
 * What a fetch that failed shows: the reason, or for an answer of another type than a page,
 * a text Preview of it when it is media.
 * @param link - The link asked for.
 * @param failure - Why the fetch gave no page.
 * @returns The state.
 */
const failedFetch = (link: string, failure: LinkFetchFailure): PreviewState => {
  switch (failure._tag) {
    case "LinkRefused": {
      return failed("Refused");
    }

    case "LinkUnreachable": {
      return failed("Unreachable");
    }

    case "LinkTimedOut": {
      return failed("TimedOut");
    }

    case "LinkTooLarge": {
      return failed("TooLarge");
    }

    case "LinkWrongType": {
      return mediaPreview(link, failure.type);
    }

    default: {
      return failure satisfies never;
    }
  }
};

/**
 * Bytes, one after another.
 * @param chunks - The chunks.
 * @returns Them, joined.
 */
const joined = (chunks: readonly Uint8Array[]): Uint8Array => {
  const whole = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let at = 0;

  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.length;
  }

  return whole;
};

/**
 * What a page's answer shows: a Preview of media from its type alone, or of the page read
 * from its head.
 * @param fetched - The answer.
 * @returns The state.
 */
const answered = (fetched: Fetched) =>
  Effect.gen(function* () {
    if (readMedia(fetched.type) !== undefined) {
      return mediaPreview(fetched.link, fetched.type);
    }

    const head = joined(yield* Stream.runCollect(fetched.body));

    const page = readPage({
      contentType: fetched.headers["content-type"],
      head,
      link: fetched.link,
    });

    return page === undefined
      ? failed("NothingToShow")
      : ({
          _tag: "Ready",
          preview: {
            description: page.description ?? null,
            kind: "page",
            link: fetched.link,
            site: page.site ?? hostOf(fetched.link),
            title: page.title ?? null,
            type: null,
          },
        } satisfies PreviewState);
  });

/** A Direct Message's link that is not yet kept: fetched only once the Owner presses it. */
const waiting: PreviewState = { _tag: "WaitingForPress" };

const pending: PreviewState = { _tag: "Pending" };

/** A link's state when asked, and whether the ask started its fetch. */
interface Claimed {
  readonly state: PreviewState;
  readonly started: boolean;
}

/**
 * The Previews, kept in memory by link, needing the link fetch, the Timeline store, and the
 * `ui` options. Each fetch runs in the Layer's Scope, so it ends when the Daemon stops.
 */
export const layerPreviews = Layer.effect(Previews)(
  Effect.gen(function* () {
    const links = yield* LinkFetch;
    const store = yield* TimelineStore;
    const ui = yield* UiConfiguration;
    const scope = yield* Scope.Scope;
    const kept = yield* Ref.make<ReadonlyMap<string, PreviewState>>(new Map());
    const changed = yield* PubSub.unbounded<PreviewItem>();

    const settle = (key: string, link: string, state: PreviewState) =>
      Effect.andThen(
        Ref.update(kept, (now) => new Map([...now, [key, state]])),
        PubSub.publish(changed, { id: idOf(key), link, state })
      );

    // Every failure of the fetch is answered with its reason, and anything unforeseen with
    // `Unreachable`, so no Preview stays pending for ever.
    const fetchOne = (key: string, link: string) =>
      Effect.scoped(
        links.fetch(key, { kind: "page" }).pipe(
          Effect.flatMap(answered),
          Effect.catch((error) => Effect.succeed(failedFetch(key, error)))
        )
      ).pipe(
        Effect.catchDefect(() => Effect.succeed(failed("Unreachable"))),
        Effect.flatMap((state) => settle(key, link, state))
      );

    /**
     * A link's state, starting its fetch if it is neither kept nor being fetched, or in a
     * Direct Message, waiting for a press until it is kept.
     * @param link - The link, as the URL parser wrote it.
     * @param direct - Whether it is in a Direct Message.
     * @returns Its item.
     */
    const stateOf = (link: string, direct: boolean) =>
      Effect.gen(function* () {
        const key = keyOf(link);

        const { started, state } = yield* Ref.modify(
          kept,
          (now): readonly [Claimed, ReadonlyMap<string, PreviewState>] => {
            const held = now.get(key);

            if (held !== undefined) {
              return [{ started: false, state: held }, now];
            }

            return direct
              ? [{ started: false, state: waiting }, now]
              : [{ started: true, state: pending }, new Map([...now, [key, pending]])];
          }
        );

        if (started) {
          yield* PubSub.publish(changed, { id: idOf(key), link, state: pending });
          yield* Effect.forkIn(fetchOne(key, link), scope);
        }

        const item: PreviewItem = { id: idOf(key), link, state };

        return item;
      });

    return {
      ask: (timeline, position) =>
        Effect.gen(function* () {
          const summary = yield* store.timeline(timeline);

          if (Option.isNone(summary)) {
            return yield* new UnknownTimeline({ timeline });
          }

          const { options } = yield* ui.inForce;

          if (options.previews === "off") {
            return yield* new PreviewsOff({ timeline });
          }

          const window = yield* store.window(timeline, { _tag: "Around", position }, 1);
          const [item] = Option.isSome(window) ? window.value.items : [];

          if (item?.content._tag !== "Message" || comparePositions(item.position, position) !== 0) {
            return yield* new UnknownMessage({ position, timeline });
          }

          const direct = summary.value.kind === "Direct";
          const { ours, text } = item.content;
          // What is shown is the echo's text once the Ircd confirmed it, which may differ from ours.
          const shown = ours?.delivery._tag === "Confirmed" ? ours.delivery.text : text;

          return yield* Effect.forEach(previewableLinksOf(shown), (found) =>
            stateOf(found.href, direct)
          );
        }),
      changes: Stream.fromPubSub(changed),
    };
  })
);
