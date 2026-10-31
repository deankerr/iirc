import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { parseFrame, parseLine } from "./line.ts";

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
  it("falls back to latin1 when the bytes are not UTF-8", () => {
    const frame = new Uint8Array([...new TextEncoder().encode("PRIVMSG #a :caf"), 0xe9]);

    expect(parseFrame(frame)).toMatchObject({ line: { params: ["#a", "café"] } });
  });

  it("survives invalid UTF-8 in tags", () => {
    const frame = new Uint8Array([0x40, 0x61, 0x3d, 0xff, 0x20, 0x50, 0x49, 0x4e, 0x47]);

    expect(parseFrame(frame)).toMatchObject({ _tag: "Line", line: { command: "PING" } });
  });
});
