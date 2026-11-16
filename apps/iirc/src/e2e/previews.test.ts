/// <reference lib="dom" />
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { layerDaemon } from "@iirc/daemon";
import { connectPeer, layerLoopbackLinkFetch, startMinio, startNgircd } from "@iirc/daemon/testing";
import type { Ircd } from "@iirc/daemon/testing";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { HttpServer } from "effect/http";
import { chromium } from "playwright";
import type { Browser, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { layerWeb } from "../web.ts";
import { networkRow, run, solidPng, watchedPage } from "./daemon.ts";

const main = path.join(import.meta.dirname, "..", "main.ts");
const web = path.join(import.meta.dirname, "..", "..", "..", "web", "dist");

/**
 * Writes a screenshot of part of the page where `IIRC_E2E_SCREENSHOTS` says, if it says.
 * @param shown - What to capture.
 * @param name - The file's name.
 */
const shoot = async (shown: Locator, name: string) => {
  const directory = process.env.IIRC_E2E_SCREENSHOTS;

  if (directory !== undefined && directory !== "") {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, name), await shown.screenshot());
  }
};

/**
 * Starts a Daemon that serves the web frontend, with a Key and a Network on a private Ircd
 * that joins a Channel, and a peer in it.
 * @param options - The data directory, the fixture site's port, the Ircd, the Channel, and the Scope the Daemon lives in.
 * @returns Where it listens, the Key, a way to call its API, and the peer.
 */
const startStack = async (options: {
  readonly dataDir: string;
  readonly fixturePort: number;
  readonly ircd: Ircd;
  readonly channel: string;
  readonly scope: Scope.Scope;
}) => {
  const { channel, dataDir, fixturePort, ircd, scope } = options;
  const created = await run(["bun", main], "key", "create", "browser", "--data-dir", dataDir);
  const key = created.stdout.trim();

  const context = await Effect.runPromise(
    Effect.gen(function* () {
      const beside = yield* layerWeb({ _tag: "Directory", directory: web });

      return yield* Layer.buildWithScope(
        layerDaemon(
          { dataDir, linkFetch: layerLoopbackLinkFetch(fixturePort) },
          { host: "127.0.0.1", port: 0 },
          beside
        ),
        scope
      );
    }).pipe(Effect.provide(BunServices.layer))
  );

  const { address } = Context.get(context, HttpServer.HttpServer);

  if (address._tag === "UnixPathAddress") {
    throw new Error("the Daemon listens on a path");
  }

  const base = `http://127.0.0.1:${address.port}`;

  const api = async (method: string, route: string, body: string) =>
    await fetch(`${base}/api${route}`, {
      body,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      method,
    });

  const peer = await connectPeer({ host: ircd.host, nick: "peer", port: ircd.plainPort });

  peer.send(`JOIN ${channel}`);

  const configured = await api(
    "PUT",
    "/networks/private",
    JSON.stringify({
      channels: [{ name: channel }],
      declined: [],
      enabled: true,
      fallbackEncoding: "windows-1252",
      ircds: [{ host: ircd.host, port: ircd.plainPort, tls: false }],
      login: { _tag: "None" },
      nicks: ["iirc"],
      realname: "iirc",
      username: "iirc",
    })
  );

  return { api, base, configured, key, peer };
};

/**
 * Signs a page in and opens a Channel's log.
 * @param tab - The page.
 * @param stack - Where the Daemon listens and the Key.
 * @param channel - The Channel.
 * @returns The Channel's log.
 */
const openChannel = async (
  tab: Page,
  stack: { readonly base: string; readonly key: string },
  channel: string
) => {
  await tab.goto(stack.base);
  await tab.getByLabel("Key").fill(stack.key);
  await tab.getByRole("button", { name: "Sign in" }).click();
  await networkRow(tab);
  await tab.getByRole("row", { name: channel }).click();

  return tab.getByRole("log", { name: channel });
};

/**
 * Scrolls a Preview's image into view, waits until the browser has loaded it, and measures it.
 * @param row - The Preview's row.
 * @returns How tall it is drawn, how wide it is, and where it is from.
 */
const loadedImage = async (row: Locator) => {
  const image = row.locator("img");

  await image.scrollIntoViewIfNeeded();
  await expect
    .poll(async () => await image.evaluate((one: HTMLImageElement) => one.naturalWidth), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);

  const box = await image.boundingBox();

  return {
    height: box?.height ?? 0,
    naturalWidth: await image.evaluate((one: HTMLImageElement) => one.naturalWidth),
    src: (await image.getAttribute("src")) ?? "",
  };
};

const status = async (response: Promise<Response>) => {
  const { status: code } = await response;

  return code;
};

const page = (title: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>ignored</title>` +
  `<meta property="og:title" content="${title}">` +
  `<meta property="og:description" content="Cats, and the people who keep them.">` +
  `<meta property="og:site_name" content="Cat Fixture"></head><body>${title}</body></html>`;

describe("a link's Preview, end to end", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "iirc-previews-"));
  let browser: Browser | undefined;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    rmSync(directory, { force: true, recursive: true });
  });

  it("shows nothing until asked, then pending, ready, opened, and failed", async () => {
    if (browser === undefined) {
      throw new Error("no browser");
    }

    const { promise: released, resolve: release } = Promise.withResolvers<undefined>();

    const fixture = Bun.serve({
      fetch: async (request) => {
        const { pathname } = new URL(request.url);
        const html = { headers: { "content-type": "text/html; charset=utf-8" } };

        if (pathname === "/cats") {
          return new Response(page("All about cats"), html);
        }

        // A page with no tags of its own, whose oEmbed answer is on the same fixture.
        if (pathname === "/embedded") {
          return new Response(
            `<!doctype html><html><head><link rel="alternate" type="application/json+oembed" href="/oembed.json"></head><body></body></html>`,
            html
          );
        }

        if (pathname === "/oembed.json") {
          return Response.json({
            author_name: "Embed Author",
            html: "<script>document.title = 'hijacked'</script>",
            title: "From oEmbed",
            type: "rich",
          });
        }

        if (pathname === "/slow") {
          await released;

          return new Response(page("Worth the wait"), html);
        }

        return new Response("<!doctype html><html><head></head><body></body></html>", html);
      },
      hostname: "127.0.0.1",
      port: 0,
    });

    const ircd = await startNgircd();
    const channel = "#previews";

    const scope = await Effect.runPromise(Scope.make());

    try {
      const stack = await startStack({
        channel,
        dataDir: path.join(directory, "data"),
        fixturePort: fixture.port ?? 0,
        ircd,
        scope,
      });

      const { api, configured, peer } = stack;
      const site = `http://127.0.0.1:${fixture.port}`;
      const cats = `${site}/cats`;
      const slow = `${site}/slow`;
      const gone = `${site}/gone`;

      const { page: tab, problems } = await watchedPage(browser);

      const refused: string[] = [];

      tab.on("response", (response) => {
        if (response.status() === 401) {
          refused.push(new URL(response.url()).pathname);
        }
      });

      const log = await openChannel(tab, stack, channel);

      // Wait until the Daemon has joined, then the peer speaks.
      await expect
        .poll(
          async () => {
            peer.send(`PRIVMSG ${channel} :hello`);

            return await log.getByText("hello").count();
          },
          { interval: 500, timeout: 20_000 }
        )
        .toBeGreaterThan(0);

      peer.send(`PRIVMSG ${channel} :look ${cats} and ${slow} and ${gone}`);
      await log.getByRole("link", { name: cats }).waitFor();

      // Off: the plain links, and no Previews.
      const said = log.locator("[data-index]").filter({ hasText: "look " });
      const previews = log.getByRole("list", { name: "Previews" });

      const before = await previews.count();
      await shoot(said, "before-off.png");

      const set = await api("PUT", "/ui/previews", JSON.stringify({ value: "links only" }));

      // Pending: `/slow` is held, so it pulses while the others settle.
      const pending = previews.locator('[data-preview="pending"]');

      await pending.filter({ hasText: `Previewing ${slow}` }).waitFor();

      const ready = previews.locator('[data-preview="ready"]');
      const summary = "Cat Fixture · All about cats";
      const opener = previews.getByRole("button", { name: summary });

      await opener.waitFor();
      const whileSlow = await pending.count();
      await shoot(said, "after-pending.png");
      await shoot(said, "after-ready.png");

      // Opened: the description shows.
      const closed = await opener.getAttribute("aria-expanded");

      await opener.click();
      const opened = await opener.getAttribute("aria-expanded");
      await previews.getByText("Cats, and the people who keep them.").waitFor();
      await shoot(said, "after-opened.png");

      // Failed: the plain link, with its reason.
      const failed = previews.locator('[data-preview="failed"]');

      await failed.waitFor();

      const failure = failed.getByRole("link", { name: gone });

      const reason = (await failure.getAttribute("title")) ?? "";
      await shoot(said, "after-failed.png");

      // Released: `/slow` becomes ready.
      release();
      await previews.getByRole("button", { name: "Cat Fixture · Worth the wait" }).waitFor();

      // An oEmbed address the page names, fetched through the real guard: its title shows.
      peer.send(`PRIVMSG ${channel} :embedded ${site}/embedded`);
      // It has no description, so its summary is not a button.
      await previews
        .locator('[data-preview="ready"]', { hasText: "Embed Author · From oEmbed" })
        .waitFor();
      const hijacked = await tab.title();

      expect({
        before,
        closed,
        configured: configured.status,
        failedWith: reason.startsWith("No preview: "),
        hijacked: hijacked === "hijacked",
        opened,
        pendingAfter: await pending.count(),
        pendingWhileSlow: whileSlow,
        problems: problems.filter((problem) => !problem.includes("401")),
        readyAfter: await ready.count(),
        refused,
        set: set.status,
      }).toStrictEqual({
        before: 0,
        closed: "false",
        configured: 200,
        failedWith: true,
        hijacked: false,
        opened: "true",
        pendingAfter: 0,
        pendingWhileSlow: 1,
        problems: [],
        readyAfter: 3,
        // The page asks who is signed in before anyone is, and is told no.
        refused: ["/api/networks"],
        set: 200,
      });

      peer.close();
    } finally {
      release();
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await fixture.stop(true);
      await ircd.stop();
    }
  }, 90_000);

  it("draws a page's image as a thumbnail and an image link as the image, from the bucket", async () => {
    if (browser === undefined) {
      throw new Error("no browser");
    }

    const thumbnail = solidPng(96, [220, 90, 60]);
    const wide = solidPng(600, [40, 120, 200]);
    const png = { headers: { "content-type": "image/png" } };

    const fixture = Bun.serve({
      fetch: (request) => {
        const { pathname } = new URL(request.url);

        if (pathname === "/thumb.png") {
          return new Response(thumbnail, png);
        }

        if (pathname === "/big.png") {
          return new Response(wide, png);
        }

        return new Response(
          `<!doctype html><html><head><meta charset="utf-8"><title>ignored</title>` +
            `<meta property="og:title" content="A page with a picture">` +
            `<meta property="og:image" content="/thumb.png"></head><body></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } }
        );
      },
      hostname: "127.0.0.1",
      port: 0,
    });

    const [minio, ircd] = await Promise.all([startMinio(), startNgircd()]);
    const channel = "#images";

    const scope = await Effect.runPromise(Scope.make());

    try {
      const stack = await startStack({
        channel,
        dataDir: path.join(directory, "images-data"),
        fixturePort: fixture.port ?? 0,
        ircd,
        scope,
      });

      const { api, peer } = stack;

      const held = await Promise.all(
        Object.entries({
          "minio-key": minio.accessKeyId,
          "minio-secret": minio.secretAccessKey,
        }).map(
          async ([name, value]) =>
            await status(api("PUT", `/credentials/${name}`, JSON.stringify({ value })))
        )
      );

      const options = {
        "store.s3.accessKeyId": "minio-key",
        "store.s3.bucket": minio.bucket,
        "store.s3.endpoint": minio.endpoint,
        "store.s3.region": minio.region,
        "store.s3.secretAccessKey": "minio-secret",
      };

      const set = await Promise.all(
        Object.entries(options).map(
          async ([option, value]) =>
            await status(api("PUT", `/options/${option}`, JSON.stringify({ value })))
        )
      );

      const on = await status(api("PUT", "/ui/previews", JSON.stringify({ value: "on" })));

      const { page: tab, problems } = await watchedPage(browser);
      const log = await openChannel(tab, stack, channel);

      await expect
        .poll(
          async () => {
            peer.send(`PRIVMSG ${channel} :hello`);

            return await log.getByText("hello").count();
          },
          { interval: 500, timeout: 20_000 }
        )
        .toBeGreaterThan(0);

      const site = `http://127.0.0.1:${fixture.port}`;

      peer.send(`PRIVMSG ${channel} :page ${site}/cat`);
      peer.send(`PRIVMSG ${channel} :image ${site}/big.png`);

      const ready = log.locator('[data-preview="ready"]');
      const pageRow = ready.filter({ has: tab.locator('img[data-drawn="thumbnail"]') });
      const imageRow = ready.filter({ has: tab.locator('img[data-drawn="whole"]') });

      await pageRow.waitFor();
      await imageRow.waitFor();

      const thumbnailDrawn = await loadedImage(pageRow);
      const imageDrawn = await loadedImage(imageRow);

      await shoot(pageRow, "preview-thumbnail.png");
      await shoot(imageRow, "preview-image-link.png");

      expect({
        imageLink: {
          drawnTallerThan260: imageDrawn.height > 260,
          loaded: imageDrawn.naturalWidth > 0,
          mediaRoute: /^\/api\/previews\/media\/[0-9a-f]{64}$/u.test(imageDrawn.src),
        },
        // The page asks who is signed in before anyone is, and is told no.
        problems: problems.filter((problem) => !problem.includes("401")),
        statuses: [...held, ...set, on],
        thumbnail: {
          loaded: thumbnailDrawn.naturalWidth > 0,
          mediaRoute: /^\/api\/previews\/media\/[0-9a-f]{64}$/u.test(thumbnailDrawn.src),
        },
      }).toStrictEqual({
        imageLink: { drawnTallerThan260: false, loaded: true, mediaRoute: true },
        problems: [],
        statuses: [204, 204, 200, 200, 200, 200, 200, 200],
        thumbnail: { loaded: true, mediaRoute: true },
      });

      peer.close();
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await fixture.stop(true);
      await Promise.all([minio.stop(), ircd.stop()]);
    }
  }, 120_000);
});
