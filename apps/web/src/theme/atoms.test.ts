// @vitest-environment happy-dom
import { draftOf } from "@iirc/frontend/composer";
import { deviceUiKey } from "@iirc/frontend/ui";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { composerState, edit, send } from "../composer/atoms.ts";
import { signedOut } from "../options/atoms.ts";
import { uiInEffect, uiSync } from "../options/ui.ts";
import { readChoice, writeChoice } from "../page/device.ts";
import { closePalette, highlightEntry, paletteSections, pickEntry } from "../palette/atoms.ts";
import { paletteHappened, paletteState } from "../palette/state.ts";
import { check } from "../sign-in/atoms.ts";
import {
  eventually,
  fakeDaemon,
  instantThemeReader,
  registryFor,
  run,
  until,
} from "../testing/fake-daemon.ts";
import { sync } from "../timelines/atoms.ts";
import {
  cancelImport,
  chooseFile,
  drawnTheme,
  editImport,
  importDraft,
  importRead,
  saveImport,
  watchTheme,
} from "./atoms.ts";
import type { ChosenFile } from "./atoms.ts";
import type { ThemeReaderPort } from "./reader.ts";

/** Nord, as Alacritty's theme of it has it. */
const nord = `[colors.primary]
background = '#2E3440'
foreground = '#D8DEE9'

[colors.normal]
black = '#3B4252'
red = '#BF616A'
green = '#A3BE8C'
yellow = '#EBCB8B'
blue = '#81A1C1'
magenta = '#B48EAD'
cyan = '#88C0D0'
white = '#E5E9F0'

[colors.bright]
black = '#4C566A'
red = '#BF616A'
green = '#A3BE8C'
yellow = '#EBCB8B'
blue = '#81A1C1'
magenta = '#B48EAD'
cyan = '#8FBCBB'
white = '#ECEFF4'
`;

/**
 * A page signed in to the fake, following its Timelines and its `ui` options, with a way to
 * type a line into the composer with no Timeline open.
 * @param fake - The fake Daemon.
 * @param reader - How themes are read.
 * @returns The registry, and ways to type and to read the composer's notice.
 */
const page = async (
  fake: ReturnType<typeof fakeDaemon>,
  reader: ThemeReaderPort = instantThemeReader
) => {
  const registry = registryFor(fake.fetch, {}, undefined, reader);

  await run(registry, check, undefined);
  registry.mount(sync);
  registry.mount(uiSync);

  const type = async (text: string) => {
    registry.set(edit, { text, timeline: "Nowhere" });
    await run(registry, send, "Nowhere");
  };

  const notice = () => draftOf(registry.get(composerState), "Nowhere").notice?.message;
  const background = () => registry.get(drawnTheme).tokens.background;

  return { background, notice, registry, type };
};

const signedIn = () => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  writeChoice(deviceUiKey, undefined);

  return fake;
};

/**
 * A file whose text comes only when the test says.
 * @param name - Its name.
 * @returns The file, and a way to give its text.
 */
const deferred = (name: string) => {
  const { promise, resolve } = Promise.withResolvers<string>();
  const file: ChosenFile = { name, size: 10, text: async () => await promise };

  return { file, give: resolve };
};

/** Lets the reads a test started settle. */
const settle = async () => {
  await Effect.runPromise(Effect.sleep("20 millis"));
};

const lineHeight = () => document.documentElement.style.getPropertyValue("--line-height");

const widestLine = () => document.documentElement.style.getPropertyValue("--widest-line");

describe("themes", () => {
  it("imports one through the dialog, previewing it, for every device, and another page uses it", async () => {
    const fake = signedIn();
    const first = await page(fake);
    const second = await page(fake);

    await eventually(() => fake.daemon.uiFollowers.length === 2);
    await first.type("/theme import");

    const opened = first.registry.get(importDraft).open;
    const before = first.background();

    first.registry.set(editImport, { text: "not a theme" });
    const refused = first.registry.get(importDraft);

    first.registry.set(editImport, { text: nord });
    const previewing = first.background();

    // Alacritty's theme names nothing, so a name must be given.
    await run(first.registry, saveImport, undefined);
    const unnamed = first.registry.get(importDraft).notice;

    first.registry.set(editImport, { name: "Nord Mine" });
    await run(first.registry, saveImport, undefined);
    const badName = first.registry.get(importDraft).notice;

    first.registry.set(editImport, { name: "nord-mine" });
    await run(first.registry, saveImport, undefined);

    const closed = first.registry.get(importDraft).open;
    const after = first.background();

    await until(second.registry, uiInEffect, (ui) => ui.themes.length === 1);
    await second.type("/theme nord-mine");
    await until(second.registry, uiInEffect, (ui) => ui.theme === "nord-mine");
    await until(first.registry, uiInEffect, (ui) => ui.theme === "nord-mine");

    expect({
      after,
      badName,
      before,
      changes: fake.daemon.uiChanges,
      closed,
      drawn: [first.background(), second.background()],
      opened,
      previewing,
      refused: refused.text,
      shared: fake.daemon.ui.options.themes.map((one) => one.name),
      unnamed,
    }).toStrictEqual({
      after: before,
      badName:
        "Nord Mine is not a theme's name: 1 to 32 letters and digits, in words joined by -, such as tokyo-night.",
      before: "#111314",
      changes: [
        { ifSequence: "0", route: "PUT themes" },
        { ifSequence: "10", route: "PUT theme" },
      ],
      closed: false,
      drawn: ["#2e3440", "#2e3440"],
      opened: true,
      previewing: "#2e3440",
      refused: "not a theme",
      shared: ["nord-mine"],
      unnamed:
        "A theme needs a name: 1 to 32 letters and digits, in words joined by -, such as tokyo-night.",
    });
  });

  it("restores the theme in effect when the import is cancelled", async () => {
    const fake = signedIn();
    const { background, registry, type } = await page(fake);

    await type("/theme import");
    registry.set(editImport, { text: nord });
    const previewing = background();

    registry.set(cancelImport, undefined);

    expect({ after: background(), previewing, shared: fake.daemon.uiChanges }).toStrictEqual({
      after: "#111314",
      previewing: "#2e3440",
      shared: [],
    });
  });

  it("lists the themes in the palette, drawing one while highlighted, and the one in effect again on Escape", async () => {
    const fake = signedIn();
    const { background, registry, type } = await page(fake);

    await type("/theme");
    const listed = registry.get(paletteState);

    registry.set(highlightEntry, { highlighted: true, key: "theme:dracula" });
    const dracula = background();

    registry.set(highlightEntry, { highlighted: true, key: "theme:solarized-light" });
    const solarized = background();

    registry.set(highlightEntry, { highlighted: true, key: "command:theme.set" });
    const command = background();

    registry.set(highlightEntry, { highlighted: true, key: "theme:nord" });
    registry.set(closePalette, undefined);

    expect({
      closed: background(),
      command,
      dracula,
      listed: [listed.open, listed.scope],
      solarized,
    }).toStrictEqual({
      closed: "#111314",
      command: "#111314",
      dracula: "#282a36",
      listed: [true, "Themes"],
      solarized: "#fdf6e3",
    });
  });

  it("sets, overrides, refuses, and removes themes by /theme", async () => {
    const fake = signedIn();
    const { background, notice, registry, type } = await page(fake);

    await type("/theme nope");
    const unknown = notice();

    await type("/theme gruvbox-dark");
    await until(registry, uiInEffect, (ui) => ui.theme === "gruvbox-dark");

    await type("/theme -device solarized-light");
    const device = [background(), readChoice(deviceUiKey)];

    await type("/theme remove nord");
    const builtIn = notice();

    await type("/theme remove mine");
    const missing = notice();

    expect({
      builtIn,
      device,
      missing,
      shared: fake.daemon.ui.options.theme,
      unknown,
    }).toStrictEqual({
      builtIn: "nord is built in, so it is never removed.",
      device: ["#fdf6e3", '{"theme":"solarized-light"}'],
      missing: "No theme mine was imported. /theme lists them.",
      shared: "gruvbox-dark",
      unknown: "There is no theme nope. /theme lists them, and /theme import adds one.",
    });
  });

  it("draws the theme as custom properties on the root, its scheme, and its name, system as the device prefers", async () => {
    const fake = signedIn();
    const { registry, type } = await page(fake);
    const stop = watchTheme(registry);
    const root = document.documentElement;

    const read = () => [
      root.style.getPropertyValue("--color-background"),
      root.style.getPropertyValue("--irc-98"),
      root.style.colorScheme,
      root.dataset.theme,
    ];

    const before = read();

    await type("/theme solarized-light");
    await until(registry, uiInEffect, (ui) => ui.theme === "solarized-light");

    const after = read();

    stop();

    expect({ after, before }).toStrictEqual({
      after: ["#fdf6e3", "#6a6969", "light", "solarized-light"],
      // happy-dom's device prefers light, which system follows.
      before: ["#f6f5f1", "#696868", "light", "system"],
    });
  });

  it("draws the text's size and font on the root at once, with IRC's monospace in a monospace font beside a sans one, previews a font highlighted in the palette, and sets one chosen there", async () => {
    const fake = signedIn();
    const { notice, registry, type } = await page(fake);
    const stop = watchTheme(registry);
    const root = document.documentElement;

    const read = () => [
      root.style.getPropertyValue("--font-size"),
      root.style.getPropertyValue("--font-text"),
      root.style.getPropertyValue("--font-mono"),
    ];

    const before = read();

    await type("/set ui.size 18");
    await until(registry, uiInEffect, (ui) => ui.size === 18);
    const sized = read();

    await type("/set ui.size 30");
    const refused = notice();

    await type("/set -device ui.font jetbrains-mono");
    const device = read();

    paletteHappened(registry, { _tag: "Opened", scope: "All" });
    registry.set(highlightEntry, { highlighted: true, key: "font:ibm-plex-mono" });
    const previewed = read();

    registry.set(highlightEntry, { highlighted: true, key: "font:inter" });
    const sans = read();

    registry.set(highlightEntry, { highlighted: true, key: "theme:nord" });
    const otherRow = read();

    registry.set(highlightEntry, { highlighted: true, key: "font:commit-mono" });
    registry.set(closePalette, undefined);
    const closed = read();

    paletteHappened(registry, { _tag: "Opened", scope: "All" });

    const commit = registry
      .get(paletteSections)
      .flatMap((section) => section.entries)
      .find((entry) => entry.key === "font:commit-mono");

    if (commit !== undefined) {
      registry.set(pickEntry, commit);
    }

    // This device overrides the font, so the choice is its own: a shared one would not win.
    await until(registry, uiInEffect, (ui) => ui.font === "commit-mono");

    stop();

    expect({
      before,
      closed,
      device,
      kept: readChoice(deviceUiKey),
      otherRow,
      picked: commit?.key,
      previewed,
      refused,
      sans,
      shared: fake.daemon.ui.options.font,
      sized,
    }).toStrictEqual({
      before: ["14px", "var(--font-device)", "var(--font-device)"],
      closed: [
        "18px",
        '"JetBrains Mono Variable", var(--font-device)',
        '"JetBrains Mono Variable", var(--font-device)',
      ],
      device: [
        "18px",
        '"JetBrains Mono Variable", var(--font-device)',
        '"JetBrains Mono Variable", var(--font-device)',
      ],
      kept: '{"font":"commit-mono"}',
      otherRow: [
        "18px",
        '"JetBrains Mono Variable", var(--font-device)',
        '"JetBrains Mono Variable", var(--font-device)',
      ],
      picked: "font:commit-mono",
      previewed: [
        "18px",
        '"IBM Plex Mono", var(--font-device)',
        '"IBM Plex Mono", var(--font-device)',
      ],
      refused: 'ui.size: Give a whole number from 10 to 24, not "30".',
      sans: ["18px", '"Inter Variable", var(--font-device-sans)', "var(--font-device)"],
      shared: "system",
      sized: ["18px", "var(--font-device)", "var(--font-device)"],
    });
  });

  it("draws a family the device has by its name, on this device alone, set by /set or typed in the palette, and previews one typed there", async () => {
    const fake = signedIn();
    const { registry, type } = await page(fake);
    const stop = watchTheme(registry);
    const root = document.documentElement;

    const read = () => [
      root.style.getPropertyValue("--font-text"),
      root.style.getPropertyValue("--font-mono"),
    ];

    await type("/set -device ui.font Fira Code");
    const set = read();

    paletteHappened(registry, { _tag: "Opened", scope: "All" });
    paletteHappened(registry, { _tag: "Queried", query: "font Iosevka Term" });

    const typed = registry
      .get(paletteSections)
      .flatMap((section) => section.entries)
      .find((entry) => entry.key === "font:Iosevka Term");

    registry.set(highlightEntry, { highlighted: true, key: "font:Iosevka Term" });
    const previewed = read();

    if (typed !== undefined) {
      registry.set(pickEntry, typed);
    }

    await until(registry, uiInEffect, (ui) => ui.font === "Iosevka Term");
    const chosen = read();

    stop();

    expect({
      chosen,
      kept: readChoice(deviceUiKey),
      previewed,
      set,
      shared: fake.daemon.ui.options.font,
    }).toStrictEqual({
      chosen: ['"Iosevka Term", var(--font-device)', "var(--font-device)"],
      kept: '{"font":"Iosevka Term"}',
      previewed: ['"Iosevka Term", var(--font-device)', "var(--font-device)"],
      set: ['"Fira Code", var(--font-device)', "var(--font-device)"],
      shared: "system",
    });
  });

  it("draws a bundled font chosen in the palette after a family typed there, since this device's override would win over the shared one", async () => {
    const fake = signedIn();
    const { registry } = await page(fake);

    const choose = async (query: string, key: string, font: string) => {
      paletteHappened(registry, { _tag: "Opened", scope: "All" });
      paletteHappened(registry, { _tag: "Queried", query });

      const entry = registry
        .get(paletteSections)
        .flatMap((section) => section.entries)
        .find((one) => one.key === key);

      if (entry !== undefined) {
        registry.set(pickEntry, entry);
      }

      await until(registry, uiInEffect, (ui) => ui.font === font);
    };

    await choose("font Fira Code", "font:Fira Code", "Fira Code");
    const family = readChoice(deviceUiKey);

    await choose("inter", "font:inter", "inter");

    expect({
      family,
      inEffect: registry.get(uiInEffect).font,
      kept: readChoice(deviceUiKey),
      shared: fake.daemon.ui.options.font,
    }).toStrictEqual({
      family: '{"font":"Fira Code"}',
      inEffect: "inter",
      kept: '{"font":"inter"}',
      shared: "system",
    });
  });

  it("draws the widest line on the root in characters, lets this device's own win, and draws none as no property", async () => {
    const fake = signedIn();
    const { notice, registry, type } = await page(fake);
    const stop = watchTheme(registry);
    const before = widestLine();

    await type("/set ui.width 72");
    await until(registry, uiInEffect, (ui) => ui.width === 72);
    const shared = widestLine();

    await type("/set -device ui.width none");
    await until(registry, uiInEffect, (ui) => ui.width === "none");
    const deviceNone = widestLine();

    await type("/set ui.width 39");
    const refused = notice();

    await type("/unset -device ui.width");
    await until(registry, uiInEffect, (ui) => ui.width === 72);
    const unsetDevice = widestLine();

    await type("/unset ui.width");
    await until(registry, uiInEffect, (ui) => ui.width === "none");
    const unset = widestLine();

    stop();

    expect({ before, deviceNone, refused, shared, unset, unsetDevice }).toStrictEqual({
      before: "",
      deviceNone: "",
      refused: 'ui.width: Give a whole number from 40 to 400, or none, not "39".',
      shared: "72ch",
      unset: "",
      unsetDevice: "72ch",
    });
  });

  it("draws the line height on the root at once, lets this device's own win, and falls back as each is unset", async () => {
    const fake = signedIn();
    const { notice, registry, type } = await page(fake);
    const stop = watchTheme(registry);
    const before = lineHeight();

    await type("/set ui.leading 1.8");
    await until(registry, uiInEffect, (ui) => ui.leading === 1.8);
    const shared = lineHeight();

    await type("/set -device ui.leading 1.2");
    await until(registry, uiInEffect, (ui) => ui.leading === 1.2);
    const device = lineHeight();

    await type("/set ui.leading 1.9");
    await eventually(() => fake.daemon.ui.options.leading === 1.9);
    const stillDevice = lineHeight();

    await type("/set ui.leading 3");
    const refused = notice();

    await type("/unset -device ui.leading");
    await until(registry, uiInEffect, (ui) => ui.leading === 1.9);
    const unsetDevice = lineHeight();

    await type("/unset ui.leading");
    await until(registry, uiInEffect, (ui) => ui.leading === 1.45);
    const unset = lineHeight();

    stop();

    expect({ before, device, refused, shared, stillDevice, unset, unsetDevice }).toStrictEqual({
      before: "1.45",
      device: "1.2",
      refused: 'ui.leading: Give a number from 1 to 2, in steps of 0.01, not "3".',
      shared: "1.8",
      stillDevice: "1.2",
      unset: "1.45",
      unsetDevice: "1.9",
    });
  });

  it("applies only the latest file read: typing, closing, and another choice let one go", async () => {
    const reads: string[] = [];

    const counting: ThemeReaderPort = {
      read: (text) =>
        Effect.suspend(() => {
          reads.push(text);

          return instantThemeReader.read(text);
        }),
    };

    const { registry, type } = await page(signedIn(), counting);

    // Typing after choosing a file keeps what was typed.
    await type("/theme import");
    const typedOver = deferred("first.conf");

    registry.set(chooseFile, typedOver.file);
    registry.set(editImport, { text: nord });
    typedOver.give("from the file");
    await settle();
    const typed = registry.get(importDraft).text;

    // A file that finishes after Cancel starts no read and opens nothing.
    const cancelled = deferred("late.conf");

    registry.set(chooseFile, cancelled.file);
    registry.set(cancelImport, undefined);
    const before = reads.length;

    cancelled.give(nord);
    await settle();
    const afterCancel = { open: registry.get(importDraft).open, reads: reads.length - before };

    // Of two choices, the later applies, whichever finishes first.
    await type("/theme import");
    const older = deferred("older.conf");
    const newer = deferred("newer.toml");

    registry.set(chooseFile, older.file);
    registry.set(chooseFile, newer.file);
    newer.give(nord);
    await settle();
    older.give("from the older file");
    await settle();

    expect({
      afterCancel,
      chosen: [registry.get(importDraft).fileName, registry.get(importDraft).text === nord],
      read: registry.get(importRead)?._tag,
      typed: typed === nord,
    }).toStrictEqual({
      afterCancel: { open: false, reads: 0 },
      chosen: ["newer.toml", true],
      read: "Parsed",
      typed: true,
    });
  });

  it("closes an import on sign-out, ending its read, and draws the theme in effect", async () => {
    const ended: string[] = [];

    const never: ThemeReaderPort = {
      read: (text) =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              ended.push(text);
            })
          )
        ),
    };

    const { background, registry, type } = await page(signedIn(), never);
    const stop = watchTheme(registry);
    const before = background();

    await type("/theme import");
    registry.set(editImport, { text: nord });
    signedOut(registry);

    const draft = registry.get(importDraft);

    stop();

    expect({ after: background(), before, draft, ended }).toStrictEqual({
      after: before,
      before,
      draft: { fileName: undefined, name: undefined, notice: undefined, open: false, text: "" },
      ended: [nord],
    });
  });
});
