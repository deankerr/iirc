import { ItemContent } from "@iirc/api";
import type { Activity } from "@iirc/api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { deviceUiOf, deviceUiText, effectiveUi, noOverrides, overridden, showsItem } from "./ui.ts";

const shared = {
  options: { activity: "quiet", colours: "theme", theme: "dark", themes: [], time: "HH:mm:ss" },
  sequence: 4,
} as const;

describe("a device's overrides", () => {
  it("are read back from the text they are kept as, option by option", () => {
    expect({
      back: deviceUiOf(deviceUiText({ theme: "light", time: "none" })),
      empty: deviceUiText(noOverrides),
      long: deviceUiOf(`{"theme":"light","x":"${"x".repeat(50_000)}"}`),
      mixed: deviceUiOf('{"theme":"light","time":"noon","palette":"dusk","activity":3}'),
      none: deviceUiOf(undefined),
      notAnObject: deviceUiOf("[1,2]"),
      notJson: deviceUiOf("{theme"),
    }).toStrictEqual({
      back: { theme: "light", time: "none" },
      empty: undefined,
      long: {},
      mixed: { theme: "light" },
      none: {},
      notAnObject: {},
      notJson: {},
    });
  });

  it("override one option, or stop, and never keep a value its Schema refuses", () => {
    const light = overridden(noOverrides, "theme", "light");

    expect({
      back: overridden(light, "theme", undefined),
      light,
      refused: overridden(light, "time", "noon"),
      replaced: overridden(light, "theme", "dark"),
    }).toStrictEqual({
      back: {},
      light: { theme: "light" },
      refused: { theme: "light" },
      replaced: { theme: "dark" },
    });
  });

  it("keep a full collection of themes beside another override, and drop a bad theme alone", () => {
    const palette = {
      ansi: Array.from({ length: 16 }, () => "#000000"),
      background: "#000000",
      cursor: "#000000",
      foreground: "#000000",
      selection: "#000000",
    };

    const themes = Array.from({ length: 32 }, (_, index) => ({
      name: `${index}`.padEnd(32, "x"),
      palette,
    }));

    const full = overridden(overridden(noOverrides, "theme", "dark"), "themes", themes);
    const text = deviceUiText(full) ?? "";

    const badOne = deviceUiOf(
      JSON.stringify({
        theme: "dark",
        themes: [...themes.slice(0, 2), { name: "nord", palette }, { name: "x", palette: {} }],
        time: "none",
      })
    );

    expect({
      back: deviceUiOf(text),
      badOne,
      count: full.themes?.length,
      theme: full.theme,
    }).toStrictEqual({
      back: full,
      badOne: { theme: "dark", themes: themes.slice(0, 2), time: "none" },
      count: 32,
      theme: "dark",
    });
  });

  it("win over the shared options, which win over the defaults", () => {
    expect({
      before: effectiveUi(undefined, noOverrides),
      device: effectiveUi(shared, { theme: "light" }),
      shared: effectiveUi(shared, noOverrides),
    }).toStrictEqual({
      before: { activity: "all", colours: "theme", theme: "system", themes: [], time: "HH:mm" },
      device: { activity: "quiet", colours: "theme", theme: "light", themes: [], time: "HH:mm:ss" },
      shared: { activity: "quiet", colours: "theme", theme: "dark", themes: [], time: "HH:mm:ss" },
    });
  });
});

const content = Schema.decodeUnknownSync(ItemContent);

const unknown = { _tag: "Unknown" };

const activity = (happened: typeof Activity.Encoded) =>
  content({ _tag: "Activity", activity: happened, at: unknown, id: unknown, live: true });

describe("which items a Timeline shows", () => {
  it("in a Channel's, all Activity, all but joins, parts, and quits, or none, and every item elsewhere", () => {
    const joined = activity({ _tag: "Joined", channel: "#iirc", nick: "peer" });
    const parted = activity({ _tag: "Parted", channel: "#iirc", nick: "peer", reason: null });
    const quit = activity({ _tag: "Quit", nick: "peer", reason: null });

    const kicked = activity({
      _tag: "Kicked",
      by: "op",
      channel: "#iirc",
      nick: "peer",
      reason: null,
    });

    const began = content({ _tag: "SessionBegan", at: 1, nick: "iirc" });

    expect(
      (["all", "quiet", "none"] as const).map((shown) => [
        ...[joined, parted, quit, kicked, began].map((one) => showsItem(shown, "Channel", one)),
        showsItem(shown, "Network", joined),
        showsItem(shown, "Direct", quit),
      ])
    ).toStrictEqual([
      [true, true, true, true, true, true, true],
      [false, false, false, true, true, true, true],
      [false, false, false, false, true, true, true],
    ]);
  });
});
