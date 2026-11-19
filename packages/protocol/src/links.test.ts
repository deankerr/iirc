import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { linksInRun, linksOf, previewableLinksOf } from "./links.ts";

const textsOf = (run: string) => linksInRun(run).map((link) => link.text);

const hostile = (brackets: number) => `https://example.org/${")".repeat(brackets)}`;

// How long the fastest of a few runs takes, so a pause on a busy machine counts for little.
const fastest = (run: string) =>
  Math.min(
    ...Array.from({ length: 5 }, () => {
      // oxlint-disable-next-line no-restricted-globals -- a test of how the work scales
      const started = performance.now();

      linksInRun(run);

      // oxlint-disable-next-line no-restricted-globals -- a test of how the work scales
      return performance.now() - started;
    })
  );

describe(linksInRun, () => {
  it("leaves out the punctuation that ends a sentence around a link", () => {
    expect(
      textsOf("see https://a.example/x. Or https://b.example/y, or (https://c.example/z)!")
    ).toStrictEqual(["https://a.example/x", "https://b.example/y", "https://c.example/z"]);
    expect(textsOf(`"https://a.example/q?x=1"?*`)).toStrictEqual(["https://a.example/q?x=1"]);
  });

  it("keeps a closing bracket the link opened and trims one it did not", () => {
    expect(
      linksInRun(
        "https://en.example/wiki/Foo_(bar) and (https://a.example/x) and https://b.example/[1]]"
      )
    ).toStrictEqual([
      {
        href: "https://en.example/wiki/Foo_(bar)",
        index: 0,
        scheme: "https",
        text: "https://en.example/wiki/Foo_(bar)",
      },
      { href: "https://a.example/x", index: 39, scheme: "https", text: "https://a.example/x" },
      { href: "https://b.example/[1]", index: 64, scheme: "https", text: "https://b.example/[1]" },
    ]);
  });

  it("writes the href as the URL parser does and keeps the text as written", () => {
    expect(linksInRun("go HTTPS://A.Example")).toStrictEqual([
      { href: "https://a.example/", index: 3, scheme: "https", text: "HTTPS://A.Example" },
    ]);
  });

  it("ends a link at a bidirectional character", () => {
    expect(
      linksInRun(
        "https://a.example/\u202Egnp.exe https://b.example/\u2066x https://c.example/\u200Fy"
      )
    ).toStrictEqual([
      { href: "https://a.example/", index: 0, scheme: "https", text: "https://a.example/" },
      { href: "https://b.example/", index: 27, scheme: "https", text: "https://b.example/" },
      { href: "https://c.example/", index: 48, scheme: "https", text: "https://c.example/" },
    ]);
  });

  it("finds no link without an allowed scheme or a host", () => {
    expect(
      linksInRun("data:text/html,x ftp://a.example file:///x irc:///x https://")
    ).toStrictEqual([]);
  });

  it("finds irc and ircs links", () => {
    expect(linksInRun("irc://a.example/#x ircs://b.example:6697/#y")).toStrictEqual([
      { href: "irc://a.example/#x", index: 0, scheme: "irc", text: "irc://a.example/#x" },
      {
        href: "ircs://b.example:6697/#y",
        index: 19,
        scheme: "ircs",
        text: "ircs://b.example:6697/#y",
      },
    ]);
  });

  it("trims a link's hostile brackets in linear time", () => {
    // Eight times the brackets takes about eight times as long, and sixty-four if quadratic.
    const small = fastest(hostile(8000));
    const large = fastest(hostile(64_000));

    expect({ found: textsOf(hostile(64_000)), scales: large < small * 24 }).toStrictEqual({
      found: ["https://example.org/"],
      scales: true,
    });
  });

  it("never throws, and finds links that sit in order inside the run", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (run) => {
        const found = linksInRun(run);

        expect(
          found.every(
            (link, at) =>
              run.slice(link.index, link.index + link.text.length) === link.text &&
              (at === 0 ||
                link.index >= (found[at - 1]?.index ?? 0) + (found[at - 1]?.text.length ?? 0))
          )
        ).toBeTruthy();
      })
    );
  });
});

describe(linksOf, () => {
  it("finds a link inside a formatted span, without the codes", () => {
    expect(
      linksOf("\u0002see\u0002 \u000304https://a.example/x\u0003 then \u001Fhttp://b.example\u001F")
    ).toStrictEqual([
      { href: "https://a.example/x", scheme: "https" },
      { href: "http://b.example/", scheme: "http" },
    ]);
  });

  it("finds a link that formatting splits only as far as its first span", () => {
    expect(linksOf("https://a.exam\u0002ple/x\u0002 and https://b.example/")).toStrictEqual([
      { href: "https://a.exam/", scheme: "https" },
      { href: "https://b.example/", scheme: "https" },
    ]);
  });
});

describe(previewableLinksOf, () => {
  it("keeps the first three links and not a fourth", () => {
    expect(
      previewableLinksOf(
        "https://a.example/1 https://a.example/2 http://a.example/3 https://a.example/4"
      )
    ).toStrictEqual([
      { href: "https://a.example/1", scheme: "https" },
      { href: "https://a.example/2", scheme: "https" },
      { href: "http://a.example/3", scheme: "http" },
    ]);
  });

  it("counts a repeated link once, so a later distinct link takes its place", () => {
    expect(
      previewableLinksOf(
        "HTTPS://A.example https://a.example/ https://a.example https://b.example/ https://c.example/ https://d.example/"
      )
    ).toStrictEqual([
      { href: "https://a.example/", scheme: "https" },
      { href: "https://b.example/", scheme: "https" },
      { href: "https://c.example/", scheme: "https" },
    ]);
  });

  it("finds irc and ircs links but never previews them", () => {
    const text = "irc://a.example/#x ircs://b.example/#y https://c.example/ irc://d.example/";

    expect({
      all: linksOf(text).map((link) => link.scheme),
      previewable: previewableLinksOf(text),
    }).toStrictEqual({
      all: ["irc", "ircs", "https", "irc"],
      previewable: [{ href: "https://c.example/", scheme: "https" }],
    });
  });

  it("counts an irc link toward nothing when it opens a Message of four links", () => {
    expect(
      previewableLinksOf(
        "irc://x.example/ https://a.example/ https://b.example/ https://c.example/"
      ).map((link) => link.href)
    ).toStrictEqual(["https://a.example/", "https://b.example/", "https://c.example/"]);
  });
});
