import type { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { fillFromOembed, readMedia, readOembed, readPage, readText } from "./read.ts";
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

const players = (text: string) => read(text).players;

const sized = (width: string | undefined, height: string | undefined) =>
  players(
    `<meta property="og:video" content="https://a.example/">${
      width === undefined ? "" : `<meta property="og:video:width" content="${width}">`
    }${height === undefined ? "" : `<meta property="og:video:height" content="${height}">`}`
  )?.[0]?.size;

describe("the players a page names", () => {
  it("reads Vimeo's og:video and twitter:player, each sized by its own tags", () => {
    expect(
      players(`<meta name="twitter:player" content="https://player.vimeo.com/video/76979871?h=8272103f6e">
        <meta name="twitter:player:width" content="640">
        <meta name="twitter:player:height" content="360">
        <meta property="og:video:url" content="https://player.vimeo.com/video/1?h=a">
        <meta property="og:video:width" content="1280">
        <meta property="og:video:height" content="720">`)
    ).toStrictEqual([
      { link: "https://player.vimeo.com/video/1?h=a", size: { height: 720, width: 1280 } },
      {
        link: "https://player.vimeo.com/video/76979871?h=8272103f6e",
        size: { height: 360, width: 640 },
      },
    ]);
  });

  it("tries og:video:secure_url, og:video:url, og:video, then twitter:player", () => {
    expect(
      players(`<meta name="twitter:player" content="https://d.example/">
        <meta property="og:video" content="https://c.example/">
        <meta property="og:video:url" content="https://b.example/">
        <meta property="og:video:secure_url" content="https://a.example/">`)?.map(
        ({ link }) => link
      )
    ).toStrictEqual([
      "https://a.example/",
      "https://b.example/",
      "https://c.example/",
      "https://d.example/",
    ]);
  });

  it("drops an address that repeats, and keeps the first one's size", () => {
    expect(
      players(`<meta property="og:video:secure_url" content="https://a.example/p">
        <meta property="og:video:url" content="https://a.example/p">
        <meta property="og:video:width" content="10">
        <meta property="og:video:height" content="20">`)
    ).toStrictEqual([{ link: "https://a.example/p", size: { height: 20, width: 10 } }]);
  });

  it("resolves an address against the page's address, or its <base>", () => {
    expect(players(`<meta property="og:video" content="/embed/1">`)).toStrictEqual([
      { link: "https://example.com/embed/1", size: null },
    ]);
    expect(
      players(`<base href="https://b.example/x/"><meta property="og:video" content="embed/1">`)
    ).toStrictEqual([{ link: "https://b.example/x/embed/1", size: null }]);
  });

  it("is dropped unless it is http or https, and when empty", () => {
    expect(
      players(`<meta property="og:video" content="javascript:alert(1)">
        <meta property="og:video:url" content="data:text/html,x">
        <meta property="og:video:secure_url" content="  ">`)
    ).toBeUndefined();
  });

  it("gives a size only when both are positive integers in plain decimal digits", () => {
    expect([
      sized("640", "360"),
      sized(" 640 ", "360"),
      sized("640", undefined),
      sized(undefined, "360"),
      sized("0", "360"),
      sized("640", "0"),
      sized("640px", "360"),
      sized("64.5", "360"),
      sized("-640", "360"),
      sized("1e3", "360"),
      sized("0x40", "360"),
      sized("", "360"),
      sized("99999999999999999999", "360"),
    ]).toStrictEqual([
      { height: 360, width: 640 },
      { height: 360, width: 640 },
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});

const GIPHY = "https://media.giphy.com/media/X/giphy.mp4";

// The video a page reads as, naming Giphy's file with a type, or none.
const named = (type: string | undefined) =>
  read(
    `<meta property="og:video" content="${GIPHY}">${
      type === undefined ? "" : `<meta property="og:video:type" content="${type}">`
    }`
  ).video;

describe("the video file a page names", () => {
  it("prefers an entry's og:video:secure_url to its own address, og:video or og:video:url", () => {
    const type = `<meta property="og:video:type" content="video/webm">`;

    expect({
      secure: read(`<meta property="og:video" content="http://c.example/v.webm">
        <meta property="og:video:secure_url" content="https://a.example/v.webm">${type}`).video,
      url: read(`<meta property="og:video:url" content="https://b.example/v.webm">${type}`).video
        ?.link,
    }).toStrictEqual({
      secure: { link: "https://a.example/v.webm", type: "video/webm" },
      url: "https://b.example/v.webm",
    });
  });

  it("keeps the type's essence, lower-cased, without its parameters", () => {
    expect(
      read(`<meta property="og:video" content="${GIPHY}">
        <meta property="og:video:type" content=" Video/MP4 ; codecs=avc1 ">`).video
    ).toStrictEqual({ link: GIPHY, type: "video/mp4" });
  });

  it("resolves the address against the page's, and takes only http or https", () => {
    expect(
      read(`<meta property="og:video" content="/v/1.mp4">
        <meta property="og:video:type" content="video/mp4">`).video?.link
    ).toBe("https://example.com/v/1.mp4");
    expect(
      read(`<meta property="og:video:secure_url" content="javascript:alert(1)">
        <meta property="og:video" content="${GIPHY}">
        <meta property="og:video:type" content="video/mp4">`).video?.link
    ).toBe(GIPHY);
    expect(
      read(`<meta property="og:video" content="data:video/mp4;base64,AAAA">
        <meta property="og:video:type" content="video/mp4">`).video
    ).toBeUndefined();
  });

  it("is absent when the page gives no type, or one that is not a plain video type", () => {
    expect(
      [
        named(undefined),
        named(""),
        named("application/x-shockwave-flash"),
        named("video"),
        named("video/"),
        named("video/mp4 extra"),
        named("video/mp4/x"),
        named("video/<b>"),
        named("audio/mpeg"),
      ].filter((video) => video !== undefined)
    ).toStrictEqual([]);
  });

  it("keeps each og:video entry's own address and type, as OpenGraph arrays them", () => {
    const player = "https://example.com/embed/1";

    expect({
      // A file, then a player whose secure address follows it: the file at its own address.
      fileFirst: read(`<meta property="og:video" content="${GIPHY}">
        <meta property="og:video:type" content="video/mp4">
        <meta property="og:video" content="${player}">
        <meta property="og:video:secure_url" content="${player}">
        <meta property="og:video:type" content="text/html">`).video,
      // A player, then a file: the file, found past the player.
      playerFirst: read(`<meta property="og:video" content="${player}">
        <meta property="og:video:secure_url" content="${player}">
        <meta property="og:video:type" content="text/html">
        <meta property="og:video" content="${GIPHY}">
        <meta property="og:video:type" content="video/mp4">`).video,
      // og:video:url repeating og:video is the same entry.
      repeated: read(`<meta property="og:video" content="${GIPHY}">
        <meta property="og:video:url" content="${GIPHY}">
        <meta property="og:video:type" content="video/mp4">`).video,
      // An entry's type is its own: the address after it takes none of it.
      typeOfAnother: read(`<meta property="og:video" content="${player}">
        <meta property="og:video:type" content="video/mp4">
        <meta property="og:video" content="${GIPHY}">`).video?.link,
    }).toStrictEqual({
      fileFirst: { link: GIPHY, type: "video/mp4" },
      playerFirst: { link: GIPHY, type: "video/mp4" },
      repeated: { link: GIPHY, type: "video/mp4" },
      typeOfAnother: player,
    });
  });

  it("is absent when the page names no video address", () => {
    expect(read(`<meta property="og:video:type" content="video/mp4">`).video).toBeUndefined();
  });
});

// The test runs where the platform is little-endian, so a 16-bit array's bytes are UTF-16LE.
const utf16le = (text: string): number[] => [
  ...new Uint8Array(Uint16Array.from(text, (ch) => ch.codePointAt(0) ?? 0).buffer),
];

describe(readText, () => {
  it.each([
    ["UTF-8 by default", utf8("héllo\nworld"), undefined, "héllo\nworld"],
    ["UTF-8 with no charset parameter", utf8("héllo"), "text/plain", "héllo"],
    ["the header's charset", latin1("caf\u00E9"), "text/plain; charset=iso-8859-1", "café"],
    [
      "windows-1252 where it differs from Latin-1",
      bytes([0x93, 0x68, 0x69, 0x94]),
      "text/plain; charset=windows-1252",
      "\u201Chi\u201D",
    ],
    ["Shift_JIS", bytes([0x82, 0xb1, 0x82, 0xf1]), 'text/plain; charset="Shift_JIS"', "こん"],
    ["UTF-16LE named by the header", bytes(utf16le("hi")), "text/plain; charset=utf-16le", "hi"],
    [
      "the charset parameter itself, not one that ends in its name",
      utf8("caf\u00E9"),
      "text/plain; x-charset=windows-1252; charset=utf-8",
      "café",
    ],
    [
      "an unknown charset label, as UTF-8",
      utf8("héllo"),
      "text/plain; charset=nonsense-9",
      "héllo",
    ],
    ["a UTF-8 BOM, which is not kept", bytes([0xef, 0xbb, 0xbf], utf8("hi")), "text/plain", "hi"],
    [
      "a UTF-16LE BOM over a header that says otherwise",
      bytes([0xff, 0xfe], utf16le("hi")),
      "text/plain; charset=windows-1252",
      "hi",
    ],
    [
      "a UTF-16BE BOM",
      bytes([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]),
      "text/plain; charset=utf-8",
      "hi",
    ],
    ["CRLF as LF", utf8("a\r\nb\r\nc"), "text/plain", "a\nb\nc"],
    ["a lone CR as LF", utf8("a\rb\rc"), "text/plain", "a\nb\nc"],
    ["line breaks and indentation kept", utf8("a\n\n    b\n\tc"), "text/plain", "a\n\n    b\n\tc"],
    ["trailing whitespace dropped", utf8("a\nb  \n\n \t\n"), "text/plain", "a\nb"],
    ["leading blank lines dropped, indentation kept", utf8("\n \n\r\n  a"), "text/plain", "  a"],
    ["markup left as text", utf8("<b>hi</b> &amp;"), "text/plain", "<b>hi</b> &amp;"],
  ] as const)("reads %s", (_, input, contentType, expected) => {
    expect(readText(input, contentType)).toBe(expected);
  });

  it("cuts to 500 code points, never half a surrogate pair", () => {
    const text = readText(utf8("😀".repeat(501)), "text/plain");

    expect(text).toBe("😀".repeat(500));
  });

  it("drops the whitespace a cut leaves at its end", () => {
    expect(readText(utf8(`${"a".repeat(499)} \n b`), "text/plain")).toBe("a".repeat(499));
  });

  it("gives a text of exactly 500 code points whole", () => {
    expect(readText(utf8("a".repeat(500)), "text/plain")).toBe("a".repeat(500));
  });

  it.each([
    ["nothing", utf8("")],
    ["whitespace", utf8(" \r\n\t\n ")],
    ["a BOM alone", bytes([0xef, 0xbb, 0xbf])],
  ])("gives nothing for %s", (_, input) => {
    expect(readText(input, "text/plain")).toBeUndefined();
  });
});
