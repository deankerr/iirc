import {
  ItemContent,
  PreviewItem,
  PreviewsRequest,
  TimelineId,
  UiInForce,
  uiDefaults,
} from "@iirc/api";
import type { Preview, PreviewsShown } from "@iirc/api";
import type { Position } from "@iirc/timelines";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  asksFor,
  asksWanted,
  initialPreviews,
  mayPreview,
  previewsModeOf,
  previewsOf,
  reasonWords,
  reducePreviews,
  summaryOf,
} from "./previews.ts";
import type { Previews, PreviewsAsk, PreviewsEvent } from "./previews.ts";

const timeline = Schema.decodeSync(TimelineId)("00000000000002-00000000-00000000");

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

/**
 * A Message's place, at a step, as the wire writes it and the API parses it.
 * @param sequence - The step.
 * @returns The place.
 */
const at = (sequence: number): Position =>
  Schema.decodeSync(PreviewsRequest)({
    position: `${hex(BigInt(sequence * 1000) + 2n ** 53n, 14)}-${hex(BigInt(sequence), 14)}-${hex(0n, 8)}`,
  }).position;

/**
 * A Message's content, as the wire carries it, decoded.
 * @param text - What it says.
 * @returns The content.
 */
const said = (text: string) =>
  Schema.decodeSync(ItemContent)({
    _tag: "Message",
    at: { _tag: "Unknown" },
    id: { _tag: "Unknown" },
    kind: "Privmsg",
    live: true,
    ours: null,
    sender: "peer",
    tags: [],
    target: "#iirc",
    text,
  });

const idOf = (letter: string) => letter.repeat(32);

const page = {
  description: "A page about cats.",
  image: null,
  kind: "page",
  link: "https://example.com/cats",
  site: "example.com",
  title: "Cats",
  type: null,
} as const;

/**
 * An item, by a letter that makes its id, as decoded.
 * @param letter - The letter.
 * @param state - Its state, as the wire carries it.
 * @param link - Its link.
 * @returns The item.
 */
const item = (
  letter: string,
  state: typeof PreviewItem.Encoded.state,
  link = `https://${letter}.example/`
) => Schema.decodeSync(PreviewItem)({ id: idOf(letter), link, state });

const pending = { _tag: "Pending" } as const;
const ready = { _tag: "Ready", preview: page } as const;

const fold = (state: Previews, ...events: readonly PreviewsEvent[]) => {
  let folded = state;

  for (const event of events) {
    folded = reducePreviews(folded, event);
  }

  return folded;
};

/**
 * A Message shown at a sequence, the stream followed, and its ask begun, as the runtime would.
 * @param sequence - Where the Message is.
 * @returns The state, and the ask.
 */
const asking = (sequence: number) => {
  const shown = fold(
    initialPreviews,
    { _tag: "Followed" },
    { _tag: "Shown", position: at(sequence), timeline }
  );

  const [ask] = asksWanted(shown, "links only");

  if (ask === undefined) {
    throw new Error("nothing to ask");
  }

  return { ask, state: fold(shown, { _tag: "Asked", ask }) } satisfies {
    readonly ask: PreviewsAsk;
    readonly state: Previews;
  };
};

const links = said("see https://a.example/ and https://b.example/");

describe("whether to ask", () => {
  it("asks under links only and on, never under off, and never before the mode is read", () => {
    expect(
      (["off", "links only", "on", undefined] as const).map((mode) => asksFor(mode))
    ).toStrictEqual([false, true, true, false]);
  });

  it("reads the mode from the shared options alone", () => {
    const shared = Schema.decodeSync(UiInForce)({
      options: { ...uiDefaults, previews: "on" },
      sequence: 3,
    });

    expect([previewsModeOf(undefined), previewsModeOf(shared)]).toStrictEqual([undefined, "on"]);
  });

  it("watches only a Message with a link that may be previewed, while the mode asks", () => {
    expect([
      mayPreview("links only", links),
      mayPreview("links only", said("irc://irc.libera.chat/#iirc and no web link")),
      mayPreview("off", links),
      mayPreview(undefined, links),
    ]).toStrictEqual([true, false, false, false]);
  });
});

describe("asking", () => {
  it("asks for a Message only once it was shown, and only while the stream is followed", () => {
    const shown = fold(initialPreviews, { _tag: "Shown", position: at(1), timeline });

    expect(asksWanted(initialPreviews, "on")).toStrictEqual([]);
    expect(asksWanted(shown, "on")).toStrictEqual([]);
    expect(asksWanted(fold(shown, { _tag: "Followed" }), "on")).toHaveLength(1);
  });

  it("never asks while the mode is off, or unknown", () => {
    const shown = fold(
      initialPreviews,
      { _tag: "Followed" },
      { _tag: "Shown", position: at(1), timeline }
    );

    expect([asksWanted(shown, "off"), asksWanted(shown, undefined)]).toStrictEqual([[], []]);
  });

  it("asks once for a Message shown again and again", () => {
    const { ask, state } = asking(1);

    const again = fold(
      state,
      { _tag: "Shown", position: at(1), timeline },
      { _tag: "Answered", ask, previews: [item("a", ready)] },
      { _tag: "Shown", position: at(1), timeline }
    );

    expect(asksWanted(state, "on")).toStrictEqual([]);
    expect(asksWanted(again, "on")).toStrictEqual([]);
  });

  it("never asks again for a Message the Daemon refused", () => {
    const { ask, state } = asking(1);
    const refused = fold(state, { _tag: "Refused", ask });

    expect(asksWanted(fold(refused, { _tag: "Lost" }, { _tag: "Followed" }), "on")).toStrictEqual(
      []
    );
    expect(previewsOf(refused, "on", timeline, at(1), links)).toStrictEqual([]);
  });

  it("asks again, once followed again, for a Message still pending when the stream was lost", () => {
    const { ask, state } = asking(1);
    const answered = fold(state, { _tag: "Answered", ask, previews: [item("a", pending)] });

    expect(asksWanted(fold(answered, { _tag: "Lost" }), "on")).toStrictEqual([]);
    expect(
      asksWanted(fold(answered, { _tag: "Lost" }, { _tag: "Followed" }), "on").map((one) => one.key)
    ).toStrictEqual([ask.key]);
  });

  it("does not ask again for a Message whose Previews all settled before the stream was lost", () => {
    const { ask, state } = asking(1);

    const settled = fold(
      state,
      { _tag: "Answered", ask, previews: [item("a", ready), item("b", pending)] },
      { _tag: "Changed", item: item("b", { _tag: "Failed", reason: "TimedOut" }) },
      { _tag: "Lost" },
      { _tag: "Followed" }
    );

    expect(asksWanted(settled, "on")).toStrictEqual([]);
  });

  it("asks again for an ask in flight when the stream was lost, and takes no answer of the first", () => {
    const { ask, state } = asking(1);
    const lost = fold(state, { _tag: "Lost" }, { _tag: "Followed" });
    const late = fold(lost, { _tag: "Answered", ask, previews: [item("a", pending)] });

    expect(asksWanted(late, "on").map((one) => one.key)).toStrictEqual([ask.key]);
  });
});

describe("folding a change", () => {
  it("replaces the item held under its id, in every Message that shows it", () => {
    const first = asking(1);

    const one = fold(first.state, {
      _tag: "Answered",
      ask: first.ask,
      previews: [item("a", pending)],
    });

    const shown = fold(one, { _tag: "Shown", position: at(2), timeline });
    const [second] = asksWanted(shown, "on");

    if (second === undefined) {
      throw new Error("nothing to ask");
    }

    const both = fold(
      shown,
      { _tag: "Asked", ask: second },
      { _tag: "Answered", ask: second, previews: [item("a", pending)] },
      { _tag: "Changed", item: item("a", ready) }
    );

    expect(
      [at(1), at(2)].map((position) =>
        previewsOf(both, "on", timeline, position, said("https://a.example/")).map(
          (shownItem) => shownItem._tag
        )
      )
    ).toStrictEqual([["Ready"], ["Ready"]]);
  });

  it("keeps a change the stream gave while the ask was in flight over the answer", () => {
    const { ask, state } = asking(1);

    const raced = fold(
      state,
      { _tag: "Changed", item: item("a", ready) },
      { _tag: "Answered", ask, previews: [item("a", pending)] }
    );

    expect(previewsOf(raced, "on", timeline, at(1), links).map((one) => one._tag)).toStrictEqual([
      "Ready",
    ]);
  });

  it("takes an answer over a change the stream gave before its ask began", () => {
    const first = asking(1);

    const failed = fold(
      first.state,
      { _tag: "Answered", ask: first.ask, previews: [item("a", pending)] },
      { _tag: "Changed", item: item("a", { _tag: "Failed", reason: "Unreachable" }) },
      { _tag: "Shown", position: at(2), timeline }
    );

    const [second] = asksWanted(failed, "on");

    if (second === undefined) {
      throw new Error("nothing to ask");
    }

    // The failure was let go of, and the second ask began its fetch again.
    const again = fold(
      failed,
      { _tag: "Asked", ask: second },
      { _tag: "Answered", ask: second, previews: [item("a", pending)] }
    );

    expect(
      previewsOf(again, "on", timeline, at(1), said("https://a.example/")).map((one) => one._tag)
    ).toStrictEqual(["Pending"]);
  });

  it("holds no change of an item no Message shows", () => {
    const followed = fold(initialPreviews, { _tag: "Followed" });
    const changed = fold(followed, { _tag: "Changed", item: item("f", ready) });

    expect(changed.items.size).toBe(0);
  });

  it("forgets everything on signing out", () => {
    const { ask, state } = asking(1);

    expect(
      fold(state, { _tag: "Answered", ask, previews: [item("a", ready)] }, { _tag: "Forgotten" })
    ).toStrictEqual(initialPreviews);
  });
});

describe("what a Message shows", () => {
  it("shows a placeholder for each link that may be previewed before it is answered", () => {
    expect(previewsOf(initialPreviews, "links only", timeline, at(1), links)).toStrictEqual([
      {
        _tag: "Pending",
        key: "0",
        link: { href: "https://a.example/", text: "https://a.example/" },
      },
      {
        _tag: "Pending",
        key: "1",
        link: { href: "https://b.example/", text: "https://b.example/" },
      },
    ]);
  });

  it("shows at most three, as the protocol counts them", () => {
    const four = said(
      "https://a.example/ https://b.example/ https://c.example/ https://d.example/"
    );

    expect(previewsOf(initialPreviews, "on", timeline, at(1), four)).toHaveLength(3);
  });

  it("shows nothing while the mode is off or unknown, nor for anything but a Message", () => {
    const joined = Schema.decodeSync(ItemContent)({
      _tag: "Activity",
      activity: { _tag: "Joined", channel: "#iirc", nick: "https://a.example/" },
      at: { _tag: "Unknown" },
      id: { _tag: "Unknown" },
      live: true,
    });

    const modes: readonly (PreviewsShown | undefined)[] = ["off", undefined];

    expect([
      ...modes.map((mode) => previewsOf(initialPreviews, mode, timeline, at(1), links)),
      previewsOf(initialPreviews, "on", timeline, at(1), joined),
    ]).toStrictEqual([[], [], []]);
  });

  it("shows the answer's items in its order, each as it is now", () => {
    const { ask, state } = asking(1);

    const answered = fold(state, {
      _tag: "Answered",
      ask,
      previews: [
        item("a", ready),
        item("b", { _tag: "Failed", reason: "Refused" }),
        item("c", { _tag: "WaitingForPress" }),
        item("d", pending),
      ],
    });

    expect(previewsOf(answered, "on", timeline, at(1), links)).toStrictEqual([
      {
        _tag: "Ready",
        description: "A page about cats.",
        image: undefined,
        key: "0",
        link: { href: "https://a.example/", text: "https://a.example/" },
        summary: "example.com · Cats",
      },
      {
        _tag: "Plain",
        key: "1",
        link: { href: "https://b.example/", text: "https://b.example/" },
        reason: "No preview: the Daemon never fetches this address.",
      },
      {
        _tag: "Plain",
        key: "2",
        link: { href: "https://c.example/", text: "https://c.example/" },
        reason: undefined,
      },
      {
        _tag: "Pending",
        key: "3",
        link: { href: "https://d.example/", text: "https://d.example/" },
      },
    ]);
  });

  it("draws the links its Message holds, never an address the Daemon gave", () => {
    const { ask, state } = asking(1);

    const answered = fold(state, {
      _tag: "Answered",
      ask,
      previews: [item("a", pending, "data:text/html,hi")],
    });

    expect(previewsOf(answered, "on", timeline, at(1), links)).toStrictEqual([
      {
        _tag: "Pending",
        key: "0",
        link: { href: "https://a.example/", text: "https://a.example/" },
      },
    ]);
  });

  it("shows two links that differ only by a fragment, each with the shared state, under distinct keys", () => {
    const { ask, state } = asking(1);
    const message = said("https://a.example/#one https://a.example/#two");

    const answered = fold(state, {
      _tag: "Answered",
      ask,
      previews: [
        item("a", ready, "https://a.example/#two"),
        item("a", ready, "https://a.example/#two"),
      ],
    });

    const shown = previewsOf(answered, "on", timeline, at(1), message);

    expect(shown.map((one) => [one._tag, one.link.href, one.key])).toStrictEqual([
      ["Ready", "https://a.example/#one", "0"],
      ["Ready", "https://a.example/#two", "1"],
    ]);
  });

  it("keeps each Message's own link when two Messages differ only by a fragment", () => {
    const first = asking(1);
    const one = said("https://a.example/#one");
    const two = said("https://a.example/#two");

    const answered = fold(
      first.state,
      { _tag: "Answered", ask: first.ask, previews: [item("a", ready, "https://a.example/#one")] },
      { _tag: "Shown", position: at(2), timeline }
    );

    const [second] = asksWanted(answered, "on");

    if (second === undefined) {
      throw new Error("nothing to ask");
    }

    const both = fold(
      answered,
      { _tag: "Asked", ask: second },
      { _tag: "Answered", ask: second, previews: [item("a", ready, "https://a.example/#two")] }
    );

    expect([
      previewsOf(both, "on", timeline, at(1), one).map((shown) => shown.link.href),
      previewsOf(both, "on", timeline, at(2), two).map((shown) => shown.link.href),
    ]).toStrictEqual([["https://a.example/#one"], ["https://a.example/#two"]]);
  });
});

/**
 * The summary of a page's Preview, with some fields other than the page's.
 * @param fields - Those fields, as the wire carries them.
 * @returns Its summary.
 */
const summary = (fields: Partial<typeof Preview.Encoded>) => {
  const decoded = Schema.decodeSync(PreviewItem)({
    id: idOf("a"),
    link: page.link,
    state: { _tag: "Ready", preview: { ...page, ...fields } },
  });

  return decoded.state._tag === "Ready" ? summaryOf(decoded.state.preview) : undefined;
};

const hash = "ab".repeat(32);

/**
 * What a Message shows of one Ready Preview, with some fields other than the page's.
 * @param fields - Those fields, as the wire carries them.
 * @returns What it shows, or none.
 */
const shownReady = (fields: Partial<typeof Preview.Encoded>) => {
  const { ask, state } = asking(1);

  const answered = fold(state, {
    _tag: "Answered",
    ask,
    previews: [
      Schema.decodeSync(PreviewItem)({
        id: idOf("a"),
        link: "https://a.example/",
        state: { _tag: "Ready", preview: { ...page, ...fields } },
      }),
    ],
  });

  const [only] = previewsOf(answered, "on", timeline, at(1), said("https://a.example/"));

  return only?._tag === "Ready" ? only : undefined;
};

describe("a Preview's image", () => {
  it("is a thumbnail, served from our own origin, for a page that has one", () => {
    expect(
      shownReady({ image: { animated: false, hash, size: 10, type: "image/png" } })?.image
    ).toStrictEqual({
      alt: "Cats",
      animated: false,
      drawn: "Thumbnail",
      src: `/api/previews/media/${hash}`,
    });
  });

  it("is the whole image for a link that is itself an image, and says when it moves", () => {
    expect(
      shownReady({
        image: { animated: true, hash, size: 10, type: "image/gif" },
        kind: "image",
        title: null,
        type: "image/gif",
      })?.image
    ).toStrictEqual({
      alt: "https://example.com/cats",
      animated: true,
      drawn: "Whole",
      src: `/api/previews/media/${hash}`,
    });
  });

  it("is none when the Daemon kept none", () => {
    expect(shownReady({ image: null })?.image).toBeUndefined();
  });
});

describe("the summary line", () => {
  it("says a page's site and title", () => {
    expect(summary({})).toBe("example.com · Cats");
  });

  it("says the site alone for a page with no title", () => {
    expect(summary({ title: null })).toBe("example.com");
  });

  it("says what a link to media itself is, its type, and its site", () => {
    expect(summary({ kind: "image", title: null, type: "image/png" })).toBe(
      "image · image/png · example.com"
    );
    expect(summary({ kind: "audio", title: null, type: "audio/ogg" })).toBe(
      "sound · audio/ogg · example.com"
    );
  });

  it("contains what a stranger wrote", () => {
    expect(summary({ site: "evil‮", title: "a\u0007b" })).toBe("evil‮‬ · a␇b");
  });
});

describe("a failure's words", () => {
  it("says each reason as itself", () => {
    expect(
      (["Refused", "Unreachable", "TimedOut", "TooLarge", "NothingToShow"] as const).map((reason) =>
        reasonWords(reason)
      )
    ).toStrictEqual([
      "No preview: the Daemon never fetches this address.",
      "No preview: the Daemon could not reach this link.",
      "No preview: this link took too long to answer.",
      "No preview: this link's answer was too large to read.",
      "No preview: this link had nothing to show.",
    ]);
  });
});
