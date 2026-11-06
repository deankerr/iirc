import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { parseFallbackEncoding } from "./decode.ts";
import { parseFrame, parseLine, pingToken } from "./line.ts";

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

const vectorsFile = new URL("testdata/msg-split.yaml", import.meta.url);

const { tests: vectors } = Schema.decodeUnknownSync(Vectors)(
  Bun.YAML.parse(await Bun.file(vectorsFile).text())
);

const lineOf = (text: string) => {
  const parsed = parseLine(text);

  if (parsed._tag === "Unparseable") {
    throw new Error(`Expected a Line from ${text}`);
  }

  return parsed.line;
};

describe("ircdocs parser tests", () => {
  it.each(vectors)("parses $input", ({ atoms, input }) => {
    const line = lineOf(input);

    expect(Object.fromEntries(line.tags)).toStrictEqual(
      Object.fromEntries(Object.entries(atoms.tags ?? {}).map(([key, value]) => [key, value ?? ""]))
    );
    expect(line.source).toBe(atoms.source ?? undefined);
    expect(line.command).toBe(atoms.verb.toUpperCase());
    expect(line.params).toStrictEqual(atoms.params ?? []);
  });
});

describe(parseLine, () => {
  it.each(["", "   "])("reports %j as empty", (text) => {
    expect(parseLine(text)).toMatchObject({ _tag: "Unparseable", reason: "Empty" });
  });

  it.each([":irc.example", "@a=b", "@a=b :irc.example"])("reports %j as commandless", (text) => {
    expect(parseLine(text)).toMatchObject({ _tag: "Unparseable", reason: "NoCommand" });
  });

  it.each([0x20_28, 0x20_29])("keeps U+%x inside a message", (codePoint) => {
    const separator = String.fromCodePoint(codePoint);

    expect(lineOf(`:a PRIVMSG #c :before${separator}after`).params).toStrictEqual([
      "#c",
      `before${separator}after`,
    ]);
  });

  it("keeps a tag named __proto__", () => {
    expect(lineOf("@__proto__=x;a=b PING").tags.get("__proto__")).toBe("x");
  });
});

describe(parseFrame, () => {
  const encoder = new TextEncoder();

  it("MSG-4: falls back to ISO-8859-1 when the bytes are not UTF-8", () => {
    const frame = new Uint8Array([...encoder.encode("PRIVMSG #a :caf"), 0xe9]);

    expect(parseFrame(frame)).toMatchObject({ line: { params: ["#a", "café"] } });
  });

  it("MSG-4: reads 0x80 to 0x9f as the C1 controls, not as windows-1252 would", () => {
    const frame = new Uint8Array([...encoder.encode("PRIVMSG #a :"), 0x80, 0x9f]);

    expect(parseFrame(frame)).toMatchObject({ line: { params: ["#a", "\u0080\u009F"] } });
  });

  it("MSG-4: tries the fallback encoding before ISO-8859-1", () => {
    const cp1251 = parseFallbackEncoding("windows-1251");

    // "Привет" in windows-1251, which is not UTF-8.
    const frame = new Uint8Array([
      ...encoder.encode("PRIVMSG #a :"),
      0xcf,
      0xf0,
      0xe8,
      0xe2,
      0xe5,
      0xf2,
    ]);

    expect(parseFrame(frame, cp1251)).toMatchObject({ line: { params: ["#a", "Привет"] } });
    expect(parseFrame(frame)).toMatchObject({ line: { params: ["#a", "Ïðèâåò"] } });
  });

  it("MSG-4: reads UTF-8 as UTF-8 whatever the fallback", () => {
    const frame = encoder.encode("PRIVMSG #a :Привет");

    expect(parseFrame(frame, parseFallbackEncoding("windows-1251"))).toMatchObject({
      line: { params: ["#a", "Привет"] },
    });
  });

  it("survives invalid UTF-8 in tags", () => {
    const frame = new Uint8Array([0x40, 0x61, 0x3d, 0xff, 0x20, 0x50, 0x49, 0x4e, 0x47]);

    expect(parseFrame(frame)).toMatchObject({ _tag: "Line", line: { command: "PING" } });
  });
});

describe(pingToken, () => {
  const encoder = new TextEncoder();

  it("LIVE-1: finds the token as bytes, past tags and a source", () => {
    const frame = Uint8Array.of(...encoder.encode("@t=1 :irc.test PING :"), 0xff, 0x20, 0x41);

    expect(pingToken(frame)).toStrictEqual(Uint8Array.of(0xff, 0x20, 0x41));
  });

  it("LIVE-1: has no token for a bare PING", () => {
    expect(pingToken(encoder.encode("PING"))).toBeUndefined();
  });

  it.each(["", "   ", ":source-only"])("has no token for %j, which is not a Line", (text) => {
    expect(pingToken(encoder.encode(text))).toBeUndefined();
  });

  it("LIVE-1: agrees with parseFrame on where a valid token starts and ends", () => {
    const parsed = parseFrame(encoder.encode(":a PING   ☃  second"));

    expect(parsed).toMatchObject({ line: { params: ["☃", "second"] } });
    expect(new TextDecoder().decode(pingToken(encoder.encode(":a PING   ☃  second")))).toBe("☃");
  });
});
