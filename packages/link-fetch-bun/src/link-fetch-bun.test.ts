import { gzipSync } from "node:zlib";

import { limits } from "@iirc/link-fetch";
import type { Purpose } from "@iirc/link-fetch";
import { loopbackPolicy } from "@iirc/link-fetch/testing";
import { Effect, Stream } from "effect";
import type { Scope } from "effect";
import { describe, expect, it, vi } from "vitest";

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

vi.setConfig({ testTimeout: 20_000 });

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
    const service = makeBunLinkFetch({ version: "1.2.3", ...guard });
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

  it("a name that does not resolve is unreachable", async () => {
    const outcome = await run(
      fetched(
        { policy: loopbackPolicy(1), resolver: scripted({}).resolver },
        "http://nowhere.test:1/"
      )
    );

    expect(outcome).toMatchObject({ failed: { _tag: "LinkUnreachable" } });
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
        // The same port on another loopback address, where a fetch by name would now go.
        const rebound = yield* serve(html, { address: "127.0.0.2", port: checked.port });
        const names = scripted({ "rebind.test": [["127.0.0.1"], ["127.0.0.2"]] });
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
      second: { failed: { _tag: "LinkRefused", reason: "127.0.0.2 is loopback" } },
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

        const rebound = yield* serve(html, { address: "127.0.0.2", port: checked.port });
        const names = scripted({ "rebind.test": [["127.0.0.1"], ["127.0.0.2"]] });

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
      failed: { _tag: "LinkRefused", reason: "127.0.0.2 is loopback" },
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
    ["a private name", "http://private.test/", "192.168.1.1 is private"],
    [
      "the metadata service",
      "http://169.254.169.254/latest/meta-data/",
      "169.254.169.254 is link-local",
    ],
    ["file:", "file:///etc/passwd", "scheme file:"],
    ["another port", "http://127.0.0.1:22/", "port 22"],
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

const rss = () => process.memoryUsage().rss;

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

const rawAttribute = (name: string) =>
  `<head><${name} data-x="</${name}><body>">ignored</${name}><title>Real title</title></head><body>x`;

describe("bounds are on the decompressed stream", () => {
  it.each([
    ["a page ends cleanly at its limit", "text/html", new Uint8Array(), page, "ended"],
    ["an image fails at its limit", "image/png", png, image, "LinkTooLarge"],
  ] as const)(
    "a 1 GiB gzip bomb is cut with bounded memory: %s",
    async (_, type, lead, purpose, ending) => {
      // Garbage is counted until it is collected, and a collector short of cores comes late, so
      // the baseline is taken after a full collection and the peak is sampled throughout.
      Bun.gc(true);
      const before = rss();
      let peak = before;

      const sampler = setInterval(() => {
        peak = Math.max(peak, rss());
      }, 1);

      const result = await run(
        Effect.gen(function* () {
          const site = yield* serve(bomb(type, lead));
          const service = makeBunLinkFetch({ policy: loopbackPolicy(site.port), version: "1.2.3" });
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

      clearInterval(sampler);
      const grown = Math.max(peak, rss()) - before;

      expect(result.end).toBe(ending);
      expect(result.size).toBeLessThanOrEqual(
        purpose.kind === "page" ? limits.page : limits.raster
      );
      expect(result.size).toBeGreaterThan(limits.page - 1);
      // Read whole, it holds at least the gibibyte it inflates to, and takes about 2 GB. Cut at
      // its cap, it holds a few MB, and its garbage peaks at tens of MB with cores to spare or a
      // few hundred without.
      expect(grown).toBeLessThan(512 * 1024 * 1024);
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

  it("a page ends at the end of its head", async () => {
    await expect(
      head(["<html><HEAD><title>t</title></HEAD>", "<body>secret</body>"])
    ).resolves.toBe("<html><HEAD><title>t</title></HEAD>");
  });

  it("a head's end tag may hold whitespace", async () => {
    await expect(
      head(["<html><head><title>t</title></Head >", "<meta name=late></head><body>secret"])
    ).resolves.toBe("<html><head><title>t</title></Head >");
  });

  it("a <body> in a script's string ends nothing", async () => {
    await expect(
      head([
        "<html><head><script>var s = '<body></head>';</script>",
        "<meta property=og:title content=T></head><body>secret",
      ])
    ).resolves.toBe(
      "<html><head><script>var s = '<body></head>';</script><meta property=og:title content=T></head>"
    );
  });

  it("a <body> in a comment or a style ends nothing", async () => {
    await expect(
      head([
        "<head><!-- <body> --><style>p:after{content:'</head>'}</style><title>T</title><body>x",
      ])
    ).resolves.toBe(
      "<head><!-- <body> --><style>p:after{content:'</head>'}</style><title>T</title>"
    );
  });

  it.each(["script", "style"])(
    "a %s's quoted attribute ends nothing, at every split",
    async (name) => {
      const page = rawAttribute(name);
      const read = page.slice(0, page.indexOf("<body>x"));

      for (let at = 1; at < page.length; at += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one split at a time, each its own server.
        await expect(head([page.slice(0, at), page.slice(at)])).resolves.toBe(read);
      }
    },
    60_000
  );

  it.each([
    ["before its <body>", "<head><title>T</title><body>x", "<head><title>T</title>"],
    ["after its </head >", "<head><title>T</title></head >x", "<head><title>T</title></head >"],
  ])(
    "a page ends %s however it is split",
    async (_, page, read) => {
      for (let at = 1; at < page.length; at += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one split at a time, each its own server.
        await expect(head([page.slice(0, at), page.slice(at)])).resolves.toBe(read);
      }
    },
    60_000
  );

  it("a tag held back at a chunk's end is given when the page ends", async () => {
    await expect(head(["<p>one <b", "o"])).resolves.toBe("<p>one <bo");
  });

  it("a <body> in a quoted attribute ends nothing", async () => {
    await expect(
      head(['<head><meta content="Use <body> here"><title>Real title</title></head><body>x'])
    ).resolves.toBe('<head><meta content="Use <body> here"><title>Real title</title></head>');
  });

  it("a quoted attribute is skipped across chunks", async () => {
    await expect(
      head([
        "<head><meta content='Use <bo",
        "dy> and </he",
        "ad> here' x=\"'\"><title>T</title></head>x",
      ])
    ).resolves.toBe(
      "<head><meta content='Use <body> and </head> here' x=\"'\"><title>T</title></head>"
    );
  });

  it("a tag whose name only starts like body ends nothing", async () => {
    await expect(head(["<head><bodyguard>", "<title>T</title></head>x"])).resolves.toBe(
      "<head><bodyguard><title>T</title></head>"
    );
  });

  it("comments and scripts are skipped across chunks", async () => {
    await expect(
      head([
        "<head><!",
        "-- <body> -",
        "-><scr",
        "ipt>'<body>'</scr",
        "ipt ><title>T</title></he",
        "ad",
        " >x",
      ])
    ).resolves.toBe("<head><!-- <body> --><script>'<body>'</script ><title>T</title></head >");
  });

  it("a page ends at its body when its head is never closed", async () => {
    await expect(head(["<html><title>t</title><BODY class=x>secret"])).resolves.toBe(
      "<html><title>t</title>"
    );
  });

  it("the end of a head is found across chunks", async () => {
    await expect(head(["<html><head><title>t</title></he", "ad>", "<body>secret"])).resolves.toBe(
      "<html><head><title>t</title></head>"
    );
  });

  it("a page with no head is read to its end", async () => {
    await expect(head(["<p>one", "two</p>"])).resolves.toBe("<p>onetwo</p>");
  });

  it("an oEmbed over 64 KB fails as it streams", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const site = yield* serve((_, response) => {
          response.writeHead(200, { "content-type": "application/json" });
          pour(response, encoder.encode(" ".repeat(16 * 1024)), 8);
        });

        return yield* fetched(
          { policy: loopbackPolicy(site.port) },
          `http://127.0.0.1:${site.port}/`,
          {
            kind: "oembed",
          }
        );
      })
    );

    expect(outcome).toMatchObject({ failed: { _tag: "LinkTooLarge", limit: limits.oembed } });
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

        const service = makeBunLinkFetch({ policy: loopbackPolicy(site.port), version: "1.2.3" });

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

        const service = makeBunLinkFetch({ policy: loopbackPolicy(site.port), version: "1.2.3" });
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
      accept: "text/html, application/xhtml+xml;q=0.9",
      "accept-language": "en, *;q=0.5",
      "user-agent": "iirc/1.2.3 (+https://github.com/deankerr/iirc) bot",
    });
    expect(headers).not.toHaveProperty("cookie");
    expect(headers).not.toHaveProperty("referer");
    expect(headers).not.toHaveProperty("range");
  });

  it.each([
    [image, "image/avif, image/webp, image/png, image/jpeg, image/gif, image/svg+xml;q=0.8"],
    [{ kind: "oembed" }, "application/json"],
    [{ kind: "stream" }, "video/*, audio/*"],
  ] as const)("asked for as $kind, it accepts %s", async (purpose, accept) => {
    const { headers } = await sent(purpose);

    expect(headers?.accept).toBe(accept);
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
});
