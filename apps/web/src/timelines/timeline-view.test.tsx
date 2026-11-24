// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { uiDefaults } from "@iirc/api";
import type { ReadRule, TimeShown, Timeline, TimelineItem, WindowGap } from "@iirc/api";
import { nickColour } from "@iirc/frontend/render";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/app.tsx";
import { deviceUi } from "../options/device.ts";
import { uiRead, uiSync } from "../options/ui.ts";
import { pageState } from "../page/atoms.ts";
import { movedEvent } from "../panes/atoms.ts";
import { marking } from "../reading/atoms.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run } from "../testing/fake-daemon.ts";
import { openTimeline, sync } from "./atoms.ts";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: (() => void)[] = [];

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const cursor = (at: number, sequence: number) =>
  `${hex(BigInt(at) + 2n ** 53n, 14)}-${hex(BigInt(sequence), 14)}-${hex(0n, 8)}`;

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;

const own = idOf(1);
const iirc = idOf(2);

const listed = (
  id: string,
  name: string,
  kind: "Network" | "Channel",
  more: Partial<typeof Timeline.Encoded> = {}
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
  ...more,
});

const message = (
  sequence: number,
  ours: {
    readonly delivery: { readonly _tag: "Unconfirmed" | "Unsent" };
    readonly intent: string;
  } | null = null,
  bot = false
): typeof TimelineItem.Encoded => ({
  answered: null,
  changed: sequence,
  content: {
    _tag: "Message",
    answers: null,
    at: { _tag: "Unknown" },
    bot,
    context: null,
    id: { _tag: "Unknown" },
    kind: "Privmsg",
    live: true,
    nicks: [],
    ours,
    prefix: null,
    sender: "peer",
    tags: [],
    target: "#iirc",
    text: `line ${sequence}`,
  },
  level: "Message",
  network: "libera",
  position: cursor(sequence * 1000, sequence),
  sequence,
  timeline: iirc,
});

/**
 * A Message, as an item, from a sender who held a prefix.
 * @param sequence - Its sequence.
 * @param prefix - The symbol of the prefix its sender held, or none.
 * @param kind - How it was said.
 * @param bot - Whether its sender said they are a bot.
 * @returns The item.
 */
const heldBy = (
  sequence: number,
  prefix: string | null,
  kind: "Privmsg" | "Notice" | "Action" = "Privmsg",
  bot = false
): typeof TimelineItem.Encoded => {
  const item = message(sequence, null, bot);

  if (item.content._tag !== "Message") {
    throw new Error("not a Message");
  }

  return { ...item, content: { ...item.content, kind, prefix } };
};

/**
 * A Message, as an item, whose text names Users.
 * @param sequence - Its sequence.
 * @param text - Its text.
 * @param nicks - The spans of its text, with formatting stripped, that name a User.
 * @returns The item.
 */
const naming = (
  sequence: number,
  text: string,
  nicks: readonly { start: number; end: number }[]
): typeof TimelineItem.Encoded => {
  const item = message(sequence);

  if (item.content._tag !== "Message") {
    throw new Error("not a Message");
  }

  return { ...item, content: { ...item.content, nicks, text } };
};

/**
 * A reply, as an item, to what an earlier item said.
 * @param sequence - Its sequence.
 * @param answered - The Message it answers, as the Daemon resolved it, or none held.
 * @param more - What else of its Message to change.
 * @returns The item.
 */
const replied = (
  sequence: number,
  answered: (typeof TimelineItem.Encoded)["answered"],
  more: { readonly answers?: string | null; readonly context?: string | null } = {}
): typeof TimelineItem.Encoded => ({
  ...message(sequence),
  answered,
  content: {
    _tag: "Message",
    answers: more.answers === undefined ? "msg-1" : more.answers,
    at: { _tag: "Unknown" },
    bot: false,
    context: more.context ?? null,
    id: { _tag: "Unknown" },
    kind: "Privmsg",
    live: true,
    nicks: [],
    ours: null,
    prefix: null,
    sender: "peer",
    tags: [],
    target: "#iirc",
    text: `line ${sequence}`,
  },
});

const joined = (sequence: number): typeof TimelineItem.Encoded => ({
  answered: null,
  changed: sequence,
  content: {
    _tag: "Activity",
    activity: { _tag: "Joined", channel: "#iirc", nick: `user${sequence}` },
    at: { _tag: "Unknown" },
    id: { _tag: "Unknown" },
    live: true,
  },
  level: "Activity",
  network: "libera",
  position: cursor(sequence * 1000, sequence),
  sequence,
  timeline: iirc,
});

/**
 * A kick in `#iirc`, which `ui.timeline.activity none` hides, and which joins no run of joins, parts,
 * quits, and changes of nick, so each stands as a row of its own.
 * @param sequence - Its sequence.
 * @returns The item.
 */
const kicked = (sequence: number): typeof TimelineItem.Encoded => ({
  ...joined(sequence),
  content: {
    _tag: "Activity",
    activity: {
      _tag: "Kicked",
      by: "op",
      channel: "#iirc",
      nick: `user${sequence}`,
      reason: null,
    },
    at: { _tag: "Unknown" },
    id: { _tag: "Unknown" },
    live: true,
  },
});

/**
 * A standard reply about `PRIVMSG` in `#iirc`, as an item.
 * @param sequence - Its sequence.
 * @param kind - Its kind.
 * @param code - Its code.
 * @param context - Its context.
 * @param description - Its description.
 * @returns The item.
 */
const reply = (
  sequence: number,
  kind: "FAIL" | "WARN" | "NOTE",
  code: string,
  context: readonly string[],
  description: string
): typeof TimelineItem.Encoded => ({
  ...joined(sequence),
  content: {
    _tag: "Activity",
    activity: { _tag: "StandardReply", code, command: "PRIVMSG", context, description, kind },
    at: { _tag: "Unknown" },
    id: { _tag: "Unknown" },
    live: true,
  },
});

/**
 * Text without the isolates a Network's text is drawn in.
 * @param text - The text.
 * @returns It, or nothing.
 */
const plain = (text: string | null | undefined) => text?.replaceAll(/[\u2066-\u2069]/gu, "");

/**
 * What a row says besides its quotation, which sits before the time, and past the time.
 * @param one - The row.
 * @returns Its words.
 */
const restOf = (one: HTMLElement) =>
  plain(one.textContent)
    ?.replace(plain(one.querySelector("button")?.textContent) ?? "", "")
    .trim()
    .replace(/^\S+ /u, "");

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
 * The Frontend signed in, its page seen, marking read, with `#iirc` holding two unread
 * Messages, or the items given, and nothing open.
 * @param gaps - The Gaps `#iirc` holds.
 * @param items - What `#iirc` holds, two Messages unless given.
 * @param more - How `#iirc` is listed, beyond two unread Messages.
 * @param network - What the Network's own Timeline holds, nothing unless given.
 * @param tags - Whether the Network's Session carries tags.
 * @returns The fake, the registry, and the page.
 */
const signedIn = async (
  gaps: readonly (typeof WindowGap.Encoded)[] = [],
  items: readonly (typeof TimelineItem.Encoded)[] = [message(1), message(2)],
  more: Partial<typeof Timeline.Encoded> = {},
  network: readonly (typeof TimelineItem.Encoded)[] = [],
  tags = false
) => {
  const fake = fakeDaemon();

  fake.daemon.sessions.set("libera", { _tag: "Registered", ircd: "ircd.test", since: 1, tags });
  // In a Session, `known` names Self, as a Daemon's does.
  fake.daemon.selves.set("libera", {
    account: { _tag: "Unknown" },
    away: { _tag: "Unknown" },
    bot: { _tag: "Unknown" },
    mask: { _tag: "Unknown" },
    nick: "iirc",
    realname: { _tag: "Unknown" },
  });
  const last = Math.max(items.at(-1)?.sequence ?? 2, network.at(-1)?.sequence ?? 0);

  fake.daemon.signedIn = true;
  fake.daemon.through = last;
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [...network], timeline: listed(own, "libera", "Network") },
    {
      gaps: [...gaps],
      items: [...items],
      timeline: listed(iirc, "#iirc", "Channel", {
        latest: cursor(last * 1000, last),
        unread: {
          activity: 0,
          botDirect: 0,
          botMessages: 0,
          direct: 0,
          highlights: 0,
          messages: 2,
        },
        ...more,
      }),
    },
  ]);

  const registry = registryFor(fake.fetch);

  registry.set(pageState, { compact: false, focused: true, visible: true });
  await run(registry, check, undefined);
  registry.mount(sync);
  registry.mount(marking);
  registry.mount(uiSync);

  const container = document.createElement("div");

  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <App />
      </RegistryContext.Provider>
    );
    await Promise.resolve();
  });

  mounted.push(() => {
    root.unmount();
    container.remove();
  });

  await settled(() => fake.daemon.followers.length === 1);

  return { ...fake, container, registry };
};

/**
 * The open Timeline's log.
 * @returns It.
 */
const logOf = () => {
  const found = document.querySelector<HTMLDivElement>('[role="log"]');

  if (found === null) {
    throw new Error("no log");
  }

  return found;
};

/**
 * Whether the open Timeline draws the "new" divider.
 * @returns Whether it does.
 */
const dividedNow = () =>
  [...logOf().querySelectorAll("p")].some((one) => one.textContent === "new");

/**
 * The text of each row of the log that says a line, its time written `T`.
 * @returns The texts.
 */
const linesOf = () =>
  [...logOf().querySelectorAll<HTMLElement>("[data-index]")].flatMap((one) =>
    one.textContent?.includes("line ")
      ? [plain(one.textContent)?.replaceAll(/\d{1,2}:\d{2}/gu, "T")]
      : []
  );

/**
 * The text of the nick each row of the log draws as a button, which a prefix is no part of.
 * @returns The texts.
 */
const nicksOf = () =>
  [...logOf().querySelectorAll('[aria-haspopup="menu"][role="button"]')].map(
    (one) => one.textContent
  );

/**
 * The colour each span of the log with exactly this text is drawn in.
 * @param text - The span's text.
 * @returns The colours.
 */
const coloursOf = (text: string) =>
  [...logOf().querySelectorAll<HTMLElement>("span")].flatMap((one) =>
    one.textContent === text ? [one.style.color] : []
  );

/**
 * Each day line's words and the day it is dated, in the order the log draws them.
 * @returns The lines.
 */
const dayLines = () =>
  [...logOf().querySelectorAll<HTMLElement>("p time[datetime]")].map((one) => [
    one.textContent,
    one.getAttribute("datetime"),
  ]);

/**
 * How the log is laid out, as a browser would and happy-dom does not: how tall its view is,
 * and how tall what it holds is, which a test changes to scroll back, how tall each row is,
 * and how wide the view is, which a test changes to wrap the rows again: `width` as the DOM
 * rounds it, `exact` its box's, unrounded, when the two differ, as a ResizeObserver
 * reports it, and `gutter` how much of it a scrollbar takes; and `least`, how wide a row in
 * columns is at least, in the font, size, and nick column in force.
 */
interface Laid {
  content: number;
  exact: number | undefined;
  gutter: number;
  least: number;
  row: number;
  top: number;
  view: number;
  width: number;
}

const layout: Laid = {
  content: 0,
  exact: undefined,
  gutter: 0,
  least: 576,
  row: 20,
  top: 0,
  view: 0,
  width: 800,
};

const isLog = (element: Element) => element.getAttribute("role") === "log";

/**
 * Whether an element is the least row in columns, which the view lays out unseen beside its log.
 * @param element - The element.
 * @returns Whether it is.
 */
const isLeast = (element: Element) =>
  element.parentElement?.previousElementSibling?.getAttribute("role") === "log";

/**
 * Gives the log its size: the virtualizer reads its view from its box, and the view reads
 * where it stands from its heights. Every other element lays out at nothing, as in happy-dom.
 */
const layOut = () => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isLog(this) ? layout.view : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return isLog(this) ? layout.width - layout.gutter : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (isLog(this)) {
        return layout.width;
      }

      return isLeast(this) ? layout.least : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isLog(this) ? layout.content : 0;
    },
  });
  // The virtualizer measures each row by its offset height.
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return Object.hasOwn(this.dataset, "index") ? layout.row : 0;
    },
  });
  // Scrolled no further than what it holds allows, as a browser clamps it.
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return isLog(this) ? Math.min(layout.top, Math.max(0, layout.content - layout.view)) : 0;
    },
    set(this: HTMLElement, top: number) {
      if (isLog(this)) {
        layout.top = top;
      }
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      if (isLog(this)) {
        return new DOMRect(0, 0, layout.width, layout.view);
      }

      // A grip's unseen measure of a hundred of the font's `0`, each eight pixels.
      if (this.previousElementSibling?.tagName === "HR") {
        return new DOMRect(0, 0, 800, 0);
      }

      return new DOMRect(0, 0, 0, Object.hasOwn(this.dataset, "index") ? layout.row : 0);
    },
  });
};

/**
 * Scrolls the log, with what it holds that tall.
 * @param top - Where it is scrolled to.
 * @param content - How tall what it holds is.
 */
const scrollTo = async (top: number, content: number) => {
  const log = logOf();

  layout.content = content;

  await act(async () => {
    log.scrollTop = top;
    log.dispatchEvent(new Event("scroll"));
    await Promise.resolve();
  });
};

/**
 * Opens a Timeline from the keys, as the Owner would: Mod+K starts `/go ` in the Composer,
 * then its name and Enter.
 * @param name - Its name, `#iirc` unless given.
 */
const openFromPalette = async (name = "#iirc") => {
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "k" })
    );
    await Promise.resolve();
  });

  const composer = document.querySelector<HTMLTextAreaElement>("textarea[data-composer]");

  if (composer === null) {
    throw new Error("no composer");
  }

  await settled(() => composer.value === "/go ");

  const text = `/go ${name}`;

  await act(async () => {
    composer.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, data: name, inputType: "insertText" })
    );
    Reflect.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      composer,
      text
    );
    composer.setSelectionRange(text.length, text.length);
    composer.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: name, inputType: "insertText" })
    );
    await Promise.resolve();
  });

  await act(async () => {
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })
    );
    await Promise.resolve();
  });

  await settled(() => composer.value === "");
};

/**
 * The Daemon folds a step into `#iirc`: it holds what the step changed, and the changes
 * stream gives it.
 * @param fake - The fake Daemon.
 * @param sequence - The step.
 * @param items - The items it added.
 * @param timeline - `#iirc` after it.
 */
const fold = (
  fake: Pick<ReturnType<typeof fakeDaemon>, "daemon" | "send">,
  sequence: number,
  items: readonly (typeof TimelineItem.Encoded)[],
  timeline: typeof Timeline.Encoded
) => {
  const held = fake.daemon.timelines.get("libera")?.find((one) => one.timeline.id === iirc);

  fake.daemon.through = sequence;
  fake.daemon.timelines.set("libera", [
    ...(fake.daemon.timelines.get("libera") ?? []).filter((one) => one !== held),
    { gaps: [], items: [...(held?.items ?? []), ...items], timeline },
  ]);
  fake.send({
    data: JSON.stringify({
      dropped: [],
      gaps: [],
      items,
      merged: [],
      removals: [],
      sequence,
      timelines: [timeline],
    }),
    event: "changed",
    id: `1.${sequence}`,
  });
};

/**
 * Presses the button with a name, as a click does.
 * @param name - Its name.
 */
const press = async (name: string) => {
  const button = [...document.querySelectorAll("button")].find((one) => one.textContent === name);

  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
};

/**
 * `#iirc` holding ten Messages, read up to the first, opened while the page is unfocused,
 * then scrolled up to its top, five rows tall, before the page takes the focus: the start,
 * the first Message, the "new" divider, and the second and third Messages are in view.
 * @param shared - `ui.unread.markRead` for every device.
 * @param device - `ui.unread.markRead` on this device, if it overrides it.
 * @returns What the Daemon was first asked to mark read.
 */
const readScrolledUp = async (shared: ReadRule, device?: ReadRule) => {
  const items = Array.from({ length: 10 }, (_, index) => message(index + 1));
  const { daemon, registry } = await signedIn([], items, { read: 1000 });

  await act(async () => {
    uiRead(registry, { options: { ...uiDefaults, "unread.markRead": shared }, sequence: 1 });
    registry.set(deviceUi, device === undefined ? {} : { "unread.markRead": device });
    registry.set(pageState, { compact: false, focused: false, visible: true });
    await Promise.resolve();
  });
  // The start, the day, ten items, and the "new" divider, each a row of 20, of which the
  // view shows the first six: up to the third item.
  layout.view = 120;
  layout.content = 260;
  await openFromPalette();
  await settled(() => registry.get(openTimeline)._tag === "Shown");
  await scrollTo(0, 260);
  await act(async () => {
    registry.set(pageState, { compact: false, focused: true, visible: true });
    await Promise.resolve();
  });
  await settled(() => daemon.reads.length > 0);

  return daemon.reads;
};

/**
 * The message of the day's folded line, in the open Timeline.
 * @returns Its button.
 */
const motdButton = () => logOf().querySelector<HTMLButtonElement>("button[aria-expanded]");

/**
 * What a run of joins shows as one line: its words, and whether it says it is open.
 * @returns Both.
 */
const foldedText = () => [motdButton()?.textContent, motdButton()?.getAttribute("aria-expanded")];

/**
 * The message of the day's text, while it is open.
 * @returns Its text.
 */
const motdBlock = () => logOf().querySelector("pre")?.textContent;

/**
 * The nicks a netsplit lists, while it is open.
 * @returns Their text.
 */
const nicks = () => logOf().querySelector("button[aria-expanded] ~ span")?.textContent;

/**
 * What the message of the day shows: its line's words, whether it says it is open, and its text.
 * @returns Them.
 */
const seen = () => [
  motdButton()?.textContent,
  motdButton()?.getAttribute("aria-expanded"),
  motdBlock(),
];

/**
 * A pointer's event at an x, as a mouse's first button gives it.
 * @param type - The event.
 * @param clientX - Where the pointer is.
 * @returns The event.
 */
const at = (type: string, clientX: number) =>
  new PointerEvent(type, { bubbles: true, cancelable: true, clientX, pointerId: 1 });

/**
 * The grip on the rule between nick and text, over the log.
 * @returns It, or none.
 */
const nickGrip = () => document.querySelector<HTMLElement>('[aria-label="resize nick column"]');

describe("what the view says it shows", () => {
  beforeEach(() => {
    layout.content = 0;
    layout.exact = undefined;
    layout.gutter = 0;
    layout.least = 576;
    layout.row = 20;
    layout.top = 0;
    layout.view = 500;
    layout.width = 800;
    layOut();
  });

  afterEach(() => {
    vi.useRealTimers();

    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("marks the last item read once it is in view above a Gap after it", async () => {
    const { daemon, registry } = await signedIn([{ count: 1, from: cursor(2500, 3), to: null }]);

    // The start, the day, the "new" divider, two items, and the Gap, each a row of 20: the
    // view shows the last item and the Gap below it.
    layout.view = 40;
    layout.content = 120;
    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await scrollTo(80, 120);
    await settled(() => daemon.reads.length === 1);

    expect(daemon.reads).toStrictEqual([{ read: 2000, timeline: iirc }]);
  });

  it("draws rows a screen beyond the view, so their Previews are asked for and loaded before they scroll in", async () => {
    const items = Array.from({ length: 100 }, (_, index) => message(index + 1));

    await signedIn([], items);

    // The view is forty rows tall, at the top of a Timeline of over a hundred.
    layout.view = 800;
    layout.content = 2100;
    await openFromPalette();
    await settled(() => logOf().querySelector("[data-index]") !== null);
    await scrollTo(0, 2100);
    await settled(() => logOf().querySelector("[data-index='0']") !== null);

    const indexes = [...logOf().querySelectorAll<HTMLElement>("[data-index]")].map((one) =>
      Number(one.dataset.index)
    );

    // Rows 0 to 39 are in view: very nearly the next forty are drawn below them, where
    // twenty-four rows reach only to the sixties.
    expect(Math.max(...indexes)).toBeGreaterThanOrEqual(75);
  });

  it("takes this device's ui.unread.markRead shown over asked, which every device shares", async () => {
    await expect(readScrolledUp("asked", "shown")).resolves.toStrictEqual([
      { read: 3000, timeline: iirc },
    ]);
  });

  it("reads older pages without scrolling while ui.timeline.activity hides every row of the latest, and marks read up to the row drawn", async () => {
    // One Message, then 250 joins: the latest two pages hold only joins.
    const items = [message(1), ...Array.from({ length: 250 }, (_, index) => joined(index + 2))];
    const { daemon, registry } = await signedIn([], items);

    await act(async () => {
      registry.set(deviceUi, { "timeline.activity": "quiet" });
      await Promise.resolve();
    });
    await openFromPalette();
    await settled(() => logOf().textContent?.includes("line 1"));
    await settled(() => daemon.reads.length > 0);

    expect({
      reads: daemon.reads,
      windows: daemon.windowsRead.map((query) => new URLSearchParams(query).has("before")),
    }).toStrictEqual({
      // Marked no further than the Message drawn, never a hidden join after it.
      reads: [{ read: 1000, timeline: iirc }],
      windows: [false, true, true],
    });
  });

  it("keeps the line read where it was when ui.timeline.activity hides or shows rows above it", async () => {
    // Messages at odd steps, joins at even ones, 60 in all: the start of the Timeline is
    // the first row, then the day, so step `n` is row `n + 1`.
    const items = Array.from({ length: 60 }, (_, index) =>
      index % 2 === 0 ? message(index + 1) : joined(index + 1)
    );

    const { registry } = await signedIn([], items);

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");

    // Scrolled back, with the join at step 20 at the top of the view, and line 21 below it,
    // past the "new" divider above the first unread row.
    await scrollTo(440, 100_000);

    const offsetOf = (text: string) => {
      const row = [...logOf().querySelectorAll<HTMLElement>("[data-index]")].find((one) =>
        one.textContent?.includes(text)
      );

      const start = Number(
        /translateY\((?<y>[\d.]+)px\)/u.exec(row?.style.transform ?? "")?.groups?.y
      );

      return start - logOf().scrollTop;
    };

    const before = offsetOf("line 21");

    await act(async () => {
      await act(async () => {
        registry.set(deviceUi, { "timeline.activity": "quiet" });
        await Promise.resolve();
      });
      await Promise.resolve();
    });

    const quiet = { offset: offsetOf("line 21"), top: logOf().scrollTop };

    await act(async () => {
      registry.set(deviceUi, {});
      await Promise.resolve();
    });

    expect({ again: offsetOf("line 21"), before, quiet }).toStrictEqual({
      again: 20,
      before: 20,
      // The join at the top hidden, line 19 before it takes its place, so line 21 stays
      // where it was, and the view stands ten rows higher with the joins above hidden.
      quiet: { offset: 20, top: 240 },
    });
  });

  it("never reads past the cap without asking, offers to on purpose, and jumps back to the latest, which it follows", async () => {
    // One Message, then 1,100 joins: past the cap, all hidden.
    const items = [message(1), ...Array.from({ length: 1100 }, (_, index) => joined(index + 2))];
    const fake = await signedIn([], items);
    const { daemon, registry } = fake;

    await act(async () => {
      registry.set(deviceUi, { "timeline.activity": "quiet" });
      await Promise.resolve();
    });
    await openFromPalette();

    // Read without asking up to the cap, with the latest kept, then held.
    await settled(() => logOf().textContent?.includes("Older history here is hidden activity"));
    const unasked = daemon.windowsRead.length;

    // Read on purpose: the newest go past the cap, and the Message is reached without
    // scrolling, with a way back to the latest.
    await press("load older");
    await settled(() => logOf().textContent?.includes("line 1"));

    const reached = {
      jump: document.body.textContent?.includes("jump to latest"),
      reads: [...daemon.reads],
    };

    // Something new arrives past the window, then the Owner jumps to the latest.
    const live = (sequence: number) => {
      fold(
        fake,
        sequence,
        [message(sequence)],
        listed(iirc, "#iirc", "Channel", {
          changed: sequence,
          latest: cursor(sequence * 1000, sequence),
          unread: {
            activity: 0,
            botDirect: 0,
            botMessages: 0,
            direct: 0,
            highlights: 0,
            messages: 1,
          },
        })
      );
    };

    live(1102);
    await press("jump to latest");
    await settled(() => logOf().textContent?.includes("line 1102"));
    await settled(() => daemon.reads.length === 1);

    // Following, a live Message after it is drawn and marked read too.
    live(1103);
    await settled(() => logOf().textContent?.includes("line 1103"));
    await settled(() => daemon.reads.length === 2);

    expect({
      jumpAfter: document.body.textContent?.includes("jump to latest"),
      reached,
      reads: daemon.reads,
      unasked,
    }).toStrictEqual({
      jumpAfter: false,
      reached: { jump: true, reads: [] },
      reads: [
        { read: 1_102_000, timeline: iirc },
        { read: 1_103_000, timeline: iirc },
      ],
      // The latest, and nine pages before it: a thousand items.
      unasked: 10,
    });
  });

  it("keeps a row in view when ui.timeline.activity hides every row before it, anchoring to the next that shows", async () => {
    // A Message long ago, kicks 2 to 60, then Messages 61 to 120: the latest page begins
    // with 40 kicks, with more before it, read up to its latest so no divider shows.
    const items = Array.from({ length: 120 }, (_, index) =>
      index === 0 || index >= 60 ? message(index + 1) : kicked(index + 1)
    );

    const { registry } = await signedIn([], items, {
      read: 120_000,
      unread: { activity: 0, botDirect: 0, botMessages: 0, direct: 0, highlights: 0, messages: 0 },
    });

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");

    // The view tells the Owner's scrolls by how long ago their input was, and the virtualizer
    // ends a run of scrolls after a pause, so the clock stands still from here: on a busy
    // machine, real time would end the run between one step and the next.
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });

    // Kick 59, row 39, at the top of the view, and line 61 two rows below it.
    await scrollTo(780, 100_000);

    const offsetOf = (text: string) => {
      const row = [...logOf().querySelectorAll<HTMLElement>("[data-index]")].find((one) =>
        one.textContent?.includes(text)
      );

      const begins = Number(
        /translateY\((?<y>[\d.]+)px\)/u.exec(row?.style.transform ?? "")?.groups?.y
      );

      return begins - logOf().scrollTop;
    };

    const before = offsetOf("line 61");

    await act(async () => {
      await act(async () => {
        registry.set(deviceUi, { "timeline.activity": "none" });
        await Promise.resolve();
      });
      await Promise.resolve();
    });

    const clamped = logOf().scrollTop;

    // As a browser does once scrolled, the virtualizer draws where the view now stands, and
    // near the top, the page before is asked for and kept above without moving line 61.
    await act(async () => {
      logOf().dispatchEvent(new Event("scroll"));
      await Promise.resolve();
    });

    // Every row before it hidden, line 61 is the first after the day's, scrolled no higher
    // than the top. The day's row, new to the view, is as tall as it is estimated to be: a
    // line, and the room between rows.
    expect({ before, clamped, quiet: offsetOf("line 61") }).toStrictEqual({
      before: 40,
      clamped: 0,
      quiet: 25,
    });
  });

  it("reads on once a Pane that could not be seen is shown again", async () => {
    const items = [message(1), ...Array.from({ length: 250 }, (_, index) => joined(index + 2))];
    const { daemon, registry } = await signedIn([], items);

    await act(async () => {
      registry.set(deviceUi, { "timeline.activity": "quiet" });
      await Promise.resolve();
    });
    layout.view = 0;
    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");

    // Shown again, as a Pane moved back into the page is: it lays out and reads on.
    layout.view = 500;
    await act(async () => {
      logOf().closest("[data-pane-host]")?.dispatchEvent(new Event(movedEvent));
      await Promise.resolve();
    });
    // Both pages before are read, until the Message: the page before them holds it.
    await settled(() => daemon.windowsRead.length === 3);

    expect(daemon.windowsRead).toHaveLength(3);
  });

  it("reads on once the view is resized to be seen, with no move", async () => {
    // A ResizeObserver that reports only when told, for the log alone.
    const told: ((entries: readonly never[]) => void)[] = [];

    // oxlint-disable-next-line typescript/no-extraneous-class -- it stands in for the browser's class.
    class Observer {
      readonly #report: (entries: readonly never[]) => void;

      constructor(report: (entries: readonly never[]) => void) {
        this.#report = report;
      }

      observe(element: Element) {
        if (isLog(element)) {
          told.push(this.#report);
        }
      }

      unobserve() {
        return this;
      }

      disconnect() {
        return this;
      }
    }

    Reflect.set(globalThis, "ResizeObserver", Observer);

    try {
      const items = [message(1), ...Array.from({ length: 250 }, (_, index) => joined(index + 2))];
      const { daemon, registry } = await signedIn([], items);

      await act(async () => {
        registry.set(deviceUi, { "timeline.activity": "quiet" });
        await Promise.resolve();
      });
      layout.view = 0;
      await openFromPalette();
      await settled(() => registry.get(openTimeline)._tag === "Shown");

      // Only its size changes: the observer reports it, and it reads on.
      layout.view = 500;
      await act(async () => {
        for (const report of told) {
          report([]);
        }

        await Promise.resolve();
      });
      await settled(() => daemon.windowsRead.length === 3);

      expect(told.length).toBeGreaterThan(0);
    } finally {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  it("draws no Gap before the first item of a Timeline read to its start, and one still open stays", async () => {
    const closed = await signedIn([{ count: 1, from: cursor(500, 1), to: cursor(800, 1) }]);

    await openFromPalette();
    await settled(() => closed.registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 2"));

    const withClosed = logOf().textContent;

    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    const open = await signedIn([{ count: 1, from: cursor(500, 1), to: null }]);

    await openFromPalette();
    await settled(() => open.registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 2"));

    expect({
      closed: withClosed?.includes("not connected"),
      open: logOf().textContent?.includes("not connected since"),
      start: withClosed?.includes("The start of this conversation"),
    }).toStrictEqual({ closed: false, open: true, start: true });
  });

  it("tells a screen reader a Timeline read to its start has nothing before its first line, and draws no words there", async () => {
    const { registry } = await signedIn();

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 2"));

    const said = [...logOf().querySelectorAll<HTMLElement>("p")].find(
      (one) => one.textContent === "The start of this conversation"
    );

    const style = said === undefined ? undefined : getComputedStyle(said);

    // Read in the log, as the first of its rows, and taken out of what is drawn.
    expect({
      clip: style?.clipPath,
      first: said?.closest<HTMLElement>("[data-index]")?.dataset.index,
      position: style?.position,
    }).toStrictEqual({ clip: "inset(50%)", first: "0", position: "absolute" });
  });

  it("says nothing of a Message of ours the Ircd cannot confirm, and says one not sent", async () => {
    const { registry } = await signedIn(
      [],
      [
        message(1, { delivery: { _tag: "Unconfirmed" }, intent: "web-1" }),
        message(2, { delivery: { _tag: "Unsent" }, intent: "web-2" }),
      ]
    );

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 2"));

    const text = logOf().textContent ?? "";

    expect({
      notSent: text.includes("not sent"),
      unconfirmed: text.includes("unconfirmed"),
    }).toStrictEqual({ notSent: true, unconfirmed: false });
  });

  it("draws a FAIL as a refusal, and a WARN or a NOTE not", async () => {
    const { registry } = await signedIn(
      [],
      [
        reply(1, "WARN", "INVALID_UTF8", ["#iirc"], "Modified"),
        reply(2, "NOTE", "QUEUED", [], "Held"),
        reply(3, "FAIL", "TOO_FAST", ["#iirc"], "Slow down"),
      ]
    );

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("Slow down"));

    const rows = [...logOf().querySelectorAll<HTMLElement>("[data-index]")].filter((one) =>
      one.textContent?.includes("PRIVMSG")
    );

    // The words are the core's: the view's own part is the FAIL's tone, as a refusal.
    expect(rows.map((row) => row.querySelector("[class*='refused']") !== null)).toStrictEqual([
      false,
      false,
      true,
    ]);
  });

  it("shows an invitation in the Network's own Timeline, and joins the Channel only when its button is pressed", async () => {
    const invitation: typeof TimelineItem.Encoded = {
      ...joined(1),
      content: {
        _tag: "Activity",
        activity: { _tag: "Invited", by: "peer", channel: "#elsewhere" },
        at: { _tag: "Unknown" },
        id: { _tag: "Unknown" },
        live: true,
      },
      level: "Highlight",
      timeline: own,
    };

    const { daemon, registry } = await signedIn([], [], {}, [invitation]);

    await openFromPalette("libera");
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("invited you to"));

    const row = [...logOf().querySelectorAll<HTMLElement>("[data-index]")].find((one) =>
      one.textContent?.includes("invited you to")
    );

    const before = {
      channels: daemon.configurations.get("libera")?.configuration.channels,
      puts: daemon.puts.length,
      row: row?.textContent?.replace(/^\S+ /u, ""),
    };

    const button = row?.querySelector<HTMLButtonElement>('button[aria-label="Join #elsewhere"]');

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await settled(() => daemon.puts.length === 1);

    expect({
      after: daemon.configurations.get("libera")?.configuration.channels,
      before,
    }).toStrictEqual({
      after: [{ name: "#iirc" }, { name: "#elsewhere" }],
      before: {
        channels: [{ name: "#iirc" }],
        puts: 0,
        row: "-- peer invited you to #elsewhere join",
      },
    });
  });

  it("shows a message of the day as one folded line that a press opens to its lines and closes again", async () => {
    const motd: typeof TimelineItem.Encoded = {
      ...joined(1),
      content: {
        _tag: "Activity",
        activity: { _tag: "Motd", cut: true, lines: ["- Welcome", "-   spaced  out"] },
        at: { _tag: "Unknown" },
        id: { _tag: "Unknown" },
        live: true,
      },
      level: null,
      timeline: own,
    };

    const { registry } = await signedIn([], [], {}, [motd]);

    await openFromPalette("libera");
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().querySelector("button[aria-expanded]") !== null);

    const folded = seen();

    await act(async () => {
      motdButton()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await settled(() => motdBlock() !== undefined);

    const opened = seen();

    await act(async () => {
      motdButton()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await settled(() => motdBlock() === undefined);

    expect([folded, opened, seen()]).toStrictEqual([
      ["\u25B8 Message of the day, 2 lines, cut short", "false", undefined],
      ["\u25BE Message of the day, 2 lines, cut short", "true", "Welcome\n  spaced  out"],
      ["\u25B8 Message of the day, 2 lines, cut short", "false", undefined],
    ]);
  });

  it("shows a netsplit as one folded line that a press opens to its nicks", async () => {
    const split: typeof TimelineItem.Encoded = {
      ...joined(1),
      content: {
        _tag: "Activity",
        activity: {
          _tag: "Netsplit",
          channel: "#iirc",
          nicks: ["alice", "bob", "carol"],
          servers: ["a.net", "b.net"],
        },
        at: { _tag: "Unknown" },
        id: { _tag: "Unknown" },
        live: true,
      },
    };

    const { registry } = await signedIn([], [split]);

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => motdButton() !== null);

    const folded = [foldedText(), nicks()];

    await act(async () => {
      motdButton()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await settled(() => nicks() !== undefined);

    expect([folded, [foldedText(), nicks()]]).toStrictEqual([
      [["\u25B8 netsplit a.net <-> b.net: 3 quit", "false"], undefined],
      [["\u25BE netsplit a.net <-> b.net: 3 quit", "true"], "alice, bob, carol"],
    ]);
  });

  it("shows joins in a row as one line that says how many and who, which a press opens to each and closes again", async () => {
    const items = [message(1), joined(2), joined(3), joined(4), message(5)];
    const { registry } = await signedIn([], items);

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => motdButton() !== null);

    const closed = foldedText();
    const hidden = logOf().textContent?.includes("user2 joined #iirc");

    await act(async () => {
      motdButton()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await settled(() => logOf().textContent?.includes("user2 joined #iirc"));

    const opened = [
      foldedText(),
      ["user2", "user3", "user4"].map((nick) => logOf().textContent?.includes(`${nick} joined`)),
    ];

    expect({ closed, hidden, opened }).toStrictEqual({
      closed: ["\u25B8 3 joined: user2, user3, user4", "false"],
      hidden: false,
      opened: [
        ["\u25BE 3 joined: user2, user3, user4", "true"],
        [true, true, true],
      ],
    });
  });

  it("shows what a reply answers above it, and goes to that Message when pressed", async () => {
    const original = {
      ...message(1),
      content: { ...message(1).content, sender: "alice", text: "the first thing" },
    };

    const answered = {
      kind: "Privmsg",
      position: original.position,
      sender: "alice",
      text: "the first thing",
    } as const;

    const items = [
      original,
      ...Array.from({ length: 4 }, (_, index) => message(index + 2)),
      replied(6, answered),
    ];

    const { daemon, registry } = await signedIn([], items);

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 6"));

    const row = [...logOf().querySelectorAll<HTMLElement>("[data-index]")].find((one) =>
      one.textContent?.includes("line 6")
    );

    const button = row?.querySelector<HTMLButtonElement>(
      'button[aria-label="Go to the replied message"]'
    );

    const before = {
      buttons: row?.querySelectorAll("button").length,
      quote: button?.textContent?.replaceAll(/[\u2066-\u2069]/gu, ""),
      reads: daemon.windowsRead.length,
    };

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await settled(() => {
      const shown = registry.get(openTimeline);

      return shown._tag === "Shown" && shown.window.target?.sequence === 1;
    });

    const shown = registry.get(openTimeline);

    expect({
      around: daemon.windowsRead.at(-1)?.includes("around="),
      before,
      following: shown._tag === "Shown" ? shown.window.following : undefined,
    }).toStrictEqual({
      around: true,
      before: { buttons: 1, quote: "\u21B3 alice: the first thing", reads: before.reads },
      following: false,
    });
  });

  it("shows a reply to an Action as an Action, and a reply that answers nothing held as a plain Message with no button", async () => {
    const answered = {
      kind: "Action",
      position: message(1).position,
      sender: "alice",
      text: "waves",
    } as const;

    const { registry } = await signedIn([], [replied(1, answered), replied(2, null)]);

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 2"));

    const rows = [...logOf().querySelectorAll<HTMLElement>("[data-index]")].filter((one) =>
      one.textContent?.includes("line ")
    );

    expect(
      rows.map((one) => [plain(one.querySelector("button")?.textContent), restOf(one)])
    ).toStrictEqual([
      ["\u21B3 * alice waves", "<peer> line 1"],
      [undefined, "<peer> line 2"],
    ]);
  });

  it("says which Channel a Direct Message is about", async () => {
    const { registry } = await signedIn(
      [],
      [replied(1, null, { answers: null, context: "#elsewhere" })]
    );

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 1"));

    const row = [...logOf().querySelectorAll<HTMLElement>("[data-index]")].find((one) =>
      one.textContent?.includes("line 1")
    );

    expect(row?.textContent?.replaceAll(/[\u2066-\u2069]/gu, "").replace(/^\S+ /u, "")).toBe(
      "<peer> line 1 in #elsewhere"
    );
  });

  // Catches a bot's Message drawn as any other's, or a mark on every Message.
  it("marks a Message a bot said by its sender, quietly, in a line and in a stacked run, and no other", async () => {
    const { registry } = await signedIn(
      [],
      [message(1, null, true), message(2, null, true), message(3)]
    );

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 3"));

    const inline = linesOf();

    await act(async () => {
      uiRead(registry, { options: { ...uiDefaults, "timeline.layout": "stacked" }, sequence: 1 });
      await Promise.resolve();
    });

    expect({ inline, stacked: linesOf() }).toStrictEqual({
      inline: ["T bot <peer> line 1", "T bot <peer> line 2", "T <peer> line 3"],
      // Line 2 continues the run, so the head alone says who it is, and line 3, which no bot
      // said, begins another, so it is never under a head that marks its sender.
      stacked: ["peer bot T line 1", "T line 2", "peer T line 3"],
    });
  });

  // Catches brackets that stay on a sender's nick when turned off, or that take a NOTICE's
  // or an action's marks with them, which are all that tell those kinds apart.
  it("draws a PRIVMSG's sender without brackets under ui.timeline.nickBrackets off, in columns and inline, a NOTICE's and an action's as they are, and a stacked head bare either way", async () => {
    const of = (sequence: number, kind: "Privmsg" | "Notice" | "Action") => {
      const item = message(sequence);

      return { ...item, content: { ...item.content, kind } };
    };

    const { registry } = await signedIn(
      [],
      [of(1, "Privmsg"), of(2, "Notice"), of(3, "Action"), message(4, null, true)]
    );

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 4"));

    const drawn = async (layout: "columns" | "inline" | "stacked", brackets: boolean) => {
      await act(async () => {
        registry.set(deviceUi, { "timeline.layout": layout, "timeline.nickBrackets": brackets });
        await Promise.resolve();
      });

      return linesOf();
    };

    expect({
      columns: await drawn("columns", false),
      inline: await drawn("inline", false),
      on: await drawn("columns", true),
      stacked: await drawn("stacked", true),
      stackedOff: await drawn("stacked", false),
    }).toStrictEqual({
      columns: ["T peer line 1", "T -peer- line 2", "T * peer line 3", "T bot peer line 4"],
      inline: ["T peer line 1", "T -peer- line 2", "T * peer line 3", "T bot peer line 4"],
      on: ["T <peer> line 1", "T -peer- line 2", "T * peer line 3", "T bot <peer> line 4"],
      stacked: ["peer T line 1", "T -peer- line 2", "T * peer line 3", "peer bot T line 4"],
      stackedOff: ["peer T line 1", "T -peer- line 2", "T * peer line 3", "peer bot T line 4"],
    });
  });

  // Catches a sender's prefix missing, drawn outside the brackets, or taken for part of the
  // nick, in any layout and for any kind, or still drawn once ui.timeline.nickPrefix is off.
  it("draws the prefix its sender held before their nick, inside any brackets, in each layout and for each kind, and nothing once ui.timeline.nickPrefix is off or they held none", async () => {
    const { registry } = await signedIn(
      [],
      [
        heldBy(1, "@"),
        heldBy(2, "@", "Notice"),
        heldBy(3, "@", "Action"),
        heldBy(4, null),
        heldBy(5, "+", "Privmsg", true),
      ]
    );

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 5"));

    const drawn = async (layout: "columns" | "inline" | "stacked", prefix: boolean) => {
      await act(async () => {
        registry.set(deviceUi, { "timeline.layout": layout, "timeline.nickPrefix": prefix });
        await Promise.resolve();
      });

      return linesOf();
    };

    expect({
      columns: await drawn("columns", true),
      inline: await drawn("inline", true),
      names: nicksOf(),
      off: await drawn("columns", false),
      stacked: await drawn("stacked", true),
    }).toStrictEqual({
      columns: [
        "T <@peer> line 1",
        "T -@peer- line 2",
        "T * @peer line 3",
        "T <peer> line 4",
        "T bot <+peer> line 5",
      ],
      inline: [
        "T <@peer> line 1",
        "T -@peer- line 2",
        "T * @peer line 3",
        "T <peer> line 4",
        "T bot <+peer> line 5",
      ],
      names: ["peer", "peer", "peer", "peer", "peer"],
      off: [
        "T <peer> line 1",
        "T -peer- line 2",
        "T * peer line 3",
        "T <peer> line 4",
        "T bot <peer> line 5",
      ],
      stacked: [
        "@peer T line 1",
        "T -@peer- line 2",
        "T * @peer line 3",
        "peer T line 4",
        "+peer bot T line 5",
      ],
    });
  });

  // Catches a name in a Message's text drawn plain, in the slot of the wrong text, or over the
  // colour its sender chose for it.
  it("draws a name its Message's text holds in that nick's colour, unless a mIRC colour covers it", async () => {
    const { registry } = await signedIn(
      [],
      [
        naming(1, "hi alice and \u000304bob\u0003", [
          { end: 8, start: 3 },
          { end: 16, start: 13 },
        ]),
      ]
    );

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("alice"));

    expect({ alice: coloursOf("alice"), bob: coloursOf("bob") }).toStrictEqual({
      alice: [`var(--nick-${nickColour("alice")})`],
      bob: ["var(--irc-4)"],
    });
  });

  // Catches the sender's nick drawn anew as its prefix comes or goes, from another device's
  // change, which would take focus, and an open menu, from it.
  it("keeps focus on a sender's nick as ui.timeline.nickPrefix turns off and on", async () => {
    const { registry } = await signedIn([], [heldBy(1, "@")]);

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 1"));

    const nick = logOf().querySelector<HTMLElement>('[aria-haspopup="menu"][role="button"]');

    nick?.focus();

    const focused = nick !== null && document.activeElement === nick;

    const kept = async (prefix: boolean) => {
      await act(async () => {
        registry.set(deviceUi, { "timeline.nickPrefix": prefix });
        await Promise.resolve();
      });

      return document.activeElement === nick;
    };

    expect({ focused, off: await kept(false), on: await kept(true) }).toStrictEqual({
      focused: true,
      off: true,
      on: true,
    });
  });

  // Catches the sender's nick drawn anew as brackets come or go, from another device's change,
  // which would take focus, and an open menu, from it.
  it("keeps focus on a sender's nick as ui.timeline.nickBrackets turns off and on", async () => {
    const { registry } = await signedIn();

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 2"));

    const nick = logOf().querySelector<HTMLElement>('[aria-haspopup="menu"][role="button"]');

    nick?.focus();

    const focused = nick !== null && document.activeElement === nick;

    const kept = async (brackets: boolean) => {
      await act(async () => {
        registry.set(deviceUi, { "timeline.nickBrackets": brackets });
        await Promise.resolve();
      });

      return document.activeElement === nick;
    };

    expect({ focused, off: await kept(false), on: await kept(true) }).toStrictEqual({
      focused: true,
      off: true,
      on: true,
    });
  });

  // Catches a "new" divider still drawn above what only bots said, once the Owner quieted them.
  it('draws no "new" divider above what only bots said while bots are quieted', async () => {
    const { registry } = await signedIn([], [message(1, null, true), message(2, null, true)], {
      unread: { activity: 0, botDirect: 0, botMessages: 2, direct: 0, highlights: 0, messages: 0 },
    });

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 2"));

    const loud = dividedNow();

    await act(async () => {
      uiRead(registry, { options: { ...uiDefaults, "unread.quietBots": true }, sequence: 1 });
      await Promise.resolve();
    });

    expect({ loud, quiet: dividedNow() }).toStrictEqual({ loud: true, quiet: false });
  });

  // Catches a grip on the rule that writes at every step, or none, or one left where no
  // rule is drawn to resize.
  it("lays one grip over the rule in columns, none inline or stacked, and a drag writes ui.timeline.nickWidth once, as it ends", async () => {
    const { daemon, registry } = await signedIn();

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 2"));

    const grips = document.querySelectorAll('[aria-label="resize nick column"]').length;

    // Right widens it, three `0`s.
    await act(async () => {
      nickGrip()?.dispatchEvent(at("pointerdown", 200));
      nickGrip()?.dispatchEvent(at("pointermove", 210));
      nickGrip()?.dispatchEvent(at("pointermove", 224));
      await Promise.resolve();
    });

    const moving = {
      changes: daemon.uiChanges.length,
      now: nickGrip()?.getAttribute("aria-valuenow"),
    };

    await act(async () => {
      nickGrip()?.dispatchEvent(at("pointerup", 224));
      await Promise.resolve();
    });
    await settled(() => daemon.ui.options["timeline.nickWidth"] === 19);

    const shown = (layout: "inline" | "stacked") => async () => {
      await act(async () => {
        registry.set(deviceUi, { "timeline.layout": layout });
        await Promise.resolve();
      });

      return nickGrip() === null;
    };

    expect({
      changes: daemon.uiChanges.map((one) => one.route),
      grips,
      inline: await shown("inline")(),
      moving,
      stacked: await shown("stacked")(),
    }).toStrictEqual({
      changes: ["PUT timeline.nickWidth"],
      grips: 1,
      inline: true,
      moving: { changes: 0, now: "19" },
      stacked: true,
    });
  });

  it("keeps a space between the parts of a row, so it reads as one run when the columns go", async () => {
    const { registry } = await signedIn();

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 2"));

    const row = [...logOf().querySelectorAll<HTMLElement>("[data-index]")].find((one) =>
      one.textContent?.includes("line 2")
    );

    expect(row?.textContent).toMatch(/^\S+ <\S+> line 2$/u);
  });

  it("says a line's date and time on hover as ui.timeline.timeFormat says, and no time under none", async () => {
    // Local mid-afternoon, so no form of the clock writes it as another does.
    const said = new Date(2026, 10, 15, 15, 7, 9);

    const at = (item: typeof TimelineItem.Encoded) => ({
      ...item,
      position: cursor(said.getTime(), item.sequence),
    });

    const { registry } = await signedIn([], [at(message(1)), at(message(2))]);

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 2"));

    const drawn = async (time: TimeShown) => {
      await act(async () => {
        registry.set(deviceUi, { "timeline.timeFormat": time });
        await Promise.resolve();
      });

      return logOf().querySelector<HTMLElement>("time[title]")?.title;
    };

    const written = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        ...options,
      }).format(said);

    const twentyFour = { hour: "2-digit", hourCycle: "h23", minute: "2-digit" } as const;
    const twelve = { hour: "numeric", hourCycle: "h12", minute: "2-digit" } as const;

    const titles = {
      none: await drawn("none"),
      twelve: await drawn("h:mm a"),
      twentyFour: await drawn("HH:mm"),
    };

    expect(titles).toStrictEqual({
      // Under none a line has no time to hover.
      none: undefined,
      twelve: written(twelve),
      twentyFour: written(twentyFour),
    });
  });

  it("draws a run under one nick under ui.timeline.layout stacked, each later Message its text with its time kept, until Activity ends it", async () => {
    const { registry } = await signedIn([], [message(1), message(2), joined(3), message(4)]);

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 4"));

    await act(async () => {
      uiRead(registry, { options: { ...uiDefaults, "timeline.layout": "stacked" }, sequence: 1 });
      await Promise.resolve();
    });

    const rows = [...logOf().querySelectorAll<HTMLElement>("[data-index]")].filter((one) =>
      one.textContent?.includes("line ")
    );

    expect({
      line: logOf().dataset.line,
      rows: rows.map((one) => [
        plain(one.querySelector("bdi")?.textContent),
        one.querySelector("time")?.getAttribute("tabindex") ?? null,
        // A tap focuses a later Message's row, which shows its time where nothing can be hovered.
        one.querySelector(":scope > div > div")?.getAttribute("tabindex") ?? null,
        // The time is the device's zone's, so only where it stands is compared.
        plain(one.textContent)?.replaceAll(/\d{1,2}:\d{2}/gu, "T"),
      ]),
    }).toStrictEqual({
      line: "stacked",
      rows: [
        ["peer", null, null, "peer T line 1"],
        ["line 2", "0", "-1", "T line 2"],
        ["peer", null, null, "peer T line 4"],
      ],
    });
  });

  it("puts what a run's head answers under its nick under ui.timeline.layout stacked, and a later Message's above its text", async () => {
    const answered = {
      kind: "Privmsg",
      position: message(1).position,
      sender: "alice",
      text: "the first thing",
    } as const;

    const original = {
      ...message(1),
      content: { ...message(1).content, sender: "alice", text: "the first thing" },
    };

    const { registry } = await signedIn([], [original, replied(2, answered), replied(3, answered)]);

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 3"));

    await act(async () => {
      uiRead(registry, { options: { ...uiDefaults, "timeline.layout": "stacked" }, sequence: 1 });
      await Promise.resolve();
    });

    const rows = [...logOf().querySelectorAll<HTMLElement>("[data-index]")].filter((one) =>
      one.textContent?.includes("line ")
    );

    // The time is the device's zone's, so only where it stands is compared.
    expect(
      rows.map((one) => plain(one.textContent)?.replaceAll(/\d{1,2}:\d{2}/gu, "T"))
    ).toStrictEqual([
      "peer T \u21B3 alice: the first thing line 2",
      "\u21B3 alice: the first thing T line 3",
    ]);
  });

  describe("where the day changes", () => {
    // Local noon on three days, the last two on consecutive days, so no zone moves one across midnight.
    const days = [
      new Date(2026, 10, 14, 12),
      new Date(2026, 10, 15, 12),
      new Date(2026, 10, 15, 13),
    ];

    const onDays = days.map((day, index) => ({
      ...message(index + 1),
      position: cursor(day.getTime(), index + 1),
    }));

    const opened = async () => {
      const found = await signedIn([], onDays);

      await openFromPalette();
      await settled(() => found.registry.get(openTimeline)._tag === "Shown");
      await settled(() => logOf().textContent?.includes("line 3"));

      return found;
    };

    it("is a line at the top and between items of different days, in the Owner's words for a day", async () => {
      await opened();

      const full = new Intl.DateTimeFormat(undefined, { dateStyle: "full" });

      expect(dayLines()).toStrictEqual([
        [full.format(days[0]), "2026-11-14"],
        [full.format(days[1]), "2026-11-15"],
      ]);

      // The rows that are a day or a line, in order, apart from the start and the "new" divider.
      const order = [...logOf().querySelectorAll<HTMLElement>("[data-index]")].flatMap((row) => {
        if (row.querySelector("p time[datetime]") !== null) {
          return ["day"];
        }

        const text = row.textContent?.replace(/^\S+ /u, "") ?? "";

        return text.startsWith("<peer>") ? [text] : [];
      });

      expect(order).toStrictEqual([
        "day",
        "<peer> line 1",
        "day",
        "<peer> line 2",
        "<peer> line 3",
      ]);
    });

    it("is written as ui.timeline.dateFormat says", async () => {
      const { registry } = await opened();

      await act(async () => {
        registry.set(deviceUi, { "timeline.dateFormat": "iso" });
        await Promise.resolve();
      });

      expect(dayLines()).toStrictEqual([
        ["2026-11-14", "2026-11-14"],
        ["2026-11-15", "2026-11-15"],
      ]);
    });
  });
});

/** What a ResizeObserver reports of a box, as much of it as the page reads. */
interface Observed {
  readonly borderBoxSize: readonly { readonly blockSize: number; readonly inlineSize: number }[];
  readonly contentRect: DOMRect;
  readonly target: Element;
}

/** How a ResizeObserver reports. */
type Report = (entries: readonly Observed[]) => void;

/** What each ResizeObserver the page made watches, and how it reports. */
const observers = new Set<{ readonly report: Report; readonly watched: Set<Element> }>();

/** A ResizeObserver that reports only when told, as the browser's does after a layout. */
// oxlint-disable-next-line typescript/no-extraneous-class -- it stands in for the browser's class.
class Observer {
  readonly #own: { readonly report: Report; readonly watched: Set<Element> };

  constructor(report: Report) {
    this.#own = { report, watched: new Set() };
    observers.add(this.#own);
  }

  observe(element: Element) {
    this.#own.watched.add(element);
  }

  unobserve(element: Element) {
    this.#own.watched.delete(element);
  }

  disconnect() {
    this.#own.watched.clear();
  }
}

/**
 * How tall the log's rows are laid out, with the room under the last, which is less than a row.
 * @returns The height, in pixels.
 */
const rowsHeight = () =>
  Number(logOf().querySelector<HTMLElement>(":scope > div")?.style.height.replace("px", "") ?? 0);

/**
 * Lays the log out again, as a browser does once its width or text size changed: every row
 * at a new height, what it holds as tall as they are, and each observer of the log or its
 * rows told of their boxes.
 * @param row - How tall each row is now.
 */
const wrapAgain = async (row: number) => {
  const count = Math.floor(rowsHeight() / layout.row);

  layout.row = row;
  layout.content = count * row;

  await act(async () => {
    for (const { report, watched } of observers) {
      const entries = [...watched].flatMap((target) => {
        const isRow = target instanceof HTMLElement && Object.hasOwn(target.dataset, "index");
        const height = isLog(target) ? layout.view : row;

        return target.isConnected && (isLog(target) || isRow)
          ? [
              {
                borderBoxSize: [{ blockSize: height, inlineSize: layout.exact ?? layout.width }],
                contentRect: new DOMRect(
                  0,
                  0,
                  (layout.exact ?? layout.width) - layout.gutter,
                  height
                ),
                target,
              },
            ]
          : [];
      });

      if (entries.length > 0) {
        report(entries);
      }
    }

    await Promise.resolve();
  });
};

/**
 * Lays the least row in columns out again, as a browser does once the font, the text's size,
 * the time's format, or the nick column changed, and tells each observer of it.
 * @param least - How wide it is now.
 */
const columnsTake = async (least: number) => {
  layout.least = least;

  await act(async () => {
    for (const { report, watched } of observers) {
      const entries = [...watched].flatMap((target) =>
        target.isConnected && isLeast(target)
          ? [
              {
                borderBoxSize: [{ blockSize: 0, inlineSize: least }],
                contentRect: new DOMRect(0, 0, least, 0),
                target,
              },
            ]
          : []
      );

      if (entries.length > 0) {
        report(entries);
      }
    }

    await Promise.resolve();
  });
};

/**
 * The first row whose top is in view, by what it says, and how far below the top it starts.
 * @returns It.
 */
const firstInView = () => {
  const rows = [...logOf().querySelectorAll<HTMLElement>("[data-index]")].map((row) => ({
    offset:
      Number(/translateY\((?<y>[\d.]+)px\)/u.exec(row.style.transform)?.groups?.y) -
      logOf().scrollTop,
    text: /line \d+/u.exec(row.textContent ?? "")?.[0],
  }));

  return rows.toSorted((one, other) => one.offset - other.offset).find((row) => row.offset >= 0);
};

/**
 * `#iirc` with sixty Messages, open and laid out at its latest.
 * @returns The fake, and the registry.
 */
const opened = async () => {
  const fake = await signedIn(
    [],
    Array.from({ length: 60 }, (_, index) => message(index + 1))
  );

  await openFromPalette();
  await settled(() => fake.registry.get(openTimeline)._tag === "Shown");
  // Laid out as tall as its rows, and at the bottom, where it opens.
  await wrapAgain(20);
  await scrollTo(layout.content, layout.content);
  await settled(() => logOf().textContent?.includes("line 60"));

  return fake;
};

/**
 * Whether the core holds the open Timeline as following its latest.
 * @param registry - The registry.
 * @returns Whether it does.
 */
const following = (registry: Awaited<ReturnType<typeof opened>>["registry"]) => {
  const shown = registry.get(openTimeline);

  return shown._tag === "Shown" && shown.window.following;
};

/**
 * How far the log is from its end, as the Owner sees it.
 * @returns The distance.
 */
const fromEnd = () => layout.content - logOf().scrollTop - layout.view;

/**
 * The Owner gives input to the log that may scroll it: the wheel, a key that scrolls, or a
 * press, as on its scrollbar.
 * @param kind - Which.
 */
const give = async (kind: "wheel" | "key" | "pointer") => {
  const events = {
    key: () => new KeyboardEvent("keydown", { bubbles: true, key: "PageUp" }),
    pointer: () => new PointerEvent("pointerdown", { bubbles: true }),
    wheel: () => new WheelEvent("wheel", { bubbles: true, deltaY: -100 }),
  };

  await act(async () => {
    logOf().dispatchEvent(events[kind]());
    await Promise.resolve();
  });
};

/**
 * A Message said in `#iirc` as it is followed.
 * @param fake - The fake Daemon.
 * @param sequence - Its step.
 */
const live = (fake: Awaited<ReturnType<typeof opened>>, sequence: number) => {
  fold(
    fake,
    sequence,
    [message(sequence)],
    listed(iirc, "#iirc", "Channel", {
      changed: sequence,
      latest: cursor(sequence * 1000, sequence),
      unread: { activity: 0, botDirect: 0, botMessages: 0, direct: 0, highlights: 0, messages: 1 },
    })
  );
};

describe("where the view stands as its rows wrap again", () => {
  beforeEach(() => {
    layout.content = 0;
    layout.row = 20;
    layout.top = 0;
    layout.view = 400;
    layout.width = 800;
    layOut();
    observers.clear();
    Reflect.set(globalThis, "ResizeObserver", Observer);
    Reflect.set(window, "ResizeObserver", Observer);
  });

  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    Reflect.deleteProperty(globalThis, "ResizeObserver");
    Reflect.deleteProperty(window, "ResizeObserver");
  });

  it("keeps the first row in view where it was, just after the Owner scrolled up, and tells the core nothing new", async () => {
    const { daemon, registry } = await opened();

    // The Owner scrolls up, and the rows wrap again before the scroll has settled.
    await act(async () => {
      logOf().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -800 }));
      await Promise.resolve();
    });
    await scrollTo(410, layout.content);

    const before = {
      first: firstInView(),
      following: following(registry),
      reads: daemon.reads.length,
    };

    await wrapAgain(40);

    const taller = {
      first: firstInView(),
      following: following(registry),
      reads: daemon.reads.length,
    };

    await wrapAgain(20);

    const back = {
      first: firstInView(),
      following: following(registry),
      reads: daemon.reads.length,
    };

    expect({ back, taller }).toStrictEqual({ back: before, taller: before });
    expect(before.first?.offset).toBe(10);
  });

  it("keeps the last row as far from the Composer as from the row above, and never nearer than half the text's size", async () => {
    // Few enough rows that each is drawn and measured, as tall as it is laid out.
    const { registry } = await signedIn();

    await openFromPalette();
    await settled(() => logOf().textContent?.includes("line 2"));
    await wrapAgain(20);

    // Each row keeps half the room between rows under itself, and the log the rest.
    const under = async (spacing: number) => {
      await act(async () => {
        registry.set(deviceUi, { "timeline.spacing": spacing });
        await Promise.resolve();
      });

      return Math.round((rowsHeight() % layout.row) + (14 * spacing) / 2);
    };

    expect([await under(0), await under(0.3), await under(1), await under(1.5)]).toStrictEqual([
      7, 7, 14, 21,
    ]);
  });

  it("keeps the first row in view where it was as the room between rows changes, though rows above it were never measured", async () => {
    const { registry } = await signedIn(
      [],
      Array.from({ length: 100 }, (_, index) => message(index + 1))
    );

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await wrapAgain(20);
    await scrollTo(layout.content, layout.content);
    await settled(() => logOf().textContent?.includes("line 100"));

    // Far from the latest, past rows above the view that were never drawn, so never measured.
    await act(async () => {
      logOf().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -800 }));
      await Promise.resolve();
    });
    // What it holds is as tall as a browser would make it once the rows grow, so the view
    // may stand anywhere in it.
    await scrollTo(1600, 100_000);

    const before = firstInView();

    await act(async () => {
      registry.set(deviceUi, { "timeline.spacing": 1.5 });
      await Promise.resolve();
    });

    expect(firstInView()).toStrictEqual(before);
    expect(before?.text).toBeDefined();
  });

  it("draws every row of a Timeline too narrow for columns as one run of text from its first frame, and in columns once it is resized wide enough", async () => {
    // Its rows as the Timeline's first frame draws them, read as its log enters the page.
    const first: (string | undefined)[] = [];

    const entered = new MutationObserver(() => {
      const log = document.querySelector<HTMLElement>('[role="log"][aria-label*="#iirc"]');

      if (log !== null && first.length === 0) {
        first.push(log.dataset.line);
      }
    });

    entered.observe(document.body, { childList: true, subtree: true });
    layout.width = 400;

    try {
      await opened();
    } finally {
      entered.disconnect();
    }

    layout.width = 800;
    await wrapAgain(20);
    const wide = logOf().dataset.line;

    // A hair wider than thirty-six of its 16px em, which the DOM rounds down to them.
    layout.width = 576;
    layout.exact = 576.25;
    await wrapAgain(20);
    const justWide = logOf().dataset.line;

    // Wide enough with its scrollbar, which takes a little of it.
    layout.exact = undefined;
    layout.gutter = 15;
    layout.width = 580;
    await wrapAgain(20);
    const scrollbar = logOf().dataset.line;

    layout.gutter = 0;
    layout.width = 400;
    await wrapAgain(40);

    expect({ first, justWide, narrowAgain: logOf().dataset.line, scrollbar, wide }).toStrictEqual({
      first: ["inline"],
      justWide: undefined,
      narrowAgain: "inline",
      scrollbar: undefined,
      wide: undefined,
    });
  });

  it("draws its rows as one run of text once the columns would leave its text too little room, whatever widens them, and in columns again once they narrow", async () => {
    const { registry } = await opened();
    const columns = logOf().dataset.line;

    // A wider nick column, a larger size, or another font: the log's own box is as it was.
    await columnsTake(820);
    const wider = logOf().dataset.line;

    await columnsTake(600);
    const narrower = logOf().dataset.line;

    expect({ columns, narrower, wider }).toStrictEqual({
      columns: undefined,
      narrower: undefined,
      wider: "inline",
    });
    expect(following(registry)).toBeTruthy();
  });

  // Catches a nick drag that widens the columns past what the log holds: the rows going
  // inline took the grip from under the pointer and wrote the width mid-drag.
  it("stays in columns while the nick column is dragged wider than the log holds, writing the width once the pointer lets go, and nothing for a drag the browser cancels", async () => {
    const { daemon } = await opened();
    const grip = nickGrip();

    await act(async () => {
      grip?.dispatchEvent(at("pointerdown", 200));
      grip?.dispatchEvent(at("pointermove", 240));
      await Promise.resolve();
    });
    // As wide as the drag made the nick column: too wide for the log.
    await columnsTake(820);

    const held = {
      changes: daemon.uiChanges.length,
      grip: nickGrip() === grip,
      line: logOf().dataset.line,
    };

    await act(async () => {
      grip?.dispatchEvent(at("pointerup", 240));
      await Promise.resolve();
    });
    await settled(() => daemon.ui.options["timeline.nickWidth"] === 21);

    const released = logOf().dataset.line;

    await columnsTake(600);
    await act(async () => {
      nickGrip()?.dispatchEvent(at("pointerdown", 200));
      nickGrip()?.dispatchEvent(at("pointermove", 160));
      nickGrip()?.dispatchEvent(at("pointercancel", 160));
      await Promise.resolve();
    });

    expect({
      cancelled: nickGrip()?.getAttribute("aria-valuenow"),
      changes: daemon.uiChanges.map((one) => one.route),
      held,
      released,
    }).toStrictEqual({
      cancelled: "21",
      changes: ["PUT timeline.nickWidth"],
      held: { changes: 0, grip: true, line: undefined },
      released: "inline",
    });
  });

  it("stays at the latest as its rows wrap again, though the browser moved the log as its box changed", async () => {
    const { registry } = await opened();
    const bottom = () => layout.content - layout.view;
    const atLatest = { following: following(registry), top: logOf().scrollTop === bottom() };

    // The Owner's wheel just now did nothing, at the bottom. Narrowed, the rows overflow
    // before they are measured, and the browser moves the log by a pixel.
    await act(async () => {
      logOf().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 800 }));
      await Promise.resolve();
    });
    const top = logOf().scrollTop;

    layout.width = 400;
    layout.content += 80;
    await scrollTo(top - 1, layout.content);
    await wrapAgain(40);

    expect({ following: following(registry), top: logOf().scrollTop === bottom() }).toStrictEqual(
      atLatest
    );
    expect(atLatest).toStrictEqual({ following: true, top: true });
  });

  it.each([
    ["just before the log's box changed", "before"],
    ["just after the log's box changed, before the view stood in it again", "after"],
  ] as const)(
    "lets the Owner leave the latest by the wheel %s, and keeps them there as a Message arrives",
    async (_, order) => {
      const fake = await opened();
      const { registry } = fake;

      // Every row measured, as tall as it is laid out.
      await wrapAgain(20);
      await wrapAgain(20);

      // The composer grows a line, so the log is shorter, as the Owner wheels up by 200.
      const from = logOf().scrollTop;

      if (order === "before") {
        await give("wheel");
        layout.view = 340;
      } else {
        layout.view = 340;
        await give("wheel");
      }

      await scrollTo(from - 200, layout.content);
      // The frame after: the log's observer reports its new box.
      await wrapAgain(20);

      const left = { following: following(registry), fromEnd: fromEnd() };
      const top = logOf().scrollTop;

      // Away, the core leaves it beyond what the view draws, to be read on the way down.
      live(fake, 61);
      await settled(() => {
        const shown = registry.get(openTimeline);

        return shown._tag === "Shown" && shown.window.later;
      });
      await wrapAgain(20);

      expect({
        after: { following: following(registry), top: logOf().scrollTop },
        left,
      }).toStrictEqual({
        after: { following: false, top },
        // At the new end, then 200 up, as they wheeled.
        left: { following: false, fromEnd: 200 },
      });
    }
  );

  it.each(["key", "pointer"] as const)(
    "lets a continuing gesture by the %s stand as the log's box changes on every frame",
    async (kind) => {
      const { registry } = await opened();

      // Every row measured, and the end, once the log is 40 pixels shorter.
      await wrapAgain(20);
      await wrapAgain(20);
      const end = layout.content - 360;
      const tops: number[] = [];

      // A trackpad's momentum wheels on, a held Page Up repeats, a dragged scrollbar stays
      // pressed, while the log is 40 pixels shorter, then taller, then shorter again.
      for (const view of [360, 400, 360, 400]) {
        if (kind !== "pointer" || tops.length === 0) {
          // oxlint-disable-next-line no-await-in-loop -- one frame after another
          await give(kind);
        }

        const from = logOf().scrollTop;

        layout.view = view;
        // oxlint-disable-next-line no-await-in-loop -- one frame after another
        await scrollTo(from - 100, layout.content);
        // oxlint-disable-next-line no-await-in-loop -- one frame after another
        await wrapAgain(20);
        tops.push(logOf().scrollTop);
      }

      await act(async () => {
        window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        await Promise.resolve();
      });

      // From the new end, a hundred up on each frame.
      expect({ following: following(registry), tops }).toStrictEqual({
        following: false,
        tops: [end - 100, end - 200, end - 300, end - 400],
      });
    }
  );

  it("takes a scroll in a changed box as the browser's, once the view stood itself again since the Owner's input", async () => {
    const { registry } = await opened();

    // The Owner wheels up, and the scroll it makes is theirs.
    await give("wheel");
    await scrollTo(logOf().scrollTop - 200, layout.content);

    const reading = {
      first: firstInView(),
      following: following(registry),
      top: logOf().scrollTop,
    };

    // Within the second their wheel lets a scroll be theirs, the log is shorter, and the view
    // stands itself in it. Then it is taller, and the browser moves the log as it changes.
    layout.view = 360;
    await wrapAgain(20);
    const from = logOf().scrollTop;

    layout.view = 400;
    await scrollTo(from - 30, layout.content);

    expect({
      first: firstInView(),
      following: following(registry),
      top: logOf().scrollTop,
    }).toStrictEqual(reading);
    expect({ following: reading.following }).toStrictEqual({ following: false });
  });
});

/**
 * A Message from alice, with an id when given one.
 * @param sequence - Its sequence.
 * @param id - Its id, if it has one.
 * @returns The item.
 */
const fromAlice = (sequence: number, id?: string): typeof TimelineItem.Encoded => ({
  ...message(sequence),
  content: {
    _tag: "Message",
    answers: null,
    at: { _tag: "Unknown" },
    bot: false,
    context: null,
    id: id === undefined ? { _tag: "Unknown" } : { _tag: "Known", at: 1, from: "ircd", value: id },
    kind: "Privmsg",
    live: true,
    nicks: [],
    ours: null,
    prefix: null,
    sender: "alice",
    tags: [],
    target: "#iirc",
    text: `said ${sequence}`,
  },
});

/**
 * The log's row that says something.
 * @param text - What it says.
 * @returns The row.
 */
const rowSaying = (text: string) => {
  const found = [...logOf().querySelectorAll<HTMLElement>("[data-index]")].find((one) =>
    one.textContent?.includes(text)
  );

  if (found === undefined) {
    throw new Error(`no row: ${text}`);
  }

  return found;
};

/**
 * The button that opens the menu of alice's Message in a row.
 * @param row - The row.
 * @returns It, or none.
 */
const menuButtonIn = (row: HTMLElement) =>
  row.querySelector<HTMLButtonElement>('button[aria-label="More for the message from alice"]');

/**
 * The items of the menu open.
 * @returns Their words.
 */
const menuItems = () =>
  [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].map((one) => one.textContent);

/**
 * Chooses an item of the menu open, by its text, with Enter, as a browser's keys do.
 * @param text - Its text.
 */
const chooseFromMenu = async (text: string) => {
  await settled(() => document.querySelector('[role="menu"]') !== null);

  const item = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(
    (one) => one.textContent === text
  );

  await act(async () => {
    item?.focus();
    await Promise.resolve();
  });

  await act(async () => {
    for (const type of ["keydown", "keyup"]) {
      item?.dispatchEvent(
        new KeyboardEvent(type, { bubbles: true, cancelable: true, key: "Enter" })
      );
    }

    await Promise.resolve();
  });

  await settled(() => document.querySelector('[role="menu"]') === null);
};

/**
 * The composer's textarea.
 * @returns It.
 */
const composer = () => {
  const found = document.querySelector("textarea");

  if (found === null) {
    throw new Error("no composer");
  }

  return found;
};

/**
 * What the composer says it answers, without its button.
 * @returns Its words, or nothing.
 */
const answeringShown = () => {
  const group = document.querySelector('[aria-label^="Replying to"]');

  return plain(
    group?.textContent?.replace(group.querySelector("button")?.textContent ?? "", "").trim()
  );
};

/**
 * The Frontend signed in, with `#iirc` open, holding a Message from alice with an id and one
 * without.
 * @param tags - Whether the Network's Session carries tags.
 * @returns The fake, the registry, and the page.
 */
const aliceSaid = async (tags: boolean) => {
  const signed = await signedIn([], [fromAlice(1, "msg-1"), fromAlice(2)], {}, [], tags);

  await openFromPalette();
  await settled(() => signed.registry.get(openTimeline)._tag === "Shown");
  await settled(() => logOf().textContent?.includes("said 2") ?? false);

  return signed;
};

describe("replying to a Message", () => {
  beforeEach(() => {
    layout.content = 0;
    layout.row = 20;
    layout.top = 0;
    layout.view = 500;
    layout.width = 800;
    layOut();
  });

  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("offers reply from a Message's menu only where the Session carries tags and the Message has an id", async () => {
    await aliceSaid(false);

    const untagged = [menuButtonIn(rowSaying("said 1")), menuButtonIn(rowSaying("said 2"))];

    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    await aliceSaid(true);

    const tagged = [menuButtonIn(rowSaying("said 1")) !== null, menuButtonIn(rowSaying("said 2"))];

    await act(async () => {
      menuButtonIn(rowSaying("said 1"))?.click();
      await Promise.resolve();
    });
    await settled(() => document.querySelector('[role="menu"]') !== null);

    expect({ items: menuItems(), tagged, untagged }).toStrictEqual({
      items: ["reply"],
      tagged: [true, null],
      untagged: [null, null],
    });
  });

  it("opens a Message's menu from the context menu, and choosing reply shows what the composer answers, focused", async () => {
    await aliceSaid(true);

    await act(async () => {
      // Right-clicked on its text, as the context menu reaches the row from within it. The
      // nick before it opens the menu on the nick instead.
      [...rowSaying("said 1").querySelectorAll("bdi")]
        .find((one) => one.textContent.includes("said 1"))
        ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await chooseFromMenu("reply");
    await settled(() => answeringShown() !== undefined);

    expect({
      focused: document.activeElement === composer(),
      shown: answeringShown(),
    }).toStrictEqual({ focused: true, shown: "\u21B3 alice: said 1" });
  });

  it("drops what the composer answers by its button, and by Escape where Escape does nothing else", async () => {
    await aliceSaid(true);

    const choose = async () => {
      await act(async () => {
        menuButtonIn(rowSaying("said 1"))?.click();
        await Promise.resolve();
      });
      await chooseFromMenu("reply");
      await settled(() => answeringShown() !== undefined);
    };

    await choose();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="stop replying"]')?.click();
      await Promise.resolve();
    });
    const byButton = answeringShown();

    await choose();
    await act(async () => {
      composer().dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })
      );
      await Promise.resolve();
    });

    expect({ byButton, byEscape: answeringShown() }).toStrictEqual({
      byButton: undefined,
      byEscape: undefined,
    });
  });

  it("sends a draft of two lines answering the Message on its first only, and lets go of it", async () => {
    const { daemon } = await aliceSaid(true);

    await act(async () => {
      menuButtonIn(rowSaying("said 1"))?.click();
      await Promise.resolve();
    });
    await chooseFromMenu("reply");
    await settled(() => answeringShown() !== undefined);

    await act(async () => {
      const text = "yes\nit is";
      const field = composer();

      Reflect.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        field,
        text
      );
      field.setSelectionRange(text.length, text.length);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      composer().dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: "Enter",
          key: "Enter",
        })
      );
      await Promise.resolve();
    });
    await settled(() => daemon.says.length === 2);

    expect({
      said: daemon.says.map((one) => [one.text, one.answers]),
      shown: answeringShown(),
    }).toStrictEqual({
      said: [
        ["yes", "msg-1"],
        ["it is", undefined],
      ],
      shown: undefined,
    });
  });
});

/**
 * Six items a day, from 08:00 every two hours, over forty local days from 1 October 2026:
 * more than a window holds either side of any day's first item, and clear of any zone's
 * midnight. The first item of 21 October is line 121, of 25 October line 145.
 */
const spread = Array.from({ length: 240 }, (_, index) => ({
  ...message(index + 1),
  position: cursor(
    new Date(2026, 9, 1 + Math.floor(index / 6), 8 + 2 * (index % 6)).getTime(),
    index + 1
  ),
}));

/** How tall what the log holds is, tall enough to be scrolled to either end of any window. */
const tall = 6000;

/**
 * `#iirc` holding `spread`, opened at its latest.
 * @returns The fake, the registry, and the page.
 */
const spreadOpen = async () => {
  const found = await signedIn([], spread);

  layout.content = tall;
  await openFromPalette();
  await settled(() => found.registry.get(openTimeline)._tag === "Shown");
  await settled(() => logOf().textContent?.includes("line 141") ?? false);

  return found;
};

/**
 * The composer.
 * @returns It.
 */
const composerOf = () => {
  const found = document.querySelector<HTMLTextAreaElement>("textarea[data-composer]");

  if (found === null) {
    throw new Error("no composer");
  }

  return found;
};

/**
 * Writes text in the composer as typed.
 * @param text - The whole text.
 */
const typed = async (text: string) => {
  const field = composerOf();

  await act(async () => {
    Reflect.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      field,
      text
    );
    field.setSelectionRange(text.length, text.length);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    await Promise.resolve();
  });
};

/** Sends what the composer holds with Enter. */
const sentWithEnter = async () => {
  const field = composerOf();

  await act(async () => {
    field.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })
    );
    await Promise.resolve();
  });
  await settled(() => field.value === "");
};

/**
 * The text of the row the view marks as jumped to.
 * @returns What it says, or nothing.
 */
const targetRow = () =>
  plain(document.querySelector("[data-target]")?.textContent)?.replace(/^\S+ /u, "");

/**
 * Waits for the row jumped to to be drawn and marked, reporting the scroll a browser makes
 * of where the view put the log, which the Owner did not make.
 * @param text - What the row says.
 */
const landedOn = async (text: string) => {
  await settled(() => {
    logOf().dispatchEvent(new Event("scroll"));

    return targetRow() === text;
  });
};

/**
 * The Owner wheels the log to a position, which a browser reports as a scroll.
 * @param top - Where it ends.
 */
const ownerWheels = async (top: number) => {
  const log = logOf();

  await act(async () => {
    log.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: top - layout.top }));
    log.scrollTop = top;
    log.dispatchEvent(new Event("scroll"));
    await Promise.resolve();
  });
};

/**
 * What the Timeline was asked for.
 * @param windows - The queries of the windows read.
 * @returns Which of `around`, `before`, and `after` each had.
 */
const askedFor = (windows: readonly string[]) =>
  windows.map((query) => {
    const asked = new URLSearchParams(query);

    return ["around", "before", "after"].filter((name) => asked.has(name));
  });

/**
 * What the composer's list offers.
 * @returns Each option's text.
 */
const offered = () =>
  [...document.querySelectorAll('[role="listbox"][aria-label="Completions"] [role="option"]')].map(
    (one) => one.textContent
  );

describe("going to a date", () => {
  beforeEach(() => {
    layout.content = 0;
    layout.row = 20;
    layout.top = 0;
    layout.view = 500;
    layout.width = 800;
    layOut();
  });

  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("lists /date in the palette", async () => {
    await spreadOpen();

    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          key: "P",
          shiftKey: true,
        })
      );
      await Promise.resolve();
    });
    await settled(() => composerOf().value === "/");
    await typed("/da");
    await settled(() => offered().length > 0);

    expect(offered().some((text) => text?.includes("/date"))).toBeTruthy();
  });

  it("reads around a day typed and lands on its first item, or on the nearest end of the Timeline", async () => {
    const { daemon, registry } = await spreadOpen();
    const before = daemon.windowsRead.length;

    await typed("/date 2026-10-21");
    await sentWithEnter();
    await landedOn("<peer> line 121");

    const shown = registry.get(openTimeline);

    const day = {
      both: shown._tag === "Shown" && shown.window.earlier && shown.window.later,
      read: askedFor(daemon.windowsRead.slice(before)),
    };

    await typed("/date 1990-01-01");
    await sentWithEnter();
    await landedOn("<peer> line 1");

    const first = logOf().textContent?.includes("The start of this conversation");

    await typed("/date 2100-01-01");
    await sentWithEnter();
    await landedOn("<peer> line 240");

    expect({ day, first }).toStrictEqual({ day: { both: true, read: [["around"]] }, first: true });
  });

  it("reads newer without scrolling from a date before the start while ui.timeline.activity hides every row there", async () => {
    // 300 joins, then one Message: a jump before the start lands on more joins than a read gives.
    const items = [...Array.from({ length: 300 }, (_, index) => joined(index + 1)), message(301)];
    const { daemon, registry } = await signedIn([], items);

    await act(async () => {
      registry.set(deviceUi, { "timeline.activity": "quiet" });
      await Promise.resolve();
    });
    await openFromPalette();
    await settled(() => logOf().textContent?.includes("line 301"));
    // Before the first item in any zone, whose items are in the first minutes of 1970 UTC.
    await typed("/date 1969-12-30");
    await sentWithEnter();
    // Drawn with no scroll at all, since a log that draws nothing cannot be scrolled.
    await settled(() => targetRow() === "<peer> line 301");
    await landedOn("<peer> line 301");

    const shown = registry.get(openTimeline);

    // Read around the date, from the first join, then on from there to the Message.
    expect({
      asked: daemon.windowsRead.some((query) => new URLSearchParams(query).has("after")),
      later: shown._tag === "Shown" ? shown.window.later : undefined,
    }).toStrictEqual({ asked: true, later: false });
  });

  it("reads on from a date jumped to, older at the top and newer at the bottom, as after a search result", async () => {
    const { daemon, registry } = await spreadOpen();

    await typed("/date 2026-10-21");
    await sentWithEnter();
    await landedOn("<peer> line 121");

    const held = () => {
      const shown = registry.get(openTimeline);

      return shown._tag === "Shown"
        ? [shown.window.items.at(0)?.sequence ?? 0, shown.window.items.at(-1)?.sequence ?? 0]
        : [];
    };

    const jumped = held();
    const before = daemon.windowsRead.length;

    await ownerWheels(0);
    await settled(() => (held()[0] ?? 0) < (jumped[0] ?? 0));

    const older = askedFor(daemon.windowsRead.slice(before));

    await ownerWheels(tall - layout.view);
    await settled(() => (held()[1] ?? 0) > (jumped[1] ?? 0));

    expect({
      newer: askedFor(daemon.windowsRead.slice(before + older.length)),
      older,
      window: [jumped, held()],
    }).toStrictEqual({
      newer: [["after"]],
      older: [["before"]],
      window: [
        [71, 170],
        [1, 240],
      ],
    });
  });

  it("offers a day's line as /date with that day, focused, which lands on the day's first item", async () => {
    await spreadOpen();

    const [, second] = dayLines();

    const button = [
      ...logOf().querySelectorAll<HTMLButtonElement>('button[aria-label$="go to another day"]'),
    ].find((one) => one.querySelector("time")?.getAttribute("datetime") === second?.[1]);

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const field = composerOf();

    await settled(() => field.value.startsWith("/date "));

    const offer = { focused: document.activeElement === field, text: field.value };

    await sentWithEnter();
    await landedOn("<peer> line 145");

    expect(offer).toStrictEqual({ focused: true, text: "/date 2026-10-25" });
  });
});
