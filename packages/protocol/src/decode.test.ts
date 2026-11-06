import { describe, expect, it } from "vitest";

import { decodeBytes, parseFallbackEncoding } from "./decode.ts";
import type { FallbackEncoding } from "./decode.ts";
import { seededRandom } from "./random.fixture.ts";

const encoder = new TextEncoder();

const encoding = (label: string): FallbackEncoding => {
  const parsed = parseFallbackEncoding(label);

  if (parsed === undefined) {
    throw new Error(`Expected an encoding for ${label}`);
  }

  return parsed;
};

describe(parseFallbackEncoding, () => {
  it("MSG-4 names the encoding as WHATWG does, whatever the label's case", () => {
    expect(encoding("Shift_JIS").name).toBe("shift_jis");
    expect(encoding("  UTF-8 ").name).toBe("utf-8");
  });

  it("MSG-4 follows WHATWG's aliases, so latin1 is windows-1252", () => {
    expect(encoding("latin1").name).toBe("windows-1252");
    expect(encoding("iso-8859-1").name).toBe("windows-1252");
  });

  it.each(["", "bogus", "utf-99", "iso-2022-kr", "replacement"])("MSG-4 refuses %j", (label) => {
    expect(parseFallbackEncoding(label)).toBeUndefined();
  });

  it("refuses x-user-defined, which drops bytes", () => {
    expect(parseFallbackEncoding("x-user-defined")).toBeUndefined();
  });
});

describe(decodeBytes, () => {
  it("MSG-4 reads valid UTF-8 as UTF-8, whatever the fallback", () => {
    expect(decodeBytes(encoder.encode("café ☃ 😀"), encoding("windows-1251"))).toStrictEqual({
      _tag: "utf-8",
      text: "café ☃ 😀",
    });
  });

  it("MSG-4 reads no bytes as empty UTF-8", () => {
    expect(decodeBytes(new Uint8Array())).toStrictEqual({ _tag: "utf-8", text: "" });
  });

  it("keeps a byte order mark", () => {
    expect(decodeBytes(Uint8Array.of(0xef, 0xbb, 0xbf, 0x61))).toStrictEqual({
      _tag: "utf-8",
      text: "﻿a",
    });
  });

  it("MSG-4 falls back to the configured encoding when the bytes are not UTF-8", () => {
    // "あ" in Shift_JIS.
    expect(decodeBytes(Uint8Array.of(0x82, 0xa0, 0x41), encoding("shift_jis"))).toStrictEqual({
      _tag: "Fallback",
      encoding: "shift_jis",
      text: "あA",
    });
  });

  it("MSG-4 falls on to Latin-1 when the fallback cannot read the bytes either", () => {
    expect(decodeBytes(Uint8Array.of(0x82, 0xff, 0xff), encoding("shift_jis"))).toStrictEqual({
      _tag: "Latin1",
      text: "\u0082ÿÿ",
    });
  });

  it("MSG-4 falls to Latin-1 with no fallback", () => {
    expect(decodeBytes(Uint8Array.of(0x63, 0x61, 0x66, 0xe9))).toStrictEqual({
      _tag: "Latin1",
      text: "café",
    });
  });

  it("MSG-4 maps every byte to the code point of its own value, which windows-1252 does not", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_unused, index) => index);
    const decoded = decodeBytes(bytes);

    expect(decoded._tag).toBe("Latin1");
    expect(Array.from(decoded.text, (char) => char.codePointAt(0))).toStrictEqual([...bytes]);
  });

  it("MSG-4 reads a very large input", () => {
    const decoded = decodeBytes(new Uint8Array(1_000_000).fill(0xe9));

    expect(decoded.text).toHaveLength(1_000_000);
  });
});

// What is wrong with how these bytes were read, if anything.
const problemWith = (bytes: Uint8Array, fallback: FallbackEncoding | undefined) => {
  const decoded = decodeBytes(bytes, fallback);

  switch (decoded._tag) {
    case "utf-8": {
      return encoder.encode(decoded.text).toString() === bytes.toString()
        ? undefined
        : "UTF-8 does not map back";
    }

    case "Latin1": {
      const back = Uint8Array.from(decoded.text, (char) => char.codePointAt(0) ?? 0);

      return back.toString() === bytes.toString() ? undefined : "Latin-1 does not map back";
    }

    case "Fallback": {
      return decoded.encoding === fallback?.name ? undefined : "wrong encoding named";
    }

    default: {
      return "unknown decoder";
    }
  }
};

describe("MSG-4 decoding, on random bytes", () => {
  const random = seededRandom(1459);

  const fallbacks = [
    undefined,
    encoding("shift_jis"),
    encoding("windows-1251"),
    encoding("utf-16le"),
    encoding("euc-kr"),
  ];

  it("never fails, and says how it read the bytes", () => {
    const problems = Array.from({ length: 3000 }, () =>
      problemWith(
        Uint8Array.from({ length: random(40) }, () => random(256)),
        fallbacks[random(fallbacks.length)]
      )
    ).filter((problem) => problem !== undefined);

    expect(problems).toStrictEqual([]);
  });
});
