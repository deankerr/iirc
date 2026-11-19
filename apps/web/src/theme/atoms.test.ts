// @vitest-environment happy-dom
import { draftOf } from "@iirc/frontend/composer";
import { deviceUiKey } from "@iirc/frontend/ui";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { edit, send } from "../composer/atoms.ts";
import { composerState } from "../composer/composer-state.ts";
import { signedOut } from "../options/atoms.ts";
import { uiInEffect, uiSync } from "../options/ui.ts";
import { readChoice, writeChoice } from "../page/device.ts";
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
  drawnTheme,
  editImport,
  importDraft,
  saveImport,
  watchTheme,
} from "./atoms.ts";
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
 * Whether the device prefers dark, as the browser's media query says it, and changes it
 * when the test says, as a device does when its setting changes.
 */
class DevicePreference extends EventTarget {
  matches: boolean;

  constructor(dark: boolean) {
    super();
    this.matches = dark;
  }

  /**
   * Changes whether the device prefers dark, and says so.
   * @param dark - Whether it prefers dark now.
   */
  prefer(dark: boolean) {
    this.matches = dark;
    this.dispatchEvent(new Event("change"));
  }
}

const drawnNow = () => document.documentElement.style.getPropertyValue("--color-background");

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

  it("draws system as the theme chosen for light or dark, follows the device at once, and lets a named theme win", async () => {
    const device = new DevicePreference(true);

    vi.stubGlobal("matchMedia", () => device);

    const { registry, type } = await page(signedIn());
    const stop = watchTheme(registry);

    await type("/theme -dark nord");
    await until(registry, uiInEffect, (ui) => ui.dark === "nord");
    const dark = drawnNow();

    device.prefer(false);
    const light = drawnNow();

    device.prefer(true);
    const backToDark = drawnNow();

    await type("/theme dracula");
    await until(registry, uiInEffect, (ui) => ui.theme === "dracula");
    device.prefer(false);
    const named = drawnNow();

    stop();
    vi.unstubAllGlobals();

    expect({ backToDark, dark, light, named }).toStrictEqual({
      backToDark: "#2e3440",
      dark: "#2e3440",
      light: "#f6f5f1",
      named: "#282a36",
    });
  });

  it("draws the text's size and font on the root at once, with IRC's monospace in a monospace font beside a sans one, and writes a font chosen on this device while it overrides ui.font", async () => {
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

    await type("/set -device ui.font inter");
    const sans = read();

    await type("/set -device ui.font jetbrains-mono");

    // This device overrides the font, so the choice is its own: a shared one would not win.
    await type("/set ui.font commit-mono");
    await until(registry, uiInEffect, (ui) => ui.font === "commit-mono");

    stop();

    expect({
      before,
      device,
      kept: readChoice(deviceUiKey),
      refused,
      sans,
      shared: fake.daemon.ui.options.font,
      sized,
    }).toStrictEqual({
      before: ["14px", "var(--font-device)", "var(--font-device)"],
      device: [
        "18px",
        '"JetBrains Mono Variable", var(--font-device)',
        '"JetBrains Mono Variable", var(--font-device)',
      ],
      kept: '{"font":"commit-mono"}',
      refused: 'ui.size: Give a whole number from 10 to 24, not "30".',
      sans: ["18px", '"Inter Variable", var(--font-device-sans)', "var(--font-device)"],
      shared: "system",
      sized: ["18px", "var(--font-device)", "var(--font-device)"],
    });
  });

  it("draws a family the device has by its name, on this device alone, set by /set with or without -device", async () => {
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

    await type("/set ui.font Iosevka Term");
    await until(registry, uiInEffect, (ui) => ui.font === "Iosevka Term");
    const chosen = read();

    stop();

    expect({
      chosen,
      kept: readChoice(deviceUiKey),
      set,
      shared: fake.daemon.ui.options.font,
    }).toStrictEqual({
      chosen: ['"Iosevka Term", var(--font-device)', "var(--font-device)"],
      kept: '{"font":"Iosevka Term"}',
      set: ['"Fira Code", var(--font-device)', "var(--font-device)"],
      shared: "system",
    });
  });

  it("draws the widest line on the root in characters, and none as no property", async () => {
    const { registry, type } = await page(signedIn());
    const stop = watchTheme(registry);
    const before = widestLine();

    await type("/set ui.width 72");
    await until(registry, uiInEffect, (ui) => ui.width === 72);
    const shared = widestLine();

    stop();

    expect({ before, shared }).toStrictEqual({ before: "", shared: "72ch" });
  });

  it("draws the line height on the root at once", async () => {
    const { registry, type } = await page(signedIn());
    const stop = watchTheme(registry);
    const before = lineHeight();

    await type("/set ui.leading 1.8");
    await until(registry, uiInEffect, (ui) => ui.leading === 1.8);
    const shared = lineHeight();

    stop();

    expect({ before, shared }).toStrictEqual({ before: "1.45", shared: "1.8" });
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
