/// <reference lib="dom" />
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { layerDaemon } from "@iirc/daemon";
import { connectPeer, layerLoopbackLinkFetch, startMinio, startNgircd } from "@iirc/daemon/testing";
import type { Ircd } from "@iirc/daemon/testing";
import { Context, Effect, Exit, Layer, Schema, Scope } from "effect";
import { HttpServer } from "effect/http";
import { chromium } from "playwright";
import type { Browser, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { layerWeb } from "../web.ts";
import { networkRow, run, screenshot, solidPng, watchedPage } from "./daemon.ts";

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

/** Each Timeline's own choice of Previews, from the `ui` options read. */
const decodeChoices = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      options: Schema.Struct({ "previews.timelines": Schema.Record(Schema.String, Schema.String) }),
    })
  )
);

const page = (title: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>ignored</title>` +
  `<meta property="og:title" content="${title}">` +
  `<meta property="og:description" content="Cats, and the people who keep them.">` +
  `<meta property="og:site_name" content="Cat Fixture"></head><body>${title}</body></html>`;

/**
 * A short sound: one second of a sine tone, as a 16-bit mono PCM WAV file.
 * @returns The file's bytes.
 */
const toneWav = () => {
  const rate = 8000;
  const samples = rate;
  const bytes = Buffer.alloc(44 + samples * 2);

  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + samples * 2, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);

  for (let index = 0; index < samples; index += 1) {
    bytes.writeInt16LE(
      Math.round(8000 * Math.sin((2 * Math.PI * 440 * index) / rate)),
      44 + index * 2
    );
  }

  return new Uint8Array(bytes);
};

/**
 * A short video, made by the browser itself so that no binary is kept: three seconds of
 * moving colour, drawn on a canvas and recorded as VP8 WebM.
 * @param browser - The browser that records it.
 * @returns The file's bytes.
 */
const recordClip = async (browser: Browser) => {
  const recorder = await browser.newPage();

  try {
    const bytes = await recorder.evaluate(async () => {
      const canvas = document.createElement("canvas");

      canvas.width = 320;
      canvas.height = 180;

      const context = canvas.getContext("2d");

      if (context === null) {
        throw new Error("no canvas");
      }

      const media = new MediaRecorder(canvas.captureStream(15), {
        mimeType: "video/webm;codecs=vp8",
      });

      const chunks: Blob[] = [];

      media.addEventListener("dataavailable", (event) => chunks.push(event.data));

      const { promise: stopped, resolve: stop } = Promise.withResolvers<undefined>();

      media.addEventListener("stop", () => {
        stop(undefined);
      });

      media.start();

      let frame = 0;

      const drawing = setInterval(() => {
        context.fillStyle = `hsl(${(frame * 20) % 360} 70% 50%)`;
        context.fillRect(0, 0, 320, 180);
        context.fillStyle = "#fff";
        context.fillRect(10 + ((frame * 8) % 290), 80, 20, 20);
        frame += 1;
      }, 66);

      const { promise: recorded, resolve: record } = Promise.withResolvers<undefined>();

      setTimeout(() => {
        record(undefined);
      }, 3000);
      await recorded;
      clearInterval(drawing);
      media.stop();
      await stopped;

      return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
    });

    return new Uint8Array(bytes);
  } finally {
    await recorder.close();
  }
};

/**
 * Serves a file as a host that honours one `Range`.
 * @param request - The request.
 * @param file - The file's bytes and media type.
 * @returns The answer: `206` with `Content-Range` for a range, `200` otherwise.
 */
const served = (
  request: Request,
  file: { readonly bytes: Uint8Array<ArrayBuffer>; readonly type: string }
) => {
  const { bytes, type } = file;
  const headers = { "accept-ranges": "bytes", "content-type": type };
  const range = /^bytes=(?<from>\d*)-(?<to>\d*)$/u.exec(request.headers.get("range") ?? "");

  if (range?.groups === undefined) {
    return new Response(bytes, { headers });
  }

  const { from = "", to = "" } = range.groups;
  const first = from === "" ? Math.max(0, bytes.length - Number(to)) : Number(from);
  const last = from === "" || to === "" ? bytes.length - 1 : Math.min(Number(to), bytes.length - 1);

  return new Response(bytes.slice(first, last + 1), {
    headers: { ...headers, "content-range": `bytes ${first}-${last}/${bytes.length}` },
    status: 206,
  });
};

/**
 * A number as two bytes, least significant first, as a GIF writes it.
 * @param value - The number.
 * @returns Its bytes.
 */
const word = (value: number) => [value % 256, Math.floor(value / 256)];

/**
 * An animated GIF of two frames, each one solid colour, made here so that no binary is
 * kept. Its pixels are coded as literals, a clear code after every two, which keeps every
 * code three bits wide, so it needs no compressor.
 * @param side - Its width and height, in pixels.
 * @returns The file's bytes.
 */
const twoFrameGif = (side: number) => {
  // Red and blue, the two frames' colours, and two the table needs to hold four.
  const palette = [255, 0, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255];

  const coded = (colour: number) => {
    const bytes: number[] = [];
    let held = 0;
    let bits = 0;

    const put = (code: number) => {
      held += code * 2 ** bits;
      bits += 3;

      while (bits >= 8) {
        bytes.push(held % 256);
        held = Math.floor(held / 256);
        bits -= 8;
      }
    };

    for (let pixel = 0; pixel < side * side; pixel += 2) {
      put(4);
      put(colour);
      put(colour);
    }

    put(5);

    if (bits > 0) {
      bytes.push(held);
    }

    // Sub-blocks of at most 255 bytes, then the empty one that ends them.
    const blocks: number[] = [];

    for (let at = 0; at < bytes.length; at += 255) {
      const block = bytes.slice(at, at + 255);

      blocks.push(block.length, ...block);
    }

    return [2, ...blocks, 0];
  };

  const frame = (colour: number) => [
    [0x21, 0xf9, 4, 0, ...word(50), 0, 0],
    [0x2c, 0, 0, 0, 0, ...word(side), ...word(side), 0],
    coded(colour),
  ];

  return Uint8Array.from(
    [
      [...Buffer.from("GIF89a"), ...word(side), ...word(side), 0xf1, 0, 0],
      palette,
      // Loops for ever.
      [0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0],
      ...frame(0),
      ...frame(1),
      [0x3b],
    ].flat()
  );
};

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

  it("holds a Direct Message's link for a press, fetches it once pressed, and takes a Timeline's own choice from its menu", async () => {
    if (browser === undefined) {
      throw new Error("no browser");
    }

    const asked: string[] = [];

    const fixture = Bun.serve({
      fetch: (request) => {
        const { pathname } = new URL(request.url);

        asked.push(pathname);

        return new Response(page(pathname === "/dogs" ? "All about dogs" : "All about cats"), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
      hostname: "127.0.0.1",
      port: 0,
    });

    const ircd = await startNgircd();
    const channel = "#direct";

    const scope = await Effect.runPromise(Scope.make());

    try {
      const stack = await startStack({
        channel,
        dataDir: path.join(directory, "direct-data"),
        fixturePort: fixture.port ?? 0,
        ircd,
        scope,
      });

      const { api, peer } = stack;
      const site = `http://127.0.0.1:${fixture.port}`;
      const on = await status(api("PUT", "/ui/previews", JSON.stringify({ value: "links only" })));

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

      // A stranger's link in a Direct Message waits for a press, and nothing is fetched.
      peer.send(`PRIVMSG iirc :look ${site}/cats`);

      const row = tab.getByRole("row", { name: /^peer/u });

      await row.click();

      const direct = tab.getByRole("log", { name: "peer" });
      const said = direct.locator("[data-index]").filter({ hasText: "look " });
      const press = said.getByRole("button", { name: `Show a preview of ${site}/cats` });

      await press.waitFor();

      const waiting = {
        asked: [...asked],
        shown: await said.locator('[data-preview="waiting"]').textContent(),
      };

      await shoot(said, "direct-waiting.png");

      // Pressed: fetched, and its Preview shows.
      await press.click();
      await said.getByRole("button", { name: "Cat Fixture · All about cats" }).waitFor();
      await shoot(said, "direct-pressed.png");

      // The Timeline's menu chooses on for it, for every device.
      await row.click({ button: "right" });

      const menu = tab.getByRole("menu");

      await menu.waitFor();

      const marked = await menu
        .locator('[role="menuitemradio"][aria-checked="true"]')
        .textContent();

      await shoot(menu, "direct-menu.png");
      await menu.getByRole("menuitemradio", { exact: true, name: "on" }).click();

      const chosen = async () => {
        const read = await fetch(`${stack.base}/api/ui`, {
          headers: { authorization: `Bearer ${stack.key}` },
        });

        return Object.values(decodeChoices(await read.text()).options["previews.timelines"]);
      };

      await expect.poll(chosen, { timeout: 10_000 }).toStrictEqual(["on"]);

      // Chosen on, a new link there is fetched unpressed.
      peer.send(`PRIVMSG iirc :and ${site}/dogs`);
      await direct.getByRole("button", { name: "Cat Fixture · All about dogs" }).waitFor();

      expect({
        asked,
        marked,
        on,
        problems: problems.filter((problem) => !problem.includes("401")),
        waiting,
      }).toStrictEqual({
        asked: ["/cats", "/dogs"],
        marked: "✓default",
        on: 200,
        problems: [],
        waiting: { asked: [], shown: `${site}/catsshow preview` },
      });

      peer.close();
    } finally {
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

  it("draws a player's poster with a play button that says where it plays from, and loads nothing from there", async () => {
    if (browser === undefined) {
      throw new Error("no browser");
    }

    const poster = solidPng(400, [60, 90, 200]);
    const embed = "https://www.youtube.com/embed/dQw4w9WgXcQ";
    const asked: string[] = [];

    const fixture = Bun.serve({
      fetch: (request) => {
        const { pathname } = new URL(request.url);

        asked.push(pathname);

        if (pathname === "/poster.png") {
          return new Response(poster, { headers: { "content-type": "image/png" } });
        }

        return new Response(
          `<!doctype html><html><head><meta charset="utf-8"><title>ignored</title>` +
            `<meta property="og:title" content="A song everyone knows">` +
            `<meta property="og:site_name" content="YouTube">` +
            `<meta property="og:image" content="/poster.png">` +
            `<meta property="og:video:url" content="${embed}">` +
            `<meta property="og:video:secure_url" content="${embed}">` +
            `<meta property="og:video:type" content="text/html">` +
            `<meta property="og:video:width" content="1280">` +
            `<meta property="og:video:height" content="720"></head><body></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } }
        );
      },
      hostname: "127.0.0.1",
      port: 0,
    });

    const [minio, ircd] = await Promise.all([startMinio(), startNgircd()]);
    const channel = "#players";

    const scope = await Effect.runPromise(Scope.make());

    try {
      const stack = await startStack({
        channel,
        dataDir: path.join(directory, "players-data"),
        fixturePort: fixture.port ?? 0,
        ircd,
        scope,
      });

      const { api, base, peer } = stack;

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
      const requested: string[] = [];

      tab.on("request", (request) => {
        requested.push(new URL(request.url()).origin);
      });

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

      peer.send(`PRIVMSG ${channel} :song http://127.0.0.1:${fixture.port}/watch`);

      const row = log.locator('[data-preview="ready"]');
      const button = row.getByRole("button", { name: "Play from www.youtube-nocookie.com" });

      await button.waitFor();

      const drawn = await loadedImage(row);

      await shoot(row, "preview-player.png");

      const hover = button.locator("xpath=..");

      await hover.hover();
      await shoot(log, "preview-player-hover.png");

      expect({
        disabled: await button.isDisabled(),
        frames: await tab.locator("iframe, frame, embed, object").count(),
        hover: await hover.getAttribute("title"),
        mediaRoute: /^\/api\/previews\/media\/[0-9a-f]{64}$/u.test(drawn.src),
        posterLoaded: drawn.naturalWidth > 0,
        // The page asks who is signed in before anyone is, and is told no.
        problems: problems.filter((problem) => !problem.includes("401")),
        statuses: [...held, ...set, on],
      }).toStrictEqual({
        disabled: true,
        frames: 0,
        hover: "plays from www.youtube-nocookie.com",
        mediaRoute: true,
        posterLoaded: true,
        problems: [],
        statuses: [204, 204, 200, 200, 200, 200, 200, 200],
      });

      // The browser spoke to the Daemon alone, and the player's address was never fetched.
      expect({
        embedFetched: asked.filter((pathname) => pathname.startsWith("/embed/")),
        origins: [...new Set(requested)],
      }).toStrictEqual({ embedFetched: [], origins: [base] });

      peer.close();
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await fixture.stop(true);
      await Promise.all([minio.stop(), ircd.stop()]);
    }
  }, 120_000);

  it("shows an animated image still under a play badge until pressed, and opens an image large over the whole screen", async () => {
    if (browser === undefined) {
      throw new Error("no browser");
    }

    const still = solidPng(1000, [40, 120, 200]);
    const moving = twoFrameGif(64);

    const fixture = Bun.serve({
      fetch: (request) => {
        const { pathname } = new URL(request.url);

        if (pathname === "/still.png") {
          return new Response(still, { headers: { "content-type": "image/png" } });
        }

        if (pathname === "/moving.gif") {
          return new Response(moving, { headers: { "content-type": "image/gif" } });
        }

        return new Response("", { status: 404 });
      },
      hostname: "127.0.0.1",
      port: 0,
    });

    const [minio, ircd] = await Promise.all([startMinio(), startNgircd()]);
    const channel = "#large";

    const scope = await Effect.runPromise(Scope.make());

    try {
      const stack = await startStack({
        channel,
        dataDir: path.join(directory, "large-data"),
        fixturePort: fixture.port ?? 0,
        ircd,
        scope,
      });

      const { api, peer } = stack;

      await Promise.all(
        Object.entries({
          "minio-key": minio.accessKeyId,
          "minio-secret": minio.secretAccessKey,
        }).map(
          async ([name, value]) =>
            await api("PUT", `/credentials/${name}`, JSON.stringify({ value }))
        )
      );

      await Promise.all(
        Object.entries({
          "store.s3.accessKeyId": "minio-key",
          "store.s3.bucket": minio.bucket,
          "store.s3.endpoint": minio.endpoint,
          "store.s3.region": minio.region,
          "store.s3.secretAccessKey": "minio-secret",
        }).map(
          async ([option, value]) =>
            await api("PUT", `/options/${option}`, JSON.stringify({ value }))
        )
      );

      await api("PUT", "/ui/previews", JSON.stringify({ value: "on" }));

      const { page: tab, problems } = await watchedPage(browser);

      await tab.setViewportSize({ height: 800, width: 1280 });

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
      const stillLink = `${site}/still.png`;
      const movingLink = `${site}/moving.gif`;

      peer.send(`PRIVMSG ${channel} :still ${stillLink}`);
      peer.send(`PRIVMSG ${channel} :moving ${movingLink}`);

      // An animated image is its first frame, drawn on a canvas, under a play badge.
      const play = log.getByRole("button", { name: `Play ${movingLink}` });
      const movingRow = log.locator("[data-index]").filter({ hasText: "moving " });

      await play.waitFor({ timeout: 20_000 });

      const before = {
        badge: await play.locator('[data-badge="play"]').count(),
        canvas: await play.locator("canvas").count(),
        playing: await movingRow.locator("img[data-playing]").count(),
      };

      await shoot(movingRow, "after-animated-still.png");
      await play.click();
      await movingRow.locator("img[data-playing]").waitFor();

      const after = {
        badge: await movingRow.locator('[data-badge="play"]').count(),
        canvas: await movingRow.locator("canvas").count(),
        playing: await movingRow.locator("img[data-playing]").count(),
        src: ((await movingRow.locator("img[data-playing]").getAttribute("src")) ?? "").slice(0, 5),
      };

      await shoot(movingRow, "after-animated-playing.png");

      // A still image opens large over the whole screen, with a link to its page.
      const open = log.getByRole("button", { name: `Open ${stillLink} large` });
      const dialog = tab.getByRole("dialog");

      await open.waitFor({ timeout: 20_000 });
      await open.click();
      await dialog.waitFor();

      // The layer around the dialog, as large as the window, whatever Pane holds the Message.
      const covered = async () =>
        await dialog.evaluate((element) => {
          let layer: Element | null = element;

          while (layer !== null && getComputedStyle(layer).position !== "fixed") {
            layer = layer.parentElement;
          }

          const box = layer?.getBoundingClientRect();

          return {
            height: box?.height === window.innerHeight,
            width: box?.width === window.innerWidth,
          };
        });

      const largeDesktop = {
        covers: await covered(),
        href: await dialog.getByRole("link", { name: stillLink }).getAttribute("href"),
      };

      await screenshot(tab, "after-large-desktop.png");
      await tab.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });

      const focused = async () => await open.evaluate((one) => one === document.activeElement);

      await expect.poll(focused).toBe(true);

      // Narrow, as a phone is, and a press outside closes it.
      await tab.setViewportSize({ height: 844, width: 390 });
      await open.click();
      await dialog.waitFor();

      const largePhone = { covers: await covered() };

      await screenshot(tab, "after-large-phone.png");
      await tab.mouse.click(2, 2);
      await dialog.waitFor({ state: "hidden" });
      await expect.poll(focused).toBe(true);

      expect({
        after,
        before,
        largeDesktop,
        largePhone,
        problems: problems.filter((problem) => !problem.includes("401")),
      }).toStrictEqual({
        after: { badge: 0, canvas: 0, playing: 1, src: "blob:" },
        before: { badge: 1, canvas: 1, playing: 0 },
        largeDesktop: { covers: { height: true, width: true }, href: stillLink },
        largePhone: { covers: { height: true, width: true } },
        problems: [],
      });

      peer.close();
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await fixture.stop(true);
      await Promise.all([minio.stop(), ircd.stop()]);
    }
  }, 120_000);

  it("plays a video and a sound link in place, fetching nothing from the host until a press", async () => {
    if (browser === undefined) {
      throw new Error("no browser");
    }

    const video = { bytes: await recordClip(browser), type: "video/webm" };
    const sound = { bytes: toneWav(), type: "audio/wav" };
    const asked: { readonly path: string; readonly range: string | null }[] = [];

    const fixture = Bun.serve({
      fetch: (request) => {
        const { pathname } = new URL(request.url);

        asked.push({ path: pathname, range: request.headers.get("range") });

        if (pathname === "/clip.webm") {
          return served(request, video);
        }

        if (pathname === "/tone.wav") {
          return served(request, sound);
        }

        return new Response("", { status: 404 });
      },
      hostname: "127.0.0.1",
      port: 0,
    });

    const ircd = await startNgircd();
    const channel = "#media";

    const scope = await Effect.runPromise(Scope.make());

    try {
      const stack = await startStack({
        channel,
        dataDir: path.join(directory, "media-data"),
        fixturePort: fixture.port ?? 0,
        ircd,
        scope,
      });

      const { api, peer } = stack;
      const site = `http://127.0.0.1:${fixture.port}`;
      const on = await status(api("PUT", "/ui/previews", JSON.stringify({ value: "on" })));

      const { page: tab, problems } = await watchedPage(browser);

      const streamed: { readonly headers: Record<string, string>; readonly status: number }[] = [];

      tab.on("response", (response) => {
        if (new URL(response.url()).pathname.endsWith("/stream")) {
          streamed.push({ headers: response.headers(), status: response.status() });
        }
      });

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

      peer.send(`PRIVMSG ${channel} :clip ${site}/clip.webm`);
      peer.send(`PRIVMSG ${channel} :sound ${site}/tone.wav`);

      const player = log.locator('video[data-preview-media="video"]');
      const listener = log.locator('audio[data-preview-media="audio"]');

      await player.waitFor();
      await listener.waitFor();

      // Each is shot as its whole message, the link and its Preview.
      const clipRow = log.locator("[data-index]").filter({ hasText: "clip " });
      const soundRow = log.locator("[data-index]").filter({ hasText: "sound " });

      const drawn = {
        audio: {
          preload: await listener.getAttribute("preload"),
          src: await listener.getAttribute("src"),
        },
        video: {
          preload: await player.getAttribute("preload"),
          src: await player.getAttribute("src"),
        },
      };

      // Given the players a moment to fetch what they should not.
      await tab.waitForTimeout(1500);

      const beforePress = [...asked];

      await shoot(clipRow, "after-video-controls.png");
      await shoot(soundRow, "after-sound-controls.png");

      // Pressed: the video plays.
      await player.evaluate(async (one: HTMLVideoElement) => {
        await one.play();
      });

      await expect
        .poll(async () => await player.evaluate((one: HTMLVideoElement) => one.currentTime), {
          timeout: 20_000,
        })
        .toBeGreaterThan(0.3);

      await shoot(clipRow, "after-video-playing.png");

      const played = await player.evaluate((one: HTMLVideoElement) => ({
        error: one.error?.message ?? null,
        height: one.videoHeight,
        paused: one.paused,
      }));

      // And the sound.
      await listener.evaluate(async (one: HTMLAudioElement) => {
        await one.play();
      });

      await expect
        .poll(async () => await listener.evaluate((one: HTMLAudioElement) => one.currentTime), {
          timeout: 20_000,
        })
        .toBeGreaterThan(0.2);

      await shoot(soundRow, "after-sound-playing.png");

      const heard = await listener.evaluate((one: HTMLAudioElement) => ({
        error: one.error?.message ?? null,
      }));

      const afterPress = asked.slice(beforePress.length);
      const pathsAfter = new Set(afterPress.map((request) => request.path));

      const streamRoute = /^\/api\/previews\/[^/]+\/stream\?/u;

      expect({
        afterPress: {
          audioRange: afterPress.some(
            (request) => request.path === "/tone.wav" && request.range !== null
          ),
          paths: [...pathsAfter].toSorted(),
          videoRange: afterPress.some(
            (request) => request.path === "/clip.webm" && request.range !== null
          ),
        },
        beforePress: {
          ranged: beforePress.filter((request) => request.range !== null),
          // Only each Preview's own fetch of the link, headers read and the body left.
          reads: beforePress.map((request) => request.path).toSorted(),
        },
        drawn: {
          audio: { preload: drawn.audio.preload, stream: streamRoute.test(drawn.audio.src ?? "") },
          video: { preload: drawn.video.preload, stream: streamRoute.test(drawn.video.src ?? "") },
        },
        heard,
        on,
        played: { ...played, height: played.height > 0 },
        // The page asks who is signed in before anyone is, and is told no.
        problems: problems.filter((problem) => !problem.includes("401")),
        streamedOk:
          streamed.length > 0 && streamed.every((one) => one.status === 200 || one.status === 206),
      }).toStrictEqual({
        afterPress: { audioRange: true, paths: ["/clip.webm", "/tone.wav"], videoRange: true },
        beforePress: { ranged: [], reads: ["/clip.webm", "/tone.wav"] },
        drawn: {
          audio: { preload: "none", stream: true },
          video: { preload: "none", stream: true },
        },
        heard: { error: null },
        on: 200,
        played: { error: null, height: true, paused: false },
        problems: [],
        streamedOk: true,
      });

      peer.close();
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await fixture.stop(true);
      await ircd.stop();
    }
  }, 120_000);
});
