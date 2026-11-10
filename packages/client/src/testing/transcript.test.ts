import { CredentialName } from "@iirc/protocol/line";
import { Result } from "effect";
import { describe, expect, it } from "vitest";

import ergoFeatures from "../../../../fixtures/transcripts/ergo/first-features.irc?raw";
import ergoFloor from "../../../../fixtures/transcripts/ergo/floor.irc?raw";
import ngircdFeatures from "../../../../fixtures/transcripts/ngircd/first-features.irc?raw";
import ngircdFloor from "../../../../fixtures/transcripts/ngircd/floor.irc?raw";
import { epoch, parse, print, writeInstant } from "./transcript.ts";
import type { Item } from "./transcript.ts";

const fixtures = [
  ["ergo/first-features", ergoFeatures],
  ["ergo/floor", ergoFloor],
  ["ngircd/first-features", ngircdFeatures],
  ["ngircd/floor", ngircdFloor],
] as const;

const bytes = (text: string) => new TextEncoder().encode(text);

const items = (text: string): readonly Item[] => Result.getOrThrow(parse(text));

const refusal = (text: string) => {
  const parsed = parse(text);

  return Result.isFailure(parsed) ? parsed.failure : undefined;
};

describe("the committed fixtures", () => {
  it.each(fixtures)("%s parses, and prints back to itself", (_name, text) => {
    expect(print(items(text))).toBe(text);
    expect(items(print(items(text)))).toStrictEqual(items(text));
  });

  it.each(fixtures)("%s names Credentials and never holds one", (_name, text) => {
    const sent = items(text).flatMap((item) =>
      item._tag === "Sent" ? [new TextDecoder().decode(item.bytes)] : []
    );

    expect(
      sent.filter((line) => /^(?:AUTHENTICATE|PASS) /u.test(line) && line !== "AUTHENTICATE PLAIN")
    ).toStrictEqual([]);
  });

  it("reads the SASL response as a whole SecretLine", () => {
    expect(items(ergoFeatures).filter((item) => item._tag === "SentSecret")).toStrictEqual([
      {
        _tag: "SentSecret",
        line: {
          _tag: "AuthenticatePlain",
          authcid: "iirc",
          authzid: "iirc",
          credential: CredentialName.make("iirc"),
        },
      },
    ]);
  });
});

describe("the format", () => {
  it("reads every kind of item", () => {
    const text = [
      "# a comment",
      "#",
      "",
      "!! configure",
      "!! configure +#iirc +#secret key=chankey -#old disable enable decline=multi-prefix accept=sasl",
      "-> dial irc.test:6697 tls",
      "-> dial irc.test:6667",
      "== opened",
      ">> CAP LS 302",
      "<< :irc.test CAP * LS :sasl",
      ">> {AuthenticatePlain credential=libera authcid=iirc authzid=}",
      ">> {JoinWithKey credential=chankey channel=#secret}",
      ">> {Pass credential=libera}",
      "== unfilled Missing",
      "!! say #iirc :hello",
      "!! notice peer :hi there",
      "!! action #iirc :waves",
      "!! retry",
      "!! read #iirc t+5s",
      "!! read t-1s",
      "!! configure highlights=release,iirc highlights=",
      "?? read-marker t+5s in=channel:#iirc",
      "+60s",
      "+250ms",
      "+2m",
      "== fired ping t+30s",
      "== fired old t-1500ms",
      "== started",
      "== connection 1",
      "?? ignored Malformed MODE",
      "...",
      "-> hangup",
      "== closed Reset",
      "",
    ].join("\n");

    expect(items(text).map((item) => item._tag)).toStrictEqual([
      "Comment",
      "Comment",
      "Blank",
      "Owner",
      "Owner",
      "Dial",
      "Dial",
      "Opened",
      "Sent",
      "Received",
      "SentSecret",
      "SentSecret",
      "SentSecret",
      "Unfilled",
      "Owner",
      "Owner",
      "Owner",
      "Owner",
      "Owner",
      "Owner",
      "Owner",
      "Expect",
      "Advance",
      "Advance",
      "Advance",
      "Fired",
      "Fired",
      "Started",
      "Connection",
      "Expect",
      "Any",
      "Hangup",
      "Closed",
    ]);
    expect(print(items(text))).toBe(text.replace("+2m", "+120s"));
  });

  it("reads a Read, with its Target or the Network's own", () => {
    expect(items("!! read #iirc t+5s\n!! read t-1s\n")).toStrictEqual([
      { _tag: "Owner", owner: { _tag: "Read", read: epoch + 5000, target: "#iirc" } },
      { _tag: "Owner", owner: { _tag: "Read", read: epoch - 1000, target: null } },
    ]);
  });

  it("reads Owner inputs into what they mean", () => {
    expect(
      items("!! configure +#secret key=chankey -#old decline=multi-prefix\n!! notice peer :a :b\n")
    ).toStrictEqual([
      {
        _tag: "Owner",
        owner: {
          _tag: "Configure",
          changes: [
            { _tag: "Join", channel: "#secret", key: "chankey" },
            { _tag: "Part", channel: "#old" },
            { _tag: "Decline", feature: "multi-prefix" },
          ],
        },
      },
      { _tag: "Owner", owner: { _tag: "Say", kind: "Notice", target: "peer", text: "a :b" } },
    ]);
  });

  it("writes instants against the transcript's clock", () => {
    expect(items("== fired ping t+30s\n")).toStrictEqual([
      { _tag: "Fired", due: epoch + 30_000, timer: "ping" },
    ]);
    expect(writeInstant(epoch)).toBe("t+0s");
    expect(writeInstant(epoch - 250)).toBe("t-250ms");
  });

  it("escapes bytes that would not survive as text, and reads them back", () => {
    const escaped: Item[] = [
      { _tag: "Received", bytes: new Uint8Array([0x3a, 0x61, 0xff, 0x00, 0x5c, 0xe2, 0x9c, 0x93]) },
      { _tag: "Received", bytes: bytes(":irc.test 375 iirc :- MOTD - ") },
      { _tag: "Sent", bytes: bytes("PRIVMSG #iirc :\u0001ACTION waves\u0001") },
      // A sent Line that looks like a placeholder is still a Line.
      { _tag: "Sent", bytes: bytes("{Pass credential=libera}") },
      // A Message whose text ends in braces is an ordinary Line.
      { _tag: "Sent", bytes: bytes("PRIVMSG #iirc :{Pass libera}") },
    ];

    const text = print(escaped);

    expect(text).toBe(
      [
        "<<\\ :a\\xff\\x00\\\\✓",
        "<<\\ :irc.test 375 iirc :- MOTD -\\x20",
        ">>\\ PRIVMSG #iirc :\\x01ACTION waves\\x01",
        ">>\\ {Pass credential=libera}",
        ">> PRIVMSG #iirc :{Pass libera}",
        "",
      ].join("\n")
    );
    expect(items(text)).toStrictEqual(escaped);
  });

  it("escapes a placeholder's field values", () => {
    const secret: Item = {
      _tag: "SentSecret",
      line: {
        _tag: "AuthenticatePlain",
        authcid: "a user",
        authzid: "{\\}",
        credential: CredentialName.make("libera"),
      },
    };

    expect(print([secret])).toBe(
      ">> {AuthenticatePlain credential=libera authcid=a\\x20user authzid=\\x7b\\\\\\x7d}\n"
    );
    expect(items(print([secret]))).toStrictEqual([secret]);
  });

  it("refuses what is not an item, naming the line", () => {
    expect(refusal("== opened\n== closed Exploded\n")).toMatchObject({
      line: 2,
      text: "== closed Exploded",
    });
    expect(refusal(">> {AuthenticatePlain credential=libera}\n")?.message).toBe(
      "a AuthenticatePlain placeholder names exactly authcid, authzid, credential"
    );
    expect(refusal(">> {Pass credential=a extra=b}\n")?.message).toBe(
      "a Pass placeholder names exactly credential"
    );
    expect(refusal("== opened")).toStrictEqual({
      line: 0,
      message: "a transcript ends with a newline",
      text: "",
    });
  });

  it("reads the Runtime's shutdown items, and prints them back", () => {
    const text = "== stopping\n== unsent 2\n";

    expect(items(text)).toStrictEqual([{ _tag: "Stopping" }, { _tag: "Unsent", count: 2 }]);
    expect(print(items(text))).toBe(text);
  });

  it.each([
    ">> {Secret credential=a}",
    "== unsent 0",
    "== unsent",
    "== stopping now",
    ">> {Pass credential=a",
    "!! shout #iirc :hi",
    "!! configure +#a  -#b",
    "!! configure ~#a",
    "!! read",
    "!! read #iirc",
    "!! read #iirc 5s",
    "!! read #a #b t+5s",
    "!! read  t+5s",
    "?? exploded",
    "== fired ping 30s",
    "== opened now",
    "== connection 0",
    "-> dial irc.test:0",
    "<<no space",
    "<<\\ bad \\q escape",
    "+0s",
  ])("refuses %j", (line) => {
    expect(refusal(`${line}\n`)).toMatchObject({ line: 1, text: line });
  });
});

describe("byte order marks", () => {
  const bom = [0xef, 0xbb, 0xbf];

  it.each([
    ["a leading BOM", "Received", [...bom, 0x50, 0x49, 0x4e, 0x47], "<<\\ \\xef\\xbb\\xbfPING"],
    [
      "an embedded BOM",
      "Sent",
      [...bytes("PRIVMSG #iirc :a"), ...bom, 0x62],
      ">>\\ PRIVMSG #iirc :a\\xef\\xbb\\xbfb",
    ],
    [
      "a BOM beside a control byte",
      "Received",
      [...bom, ...bytes(":a PRIVMSG #b :\u0001x"), ...bom],
      "<<\\ \\xef\\xbb\\xbf:a PRIVMSG #b :\\x01x\\xef\\xbb\\xbf",
    ],
  ] as const)("keeps %s, visibly, through a round trip", (_name, tag, raw, line) => {
    const item: Item = { _tag: tag, bytes: Uint8Array.from(raw) };

    expect(print([item])).toBe(`${line}\n`);
    expect(items(print([item]))).toStrictEqual([item]);
  });
});
