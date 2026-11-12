// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { TimelineId } from "@iirc/api";
import type { Member, Timeline } from "@iirc/api";
import { Schema } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { channelSync } from "../channel/atoms.ts";
import { membersShown } from "../channel/state.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, profileOf, registryFor, run } from "../testing/fake-daemon.ts";
import type { LookScript } from "../testing/fake-daemon.ts";
import { open, sync } from "../timelines/atoms.ts";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: (() => void)[] = [];

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;

const own = idOf(1);
const iirc = idOf(2);

// Text a hostile Network could send: an override that would reverse what follows, markup,
// and a control.
const override = String.fromCodePoint(0x20_2e);
const bell = String.fromCodePoint(0x07);

const listed = (
  id: string,
  name: string,
  kind: "Network" | "Channel"
): typeof Timeline.Encoded => ({
  changed: 1,
  detached: false,
  head: null,
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

/** `peer`, as a `WHOIS` describes them, with a hostile realname and an unknown numeric. */
const hostilePeer: LookScript = {
  answer: "LookedUp",
  pending: 0,
  result: {
    _tag: "Found",
    profiles: [
      profileOf({
        channels: [{ name: "#iirc", prefixes: ["o"] }],
        host: "example.test",
        idle: 180,
        other: [{ numeric: "378", params: ["is connecting from", "*@10.0.0.1"] }],
        realname: `${override}<img src=x onerror=alert(1)>${bell}`,
        user: "~peer",
      }),
    ],
  },
};

const settled = async (holds: () => boolean) => {
  await act(async () => {
    await eventually(holds);
  });
};

/**
 * A browser signed in to a Daemon with `#iirc` open, its members `op` and `peer`, the page
 * drawn.
 * @param scripts - How the Daemon answers each `look`.
 * @returns The fake, the registry, and the page.
 */
const signedIn = async (...scripts: readonly LookScript[]) => {
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
      modes: { _tag: "Known", at: 1, from: "ircd", value: [] },
      name: "#iirc",
      network: "libera",
      ranks: [
        { mode: "o", symbol: "@" },
        { mode: "v", symbol: "+" },
      ],
      standing: "Joined",
      timeline: iirc,
      topic: { _tag: "Known", at: 1, from: "ircd", value: null },
    },
    members: [member("op", ["o"]), member("peer")],
  });
  fake.daemon.lookScripts.push(...scripts);

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
 * Types a line into the composer, and presses a key there, as the browser dispatches it.
 * @param container - The page.
 * @param text - The line, or none to leave it.
 * @param key - The key.
 */
const inComposer = async (container: HTMLElement, text: string | undefined, key: string) => {
  const composer = container.querySelector("textarea");

  if (composer === null) {
    throw new Error("no composer");
  }

  await act(async () => {
    if (text !== undefined) {
      Reflect.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        composer,
        text
      );
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    }

    await Promise.resolve();
  });

  await act(async () => {
    composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
    await Promise.resolve();
  });
};

const card = () =>
  document.querySelector<HTMLElement>("section[aria-labelledby] h3")?.closest("section");

describe("the Lookup card", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("shows what /whois found as text in isolates, and Escape in the composer puts it away", async () => {
    const { container } = await signedIn(hostilePeer);

    await inComposer(container, "/whois peer", "Enter");
    await settled(() => card()?.textContent.includes("example.test") === true);

    const shown = card();

    const realname = [...(shown?.querySelectorAll("bdi") ?? [])].find((one) =>
      one.textContent.includes("<img")
    );

    const drawn = {
      channel: shown?.querySelector("li")?.textContent,
      heading: shown?.querySelector("h3")?.textContent,
      images: shown?.querySelectorAll("img").length,
      // The override is closed, and the bell shown as its symbol.
      realname: realname?.textContent,
      realnameOnlyText: [...(realname?.childNodes ?? [])].every((node) => node.nodeType === 3),
      text: shown?.textContent.includes("~peer@example.test"),
      unknown: shown?.textContent.includes("378 is connecting from *@10.0.0.1"),
    };

    await inComposer(container, undefined, "Escape");

    expect({ ...drawn, after: card() ?? null }).toStrictEqual({
      after: null,
      channel: "@#iirc",
      heading: "whois peer",
      images: 0,
      realname: `${override}<img src=x onerror=alert(1)>␇‬`,
      realnameOnlyText: true,
      text: true,
      unknown: true,
    });
  });

  it("says not found in words, and its close button puts it away", async () => {
    const { container } = await signedIn({
      answer: "LookedUp",
      pending: 0,
      result: { _tag: "NotFound", reply: "401" },
    });

    await inComposer(container, "/whois nobody", "Enter");
    await settled(() => card()?.textContent.includes("No one uses") === true);

    const words = card()?.textContent;

    await act(async () => {
      card()?.querySelector<HTMLElement>('button[aria-label="Close the Lookup"]')?.click();
      await Promise.resolve();
    });

    expect({ after: card() ?? null, words }).toStrictEqual({
      after: null,
      words: "whois nobody×No one uses the nick nobody now (401).",
    });
  });

  it("is asked from a member's menu in the members, by their Whois, Query first", async () => {
    const { container, daemon, registry } = await signedIn(hostilePeer);

    await act(async () => {
      registry.set(membersShown, true);
      await Promise.resolve();
    });
    await settled(() => container.querySelector('[role="grid"] [data-key="peer"]') !== null);

    // A press on the member opens their menu, anchored to their row.
    await act(async () => {
      container.querySelector<HTMLElement>('[role="grid"] [data-key="peer"]')?.click();
      await Promise.resolve();
    });
    await settled(() => document.querySelector('[role="menu"]') !== null);

    const menu = document.querySelector('[role="menu"]');

    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) =>
      item.getAttribute("aria-label")
    );

    await act(async () => {
      document.querySelector<HTMLElement>('[role="menuitem"][aria-label="Whois peer"]')?.click();
      await Promise.resolve();
    });
    await settled(() => card()?.textContent.includes("example.test") === true);

    expect({
      closed: document.querySelector('[role="menu"]') === null,
      items,
      label: menu?.getAttribute("aria-label"),
      looks: daemon.looks.map((one) => one.lookup),
    }).toStrictEqual({
      closed: true,
      items: ["Query peer", "Whois peer", "Mention peer"],
      label: "What to do with peer",
      looks: [{ _tag: "Whois", nick: "peer" }],
    });
  });
});
