import { TimelineItem } from "@iirc/api";
import type { Activity, ItemContent } from "@iirc/api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  deviceUiOf,
  deviceUiText,
  effectiveUi,
  readRuleOf,
  noOverrides,
  overridden,
  showsIn,
  writtenOnDevice,
} from "./ui.ts";

const shared = {
  options: {
    activity: "quiet",
    colours: "theme",
    dark: "dark",
    day: "long",
    enter: "newline",
    font: "commit-mono",
    leading: 1.45,
    light: "light",
    line: "columns",
    previews: "off",
    "previews.animate": false,
    "previews.folded": "summary",
    "previews.mediaHeight": "medium",
    "previews.players": ["player.vimeo.com"],
    "previews.style": "thumbnail",
    "previews.timelines": {},
    read: "latest",
    size: 16,
    spellcheck: true,
    suffix: ": ",
    theme: "dark",
    themes: [],
    time: "HH:mm:ss",
    width: "none",
  },
  sequence: 4,
} as const;

describe("a device's overrides", () => {
  it("are read back from the text they are kept as, option by option", () => {
    expect({
      back: deviceUiOf(deviceUiText({ theme: "light", time: "none" })),
      empty: deviceUiText(noOverrides),
      family: deviceUiOf('{"font":"Iosevka Term"}'),
      habits: deviceUiOf('{"enter":"send","spellcheck":false,"suffix":", "}'),
      habitsOut: deviceUiOf('{"enter":"shift","spellcheck":"no","suffix":"\\u0003","size":20}'),
      habitsTooLong: deviceUiOf('{"suffix":"123456789","enter":"newline"}'),
      leading: deviceUiOf('{"leading":1.2}'),
      leadingFine: deviceUiOf('{"leading":1.455,"size":20}'),
      leadings: deviceUiOf('{"leading":3,"size":20}'),
      long: deviceUiOf(`{"theme":"light","x":"${"x".repeat(50_000)}"}`),
      mixed: deviceUiOf('{"theme":"light","time":"noon","palette":"dusk","activity":3}'),
      none: deviceUiOf(undefined),
      notAnObject: deviceUiOf("[1,2]"),
      notJson: deviceUiOf("{theme"),
      sized: deviceUiOf('{"size":24,"font":"jetbrains-mono"}'),
      sizes: deviceUiOf('{"size":9,"font":"Ios\\"evka"}'),
      widths: deviceUiOf('{"width":"none","size":20}'),
      widthsOut: deviceUiOf('{"width":0,"size":20}'),
      widthsSet: deviceUiOf('{"width":72}'),
    }).toStrictEqual({
      back: { theme: "light", time: "none" },
      empty: undefined,
      family: { font: "Iosevka Term" },
      habits: { enter: "send", spellcheck: false, suffix: ", " },
      habitsOut: { size: 20 },
      habitsTooLong: { enter: "newline" },
      leading: { leading: 1.2 },
      leadingFine: { size: 20 },
      leadings: { size: 20 },
      long: {},
      mixed: { theme: "light" },
      none: {},
      notAnObject: {},
      notJson: {},
      sized: { font: "jetbrains-mono", size: 24 },
      sizes: {},
      widths: { size: 20, width: "none" },
      widthsOut: { size: 20 },
      widthsSet: { width: 72 },
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
      device: effectiveUi(shared, { size: 20, theme: "light" }),
      leading: effectiveUi(shared, { leading: 1.8 }).leading,
      shared: effectiveUi(shared, noOverrides),
    }).toStrictEqual({
      before: {
        activity: "all",
        colours: "theme",
        dark: "dark",
        day: "full",
        enter: "send",
        font: "system",
        leading: 1.45,
        light: "light",
        line: "columns",
        previews: "off",
        "previews.animate": false,
        "previews.folded": "summary",
        "previews.mediaHeight": "medium",
        "previews.players": [
          "www.youtube-nocookie.com",
          "player.vimeo.com",
          "w.soundcloud.com",
          "bandcamp.com",
          "open.spotify.com",
          "player.twitch.tv",
        ],
        "previews.style": "thumbnail",
        "previews.timelines": {},
        read: "latest",
        size: 14,
        spellcheck: true,
        suffix: ": ",
        theme: "system",
        themes: [],
        time: "HH:mm",
        width: "none",
      },
      device: { ...shared.options, size: 20, theme: "light" },
      leading: 1.8,
      shared: shared.options,
    });
  });

  it("know when a Timeline is marked read only once this device or the shared options say", () => {
    const asked = { ...shared, options: { ...shared.options, read: "asked" as const } };

    expect({
      before: readRuleOf(undefined, noOverrides),
      device: readRuleOf(asked, { read: "shown" }),
      deviceBefore: readRuleOf(undefined, { read: "shown" }),
      shared: readRuleOf(asked, noOverrides),
    }).toStrictEqual({
      before: undefined,
      device: "shown",
      deviceBefore: "shown",
      shared: "asked",
    });
  });
});

const unknown = { _tag: "Unknown" } as const;

describe("an option every device shares only", () => {
  it("is never a device's: not read back, not kept, not in effect, and never written there", () => {
    const kept = deviceUiOf('{"previews":"on","size":20}');

    expect({
      effective: effectiveUi(shared, { previews: "on", size: 20 }).previews,
      kept,
      overridden: overridden(noOverrides, "previews", "links only"),
      written: [writtenOnDevice("previews", "on", false), writtenOnDevice("previews", "on", true)],
    }).toStrictEqual({
      effective: "off",
      kept: { size: 20 },
      overridden: noOverrides,
      written: [false, false],
    });
  });
});

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const itemOf = (sequence: number, at: number, held: typeof ItemContent.Encoded) =>
  Schema.decodeSync(TimelineItem)({
    answered: null,
    changed: sequence,
    content: held,
    level: "Activity",
    network: "alpha",
    position: `${hex(BigInt(at) + 2n ** 53n, 14)}-${hex(BigInt(sequence), 14)}-${hex(0n, 8)}`,
    sequence,
    timeline: `${hex(1n, 14)}-00000000-00000000`,
  });

const happened = (sequence: number, at: number, what: typeof Activity.Encoded) =>
  itemOf(sequence, at, { _tag: "Activity", activity: what, at: unknown, id: unknown, live: true });

const said = (
  sequence: number,
  at: number,
  sender: string,
  kind: "Privmsg" | "Notice" | "Action" = "Privmsg"
) =>
  itemOf(sequence, at, {
    _tag: "Message",
    answers: null,
    at: unknown,
    context: null,
    id: unknown,
    kind,
    live: true,
    ours: null,
    sender,
    tags: [],
    target: "#iirc",
    text: "hi",
  });

const joined = (sequence: number, at: number, nick: string) =>
  happened(sequence, at, { _tag: "Joined", channel: "#iirc", nick });

const quit = (sequence: number, at: number, nick: string) =>
  happened(sequence, at, { _tag: "Quit", nick, reason: null });

const minute = 60_000;

describe("which items a Timeline shows", () => {
  it("in a Channel's, all Activity, all but joins, parts, and quits, or none, and every item elsewhere", () => {
    const parted = happened(2, 2, { _tag: "Parted", channel: "#iirc", nick: "peer", reason: null });

    const kicked = happened(4, 4, {
      _tag: "Kicked",
      by: "op",
      channel: "#iirc",
      nick: "peer",
      reason: null,
    });

    const began = itemOf(5, 5, { _tag: "SessionBegan", at: 1, nick: "iirc" });
    const items = [joined(1, 1, "peer"), parted, quit(3, 3, "peer"), kicked, began];

    expect(
      (["all", "spoke", "quiet", "none"] as const).map((shown) => [
        ...items.map(showsIn(shown, "Channel", items, undefined)),
        ...items.map(showsIn(shown, "Network", items, undefined)).slice(0, 1),
        ...items.map(showsIn(shown, "Direct", items, undefined)).slice(2, 3),
      ])
    ).toStrictEqual([
      [true, true, true, true, true, true, true],
      [false, false, false, true, true, true, true],
      [false, false, false, true, true, true, true],
      [false, false, false, false, true, true, true],
    ]);
  });

  it("under spoke, in a Channel's, shows a join, part, or quit only of Self's or of a User who spoke up to five minutes before it", () => {
    const items = [
      said(1, 0, "alice"),
      said(2, 0, "Bob", "Action"),
      said(3, 0, "carol", "Notice"),
      said(4, 0, "dave"),
      joined(5, 5 * minute, "ALICE"),
      quit(6, 5 * minute, "bob"),
      quit(7, 5 * minute, "carol"),
      // Six minutes after dave spoke, and erin never did.
      quit(8, 6 * minute, "dave"),
      quit(9, 6 * minute, "erin"),
      quit(10, 6 * minute, "Me"),
    ];

    expect(items.map(showsIn("spoke", "Channel", items, "me"))).toStrictEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      true,
    ]);
  });

  it("under spoke, follows a User across a change of nick, and measures from their latest Message", () => {
    const items = [
      said(1, 0, "bob"),
      happened(2, minute, { _tag: "NickChanged", from: "bob", to: "bobby" }),
      quit(3, 4 * minute, "bobby"),
      said(4, 5 * minute, "bobby"),
      quit(5, 9 * minute, "bobby"),
      // The old nick is no one's after it changed.
      joined(6, 9 * minute, "bob"),
    ];

    expect(items.map(showsIn("spoke", "Channel", items, undefined))).toStrictEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it("under spoke, leaves a Network's and a Direct Message's Timeline alone", () => {
    const items = [quit(1, 0, "erin")];

    expect(
      (["Network", "Direct", undefined] as const).map((kind) =>
        items.map(showsIn("spoke", kind, items, undefined))
      )
    ).toStrictEqual([[true], [true], [true]]);
  });
});

describe("where a change of an option is written", () => {
  it("is this device's for a font's family, and for any option this device overrides, and every device's otherwise", () => {
    expect({
      bundled: writtenOnDevice("font", "inter", false),
      bundledAnyCase: writtenOnDevice("font", "Inter", false),
      bundledOverridden: writtenOnDevice("font", "inter", true),
      family: writtenOnDevice("font", "Fira Code", false),
      familyOverridden: writtenOnDevice("font", "Fira Code", true),
      other: writtenOnDevice("size", 20, false),
      otherOverridden: writtenOnDevice("size", 20, true),
      unset: writtenOnDevice("font", undefined, false),
      unsetOverridden: writtenOnDevice("font", undefined, true),
    }).toStrictEqual({
      bundled: false,
      bundledAnyCase: false,
      bundledOverridden: true,
      family: true,
      familyOverridden: true,
      other: false,
      otherOverridden: true,
      unset: false,
      unsetOverridden: true,
    });
  });
});
