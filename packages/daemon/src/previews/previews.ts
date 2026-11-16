/**
 * Previews: a Message's links, fetched through the link fetch when a Frontend asks, read
 * into a Preview, and kept in the Preview cache by link, so one link in many Messages is
 * fetched once. A Preview is a cache outside the Journal (ADR 0017): nothing here is
 * journaled, and losing the cache loses nothing but fetches.
 *
 * @packageDocumentation
 */
import { createHash } from "node:crypto";

import { PreviewId, PreviewsOff, UnknownMessage, UnknownTimeline } from "@iirc/api";
import type { PreviewFailure, PreviewItem, PreviewState } from "@iirc/api";
import { LinkFetch } from "@iirc/link-fetch";
import type { Fetched, LinkFetchFailure, LinkFetchService } from "@iirc/link-fetch";
import { PreviewCache } from "@iirc/preview-cache";
import type { Kept, Settled } from "@iirc/preview-cache";
import { previewableLinksOf } from "@iirc/protocol/links";
import { TimelineStore } from "@iirc/timeline-store";
import type { TimelineStoreFailed } from "@iirc/timeline-store";
import { comparePositions } from "@iirc/timelines";
import type { Position, TimelineId } from "@iirc/timelines";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  PubSub,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";

import { UiConfiguration } from "../ui.ts";
import { fillFromOembed, readMedia, readOembed, readPage } from "./read.ts";
import type { PageRead } from "./read.ts";

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

const failed = (reason: PreviewFailure): Settled => ({ _tag: "Failed", reason });

/**
 * A text Preview of a link to media itself, from its type alone: its body is never read.
 * @param link - The link it answered as.
 * @param type - Its media type.
 * @returns The state, or nothing to show when the type is not media.
 */
const mediaPreview = (link: string, type: string): Settled => {
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
 * @param failure - Why the fetch gave no page.
 * @returns The state.
 */
const failedFetch = (failure: LinkFetchFailure): Settled => {
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
      return mediaPreview(failure.link, failure.type);
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

const utf8 = new TextDecoder("utf-8");

/**
 * The page's own reading, with its gaps filled from the oEmbed address it names, fetched
 * through the same port and so the same guard. Whatever goes wrong there, in any way at
 * all, leaves the page's own reading exactly as it was.
 * @param links - The link fetch.
 * @param page - What the page said of itself.
 * @returns The page, filled as far as the answer allowed.
 */
const filled = (links: LinkFetchService, page: PageRead) => {
  const { oembed: address } = page;

  return address === undefined
    ? Effect.succeed(page)
    : Effect.gen(function* () {
        const answer = yield* links.fetch(address, { kind: "oembed" });

        if (answer.status < 200 || answer.status > 299) {
          return page;
        }

        const read = readOembed(utf8.decode(joined(yield* Stream.runCollect(answer.body))));

        return read === undefined ? page : fillFromOembed(page, read, answer.link);
      }).pipe(
        Effect.scoped,
        Effect.orElseSucceed(() => page),
        Effect.catchDefect(() => Effect.succeed(page))
      );
};

/**
 * What a page's answer shows: a Preview of media from its type alone, or of the page read
 * from its head and filled from the oEmbed address it names.
 * @param links - The link fetch.
 * @param fetched - The answer.
 * @returns The state.
 */
const answered = (links: LinkFetchService, fetched: Fetched) =>
  Effect.gen(function* () {
    if (readMedia(fetched.type) !== undefined) {
      return mediaPreview(fetched.link, fetched.type);
    }

    const head = joined(yield* Stream.runCollect(fetched.body));

    const page = yield* filled(
      links,
      readPage({ contentType: fetched.headers["content-type"], head, link: fetched.link })
    );

    return page.title === undefined && page.description === undefined
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
        } satisfies Settled);
  });

/** A Direct Message's link that is not yet kept: fetched only once the Owner presses it. */
const waiting: PreviewState = { _tag: "WaitingForPress" };

const pending: PreviewState = { _tag: "Pending" };

/**
 * How long a ready Preview is served as it is before it is fetched again: a page's title
 * and description change slowly, so a day keeps the text fresh without a fetch per view.
 */
const readyFor = Duration.toMillis(Duration.days(1));

/**
 * How long a failure is served without fetching again: a dead link stays dead for a while,
 * and an hour bounds what asking it costs, yet lets a page that was down be tried again.
 */
const failedFor = Duration.toMillis(Duration.hours(1));

/**
 * Logs a Preview cache that failed. A cache that cannot be read or written never fails an
 * ask: a read is a miss, and a write leaves the item shown but not kept.
 * @param what - What it could not be.
 * @returns What logs a failure.
 */
const warn = (what: string) => (error: { readonly reason: string }) =>
  Effect.logWarning(`The Preview cache could not be ${what}: ${error.reason}`);

/** A link being fetched now: what to answer meanwhile, and when it was last shown. */
interface Flight {
  readonly state: PreviewState;
  readonly shown: number;
}

/** A link's state when asked, and whether the ask started its fetch, and published it. */
interface Claimed {
  readonly state: PreviewState;
  readonly started: boolean;
  readonly publish: boolean;
}

/**
 * Whether a kept record is served as it is, and if not, whether it is fetched again.
 * @param kept - The record.
 * @param now - The time, in milliseconds since the epoch.
 * @param direct - Whether it is in a Direct Message, which never fetches.
 * @returns Whether it is stale.
 */
const stale = (kept: Kept, now: number, direct: boolean): boolean => {
  if (direct) {
    return false;
  }

  const age = now - kept.fetched;

  return kept.state._tag === "Ready" ? age > readyFor : age >= failedFor;
};

/**
 * The Previews, kept in the Preview cache by link, needing the link fetch, the Preview
 * cache, the Timeline store, and the `ui` options. Only the links being fetched now are
 * held in memory. Each fetch runs in the Layer's Scope, so it ends when the Daemon stops.
 */
export const layerPreviews = Layer.effect(Previews)(
  Effect.gen(function* () {
    const links = yield* LinkFetch;
    const cache = yield* PreviewCache;
    const store = yield* TimelineStore;
    const ui = yield* UiConfiguration;
    const scope = yield* Scope.Scope;
    const flying = yield* Ref.make<ReadonlyMap<string, Flight>>(new Map());
    // Looking in flight and in the cache, and claiming a fetch, is one turn, and so is
    // keeping what settled and leaving flight, so no link is fetched twice.
    const turn = yield* Semaphore.make(1);
    const changed = yield* PubSub.unbounded<PreviewItem>();

    const settle = (key: string, link: string, state: Settled) =>
      Effect.gen(function* () {
        yield* turn.withPermit(
          Effect.gen(function* () {
            const fetched = yield* Clock.currentTimeMillis;
            const flight = (yield* Ref.get(flying)).get(key);

            yield* cache
              .put({ fetched, image: null, link: key, shown: flight?.shown ?? fetched, state })
              .pipe(Effect.catch(warn("written")));
            yield* Ref.update(flying, (now) => {
              const rest = new Map(now);

              rest.delete(key);

              return rest;
            });
          })
        );
        yield* PubSub.publish(changed, { id: idOf(key), link, state });
      });

    // Every failure of the fetch is answered with its reason, and anything unforeseen with
    // `Unreachable`, so no Preview stays pending for ever.
    const fetchOne = (key: string, link: string) =>
      Effect.scoped(
        links.fetch(key, { kind: "page" }).pipe(
          Effect.flatMap((fetched) => answered(links, fetched)),
          Effect.catch((error) => Effect.succeed(failedFetch(error)))
        )
      ).pipe(
        Effect.catchDefect(() => Effect.succeed(failed("Unreachable"))),
        Effect.flatMap((state) => settle(key, link, state))
      );

    /**
     * Decides what an ask of a link answers and whether it starts a fetch, in one turn.
     * @param key - The link it is kept under.
     * @param direct - Whether it is in a Direct Message.
     * @returns What it answers and whether it started.
     */
    const claim = (key: string, direct: boolean) =>
      turn.withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const flight = (yield* Ref.get(flying)).get(key);

          if (flight !== undefined) {
            yield* Ref.update(
              flying,
              (held) => new Map([...held, [key, { ...flight, shown: now }]])
            );

            return { publish: false, started: false, state: flight.state } satisfies Claimed;
          }

          const kept = yield* cache
            .shown(key, now)
            .pipe(Effect.catch((error) => Effect.as(warn("read")(error), Option.none<Kept>())));

          if (Option.isSome(kept) && !stale(kept.value, now, direct)) {
            return { publish: false, started: false, state: kept.value.state } satisfies Claimed;
          }

          if (Option.isNone(kept) && direct) {
            return { publish: false, started: false, state: waiting } satisfies Claimed;
          }

          // A ready Preview is served as it is while it is fetched again, and the stream
          // carries the new one, so only a link with nothing to show is published pending.
          const old = Option.isSome(kept) && kept.value.state._tag === "Ready";
          const state: PreviewState = old ? kept.value.state : pending;
          const shown = Option.isSome(kept) ? Math.max(kept.value.shown, now) : now;

          yield* Ref.update(flying, (held) => new Map([...held, [key, { shown, state }]]));

          return { publish: !old, started: true, state } satisfies Claimed;
        })
      );

    /**
     * A link's state, starting its fetch if it is not kept fresh or being fetched, or in a
     * Direct Message, waiting for a press until it is kept.
     * @param link - The link, as the URL parser wrote it.
     * @param direct - Whether it is in a Direct Message.
     * @returns Its item.
     */
    const stateOf = (link: string, direct: boolean) =>
      Effect.gen(function* () {
        const key = keyOf(link);
        const { publish, started, state } = yield* claim(key, direct);

        if (publish) {
          yield* PubSub.publish(changed, { id: idOf(key), link, state });
        }

        if (started) {
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
