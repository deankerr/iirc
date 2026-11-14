import { NetworkId, Timeline, TimelineId } from "@iirc/api";
import { FontFamily, uiDefaults } from "@iirc/api/ui";
import { NetworkConfiguration } from "@iirc/client/configuration";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { CommandContext } from "./commands.ts";
import { draftOf, initialComposers, reduceComposers, started } from "./composer.ts";
import { defaultKeymap, formatChord } from "./keymap.ts";
import { optionsOf } from "./options.ts";
import {
  allScope,
  choose,
  fontDescription,
  fontOfKey,
  initialPalette,
  recentCap,
  reducePalette,
  remember,
  sections,
} from "./palette.ts";
import type { Entry, Listing, PaletteEvent, Scope, Section } from "./palette.ts";
import { listedThemes, paletteNamed } from "./theme.ts";
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
    unread: { activity: 0, direct: 0, highlights: 0, messages: 0 },
  });

const sidebar: readonly SidebarNetwork[] = [
  {
    away: { _tag: "Unknown" },
    connection: { _tag: "Connected", nick: "dean", since: 1 },
    network: libera,
    reading: false,
    removed: false,
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
  behind: false,
  draft: undefined,
  focus: {
    detached: false,
    key: "#iirc",
    kind: "Channel",
    name: "#iirc",
    network: libera,
    removed: false,
    timeline: channel,
  },
  head: undefined,
  open: channel,
  panes: 1,
  session: true,
  shown: [],
  timelines: [own, channel, direct],
  unread: [],
};

const nowhere: CommandContext = { ...inChannel, focus: undefined, open: undefined, session: false };

const themesScope: Scope = { _tag: "Themes", option: "theme" };

const listing = (context: CommandContext = inChannel): Listing => ({
  chosen: { dark: "dark", light: "light", theme: "system" },
  context,
  font: "system",
  keymap: defaultKeymap,
  options: optionsOf(libera, configuration, new Set(["libera.password"])),
  sidebar,
  themes: [],
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
    removed: false,
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
  it("lists the commands that can run here, every Timeline, every font, and every option, but not itself", () => {
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
        "command:theme.set",
        "command:options.unset",
        "command:network.manage",
        "command:network.connect",
        "command:network.disconnect",
        "command:timeline.next",
        "command:timeline.previous",
        "command:timeline.unread",
        "command:timeline.read",
        "command:notify.set",
        "command:members.toggle",
        "command:sidebar.toggle",
        "command:search.open",
        "command:pane.split",
        "command:composer.focus",
      ],
      here: [
        "command:say.privmsg",
        "command:say.action",
        "command:say.to",
        "command:say.notice",
        "command:channels.join",
        "command:channels.part",
        "command:act.topic",
        "command:act.kick",
        "command:act.mode",
        "command:act.op",
        "command:act.deop",
        "command:act.voice",
        "command:act.devoice",
        "command:act.ban",
        "command:act.unban",
        "command:act.invite",
        "command:act.away",
        "command:act.back",
        "command:act.nick",
        "command:act.quote",
        "command:options.set",
        "command:theme.set",
        "command:options.unset",
        "command:network.manage",
        "command:network.connect",
        "command:network.disconnect",
        "command:timeline.latest",
        "command:timeline.next",
        "command:timeline.previous",
        "command:timeline.unread",
        "command:timeline.read",
        "command:notify.set",
        "command:timeline.query",
        "command:lookup.whois",
        "command:lookup.whowas",
        "command:members.toggle",
        "command:sidebar.toggle",
        "command:search.open",
        "command:pane.split",
        "command:composer.focus",
      ],
      timelines: 3,
      titles: ["Commands", "Timelines", "Networks", "Fonts", "Options"],
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
      // `nicks` starts the last word of an option's name, and no command's.
      nick: first(sections(listing(), "nicks", [])),
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
    expect(titles(sections(listing(), "next tim", ["command:timeline.next"]))).toStrictEqual([
      "Commands",
    ]);
  });
});

const all = sections(listing(), "", []);

const pick = (key: string, context = inChannel) => choose(entryOf(all, key), context, false);

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
      credential: choose(entryOf(all, "option:network.libera.password"), inChannel, false),
      option: choose(entryOf(all, "option:network.libera.nicks"), inChannel, false),
      timeline: choose(entryOf(all, `timeline:${own}`), inChannel, false),
    }).toStrictEqual({
      credential: [{ _tag: "PromptCredential", network: libera, path: ["password"] }],
      option: [{ _tag: "FocusComposer", text: "/set network.libera.nicks " }],
      timeline: [{ _tag: "Open", timeline: own }],
    });
  });

  it("asks to remove a Network, or to drop what a removed one kept, found by either word", () => {
    const removed: SidebarNetwork = {
      away: { _tag: "Unknown" },
      connection: { _tag: "Unknown" },
      network: Schema.decodeSync(NetworkId)("oftc"),
      reading: false,
      removed: true,
      running: undefined,
      timelines: [],
    };

    const withRemoved: Listing = { ...listing(), sidebar: [...sidebar, removed] };
    const networks = sections(withRemoved, "", []).find((one) => one.title === "Networks");

    expect({
      choices: networks?.entries.map((entry) => choose(entry, inChannel, false)),
      dropFound: first(sections(withRemoved, "drop", [])),
      names: networks?.entries.map((entry) => entry.key),
      removeFound: first(sections(withRemoved, "remove lib", [])),
    }).toStrictEqual({
      choices: [
        [{ _tag: "AskRemoval", keep: undefined, network: libera }],
        [{ _tag: "AskRemoval", keep: undefined, network: removed.network }],
      ],
      dropFound: "network:oftc",
      names: ["network:libera", "network:oftc"],
      removeFound: "network:libera",
    });
  });
});

describe("the themes in the palette", () => {
  const themed = {
    ...listing(),
    chosen: { dark: "mine", light: "light", theme: "nord" },
    themes: listedThemes([{ name: "mine", palette: paletteNamed("dracula", uiDefaults, true) }]),
  };

  it("lists every theme, the one in effect said, alone when scoped to them, and finds them by name or as themes", () => {
    const scoped = sections(themed, "", ["command:timeline.next"], themesScope);
    const nord = entryOf(scoped, "theme:nord");

    expect({
      all: titles(sections(themed, "", [])),
      byName: keys(sections(themed, "dracu", [])),
      chosen: choose(nord, inChannel, false),
      current: nord._tag === "Theme" && nord.current,
      scoped: keys(scoped),
      themes: first(sections(themed, "theme", [])),
    }).toStrictEqual({
      all: ["Commands", "Timelines", "Networks", "Themes", "Fonts", "Options"],
      byName: [["Themes", ["theme:dracula"]]],
      chosen: [{ _tag: "UseTheme", device: false, name: "nord", option: "theme" }],
      current: true,
      scoped: [
        [
          "Themes",
          [
            "theme:system",
            "theme:dark",
            "theme:light",
            "theme:solarized-dark",
            "theme:solarized-light",
            "theme:gruvbox-dark",
            "theme:nord",
            "theme:dracula",
            "theme:tokyo-night",
            "theme:mine",
          ],
        ],
      ],
      themes: "command:theme.set",
    });
  });

  it("lists the themes for dark, without system, the one ui.dark names said, and choosing one sets ui.dark", () => {
    const forDark = sections(themed, "", [], { _tag: "Themes", option: "dark" });
    const mine = entryOf(forDark, "theme:mine");
    const nord = entryOf(forDark, "theme:nord");

    expect({
      chosen: choose(nord, inChannel, false),
      current: [mine, nord].map((one) => one._tag === "Theme" && one.current),
      system: keys(forDark)[0]?.[1].includes("theme:system"),
    }).toStrictEqual({
      chosen: [{ _tag: "UseTheme", device: false, name: "nord", option: "dark" }],
      current: [true, false],
      system: false,
    });
  });
});

describe("the fonts in the palette", () => {
  it("lists every font, the one in effect said, finds them by name or as fonts, and sets one for every device", () => {
    const fonted = { ...listing(), font: "commit-mono" as const, themes: listedThemes([]) };
    const all = sections(fonted, "", []);
    const commit = entryOf(all, "font:commit-mono");

    expect({
      byName: keys(sections(fonted, "ibm-plex", [])),
      bySans: keys(sections(fonted, "sans", []))
        .find(([title]) => title === "Fonts")?.[1]
        .toSorted(),
      chosen: choose(commit, inChannel, false),
      current: commit._tag === "Font" && commit.current,
      fonts: keys(all).find(([title]) => title === "Fonts"),
      found: keys(sections(fonted, "font", [])).find(([title]) => title === "Fonts")?.[1].length,
      scoped: titles(sections(fonted, "", [], themesScope)),
    }).toStrictEqual({
      byName: [["Fonts", ["font:ibm-plex-mono", "font:ibm-plex-sans"]]],
      bySans: [
        "font:atkinson-hyperlegible-next",
        "font:ibm-plex-sans",
        "font:inter",
        "font:source-sans-3",
        "font:system-sans",
      ],
      chosen: [{ _tag: "ChangeUi", device: false, option: "font", value: "commit-mono" }],
      current: true,
      fonts: [
        "Fonts",
        [
          "font:system",
          "font:jetbrains-mono",
          "font:ibm-plex-mono",
          "font:source-code-pro",
          "font:commit-mono",
          "font:atkinson-hyperlegible-mono",
          "font:system-sans",
          "font:ibm-plex-sans",
          "font:atkinson-hyperlegible-next",
          "font:source-sans-3",
          "font:inter",
        ],
      ],
      found: 11,
      scoped: ["Themes"],
    });
  });
});

describe("a family typed in the palette", () => {
  it("is offered after font, unless it names a font listed or no family, and set for this device alone", () => {
    const fonted = { ...listing(), themes: listedThemes([]) };

    const fontsFor = (query: string) =>
      sections(fonted, query, []).find((section) => section.title === "Fonts")?.entries ?? [];

    const [typed] = fontsFor("/font  Fira Code ");

    expect({
      alone: fontsFor("Fira Code").map((one) => one.key),
      anyCase: fontsFor("FONT fira code").map((one) => one.key),
      chosen: typed === undefined ? undefined : choose(typed, inChannel, false),
      first: titles(sections(fonted, "font Fira Code", [])),
      named: fontsFor("font Inter").map((one) => one.key),
      previewed: typed === undefined ? undefined : fontOfKey(typed.key),
      refused: ['font Fira"Code', String.raw`font Fira\Code`, `font ${"x".repeat(65)}`].map(
        (query) => fontsFor(query).length
      ),
      said: typed?._tag === "Font" ? fontDescription(typed.name) : undefined,
      themes: titles(sections(fonted, "font Fira Code", [], themesScope)),
      typed,
    }).toStrictEqual({
      alone: [],
      anyCase: ["font:fira code"],
      chosen: [{ _tag: "ChangeUi", device: true, option: "font", value: "Fira Code" }],
      first: ["Fonts"],
      named: [],
      previewed: "Fira Code",
      refused: [0, 0, 0],
      said: "font: a family on this device",
      themes: [],
      typed: { _tag: "Font", current: false, key: "font:Fira Code", name: "Fira Code" },
    });
  });

  it("is said to be in effect when it is", () => {
    const fira = Schema.decodeSync(FontFamily)("Fira Code");
    const fonted = { ...listing(), font: fira, themes: listedThemes([]) };

    expect(
      sections(fonted, "font Fira Code", []).find((section) => section.title === "Fonts")?.entries
    ).toStrictEqual([{ _tag: "Font", current: true, key: "font:Fira Code", name: "Fira Code" }]);
  });

  it("is listed among the recent once chosen, with no query naming it, and is not made from a key no family has", () => {
    const fonted = { ...listing(), themes: listedThemes([]) };
    const recent = ["font:Fira Code", 'font:Fira"Code', "font:inter"];

    expect(
      sections(fonted, "", recent).find((section) => section.title === "Recent")?.entries
    ).toStrictEqual([
      { _tag: "Font", current: false, key: "font:Fira Code", name: "Fira Code" },
      { _tag: "Font", current: false, key: "font:inter", name: "inter" },
    ]);
  });
});

describe("the palette's state", () => {
  it("opens empty, keeps what is typed, and remembers a choice as it closes", () => {
    const events: readonly PaletteEvent[] = [
      { _tag: "Opened", scope: allScope },
      { _tag: "Queried", query: "nxt" },
      { _tag: "Chosen", key: "command:timeline.next" },
      { _tag: "Opened", scope: themesScope },
    ];

    expect(folded(events)).toStrictEqual({
      open: true,
      query: "",
      recent: ["command:timeline.next"],
      scope: themesScope,
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

  for (const intent of choose(entry, inChannel, false)) {
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
          _tag: "AboutText",
          message: "/me was not put in, since the composer has text. Clear it and choose again.",
        },
        recalled: undefined,
        text: "half a thought",
      },
    });
  });
});

const written = (entry: Entry | undefined, overridesFont: boolean) =>
  entry === undefined ? undefined : choose(entry, inChannel, overridesFont);

describe("where choosing a font is written", () => {
  it("is this device's for a family, and for a bundled font while this device overrides ui.font, and every device's otherwise", () => {
    const fonted = { ...listing(), themes: listedThemes([]) };

    const entries = sections(fonted, "font Fira Code", []).flatMap((section) => section.entries);
    const family = entries.find((entry) => entry.key === "font:Fira Code");
    const inter = entryOf(sections(fonted, "", []), "font:inter");

    expect({
      familyAlone: written(family, false),
      familyOverriding: written(family, true),
      interAlone: written(inter, false),
      interOverriding: written(inter, true),
    }).toStrictEqual({
      familyAlone: [{ _tag: "ChangeUi", device: true, option: "font", value: "Fira Code" }],
      familyOverriding: [{ _tag: "ChangeUi", device: true, option: "font", value: "Fira Code" }],
      interAlone: [{ _tag: "ChangeUi", device: false, option: "font", value: "inter" }],
      interOverriding: [{ _tag: "ChangeUi", device: true, option: "font", value: "inter" }],
    });
  });
});
