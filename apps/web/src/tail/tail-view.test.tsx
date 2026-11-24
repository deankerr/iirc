// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { TimelineId, uiDefaults } from "@iirc/api";
import type { Timeline } from "@iirc/api";
import { chosenOf } from "@iirc/frontend/timelines";
import { Schema } from "effect";
import type { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { optionsState } from "../options/atoms.ts";
import { uiSync } from "../options/ui.ts";
import { pageState } from "../page/atoms.ts";
import { drawerState } from "../page/drawer.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run } from "../testing/fake-daemon.ts";
import { open, paned, sync, timelinesState } from "../timelines/atoms.ts";
import { clockFor } from "../ui/clock.ts";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: (() => void)[] = [];

const idOf = (sequence: number) => `${sequence.toString(16).padStart(14, "0")}-00000000-00000000`;
const timelineId = Schema.decodeSync(TimelineId);
const own = timelineId(idOf(1));
const iirc = timelineId(idOf(2));
const other = timelineId(idOf(3));

const describeTimeline = (
  id: string,
  name: string,
  kind: "Network" | "Channel"
): typeof Timeline.Encoded => ({
  changed: 1,
  closed: false,
  detached: false,
  head: null,
  id,
  key: kind === "Network" ? null : name,
  kind,
  latest: null,
  life: 1,
  name,
  network: "libera",
  read: null,
  removed: false,
  unread: { activity: 0, botDirect: 0, botMessages: 0, direct: 0, highlights: 0, messages: 0 },
});

/**
 * Waits until something holds, letting React render what changed meanwhile.
 * @param holds - What must hold.
 */
const settled = async (holds: () => boolean) => {
  await act(async () => {
    await eventually(holds);
  });
};

/**
 * Does something to the page, letting React render it.
 * @param what - What to do.
 */
const doing = async (what: () => void) => {
  await act(async () => {
    what();
    await Promise.resolve();
  });
};

/**
 * The fake Daemon, signed in, with one Network holding its own Timeline, `#iirc`, and
 * `#other`, or none when asked.
 * @param networks - Whether a Network is configured.
 * @returns The fake.
 */
const daemonWith = (networks = true) => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;

  if (networks) {
    fake.daemon.timelines.set("libera", [
      { gaps: [], items: [], timeline: describeTimeline(own, "libera", "Network") },
      { gaps: [], items: [], timeline: describeTimeline(iirc, "#iirc", "Channel") },
      { gaps: [], items: [], timeline: describeTimeline(other, "#other", "Channel") },
    ]);
  } else {
    fake.daemon.timelines.clear();
  }

  return fake;
};

/**
 * The Frontend signed in to the fake, on a wide screen, following the Timelines, rendered
 * once the Network list is read, with nothing open.
 * @param fake - The fake Daemon.
 * @returns The registry and the page.
 */
const page = async (fake: ReturnType<typeof fakeDaemon>) => {
  const registry = registryFor(fake.fetch);

  registry.set(pageState, { compact: false, focused: true, visible: true });
  await run(registry, check, undefined);
  registry.mount(sync);
  registry.mount(uiSync);

  const container = document.createElement("div");

  document.body.append(container);
  const root = createRoot(container);

  await doing(() => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <App />
      </RegistryContext.Provider>
    );
  });

  mounted.push(() => {
    root.unmount();
    container.remove();
  });

  await settled(() => registry.get(timelinesState).listed);

  return { container, registry };
};

/**
 * The view, while a Pane shows it.
 * @param container - The page.
 * @returns It, or none.
 */
const view = (container: ParentNode) =>
  container.querySelector<HTMLElement>('main section[aria-label="logs"]');

/**
 * The Tail's lines the view shows, each its time, words, annotations, and cause, line by
 * line, and whether it is marked as a warning.
 * @param container - The page.
 * @returns Each.
 */
const lines = (container: ParentNode) =>
  [...(view(container)?.querySelectorAll("li") ?? [])].map((line) => {
    const [time, text] = line.children;
    const parts = [...(text?.children ?? [])];

    return {
      annotations: parts
        .slice(1)
        .flatMap((part) => (part.tagName === "BDI" ? [part.textContent] : [])),
      cause:
        parts.at(-1)?.tagName === "SPAN"
          ? [...(parts.at(-1)?.children ?? [])].map((one) => one.textContent)
          : null,
      message: parts[0]?.textContent,
      time: time?.textContent,
      warning: "warning" in line.dataset,
    };
  });

/**
 * The words of each line the view shows.
 * @param container - The page.
 * @returns Each.
 */
const words = (container: ParentNode) => lines(container).map((line) => line.message);

/**
 * A time as the view draws it under the default `ui.timeline.timeFormat`.
 * @param at - The instant.
 * @returns The time.
 */
const timeOf = (at: number) => clockFor(uiDefaults["timeline.timeFormat"]).format(new Date(at));

/**
 * The view's banner: the art, as a screen reader names it, and the version under it.
 * @param container - The page.
 * @returns It.
 */
const banner = (container: ParentNode) => {
  const art = view(container)?.querySelector("h2");

  return {
    art: art?.getAttribute("aria-label"),
    drawn: art?.textContent.includes("██"),
    version: art?.nextElementSibling?.textContent,
  };
};

/**
 * The sidebar's `logs` row.
 * @returns It.
 */
const tailRow = () => {
  const found = document.querySelector<HTMLElement>('nav [role="option"][data-key="Tail"]');

  if (found === null) {
    throw new Error("no iirc row");
  }

  return found;
};

/**
 * Types into the composer, as a keystroke does, and presses a key there.
 * @param container - The page.
 * @param text - What to type, if anything.
 * @param key - The key to press after, if any.
 */
const composerDoes = async (container: HTMLElement, text?: string, key?: string) => {
  const composer = container.querySelector("textarea");

  if (composer === null) {
    throw new Error("no composer");
  }

  if (text !== undefined) {
    await doing(() => {
      Reflect.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        composer,
        text
      );
      composer.setSelectionRange(text.length, text.length);
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  if (key !== undefined) {
    await doing(() => {
      composer.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: key, key })
      );
    });
  }
};

/**
 * How to start, as the view says it, and whether it follows the banner.
 * @param container - The page.
 * @returns It, or none.
 */
const hintOf = (container: HTMLElement) => {
  const parts = [...(view(container)?.querySelectorAll("h2, p") ?? [])];
  const hint = parts.findIndex((one) => one.textContent.startsWith("Choose a conversation"));

  return hint === -1
    ? undefined
    : { after: parts[0]?.tagName === "H2" && hint > 0, text: parts[hint]?.textContent };
};

/**
 * Whether the focused Pane shows the Tail, as the sidebar marks it.
 * @param registry - The registry.
 * @returns Whether it does.
 */
const tailShownNow = (registry: AtomRegistry.AtomRegistry) =>
  chosenOf(registry.get(timelinesState))._tag === "Tail";

/**
 * The words of the lines the view shows under a value of `ui.tail`, with one line at each level held.
 * @param tail - The value.
 * @returns The words.
 */
const shownAt = async (tail: "debug" | "info" | "warning" | "error") => {
  const fake = daemonWith();

  fake.daemon.ui = { options: { ...uiDefaults, tail }, sequence: 1 };
  fake.log("Debug", "debug");
  fake.log("Info", "info");
  fake.log("Warn", "warn");
  fake.log("Error", "error");
  fake.log("Fatal", "fatal");

  const { container, registry } = await page(fake);

  await settled(() => registry.get(optionsState).ui?.sequence === 1 && words(container).length > 0);

  return words(container);
};

describe("the iirc view", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    localStorage.clear();
  });

  // Regression: the view drops a part of a line, shows Debug, or loses the order.
  it("shows the banner and the Daemon's version above the Tail's lines at Info and above, oldest first, each its time, words, annotations, and cause", async () => {
    const fake = daemonWith();

    fake.log("Debug", "Read a line", { network: "libera" });
    fake.log("Info", "Dialling", { ircd: "irc.example:6697", network: "libera" });
    fake.log("Error", "Connection failed", { network: "libera" }, "Error: refused\n  at dial");

    const { container } = await page(fake);

    await settled(() => lines(container).length === 3);

    // The banner and the lines scroll together, the banner first.
    const scrolled = [...(view(container)?.querySelectorAll('[role="log"] :is(h2, li)') ?? [])];

    expect({
      above: scrolled.map((one) => one.tagName).slice(0, 2),
      banner: banner(container),
      lines: lines(container),
    }).toStrictEqual({
      above: ["H2", "LI"],
      banner: { art: "iirc", drawn: true, version: "0.0.0" },
      lines: [
        {
          annotations: ["version=0.0.0"],
          cause: null,
          message: "Started",
          time: timeOf(1_700_000_000_000),
          warning: false,
        },
        {
          annotations: ["ircd=irc.example:6697", "network=libera"],
          cause: null,
          message: "Dialling",
          time: timeOf(1_700_000_003_000),
          warning: false,
        },
        {
          annotations: ["network=libera"],
          cause: ["Error: refused", "  at dial"],
          message: "Connection failed",
          time: timeOf(1_700_000_004_000),
          warning: true,
        },
      ],
    });
  });

  // Regression: an Ircd's words in a line become markup in the page.
  it("draws what a line holds as text, never as markup", async () => {
    const fake = daemonWith();

    fake.log(
      "Warn",
      "<b>x</b>",
      { said: "<img src=x onerror=alert(1)>" },
      "<script>bad()</script>"
    );

    const { container } = await page(fake);

    await settled(() => lines(container).length === 2);

    expect({
      elements: view(container)?.querySelectorAll("li b, li img, li script").length,
      line: lines(container)[1],
    }).toStrictEqual({
      elements: 0,
      line: {
        annotations: ["said=<img src=x onerror=alert(1)>"],
        cause: ["<script>bad()</script>"],
        message: "<b>x</b>",
        time: timeOf(1_700_000_002_000),
        warning: true,
      },
    });
  });

  // Regression: a warning looks like any other line.
  it("marks every line at Warn and above, and none below", async () => {
    const fake = daemonWith();

    fake.log("Info", "info");
    fake.log("Warn", "warn");
    fake.log("Error", "error");
    fake.log("Fatal", "fatal");

    const { container } = await page(fake);

    await settled(() => lines(container).length === 5);

    expect(lines(container).map((line) => [line.message, line.warning])).toStrictEqual([
      ["Started", false],
      ["info", false],
      ["warn", true],
      ["error", true],
      ["fatal", true],
    ]);
  });

  // Regression: the view reads the Tail once and never follows it.
  it("shows a line logged while it shows, without a reload", async () => {
    const fake = daemonWith();
    const { container } = await page(fake);

    await settled(() => words(container).length === 1 && fake.daemon.tailFollowers.length === 1);
    fake.log("Info", "Joined", { channel: "#iirc" });
    await settled(() => words(container).length === 2);

    expect(words(container)).toStrictEqual(["Started", "Joined"]);
  });

  // Regression: a Tail read whole waits on its stream, so a stream that cannot open hides it.
  it("shows the Tail read while its stream cannot be followed", async () => {
    const fake = daemonWith();

    fake.daemon.tailStreamDown = true;
    fake.log("Info", "Dialling");

    const { container } = await page(fake);

    await settled(() => words(container).length === 2);

    expect({ version: banner(container).version, words: words(container) }).toStrictEqual({
      version: "0.0.0",
      words: ["Started", "Dialling"],
    });
  });

  // Regression: after a restart the view keeps the old Daemon's Tail, or misses the new one's start.
  it("shows the new Tail from its start after the Daemon restarts, with its version", async () => {
    const fake = daemonWith();

    fake.log("Info", "Before");

    const { container } = await page(fake);

    await settled(() => words(container).length === 2 && fake.daemon.tailFollowers.length === 1);
    fake.restart("0.0.1");
    fake.log("Info", "After");
    await settled(() => banner(container).version === "0.0.1" && words(container).length === 2);

    expect({ version: banner(container).version, words: words(container) }).toStrictEqual({
      version: "0.0.1",
      words: ["Started", "After"],
    });
  });

  // Regression: an empty Pane shows no view, or how to start is lost, or shown with a Network.
  it("is what a Pane with nothing open shows, with how to start after the banner only while no Network is configured", async () => {
    const none = await page(daemonWith(false));

    await settled(() => hintOf(none.container) !== undefined);

    const some = await page(daemonWith());

    await settled(() => words(some.container).length === 1);

    expect({ none: hintOf(none.container), some: hintOf(some.container) }).toStrictEqual({
      none: {
        after: true,
        text: "Choose a conversation, or add a network with /network add <id> <host>[/port] [plain] <nick>. /set opens settings.",
      },
      some: undefined,
    });
  });

  // Regression: `ui.tail` is not read, or a level it names is mapped to the wrong one.
  it("shows the lines at the level ui.tail names and above, and no others", async () => {
    expect({
      debug: await shownAt("debug"),
      error: await shownAt("error"),
      info: await shownAt("info"),
      warning: await shownAt("warning"),
    }).toStrictEqual({
      debug: ["Started", "debug", "info", "warn", "error", "fatal"],
      error: ["error", "fatal"],
      info: ["Started", "info", "warn", "error", "fatal"],
      warning: ["warn", "error", "fatal"],
    });
  });

  // Regression: a change on another device waits for a reload, or the Debug lines held are lost or out of order.
  it("shows the Debug lines held, each in time order, once another device turns ui.tail down to debug, and hides them again once it is unset", async () => {
    const fake = daemonWith();

    fake.log("Debug", "Read a line");
    fake.log("Info", "Dialling");
    fake.log("Debug", "Sent a line");

    const shown = await page(fake);
    const other = await page(fake);

    await settled(
      () => words(shown.container).length === 2 && fake.daemon.uiFollowers.length === 2
    );
    const before = words(shown.container);

    await composerDoes(other.container, "/set ui.tail debug", "Enter");
    await settled(() => words(shown.container).length === 4);
    const debug = lines(shown.container).map((line) => [line.message, line.time]);

    await composerDoes(other.container, "/unset ui.tail", "Enter");
    await settled(() => words(shown.container).length === 2);

    expect({ after: words(shown.container), before, debug }).toStrictEqual({
      after: ["Started", "Dialling"],
      before: ["Started", "Dialling"],
      debug: [
        ["Started", timeOf(1_700_000_000_000)],
        ["Read a line", timeOf(1_700_000_002_000)],
        ["Dialling", timeOf(1_700_000_003_000)],
        ["Sent a line", timeOf(1_700_000_004_000)],
      ],
    });
  });

  // Regression: `/tail` is no command, or the palette does not offer it.
  it("opens from the palette, as /tail, in the focused Pane", async () => {
    const { container, registry } = await page(daemonWith());

    await doing(() => {
      registry.set(open, iirc);
    });
    await settled(() => !tailShownNow(registry) && view(container) === null);

    await composerDoes(container, "/tai", "ArrowDown");
    await composerDoes(container, undefined, "Enter");
    await settled(() => tailShownNow(registry) && view(container) !== null);

    expect(tailShownNow(registry)).toBeTruthy();
  });
});

describe("the iirc row", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    localStorage.clear();
  });

  // Regression: the row is missing, not first, does not open the view, or is marked as no other view's row is.
  it("is the Sidebar's first row, in place of the Networks heading, and opens the view in the focused Pane, marked as a view's row is", async () => {
    const { registry } = await page(daemonWith());

    const marks = () => [
      tailRow().getAttribute("aria-label"),
      tailRow().getAttribute("aria-selected"),
    ];

    await settled(() => document.querySelector('nav [role="row"]') !== null);

    const first = document.querySelector('nav [role="option"], nav [role="row"]') === tailRow();
    const headings = [...document.querySelectorAll("nav h2")].map((one) => one.textContent);
    const empty = marks();

    await doing(() => {
      registry.set(open, iirc);
      registry.set(paned, { _tag: "Split", axis: "Horizontal", timeline: other });
    });
    await settled(() => marks()[1] === "false");
    const neither = marks();

    await doing(() => {
      tailRow().click();
    });
    await settled(() => tailShownNow(registry));
    const chosen = marks();

    await doing(() => {
      registry.set(paned, { _tag: "Focus", pane: "p0" });
    });
    await settled(() => marks()[1] === "false");

    expect({ chosen, elsewhere: marks(), empty, first, headings, neither }).toStrictEqual({
      chosen: ["logs", "true"],
      elsewhere: ["logs, in pane 2", "false"],
      empty: ["logs", "true"],
      first: true,
      headings: [],
      neither: ["logs", "false"],
    });
  });

  // Regression: on a phone the row is out of reach, or choosing it leaves the drawer over the view.
  it("is in the drawer on a phone, and choosing it closes the drawer", async () => {
    const { registry } = await page(daemonWith());

    await doing(() => {
      registry.set(open, iirc);
      registry.set(pageState, { compact: true, focused: true, visible: true });
      registry.set(drawerState, "Sidebar");
    });
    await settled(
      () => document.querySelector('[role="dialog"] nav [role="option"][data-key="Tail"]') !== null
    );

    await doing(() => {
      tailRow().click();
    });
    await settled(() => tailShownNow(registry));

    expect(registry.get(drawerState)).toBe("None");
  });
});
