import type { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { fillFromOembed, readMedia, readOembed, readPage } from "./read.ts";
import type { PageRead } from "./read.ts";

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

describe("a head that says little", () => {
  it("an empty head reads as nothing", () => {
    expect(read("")).toStrictEqual({});
  });

  it("an image alone has no title or description", () => {
    expect(read(`<meta property="og:image" content="https://x.example/i.png">`)).toStrictEqual({
      image: "https://x.example/i.png",
    });
  });

  it("a site name alone has no title or description", () => {
    expect(read(`<meta property="og:site_name" content="Site">`)).toStrictEqual({ site: "Site" });
  });

  it("an oEmbed address alone is still read, for the fill that follows", () => {
    expect(
      read(`<link rel="alternate" type="application/json+oembed" href="https://p.example/o">`)
    ).toStrictEqual({ oembed: "https://p.example/o" });
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

const OEMBED = "https://p.example/oembed?url=x";

// oxlint-disable-next-line no-script-url -- a hostile address, which must be dropped.
const SCRIPT_URL = "javascript:alert(1)";

const oembedOf = (head: string) => read(head)?.oembed;

describe("the oEmbed address a page names", () => {
  it("is the href of an alternate link of type application/json+oembed", () => {
    expect(oembedOf(`<link rel="alternate" type="application/json+oembed" href="${OEMBED}">`)).toBe(
      OEMBED
    );
  });

  it("reads rel as a list of tokens, and rel and type without regard to case", () => {
    expect(
      oembedOf(
        `<link rel="ICON  Alternate\tfoo" type=" Application/JSON+oEmbed " href="${OEMBED}">`
      )
    ).toBe(OEMBED);
  });

  it("needs the alternate token", () => {
    expect(
      oembedOf(`<link rel="alternates" type="application/json+oembed" href="${OEMBED}">`)
    ).toBeUndefined();
  });

  it("ignores the XML flavour and any other type", () => {
    expect(
      oembedOf(`<link rel="alternate" type="application/xml+oembed" href="${OEMBED}">
        <link rel="alternate" type="text/xml+oembed" href="${OEMBED}">
        <link rel="alternate" href="${OEMBED}">`)
    ).toBeUndefined();
  });

  it("is resolved against the page's address, or its <base>", () => {
    expect(oembedOf('<link rel="alternate" type="application/json+oembed" href="/o?u=1">')).toBe(
      "https://example.com/o?u=1"
    );
    expect(
      oembedOf(
        '<base href="https://b.example/dir/"><link rel="alternate" type="application/json+oembed" href="o.json">'
      )
    ).toBe("https://b.example/dir/o.json");
  });

  it("has its entities decoded", () => {
    expect(
      oembedOf(
        '<link rel="alternate" type="application/json+oembed" href="https://p.example/o?a=1&amp;b=2">'
      )
    ).toBe("https://p.example/o?a=1&b=2");
  });

  it("is dropped unless it is http or https", () => {
    for (const href of [SCRIPT_URL, "data:application/json,{}", "ftp://p.example/o"]) {
      expect(
        oembedOf(`<link rel="alternate" type="application/json+oembed" href="${href}">`)
      ).toBeUndefined();
    }
  });

  it("is the first one when a page names several", () => {
    expect(
      oembedOf(`<link rel="alternate" type="application/json+oembed" href="https://one.example/o">
        <link rel="alternate" type="application/json+oembed" href="https://two.example/o">`)
    ).toBe("https://one.example/o");
  });

  it("is not read past the body", () => {
    expect(
      oembedOf(`<body><link rel="alternate" type="application/json+oembed" href="${OEMBED}">`)
    ).toBeUndefined();
  });
});

// What the Daemon does with an answer: its JSON text read, then the gaps filled.
const fill = (page: PageRead, answer: Schema.Json): PageRead => {
  const read = readOembed(JSON.stringify(answer));

  return read === undefined ? page : fillFromOembed(page, read, OEMBED);
};

describe(fillFromOembed, () => {
  it("fills the title, the author as the site, and the thumbnail with its size", () => {
    expect(
      fill(
        {},
        {
          author_name: "  Some  Author ",
          thumbnail_height: 90,
          thumbnail_url: "https://cdn.example/t.jpg",
          thumbnail_width: 120,
          title: "A\n title",
        }
      )
    ).toStrictEqual({
      image: "https://cdn.example/t.jpg",
      imageHeight: 90,
      imageWidth: 120,
      site: "Some Author",
      title: "A title",
    });
  });

  it("fills only what the page left empty", () => {
    const page: PageRead = {
      description: "Page description",
      image: "https://page.example/i.png",
      oembed: OEMBED,
      site: "Page Site",
      title: "Page title",
    };

    expect(
      fill(page, {
        author_name: "Author",
        thumbnail_height: 9,
        thumbnail_url: "https://cdn.example/t.jpg",
        thumbnail_width: 9,
        title: "oEmbed title",
      })
    ).toStrictEqual(page);
  });

  it("fills each gap on its own", () => {
    expect(
      fill(
        { site: "Page Site", title: "Page title" },
        { author_name: "Author", thumbnail_url: "https://cdn.example/t.jpg", title: "Other" }
      )
    ).toStrictEqual({
      image: "https://cdn.example/t.jpg",
      site: "Page Site",
      title: "Page title",
    });
  });

  it("never fills the description", () => {
    expect(fill({}, { description: "From oEmbed", title: "T" })).toStrictEqual({ title: "T" });
  });

  it("never reads html, whatever the type", () => {
    for (const type of ["rich", "video", "photo", "link"]) {
      expect(fill({}, { html: "<script>alert(1)</script><b>Hi</b>", type })).toStrictEqual({});
      expect(
        fill({}, { html: "<iframe src='https://evil.example/'></iframe>", title: "T", type })
      ).toStrictEqual({ title: "T" });
    }
  });

  it("cuts a title at 200 code points", () => {
    const title = fill({}, { title: `${"a".repeat(199)}😀tail` }).title ?? "";

    // oxlint-disable-next-line typescript/no-misused-spread -- counting code points.
    expect([...title]).toHaveLength(200);
    expect(title.endsWith("😀")).toBeTruthy();
  });

  it("does not decode entities: text in JSON is not HTML", () => {
    expect(fill({}, { title: "Fish &amp; <b>Chips</b>" })).toStrictEqual({
      title: "Fish &amp; <b>Chips</b>",
    });
  });

  it("resolves the thumbnail against the oEmbed address, and keeps only http and https", () => {
    expect(fill({}, { thumbnail_url: "/t.png" }).image).toBe("https://p.example/t.png");

    for (const thumbnail_url of [SCRIPT_URL, "data:image/png;base64,AAAA", "file:///x"]) {
      expect(fill({}, { thumbnail_height: 5, thumbnail_url, thumbnail_width: 5 })).toStrictEqual(
        {}
      );
    }
  });

  it("keeps a thumbnail's size only as positive integers, numeric strings included", () => {
    const thumbnail_url = "https://cdn.example/t.jpg";

    expect(
      fill({}, { thumbnail_height: "90", thumbnail_url, thumbnail_width: "120" })
    ).toStrictEqual({ image: thumbnail_url, imageHeight: 90, imageWidth: 120 });

    expect(fill({}, { thumbnail_height: -3, thumbnail_url, thumbnail_width: 1.5 })).toStrictEqual({
      image: thumbnail_url,
    });

    expect(fill({}, { thumbnail_height: 0, thumbnail_url, thumbnail_width: "wide" })).toStrictEqual(
      { image: thumbnail_url }
    );
  });

  it("does not keep a size alongside a thumbnail the page's own image replaced", () => {
    expect(
      fill(
        { image: "https://page.example/i.png" },
        { thumbnail_height: 90, thumbnail_url: "https://cdn.example/t.jpg", thumbnail_width: 120 }
      )
    ).toStrictEqual({ image: "https://page.example/i.png" });
  });

  it("drops a malformed field on its own, never the rest, and never throws", () => {
    expect(
      fill(
        {},
        {
          author_name: ["a"],
          thumbnail_url: 42,
          title: "Kept",
        }
      )
    ).toStrictEqual({ title: "Kept" });

    expect(fill({}, { author_name: "Kept", title: { text: "no" } })).toStrictEqual({
      site: "Kept",
    });

    expect(fill({}, { author_name: "   ", title: "" })).toStrictEqual({});
  });

  it("leaves the page as it was when the answer is not an object", () => {
    const page: PageRead = { title: "T" };

    for (const answer of [null, "title", 42, true, ["title"], []]) {
      expect(fill(page, answer)).toStrictEqual(page);
    }
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
