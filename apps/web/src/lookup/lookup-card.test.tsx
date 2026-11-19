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
import { lookupsState } from "./state.ts";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: (() => void)[] = [];

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;

const own = idOf(1);
const iirc = idOf(2);
const ops = idOf(3);

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
  unread: { activity: 0, direct: 0, highlights: 0, messages: 0 },
});

const member = (nick: string, prefixes: readonly string[] = []): typeof Member.Encoded => ({
  account: { _tag: "Unknown" },
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
    notes: [],
    profiles: [
      profileOf({
        account: "peerly",
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

/**
 * A Channel's head, with Self holding the prefixes given there.
 * @param timeline - Its Timeline.
 * @param name - Its name.
 * @param held - The prefix modes Self holds.
 * @returns The head, as the wire carries it.
 */
const headOf = (timeline: string, name: string, held: readonly string[]) =>
  ({
    chanmodes: { always: "k", flags: "imnpst", list: "beI", whenSet: "l" },
    chantypes: "#&",
    held: { _tag: "Known", at: 1, from: "ircd", value: [...held] },
    lists: { bans: "b", exceptions: "e", invitations: "I" },
    members: 2,
    modes: { _tag: "Known", at: 1, from: "ircd", value: [] },
    name,
    network: "libera",
    ranks: [
      { mode: "o", symbol: "@" },
      { mode: "v", symbol: "+" },
    ],
    standing: "Joined",
    timeline,
    topic: { _tag: "Known", at: 1, from: "ircd", value: null },
  }) as const;

/** A list of one ban, as the Daemon answers `/bans`. */
const oneBan: LookScript = {
  answer: "LookedUp",
  pending: 0,
  result: {
    _tag: "Listed",
    cut: null,
    masks: [{ mask: "bad!*@*", setAt: null, setBy: null }],
    notes: [],
  },
};

const settled = async (holds: () => boolean) => {
  await act(async () => {
    await eventually(holds);
  });
};

/**
 * A browser signed in to a Daemon with `#iirc` open, its members `op` and `peer`, and Self
 * holding the prefixes given there, the page drawn.
 * @param held - The prefix modes Self holds in `#iirc`.
 * @param scripts - How the Daemon answers each `look`.
 * @param opsHeld - The prefix modes Self holds in `#ops`, which no Pane shows.
 * @returns The fake, the registry, and the page.
 */
const signedInHolding = async (
  held: readonly string[],
  scripts: readonly LookScript[],
  opsHeld: readonly string[] = ["o"]
) => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: listed(own, "libera", "Network") },
    { gaps: [], items: [], timeline: listed(iirc, "#iirc", "Channel") },
    { gaps: [], items: [], timeline: listed(ops, "#ops", "Channel") },
  ]);
  fake.daemon.channels.set(iirc, {
    header: headOf(iirc, "#iirc", held),
    members: [member("op", ["o"]), member("peer")],
  });
  // Another Channel, which no Pane shows.
  fake.daemon.channels.set(ops, { header: headOf(ops, "#ops", opsHeld), members: [] });
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
 * A browser signed in to a Daemon with `#iirc` open, its members `op` and `peer`, the page
 * drawn.
 * @param scripts - How the Daemon answers each `look`.
 * @returns The fake, the registry, and the page.
 */
const signedIn = async (...scripts: readonly LookScript[]) => await signedInHolding([], scripts);

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

const buttons = () =>
  [...(card()?.querySelectorAll("button") ?? [])].map((one) => one.getAttribute("aria-label"));

const press = async (label: string) => {
  await act(async () => {
    card()?.querySelector<HTMLElement>(`button[aria-label="${label}"]`)?.click();
    await Promise.resolve();
  });
};

/**
 * Removes the one ban `/bans` lists, which the Daemon acts on, then sends an event of the
 * changes stream, and waits until no card hides a mask any more.
 * @param event - The event.
 * @returns The masks each card is still removing then.
 */
const removedThen = async (event: Parameters<ReturnType<typeof fakeDaemon>["send"]>[0]) => {
  const { container, daemon, registry, send } = await signedInHolding(["o"], [oneBan]);

  const removing = () =>
    [...registry.get(lookupsState).cards.values()].flatMap((one) => [...one.removing.keys()]);

  await inComposer(container, "/bans", "Enter");
  await settled(() => card()?.textContent.includes("bad!*@*") === true);
  await press("Remove bad!*@*");
  await settled(() => daemon.acts.length === 1);
  await settled(() => card()?.textContent.includes("has no bans") === true);

  const before = removing();

  await act(async () => {
    send(event);
    await Promise.resolve();
  });
  await settled(() => removing().length === 0);

  return { after: removing(), before };
};

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
      account: shown?.textContent.includes("account peerly"),
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
      account: true,
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
      result: { _tag: "NotFound", notes: [], reply: "401" },
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

  it("shows the WARN and NOTE the Network gave with its result, under it", async () => {
    const { container } = await signedIn({
      answer: "LookedUp",
      pending: 0,
      result: {
        _tag: "NotFound",
        notes: [
          {
            code: "CACHED",
            command: "WHOIS",
            context: ["nobody"],
            description: "From cache",
            kind: "NOTE",
          },
        ],
        reply: "401",
      },
    });

    await inComposer(container, "/whois nobody", "Enter");
    await settled(() => card()?.textContent.includes("No one uses") === true);

    expect(card()?.textContent).toBe(
      "whois nobody×No one uses the nick nobody now (401).NOTE WHOIS CACHED nobody: From cache"
    );
  });

  it("lists a Channel's bans, and removes one while Self is its operator, showing it no more", async () => {
    const bans: LookScript = {
      answer: "LookedUp",
      pending: 0,
      result: {
        _tag: "Listed",
        cut: null,
        masks: [
          { mask: "bad!*@*", setAt: null, setBy: "op!u@h" },
          { mask: `${override}worse!*@*`, setAt: null, setBy: null },
        ],
        notes: [],
      },
    };

    const { container, daemon } = await signedInHolding(["o"], [bans]);

    await inComposer(container, "/bans", "Enter");
    await settled(() => card()?.textContent.includes("bad!*@*") === true);

    const drawn = {
      heading: card()?.querySelector("h3")?.textContent,
      masks: [...(card()?.querySelectorAll("li") ?? [])].map((one) => one.textContent),
      removable: [...(card()?.querySelectorAll("button") ?? [])].map((one) =>
        one.getAttribute("aria-label")
      ),
    };

    await act(async () => {
      card()?.querySelector<HTMLElement>('button[aria-label="Remove bad!*@*"]')?.click();
      await Promise.resolve();
    });
    await settled(() => daemon.acts.length === 1);

    expect({
      ...drawn,
      acts: daemon.acts.map((one) => one.action),
      after: [...(card()?.querySelectorAll("li") ?? [])].map((one) => one.textContent),
      looks: daemon.looks.map((one) => one.lookup),
    }).toStrictEqual({
      acts: [
        { _tag: "Mode", changes: [{ mode: "b", param: "bad!*@*", set: false }], target: "#iirc" },
      ],
      after: [`${override}worse!*@*‬×`],
      heading: "bans #iirc",
      looks: [{ _tag: "Bans", channel: "#iirc" }],
      masks: ["bad!*@* set by op!u@h×", `${override}worse!*@*‬×`],
      removable: ["Close the Lookup", "Remove bad!*@*", `Remove ${override}worse!*@*‬`],
    });
  });

  it("shows a mask again when the act removing it is refused, and never says none are left", async () => {
    const { container, daemon } = await signedInHolding(["o"], [oneBan]);

    daemon.sayAnswers.push("Offline");
    await inComposer(container, "/bans", "Enter");
    await settled(() => card()?.textContent.includes("bad!*@*") === true);
    await press("Remove bad!*@*");
    await settled(() => daemon.acts.length === 1);
    await settled(() => card()?.textContent.includes("bad!*@*") === true);

    expect(buttons()).toStrictEqual(["Close the Lookup", "Remove bad!*@*"]);
  });

  it("shows a mask again when the Ircd refuses its removal later, by the act's intent", async () => {
    const { container, daemon, send } = await signedInHolding(["o"], [oneBan]);

    await inComposer(container, "/bans", "Enter");
    await settled(() => card()?.textContent.includes("bad!*@*") === true);
    await press("Remove bad!*@*");
    await settled(() => daemon.acts.length === 1);
    await settled(() => card()?.textContent.includes("has no bans") === true);

    const intent = daemon.acts[0]?.intent ?? "";

    await act(async () => {
      send({
        data: JSON.stringify({
          dropped: [],
          gaps: [],
          items: [
            {
              answered: null,
              changed: 50,
              content: {
                _tag: "ActionRefused",
                at: 1,
                attempted: { _tag: "Mode", modes: "-b", target: "#iirc" },
                intent,
                reason: { _tag: "Rejected", reply: "482" },
              },
              level: null,
              network: "libera",
              position: `${hex(2n ** 53n + 50_000n, 14)}-${hex(50n, 14)}-${hex(0n, 8)}`,
              sequence: 50,
              timeline: iirc,
            },
          ],
          merged: [],
          removals: [],
          sequence: 50,
          timelines: [],
        }),
        event: "changed",
        id: "1.50",
      });
      await Promise.resolve();
    });
    await settled(() => card()?.textContent.includes("bad!*@*") === true);

    expect(buttons()).toStrictEqual(["Close the Lookup", "Remove bad!*@*"]);
  });

  it("shows a mask again when the removal's request is never answered, and sends it once", async () => {
    const { container, daemon } = await signedInHolding(["o"], [oneBan]);

    daemon.holdActs = true;
    await inComposer(container, "/bans", "Enter");
    await settled(() => card()?.textContent.includes("bad!*@*") === true);
    await press("Remove bad!*@*");
    await settled(() => card()?.textContent.includes("has no bans") === true);
    await settled(() => card()?.textContent.includes("bad!*@*") === true);

    expect({ acts: daemon.acts.length, buttons: buttons() }).toStrictEqual({
      acts: 1,
      buttons: ["Close the Lookup", "Remove bad!*@*"],
    });
  });

  it("shows a mask again when the changes stream overflows while it is removed", async () => {
    const removed = await removedThen({
      data: JSON.stringify({ sequence: 50, timelines: [] }),
      event: "overflowed",
      id: "1.50",
    });

    await settled(() => card()?.textContent.includes("bad!*@*") === true);

    expect({ ...removed, buttons: buttons() }).toStrictEqual({
      after: [],
      before: ["bad!*@*"],
      buttons: ["Close the Lookup", "Remove bad!*@*"],
    });
  });

  it("stops hiding a mask when the changes stream resets while it is removed", async () => {
    await expect(
      removedThen({ data: JSON.stringify({ through: 9, version: 1 }), event: "reset" })
    ).resolves.toStrictEqual({ after: [], before: ["bad!*@*"] });
  });

  it("follows the head of another Channel's list, as Self is made its operator and unmade", async () => {
    const { container, daemon, send } = await signedInHolding([], [oneBan, oneBan], []);

    // Something happened in `#ops`, after which Self holds the prefixes given there.
    const changeTo = async (sequence: number, held: readonly string[]) => {
      daemon.channels.set(ops, { header: headOf(ops, "#ops", held), members: [] });

      await act(async () => {
        send({
          data: JSON.stringify({
            dropped: [],
            gaps: [],
            items: [
              {
                answered: null,
                changed: sequence,
                content: {
                  _tag: "Activity",
                  activity: { _tag: "Joined", channel: "#ops", nick: "newcomer" },
                  at: { _tag: "Unknown" },
                  id: { _tag: "Unknown" },
                  live: true,
                },
                level: "Activity",
                network: "libera",
                position: `${hex(2n ** 53n + BigInt(sequence) * 1000n, 14)}-${hex(BigInt(sequence), 14)}-${hex(0n, 8)}`,
                sequence,
                timeline: ops,
              },
            ],
            merged: [],
            removals: [],
            sequence,
            timelines: [],
          }),
          event: "changed",
          id: `1.${sequence}`,
        });
        await Promise.resolve();
      });
    };

    await inComposer(container, "/bans #ops", "Enter");
    await settled(() => card()?.textContent.includes("bad!*@*") === true);

    const before = buttons();

    await changeTo(60, ["o"]);
    await settled(() => buttons().includes("Remove bad!*@*"));

    const promoted = buttons();

    await changeTo(61, ["v"]);
    await settled(() => !buttons().includes("Remove bad!*@*"));

    expect({ before, demoted: buttons(), promoted }).toStrictEqual({
      before: ["Close the Lookup"],
      demoted: ["Close the Lookup"],
      promoted: ["Close the Lookup", "Remove bad!*@*"],
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
      items: ["Query peer", "Whois peer", "Mention peer", "Ignore peer"],
      label: "What to do with peer",
      looks: [{ _tag: "Whois", nick: "peer" }],
    });
  });
});
