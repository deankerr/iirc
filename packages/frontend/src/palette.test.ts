import { NetworkId, Timeline, TimelineId } from "@iirc/api";
import { NetworkConfiguration } from "@iirc/client/configuration";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { CommandContext } from "./commands.ts";
import { draftOf, initialComposers, reduceComposers, started } from "./composer.ts";
import { defaultKeymap, formatChord } from "./keymap.ts";
import { optionsOf } from "./options.ts";
import { choose, initialPalette, recentCap, reducePalette, remember, sections } from "./palette.ts";
import type { Entry, Listing, PaletteEvent, Section } from "./palette.ts";
import type { SidebarNetwork } from "./timelines.ts";

const libera = Schema.decodeSync(NetworkId)("libera");
const timelineId = Schema.decodeSync(TimelineId);
const decodeTimeline = Schema.decodeSync(Timeline);
const own = timelineId("00000000000001-00000000-00000000");
const channel = timelineId("00000000000002-00000000-00000000");
const direct = timelineId("00000000000003-00000000-00000000");

const timelineOf = (id: string, kind: "Network" | "Channel" | "Direct", name: string) =>
  decodeTimeline({
    changed: 1,
    detached: false,
    id,
    key: kind === "Network" ? null : name,
    kind,
    latest: null,
    name,
    network: "libera",
  });

const sidebar: readonly SidebarNetwork[] = [
  {
    connection: { _tag: "Connected", nick: "dean", since: 1 },
    network: libera,
    reading: false,
    running: undefined,
    timelines: [
      timelineOf(own, "Network", "libera"),
      timelineOf(channel, "Channel", "#iirc"),
      timelineOf(direct, "Direct", "peer"),
    ],
  },
];

const configuration = Schema.decodeSync(NetworkConfiguration)({
  channels: [{ name: "#iirc" }],
  declined: [],
  enabled: true,
  fallbackEncoding: "windows-1252",
  ircds: [{ host: "irc.libera.chat", port: 6697, tls: true }],
  login: { _tag: "None" },
  nicks: ["dean"],
  password: "libera.password",
  realname: "Dean",
  username: "dean",
});

const inChannel: CommandContext = {
  focus: {
    detached: false,
    key: "#iirc",
    kind: "Channel",
    name: "#iirc",
    network: libera,
    timeline: channel,
  },
  open: channel,
  session: true,
  timelines: [own, channel, direct],
};

const nowhere: CommandContext = { ...inChannel, focus: undefined, open: undefined, session: false };

const listing = (context: CommandContext = inChannel): Listing => ({
  context,
  keymap: defaultKeymap,
  options: optionsOf(libera, configuration, new Set(["libera.password"])),
  sidebar,
});

const keys = (shown: readonly Section[]) =>
  shown.map((section) => [section.title, section.entries.map((entry) => entry.key)] as const);

const titles = (shown: readonly Section[]) => shown.map((section) => section.title);

const first = (shown: readonly Section[]) => shown[0]?.entries[0]?.key;

const entryOf = (shown: readonly Section[], key: string): Entry => {
  const found = shown.flatMap((section) => section.entries).find((entry) => entry.key === key);

  if (found === undefined) {
    throw new Error(`not listed: ${key}`);
  }

  return found;
};

const commandsOf = (shown: readonly Section[]) =>
  shown.find((section) => section.title === "Commands")?.entries.map((entry) => entry.key);

const inNetwork: CommandContext = {
  ...inChannel,
  focus: {
    detached: false,
    key: undefined,
    kind: "Network",
    name: "libera",
    network: libera,
    timeline: own,
  },
  open: own,
};

const folded = (events: readonly PaletteEvent[]) => {
  let state = initialPalette;

  for (const event of events) {
    state = reducePalette(state, event);
  }

  return state;
};

const rememberedAll = (chosen: readonly string[]) => {
  let recent: readonly string[] = [];

  for (const key of chosen) {
    recent = remember(recent, key);
  }

  return recent;
};

describe("the palette's entries", () => {
  it("lists the commands that can run here, every Timeline, and every option, but not itself", () => {
    const here = sections(listing(), "", []);
    const away = sections(listing(nowhere), "", []);

    expect({
      away: commandsOf(away),
      here: commandsOf(here),
      timelines: here.find((section) => section.title === "Timelines")?.entries.length,
      titles: titles(here),
    }).toStrictEqual({
      away: [
        "command:options.set",
        "command:options.unset",
        "command:network.add",
        "command:timeline.next",
        "command:timeline.previous",
        "command:composer.focus",
      ],
      here: [
        "command:say.privmsg",
        "command:say.action",
        "command:say.to",
        "command:say.notice",
        "command:channels.join",
        "command:channels.part",
        "command:options.set",
        "command:options.unset",
        "command:network.add",
        "command:timeline.next",
        "command:timeline.previous",
        "command:composer.focus",
      ],
      timelines: 3,
      titles: ["Commands", "Timelines", "Options"],
    });
  });

  it("shows the chords bound to a command beside it", () => {
    const next = entryOf(sections(listing(), "", []), "command:timeline.next");

    expect(next._tag === "Command" ? next.chords.map(formatChord) : []).toStrictEqual([
      "alt+arrowdown",
    ]);
  });

  it("ranks an exact prefix over a word's start over the characters in order", () => {
    const keysOf = (query: string) =>
      sections(listing(), query, []).flatMap((section) => section.entries.map((one) => one.key));

    expect({
      // An alias finds its command.
      alias: first(sections(listing(), "prev", [])),
      // `iirc` starts no name, but starts a word of `#iirc`.
      iirc: first(sections(listing(), "iirc", [])),
      // `nick` starts the last word of an option's name.
      nick: first(sections(listing(), "nick", [])),
      // Matching nothing, nothing is listed.
      none: sections(listing(), "zzzz", []),
      // `nxt` is only in `next` as characters in order.
      nxt: first(sections(listing(), "nxt", [])),
      // `p`: `part` and `previous` by length, then `msg`, whose alias `privmsg` it starts.
      p: keysOf("p").slice(0, 3),
      // A slash before a command's name is ignored.
      slash: first(sections(listing(), "/me", [])),
    }).toStrictEqual({
      alias: "command:timeline.previous",
      iirc: "timeline:00000000000002-00000000-00000000",
      nick: "option:network.libera.nicks",
      none: [],
      nxt: "command:timeline.next",
      p: ["command:channels.part", "command:timeline.previous", "command:say.to"],
      slash: "command:say.action",
    });
  });

  it("puts the section with the best match first", () => {
    expect({
      peer: titles(sections(listing(), "peer", [])),
      set: titles(sections(listing(), "set", []))[0],
    }).toStrictEqual({ peer: ["Timelines"], set: "Commands" });
  });

  it("lists recent choices first, newest first, when the query is empty, and nowhere else twice", () => {
    const recent = remember(remember([], `timeline:${direct}`), "command:timeline.next");
    const shown = sections(listing(), "", [...recent, "timeline:gone"]);

    expect(keys(shown)[0]).toStrictEqual([
      "Recent",
      ["command:timeline.next", `timeline:${direct}`],
    ]);
    expect(
      shown
        .flatMap((section) => section.entries)
        .filter((one) => one.key === "command:timeline.next")
    ).toHaveLength(1);
  });

  it("ignores recent choices once there is a query", () => {
    expect(titles(sections(listing(), "next", ["command:timeline.next"]))).toStrictEqual([
      "Commands",
    ]);
  });
});

const all = sections(listing(), "", []);

const pick = (key: string, context = inChannel) => choose(entryOf(all, key), context);

describe("choosing an entry", () => {
  it("runs a command that needs no arguments, and starts one that does in the composer", () => {
    expect({
      me: pick("command:say.action"),
      next: pick("command:timeline.next"),
      partHere: pick("command:channels.part"),
      // `/part` with none named needs a Channel open, so it starts in the composer instead.
      partNowhere: pick("command:channels.part", inNetwork),
      set: pick("command:options.set"),
    }).toStrictEqual({
      me: [{ _tag: "FocusComposer", text: "/me " }],
      next: [{ _tag: "Open", timeline: direct }],
      partHere: [
        {
          _tag: "Configure",
          edit: { _tag: "PartTimeline", key: "#iirc", name: "#iirc" },
          network: libera,
        },
      ],
      partNowhere: [{ _tag: "FocusComposer", text: "/part " }],
      set: [{ _tag: "OpenOptions", filter: "" }],
    });
  });

  it("opens a Timeline, starts /set for an option, and asks for a Credential in the prompt", () => {
    expect({
      credential: choose(entryOf(all, "option:network.libera.password"), inChannel),
      option: choose(entryOf(all, "option:network.libera.nicks"), inChannel),
      timeline: choose(entryOf(all, `timeline:${own}`), inChannel),
    }).toStrictEqual({
      credential: [{ _tag: "PromptCredential", network: libera, path: ["password"] }],
      option: [{ _tag: "FocusComposer", text: "/set network.libera.nicks " }],
      timeline: [{ _tag: "Open", timeline: own }],
    });
  });
});

describe("the palette's state", () => {
  it("opens empty, keeps what is typed, and remembers a choice as it closes", () => {
    const events: readonly PaletteEvent[] = [
      { _tag: "Opened" },
      { _tag: "Queried", query: "nxt" },
      { _tag: "Chosen", key: "command:timeline.next" },
      { _tag: "Opened" },
    ];

    expect(folded(events)).toStrictEqual({
      open: true,
      query: "",
      recent: ["command:timeline.next"],
    });
  });

  it("remembers at most the cap, newest first, each once, for any choices", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...Array.from({ length: 30 }, (_, index) => `k${index}`))),
        (chosen) => {
          const recent = rememberedAll(chosen);
          const distinct = [...new Set(chosen.toReversed())];

          expect(recent).toStrictEqual(distinct.slice(0, recentCap));
        }
      )
    );
  });

  it("is plain data", () => {
    const state = reducePalette(initialPalette, { _tag: "Chosen", key: "command:timeline.next" });

    expect(structuredClone(state)).toStrictEqual(state);
  });
});

const everyEntry = all.flatMap((section) => section.entries);

/**
 * The composers after a choice's intents that start the composer.
 * @param text - The draft before.
 * @param entry - The entry chosen.
 * @returns The composer after.
 */
const afterChoosing = (text: string, entry: Entry) => {
  let state = reduceComposers(initialComposers, { _tag: "Edited", text, timeline: channel });

  for (const intent of choose(entry, inChannel)) {
    if (intent._tag === "FocusComposer") {
      state = started(state, channel, intent.text);
    }
  }

  return draftOf(state, channel);
};

describe("a choice and the draft", () => {
  it("never changes a draft with text in it, for any choice", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((text) => text.trim() !== ""),
        fc.constantFrom(...everyEntry),
        (text, entry) => {
          expect(afterChoosing(text, entry).text).toBe(text);
        }
      )
    );
  });

  it("starts an empty or blank draft, and says what was not put in over one with text", () => {
    const me = entryOf(all, "command:say.action");

    expect({
      blank: afterChoosing("  ", me).text,
      empty: afterChoosing("", me).text,
      kept: afterChoosing("half a thought", me),
    }).toStrictEqual({
      blank: "/me ",
      empty: "/me ",
      kept: {
        confirming: undefined,
        history: [],
        kept: "",
        notice: {
          message: "/me was not put in, since the composer has text. Clear it and choose again.",
          offer: undefined,
        },
        recalled: undefined,
        text: "half a thought",
      },
    });
  });
});
