// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { TimelineId } from "@iirc/api";
import type { Member, Timeline } from "@iirc/api";
import { Schema } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run } from "../testing/fake-daemon.ts";
import { open, sync } from "../timelines/atoms.ts";
import { channelSync } from "./atoms.ts";
import { membersShown, paneMeasured } from "./state.ts";

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
  detached: false,
  id,
  key: kind === "Network" ? null : name,
  kind,
  latest: null,
  name,
  network: "libera",
  read: null,
  unread: { activity: 0, direct: 0, highlights: 0, messages: 0 },
});

const member = (nick: string, prefixes: readonly string[] = []): typeof Member.Encoded => ({
  away: { _tag: "Known", at: 1, from: "ircd", value: null },
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
 * @returns The fake, the registry, and the page.
 */
const signedIn = async () => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: listed(own, "libera", "Network") },
    { gaps: [], items: [], timeline: listed(iirc, "#iirc", "Channel") },
  ]);
  fake.daemon.channels.set(iirc, {
    header: {
      chanmodes: { always: "k", flags: "imnpst", list: "beI", whenSet: "l" },
      chantypes: "#&",
      members: 2,
      modes: { _tag: "Known", at: 1, from: "ircd", value: [{ mode: "n", param: null }] },
      name: "#iirc",
      network: "libera",
      ranks: [
        { mode: "o", symbol: "@" },
        { mode: "v", symbol: "+" },
      ],
      standing: "Joined",
      timeline: iirc,
      topic: {
        _tag: "Known",
        at: 1,
        from: "ircd",
        value: { setAt: null, setBy: "op", text: hostileTopic },
      },
    },
    members: [member("op", ["o"]), member("peer")],
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
const members = () => document.querySelector<HTMLElement>('section[aria-label="Members"]');

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

describe("a Pane's status bar", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("says the count once, in the toggle, and discloses the topic in full, isolated, under its one line", async () => {
    await signedIn();
    await settled(() => toggle()?.getAttribute("aria-label") === "Members, 2");

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

    expect({ first, members: members() }).toStrictEqual({ first: "Query peer", members: null });
  });
});
