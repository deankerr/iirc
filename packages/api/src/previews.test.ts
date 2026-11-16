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
} from "./previews.ts";
import { UiOptions, uiDefaults, uiSharedOnly } from "./ui.ts";

const id = "0123456789abcdef0123456789abcdef";

const page = {
  description: "A page about cats.",
  kind: "page",
  link: "https://example.com/cats",
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
      kind: "image",
      link: "https://example.com/cat.png",
      site: "example.com",
      title: null,
      type: "image/png",
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
        { _tag: "Ready", preview: { description: null, kind: "page", link: page.link, site: "x" } },
        { _tag: "Loading" },
      ].map((each) => Option.isSome(state(each)))
    ).toStrictEqual([false, false, false, false, false, false]);
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

  it("asks by POST beside the Timelines, and follows beside News, both behind a key or a sign-in", () => {
    const document = OpenApi.fromApi(DaemonApi);
    const ask = document.paths["/api/timelines/{timeline}/previews"]?.post;
    const follow = document.paths["/api/previews/changes"]?.get;

    expect({
      ask: ask?.security,
      follow: follow?.security,
      statuses: Object.keys(ask?.responses ?? {}).toSorted(),
    }).toStrictEqual({
      ask: [{ bearer: [] }, { signIn: [] }],
      follow: [{ bearer: [] }, { signIn: [] }],
      statuses: ["200", "400", "401", "403", "404", "409", "503"],
    });
  });
});

describe("ui.previews", () => {
  it("is off, links only, or on, off by default, and the one option no device overrides", () => {
    const options = Schema.decodeUnknownOption(UiOptions);

    expect({
      default: uiDefaults.previews,
      sharedOnly: [...uiSharedOnly],
      taken: ["off", "links only", "on", "links", "Links Only", true].map((previews) =>
        Option.isSome(options({ ...uiDefaults, previews }))
      ),
    }).toStrictEqual({
      default: "off",
      sharedOnly: ["previews"],
      taken: [true, true, true, false, false, false],
    });
  });
});
