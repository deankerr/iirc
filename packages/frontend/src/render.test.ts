import { ItemContent } from "@iirc/api";
import type { Activity, Delivery } from "@iirc/api";
import { plainStyle } from "@iirc/protocol/format";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  attemptedText,
  contained,
  formatted,
  lineOf,
  linkSchemes,
  nickColour,
  nickSlots,
  plainLimit,
  plainText,
  requested,
} from "./render.ts";
import type { Inline, Line } from "./render.ts";

const bold = { ...plainStyle, bold: true };

const texts = (inlines: readonly Inline[]) => inlines.map((inline) => inline.text).join("");

// The bidirectional formatting characters, by what they do.
const opensEmbedding = new Set([0x20_2a, 0x20_2b, 0x20_2d, 0x20_2e]);
const opensIsolate = new Set([0x20_66, 0x20_67, 0x20_68]);

/**
 * Whether text closes every embedding, override, and isolate it opens, so nothing after it
 * is reordered by it.
 * @param text - The text.
 * @returns Whether it does.
 */
const balanced = (text: string): boolean => {
  const open: number[] = [];

  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;

    if (opensEmbedding.has(code) || opensIsolate.has(code)) {
      open.push(code);
    } else if (code === 0x20_2c && opensEmbedding.has(open.at(-1) ?? 0)) {
      open.pop();
    } else if (code === 0x20_69) {
      const isolate = open.findLastIndex((opened) => opensIsolate.has(opened));

      if (isolate !== -1) {
        open.length = isolate;
      }
    }
  }

  return open.length === 0;
};

// oxlint-disable-next-line no-control-regex -- the controls no shown text may hold
const controls = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u;

// Any text, weighted towards what hostile text uses: formatting codes, controls, bidi
// characters, and the pieces of links.
const hostile = fc
  .array(
    fc.oneof(
      fc.string({ unit: "grapheme" }),
      fc.constantFrom(
        "\u0002",
        "\u0003",
        "\u000304,12",
        "\u0004ff0000",
        "\u000F",
        "\u0016",
        "\u001D",
        "\u0000",
        "\u0007",
        "\n",
        "\r",
        "\u007F",
        "\u0085",
        "\u2028",
        "\u202A",
        "\u202B",
        "\u202C",
        "\u202D",
        "\u202E",
        "\u2066",
        "\u2067",
        "\u2068",
        "\u2069",
        "\u200F",
        "\uD800",
        "https://",
        "http://example.com/a(b)c",
        // oxlint-disable-next-line no-script-url -- hostile text, which must never become a link
        "javascript:alert(1)",
        "irc://irc.example.net/#iirc",
        "data:text/html,x",
        " ",
        ").",
        "<script>"
      )
    ),
    { maxLength: 30 }
  )
  .map((parts) => parts.join(""));

describe("formatted text", () => {
  it("reads mIRC formatting into styles, as data", () => {
    expect(formatted("\u0002bold\u0002 and \u000304red\u0003")).toStrictEqual([
      { _tag: "Text", style: bold, text: "bold" },
      { _tag: "Text", style: plainStyle, text: " and " },
      {
        _tag: "Text",
        style: { ...plainStyle, foreground: { _tag: "Palette", index: 4 } },
        text: "red",
      },
    ]);
  });

  it("finds links of the schemes it allows, and leaves the rest as text", () => {
    expect(
      formatted(
        "see https://example.com/a?b=1, (http://example.com/x_(y)) irc://irc.example.net/#c javascript:alert(1) data:text/html,x ftp://example.com"
      )
    ).toStrictEqual([
      { _tag: "Text", style: plainStyle, text: "see " },
      {
        _tag: "Link",
        href: "https://example.com/a?b=1",
        style: plainStyle,
        text: "https://example.com/a?b=1",
      },
      { _tag: "Text", style: plainStyle, text: ", (" },
      {
        _tag: "Link",
        href: "http://example.com/x_(y)",
        style: plainStyle,
        text: "http://example.com/x_(y)",
      },
      { _tag: "Text", style: plainStyle, text: ") " },
      {
        _tag: "Link",
        href: "irc://irc.example.net/#c",
        style: plainStyle,
        text: "irc://irc.example.net/#c",
      },
      {
        _tag: "Text",
        style: plainStyle,
        text: " javascript:alert(1) data:text/html,x ftp://example.com",
      },
    ]);
  });

  it("keeps a link's style, and gives its href as the URL parser writes it", () => {
    expect(formatted("\u0002HTTPS://Example.COM/Path\u0002")).toStrictEqual([
      {
        _tag: "Link",
        href: "https://example.com/Path",
        style: bold,
        text: "HTTPS://Example.COM/Path",
      },
    ]);
  });

  it("ends a link at a control or a bidirectional character, so neither is ever in one", () => {
    expect(formatted("https://a.example/\u202Egnp.exe")).toStrictEqual([
      { _tag: "Link", href: "https://a.example/", style: plainStyle, text: "https://a.example/" },
      { _tag: "Text", style: plainStyle, text: "\u202Egnp.exe\u202C" },
    ]);
  });

  it("shows control characters as symbols", () => {
    expect(texts(formatted("a\u0000b\u0007c\u007Fd\u0085e\u2028f"))).toBe(
      "a\u2400b\u2407c\u2421d\uFFFDe\u2424f"
    );
  });

  it("closes the bidirectional formatting each run opens", () => {
    expect({
      embedding: contained("\u202Eevil"),
      isolate: contained("\u2067a\u202Bb"),
      popped: contained("\u202Aa\u202Cb"),
      stray: contained("\u202C\u2069a"),
    }).toStrictEqual({
      embedding: "\u202Eevil\u202C",
      isolate: "\u2067a\u202Bb\u202C\u2069",
      popped: "\u202Aa\u202Cb",
      stray: "\u202C\u2069a",
    });
  });

  it("formats a very long line in one piece, keeping all of it", () => {
    const long = `${"word ".repeat(20_000)}https://example.com/${"x".repeat(50_000)}`;
    const inlines = formatted(long);

    expect({
      kinds: inlines.map((inline) => inline._tag),
      length: texts(inlines).length,
    }).toStrictEqual({ kinds: ["Text", "Link"], length: long.length });
  });

  it("trims a link's hostile brackets and closes deep bidi formatting in linear time", () => {
    // Quadratic work over these takes seconds; linear, a few milliseconds.
    const brackets = `https://example.org/${")".repeat(64_000)}`;
    const nested = `${"\u202A".repeat(30_000)}${"\u2069".repeat(30_000)}`;

    // oxlint-disable-next-line no-restricted-globals -- a test of how long the work takes
    const started = performance.now();
    const linked = formatted(brackets);
    const closed = contained(nested);
    // oxlint-disable-next-line no-restricted-globals -- a test of how long the work takes
    const took = performance.now() - started;

    expect({
      closed: closed.length,
      fast: took < 500,
      link: linked[0]?._tag === "Link" ? linked[0].href : undefined,
      rest: linked[1]?.text.length,
    }).toStrictEqual({
      closed: 90_000,
      fast: true,
      link: "https://example.org/",
      rest: 64_000,
    });
  });

  it("never throws, and holds only text: no control, balanced bidi, and safe links", () => {
    fc.assert(
      fc.property(hostile, (text) => {
        const inlines = formatted(text);

        expect(
          inlines.every(
            (inline) =>
              !controls.test(inline.text) &&
              balanced(inline.text) &&
              (inline._tag === "Text" ||
                (linkSchemes.has(new URL(inline.href).protocol) && !controls.test(inline.href)))
          )
        ).toBeTruthy();
      }),
      { numRuns: 2000 }
    );
  });
});

describe("nick colours", () => {
  it("gives a nick the same slot every time, whatever its case under RFC 1459", () => {
    expect({
      again: nickColour("Alice") === nickColour(["Al", "ice"].join("")),
      folded: nickColour("Ali[ce]") === nickColour("ali{CE}"),
    }).toStrictEqual({ again: true, folded: true });
  });

  it("gives a slot in range for any nick, spread over every slot", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (nick) => {
        const slot = nickColour(nick);

        return Number.isInteger(slot) && slot >= 0 && slot < nickSlots;
      })
    );

    const used = new Set(Array.from({ length: 500 }, (_, index) => nickColour(`user${index}`)));

    expect(used.size).toBe(nickSlots);
  });

  it("is the same slot on every run, so it can be checked against a constant", () => {
    expect([nickColour("iirc"), nickColour("peer"), nickColour("")]).toStrictEqual([
      nickColour("IIRC"),
      nickColour("PEER"),
      0x81_1c_9d_c5 % nickSlots,
    ]);
  });
});

const content = Schema.decodeSync(ItemContent);
const unknown = { _tag: "Unknown" } as const;

/**
 * A Message from a sender, parsed as the API parses it.
 * @param sender - Who said it.
 * @param text - What they said.
 * @param delivery - Its delivery, for one of ours.
 * @returns The content.
 */
const message = (sender: string, text: string, delivery?: typeof Delivery.Encoded): ItemContent =>
  content({
    _tag: "Message",
    at: unknown,
    id: unknown,
    kind: "Privmsg",
    live: true,
    ours: delivery === undefined ? null : { delivery, intent: "i1" },
    sender,
    tags: [],
    target: "#iirc",
    text,
  });

/**
 * An Activity, parsed as the API parses it.
 * @param activity - The Activity, as the wire has it.
 * @returns The content.
 */
const activity = (activity: typeof Activity.Encoded): ItemContent =>
  content({ _tag: "Activity", activity, at: unknown, id: unknown, live: true });

/**
 * A line's words, with each nick in angle brackets, as a reader would see it.
 * @param line - The line.
 * @returns Its words.
 */
const read = (line: Line): string =>
  line._tag === "Message"
    ? `<${line.nick}> ${texts(line.text)}`
    : line.parts
        .map((part) => {
          switch (part._tag) {
            case "Nick": {
              return `<${part.nick}>`;
            }

            case "Said": {
              return texts(part.inlines);
            }

            case "Name":
            case "Words": {
              return part.text;
            }

            default: {
              return part satisfies never;
            }
          }
        })
        .join("");

/** An action refused, as the wire carries it. */
type ActionRefusedOnWire = Extract<typeof ItemContent.Encoded, { readonly _tag: "ActionRefused" }>;

const rejected482: ActionRefusedOnWire["reason"] = { _tag: "Rejected", reply: "482" };

/**
 * An action's refusal, as an item shows it.
 * @param attempted - What it tried.
 * @param reason - Why it was refused.
 * @returns The item's content, on the wire.
 */
const refused = (
  attempted: ActionRefusedOnWire["attempted"],
  reason: ActionRefusedOnWire["reason"] = rejected482
): typeof ItemContent.Encoded => ({
  _tag: "ActionRefused",
  at: 0,
  attempted,
  intent: "i1",
  reason,
});

describe("lines", () => {
  it("shows a Message by its sender, in their colour", () => {
    expect(lineOf(message("peer", "\u0002hi"))).toStrictEqual({
      _tag: "Message",
      colour: nickColour("peer"),
      delivered: undefined,
      delivery: undefined,
      kind: "Privmsg",
      nick: "peer",
      text: [{ _tag: "Text", style: bold, text: "hi" }],
    });
  });

  it("shows how one of ours stands, and the Ircd's own text once it confirmed it", () => {
    const pending = lineOf(message("iirc", "hello", { _tag: "Pending" }));

    const confirmed = lineOf(
      message("iirc", "hello", { _tag: "Confirmed", at: unknown, id: unknown, text: "hello!" })
    );

    const others = [
      { _tag: "Unconfirmed" },
      { _tag: "Unsent" },
      { _tag: "Rejected", reply: "404\u202E" },
    ] as const;

    expect({
      confirmed: confirmed._tag === "Message" && [
        confirmed.delivery,
        confirmed.delivered,
        texts(confirmed.text),
      ],
      others: others
        .map((delivery) => lineOf(message("iirc", "hello", delivery)))
        .map((line) => line._tag === "Message" && [line.delivery, line.delivered]),
      pending: pending._tag === "Message" && [pending.delivery, pending.delivered],
    }).toStrictEqual({
      confirmed: ["Confirmed", undefined, "hello!"],
      others: [
        ["Unconfirmed", "unconfirmed"],
        ["Unsent", "not sent"],
        // The Ircd's code is contained, as any text it sends is.
        ["Rejected", "refused: 404\u202E\u202C"],
      ],
      pending: ["Pending", "sending"],
    });
  });

  it("keeps a hostile nick from reordering the line", () => {
    const line = lineOf(message("\u202Eevil\u0007", "x"));

    expect(line._tag === "Message" && line.nick).toBe("\u202Eevil\u2407\u202C");
  });

  it("describes each Activity in a few words", () => {
    const described = [
      activity({ _tag: "Joined", channel: "#iirc", nick: "peer" }),
      activity({ _tag: "Parted", channel: "#iirc", nick: "peer", reason: "\u0002bye" }),
      activity({ _tag: "Quit", nick: "peer", reason: null }),
      activity({ _tag: "Kicked", by: "op", channel: "#iirc", nick: "peer", reason: "spam" }),
      activity({ _tag: "NickChanged", from: "peer", to: "peer2" }),
      activity({
        _tag: "TopicChanged",
        by: "op",
        channel: "#iirc",
        topic: { setAt: null, setBy: null, text: "welcome" },
      }),
      activity({ _tag: "TopicChanged", by: "op", channel: "#iirc", topic: null }),
      activity({
        _tag: "ModeChanged",
        by: "op",
        changes: [
          { mode: "o", param: "peer", set: true },
          { mode: "m", param: null, set: false },
        ],
        target: "#iirc",
      }),
      activity({ _tag: "AwayChanged", away: { message: "lunch" }, nick: "peer" }),
      activity({ _tag: "AwayChanged", away: null, nick: "peer" }),
    ].map((content) => read(lineOf(content)));

    expect(described).toStrictEqual([
      "<peer> joined #iirc",
      "<peer> left #iirc (bye)",
      "<peer> quit",
      "<op> kicked <peer> from #iirc (spam)",
      "<peer> is now <peer2>",
      "<op> set the topic of #iirc: welcome",
      "<op> cleared the topic of #iirc",
      "<op> set +o peer -m on #iirc",
      "<peer> is away: lunch",
      "<peer> is back",
    ]);
  });

  it("describes a Session's start and end, and a failed Connection, never in an Ircd's words", () => {
    const wire: readonly (typeof ItemContent.Encoded)[] = [
      { _tag: "SessionBegan", at: 0, nick: "iirc" },
      { _tag: "SessionEnded", at: 0, reason: { _tag: "Closed", reason: "Reset" } },
      { _tag: "ConnectionFailed", at: 0, reason: { _tag: "Closed", reason: "Refused" } },
    ];

    expect(
      wire
        .map((one) => lineOf(content(one)))
        .map((line) => [line._tag === "Description" && line.tone, read(line)])
    ).toStrictEqual([
      ["Session", "Connected as <iirc>"],
      ["Session", "Disconnected: the connection was reset"],
      ["Session", "Could not connect: the connection was refused"],
    ]);
  });

  it("describes a refused action calmly, by what it tried and the Ircd's code, never its text", () => {
    const wire: readonly (typeof ItemContent.Encoded)[] = [
      refused({ _tag: "Topic", channel: "#iirc" }),
      refused({ _tag: "Kick", channel: "#iirc", nicks: ["a", "b"] }, { _tag: "Unsent" }),
      refused({ _tag: "Mode", modes: "+o-v", target: "#iirc" }),
      refused(
        { _tag: "Invite", channel: "#iirc", nick: "peer" },
        { _tag: "Rejected", reply: "443" }
      ),
      refused({ _tag: "Nick", nick: "taken" }, { _tag: "Rejected", reply: "433" }),
      refused({ _tag: "Away", away: true }, { _tag: "Unsent" }),
      refused({ _tag: "Raw", command: "FROB" }, { _tag: "Rejected", reply: "421" }),
      refused({ _tag: "Raw", command: null }, { _tag: "Rejected", reply: "\u202E1" }),
    ];

    expect(
      wire
        .map((one) => lineOf(content(one)))
        .map((line) => [line._tag === "Description" && line.tone, read(line)])
    ).toStrictEqual([
      ["Refused", "Your topic change for #iirc was refused (482)"],
      ["Refused", "Your kick of <a>, <b> from #iirc was not sent: its connection ended first"],
      ["Refused", "Your mode change +o-v on #iirc was refused (482)"],
      ["Refused", "Your invite of <peer> to #iirc was refused (443)"],
      ["Refused", "Your nick change to <taken> was refused (433)"],
      ["Refused", "Marking you away was not sent: its connection ended first"],
      ["Refused", "Your raw FROB was refused (421)"],
      ["Refused", "Your raw line was refused (\u202E1\u202C)"],
    ]);
  });

  it("says what an action asked for as the Client would summarise it", () => {
    expect([
      attemptedText(
        requested({
          _tag: "Mode",
          changes: [
            { mode: "o", param: "a", set: true },
            { mode: "v", param: "b", set: true },
            { mode: "k", param: "secret", set: false },
          ],
          target: "#iirc",
        })
      ),
      attemptedText(requested({ _tag: "Raw", line: "@+x=y whois peer" })),
      attemptedText(requested({ _tag: "Away", message: "" })),
    ]).toStrictEqual(["Your mode change +ov-k on #iirc", "Your raw WHOIS", "Marking you back"]);
  });
});

/**
 * What plain text holds inside its isolate.
 * @param text - The plain text.
 * @returns Its body.
 */
const inside = (text: string) => text.slice(1, -1);

/**
 * Text's characters, one per code point, as plain text counts them.
 * @param text - The text.
 * @returns Its characters.
 */
// oxlint-disable-next-line typescript/no-misused-spread -- plain text is cut by code point, so the test counts by code point.
const characters = (text: string): readonly string[] => [...text];

describe("plain text, for a notification", () => {
  it("strips formatting and controls, drops bidi formatting, and isolates the whole", () => {
    expect([
      plainText("\u0002bold\u0002 \u000304,12red\u0003 \u001Ditalic\u000F"),
      plainText("a\u0000b\u0007c\u007Fd\u0085e\nf\rg"),
      plainText("\u202Eevil\u202C \u2067rtl\u2069 \u200Fmark \u061Calm"),
      plainText("one\u2028two\u2029three"),
      plainText("lone \uD800 surrogate"),
    ]).toStrictEqual([
      "\u2068bold red italic\u2069",
      "\u2068abcdefg\u2069",
      "\u2068evil rtl mark alm\u2069",
      "\u2068one two three\u2069",
      "\u2068lone  surrogate\u2069",
    ]);
  });

  it("cuts long text with an ellipsis, never through a character", () => {
    const emoji = "\u{1F600}".repeat(plainLimit + 5);
    const cut = characters(inside(plainText(emoji)));

    expect({
      exact: inside(plainText("x".repeat(plainLimit))).length,
      last: cut.at(-1),
      length: cut.length,
      long: inside(plainText("x".repeat(70_000))).length,
      whole: cut.slice(0, -1).every((character) => character === "\u{1F600}"),
    }).toStrictEqual({
      exact: plainLimit,
      last: "\u2026",
      length: plainLimit,
      long: plainLimit,
      whole: true,
    });
  });

  it("holds no control, bidi formatting, or lone surrogate inside its isolate, for any text", () => {
    const unsafe =
      // oxlint-disable-next-line no-control-regex -- the controls are what must never be there
      /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

    fc.assert(
      fc.property(hostile, (text) => {
        const shown = plainText(text);
        const body = inside(shown);

        expect({
          isolated: shown.startsWith("\u2068") && shown.endsWith("\u2069"),
          safe: !unsafe.test(body) && body.isWellFormed(),
          short: characters(body).length <= plainLimit,
        }).toStrictEqual({ isolated: true, safe: true, short: true });
      }),
      { numRuns: 2000 }
    );
  });
});
