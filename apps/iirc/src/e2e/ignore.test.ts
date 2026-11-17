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

describe("ignoring a User by mask, on iirc daemon --web", () => {
  let browser: Browser;
  let directory: string;

  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "iirc-ignore-e2e-"));
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
    rmSync(directory, { force: true, recursive: true });
  });

  it(
    "hides what a User matching a mask says and does from the Timeline, keeps Self's and others', and shows it again when the mask is dropped",
    { timeout: 120_000 },
    async () => {
      const channel = "#iirc-ignore";

      const { api, base, child, key, ngircd, peer } = await privateNetwork(
        ["bun", main],
        [`--web=${web}`],
        path.join(directory, "ignore"),
        channel
      );

      let friend: Peer | undefined;

      /**
       * Puts the Network's Configuration, as the Owner's own.
       * @param ignores - The masks to ignore.
       */
      const configure = async (ignores: readonly string[]) => {
        const configured = await api(
          "PUT",
          "/networks/private",
          JSON.stringify({
            channels: [{ name: channel }],
            declined: [],
            enabled: true,
            fallbackEncoding: "windows-1252",
            ignores,
            ircds: [{ host: ngircd.host, port: ngircd.plainPort, tls: false }],
            login: { _tag: "None" },
            nicks: ["iirc"],
            realname: "iirc",
            username: "iirc",
          })
        );

        expect(configured.status).toBe(200);
      };

      try {
        friend = await connectPeer({ host: ngircd.host, nick: "friend", port: ngircd.plainPort });

        // The mask stands before they speak: it hides what is said from then on.
        await configure(["peer!*@*"]);

        const { page, problems } = await watchedPage(browser);

        await page.setViewportSize({ height: 800, width: 1280 });
        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await networkRow(page);
        await page.getByRole("row", { name: channel }).click();

        const log = page.getByRole("log", { name: channel });
        const composer = page.getByRole("textbox", { name: channel });

        // Both Users speak, one of them parts and joins again, and Self answers.
        friend.send(`JOIN ${channel}`);
        peer.send(`PRIVMSG ${channel} :hello from the peer`);
        friend.send(`PRIVMSG ${channel} :friend here, hello`);
        peer.send(`PART ${channel} :stepping out`);
        peer.send(`JOIN ${channel}`);
        peer.send(`PRIVMSG ${channel} :the peer is back, and has a lot to say`);

        await log.getByText("friend here, hello").waitFor();

        await composer.fill("hello, you two");
        await composer.press("Enter");
        await log.getByText("hello, you two").waitFor();

        // A line of another User after theirs is in the window, so nothing of theirs is merely late.
        friend.send(`PRIVMSG ${channel} :friend again, after`);
        peer.send(`PRIVMSG ${channel} :said while ignored`);
        friend.send(`PRIVMSG ${channel} :friend last`);
        await log.getByText("friend last").waitFor();

        const shown = (await log.textContent()) ?? "";

        // What of theirs shows, and what of the others' and Self's does.
        expect({
          friend: shown.includes("friend here, hello"),
          late: shown.includes("said while ignored"),
          none: ["hello from the peer", "the peer is back", "stepping out", "peer"].filter((text) =>
            shown.includes(text)
          ),
          self: shown.includes("hello, you two"),
        }).toStrictEqual({ friend: true, late: false, none: [], self: true });
        await screenshot(page, "after-channel-desktop.png");

        // The Network's options list the mask.
        await page.getByRole("button", { exact: true, name: "Options" }).click();
        await page.getByRole("searchbox", { name: "Filter options" }).fill("network.private.");

        const ignores = page.getByRole("row", { name: "network.private.ignores" });

        await ignores.getByText("peer!*@*", { exact: true }).waitFor();
        await screenshot(page, "after-options-desktop.png");

        // The mask goes, and everything they said, while it stood, is shown again.
        await configure([]);
        await page.getByRole("row", { name: /^#iirc-ignore, /u }).click();

        await log.getByText("hello from the peer").waitFor();
        await log.getByText("the peer is back, and has a lot to say").waitFor();
        await log.getByText("said while ignored").waitFor();
        await screenshot(page, "after-restored-desktop.png");

        const restored = (await log.textContent()) ?? "";

        expect({
          friend: restored.includes("friend here, hello"),
          problems: problems.filter((problem) => problem.includes("Content Security Policy")),
          self: restored.includes("hello, you two"),
        }).toStrictEqual({ friend: true, problems: [], self: true });
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
