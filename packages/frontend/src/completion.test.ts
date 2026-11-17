import type { TimelineItem } from "@iirc/api";
import {
  NetworkEntry,
  NetworkId,
  SessionKnowledge,
  Timeline,
  TimelineId,
  TimelineList,
  TimelineWindow,
} from "@iirc/api";
import { ThemeName, fontNames, uiDefaults } from "@iirc/api/ui";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { commands, interpret, namedIn } from "./commands.ts";
import type { CommandContext } from "./commands.ts";
import {
  announced,
  chantypesWanted,
  completes,
  initialCompletion,
  listOf,
  nicksWanted,
  orderNicks,
  owns,
  previewOf,
  reduceCompletion,
  sourcesOf,
  spotAt,
} from "./completion.ts";
import type { Completion, CompletionEvent, Held, Shown, Sources } from "./completion.ts";
import { chordsFor, defaultKeymap } from "./keymap.ts";
import { choose, networkEntry, sections } from "./palette.ts";
import type { Listing } from "./palette.ts";
import { listedThemes } from "./theme.ts";
import { initialTimelines, reduceTimelines } from "./timelines.ts";
import type { SidebarNetwork, TimelinesEvent } from "./timelines.ts";

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const cursor = (at: number, sequence: number) =>
  `${hex(BigInt(at) + 2n ** 53n, 14)}-${hex(BigInt(sequence), 14)}-${hex(0n, 8)}`;

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;

const timelineId = Schema.decodeSync(TimelineId);
const network = Schema.decodeSync(NetworkId)("libera");
const iirc = timelineId(idOf(2));
const peer = timelineId(idOf(4));

const listing = (...names: readonly string[]) => commands.filter((one) => names.includes(one.name));

const sources: Sources = {
  channels: ["#iirc", "#other", "&local"],
  chantypes: undefined,
  chosen: { dark: uiDefaults.dark, light: uiDefaults.light, theme: uiDefaults.theme },
  commands: listing("me", "members", "msg", "set"),
  font: uiDefaults.font,
  keymap: [],
  network,
  networks: [],
  nicks: { _tag: "Members", timeline: iirc },
  options: [
    { description: "", name: "network.libera.nicks" },
    { description: "", name: "network.libera.realname" },
  ],
  ran: [],
  recent: [],
  self: undefined,
  suffix: ": ",
  themes: listedThemes([]),
  timelines: [],
};

/** Nicks at hand, as in a Direct Message, some alike under RFC 1459. */
const peers: Sources = {
  ...sources,
  nicks: { _tag: "Listed", nicks: ["peer", "pete", "Pa", "[p]"] },
};

interface Run {
  readonly state: Completion;
  readonly text: string;
  readonly caret: number;
}

/**
 * Folds events into completion as the composer would, its draft following each edit.
 * @param text - What is typed.
 * @param events - The events, Tabs with the composer's text and caret as they then are.
 * @param given - The sources.
 * @returns The state, and the text and caret shown.
 */
const play = (
  text: string,
  events: readonly (
    | { readonly _tag: "Tab"; readonly backwards?: boolean }
    | { readonly _tag: "Type"; readonly text: string }
    | { readonly _tag: "Pick"; readonly index: number }
    | { readonly _tag: "Move"; readonly start: number; readonly end?: number }
    | Exclude<CompletionEvent, { readonly _tag: "Tabbed" | "Typed" | "Picked" | "Moved" }>
  )[],
  given: Sources = sources
): Run => {
  let run: Run = { caret: text.length, state: initialCompletion, text };

  /**
   * The event as the composer says it, from where it stands.
   * @param event - The step.
   * @param now - The text and caret shown, after any typing.
   * @returns The event.
   */
  const said = (event: (typeof events)[number], now: Shown): CompletionEvent => {
    switch (event._tag) {
      case "Tab": {
        return { _tag: "Tabbed", backwards: event.backwards ?? false, place: iirc, ...now };
      }

      case "Type": {
        return { _tag: "Typed", place: iirc, ...now };
      }

      case "Pick": {
        return { _tag: "Picked", index: event.index, place: iirc, text: now.text };
      }

      case "Move": {
        return {
          _tag: "Moved",
          end: event.end ?? event.start,
          place: iirc,
          start: event.start,
          text: now.text,
        };
      }

      case "Escaped":
      case "LetGo":
      case "NicksFailed":
      case "NicksRead": {
        return event;
      }

      default: {
        return event satisfies never;
      }
    }
  };

  for (const event of events) {
    const now: Shown =
      event._tag === "Type"
        ? { caret: event.text.length, text: event.text }
        : { caret: event._tag === "Move" ? event.start : run.caret, text: run.text };

    const step = reduceCompletion(run.state, said(event, now), given);

    run = {
      caret: step.edit?.caret ?? now.caret,
      state: step.state,
      text: step.edit?.text ?? now.text,
    };
  }

  return run;
};

const tab = { _tag: "Tab" } as const;
const back = { _tag: "Tab", backwards: true } as const;
const type = (text: string) => ({ _tag: "Type", text }) as const;
const shown = (run: Run) => [run.text, run.caret];

/**
 * The names the composer lists, and which is highlighted, or none while no list is open.
 * @param run - Where the composer stands.
 * @param given - The sources.
 * @returns The names and the highlighted one's index, or none.
 */
const listed = (run: Run, given: Sources = sources) => {
  const list = listOf(run.state, iirc, run.text, given);

  return list === undefined
    ? undefined
    : { highlighted: list.highlighted, names: list.candidates.map((one) => one.name) };
};

describe("the word at the caret", () => {
  it("runs back from the caret to the whitespace before it, and keeps what follows", () => {
    expect({
      end: spotAt("hello wor", 9),
      middle: spotAt("say pe there", 6),
      newline: spotAt("one\n/se", 7),
      space: spotAt("hello ", 6),
    }).toStrictEqual({
      end: { after: "", before: "hello ", word: "wor" },
      middle: { after: " there", before: "say ", word: "pe" },
      newline: { after: "", before: "one\n", word: "/se" },
      space: { after: "", before: "hello ", word: "" },
    });
  });

  it("is taken by Tab only when there is one, so Tab otherwise moves focus", () => {
    expect([completes("", 0), completes("hi ", 3), completes("hi p", 4)]).toStrictEqual([
      false,
      false,
      true,
    ]);
  });
});

describe("completing", () => {
  it("completes a command at the start of a line, ranked as the palette ranks it, cycling with Tab, backwards with Shift+Tab", () => {
    expect({
      back: shown(play("/m", [back])),
      first: shown(play("/m", [tab])),
      notAtStart: play("say /m", [tab]).state.phase._tag,
      second: shown(play("/m", [tab, tab])),
      wraps: shown(play("/m", [tab, tab, tab, tab])),
      wrapsBack: shown(play("/m", [tab, back])),
    }).toStrictEqual({
      back: ["/members ", 9],
      first: ["/me ", 4],
      // A word starting with `/` mid-line is no command: none of the nicks start with it.
      notAtStart: "Asking",
      // The shorter name it begins ranks first, as in the palette.
      second: ["/msg ", 5],
      wraps: ["/me ", 4],
      wrapsBack: ["/members ", 9],
    });
  });

  it("completes an option's name after /set, a Channel's name, and keeps what follows the caret", () => {
    const middle = reduceCompletion(
      initialCompletion,
      { _tag: "Tabbed", backwards: false, caret: 8, place: iirc, text: "join #ii now" },
      sources
    );

    expect({
      ampersand: shown(play("see &l", [tab])),
      channel: shown(play("join #ii", [tab])),
      middle: middle.edit,
      option: shown(play("/set network.libera.n", [tab])),
      optionCase: shown(play("/SET  NETWORK.libera.r", [tab])),
    }).toStrictEqual({
      ampersand: ["see &local ", 11],
      channel: ["join #iirc ", 11],
      // Whitespace already follows the caret, so none is added.
      middle: { caret: 10, place: iirc, text: "join #iirc now" },
      option: ["/set network.libera.nicks ", 26],
      optionCase: ["/SET  network.libera.realname ", 30],
    });
  });

  it("asks the members route for a nick in a Channel, once however often Tab is pressed, then cycles", () => {
    const asking = play("al", [tab, tab]);
    const wanted = nicksWanted(asking.state);

    const answered = play(
      "al",
      [
        tab,
        { _tag: "NicksRead", nicks: ["al", "alice", "alex"], place: iirc, request: 1, text: "al" },
      ],
      { ...sources, recent: ["bob", "alex"], self: "al" }
    );

    expect({
      announced: announced(answered.state, iirc, answered.text, sources),
      asked: wanted,
      asking: shown(asking),
      cycled: listed(answered),
      first: shown(answered),
      requests: asking.state.requests,
    }).toStrictEqual({
      // The list names the one highlighted as it moves, so nothing more is said.
      announced: "",
      asked: { prefix: "al", request: 1, timeline: iirc },
      asking: ["al", 2],
      cycled: { highlighted: 0, names: ["alex", "alice", "al"] },
      first: ["alex: ", 6],
      requests: 1,
    });
  });

  it("puts `: ` after a nick only at the start of a line, and a space elsewhere", () => {
    const listed: Sources = { ...sources, nicks: { _tag: "Listed", nicks: ["peer"] } };

    expect({
      line: shown(play("one\npe", [tab], listed)),
      middle: shown(play("thanks pe", [tab], listed)),
      start: shown(play("pe", [tab], listed)),
    }).toStrictEqual({
      line: ["one\npeer: ", 10],
      middle: ["thanks peer ", 12],
      start: ["peer: ", 6],
    });
  });

  it("puts the Owner's suffix after a nick at the start of a line, nothing for none, and a space elsewhere", () => {
    const listed: Sources = {
      ...sources,
      nicks: { _tag: "Listed", nicks: ["peer"] },
      suffix: ", ",
    };

    const none: Sources = { ...listed, suffix: "" };
    const members: Sources = { ...sources, suffix: " -> " };
    const read = { _tag: "NicksRead", nicks: ["peer"], request: 1 } as const;

    expect({
      asked: shown(play("pe", [tab, { ...read, place: iirc, text: "pe" }], members)),
      askedMiddle: shown(play("hi pe", [tab, { ...read, place: iirc, text: "hi pe" }], members)),
      cycled: shown(play("pe", [tab, tab], listed)),
      line: shown(play("one\npe", [tab], listed)),
      middle: shown(play("thanks pe", [tab], listed)),
      none: shown(play("pe", [tab], none)),
      start: shown(play("pe", [tab], listed)),
    }).toStrictEqual({
      asked: ["peer -> ", 8],
      askedMiddle: ["hi peer ", 8],
      cycled: ["peer, ", 6],
      line: ["one\npeer, ", 10],
      middle: ["thanks peer ", 12],
      none: ["peer", 4],
      start: ["peer, ", 6],
    });
  });

  it("ignores an answer for a request let go of, and says when nothing completes the word", () => {
    const letGo = play("al", [
      tab,
      { _tag: "LetGo" },
      { _tag: "NicksRead", nicks: ["alice"], place: iirc, request: 1, text: "al" },
    ]);

    const failed = play("al", [tab, { _tag: "NicksFailed", request: 1 }]);

    const none = play("al", [
      tab,
      { _tag: "NicksRead", nicks: [], place: iirc, request: 1, text: "al" },
    ]);

    const superseded = play("al", [
      tab,
      { _tag: "LetGo" },
      tab,
      { _tag: "NicksRead", nicks: ["old"], place: iirc, request: 1, text: "al" },
    ]);

    expect({
      failed: announced(failed.state, iirc, failed.text, sources),
      letGo: [shown(letGo), letGo.state.phase._tag],
      none: announced(none.state, iirc, none.text, sources),
      superseded: [shown(superseded), superseded.state.phase._tag, nicksWanted(superseded.state)],
    }).toStrictEqual({
      failed: "Nothing completes al",
      letGo: [["al", 2], "Idle"],
      none: "Nothing completes al",
      superseded: [["al", 2], "Asking", { prefix: "al", request: 2, timeline: iirc }],
    });
  });

  it("puts in nothing when the answer comes for a draft no longer shown", () => {
    const answer = (place: typeof iirc, text: string) =>
      play("al", [tab, { _tag: "NicksRead", nicks: ["alice"], place, request: 1, text }]);

    const recalled = answer(iirc, "said before");
    const elsewhere = answer(peer, "al");
    const same = answer(iirc, "al");

    expect({
      elsewhere: [shown(elsewhere), elsewhere.state.phase._tag],
      recalled: [shown(recalled), recalled.state.phase._tag],
      same: shown(same),
    }).toStrictEqual({
      elsewhere: [["al", 2], "Idle"],
      recalled: [["al", 2], "Idle"],
      same: ["alice: ", 7],
    });
  });

  it("tells a Channel's name from a nick by the Network's CHANTYPES, RFC 2811's while unknown", () => {
    const listed: Sources = {
      ...sources,
      channels: ["[old", "#iirc", "&local"],
      nicks: { _tag: "Listed", nicks: ["[bob]", "&amp"] },
    };

    const hashOnly: Sources = { ...listed, chantypes: "#" };

    expect({
      ampersand: shown(play("&l", [tab], listed)),
      ampersandNick: shown(play("&a", [tab], hashOnly)),
      // `[old` was a Channel under CHANTYPES the Network no longer declares.
      bracket: shown(play("[b", [tab], hashOnly)),
      hash: shown(play("#i", [tab], hashOnly)),
    }).toStrictEqual({
      ampersand: ["&local ", 7],
      ampersandNick: ["&amp: ", 6],
      bracket: ["[bob]: ", 7],
      hash: ["#iirc ", 6],
    });
  });

  it("completes the nick after /whois and /whowas, asked of the members, with a space", () => {
    const asked = play("/whois pe", [tab]);

    const answered = play("/whois pe", [
      tab,
      { _tag: "NicksRead", nicks: ["peer"], place: iirc, request: 1, text: "/whois pe" },
    ]);

    expect({
      answered: shown(answered),
      asked: nicksWanted(asked.state),
      direct: shown(play("/whowas pe", [tab], peers)),
    }).toStrictEqual({
      answered: ["/whois peer ", 12],
      asked: { prefix: "pe", request: 1, timeline: iirc },
      direct: ["/whowas peer ", 13],
    });
  });

  it("gives back what was typed on Escape, caret and all", () => {
    const middle = { ...play("x", []), caret: 6, text: "hi /m there" };

    const step = reduceCompletion(
      initialCompletion,
      { _tag: "Tabbed", backwards: false, caret: 2, place: iirc, text: "#i and" },
      sources
    );

    const restored = reduceCompletion(step.state, { _tag: "Escaped", place: iirc }, sources);

    expect({
      after: [restored.edit, restored.state.phase._tag, restored.state.caret],
      notCompleting: reduceCompletion(middle.state, { _tag: "Escaped", place: iirc }, sources).edit,
      shown: step.edit,
    }).toStrictEqual({
      after: [{ caret: 2, place: iirc, text: "#i and" }, "Idle", 2],
      notCompleting: undefined,
      shown: { caret: 5, place: iirc, text: "#iirc and" },
    });
  });

  it("starts afresh when the Owner moved the caret or changed the text since", () => {
    const first = play("/m", [tab]);

    const moved = reduceCompletion(
      first.state,
      { _tag: "Tabbed", backwards: false, caret: 1, place: iirc, text: first.text },
      sources
    );

    expect({
      active: owns(first.state, iirc, first.text, sources),
      elsewhere: owns(first.state, peer, first.text, sources),
      moved: moved.edit?.text,
      typed: announced(first.state, iirc, `${first.text}x`, sources),
    }).toStrictEqual({ active: true, elsewhere: false, moved: "/me me ", typed: "" });
  });

  it("gives back exactly what was typed after any number of Tabs, for any text and caret", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom("p", "e", "/", "#", " ", "\n", "m", "i", "[") }),
        fc.nat(),
        fc.array(fc.boolean(), { maxLength: 8 }),
        (text, at, presses) => {
          const caret = at % (text.length + 1);
          let state = initialCompletion;
          let now = { caret, text };

          for (const backwards of presses) {
            const step = reduceCompletion(
              state,
              { _tag: "Tabbed", backwards, caret: now.caret, place: iirc, text: now.text },
              peers
            );

            ({ state } = step);
            now = step.edit ?? now;
          }

          const escaped = reduceCompletion(state, { _tag: "Escaped", place: iirc }, peers);
          const back = escaped.edit ?? now;

          expect({
            caret: back.caret,
            cloned: structuredClone(state),
            text: back.text,
          }).toStrictEqual({
            caret,
            cloned: state,
            text,
          });
        }
      )
    );
  });
});

describe("the list", () => {
  it("opens as a draft starts with /, listing each command once by name, and narrows with each key typed", () => {
    const all = play("", [type("/")]);
    const narrowed = play("", [type("/"), type("/m"), type("/me")]);
    const me = commands.find((one) => one.name === "me");

    expect({
      // An alias finds its command, listed by its name.
      alias: listOf(play("", [type("/act")]).state, iirc, "/act", sources)?.candidates[0],
      all: listed(all),
      allText: shown(all),
      described: listOf(narrowed.state, iirc, narrowed.text, sources)?.candidates[0],
      m: listed(play("", [type("/"), type("/m")])),
      narrowed: listed(narrowed),
      optional: listOf(play("", [type("/membe")]).state, iirc, "/membe", sources)?.candidates[0],
    }).toStrictEqual({
      alias: {
        _tag: "Command",
        chords: [],
        description: me?.description,
        name: "/me",
        takes: "<text>",
        text: "/me",
      },
      all: { highlighted: undefined, names: ["/me", "/members", "/msg", "/set"] },
      allText: ["/", 1],
      described: {
        _tag: "Command",
        chords: [],
        description: me?.description,
        name: "/me",
        takes: "<text>",
        text: "/me",
      },
      m: { highlighted: undefined, names: ["/me", "/msg", "/members"] },
      // `/msg` says it sends a Message, a word its description begins with `me`.
      narrowed: { highlighted: undefined, names: ["/me", "/members", "/msg"] },
      optional: {
        _tag: "Command",
        chords: [],
        description: commands.find((one) => one.name === "members")?.description,
        name: "/members",
        takes: "[on|off]",
        text: "/members",
      },
    });
  });

  it("lists what a command takes where completion knows it: an option after /set, a Channel after /join or /part", () => {
    expect({
      join: listed(play("", [type("/join ")])),
      joinNarrowed: listed(play("", [type("/JOIN #I")])),
      leave: listed(play("", [type("/leave &")])),
      part: listed(play("", [type("/part ")])),
      secondArgument: listed(play("", [type("/set network.libera.nicks x")])),
      set: listed(play("", [type("/set ")])),
      setNarrowed: listed(play("", [type("/set network.libera.r")])),
      // What completion asks the Daemon for opens only on Tab.
      whois: listed(play("", [type("/whois pe")])),
    }).toStrictEqual({
      join: { highlighted: undefined, names: ["#iirc", "#other", "&local"] },
      joinNarrowed: { highlighted: undefined, names: ["#iirc"] },
      leave: { highlighted: undefined, names: ["&local"] },
      part: { highlighted: undefined, names: ["#iirc", "#other", "&local"] },
      secondArgument: undefined,
      set: { highlighted: undefined, names: ["network.libera.nicks", "network.libera.realname"] },
      setNarrowed: { highlighted: undefined, names: ["network.libera.realname"] },
      whois: undefined,
    });
  });

  it("stays shut for a draft that is no command, one past its first line, or one nothing completes", () => {
    const asking = play("al", [tab]);

    const typedOver = reduceCompletion(
      asking.state,
      { _tag: "Typed", caret: 3, place: iirc, text: "alx" },
      sources
    );

    expect({
      doubled: listed(play("", [type("//m")])),
      letGoOfAsking: [typedOver.state.phase._tag, nicksWanted(typedOver.state)],
      midLine: listed(play("", [type("say /m")])),
      nothing: listed(play("", [type("/zz")])),
      secondLine: listed(play("", [type("hi\n/m")])),
      text: listed(play("", [type("hello")])),
    }).toStrictEqual({
      doubled: undefined,
      letGoOfAsking: ["Idle", undefined],
      midLine: undefined,
      nothing: undefined,
      secondLine: undefined,
      text: undefined,
    });
  });

  it("moves with Tab and Shift+Tab, writing the one highlighted into the draft, and Escape gives back what was typed", () => {
    const forth = play("", [type("/m"), tab]);
    const twice = play("", [type("/m"), tab, tab]);
    const backFirst = play("", [type("/m"), back]);
    const wrapped = play("", [type("/m"), tab, back]);
    const escaped = play("", [type("/m"), tab, tab, { _tag: "Escaped", place: iirc }]);
    const closed = play("", [type("/m"), { _tag: "Escaped", place: iirc }]);

    expect({
      backFirst: [shown(backFirst), listed(backFirst)?.highlighted],
      closed: [shown(closed), listed(closed)],
      escaped: [shown(escaped), listed(escaped)],
      forth: [shown(forth), listed(forth)],
      twice: [shown(twice), listed(twice)?.highlighted],
      wrapped: [shown(wrapped), listed(wrapped)?.highlighted],
    }).toStrictEqual({
      backFirst: [["/members ", 9], 2],
      closed: [["/m", 2], undefined],
      escaped: [["/m", 2], undefined],
      forth: [["/me ", 4], { highlighted: 0, names: ["/me", "/msg", "/members"] }],
      twice: [["/msg ", 5], 1],
      wrapped: [["/members ", 9], 2],
    });
  });

  it("writes a candidate picked from the list into the draft, highlighted", () => {
    const picked = play("", [type("/m"), { _tag: "Pick", index: 1 }]);
    const open = play("", [type("/m")]);

    const stale = reduceCompletion(
      open.state,
      { _tag: "Picked", index: 1, place: iirc, text: "/mx" },
      sources
    );

    expect({
      picked: [shown(picked), listed(picked)?.highlighted],
      // Picked from a list for a draft no longer shown, it is let go of.
      stale: [stale.edit, stale.state.phase._tag],
    }).toStrictEqual({ picked: [["/msg ", 5], 1], stale: [undefined, "Idle"] });
  });

  it("belongs to the place it was opened in, and to the draft it lists for", () => {
    const open = play("", [type("/m")]);

    expect({
      elsewhere: listOf(open.state, peer, open.text, sources),
      here: listOf(open.state, iirc, open.text, sources)?.candidates.length,
      otherText: listOf(open.state, iirc, "/me", sources),
    }).toStrictEqual({ elsewhere: undefined, here: 3, otherText: undefined });
  });

  it("says how many it lists as it opens, and nothing more while one is highlighted", () => {
    const one = play("", [type("/se")]);
    const three = play("", [type("/m")]);
    const moved = play("", [type("/m"), tab]);

    expect([
      announced(one.state, iirc, one.text, sources),
      announced(three.state, iirc, three.text, sources),
      announced(moved.state, iirc, moved.text, sources),
    ]).toStrictEqual(["1 completion", "3 completions", ""]);
  });
});

describe("the list and the caret", () => {
  it("lets go when the caret leaves where completion left it, so nothing listed owns a key", () => {
    const moved = play("", [type("/se"), { _tag: "Move", start: 1 }]);
    const selected = play("", [type("/se"), { _tag: "Move", end: 3, start: 1 }]);
    const stayed = play("", [type("/se"), { _tag: "Move", start: 3 }]);
    const highlighted = play("", [type("/se"), tab, { _tag: "Move", start: 0 }]);
    const asking = play("al", [tab, { _tag: "Move", start: 0 }]);

    expect({
      asking: [owns(asking.state, iirc, asking.text, sources), nicksWanted(asking.state)],
      highlighted: [listed(highlighted), shown(highlighted)],
      moved: [listed(moved), owns(moved.state, iirc, moved.text, sources)],
      selected: listed(selected),
      stayed: [listed(stayed), owns(stayed.state, iirc, stayed.text, sources)],
    }).toStrictEqual({
      asking: [false, undefined],
      highlighted: [undefined, ["/set ", 0]],
      moved: [undefined, false],
      selected: undefined,
      stayed: [{ highlighted: undefined, names: ["/set"] }, true],
    });
  });

  it("owns the keys exactly while a list is shown, or a nick is being asked for", () => {
    const empty: Sources = { ...sources, channels: [] };
    const parted = play("", [type("/part ")]);
    const asking = play("al", [tab]);

    expect({
      asking: [owns(asking.state, iirc, asking.text, sources), listed(asking)],
      // Every Channel gone: nothing is shown, so nothing is owned.
      emptied: [
        listOf(parted.state, iirc, parted.text, empty),
        owns(parted.state, iirc, parted.text, empty),
      ],
      open: [listed(parted) !== undefined, owns(parted.state, iirc, parted.text, sources)],
    }).toStrictEqual({
      asking: [true, undefined],
      emptied: [undefined, false],
      open: [true, true],
    });
  });
});

describe("the list as it follows typing", () => {
  it("follows the sources while nothing is highlighted, and holds its order once something is", () => {
    const parted: Sources = { ...sources, channels: ["#iirc", "&local"] };
    const open = play("", [type("/part ")]);
    const moving = play("", [type("/part "), tab]);

    expect({
      following: listed(open, parted),
      held: listed(moving, parted),
      picked: shown(play("", [type("/part "), { _tag: "Pick", index: 1 }], parted)),
    }).toStrictEqual({
      following: { highlighted: undefined, names: ["#iirc", "&local"] },
      held: { highlighted: 0, names: ["#iirc", "#other", "&local"] },
      picked: ["/part &local ", 13],
    });
  });
});

describe("ordering nicks", () => {
  it("puts those who spoke latest first, then the route's order, and Self last", () => {
    expect(
      orderNicks(["Ann", "bob", "Carl", "me", "dee"], {
        ...sources,
        recent: ["DEE", "carl", "dee"],
        self: "ME",
      })
    ).toStrictEqual(["dee", "Carl", "Ann", "bob", "me"]);
  });
});

const said = (sequence: number, sender: string, ours = false): typeof TimelineItem.Encoded => ({
  answered: null,
  changed: sequence,
  content: {
    _tag: "Message",
    answers: null,
    at: { _tag: "Unknown" },
    context: null,
    id: { _tag: "Unknown" },
    kind: "Privmsg",
    live: true,
    ours: ours ? { delivery: { _tag: "Unconfirmed" }, intent: "web-1" } : null,
    sender,
    tags: [],
    target: "#iirc",
    text: "hi",
  },
  level: "Message",
  network: "libera",
  position: cursor(sequence * 1000, sequence),
  sequence,
  timeline: idOf(2),
});

/** What completion lists from beyond the Timelines, as a Frontend would hold it. */
const held: Held = {
  chantypes: new Map(),
  chosen: sources.chosen,
  font: sources.font,
  keymap: [],
  options: [],
  ran: [],
  suffix: ": ",
  themes: sources.themes,
};

describe("the sources", () => {
  const nothing = { activity: 0, direct: 0, highlights: 0, messages: 0 };

  const described = (
    id: string,
    name: string,
    kind: "Network" | "Channel" | "Direct"
  ): typeof Timeline.Encoded => ({
    changed: 1,
    closed: false,
    detached: false,
    head: null,
    id,
    key: kind === "Network" ? null : name,
    kind,
    latest: null,
    life: 1,
    name,
    network: "libera",
    read: null,
    removed: false,
    unread: nothing,
  });

  const world = () => {
    const read = {
      _tag: "Latest",
      attempt: 0,
      generation: 0,
      limit: 1000,
      timeline: iirc,
    } as const;

    const list = { _tag: "List", after: undefined, attempt: 0, network } as const;
    const status = { _tag: "Status", attempt: 0, network } as const;

    const events: TimelinesEvent[] = [
      { _tag: "ReadStarted", read: { _tag: "Networks", attempt: 0 } },
      {
        _tag: "NetworksRead",
        entries: [
          Schema.decodeSync(NetworkEntry)({
            _tag: "Live",
            life: 1,
            network: "libera",
            status: { _tag: "Running" },
          }),
        ],
      },
      { _tag: "ReadStarted", read: list },
      {
        _tag: "ListRead",
        after: undefined,
        network,
        page: Schema.decodeSync(TimelineList)({
          more: false,
          projection: { _tag: "Running" },
          through: 10,
          timelines: [
            described(idOf(1), "libera", "Network"),
            described(idOf(2), "#iirc", "Channel"),
            described(idOf(3), "&local", "Channel"),
            described(idOf(4), "peer", "Direct"),
          ],
          version: 1,
        }),
      },
      { _tag: "ReadStarted", read: status },
      { _tag: "Requesting", read: status },
      {
        _tag: "StatusRead",
        life: 1,
        network,
        partners: [],
        self: null,
        session: Schema.decodeSync(SessionKnowledge)({
          _tag: "Registered",
          ircd: "x",
          since: 1,
          tags: false,
        }),
      },
      { _tag: "Opened", timeline: iirc },
      { _tag: "ReadStarted", read },
      {
        _tag: "WindowRead",
        read,
        window: Schema.decodeSync(TimelineWindow)({
          earlier: false,
          gaps: [],
          items: [said(5, "ann"), said(6, "iirc", true), said(7, "bob"), said(8, "ann")],
          later: false,
          network: "libera",
          through: 10,
          timeline: idOf(2),
          version: 1,
        }),
      },
    ];

    let state = initialTimelines;

    for (const event of events) {
      state = reduceTimelines(state, event);
    }

    return state;
  };

  it("are the Network's Channels, the open Channel's members, and who spoke there, latest first", () => {
    const state = world();
    const channel = sourcesOf(state, iirc, held);
    const direct = sourcesOf(state, peer, held);
    const nowhere = sourcesOf(state, "Nowhere", held);

    expect({
      channels: channel.channels,
      commands: channel.commands === commands,
      directNicks: direct.nicks,
      nicks: channel.nicks,
      nowhere: [nowhere.channels, nowhere.nicks],
      options: channel.options.some((one) => one.name === "network.libera.login.account"),
      recent: channel.recent,
      suffix: [channel.suffix, sourcesOf(state, iirc, { ...held, suffix: ", " }).suffix],
    }).toStrictEqual({
      channels: ["#iirc", "&local"],
      commands: true,
      directNicks: { _tag: "Listed", nicks: ["peer"] },
      nicks: { _tag: "Members", timeline: iirc },
      nowhere: [[], { _tag: "Listed", nicks: [] }],
      options: true,
      recent: ["ann", "bob", "ann"],
      suffix: [": ", ", "],
    });
  });

  it("take a Network's CHANTYPES only as read during the Session it is in now", () => {
    const state = world();
    const during = new Map([[network, { chantypes: "#", since: 1 }]]);
    const before = new Map([[network, { chantypes: "#", since: 0 }]]);

    expect({
      before: sourcesOf(state, iirc, { ...held, chantypes: before }).chantypes,
      during: sourcesOf(state, iirc, { ...held, chantypes: during }).chantypes,
      none: sourcesOf(state, iirc, held).chantypes,
      wantedBefore: chantypesWanted(state, iirc, before),
      wantedDuring: chantypesWanted(state, iirc, during),
      wantedNowhere: chantypesWanted(state, "Nowhere", new Map()),
    }).toStrictEqual({
      before: undefined,
      during: "#",
      none: undefined,
      wantedBefore: { network, since: 1 },
      wantedDuring: undefined,
      wantedNowhere: undefined,
    });
  });
});

/**
 * A Network as the sidebar lists it.
 * @param on - The Network.
 * @param removed - Whether it was removed with its Timelines kept.
 * @param timelines - Its Timelines listed.
 * @param closed - Its Timelines closed.
 * @returns It.
 */
const networkOf = (
  on: NetworkId,
  removed: boolean,
  timelines: readonly Timeline[],
  closed: readonly Timeline[]
): SidebarNetwork => ({
  away: { _tag: "Unknown" },
  closed,
  connection: { _tag: "Unknown" },
  listed: true,
  network: on,
  removed,
  running: undefined,
  timelines,
});

describe("everything the palette lists", () => {
  const oftc = Schema.decodeSync(NetworkId)("oftc");
  const decodeTimeline = Schema.decodeSync(Timeline);

  const timelineOf = (
    sequence: number,
    on: NetworkId,
    kind: "Network" | "Channel" | "Direct",
    name: string
  ) =>
    decodeTimeline({
      changed: 1,
      closed: false,
      detached: false,
      head: null,
      id: idOf(sequence),
      key: kind === "Network" ? null : name,
      kind,
      latest: null,
      life: 1,
      name,
      network: on,
      read: null,
      removed: false,
      unread: { activity: 0, direct: 0, highlights: 0, messages: 0 },
    });

  const bar: readonly SidebarNetwork[] = [
    networkOf(
      network,
      false,
      [
        timelineOf(1, network, "Network", "libera"),
        timelineOf(2, network, "Channel", "#iirc"),
        timelineOf(4, network, "Direct", "peer"),
      ],
      [timelineOf(5, network, "Channel", "#closed")]
    ),
    networkOf(
      oftc,
      true,
      [
        timelineOf(11, oftc, "Network", "oftc"),
        timelineOf(12, oftc, "Channel", "#iirc"),
        timelineOf(13, oftc, "Channel", "#debian"),
      ],
      []
    ),
  ];

  /** Sources on libera's #iirc, with every command, Timeline, and Network. */
  const everywhere: Sources = {
    ...sources,
    commands,
    keymap: defaultKeymap,
    networks: bar.map((one) => ({ network: one.network, removed: one.removed })),
    timelines: namedIn(bar),
  };

  /** The same, from a composer on no Network. */
  const nowhere: Sources = { ...everywhere, network: undefined };

  const context: CommandContext = {
    behind: false,
    draft: undefined,
    focus: {
      detached: false,
      key: "#iirc",
      kind: "Channel",
      name: "#iirc",
      network,
      removed: false,
      timeline: iirc,
    },
    head: undefined,
    named: namedIn(bar),
    open: iirc,
    panes: 1,
    session: true,
    shown: [iirc],
    timelines: [],
    unread: [],
    unreadClosed: [],
  };

  const away: CommandContext = { ...context, focus: undefined, open: undefined, session: false };

  const listing: Listing = {
    chosen: sources.chosen,
    context,
    font: sources.font,
    keymap: defaultKeymap,
    options: [],
    sidebar: bar,
    themes: sources.themes,
  };

  /**
   * The list a draft opens as it is typed.
   * @param text - The draft.
   * @param given - The sources.
   * @returns Its candidates.
   */
  const opened = (text: string, given: Sources = everywhere) =>
    listOf(play("", [type(text)], given).state, iirc, text, given)?.candidates ?? [];

  /**
   * What a draft says once the candidate at an index is picked from its list.
   * @param text - The draft.
   * @param index - The candidate.
   * @param given - The sources.
   * @returns The draft after.
   */
  const pickedIn = (text: string, index: number, given: Sources = everywhere) =>
    play("", [type(text), { _tag: "Pick", index }], given).text;

  /**
   * A section of what the palette lists for a query.
   * @param query - The query.
   * @param title - The section's title.
   * @returns Its entries.
   */
  const sectionOf = (query: string, title: string) =>
    sections(listing, query, []).find((one) => one.title === title)?.entries ?? [];

  /**
   * Opens `/network remove `, highlights its first candidate, and picks one.
   * @param index - The candidate picked.
   * @returns Each step, and the pick.
   */
  const steps = (index: number) => {
    const typed = reduceCompletion(
      initialCompletion,
      { _tag: "Typed", caret: 15, place: iirc, text: "/network remove" },
      everywhere
    );

    const opening = reduceCompletion(
      typed.state,
      { _tag: "Typed", caret: 16, place: iirc, text: "/network remove " },
      everywhere
    );

    const highlighted = reduceCompletion(
      opening.state,
      { _tag: "Tabbed", backwards: false, caret: 16, place: iirc, text: "/network remove " },
      everywhere
    );

    const picked = reduceCompletion(
      highlighted.state,
      { _tag: "Picked", index, place: iirc, text: highlighted.edit?.text ?? "" },
      everywhere
    );

    return { picked, steps: [typed, opening, highlighted, picked] };
  };

  /**
   * What sending a Network picked from `/network remove`'s list asks for, beside what the
   * palette's entry for it asks for, and what each step of completion gave.
   * @param index - The Network's index in the list.
   * @returns The steps' fields, and both asks.
   */
  const sent = (index: number) => {
    const { picked, steps: all } = steps(index);
    const network_ = everywhere.networks[index];

    return {
      // Listing, highlighting, and picking only put text in the draft.
      fields: all.map((one) => Object.keys(one).toSorted()),
      palette: network_ === undefined ? undefined : choose(networkEntry(network_), context, false),
      sent: interpret(picked.edit?.text ?? "", context),
    };
  };

  it("lists every Timeline on every Network after /go, open then closed, each with its Network and kind", () => {
    expect(
      opened("/go ").map((one) =>
        one._tag === "Timeline" ? [one.name, one.network, one.kind] : one._tag
      )
    ).toStrictEqual([
      ["libera", "libera", "Network"],
      ["#iirc", "libera", "Channel"],
      ["peer", "libera", "Direct"],
      ["#closed", "libera", "Channel"],
      ["oftc", "oftc", "Network"],
      ["#iirc", "oftc", "Channel"],
      ["#debian", "oftc", "Channel"],
    ]);
  });

  it("writes for /go the name alone where it finds that Timeline from where the composer is, else its Network too", () => {
    expect({
      here: pickedIn("/go #ii", 0),
      nowhere: opened("/go ", nowhere).map((one) => one.text),
      there: opened("/go ").map((one) => one.text),
    }).toStrictEqual({
      here: "/go #iirc",
      nowhere: ["libera", "libera #iirc", "peer", "#closed", "oftc", "oftc #iirc", "#debian"],
      there: ["libera", "#iirc", "peer", "#closed", "oftc", "oftc #iirc", "#debian"],
    });
  });

  it("sends from each /go candidate exactly the Timeline it lists, from a Timeline or from nowhere", () => {
    const timelines = namedIn(bar).map((one) => [{ _tag: "Open", timeline: one.timeline }]);

    const sent = (given: Sources, at: CommandContext) =>
      timelines.map((_, index) => {
        const read = interpret(pickedIn("/go ", index, given), at);

        return read._tag === "Parsed" ? read.value : read.message;
      });

    expect({ here: sent(everywhere, context), nowhere: sent(nowhere, away) }).toStrictEqual({
      here: timelines,
      nowhere: timelines,
    });
  });

  it("lists no /go candidate it cannot reach, as the second of two that share a name on one Network", () => {
    const shared: Sources = {
      ...everywhere,
      timelines: namedIn([
        networkOf(
          network,
          false,
          [
            timelineOf(1, network, "Network", "libera"),
            timelineOf(2, network, "Channel", "#a[b"),
            timelineOf(3, network, "Channel", "#a{b"),
          ],
          []
        ),
      ]),
    };

    expect(opened("/go #a", shared).map((one) => one.text)).toStrictEqual(["#a[b"]);
  });

  it("lists no theme after /theme import or /theme remove, which name no theme to draw", () => {
    // An imported theme's description says "imported theme", which `import` would match.
    const imported: Sources = {
      ...everywhere,
      themes: [
        ...everywhere.themes,
        { builtIn: false, name: Schema.decodeSync(ThemeName)("mine") },
      ],
    };

    expect({
      import: opened("/theme import", imported),
      remove: opened("/theme remove imp", imported),
      theme: opened("/theme imp", imported).map((one) => one.name),
    }).toStrictEqual({ import: [], remove: [], theme: ["mine"] });
  });

  it("takes the whole rest of the line as the query, spaces collapsed, and a candidate replaces all of it", () => {
    expect({
      named: opened("/go oftc   #i").map((one) => one.text),
      written: pickedIn("/go oftc  #deb", 0),
    }).toStrictEqual({
      // `#debian` holds an `i`, in order after `oftc #`.
      named: ["oftc #iirc", "#debian"],
      written: "/go #debian",
    });
  });

  it("ranks as the palette ranks, so nothing the palette finds is harder to find here", () => {
    const commandIds = new Map(commands.map((one) => [`/${one.name}`, one.id]));

    fc.assert(
      fc.property(
        fc.string({
          minLength: 1,
          unit: fc.constantFrom("a", "e", "i", "m", "o", "s", "#", "-", "l", "r"),
        }),
        (query) => {
          const palette = {
            commands: sectionOf(query, "Commands").map((one) => one.key),
            networks: sectionOf(query, "Networks").flatMap((one) =>
              one._tag === "Network" ? [one.network] : []
            ),
            themes: sectionOf(query, "Themes").map((one) => one.name),
            timelines: sectionOf(query, "Timelines").flatMap((one) =>
              one._tag === "Timeline" ? [one.timeline] : []
            ),
          };

          const listedHere = new Set(palette.commands);
          const ids = namedIn(bar);

          const here = {
            commands: opened(`/${query}`)
              .map((one) => `command:${commandIds.get(one.name) ?? ""}`)
              .filter((key) => listedHere.has(key)),
            networks: opened(`/network remove ${query}`).map((one) => one.name),
            themes: opened(`/theme ${query}`).map((one) => one.name),
            timelines: opened(`/go ${query}`).map(
              (one) =>
                ids.find(
                  (named) =>
                    one._tag === "Timeline" &&
                    named.network === one.network &&
                    named.name === one.name &&
                    named.kind === one.kind
                )?.timeline
            ),
          };

          expect(here).toStrictEqual(palette);
        }
      )
    );
  });

  it("shows the keys bound to a command beside it", () => {
    const next = opened("/next").find((one) => one.name === "/next");

    expect(next?._tag === "Command" ? next.chords : undefined).toStrictEqual(
      chordsFor(defaultKeymap, "timeline.next")
    );
    expect(chordsFor(defaultKeymap, "timeline.next")).not.toHaveLength(0);
  });

  it("lists after a bare / what was run recently first, newest first, then the rest by name", () => {
    const ran: Sources = {
      ...sources,
      ran: ["command:options.set", "timeline:x", "command:say.to", "command:no.such", "theme:dark"],
    };

    expect({
      bare: opened("/", ran).map((one) => one.name),
      query: opened("/m", ran).map((one) => one.name),
    }).toStrictEqual({
      bare: ["/set", "/msg", "/me", "/members"],
      query: ["/me", "/msg", "/members"],
    });
  });

  it("lists the themes after /theme, as the palette's themes, each built in or imported and whether it is in effect", () => {
    const themed: Sources = {
      ...everywhere,
      chosen: { dark: "nord", light: "solarized-light", theme: "dark" },
      themes: [
        ...listedThemes([]).slice(0, 3),
        { builtIn: false, name: Schema.decodeSync(ThemeName)("nord") },
      ],
    };

    const shown = (text: string) =>
      opened(text, themed).map((one) =>
        one._tag === "Theme" ? [one.name, one.builtIn, one.current] : one._tag
      );

    expect({
      dark: shown("/theme -dark "),
      deviceLight: shown("/theme -device -LIGHT  li"),
      theme: shown("/theme "),
    }).toStrictEqual({
      dark: [
        ["dark", true, false],
        ["light", true, false],
        ["nord", false, true],
      ],
      deviceLight: [["light", true, false]],
      theme: [
        ["system", true, false],
        ["dark", true, true],
        ["light", true, false],
        ["nord", false, false],
      ],
    });
  });

  it("writes a theme after any flags, which sends to set the option they say", () => {
    const text = pickedIn("/theme -light  ", 1);

    expect([text, interpret(text, context)]).toStrictEqual([
      "/theme -light  light",
      {
        _tag: "Parsed",
        value: [{ _tag: "UseTheme", device: false, name: "light", option: "light" }],
      },
    ]);
  });

  it("lists the fonts after /set ui.font, and a family typed by name, each with whether it is in effect", () => {
    const fonts = opened("/set ui.font ");
    const family = opened("/set -device ui.font Fira  Code");
    const text = pickedIn("/set -device ui.font Fira  Code", 0);

    expect({
      current: fonts.flatMap((one) => (one._tag === "Font" && one.current ? [one.name] : [])),
      family: family[0],
      fonts: fonts.map((one) => one.name),
      sent: interpret(text, context),
      text,
    }).toStrictEqual({
      current: [uiDefaults.font],
      family: { _tag: "Font", current: false, name: "Fira Code", text: "Fira Code" },
      fonts: [...fontNames],
      sent: {
        _tag: "Parsed",
        value: [{ _tag: "ChangeUi", device: true, option: "font", value: "Fira Code" }],
      },
      text: "/set -device ui.font Fira Code",
    });
  });

  it("draws a theme or a font only while it is highlighted, and the one in effect once the highlight moves on, the list closes, or the draft changes or is sent", () => {
    const following = play("", [type("/theme ")], everywhere);
    const first = play("", [type("/theme "), tab], everywhere);
    const second = play("", [type("/theme "), tab, tab], everywhere);
    const escaped = play("", [type("/theme "), tab, { _tag: "Escaped", place: iirc }], everywhere);
    const sent = play("", [type("/theme "), tab, { _tag: "LetGo" }], everywhere);
    const command = play("", [type("/the"), tab], everywhere);
    const font = play("", [type("/set ui.font "), tab, tab], everywhere);

    expect({
      command: previewOf(command.state, iirc, command.text),
      elsewhere: previewOf(first.state, peer, first.text),
      escaped: previewOf(escaped.state, iirc, escaped.text),
      first: previewOf(first.state, iirc, first.text),
      following: previewOf(following.state, iirc, following.text),
      font: previewOf(font.state, iirc, font.text),
      second: previewOf(second.state, iirc, second.text),
      sent: previewOf(sent.state, iirc, ""),
      typed: previewOf(first.state, iirc, `${first.text}x`),
    }).toStrictEqual({
      command: undefined,
      elsewhere: undefined,
      escaped: undefined,
      first: { _tag: "Theme", name: "system" },
      following: undefined,
      font: { _tag: "Font", font: fontNames[1] },
      second: { _tag: "Theme", name: "dark" },
      sent: undefined,
      typed: undefined,
    });
  });

  it("lists the Networks after /network remove, a removed one whose Timelines were kept too, and writes only the id", () => {
    expect({
      listed: opened("/network remove ").map((one) =>
        one._tag === "Network" ? [one.name, one.removed, one.text] : one._tag
      ),
      narrowed: opened("/network remove oft").map((one) => one.name),
    }).toStrictEqual({
      listed: [
        ["libera", false, "libera"],
        ["oftc", true, "oftc"],
      ],
      narrowed: ["oftc"],
    });
  });

  it("asks first, as the palette's entry does, only once /network remove <id> is sent, for a live Network and a removed one", () => {
    const live = sent(0);
    const removed = sent(1);

    expect({
      fields: [live.fields, removed.fields],
      live: live.sent,
      removed: removed.sent,
      samePalette: [live.palette, removed.palette],
    }).toStrictEqual({
      fields: [
        Array.from({ length: 4 }, () => ["edit", "state"]),
        Array.from({ length: 4 }, () => ["edit", "state"]),
      ],
      live: {
        _tag: "Parsed",
        value: [{ _tag: "AskRemoval", keep: undefined, network: "libera" }],
      },
      removed: {
        _tag: "Parsed",
        value: [{ _tag: "AskRemoval", keep: undefined, network: "oftc" }],
      },
      samePalette: [
        [{ _tag: "AskRemoval", keep: undefined, network: "libera" }],
        [{ _tag: "AskRemoval", keep: undefined, network: "oftc" }],
      ],
    });
  });
});
