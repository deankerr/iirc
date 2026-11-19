import { Answered, ItemContent, NetworkId } from "@iirc/api";
import type { Activity, Delivery, EndReason } from "@iirc/api";
import { plainStyle } from "@iirc/protocol/format";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  attemptedText,
  contained,
  formatted,
  lineOf as lineIn,
  linkSchemes,
  mismatchedTls,
  nickColour,
  nickSlots,
  plainLimit,
  plainText,
  quotedOf,
  requested,
} from "./render.ts";
import type { Inline, Line } from "./render.ts";

const bold = { ...plainStyle, bold: true };

const libera = Schema.decodeSync(NetworkId)("libera");

const lineOf = (content: ItemContent): Line => lineIn(content, libera);

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

// A link closed by many brackets, and many embeddings closed by isolates' ends, of a size.
const brackets = (size: number) => `https://example.org/${")".repeat(size)}`;
const nested = (size: number) => `${"\u202A".repeat(size / 2)}${"\u2069".repeat(size / 2)}`;

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
    // A million characters take a fraction of a second when the work is linear. Quadratic
    // work on them is half a trillion steps, which no machine finishes inside the test's
    // limit, so the limit guards the growth without timing anything.
    const size = 1_000_000;
    const linked = formatted(brackets(size));

    expect({
      closed: contained(nested(size)).length,
      link: linked[0]?._tag === "Link" ? linked[0].href : undefined,
      rest: linked[1]?.text.length,
    }).toStrictEqual({
      closed: 1_500_000,
      link: "https://example.org/",
      rest: size,
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
    answers: null,
    at: unknown,
    context: null,
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
 * A standard reply's line, about `PRIVMSG` with a hostile code.
 * @param kind - `FAIL`, `WARN`, or `NOTE`.
 * @param context - Its context.
 * @param description - Its description.
 * @returns The line.
 */
const reply = (kind: "FAIL" | "WARN" | "NOTE", context: readonly string[], description: string) =>
  lineOf(
    activity({
      _tag: "StandardReply",
      code: "CODE\u202E",
      command: "PRIVMSG",
      context,
      description,
      kind,
    })
  );

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

            case "Command": {
              return `\`${part.text}\``;
            }

            case "Join": {
              return `[join ${part.channel} on ${part.network}]`;
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

const failed = (host: string, port: number, tls: boolean, reason: EndReason, opened = true) =>
  read(
    lineOf(content({ _tag: "ConnectionFailed", at: 0, ircd: { host, port, tls }, opened, reason }))
  );

const closed = (reason: "Ended" | "Refused" | "Tls" | "Reset" | "TimedOut") =>
  ({ _tag: "Closed", reason }) as const;

/**
 * What stands in the senders' column for an item described, or that it is a Message.
 * @param shown - The item's content.
 * @returns Its marker.
 */
const markerOf = (shown: ItemContent) => {
  const line = lineOf(shown);

  return line._tag === "Description" ? line.marker : "a Message";
};

describe("lines", () => {
  it("shows a Message by its sender, in their colour", () => {
    expect(lineOf(message("peer", "\u0002hi"))).toStrictEqual({
      _tag: "Message",
      colour: nickColour("peer"),
      context: undefined,
      delivered: undefined,
      delivery: undefined,
      kind: "Privmsg",
      nick: "peer",
      text: [{ _tag: "Text", style: bold, text: "hi" }],
    });
  });

  it("says which Channel a Direct Message is about, contained, and nothing for one that names none", () => {
    const about = lineOf(
      content({
        _tag: "Message",
        answers: null,
        at: unknown,
        context: "#iirc\u202E",
        id: unknown,
        kind: "Privmsg",
        live: true,
        ours: null,
        sender: "peer",
        tags: [],
        target: "iirc",
        text: "hi",
      })
    );

    expect(about._tag === "Message" ? about.context : "not a Message").toBe(
      contained("#iirc\u202E")
    );
  });

  it("quotes what a reply answers: its sender in their colour, how it was said, and its text as one plain line", () => {
    const answered = Schema.decodeSync(Answered)({
      kind: "Action",
      position: "20000000000000-00000000000001-00000000",
      sender: "al\u202Eice",
      text: "\u0002waves\u0002 hello\u202E",
    });

    expect(quotedOf(answered)).toStrictEqual({
      colour: nickColour("al\u202Eice"),
      kind: "Action",
      nick: contained("al\u202Eice"),
      position: answered.position,
      text: plainText("waves hello"),
    });
  });

  it("shows how one of ours stands, saying nothing once confirmed or while it cannot be, and the Ircd's own text once confirmed", () => {
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
        // With no `echo-message` it stays so for good, which is ordinary, so nothing is said.
        ["Unconfirmed", undefined],
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

  it("marks each Activity in the senders' column as WeeChat does, and a Session not at all", () => {
    expect([
      markerOf(activity({ _tag: "Joined", channel: "#iirc", nick: "peer" })),
      markerOf(activity({ _tag: "Parted", channel: "#iirc", nick: "peer", reason: null })),
      markerOf(activity({ _tag: "Quit", nick: "peer", reason: null })),
      markerOf(
        activity({ _tag: "Kicked", by: "op", channel: "#iirc", nick: "peer", reason: null })
      ),
      markerOf(activity({ _tag: "NickChanged", from: "peer", to: "peer2" })),
      markerOf(activity({ _tag: "TopicChanged", by: "op", channel: "#iirc", topic: null })),
      markerOf(activity({ _tag: "AwayChanged", away: null, nick: "peer" })),
      markerOf(activity({ _tag: "AccountChanged", account: "peerly", nick: "peer" })),
      markerOf(content({ _tag: "SessionBegan", at: 0, nick: "iirc" })),
      markerOf(message("peer", "hi")),
    ]).toStrictEqual(["-->", "<--", "<--", "<--", "--", "--", "--", "--", undefined, "a Message"]);
  });

  it("marks a numeric by its number, and draws its parameters as said text with links", () => {
    const numeric = activity({
      _tag: "Numeric",
      numeric: "251",
      params: ["There are 3 users", "\u0002see\u0002 https://example.test/x"],
    });

    const line = lineOf(numeric);

    expect(line._tag === "Description" && [line.marker, line.tone]).toStrictEqual([
      "251",
      "Numeric",
    ]);
    expect(line._tag === "Description" && line.parts).toStrictEqual([
      {
        _tag: "Said",
        inlines: formatted("There are 3 users \u0002see\u0002 https://example.test/x"),
      },
    ]);
    expect(
      line._tag === "Description" &&
        line.parts.some(
          (part) => part._tag === "Said" && part.inlines.some((inline) => inline._tag === "Link")
        )
    ).toBeTruthy();
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
      activity({ _tag: "AccountChanged", account: "peerly", nick: "peer" }),
      activity({ _tag: "AccountChanged", account: null, nick: "peer" }),
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
      "<peer> logged in as peerly",
      "<peer> logged out",
    ]);
  });

  it("shows a standard reply by its kind, command, code, context, and description, a FAIL as refused", () => {
    expect(
      [
        reply("WARN", ["#iirc"], "\u0002Modified"),
        reply("NOTE", [], ""),
        reply("FAIL", ["a\u0007", "b"], "Nope"),
      ].map((line) => [
        line._tag === "Description" && line.tone,
        line._tag === "Description" && line.marker,
        read(line),
      ])
    ).toStrictEqual([
      ["Activity", "--", "WARN PRIVMSG CODE\u202E\u202C #iirc: Modified"],
      ["Activity", "--", "NOTE PRIVMSG CODE\u202E\u202C"],
      ["Refused", "--", "FAIL PRIVMSG CODE\u202E\u202C a\u2407 b: Nope"],
    ]);
  });

  it("shows a CTCP request with the answer sent or why none was, a reply, its text only as text, and an answer that never left", () => {
    const ctcp = { args: "", command: "VERSION", nick: "peer", target: "iirc" };

    expect(
      [
        activity({ _tag: "CtcpRequest", ...ctcp, answer: { _tag: "Answered", text: "iirc" } }),
        activity({
          _tag: "CtcpRequest",
          ...ctcp,
          answer: { _tag: "Unanswered", reason: "Limited" },
          args: "\u0002x\u202E",
          command: "PING",
        }),
        activity({ _tag: "CtcpReply", ...ctcp, args: "irssi 1.4", roundTrip: null }),
        activity({ _tag: "CtcpUnsent", command: "VERSION", nick: "peer", target: "iirc" }),
        activity({ _tag: "CtcpSent", args: "", command: "VERSION", nick: "peer" }),
        activity({ _tag: "CtcpSent", args: "are you there", command: "FINGER", nick: "peer" }),
        activity({ _tag: "CtcpSent", args: "1767225600000", command: "PING", nick: "peer" }),
        activity({
          _tag: "CtcpReply",
          ...ctcp,
          args: "1767225600000",
          command: "PING",
          roundTrip: 250,
        }),
        activity({ _tag: "CtcpReply", ...ctcp, args: "x", command: "PING", roundTrip: 61_005 }),
        activity({ _tag: "CtcpReply", ...ctcp, args: "x", command: "PING", roundTrip: 0 }),
        activity({ _tag: "CtcpReply", ...ctcp, args: "forged", command: "PING", roundTrip: null }),
      ].map((each) => {
        const line = lineOf(each);

        return [
          line._tag === "Description" && line.tone,
          line._tag === "Description" && line.marker,
          read(line),
        ];
      })
    ).toStrictEqual([
      ["Activity", "--", "<peer> asked for VERSION, answered iirc"],
      ["Activity", "--", "<peer> asked for PING x\u202E\u202C, not answered: too many requests"],
      ["Activity", "--", "<peer> replied to VERSION: irssi 1.4"],
      ["Refused", "--", "<peer> asked for VERSION, the answer never left"],
      ["Activity", "--", "You asked <peer> for VERSION"],
      ["Activity", "--", "You asked <peer> for FINGER are you there"],
      ["Activity", "--", "You asked <peer> for PING 1767225600000"],
      ["Activity", "--", "<peer> replied to PING in 0.250 s"],
      ["Activity", "--", "<peer> replied to PING in 61.005 s"],
      ["Activity", "--", "<peer> replied to PING in 0.000 s"],
      ["Activity", "--", "<peer> replied to PING: forged"],
    ]);
  });

  it("shows an answer to Self's OPER by its numeric alone, a refusal as refused", () => {
    expect(
      [
        activity({ _tag: "OperGranted", nick: "iirc" }),
        activity({ _tag: "OperRefused", nick: "iirc", reply: "491" }),
      ].map((each) => {
        const line = lineOf(each);

        return [
          line._tag === "Description" && line.tone,
          line._tag === "Description" && line.marker,
          read(line),
        ];
      })
    ).toStrictEqual([
      ["Activity", "--", "<iirc> is now an IRC operator"],
      ["Refused", "--", "<iirc> was refused as an IRC operator (491)"],
    ]);
  });

  it("shows a partner coming and going as arriving and leaving, in a few words", () => {
    expect(
      [
        activity({ _tag: "CameOnline", nick: "peer" }),
        activity({ _tag: "WentOffline", nick: "peer" }),
      ].map((each) => {
        const line = lineOf(each);

        return [line._tag === "Description" && line.marker, read(line)];
      })
    ).toStrictEqual([
      ["-->", "<peer> is online"],
      ["<--", "<peer> went offline"],
    ]);
  });

  it("shows an invitation by who invited and where, with an offer to join that Channel", () => {
    const line = lineOf(activity({ _tag: "Invited", by: "peer", channel: "#elsewhere" }));

    expect([
      line._tag === "Description" && line.tone,
      line._tag === "Description" && line.marker,
      read(line),
    ]).toStrictEqual([
      "Activity",
      "--",
      "<peer> invited you to #elsewhere [join #elsewhere on libera]",
    ]);
  });

  it("offers to join the Channel as the Network said it, and shows its name contained", () => {
    const line = lineOf(activity({ _tag: "Invited", by: "peer", channel: "#a\u202Eb" }));

    expect(line._tag === "Description" ? line.parts : []).toContainEqual({
      _tag: "Join",
      channel: "#a\u202Eb",
      network: libera,
    });
    expect(read(line)).toContain("#a\u202Eb\u202C ");
  });

  it("describes a Session's start and end, and a failed Connection, never in an Ircd's words", () => {
    const wire: readonly (typeof ItemContent.Encoded)[] = [
      { _tag: "SessionBegan", at: 0, nick: "iirc" },
      { _tag: "SessionEnded", at: 0, reason: { _tag: "Closed", reason: "Reset" } },
      {
        _tag: "ConnectionFailed",
        at: 0,
        ircd: { host: "irc.test", port: 6697, tls: true },
        opened: false,
        reason: { _tag: "Closed", reason: "Refused" },
      },
    ];

    expect(
      wire
        .map((one) => lineOf(content(one)))
        .map((line) => [line._tag === "Description" && line.tone, read(line)])
    ).toStrictEqual([
      ["Session", "Connected as <iirc>"],
      ["Session", "Disconnected: the connection was reset"],
      ["Session", "Could not connect to irc.test/6697: the connection was refused"],
    ]);
  });

  it("hints at TLS the other way, by the port and how the Connection ended alone", () => {
    expect([
      failed("irc.example.net", 6697, false, closed("Ended")),
      failed("irc.example.net", 6697, false, { _tag: "Silent" }),
      failed("irc.example.net", 6667, true, closed("Tls"), false),
      failed("irc.example.net", 6697, false, closed("Refused"), false),
      failed("irc.example.net", 6697, false, closed("TimedOut"), false),
      failed("irc.example.net", 6697, false, closed("Reset"), false),
      failed("irc.example.net", 6667, true, closed("Reset")),
      failed("irc.example.net", 7000, false, closed("Ended")),
      failed("irc.example.net", 6697, true, closed("Tls")),
    ]).toStrictEqual([
      "Could not connect to irc.example.net/6697 plain: the Ircd closed the connection. Port 6697 is usually TLS: try `/set network.libera.ircds irc.example.net/6697`",
      "Could not connect to irc.example.net/6697 plain: the Ircd stopped answering. Port 6697 is usually TLS: try `/set network.libera.ircds irc.example.net/6697`",
      "Could not connect to irc.example.net/6667: TLS failed. Port 6667 is usually plaintext: try `/set network.libera.ircds irc.example.net/6667 plain`",
      "Could not connect to irc.example.net/6697 plain: the connection was refused",
      "Could not connect to irc.example.net/6697 plain: the connection timed out",
      "Could not connect to irc.example.net/6697 plain: the connection was reset",
      "Could not connect to irc.example.net/6667: the connection was reset",
      "Could not connect to irc.example.net/7000 plain: the Ircd closed the connection",
      "Could not connect to irc.example.net/6697: TLS failed",
    ]);
    expect(
      mismatchedTls({
        ircd: { host: "a", port: 6697, tls: false },
        opened: true,
        reason: { _tag: "Disabled" },
      })
    ).toBeUndefined();
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
      refused(
        { _tag: "Ctcp", command: "VERSION", nick: "nobody" },
        { _tag: "Rejected", reply: "401" }
      ),
      refused({ _tag: "Ping", nick: "peer" }, { _tag: "Unsent" }),
      refused({ _tag: "Part", channel: "#iirc" }, { _tag: "Unsent" }),
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
      ["Refused", "Your CTCP VERSION to <nobody> was refused (401)"],
      ["Refused", "Your PING of <peer> was not sent: its connection ended first"],
      ["Refused", "Your leaving of #iirc was not sent: its connection ended first"],
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
      attemptedText(requested({ _tag: "Ctcp", args: "secret", command: "finger", nick: "peer" })),
      attemptedText(requested({ _tag: "Ping", nick: "peer" })),
      attemptedText(requested({ _tag: "Part", channel: "#iirc", reason: "secret" })),
    ]).toStrictEqual([
      "Your mode change +ov-k on #iirc",
      "Your raw WHOIS",
      "Marking you back",
      "Your CTCP FINGER to peer",
      "Your PING of peer",
      "Your leaving of #iirc",
    ]);
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
