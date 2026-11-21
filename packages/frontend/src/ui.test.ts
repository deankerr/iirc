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
    aliases: [],
    "composer.enter": "newline",
    "composer.nickSuffix": ": ",
    "composer.spellcheck": true,
    font: "commit-mono",
    "font.lineHeight": 1.45,
    "font.size": 16,
    previews: "off",
    "previews.animate": false,
    "previews.folded": "summary",
    "previews.mediaHeight": "medium",
    "previews.players": ["player.vimeo.com"],
    "previews.timelines": {},
    "sidebar.networks": [],
    "sidebar.order": [],
    "sidebar.pinned": [],
    tail: "info",
    theme: "dark",
    "theme.dark": "dark",
    "theme.imported": [],
    "theme.light": "light",
    "timeline.activity": "quiet",
    "timeline.colours": "theme",
    "timeline.dateFormat": "long",
    "timeline.layout": "columns",
    "timeline.maxWidth": "none",
    "timeline.timeFormat": "HH:mm:ss",
    "unread.markRead": "latest",
    "unread.muted": [],
    "unread.quietBots": false,
  },
  sequence: 4,
} as const;

describe("a device's overrides", () => {
  it("are read back from the text they are kept as, option by option", () => {
    expect({
      back: deviceUiOf(deviceUiText({ theme: "light", "timeline.timeFormat": "none" })),
      empty: deviceUiText(noOverrides),
      family: deviceUiOf('{"font":"Iosevka Term"}'),
      habits: deviceUiOf(
        '{"composer.enter":"send","composer.spellcheck":false,"composer.nickSuffix":", "}'
      ),
      habitsOut: deviceUiOf(
        '{"composer.enter":"shift","composer.spellcheck":"no","composer.nickSuffix":"\\u0003","font.size":20}'
      ),
      habitsTooLong: deviceUiOf(
        '{"composer.nickSuffix":"123456789","tail":"info","composer.enter":"newline"}'
      ),
      lineHeight: deviceUiOf('{"font.lineHeight":1.2}'),
      lineHeightFine: deviceUiOf('{"font.lineHeight":1.455,"font.size":20}'),
      lineHeights: deviceUiOf('{"font.lineHeight":3,"font.size":20}'),
      long: deviceUiOf(`{"theme":"light","x":"${"x".repeat(50_000)}"}`),
      mixed: deviceUiOf(
        '{"theme":"light","timeline.timeFormat":"noon","palette":"dusk","timeline.activity":3}'
      ),
      // Kept under the name an option had before, which is the option's still.
      namedBefore: deviceUiOf('{"size":20,"time":"none"}'),
      none: deviceUiOf(undefined),
      notAnObject: deviceUiOf("[1,2]"),
      notJson: deviceUiOf("{theme"),
      sized: deviceUiOf('{"font.size":24,"font":"jetbrains-mono"}'),
      sizes: deviceUiOf('{"font.size":9,"font":"Ios\\"evka"}'),
      widths: deviceUiOf('{"timeline.maxWidth":"none","font.size":20}'),
      widthsOut: deviceUiOf('{"timeline.maxWidth":0,"font.size":20}'),
      widthsSet: deviceUiOf('{"timeline.maxWidth":72}'),
    }).toStrictEqual({
      back: { theme: "light", "timeline.timeFormat": "none" },
      empty: undefined,
      family: { font: "Iosevka Term" },
      habits: {
        "composer.enter": "send",
        "composer.nickSuffix": ", ",
        "composer.spellcheck": false,
      },
      habitsOut: { "font.size": 20 },
      habitsTooLong: { "composer.enter": "newline" },
      lineHeight: { "font.lineHeight": 1.2 },
      lineHeightFine: { "font.size": 20 },
      lineHeights: { "font.size": 20 },
      long: {},
      mixed: { theme: "light" },
      namedBefore: { "font.size": 20, "timeline.timeFormat": "none" },
      none: {},
      notAnObject: {},
      notJson: {},
      sized: { font: "jetbrains-mono", "font.size": 24 },
      sizes: {},
      widths: { "font.size": 20, "timeline.maxWidth": "none" },
      widthsOut: { "font.size": 20 },
      widthsSet: { "timeline.maxWidth": 72 },
    });
  });

  it("drop one kept under ui.previews.style, which is gone, and keep every other", () => {
    const device = deviceUiOf('{"previews.style":"card","previews.mediaHeight":"large"}');

    expect({ device, inEffect: effectiveUi(shared, device) }).toStrictEqual({
      device: { "previews.mediaHeight": "large" },
      inEffect: { ...shared.options, "previews.mediaHeight": "large" },
    });
  });

  it("override one option, or stop, and never keep a value its Schema refuses", () => {
    const light = overridden(noOverrides, "theme", "light");

    expect({
      back: overridden(light, "theme", undefined),
      light,
      refused: overridden(light, "timeline.timeFormat", "noon"),
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

    const full = overridden(overridden(noOverrides, "theme", "dark"), "theme.imported", themes);
    const text = deviceUiText(full) ?? "";

    const badOne = deviceUiOf(
      JSON.stringify({
        theme: "dark",
        "theme.imported": [
          ...themes.slice(0, 2),
          { name: "nord", palette },
          { name: "x", palette: {} },
        ],
        "timeline.timeFormat": "none",
      })
    );

    expect({
      back: deviceUiOf(text),
      badOne,
      count: full["theme.imported"]?.length,
      theme: full.theme,
    }).toStrictEqual({
      back: full,
      badOne: {
        theme: "dark",
        "theme.imported": themes.slice(0, 2),
        "timeline.timeFormat": "none",
      },
      count: 32,
      theme: "dark",
    });
  });

  it("win over the shared options, which win over the defaults", () => {
    expect({
      before: effectiveUi(undefined, noOverrides),
      device: effectiveUi(shared, { "font.size": 20, theme: "light" }),
      "font.lineHeight": effectiveUi(shared, { "font.lineHeight": 1.8 })["font.lineHeight"],
      shared: effectiveUi(shared, noOverrides),
    }).toStrictEqual({
      before: {
        aliases: [],
        "composer.enter": "send",
        "composer.nickSuffix": ": ",
        "composer.spellcheck": true,
        font: "system",
        "font.lineHeight": 1.45,
        "font.size": 14,
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
        "previews.timelines": {},
        "sidebar.networks": [],
        "sidebar.order": [],
        "sidebar.pinned": [],
        tail: "info",
        theme: "system",
        "theme.dark": "dark",
        "theme.imported": [],
        "theme.light": "light",
        "timeline.activity": "all",
        "timeline.colours": "theme",
        "timeline.dateFormat": "full",
        "timeline.layout": "columns",
        "timeline.maxWidth": "none",
        "timeline.timeFormat": "HH:mm",
        "unread.markRead": "latest",
        "unread.muted": [],
        "unread.quietBots": false,
      },
      device: { ...shared.options, "font.size": 20, theme: "light" },
      "font.lineHeight": 1.8,
      shared: shared.options,
    });
  });

  it("know when a Timeline is marked read only once this device or the shared options say", () => {
    const asked = {
      ...shared,
      options: { ...shared.options, "unread.markRead": "asked" as const },
    };

    expect({
      before: readRuleOf(undefined, noOverrides),
      device: readRuleOf(asked, { "unread.markRead": "shown" }),
      deviceBefore: readRuleOf(undefined, { "unread.markRead": "shown" }),
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
    const kept = deviceUiOf('{"previews":"on","font.size":20}');

    expect({
      effective: effectiveUi(shared, { "font.size": 20, previews: "on" }).previews,
      kept,
      overridden: overridden(noOverrides, "previews", "text"),
      written: [writtenOnDevice("previews", "on", false), writtenOnDevice("previews", "on", true)],
    }).toStrictEqual({
      effective: "off",
      kept: { "font.size": 20 },
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
    bot: false,
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
        ...items.map(showsIn(shown, "Channel", items, "iirc")),
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

  it("under spoke, in a Channel's, shows a join, part, or quit only of Self's or of a User who spoke up to five minutes before it, and every one while Self's nick is unknown", () => {
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

    expect({
      known: items.map(showsIn("spoke", "Channel", items, "me")),
      // Any of them could be Self's, so none is hidden.
      unknown: items.map(showsIn("spoke", "Channel", items, undefined)),
    }).toStrictEqual({
      known: [true, true, true, true, true, true, true, false, false, true],
      unknown: items.map(() => true),
    });
  });

  it("treats a netsplit or a netjoin as the quits and joins it tells: quiet hides it, and spoke shows it when any of its members spoke", () => {
    const split = (sequence: number, nicks: string[]) =>
      happened(sequence, 5 * minute, {
        _tag: "Netsplit",
        channel: "#iirc",
        nicks,
        servers: ["a.net", "b.net"],
      });

    const items = [
      said(1, 0, "alice"),
      split(2, ["bob", "ALICE"]),
      split(3, ["bob", "carol"]),
      happened(4, 5 * minute, {
        _tag: "Netjoin",
        channel: "#iirc",
        nicks: ["bob"],
        servers: ["a.net", "b.net"],
      }),
    ];

    expect({
      quiet: items.map(showsIn("quiet", "Channel", items, "me")),
      spoke: items.map(showsIn("spoke", "Channel", items, "me")),
    }).toStrictEqual({
      quiet: [true, false, false, false],
      spoke: [true, true, false, false],
    });
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

    expect(items.map(showsIn("spoke", "Channel", items, "me"))).toStrictEqual([
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
      other: writtenOnDevice("font.size", 20, false),
      otherOverridden: writtenOnDevice("font.size", 20, true),
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
