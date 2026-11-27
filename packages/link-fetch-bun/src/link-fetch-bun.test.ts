import type * as Http from "node:http";
import { gzipSync } from "node:zlib";

import { limits, pacing } from "@iirc/link-fetch";
import type { Precedence, Purpose } from "@iirc/link-fetch";
import { loopbackPolicy } from "@iirc/link-fetch/testing";
import { Effect, Option, Schedule, Stream } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import { headEnd } from "./content.ts";
import { makeBunLinkFetch } from "./link-fetch-bun.ts";
import type { BunLinkFetchOptions } from "./link-fetch-bun.ts";
import {
  closes,
  environment,
  makeCertificate,
  pour,
  scripted,
  serve,
  tripwire,
} from "./testing/sites.ts";
import type { Handler, Site } from "./testing/sites.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const page: Purpose = { kind: "page" };
const image: Purpose = { kind: "image" };

const run = async <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(effect));

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

/** How a test builds the guard: its policy, usually admitting the test's site, and more. */
type Guard = Omit<BunLinkFetchOptions, "version">;

/**
 * Fetches a link with a guard and reads its body, or says why it failed.
 * @param guard - How the guard is built.
 * @param link - The link.
 * @param purpose - What it is for.
 * @returns The answer and its body, or the failure.
 */
const fetched = (guard: Guard, link: string, purpose: Purpose = page) =>
  Effect.gen(function* () {
    const service = yield* makeBunLinkFetch({ version: "1.2.3", ...guard });
    const answer = yield* service.fetch(link, purpose);
    const body = yield* Stream.mkUint8Array(answer.body);

    return { ...answer, body };
  }).pipe(
    Effect.match({
      onFailure: (failure) => ({ failed: failure }),
      onSuccess: (answer) => ({ answer }),
    })
  );

const plain =
  (type: string, body: Uint8Array | string, status = 200): Handler =>
  (_, response) => {
    response.writeHead(status, { "content-type": type });
    response.end(body);
  };

const html = plain(
  "text/html; charset=utf-8",
  "<html><head><title>hi</title></head><body>x</body></html>"
);

describe("every record is checked", () => {
  it("a name with one public and one private record is refused", async () => {
    const result = await run(
      Effect.gen(function* () {
        const site = yield* serve(html);
        const names = scripted({ "mixed.test": [["127.0.0.1", "10.0.0.1"]] });

        return {
          outcome: yield* fetched(
            { policy: loopbackPolicy(site.port), resolver: names.resolver },
            `http://mixed.test:${site.port}/`
          ),
          site,
        };
      })
    );

    expect(result.outcome).toMatchObject({
      failed: { _tag: "LinkRefused", reason: "10.0.0.1 is private" },
    });
    expect(result.site.connections.opened).toBe(0);
  });

  it("a name with no records is unreachable", async () => {
    const outcome = await run(
      fetched(
        { policy: loopbackPolicy(1), resolver: scripted({ "empty.test": [[]] }).resolver },
        "http://empty.test:1/"
      )
    );

    expect(outcome).toMatchObject({
      failed: { _tag: "LinkUnreachable", reason: "empty.test has no address" },
    });
  });

  it("a port with nothing on it is unreachable", async () => {
    const port = await run(serve(html).pipe(Effect.map((site) => site.port)));

    const outcome = await run(
      fetched({ policy: loopbackPolicy(port) }, `http://127.0.0.1:${port}/`)
    );

    expect(outcome).toMatchObject({ failed: { _tag: "LinkUnreachable" } });
  });
});

describe("the fetch is pinned to the checked address", () => {
  it("rebinding only ever reaches the checked address", async () => {
    const result = await run(
      Effect.gen(function* () {
        const checked = yield* serve(html);
        // The same port on the IPv6 loopback, where a fetch by name would now go.
        const rebound = yield* serve(html, { address: "::1", port: checked.port });
        const names = scripted({ "rebind.test": [["127.0.0.1"], ["::1"]] });
        const guard = { policy: loopbackPolicy(checked.port), resolver: names.resolver };
        const link = `http://rebind.test:${checked.port}/`;
        const first = yield* fetched(guard, link);
        const second = yield* fetched(guard, link);

        return { checked, first, lookups: names.lookups.get("rebind.test"), rebound, second };
      })
    );

    expect(result).toMatchObject({
      checked: { connections: { opened: 1 }, seen: [{ local: "127.0.0.1" }] },
      first: { answer: { status: 200 } },
      lookups: 2,
      rebound: { connections: { opened: 0 } },
      second: { failed: { _tag: "LinkRefused", reason: "::1 is loopback" } },
    });
    expect(result.checked.seen).toHaveLength(1);
  });

  it("a redirect to a name that now resolves privately is refused", async () => {
    const result = await run(
      Effect.gen(function* () {
        const checked = yield* serve((_, response) => {
          response.writeHead(302, { location: "/again" });
          response.end();
        });

        const rebound = yield* serve(html, { address: "::1", port: checked.port });
        const names = scripted({ "rebind.test": [["127.0.0.1"], ["::1"]] });

        return {
          checked,
          outcome: yield* fetched(
            { policy: loopbackPolicy(checked.port), resolver: names.resolver },
            `http://rebind.test:${checked.port}/`
          ),
          rebound,
        };
      })
    );

    expect(result.outcome).toMatchObject({
      failed: { _tag: "LinkRefused", reason: "::1 is loopback" },
    });
    expect(result.checked.seen).toHaveLength(1);
    expect(result.rebound.connections.opened).toBe(0);
  });

  it("SNI and Host name the original name while the peer is the address", async () => {
    const certificate = makeCertificate("preview.test");

    const result = await run(
      Effect.gen(function* () {
        const site = yield* serve(html, { certificate });
        const names = scripted({ "preview.test": [["127.0.0.1"]] });

        return {
          outcome: yield* fetched(
            {
              policy: loopbackPolicy(site.port),
              resolver: names.resolver,
              trust: [certificate.cert],
            },
            `https://preview.test:${site.port}/a?b=c#d`
          ),
          site,
        };
      })
    );

    expect(result.outcome).toMatchObject({ answer: { status: 200 } });
    expect(result.site.seen).toMatchObject([
      {
        headers: { host: `preview.test:${result.site.port}` },
        local: "127.0.0.1",
        servername: "preview.test",
        url: "/a?b=c",
      },
    ]);
  });

  it("a certificate for another name is refused by TLS", async () => {
    const certificate = makeCertificate("other.test");

    const outcome = await run(
      Effect.gen(function* () {
        const site = yield* serve(html, { certificate });
        const names = scripted({ "preview.test": [["127.0.0.1"]] });

        return yield* fetched(
          {
            policy: loopbackPolicy(site.port),
            resolver: names.resolver,
            trust: [certificate.cert],
          },
          `https://preview.test:${site.port}/`
        );
      })
    );

    expect(outcome).toMatchObject({ failed: { _tag: "LinkUnreachable" } });
  });
});

describe("the proxy environment is ignored", () => {
  const variables = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ];

  it("HTTP_PROXY, HTTPS_PROXY and ALL_PROXY are never used", async () => {
    const certificate = makeCertificate("preview.test");

    const result = await run(
      Effect.gen(function* () {
        const proxy = yield* tripwire;

        yield* environment(
          Object.fromEntries(variables.map((name) => [name, `http://127.0.0.1:${proxy.port}`]))
        );

        const site = yield* serve(html);
        const secure = yield* serve(html, { certificate });
        const names = scripted({ "preview.test": [["127.0.0.1"]] });

        const insecure = yield* fetched(
          { policy: loopbackPolicy(site.port) },
          `http://127.0.0.1:${site.port}/`
        );

        const tls = yield* fetched(
          {
            policy: loopbackPolicy(secure.port),
            resolver: names.resolver,
            trust: [certificate.cert],
          },
          `https://preview.test:${secure.port}/`
        );

        const guarded = proxy.tripped.count;

        // A fetch that does not refuse the proxy is sent through it, so the environment is in
        // force while the guard ignores it.
        const control = yield* Effect.promise(
          async () =>
            await fetch(`http://127.0.0.1:${site.port}/`).then(
              (response) => response.status,
              () => "failed"
            )
        );

        return { control, guarded, insecure, proxied: proxy.tripped.count, tls };
      })
    );

    expect(result).toMatchObject({
      control: "failed",
      guarded: 0,
      insecure: { answer: { status: 200 } },
      proxied: 1,
      tls: { answer: { status: 200 } },
    });
  });
});

const hops: Handler = (request, response) => {
  const left = Number(request.url?.split("/")[2] ?? "0");

  if (left === 0) {
    html(request, response);
  } else {
    response.writeHead(302, { location: `/r/${left - 1}` });
    response.end("moved");
  }
};

const followed = async (from: number) =>
  await run(
    Effect.gen(function* () {
      const site = yield* serve(hops);
      const names = scripted({ "hops.test": [["127.0.0.1"]] });

      return {
        outcome: yield* fetched(
          { policy: loopbackPolicy(site.port), resolver: names.resolver },
          `http://hops.test:${site.port}/r/${from}`
        ),
        site,
      };
    })
  );

const toImage: Handler = (request, response) => {
  if (request.url === "/pic.png") {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  } else {
    response.writeHead(302, { location: "/pic.png" });
    response.end("moved");
  }
};

describe("redirects", () => {
  it("three redirects are followed, each resolved against the last by name", async () => {
    const { outcome, site } = await followed(3);

    expect(outcome).toMatchObject({
      answer: { link: `http://hops.test:${site.port}/r/0`, status: 200 },
    });
    expect(site.seen.map((each) => [each.url, each.headers.host])).toStrictEqual(
      [3, 2, 1, 0].map((left) => [`/r/${left}`, `hops.test:${site.port}`])
    );
  });

  it("a redirect to an image, asked as a page, is a wrong type that names the final link", async () => {
    const { outcome, site } = await run(
      Effect.gen(function* () {
        const site = yield* serve(toImage);
        const names = scripted({ "hops.test": [["127.0.0.1"]] });

        return {
          outcome: yield* fetched(
            { policy: loopbackPolicy(site.port), resolver: names.resolver },
            `http://hops.test:${site.port}/`
          ),
          site,
        };
      })
    );

    expect(outcome).toMatchObject({
      failed: {
        _tag: "LinkWrongType",
        link: `http://hops.test:${site.port}/pic.png`,
        type: "image/png",
      },
    });
  });

  it("a fourth redirect is refused", async () => {
    const { outcome, site } = await followed(4);

    expect(outcome).toMatchObject({
      failed: { _tag: "LinkRefused", reason: "more than 3 redirects" },
    });
    expect(site.seen).toHaveLength(4);
  });

  it.each([
    ["a private address", "http://10.0.0.1/", "10.0.0.1 is private"],
    ["file:", "file:///etc/passwd", "scheme file:"],
  ])("a redirect to %s is refused", async (_, location, reason) => {
    const outcome = await run(
      Effect.gen(function* () {
        const site = yield* serve((_request, response) => {
          response.writeHead(301, { location });
          response.end();
        });

        const names = scripted({ "private.test": [["192.168.1.1"]] });

        return yield* fetched(
          { policy: loopbackPolicy(site.port), resolver: names.resolver },
          `http://127.0.0.1:${site.port}/`
        );
      })
    );

    expect(outcome).toMatchObject({ failed: { _tag: "LinkRefused", reason } });
  });
});

// Each gzip member is a mebibyte of zeros, so 1024 of them are a gibibyte.
const bomb =
  (type: string, lead: Uint8Array): Handler =>
  (_, response) => {
    const first = new Uint8Array(1024 * 1024);

    first.set(lead);
    response.writeHead(200, { "content-encoding": "gzip", "content-type": type });
    response.write(gzipSync(first));
    pour(response, gzipSync(new Uint8Array(1024 * 1024)), 1023);
  };

const head = async (chunks: readonly string[]) =>
  await run(
    Effect.gen(function* () {
      const site = yield* serve((_, response) => {
        response.writeHead(200, { "content-type": "text/html" });

        const write = (index: number) => {
          if (index === chunks.length) {
            response.end();
          } else {
            response.write(chunks[index]);
            setTimeout(() => {
              write(index + 1);
            }, 20);
          }
        };

        write(0);
      });

      const outcome = yield* fetched(
        { policy: loopbackPolicy(site.port) },
        `http://127.0.0.1:${site.port}/`
      );

      return "answer" in outcome ? decoder.decode(outcome.answer.body) : outcome;
    })
  );

/**
 * Reads a page split in two, as the guard reads a page's chunks: up to the end of its head.
 * @param page - The page.
 * @param at - Where the network split it.
 * @returns What is read of it.
 */
const splitAt = (page: string, at: number) => {
  const ends = headEnd();
  let read = "";

  for (const chunk of [page.slice(0, at), page.slice(at)]) {
    const { done, give } = ends.feed(encoder.encode(chunk));

    read += decoder.decode(give);

    if (done) {
      break;
    }
  }

  return read + decoder.decode(ends.flush());
};

// A head that names a card tag, which is a head a page ends after.
const card = `<meta property="og:title" content="T">`;

const rawAttribute = (name: string) =>
  `<head>${card}<${name} data-x="</${name}><body>">ignored</${name}><title>Real title</title></head><body>x`;

describe("bounds are on the decompressed stream", () => {
  it.each([
    ["a page ends cleanly at its limit", "text/html", new Uint8Array(), page, "ended"],
    ["an image fails at its limit", "image/png", png, image, "LinkTooLarge"],
  ] as const)(
    "a 1 GiB gzip bomb is cut at its limit: %s",
    async (_, type, lead, purpose, ending) => {
      const result = await run(
        Effect.gen(function* () {
          const site = yield* serve(bomb(type, lead));

          const service = yield* makeBunLinkFetch({
            policy: loopbackPolicy(site.port),
            version: "1.2.3",
          });

          const answer = yield* service.fetch(`http://127.0.0.1:${site.port}/`, purpose);
          let size = 0;

          const end = yield* Stream.runForEach(answer.body, (chunk) =>
            Effect.sync(() => {
              size += chunk.length;
            })
          ).pipe(Effect.match({ onFailure: (failure) => failure._tag, onSuccess: () => "ended" }));

          return { closed: yield* closes(site), end, size };
        })
      );

      expect(result.end).toBe(ending);
      expect(result.size).toBeLessThanOrEqual(
        purpose.kind === "page" ? limits.page : limits.raster
      );
      expect(result.size).toBeGreaterThan(limits.page - 1);
      expect(result.closed).toBe(1);
    }
  );

  it("a head with no </head> stops at 1 MB and closes the connection", async () => {
    const written: { chunks: number }[] = [];

    const result = await run(
      Effect.gen(function* () {
        const site = yield* serve((_, response) => {
          response.writeHead(200, { "content-type": "text/html" });
          response.write("<html><head>");
          written.push(pour(response, encoder.encode("a".repeat(64 * 1024)), 1024));
        });

        const outcome = yield* fetched(
          { policy: loopbackPolicy(site.port) },
          `http://127.0.0.1:${site.port}/`
        );

        return { closed: yield* closes(site), outcome };
      })
    );

    expect(result.outcome).toMatchObject({ answer: { status: 200 } });
    expect("answer" in result.outcome && result.outcome.answer.body.length).toBe(limits.page);
    expect(written[0]?.chunks ?? 0).toBeLessThan(1024);
    expect(result.closed).toBe(1);
  });

  it("a page ends at the end of a head that names a card tag", async () => {
    await expect(
      head([`<html><HEAD>${card}<title>t</title></HEAD>`, "<body>secret</body>"])
    ).resolves.toBe(`<html><HEAD>${card}<title>t</title></HEAD>`);
  });

  it.each([
    ["names none", "<title>t</title>"],
    ["names one only in a comment and a script", "<!-- og: --><script>'og:'</script>"],
    ["names one only in its text", "<title>twitter: og:</title>"],
  ])("a page whose head %s is read to its end", async (_, inside) => {
    const page = `<html><head>${inside}</head><body><meta property="og:title" content="T"></body>`;

    await expect(head([page.slice(0, 20), page.slice(20)])).resolves.toBe(page);
  });

  it.each(["script", "style"])("a %s's quoted attribute ends nothing, at every split", (name) => {
    const page = rawAttribute(name);
    const read = page.slice(0, page.indexOf("<body>x"));

    for (let at = 1; at < page.length; at += 1) {
      expect(splitAt(page, at)).toBe(read);
    }
  });

  it.each([
    ["before its <body>", `<head>${card}<body>x`, `<head>${card}`],
    ["after its </head >", `<head>${card}</head >x`, `<head>${card}</head >`],
    [
      "by a twitter tag",
      "<head><meta name=twitter:card></head>x",
      "<head><meta name=twitter:card></head>",
    ],
  ])("a page ends %s however it is split", (_, page, read) => {
    for (let at = 1; at < page.length; at += 1) {
      expect(splitAt(page, at)).toBe(read);
    }
  });

  it("a tag held back at a chunk's end is given when the page ends", async () => {
    await expect(head(["<p>one <b", "o"])).resolves.toBe("<p>one <bo");
  });

  it("a quoted attribute is skipped across chunks", async () => {
    await expect(
      head([
        "<head><meta property=og:description content='Use <bo",
        "dy> and </he",
        "ad> here' x=\"'\"><title>T</title></head>x",
      ])
    ).resolves.toBe(
      "<head><meta property=og:description content='Use <body> and </head> here' x=\"'\"><title>T</title></head>"
    );
  });

  it("a tag whose name only starts like body ends nothing", async () => {
    await expect(head([`<head><bodyguard>${card}`, "<title>T</title></head>x"])).resolves.toBe(
      `<head><bodyguard>${card}<title>T</title></head>`
    );
  });

  it("comments and scripts are skipped across chunks", async () => {
    await expect(
      head([
        "<head><!",
        "-- <body> -",
        "-><scr",
        "ipt>'<body>'</scr",
        `ipt >${card}<title>T</title></he`,
        "ad",
        " >x",
      ])
    ).resolves.toBe(
      `<head><!-- <body> --><script>'<body>'</script >${card}<title>T</title></head >`
    );
  });

  it("a page with no head is read to its end", async () => {
    await expect(head(["<p>one", "two</p>"])).resolves.toBe("<p>onetwo</p>");
  });

  // A body that has reached its cap and not yet ended may have more to come, and waiting to
  // find out could wait for ever, so the guard counts it too large unless its declared length
  // says it is whole.
  it("a body of exactly its cap that never ends is cut at once", async () => {
    const result = await run(
      Effect.gen(function* () {
        const site = yield* serve((_, response) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.write(new Uint8Array(limits.oembed).fill(0x20));
        });

        const outcome = yield* fetched(
          { policy: loopbackPolicy(site.port) },
          `http://127.0.0.1:${site.port}/`,
          { kind: "oembed" }
        ).pipe(
          Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.succeed("hung") })
        );

        return { closed: yield* closes(site), outcome };
      })
    );

    expect(result).toMatchObject({
      closed: 1,
      outcome: { failed: { _tag: "LinkTooLarge", limit: limits.oembed } },
    });
  });

  it("a body of exactly its cap whose length says so is taken whole", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const site = yield* serve((_, response) => {
          response.writeHead(200, {
            "content-length": String(limits.oembed),
            "content-type": "application/json",
          });
          response.end(new Uint8Array(limits.oembed).fill(0x20));
        });

        return yield* fetched(
          { policy: loopbackPolicy(site.port) },
          `http://127.0.0.1:${site.port}/`,
          { kind: "oembed" }
        );
      })
    );

    expect("answer" in outcome && outcome.answer.body.length).toBe(limits.oembed);
  });

  it("closing the caller's Scope mid-body closes the connection", async () => {
    const closed = await run(
      Effect.gen(function* () {
        const site = yield* serve((_, response) => {
          response.writeHead(200, { "content-type": "video/mp4" });
          response.write("....");
        });

        const service = yield* makeBunLinkFetch({
          policy: loopbackPolicy(site.port),
          version: "1.2.3",
        });

        yield* Effect.scoped(service.fetch(`http://127.0.0.1:${site.port}/`, { kind: "stream" }));

        return yield* closes(site);
      })
    );

    expect(closed).toBe(1);
  });

  it("a reader that stops early closes the connection", async () => {
    const closed = await run(
      Effect.gen(function* () {
        const site = yield* serve((_, response) => {
          response.writeHead(200, { "content-type": "video/mp4" });
          response.write("....");
        });

        const service = yield* makeBunLinkFetch({
          policy: loopbackPolicy(site.port),
          version: "1.2.3",
        });

        const answer = yield* service.fetch(`http://127.0.0.1:${site.port}/`, { kind: "stream" });

        yield* Stream.runHead(answer.body);

        return yield* closes(site);
      })
    );

    expect(closed).toBe(1);
  });

  it("a declared length over the cap is refused before the body is read", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const site = yield* serve((_, response) => {
          response.writeHead(200, {
            "content-length": String(limits.svg + 1),
            "content-type": "image/svg+xml",
          });
          response.write("<svg");
        });

        return yield* fetched(
          { policy: loopbackPolicy(site.port) },
          `http://127.0.0.1:${site.port}/`,
          image
        );
      })
    );

    expect(outcome).toMatchObject({ failed: { _tag: "LinkTooLarge", limit: limits.svg } });
  });
});

const answered = async (handler: Handler, purpose: Purpose) =>
  await run(
    Effect.gen(function* () {
      const site = yield* serve(handler);

      return yield* fetched(
        { policy: loopbackPolicy(site.port) },
        `http://127.0.0.1:${site.port}/`,
        purpose
      );
    })
  );

/**
 * A host answering 404 with a type, whose body never comes.
 * @param type - The type.
 * @returns The handler.
 */
const errorWithheld =
  (type: string): Handler =>
  (_request, response) => {
    response.writeHead(404, { "content-type": type });
    response.flushHeaders();
  };

const gif = encoder.encode("GIF89a\u0001\u0000\u0001\u0000");
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const webp = encoder.encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ");

const avif = Uint8Array.from([
  0,
  0,
  0,
  28,
  ...encoder.encode("ftypmif1\u0000\u0000\u0000\u0000mif1avifmiaf"),
]);

const svg = encoder.encode('﻿  <?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');

const prologSvg = encoder.encode(
  `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: an editor -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n  <!ENTITY ns "http://www.w3.org/2000/svg">\n]>\n${" ".repeat(400)}<svg\n  xmlns="http://www.w3.org/2000/svg"/>`
);

const chunked =
  (chunks: readonly Uint8Array[]): Handler =>
  (_, response) => {
    response.writeHead(200, { "content-type": "image/svg+xml" });

    const write = (index: number) => {
      if (index === chunks.length) {
        response.end();
      } else {
        response.write(chunks[index]);
        setTimeout(() => {
          write(index + 1);
        }, 20);
      }
    };

    write(0);
  };

describe("an image's type is told from its first KiB however it arrives", () => {
  const late = encoder.encode(`${" ".repeat(1500)}<svg/>`);
  const early = encoder.encode(`${" ".repeat(900)}<svg/>`);

  it.each([
    ["past it, in one chunk", [late], "LinkWrongType"],
    ["past it, in two chunks", [late.subarray(0, 700), late.subarray(700)], "LinkWrongType"],
    ["within it, in one chunk", [early], "image/svg+xml"],
    ["within it, in two chunks", [early.subarray(0, 450), early.subarray(450)], "image/svg+xml"],
  ] as const)("an SVG root %s", async (_, chunks, expected) => {
    const outcome = await answered(chunked(chunks), image);

    expect("answer" in outcome ? outcome.answer.type : outcome.failed._tag).toBe(expected);
  });
});

describe("types", () => {
  it.each([
    ["a page", "text/html; charset=utf-8", encoder.encode("<p>"), page, "text/html"],
    [
      "an XHTML page",
      "application/xhtml+xml",
      encoder.encode("<p>"),
      page,
      "application/xhtml+xml",
    ],
    ["a PNG", "image/png", png, image, "image/png"],
    ["a JPEG named image/jpg", "image/jpg", jpeg, image, "image/jpeg"],
    ["a GIF", "image/gif", gif, image, "image/gif"],
    ["a WebP", "image/webp", webp, image, "image/webp"],
    ["an AVIF", "image/avif", avif, image, "image/avif"],
    ["an SVG", "image/svg+xml", svg, image, "image/svg+xml"],
    ["an SVG after a prolog", "image/svg+xml", prologSvg, image, "image/svg+xml"],
    ["an oEmbed", "application/json", encoder.encode("{}"), { kind: "oembed" }, "application/json"],
    ["a video", "video/mp4", encoder.encode("...."), { kind: "stream" }, "video/mp4"],
    ["a sound", "audio/ogg", encoder.encode("OggS"), { kind: "stream" }, "audio/ogg"],
  ] as const)("%s is taken", async (_, type, body, purpose, taken) => {
    await expect(answered(plain(type, body), purpose)).resolves.toMatchObject({
      answer: { body, type: taken },
    });
  });

  it.each([
    ["an image asked for as a page", "image/png", png, page],
    ["a page with no type", "", encoder.encode("<p>"), page],
    [
      "a PNG header over HTML bytes",
      "image/png",
      encoder.encode("<html><head></head></html>"),
      image,
    ],
    ["a JPEG named a PNG", "image/png", jpeg, image],
    ["an SVG named a PNG", "image/png", svg, image],
    ["an empty image", "image/gif", new Uint8Array(), image],
    ["HTML named an SVG", "image/svg+xml", encoder.encode("<html><svg></svg></html>"), image],
    [
      "HTML after an XML declaration named an SVG",
      "image/svg+xml",
      encoder.encode('<?xml version="1.0"?><html><body>not svg</body></html>'),
      image,
    ],
    ["a root that only starts like svg", "image/svg+xml", encoder.encode("<svgx/>"), image],
    [
      "HTML behind a quoted ]> in a DOCTYPE named an SVG",
      "image/svg+xml",
      encoder.encode('<?xml version="1.0"?><!DOCTYPE html [<!ENTITY bait "]><svg/>">]><html/>'),
      image,
    ],
    ["a BMP", "image/bmp", encoder.encode("BM...."), image],
    ["an oEmbed as HTML", "text/html", encoder.encode("{}"), { kind: "oembed" }],
    ["a stream as HTML", "text/html", encoder.encode("<p>"), { kind: "stream" }],
  ] as const)("%s is a wrong type", async (_, type, body, purpose) => {
    const handler: Handler = (_request, response) => {
      response.writeHead(200, type === "" ? {} : { "content-type": type });
      response.end(body);
    };

    await expect(answered(handler, purpose)).resolves.toMatchObject({
      failed: { _tag: "LinkWrongType" },
    });
  });

  // The body never comes, so a fetch that waited for any of it would time out.
  it.each([
    ["a page", "text/html", page],
    ["a page answered as an image", "image/png", page],
    ["an image", "image/png", image],
    ["an image answered as a page", "text/html", image],
    ["an oEmbed answered as a page", "text/html", { kind: "oembed" }],
  ] as const)("%s that answers with an error is its status alone", async (_, type, purpose) => {
    await expect(answered(errorWithheld(type), purpose)).resolves.toMatchObject({
      answer: { body: new Uint8Array(), status: 404, type },
    });
  });
});

/**
 * A host answering 200 with a type and a length, whose body never comes.
 * @param type - The type.
 * @param length - The length it declares.
 * @returns The handler.
 */
const withheld =
  (type: string, length: number): Handler =>
  (_request, response) => {
    response.writeHead(200, { "content-length": length, "content-type": type });
    response.flushHeaders();
  };

describe("a plain-text file", () => {
  const text = "line one\nline two\n";

  it("within its bound is whole, with the length it declared", async () => {
    const handler: Handler = (_request, response) => {
      response.writeHead(200, {
        "content-length": text.length,
        "content-type": "text/plain; charset=utf-8",
      });
      response.end(text);
    };

    await expect(answered(handler, page)).resolves.toMatchObject({
      answer: { body: encoder.encode(text), length: text.length, type: "text/plain" },
    });
  });

  // One mebibyte, declared or streamed, and more than the host would ever stop sending.
  it.each([
    [
      "declared whole",
      ((_request, response) => {
        response.writeHead(200, { "content-length": 1024 * 1024, "content-type": "text/plain" });
        response.end("a".repeat(1024 * 1024));
      }) satisfies Handler,
    ],
    [
      "streamed",
      ((_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        pour(response, encoder.encode("a".repeat(8 * 1024)), 128);
      }) satisfies Handler,
    ],
  ] as const)("past its bound ends cleanly at it, %s", async (_, handler) => {
    const result = await run(
      Effect.gen(function* () {
        const site = yield* serve(handler);

        const outcome = yield* fetched(
          { policy: loopbackPolicy(site.port) },
          `http://127.0.0.1:${site.port}/`
        );

        return { closed: yield* closes(site), outcome };
      })
    );

    expect(result.outcome).toMatchObject({ answer: { status: 200, type: "text/plain" } });
    expect("answer" in result.outcome && result.outcome.answer.body.length).toBe(limits.text);
    expect(result.closed).toBe(1);
  });

  it("asked for as anything but a page is a wrong type", async () => {
    await expect(answered(plain("text/plain", text), image)).resolves.toMatchObject({
      failed: { _tag: "LinkWrongType", type: "text/plain" },
    });
  });
});

describe("a type the purpose does not take", () => {
  it.each([
    ["declared", { "content-length": "5" }, 5],
    ["declared and identity", { "content-encoding": "identity", "content-length": "5" }, 5],
    ["compressed", { "content-encoding": "gzip" }, null],
    ["not declared", {}, null],
  ] as const)("is a wrong type that carries its length when %s", async (_, headers, length) => {
    const handler: Handler = (_request, response) => {
      response.writeHead(200, { ...headers, "content-type": "application/pdf" });
      response.end(
        "content-encoding" in headers && headers["content-encoding"] === "gzip"
          ? gzipSync("%PDF-")
          : "%PDF-"
      );
    };

    await expect(answered(handler, page)).resolves.toMatchObject({
      failed: { _tag: "LinkWrongType", length, type: "application/pdf" },
    });
  });

  // Its body never comes, so a fetch that waited for any byte of it would time out.
  it("is refused before any byte of its body is read", async () => {
    await expect(answered(withheld("application/pdf", 10), page)).resolves.toMatchObject({
      failed: { _tag: "LinkWrongType", length: 10, type: "application/pdf" },
    });
  });
});

const sent = async (purpose: Purpose, handler: Handler = html) =>
  await run(
    Effect.gen(function* () {
      const site: Site = yield* serve(handler);

      const outcome = yield* fetched(
        { policy: loopbackPolicy(site.port) },
        `http://127.0.0.1:${site.port}/`,
        purpose
      );

      return { headers: site.seen[0]?.headers, outcome };
    })
  );

describe("what is sent", () => {
  it("an honest user agent, an Accept for the purpose, a fixed language, and no cookie or Referer", async () => {
    const { headers } = await sent(page);

    expect(headers).toMatchObject({
      accept: "text/html, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1",
      "accept-language": "en, *;q=0.5",
      "user-agent": "iirc/1.2.3 (+https://github.com/deankerr/iirc) bot",
    });
    expect(headers).not.toHaveProperty("cookie");
    expect(headers).not.toHaveProperty("referer");
    expect(headers).not.toHaveProperty("range");
  });

  it("asked for as an image, it accepts images", async () => {
    const { headers } = await sent(image);

    expect(headers?.accept).toBe(
      "image/avif, image/webp, image/png, image/jpeg, image/gif, image/svg+xml;q=0.8"
    );
  });

  it("a stream's range is passed on as one Range, and a 206 is answered", async () => {
    const { headers, outcome } = await sent(
      { kind: "stream", range: { end: 100, start: 0 } },
      (_, response) => {
        response.writeHead(206, {
          "content-range": "bytes 0-99/1000",
          "content-type": "video/mp4",
        });
        response.end(new Uint8Array(100));
      }
    );

    expect(headers).toMatchObject({ "accept-encoding": "identity", range: "bytes=0-99" });
    expect(outcome).toMatchObject({
      answer: { headers: { "content-range": "bytes 0-99/1000" }, status: 206, type: "video/mp4" },
    });
  });

  it("a range with no end runs to the end", async () => {
    const { headers } = await sent(
      { kind: "stream", range: { start: 500 } },
      plain("video/mp4", "....")
    );

    expect(headers?.range).toBe("bytes=500-");
  });

  it.each([
    ["no type", {}],
    ["an HTML type", { "content-type": "text/html" }],
  ])("a stream's 416 with %s is answered with its Content-Range", async (_, type) => {
    const { outcome } = await sent({ kind: "stream", range: { start: 5000 } }, (__, response) => {
      response.writeHead(416, { "content-range": "bytes */1000", ...type });
      response.end();
    });

    expect(outcome).toMatchObject({
      answer: { headers: { "content-range": "bytes */1000" }, status: 416 },
    });
  });

  it("a stream that declares more than its cap is answered, to be cut off as it streams", async () => {
    const answered = await run(
      Effect.gen(function* () {
        const site = yield* serve((_, response) => {
          response.writeHead(200, {
            "content-length": String(limits.stream + 1),
            "content-type": "video/mp4",
          });
          response.write("....");
        });

        const service = yield* makeBunLinkFetch({
          policy: loopbackPolicy(site.port),
          version: "1.2.3",
        });

        const answer = yield* service.fetch(`http://127.0.0.1:${site.port}/`, { kind: "stream" });
        const first = yield* Stream.runHead(answer.body);

        return { first: Option.getOrUndefined(first)?.length, status: answer.status };
      }).pipe(Effect.scoped)
    );

    expect(answered).toStrictEqual({ first: 4, status: 200 });
  });
});

/** A site that holds each answer until it is let go, oldest first. */
interface Holding {
  readonly handler: Handler;
  /** Answers the oldest request still held, with a page. */
  readonly letGo: Effect.Effect<void>;
}

/**
 * Makes a site that holds every request to `/held/…` and redirects every other to the link
 * its path names after `/to/`.
 * @returns The site's handler, and what lets a held answer go.
 */
const holding = (): Holding => {
  const held: Http.ServerResponse[] = [];

  return {
    handler: (request, response) => {
      const url = request.url ?? "";

      if (url.startsWith("/to/")) {
        response.writeHead(302, { location: decodeURIComponent(url.slice("/to/".length)) });
        response.end();
      } else {
        held.push(response);
      }
    },
    letGo: Effect.sync(() => {
      const response = held.shift();

      response?.writeHead(200, { "content-type": "text/html" });
      response?.end("<html><head><title>held</title></head><body>x</body></html>");
    }),
  };
};

/**
 * The paths a site has seen, once it has seen as many as asked, or after two seconds.
 * @param site - The site.
 * @param count - How many to wait for.
 * @returns The paths.
 */
const seenPaths = (site: Site, count: number) =>
  Effect.suspend(() => Effect.succeed(site.seen.map((each) => each.url))).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 millis"),
      until: (seen) => seen.length >= count,
    }),
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.succeed(site.seen.map((each) => each.url)),
    })
  );

/**
 * A site that redirects `/go` to a link, and answers anything else as a page.
 * @param to - Where `/go` redirects, given the site's port.
 * @returns The handler.
 */
const redirecting =
  (to: (port: number) => string): Handler =>
  (request, response) => {
    if (request.url === "/go") {
      response.writeHead(302, { location: to(request.socket.localPort ?? 0) });
      response.end();
    } else {
      html(request, response);
    }
  };

describe("each hop is asked as its site answers it", () => {
  it("a redirect to a crawler's host sends the crawler agent, and a likely image asks for media", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const site = yield* serve(redirecting((port) => `http://www.reddit.com:${port}/r/a`));

        const names = scripted({
          "short.test": [["127.0.0.1"]],
          "www.reddit.com": [["127.0.0.1"]],
        });

        const guard = { policy: loopbackPolicy(site.port), resolver: names.resolver };

        yield* fetched(guard, `http://short.test:${site.port}/go`);
        yield* fetched(guard, `http://short.test:${site.port}/a.png`);

        return site.seen.map(({ headers, url }) => [url, headers["user-agent"], headers.accept]);
      })
    );

    const honest = "iirc/1.2.3 (+https://github.com/deankerr/iirc) bot";
    const pages = "text/html, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1";

    expect(seen).toStrictEqual([
      ["/go", honest, pages],
      [
        "/r/a",
        "Mozilla/5.0 (compatible; iirc/1.2.3; +https://github.com/deankerr/iirc) facebookexternalhit/1.1 Twitterbot/1.0",
        pages,
      ],
      [
        "/a.png",
        honest,
        "image/avif, image/webp, image/png, image/jpeg, image/gif, image/svg+xml;q=0.8, video/*;q=0.8, audio/*;q=0.8",
      ],
    ]);
  });

  it("a redirect to an X post is rewritten, and the rewrite is checked as any link", async () => {
    const result = await run(
      Effect.gen(function* () {
        const site = yield* serve(redirecting((port) => `http://x.com:${port}/someone/status/1`));

        const names = scripted({
          "fixupx.com": [["127.0.0.1"]],
          "short.test": [["127.0.0.1"]],
          "x.com": [["127.0.0.1"]],
        });

        const outcome = yield* fetched(
          { policy: loopbackPolicy(site.port), resolver: names.resolver },
          `http://short.test:${site.port}/go`
        );

        return { lookups: Object.fromEntries(names.lookups), outcome, seen: site.seen.length };
      })
    );

    // The rewrite is to fixupx.com on 443, where the policy admits no loopback address.
    expect(result).toMatchObject({
      outcome: { failed: { _tag: "LinkRefused", reason: "127.0.0.1 is loopback" } },
      seen: 1,
    });
    expect(result.lookups).toStrictEqual({ "fixupx.com": 1, "short.test": 1 });
  });
});

describe("fetches are paced", () => {
  /** One for each of a name's places. */
  const places = Array.from({ length: pacing.perName }, (_, at) => at);

  it("a redirect gives up the name it left, and goes by the name it goes to once that name frees a place", async () => {
    const paths = await run(
      Effect.gen(function* () {
        const site = holding();
        const listening = yield* serve(site.handler);
        const names = scripted({ "a.test": [["127.0.0.1"]], "b.test": [["127.0.0.1"]] });
        const at = (name: string, path: string) => `http://${name}:${listening.port}${path}`;

        const service = yield* makeBunLinkFetch({
          policy: loopbackPolicy(listening.port),
          resolver: names.resolver,
          version: "1.2.3",
        });

        const fetching = (link: string) =>
          Effect.forkChild(
            Effect.scoped(
              Effect.flatMap(service.fetch(link, page), (answer) => Stream.runDrain(answer.body))
            )
          );

        for (const held of places) {
          yield* fetching(at("b.test", `/held/b${held}`));
        }

        yield* seenPaths(listening, pacing.perName);
        yield* fetching(
          at("a.test", `/to/${encodeURIComponent(at("b.test", "/held/redirected"))}`)
        );
        yield* seenPaths(listening, pacing.perName + 1);

        // Were the redirect still holding its place at a.test, one of these would wait.
        for (const held of places) {
          yield* fetching(at("a.test", `/held/a${held}`));
        }

        const waiting = yield* seenPaths(listening, 2 * pacing.perName + 1);

        yield* site.letGo;

        return {
          after: (yield* seenPaths(listening, 2 * pacing.perName + 2)).slice(
            2 * pacing.perName + 1
          ),
          waiting,
        };
      })
    );

    expect(paths.waiting).toStrictEqual(expect.arrayContaining(places.map((at) => `/held/a${at}`)));
    expect(paths.after).toStrictEqual(["/held/redirected"]);
  });

  it("counts a fetch waiting for a name as started only once it goes", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const site = holding();
        const listening = yield* serve(site.handler);

        const others = Array.from(
          { length: pacing.perMinute - pacing.perName },
          (_, at) => `n${at}.test`
        );

        const names = scripted(
          Object.fromEntries(["a.test", ...others].map((name) => [name, [["127.0.0.1"]]]))
        );

        const service = yield* makeBunLinkFetch({
          policy: loopbackPolicy(listening.port),
          resolver: names.resolver,
          version: "1.2.3",
        });

        const fetching = (name: string, path: string) =>
          Effect.forkChild(
            Effect.scoped(
              Effect.flatMap(
                service.fetch(`http://${name}:${listening.port}${path}`, page),
                (answer) => Stream.runDrain(answer.body)
              )
            )
          );

        for (const at of places) {
          yield* fetching("a.test", `/held/a${at}`);
        }

        yield* seenPaths(listening, pacing.perName);
        // It waits for a.test, which holds all its places, and has not started.
        yield* fetching("a.test", "/held/waits");

        for (const name of others) {
          yield* fetching(name, `/held/${name}`);
        }

        return (yield* seenPaths(listening, pacing.perMinute)).length;
      })
    );

    // Those holding a.test's places and all the others start within the minute.
    expect(seen).toBe(pacing.perMinute);
  });

  it("gives a name's freed place to a first fetch ahead of a refresh asked after it", async () => {
    const after = await run(
      Effect.gen(function* () {
        const site = holding();
        const listening = yield* serve(site.handler);
        const names = scripted({ "a.test": [["127.0.0.1"]] });

        const service = yield* makeBunLinkFetch({
          policy: loopbackPolicy(listening.port),
          resolver: names.resolver,
          version: "1.2.3",
        });

        const fetching = (path: string, precedence: Precedence) =>
          Effect.forkChild(
            Effect.scoped(
              Effect.flatMap(
                service.fetch(`http://a.test:${listening.port}${path}`, page, precedence),
                (answer) => Stream.runDrain(answer.body)
              )
            )
          );

        for (const at of places) {
          yield* fetching(`/held/${at}`, "first");
        }

        yield* seenPaths(listening, pacing.perName);
        // Both wait for a.test's place, the refresh asked last.
        yield* fetching("/held/first", "first");
        yield* fetching("/held/refresh", "refresh");
        yield* Effect.yieldNow.pipe(Effect.repeat({ times: 100 }));
        yield* site.letGo;

        return (yield* seenPaths(listening, pacing.perName + 1)).slice(pacing.perName);
      })
    );

    expect(after).toStrictEqual(["/held/first"]);
  });
});
