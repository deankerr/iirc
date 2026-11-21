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
  asksWanted,
  choosing,
  foldedOf,
  hostNamed,
  initialPreviews,
  mayPreview,
  messageKey,
  motionOf,
  opening,
  pressOf,
  playsIn,
  pressOn,
  previewsModesOf,
  previewsOf,
  reasonWords,
  reducePreviews,
} from "./previews.ts";
import type {
  Motion,
  MotionAsked,
  PressDoes,
  Previews,
  PreviewsAsk,
  PreviewShown,
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
    answers: null,
    at: { _tag: "Unknown" },
    bot: false,
    context: null,
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
  stream: null,
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

/** The hosts `ui.previews.players` lists by default. */
const listed = uiDefaults["previews.players"];

/** The hosts listed by default, as a Message's Previews are drawn with them. */
const drawing = listed;

const pending = { _tag: "Pending" } as const;
const waitingForPress = { _tag: "WaitingForPress" } as const;

/**
 * `ui.previews` alone, with no Timeline choosing its own.
 * @param shown - `ui.previews`.
 * @returns The modes.
 */
const everywhere = (shown: PreviewsShown): PreviewsModes => ({
  players: listed,
  shown,
  timelines: {},
});

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

  const [ask] = asksWanted(shown, everywhere("text"));

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
  it("reads the mode from the shared options alone", () => {
    const shared = Schema.decodeSync(UiInForce)({
      options: { ...uiDefaults, previews: "on" },
      sequence: 3,
    });

    expect([previewsModesOf(undefined), previewsModesOf(shared)]).toStrictEqual([
      undefined,
      { players: listed, shown: "on", timelines: {} },
    ]);
  });

  it("makes or removes one Timeline's own choice, leaving the others", () => {
    const timelines = { [other]: "off", [timeline]: "on" } as const;

    expect([
      choosing(timelines, timeline, "text"),
      choosing(timelines, timeline, undefined),
      choosing({}, other, undefined),
    ]).toStrictEqual([{ [other]: "off", [timeline]: "text" }, { [other]: "off" }, {}]);
  });

  it("follows the stream while any Timeline asks, even with ui.previews off", () => {
    expect([
      asksAnywhere(undefined),
      asksAnywhere(everywhere("off")),
      asksAnywhere({ players: listed, shown: "off", timelines: { [other]: "off" } }),
      asksAnywhere({ players: listed, shown: "off", timelines: { [other]: "text" } }),
      asksAnywhere({ players: listed, shown: "on", timelines: { [other]: "off" } }),
    ]).toStrictEqual([false, false, false, true, true]);
  });

  it("watches only a Message with a link that may be previewed, while the mode asks", () => {
    expect([
      mayPreview("text", links),
      mayPreview("text", said("irc://irc.libera.chat/#iirc and no web link")),
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
    expect(previewsOf(refused, "on", timeline, at(1), links, drawing)).toStrictEqual([]);
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
      keys({ players: listed, shown: "on", timelines: { [other]: "off" } }),
      keys({ players: listed, shown: "off", timelines: { [other]: "text" } }),
    ]).toStrictEqual([[timeline], [other]]);
  });

  it("asks again for a Message waiting for a press once its Timeline chooses to be previewed", () => {
    const { ask, state } = asking(1);
    const answered = fold(state, { _tag: "Answered", ask, previews: [item("a", waitingForPress)] });

    const chosen: PreviewsModes = {
      players: listed,
      shown: "text",
      timelines: { [timeline]: "on" },
    };

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
      shown: previewsOf(reanswered, "on", timeline, at(1), said("https://a.example/"), drawing).map(
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
      previewsOf(one, "on", timeline, at(1), links, drawing).map((shown) => shown._tag);

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
        previewsOf(both, "on", timeline, position, said("https://a.example/"), drawing).map(
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

    expect(
      previewsOf(raced, "on", timeline, at(1), links, drawing).map((one) => one._tag)
    ).toStrictEqual(["Ready"]);
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
      previewsOf(again, "on", timeline, at(1), said("https://a.example/"), drawing).map(
        (one) => one._tag
      )
    ).toStrictEqual(["Pending"]);
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
    expect(previewsOf(initialPreviews, "text", timeline, at(1), links, drawing)).toStrictEqual([
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

    expect(previewsOf(initialPreviews, "on", timeline, at(1), four, drawing)).toHaveLength(3);
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
      ...modes.map((mode) => previewsOf(initialPreviews, mode, timeline, at(1), links, drawing)),
      previewsOf(initialPreviews, "on", timeline, at(1), joined, drawing),
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

    expect(previewsOf(answered, "on", timeline, at(1), links, drawing)).toStrictEqual([
      {
        _tag: "Ready",
        description: "A page about cats.",
        host: "example.com",
        image: undefined,
        key: "0",
        link: { href: "https://a.example/", text: "https://a.example/" },
        media: undefined,
        name: "Cats",
        player: undefined,
        title: "Cats",
      },
      {
        _tag: "Failed",
        key: "1",
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

    expect(previewsOf(answered, "on", timeline, at(1), links, drawing)).toStrictEqual([
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

    const shown = previewsOf(answered, "on", timeline, at(1), message, drawing);

    expect(
      shown.map((one) => [one._tag, one._tag === "Ready" ? one.link.href : undefined, one.key])
    ).toStrictEqual([
      ["Ready", "https://a.example/#one", "0"],
      ["Ready", "https://a.example/#two", "1"],
    ]);
  });
});

const hash = "ab".repeat(32);

/**
 * What a Message shows of one Ready Preview, with some fields other than the page's.
 * @param fields - Those fields, as the wire carries them.
 * @param mode - `ui.previews`, `on` unless given.
 * @param players - The hosts `ui.previews.players` lists, its default unless given.
 * @returns What it shows, or none.
 */
const shownReady = (
  fields: Partial<typeof Preview.Encoded>,
  mode: "on" | "text" = "on",
  players: readonly string[] = listed
) => {
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

  const [only] = previewsOf(answered, mode, timeline, at(1), said("https://a.example/"), players);

  return only?._tag === "Ready" ? only : undefined;
};

describe("a Preview's image", () => {
  it("is the whole image for a link that is itself an image, and says when it moves", () => {
    expect(
      shownReady({
        image: { animated: true, dimensions: null, hash, size: 10, type: "image/gif" },
        kind: "image",
        title: null,
        type: "image/gif",
      })?.image
    ).toStrictEqual({
      alt: "https://example.com/cats",
      animated: true,
      dimensions: undefined,
      drawn: "Whole",
      src: `/api/previews/images/${hash}`,
    });
  });

  it("is none when the Daemon kept none", () => {
    expect(shownReady({ image: null })?.image).toBeUndefined();
  });

  it("carries its dimensions in pixels, or none where the Daemon read none", () => {
    const sized = { animated: false, dimensions: { height: 48, width: 64 }, hash, size: 10 };

    expect([
      shownReady({ image: { ...sized, type: "image/png" } })?.image?.dimensions,
      shownReady({ image: { ...sized, dimensions: null, type: "image/png" } })?.image?.dimensions,
    ]).toStrictEqual([{ height: 48, width: 64 }, undefined]);
  });

  it("is a poster for a page's video, and whole for a page", () => {
    const image = {
      animated: false,
      dimensions: null,
      hash,
      size: 10,
      type: "image/jpeg",
    } as const;

    expect([
      shownReady({ image, kind: "video", stream: "https://example.com/cats.mp4" })?.image?.drawn,
      shownReady({ image, kind: "page" })?.image?.drawn,
    ]).toStrictEqual(["Poster", "Whole"]);
  });
});

const streamed = (fields: Partial<typeof Preview.Encoded>, mode: "on" | "text" = "on") =>
  shownReady({ title: null, ...fields }, mode)?.media;

const playing = {
  image: { animated: false, dimensions: null, hash, size: 10, type: "image/jpeg" },
  kind: "player",
  link: "https://www.youtube.com/watch?v=abc",
  player: { link: "https://www.youtube-nocookie.com/embed/abc", size: { height: 360, width: 640 } },
  title: "A song",
} as const;

/**
 * The address a player's frame loads, once pressed.
 * @param link - The player's address, as the Daemon answered it.
 * @param hosts - The hosts listed now.
 * @returns What the frame loads.
 */
const srcOf = (link: string, hosts: readonly string[]) =>
  shownReady({ ...playing, player: { link, size: null } }, "on", hosts)?.player?.src;

describe("a Preview's player", () => {
  it("is the host it plays from, the words that say so, and what a frame needs, under on", () => {
    expect(shownReady(playing)?.player).toStrictEqual({
      host: "www.youtube-nocookie.com",
      size: { height: 360, width: 640 },
      src: "https://www.youtube-nocookie.com/embed/abc?autoplay=1",
      words: "plays from www.youtube-nocookie.com",
    });
  });

  it("starts playing by its host's own parameter, keeping the rest of its query", () => {
    expect([
      srcOf("https://www.youtube-nocookie.com/embed/abc?start=30&autoplay=0", listed),
      srcOf("https://player.vimeo.com/video/1?h=9f", listed),
      srcOf("https://w.soundcloud.com/player/?url=https%3A%2F%2Fa.example%2Fb", listed),
      srcOf("https://w.soundcloud.com/player/?auto_play=false", listed),
    ]).toStrictEqual([
      "https://www.youtube-nocookie.com/embed/abc?start=30&autoplay=1",
      "https://player.vimeo.com/video/1?h=9f&autoplay=1",
      "https://w.soundcloud.com/player/?url=https%3A%2F%2Fa.example%2Fb&auto_play=true",
      "https://w.soundcloud.com/player/?auto_play=true",
    ]);
  });

  it("leaves the link of a host with no autoplay parameter as it is", () => {
    expect(
      shownReady(
        { ...playing, player: { link: "https://bandcamp.com/EmbeddedPlayer/album=1", size: null } },
        "on",
        listed
      )?.player?.src
    ).toBe("https://bandcamp.com/EmbeddedPlayer/album=1");
  });

  it("has no size when its page gave none", () => {
    expect(
      shownReady({ ...playing, player: { link: playing.player.link, size: null } })?.player?.size
    ).toBeUndefined();
  });

  it("is none for any kind but a player", () => {
    expect(
      (["page", "image", "video", "audio"] as const).map(
        (kind) => shownReady({ ...playing, kind })?.player
      )
    ).toStrictEqual([undefined, undefined, undefined, undefined]);
  });

  it("is a page with its image once the list no longer names its host, as the Daemon would answer it", () => {
    const shown = shownReady(playing, "on", ["player.vimeo.com"]);

    expect([
      shown?.player,
      shown?.image?.drawn,
      shownReady(playing, "on", [])?.player,
    ]).toStrictEqual([undefined, "Whole", undefined]);
  });

  it("matches its host exactly, never by a suffix or a look-alike", () => {
    expect(
      [["youtube-nocookie.com"], ["nocookie.com"], ["www.youtube-nocookie.com."]].map(
        (players) => shownReady(playing, "on", players)?.player
      )
    ).toStrictEqual([undefined, undefined, undefined]);
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
      dimensions: undefined,
      drawn: "Poster",
      src: `/api/previews/images/${hash}`,
    });
  });

  it("is text alone under text: no image, no player", () => {
    const shown = shownReady(playing, "text");

    expect([shown?.image, shown?.player, shown?.media, shown?.title]).toStrictEqual([
      undefined,
      undefined,
      undefined,
      "A song",
    ]);
  });
});

const image = { animated: false, dimensions: null, hash, size: 10, type: "image/png" } as const;

/**
 * What a card holds, in its order, as a row of a table: its title, its description, how
 * its image is drawn, its media's kind, and the host its player plays from, each `-` where
 * it has none, or `nothing` for no card at all.
 * @param fields - The Preview's fields other than the page's.
 * @param mode - `ui.previews`.
 * @returns The row.
 */
const holds = (fields: Partial<typeof Preview.Encoded>, mode: "on" | "text") => {
  const shown = shownReady(fields, mode);

  return shown === undefined
    ? "nothing"
    : [
        shown.title ?? "-",
        shown.description ?? "-",
        shown.image?.drawn ?? "-",
        shown.media?.kind ?? "-",
        shown.player?.host ?? "-",
      ].join(" | ");
};

/** A page that names a video file, which streams from elsewhere than its own link. */
const pageVideo = {
  image,
  kind: "video",
  stream: "https://example.com/cats.mp4",
  type: "video/mp4",
} as const;

/** A link that is itself a video: its stream is itself, and the Daemon gives it no words. */
const videoItself = {
  description: null,
  kind: "video",
  stream: page.link,
  title: null,
  type: "video/mp4",
} as const;

describe("what a card holds", () => {
  it.each([
    ["a page", { image }, "on", "Cats | A page about cats. | Whole | - | -"],
    ["a page", { image }, "text", "Cats | A page about cats. | - | - | -"],
    [
      "a page with no title",
      { image, title: null },
      "on",
      "- | A page about cats. | Whole | - | -",
    ],
    ["a page with no image", {}, "on", "Cats | A page about cats. | - | - | -"],
    ["a page with only blank words", { description: " ", title: "" }, "on", "nothing"],
    [
      "a page that names a video file",
      pageVideo,
      "on",
      "Cats | A page about cats. | Poster | video | -",
    ],
    ["a page that names a video file", pageVideo, "text", "Cats | A page about cats. | - | - | -"],
    [
      "a page that names a listed player",
      playing,
      "on",
      "A song | A page about cats. | Poster | - | www.youtube-nocookie.com",
    ],
    [
      "a page that names a listed player",
      playing,
      "text",
      "A song | A page about cats. | - | - | -",
    ],
    [
      "a link that is itself an image",
      { description: null, image, kind: "image", title: null },
      "on",
      "- | - | Whole | - | -",
    ],
    [
      "a link that is itself an image",
      { description: null, image, kind: "image", title: null },
      "text",
      "nothing",
    ],
    [
      "a page whose video file is its own link",
      { ...pageVideo, stream: page.link },
      "text",
      "Cats | A page about cats. | - | - | -",
    ],
    ["a link that is itself a video", videoItself, "on", "- | - | - | video | -"],
    ["a link that is itself a video", videoItself, "text", "nothing"],
    [
      "a link that is itself a sound",
      { description: null, kind: "audio", stream: page.link, title: null },
      "on",
      "- | - | - | audio | -",
    ],
    [
      "a link that is itself a sound",
      { description: null, kind: "audio", stream: page.link, title: null },
      "text",
      "nothing",
    ],
  ] as const)("%s, under %s", (_name, fields, mode, expected) => {
    expect(holds(fields, mode)).toBe(expected);
  });

  it("is named for its title, or else its link, and contains what a stranger wrote", () => {
    expect([
      shownReady({})?.name,
      shownReady({ title: null })?.name,
      shownReady({ description: "a\u0007b", title: "evil\u202E" })?.title,
      shownReady({ description: "a\u0007b", title: "evil\u202E" })?.description,
    ]).toStrictEqual(["Cats", "https://a.example/", "evil\u202E\u202C", "a␇b"]);
  });
});

describe("the host a card names", () => {
  it.each([
    ["the same host", "https://example.com/a", "https://example.com/b", undefined],
    [
      "the same host, but for www.",
      "https://example.com/a",
      "https://www.example.com/a",
      undefined,
    ],
    ["the same host in another case", "https://EXAMPLE.com/a", "https://example.com/a", undefined],
    [
      "a shortened link that led elsewhere",
      "https://t.co/abc",
      "https://www.example.com/cats",
      "example.com",
    ],
    [
      "another host under the same name",
      "https://example.com/",
      "https://cdn.example.com/",
      "cdn.example.com",
    ],
    ["a link that cannot be read", "not a link", "https://example.com/", undefined],
  ] as const)("is %s", (_name, address, read, expected) => {
    expect(hostNamed(address, read)).toBe(expected);
  });

  it("is said on a card read from another host than its Message's link", () => {
    expect([
      shownReady({ link: "https://www.example.com/cats" })?.host,
      shownReady({ link: "https://a.example/" })?.host,
    ]).toStrictEqual(["example.com", undefined]);
  });
});

const key = messageKey(timeline, at(1));

const pendingRow: PreviewShown = {
  _tag: "Pending",
  key: "0",
  link: { href: "https://a.example/", text: "https://a.example/" },
};

const failedRow: PreviewShown = {
  _tag: "Failed",
  key: "1",
  reason: "No preview: this link had nothing to show.",
};

const waitingRow: PreviewShown = {
  _tag: "Waiting",
  index: 2,
  key: "2",
  link: { href: "https://c.example/", text: "https://c.example/" },
};

/**
 * A ready row, under a key, as drawn with some fields of the page's.
 * @param rowKey - Its key.
 * @param fields - Those fields.
 * @returns The row.
 */
const readyRow = (rowKey: string, fields: Partial<typeof Preview.Encoded>): PreviewShown => {
  const shown = shownReady(fields);

  if (shown === undefined) {
    throw new Error("not ready");
  }

  return { ...shown, key: rowKey };
};

describe("ui.previews.folded", () => {
  const plainPage = readyRow("3", { description: null });
  const withImage = readyRow("4", { image });
  const rows = [pendingRow, failedRow, waitingRow, plainPage, withImage];

  it("draws every Preview open under open", () => {
    expect(foldedOf("open", new Set(), key, rows)).toStrictEqual({
      _tag: "Rows",
      rows: rows.map((shown) => ({ fold: "Open", shown })),
    });
  });

  it("folds under summary only a card that shows more than its title", () => {
    expect(foldedOf("summary", new Set(), key, rows)).toStrictEqual({
      _tag: "Rows",
      rows: [
        { fold: "Open", shown: pendingRow },
        { fold: "Open", shown: failedRow },
        { fold: "Open", shown: waitingRow },
        { fold: "Open", shown: plainPage },
        { fold: "Folded", shown: withImage },
      ],
    });
  });

  it("folds a card with a description alone under summary, to its title", () => {
    expect(foldedOf("summary", new Set(), key, [readyRow("0", {})])).toStrictEqual({
      _tag: "Rows",
      rows: [{ fold: "Folded", shown: readyRow("0", {}) }],
    });
  });

  it("opens under summary only the Preview pressed, and keeps it open", () => {
    const other = readyRow("5", { image });
    const opened = opening(new Set(), key, [withImage]);

    expect(foldedOf("summary", opened, key, [withImage, other])).toStrictEqual({
      _tag: "Rows",
      rows: [
        { fold: "Open", shown: withImage },
        { fold: "Folded", shown: other },
      ],
    });
  });

  it("keeps a Preview opened in one Message folded in another", () => {
    const opened = opening(new Set(), messageKey(timeline, at(2)), [withImage]);

    expect(foldedOf("summary", opened, key, [withImage])).toStrictEqual({
      _tag: "Rows",
      rows: [{ fold: "Folded", shown: withImage }],
    });
  });

  it("draws a Message's Previews as one chip counting them under chip, whatever they are", () => {
    expect([
      foldedOf("chip", new Set(), key, rows),
      foldedOf("chip", new Set(), key, [pendingRow]),
    ]).toStrictEqual([
      { _tag: "Chip", count: 5 },
      { _tag: "Chip", count: 1 },
    ]);
  });

  it("opens every Preview of a Message once its chip is pressed", () => {
    const described = readyRow("6", {});
    const all = [...rows, described];

    expect(foldedOf("chip", opening(new Set(), key, all), key, all)).toStrictEqual({
      _tag: "Rows",
      rows: [
        { fold: "Open", shown: pendingRow },
        { fold: "Open", shown: failedRow },
        { fold: "Open", shown: waitingRow },
        { fold: "Open", shown: plainPage },
        { fold: "Open", shown: withImage },
        { fold: "Open", shown: described },
      ],
    });
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

  it("is none under text, even one held from while Previews were on", () => {
    expect(streamed({ kind: "video", type: "video/mp4" }, "text")).toBeUndefined();
    expect(streamed({ kind: "audio", type: "audio/ogg" }, "text")).toBeUndefined();
  });

  it("is none for a page, an image, or a player", () => {
    expect(streamed({ kind: "page" })).toBeUndefined();
    expect(streamed({ kind: "image", type: "image/png" })).toBeUndefined();
    expect(streamed({ kind: "player" })).toBeUndefined();
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

describe("the box a poster, its video, and its player share", () => {
  const player = { size: { height: 360, width: 640 } };
  const poster = { dimensions: { height: 3, width: 4 } };

  it("is the player's shape if its page gave one, else the poster's, else 16 by 9", () => {
    expect([
      playsIn({ player, poster }),
      playsIn({ player: { size: undefined }, poster }),
      playsIn({ poster }),
      playsIn({ player: { size: undefined }, poster: { dimensions: undefined } }),
      playsIn({ player }),
      playsIn({}),
    ]).toStrictEqual([
      { height: 360, width: 640 },
      { height: 3, width: 4 },
      { height: 3, width: 4 },
      { height: 9, width: 16 },
      { height: 360, width: 640 },
      { height: 9, width: 16 },
    ]);
  });
});
