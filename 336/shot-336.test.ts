/// <reference lib="dom" />
// Scratch evidence for #336, never committed: a failed Preview in a waiting Direct Message.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";
import { it } from "vitest";

import { privateNetwork } from "./testing/network.ts";

const main = path.join(import.meta.dirname, "..", "main.ts");
const web = process.env.SHOT_WEB ?? "";
const out = process.env.SHOT_OUT ?? "";
const variant = process.env.SHOT_VARIANT ?? "";

it("shoots", { timeout: 120_000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "iirc-shot-"));
  const { api, base, child, key, ngircd, peer } = await privateNetwork(
    ["bun", main],
    [`--web=${web}`],
    path.join(directory, "data"),
    "#shot"
  );
  const browser = await chromium.launch();

  try {
    await api("PUT", "/ui/previews", JSON.stringify({ value: "on" }));
    const page = await browser.newPage({ colorScheme: "dark", viewport: { height: 360, width: 760 } });

    await page.goto(base);
    await page.getByLabel("Key").fill(key);
    await page.getByRole("button", { name: "Sign in" }).click();
    peer.send("PRIVMSG iirc :have a look at https://iirc-336.invalid/page");
    await page.getByRole("row", { name: "peer" }).click();
    const log = page.getByRole("log", { name: "peer" });

    await log.getByRole("button", { name: /^Preview of/u }).click();
    await log.locator('[data-preview="failed"]').waitFor();
    await page.screenshot({ path: `${out}/${variant}-failed.png` });

    if (variant === "after") {
      const retry = log.locator('button[data-preview="failed"]');

      await retry.hover();
      await page.screenshot({ path: `${out}/${variant}-failed-hovered.png` });
      await retry.click();
      // The press is answered pending, and the fetch fails again, so the button comes back.
      await log.locator('button[data-preview="failed"]').waitFor();
    }
  } finally {
    await browser.close();
    child.kill();
    peer.close();
    await ngircd.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});
