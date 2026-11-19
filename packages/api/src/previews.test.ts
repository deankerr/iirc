import { Instant } from "@iirc/client";
import { cursorOf } from "@iirc/timelines";
import { Option, Schema } from "effect";
import { OpenApi } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { DaemonApi } from "./api.ts";
import {
  MessagePreviews,
  PreviewId,
  PreviewItem,
  PreviewState,
  PreviewsEvent,
  PreviewsRequest,
  PressRequest,
} from "./previews.ts";
import { PlayerHost, UiOptions, mutedCap, uiDefaults, uiSharedOnly } from "./ui.ts";

const id = "0123456789abcdef0123456789abcdef";

const page = {
  description: "A page about cats.",
  image: null,
  kind: "page",
  link: "https://example.com/cats",
  media: null,
  player: null,
  site: "example.com",
  title: "Cats",
  type: null,
} as const;

const states = [
  { _tag: "Pending" },
  { _tag: "Ready", preview: page },
  {
    _tag: "Ready",
    preview: {
      description: null,
      image: {
        animated: false,
        hash: "a".repeat(64),
        size: 1024,
        type: "image/png",
      },
      kind: "image",
      link: "https://example.com/cat.png",
      media: null,
      player: null,
      site: "example.com",
      title: null,
      type: "image/png",
    },
  },
  {
    _tag: "Ready",
    preview: {
      ...page,
      kind: "player",
      player: {
        link: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
        size: { height: 720, width: 1280 },
      },
    },
  },
  {
    _tag: "Ready",
    preview: {
      ...page,
      kind: "player",
      player: { link: "https://player.vimeo.com/video/1", size: null },
    },
  },
  {
    _tag: "Ready",
    preview: {
      ...page,
      kind: "video",
      media: "https://cdn.example/clip.mp4?Signature=abc",
      type: "video/mp4",
    },
  },
  { _tag: "WaitingForPress" },
  { _tag: "Failed", reason: "Refused" },
  { _tag: "Failed", reason: "Unreachable" },
  { _tag: "Failed", reason: "TimedOut" },
  { _tag: "Failed", reason: "TooLarge" },
  { _tag: "Failed", reason: "NothingToShow" },
] as const;

describe("Previews on the wire", () => {
  it("carries an item in each state, and the Preview whole, as the same JSON both ways", () => {
    const items = states.map((state) => ({ id, link: "https://example.com/cats", state }));
    const decoded = items.map((item) => Schema.decodeSync(PreviewItem)(item));

    expect(decoded.map((item) => Schema.encodeSync(PreviewItem)(item))).toStrictEqual(items);
    expect(Schema.encodeSync(MessagePreviews)({ previews: decoded })).toStrictEqual({
      previews: items,
    });
  });

  it("refuses a reason, a kind, or a state it does not name, and a Preview missing a field", () => {
    const state = Schema.decodeUnknownOption(PreviewState);

    expect(
      [
        { _tag: "Failed", reason: "Gone" },
        { _tag: "Failed" },
        { _tag: "Ready", preview: { ...page, kind: "embed" } },
        { _tag: "Ready", preview: { ...page, site: null } },
        {
          _tag: "Ready",
          preview: { ...page, image: { animated: false, hash: "A", size: 1, type: "image/png" } },
        },
        {
          _tag: "Ready",
          preview: {
            ...page,
            image: { animated: false, hash: "a".repeat(64), size: 1, type: "image/bmp" },
          },
        },
        { _tag: "Ready", preview: { description: null, kind: "page", link: page.link, site: "x" } },
        { _tag: "Ready", preview: { ...page, media: undefined } },
        { _tag: "Ready", preview: { ...page, player: undefined } },
        { _tag: "Ready", preview: { ...page, player: { link: page.link } } },
        {
          _tag: "Ready",
          preview: { ...page, player: { link: page.link, size: { height: 0, width: 640 } } },
        },
        {
          _tag: "Ready",
          preview: { ...page, player: { link: page.link, size: { height: 360.5, width: 640 } } },
        },
        { _tag: "Loading" },
      ].map((each) => Option.isSome(state(each)))
    ).toStrictEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("takes a Preview's id as 32 lower-case hex digits, and nothing else", () => {
    const decode = Schema.decodeUnknownOption(PreviewId);

    expect(
      [id, id.toUpperCase(), `${id}0`, id.slice(1), `../${id.slice(3)}`, ""].map((each) =>
        Option.isSome(decode(each))
      )
    ).toStrictEqual([true, false, false, false, false, false]);
  });

  it("takes a Message's place as the cursor a window gave, and nothing else", () => {
    const position = { at: Instant.make(1_762_560_000_000), n: 2, sequence: 7 };
    const decode = Schema.decodeUnknownOption(PreviewsRequest);

    expect([
      decode({ position: cursorOf(position) }),
      decode({ position: "7.2" }),
      decode({ index: 2, sequence: 7 }),
    ]).toStrictEqual([Option.some({ position }), Option.none(), Option.none()]);
  });

  it("takes a press as a Message's place and the index of one of its links, from 0", () => {
    const position = { at: Instant.make(1_762_560_000_000), n: 2, sequence: 7 };
    const decode = Schema.decodeUnknownOption(PressRequest);

    expect([
      decode({ link: 0, position: cursorOf(position) }),
      decode({ link: 2, position: cursorOf(position) }),
      decode({ link: -1, position: cursorOf(position) }),
      decode({ link: 1.5, position: cursorOf(position) }),
      decode({ link: "0", position: cursorOf(position) }),
      decode({ position: cursorOf(position) }),
      decode({ link: 0, position: "7.2" }),
    ]).toStrictEqual([
      Option.some({ link: 0, position }),
      Option.some({ link: 2, position }),
      Option.none(),
      Option.none(),
      Option.none(),
      Option.none(),
      Option.none(),
    ]);
  });

  it("says 409 to a press for a link not waiting", () => {
    const document = OpenApi.fromApi(DaemonApi);
    const press = document.paths["/api/timelines/{timeline}/previews/press"]?.post;

    expect(Object.keys(press?.responses ?? {}).toSorted()).toStrictEqual([
      "200",
      "400",
      "401",
      "403",
      "404",
      "409",
      "503",
    ]);
  });

  it("carries each change with no event id, and a heartbeat", () => {
    const item = { id, link: page.link, state: { _tag: "Ready", preview: page } };

    const wire = [
      { data: JSON.stringify(item), event: "changed" },
      { data: "{}", event: "heartbeat" },
    ];

    const decoded = wire.map((event) => Schema.decodeUnknownSync(PreviewsEvent)(event));

    expect(decoded[0]).toStrictEqual({ data: item, event: "changed" });
    expect(decoded.map((event) => Schema.encodeSync(PreviewsEvent)(event))).toStrictEqual(wire);
  });

  it("says 409 to an ask while previews are off, and 404 for a Timeline or Message it does not have", () => {
    const document = OpenApi.fromApi(DaemonApi);
    const ask = document.paths["/api/timelines/{timeline}/previews"]?.post;

    expect(Object.keys(ask?.responses ?? {}).toSorted()).toStrictEqual([
      "200",
      "400",
      "401",
      "403",
      "404",
      "409",
      "503",
    ]);
  });
});

describe("ui.previews", () => {
  it("is off, links only, or on, and the one option no device overrides", () => {
    const options = Schema.decodeUnknownOption(UiOptions);

    expect({
      sharedOnly: [...uiSharedOnly],
      taken: ["off", "links only", "on", "links", "Links Only", true].map((previews) =>
        Option.isSome(options({ ...uiDefaults, previews }))
      ),
    }).toStrictEqual({
      sharedOnly: [
        "aliases",
        "muted",
        "previews",
        "previews.players",
        "previews.timelines",
        "sidebar.networks",
        "sidebar.order",
        "sidebar.pinned",
      ],
      taken: [true, true, true, false, false, false],
    });
  });
});

describe("ui.previews.players", () => {
  it("takes host names in lower case alone, with no port, scheme, path, wildcard or space", () => {
    const host = Schema.decodeUnknownOption(PlayerHost);

    expect(
      [
        "player.vimeo.com",
        "bandcamp.com",
        "127.0.0.1",
        "xn--bcher-kva.example",
        "Player.Vimeo.com",
        "player.vimeo.com:443",
        "https://player.vimeo.com",
        "player.vimeo.com/video",
        "*.vimeo.com",
        ".vimeo.com",
        "vimeo.com.",
        "localhost",
        " player.vimeo.com",
        "player..vimeo.com",
        "-player.vimeo.com",
        "",
        `${"a".repeat(64)}.com`,
      ].map((each) => Option.isSome(host(each)))
    ).toStrictEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("takes an empty list, and refuses a list holding one host it does not take", () => {
    const options = Schema.decodeUnknownOption(UiOptions);

    expect(
      [[], ["player.vimeo.com"], ["player.vimeo.com", "*.evil.test"]].map((players) =>
        Option.isSome(options({ ...uiDefaults, "previews.players": players }))
      )
    ).toStrictEqual([true, true, false]);
  });
});

describe("ui.previews.timelines", () => {
  const timeline = "0000000000001a-00000000-00000001";
  const other = "0000000000001b-00000000-00000000";

  it("maps a Timeline's id to off, links only, or on", () => {
    const options = Schema.decodeUnknownOption(UiOptions);

    const given = (each: Schema.Json) =>
      Option.getOrNull(
        Option.map(
          options({ ...uiDefaults, "previews.timelines": each }),
          (one) => one["previews.timelines"]
        )
      );

    expect(
      [
        {},
        { [timeline]: "off" },
        { [other]: "on", [timeline]: "links only" },
        { [timeline]: "links" },
        { [timeline]: "default" },
        { [timeline]: true },
        [],
        null,
      ].map(given)
    ).toStrictEqual([
      {},
      { [timeline]: "off" },
      { [other]: "on", [timeline]: "links only" },
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("keeps no entry whose key is not a Timeline's id", () => {
    const options = Schema.decodeUnknownSync(UiOptions);

    expect(
      options({ ...uiDefaults, "previews.timelines": { "#iirc": "on", [timeline]: "off" } })[
        "previews.timelines"
      ]
    ).toStrictEqual({ [timeline]: "off" });
  });
});

describe("ui.sidebar", () => {
  it("start empty, name ids that may have gone, and refuse a list naming one twice", () => {
    const options = Schema.decodeUnknownOption(UiOptions);
    const a = "00000000000001-00000001-00000000";

    const decodes = (extra: Readonly<Record<string, readonly string[]>>) =>
      Option.isSome(options({ ...uiDefaults, ...extra }));

    expect({
      default: [
        uiDefaults["sidebar.networks"],
        uiDefaults["sidebar.order"],
        uiDefaults["sidebar.pinned"],
      ],
      gone: decodes({ "sidebar.networks": ["libera", "gone"], "sidebar.pinned": [a] }),
      twice: [
        decodes({ "sidebar.networks": ["libera", "libera"] }),
        decodes({ "sidebar.order": [a, a] }),
        decodes({ "sidebar.pinned": [a, a] }),
      ],
    }).toStrictEqual({
      default: [[], [], []],
      gone: true,
      twice: [false, false, false],
    });
  });
});

const ids = (count: number) =>
  Array.from(
    { length: count },
    (_, at) => `00000000000001-${String(at).padStart(8, "0")}-00000000`
  );

describe("ui.muted", () => {
  it("starts empty, names ids that may have gone, and refuses one named twice or past the cap", () => {
    const options = Schema.decodeUnknownOption(UiOptions);
    const decodes = (muted: readonly string[]) => Option.isSome(options({ ...uiDefaults, muted }));

    expect({
      cap: [decodes(ids(mutedCap)), decodes(ids(mutedCap + 1))],
      default: uiDefaults.muted,
      gone: decodes(ids(2)),
      twice: decodes([...ids(1), ...ids(1)]),
    }).toStrictEqual({
      cap: [true, false],
      default: [],
      gone: true,
      twice: false,
    });
  });
});
