/// <reference lib="dom" />
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  connectPeer,
  freePort,
  holdsBytes,
  loopback,
  loseBytes,
  seedUpload,
  startErgo,
  startMinio,
  startNgircd,
} from "@iirc/daemon/testing";
import type { Ircd, Minio, Peer } from "@iirc/daemon/testing";
import { Schema } from "effect";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  networkRow,
  run,
  screenshot,
  solidPng,
  startDaemon as startWith,
  watchedPage,
} from "./daemon.ts";
import { privateNetwork as sharedNetwork } from "./testing/network.ts";
import type { Preparing } from "./testing/network.ts";

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

/**
 * A private ngircd, a real `iirc daemon --web` from source with a key, and a Network joined
 * there, as `privateNetwork` makes.
 * @param dataDir - The Daemon's data directory.
 * @param channel - The Channel.
 * @param preparing - What the peer does first, and the Channel's key.
 * @returns Everything, for the test to stop.
 */
const privateNetwork = async (dataDir: string, channel: string, preparing: Preparing = {}) =>
  await sharedNetwork(source, [`--web=${web}`], dataDir, channel, preparing);

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

/** A Channel's head as the Daemon answers it, whatever it holds, to answer it changed. */
/** What the end-to-end run reads of an Upload. */
const UploadRead = Schema.Struct({
  deleted: Schema.optionalKey(Schema.Struct({ why: Schema.String })),
  hash: Schema.String,
  id: Schema.String,
  link: Schema.NullOr(Schema.String),
  missing: Schema.optionalKey(Schema.Boolean),
  safeName: Schema.String,
});

const decodeUpload = Schema.decodeUnknownSync(Schema.fromJsonString(UploadRead));

/** What the end-to-end run reads of a page of Uploads. */
const decodeUploads = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ uploads: Schema.Array(UploadRead) }))
);

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

/** The Networks removed with their Timelines kept, as the Daemon lists them. */
const decodeListed = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ _tag: Schema.String, network: Schema.String }))
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
          dark: Schema.String,
          light: Schema.String,
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
 * with Alt+N while the focus is in it, which sends the focus to the composer, reloads, which
 * keeps it hidden, and shows it again from the button beside the composer.
 * @param page - The page, on a wide screen, with the sidebar shown at its first width.
 * @returns Its width before and after, the width kept, whether the composer took the focus,
 * and how many sidebars the reload drew.
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

  // Hidden while the focus is in it, the focus goes to the composer, not nowhere.
  await sidebar.getByRole("row").first().focus();
  await page.keyboard.press("Alt+N");
  await sidebar.waitFor({ state: "detached" });

  const focusAfter = await page.evaluate(() => {
    const focused = document.activeElement;

    return focused instanceof HTMLElement && focused.dataset.composer !== undefined;
  });

  await page.reload();
  const show = page.getByRole("button", { name: /^Show the sidebar/u });

  await show.waitFor();
  const hiddenKept = await sidebar.count();

  await show.click();
  await sidebar.waitFor();

  return { focusAfter, hiddenKept, narrow, wide: await sidebarWidth(), widthKept };
};

/**
 * Waits until every font is loaded and the page has drawn twice since.
 * @param page - The page.
 */
const settled = async (page: Page) => {
  await page.evaluate(async () => {
    await document.fonts.ready;

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
 * How far anything in an element reaches past its right edge.
 * @param locator - The element.
 * @returns The distance in whole pixels, 0 when nothing does.
 */
const pastOf = async (locator: ReturnType<Page["getByRole"]>) =>
  await locator.evaluate((element) => {
    const { right } = element.getBoundingClientRect();

    return Math.max(
      0,
      ...[...element.querySelectorAll("*")].map((one) =>
        Math.round(one.getBoundingClientRect().right - right)
      )
    );
  });

/**
 * How a Timeline's rows lie, in the columns every row shares: how many places their times
 * end and their texts start, whose nicks are cut, and how many rows are taller than a line
 * or reach past the log.
 * @param log - The Timeline's log.
 * @returns What it drew.
 */
const timelineDrawn = async (log: ReturnType<Page["getByRole"]>) =>
  await log.evaluate((element) => {
    const { right } = element.getBoundingClientRect();

    // A time column cell is the `time` that carries a sample; the day-change line's `time` does not.
    const rows = [...element.querySelectorAll("time[data-sample]")].flatMap((time) => {
      const row = time.parentElement;

      if (row === null) {
        return [];
      }

      const [, sender, text] = row.children;
      const glyphs = document.createRange();

      glyphs.selectNodeContents(time);

      const cut =
        sender !== undefined &&
        [sender, ...sender.querySelectorAll("*")].some((one) => one.scrollWidth > one.clientWidth);

      const reach = [...row.querySelectorAll("*")].map((one) => one.getBoundingClientRect().right);

      return [
        {
          cut: cut ? (sender.querySelector("bdi")?.textContent ?? "") : undefined,
          lines:
            row.getBoundingClientRect().height /
            Number(getComputedStyle(row).lineHeight.replace(/px$/u, "")),
          past: Math.max(...reach) - right,
          textStart: Math.round(text?.getBoundingClientRect().left ?? 0),
          timeEnd: Math.round(glyphs.getBoundingClientRect().right),
        },
      ];
    });

    return {
      clipped: rows.flatMap((row) => (row.cut === undefined ? [] : [row.cut])).toSorted(),
      past: rows.filter((row) => row.past > 0.5).length,
      rows: rows.length,
      taller: rows.filter((row) => row.lines > 1.01).length,
      textStarts: new Set(rows.map((row) => row.textStart)).size,
      timeEnds: new Set(rows.map((row) => row.timeEnd)).size,
    };
  });

/**
 * Each form of `ui.time`, with how the web frontend's clock draws a time of day in it, a copy
 * here as the spec the clock is held to, and the text of any one such time.
 */
const clockForms = [
  {
    options: { hour: "2-digit", hourCycle: "h23", minute: "2-digit" },
    text: /^\d{2}:\d{2}$/u,
    time: "HH:mm",
  },
  {
    options: { hour: "2-digit", hourCycle: "h23", minute: "2-digit", second: "2-digit" },
    text: /^\d{2}:\d{2}:\d{2}$/u,
    time: "HH:mm:ss",
  },
  {
    options: { hour: "numeric", hourCycle: "h12", minute: "2-digit" },
    text: /^\d{1,2}:\d{2}[^\d:]+$/u,
    time: "h:mm a",
  },
  {
    options: { hour: "numeric", hourCycle: "h12", minute: "2-digit", second: "2-digit" },
    text: /^\d{1,2}:\d{2}:\d{2}[^\d:]+$/u,
    time: "h:mm:ss a",
  },
] as const satisfies readonly {
  readonly options: Intl.DateTimeFormatOptions;
  readonly text: RegExp;
  readonly time: string;
}[];

/**
 * How far a Timeline's time column is from as wide as it needs and no wider: its width less
 * the widest time of the form, at any hour of the day, drawn in the same font in an element
 * like a time. Zero when it is exactly as wide, within half a pixel.
 * @param log - The Timeline's log.
 * @param options - The form's Intl options.
 * @returns The difference, in pixels, and the two widths.
 */
const timeColumnDrawn = async (
  log: ReturnType<Page["getByRole"]>,
  options: Intl.DateTimeFormatOptions
) =>
  await log.evaluate((element, formOptions) => {
    const time = element.querySelector("time[data-sample]");
    const parent = time?.parentElement;

    if (time === null || parent === null || parent === undefined) {
      throw new Error("no time to measure");
    }

    const format = new Intl.DateTimeFormat(undefined, formOptions);
    const probe = time.cloneNode();

    if (!(probe instanceof HTMLElement)) {
      throw new TypeError("a time is an element");
    }

    // A time's own samples would make the probe as wide as the column, not as wide as its text.
    delete probe.dataset.sample;
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.width = "max-content";
    parent.append(probe);

    const widths = Array.from({ length: 24 }, (_, hour) => {
      probe.textContent = format.format(new Date(2000, 0, 1, hour, 59, 59));

      return probe.getBoundingClientRect().width;
    });

    probe.remove();

    const column = time.getBoundingClientRect().width;
    const widest = Math.max(...widths);

    return { column, difference: Math.abs(column - widest) <= 0.5 ? 0 : column - widest, widest };
  }, options);

/**
 * How the members' rows lie: whose nicks are cut, how many places the nicks start, and how
 * tall each row is.
 * @param members - The members' list.
 * @returns What it drew.
 */
const membersDrawn = async (members: ReturnType<Page["getByRole"]>) =>
  await members.getByRole("row").evaluateAll((rows) => {
    const drawn = rows.map((row) => ({
      cut: [row, ...row.querySelectorAll("*")].some((one) => one.scrollWidth > one.clientWidth),
      height: Math.round(row.getBoundingClientRect().height),
      nick: row.querySelector("bdi")?.textContent ?? "",
      start: Math.round(row.querySelector("bdi")?.getBoundingClientRect().left ?? 0),
    }));

    return {
      clipped: drawn.flatMap((row) => (row.cut ? [row.nick] : [])).toSorted(),
      heights: drawn.map((row) => row.height),
      starts: new Set(drawn.map((row) => row.start)).size,
    };
  });

/**
 * Each of the sidebar's rows' heights.
 * @param sidebar - The sidebar.
 * @returns The heights, in whole pixels.
 */
const rowHeights = async (sidebar: ReturnType<Page["getByRole"]>) =>
  await sidebar
    .getByRole("row")
    .evaluateAll((rows) => rows.map((row) => Math.round(row.getBoundingClientRect().height)));

/**
 * Whether two lengths, in pixels, are the same as drawn.
 * @param one - One.
 * @param other - The other.
 * @returns Whether they are within half a pixel.
 */
const near = (one: number, other: number) => Math.abs(one - other) < 0.5;

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

        // With ui.enter newline on this device, Enter begins a line, a send button shows, and
        // Mod+Enter sends both lines.
        const sendButton = page.getByRole("button", { exact: true, name: "Send" });
        const buttonBefore = await sendButton.count();

        await composer.fill("/set -device ui.enter newline");
        await composer.press("Enter");
        await sendButton.waitFor();
        await composer.fill("one");
        await composer.press("Enter");
        await composer.pressSequentially("two");
        const twoLines = await composer.inputValue();

        await composer.press("ControlOrMeta+Enter");

        const first = await peer.waitFor(
          (line) => line.command === "PRIVMSG" && line.params[1] === "one",
          "the first line"
        );

        const second = await peer.waitFor(
          (line) => line.command === "PRIVMSG" && line.params[1] === "two",
          "the second line"
        );

        // The button sends as Mod+Enter does.
        await composer.fill("pressed");
        await sendButton.click();

        const pressed = await peer.waitFor(
          (line) => line.command === "PRIVMSG" && line.params[1] === "pressed",
          "the line the button sent"
        );

        const violations = await page.evaluate(
          () => document.documentElement.dataset.cspViolations ?? ""
        );

        expect({
          action: action.params,
          buttonBefore,
          cleared,
          delivery,
          direct: direct.params,
          heard: heard.params,
          newline: [twoLines, first.params, second.params, pressed.params],
          problems: problems.filter((problem) => problem.includes("Content Security Policy")),
          recalled,
          rows,
          violations,
        }).toStrictEqual({
          action: [channel, "\u0001ACTION waves\u0001"],
          buttonBefore: 0,
          cleared: "",
          delivery: false,
          direct: ["peer", "hi"],
          heard: [channel, "hello from the web"],
          newline: ["one\ntwo", [channel, "one"], [channel, "two"], [channel, "pressed"]],
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
    "sends /ping and /ctcp from the composer, and shows each request beside its reply and the round trip",
    { timeout: 90_000 },
    async () => {
      const { base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "ctcp"),
        "#iirc-ctcp"
      );

      try {
        const { page, problems } = await watchedPage(browser);

        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await networkRow(page);
        await page.getByRole("row", { name: channel }).click();

        // The peer speaks first, so their Direct Messages exist, where CTCP with them shows.
        peer.send("PRIVMSG iirc :hello");
        const composer = page.getByRole("textbox", { name: channel });

        await composer.fill("/query peer");
        await composer.press("Enter");
        const log = page.getByRole("log", { name: "peer" });
        const direct = page.getByRole("textbox", { name: "peer" });

        await log.getByText("hello", { exact: true }).waitFor();

        // A PING, which the peer answers a moment later with its token.
        await direct.fill("/ping peer");
        await direct.press("Enter");

        const ping = await peer.waitFor(
          (line) =>
            line.command === "PRIVMSG" && line.params[1]?.startsWith("\u0001PING ") === true,
          "the PING"
        );

        const token = (ping.params[1] ?? "").slice(6, -1);

        await Bun.sleep(300);
        peer.send(`NOTICE iirc :\u0001PING ${token}\u0001`);

        const pinged = log.getByText(`You asked peer for PING ${token}`, { exact: true });
        const replied = log.getByText(/^peer replied to PING in \d+\.\d{3} s$/u);

        await pinged.waitFor();
        await replied.waitFor();

        const roundTrip = Number(
          /in (?<s>[\d.]+) s/u.exec((await replied.textContent()) ?? "")?.groups?.s
        );

        // Any other request, whose reply shows as its text.
        await direct.fill("/ctcp peer version");
        await direct.press("Enter");

        const version = await peer.waitFor(
          (line) =>
            line.command === "PRIVMSG" && line.params[1]?.startsWith("\u0001VERSION") === true,
          "the VERSION request"
        );

        peer.send("NOTICE iirc :\u0001VERSION a test peer 1.0\u0001");
        await log.getByText("You asked peer for VERSION", { exact: true }).waitFor();
        await log.getByText("peer replied to VERSION: a test peer 1.0", { exact: true }).waitFor();

        // To a Channel, nothing is sent, and the composer says why.
        await direct.fill(`/ctcp ${channel} VERSION`);
        await direct.press("Enter");
        await page.getByText(/^A CTCP request goes to one nick, never a Channel/u).waitFor();

        const violations = await page.evaluate(
          () => document.documentElement.dataset.cspViolations ?? ""
        );

        expect({
          problems: problems.filter((problem) => problem.includes("Content Security Policy")),
          roundTrip: roundTrip >= 0.3 && roundTrip < 20,
          token: /^\d+-\d+$/u.test(token),
          version: version.params,
          violations,
        }).toStrictEqual({
          problems: [],
          roundTrip: true,
          token: true,
          version: ["peer", "\u0001VERSION\u0001"],
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
    "shows a Channel's modes in its status bar on joining, with no input and never its key, and follows a change",
    { timeout: 90_000 },
    async () => {
      const secret = "hunter2-modes";

      const { base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "modes"),
        "#iirc-modes",
        {
          channelKey: secret,
          // The peer made the Channel, so sets its modes before the Daemon joins.
          prepare: async (made) => {
            made.send(`MODE #iirc-modes +ntlk 10 ${secret}`);
            await made.waitFor(
              (line) => line.command === "MODE" && line.params[0] === "#iirc-modes",
              "the Channel's modes set"
            );
          },
        }
      );

      try {
        const { page, problems } = await watchedPage(browser);

        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await networkRow(page);
        await page.getByRole("row", { name: channel }).click();
        await page.getByRole("log", { name: channel }).waitFor();

        const modes = page.locator("[data-pane] header bdi[title^='+']").first();

        // The letters set, in any order, and each parameter, as the bar says them.
        const shown = async () => {
          const text = await modes.textContent();
          const [letters = "", ...params] = (text ?? "").split(" ");

          return [letters.split("").toSorted().join(""), ...params];
        };

        await expect.poll(shown, { timeout: 20_000 }).toStrictEqual(["+klnt", "10"]);

        const first = await modes.getAttribute("title");

        // Another User changes them, and the bar follows.
        peer.send(`MODE ${channel} +m-l`);
        await expect.poll(shown, { timeout: 20_000 }).toStrictEqual(["+kmnt"]);
        const html = await page.content();

        expect({
          first: first?.includes(secret),
          html: html.includes(secret),
          problems: problems.filter((problem) => problem.includes(secret)),
          react: await page.evaluate(heldByReact, secret),
        }).toStrictEqual({ first: false, html: false, problems: [], react: false });
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

        // A change of the line height that leaves a row's estimate as it was still lays the
        // list out again: each row's wrapper is as tall as the row it holds, to the pixel, so
        // none is clipped or left with a gap under it.
        const rowsStale = async () =>
          await members.getByRole("row").evaluateAll((rows) =>
            rows.flatMap((row) => {
              const wrapper = row.parentElement?.getBoundingClientRect().height ?? 0;
              const { height } = row.getBoundingClientRect();

              return Math.abs(wrapper - height) >= 0.5 ? [{ row: height, wrapper }] : [];
            })
          );

        const lineHeightIs = async (expected: string) =>
          await page
            .evaluate(() => getComputedStyle(document.body).lineHeight)
            .then((now) => now === expected);

        const stale: { row: number; wrapper: number }[][] = [];

        // The list held at one size, as a sheet of a fixed height is, so nothing but the rows
        // themselves can lay it out again.
        await members.evaluate((list) => {
          const { height, width } = list.getBoundingClientRect();

          Object.assign(list.style, { flex: "none", height: `${height}px`, width: `${width}px` });
        });

        for (const [leading, expected] of [
          ["1.43", "20.02px"],
          ["1.5", "21px"],
          ["1.45", "20.3px"],
        ] as const) {
          // oxlint-disable-next-line no-await-in-loop -- one change after another
          await composer.fill(`/set ui.leading ${leading}`);
          // oxlint-disable-next-line no-await-in-loop -- one change after another
          await composer.press("Enter");
          // oxlint-disable-next-line no-await-in-loop -- one change after another
          await expect.poll(async () => await lineHeightIs(expected)).toBe(true);
          // oxlint-disable-next-line no-await-in-loop -- one change after another
          await page.evaluate(async () => {
            const { promise, resolve } = Promise.withResolvers<undefined>();

            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                resolve(undefined);
              });
            });
            await promise;
          });
          // oxlint-disable-next-line no-await-in-loop -- one change after another
          stale.push(await rowsStale());
        }

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
          stale,
          symbol,
          topic,
          violations,
        }).toStrictEqual({
          completed: "peer: ",
          menu: { focused: true, height: true, items: 3 },
          problems: [],
          stale: [[], [], []],
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
    "removes a Network after asking, keeps its Timelines to read apart from the rest, then drops them",
    { timeout: 90_000 },
    async () => {
      const dataDir = path.join(directory, "remove");
      const ngircd: Ircd = await startNgircd();
      const created = await iirc("key", "create", "browser", "--data-dir", dataDir);
      const key = created.stdout.trim();
      const { base, child } = await startDaemon(dataDir);
      const peer = await connectPeer({ host: ngircd.host, nick: "peer", port: ngircd.plainPort });

      const removedNetworks = async () => {
        const answer = await fetch(`${base}/api/networks`, {
          headers: { authorization: `Bearer ${key}` },
        });

        return decodeListed(await answer.text())
          .filter((entry) => entry._tag === "Kept")
          .map(({ network }) => ({ network }));
      };

      try {
        peer.send("JOIN #iirc");
        await peer.waitFor((line) => line.command === "JOIN", "the peer's own JOIN");

        const { page, problems } = await watchedPage(browser);

        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.getByText("No Networks are configured yet.").waitFor();

        const nowhere = page.getByRole("textbox", { name: "iirc" });

        await nowhere.fill(`/network add test ${ngircd.host}/${ngircd.plainPort} plain iirc`);
        await nowhere.press("Enter");
        await page.getByRole("row", { name: /^test, .*connected$/u }).waitFor({ timeout: 20_000 });
        await page.getByRole("row", { name: /^test, /u }).click();
        await page.getByRole("textbox", { name: "test" }).fill("/join #iirc");
        await page.getByRole("textbox", { name: "test" }).press("Enter");
        await peer.waitFor(
          (line) => line.command === "JOIN" && line.source?.startsWith("iirc!") === true,
          "Self's JOIN"
        );
        peer.send("PRIVMSG #iirc :said before the removal");
        await page.getByRole("row", { name: /^#iirc/u }).click();
        await page.getByText("said before the removal").waitFor();

        // The options ask first, keeping the Timelines unless the Owner says otherwise.
        await page.getByRole("button", { exact: true, name: "Options" }).click();
        await page.getByRole("button", { name: "Remove test…" }).click();
        const question = page.getByRole("alertdialog");

        await question.getByRole("heading", { name: "Remove test?" }).waitFor();

        const keepChecked = await question
          .getByRole("radio", { name: "Keep its Timelines, to read and search" })
          .isChecked();

        await question.getByRole("button", { name: "Remove" }).click();
        const quit = await peer.waitFor((line) => line.command === "QUIT", "Self's QUIT");

        // Apart from the rest, read, and never said to.
        await page.getByRole("row", { name: /^test, .*removed$/u }).waitFor();
        await page.getByRole("row", { name: /^#iirc/u }).click();
        await page.getByText("said before the removal").waitFor();
        const note = await page.getByRole("note").textContent();

        const kept = await removedNetworks();

        const composer = page.getByRole("textbox", { name: "#iirc" });

        await composer.fill("still here?");
        await composer.press("Enter");
        await page
          .getByText(/test was removed, and its Timelines are kept only to read/u)
          .waitFor();

        // A new Network cannot take the name while they are kept.
        await composer.fill(`/network add test ${ngircd.host}/${ngircd.plainPort} plain iirc`);
        await composer.press("Enter");
        await page.getByText(/so no Network can take its name until they are dropped/u).waitFor();

        // The Pane's own button asks again, which drops them and frees the name.
        await page.getByRole("note").getByRole("button", { name: "Drop them…" }).click();
        await question.getByRole("heading", { name: "Drop test's Timelines?" }).waitFor();
        await question.getByRole("button", { name: "Drop them" }).click();
        await page.getByText("No Networks are configured yet.").waitFor();
        const dropped = await removedNetworks();

        await nowhere.fill(`/network add test ${ngircd.host}/${ngircd.plainPort} plain iirc`);
        await nowhere.press("Enter");
        await page.getByRole("row", { name: /^test, /u }).waitFor({ timeout: 20_000 });

        const violations = await page.evaluate(
          () => document.documentElement.dataset.cspViolations ?? ""
        );

        expect({
          dropped,
          keepChecked,
          kept,
          note,
          problems: problems.filter((problem) => problem.includes("Content Security Policy")),
          quit: quit.source?.startsWith("iirc!"),
          violations,
        }).toStrictEqual({
          dropped: [],
          keepChecked: true,
          kept: [{ network: "test" }],
          note: "test was removed. Its Timelines are kept to read and search, and nothing can be said here.Drop them…",
          problems: [],
          quit: true,
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
          resized: { focusAfter: true, hiddenKept: 0, narrow: 200, wide: 300, widthKept: "300" },
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
          shared: {
            activity: "all",
            dark: "dark",
            light: "light",
            theme: "dark",
            time: "HH:mm:ss",
          },
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
    "draws system as the theme chosen for dark or for light, and follows the device the moment it changes",
    { timeout: 60_000 },
    async () => {
      const { api, base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "schemes"),
        "#iirc-schemes"
      );

      try {
        const { page, problems } = await watchedPage(browser);

        await page.emulateMedia({ colorScheme: "dark" });
        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.getByRole("row", { name: channel }).click();

        const composer = page.getByRole("textbox", { name: channel });

        const type = async (text: string) => {
          await composer.fill(text);
          await composer.press("Enter");
        };

        const drawn = async () =>
          await page.evaluate(() => [
            document.documentElement.dataset.theme,
            document.documentElement.style.getPropertyValue("--color-background"),
            getComputedStyle(document.body).backgroundColor,
          ]);

        // The device's change is followed at once, with no read of the options in between.
        const followed = { timeout: 1000 };

        const before = await drawn();

        await type("/theme -dark nord");
        await expect.poll(drawn).toStrictEqual(["system", "#2e3440", "rgb(46, 52, 64)"]);

        await page.emulateMedia({ colorScheme: "light" });
        await expect
          .poll(drawn, followed)
          .toStrictEqual(["system", "#f6f5f1", "rgb(246, 245, 241)"]);

        await type("/theme -light solarized-light");
        await expect.poll(drawn).toStrictEqual(["system", "#fdf6e3", "rgb(253, 246, 227)"]);

        await page.emulateMedia({ colorScheme: "dark" });
        await expect.poll(drawn, followed).toStrictEqual(["system", "#2e3440", "rgb(46, 52, 64)"]);

        // A theme named wins over both, whatever the device prefers.
        await type("/theme dracula");
        await expect.poll(drawn).toStrictEqual(["dracula", "#282a36", "rgb(40, 42, 54)"]);
        await page.emulateMedia({ colorScheme: "light" });

        // A change of the device's setting is told in a frame's rendering, so two frames on it
        // has been told.
        await page.evaluate(async () => {
          const { promise, resolve } = Promise.withResolvers<number>();

          requestAnimationFrame(() => requestAnimationFrame(resolve));
          await promise;
        });
        const named = await drawn();

        const answered = await api("GET", "/ui");
        const shared = decodeUi(await answered.text());

        expect({
          before,
          named,
          problems: problems.filter((problem) => problem.includes("Content Security Policy")),
          shared: [shared.theme, shared.light, shared.dark],
          violations: await page.evaluate(
            () => document.documentElement.dataset.cspViolations ?? ""
          ),
        }).toStrictEqual({
          before: ["system", "#111314", "rgb(17, 19, 20)"],
          named: ["dracula", "#282a36", "rgb(40, 42, 54)"],
          problems: [],
          shared: ["dracula", "solarized-light", "nord"],
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
    "fetches no font with the device's own, either kind, sets the text's size and a bundled font at once, fetches only the ones chosen, and serves their files from the page's origin, under the policy",
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

        // Both answers are in, in whichever order they came.
        await expect.poll(() => fonts.length).toBe(2);

        // The device's own sans font is drawn in its stack's first family, and fetches nothing.
        await type("/set ui.font system-sans");
        await expect.poll(drawn).toStrictEqual(["18px", "system-ui"]);
        await page.evaluate(async () => {
          await document.fonts.ready;
        });

        const afterSystemSans = fonts.length;

        // A bundled sans font fetches its own Latin regular and italic, and no other.
        await type("/set ui.font inter");
        await expect.poll(drawn).toStrictEqual(["18px", '"Inter Variable"']);
        await expect.poll(() => fonts.length).toBe(4);

        // Back to the first, which is already fetched, for the rest.
        await type("/set ui.font jetbrains-mono");
        await expect.poll(drawn).toStrictEqual(["18px", '"JetBrains Mono Variable"']);

        const violations = await page.evaluate(
          () => document.documentElement.dataset.cspViolations ?? ""
        );

        const { origin } = new URL(base);

        // The options at the largest text, in a Pane too narrow for their four columns on a
        // screen that is not compact: nothing reaches past the Pane.
        await page.setViewportSize({ height: 800, width: 700 });
        await type("/set ui.size 24");
        await expect.poll(drawn).toStrictEqual(["24px", '"JetBrains Mono Variable"']);
        await page.keyboard.press("Control+,");

        await page.getByRole("searchbox", { name: "Filter options" }).waitFor();

        // How far anything drawn in the Pane reaches past its right edge, in whole pixels.
        const optionsPast = await page
          .locator("[data-pane]")
          .first()
          .evaluate((pane) => {
            const { right } = pane.getBoundingClientRect();
            let past = 0;

            for (const one of pane.querySelectorAll("*")) {
              past = Math.max(past, Math.round(one.getBoundingClientRect().right - right));
            }

            return past;
          });

        expect({
          afterSystemSans,
          byDefault,
          fetched: fonts
            .map((font) => ({
              cache: font.cache,
              own: new URL(font.url).origin === origin,
              path: new URL(font.url).pathname.replace(/-[\w-]{8}\.woff2$/u, ".woff2"),
              type: font.type,
            }))
            .toSorted((left, right) => (left.path < right.path ? -1 : 1)),
          optionsPast,
          problems: problems.filter((problem) => !problem.includes("401")),
          violations,
        }).toStrictEqual({
          afterSystemSans: 2,
          byDefault: { drawn: ["14px", "ui-monospace"], fetched: 0 },
          fetched: [
            {
              cache: "public, max-age=31536000, immutable",
              own: true,
              path: "/assets/inter-latin-wght-italic.woff2",
              type: "font/woff2",
            },
            {
              cache: "public, max-age=31536000, immutable",
              own: true,
              path: "/assets/inter-latin-wght-normal.woff2",
              type: "font/woff2",
            },
            {
              cache: "public, max-age=31536000, immutable",
              own: true,
              path: "/assets/jetbrains-mono-latin-wght-italic.woff2",
              type: "font/woff2",
            },
            {
              cache: "public, max-age=31536000, immutable",
              own: true,
              path: "/assets/jetbrains-mono-latin-wght-normal.woff2",
              type: "font/woff2",
            },
          ],
          optionsPast: 0,
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
    "draws in a family the device has, named in a command or the options, on this device alone, falls back to the default font for one it lacks, and says in the options that it was not found",
    { timeout: 60_000 },
    async () => {
      const { base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "family"),
        "#iirc-family"
      );

      // A family this machine's browser has, as fontconfig lists it, and one no device has.
      const present = "Noto Serif";
      const absent = "No Such Font Here";

      try {
        const { page, problems } = await watchedPage(browser);

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

        const sample = "mmmmmmmmmm lllll WWWWW 00000";

        peer.send(`PRIVMSG ${channel} :${sample}`);
        await log.getByText(sample).waitFor();

        // The fonts the root draws text in, and how wide the sample is drawn.
        const drawn = async () =>
          await page.evaluate(async (text) => {
            await document.fonts.ready;
            const root = document.documentElement.style;

            const shown = [...document.querySelectorAll("[role=log] *")].find(
              (one) => one.textContent === text
            );

            return {
              font: root.getPropertyValue("--font-text"),
              width: Math.round(shown?.getBoundingClientRect().width ?? 0),
            };
          }, sample);

        const byDefault = await drawn();

        const fontDrawn = async () => {
          const { font } = await drawn();

          return font;
        };

        const sharedFont = async () => {
          const answered = await fetch(`${base}/api/ui`, {
            headers: { authorization: `Bearer ${key}` },
          });

          const text = await answered.text();

          return text.includes('"font":"system"');
        };

        // A family typed in place on a device that overrides nothing is this device's, and
        // never every device's.
        await page.keyboard.press("Control+,");
        await page.getByRole("searchbox", { name: "Filter options" }).fill("ui.font");
        const fresh = page.getByRole("row", { name: "ui.font" });

        await fresh.focus();
        await page.keyboard.press("Enter");
        const typed = page.getByRole("textbox", { name: "Value of ui.font" });

        await typed.fill(absent);
        await typed.press("Enter");
        await fresh.getByText("not found on this device").first().waitFor();

        const freshly = {
          kept: await page.evaluate(() => localStorage.getItem("iirc.ui")),
          shared: await sharedFont(),
        };

        await page.getByRole("row", { name: channel }).click();

        await expect.poll(fontDrawn).toContain(absent);
        const lacked = await drawn();

        await type(`/set -device ui.font ${present}`);
        await expect.poll(fontDrawn).toContain(present);
        const had = await drawn();

        await type(`/set -device ui.font ${absent}`);
        await expect.poll(fontDrawn).toContain(absent);

        // The options say the family in effect here was not found, beside every device's.
        await page.keyboard.press("Control+,");
        await page.getByRole("searchbox", { name: "Filter options" }).fill("ui.font");
        const row = page.getByRole("row", { name: "ui.font" });

        await row.getByText("not found on this device").first().waitFor();
        const missingRow = await row.textContent();

        // A family typed in place, where this device overrides it, is this device's too, and found.
        await row.focus();
        await page.keyboard.press("Enter");
        const editor = page.getByRole("textbox", { name: "Value of ui.font" });

        await editor.fill(present);
        await editor.press("Enter");
        await row.getByText(present, { exact: true }).first().waitFor();
        const foundRow = await row.textContent();

        const shared = await sharedFont();

        expect({
          fresh: freshly,
          had: had.width === byDefault.width,
          kept: await page.evaluate(() => localStorage.getItem("iirc.ui")),
          lacked: lacked.width === byDefault.width,
          lackedFont: lacked.font,
          problems: problems.filter((problem) => !problem.includes("401")),
          rows: [missingRow, foundRow].map((text) => text?.includes("not found")),
          shared,
        }).toStrictEqual({
          fresh: { kept: JSON.stringify({ font: absent }), shared: true },
          had: false,
          kept: JSON.stringify({ font: present }),
          lacked: true,
          lackedFont: `"${absent}", var(--font-device)`,
          problems: [],
          rows: [true, false],
          shared: true,
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
    "lines up and clips no more in a sans font than in monospace did: the times, in each form and no wider than it needs, the nicks, a refusal, the members, the composer's prompt, the sidebar, and a Lookup's card, at two sizes and on a phone",
    { timeout: 420_000 },
    async () => {
      // Ergo, whose nicks run to 32 characters, past RFC 2812's nine.
      const { base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "pitch"),
        "#iirc-pitch",
        { start: startErgo }
      );

      // The widest nick monospace showed whole in a Timeline's column, in a wide letter and a
      // narrow one; the widest its members' column showed whole at the largest size; a short
      // one; and one past every column.
      const widest = "WWWWWWWWWWWWWW";
      const nicks = [widest, "mmmmmmmmmmmmmm", "WWWWWWWWWWWWWWW", "ab", "WWWWWWWWWWWWWWWWWWWW"];
      const others: Peer[] = [];

      try {
        for (const nick of nicks) {
          // oxlint-disable-next-line no-await-in-loop -- one User after another, in order
          const other = await connectPeer({ host: ngircd.host, nick, port: ngircd.plainPort });

          others.push(other);
          other.send(`JOIN ${channel}`);
          other.send(`PRIVMSG ${channel} :hello from ${nick.length}`);
          // oxlint-disable-next-line no-await-in-loop -- one User after another, in order
          await peer.waitFor(
            (line) => line.command === "JOIN" && line.source?.startsWith(`${nick}!`) === true,
            `${nick} to join`
          );
        }

        // Voiced, so the members show a symbol of each kind: an operator's, a voice's, and none.
        peer.send(`MODE ${channel} +v ab`);

        const { page, problems } = await watchedPage(browser);
        const wide = { height: 1000, width: 1920 };

        await page.setViewportSize(wide);
        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await networkRow(page);
        await page.getByRole("row", { name: channel }).click();

        const log = page.getByRole("log", { name: channel });
        const members = page.getByRole("region", { name: "members" });
        const sidebar = page.getByRole("navigation", { name: "Networks" });
        const composer = page.getByRole("textbox", { name: channel });

        const type = async (text: string) => {
          await composer.fill(text);
          await composer.press("Enter");
        };

        await log.getByText("hello from 20").waitFor();

        // Without the operator rank, the Ircd refuses a kick: a row in italic, in the columns.
        await type("/kick ab");
        await log.getByText(/was refused \(482\)$/u).waitFor();

        await composer.click();
        await page.keyboard.press("Alt+m");
        await members.getByRole("row", { name: "ab, voice" }).waitFor();

        // The composer's prompt for a Direct Message not yet begun with the widest nick, on a
        // wide screen and on a phone, and there with the send button too: cut or not, how tall
        // its line is, how far anything reaches past it, and whether the field beside it still
        // has room for eight of its own "0". Then back to the Channel.
        const prompt = async () => {
          await type(`/query ${widest}`);

          const textbox = page.getByRole("textbox", { name: widest });

          await textbox.waitFor();

          const id = (await textbox.getAttribute("id")) ?? "";
          const label = page.locator(`label[for="${id}"]`);

          const drawn = async () => {
            await settled(page);

            return await label.evaluate((element) => {
              const line = element.parentElement;
              const { right } = line?.getBoundingClientRect() ?? { right: 0 };

              const field = line?.querySelector("textarea") ?? undefined;
              const zeros = document.createElement("span");

              if (field !== undefined) {
                const { fontFamily, fontSize, fontWeight } = getComputedStyle(field);

                Object.assign(zeros.style, {
                  fontFamily,
                  fontSize,
                  fontWeight,
                  position: "absolute",
                });
              }

              zeros.textContent = "0".repeat(8);
              document.body.append(zeros);

              const room = zeros.getBoundingClientRect().width;

              zeros.remove();

              return {
                clipped: [element, ...element.querySelectorAll("*")].some(
                  (one) => one.scrollWidth > one.clientWidth
                ),
                height: Math.round(line?.getBoundingClientRect().height ?? 0),
                past: Math.max(
                  0,
                  ...[...(line?.querySelectorAll("*") ?? [])].map((one) =>
                    Math.round(one.getBoundingClientRect().right - right)
                  )
                ),
                roomy: Math.round(field?.getBoundingClientRect().width ?? 0) >= Math.round(room),
              };
            });
          };

          const onWide = await drawn();

          await page.setViewportSize({ height: 800, width: 360 });

          const onPhone = await drawn();

          // Under ui.enter newline, the send button stands beside the others.
          const send = page.getByRole("button", { exact: true, name: "Send" });

          await textbox.fill("/set -device ui.enter newline");
          await textbox.press("Enter");
          await send.waitFor();

          const sending = await drawn();

          await textbox.fill("/set -device ui.enter send");
          await textbox.press("ControlOrMeta+Enter");
          await send.waitFor({ state: "detached" });
          await page.setViewportSize(wide);
          await page.getByRole("row", { name: channel }).click();
          await composer.waitFor();

          return { onPhone, onWide, sending };
        };

        // How far anything in the widest nick's Lookup reaches past its card, then put away.
        const lookup = async () => {
          await type(`/whois ${widest}`);

          const card = page.getByRole("region", { name: `whois ${widest}` });

          await card.getByRole("list", { name: "Channels" }).waitFor();
          await settled(page);

          const past = await pastOf(card);

          await composer.press("Escape");
          await card.waitFor({ state: "detached" });

          return past;
        };

        const monospace = new Set(["system", "jetbrains-mono"]);

        const fonts = [
          ...monospace,
          "system-sans",
          "ibm-plex-sans",
          "atkinson-hyperlegible-next",
          "source-sans-3",
          "inter",
        ];

        const timelines: (Awaited<ReturnType<typeof timelineDrawn>> & {
          readonly font: string;
          readonly size: number;
          readonly time: string;
          readonly timeColumn: Awaited<ReturnType<typeof timeColumnDrawn>>;
        })[] = [];

        const rest = [];

        for (const size of [14, 24]) {
          // oxlint-disable-next-line no-await-in-loop -- one size after another
          await type(`/set ui.size ${size}`);

          for (const font of fonts) {
            // oxlint-disable-next-line no-await-in-loop -- one font after another
            await type(`/set ui.font ${font}`);
            // oxlint-disable-next-line no-await-in-loop -- one font after another
            await expect
              .poll(
                async () =>
                  await page.evaluate(() =>
                    document.documentElement.style.getPropertyValue("--font-text")
                  )
              )
              .toContain(font.startsWith("system") ? "var(--font-device" : "Variable");

            for (const { options, text, time } of clockForms) {
              // oxlint-disable-next-line no-await-in-loop -- one format after another
              await type(`/set ui.time ${time}`);
              // oxlint-disable-next-line no-await-in-loop -- one format after another
              await expect
                .poll(async () => await log.locator("time[data-sample]").first().textContent())
                .toMatch(text);
              // oxlint-disable-next-line no-await-in-loop -- once it is drawn
              await settled(page);
              // oxlint-disable-next-line no-await-in-loop -- one format after another
              const drawn = await timelineDrawn(log);
              // oxlint-disable-next-line no-await-in-loop -- one format after another
              const timeColumn = await timeColumnDrawn(log, options);

              timelines.push({ font, size, time, timeColumn, ...drawn });
            }

            // oxlint-disable-next-line no-await-in-loop -- one font after another
            const promptDrawn = await prompt();
            // oxlint-disable-next-line no-await-in-loop -- one font after another
            const lookupPast = await lookup();

            rest.push({
              font,
              lookupPast,
              // oxlint-disable-next-line no-await-in-loop -- one font after another
              members: await membersDrawn(members),
              // oxlint-disable-next-line no-await-in-loop -- one font after another
              membersPast: await pastOf(members),
              prompt: promptDrawn,
              // oxlint-disable-next-line no-await-in-loop -- one font after another
              sidebar: await rowHeights(sidebar),
              // oxlint-disable-next-line no-await-in-loop -- one font after another
              sidebarPast: await pastOf(sidebar),
              size,
            });
          }
        }

        // In a Pane split on a narrow desktop screen, some 200px wide at the largest size, the
        // members lie over its Timeline, and stay inside it in either kind of font.
        await page.setViewportSize({ height: 800, width: 660 });
        await page.keyboard.press("Alt+Shift+S");
        await page.getByRole("row", { name: channel }).click();
        await composer.click();
        await page.keyboard.press("Alt+m");

        const floating = page.getByRole("dialog", { name: "Members" });
        const floatingPast = [];

        for (const font of ["inter", "system"]) {
          // oxlint-disable-next-line no-await-in-loop -- one font after another
          await type(`/set ui.font ${font}`);
          // oxlint-disable-next-line no-await-in-loop -- once it is drawn
          await settled(page);

          // oxlint-disable-next-line no-await-in-loop -- one font after another
          const past = await floating.evaluate((panel) => {
            const pane = panel.closest("[data-pane]")?.getBoundingClientRect();
            const box = panel.getBoundingClientRect();

            return {
              left: Math.max(0, Math.round((pane?.left ?? 0) - box.left)),
              pane: Math.round(pane?.width ?? 0) < 600,
              right: Math.max(0, Math.round(box.right - (pane?.right ?? 0))),
            };
          });

          floatingPast.push({ font, ...past });
        }

        // What monospace showed whole it shows still, and every font shows it whole too: the
        // Timeline cuts only nicks past fourteen letters, the members only past fifteen, and the
        // prompt on a wide screen none. On a phone monospace's prompt still holds the widest
        // nick at the smaller size, and at the larger yields to the field, which keeps its
        // room, and no prompt reaches past its line. Every row, the refusal's too, lines up,
        // and is as tall as monospace's at its size.
        const heightsAt = new Map(
          rest.flatMap((one) => (one.font === "system" ? [[one.size, one]] : []))
        );

        expect({
          floatingPast,
          problems: problems.filter((problem) => !problem.includes("401")),
          rest,
          timelines,
        }).toStrictEqual({
          floatingPast: [
            { font: "inter", left: 0, pane: true, right: 0 },
            { font: "system", left: 0, pane: true, right: 0 },
          ],
          problems: [],
          rest: rest.map(({ font, prompt: drawn, size }) => ({
            font,
            lookupPast: 0,
            members: {
              clipped: ["WWWWWWWWWWWWWWWWWWWW"],
              heights: heightsAt.get(size)?.members.heights,
              starts: 1,
            },
            membersPast: 0,
            prompt: {
              onPhone: {
                clipped: monospace.has(font) && size === 14 ? false : drawn.onPhone.clipped,
                height: heightsAt.get(size)?.prompt.onPhone.height,
                past: 0,
                roomy: true,
              },
              onWide: {
                clipped: false,
                height: heightsAt.get(size)?.prompt.onWide.height,
                past: 0,
                roomy: true,
              },
              sending: {
                clipped: monospace.has(font) && size === 14 ? false : drawn.sending.clipped,
                height: heightsAt.get(size)?.prompt.onPhone.height,
                past: 0,
                roomy: true,
              },
            },
            sidebar: heightsAt.get(size)?.sidebar,
            sidebarPast: 0,
            size,
          })),
          // A sans font may show whole the fifteen letters monospace cut, as Source Sans 3's
          // wide "m" leaves room for, and cuts nothing shorter.
          timelines: timelines.map(({ clipped, font, rows, size, time, timeColumn }) => ({
            clipped:
              monospace.has(font) || clipped.length > 1
                ? ["WWWWWWWWWWWWWWW", "WWWWWWWWWWWWWWWWWWWW"]
                : ["WWWWWWWWWWWWWWWWWWWW"],
            font,
            past: 0,
            rows,
            size,
            taller: 0,
            textStarts: 1,
            time,
            timeColumn: { column: timeColumn.column, difference: 0, widest: timeColumn.widest },
            timeEnds: 1,
          })),
        });
        expect(timelines[0]?.rows).toBe(13);
      } finally {
        for (const other of others) {
          other.close();
        }

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

        /**
         * Waits for frames to be drawn after this one.
         * @param count - How many.
         */
        const frames = async (count: number) => {
          await page.evaluate(async (left) => {
            for (let index = 0; index < left; index += 1) {
              const { promise, resolve } = Promise.withResolvers<undefined>();

              requestAnimationFrame(() => {
                resolve(undefined);
              });
              // oxlint-disable-next-line no-await-in-loop -- one frame after another
              await promise;
            }
          }, count);
        };

        /**
         * Where the view stands once it has settled: read on each frame until it holds, for
         * up to five seconds, then read again a few frames later, so a late correction shows.
         * @param holds - Whether it stands as it should.
         * @returns Where it stands then.
         */
        const settledWhere = async (
          holds: (now: Awaited<ReturnType<typeof standing>>) => boolean
        ) => {
          const until = Date.now() + 5000;

          // oxlint-disable-next-line no-await-in-loop -- polled, one frame after another
          while (!holds(await standing()) && Date.now() < until) {
            // oxlint-disable-next-line no-await-in-loop -- polled, one frame after another
            await frames(1);
          }

          await frames(5);

          return await standing();
        };

        /**
         * How the log is laid out, read at once: its width, how a Message's row is laid out,
         * in a row or as a block, and how the log's width says it should be, as a block
         * where it is sixty characters of its text or narrower.
         * @returns How it is.
         */
        const laidOut = async () =>
          await log.evaluate((element) => {
            const probe = document.createElement("div");

            probe.style.width = "60ch";
            element.append(probe);
            const narrowest = probe.getBoundingClientRect().width;

            probe.remove();

            const row = [...element.querySelectorAll("[data-index]")].find((one) =>
              one.textContent?.includes("filler")
            );

            const message = row?.firstElementChild?.firstElementChild;

            return {
              expected: element.clientWidth <= narrowest ? "block" : "grid",
              layout: message instanceof Element ? getComputedStyle(message).display : "",
              width: element.clientWidth,
            };
          });

        /**
         * Resizes the page in one step, and waits for the log to be as wide as it is there,
         * and its rows laid out as that width says.
         * @param width - The page's width.
         */
        const resize = async (width: number) => {
          const before = await laidOut();

          await page.setViewportSize({ height: 800, width });
          await expect
            .poll(async () => {
              const now = await laidOut();

              return now.width !== before.width && now.layout === now.expected;
            })
            .toBe(true);
        };

        /**
         * Whether the view is at the latest, within a pixel.
         * @param now - Where it stands.
         * @returns Whether it is.
         */
        const atLatest = (now: Awaited<ReturnType<typeof standing>>) => now.fromEnd <= 1;

        const box = await log.boundingBox();

        await page.mouse.move((box?.x ?? 0) + 100, (box?.y ?? 0) + 100);

        // At the latest, it stays at the latest as every row wraps again, and follows what is
        // said after.
        await page.mouse.wheel(0, 100_000);
        await expect.poll(fromEnd).toBeLessThanOrEqual(1);

        await resize(560);
        const latestNarrow = await settledWhere(atLatest);

        peer.send(`PRIVMSG ${channel} :said once narrow`);
        await log.getByText("said once narrow").waitFor();
        const latestAfter = await settledWhere(atLatest);

        await resize(1280);
        const latestBack = await settledWhere(atLatest);

        // Reading older, the first row in view stays where it is as every row wraps again,
        // in one step there and back, while the scroll that put it there has only just ended.
        await page.mouse.wheel(0, -1200);
        await expect.poll(fromEnd).toBeGreaterThan(400);
        await frames(5);
        const reading = await standing();

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

        await resize(560);
        const readingNarrow = await settledWhere(held);

        await resize(1280);
        const readingBack = await settledWhere(held);

        // The same as the text's size changes, which wraps them again too.
        const composer = page.getByRole("textbox", { name: channel });

        const sized = async () =>
          await page.evaluate(() => getComputedStyle(document.body).fontSize);

        await composer.fill("/set ui.size 20");
        await composer.press("Enter");
        await expect.poll(sized).toBe("20px");
        const readingLarger = await settledWhere(held);

        await composer.fill("/set ui.size 14");
        await composer.press("Enter");
        await expect.poll(sized).toBe("14px");
        const readingSized = await settledWhere(held);

        // And as the line height changes, which makes every row taller or shorter.
        const lineHeight = async () =>
          await page.evaluate(() => getComputedStyle(document.body).lineHeight);

        await composer.fill("/set ui.leading 2");
        await composer.press("Enter");
        await expect.poll(lineHeight).toBe("28px");
        const readingTaller = await settledWhere(held);

        await composer.fill("/set ui.leading 1.45");
        await composer.press("Enter");
        await expect.poll(lineHeight).toBe("20.3px");
        const readingLeaded = await settledWhere(held);

        // Back to the latest.
        await page.mouse.wheel(0, 100_000);
        await expect.poll(fromEnd).toBeLessThanOrEqual(1);

        // At the latest, it stays at the latest as the line height changes there and back.
        await composer.fill("/set ui.leading 2");
        await composer.press("Enter");
        await expect.poll(lineHeight).toBe("28px");
        const latestTaller = await settledWhere(atLatest);

        await composer.fill("/set ui.leading 1.45");
        await composer.press("Enter");
        await expect.poll(lineHeight).toBe("20.3px");
        const latestLeaded = await settledWhere(atLatest);

        /**
         * Following the latest, the Owner wheels up by 300 pixels as the log's box is made
         * 60 pixels shorter, as a composer that grows a line makes it: the box changes as the
         * wheel's scroll is reported, or as the wheel arrives, before the scroll it makes.
         * Then a Message is said. Where they end, from the end, before and after it, and
         * whether the view drew it.
         * @param when - Which comes first.
         * @param said - What is said after.
         * @returns Where they ended, and whether the Message was drawn.
         */
        const leaveAsReboxed = async (when: "scroll" | "wheel", said: string) => {
          await log.evaluate((element, armed) => {
            const shorter = () => {
              element.style.maxHeight = `${element.clientHeight - 60}px`;
            };

            // Ahead of the view's own listeners: the document's capture runs before the
            // log's, and the window's before React's own.
            if (armed === "scroll") {
              document.addEventListener("scroll", shorter, { capture: true, once: true });
            } else {
              globalThis.addEventListener("wheel", shorter, { capture: true, once: true });
            }
          }, when);
          await page.mouse.wheel(0, -300);
          const left = await settledWhere((now) => now.fromEnd > 1);

          // Away, the view offers the latest; following, it draws the Message.
          const jump = page.getByRole("button", { name: "Jump to latest" });

          peer.send(`PRIVMSG ${channel} :${said}`);
          await jump.or(log.getByText(said)).first().waitFor();
          const after = await settledWhere(() => false);
          const drawn = await log.getByText(said).count();

          // The box as it was, and back to the latest.
          await log.evaluate((element) => {
            element.style.maxHeight = "";
          });

          if ((await jump.count()) > 0) {
            await jump.click();
          }

          await log.getByText(said).waitFor();
          await page.mouse.move((box?.x ?? 0) + 100, (box?.y ?? 0) + 100);
          await page.mouse.wheel(0, 100_000);
          await expect.poll(fromEnd).toBeLessThanOrEqual(1);
          await frames(5);

          return { after: after.fromEnd, drawn, left: left.fromEnd };
        };

        const leftAsScrolled = await leaveAsReboxed("scroll", "said once left by the wheel");
        const leftAsWheeled = await leaveAsReboxed("wheel", "said once left as the box changed");

        await page.locator("[data-pane] header bdi[title^='+f']").waitFor();
        const modesPast = [await hostileModes(1280), await hostileModes(560)];

        await page.setViewportSize({ height: 800, width: 1280 });

        const drawn: Record<number, { layout: string; sideways: number }> = {};

        for (const width of [1280, 900, 700, 520, 390, 320, 240]) {
          // oxlint-disable-next-line no-await-in-loop -- one width after another
          drawn[width] = await drawnAt(width);
        }

        expect({
          latest: [latestNarrow, latestAfter, latestBack, latestTaller, latestLeaded].map(atLatest),
          left: [leftAsScrolled, leftAsWheeled],
          modesPast,
          narrow: drawn[390]?.layout,
          problems,
          reading: [
            readingNarrow,
            readingBack,
            readingLarger,
            readingSized,
            readingTaller,
            readingLeaded,
          ].map(held),
          sideways: Object.entries(drawn).filter(([, one]) => one.sideways > 0),
          wide: drawn[1280]?.layout,
        }).toStrictEqual({
          latest: [true, true, true, true, true],
          // Where they wheeled to from the end, and kept there as a Message is said.
          left: [
            { after: 300, drawn: 0, left: 300 },
            { after: 300, drawn: 0, left: 300 },
          ],
          modesPast: [0, 0],
          narrow: "block",
          problems: [],
          reading: [true, true, true, true, true, true],
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

        // A field inside a shadow root keeps what is typed into it: at the document the key
        // names the root's host, and only its path names the field.
        await page.evaluate(() => {
          const host = document.createElement("div");
          const field = document.createElement("input");

          host.id = "shadowed";
          host.attachShadow({ mode: "open" }).append(field);
          document.body.append(host);
          field.focus();
        });
        await page.keyboard.type("z");

        const inShadow = await page.evaluate(() => {
          const host = document.querySelector("#shadowed");
          const typed = host?.shadowRoot?.querySelector("input")?.value;

          host?.remove();

          return typed;
        });

        const afterShadow = await composer.inputValue();

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
          afterShadow,
          afterSpace,
          fromMembers,
          fromPane,
          fromPaste,
          fromSidebar,
          inShadow,
          problems: problems.filter((problem) => !problem.includes("401")),
          typedInPalette,
        }).toStrictEqual({
          afterBound: "hello!?",
          afterShadow: "hello!?p pasted",
          afterSpace: "hello!?",
          fromMembers: ["hello!?p", true],
          fromPane: ["hello!?", true, [7, 7, 7]],
          fromPaste: ["hello!?p pasted", true],
          fromSidebar: ["hello", true],
          inShadow: "z",
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

  it(
    "wraps what was said at the widest line, in characters of the font at its size, where it started, and as before in a Pane narrower than the bound",
    { timeout: 120_000 },
    async () => {
      const { base, channel, child, key, ngircd, peer } = await privateNetwork(
        path.join(directory, "width"),
        "#iirc-width"
      );

      // Long enough to run the width of a wide Pane more than once.
      const said = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");

      // The same, calling Self by nick, so that it is a Highlight, whose tint runs the row.
      const shouted = `iirc: ${said.replaceAll("word", "call")}`;

      try {
        peer.send(`PRIVMSG ${channel} :${said}`);
        peer.send(`PRIVMSG ${channel} :${shouted}`);

        const { page, problems } = await watchedPage(browser);

        await page.setViewportSize({ height: 900, width: 1600 });
        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await networkRow(page);
        await page.getByRole("row", { name: channel }).click();

        const log = page.getByRole("log", { name: channel });
        const composer = page.getByRole("textbox", { name: channel });
        const sidebar = page.getByRole("navigation", { name: "Networks" });
        // What was said, as a whole: the outermost element holding its words.
        const text = log.locator("bdi", { hasText: "word59" }).first();

        await text.waitFor();

        const set = async (option: string, value: string) => {
          await composer.fill(`/set ui.${option} ${value}`);
          await composer.press("Enter");
          await expect
            .poll(async () => (await composer.inputValue()) === "", { timeout: 5000 })
            .toBe(true);
        };

        /**
         * What was said as drawn: where it starts, how wide and tall it is, how wide a
         * character of its font is at its size, as its own `0`, and whether its row was laid
         * out again to its height. Beside it, how wide the Composer and the Sidebar are, when
         * the Sidebar is drawn.
         * @returns The measures.
         */
        const drawn = async () => {
          await settled(page);

          const measured = await text.evaluate((element) => {
            const probe = document.createElement("span");

            probe.textContent = "0".repeat(100);
            Object.assign(probe.style, {
              position: "absolute",
              visibility: "hidden",
              whiteSpace: "pre",
            });
            element.append(probe);
            const ch = probe.getBoundingClientRect().width / 100;

            probe.remove();

            const { height, left, width } = element.getBoundingClientRect();
            const row = element.closest("[data-index]");
            const line = row?.firstElementChild?.getBoundingClientRect().height ?? 0;

            return {
              ch,
              height,
              left,
              stale: Math.abs((row?.getBoundingClientRect().height ?? 0) - line) >= 0.5,
              width,
            };
          });

          const composerBox = await composer.boundingBox();
          // A phone draws no Sidebar but as a drawer.
          const sidebarBox = (await sidebar.count()) === 0 ? null : await sidebar.boundingBox();

          return {
            ...measured,
            composer: composerBox?.width ?? 0,
            sidebar: sidebarBox?.width ?? 0,
          };
        };

        /**
         * How a row reads as one run: whether the Timeline is narrow enough for it, how its
         * text reaches from where its row's content starts, how tall it is, where it starts,
         * whether its row was laid out again to its height, and whether the row, with its
         * tint, runs the Timeline's width.
         * @param words - What was said, as a whole.
         * @returns The measures.
         */
        const run = async (words: typeof text) => {
          await settled(page);

          return await words.evaluate((element) => {
            const probe = document.createElement("span");

            probe.textContent = "0".repeat(100);
            Object.assign(probe.style, {
              position: "absolute",
              visibility: "hidden",
              whiteSpace: "pre",
            });
            element.append(probe);
            const ch = probe.getBoundingClientRect().width / 100;

            probe.remove();

            const row = element.closest("[data-index]");
            const line = row?.firstElementChild;
            // What tints and pads the row, inside the box that holds it.
            const body = line?.firstElementChild;

            if (!row || !line || !body) {
              throw new Error("No row holds what was said.");
            }

            let container = element.parentElement;

            while (container && getComputedStyle(container).containerType !== "inline-size") {
              container = container.parentElement;
            }

            if (!container) {
              throw new Error("No Timeline holds the row.");
            }

            const style = getComputedStyle(body);
            const box = body.getBoundingClientRect();
            const said = element.getBoundingClientRect();
            const rowBox = row.getBoundingClientRect();

            return {
              ch,
              display: style.display,
              height: said.height,
              left: said.left,
              // The query's em is the Timeline's own text size.
              narrow:
                container.clientWidth <=
                36 * Number(getComputedStyle(container).fontSize.replace("px", "")),
              reach: said.right - (box.left + Number(style.paddingLeft.replace("px", ""))),
              // The room the run has, between the row's paddings.
              room:
                box.width -
                Number(style.paddingLeft.replace("px", "")) -
                Number(style.paddingRight.replace("px", "")),
              stale: Math.abs(rowBox.height - line.getBoundingClientRect().height) >= 0.5,
              tinted: style.backgroundColor !== "rgba(0, 0, 0, 0)",
              whole: Math.abs(box.width - rowBox.width) < 0.5,
              width: box.width,
            };
          });
        };

        /**
         * How a row read as one run differs with a bound from with none.
         * @param none - The row with none.
         * @param bound - The same row with the bound of 40.
         * @returns What differs, each as it should.
         */
        const against = (none: Awaited<ReturnType<typeof run>>, bound: typeof none) => ({
          // The Timeline is narrow enough for a row to read as one run, in both.
          asRun: [none.display, bound.display, none.narrow, bound.narrow],
          // The bound is well within the room the run had, and is the room it has now.
          atBound: near(bound.room, 40 * bound.ch) && 40 * bound.ch < none.room - 40,
          left: near(bound.left, none.left),
          // The text reaches no further than the bound from where its row's content starts,
          // bar the space a line ends on, which hangs past it, and with none reaches past it.
          reach: bound.reach <= 41 * bound.ch + 0.5 && none.reach > 41 * bound.ch + 40,
          stale: [none.stale, bound.stale],
          taller: bound.height > none.height,
          // The row runs the Timeline's width as it did with none.
          whole: [none.whole, bound.whole, near(bound.width, none.width)],
        });

        const widthNow = async () => {
          const now = await drawn();

          return now.width;
        };

        const chNow = async () => {
          const now = await drawn();

          return now.ch;
        };

        const unbounded = await drawn();

        await set("width", "40");
        await expect.poll(widthNow).toBeLessThan(unbounded.width);
        const bounded = await drawn();

        await set("size", "20");
        await expect.poll(chNow).toBeGreaterThan(bounded.ch);
        const larger = await drawn();

        await set("size", "14");
        await expect.poll(chNow).toBeCloseTo(bounded.ch, 1);
        await set("width", "none");
        await expect.poll(widthNow).toBeCloseTo(unbounded.width, 1);
        const unset = await drawn();

        // A bound wider than the Pane: drawn as with none.
        await set("width", "400");
        await settled(page);
        const wider = await drawn();

        // A phone, where a row reads as one run, and a bound wider than it.
        await set("width", "none");
        await page.setViewportSize({ height: 800, width: 360 });
        const phone = await drawn();

        await set("width", "60");
        await settled(page);
        const phoneBounded = await drawn();

        // A Timeline just narrow enough for a row to read as one run, with a bound well
        // within it: the run wraps at the bound from its start, and the row, with its tint,
        // still runs the width. Each is seen with none and with the bound.
        const called = log.locator("bdi", { hasText: "call59" }).first();

        await called.waitFor();
        await set("width", "none");
        await page.setViewportSize({ height: 800, width: 500 });
        const narrowSaid = await run(text);
        const narrowCalled = await run(called);

        await set("width", "40");
        await settled(page);
        const narrowSaidBounded = await run(text);
        const narrowCalledBounded = await run(called);

        expect({
          bounded: {
            atBound: near(bounded.width, 40 * bounded.ch),
            composer: near(bounded.composer, unbounded.composer),
            left: near(bounded.left, unbounded.left),
            narrower: bounded.width < unbounded.width,
            sidebar: near(bounded.sidebar, unbounded.sidebar),
            stale: bounded.stale,
            taller: bounded.height > unbounded.height,
          },
          larger: {
            atBound: near(larger.width, 40 * larger.ch),
            stale: larger.stale,
            wider: larger.width > bounded.width,
          },
          narrow: [
            against(narrowSaid, narrowSaidBounded),
            against(narrowCalled, narrowCalledBounded),
          ],
          narrowTint: [narrowCalled.tinted, narrowCalledBounded.tinted],
          phone: [phone.left, phone.width, phone.height, phone.stale],
          phoneBounded: [
            phoneBounded.left,
            phoneBounded.width,
            phoneBounded.height,
            phoneBounded.stale,
          ],
          problems: problems.filter((problem) => problem.includes("Content Security Policy")),
          unset: [unset.left, unset.width, unset.height, unset.stale],
          wider: [wider.left, wider.width, wider.height, wider.stale],
        }).toStrictEqual({
          bounded: {
            atBound: true,
            composer: true,
            left: true,
            narrower: true,
            sidebar: true,
            stale: false,
            taller: true,
          },
          larger: { atBound: true, stale: false, wider: true },
          narrow: [
            {
              asRun: ["block", "block", true, true],
              atBound: true,
              left: true,
              reach: true,
              stale: [false, false],
              taller: true,
              whole: [true, true, true],
            },
            {
              asRun: ["block", "block", true, true],
              atBound: true,
              left: true,
              reach: true,
              stale: [false, false],
              taller: true,
              whole: [true, true, true],
            },
          ],
          narrowTint: [true, true],
          phone: [phone.left, phone.width, phone.height, false],
          phoneBounded: [phone.left, phone.width, phone.height, false],
          problems: [],
          unset: [unbounded.left, unbounded.width, unbounded.height, false],
          wider: [unbounded.left, unbounded.width, unbounded.height, false],
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
    "expires at start an Upload older than uploads.expireAfter, releasing its bytes, and the list shows it expired",
    { timeout: 120_000 },
    async () => {
      const dataDir = path.join(directory, "expiring");
      const minio: Minio = await startMinio();

      // MinIO goes with the run, however far its setup got.
      try {
        const created = await iirc("key", "create", "browser", "--data-dir", dataDir);
        const key = created.stdout.trim();
        const listen = freePort();

        const authorization = {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        };

        const kept = solidPng(8, [40, 96, 208]);
        const aged = solidPng(8, [208, 96, 40]);
        const day = 24 * 60 * 60 * 1000;
        let child: Awaited<ReturnType<typeof startDaemon>>["child"] | undefined;

        // One run of the Daemon on the data directory, its API called with the key.
        const running = async () => {
          const started = await startDaemon(dataDir);

          ({ child } = started);

          return {
            api: async (
              method: string,
              route: string,
              body: string | Uint8Array<ArrayBuffer> | null = null
            ) =>
              await fetch(`${started.base}/api${route}`, { body, headers: authorization, method }),
            base: started.base,
          };
        };

        const stopped = async () => {
          child?.kill("SIGTERM");
          await child?.exited;
        };

        try {
          const first = await running();

          const options = {
            "store.s3.accessKeyId": "minio-key",
            "store.s3.bucket": minio.bucket,
            "store.s3.endpoint": minio.endpoint,
            "store.s3.region": minio.region,
            "store.s3.secretAccessKey": "minio-secret",
            "uploads.listen": `${loopback}:${listen}`,
            "uploads.publicUrl": `http://${loopback}:${listen}`,
          };

          await first.api(
            "PUT",
            "/credentials/minio-key",
            JSON.stringify({ value: minio.accessKeyId })
          );
          await first.api(
            "PUT",
            "/credentials/minio-secret",
            JSON.stringify({ value: minio.secretAccessKey })
          );

          for (const [option, value] of Object.entries(options)) {
            // oxlint-disable-next-line no-await-in-loop -- set in order
            await first.api("PUT", `/options/${option}`, JSON.stringify({ value }));
          }

          const uploaded = await first.api("POST", "/uploads?name=b.png", kept);

          expect(uploaded.status).toBe(200);
          await stopped();

          // The Daemon cannot be aged, so A is journaled, with its bytes, three days ago
          // while it is stopped.
          const old = await seedUpload(minio, minio.bucket, dataDir, {
            at: Date.now() - 3 * day,
            bytes: aged,
            name: "a.png",
            type: "image/png",
          });

          const live = await running();

          const listed = async (api: typeof live.api) => {
            const answer = await api("GET", "/uploads?deleted=true");

            return decodeUploads(await answer.text()).uploads;
          };

          const before = await listed(live.api);

          const { page, problems } = await watchedPage(browser);

          await page.goto(live.base);
          await page.getByLabel("Key").fill(key);
          await page.getByRole("button", { name: "Sign in" }).click();
          await page.getByRole("button", { exact: true, name: "Options" }).click();

          const uploads = page.getByRole("region", { name: "Uploads" });
          const rows = uploads.getByRole("listitem");

          await rows.filter({ hasText: "a.png" }).waitFor();
          await rows.filter({ hasText: "b.png" }).waitFor();
          const liveRows = await rows.count();

          // Closed before its Daemon is, so its streams ending is not read as a failure.
          await page.context().close();
          await live.api("PUT", "/options/uploads.expireAfter", JSON.stringify({ value: 1 }));
          await stopped();

          const expiring = await running();
          const after = await listed(expiring.api);
          const aOf = after.find((upload) => upload.id === old.id);
          const bOf = after.find((upload) => upload.safeName === "b.png");

          const listener = (upload: { readonly id: string; readonly safeName: string }) =>
            `http://${loopback}:${listen}/${upload.id}/${upload.safeName}`;

          const aLink = await fetch(listener({ id: old.id, safeName: "a.png" }));
          const bLink = await fetch(listener({ id: bOf?.id ?? "", safeName: "b.png" }));

          // A fresh page, since the Daemon it was signed in to is gone.
          const { page: later, problems: laterProblems } = await watchedPage(browser);

          await later.goto(expiring.base);
          await later.getByLabel("Key").fill(key);
          await later.getByRole("button", { name: "Sign in" }).click();
          await later.getByRole("button", { exact: true, name: "Options" }).click();

          const laterUploads = later.getByRole("region", { name: "Uploads" });
          const laterRows = laterUploads.getByRole("listitem");

          await laterRows.filter({ hasText: "b.png" }).waitFor();

          const hidden = await laterRows.filter({ hasText: "a.png" }).count();

          await later.getByRole("button", { name: "Show deleted" }).click();

          const expired = laterRows.filter({ hasText: "a.png" });

          await expired.waitFor();
          const expiredText = (await expired.textContent()) ?? "";

          expect({
            aBytes: await holdsBytes(minio, minio.bucket, old.hash),
            aLink: aLink.status,
            aLinkField: aOf?.link,
            aRecord: aOf?.deleted?.why,
            bBytes: await holdsBytes(minio, minio.bucket, bOf?.hash ?? ""),
            bLink: [bLink.status, new Uint8Array(await bLink.arrayBuffer())],
            bRecord: bOf?.deleted,
            before: before.map((upload) => [upload.safeName, upload.deleted?.why]),
            expiredText: expiredText.includes("expired"),
            hidden,
            liveRows,
            problems: [...problems, ...laterProblems].filter((problem) => !problem.includes("401")),
          }).toStrictEqual({
            aBytes: false,
            aLink: 404,
            aLinkField: null,
            aRecord: "expired",
            bBytes: true,
            bLink: [200, kept],
            bRecord: undefined,
            // Newest first: the one seeded after B is above it.
            before: [
              ["a.png", undefined],
              ["b.png", undefined],
            ],
            expiredText: true,
            hidden: 0,
            liveRows: 2,
            problems: [],
          });
        } finally {
          await stopped();
        }
      } finally {
        await minio.stop();
      }
    }
  );

  it(
    "marks an Upload whose bytes vanished from the Store as missing in the list, live, and clears it when the same bytes are uploaded again",
    { timeout: 120_000 },
    async () => {
      const dataDir = path.join(directory, "vanishing");
      const minio: Minio = await startMinio();

      // MinIO goes with the run, however far its setup got.
      try {
        const created = await iirc("key", "create", "browser", "--data-dir", dataDir);
        const key = created.stdout.trim();
        const listen = freePort();
        const lost = solidPng(8, [208, 96, 40]);
        const kept = solidPng(8, [40, 96, 208]);
        const started = await startDaemon(dataDir);

        try {
          const api = async (
            method: string,
            route: string,
            body: string | Uint8Array<ArrayBuffer> | null = null
          ) =>
            await fetch(`${started.base}/api${route}`, {
              body,
              headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
              method,
            });

          const options = {
            "store.s3.accessKeyId": "minio-key",
            "store.s3.bucket": minio.bucket,
            "store.s3.endpoint": minio.endpoint,
            "store.s3.region": minio.region,
            "store.s3.secretAccessKey": "minio-secret",
            "uploads.listen": `${loopback}:${listen}`,
            "uploads.publicUrl": `http://${loopback}:${listen}`,
          };

          await api("PUT", "/credentials/minio-key", JSON.stringify({ value: minio.accessKeyId }));
          await api(
            "PUT",
            "/credentials/minio-secret",
            JSON.stringify({ value: minio.secretAccessKey })
          );

          for (const [option, value] of Object.entries(options)) {
            // oxlint-disable-next-line no-await-in-loop -- set in order
            await api("PUT", `/options/${option}`, JSON.stringify({ value }));
          }

          const first = await api("POST", "/uploads?name=lost.png", lost);
          const second = await api("POST", "/uploads?name=kept.png", kept);

          expect([first.status, second.status]).toStrictEqual([200, 200]);

          const lostUpload = decodeUpload(await first.text());
          const link = `http://${loopback}:${listen}/${lostUpload.id}/${lostUpload.safeName}`;

          const { page, problems } = await watchedPage(browser);

          await page.goto(started.base);
          await page.getByLabel("Key").fill(key);
          await page.getByRole("button", { name: "Sign in" }).click();
          await page.getByRole("button", { exact: true, name: "Options" }).click();

          const uploads = page.getByRole("region", { name: "Uploads" });
          const rows = uploads.getByRole("listitem");
          const lostRow = rows.filter({ hasText: "lost.png" });
          const keptRow = rows.filter({ hasText: "kept.png" });

          await lostRow.waitFor();
          await keptRow.waitFor();
          await screenshot(page, "156-before.png");

          const copyBefore = await lostRow.getByRole("button", { name: /^Copy the link/u }).count();

          // Taken out of the bucket behind the Daemon's back, which no Change says.
          await loseBytes(minio, minio.bucket, lostUpload.hash);

          // The read of the link finds them gone, which marks the Upload and tells the page
          // by the stream, so it needs no reload.
          const gone = await fetch(link);

          await gone.arrayBuffer();
          await lostRow.getByText("missing").waitFor();
          await screenshot(page, "156-after.png");

          const marked = {
            copy: await lostRow.getByRole("button", { name: /^Copy the link/u }).count(),
            keptMissing: await keptRow.getByText("missing").count(),
            lostOffers: await lostRow.getByRole("button").allTextContents(),
          };

          const record = async () => {
            const read = await api("GET", "/uploads");
            const { uploads: held } = decodeUploads(await read.text());

            return held.find((upload) => upload.id === lostUpload.id);
          };

          const recordBefore = await record();

          // The same bytes again: the Upload's bytes are back, so it is no longer missing.
          const again = await api("POST", "/uploads?name=lost-again.png", lost);

          await uploads.getByText("missing").waitFor({ state: "detached" });

          const back = await fetch(link);
          const recordAfter = await record();

          expect({
            again: again.status,
            backBytes: [back.status, new Uint8Array(await back.arrayBuffer())],
            copyBefore,
            gone: gone.status,
            marked,
            missingRecord: recordBefore?.missing,
            problems: problems.filter((problem) => !problem.includes("404")),
            recordAfter: recordAfter?.missing,
            storeHolds: await holdsBytes(minio, minio.bucket, lostUpload.hash),
          }).toStrictEqual({
            again: 200,
            backBytes: [200, lost],
            copyBefore: 1,
            gone: 404,
            marked: { copy: 0, keptMissing: 0, lostOffers: ["Rename", "Delete"] },
            missingRecord: true,
            problems: [],
            recordAfter: undefined,
            storeHolds: true,
          });
        } finally {
          started.child.kill("SIGTERM");
          await started.child.exited;
        }
      } finally {
        await minio.stop();
      }
    }
  );
});
