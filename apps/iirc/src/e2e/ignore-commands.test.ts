/// <reference lib="dom" />
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { connectPeer } from "@iirc/daemon/testing";
import type { Peer } from "@iirc/daemon/testing";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { networkRow, screenshot, watchedPage } from "./daemon.ts";
import { privateNetwork } from "./testing/network.ts";

const main = path.join(import.meta.dirname, "..", "main.ts");
const web = path.join(import.meta.dirname, "..", "..", "..", "web", "dist");

describe("/ignore and /unignore, on iirc daemon --web", () => {
  let browser: Browser;
  let directory: string;

  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "iirc-ignore-commands-e2e-"));
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
    rmSync(directory, { force: true, recursive: true });
  });

  it(
    "lists the masks with /ignore alone, hides a nick's lines after /ignore nick, and shows them again after /unignore",
    { timeout: 120_000 },
    async () => {
      const channel = "#iirc-ignore";

      const { base, child, key, ngircd, peer } = await privateNetwork(
        ["bun", main],
        [`--web=${web}`],
        path.join(directory, "ignore-commands"),
        channel
      );

      let friend: Peer | undefined;

      try {
        friend = await connectPeer({ host: ngircd.host, nick: "friend", port: ngircd.plainPort });

        const { page, problems } = await watchedPage(browser);

        await page.setViewportSize({ height: 800, width: 1280 });
        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await networkRow(page);

        const row = page.getByRole("row", { name: new RegExp(`^${channel}`, "u") });
        const log = page.getByRole("log", { name: channel });
        const composer = page.getByRole("textbox", { name: channel });
        const ignores = page.getByRole("row", { name: "network.private.ignores" });

        /**
         * Types a line into the Channel's composer and sends it.
         * @param line - The line.
         */
        const type = async (line: string) => {
          await composer.fill(line);
          await composer.press("Enter");
        };

        await row.click();
        friend.send(`JOIN ${channel}`);
        peer.send(`PRIVMSG ${channel} :said before the ignore`);
        await log.getByText("said before the ignore").waitFor();

        // Alone, it lists what is ignored on the Network: nothing yet.
        await type("/ignore");
        await ignores.waitFor();
        await screenshot(page, "list-empty-desktop.png");
        await row.click();

        // Listed only once the Daemon took it, so what the peer says next comes after it.
        await type("/ignore peer");
        await type("/ignore");
        await ignores.getByText("peer!*@*", { exact: true }).waitFor();
        await screenshot(page, "list-desktop.png");
        await row.click();

        // The Ircd answers the peer's PING only once it has passed on what the peer said, so a
        // line of another User sent after the PONG reaches the Daemon after theirs.
        peer.send(`PRIVMSG ${channel} :said while ignored`);
        peer.send(`PART ${channel} :stepping out`);
        peer.send("PING :ordered");
        await peer.waitFor(
          (line) => line.command === "PONG" && line.params.at(-1) === "ordered",
          "the PONG"
        );
        friend.send(`PRIVMSG ${channel} :friend, after`);
        await log.getByText("friend, after").waitFor();
        await screenshot(page, "channel-desktop.png");

        const shown = (await log.textContent()) ?? "";

        expect({
          before: shown.includes("said before the ignore"),
          ignored: ["said while ignored", "stepping out"].filter((text) => shown.includes(text)),
        }).toStrictEqual({ before: true, ignored: [] });

        // Compared folded, so another spelling takes it out.
        await type("/unignore PEER");
        await log.getByText("said while ignored").waitFor();
        await log.getByText("stepping out").waitFor();
        await screenshot(page, "restored-desktop.png");

        expect(
          problems.filter((problem) => problem.includes("Content Security Policy"))
        ).toStrictEqual([]);
      } finally {
        friend?.close();
        peer.close();
        child.kill("SIGTERM");
        await child.exited;
        await ngircd.stop();
      }
    }
  );
});
