import { Schema } from "effect";
import { Yaml } from "effect/encoding";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import ergoFeatures from "../../../fixtures/transcripts/ergo/first-features.irc?raw";
import ergoFloor from "../../../fixtures/transcripts/ergo/floor.irc?raw";
import ngircdFeatures from "../../../fixtures/transcripts/ngircd/first-features.irc?raw";
import ngircdFloor from "../../../fixtures/transcripts/ngircd/floor.irc?raw";
import {
  Encoding,
  encode,
  fallbackEncodings,
  isRejected,
  outbound,
  parse,
  parseSource,
  rawParams,
} from "./line.ts";
import type { Line, OutboundLine, Parsed, RawParam } from "./line.ts";
import msgSplit from "./testdata/msg-split.yaml?raw";

// The bytes `encode` writes for a Line our own builders made, which it never rejects.
const encodedBytes = (line: OutboundLine): Uint8Array => {
  const bytes = encode(line);

  if (isRejected(bytes)) {
    throw new Error(`Expected bytes, not ${bytes.reason}`);
  }

  return bytes;
};

const utf8 = new TextEncoder();
const utf8Only: Encoding = { _tag: "Utf8Only" };
const latin1: Encoding = { _tag: "Utf8OrElse", fallback: "windows-1252" };

const lineOf = (parsed: Parsed): Line => {
  if (parsed._tag === "Unparseable") {
    throw new Error(`Expected a Line, not ${parsed.reason}`);
  }

  return parsed.line;
};

const parsedText = (text: string, encoding: Encoding = utf8Only) =>
  lineOf(parse(utf8.encode(text), encoding));

const Vectors = Schema.Struct({
  tests: Schema.Array(
    Schema.Struct({
      atoms: Schema.Struct({
        params: Schema.optional(Schema.Array(Schema.String)),
        source: Schema.optional(Schema.NullOr(Schema.String)),
        tags: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
        verb: Schema.String,
      }),
      input: Schema.String,
    })
  ),
});

const { tests: vectors } = Schema.decodeUnknownSync(Vectors)(Yaml.parse(msgSplit));

describe("the ircdocs parser vectors", () => {
  it.each(vectors)("parse $input", ({ atoms, input }) => {
    for (const encoding of [utf8Only, latin1]) {
      const line = parsedText(input, encoding);

      expect(Object.fromEntries(line.tags)).toStrictEqual(
        Object.fromEntries(
          Object.entries(atoms.tags ?? {}).map(([key, value]) => [key, value ?? ""])
        )
      );
      expect(line.source).toBe(atoms.source ?? undefined);
      expect(line.command).toBe(atoms.verb.toUpperCase());
      expect(line.params).toStrictEqual(atoms.params ?? []);
    }
  });
});

// A transcript's `<<` Lines as the bytes that arrived. `<<\ ` Lines escape `\\` and `\xNN`.
const received = (transcript: string): readonly Uint8Array[] =>
  transcript.split("\n").flatMap((row) => {
    if (row.startsWith("<<\\ ")) {
      const bytes: number[] = [];
      const text = row.slice(4);

      for (let index = 0; index < text.length; index += 1) {
        if (text.startsWith("\\x", index)) {
          bytes.push(Number.parseInt(text.slice(index + 2, index + 4), 16));
          index += 3;
        } else if (text.startsWith("\\\\", index)) {
          bytes.push(0x5c);
          index += 1;
        } else {
          for (const byte of utf8.encode(text.charAt(index))) {
            bytes.push(byte);
          }
        }
      }

      return [Uint8Array.from(bytes)];
    }

    return row.startsWith("<< ") ? [utf8.encode(row.slice(3))] : [];
  });

// A transcript's `>>` Lines, but for those that name a Credential in its place.
const sent = (transcript: string): readonly string[] =>
  transcript
    .split("\n")
    .filter((row) => row.startsWith(">> ") && !row.endsWith("}"))
    .map((row) => row.slice(3));

const fixtures = [
  ["ergo/first-features", ergoFeatures],
  ["ergo/floor", ergoFloor],
  ["ngircd/first-features", ngircdFeatures],
  ["ngircd/floor", ngircdFloor],
] as const;

describe("the recorded transcripts", () => {
  it.each(fixtures)("%s: every received Line parses", (_name, transcript) => {
    const lines = received(transcript);

    expect(lines.length).toBeGreaterThan(20);

    for (const bytes of lines) {
      expect(parse(bytes, utf8Only)._tag).toBe("Line");
      expect(parse(bytes, latin1)._tag).toBe("Line");
    }
  });

  it.each(fixtures)(
    "%s: every Line we sent can be built, and reads back the same",
    (_name, transcript) => {
      for (const text of sent(transcript)) {
        const line = parsedText(text);
        const built = outbound(line.command, line.params, Object.fromEntries(line.tags));
        const bytes = isRejected(built) ? new Uint8Array() : encodedBytes(built).subarray(0, -2);

        expect(parse(bytes, utf8Only)).toStrictEqual({ _tag: "Line", line });
      }
    }
  );

  it("keeps the space a MOTD header ends in", () => {
    const header = received(ergoFloor)
      .map((bytes) => parse(bytes, utf8Only))
      .find((parsed) => parsed._tag === "Line" && parsed.line.command === "375");

    expect(lineOf(header ?? { _tag: "Unparseable", reason: "Empty" }).params).toStrictEqual([
      "iirc_",
      "- ergo.test Message of the day - ",
    ]);
  });
});

describe(parse, () => {
  it.each(["", "   "])("finds %j empty", (text) => {
    expect(parse(utf8.encode(text), utf8Only)).toStrictEqual({
      _tag: "Unparseable",
      reason: "Empty",
    });
  });

  it.each([":irc.example", "@a=b", "@a=b :irc.example", "@a=b   :irc.example   "])(
    "finds %j has no command",
    (text) => {
      expect(parse(utf8.encode(text), utf8Only)).toStrictEqual({
        _tag: "Unparseable",
        reason: "NoCommand",
      });
    }
  );

  it("reads tags in any order, and the last of a repeated key", () => {
    expect(parsedText("@b=2;a=1;b=3 PING").tags).toStrictEqual(
      new Map([
        ["b", "3"],
        ["a", "1"],
      ])
    );
  });

  it("reads a key it has never heard of, whatever its shape", () => {
    expect(parsedText("@+Ünïcode/k_y=v;=lost;; PING").tags).toStrictEqual(
      new Map([["+Ünïcode/k_y", "v"]])
    );
  });

  it("keeps a tag named __proto__", () => {
    expect(parsedText("@__proto__=x;a=b PING").tags.get("__proto__")).toBe("x");
  });

  it("reads a trailing parameter with its colon or without", () => {
    expect(parsedText(":a PRIVMSG #c hi").params).toStrictEqual(["#c", "hi"]);
    expect(parsedText(":a PRIVMSG #c :hi").params).toStrictEqual(["#c", "hi"]);
    expect(parsedText(":a PRIVMSG #c :").params).toStrictEqual(["#c", ""]);
  });

  it("reads more parameters than fifteen, and spaces before the first part", () => {
    const params = Array.from({ length: 20 }, (_unused, index) => `p${index}`);

    expect(parsedText(`  :a X ${params.join(" ")}`).params).toStrictEqual(params);
  });

  it("upper-cases ASCII in a command and leaves the rest", () => {
    expect(parsedText("privmsg #c :x").command).toBe("PRIVMSG");
    expect(parsedText("prïvmsg #c :x").command).toBe("PRïVMSG");
  });

  it("takes an empty source as none", () => {
    expect(parsedText(": PING x").source).toBeUndefined();
  });

  it("ends a Line at NUL, CR, or LF", () => {
    expect(parsedText("PRIVMSG #c :before\0after").params).toStrictEqual(["#c", "before"]);
    expect(parsedText("PRIVMSG #c :before\rQUIT").params).toStrictEqual(["#c", "before"]);
    expect(parsedText("PRIVMSG #c :before\nQUIT").params).toStrictEqual(["#c", "before"]);
  });

  it.each([0x20_28, 0x20_29, 0x85, 0xa0])("keeps U+%s inside a Message", (codePoint) => {
    const separator = String.fromCodePoint(codePoint);

    expect(parsedText(`:a PRIVMSG #c :before${separator}after`).params).toStrictEqual([
      "#c",
      `before${separator}after`,
    ]);
  });

  it("reads tags as UTF-8 and the rest in the fallback, part by part", () => {
    const bytes = Uint8Array.from([
      ...utf8.encode("@+x=é :caf"),
      0xe9,
      ...utf8.encode(" PRIVMSG #ç :"),
      0xe7,
      0x61,
    ]);

    expect(lineOf(parse(bytes, latin1))).toStrictEqual({
      command: "PRIVMSG",
      params: ["#ç", "ça"],
      source: "café",
      tags: new Map([["+x", "é"]]),
    });
  });

  it("reads in a multi-byte fallback, and falls on to ISO-8859-1 when it cannot", () => {
    // "あ" in Shift_JIS, then bytes Shift_JIS cannot read.
    const shiftJis: Encoding = { _tag: "Utf8OrElse", fallback: "shift_jis" };

    expect(parse(Uint8Array.of(0x50, 0x20, 0x82, 0xa0), shiftJis)).toMatchObject({
      line: { params: ["あ"] },
    });
    expect(parse(Uint8Array.of(0x50, 0x20, 0x82, 0xff), shiftJis)).toMatchObject({
      line: { params: ["\u0082ÿ"] },
    });
  });

  it("reads ISO-8859-1 byte for byte when the fallback cannot read it either", () => {
    // 0x82 0xff is no Shift_JIS character, so neither UTF-8 nor the fallback reads it.
    const shiftJis: Encoding = { _tag: "Utf8OrElse", fallback: "shift_jis" };

    expect(parse(Uint8Array.of(0x50, 0x20, 0x82, 0xff), shiftJis)).toMatchObject({
      line: { params: ["\u0082\u00FF"] },
    });
  });

  it("reads what is not UTF-8 as U+FFFD under UTF8ONLY", () => {
    expect(parse(Uint8Array.of(0x50, 0x20, 0xff, 0x61), utf8Only)).toMatchObject({
      line: { params: ["�a"] },
    });
  });

  it("keeps a byte order mark as U+FEFF", () => {
    expect(parse(Uint8Array.of(0x50, 0x20, 0xef, 0xbb, 0xbf, 0x61), utf8Only)).toMatchObject({
      line: { params: ["﻿a"] },
    });
  });
});

describe("parsing arbitrary bytes", () => {
  const spaces = fc.constantFrom(0x20, 0x20, 0x3a, 0x40, 0x3b, 0x3d, 0x5c, 0x00, 0x0d, 0x0a, 0xff);

  const bytes = fc
    .array(fc.oneof(fc.integer({ max: 0xff, min: 0 }), spaces), { maxLength: 600 })
    .map((values) => Uint8Array.from(values));

  const encodings = fc.constantFrom<Encoding>(
    utf8Only,
    latin1,
    { _tag: "Utf8OrElse", fallback: "shift_jis" },
    { _tag: "Utf8OrElse", fallback: "iso-2022-jp" },
    { _tag: "Utf8OrElse", fallback: "gb18030" }
  );

  it("never throws, and gives Lines whose parts could not have been split otherwise", () => {
    expect(() => {
      fc.assert(
        fc.property(bytes, encodings, (input, encoding) => {
          const parsed = parse(input, encoding);

          if (parsed._tag === "Unparseable") {
            return true;
          }

          const { command, params } = parsed.line;
          const middle = params.slice(0, -1);

          return (
            command !== "" &&
            !command.includes(" ") &&
            params.every((param) => !/[\0\r\n]/u.test(param)) &&
            middle.every((param) => param !== "" && !param.includes(" "))
          );
        }),
        { numRuns: 5000 }
      );
    }).not.toThrow();
  });
});

const bytesOfRaw = (param: RawParam) =>
  Uint8Array.from(param.bytes, (char) => char.codePointAt(0) ?? 0);

describe(rawParams, () => {
  const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });

  const bytes = fc.uint8Array({ maxLength: 300 }).map((values) =>
    // Spaces and colons often, so the split is worth checking.
    values.map((byte) => {
      if (byte % 5 === 0) {
        return 0x20;
      }

      return byte % 7 === 0 ? 0x3a : byte;
    })
  );

  it("splits exactly as parse does, so each part decodes to the parsed text", () => {
    expect(() => {
      fc.assert(
        fc.property(bytes, (input) => {
          const parsed = parse(input, utf8Only);
          const raw = rawParams(input);

          expect(raw.map((part) => utf8Decoder.decode(bytesOfRaw(part)))).toStrictEqual(
            parsed._tag === "Line" ? parsed.line.params : []
          );
        }),
        { numRuns: 5000 }
      );
    }).not.toThrow();
  });

  it("gives the bytes as they came, which text could not", () => {
    expect(rawParams(Uint8Array.of(0x50, 0x20, 0xff, 0x20, 0x3a, 0xfe, 0x20))).toStrictEqual([
      { bytes: "\u00FF" },
      { bytes: "\u00FE " },
    ]);
    expect(rawParams(utf8.encode(":only.a.source"))).toStrictEqual([]);
  });

  it("is not changed by changing a Buffer it was read from, whose slices share memory", () => {
    const received = Buffer.from("PING :abc");
    const [token] = rawParams(received);

    received.write("XYZ", 6);

    expect(token).toStrictEqual({ bytes: "abc" });
  });
});

describe("the Encoding schema", () => {
  const decode = Schema.decodeUnknownExit(Encoding);

  it.each(fallbackEncodings)("takes %s as a fallback, which this runtime decodes", (fallback) => {
    expect(decode({ _tag: "Utf8OrElse", fallback })._tag).toBe("Success");
    expect(new TextDecoder(fallback, { fatal: true }).encoding).toBe(fallback);
  });

  // Only canonical names, so a recorded Configuration means the same on every runtime.
  it.each([
    "",
    "bogus",
    "utf-8",
    "latin1",
    "Shift_JIS",
    "utf-16le",
    "UTF-16",
    "x-user-defined",
    "replacement",
    "iso-2022-kr",
  ])("refuses %j as a fallback", (fallback) => {
    expect(decode({ _tag: "Utf8OrElse", fallback })._tag).toBe("Failure");
  });
});

describe(parseSource, () => {
  it.each([
    ["nick!user@host", { host: "host", nick: "nick", user: "user" }],
    ["nick@host", { host: "host", nick: "nick", user: undefined }],
    ["nick!user", { host: undefined, nick: "nick", user: "user" }],
    ["irc.example.com", { host: undefined, nick: "irc.example.com", user: undefined }],
    ["a!b!c@d@e", { host: "d@e", nick: "a", user: "b!c" }],
    ["a@b!c", { host: "b!c", nick: "a", user: undefined }],
  ])("splits %j", (source, parts) => {
    expect(parseSource(source)).toStrictEqual(parts);
  });
});
