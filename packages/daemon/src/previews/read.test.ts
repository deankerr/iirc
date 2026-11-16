import { describe, expect, it } from "vitest";

import { readMedia, readPage } from "./read.ts";

const LINK = "https://example.com/a/b/page.html";
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (ch) => ch.codePointAt(0) ?? 0);

const bytes = (...parts: (Uint8Array | number[])[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((part) => [...part]));

const readBytes = (head: Uint8Array, contentType: string | undefined = "text/html") =>
  readPage({ contentType, head, link: LINK });

const read = (text: string, contentType: string | undefined = "text/html") =>
  readBytes(utf8(text), contentType);

describe("precedence", () => {
  const all = `<head>
    <title>Plain title</title>
    <meta name="description" content="Plain description">
    <meta name="twitter:title" content="Twitter title">
    <meta name="twitter:description" content="Twitter description">
    <meta name="twitter:image" content="https://t.example/t.png">
    <meta property="og:title" content="OG title">
    <meta property="og:description" content="OG description">
    <meta property="og:site_name" content="OG Site">
    <meta property="og:image" content="https://o.example/o.png">
  </head>`;

  it("OpenGraph beats Twitter beats title and description", () => {
    expect(read(all)).toStrictEqual({
      description: "OG description",
      image: "https://o.example/o.png",
      site: "OG Site",
      title: "OG title",
    });
  });

  it("Twitter tags beat title and description when there is no OpenGraph", () => {
    expect(
      read(`<title>Plain</title>
        <meta name="twitter:title" content="Twitter title">
        <meta name="twitter:description" content="Twitter description">
        <meta name="twitter:image:src" content="https://t.example/t.png">
        <meta name="description" content="Plain description">`)
    ).toStrictEqual({
      description: "Twitter description",
      image: "https://t.example/t.png",
      title: "Twitter title",
    });
  });

  it("the title and description tags are the last resort", () => {
    expect(
      read(`<title>Plain title</title><meta name="description" content="Plain">`)
    ).toStrictEqual({
      description: "Plain",
      title: "Plain title",
    });
  });

  it("each field falls back on its own", () => {
    expect(
      read(`<title>Plain title</title>
        <meta property="og:description" content="OG description">
        <meta name="twitter:image" content="https://t.example/t.png">`)
    ).toStrictEqual({
      description: "OG description",
      image: "https://t.example/t.png",
      title: "Plain title",
    });
  });

  it("Twitter tags are read by property as well as name", () => {
    expect(read(`<meta property="twitter:title" content="By property">`)).toStrictEqual({
      title: "By property",
    });
  });

  it("an empty OpenGraph tag counts as absent", () => {
    expect(read(`<meta property="og:title" content="  "><title>Fallback</title>`)).toStrictEqual({
      title: "Fallback",
    });
  });

  it("og:image:secure_url and og:image:url are images too", () => {
    expect(
      read(
        `<title>t</title><meta property="og:image:secure_url" content="https://x.example/s.png">`
      )?.image
    ).toBe("https://x.example/s.png");
    expect(
      read(`<title>t</title><meta property="og:image:url" content="https://x.example/u.png">`)
        ?.image
    ).toBe("https://x.example/u.png");
  });

  it("whitespace is collapsed and trimmed", () => {
    expect(read("<title>\n  Many\t\t words \n here </title>")?.title).toBe("Many words here");
  });

  it("attribute names are case-insensitive, and values may be unquoted or single-quoted", () => {
    expect(
      read(`<META PROPERTY=og:title CONTENT=Loud><meta property='og:description' content='Quiet'>`)
    ).toStrictEqual({ description: "Quiet", title: "Loud" });
  });

  it("comments, scripts and styles are skipped", () => {
    expect(
      read(`<!-- <title>Hidden</title> -->
        <script>var s = "<title>Script</title>";</script>
        <style>/* <title>Style</title> */</style>
        <title>Real</title>`)
    ).toStrictEqual({ title: "Real" });
  });
});

describe("charset", () => {
  it("a Latin-1 page is read by its header", () => {
    const head = latin1("<title>Café Zoë</title>");
    expect(readBytes(head, "text/html; charset=ISO-8859-1")?.title).toBe("Café Zoë");
  });

  it("a Shift_JIS page is read by its meta", () => {
    const head = bytes(
      utf8('<meta charset="Shift_JIS"><title>'),
      [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea],
      utf8("</title>")
    );

    expect(readBytes(head, "text/html")?.title).toBe("日本語");
  });

  it("a page whose header and meta disagree is read by the header", () => {
    const head = bytes(utf8('<meta charset="Shift_JIS"><title>'), [0xe9], utf8("</title>"));
    expect(readBytes(head, "text/html; charset=iso-8859-1")?.title).toBe("é");
  });

  it("a BOM beats the header and the meta", () => {
    const head = bytes([0xef, 0xbb, 0xbf], utf8('<meta charset="Shift_JIS"><title>Ünï</title>'));
    expect(readBytes(head, "text/html; charset=iso-8859-1")?.title).toBe("Ünï");
  });

  it("a UTF-16 BOM is honoured", () => {
    const units = "<title>Hi é</title>".split("").flatMap((ch) => [ch.codePointAt(0) ?? 0, 0]);
    expect(readBytes(bytes([0xff, 0xfe], units), "text/html")?.title).toBe("Hi é");
  });

  it("http-equiv content-type declares a charset", () => {
    const head = bytes(
      utf8('<meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><title>'),
      [0x80],
      utf8("</title>")
    );

    expect(readBytes(head, undefined)?.title).toBe("€");
  });

  it("an unknown header label falls through to the meta", () => {
    const head = bytes(utf8('<meta charset="iso-8859-1"><title>'), [0xe9], utf8("</title>"));
    expect(readBytes(head, "text/html; charset=nonsense")?.title).toBe("é");
  });

  it("a meta-declared UTF-16 means UTF-8", () => {
    expect(read('<meta charset="utf-16"><title>Ünï</title>', undefined)?.title).toBe("Ünï");
  });

  it("with nothing declared the page is UTF-8", () => {
    expect(read("<title>日本語</title>", undefined)?.title).toBe("日本語");
  });
});

describe("addresses and entities", () => {
  it("a relative og:image resolves against the link", () => {
    expect(read(`<title>t</title><meta property="og:image" content="../img/p.png">`)?.image).toBe(
      "https://example.com/a/img/p.png"
    );
  });

  it("a relative og:image resolves against base href", () => {
    expect(
      read(
        `<base href="https://cdn.example.org/root/"><title>t</title><meta property="og:image" content="p.png">`
      )?.image
    ).toBe("https://cdn.example.org/root/p.png");
  });

  it("a relative base href resolves against the link first", () => {
    expect(
      read(`<base href="/assets/"><title>t</title><meta property="og:image" content="p.png">`)
        ?.image
    ).toBe("https://example.com/assets/p.png");
  });

  it("an image that is not http or https is dropped", () => {
    expect(
      read(`<title>t</title><meta property="og:image" content="data:image/png;base64,AAAA">`)
    ).toStrictEqual({
      title: "t",
    });
    expect(
      read(`<title>t</title><meta property="og:image" content="javascript:alert(1)">`)
    ).toStrictEqual({
      title: "t",
    });
  });

  it("entities are decoded in attributes and in the title", () => {
    expect(
      read(`<title>Tom &amp; Jerry &#x1F600; &lt;3</title>
        <meta property="og:description" content="&quot;Quoted&quot; &amp; more &eacute;">
        <meta property="og:image" content="https://x.example/i.png?a=1&amp;b=2">`)
    ).toStrictEqual({
      description: '"Quoted" & more é',
      image: "https://x.example/i.png?a=1&b=2",
      title: "Tom & Jerry 😀 <3",
    });
  });
});

describe("limits", () => {
  it("a title is cut at 200 characters, never inside a surrogate pair", () => {
    const title = `${"a".repeat(199)}😀tail`;
    const cut = read(`<title>${title}</title>`)?.title ?? "";
    expect(cut).toHaveLength(201);
    expect(cut).toBe(`${"a".repeat(199)}😀`);
  });

  it("a description is cut at 500 characters, never inside a surrogate pair", () => {
    const text = `${"b".repeat(499)}😀tail`;
    const cut = read(`<meta name="description" content="${text}">`)?.description ?? "";
    expect(cut).toHaveLength(501);
    expect(cut.endsWith("😀")).toBeTruthy();
  });
});

describe("nothing to show", () => {
  it("an empty head is nothing", () => {
    expect(read("")).toBeUndefined();
  });

  it("an image alone is nothing", () => {
    expect(read(`<meta property="og:image" content="https://x.example/i.png">`)).toBeUndefined();
  });

  it("a site name alone is nothing", () => {
    expect(read(`<meta property="og:site_name" content="Site">`)).toBeUndefined();
  });

  it("a description alone is enough", () => {
    expect(read(`<meta name="description" content="Just this">`)).toStrictEqual({
      description: "Just this",
    });
  });

  it("hostile input never throws", () => {
    const hostile = [
      "<",
      "<meta",
      '<meta content="',
      "<!--",
      "<title>",
      "<script>",
      "<base href='http://[::'><title>x</title>",
      '<meta property="og:image" content="http://[">',
      "<meta charset='\u0000'>",
      "\u0000".repeat(5000),
      "<a ".repeat(10_000),
    ];

    for (const text of hostile) {
      expect(() => read(text)).not.toThrow();
    }

    expect(() =>
      readBytes(Uint8Array.from({ length: 4096 }, (_, i) => (i * 37) % 256))
    ).not.toThrow();
  });
});

describe(readMedia, () => {
  it("names the kind of image, video and audio types", () => {
    expect(readMedia("image/png")).toBe("image");
    expect(readMedia("video/mp4")).toBe("video");
    expect(readMedia("audio/ogg")).toBe("audio");
  });

  it("reads the essence, ignoring parameters and case", () => {
    expect(readMedia("Image/WEBP; q=1")).toBe("image");
    expect(readMedia("  VIDEO/webm ;codecs=vp9")).toBe("video");
  });

  it("anything else is not media", () => {
    expect(readMedia("text/html; charset=utf-8")).toBeUndefined();
    expect(readMedia("application/octet-stream")).toBeUndefined();
    expect(readMedia("")).toBeUndefined();
  });
});
