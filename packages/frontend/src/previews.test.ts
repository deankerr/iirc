import {
  HeldItem,
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
  hasMedia,
  heldReadOf,
  initialPreviews,
  isOpen,
  linkKey,
  mayPreview,
  messageKey,
  motionOf,
  pressOf,
  pressesWanted,
  pressOn,
  previewsModesOf,
  previewsOf,
  reasonWords,
  reducePreviews,
  thumbnailOf,
  togglesIn,
} from "./previews.ts";
import type {
  MediaShown,
  Motion,
  MotionAsked,
  Opening,
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
    answers: null,
    at: { _tag: "Unknown" },
    bot: false,
    context: null,
    id: { _tag: "Unknown" },
    kind: "Privmsg",
    live: true,
    nicks: [],
    ours: null,
    prefix: null,
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
  size: null,
  stream: null,
  thumbnail: false,
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

/**
 * A held item, by a letter that makes its id, as decoded.
 * @param letter - The letter.
 * @param state - Its state, as the wire carries it.
 * @returns The item.
 */
const heldItem = (letter: string, state: typeof HeldItem.Encoded.state) =>
  Schema.decodeSync(HeldItem)({ id: idOf(letter), link: `https://${letter}.example/`, state });

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

/** Every Preview open, as `ui.previews.start` starts them, and nothing toggled. */
const opened: Opening = { start: "open", toggles: new Map() };

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
    { _tag: "Shown", direct: false, links: 1, position: at(sequence), timeline }
  );

  const [ask] = asksWanted(shown, everywhere("text"), opened);

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

  it("makes or removes one conversation's own choice, leaving the others", () => {
    const timelines = { [other]: "off", [timeline]: "on" } as const;

    expect([
      choosing(timelines, timeline, "text"),
      choosing(timelines, timeline, undefined),
      choosing({}, other, undefined),
    ]).toStrictEqual([{ [other]: "off", [timeline]: "text" }, { [other]: "off" }, {}]);
  });

  it("follows the stream while any conversation asks, even with ui.previews off", () => {
    expect([
      asksAnywhere(undefined),
      asksAnywhere(everywhere("off")),
      asksAnywhere({ players: listed, shown: "off", timelines: { [other]: "off" } }),
      asksAnywhere({ players: listed, shown: "off", timelines: { [other]: "text" } }),
      asksAnywhere({ players: listed, shown: "on", timelines: { [other]: "off" } }),
    ]).toStrictEqual([false, false, false, true, true]);
  });

  it("watches only a message with a link that may be previewed, while the mode asks", () => {
    expect([
      mayPreview("text", links),
      mayPreview("text", said("irc://irc.libera.chat/#iirc and no web link")),
      mayPreview("off", links),
      mayPreview(undefined, links),
    ]).toStrictEqual([true, false, false, false]);
  });
});

describe("asking", () => {
  it("asks for a message only once it was shown, and only while the stream is followed", () => {
    const shown = fold(initialPreviews, {
      _tag: "Shown",
      direct: false,
      links: 1,
      position: at(1),
      timeline,
    });

    expect(asksWanted(initialPreviews, everywhere("on"), opened)).toStrictEqual([]);
    expect(asksWanted(shown, everywhere("on"), opened)).toStrictEqual([]);
    expect(asksWanted(fold(shown, { _tag: "Followed" }), everywhere("on"), opened)).toHaveLength(1);
  });

  it("never asks while the mode is off, or unknown", () => {
    const shown = fold(
      initialPreviews,
      { _tag: "Followed" },
      { _tag: "Shown", direct: false, links: 1, position: at(1), timeline }
    );

    expect([
      asksWanted(shown, everywhere("off"), opened),
      asksWanted(shown, undefined, opened),
    ]).toStrictEqual([[], []]);
  });

  it("asks once for a message shown again and again", () => {
    const { ask, state } = asking(1);

    const again = fold(
      state,
      { _tag: "Shown", direct: false, links: 1, position: at(1), timeline },
      { _tag: "Answered", ask, previews: [item("a", ready)] },
      { _tag: "Shown", direct: false, links: 1, position: at(1), timeline }
    );

    expect(asksWanted(state, everywhere("on"), opened)).toStrictEqual([]);
    expect(asksWanted(again, everywhere("on"), opened)).toStrictEqual([]);
  });

  it("never asks again for a message the daemon refused", () => {
    const { ask, state } = asking(1);
    const refused = fold(state, { _tag: "Refused", ask });

    expect(
      asksWanted(fold(refused, { _tag: "Lost" }, { _tag: "Followed" }), everywhere("on"), opened)
    ).toStrictEqual([]);
    expect(previewsOf(refused, "on", timeline, at(1), links, drawing)).toStrictEqual([]);
  });

  it("asks again, once followed again, for a message still pending when the stream was lost", () => {
    const { ask, state } = asking(1);
    const answered = fold(state, { _tag: "Answered", ask, previews: [item("a", pending)] });

    expect(asksWanted(fold(answered, { _tag: "Lost" }), everywhere("on"), opened)).toStrictEqual(
      []
    );
    expect(
      asksWanted(
        fold(answered, { _tag: "Lost" }, { _tag: "Followed" }),
        everywhere("on"),
        opened
      ).map((one) => one.key)
    ).toStrictEqual([ask.key]);
  });

  it("does not ask again for a message whose Previews all settled before the stream was lost", () => {
    const { ask, state } = asking(1);

    const settled = fold(
      state,
      { _tag: "Answered", ask, previews: [item("a", ready), item("b", pending)] },
      { _tag: "Changed", item: item("b", { _tag: "Failed", reason: "TimedOut" }) },
      { _tag: "Lost" },
      { _tag: "Followed" }
    );

    expect(asksWanted(settled, everywhere("on"), opened)).toStrictEqual([]);
  });

  it("asks again for an ask in flight when the stream was lost, and takes no answer of the first", () => {
    const { ask, state } = asking(1);
    const lost = fold(state, { _tag: "Lost" }, { _tag: "Followed" });
    const late = fold(lost, { _tag: "Answered", ask, previews: [item("a", pending)] });

    expect(asksWanted(late, everywhere("on"), opened).map((one) => one.key)).toStrictEqual([
      ask.key,
    ]);
  });
});

describe("asking per conversation", () => {
  it("asks only for messages in a conversation whose own mode asks", () => {
    const shown = fold(
      initialPreviews,
      { _tag: "Followed" },
      { _tag: "Shown", direct: false, links: 1, position: at(1), timeline },
      { _tag: "Shown", direct: false, links: 1, position: at(2), timeline: other }
    );

    const keys = (modes: PreviewsModes) =>
      asksWanted(shown, modes, opened).map((one) => one.timeline);

    expect([
      keys({ players: listed, shown: "on", timelines: { [other]: "off" } }),
      keys({ players: listed, shown: "off", timelines: { [other]: "text" } }),
    ]).toStrictEqual([[timeline], [other]]);
  });

  it("asks again for a message waiting for a press once its conversation chooses to be previewed", () => {
    const { ask, state } = asking(1);
    const answered = fold(state, { _tag: "Answered", ask, previews: [item("a", waitingForPress)] });

    const chosen: PreviewsModes = {
      players: listed,
      shown: "text",
      timelines: { [timeline]: "on" },
    };

    const [again] = asksWanted(answered, chosen, opened);

    if (again === undefined) {
      throw new Error("nothing to ask");
    }

    const reanswered = fold(
      answered,
      { _tag: "Asked", ask: again },
      { _tag: "Answered", ask: again, previews: [item("a", pending)] }
    );

    expect({
      default: asksWanted(answered, everywhere("on"), opened),
      onceAnswered: asksWanted(reanswered, chosen, opened),
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
  it("is a press of its message's place and its index, at the stream's count", () => {
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
      ["LinkCard", "Pending"],
      ["LinkCard", "LinkCard"],
    ]);
  });

  it("asks its message again when a press is refused, so what is drawn is the daemon's", () => {
    const state = waiting();
    const press = pressOf(state, timeline, at(1), 1);
    const refused = fold(state, { _tag: "PressRefused", press });

    expect(asksWanted(refused, everywhere("on"), opened).map((one) => one.key)).toStrictEqual([
      press.key,
    ]);
  });
});

/** A Message's place in each kind of Timeline, as whether its Previews are open asks. */
const inChannel = { direct: false, position: at(1), timeline } as const;
const inDirect = { direct: true, position: at(1), timeline } as const;

/**
 * How a view opens Previews.
 * @param start - `ui.previews.start`.
 * @param toggled - The links toggled, by their index in the Message at 1, open or closed.
 * @returns The opening.
 */
const opening = (
  start: "open" | "closed",
  toggled: readonly (readonly [number, boolean])[] = []
): Opening => ({
  start,
  toggles: new Map(
    toggled.map(([index, open]) => [linkKey(messageKey(timeline, at(1)), index), open])
  ),
});

/**
 * The modes with `ui.previews` `on`, and this Timeline's own choice, if any.
 * @param chosen - Its own choice.
 * @returns The modes.
 */
const choosingHere = (chosen?: "off" | "text" | "on"): PreviewsModes => ({
  players: listed,
  shown: "on",
  timelines: chosen === undefined ? {} : { [timeline]: chosen },
});

/**
 * A Message at 1 answered with a link waiting for a press.
 * @returns The state.
 */
const waitingHere = () => {
  const { ask, state } = asking(1);

  return fold(state, { _tag: "Answered", ask, previews: [item("a", waitingForPress)] });
};

describe("whether a Preview is open", () => {
  it.each([
    ["as start says, open", initialPreviews, undefined, opening("open"), inChannel, true],
    ["as start says, closed", initialPreviews, undefined, opening("closed"), inChannel, false],
    [
      "closed by the Owner under open",
      initialPreviews,
      undefined,
      opening("open", [[0, false]]),
      inChannel,
      false,
    ],
    [
      "opened by the Owner under closed",
      initialPreviews,
      undefined,
      opening("closed", [[0, true]]),
      inChannel,
      true,
    ],
    [
      "closed in a direct message with no mode of its own, whatever start says",
      initialPreviews,
      undefined,
      opening("open"),
      inDirect,
      false,
    ],
    [
      "opened by the Owner in a direct message with no mode of its own",
      initialPreviews,
      undefined,
      opening("closed", [[0, true]]),
      inDirect,
      true,
    ],
    [
      "as start says in a direct message set to on",
      initialPreviews,
      "on",
      opening("open"),
      inDirect,
      true,
    ],
    [
      "as start says in a direct message set to text",
      initialPreviews,
      "text",
      opening("closed"),
      inDirect,
      false,
    ],
    [
      "closed where the daemon says its link waits for a press",
      waitingHere(),
      undefined,
      opening("open"),
      inChannel,
      false,
    ],
    [
      "as start says where a link waited before its conversation chose a mode",
      waitingHere(),
      "on",
      opening("open"),
      inChannel,
      true,
    ],
  ] as const)("is %s", (_name, state, chosen, how, where, expected) => {
    expect(isOpen(state, choosingHere(chosen), how, where, 0)).toBe(expected);
  });
});

/**
 * Whether a Message with two links, shown in a Timeline, is asked for.
 * @param direct - Whether the Timeline is a Direct Message.
 * @param modes - The modes.
 * @param how - How the view opens Previews.
 * @returns Whether it is asked for.
 */
const askedFor = (direct: boolean, modes: PreviewsModes, how: Opening) =>
  asksWanted(
    fold(
      initialPreviews,
      { _tag: "Followed" },
      { _tag: "Shown", direct, links: 2, position: at(1), timeline }
    ),
    modes,
    how
  ).length === 1;

describe("whether a message is asked for", () => {
  it.each([
    ["while start is open", false, choosingHere(), opening("open"), true],
    ["not while start is closed", false, choosingHere(), opening("closed"), false],
    [
      "once one link is opened under closed",
      false,
      choosingHere(),
      opening("closed", [[1, true]]),
      true,
    ],
    [
      "not once every link is closed under open",
      false,
      choosingHere(),
      opening("open", [
        [0, false],
        [1, false],
      ]),
      false,
    ],
    [
      "while one link of two is still open",
      false,
      choosingHere(),
      opening("open", [[0, false]]),
      true,
    ],
    ["not under off, whatever is open", false, choosingHere("off"), opening("open"), false],
    [
      "in a direct message with no mode of its own under open, as the daemon fetches nothing there",
      true,
      choosingHere(),
      opening("open"),
      true,
    ],
    [
      "in a direct message with no mode of its own under closed, as the daemon fetches nothing there",
      true,
      choosingHere(),
      opening("closed"),
      true,
    ],
    [
      "not in a direct message set to on while start is closed",
      true,
      choosingHere("on"),
      opening("closed"),
      false,
    ],
    [
      "in a direct message set to on while start is open",
      true,
      choosingHere("on"),
      opening("open"),
      true,
    ],
    [
      "in a direct message set to text once one link is opened",
      true,
      choosingHere("text"),
      opening("closed", [[0, true]]),
      true,
    ],
  ] as const)("is %s", (_name, direct, modes, how, expected) => {
    expect(askedFor(direct, modes, how)).toBe(expected);
  });

  it("asks again for a message waiting for a press, once its conversation chooses a mode, only while one is open", () => {
    const { ask, state } = asking(1);
    const answered = fold(state, { _tag: "Answered", ask, previews: [item("a", waitingForPress)] });

    expect([
      asksWanted(answered, choosingHere("on"), opening("open")).length,
      asksWanted(answered, choosingHere("on"), opening("closed")).length,
    ]).toStrictEqual([1, 0]);
  });
});

/**
 * A Message at 1 answered with a ready Preview, then a link waiting for a press.
 * @returns The state.
 */
const answered = () => {
  const { ask, state } = asking(1);

  return fold(state, {
    _tag: "Answered",
    ask,
    previews: [item("a", ready), item("b", waitingForPress)],
  });
};

/**
 * What was toggled, by each link's index in the Message at 1.
 * @param pairs - Each link's index, and whether it was opened.
 * @returns The toggles.
 */
const toggled = (pairs: readonly (readonly [number, boolean])[]) =>
  opening("closed", pairs).toggles;

describe("whether a link is pressed", () => {
  it.each([
    ["not while the Owner has not opened it", answered(), toggled([]), []],
    ["once the Owner opens it", answered(), toggled([[1, true]]), [1]],
    ["not while the Owner has closed it", answered(), toggled([[1, false]]), []],
    ["not where it does not wait, though opened", answered(), toggled([[0, true]]), []],
    [
      "not twice",
      fold(answered(), { _tag: "Pressing", press: pressOf(answered(), timeline, at(1), 1) }),
      toggled([[1, true]]),
      [],
    ],
  ] as const)("is %s", (_name, state, toggles, expected) => {
    expect(pressesWanted(state, toggles).map((press) => press.link)).toStrictEqual(expected);
  });
});

/**
 * A text's runs as drawn, each a link's by its `href`, or other text.
 * @param hrefs - Each run's `href`, or none.
 * @returns The runs.
 */
const runs = (...hrefs: readonly (string | undefined)[]) =>
  hrefs.map((href) => (href === undefined ? { _tag: "Text" } : { _tag: "Link", href }));

describe("a press let go of before it was answered", () => {
  it("is pressed again, as the link still waits", () => {
    const press = pressOf(answered(), timeline, at(1), 1);

    expect(
      pressesWanted(
        fold(answered(), { _tag: "Pressing", press }, { _tag: "PressDropped", press }),
        toggled([[1, true]])
      ).map((one) => one.link)
    ).toStrictEqual([1]);
  });
});

describe("a message shown again with more links", () => {
  it("is asked for once its new link is opened, as a server's echo may add one", () => {
    const state = fold(
      initialPreviews,
      { _tag: "Followed" },
      { _tag: "Shown", direct: false, links: 1, position: at(1), timeline },
      { _tag: "Shown", direct: false, links: 2, position: at(1), timeline }
    );

    expect(asksWanted(state, choosingHere(), opening("closed", [[1, true]]))).toHaveLength(1);
  });
});

describe("a message answered, then shown with more links", () => {
  it("is asked for again, and an answer for its old links settles nothing", () => {
    const { ask, state } = asking(1);
    const more = { _tag: "Shown", direct: false, links: 2, position: at(1), timeline } as const;
    const answered = fold(state, { _tag: "Answered", ask, previews: [item("a", ready)] }, more);
    const raced = fold(state, more, { _tag: "Answered", ask, previews: [item("a", ready)] });

    expect([
      asksWanted(answered, choosingHere(), opening("closed", [[1, true]])).length,
      asksWanted(raced, choosingHere(), opening("closed", [[1, true]])).length,
    ]).toStrictEqual([1, 1]);
  });
});

describe("where a toggle stands", () => {
  it.each([
    [
      "after each link that may be previewed",
      runs(undefined, "https://a.example/", undefined, "https://b.example/"),
      said("see https://a.example/ and https://b.example/"),
      [
        [1, 0],
        [3, 1],
      ],
    ],
    [
      "after the first of a link said twice",
      runs("https://a.example/", undefined, "https://a.example/"),
      said("https://a.example/ and https://a.example/"),
      [[0, 0]],
    ],
    [
      "after none that may not be previewed",
      runs("irc://irc.libera.chat/#iirc"),
      said("irc://irc.libera.chat/#iirc"),
      [],
    ],
    [
      "after the first three links alone",
      runs("https://a.example/", "https://b.example/", "https://c.example/", "https://d.example/"),
      said("https://a.example/ https://b.example/ https://c.example/ https://d.example/"),
      [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
    ],
  ] as const)("is %s", (_name, drawn, content, expected) => {
    expect([...togglesIn(drawn, content)]).toStrictEqual(expected);
  });
});

describe("folding a change", () => {
  it("replaces the item held under its id, in every message that shows it", () => {
    const first = asking(1);

    const one = fold(first.state, {
      _tag: "Answered",
      ask: first.ask,
      previews: [item("a", pending)],
    });

    const shown = fold(one, { _tag: "Shown", direct: false, links: 1, position: at(2), timeline });
    const [second] = asksWanted(shown, everywhere("on"), opened);

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
    ).toStrictEqual([["LinkCard"], ["LinkCard"]]);
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
    ).toStrictEqual(["LinkCard"]);
  });

  it("takes an answer over a change the stream gave before its ask began", () => {
    const first = asking(1);

    const failed = fold(
      first.state,
      { _tag: "Answered", ask: first.ask, previews: [item("a", pending)] },
      { _tag: "Changed", item: item("a", { _tag: "Failed", reason: "Unreachable" }) },
      { _tag: "Shown", direct: false, links: 1, position: at(2), timeline }
    );

    const [second] = asksWanted(failed, everywhere("on"), opened);

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

const notHeld = { _tag: "NotHeld" } as const;

/**
 * A held read of the Message at one, begun and answered with its items.
 * @param state - The state it begins in.
 * @param previews - What the Daemon holds of its links.
 * @returns The state, once read.
 */
const heldIn = (state: Previews, previews: readonly HeldItem[]) => {
  const read = heldReadOf(state, timeline);

  return fold(
    state,
    { _tag: "Reading", read },
    { _tag: "Read", messages: [{ position: at(1), previews }], read }
  );
};

describe("a held read", () => {
  it("draws a row held before it is drawn, with no placeholder, while other messages are answered", () => {
    const held = heldIn(initialPreviews, [
      heldItem("a", ready),
      heldItem("b", { _tag: "Failed", reason: "Refused" }),
    ]);

    const shown = fold(
      held,
      { _tag: "Followed" },
      { _tag: "Shown", direct: false, links: 1, position: at(2), timeline }
    );

    const [ask] = asksWanted(shown, everywhere("on"), opened);

    if (ask === undefined) {
      throw new Error("nothing to ask");
    }

    const answered = fold(
      shown,
      { _tag: "Asked", ask },
      { _tag: "Answered", ask, previews: [item("c", ready)] }
    );

    expect(
      [held, answered].map((state) =>
        previewsOf(state, "on", timeline, at(1), links, drawing).map((one) => one._tag)
      )
    ).toStrictEqual([
      ["LinkCard", "Failed"],
      ["LinkCard", "Failed"],
    ]);
  });

  it("keeps a change the stream gave while it was in flight over what it read", () => {
    const read = heldReadOf(initialPreviews, timeline);

    const raced = fold(
      initialPreviews,
      { _tag: "Followed" },
      { _tag: "Reading", read },
      { _tag: "Changed", item: item("a", ready) },
      { _tag: "Read", messages: [{ position: at(1), previews: [heldItem("a", pending)] }], read }
    );

    expect(
      previewsOf(raced, "on", timeline, at(1), said("https://a.example/"), drawing).map(
        (one) => one._tag
      )
    ).toStrictEqual(["LinkCard"]);
  });

  it("draws a link not held as a placeholder, and still asks for its message once shown", () => {
    const held = fold(heldIn(initialPreviews, [heldItem("a", ready), heldItem("b", notHeld)]), {
      _tag: "Followed",
    });

    const shown = fold(held, {
      _tag: "Shown",
      direct: false,
      links: 2,
      position: at(1),
      timeline,
    });

    expect(
      previewsOf(held, "on", timeline, at(1), links, drawing).map((one) => one._tag)
    ).toStrictEqual(["LinkCard", "Pending"]);
    expect(asksWanted(shown, everywhere("on"), opened).map((one) => one.key)).toStrictEqual([
      messageKey(timeline, at(1)),
    ]);
  });

  it("draws a placeholder, not another link's card, when the message's links changed since the read", () => {
    const held = heldIn(initialPreviews, [heldItem("a", ready)]);

    expect(
      previewsOf(held, "on", timeline, at(1), said("https://z.example/"), drawing).map(
        (one) => one._tag
      )
    ).toStrictEqual(["Pending"]);
  });

  it("draws a link not held once the stream says another device's ask fetched it", () => {
    const held = heldIn(fold(initialPreviews, { _tag: "Followed" }), [heldItem("a", notHeld)]);
    const changed = fold(held, { _tag: "Changed", item: item("a", ready) });

    expect(
      previewsOf(changed, "on", timeline, at(1), said("https://a.example/"), drawing).map(
        (one) => one._tag
      )
    ).toStrictEqual(["LinkCard"]);
  });
});

describe("what a message shows", () => {
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

  it("shows nothing while the mode is off or unknown, nor for anything but a message", () => {
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
        _tag: "LinkCard",
        description: "A page about cats.",
        key: "0",
        link: { href: "https://a.example/", text: "https://a.example/" },
        media: { _tag: "None" },
        name: "Cats",
        title: "Cats",
      },
      {
        _tag: "Failed",
        key: "1",
        reason: "No preview: the daemon never fetches this address.",
      },
      {
        _tag: "Pending",
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

  it("draws the links its message holds, never an address the daemon gave", () => {
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
      shown.map((one) => [one._tag, one._tag === "LinkCard" ? one.link.href : undefined, one.key])
    ).toStrictEqual([
      ["LinkCard", "https://a.example/#one", "0"],
      ["LinkCard", "https://a.example/#two", "1"],
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

  return only?._tag === "LinkCard" || only?._tag === "MediaCard" ? only : undefined;
};

/**
 * A card's words, or none for a media card, which has none.
 * @param fields - The Preview's fields other than the page's.
 * @param mode - `ui.previews`.
 * @returns Its title and description.
 */
const wordsIn = (fields: Partial<typeof Preview.Encoded>, mode: "on" | "text" = "on") => {
  const shown = shownReady(fields, mode);

  return shown?._tag === "LinkCard" ? [shown.title, shown.description] : undefined;
};

const picture = {
  _tag: "Picture",
  alt: "Cats",
  animated: false,
  dimensions: undefined,
  src: `/api/previews/images/${hash}`,
} as const;

describe("a card's picture", () => {
  it("is the link itself for a link that is itself an image, and says when it moves", () => {
    expect(
      shownReady({
        description: null,
        image: { animated: true, dimensions: null, hash, size: 10, type: "image/gif" },
        kind: "image",
        title: null,
        type: "image/gif",
      })?.media
    ).toStrictEqual({ ...picture, alt: "https://example.com/cats", animated: true });
  });

  it("carries its dimensions in pixels, or none where the daemon read none", () => {
    const sized = { animated: false, dimensions: { height: 48, width: 64 }, hash, size: 10 };

    expect([
      shownReady({ image: { ...sized, type: "image/png" } })?.media,
      shownReady({ image: { ...sized, dimensions: null, type: "image/png" } })?.media,
    ]).toStrictEqual([{ ...picture, dimensions: { height: 48, width: 64 } }, picture]);
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
 * A card's player, or none when its media is another.
 * @param fields - The Preview's fields other than the page's.
 * @param players - The hosts listed now.
 * @returns The player.
 */
const playerIn = (fields: Partial<typeof Preview.Encoded>, players: readonly string[] = listed) => {
  const media = shownReady(fields, "on", players)?.media;

  return media?._tag === "Player" ? media : undefined;
};

/**
 * The address a player's frame loads, once pressed.
 * @param link - The player's address, as the Daemon answered it.
 * @param hosts - The hosts listed now.
 * @returns What the frame loads.
 */
const srcOf = (link: string, hosts: readonly string[]) =>
  playerIn({ ...playing, player: { link, size: null } }, hosts)?.src;

describe("a card's player", () => {
  it("is the host it plays from, the words that say so, its poster, and what a frame needs, under on", () => {
    expect(playerIn(playing)).toStrictEqual({
      _tag: "Player",
      box: { height: 360, width: 640 },
      host: "www.youtube-nocookie.com",
      poster: { ...picture, alt: "A song" },
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
    expect(srcOf("https://bandcamp.com/EmbeddedPlayer/album=1", listed)).toBe(
      "https://bandcamp.com/EmbeddedPlayer/album=1"
    );
  });

  it.each([
    ["the list no longer names its host", playing, ["player.vimeo.com"]],
    ["the list names none", playing, []],
    ["the list names its host by a suffix", playing, ["youtube-nocookie.com"]],
    ["the list names a look-alike", playing, ["www.youtube-nocookie.com."]],
    [
      "its address cannot be read",
      { ...playing, player: { link: "not a link", size: null } },
      listed,
    ],
  ] as const)("is a page with its picture once %s", (_name, fields, players) => {
    expect(shownReady(fields, "on", players)?.media).toStrictEqual({ ...picture, alt: "A song" });
  });
});

/**
 * The box a card's poster and what it plays share, or none when it plays nothing.
 * @param fields - The Preview's fields other than the page's.
 * @returns The box.
 */
const boxIn = (fields: Partial<typeof Preview.Encoded>) => {
  const media = shownReady(fields)?.media;

  return media?._tag === "Player" || media?._tag === "Video" ? media.box : undefined;
};

describe("the box a poster and what it plays share", () => {
  const poster = { ...playing.image, dimensions: { height: 3, width: 4 } };

  it.each([
    ["a player's size, if its page gave one", { ...playing, image: poster }, 640, 360],
    [
      "else its poster's shape",
      { ...playing, image: poster, player: { ...playing.player, size: null } },
      4,
      3,
    ],
    ["else 16 by 9", { ...playing, player: { ...playing.player, size: null } }, 16, 9],
    ["a video's poster's shape", { image: poster, kind: "video" }, 4, 3],
    ["16 by 9 for a video with no poster", { kind: "video" }, 16, 9],
  ] as const)("is %s", (_name, fields, width, height) => {
    expect(boxIn(fields)).toStrictEqual({ height, width });
  });
});

const image = { animated: false, dimensions: null, hash, size: 10, type: "image/png" } as const;

/**
 * What media a card holds, in a word, with its poster or the host it plays from.
 * @param media - The media.
 * @returns The word.
 */
const mediaWords = (media: MediaShown): string => {
  switch (media._tag) {
    case "None": {
      return "-";
    }

    case "Picture": {
      return "picture";
    }

    case "ThumbnailOnly": {
      return "thumbnail only";
    }

    case "Video": {
      return media.poster === undefined ? "video" : "video, poster";
    }

    case "Player": {
      return `player ${media.host}${media.poster === undefined ? "" : ", poster"}`;
    }

    case "Sound": {
      return "sound";
    }

    default: {
      return media satisfies never;
    }
  }
};

/**
 * What a card holds, in its order, as a row of a table: which card it is, its title, its
 * description, and its media, each `-` where it has none, or `nothing` for no card at all.
 * @param fields - The Preview's fields other than the page's.
 * @param mode - `ui.previews`.
 * @returns The row.
 */
const holds = (fields: Partial<typeof Preview.Encoded>, mode: "on" | "text") => {
  const shown = shownReady(fields, mode);

  if (shown === undefined) {
    return "nothing";
  }

  const words = shown._tag === "LinkCard" ? [shown.title, shown.description] : [];

  return [shown._tag, ...[0, 1].map((at) => words[at] ?? "-"), mediaWords(shown.media)].join(" | ");
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
    ["a page", { image }, "on", "LinkCard | Cats | A page about cats. | picture"],
    ["a page", { image }, "text", "LinkCard | Cats | A page about cats. | -"],
    [
      "a page with no title",
      { image, title: null },
      "on",
      "LinkCard | - | A page about cats. | picture",
    ],
    ["a page with no image", {}, "on", "LinkCard | Cats | A page about cats. | -"],
    [
      "a page that calls its image a thumbnail",
      { image, thumbnail: true },
      "on",
      "LinkCard | Cats | A page about cats. | thumbnail only",
    ],
    [
      "a page that calls its image a thumbnail, with no words",
      { description: null, image, thumbnail: true, title: null },
      "on",
      "MediaCard | - | - | picture",
    ],
    ["a page with only blank words", { description: " ", title: "" }, "on", "nothing"],
    [
      "a page with no words but its image",
      { description: null, image, title: null },
      "on",
      "MediaCard | - | - | picture",
    ],
    [
      "a page that names a video file",
      pageVideo,
      "on",
      "LinkCard | Cats | A page about cats. | video, poster",
    ],
    [
      "a page that names a video file with no poster",
      { ...pageVideo, image: null },
      "on",
      "LinkCard | Cats | A page about cats. | video",
    ],
    [
      "a page that names a video file",
      pageVideo,
      "text",
      "LinkCard | Cats | A page about cats. | -",
    ],
    [
      "a page that names a listed player",
      playing,
      "on",
      "LinkCard | A song | A page about cats. | player www.youtube-nocookie.com, poster",
    ],
    [
      "a page that names a listed player",
      playing,
      "text",
      "LinkCard | A song | A page about cats. | -",
    ],
    [
      "a listed player with no words",
      { ...playing, description: null, image: null, title: null },
      "on",
      "MediaCard | - | - | player www.youtube-nocookie.com",
    ],
    [
      "a link that is itself an image",
      { description: null, image, kind: "image", title: null },
      "on",
      "MediaCard | - | - | picture",
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
      "LinkCard | Cats | A page about cats. | -",
    ],
    ["a link that is itself a video", videoItself, "on", "MediaCard | - | - | video"],
    ["a link that is itself a video", videoItself, "text", "nothing"],
    [
      "a link that is itself a sound",
      { description: null, kind: "audio", stream: page.link, title: null },
      "on",
      "MediaCard | - | - | sound",
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
      ...(wordsIn({ description: "a\u0007b", title: "evil\u202E" }) ?? []),
    ]).toStrictEqual(["Cats", "https://a.example/", "evil\u202E\u202C", "a␇b"]);
  });
});

/**
 * A card for a link to a file, as `holds` reads a card, with no page words of its own.
 * @param link - The link the file was read from.
 * @param fields - What the Daemon read of it.
 * @param mode - `ui.previews`.
 * @returns The row.
 */
const fileHolds = (
  link: string,
  fields: Partial<typeof Preview.Encoded> = {},
  mode: "on" | "text" = "on"
) => holds({ description: null, kind: "file", link, size: null, title: null, ...fields }, mode);

describe("a file's card", () => {
  it.each([
    ["its name from the path", "https://example.com/a/b/report.pdf", "report.pdf"],
    ["its name without its query or fragment", "https://example.com/a.txt?x=/y#/z", "a.txt"],
    ["its name percent-decoded", "https://example.com/my%20notes%C3%A9.txt", "my notesé.txt"],
    ["its name as written where it does not decode", "https://example.com/100%.txt", "100%.txt"],
    ["its host for a path with no last part", "https://example.com/", "example.com"],
    ["its host for a trailing slash", "https://example.com/dir/", "example.com"],
    ["its host for a name that decodes to blank", "https://example.com/%20", "example.com"],
    ["its name contained", "https://example.com/a%0Ab%E2%80%AEc", "a\u240Ab\u202Ec\u202C"],
  ] as const)("is %s", (_name, link, title) => {
    expect(fileHolds(link).split(" | ")[1]).toBe(title);
  });

  it.each([
    ["its first lines with their breaks", { description: "one\ntwo\n\nfour" }, "one\ntwo\n\nfour"],
    [
      "its first lines in place of its type and size",
      { description: "one", size: 5, type: "text/plain" },
      "one",
    ],
    [
      "its lines contained each on its own",
      { description: "a\u202Eb\nc\u0007d\ne\u2066" },
      "a\u202Eb\u202C\nc\u2407d\ne\u2066\u2069",
    ],
    ["its tabs as spaces", { description: "\tif x:\n\t\ty" }, "    if x:\n        y"],
    ["its Windows line breaks as breaks", { description: "a\r\nb\r\n" }, "a\nb"],
    [
      "its blank lines at either end dropped",
      { description: "\n \nfirst\nlast\n\n" },
      "first\nlast",
    ],
    [
      "its type and size when it has no lines",
      { description: "", size: 1_234_567, type: "text/plain" },
      "text/plain \u00B7 1.2 MB",
    ],
    [
      "its type and size when its lines are blank",
      { description: " \n\n", size: 0, type: "text/plain" },
      "text/plain \u00B7 0 B",
    ],
    [
      "its type and size",
      { size: 1_200_000, type: "application/pdf" },
      "application/pdf \u00B7 1.2 MB",
    ],
    ["its type alone with no size", { type: "application/pdf" }, "application/pdf"],
    ["its size alone with no type", { size: 1 }, "1 B"],
    ["no description with neither", {}, "-"],
    ["its type contained", { type: "a/b\u202E" }, "a/b\u202E\u202C"],
  ] as const)("has %s", (_name, fields, description) => {
    expect(
      fileHolds("https://example.com/a.bin", fields).split(" | ").slice(2, -1).join(" | ")
    ).toBe(description);
  });

  it("is shown under text as under on, with no media", () => {
    expect(fileHolds("https://example.com/a.bin", { type: "text/x" }, "text")).toBe(
      "LinkCard | a.bin | text/x | -"
    );
    expect(fileHolds("https://example.com/a.bin", { image, type: "text/x" }, "on")).toBe(
      "LinkCard | a.bin | text/x | -"
    );
  });

  it("is named for its file name", () => {
    expect(
      shownReady({ kind: "file", link: "https://example.com/x/a.pdf", title: null })?.name
    ).toBe("a.pdf");
  });
});

describe("how big a file is said to be", () => {
  it.each([
    [0, "0 B"],
    [1, "1 B"],
    [2, "2 B"],
    [999, "999 B"],
    [1000, "1.0 KB"],
    [1234, "1.2 KB"],
    [9949, "9.9 KB"],
    [9950, "10 KB"],
    [12_345, "12 KB"],
    [999_499, "999 KB"],
    [999_500, "1.0 MB"],
    [999_999, "1.0 MB"],
    [1_200_000, "1.2 MB"],
    [12_000_000, "12 MB"],
    [3_400_000_000, "3.4 GB"],
    [999_999_999_999, "1.0 TB"],
    [5_600_000_000_000, "5.6 TB"],
    [5_600_000_000_000_000, "5600 TB"],
  ] as const)("%d bytes as %s", (bytes, words) => {
    expect(fileHolds("https://example.com/a", { size: bytes })).toBe(`LinkCard | a | ${words} | -`);
  });
});

describe("a link card's thumbnail", () => {
  const video = {
    _tag: "Video",
    box: { height: 9, width: 16 },
    src: "/v",
    type: undefined,
  } as const;

  const player = {
    _tag: "Player",
    box: { height: 9, width: 16 },
    host: "p.example",
    src: "/p",
    words: "plays from p.example",
  } as const;

  it.each([
    ["none for no media", { _tag: "None" }, { _tag: "None" }],
    ["the picture for a picture", picture, { _tag: "Picture", picture }],
    [
      "the picture for one that is only a thumbnail",
      { _tag: "ThumbnailOnly", picture },
      { _tag: "Picture", picture },
    ],
    [
      "the picture for an animated one",
      { ...picture, animated: true },
      { _tag: "Picture", picture: { ...picture, animated: true } },
    ],
    [
      "the poster under play for a video with one",
      { ...video, poster: picture },
      { _tag: "Poster", poster: picture },
    ],
    ["play alone for a video with no poster", { ...video, poster: undefined }, { _tag: "Play" }],
    [
      "the poster under play for a player with one",
      { ...player, poster: picture },
      { _tag: "Poster", poster: picture },
    ],
    ["play alone for a player with no poster", { ...player, poster: undefined }, { _tag: "Play" }],
    ["play alone for a sound", { _tag: "Sound", src: "/a", type: undefined }, { _tag: "Play" }],
  ] as const)("is %s", (_name, media: MediaShown, expected) => {
    expect(thumbnailOf(media)).toStrictEqual(expected);
  });
});

describe("whether a link card shows more than its words", () => {
  it.each([
    ["no media", { _tag: "None" }, false],
    ["a picture", picture, true],
    ["a picture that is only a thumbnail", { _tag: "ThumbnailOnly", picture }, false],
    ["a sound", { _tag: "Sound", src: "/a", type: undefined }, true],
  ] as const)("is %s for %s", (_name, media: MediaShown, expected) => {
    expect(hasMedia({ media })).toBe(expected);
  });
});

describe("a card's media", () => {
  it("is a video to stream under on, from the route by the message's place", () => {
    expect(streamed({ kind: "video", type: "video/mp4" })).toStrictEqual({
      _tag: "Video",
      box: { height: 9, width: 16 },
      poster: undefined,
      src: `/api/previews/${idOf("a")}/stream?timeline=${timeline}&position=${cursorOf(at(1))}`,
      type: "video/mp4",
    });
  });

  it("is a sound likewise, and has no type when the daemon read none", () => {
    expect(streamed({ kind: "audio", type: null })).toStrictEqual({
      _tag: "Sound",
      src: `/api/previews/${idOf("a")}/stream?timeline=${timeline}&position=${cursorOf(at(1))}`,
      type: undefined,
    });
  });

  it("is none for a page, an image, or a player that has none", () => {
    expect(
      ([{ kind: "page" }, { kind: "image", type: "image/png" }, { kind: "player" }] as const).map(
        (fields) => streamed(fields)?._tag
      )
    ).toStrictEqual(["None", "None", "None"]);
  });
});

describe("a failure's words", () => {
  it("says each reason as itself", () => {
    expect(
      (
        [
          "Refused",
          "Unreachable",
          "TimedOut",
          "TooLarge",
          "AnsweredError",
          "NothingToShow",
        ] as const
      ).map((reason) => reasonWords(reason))
    ).toStrictEqual([
      "No preview: the daemon never fetches this address.",
      "No preview: the daemon could not reach this link.",
      "No preview: this link took too long to answer.",
      "No preview: this link's answer was too large to read.",
      "No preview: this link answered with an error.",
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
