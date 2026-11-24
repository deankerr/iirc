import { NetworkId, TimelineId } from "@iirc/api";
import { FontFamily, uiDefaults } from "@iirc/api/ui";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { commandWithId } from "./commands.ts";
import {
  commandEntry,
  commandKey,
  fontDescription,
  fontEntries,
  familyNamed,
  matchedBy,
  networkEntry,
  recentCap,
  remember,
  themeEntries,
  themeDescription,
  timelineEntry,
} from "./entries.ts";
import type { Entry } from "./entries.ts";
import { defaultKeymap, formatChord } from "./keymap.ts";
import { listedThemes, paletteNamed } from "./theme.ts";

const libera = Schema.decodeSync(NetworkId)("libera");
const channel = Schema.decodeSync(TimelineId)("00000000000002-00000000-00000000");

const commandOf = (id: string): Entry => {
  const found = commandWithId(id);

  if (found === undefined) {
    throw new Error(`no command ${id}`);
  }

  return commandEntry(found, defaultKeymap);
};

describe("an entry's key and the words it is matched by", () => {
  it("is keyed so each kind is remembered and found apart, and matched by its names and description", () => {
    const previous = commandOf("timeline.previous");

    const timeline = timelineEntry({
      kind: "Channel",
      name: "#iirc",
      network: libera,
      timeline: channel,
    });

    const removed = networkEntry({ network: libera, removed: true });
    const live = networkEntry({ network: libera, removed: false });

    expect({
      alias: matchedBy(previous).names,
      chords: previous._tag === "Command" ? previous.chords.map(formatChord) : undefined,
      keys: [previous.key, timeline.key, live.key, commandKey("timeline.previous")],
      network: [matchedBy(live).description, matchedBy(removed).description],
      timeline: matchedBy(timeline).names,
    }).toStrictEqual({
      alias: ["previous", "prev"],
      chords: ["alt+arrowup"],
      keys: [
        "command:timeline.previous",
        `timeline:${channel}`,
        "network:libera",
        "command:timeline.previous",
      ],
      network: [
        "network: remove it, asking first whether to keep its conversations to read",
        "network: delete its kept conversations and free its name",
      ],
      timeline: ["#iirc", "libera #iirc"],
    });
  });
});

const names = (entries: readonly Entry[]) => entries.map((one) => one.key);

const current = (entries: readonly Entry[]) =>
  entries.flatMap((one) => (one._tag === "Theme" && one.current ? [one.name] : []));

describe("the themes listed", () => {
  const themes = listedThemes([
    { name: "mine", palette: paletteNamed("dracula", uiDefaults, true) },
  ]);

  const chosen = { theme: "nord", "theme.dark": "mine", "theme.light": "light" };

  it("lists every theme, the one the option names said, and none called system for the schemes", () => {
    const forTheme = themeEntries(themes, chosen, "theme");
    const forDark = themeEntries(themes, chosen, "theme.dark");

    expect({
      current: [current(forTheme), current(forDark)],
      darkHasSystem: names(forDark).includes("theme:system"),
      described: [themeDescription({ builtIn: true }), themeDescription({ builtIn: false })],
      themeHasSystem: names(forTheme).includes("theme:system"),
      themes: names(forTheme).slice(-3),
    }).toStrictEqual({
      current: [["nord"], ["mine"]],
      darkHasSystem: false,
      described: ["built-in theme", "imported theme"],
      themeHasSystem: true,
      themes: ["theme:dracula", "theme:tokyo-night", "theme:mine"],
    });
  });
});

describe("the fonts listed", () => {
  it("lists every font, the one in effect said, and a family named after the bundled ones", () => {
    const fira = Schema.decodeSync(FontFamily)("Fira Code");
    const plain = fontEntries(undefined, "commit-mono");
    const typed = fontEntries(fira, fira);
    const family = typed.at(-1);

    expect({
      bundled: plain.length,
      current: plain.flatMap((one) => (one._tag === "Font" && one.current ? [one.key] : [])),
      family,
      familyNames: family === undefined ? [] : matchedBy(family).names,
      said: [fontDescription("inter"), fontDescription(fira)],
    }).toStrictEqual({
      bundled: 11,
      current: ["font:commit-mono"],
      family: { _tag: "Font", current: true, key: "font:Fira Code", name: "Fira Code" },
      familyNames: ["font Fira Code", "Fira Code"],
      said: ["font: sans", "font: a font family on this device"],
    });
  });

  it("names a family only where it is one: no quote, backslash, or more than 64 characters", () => {
    expect({
      long: familyNamed("x".repeat(65)),
      quote: familyNamed('Fira"Code'),
      slash: familyNamed(String.raw`Fira\Code`),
      spaced: familyNamed("Fira Code"),
    }).toStrictEqual({
      long: undefined,
      quote: undefined,
      slash: undefined,
      spaced: "Fira Code",
    });
  });
});

describe("what was run recently", () => {
  it("remembers at most the cap, newest first, each once, for any keys", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...Array.from({ length: 30 }, (_, index) => `k${index}`))),
        (ran) => {
          let recent: readonly string[] = [];

          for (const key of ran) {
            recent = remember(recent, key);
          }

          expect(recent).toStrictEqual([...new Set(ran.toReversed())].slice(0, recentCap));
        }
      )
    );
  });
});
