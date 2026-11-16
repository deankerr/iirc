/// <reference lib="dom" />
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { layerDaemon } from "@iirc/daemon";
import { connectPeer, layerLoopbackLinkFetch, startNgircd } from "@iirc/daemon/testing";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { HttpServer } from "effect/http";
import { chromium } from "playwright";
import type { Browser, Locator } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { layerWeb } from "../web.ts";
import { networkRow, run, watchedPage } from "./daemon.ts";

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
    const dataDir = path.join(directory, "data");
    const created = await run(["bun", main], "key", "create", "browser", "--data-dir", dataDir);
    const key = created.stdout.trim();
    const scope = await Effect.runPromise(Scope.make());

    try {
      const context = await Effect.runPromise(
        Effect.gen(function* () {
          const beside = yield* layerWeb({ _tag: "Directory", directory: web });

          return yield* Layer.buildWithScope(
            layerDaemon(
              { dataDir, linkFetch: layerLoopbackLinkFetch(fixture.port ?? 0) },
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

      const channel = "#previews";
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

      await tab.goto(base);
      await tab.getByLabel("Key").fill(key);
      await tab.getByRole("button", { name: "Sign in" }).click();
      await networkRow(tab);
      await tab.getByRole("row", { name: channel }).click();

      const log = tab.getByRole("log", { name: channel });

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

      expect({
        before,
        closed,
        configured: configured.status,
        failedWith: reason.startsWith("No preview: "),
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
        opened: "true",
        pendingAfter: 0,
        pendingWhileSlow: 1,
        problems: [],
        readyAfter: 2,
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
});
