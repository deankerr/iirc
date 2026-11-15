import { describe, expect, it } from "vitest";

import { detectKind, headLength } from "./kind.ts";

const ascii = (text: string): readonly number[] =>
  Array.from(text, (character) => character.codePointAt(0) ?? 0);

const bytes = (...parts: readonly (number | readonly number[])[]): Uint8Array =>
  Uint8Array.from(parts.flat());

const ftyp = (major: string, ...compatible: readonly string[]): Uint8Array =>
  bytes(
    0,
    0,
    0,
    16 + compatible.length * 4,
    ascii("ftyp"),
    ascii(major),
    0,
    0,
    0,
    0,
    ...compatible.map((brand) => ascii(brand))
  );

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const label = (head: Uint8Array) => {
  const { inline, type } = detectKind(head);

  return `${type} ${inline ? "inline" : "attachment"}`;
};

describe("detectKind images", () => {
  it("reads PNG", () => {
    expect(
      label(bytes(0x89, ascii("PNG\r\n"), 0x1a, ascii("\n"), 0, 0, 0, 13, ascii("IHDR")))
    ).toBe("image/png inline");
  });

  it("reads JPEG", () => {
    expect(label(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16, ascii("JFIF")))).toBe("image/jpeg inline");
    expect(detectKind(bytes(0xff, 0xd8, 0xff, 0xe0)).extensions).toStrictEqual([
      "jpg",
      "jpeg",
      "jpe",
    ]);
  });

  it("reads GIF", () => {
    expect(label(bytes(ascii("GIF89a"), 1, 0, 1, 0))).toBe("image/gif inline");
    expect(label(bytes(ascii("GIF87a"), 1, 0, 1, 0))).toBe("image/gif inline");
  });

  it("reads WebP", () => {
    expect(label(bytes(ascii("RIFF"), 1, 2, 3, 4, ascii("WEBPVP8 ")))).toBe("image/webp inline");
  });

  it("reads AVIF by its major brand", () => {
    expect(label(ftyp("avif", "mif1"))).toBe("image/avif inline");
  });

  it("reads AVIF by a compatible brand", () => {
    expect(label(ftyp("mif1", "miaf", "avif"))).toBe("image/avif inline");
  });

  it("serves HEIC as an attachment", () => {
    expect(label(ftyp("heic", "mif1"))).toBe("image/heic attachment");
    expect(label(ftyp("mif1", "heic"))).toBe("image/heic attachment");
  });
});

describe("detectKind video", () => {
  it("reads MP4 by its brands", () => {
    for (const brand of ["isom", "iso2", "mp41", "mp42", "avc1", "dash", "M4V "]) {
      expect(label(ftyp(brand))).toBe("video/mp4 inline");
    }

    expect(detectKind(ftyp("isom")).extensions).toStrictEqual(["mp4", "m4v"]);
  });

  it("reads QuickTime", () => {
    expect(label(ftyp("qt  "))).toBe("video/quicktime inline");
  });

  it("reads WebM by its doc type", () => {
    expect(label(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84, ascii("webm")))).toBe(
      "video/webm inline"
    );
  });

  it("serves Matroska as an attachment", () => {
    expect(label(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88, ascii("matroska")))).toBe(
      "video/x-matroska attachment"
    );
  });
});

describe("detectKind audio", () => {
  it("reads MP3 by an ID3 tag", () => {
    expect(label(bytes(ascii("ID3"), 4, 0, 0, 0, 0, 0, 0))).toBe("audio/mpeg inline");
  });

  it("reads MP3 by a frame sync", () => {
    expect(label(bytes(0xff, 0xfb, 0x90, 0x64))).toBe("audio/mpeg inline");
  });

  it("does not take an invalid frame header for MP3", () => {
    expect(label(bytes(0xff, 0xfb, 0xf0, 0x64))).toBe("application/octet-stream attachment");
  });

  it("reads Ogg", () => {
    expect(label(bytes(ascii("OggS"), 0, 2))).toBe("audio/ogg inline");
    expect(detectKind(bytes(ascii("OggS"))).extensions).toStrictEqual(["ogg", "oga", "opus"]);
  });

  it("reads FLAC", () => {
    expect(label(bytes(ascii("fLaC"), 0, 0, 0, 34))).toBe("audio/flac inline");
  });

  it("reads WAV", () => {
    expect(label(bytes(ascii("RIFF"), 1, 2, 3, 4, ascii("WAVEfmt ")))).toBe("audio/wav inline");
  });

  it("reads M4A as audio", () => {
    expect(label(ftyp("M4A ", "isom"))).toBe("audio/mp4 inline");
  });
});

describe("detectKind attachments", () => {
  it("serves PDF as an attachment", () => {
    expect(label(bytes(ascii("%PDF-1.7\n")))).toBe("application/pdf attachment");
  });

  it("serves SVG as an attachment", () => {
    expect(label(utf8('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(
      "image/svg+xml attachment"
    );
  });

  it("serves an SVG with an XML prolog as SVG", () => {
    expect(label(utf8('<?xml version="1.0"?>\n<!-- hi -->\n<SVG viewBox="0 0 1 1"/>'))).toBe(
      "image/svg+xml attachment"
    );
  });

  it("serves XML that is not SVG as XML", () => {
    expect(label(utf8('<?xml version="1.0"?><feed/>'))).toBe("application/xml attachment");
  });

  it("serves HTML in any of its openings as HTML", () => {
    for (const source of [
      "<!DOCTYPE html><p>",
      "<HTML>",
      "<head>",
      "<body onload=x()>",
      "<script>alert(1)</script>",
      "<iframe src=x>",
      "<!-- hi --><p>",
      "<custom-tag>",
    ]) {
      expect(label(utf8(source))).toBe("text/html; charset=utf-8 attachment");
    }
  });

  it("skips a BOM and leading whitespace before markup", () => {
    expect(label(bytes(0xef, 0xbb, 0xbf, ascii(" \r\n\t"), ascii("<html>")))).toBe(
      "text/html; charset=utf-8 attachment"
    );
  });

  it("never serves text that begins with a angle bracket as plain text", () => {
    expect(label(utf8("<3 you all"))).toBe("text/html; charset=utf-8 attachment");
  });

  it("serves unknown bytes as an attachment named bin", () => {
    const kind = detectKind(bytes(0x50, 0x4b, 3, 4, 0, 0, 0, 0));
    expect(kind).toMatchObject({
      extension: "bin",
      extensions: [],
      family: "file",
      inline: false,
      type: "application/octet-stream",
    });
  });
});

describe("detectKind text", () => {
  it("reads plain text as inline text", () => {
    expect(detectKind(utf8("hello, wörld\n\tline two\r\n\f"))).toMatchObject({
      extension: "txt",
      family: "text",
      inline: true,
      type: "text/plain; charset=utf-8",
    });
  });

  it("lists the aliases of text", () => {
    expect(detectKind(utf8("x")).extensions).toStrictEqual(
      expect.arrayContaining(["txt", "md", "json"])
    );
  });

  it("reads plain text that starts with a BOM", () => {
    expect(label(bytes(0xef, 0xbb, 0xbf, ascii("hello")))).toBe("text/plain; charset=utf-8 inline");
  });

  it("allows a multi-byte sequence cut off by the end of the head", () => {
    const euro = utf8("€");
    expect(label(Uint8Array.from([...utf8("price: "), ...euro.subarray(0, 2)]))).toBe(
      "text/plain; charset=utf-8 inline"
    );
  });

  it("refuses invalid UTF-8 in the middle", () => {
    expect(label(bytes(ascii("abc"), 0xc3, 0x28, ascii("def")))).toBe(
      "application/octet-stream attachment"
    );
  });

  it("refuses NUL and C0 controls other than tab, LF, CR and form feed", () => {
    expect(label(bytes(ascii("a"), 0, ascii("b")))).toBe("application/octet-stream attachment");
    expect(label(bytes(ascii("a"), 0x1b, ascii("[0m")))).toBe(
      "application/octet-stream attachment"
    );
    expect(label(bytes(ascii("a"), 0x7f))).toBe("application/octet-stream attachment");
  });

  it("reads empty input as unknown", () => {
    expect(label(new Uint8Array(0))).toBe("application/octet-stream attachment");
  });
});

describe("detectKind by structure, not name", () => {
  it("reads a head shorter than the magic number as unknown, or as text if it is", () => {
    expect(label(bytes(0x89, ascii("PN")))).toBe("application/octet-stream attachment");
    expect(label(bytes(0xff, 0xd8))).toBe("application/octet-stream attachment");
    expect(label(bytes(ascii("Og")))).toBe("text/plain; charset=utf-8 inline");
    expect(label(bytes(0, 0, 0, 16, ascii("ftyp")))).toBe("application/octet-stream attachment");
  });

  it("is only given headLength bytes but accepts fewer", () => {
    expect(headLength).toBe(4096);
    expect(label(bytes(ascii("x")))).toBe("text/plain; charset=utf-8 inline");
  });

  it("does not take HTML for an image whatever it might be named", () => {
    expect(label(utf8("<html><img src=x onerror=alert(1)>"))).toBe(
      "text/html; charset=utf-8 attachment"
    );
  });
});
