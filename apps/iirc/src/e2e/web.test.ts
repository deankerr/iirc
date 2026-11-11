/// <reference lib="dom" />
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { connectPeer, startNgircd } from "@iirc/daemon/testing";
import type { Ircd } from "@iirc/daemon/testing";
import { Schema } from "effect";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { run, startDaemon as startWith, watchedPage } from "./daemon.ts";

const main = path.join(import.meta.dirname, "..", "main.ts");
const web = path.join(import.meta.dirname, "..", "..", "..", "web", "dist");

/** `iirc` run from source. */
const source = ["bun", main];

/**
 * Runs `iirc` from source to its end.
 * @param args - Its arguments.
 * @returns Its exit code and stdout.
 */
const iirc = async (...args: readonly string[]) => await run(source, ...args);

/**
 * Starts `iirc daemon --web` from source on a port the kernel picks, and waits until it
 * listens.
 * @param dataDir - Its data directory.
 * @returns Where it listens, and the process.
 */
const startDaemon = async (dataDir: string) => await startWith(source, dataDir, `--web=${web}`);

const wrongKey = "iirc_not-the-key-but-close";

/** What the end-to-end run reads of `known`: which Channels the Client has joined. */
const decodeKnown = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      channels: Schema.Array(Schema.Struct({ name: Schema.String, standing: Schema.String })),
    })
  )
);

/** What the end-to-end run reads of a Configuration: its Channels and nicks. */
const decodeInForce = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      configuration: Schema.Struct({
        channels: Schema.Array(Schema.Struct({ name: Schema.String })),
        nicks: Schema.Array(Schema.String),
      }),
      sequence: Schema.Finite,
    })
  )
);

/** What the end-to-end run reads of a Network's Timelines: each one's name and Read Marker. */
const decodeTimelines = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      timelines: Schema.Array(
        Schema.Struct({ name: Schema.String, read: Schema.NullOr(Schema.Finite) })
      ),
    })
  )
);

/** What the end-to-end run reads of a layout the page kept: its root Split's ratios. */
const decodeKeptRatios = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      root: Schema.Struct({ children: Schema.Array(Schema.Struct({ ratio: Schema.Finite })) }),
    })
  )
);

/** A notification the stand-in kept: its title, body, and tag. */
const decodeNotified = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ body: Schema.String, tag: Schema.String, title: Schema.String })
  )
);

/**
 * Stands in for the browser's notifications, granting them when asked, and keeps each one
 * shown on the page's root, where the test reads it. It runs in the page before its scripts.
 */
const stubNotifications = () => {
  // oxlint-disable-next-line typescript/no-extraneous-class -- the Notification API is a class, and this stands in for it.
  class Shown {
    static permission: NotificationPermission = "default";

    // oxlint-disable-next-line typescript/require-await -- the API answers with a promise.
    static async requestPermission() {
      Shown.permission = "granted";

      return Shown.permission;
    }

    constructor(title: string, options?: NotificationOptions) {
      const root = document.documentElement;
      const shown = { body: options?.body, tag: options?.tag, title };

      root.dataset.notified = `${root.dataset.notified ?? ""}${JSON.stringify(shown)}\n`;
    }

    addEventListener() {
      return this;
    }

    close() {
      return this;
    }
  }

  Object.defineProperty(window, "Notification", { configurable: true, value: Shown });
};

/**
 * Counts each time the page keeps its layout, on the page's root, where the test reads it.
 * It runs in the page before its scripts.
 */
const countLayoutWrites = () => {
  // oxlint-disable-next-line typescript/unbound-method -- called with the Storage it was on, below.
  const { setItem: keep } = Storage.prototype;

  Storage.prototype.setItem = function setItem(this: Storage, key: string, value: string) {
    if (key === "iirc.layout") {
      const root = document.documentElement;

      root.dataset.layoutWrites = String(Number(root.dataset.layoutWrites ?? "0") + 1);
    }

    keep.call(this, key, value);
  };
};

/**
 * The first Network's row in the sidebar, once its connection is known.
 * @param page - The page.
 * @returns The row's text: its chevron, its id, and its connection.
 */
const networkRow = async (page: Page) => {
  const row = page.getByRole("row").first();

  await row.getByText(/^(?:connected|offline|stopped)$/u).waitFor();

  return await row.textContent();
};

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

/**
 * A private ngircd on a loopback port the kernel picks, a real `iirc daemon --web` with a
 * key, a Network configured through the API to join a Channel there, joined as the Client
 * knows it, and a raw IRC connection as the other User, `peer`, in the Channel.
 * @param dataDir - The Daemon's data directory.
 * @param channel - The Channel.
 * @returns Everything, for the test to stop.
 */
const privateNetwork = async (dataDir: string, channel: string) => {
  const ngircd: Ircd = await startNgircd();
  const created = await iirc("key", "create", "browser", "--data-dir", dataDir);
  const key = created.stdout.trim();
  const { base, child } = await startDaemon(dataDir);
  const authorization = { authorization: `Bearer ${key}`, "content-type": "application/json" };

  const api = async (method: string, route: string, body: string | null = null) =>
    await fetch(`${base}/api${route}`, { body, headers: authorization, method });

  const peer = await connectPeer({ host: ngircd.host, nick: "peer", port: ngircd.plainPort });

  peer.send(`JOIN ${channel}`);

  const configured = await api(
    "PUT",
    "/networks/private",
    JSON.stringify({
      channels: [{ name: channel }],
      declined: [],
      enabled: true,
      fallbackEncoding: "windows-1252",
      ircds: [{ host: ngircd.host, port: ngircd.plainPort, tls: false }],
      login: { _tag: "None" },
      nicks: ["iirc"],
      realname: "iirc",
      username: "iirc",
    })
  );

  expect(configured.status).toBe(200);

  // Joined, as the Client knows it, decided from its Knowledge's structure.
  await expect
    .poll(
      async () => {
        const answer = await api("GET", "/networks/private/known");
        const known = decodeKnown(await answer.text());

        return known.channels.some((one) => one.name === channel && one.standing === "Joined");
      },
      { interval: 100, timeout: 20_000 }
    )
    .toBe(true);

  return { api, base, channel, child, key, ngircd, peer };
};

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
        const listed = await networkRow(page);

        await page.reload();
        const afterReload = await networkRow(page);

        // Only the layout this device keeps, which holds no key.
        const held = await page.evaluate((secret) => {
          const local = Object.keys(localStorage);

          return {
            cookie: document.cookie,
            local,
            localHoldsKey: local.some(
              (one) => localStorage.getItem(one)?.includes(secret) === true
            ),
            session: sessionStorage.length,
          };
        }, key);

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
          afterReload: "exampleoffline",
          afterWrong: { describedBy: true, field: "", inPage: false, tracker: "" },
          configured: 200,
          cookies: [{ holdsKey: false, httpOnly: true, name: "iirc_sign_in", sameSite: "Strict" }],
          cookiesAfter: [],
          held: { cookie: "", local: ["iirc.layout"], localHoldsKey: false, session: 0 },
          listed: "exampleoffline",
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

  it(
    "reads a Network's Timelines on a real Ircd, live, with formatting, and older history on scrolling up",
    { timeout: 90_000 },
    async () => {
      const { api, base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "timelines"),
        "#iirc-web"
      );

      try {
        // History: more than a window holds, so the oldest comes only on scrolling up.
        for (let index = 1; index <= 130; index += 1) {
          // oxlint-disable-next-line no-await-in-loop -- said in order
          await api(
            "POST",
            "/networks/private/say",
            JSON.stringify({ kind: "Privmsg", target: channel, text: `history ${index}` })
          );
        }

        const { page, problems } = await watchedPage(browser);

        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();

        const status = await networkRow(page);

        await page.getByRole("row", { name: channel }).click();
        const log = page.getByRole("log", { name: channel });

        await log.getByText("history 130", { exact: true }).waitFor();

        peer.send(
          `PRIVMSG ${channel} :\u0002bold\u0002 and \u000304red\u0003 https://example.com/x`
        );
        const red = log.getByText("red", { exact: true });

        await red.waitFor();

        // A live item arriving at the bottom keeps the view there.
        const pinned = await log.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight < 8
        );

        const formatting = {
          bold: await log
            .getByText("bold", { exact: true })
            .evaluate((element) => getComputedStyle(element).fontWeight),
          red: await red.evaluate((element) => getComputedStyle(element).color),
        };

        const link = log.getByRole("link", { name: "https://example.com/x" });

        const linked = {
          href: await link.getAttribute("href"),
          rel: await link.getAttribute("rel"),
          target: await link.getAttribute("target"),
        };

        // Where a row stands in the view, by its text, or `null` while it is not drawn.
        const offsetOf = async (text: string) =>
          await log.evaluate((element, wanted) => {
            const row = [...element.querySelectorAll("[data-index]")].find(
              (one) => one.textContent === wanted
            );

            return row === undefined
              ? null
              : row.getBoundingClientRect().top - element.getBoundingClientRect().top;
          }, text);

        // Near the top, but not near enough to ask for more: the row at the top, once drawn.
        await log.evaluate((element) => {
          element.scrollTop = 300;
        });

        const rowAtTop = async () =>
          await log.evaluate((element) => {
            const box = element.getBoundingClientRect();

            return (
              document.elementFromPoint(box.left + 80, box.top + 4)?.closest("[data-index]")
                ?.textContent ?? ""
            );
          });

        await expect.poll(rowAtTop).not.toBe("");
        const anchored = await rowAtTop();

        const before = await offsetOf(anchored);

        // Nearer: older items are asked for, and go in above without moving that row.
        const olderRead = page.waitForResponse((response) => response.url().includes("before="));

        await log.evaluate((element) => {
          element.scrollTop = 200;
        });
        await olderRead;
        await log.getByText("history 1", { exact: true }).waitFor({ state: "attached" });

        // Moved down by the 100 pixels scrolled, and by nothing the older items added.
        const offsetKept = async () => {
          const after = await offsetOf(anchored);

          return before !== null && after !== null && Math.abs(after - (before + 100)) < 4;
        };

        await expect.poll(offsetKept).toBe(true);
        const kept = await offsetKept();

        const scrollToTop = async () => {
          await log.evaluate((element) => {
            element.scrollTop = 0;
          });
        };

        // Scrolling up loads what lies before, until the oldest is shown.
        const oldest = log.getByText("history 1", { exact: true });

        await expect
          .poll(
            async () => {
              await scrollToTop();

              return await oldest.count();
            },
            { interval: 200, timeout: 15_000 }
          )
          .toBe(1);

        const violations = await page.evaluate(
          () => document.documentElement.dataset.cspViolations ?? ""
        );

        expect({
          formatting,
          kept,
          linked,
          pinned,
          problems: problems.filter((problem) => problem.includes("Content Security Policy")),
          status,
          violations,
        }).toStrictEqual({
          formatting: { bold: "700", red: "rgb(255, 0, 0)" },
          kept: true,
          linked: { href: "https://example.com/x", rel: "noopener noreferrer", target: "_blank" },
          pinned: true,
          problems: [],
          status: "\u25BEprivateconnected",
          violations: "",
        });
      } finally {
        peer.close();
        child.kill("SIGTERM");
        await child.exited;
        await ngircd.stop();
      }
    }
  );

  it(
    "says Messages from the composer to a real Ircd, as actions and to a nick, and recalls them",
    { timeout: 90_000 },
    async () => {
      const { base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "composer"),
        "#iirc-say"
      );

      try {
        const { page, problems } = await watchedPage(browser);

        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await networkRow(page);
        await page.getByRole("row", { name: channel }).click();

        const log = page.getByRole("log", { name: channel });
        const composer = page.getByRole("textbox", { name: channel });

        // Plain text, said to the Channel, which the other User hears.
        await composer.fill("hello from the web");
        await composer.press("Enter");

        const heard = await peer.waitFor(
          (line) => line.command === "PRIVMSG" && line.params[1] === "hello from the web",
          "the Message"
        );

        // Ours, in the Timeline, once: ngircd has no echo-message, so it stays unconfirmed.
        const ourRow = log.locator("[data-index]", { hasText: "hello from the web" });

        await ourRow.getByText("unconfirmed").waitFor();
        const rows = await ourRow.count();
        const cleared = await composer.inputValue();

        // An action, as a CTCP ACTION.
        await composer.fill("/me waves");
        await composer.press("Enter");

        const action = await peer.waitFor(
          (line) =>
            line.command === "PRIVMSG" && line.params[1]?.startsWith("\u0001ACTION") === true,
          "the action"
        );

        // To a nick: the other User hears it, and its Direct Message opens.
        await composer.fill("/msg peer hi");
        await composer.press("Enter");

        const direct = await peer.waitFor(
          (line) => line.command === "PRIVMSG" && line.params[0] === "peer",
          "the Direct Message"
        );

        await page.getByRole("log", { name: "peer" }).getByText("hi", { exact: true }).waitFor();

        // Back in the Channel, Up recalls the last line sent from it.
        await page.getByRole("row", { name: channel }).click();
        await composer.click();
        await composer.press("ArrowUp");
        const recalled = await composer.inputValue();

        const violations = await page.evaluate(
          () => document.documentElement.dataset.cspViolations ?? ""
        );

        expect({
          action: action.params,
          cleared,
          direct: direct.params,
          heard: heard.params,
          problems: problems.filter((problem) => problem.includes("Content Security Policy")),
          recalled,
          rows,
          violations,
        }).toStrictEqual({
          action: [channel, "\u0001ACTION waves\u0001"],
          cleared: "",
          direct: ["peer", "hi"],
          heard: [channel, "hello from the web"],
          problems: [],
          recalled: "/msg peer hi",
          rows: 1,
          violations: "",
        });
      } finally {
        peer.close();
        child.kill("SIGTERM");
        await child.exited;
        await ngircd.stop();
      }
    }
  );

  it(
    "acts on the Network from the composer: a refusal shown calmly, the topic, ranks, away, and a kick",
    { timeout: 90_000 },
    async () => {
      const { base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "act"),
        "#iirc-act"
      );

      try {
        const { page, problems } = await watchedPage(browser);

        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await networkRow(page);
        await page.getByRole("row", { name: channel }).click();

        const view = page.getByRole("region", { name: channel });
        const log = page.getByRole("log", { name: channel });
        const composer = page.getByRole("textbox", { name: channel });

        await log.waitFor();

        // Without the operator rank, the Ircd refuses a kick, which the Timeline says calmly.
        await composer.fill("/kick peer");
        await composer.press("Enter");
        const refused = log.getByText(/^Your kick of peer from #iirc-act was refused \(482\)$/u);

        await refused.waitFor();

        const refusedStyle = await refused.evaluate(
          (element) => getComputedStyle(element).fontStyle
        );

        // The peer made the Channel, so holds its operator rank, and ops Self.
        await composer.click();
        await page.keyboard.press("Alt+m");
        const members = page.getByRole("region", { name: "members" });

        peer.send(`MODE ${channel} +o iirc`);
        await members.getByRole("row", { name: "iirc, operator" }).waitFor();

        // A topic set from the composer shows in the header.
        await composer.fill("/topic a plan for today");
        await composer.press("Enter");
        await view.locator("header").getByText("a plan for today", { exact: true }).waitFor();

        // Taking the peer's rank and giving it back, by PREFIX's `o`.
        await composer.fill("/deop peer");
        await composer.press("Enter");
        await members.getByRole("row", { exact: true, name: "peer" }).waitFor();
        await composer.fill("/op peer");
        await composer.press("Enter");
        const opped = members.getByRole("row", { name: "peer, operator" });

        await opped.waitFor();
        const symbol = await opped.textContent();

        // Away, as the Ircd confirmed it, beside the prompt, and back again.
        const prompt = page.locator("label", { hasText: channel });

        await composer.fill("/away gone fishing");
        await composer.press("Enter");
        await prompt.getByText("(away)", { exact: true }).waitFor();
        await composer.fill("/back");
        await composer.press("Enter");
        await prompt.getByText("(away)", { exact: true }).waitFor({ state: "detached" });

        // A kick with the rank removes the peer.
        await composer.fill("/kick peer enough");
        await composer.press("Enter");
        await members.getByRole("row", { name: /^peer\b/u }).waitFor({ state: "detached" });

        const violations = await page.evaluate(
          () => document.documentElement.dataset.cspViolations ?? ""
        );

        expect({
          problems: problems.filter((problem) => problem.includes("Content Security Policy")),
          refusedStyle,
          symbol,
          violations,
        }).toStrictEqual({ problems: [], refusedStyle: "italic", symbol: "@peer", violations: "" });
      } finally {
        peer.close();
        child.kill("SIGTERM");
        await child.exited;
        await ngircd.stop();
      }
    }
  );

  it(
    "shows who is here: the header's topic, the members with their rank, nick completion, and /query",
    { timeout: 90_000 },
    async () => {
      const { base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "who"),
        "#iirc-who"
      );

      try {
        const { page, problems } = await watchedPage(browser);

        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await networkRow(page);
        await page.getByRole("row", { name: channel }).click();

        const view = page.getByRole("region", { name: channel });
        const composer = page.getByRole("textbox", { name: channel });

        await page.getByRole("log", { name: channel }).waitFor();

        // The peer sets the topic: the header reads the Channel again and shows it, formatted.
        peer.send(`TOPIC ${channel} :the \u0002plan\u0002 for today`);
        const head = view.locator("header");

        await head.getByText("set by peer", { exact: false }).waitFor();

        const topic = await head
          .getByText("plan", { exact: true })
          .evaluate((element) => getComputedStyle(element).fontWeight);

        // Alt+M shows the members: the peer made the Channel, so holds its operator rank.
        await composer.click();
        await page.keyboard.press("Alt+m");
        const members = page.getByRole("region", { name: "members" });
        const peerRow = members.getByRole("row", { name: "peer, operator" });

        await peerRow.waitFor();
        const symbol = await peerRow.textContent();

        // The peer ops Self, which the list reads again and shows.
        peer.send(`MODE ${channel} +o iirc`);
        await members.getByRole("row", { name: "iirc, operator" }).waitFor();

        // The start of the peer's nick and Tab, at the start of the line: their nick and `: `.
        await composer.click();
        await composer.fill("pe");
        await composer.press("Tab");
        await expect.poll(async () => await composer.inputValue()).toBe("peer: ");
        const completed = await composer.inputValue();

        // The peer says something to Self, which makes their Direct Message; /query opens it.
        peer.send("PRIVMSG iirc :hello there");
        await page
          .getByRole("treegrid")
          .getByRole("row", { name: /^peer\b/u })
          .waitFor();
        await composer.fill("/query peer");
        await composer.press("Enter");
        await page
          .getByRole("log", { name: "peer" })
          .getByText("hello there", { exact: true })
          .waitFor();

        const violations = await page.evaluate(
          () => document.documentElement.dataset.cspViolations ?? ""
        );

        expect({
          completed,
          problems: problems.filter((problem) => problem.includes("Content Security Policy")),
          symbol,
          topic,
          violations,
        }).toStrictEqual({
          completed: "peer: ",
          problems: [],
          symbol: "@peer",
          topic: "700",
          violations: "",
        });
      } finally {
        peer.close();
        child.kill("SIGTERM");
        await child.exited;
        await ngircd.stop();
      }
    }
  );

  it(
    "opens the palette with the keyboard, jumps to a Channel, runs commands from it, and moves between Timelines",
    { timeout: 90_000 },
    async () => {
      const { base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "palette"),
        "#iirc-palette"
      );

      try {
        const { page, problems } = await watchedPage(browser);

        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await networkRow(page);

        const palette = page.getByRole("dialog", { name: "Command palette" });
        const search = palette.getByRole("searchbox", { name: "Command, Timeline, or option" });
        const composer = page.getByRole("textbox", { name: channel });

        const hasFocus = async (locator: typeof search) =>
          await locator.evaluate((element) => element === document.activeElement);

        // Mod+K opens it, with the caret in its search field, and the Channel is found by name.
        await page.keyboard.press("Control+k");
        await palette.waitFor();
        await expect.poll(async () => await hasFocus(search)).toBe(true);
        await page.keyboard.type(channel);
        await palette.getByRole("menuitem").first().getByText(channel).waitFor();
        await page.keyboard.press("Enter");
        await palette.waitFor({ state: "detached" });

        const log = page.getByRole("log", { name: channel });

        await log.waitFor();

        // A command that needs arguments starts in the composer, focused, and is said from there.
        await page.keyboard.press("Control+k");
        await palette.waitFor();
        await page.keyboard.type("/me");
        await page.keyboard.press("Enter");
        await palette.waitFor({ state: "detached" });
        await expect.poll(async () => await composer.inputValue()).toBe("/me ");
        const prefilled = await hasFocus(composer);

        await page.keyboard.type("waves");
        await page.keyboard.press("Enter");

        const action = await peer.waitFor(
          (line) =>
            line.command === "PRIVMSG" && line.params[1]?.startsWith("\u0001ACTION") === true,
          "the action"
        );

        // Escape closes it, choosing nothing, and focus goes back to the composer.
        await page.keyboard.press("Control+Shift+P");
        await palette.waitFor();
        await page.keyboard.press("Escape");
        await palette.waitFor({ state: "detached" });
        await expect.poll(async () => await hasFocus(composer)).toBe(true);

        // One that needs none runs: /set shows the options.
        await page.keyboard.press("Control+k");
        await palette.waitFor();
        await page.keyboard.type("set");
        await page.keyboard.press("Enter");
        await page.getByRole("searchbox", { name: "Filter options" }).waitFor();

        // Alt+ArrowUp opens the Timeline before the Channel in the sidebar: the Network's own.
        await page.keyboard.press("Alt+ArrowUp");
        await page.getByRole("log", { name: "private" }).waitFor();

        const violations = await page.evaluate(
          () => document.documentElement.dataset.cspViolations ?? ""
        );

        expect({
          action: action.params,
          prefilled,
          problems: problems.filter((problem) => problem.includes("Content Security Policy")),
          violations,
        }).toStrictEqual({
          action: [channel, "\u0001ACTION waves\u0001"],
          prefilled: true,
          problems: [],
          violations: "",
        });
      } finally {
        peer.close();
        child.kill("SIGTERM");
        await child.exited;
        await ngircd.stop();
      }
    }
  );

  it(
    "adds a Network from nothing, joins and parts a Channel, and changes an option in place",
    { timeout: 90_000 },
    async () => {
      const dataDir = path.join(directory, "options");
      const ngircd: Ircd = await startNgircd();
      const created = await iirc("key", "create", "browser", "--data-dir", dataDir);
      const key = created.stdout.trim();
      const { base, child } = await startDaemon(dataDir);
      const peer = await connectPeer({ host: ngircd.host, nick: "peer", port: ngircd.plainPort });

      const configurationOf = async () => {
        const answer = await fetch(`${base}/api/networks/test/configuration`, {
          headers: { authorization: `Bearer ${key}` },
        });

        return decodeInForce(await answer.text());
      };

      try {
        peer.send("JOIN #iirc");
        await peer.waitFor((line) => line.command === "JOIN", "the peer's own JOIN");

        const { page, problems } = await watchedPage(browser);

        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.getByText("No Networks are configured yet.").waitFor();

        // With no Timeline open, the composer takes commands that need none.
        const nowhere = page.getByRole("textbox", { name: "iirc" });

        await nowhere.fill(`/network add test ${ngircd.host}/${ngircd.plainPort} -tls iirc`);
        await nowhere.press("Enter");

        const row = page.getByRole("row").first();

        await row.getByText("connected", { exact: true }).waitFor({ timeout: 20_000 });

        // The Network's own Timeline, under the Network's row of the same name, then /join there.
        await page.getByRole("row", { exact: true, name: "test" }).last().click();
        const composer = page.getByRole("textbox", { name: "test" });

        await composer.fill("/join #iirc");
        await composer.press("Enter");

        const joined = await peer.waitFor(
          (line) => line.command === "JOIN" && line.source?.startsWith("iirc!") === true,
          "Self's JOIN"
        );

        // The options, filtered, and nicks changed in place.
        await page.getByRole("button", { exact: true, name: "Options" }).click();
        await page.getByRole("searchbox", { name: "Filter options" }).fill("*.nicks");

        const nicks = page.getByRole("row", { name: "network.test.nicks" });

        await nicks.getByText("iirc", { exact: true }).waitFor();
        await nicks.focus();
        await page.keyboard.press("Enter");

        const editor = page.getByRole("textbox", { name: "Value of network.test.nicks" });

        await editor.fill("iirc,iirc_");
        await editor.press("Enter");
        await nicks.getByText("iirc,iirc_", { exact: true }).waitFor();
        const afterNicks = await configurationOf();

        // Delete asks first, then sets an option back to what a new Network starts with.
        await page.getByRole("searchbox", { name: "Filter options" }).fill("*.realname");
        const realname = page.getByRole("row", { name: "network.test.realname" });

        await realname.focus();
        await page.keyboard.press("Enter");
        await page.getByRole("textbox", { name: "Value of network.test.realname" }).fill("Someone");
        await page.keyboard.press("Enter");
        await realname.getByText("Someone", { exact: true }).waitFor();
        await realname.focus();
        await page.keyboard.press("Delete");
        await page.getByRole("alertdialog").getByRole("button", { name: "Unset" }).waitFor();
        await page.keyboard.press("Enter");
        await realname.getByText("iirc", { exact: true }).waitFor();

        // Back to the Channel, and /part with no argument parts it.
        await page.getByRole("row", { name: "#iirc" }).click();
        const inChannel = page.getByRole("textbox", { name: "#iirc" });

        await inChannel.fill("/part");
        await inChannel.press("Enter");

        const parted = await peer.waitFor(
          (line) => line.command === "PART" && line.source?.startsWith("iirc!") === true,
          "Self's PART"
        );

        const afterPart = await configurationOf();

        const violations = await page.evaluate(
          () => document.documentElement.dataset.cspViolations ?? ""
        );

        expect({
          channels: afterPart.configuration.channels,
          joined: joined.params[0],
          nicks: afterNicks.configuration.nicks,
          parted: parted.params[0],
          problems: problems.filter((problem) => problem.includes("Content Security Policy")),
          violations,
        }).toStrictEqual({
          channels: [],
          joined: "#iirc",
          nicks: ["iirc", "iirc_"],
          parted: "#iirc",
          problems: [],
          violations: "",
        });
      } finally {
        peer.close();
        child.kill("SIGTERM");
        await child.exited;
        await ngircd.stop();
      }
    }
  );

  it(
    "shows a Highlight where it was said, jumps to it with Alt+A, marks it read, and every Frontend sees it",
    { timeout: 90_000 },
    async () => {
      const { api, base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "reading"),
        "#iirc-new"
      );

      const readOf = async (name: string) => {
        const answer = await api("GET", "/networks/private/timelines");

        return decodeTimelines(await answer.text()).timelines.find((one) => one.name === name)
          ?.read;
      };

      try {
        const { page, problems } = await watchedPage(browser);

        await page.addInitScript(stubNotifications);
        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await networkRow(page);

        // Seen once, the Channel is marked read up to its latest by the Daemon.
        await page.getByRole("row", { name: channel }).click();
        await expect
          .poll(async () => await readOf(channel), { interval: 100, timeout: 10_000 })
          .not.toBeNull();

        // Away in the Network's own Timeline, with notifications on for this device.
        await page.keyboard.press("Alt+ArrowUp");
        await page.getByRole("log", { name: "private" }).waitFor();
        const composer = page.getByRole("textbox", { name: "private" });

        await composer.fill("/notify on");
        await composer.press("Enter");

        // Another Frontend, open on nothing.
        const other = await page.context().newPage();

        await other.goto(base);
        await networkRow(other);

        peer.send(`PRIVMSG ${channel} :iirc: look here`);

        const highlighted = `${channel}, 1 unread, 1 highlight`;

        await page.getByRole("row", { exact: true, name: highlighted }).waitFor();
        await other.getByRole("row", { exact: true, name: highlighted }).waitFor();
        await expect.poll(async () => await page.title()).toBe("(1) iirc");
        await expect.poll(async () => await other.title()).toBe("(1) iirc");

        const notified = await page.evaluate(() => document.documentElement.dataset.notified ?? "");

        // Alt+A opens it, with the "new" divider right before the Highlight.
        await page.keyboard.press("Alt+a");
        const log = page.getByRole("log", { name: channel });

        await log.getByText("look here", { exact: false }).waitFor();

        const divided = await log.evaluate((element) => {
          const rows = [...element.querySelectorAll<HTMLElement>("[data-index]")].toSorted(
            (left, right) => Number(left.dataset.index) - Number(right.dataset.index)
          );

          const at = rows.findIndex((row) => row.textContent === "new");

          return rows[at + 1]?.textContent?.includes("look here") === true;
        });

        // Seen for a moment, it is read, here and in the other Frontend.
        await page.getByRole("row", { exact: true, name: channel }).waitFor();
        await other.getByRole("row", { exact: true, name: channel }).waitFor();
        await expect.poll(async () => await page.title()).toBe("iirc");
        await expect.poll(async () => await other.title()).toBe("iirc");

        // The divider stays while the Channel stays open.
        const kept = await log.getByText("new", { exact: true }).count();

        const violations = await page.evaluate(
          () => document.documentElement.dataset.cspViolations ?? ""
        );

        expect({
          divided,
          kept,
          notified: notified
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => {
              const one = decodeNotified(line);

              // Tagged by its Timeline, whose id the Daemon chose.
              return { ...one, tag: one.tag.startsWith("iirc:") };
            }),
          problems: problems.filter((problem) => problem.includes("Content Security Policy")),
          violations,
        }).toStrictEqual({
          divided: true,
          kept: 1,
          notified: [
            {
              body: "<\u2068peer\u2069> \u2068iirc: look here\u2069",
              tag: true,
              title: `\u2068${channel}\u2069 \u00B7 private`,
            },
          ],
          problems: [],
          violations: "",
        });
      } finally {
        peer.close();
        child.kill("SIGTERM");
        await child.exited;
        await ngircd.stop();
      }
    }
  );

  it(
    "splits into Panes, shows two Channels live, moves the focus by keys, sends from the focused Pane, and keeps the layout across a reload",
    { timeout: 90_000 },
    async () => {
      const { base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "panes"),
        "#iirc-left"
      );

      const other = "#iirc-right";

      try {
        peer.send(`JOIN ${other}`);
        await peer.waitFor((line) => line.command === "JOIN" && line.params[0] === other, "JOIN");

        const { page, problems } = await watchedPage(browser);

        await page.addInitScript(countLayoutWrites);
        await page.setViewportSize({ height: 800, width: 1280 });
        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await networkRow(page);

        // The first Channel, then the second joined from it.
        await page.getByRole("row", { name: channel }).click();
        const first = page.getByRole("textbox", { name: channel });

        await first.fill(`/join ${other}`);
        await first.press("Enter");
        await page.getByRole("row", { name: other }).waitFor();

        // Split side by side: the new Pane has the focus, and the second Channel opens in it.
        await page.keyboard.press("Alt+Shift+S");
        await page.getByRole("separator").waitFor();
        await page.getByRole("row", { name: other }).click();

        const left = page.getByRole("log", { name: channel });
        const right = page.getByRole("log", { name: other });

        await right.waitFor();

        // Both receive live Messages.
        peer.send(`PRIVMSG ${channel} :to the left`);
        peer.send(`PRIVMSG ${other} :to the right`);
        await left.getByText("to the left", { exact: true }).waitFor();
        await right.getByText("to the right", { exact: true }).waitFor();

        const leftBox = await left.boundingBox();
        const rightBox = await right.boundingBox();

        const sideBySide =
          leftBox !== null &&
          rightBox !== null &&
          leftBox.x + leftBox.width <= rightBox.x + 1 &&
          leftBox.y === rightBox.y;

        // A drag of the divider is one Resize, on release, however far it moves.
        const separator = page.getByRole("separator");
        const box = await separator.boundingBox();

        const writes = async () =>
          await page.evaluate(() => Number(document.documentElement.dataset.layoutWrites ?? "0"));

        const beforeDrag = await writes();

        await page.mouse.move((box?.x ?? 0) + 1, (box?.y ?? 0) + 200);
        await page.mouse.down();
        await page.mouse.move((box?.x ?? 0) + 151, (box?.y ?? 0) + 200, { steps: 20 });
        await page.mouse.up();
        await expect.poll(async () => (await writes()) - beforeDrag).toBe(1);

        const dragged = decodeKeptRatios(
          await page.evaluate(() => localStorage.getItem("iirc.layout") ?? "{}")
        ).root.children[0]?.ratio;

        // An arrow key on the focused divider is one Resize too.
        await separator.focus();
        await page.keyboard.press("ArrowLeft");
        await expect.poll(async () => (await writes()) - beforeDrag).toBe(2);

        // Alt+Shift+ArrowLeft, typed in the composer, focuses the left Pane, and the composer
        // then writes there.
        await page.getByRole("textbox", { name: `Pane 2: ${other}` }).focus();
        await page.keyboard.press("Alt+Shift+ArrowLeft");
        const composer = page.getByRole("textbox", { name: `Pane 1: ${channel}` });

        await composer.fill("from the focused Pane");
        await composer.press("Enter");

        const said = await peer.waitFor(
          (line) => line.command === "PRIVMSG" && line.params[1] === "from the focused Pane",
          "the Message said from the left Pane"
        );

        // Splitting the Pane whose log has the focus moves its node into a nested Panel, and
        // the new Pane takes the focus. The log stays at its latest. Closing the new Pane
        // moves the node back, and the focus with it.
        await left.focus();
        await page.keyboard.press("Alt+Shift+D");
        await page.getByRole("separator").nth(1).waitFor();

        const kept = async () =>
          await left.evaluate((element) => ({
            focused: document.activeElement === element,
            latest: element.scrollHeight - element.scrollTop - element.clientHeight < 8,
          }));

        const splitKept = await kept();

        await page.keyboard.press("Alt+Shift+W");
        await expect.poll(async () => await page.getByRole("separator").count()).toBe(1);
        const closeKept = await kept();

        // A reload brings the layout back, the focus with it.
        await page.reload();
        await left.getByText("to the left", { exact: true }).waitFor();
        await right.getByText("to the right", { exact: true }).waitFor();
        await page.getByRole("textbox", { name: `Pane 1: ${channel}` }).waitFor();

        // Closing the focused Pane leaves the other in its place.
        await page.keyboard.press("Alt+Shift+W");
        await page.getByRole("textbox", { exact: true, name: other }).waitFor();

        const after = {
          logs: await page.getByRole("log").count(),
          separators: await page.getByRole("separator").count(),
        };

        const violations = await page.evaluate(
          () => document.documentElement.dataset.cspViolations ?? ""
        );

        expect({
          after,
          dragged: dragged !== undefined && dragged > 0.6 && dragged < 0.7,
          moved: [splitKept, closeKept],
          problems: problems.filter((problem) => problem.includes("Content Security Policy")),
          said: said.params[0],
          sideBySide,
          violations,
        }).toStrictEqual({
          after: { logs: 1, separators: 0 },
          dragged: true,
          moved: [
            { focused: false, latest: true },
            { focused: true, latest: true },
          ],
          problems: [],
          said: channel,
          sideBySide: true,
          violations: "",
        });
      } finally {
        peer.close();
        child.kill("SIGTERM");
        await child.exited;
        await ngircd.stop();
      }
    }
  );
});
