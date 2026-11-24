// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { TimelineId } from "@iirc/api";
import type { Member, TimeShown, Timeline } from "@iirc/api";
import { Schema } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/app.tsx";
import { deviceUi } from "../options/device.ts";
import { pageState } from "../page/atoms.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run } from "../testing/fake-daemon.ts";
import { back, left, pageEntered } from "../testing/history.ts";
import { open, sync } from "../timelines/atoms.ts";
import { channelSync } from "./atoms.ts";
import { channelState, membersShown, paneMeasured } from "./state.ts";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: (() => void)[] = [];

const idOf = (sequence: number) => `${sequence.toString(16).padStart(14, "0")}-00000000-00000000`;

const own = idOf(1);
const iirc = idOf(2);

// A topic a hostile Network could send: an override that would reverse what follows, and
// a word long enough to widen anything that let it.
const override = String.fromCodePoint(0x20_2e);
const hostileTopic = `${override}the plan https://example.com/plan ${"x".repeat(400)}`;

const listed = (
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

const unknownAccount = { _tag: "Unknown" } as const;
const unknownBot = { _tag: "Unknown" } as const;

const known = (value: string | null) => ({ _tag: "Known", at: 1, from: "ircd", value }) as const;

const member = (
  nick: string,
  prefixes: readonly string[] = [],
  account: typeof Member.Encoded.account = unknownAccount,
  bot: typeof Member.Encoded.bot = unknownBot
): typeof Member.Encoded => ({
  account,
  away: { _tag: "Known", at: 1, from: "ircd", value: null },
  bot,
  nick,
  prefixes: { _tag: "Known", at: 1, from: "ircd", value: [...prefixes] },
});

const settled = async (holds: () => boolean) => {
  await act(async () => {
    await eventually(holds);
  });
};

/**
 * A browser signed in to a Daemon with `#iirc` open, its topic hostile and set by `op`,
 * its members `op` and `peer`, the page drawn.
 * @param setAt - When the topic was set, if known.
 * @param people - Its members, `op` and `peer` unless given.
 * @param held - The prefix modes Self holds there, or none while they are not read.
 * @param opening - Whether `#iirc` is opened, or left listed in the Sidebar alone.
 * @returns The fake, the registry, and the page.
 */
const signedIn = async (
  setAt: number | null = null,
  people: readonly (typeof Member.Encoded)[] = [member("op", ["o"]), member("peer")],
  held: readonly string[] | null = null,
  opening = true
) => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: listed(own, "libera", "Network") },
    { gaps: [], items: [], timeline: listed(iirc, "#iirc", "Channel") },
  ]);
  fake.daemon.channels.set(iirc, {
    header: {
      accountBan: null,
      chanmodes: { always: "k", flags: "imnpst", list: "beI", whenSet: "l" },
      chantypes: "#&",
      held: held === null ? null : { _tag: "Known", at: 1, from: "ircd", value: [...held] },
      lists: { bans: "b", exceptions: "e", invitations: "I" },
      members: 2,
      modes: { _tag: "Known", at: 1, from: "ircd", value: [{ mode: "n", param: null }] },
      name: "#iirc",
      network: "libera",
      ranks: [
        { mode: "q", symbol: "~" },
        { mode: "o", symbol: "@" },
        { mode: "v", symbol: "+" },
      ],
      standing: "Joined",
      timeline: iirc,
      topic: {
        _tag: "Known",
        at: 1,
        from: "ircd",
        value: { setAt, setBy: "op", text: hostileTopic },
      },
    },
    members: [...people],
  });

  const registry = registryFor(fake.fetch);

  await run(registry, check, undefined);
  registry.mount(sync);
  registry.mount(channelSync);

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

  if (!opening) {
    return { ...fake, container, registry };
  }

  await act(async () => {
    registry.set(open, Schema.decodeSync(TimelineId)(iirc));
    await Promise.resolve();
  });
  await settled(() => container.querySelector('[role="log"]') !== null);

  return { ...fake, container, registry };
};

/**
 * The Pane's status bar.
 * @returns It, or none.
 */
const bar = () => document.querySelector<HTMLElement>('[data-pane="p0"] header');

/**
 * The Pane's members' toggle.
 * @returns It, or none.
 */
const toggle = () => bar()?.querySelector<HTMLElement>("[data-members-toggle]") ?? undefined;

/**
 * The members shown, as a column or over the Timeline.
 * @returns Them, or none.
 */
const members = () => document.querySelector<HTMLElement>('section[aria-label="members"]');

/**
 * What a disclosure's trigger controls.
 * @param trigger - The trigger.
 * @returns Its panel, or none.
 */
const panelOf = (trigger: HTMLElement | null | undefined) =>
  document.querySelector<HTMLElement>(`[id="${trigger?.getAttribute("aria-controls") ?? ""}"]`);

/**
 * Presses something, as React Aria hears a press with no pointer.
 * @param target - What is pressed.
 */
const press = async (target: HTMLElement | null | undefined) => {
  await act(async () => {
    target?.click();
    await Promise.resolve();
  });
};

/**
 * Presses a key on something, as the browser dispatches it.
 * @param target - What has the focus.
 * @param name - The key.
 */
const key = async (target: Element | null | undefined, name: string) => {
  await act(async () => {
    target?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: name })
    );
    target?.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: name })
    );
    await Promise.resolve();
  });
};

/**
 * Says how wide the Pane is, as the page measures it.
 * @param registry - The registry.
 * @param width - Its width in pixels.
 */
const measure = async (registry: Parameters<typeof paneMeasured>[0], width: number) => {
  await act(async () => {
    paneMeasured(registry, "p0", width);
    await Promise.resolve();
  });
};

/**
 * The grip on the members' edge, beside a Timeline.
 * @returns It, or none.
 */
const grip = () => document.querySelector<HTMLElement>('[aria-label="resize members"]');

/**
 * Has the page measure each of the font's `0` as eight pixels, from a grip's unseen measure
 * of a hundred beside it, and everything else as nothing, as happy-dom does.
 * @returns What puts the measure back.
 */
const zeroOfEight = () => {
  const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element
  ) {
    return new DOMRect(0, 0, this.previousElementSibling?.tagName === "HR" ? 800 : 0, 0);
  });

  return () => {
    spy.mockRestore();
  };
};

/**
 * A pointer's event at an x, as a mouse's first button gives it.
 * @param type - The event.
 * @param clientX - Where the pointer is.
 * @returns The event.
 */
const at = (type: string, clientX: number) =>
  new PointerEvent(type, { bubbles: true, cancelable: true, clientX, pointerId: 1 });

/**
 * Drags a grip from the first x to the last, through each between, as a pointer does.
 * @param target - The grip.
 * @param xs - Where the pointer is, from where it goes down to where it lets go.
 * @param between - Called once the pointer has moved, before it lets go.
 */
const drag = async (target: HTMLElement | null, xs: readonly number[], between?: () => void) => {
  await act(async () => {
    target?.dispatchEvent(at("pointerdown", xs[0] ?? 0));

    for (const x of xs.slice(1)) {
      target?.dispatchEvent(at("pointermove", x));
    }

    await Promise.resolve();
  });
  between?.();
  await act(async () => {
    target?.dispatchEvent(at("pointerup", xs.at(-1) ?? 0));
    await Promise.resolve();
  });
};

describe("a Pane's status bar", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("opens a Channel the Sidebar lists with its topic, modes and count in the first frame drawn", async () => {
    const { container, daemon, registry } = await signedIn(null, undefined, null, false);

    // Its head is read while it is only listed, before any Pane shows it.
    let held = true;

    await act(async () => {
      held = await eventually(
        () =>
          registry.get(channelState).get(Schema.decodeSync(TimelineId)(iirc))?.head.header !==
          undefined
      ).then(
        () => true,
        () => false
      );
    });

    // A read that opening it begins is held, so the bar shows only what was held before.
    daemon.holdChannels = true;

    // Every frame the bar is drawn in, from the one that opens it on.
    const frames: string[] = [];

    const drawn = () => {
      const text = bar()?.textContent;
      const count = toggle()?.getAttribute("aria-label");

      if (text !== undefined && count !== undefined && frames.at(-1) !== `${text} ${count}`) {
        frames.push(`${text} ${count}`);
      }
    };

    const observer = new MutationObserver(drawn);

    observer.observe(container, { characterData: true, childList: true, subtree: true });
    await act(async () => {
      registry.set(open, Schema.decodeSync(TimelineId)(iirc));
      await Promise.resolve();
    });
    drawn();
    await settled(() => container.querySelector('[role="log"]') !== null);
    drawn();
    observer.disconnect();
    daemon.holdChannels = false;

    for (const release of daemon.held.channel.splice(0)) {
      release();
    }

    expect({
      held,
      shows: frames.map((frame) => [
        frame.includes("+n"),
        frame.includes("the plan"),
        frame.endsWith("members, 2"),
      ]),
    }).toStrictEqual({ held: true, shows: frames.map(() => [true, true, true]) });
    expect(frames.length).toBeGreaterThan(0);
  });

  it("says the count once, in the toggle, and discloses the topic in full, isolated, under its one line", async () => {
    await signedIn();
    await settled(() => toggle()?.getAttribute("aria-label") === "members, 2");

    const topic = bar()?.querySelector<HTMLElement>("button[aria-expanded]");

    const closed = {
      expanded: topic?.getAttribute("aria-expanded"),
      isolated: topic?.querySelector("bdi")?.textContent.includes("the plan") === true,
      // The line is a button, so a link in the topic is only text there.
      links: topic?.querySelectorAll("a").length,
      // The count is said once, in the toggle, and no word "members" stands in the bar.
      said: bar()?.textContent.includes("members") === true,
      shown: panelOf(topic)?.hidden === false,
      toggle: [toggle()?.textContent, toggle()?.getAttribute("aria-pressed")],
    };

    await press(topic);
    await settled(() => topic?.getAttribute("aria-expanded") === "true");

    const panel = panelOf(topic);

    expect({
      closed,
      open: {
        isolated: panel?.querySelector("bdi")?.textContent.includes("the plan") === true,
        // Disclosed, the topic's link is a link.
        link: panel?.querySelector("a")?.getAttribute("href"),
        // Who set it stands in the topic's place on the bar.
        set: topic?.textContent === "set by op",
        visible: panel?.hidden !== true,
      },
    }).toStrictEqual({
      closed: {
        expanded: "false",
        isolated: true,
        links: 0,
        said: false,
        shown: false,
        toggle: ["◨2", "false"],
      },
      open: { isolated: true, link: "https://example.com/plan", set: true, visible: true },
    });
  });
});

describe("a topic's time", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("is drawn as ui.conversation.timeFormat says, HH:mm under none", async () => {
    // Local mid-afternoon, so no form of the clock writes it as another does.
    const set = new Date(2026, 10, 15, 15, 7, 9);
    const { registry } = await signedIn(set.getTime());

    await settled(() => toggle()?.getAttribute("aria-label") === "members, 2");

    const topic = bar()?.querySelector<HTMLElement>("button[aria-expanded]");

    await press(topic);
    await settled(() => topic?.getAttribute("aria-expanded") === "true");

    const drawn = async (time: TimeShown) => {
      await act(async () => {
        registry.set(deviceUi, { "conversation.timeFormat": time });
        await Promise.resolve();
      });

      return topic?.textContent;
    };

    const written = (options: Intl.DateTimeFormatOptions) =>
      `set by op, ${new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        ...options,
      }).format(set)}`;

    const twentyFour = { hour: "2-digit", hourCycle: "h23", minute: "2-digit" } as const;
    const twelve = { hour: "numeric", hourCycle: "h12", minute: "2-digit" } as const;

    const texts = { none: await drawn("none"), twelve: await drawn("h:mm a") };

    expect(texts).toStrictEqual({ none: written(twentyFour), twelve: written(twelve) });
    expect(texts.twelve).not.toBe(texts.none);
  });
});

describe("a Pane's members", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("lie over a narrow Pane's Timeline only when its toggle asks, and Escape, a press elsewhere, or widening puts them away", async () => {
    const { registry } = await signedIn();

    await settled(() => toggle() !== undefined);
    await measure(registry, 400);

    // The device's choice alone shows no members in a narrow Pane.
    await act(async () => {
      registry.set(membersShown, true);
      await Promise.resolve();
    });

    const chosen = { members: members() !== null, pressed: toggle()?.getAttribute("aria-pressed") };

    await press(toggle());
    await settled(() => members() !== null);

    const floating = {
      focused: document.activeElement === members(),
      pressed: toggle()?.getAttribute("aria-pressed"),
      under: members()?.closest("header") === null,
    };

    await key(members(), "Escape");
    await settled(() => members() === null);

    await press(toggle());
    await settled(() => members() !== null);
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await Promise.resolve();
    });
    await settled(() => members() === null);

    // Widened, the Pane shows the column the device chose, and narrowed again, nothing.
    await press(toggle());
    await settled(() => members() !== null);
    await measure(registry, 800);
    const wide = members() !== null;

    await measure(registry, 400);

    expect({ chosen, floating, narrowed: members() === null, wide }).toStrictEqual({
      chosen: { members: false, pressed: "false" },
      floating: { focused: true, pressed: "true", under: true },
      narrowed: true,
      wide: true,
    });
  });

  // Catches a drag that writes the option at every step, or past its bounds, or not at all.
  it("are resized as their edge is dragged, within the option's bounds, and write it once, as it ends", async () => {
    const { daemon, registry } = await signedIn();
    const restore = zeroOfEight();

    await settled(() => toggle() !== undefined);
    await measure(registry, 800);
    await press(toggle());
    await settled(() => grip() !== null);

    const now = () => grip()?.getAttribute("aria-valuenow");
    const steps: (string | null | undefined)[] = [];
    let written = -1;

    // Left widens them: four `0`s, then far past the widest.
    await drag(grip(), [600, 568, 0], () => {
      steps.push(now());
      written = daemon.uiChanges.length;
    });
    await settled(() => daemon.ui.options["members.width"] === 40);

    const widest = { changes: daemon.uiChanges.map((one) => one.route), now: now() };

    // Right narrows them, and never below the narrowest.
    await drag(grip(), [100, 140, 2000]);
    await settled(() => daemon.ui.options["members.width"] === 14);
    restore();

    expect({
      changes: daemon.uiChanges.map((one) => one.route),
      narrowest: now(),
      steps,
      widest,
      written,
    }).toStrictEqual({
      changes: ["PUT members.width", "PUT members.width"],
      narrowest: "14",
      steps: ["40"],
      widest: { changes: ["PUT members.width"], now: "40" },
      written: 0,
    });
  });

  // Catches a key that writes the shared option over the one this device overrides, which
  // would then win, so the edge would seem not to move.
  it("are resized from their edge by the arrows, Home, and End, written as this device's own where it overrides the option", async () => {
    const { daemon, registry } = await signedIn();

    await settled(() => toggle() !== undefined);
    await measure(registry, 800);
    await press(toggle());
    await settled(() => grip() !== null);

    const shared = [];

    await key(grip(), "ArrowLeft");
    await settled(() => daemon.ui.options["members.width"] === 19);
    shared.push(grip()?.getAttribute("aria-valuenow"));

    await act(async () => {
      registry.set(deviceUi, { "members.width": 20 });
      await Promise.resolve();
    });

    const ownAfter = async (name: string) => {
      await key(grip(), name);

      return registry.get(deviceUi)["members.width"];
    };

    const own = [await ownAfter("ArrowRight"), await ownAfter("End"), await ownAfter("Home")];

    expect({
      changes: daemon.uiChanges.map((one) => one.route),
      focusable: grip()?.tabIndex,
      own,
      shared,
      sharedAfter: daemon.ui.options["members.width"],
    }).toStrictEqual({
      changes: ["PUT members.width"],
      focusable: 0,
      own: [19, 40, 14],
      shared: ["19"],
      sharedAfter: 19,
    });
  });

  // Catches a key on the members' edge that lets go of a nick column dragged meanwhile.
  it("keep a nick column dragged meanwhile as it was dragged while a key resizes them", async () => {
    const { daemon, registry } = await signedIn();
    const restore = zeroOfEight();

    await settled(() => toggle() !== undefined);
    await measure(registry, 800);
    await press(toggle());
    await settled(() => grip() !== null);

    const nick = document.querySelector<HTMLElement>('[aria-label="resize nick column"]');

    await act(async () => {
      nick?.dispatchEvent(at("pointerdown", 200));
      nick?.dispatchEvent(at("pointermove", 224));
      await Promise.resolve();
    });
    await key(grip(), "ArrowLeft");
    await settled(() => daemon.ui.options["members.width"] === 19);

    const meanwhile = nick?.getAttribute("aria-valuenow");

    await act(async () => {
      nick?.dispatchEvent(at("pointerup", 224));
      await Promise.resolve();
    });
    await settled(() => daemon.uiChanges.length === 2);
    restore();

    expect({ meanwhile, written: daemon.ui.options["conversation.nickWidth"] }).toStrictEqual({
      meanwhile: "19",
      written: 19,
    });
  });

  // Catches a width the Daemon refused that snaps back with no word of why.
  it("say in the Composer why a width was not written, and draw the one in force", async () => {
    const { daemon, registry } = await signedIn();

    await settled(() => toggle() !== undefined);
    await measure(registry, 800);
    await press(toggle());
    await settled(() => grip() !== null);
    daemon.refuseUi = true;
    await key(grip(), "ArrowLeft");
    await settled(() => document.body.textContent.includes("could not record"));

    expect({
      changes: daemon.uiChanges.map((one) => one.route),
      now: grip()?.getAttribute("aria-valuenow"),
    }).toStrictEqual({ changes: ["PUT members.width"], now: "18" });
  });

  // Catches a grip on members that a drag cannot resize: over a narrow Pane, or a sheet.
  it("have no edge to drag over a narrow Pane or as a sheet", async () => {
    const { registry } = await signedIn();

    await settled(() => toggle() !== undefined);
    await measure(registry, 400);
    await press(toggle());
    await settled(() => members() !== null);

    const narrow = { grip: grip() === null, members: members() !== null };

    await act(async () => {
      registry.set(pageState, { compact: true, focused: true, visible: true });
      await Promise.resolve();
    });
    await press(toggle());
    await settled(() => document.querySelector('[role="dialog"] h2')?.textContent === "members");

    expect({ narrow, sheet: grip() === null }).toStrictEqual({
      narrow: { grip: true, members: true },
      sheet: true,
    });
  });

  // Catches Back leaving the page while members lie over a narrow Pane's Timeline, or
  // dropping the focus that was in them.
  it("over a narrow Pane are put away by Back, and the page stays", async () => {
    pageEntered();
    const { registry } = await signedIn();

    await settled(() => toggle() !== undefined);
    await measure(registry, 400);
    await act(async () => {
      toggle()?.focus();
      await Promise.resolve();
    });
    await press(toggle());
    await settled(() => members() !== null);
    await act(async () => {
      members()?.querySelector<HTMLElement>('[data-key="peer"]')?.focus();
      await Promise.resolve();
    });
    await back();
    await settled(() => members() === null);

    expect({ focus: document.activeElement === toggle(), left: left() }).toStrictEqual({
      focus: true,
      left: false,
    });
  });

  it("offer a menu on a member, Query first, so Enter twice opens their Direct Message and puts the members away", async () => {
    const { container, registry } = await signedIn();

    await settled(() => toggle() !== undefined);
    await measure(registry, 400);
    await press(toggle());
    await settled(() => members()?.querySelector('[data-key="peer"]') !== null);

    const row = members()?.querySelector<HTMLElement>('[data-key="peer"]');

    await act(async () => {
      row?.focus();
      await Promise.resolve();
    });
    await key(row, "Enter");
    await settled(() => document.querySelector('[role="menu"]') !== null);

    // Query is first, which the menu focuses as it opens (happy-dom does not move the focus
    // there itself, so it is focused here, as a browser does).
    const query = document.querySelector<HTMLElement>('[role="menuitem"]');
    const first = query?.getAttribute("aria-label");

    await act(async () => {
      query?.focus();
      await Promise.resolve();
    });
    await key(query, "Enter");
    await settled(() => document.querySelector('[role="menu"]') === null);
    await settled(() => container.querySelector('[role="log"]') === null);

    expect({ first, members: members() }).toStrictEqual({ first: "query peer", members: null });
  });

  it("says in a member's menu which account they are logged in to, or that they are logged out, and nothing when it is not known", async () => {
    const { registry } = await signedIn(null, [
      member("op", ["o"], known("opper")),
      member("peer", [], known(null)),
      member("quiet"),
    ]);

    await settled(() => toggle() !== undefined);
    await measure(registry, 400);
    await press(toggle());
    await settled(() => members()?.querySelector('[data-key="quiet"]') !== null);

    const menuOf = async (nick: string) => {
      const row = members()?.querySelector<HTMLElement>(`[data-key="${nick}"]`);

      await act(async () => {
        row?.focus();
        await Promise.resolve();
      });
      await key(row, "Enter");
      await settled(() => document.querySelector('[role="menu"]') !== null);

      const popover = document.querySelector('[role="menu"]')?.parentElement?.textContent;

      await key(document.querySelector('[role="menu"]'), "Escape");
      await settled(() => document.querySelector('[role="menu"]') === null);

      return popover;
    };

    expect({
      op: await menuOf("op"),
      peer: await menuOf("peer"),
      quiet: await menuOf("quiet"),
    }).toStrictEqual({
      op: "account opperquerywhoismentionignore",
      peer: "logged outquerywhoismentionignore",
      quiet: "querywhoismentionignore",
    });
  });

  // Catches a bot unmarked, or a mark drawn on a member who is not known to be one: a
  // person, a fact gone stale, or one never learned.
  it("marks a member whose User is known to be a bot, quietly and for a screen reader, and no other", async () => {
    const { registry } = await signedIn(null, [
      member("helper", ["o"], unknownAccount, { _tag: "Known", at: 1, from: "ircd", value: true }),
      member("person", [], unknownAccount, { _tag: "Known", at: 1, from: "ircd", value: false }),
      member("stale", [], unknownAccount, { _tag: "Stale", since: 2, was: true }),
      member("unknown"),
    ]);

    await settled(() => toggle() !== undefined);
    await measure(registry, 400);
    await press(toggle());
    await settled(() => members()?.querySelector('[data-key="unknown"]') !== null);

    const shown = ["helper", "person", "stale", "unknown"].map((nick) => {
      const row = members()?.querySelector<HTMLElement>(`[data-key="${nick}"]`);

      return [row?.textContent, row?.getAttribute("aria-label")];
    });

    expect(shown).toStrictEqual([
      ["@helperbot", "helper, operator, bot"],
      [" person", "person"],
      [" stale", "stale"],
      [" unknown", "unknown"],
    ]);
  });

  it("offers no kick, deop, or devoice of a member who outranks Self, and does of one who does not", async () => {
    const { registry } = await signedIn(
      null,
      [member("founder", ["q"]), member("op", ["o"]), member("peer")],
      ["o"]
    );

    await settled(() => toggle() !== undefined);
    await measure(registry, 400);
    await press(toggle());
    await settled(() => members()?.querySelector('[data-key="peer"]') !== null);

    const offered = async (nick: string) => {
      const row = members()?.querySelector<HTMLElement>(`[data-key="${nick}"]`);

      await act(async () => {
        row?.focus();
        await Promise.resolve();
      });
      await key(row, "Enter");
      await settled(() => document.querySelector('[role="menu"]') !== null);

      const labels = [...document.querySelectorAll('[role="menuitem"]')].map((item) =>
        item.getAttribute("aria-label")
      );

      await key(document.querySelector('[role="menu"]'), "Escape");
      await settled(() => document.querySelector('[role="menu"]') === null);

      return labels;
    };

    expect({
      founder: await offered("founder"),
      op: await offered("op"),
      peer: await offered("peer"),
    }).toStrictEqual({
      founder: [
        "query founder",
        "whois founder",
        "mention founder",
        "ignore founder",
        "ban founder",
        "op founder",
        "voice founder",
      ],
      op: [
        "query op",
        "whois op",
        "mention op",
        "ignore op",
        "ban op",
        "op op",
        "deop op",
        "voice op",
        "devoice op",
        "kick op",
      ],
      peer: [
        "query peer",
        "whois peer",
        "mention peer",
        "ignore peer",
        "ban peer",
        "op peer",
        "deop peer",
        "voice peer",
        "devoice peer",
        "kick peer",
      ],
    });
  });
});
