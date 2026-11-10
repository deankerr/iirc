/// <reference lib="dom" />
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const main = path.join(import.meta.dirname, "..", "main.ts");
const web = path.join(import.meta.dirname, "..", "..", "..", "web", "dist");

/**
 * Runs `iirc` to its end.
 * @param args - Its arguments.
 * @returns Its exit code and stdout.
 */
const iirc = async (...args: readonly string[]) => {
  const child = Bun.spawn(["bun", main, ...args], { stderr: "inherit", stdout: "pipe" });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);

  return { code, stdout };
};

/**
 * Starts `iirc daemon --web` on a port the kernel picks, and waits until it listens.
 * @param dataDir - Its data directory.
 * @returns Where it listens, and the process.
 */
const startDaemon = async (dataDir: string) => {
  const child = Bun.spawn(
    ["bun", main, "daemon", "--data-dir", dataDir, "--listen", "127.0.0.1:0", "--web", web],
    { stderr: "pipe", stdout: "inherit" }
  );

  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  let logged = "";

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- reading the log in order
    const chunk = await reader.read();

    if (chunk.done) {
      throw new Error(`the Daemon ended before listening: ${logged}`);
    }

    logged += decoder.decode(chunk.value);
    const port = /Listening on http:\/\/127\.0\.0\.1:(?<port>\d+)/u.exec(logged)?.groups?.port;

    if (port !== undefined) {
      reader.releaseLock();

      return { base: `http://127.0.0.1:${port}`, child };
    }
  }
};

const wrongKey = "iirc_not-the-key-but-close";

/**
 * Whether anything React keeps for the page, its state and its props, holds a secret. It
 * runs in the page, from the root fiber React keeps on `#root`, following every own
 * property, a DOM node only through what React keeps on it, and never into `window`.
 * @param secret - The secret.
 * @returns Whether it was found.
 */
const heldByReact = (secret: string) => {
  const container = document.querySelector("#root");
  const seen = new Set<object>();

  // What React keeps on a value: every own property of an object, and only React's own
  // keys on a DOM node. Never `window`, which would be the whole page. It is defined here
  // because the whole function runs in the page, so it must hold everything it uses.
  // oxlint-disable-next-line anti-slop/no-object-parameters, unicorn/consistent-function-scoping -- the walk takes values of any shape, and runs in the page.
  const kept = (value: object): readonly unknown[] =>
    value === window
      ? []
      : Object.keys(value)
          .filter((key) => !(value instanceof Node) || key.startsWith("__react"))
          // oxlint-disable-next-line anti-slop/no-reflect-get, anti-slop/no-unknown-returns -- a walk over values of any shape, looking for a secret, reads properties it cannot name.
          .map((key): unknown => Reflect.get(value, key));

  const pending: unknown[] = container === null ? [] : [...kept(container)];

  while (pending.length > 0) {
    const next = pending.pop();

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- this walks values of any shape on purpose, looking for a string.
    if (typeof next === "string") {
      if (next.includes(secret)) {
        return true;
      }
    } else if (next instanceof Object && !seen.has(next)) {
      seen.add(next);
      pending.push(...kept(next));
    }
  }

  return false;
};

/**
 * What React DOM's value tracker on an input holds: the last value it saw typed, which it
 * keeps even on an uncontrolled input. It is React's internal, so it is read loosely.
 * @param input - The input, in the page.
 * @returns The value it holds, or `null` when there is no tracker.
 */
const tracked = (
  input: (HTMLElement | SVGElement) & {
    // React DOM's internal, not in the DOM's types, and absent from a React without it.
    readonly _valueTracker?: { readonly getValue: () => string } | null;
  }
) => input._valueTracker?.getValue() ?? null;

describe("the web frontend on iirc daemon --web", () => {
  let browser: Browser;
  let directory: string;

  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "iirc-web-e2e-"));
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
    rmSync(directory, { force: true, recursive: true });
  });

  it(
    "signs in with a key, stays signed in across a reload, and signs out",
    { timeout: 30_000 },
    async () => {
      const dataDir = path.join(directory, "data");
      const created = await iirc("key", "create", "browser", "--data-dir", dataDir);
      const key = created.stdout.trim();
      const { base, child } = await startDaemon(dataDir);

      try {
        // A Network to list, configured through the API with the key, and never dialled.
        const configured = await fetch(`${base}/api/networks/example`, {
          body: JSON.stringify({
            channels: [],
            declined: [],
            enabled: false,
            fallbackEncoding: "windows-1252",
            ircds: [{ host: "127.0.0.1", port: 1, tls: false }],
            login: { _tag: "None" },
            nicks: ["iirc"],
            realname: "iirc",
            username: "iirc",
          }),
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          method: "PUT",
        });

        const context = await browser.newContext();
        const page = await context.newPage();
        const problems: string[] = [];

        page.on("console", (message) => {
          if (message.type() === "error") {
            problems.push(message.text());
          }
        });
        page.on("pageerror", (error) => problems.push(error.message));

        await page.goto(base);
        const field = page.getByLabel("Key");

        await field.fill(wrongKey);
        await page.getByRole("button", { name: "Sign in" }).click();
        const wrong = await page.getByRole("alert").textContent();

        const afterWrong = {
          describedBy:
            (await field.getAttribute("aria-describedby")) ===
            (await page.getByRole("alert").getAttribute("id")),
          field: await field.inputValue(),
          inPage: await page.evaluate(heldByReact, wrongKey),
          tracker: await field.evaluate(tracked),
        };

        await field.fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.getByRole("heading", { name: "Networks" }).waitFor();
        const listed = await page.getByRole("listitem").allTextContents();

        await page.reload();
        await page.getByRole("heading", { name: "Networks" }).waitFor();
        const afterReload = await page.getByRole("listitem").allTextContents();

        const held = await page.evaluate(() => ({
          cookie: document.cookie,
          local: localStorage.length,
          session: sessionStorage.length,
        }));

        const cookies = await context.cookies();

        await page.getByRole("button", { name: "Sign out" }).click();
        await page.getByLabel("Key").waitFor();
        await page.reload();
        await page.getByLabel("Key").waitFor();
        const cookiesAfter = await context.cookies();

        expect({
          afterReload,
          afterWrong,
          configured: configured.status,
          cookies: cookies.map(({ httpOnly, name, sameSite, value }) => ({
            holdsKey: value.includes(key),
            httpOnly,
            name,
            sameSite,
          })),
          cookiesAfter,
          held,
          listed,
          problems: problems.filter((problem) => !problem.includes("401")),
          wrong,
        }).toStrictEqual({
          afterReload: ["examplerunning"],
          afterWrong: { describedBy: true, field: "", inPage: false, tracker: "" },
          configured: 200,
          cookies: [{ holdsKey: false, httpOnly: true, name: "iirc_sign_in", sameSite: "Strict" }],
          cookiesAfter: [],
          held: { cookie: "", local: 0, session: 0 },
          listed: ["examplerunning"],
          problems: [],
          wrong:
            "That key matches none the Daemon holds. Check it, or make one with iirc key create.",
        });
      } finally {
        child.kill("SIGTERM");
        await child.exited;
      }
    }
  );
});
