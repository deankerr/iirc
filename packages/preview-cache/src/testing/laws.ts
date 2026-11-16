import { Sha256 } from "@iirc/byte-store";
/**
 * The laws every Preview cache adapter keeps, as data, so the in-memory cache and a file
 * agree. Each is checked with `holds` from `@iirc/runtime/testing`.
 *
 * @packageDocumentation
 */
import { LawBroken } from "@iirc/runtime/testing";
import type { Law } from "@iirc/runtime/testing";
import { Effect, Option } from "effect";

import type { Kept, PreviewCacheFailed, PreviewCacheService } from "../cache.ts";

const same = <T>(what: string, actual: T, expected: T) => {
  const shown = { actual: JSON.stringify(actual), expected: JSON.stringify(expected) };

  return shown.actual === shown.expected
    ? Effect.void
    : Effect.fail(new LawBroken({ ...shown, what }));
};

const hash = Sha256.make("ab".repeat(32));

const ready = (link: string, overrides: Partial<Kept> = {}): Kept => ({
  fetched: 1000,
  image: null,
  link,
  shown: 2000,
  state: {
    _tag: "Ready",
    preview: {
      description: "A page about nothing",
      image: null,
      kind: "page",
      link,
      site: "example.com",
      title: "Nothing",
      type: null,
    },
  },
  ...overrides,
});

const failed = (
  link: string,
  reason: Extract<Kept["state"], { _tag: "Failed" }>["reason"]
): Kept => ({
  fetched: 3000,
  image: null,
  link,
  shown: 4000,
  state: { _tag: "Failed", reason },
});

const a = "https://example.com/a";
const b = "https://example.com/b";

type PreviewCacheLaw = Law<PreviewCacheService, PreviewCacheFailed>;

const unknownLink: PreviewCacheLaw = {
  check: (cache) => cache.get(a).pipe(Effect.flatMap((got) => same("get", got, Option.none()))),
  name: "get of a link nothing was kept under is None",
};

const putThenGet: PreviewCacheLaw = {
  check: (cache) =>
    Effect.gen(function* () {
      const everything = ready("https://example.com/é/日本語?q=ключ#🙂", {
        image: hash,
        state: {
          _tag: "Ready",
          preview: {
            description: "Ünïcode — 日本語 🙂\nand a second line",
            image: { animated: true, hash, size: 1234, type: "image/gif" },
            kind: "player",
            link: "https://example.com/é/日本語?q=ключ#🙂",
            site: "Exämple",
            title: "Tïtle",
            type: "video/mp4",
          },
        },
      });

      const bare = ready("https://example.com/bare", {
        state: {
          _tag: "Ready",
          preview: {
            description: null,
            image: null,
            kind: "image",
            link: "https://example.com/bare",
            site: "example.com",
            title: null,
            type: "image/png",
          },
        },
      });

      const reasons = (
        ["Refused", "Unreachable", "TimedOut", "TooLarge", "NothingToShow"] as const
      ).map((reason) => failed(`https://example.com/${reason}`, reason));

      for (const kept of [everything, bare, ready(a), ...reasons]) {
        yield* cache.put(kept);
        yield* same(`get of ${kept.link}`, yield* cache.get(kept.link), Option.some(kept));
      }

      yield* same(
        "a Failed with an image hash",
        yield* cache
          .put({ ...failed(b, "Unreachable"), image: hash })
          .pipe(Effect.andThen(cache.get(b))),
        Option.some({ ...failed(b, "Unreachable"), image: hash })
      );
    }),
  name: "put then get gives the record exactly",
};

const putReplaces: PreviewCacheLaw = {
  check: (cache) =>
    Effect.gen(function* () {
      yield* cache.put(ready(a, { image: hash, shown: 9000 }));

      const replacement = failed(a, "TimedOut");

      yield* cache.put(replacement);
      yield* same("the record kept", yield* cache.get(a), Option.some(replacement));
    }),
  name: "put replaces the whole record kept under the link",
};

const independent: PreviewCacheLaw = {
  check: (cache) =>
    Effect.gen(function* () {
      const first = ready(a);
      const second = failed(b, "Refused");

      yield* cache.put(first);
      yield* cache.put(second);
      yield* cache.put({ ...first, shown: 5000 });
      yield* cache.shown(a, 8000);
      yield* same("the other link", yield* cache.get(b), Option.some(second));
    }),
  name: "records under different links are independent",
};

const shownUnknown: PreviewCacheLaw = {
  check: (cache) =>
    Effect.gen(function* () {
      yield* same("shown", yield* cache.shown(a, 5000), Option.none());
      yield* same("get after", yield* cache.get(a), Option.none());
    }),
  name: "shown of a link nothing was kept under is None, and keeps nothing",
};

const shownMoves: PreviewCacheLaw = {
  check: (cache) =>
    Effect.gen(function* () {
      const first = ready(a, { image: hash, shown: 2000 });
      const moved = { ...first, shown: 7000 };

      yield* cache.put(first);
      yield* same("shown", yield* cache.shown(a, 7000), Option.some(moved));
      yield* same("get after", yield* cache.get(a), Option.some(moved));
    }),
  name: "shown moves when it was last shown forward, changes nothing else, and is what get gives",
};

const shownEarlier: PreviewCacheLaw = {
  check: (cache) =>
    Effect.gen(function* () {
      const first = ready(a, { shown: 6000 });

      yield* cache.put(first);
      yield* same("shown earlier", yield* cache.shown(a, 1000), Option.some(first));
      yield* same("shown at the same time", yield* cache.shown(a, 6000), Option.some(first));
      yield* same("get after", yield* cache.get(a), Option.some(first));
    }),
  name: "shown with an earlier time leaves when it was last shown, and still gives the record",
};

const other = Sha256.make("cd".repeat(32));

const refers: PreviewCacheLaw = {
  check: (cache) =>
    Effect.gen(function* () {
      yield* same("refers in an empty cache", yield* cache.refers(hash), false);
      yield* cache.put(ready(a, { image: hash }));
      yield* cache.put(failed(b, "Refused"));
      yield* same("refers to a kept record's image", yield* cache.refers(hash), true);
      yield* same("refers to an image no record holds", yield* cache.refers(other), false);
      yield* cache.put({ ...failed(b, "TimedOut"), image: hash });
      yield* cache.put(ready(a));
      yield* same("refers while another record holds it", yield* cache.refers(hash), true);
      yield* cache.put(failed(b, "TimedOut"));
      yield* same("refers once no record holds it", yield* cache.refers(hash), false);
    }),
  name: "refers says whether any record kept holds the image, as records are replaced",
};

/** The laws every Preview cache adapter keeps. */
export const previewCacheLaws: readonly PreviewCacheLaw[] = [
  unknownLink,
  putThenGet,
  putReplaces,
  independent,
  shownUnknown,
  shownMoves,
  shownEarlier,
  refers,
];
