/**
 * Previews: a Message's links, fetched through the link fetch when a Frontend asks, read
 * into a Preview, and kept in the Preview cache by link, so one link in many Messages is
 * fetched once. Under `on`, a Preview's image is fetched too, kept in the store, and served
 * from the Daemon's own origin. A Preview is a cache outside the Journal (ADR 0017): nothing
 * here is journaled, and losing the cache loses nothing but fetches.
 *
 * @packageDocumentation
 */
import { createHash } from "node:crypto";

import {
  LinksOnly,
  MediaType,
  NotWaiting,
  PreviewId,
  PreviewsOff,
  StreamFailed,
  UnknownMessage,
  UnknownStream,
  UnknownTimeline,
} from "@iirc/api";
import type {
  MediaHash,
  PreviewFailure,
  PreviewImage,
  PreviewItem,
  PreviewsShown,
  PreviewState,
} from "@iirc/api";
import { ByteStoreUnavailable, Sha256 } from "@iirc/byte-store";
import { LinkFetch, limits } from "@iirc/link-fetch";
import type {
  BodyFailure,
  Fetched,
  LinkFetchFailure,
  LinkFetchService,
  StreamRange,
} from "@iirc/link-fetch";
import { sniff, sniffed } from "@iirc/link-fetch-bun";
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
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  PubSub,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Sink,
  Stream,
} from "effect";

import { StoreBytes, hashOf } from "../store-bytes.ts";
import { UiConfiguration } from "../ui.ts";
import type { StartingRange } from "../uploads/wanted.ts";
import { animated } from "./animated.ts";
import { fillFromOembed, readMedia, readOembed, readPage } from "./read.ts";
import type { PageRead } from "./read.ts";
import { makeRoom } from "./room.ts";
import { previewStore } from "./store.ts";

/** No Preview holds an image with the hash, or the store no longer holds its bytes. */
export class NoSuchMedia extends Data.TaggedError("NoSuchMedia") {}

/** An image a Preview holds, as it is served: its type, read from its bytes, and they. */
export interface Media {
  readonly type: MediaType;
  readonly bytes: Stream.Stream<Uint8Array, ByteStoreUnavailable>;
}

/**
 * What a stream of a link answers: nothing that satisfies the range asked, with the host's
 * `Content-Range` when it gave one, or a body, whole or a part of the media, as it arrives.
 * Its headers are the host's own, when it sent them, and its length is given only when it
 * is of the bytes the body gives.
 */
export type Streamed =
  | { readonly _tag: "Unsatisfiable"; readonly contentRange?: string }
  | {
      readonly _tag: "Body";
      readonly status: 200 | 206;
      readonly type: string;
      readonly contentLength?: number;
      readonly contentRange?: string;
      readonly acceptRanges?: string;
      readonly body: Stream.Stream<Uint8Array, BodyFailure>;
    };

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
    /**
     * Fetches one link of the Message at a position in a Timeline that waits for a press,
     * answering its item, pending. A link that is not waiting is `NotWaiting`.
     */
    readonly press: (
      timeline: TimelineId,
      position: Position,
      link: number
    ) => Effect.Effect<
      PreviewItem,
      UnknownTimeline | UnknownMessage | PreviewsOff | NotWaiting | TimelineStoreFailed
    >;
    /** Each link's item, every time its Preview's state changes, from now on. */
    readonly changes: Stream.Stream<PreviewItem>;
    /**
     * The image a Preview holds, by its hash, with its type read from its leading bytes,
     * which are read before it answers. A hash no record kept refers to, or bytes of none
     * of the image types, is `NoSuchMedia`.
     */
    readonly media: (
      hash: MediaHash
    ) => Effect.Effect<Media, NoSuchMedia | ByteStoreUnavailable, Scope.Scope>;
    /**
     * The video or sound a link of the Message at a position in a Timeline is, streamed from
     * the address the Daemon read for its Preview, never any other, and kept nowhere. Only a
     * Timeline whose mode is `on` streams, and only a link whose kept Preview is ready and of
     * kind video or audio. A start at or past `limits.stream` is unsatisfiable without a
     * fetch, and any other range ends at `limits.stream` at the latest, so no byte past it is
     * ever asked for. The connection lives in the Scope, which must outlast the body.
     */
    readonly stream: (
      timeline: TimelineId,
      position: Position,
      id: PreviewId,
      range: StartingRange | undefined
    ) => Effect.Effect<
      Streamed,
      | UnknownTimeline
      | UnknownMessage
      | PreviewsOff
      | LinksOnly
      | UnknownStream
      | StreamFailed
      | TimelineStoreFailed,
      Scope.Scope
    >;
    /**
     * Whether any Preview kept holds the image with the hash, without reading its bytes. A
     * cache that cannot be read is as unavailable as the store.
     */
    readonly refers: (hash: MediaHash) => Effect.Effect<boolean, ByteStoreUnavailable>;
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
 * What a fetch of a link came to, and the address of the image it names, if any: a page's
 * own, or the link itself when it is an image.
 */
interface Read {
  readonly state: Settled;
  readonly image?: string | undefined;
}

const failedRead = (reason: PreviewFailure): Read => ({ state: failed(reason) });

/**
 * A text Preview of a link to media itself, from its type alone: its body is never read.
 * A link to an image names itself as the image.
 * @param link - The link it answered as.
 * @param type - Its media type.
 * @returns What it came to, or nothing to show when the type is not media.
 */
const mediaPreview = (link: string, type: string): Read => {
  const kind = readMedia(type);

  return kind === undefined
    ? failedRead("NothingToShow")
    : {
        image: kind === "image" ? link : undefined,
        state: {
          _tag: "Ready",
          preview: {
            description: null,
            image: null,
            kind,
            link,
            site: hostOf(link),
            title: null,
            type,
          },
        },
      };
};

/**
 * Why a fetch gave nothing, as a Preview's failure. An answer of another type than the
 * purpose takes is nothing to show.
 * @param failure - Why the fetch gave nothing.
 * @returns The reason.
 */
const reasonOf = (failure: LinkFetchFailure): PreviewFailure => {
  switch (failure._tag) {
    case "LinkRefused": {
      return "Refused";
    }

    case "LinkUnreachable": {
      return "Unreachable";
    }

    case "LinkTimedOut": {
      return "TimedOut";
    }

    case "LinkTooLarge": {
      return "TooLarge";
    }

    case "LinkWrongType": {
      return "NothingToShow";
    }

    default: {
      return failure satisfies never;
    }
  }
};

/**
 * What a fetch that failed shows: the reason, or for an answer of another type than a page,
 * a text Preview of it when it is media.
 * @param failure - Why the fetch gave no page.
 * @returns What it came to.
 */
const failedFetch = (failure: LinkFetchFailure): Read =>
  failure._tag === "LinkWrongType"
    ? mediaPreview(failure.link, failure.type)
    : failedRead(reasonOf(failure));

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
 * What a page's answer says: a Preview of media from its type alone, or what the page says
 * of itself in its head, which is read whole.
 * @param fetched - The answer.
 * @returns What it came to, or the page and the link it answered as.
 */
const answered = (fetched: Fetched) =>
  Effect.gen(function* () {
    if (readMedia(fetched.type) !== undefined) {
      return mediaPreview(fetched.link, fetched.type);
    }

    const head = joined(yield* Stream.runCollect(fetched.body));

    return {
      link: fetched.link,
      page: readPage({ contentType: fetched.headers["content-type"], head, link: fetched.link }),
    };
  });

/**
 * A page's Preview, from what it said of itself, filled from the oEmbed address it names,
 * with the image it names. The page's own fetch is over by now, so it holds no place with
 * the pacer while its oEmbed waits for one.
 * @param links - The link fetch.
 * @param link - The link the page answered as.
 * @param said - What the page said of itself.
 * @returns What it came to.
 */
const pageRead = (links: LinkFetchService, link: string, said: PageRead) =>
  Effect.gen(function* () {
    const page = yield* filled(links, said);

    if (page.title === undefined && page.description === undefined) {
      return failedRead("NothingToShow");
    }

    const read: Read = {
      image: page.image,
      state: {
        _tag: "Ready",
        preview: {
          description: page.description ?? null,
          image: null,
          kind: "page",
          link,
          site: page.site ?? hostOf(link),
          title: page.title ?? null,
          type: null,
        },
      },
    };

    return read;
  });

/**
 * A state as it is answered under a mode: under `links only`, a Preview holds text only,
 * even one kept with its image while Previews were `on`.
 * @param state - The state, as kept.
 * @param shown - Whether Previews are `on` or `links only`.
 * @returns The state to answer.
 */
const asShown = (state: PreviewState, shown: PreviewsShown): PreviewState =>
  shown === "on" || state._tag !== "Ready" || state.preview.image === null
    ? state
    : { ...state, preview: { ...state.preview, image: null } };

const decodeMediaType = Schema.decodeUnknownOption(MediaType);

/** Why an image was not kept, beyond what the fetch and the store say. */
class NoImage extends Data.TaggedError("NoImage")<{ readonly reason: string }> {}

/** Leading chunks of a stream, and how many bytes they hold. */
interface Leading {
  readonly chunks: readonly Uint8Array[];
  readonly size: number;
}

/**
 * Leading bytes of a stream, at least {@link sniffed} of them unless it is shorter, and the
 * stream from where they end.
 */
const head = Sink.fold(
  (): Leading => ({ chunks: [], size: 0 }),
  ({ size }) => size < sniffed,
  ({ chunks, size }, chunk: Uint8Array) =>
    Effect.succeed({ chunks: [...chunks, chunk], size: size + chunk.length })
);

/**
 * A link not yet kept in a Direct Message the Owner has set no mode for: fetched only once
 * the Owner presses it.
 */
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

/** How a link is asked for: its Timeline's mode, and whether it waits for a press or is one. */
interface How {
  readonly pressed: boolean;
  readonly shown: PreviewsShown;
  readonly waits: boolean;
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
 * @param waits - Whether it is in a Timeline that waits for a press, which never fetches
 * again.
 * @returns Whether it is stale.
 */
const stale = (kept: Kept, now: number, waits: boolean): boolean => {
  if (waits) {
    return false;
  }

  const age = now - kept.fetched;

  return kept.state._tag === "Ready" ? age > readyFor : age >= failedFor;
};

/**
 * A fetch of a stream as it is answered: the host's `200` or `206` with its headers, its `416`,
 * or, for any other status, nothing to show.
 * @param id - The Preview's id.
 * @param fetched - What the host answered.
 * @returns What to answer.
 */
const streamed = (id: PreviewId, fetched: Fetched) => {
  const { headers, status } = fetched;

  if (status === 416) {
    const contentRange = headers["content-range"];

    return Effect.succeed(
      (contentRange === undefined
        ? { _tag: "Unsatisfiable" }
        : { _tag: "Unsatisfiable", contentRange }) satisfies Streamed
    );
  }

  if (status !== 200 && status !== 206) {
    return Effect.fail(new StreamFailed({ id, reason: "NothingToShow" }));
  }

  // A length is of the bytes the host sent, which are not the bytes of the body when the host
  // encoded them.
  const encoding = (headers["content-encoding"] ?? "identity").trim().toLowerCase();

  const length = /^\d+$/u.test(headers["content-length"] ?? "")
    ? Number(headers["content-length"])
    : Number.NaN;

  return Effect.succeed({
    _tag: "Body",
    body: fetched.body,
    status,
    type: fetched.type,
    ...(encoding === "identity" && Number.isSafeInteger(length) && { contentLength: length }),
    ...(status === 206 &&
      headers["content-range"] !== undefined && { contentRange: headers["content-range"] }),
    ...(headers["accept-ranges"] !== undefined && { acceptRanges: headers["accept-ranges"] }),
  } satisfies Streamed);
};

/**
 * The Previews, kept in the Preview cache by link, needing the link fetch, the Preview
 * cache, the Timeline store, the Uploads, and the `ui` options. Only the links being fetched
 * now are held in memory. Each fetch runs in the Layer's Scope, so it ends when the Daemon
 * stops.
 */
export const layerPreviews = Layer.effect(Previews)(
  Effect.gen(function* () {
    const links = yield* LinkFetch;
    const cache = yield* PreviewCache;
    const store = yield* TimelineStore;
    const ui = yield* UiConfiguration;
    const { made: bucket } = yield* previewStore;
    const shared = yield* StoreBytes;
    const room = yield* makeRoom;
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

            const image = state._tag === "Ready" ? (state.preview.image?.hash ?? null) : null;

            yield* cache
              .put({
                fetched,
                image: image === null ? null : Sha256.make(image),
                link: key,
                shown: flight?.shown ?? fetched,
                state,
              })
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

    /**
     * Fetches an image as an image, through the same guard, and keeps its bytes in the store,
     * collected first, since the store may run what it is given more than once. No bucket
     * means no fetch at all. Its hash is claimed in `holding` before the put, so no release
     * of the same bytes takes them before the cache refers to them, and room is made for it
     * there, under `previews.maxTotal`, in the same turn.
     * @param address - Where the image is.
     * @param holding - The Scope the claim lasts for.
     * @returns The image as a Preview holds it.
     */
    const keepImage = (address: string, holding: Scope.Scope) =>
      Effect.gen(function* () {
        const bytesStore = yield* bucket;
        const fetched = yield* links.fetch(address, { kind: "image" });

        if (fetched.status < 200 || fetched.status > 299) {
          return yield* new NoImage({ reason: `it answered ${fetched.status}` });
        }

        const type = decodeMediaType(fetched.type);

        if (Option.isNone(type)) {
          return yield* new NoImage({ reason: `it is of the type ${fetched.type}` });
        }

        const bytes = joined(yield* Stream.runCollect(fetched.body));

        if (bytes.length === 0) {
          return yield* new NoImage({ reason: "it is empty" });
        }

        const hash = hashOf(bytes);

        yield* Scope.provide(shared.claimed(hash), holding);
        yield* room.fit(hash, bytes.length, bytesStore, holding);
        const stored = yield* bytesStore.put(Stream.make(bytes));

        return {
          animated: animated(bytes),
          hash: stored.hash,
          size: stored.size,
          type: type.value,
        } satisfies PreviewImage;
      }).pipe(Effect.scoped);

    /**
     * A Preview with its image, when it names one and Previews are `on`. Whatever goes wrong
     * with the image, in any way at all, leaves the Preview as it was, with no image.
     * @param read - What the fetch came to.
     * @param shown - Whether Previews are `on` or `links only`, as they were when asked.
     * @param holding - The Scope its image's claim lasts for.
     * @returns The state.
     */
    const withImage = (read: Read, shown: PreviewsShown, holding: Scope.Scope) => {
      const { image: address, state } = read;

      if (shown !== "on" || address === undefined || state._tag !== "Ready") {
        return Effect.succeed(state);
      }

      const warned = (reason: string) =>
        Effect.as(
          Effect.logWarning(`A Preview's image was not kept: ${reason}`).pipe(
            Effect.annotateLogs({ image: address })
          ),
          state
        );

      return keepImage(address, holding).pipe(
        Effect.map((image): Settled => ({ ...state, preview: { ...state.preview, image } })),
        Effect.catch((error) =>
          warned("reason" in error ? `${error._tag}, ${error.reason}` : error._tag)
        ),
        Effect.catchDefect(() => warned("it failed unforeseen"))
      );
    };

    // Every failure of the fetch is answered with its reason, and anything unforeseen with
    // `Unreachable`, so no Preview stays pending for ever.
    const fetchOne = (key: string, link: string, shown: PreviewsShown) =>
      Effect.scoped(Effect.flatMap(links.fetch(key, { kind: "page" }), answered)).pipe(
        Effect.filterOrElse(
          (said): said is Read => "state" in said,
          (said) => pageRead(links, said.link, said.page)
        ),
        Effect.catch((error) => Effect.succeed(failedFetch(error))),
        Effect.catchDefect(() => Effect.succeed(failedRead("Unreachable"))),
        // An image stays claimed until the cache refers to it.
        Effect.flatMap((read) =>
          Effect.gen(function* () {
            const state = yield* withImage(read, shown, yield* Scope.Scope);

            yield* settle(key, link, state);
          }).pipe(Effect.scoped)
        )
      );

    /**
     * Decides what an ask or a press of a link answers and whether it starts a fetch, in one
     * turn. A link that is being fetched or kept is served as it is, and one not kept in a
     * Timeline that waits is waiting, unless pressed, which starts its fetch.
     * @param key - The link it is kept under.
     * @param waits - Whether its Timeline waits for a press.
     * @param pressed - Whether it is a press rather than an ask.
     * @returns What it answers and whether it started.
     */
    const claim = (key: string, waits: boolean, pressed: boolean) =>
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

          if (Option.isSome(kept) && !stale(kept.value, now, waits)) {
            return { publish: false, started: false, state: kept.value.state } satisfies Claimed;
          }

          if (Option.isNone(kept) && waits && !pressed) {
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
     * Timeline that waits for a press, waiting until it is kept or pressed.
     * @param link - The link, as the URL parser wrote it.
     * @param how - Whether its Timeline waits, whether it is a press, and whether Previews
     * are `on` or `links only`, which a fetch it starts keeps.
     * @returns Its item, and whether it started its fetch.
     */
    const stateOf = (link: string, how: How) =>
      Effect.gen(function* () {
        const key = keyOf(link);
        const { publish, started, state } = yield* claim(key, how.waits, how.pressed);

        if (publish) {
          yield* PubSub.publish(changed, { id: idOf(key), link, state });
        }

        if (started) {
          yield* Effect.forkIn(fetchOne(key, link, how.shown), scope);
        }

        const item: PreviewItem = { id: idOf(key), link, state: asShown(state, how.shown) };

        return { item, started };
      });

    /**
     * The links of the Message at a position in a Timeline that may be previewed, and how
     * they are asked for there: whether the Timeline waits for a press, and under which mode.
     * @param timeline - The Timeline.
     * @param position - The Message's place in it.
     * @returns The links as the URL parser wrote them, with the mode and whether it waits.
     */
    const locate = (timeline: TimelineId, position: Position) =>
      Effect.gen(function* () {
        const summary = yield* store.timeline(timeline);

        if (Option.isNone(summary)) {
          return yield* new UnknownTimeline({ timeline });
        }

        const { options } = yield* ui.inForce;
        // A merged id is read as the Timeline it went to, whose own override decides, never
        // one left under the merged id.
        const override = options["previews.timelines"][summary.value.id];
        const shown = override ?? options.previews;

        if (shown === "off") {
          return yield* new PreviewsOff({ timeline });
        }

        const window = yield* store.window(timeline, { _tag: "Around", position }, 1);
        const [item] = Option.isSome(window) ? window.value.items : [];

        if (item?.content._tag !== "Message" || comparePositions(item.position, position) !== 0) {
          return yield* new UnknownMessage({ position, timeline });
        }

        const { ours, text } = item.content;
        // What is shown is the echo's text once the Ircd confirmed it, which may differ from ours.
        const said = ours?.delivery._tag === "Confirmed" ? ours.delivery.text : text;

        return {
          // Only a Direct Message the Owner has not chosen a mode for waits.
          links: previewableLinksOf(said).map((found) => found.href),
          shown,
          waits: summary.value.kind === "Direct" && override === undefined,
        };
      });

    const refers = (hash: MediaHash) =>
      cache.refers(Sha256.make(hash)).pipe(
        Effect.mapError(
          (error) =>
            new ByteStoreUnavailable({
              reason: `the Preview cache could not be read: ${error.reason}`,
            })
        )
      );

    return {
      ask: (timeline, position) =>
        Effect.gen(function* () {
          const { links: previewable, shown, waits } = yield* locate(timeline, position);

          // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes the iterable first; it has no thisArg.
          const asked = yield* Effect.forEach(previewable, (link) =>
            stateOf(link, { pressed: false, shown, waits })
          );

          return asked.map(({ item }) => item);
        }),
      changes: Stream.fromPubSub(changed),
      media: (hash) =>
        Effect.gen(function* () {
          if (!(yield* refers(hash))) {
            return yield* new NoSuchMedia();
          }

          const bytesStore = yield* bucket;

          const bytes = yield* bytesStore
            .read(Sha256.make(hash))
            .pipe(Effect.catchTag("ByteStoreNotFound", () => Effect.fail(new NoSuchMedia())));

          // The type is read from the bytes as they are served, never from what was recorded,
          // and bytes of none of the image types are not served at all.
          const [leading, rest] = yield* Stream.peel(bytes, head);
          const type = decodeMediaType(sniff(joined(leading.chunks)));

          if (Option.isNone(type)) {
            return yield* new NoSuchMedia();
          }

          return {
            bytes: Stream.concat(Stream.fromIterable(leading.chunks), rest),
            type: type.value,
          } satisfies Media;
        }),
      press: (timeline, position, link) =>
        Effect.gen(function* () {
          const { links: found, shown, waits } = yield* locate(timeline, position);
          const address = found[link];

          if (!waits || address === undefined) {
            return yield* new NotWaiting({ link, position, timeline });
          }

          const { item, started } = yield* stateOf(address, { pressed: true, shown, waits });

          // Claiming is decided in one turn, so a link kept or fetched meanwhile starts nothing.
          return started ? item : yield* new NotWaiting({ link, position, timeline });
        }),
      refers,
      stream: (timeline, position, id, range) =>
        Effect.gen(function* () {
          const { links: found, shown } = yield* locate(timeline, position);

          if (shown === "links only") {
            return yield* new LinksOnly({ timeline });
          }

          const key = found.map(keyOf).find((one) => idOf(one) === id);

          // A cache that cannot be read keeps nothing to stream from.
          const kept =
            key === undefined
              ? Option.none<Kept>()
              : yield* cache
                  .get(key)
                  .pipe(
                    Effect.catch((error) => Effect.as(warn("read")(error), Option.none<Kept>()))
                  );

          const preview =
            Option.isSome(kept) && kept.value.state._tag === "Ready"
              ? kept.value.state.preview
              : undefined;

          if (preview === undefined || (preview.kind !== "video" && preview.kind !== "audio")) {
            return yield* new UnknownStream({ id });
          }

          // No byte past the limit is asked for, however many seeks add up to it.
          if (range !== undefined && range.start >= limits.stream) {
            return { _tag: "Unsatisfiable" } satisfies Streamed;
          }

          const asking: StreamRange | undefined =
            range === undefined
              ? undefined
              : { end: Math.min(range.end ?? limits.stream, limits.stream), start: range.start };

          const fetched = yield* links
            .fetch(
              preview.link,
              asking === undefined ? { kind: "stream" } : { kind: "stream", range: asking }
            )
            .pipe(
              Effect.mapError((failure) => new StreamFailed({ id, reason: reasonOf(failure) }))
            );

          return yield* streamed(id, fetched);
        }),
    };
  })
);
