import type { TimelineItem, Timeline } from "@iirc/api";
import {
  NetworkEntry,
  NetworkId,
  SessionKnowledge,
  TimelineId,
  TimelineList,
  TimelineWindow,
} from "@iirc/api";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { commands } from "./commands.ts";
import {
  active,
  announced,
  chantypesWanted,
  completes,
  initialCompletion,
  listOf,
  nicksWanted,
  orderNicks,
  reduceCompletion,
  sourcesOf,
  spotAt,
} from "./completion.ts";
import type { Completion, CompletionEvent, Shown, Sources } from "./completion.ts";
import { initialTimelines, reduceTimelines } from "./timelines.ts";
import type { TimelinesEvent } from "./timelines.ts";

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const cursor = (at: number, sequence: number) =>
  `${hex(BigInt(at) + 2n ** 53n, 14)}-${hex(BigInt(sequence), 14)}-${hex(0n, 8)}`;

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;

const timelineId = Schema.decodeSync(TimelineId);
const network = Schema.decodeSync(NetworkId)("libera");
const iirc = timelineId(idOf(2));
const peer = timelineId(idOf(4));

const sources: Sources = {
  channels: ["#iirc", "#other", "&local"],
  chantypes: undefined,
  commands: ["me", "members", "msg", "set", "action"],
  nicks: { _tag: "Members", timeline: iirc },
  options: ["network.libera.nicks", "network.libera.realname"],
  recent: [],
  self: undefined,
  suffix: ": ",
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
    | Exclude<CompletionEvent, { readonly _tag: "Tabbed" | "Typed" | "Picked" }>
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
        : { caret: run.caret, text: run.text };

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
 * @returns The names and the highlighted one's index, or none.
 */
const listed = (run: Run) => {
  const list = listOf(run.state, iirc, run.text);

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
  it("completes a command at the start of a line, cycling with Tab, backwards with Shift+Tab", () => {
    expect({
      back: shown(play("/m", [back])),
      first: shown(play("/m", [tab])),
      notAtStart: play("say /m", [tab]).state.phase._tag,
      second: shown(play("/m", [tab, tab])),
      wraps: shown(play("/m", [tab, tab, tab, tab])),
      wrapsBack: shown(play("/m", [tab, back])),
    }).toStrictEqual({
      back: ["/msg ", 5],
      first: ["/me ", 4],
      // A word starting with `/` mid-line is no command: none of the nicks start with it.
      notAtStart: "Asking",
      second: ["/members ", 9],
      wraps: ["/me ", 4],
      wrapsBack: ["/msg ", 5],
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
      announced: announced(answered.state, iirc, answered.text),
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
      failed: announced(failed.state, iirc, failed.text),
      letGo: [shown(letGo), letGo.state.phase._tag],
      none: announced(none.state, iirc, none.text),
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
      active: active(first.state, iirc, { caret: first.caret, text: first.text }),
      elsewhere: active(first.state, peer, { caret: first.caret, text: first.text }),
      moved: moved.edit?.text,
      typed: announced(first.state, iirc, `${first.text}x`),
    }).toStrictEqual({ active: true, elsewhere: false, moved: "/action me ", typed: "" });
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
  it("opens as a draft starts with /, listing the commands, and narrows with each key typed", () => {
    const all = play("", [type("/")]);
    const narrowed = play("", [type("/"), type("/m"), type("/me")]);
    const me = commands.find((one) => one.name === "me");

    expect({
      // An alias takes what its command does.
      alias: listOf(play("", [type("/act")]).state, iirc, "/act")?.candidates[0],
      all: listed(all),
      allText: shown(all),
      described: listOf(narrowed.state, iirc, narrowed.text)?.candidates[0],
      m: listed(play("", [type("/"), type("/m")])),
      narrowed: listed(narrowed),
      optional: listOf(play("", [type("/membe")]).state, iirc, "/membe")?.candidates[0],
    }).toStrictEqual({
      alias: {
        _tag: "Command",
        description: me?.description,
        name: "/action",
        takes: "<text>",
      },
      all: {
        highlighted: undefined,
        names: ["/action", "/me", "/members", "/msg", "/set"],
      },
      allText: ["/", 1],
      described: { _tag: "Command", description: me?.description, name: "/me", takes: "<text>" },
      m: { highlighted: undefined, names: ["/me", "/members", "/msg"] },
      narrowed: { highlighted: undefined, names: ["/me", "/members"] },
      optional: {
        _tag: "Command",
        description: commands.find((one) => one.name === "members")?.description,
        name: "/members",
        takes: "[on|off]",
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
      backFirst: [["/msg ", 5], 2],
      closed: [["/m", 2], undefined],
      escaped: [["/m", 2], undefined],
      forth: [["/me ", 4], { highlighted: 0, names: ["/me", "/members", "/msg"] }],
      twice: [["/members ", 9], 1],
      wrapped: [["/msg ", 5], 2],
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
    }).toStrictEqual({ picked: [["/members ", 9], 1], stale: [undefined, "Idle"] });
  });

  it("belongs to the place it was opened in, and to the draft it lists for", () => {
    const open = play("", [type("/m")]);

    expect({
      elsewhere: listOf(open.state, peer, open.text),
      here: listOf(open.state, iirc, open.text)?.candidates.length,
      otherText: listOf(open.state, iirc, "/me"),
    }).toStrictEqual({ elsewhere: undefined, here: 3, otherText: undefined });
  });

  it("says how many it lists as it opens, and nothing more while one is highlighted", () => {
    const one = play("", [type("/se")]);
    const three = play("", [type("/m")]);
    const moved = play("", [type("/m"), tab]);

    expect([
      announced(one.state, iirc, one.text),
      announced(three.state, iirc, three.text),
      announced(moved.state, iirc, moved.text),
    ]).toStrictEqual(["1 completion", "3 completions", ""]);
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
    const channel = sourcesOf(state, iirc, []);
    const direct = sourcesOf(state, peer, []);
    const nowhere = sourcesOf(state, "Nowhere", []);

    expect({
      channels: channel.channels,
      commands: channel.commands.includes("query") && channel.commands.includes("action"),
      directNicks: direct.nicks,
      nicks: channel.nicks,
      nowhere: [nowhere.channels, nowhere.nicks],
      options: channel.options.includes("network.libera.login.account"),
      recent: channel.recent,
      suffix: [channel.suffix, sourcesOf(state, iirc, [], new Map(), ", ").suffix],
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
      before: sourcesOf(state, iirc, [], before).chantypes,
      during: sourcesOf(state, iirc, [], during).chantypes,
      none: sourcesOf(state, iirc, []).chantypes,
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
