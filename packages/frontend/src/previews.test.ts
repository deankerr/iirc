import {
  ItemContent,
  PreviewItem,
  PreviewsRequest,
  TimelineId,
  UiInForce,
  uiDefaults,
} from "@iirc/api";
import type { Preview, PreviewsShown } from "@iirc/api";
import { cursorOf } from "@iirc/timelines";
import type { Position } from "@iirc/timelines";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  asksAnywhere,
  asksFor,
  asksWanted,
  choosing,
  initialPreviews,
  mayPreview,
  modeIn,
  motionOf,
  pressOf,
  pressOn,
  previewsModesOf,
  previewsOf,
  reasonWords,
  reducePreviews,
  summaryOf,
} from "./previews.ts";
import type {
  Motion,
  MotionAsked,
  PressDoes,
  Previews,
  PreviewsAsk,
  PreviewsEvent,
  PreviewsModes,
} from "./previews.ts";

const timeline = Schema.decodeSync(TimelineId)("00000000000002-00000000-00000000");
const other = Schema.decodeSync(TimelineId)("00000000000003-00000000-00000000");

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
  player: null,
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
const waitingForPress = { _tag: "WaitingForPress" } as const;

/**
 * `ui.previews` alone, with no Timeline choosing its own.
 * @param shown - `ui.previews`.
 * @returns The modes.
 */
const everywhere = (shown: PreviewsShown): PreviewsModes => ({ shown, timelines: {} });
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

  const [ask] = asksWanted(shown, everywhere("links only"));

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

    expect([previewsModesOf(undefined), previewsModesOf(shared)]).toStrictEqual([
      undefined,
      { shown: "on", timelines: {} },
    ]);
  });

  it("takes a Timeline's own choice over ui.previews, and ui.previews where it has none", () => {
    const modes: PreviewsModes = { shown: "on", timelines: { [other]: "off" } };

    expect([modeIn(modes, timeline), modeIn(modes, other), modeIn(undefined, other)]).toStrictEqual(
      ["on", "off", undefined]
    );
  });

  it("makes or removes one Timeline's own choice, leaving the others", () => {
    const timelines = { [other]: "off", [timeline]: "on" } as const;

    expect([
      choosing(timelines, timeline, "links only"),
      choosing(timelines, timeline, undefined),
      choosing({}, other, undefined),
    ]).toStrictEqual([{ [other]: "off", [timeline]: "links only" }, { [other]: "off" }, {}]);
  });

  it("follows the stream while any Timeline asks, even with ui.previews off", () => {
    expect([
      asksAnywhere(undefined),
      asksAnywhere(everywhere("off")),
      asksAnywhere({ shown: "off", timelines: { [other]: "off" } }),
      asksAnywhere({ shown: "off", timelines: { [other]: "links only" } }),
      asksAnywhere({ shown: "on", timelines: { [other]: "off" } }),
    ]).toStrictEqual([false, false, false, true, true]);
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

    expect(asksWanted(initialPreviews, everywhere("on"))).toStrictEqual([]);
    expect(asksWanted(shown, everywhere("on"))).toStrictEqual([]);
    expect(asksWanted(fold(shown, { _tag: "Followed" }), everywhere("on"))).toHaveLength(1);
  });

  it("never asks while the mode is off, or unknown", () => {
    const shown = fold(
      initialPreviews,
      { _tag: "Followed" },
      { _tag: "Shown", position: at(1), timeline }
    );

    expect([asksWanted(shown, everywhere("off")), asksWanted(shown, undefined)]).toStrictEqual([
      [],
      [],
    ]);
  });

  it("asks once for a Message shown again and again", () => {
    const { ask, state } = asking(1);

    const again = fold(
      state,
      { _tag: "Shown", position: at(1), timeline },
      { _tag: "Answered", ask, previews: [item("a", ready)] },
      { _tag: "Shown", position: at(1), timeline }
    );

    expect(asksWanted(state, everywhere("on"))).toStrictEqual([]);
    expect(asksWanted(again, everywhere("on"))).toStrictEqual([]);
  });

  it("never asks again for a Message the Daemon refused", () => {
    const { ask, state } = asking(1);
    const refused = fold(state, { _tag: "Refused", ask });

    expect(
      asksWanted(fold(refused, { _tag: "Lost" }, { _tag: "Followed" }), everywhere("on"))
    ).toStrictEqual([]);
    expect(previewsOf(refused, "on", timeline, at(1), links)).toStrictEqual([]);
  });

  it("asks again, once followed again, for a Message still pending when the stream was lost", () => {
    const { ask, state } = asking(1);
    const answered = fold(state, { _tag: "Answered", ask, previews: [item("a", pending)] });

    expect(asksWanted(fold(answered, { _tag: "Lost" }), everywhere("on"))).toStrictEqual([]);
    expect(
      asksWanted(fold(answered, { _tag: "Lost" }, { _tag: "Followed" }), everywhere("on")).map(
        (one) => one.key
      )
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

    expect(asksWanted(settled, everywhere("on"))).toStrictEqual([]);
  });

  it("asks again for an ask in flight when the stream was lost, and takes no answer of the first", () => {
    const { ask, state } = asking(1);
    const lost = fold(state, { _tag: "Lost" }, { _tag: "Followed" });
    const late = fold(lost, { _tag: "Answered", ask, previews: [item("a", pending)] });

    expect(asksWanted(late, everywhere("on")).map((one) => one.key)).toStrictEqual([ask.key]);
  });
});

describe("asking per Timeline", () => {
  it("asks only for Messages in a Timeline whose own mode asks", () => {
    const shown = fold(
      initialPreviews,
      { _tag: "Followed" },
      { _tag: "Shown", position: at(1), timeline },
      { _tag: "Shown", position: at(2), timeline: other }
    );

    const keys = (modes: PreviewsModes) => asksWanted(shown, modes).map((one) => one.timeline);

    expect([
      keys({ shown: "on", timelines: { [other]: "off" } }),
      keys({ shown: "off", timelines: { [other]: "links only" } }),
    ]).toStrictEqual([[timeline], [other]]);
  });

  it("asks again for a Message waiting for a press once its Timeline chooses to be previewed", () => {
    const { ask, state } = asking(1);
    const answered = fold(state, { _tag: "Answered", ask, previews: [item("a", waitingForPress)] });
    const chosen: PreviewsModes = { shown: "links only", timelines: { [timeline]: "on" } };
    const [again] = asksWanted(answered, chosen);

    if (again === undefined) {
      throw new Error("nothing to ask");
    }

    const reanswered = fold(
      answered,
      { _tag: "Asked", ask: again },
      { _tag: "Answered", ask: again, previews: [item("a", pending)] }
    );

    expect({
      default: asksWanted(answered, everywhere("on")),
      onceAnswered: asksWanted(reanswered, chosen),
      shown: previewsOf(reanswered, "on", timeline, at(1), said("https://a.example/")).map(
        (one) => one._tag
      ),
    }).toStrictEqual({ default: [], onceAnswered: [], shown: ["Pending"] });
  });
});

/**
 * A Message answered with a ready Preview and a link waiting for a press.
 * @returns The state.
 */
const waiting = () => {
  const { ask, state } = asking(1);

  return fold(state, {
    _tag: "Answered",
    ask,
    previews: [item("a", ready), item("b", waitingForPress)],
  });
};

describe("a link waiting for a press", () => {
  it("is drawn as the plain link with a press, by its index among the Message's links", () => {
    expect(previewsOf(waiting(), "on", timeline, at(1), links)).toStrictEqual([
      expect.objectContaining({ _tag: "Ready", key: "0" }),
      {
        _tag: "Waiting",
        index: 1,
        key: "1",
        link: { href: "https://b.example/", text: "https://b.example/" },
      },
    ]);
  });

  it("is a press of its Message's place and its index, at the stream's count", () => {
    const state = fold(waiting(), { _tag: "Changed", item: item("a", ready) });

    expect(pressOf(state, timeline, at(1), 1)).toStrictEqual({
      key: asking(1).ask.key,
      link: 1,
      position: at(1),
      since: 1,
      timeline,
    });
  });

  it("shows what a press answered, unless the stream changed it since", () => {
    const state = waiting();
    const press = pressOf(state, timeline, at(1), 1);
    const pressed = fold(state, { _tag: "Pressed", item: item("b", pending), press });

    const raced = fold(
      state,
      { _tag: "Changed", item: item("b", ready) },
      { _tag: "Pressed", item: item("b", pending), press }
    );

    const tags = (one: Previews) =>
      previewsOf(one, "on", timeline, at(1), links).map((shown) => shown._tag);

    expect([tags(pressed), tags(raced)]).toStrictEqual([
      ["Ready", "Pending"],
      ["Ready", "Ready"],
    ]);
  });

  it("asks its Message again when a press is refused, so what is drawn is the Daemon's", () => {
    const state = waiting();
    const press = pressOf(state, timeline, at(1), 1);
    const refused = fold(state, { _tag: "PressRefused", press });

    expect(asksWanted(refused, everywhere("on")).map((one) => one.key)).toStrictEqual([press.key]);
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
    const [second] = asksWanted(shown, everywhere("on"));

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

    const [second] = asksWanted(failed, everywhere("on"));

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
        media: undefined,
        player: undefined,
        summary: "example.com · Cats",
      },
      {
        _tag: "Plain",
        key: "1",
        link: { href: "https://b.example/", text: "https://b.example/" },
        reason: "No preview: the Daemon never fetches this address.",
      },
      {
        _tag: "Waiting",
        index: 2,
        key: "2",
        link: { href: "https://c.example/", text: "https://c.example/" },
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

    const [second] = asksWanted(answered, everywhere("on"));

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
 * @param mode - `ui.previews`, `on` unless given.
 * @returns What it shows, or none.
 */
const shownReady = (fields: Partial<typeof Preview.Encoded>, mode: "on" | "links only" = "on") => {
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

  const [only] = previewsOf(answered, mode, timeline, at(1), said("https://a.example/"));

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

  it("is none under links only, even one held from while Previews were on", () => {
    expect(
      shownReady({ image: { animated: false, hash, size: 10, type: "image/png" } }, "links only")
        ?.image
    ).toBeUndefined();
  });

  it("is none when the Daemon kept none", () => {
    expect(shownReady({ image: null })?.image).toBeUndefined();
  });
});

const streamed = (fields: Partial<typeof Preview.Encoded>, mode: "on" | "links only" = "on") =>
  shownReady({ title: null, ...fields }, mode)?.media;

const playing = {
  image: { animated: false, hash, size: 10, type: "image/jpeg" },
  kind: "player",
  link: "https://www.youtube.com/watch?v=abc",
  player: { link: "https://www.youtube-nocookie.com/embed/abc", size: { height: 360, width: 640 } },
  title: "A song",
} as const;

describe("a Preview's player", () => {
  it("is the host it plays from, and the words that say so, under on", () => {
    expect(shownReady(playing)?.player).toStrictEqual({
      host: "www.youtube-nocookie.com",
      words: "plays from www.youtube-nocookie.com",
    });
  });

  it("is none under links only, even one held from while Previews were on", () => {
    expect(shownReady(playing, "links only")?.player).toBeUndefined();
  });

  it("is none for any kind but a player", () => {
    expect(
      (["page", "image", "video", "audio"] as const).map(
        (kind) => shownReady({ ...playing, kind, player: null })?.player
      )
    ).toStrictEqual([undefined, undefined, undefined, undefined]);
  });

  it("is none when its address cannot be read", () => {
    expect(
      shownReady({ ...playing, player: { link: "not a link", size: null } })?.player
    ).toBeUndefined();
  });

  it("draws its image as the poster, served from our own origin", () => {
    expect(shownReady(playing)?.image).toStrictEqual({
      alt: "A song",
      animated: false,
      drawn: "Poster",
      src: `/api/previews/media/${hash}`,
    });
  });

  it("is text alone under links only: no image, no player", () => {
    const shown = shownReady(playing, "links only");

    expect([shown?.image, shown?.player, shown?.media, shown?.summary]).toStrictEqual([
      undefined,
      undefined,
      undefined,
      "example.com · A song",
    ]);
  });

  it("has no poster when the Daemon kept none, and still plays", () => {
    const shown = shownReady({ ...playing, image: null });

    expect([shown?.image, shown?.player?.host]).toStrictEqual([
      undefined,
      "www.youtube-nocookie.com",
    ]);
  });

  it("is summed up as a page is, by its site and title", () => {
    expect([summary(playing), summary({ ...playing, title: null })]).toStrictEqual([
      "example.com · A song",
      "example.com",
    ]);
  });
});

describe("a Preview's media", () => {
  it("is a video to stream under on, from the route by the Message's place", () => {
    expect(streamed({ kind: "video", type: "video/mp4" })).toStrictEqual({
      kind: "video",
      src: `/api/previews/${idOf("a")}/stream?timeline=${timeline}&position=${cursorOf(at(1))}`,
      type: "video/mp4",
    });
  });

  it("is a sound likewise, and has no type when the Daemon read none", () => {
    expect(streamed({ kind: "audio", type: null })?.kind).toBe("audio");
    expect(streamed({ kind: "audio", type: null })?.type).toBeNull();
  });

  it("is none under links only, even one held from while Previews were on", () => {
    expect(streamed({ kind: "video", type: "video/mp4" }, "links only")).toBeUndefined();
    expect(streamed({ kind: "audio", type: "audio/ogg" }, "links only")).toBeUndefined();
  });

  it("is none for a page, an image, or a player", () => {
    expect(streamed({ kind: "page" })).toBeUndefined();
    expect(streamed({ kind: "image", type: "image/png" })).toBeUndefined();
    expect(streamed({ kind: "player" })).toBeUndefined();
  });

  it("encodes the Timeline and the place in the route's query", () => {
    const src = streamed({ kind: "video", type: "video/mp4" })?.src ?? "";
    const query = new URL(src, "http://daemon.test").searchParams;

    expect({ position: query.get("position"), timeline: query.get("timeline") }).toStrictEqual({
      position: cursorOf(at(1)),
      timeline,
    });
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

describe("whether an image moves", () => {
  const every = [false, true] as const;
  const choices = [undefined, "Still", "Moving"] as const;

  const rows = (animated: boolean) =>
    every.flatMap((animate) =>
      every.flatMap((reducedMotion) =>
        choices.map((chosen): [boolean, boolean, Motion | undefined, Motion] => [
          animate,
          reducedMotion,
          chosen,
          motionOf({ animate, animated, chosen, reducedMotion } satisfies MotionAsked),
        ])
      )
    );

  it("is still for an image that is not animated, however it is set and pressed", () => {
    expect(rows(false).map((row) => row[3])).toStrictEqual(
      Array.from({ length: 12 }, (): Motion => "Still")
    );
  });

  it("is, for an animated one, as it was last pressed, and until then moving only with animate on and no reduced motion", () => {
    expect(rows(true)).toStrictEqual([
      // animate, reduced motion, last pressed into, then its motion
      [false, false, undefined, "Still"],
      [false, false, "Still", "Still"],
      [false, false, "Moving", "Moving"],
      [false, true, undefined, "Still"],
      [false, true, "Still", "Still"],
      [false, true, "Moving", "Moving"],
      [true, false, undefined, "Moving"],
      [true, false, "Still", "Still"],
      [true, false, "Moving", "Moving"],
      [true, true, undefined, "Still"],
      [true, true, "Still", "Still"],
      [true, true, "Moving", "Moving"],
    ]);
  });
});

describe("what a press of an image does", () => {
  it("opens a still image large, whatever its motion", () => {
    const motions = ["Still", "Moving"] as const;

    expect(motions.map((motion) => pressOn({ animated: false }, motion))).toStrictEqual([
      "OpenLarge",
      "OpenLarge",
    ] satisfies PressDoes[]);
  });

  it("plays an animated image that is still, and stops one that moves", () => {
    expect({
      moving: pressOn({ animated: true }, "Moving"),
      still: pressOn({ animated: true }, "Still"),
    }).toStrictEqual({ moving: "Stop", still: "Play" });
  });
});
