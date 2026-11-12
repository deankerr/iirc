/// <reference lib="dom" />
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

/**
 * A colour as CSS computes it, `rgb(r, g, b)`, as hex.
 * @param rgb - The computed colour.
 * @returns Its hex.
 */
const hexOf = (rgb: string) =>
  `#${[...rgb.matchAll(/\d+/gu)].map(([digits]) => Number(digits).toString(16).padStart(2, "0")).join("")}`;

/** Nord as Alacritty's theme of it has it, a real theme file to import. */
const nordAlacritty = readFileSync(
  path.join(import.meta.dirname, "..", "..", "..", "..", "fixtures", "themes", "nord.toml"),
  "utf-8"
);

/** What the end-to-end run reads of `known`: which Channels the Client has joined. */
const decodeKnown = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      channels: Schema.Array(Schema.Struct({ name: Schema.String, standing: Schema.String })),
    })
  )
);

/** A Channel's head as the Daemon answers it, whatever it holds, to answer it changed. */
const decodeHead = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
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

/**
 * What the end-to-end run reads of the options under `ui` every device shares.
 * @param text - The answer of `GET /api/ui`.
 * @returns The options.
 */
const decodeUi = (text: string) =>
  Schema.decodeSync(
    Schema.fromJsonString(
      Schema.Struct({
        options: Schema.Struct({
          activity: Schema.String,
          theme: Schema.String,
          time: Schema.String,
        }),
        sequence: Schema.Finite,
      })
    )
  )(text).options;

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

/** How a Network's row ends its label, once its connection is known: the word for it. */
const standingWord = /, (?:connected|offline|stopped)(?:: .*)?$/u;

/**
 * The first Network's row in the sidebar, once its connection is known.
 * @param page - The page.
 * @returns The row's text: its chevron, its id, what is unread, and its connection's symbol.
 */
const networkRow = async (page: Page) => {
  await page.getByRole("row", { name: standingWord }).first().waitFor();

  return (await page.getByRole("row").first().textContent()) ?? "";
};

/**
 * How the first Network's connection stands, as its row's label says it.
 * @param page - The page.
 * @returns The label.
 */
const standingLabel = async (page: Page) =>
  (await page.getByRole("row").first().getAttribute("aria-label")) ?? "";

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

/**
 * The smaller of an element's width and height, as drawn.
 * @param locator - The element.
 * @returns The side, in whole pixels, or 0 when it is not drawn.
 */
const leastSide = async (locator: ReturnType<Page["getByRole"]>) => {
  const box = await locator.boundingBox();

  return box === null ? 0 : Math.round(Math.min(box.width, box.height));
};

/**
 * Drags the sidebar's edge 100 pixels wider, which the device keeps, then hides the sidebar
 * with Alt+N, reloads, which keeps it hidden, and shows it again from the button beside the
 * composer.
 * @param page - The page, on a wide screen, with the sidebar shown at its first width.
 * @returns Its width before and after, the width kept, and how many sidebars the reload drew.
 */
const resizedSidebar = async (page: Page) => {
  const sidebar = page.getByRole("navigation", { name: "Networks" });
  const edge = await page.getByRole("separator", { name: "Resize the sidebar" }).boundingBox();
  const at = { x: (edge?.x ?? 0) + 0.5, y: (edge?.y ?? 0) + 300 };

  const sidebarWidth = async () => {
    const box = await sidebar.boundingBox();

    return Math.round(box?.width ?? 0);
  };

  const narrow = await sidebarWidth();

  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 100, at.y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(sidebarWidth).toBe(narrow + 100);

  const widthKept = await page.evaluate(() => localStorage.getItem("iirc.sidebar-width"));

  await page.keyboard.press("Alt+N");
  await sidebar.waitFor({ state: "detached" });
  await page.reload();
  const show = page.getByRole("button", { name: /^Show the sidebar/u });

  await show.waitFor();
  const hiddenKept = await sidebar.count();

  await show.click();
  await sidebar.waitFor();

  return { hiddenKept, narrow, wide: await sidebarWidth(), widthKept };
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
          // Its id, and an open circle, which is offline.
          afterReload: "example\u25CB",
          afterWrong: { describedBy: true, field: "", inPage: false, tracker: "" },
          configured: 200,
          cookies: [{ holdsKey: false, httpOnly: true, name: "iirc_sign_in", sameSite: "Strict" }],
          cookiesAfter: [],
          held: { cookie: "", local: ["iirc.layout"], localHoldsKey: false, session: 0 },
          listed: "example\u25CB",
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
          status: status.startsWith("\u25BEprivate") && status.endsWith("\u25CF"),
          violations,
        }).toStrictEqual({
          // mIRC's red is the theme's bright red, `light`'s under Playwright's light device.
          formatting: { bold: "700", red: "rgb(194, 24, 91)" },
          kept: true,
          linked: { href: "https://example.com/x", rel: "noopener noreferrer", target: "_blank" },
          pinned: true,
          problems: [],
          // The chevron, the id, and a filled circle, which is connected.
          status: true,
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

        // Ours, in the Timeline, once: ngircd has no echo-message, so it stays unconfirmed,
        // which is not worth saying on every line.
        const ourRow = log.locator("[data-index]", { hasText: "hello from the web" });

        await ourRow.waitFor();
        await expect.poll(async () => await ourRow.textContent()).not.toContain("sending");

        const delivery = /sending|unconfirmed|not sent|refused/u.test(
          (await ourRow.textContent()) ?? ""
        );

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
          delivery,
          direct: direct.params,
          heard: heard.params,
          problems: problems.filter((problem) => problem.includes("Content Security Policy")),
          recalled,
          rows,
          violations,
        }).toStrictEqual({
          action: [channel, "\u0001ACTION waves\u0001"],
          cleared: "",
          delivery: false,
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
    "disconnects and connects with /disconnect and /connect, and begins a Direct Message with /query",
    { timeout: 90_000 },
    async () => {
      const { base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "connect"),
        "#iirc-connect"
      );

      try {
        const { page, problems } = await watchedPage(browser);

        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await networkRow(page);
        await page.getByRole("row", { name: channel }).click();

        const composer = page.getByRole("textbox", { name: channel });
        const standing = async () => await standingLabel(page);

        // `/disconnect` turns the focused Network off, and the sidebar says so.
        await composer.fill("/disconnect");
        await composer.press("Enter");
        await expect
          .poll(standing, { timeout: 20_000 })
          .toMatch(/, (?:offline|stopped)(?:: .*)?$/u);
        const off = await standing();

        // `/connect` turns it on again.
        await composer.fill("/connect");
        await composer.press("Enter");
        await expect.poll(standing, { timeout: 20_000 }).toMatch(/, connected$/u);
        const on = await standing();

        // `/query` to a nick nothing was said to yet shows a Direct Message not yet begun,
        // and plain text typed there goes to the nick, which makes its Timeline.
        await composer.fill("/query peer");
        await composer.press("Enter");
        await page.getByRole("region", { name: "Direct Message with peer" }).waitFor();

        const draft = page.getByRole("textbox", { name: "peer" });

        await draft.fill("hi");
        await draft.press("Enter");

        const direct = await peer.waitFor(
          (line) => line.command === "PRIVMSG" && line.params[0] === "peer",
          "the Direct Message"
        );

        await page.getByRole("log", { name: "peer" }).getByText("hi", { exact: true }).waitFor();

        const drafted = await page
          .getByRole("region", { name: "Direct Message with peer" })
          .count();

        const violations = await page.evaluate(
          () => document.documentElement.dataset.cspViolations ?? ""
        );

        expect({
          direct: direct.params,
          drafted,
          off: /, (?:offline|stopped)(?:: .*)?$/u.test(off),
          on: on.endsWith(", connected"),
          problems: problems.filter((problem) => problem.includes("Content Security Policy")),
          violations,
        }).toStrictEqual({
          direct: ["peer", "hi"],
          drafted: 0,
          off: true,
          on: true,
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

        // A topic set from the composer shows in the Pane's status bar.
        await composer.fill("/topic a plan for today");
        await composer.press("Enter");
        await page
          .locator("[data-pane] header")
          .getByRole("button", { exact: true, name: "a plan for today" })
          .waitFor();

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
    "looks a User up: /whois shows their card with user@host and the Channel shared, and /whois nobody says not found",
    { timeout: 90_000 },
    async () => {
      const { base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "lookup"),
        "#iirc-lookup"
      );

      try {
        const { page, problems } = await watchedPage(browser);

        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await networkRow(page);
        await page.getByRole("row", { name: channel }).click();
        await page.getByRole("log", { name: channel }).waitFor();

        const composer = page.getByRole("textbox", { name: channel });

        await composer.fill("/whois peer");
        await composer.press("Enter");

        // The peer made the Channel, so holds its operator rank there, and its Timeline is
        // open, so choosing it opens it.
        const card = page.getByRole("region", { name: "whois peer" });
        const shared = card.getByRole("button", { name: `Open ${channel}, operator` });

        await shared.waitFor();

        const drawn = {
          channel: await shared.textContent(),
          mask: /\bpeer@\S+/u.test((await card.textContent()) ?? ""),
        };

        // Escape in the composer puts it away.
        await composer.press("Escape");
        await card.waitFor({ state: "detached" });

        await composer.fill("/whois nobody");
        await composer.press("Enter");

        const missing = page.getByRole("region", { name: "whois nobody" });

        await missing.getByText(/^No one uses the nick nobody now \(\d{3}\)\.$/u).waitFor();

        const violations = await page.evaluate(
          () => document.documentElement.dataset.cspViolations ?? ""
        );

        expect({
          drawn,
          problems: problems.filter((problem) => problem.includes("Content Security Policy")),
          violations,
        }).toStrictEqual({
          drawn: { channel: `@${channel}`, mask: true },
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

        const composer = page.getByRole("textbox", { name: channel });

        await page.getByRole("log", { name: channel }).waitFor();

        // The peer sets the topic: the bar reads the Channel again and shows it on one line,
        // which a press discloses in full, formatted, with who set it in its place.
        peer.send(`TOPIC ${channel} :the \u0002plan\u0002 for today`);
        const head = page.locator("[data-pane] header");
        const line = head.getByRole("button", { name: "the plan for today" });

        await line.click();
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

        // A press on a member opens their menu, as dense as the list, Query focused first.
        await peerRow.click();
        const query = page.getByRole("menuitem", { name: "Query peer" });

        await query.waitFor();

        const [actionBox, rowBox] = [await query.boundingBox(), await peerRow.boundingBox()];

        const menu = {
          focused: await query.evaluate((element) => element === document.activeElement),
          height: actionBox?.height === rowBox?.height,
          items: await page.getByRole("menuitem").count(),
        };

        await page.keyboard.press("Escape");
        await query.waitFor({ state: "detached" });

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
          menu,
          problems: problems.filter((problem) => problem.includes("Content Security Policy")),
          symbol,
          topic,
          violations,
        }).toStrictEqual({
          completed: "peer: ",
          menu: { focused: true, height: true, items: 3 },
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

        await nowhere.fill(`/network add test ${ngircd.host}/${ngircd.plainPort} plain iirc`);
        await nowhere.press("Enter");

        const row = page.getByRole("row", { name: /^test, .*connected$/u });

        await row.waitFor({ timeout: 20_000 });

        // The Network's own Timeline, which its row opens, then /join there.
        await row.click();
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
        // The Panes' dividers, apart from the sidebar's edge, which is outside the main view.
        const dividers = page.getByRole("main").getByRole("separator");

        await dividers.waitFor();
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
        const separator = dividers;
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
        await dividers.nth(1).waitFor();

        const kept = async () =>
          await left.evaluate((element) => ({
            focused: document.activeElement === element,
            latest: element.scrollHeight - element.scrollTop - element.clientHeight < 8,
          }));

        const splitKept = await kept();

        await page.keyboard.press("Alt+Shift+W");
        await expect.poll(async () => await dividers.count()).toBe(1);
        const closeKept = await kept();

        // The page keeps its layout in the same tick as it changes, so a reload straight
        // after the close finds the two Panes side by side, with nothing to wait for.
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
          separators: await dividers.count(),
        };

        // The sidebar resizes and hides apart from the Panes, each kept on this device.
        const resized = await resizedSidebar(page);

        const violations = await page.evaluate(
          () => document.documentElement.dataset.cspViolations ?? ""
        );

        expect({
          after,
          dragged: dragged !== undefined && dragged > 0.6 && dragged < 0.7,
          moved: [splitKept, closeKept],
          problems: problems.filter((problem) => problem.includes("Content Security Policy")),
          resized,
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
          resized: { hiddenKept: 0, narrow: 200, wide: 300, widthKept: "300" },
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

  it(
    "shares ui options between devices, shows seconds, hides joins when quiet, and overrides the theme on one device",
    { timeout: 90_000 },
    async () => {
      const { api, base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "ui"),
        "#iirc-ui"
      );

      const newcomer = await connectPeer({
        host: ngircd.host,
        nick: "newcomer",
        port: ngircd.plainPort,
      });

      try {
        // Two devices, each a browser context of its own, with its own storage.
        const devices = [await watchedPage(browser), await watchedPage(browser)];

        const opened = await Promise.all(
          devices.map(async ({ page }) => {
            await page.goto(base);
            await page.getByLabel("Key").fill(key);
            await page.getByRole("button", { name: "Sign in" }).click();
            await page.getByRole("row", { name: channel }).click();

            return {
              composer: page.getByRole("textbox", { name: channel }),
              log: page.getByRole("log", { name: channel }),
              page,
            };
          })
        );

        const [first, second] = opened;

        if (first === undefined || second === undefined) {
          throw new Error("two devices were opened");
        }

        const type = async (where: typeof first, text: string) => {
          await where.composer.fill(text);
          await where.composer.press("Enter");
        };

        peer.send(`PRIVMSG ${channel} :before`);
        await second.log.getByText("before", { exact: true }).waitFor();
        const timeBefore = await second.log.locator("time").last().textContent();

        // Set on one device, shown on the other: a line's time with seconds.
        await type(first, "/set ui.time HH:mm:ss");
        await expect
          .poll(async () => await second.log.locator("time").last().textContent())
          .toMatch(/^\d{2}:\d{2}:\d{2}$/u);

        // Quiet hides a join, and the Message after it shows.
        await type(first, "/set ui.activity quiet");
        await expect
          .poll(async () => {
            const answer = await api("GET", "/ui");
            const text = await answer.text();

            return decodeUi(text).activity;
          })
          .toBe("quiet");
        newcomer.send(`JOIN ${channel}`);
        await newcomer.waitFor((line) => line.command === "JOIN", "the newcomer's own JOIN");
        newcomer.send(`PRIVMSG ${channel} :after the join`);
        await second.log.getByText("after the join", { exact: true }).waitFor();
        await expect
          .poll(async () => await second.log.getByText(/newcomer joined/u).count())
          .toBe(0);
        const quiet = await first.log.getByText(/newcomer joined/u).count();

        // All shows it again, on both devices.
        await type(second, "/set ui.activity all");
        await second.log.getByText(/newcomer joined/u).waitFor();
        await first.log.getByText(/newcomer joined/u).waitFor();

        // A theme for this device alone wins over the one every device shares, and is never sent.
        await type(first, "/set -device ui.theme light");
        await type(second, "/set ui.theme dark");

        const themeOf = async (where: typeof first) =>
          await where.page.evaluate(() => [
            document.documentElement.dataset.theme,
            getComputedStyle(document.body).backgroundColor,
          ]);

        const drawnIn = async (where: typeof first) =>
          await where.page.evaluate(() => document.documentElement.dataset.theme);

        await expect.poll(async () => await drawnIn(second)).toBe("dark");
        await expect.poll(async () => await drawnIn(first)).toBe("light");

        const answered = await api("GET", "/ui");
        const shared = await answered.text();
        const kept = await first.page.evaluate(() => localStorage.getItem("iirc.ui"));

        const violations = await Promise.all(
          opened.map(
            async ({ page }) =>
              await page.evaluate(() => document.documentElement.dataset.cspViolations ?? "")
          )
        );

        expect({
          kept,
          problems: devices.flatMap(({ problems }) =>
            problems.filter((problem) => problem.includes("Content Security Policy"))
          ),
          quiet,
          shared: decodeUi(shared),
          themes: [await themeOf(first), await themeOf(second)],
          timeBefore: /^\d{2}:\d{2}$/u.test(timeBefore ?? ""),
          violations,
        }).toStrictEqual({
          kept: '{"theme":"light"}',
          problems: [],
          quiet: 0,
          shared: { activity: "all", theme: "dark", time: "HH:mm:ss" },
          themes: [
            ["light", "rgb(246, 245, 241)"],
            ["dark", "rgb(17, 19, 20)"],
          ],
          timeBefore: true,
          violations: ["", ""],
        });
      } finally {
        newcomer.close();
        peer.close();
        child.kill("SIGTERM");
        await child.exited;
        await ngircd.stop();
      }
    }
  );

  it(
    "fetches no font with the device's own, sets the text's size and a bundled font at once, and serves its files from the page's origin, under the policy",
    { timeout: 60_000 },
    async () => {
      const { base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "fonts"),
        "#iirc-fonts"
      );

      try {
        const { page, problems } = await watchedPage(browser);
        const fonts: { url: string; type: string | null; cache: string | null }[] = [];

        page.on("response", (response) => {
          if (response.request().resourceType() === "font") {
            const headers = response.headers();

            fonts.push({
              cache: headers["cache-control"] ?? null,
              type: headers["content-type"] ?? null,
              url: response.url(),
            });
          }
        });

        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.getByRole("row", { name: channel }).click();

        const composer = page.getByRole("textbox", { name: channel });
        const log = page.getByRole("log", { name: channel });

        const type = async (text: string) => {
          await composer.fill(text);
          await composer.press("Enter");
        };

        // Bold, italic, box drawing, and block elements, as IRC art has them.
        peer.send(`PRIVMSG ${channel} :\u0002bold\u0002 \u001Ditalic\u001D ┌─┐│█▓▒░│└─┘`);
        await log.getByText("italic").waitFor();
        await page.evaluate(async () => {
          await document.fonts.ready;
        });

        const drawn = async () =>
          await page.evaluate(() => {
            const style = getComputedStyle(document.body);

            return [style.fontSize, style.fontFamily.split(",")[0]?.trim() ?? ""];
          });

        const byDefault = { drawn: await drawn(), fetched: fonts.length };

        await type("/set ui.size 18");
        await expect.poll(drawn).toStrictEqual(["18px", "ui-monospace"]);

        await type("/set ui.font jetbrains-mono");
        await expect.poll(drawn).toStrictEqual(["18px", '"JetBrains Mono Variable"']);

        // Each face the line draws with is fetched: the regular, whose variable weight is also
        // the bold, and the italic.
        await expect
          .poll(
            async () =>
              await page.evaluate(async () => {
                await document.fonts.ready;

                return [...document.fonts]
                  .flatMap((face) =>
                    face.status === "loaded" ? [`${face.family} ${face.style}`] : []
                  )
                  .toSorted();
              })
          )
          .toStrictEqual(["JetBrains Mono Variable italic", "JetBrains Mono Variable normal"]);

        const violations = await page.evaluate(
          () => document.documentElement.dataset.cspViolations ?? ""
        );

        const { origin } = new URL(base);

        expect({
          byDefault,
          fetched: fonts.map((font) => ({
            cache: font.cache,
            own: new URL(font.url).origin === origin,
            path: new URL(font.url).pathname.replace(/-[\w-]{8}\.woff2$/u, ".woff2"),
            type: font.type,
          })),
          problems: problems.filter((problem) => !problem.includes("401")),
          violations,
        }).toStrictEqual({
          byDefault: { drawn: ["14px", "ui-monospace"], fetched: 0 },
          fetched: [
            {
              cache: "public, max-age=31536000, immutable",
              own: true,
              path: "/assets/jetbrains-mono-latin-wght-normal.woff2",
              type: "font/woff2",
            },
            {
              cache: "public, max-age=31536000, immutable",
              own: true,
              path: "/assets/jetbrains-mono-latin-wght-italic.woff2",
              type: "font/woff2",
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
    "imports a theme from Alacritty's text, previews it, saves it, draws in it on two devices, and previews built-ins from the palette, under the policy",
    { timeout: 90_000 },
    async () => {
      const { channel, child, key, ngircd, peer, base } = await privateNetwork(
        path.join(directory, "themes"),
        "#iirc-themes"
      );

      try {
        const devices = [await watchedPage(browser), await watchedPage(browser)];

        const opened = await Promise.all(
          devices.map(async ({ page }) => {
            await page.goto(base);
            await page.getByLabel("Key").fill(key);
            await page.getByRole("button", { name: "Sign in" }).click();
            await page.getByRole("row", { name: channel }).click();

            return {
              composer: page.getByRole("textbox", { name: channel }),
              log: page.getByRole("log", { name: channel }),
              page,
            };
          })
        );

        const [first, second] = opened;

        if (first === undefined || second === undefined) {
          throw new Error("two devices were opened");
        }

        const type = async (where: typeof first, text: string) => {
          await where.composer.fill(text);
          await where.composer.press("Enter");
        };

        const drawn = async (where: typeof first) =>
          await where.page.evaluate(() => [
            document.documentElement.dataset.theme,
            getComputedStyle(document.body).backgroundColor,
          ]);

        const background = async (where: typeof first) =>
          await where.page.evaluate(() => getComputedStyle(document.body).backgroundColor);

        const before = await drawn(first);

        // The dialog reads the text as it is pasted, and draws the page in it at once.
        await type(first, "/theme import");
        const dialog = first.page.getByRole("dialog", { name: "Import a theme" });

        await dialog.getByLabel(/theme file's text/u).fill(nordAlacritty);
        await dialog.getByText("Read as Alacritty.").waitFor();
        await expect.poll(async () => await background(first)).toBe("rgb(46, 52, 64)");
        const previewed = await background(first);

        await dialog.getByLabel("Name").fill("nord-mine");
        await dialog.getByRole("button", { name: "Save" }).click();
        await dialog.waitFor({ state: "detached" });
        const saved = await drawn(first);

        // Drawn in on one device, every device draws it.
        await type(first, "/theme nord-mine");
        await expect
          .poll(async () => await drawn(second))
          .toStrictEqual(["nord-mine", "rgb(46, 52, 64)"]);
        await expect
          .poll(async () => await drawn(first))
          .toStrictEqual(["nord-mine", "rgb(46, 52, 64)"]);

        // The palette draws a built-in one while it is highlighted, and the one in effect after.
        await type(second, "/theme");
        const search = second.page.getByRole("searchbox", { name: "Command, Timeline, or option" });

        await search.fill("dracula");
        await second.page.keyboard.press("ArrowDown");
        await expect.poll(async () => await background(second)).toBe("rgb(40, 42, 54)");
        const highlighted = await background(second);

        await second.page.keyboard.press("Escape");
        await second.page.keyboard.press("Escape");
        await search.waitFor({ state: "detached" });
        await expect.poll(async () => await background(second)).toBe("rgb(46, 52, 64)");

        // A colour a Message asks for is the theme's, through its variable.
        peer.send(`PRIVMSG ${channel} :\u000304warned`);
        const warned = first.log.getByText("warned", { exact: true });

        await warned.waitFor();

        const colour = await warned.evaluate((element) => ({
          asked: element.style.color,
          drawn: getComputedStyle(element).color,
          theme: getComputedStyle(document.documentElement).getPropertyValue("--irc-4").trim(),
        }));

        // Text Effect's YAML parser takes seconds over in JavaScriptCore and Node is read in a
        // Worker, ended after a second and refused in words, while the page answers at once.
        // Chromium's V8 reads it in milliseconds, so the Worker's script is stood in for here
        // by one that never answers, served from the page's own origin as the real one is.
        await first.page.route(/import-worker-[^/]*\.js$/u, async (route) => {
          await route.fulfill({
            body: "self.addEventListener('message', () => { for (;;) {} });",
            contentType: "text/javascript",
          });
        });

        await type(first, "/theme import");
        const slowDialog = first.page.getByRole("dialog", { name: "Import a theme" });
        const slowText = `base00: x\nextra: "${"\\".repeat(160_000)}x\n  end"`;
        const pasted = Date.now();

        await slowDialog.getByLabel(/theme file's text/u).fill(slowText);
        await slowDialog.getByText("Reading…").waitFor();
        const answered = Date.now();

        await first.page.evaluate(() => document.title);
        const responsive = Date.now() - answered;

        await slowDialog.getByText(/took too long to read/u).waitFor({ timeout: 5000 });
        const refusedAfter = Date.now() - pasted;

        await slowDialog.getByRole("button", { name: "Cancel" }).click();
        await slowDialog.waitFor({ state: "detached" });
        await first.page.unrouteAll();

        const violations = await Promise.all(
          opened.map(
            async ({ page }) =>
              await page.evaluate(() => document.documentElement.dataset.cspViolations ?? "")
          )
        );

        expect({
          before,
          colour: { asked: colour.asked, drawn: hexOf(colour.drawn) === colour.theme },
          highlighted,
          previewed,
          problems: devices.flatMap(({ problems }) =>
            problems.filter((problem) => problem.includes("Content Security Policy"))
          ),
          saved,
          slow: { refused: refusedAfter < 3000, responsive: responsive < 500 },
          violations,
        }).toStrictEqual({
          before: ["system", "rgb(246, 245, 241)"],
          colour: { asked: "var(--irc-4)", drawn: true },
          highlighted: "rgb(40, 42, 54)",
          previewed: "rgb(46, 52, 64)",
          problems: [],
          saved: ["system", "rgb(246, 245, 241)"],
          slow: { refused: true, responsive: true },
          violations: ["", ""],
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
    "searches the Messages newest first, narrows by sender, and jumps to an older one, centred and marked, while live ones arrive below",
    { timeout: 120_000 },
    async () => {
      const { api, base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "search"),
        "#iirc-search"
      );

      const say = async (text: string) =>
        await api(
          "POST",
          "/networks/private/say",
          JSON.stringify({ kind: "Privmsg", target: channel, text })
        );

      // How many Messages the Daemon finds for some text, once it folded them.
      const found = async (text: string) => {
        const answer = await api("GET", `/search?text=${encodeURIComponent(text)}`);

        const page = Schema.decodeSync(
          Schema.fromJsonString(Schema.Struct({ items: Schema.Array(Schema.Unknown) }))
        )(await answer.text());

        return page.items.length;
      };

      try {
        // Each needle said by peer, then by us, with filler around them, so the first lies
        // far from the latest and has a view's worth before it.
        for (let index = 1; index <= 40; index += 1) {
          // oxlint-disable-next-line no-await-in-loop -- said in order
          await say(`filler before ${index}`);
        }

        peer.send(`PRIVMSG ${channel} :a needle from peer 1`);
        await expect.poll(async () => await found("needle from peer"), { timeout: 20_000 }).toBe(1);
        await say("a needle from iirc 1");

        for (let index = 1; index <= 30; index += 1) {
          // oxlint-disable-next-line no-await-in-loop -- said in order
          await say(`filler between ${index}`);
        }

        peer.send(`PRIVMSG ${channel} :a needle from peer 2`);
        await expect.poll(async () => await found("needle from peer"), { timeout: 20_000 }).toBe(2);
        await say("a needle from iirc 2");

        for (let index = 1; index <= 60; index += 1) {
          // oxlint-disable-next-line no-await-in-loop -- said in order
          await say(`filler after ${index}`);
        }

        await expect.poll(async () => await found("filler after 60"), { timeout: 20_000 }).toBe(1);

        const { page, problems } = await watchedPage(browser);

        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await networkRow(page);
        await page.getByRole("row", { name: channel }).click();

        const log = page.getByRole("log", { name: channel });

        await log.getByText("filler after 60", { exact: true }).waitFor();

        // Mod+Shift+F from the composer shows the search, with the caret in its field.
        await page.getByRole("textbox", { name: channel }).focus();
        await page.keyboard.press("Control+Shift+F");

        const field = page.getByRole("textbox", { exact: true, name: "Search" });
        const results = page.getByRole("listbox", { name: "Results" });
        const options = results.getByRole("option");

        await expect
          .poll(async () => await field.evaluate((element) => element === document.activeElement))
          .toBe(true);

        await page.keyboard.type("needle");
        await page.keyboard.press("Enter");
        await expect.poll(async () => await options.count()).toBe(4);

        // Who said each, by the nick its line shows, newest first, and what was marked.
        const shown = async () =>
          await options.evaluateAll((rows) =>
            rows.map((row) => row.textContent?.replace(/^.*?</u, "<") ?? "")
          );

        const all = await shown();
        const marked = await options.first().locator("mark").textContent();

        await field.fill("needle from:peer");
        await page.keyboard.press("Enter");
        await expect.poll(async () => await options.count()).toBe(2);
        const narrowed = await shown();

        // Into the results, to the older, and Enter jumps to it.
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");

        const target = log.locator("[data-target]");

        await target.waitFor();

        // How far the target's middle stands from the middle of the log, in pixels.
        const offCentre = async () =>
          await log.evaluate((element) => {
            const row = element.querySelector("[data-target]");
            const box = element.getBoundingClientRect();
            const at = row?.getBoundingClientRect();

            return at === undefined
              ? null
              : Math.round(at.top + at.height / 2 - (box.top + box.height / 2));
          });

        // Centred within a row, and settled: the same twice, a moment apart, as rows measure.
        let last: number | null = null;

        await expect
          .poll(async () => {
            const now = await offCentre();
            const settled = now !== null && now === last && Math.abs(now) <= 20;

            last = now;

            return settled;
          })
          .toBe(true);
        const centred = await offCentre();
        const targetText = await target.textContent();
        const jump = page.getByRole("button", { name: "Jump to latest" });
        const jumpShown = await jump.isVisible();

        // Live Messages arrive beyond the window, and the target stays where it was.
        peer.send(`PRIVMSG ${channel} :live one`);
        peer.send(`PRIVMSG ${channel} :live two`);
        await expect.poll(async () => await found("live two"), { timeout: 20_000 }).toBe(1);
        await page.waitForTimeout(500);
        const stayed = await offCentre();

        // Jump to latest reads the latest again, and follows it.
        await jump.click();
        await log.getByText("live two", { exact: true }).waitFor();
        await expect
          .poll(
            async () =>
              await log.evaluate(
                (element) => element.scrollHeight - element.scrollTop - element.clientHeight < 8
              )
          )
          .toBe(true);

        const violations = await page.evaluate(
          () => document.documentElement.dataset.cspViolations ?? ""
        );

        expect({
          all,
          centred: Math.abs(centred ?? 999) <= 20,
          jumpShown,
          marked,
          narrowed,
          problems: problems.filter((problem) => problem.includes("Content Security Policy")),
          stayed: Math.abs((stayed ?? 999) - (centred ?? 0)) <= 2 ? true : [centred, stayed],
          target: targetText?.includes("a needle from peer 1"),
          violations,
        }).toStrictEqual({
          all: [
            "<iirc> a needle from iirc 2",
            "<peer> a needle from peer 2",
            "<iirc> a needle from iirc 1",
            "<peer> a needle from peer 1",
          ],
          centred: true,
          jumpShown: true,
          marked: "needle",
          narrowed: ["<peer> a needle from peer 2", "<peer> a needle from peer 1"],
          problems: [],
          stayed: true,
          target: true,
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
    "works on a phone: fields at 16px, targets a finger's size, the sidebar as a drawer, the members as a sheet, and the palette from a button, never scrolling sideways",
    { timeout: 90_000 },
    async () => {
      const { base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "phone"),
        "#iirc-phone"
      );

      try {
        // A phone's screen, touched, at the width of most phones today.
        const context = await browser.newContext({
          deviceScaleFactor: 3,
          hasTouch: true,
          isMobile: true,
          viewport: { height: 844, width: 390 },
        });

        const page = await context.newPage();
        const problems: string[] = [];

        page.on("pageerror", (error) => problems.push(error.message));

        /**
         * The computed font size of every field in the page.
         * @returns Each, in pixels.
         */
        const fieldSizes = async () =>
          await page.evaluate(() =>
            [...document.querySelectorAll("input, textarea")].map((one) =>
              Number(getComputedStyle(one).fontSize.replace("px", ""))
            )
          );

        /**
         * How far the page can scroll sideways: none, on a phone.
         * @returns How far, in pixels.
         */
        const sideways = async () =>
          await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth
          );

        const fields: number[] = [];
        const targets: Record<string, number> = {};
        const scrolled: number[] = [];

        await page.goto(base);
        await page.getByLabel("Key").waitFor();
        fields.push(...(await fieldSizes()));
        scrolled.push(await sideways());
        await page.getByLabel("Key").fill(key);
        targets.key = await leastSide(page.getByLabel("Key"));
        targets["sign in"] = await leastSide(page.getByRole("button", { name: "Sign in" }));
        await page.getByRole("button", { name: "Sign in" }).tap();

        // Signed in: no sidebar beside the Panes, and a button in the bar for it.
        const networks = page.getByRole("button", { name: /^Networks/u });

        await networks.waitFor();
        await page.getByRole("textbox").first().waitFor();
        const sidebarBeside = await page.locator('nav[aria-label="Networks"]').count();

        fields.push(...(await fieldSizes()));
        scrolled.push(await sideways());
        targets.networks = await leastSide(networks);
        targets.palette = await leastSide(page.getByRole("button", { name: "Command palette" }));
        targets.composer = await leastSide(page.getByRole("textbox").first());

        // The drawer opens, and choosing a Timeline in it opens that and closes it.
        await networks.tap();
        const drawer = page.getByRole("dialog", { name: "Networks" });

        await drawer.waitFor();
        const row = drawer.getByRole("row", { name: new RegExp(`^${channel}`, "u") });

        await row.waitFor();
        targets["sidebar row"] = await leastSide(row);
        targets["network row"] = await leastSide(drawer.getByRole("row").first());
        targets.options = await leastSide(drawer.getByRole("button", { name: "Options" }));
        targets["sign out"] = await leastSide(drawer.getByRole("button", { name: "Sign out" }));
        scrolled.push(await sideways());
        await row.tap();
        await drawer.waitFor({ state: "detached" });
        const log = page.getByRole("log", { name: channel });

        await log.waitFor();
        peer.send(`PRIVMSG ${channel} :hello from a phone's peer`);
        await log.getByText("hello from a phone's peer").waitFor();

        // The members are a sheet over the Channel, from the toggle in its status bar.
        const toggle = page.getByRole("button", { name: /^Members\b/u });

        targets["members toggle"] = await leastSide(toggle);
        await toggle.tap();
        const sheet = page.getByRole("dialog", { name: "members" });
        const member = sheet.getByRole("row", { name: /^peer\b/u });

        await member.waitFor();
        targets["member row"] = await leastSide(member);
        targets["members hide"] = await leastSide(
          sheet.getByRole("button", { name: "Hide the members" })
        );
        scrolled.push(await sideways());

        // A tap on a member opens their menu, a finger's size, and Escape closes it alone.
        await member.tap();
        const action = page.getByRole("menuitem", { name: "Query peer" });

        await action.waitFor();
        targets["member action"] = await leastSide(action);
        scrolled.push(await sideways());
        await page.keyboard.press("Escape");
        await action.waitFor({ state: "detached" });
        await sheet.getByRole("button", { name: "Hide the members" }).tap();
        await sheet.waitFor({ state: "detached" });

        // The palette, from its button, since a phone has no keys to open it with.
        await page.getByRole("button", { name: "Command palette" }).tap();
        const palette = page.getByRole("dialog", { name: "Command palette" });

        await palette.waitFor();
        const entry = palette.getByRole("menuitem").first();

        await entry.waitFor();
        targets["palette entry"] = await leastSide(entry);
        targets["palette field"] = await leastSide(palette.getByRole("searchbox"));
        fields.push(...(await fieldSizes()));
        scrolled.push(await sideways());
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        await palette.waitFor({ state: "detached" });

        // The options' filter and the search's field, each in turn. The composer's name is
        // what its Pane shows, so it is found as the one textarea.
        const composer = page.locator("textarea");

        await composer.fill("/set");
        await composer.press("Enter");
        await page.getByRole("searchbox").waitFor();
        fields.push(...(await fieldSizes()));
        scrolled.push(await sideways());
        targets["options close"] = await leastSide(
          page.getByRole("button", { name: "Close the options" })
        );
        await page.getByRole("button", { name: "Close the options" }).tap();
        await log.waitFor();

        await composer.fill("/search hello");
        await composer.press("Enter");
        const searchField = page.getByRole("textbox", { exact: true, name: "Search" });

        await searchField.waitFor();
        fields.push(...(await fieldSizes()));
        scrolled.push(await sideways());
        targets["search field"] = await leastSide(searchField);

        // Its close button shows the Timeline again, with no key to press.
        const closeSearch = page.getByRole("button", { name: "Close the search" });

        targets["search close"] = await leastSide(closeSearch);
        await closeSearch.tap();
        await searchField.waitFor({ state: "detached" });
        await log.waitFor();

        const small = Object.entries(targets).filter(([, side]) => side < 44);

        expect({
          fields: fields.length > 0 && fields.every((size) => size >= 16),
          problems,
          sidebarBeside,
          sideways: scrolled.every((by) => by === 0) ? true : scrolled,
          small,
        }).toStrictEqual({
          fields: true,
          problems: [],
          sidebarBeside: 0,
          sideways: true,
          small: [],
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
    "draws a Timeline's rows inline where it is narrow, and never scrolls it sideways at any width",
    { timeout: 90_000 },
    async () => {
      const { base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "narrow"),
        "#iirc-narrow"
      );

      const visitor = await connectPeer({
        host: ngircd.host,
        nick: "visitor",
        port: ngircd.plainPort,
      });

      try {
        const context = await browser.newContext({ viewport: { height: 800, width: 1280 } });
        const page = await context.newPage();
        const problems: string[] = [];

        page.on("pageerror", (error) => problems.push(error.message));

        // No Ircd here says a Channel's modes with a parameter as long as it likes, so the
        // Channel's head is answered as the Daemon answers it, with its modes made hostile.
        await page.route(/\/api\/timelines\/[^/]+\/channel$/u, async (route) => {
          // The Daemon may have stopped, as the test ends.
          const response = await route.fetch().catch(() => {});

          if (response === undefined) {
            await route.abort();

            return;
          }

          const head = decodeHead(await response.text());

          await route.fulfill({
            json: {
              ...head,
              modes: {
                _tag: "Known",
                at: 1,
                from: "ircd",
                value: [{ mode: "f", param: "x".repeat(200) }],
              },
            },
            response,
          });
        });

        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await networkRow(page);
        await page.getByRole("row", { name: channel }).click();
        const log = page.getByRole("log", { name: channel });

        await log.waitFor();

        // Enough before them that the Timeline scrolls, each long enough to wrap where narrow.
        for (let index = 1; index <= 80; index += 1) {
          peer.send(`PRIVMSG ${channel} :filler ${index} ${"some words to wrap ".repeat(5)}`);
        }

        await log.getByText("filler 80 ", { exact: false }).waitFor();

        // What has nowhere to break, what is wide, and what is plain, said and done.
        const said = [
          "a short one",
          "unbroken".repeat(40),
          `https://example.com/${"path/".repeat(60)}?q=${"v".repeat(80)}`,
          "\u5168\u89D2\u6587\u5B57".repeat(25),
          "words that wrap ".repeat(12),
        ];

        for (const line of said) {
          peer.send(`PRIVMSG ${channel} :${line}`);
        }

        peer.send(`PRIVMSG ${channel} :\u0001ACTION ${"waves ".repeat(30)}\u0001`);
        visitor.send(`JOIN ${channel}`);
        visitor.send(`QUIT :${"gone".repeat(60)}`);
        await log.getByText("a short one").waitFor();
        await log.getByText("waves", { exact: false }).first().waitFor();

        /**
         * How the log draws at a width: whether it scrolls sideways, and how a Message's row is laid out.
         * @param width - The page's width.
         * @returns What it drew.
         */
        const drawnAt = async (width: number) => {
          await page.setViewportSize({ height: 800, width });
          await expect.poll(async () => await log.getByText("a short one").count()).toBe(1);

          return await log.evaluate((element) => {
            const row = [...element.querySelectorAll("[data-index]")].find((one) =>
              one.textContent?.includes("a short one")
            );

            const message = row?.firstElementChild?.firstElementChild;

            return {
              layout:
                message === null || message === undefined ? "" : getComputedStyle(message).display,
              sideways: element.scrollWidth - element.clientWidth,
            };
          });
        };

        /**
         * Whether a Channel's modes as long as a Network likes keep the bar's control in its
         * Pane, with the hostile modes the head was answered with.
         * @param width - The page's width.
         * @returns How far the members' toggle reaches past the bar.
         */
        const hostileModes = async (width: number) => {
          await page.setViewportSize({ height: 800, width });

          return await page
            .locator("[data-pane] header")
            .first()
            .evaluate((bar) => {
              const toggle = bar.querySelector("[data-members-toggle]");

              if (toggle === null) {
                return "missing";
              }

              return Math.max(
                Math.round(
                  toggle.getBoundingClientRect().right - bar.getBoundingClientRect().right
                ),
                0
              );
            });
        };

        /**
         * Where the Timeline stands: how far it is from its end, and the first row whose top
         * is in view, the row the view holds still as the rows wrap again, with how far below
         * the top of the view it starts.
         * @returns Where it stands.
         */
        const standing = async () =>
          await log.evaluate((element) => {
            const { top } = element.getBoundingClientRect();

            const first = [...element.querySelectorAll("[data-index]")]
              .map((row) => ({ at: row.getBoundingClientRect().top - top, row }))
              .find(({ at }) => at > -0.5);

            return {
              fromEnd: Math.round(element.scrollHeight - element.scrollTop - element.clientHeight),
              offset: first === undefined ? undefined : Math.round(first.at),
              row: first?.row.textContent?.match(/filler \d+/u)?.[0],
            };
          });

        const fromEnd = async () => {
          const now = await standing();

          return now.fromEnd;
        };

        /** Waits for a frame to be drawn after this one, by which the rows are measured. */
        const painted = async () => {
          await page.evaluate(async () => {
            const { promise, resolve } = Promise.withResolvers<undefined>();

            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                resolve(undefined);
              });
            });
            await promise;
          });
        };

        /**
         * Resizes the page in one step, and waits for the rows to be drawn at the new width.
         * @param width - The page's width.
         */
        const resize = async (width: number) => {
          await page.setViewportSize({ height: 800, width });
          await painted();
        };

        const box = await log.boundingBox();

        await page.mouse.move((box?.x ?? 0) + 100, (box?.y ?? 0) + 100);

        // At the latest, it stays at the latest as every row wraps again, and follows what is
        // said after.
        await page.mouse.wheel(0, 100_000);
        await expect.poll(fromEnd).toBeLessThanOrEqual(1);
        await resize(560);
        const latestNarrow = await fromEnd();

        peer.send(`PRIVMSG ${channel} :said once narrow`);
        await log.getByText("said once narrow").waitFor();
        await painted();
        const latestAfter = await fromEnd();

        await resize(1280);
        const latestBack = await fromEnd();

        // Reading older, the first row in view stays where it is as every row wraps again,
        // in one step there and back, while the scroll that put it there has only just ended.
        await page.mouse.wheel(0, -1200);
        await expect.poll(fromEnd).toBeGreaterThan(400);
        await painted();
        const reading = await standing();

        await resize(560);
        const readingNarrow = await standing();

        await resize(1280);
        const readingBack = await standing();

        // The same as the text's size changes, which wraps them again too.
        const composer = page.getByRole("textbox", { name: channel });

        const sized = async () =>
          await page.evaluate(() => getComputedStyle(document.body).fontSize);

        await composer.fill("/set ui.size 20");
        await composer.press("Enter");
        await expect.poll(sized).toBe("20px");
        await painted();
        const readingLarger = await standing();

        await composer.fill("/set ui.size 14");
        await composer.press("Enter");
        await expect.poll(sized).toBe("14px");
        await painted();
        const readingSized = await standing();

        // Back to the latest, where the widths below expect it.
        await page.mouse.wheel(0, 100_000);
        await expect.poll(fromEnd).toBeLessThanOrEqual(1);

        /**
         * Whether the view stood as it did: the same row first in view, as far below the top,
         * within a pixel.
         * @param now - Where it stands now.
         * @returns Whether it did.
         */
        const held = (now: Awaited<ReturnType<typeof standing>>) =>
          now.row !== undefined &&
          now.row === reading.row &&
          Math.abs((now.offset ?? Number.NaN) - (reading.offset ?? Number.NaN)) <= 1;

        await page.locator("[data-pane] header bdi[title^='+f']").waitFor();
        const modesPast = [await hostileModes(1280), await hostileModes(560)];

        await page.setViewportSize({ height: 800, width: 1280 });

        const drawn: Record<number, { layout: string; sideways: number }> = {};

        for (const width of [1280, 900, 700, 520, 390, 320, 240]) {
          // oxlint-disable-next-line no-await-in-loop -- one width after another
          drawn[width] = await drawnAt(width);
        }

        expect({
          latest: [latestNarrow, latestAfter, latestBack].map((one) => one <= 1),
          modesPast,
          narrow: drawn[390]?.layout,
          problems,
          reading: [readingNarrow, readingBack, readingLarger, readingSized].map(held),
          sideways: Object.entries(drawn).filter(([, one]) => one.sideways > 0),
          wide: drawn[1280]?.layout,
        }).toStrictEqual({
          latest: [true, true, true],
          modesPast: [0, 0],
          narrow: "block",
          problems: [],
          reading: [true, true, true, true],
          sideways: [],
          wide: "grid",
        });
      } finally {
        visitor.close();
        peer.close();
        child.kill("SIGTERM");
        await child.exited;
        await ngircd.stop();
      }
    }
  );

  it(
    "takes what is typed anywhere into the composer, and lets a notice go when it stops being true",
    { timeout: 90_000 },
    async () => {
      const { base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "typing"),
        "#iirc-typing"
      );

      try {
        const { page, problems } = await watchedPage(browser);

        await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: new URL(base).origin,
        });
        await page.setViewportSize({ height: 800, width: 1280 });
        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await networkRow(page);

        const composer = page.getByRole("textbox", { name: channel });
        const log = page.getByRole("log", { name: channel });
        const palette = page.getByRole("dialog", { name: "Command palette" });

        const hasFocus = async () =>
          await composer.evaluate((element) => element === document.activeElement);

        const caret = async () =>
          await composer.evaluate((element: HTMLTextAreaElement) => [
            element.selectionStart,
            element.selectionEnd,
            element.value.length,
          ]);

        // A Timeline chosen in the sidebar, then typing: the first character is not lost, and
        // the tree's typeahead does not take the focus to a row.
        await page.getByRole("row", { name: channel }).click();
        await log.waitFor();
        await page.getByRole("row", { name: channel }).focus();
        await page.keyboard.type("hello");
        const fromSidebar = [await composer.inputValue(), await hasFocus()];

        // A Pane's Timeline clicked, then typing: the caret goes to the end of the draft.
        await log.click();
        await page.keyboard.type("!?");
        const fromPane = [await composer.inputValue(), await hasFocus(), await caret()];

        // Space and Enter are not typing: Space on a row opens it, and the draft is as it was.
        await page.getByRole("row", { name: channel }).focus();
        await page.keyboard.press("Space");
        const afterSpace = await composer.inputValue();

        // A key the keymap binds is the keymap's: Alt+M shows the members, nothing is typed.
        await log.click();
        await page.keyboard.press("Alt+m");
        const members = page.getByRole("region", { name: "members" });

        await members.getByRole("row", { name: "peer" }).waitFor();
        const afterBound = await composer.inputValue();

        // From the members' list, the composer wins over its typeahead.
        await members.getByRole("row", { name: "peer" }).focus();
        await page.keyboard.type("p");
        const fromMembers = [await composer.inputValue(), await hasFocus()];

        // With the palette open, a key stays with the palette's search field.
        await page.keyboard.press("Control+k");
        await palette.waitFor();
        await page.keyboard.type("set");
        const typedInPalette = await composer.inputValue();

        // Escape clears the search field first, and closes the palette second.
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        await palette.waitFor({ state: "detached" });

        // A paste by the platform's chord from outside the composer lands in it.
        await page.evaluate(async () => {
          await navigator.clipboard.writeText(" pasted");
        });
        await log.click();
        await page.keyboard.press("Control+v");
        await expect.poll(async () => await composer.inputValue()).toBe("hello!?p pasted");
        const fromPaste = [await composer.inputValue(), await hasFocus()];

        // A complaint about the text goes when the text is edited, and a button dismisses it.
        await composer.fill("/d");
        await composer.press("Enter");
        const complaint = page.getByRole("alert").filter({ hasText: "There is no command /d" });

        await complaint.waitFor();
        await composer.press("End");
        await page.keyboard.type("x");
        await complaint.waitFor({ state: "detached" });

        await composer.press("Enter");
        await complaint.waitFor();
        await complaint.getByRole("button", { name: "Dismiss" }).click();
        await complaint.waitFor({ state: "detached" });

        expect({
          afterBound,
          afterSpace,
          fromMembers,
          fromPane,
          fromPaste,
          fromSidebar,
          problems: problems.filter((problem) => !problem.includes("401")),
          typedInPalette,
        }).toStrictEqual({
          afterBound: "hello!?",
          afterSpace: "hello!?",
          fromMembers: ["hello!?p", true],
          fromPane: ["hello!?", true, [7, 7, 7]],
          fromPaste: ["hello!?p pasted", true],
          fromSidebar: ["hello", true],
          problems: [],
          typedInPalette: "hello!?p",
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
