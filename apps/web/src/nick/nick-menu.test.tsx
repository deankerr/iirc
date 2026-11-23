// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { TimelineId } from "@iirc/api";
import type { ChannelHeader, Member, Timeline, TimelineItem } from "@iirc/api";
import { Effect, Schema } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { channelSync } from "../channel/atoms.ts";
import { focusedId } from "../panes/atoms.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, profileOf, registryFor, run } from "../testing/fake-daemon.ts";
import type { LookScript } from "../testing/fake-daemon.ts";
import { open, paned, sync } from "../timelines/atoms.ts";
import { nickMenuSync } from "./atoms.ts";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: (() => void)[] = [];

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const cursor = (at: number, sequence: number) =>
  `${hex(BigInt(at) + 2n ** 53n, 14)}-${hex(BigInt(sequence), 14)}-${hex(0n, 8)}`;

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;

const own = idOf(1);
const iirc = idOf(2);
const ops = idOf(3);

const listed = (
  id: string,
  name: string,
  kind: "Network" | "Channel",
  latest: number | null = null
): typeof Timeline.Encoded => ({
  changed: 1,
  closed: false,
  detached: false,
  head: null,
  id,
  key: kind === "Network" ? null : name,
  kind,
  latest: latest === null ? null : cursor(latest * 1000, latest),
  life: 1,
  name,
  network: "libera",
  read: null,
  removed: false,
  unread: { activity: 0, botDirect: 0, botMessages: 0, direct: 0, highlights: 0, messages: 0 },
});

/**
 * A Message in `#iirc`, with an id a reply could answer.
 * @param sequence - Its sequence.
 * @param sender - Who said it.
 * @returns The item.
 */
const said = (sequence: number, sender: string): typeof TimelineItem.Encoded => ({
  answered: null,
  changed: sequence,
  content: {
    _tag: "Message",
    answers: null,
    at: { _tag: "Unknown" },
    bot: false,
    context: null,
    id: { _tag: "Known", at: 1, from: "ircd", value: `msg-${sequence}` },
    kind: "Privmsg",
    live: true,
    ours: null,
    prefix: null,
    sender,
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
 * A User joining `#iirc`.
 * @param sequence - Its sequence.
 * @param nick - Who joined.
 * @returns The item.
 */
const joined = (sequence: number, nick: string): typeof TimelineItem.Encoded => ({
  answered: null,
  changed: sequence,
  content: {
    _tag: "Activity",
    activity: { _tag: "Joined", channel: "#iirc", nick },
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

const member = (nick: string, prefixes: readonly string[] = []): typeof Member.Encoded => ({
  account: { _tag: "Unknown" },
  away: { _tag: "Known", at: 1, from: "ircd", value: null },
  bot: { _tag: "Unknown" },
  nick,
  prefixes: { _tag: "Known", at: 1, from: "ircd", value: [...prefixes] },
});

/**
 * A Channel's head, with Self holding the prefixes given there.
 * @param timeline - Its Timeline.
 * @param name - Its name.
 * @param held - The prefix modes Self holds.
 * @param accountBan - How its Network's bans name an account, if they do.
 * @returns The head, as the wire carries it.
 */
const headOf = (
  timeline: string,
  name: string,
  held: readonly string[],
  accountBan: (typeof ChannelHeader.Encoded)["accountBan"] = null
) =>
  ({
    accountBan,
    chanmodes: { always: "k", flags: "imnpst", list: "beI", whenSet: "l" },
    chantypes: "#&",
    held: { _tag: "Known", at: 1, from: "ircd", value: [...held] },
    lists: { bans: "b", exceptions: "e", invitations: "I" },
    members: 3,
    modes: { _tag: "Known", at: 1, from: "ircd", value: [] },
    name,
    network: "libera",
    ranks: [
      { mode: "o", symbol: "@" },
      { mode: "h", symbol: "%" },
      { mode: "v", symbol: "+" },
    ],
    standing: "Joined",
    timeline,
    topic: { _tag: "Known", at: 1, from: "ircd", value: null },
  }) as const;

/** `peer`, as a `WHOIS` describes them. */
const whoisPeer: LookScript = {
  answer: "LookedUp",
  pending: 0,
  result: {
    _tag: "Found",
    notes: [],
    profiles: [profileOf({ host: "example.test", user: "~peer" })],
  },
};

const isLog = (element: Element) => element.getAttribute("role") === "log";

/**
 * A size a log and a row are laid out at, and every other element at nothing.
 * @param log - The log's.
 * @param row - A row's.
 * @returns The getter.
 */
const sized = (log: number, row: number) =>
  function (this: HTMLElement) {
    if (isLog(this)) {
      return log;
    }

    return Object.hasOwn(this.dataset, "index") ? row : 0;
  };

/**
 * Gives each log a size, so its virtualizer draws its rows, each 20 pixels tall. Every
 * other element lays out at nothing, as in happy-dom.
 */
const layOut = () => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: sized(500, 0),
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: sized(800, 0),
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: sized(0, 20),
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      return isLog(this)
        ? new DOMRect(0, 0, 800, 500)
        : new DOMRect(0, 0, 0, Object.hasOwn(this.dataset, "index") ? 20 : 0);
    },
  });
};

const settled = async (holds: () => boolean) => {
  await act(async () => {
    await eventually(holds);
  });
};

const pause = async (millis: number) => {
  await act(async () => {
    await Effect.runPromise(Effect.sleep(`${millis} millis`));
  });
};

/**
 * A browser signed in to a Daemon with `#iirc` open, where `peer` said something, `gone`
 * said something and left, and `peer` joined, its members `op` and `peer`, Self holding the
 * prefixes given there, and `#ops`, where Self holds nothing.
 * @param held - The prefix modes Self holds in `#iirc`.
 * @param accountBan - How its Network's bans name an account, if they do.
 * @param scripts - How the Daemon answers each `look`.
 * @returns The fake, the registry, and the page.
 */
const signedInNaming = async (
  held: readonly string[],
  accountBan: (typeof ChannelHeader.Encoded)["accountBan"],
  scripts: readonly LookScript[]
) => {
  const fake = fakeDaemon();
  const items = [joined(1, "peer"), said(2, "peer"), said(3, "gone")];

  fake.daemon.signedIn = true;
  fake.daemon.through = 3;
  fake.daemon.sessions.set("libera", {
    _tag: "Registered",
    ircd: "ircd.test",
    since: 1,
    tags: true,
  });
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: listed(own, "libera", "Network") },
    { gaps: [], items, timeline: listed(iirc, "#iirc", "Channel", 3) },
    { gaps: [], items: [], timeline: listed(ops, "#ops", "Channel") },
  ]);
  fake.daemon.channels.set(iirc, {
    header: headOf(iirc, "#iirc", held, accountBan),
    members: [member("op", ["o"]), member("peer")],
  });
  fake.daemon.channels.set(ops, { header: headOf(ops, "#ops", []), members: [] });
  fake.daemon.lookScripts.push(...scripts);

  const registry = registryFor(fake.fetch);

  await run(registry, check, undefined);
  registry.mount(sync);
  registry.mount(channelSync);
  registry.mount(nickMenuSync);

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
  await settled(
    () => container.querySelector('[role="log"]')?.textContent.includes("line 3") === true
  );

  return { ...fake, container, registry };
};

const signedIn = async (held: readonly string[], ...scripts: readonly LookScript[]) =>
  await signedInNaming(held, null, scripts);

/**
 * The nick that opens a menu in a row of a Pane's log that holds some text.
 * @param text - What the row holds.
 * @param pane - The Pane.
 * @returns The nick, or none.
 */
const nickIn = (text: string, pane = "p0") =>
  [...document.querySelectorAll<HTMLElement>(`[data-pane="${pane}"] [role="log"] [data-index]`)]
    .find((row) => row.textContent.includes(text))
    ?.querySelector<HTMLElement>('[role="button"][aria-haspopup="menu"]') ?? undefined;

const menu = () => document.querySelector<HTMLElement>('[role="menu"]');

/**
 * Every row of the menu, a wait as much as an entry.
 * @returns Their accessible names.
 */
const rows = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((one) =>
    one.getAttribute("aria-label")
  );

/**
 * The entries of the menu, which leaves out a wait.
 * @returns Their accessible names.
 */
const entries = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')].map(
    (one) => one.getAttribute("aria-label")
  );

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
 * The nick a Lookup card's profile shows.
 * @returns It, or none.
 */
const profileNick = () =>
  document.querySelector<HTMLElement>(
    'section[aria-labelledby] [role="button"][aria-haspopup="menu"]'
  );

/** Puts a finger down on the nick in the row of `line 2`. */
const touchDown = async () => {
  await act(async () => {
    nickIn("line 2")?.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        clientX: 0,
        clientY: 0,
        pointerType: "touch",
      })
    );
    await Promise.resolve();
  });
};

/** Closes the menu open with Escape, and waits until it is gone. */
const escaped = async () => {
  await key(menu(), "Escape");
  await settled(() => menu() === null);
};

/**
 * What the menu on `peer`'s nick in the row of `line 2` offers, once they are read to be
 * there, with Self holding the prefixes given, the page let go of after.
 * @param held - The prefix modes Self holds in `#iirc`.
 * @returns The entries' names.
 */
const offeredHolding = async (held: readonly string[]) => {
  const { daemon } = await signedIn(held);

  await settled(() => nickIn("line 2") !== undefined);
  await press(nickIn("line 2"));
  await settled(() => daemon.membersRead.some((query) => query.includes("prefix=peer")));
  await settled(() => rows().length === entries().length);

  const offered = entries();

  await escaped();

  for (const unmount of mounted.splice(0)) {
    act(unmount);
  }

  return offered;
};

const everyone = (nick: string) => [
  `Query ${nick}`,
  `Whois ${nick}`,
  `Mention ${nick}`,
  `Ignore ${nick}`,
];

const operator = (nick: string) => [
  ...everyone(nick),
  `Ban ${nick}`,
  `Op ${nick}`,
  `Deop ${nick}`,
  `Voice ${nick}`,
  `Devoice ${nick}`,
  `Kick ${nick}`,
];

describe("the menu on a nick", () => {
  beforeEach(layOut);

  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("opens from a Message's sender, offers an operator's entries for a member, and runs what /op runs", async () => {
    const { daemon } = await signedIn(["o"]);

    await settled(() => nickIn("line 2") !== undefined);
    await press(nickIn("line 2"));
    await settled(() => entries().length === 10);

    const label = menu()?.getAttribute("aria-label");
    const offered = entries();

    await press(document.querySelector<HTMLElement>('[role="menuitem"][aria-label="Op peer"]'));
    await settled(() => daemon.acts.length === 1);

    expect({
      act: daemon.acts[0]?.action,
      closed: menu(),
      label,
      offered,
    }).toStrictEqual({
      act: {
        _tag: "Mode",
        changes: [{ mode: "o", param: "peer", set: true }],
        target: "#iirc",
      },
      closed: null,
      label: "What to do with peer",
      offered: operator("peer"),
    });
  });

  it("offers a ban by account where the Network's bans name one, and sends BanAccount for it", async () => {
    const { daemon } = await signedInNaming(["o"], { names: ["account"], prefix: "~" }, []);

    await settled(() => nickIn("line 2") !== undefined);
    await press(nickIn("line 2"));
    await settled(() => entries().length === 11);

    const offered = entries();

    const word = document.querySelector<HTMLElement>(
      '[role="menuitem"][aria-label="Ban peer\'s account"]'
    );

    await press(word);
    await settled(() => daemon.acts.length === 1);

    expect({ act: daemon.acts[0]?.action, offered, word: word?.textContent }).toStrictEqual({
      act: { _tag: "BanAccount", channel: "#iirc", nick: "peer" },
      offered: [
        ...everyone("peer"),
        "Ban peer",
        "Ban peer's account",
        "Op peer",
        "Deop peer",
        "Voice peer",
        "Devoice peer",
        "Kick peer",
      ],
      word: "ban account",
    });
  });

  it("draws a wait where an operator's entries go while the members and known are read, and moves nothing when they arrive", async () => {
    const { daemon } = await signedIn(["o"]);

    daemon.holdMembers = true;
    daemon.holdKnown = true;

    await settled(() => nickIn("line 2") !== undefined);
    await press(nickIn("line 2"));
    await settled(() => daemon.held.members.length === 1);
    await settled(() => rows().includes("Reading what else can be done with peer"));

    const waiting = rows();

    for (const release of daemon.held.members.splice(0)) {
      release();
    }

    await settled(() => daemon.held.known.length === 1);

    for (const release of daemon.held.known.splice(0)) {
      release();
    }

    await settled(() => rows().length === 10);

    expect({ arrived: rows(), waiting }).toStrictEqual({
      arrived: operator("peer"),
      waiting: [...everyone("peer"), "Ban peer", "Reading what else can be done with peer"],
    });
  });

  it("offers a nick that has left all but what needs them there", async () => {
    const { daemon } = await signedIn(["o"]);

    await settled(() => nickIn("line 3") !== undefined);
    await press(nickIn("line 3"));
    await settled(() => daemon.membersRead.some((query) => query.includes("prefix=gone")));
    await settled(() => entries().includes("Ban gone"));

    expect(entries()).toStrictEqual([...everyone("gone"), "Ban gone"]);
  });

  it("offers nothing to operate where Self holds a rank below operator", async () => {
    await expect(offeredHolding(["h"])).resolves.toStrictEqual(everyone("peer"));
  });

  it("opens from a nick in an Activity's words by the keyboard, and from a sender by the context menu, in place of the Message's", async () => {
    await signedIn(["o"]);

    await settled(() => nickIn("joined") !== undefined);

    const joiner = nickIn("joined");

    await act(async () => {
      joiner?.focus();
      await Promise.resolve();
    });
    await key(joiner, "Enter");
    await settled(() => menu() !== null);

    const byKey = menu()?.getAttribute("aria-label");

    await escaped();

    await act(async () => {
      nickIn("line 2")?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
      );
      await Promise.resolve();
    });
    await settled(() => menu() !== null);

    expect({
      byKey,
      byMenu: menu()?.getAttribute("aria-label"),
      menus: document.querySelectorAll('[role="menu"]').length,
    }).toStrictEqual({ byKey: "What to do with peer", byMenu: "What to do with peer", menus: 1 });
  });

  it("opens on a long press of a touch", async () => {
    await signedIn(["o"]);

    await settled(() => nickIn("line 2") !== undefined);

    await touchDown();
    await pause(600);

    expect(menu()?.getAttribute("aria-label")).toBe("What to do with peer");
  });

  it("opens from a Lookup card's profile", async () => {
    const { container } = await signedIn(["o"], whoisPeer);
    const composer = container.querySelector("textarea");

    await act(async () => {
      Reflect.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        composer,
        "/whois peer"
      );
      composer?.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await key(composer, "Enter");

    await settled(() => profileNick() !== null);
    await press(profileNick());
    await settled(() => entries().length === 10);

    expect(entries()).toStrictEqual(operator("peer"));
  });

  it("acts on the Channel of the Pane it was opened in, never the focused Pane's", async () => {
    const { daemon, registry } = await signedIn(["o"]);

    await act(async () => {
      registry.set(paned, {
        _tag: "Split",
        axis: "Horizontal",
        timeline: Schema.decodeSync(TimelineId)(ops),
      });
      await Promise.resolve();
    });
    await settled(() => registry.get(focusedId) === "p1");
    await settled(() => nickIn("line 2", "p0") !== undefined);

    const nick = nickIn("line 2", "p0");

    // Reached by the keyboard, from a Pane not focused.
    await act(async () => {
      nick?.focus();
      await Promise.resolve();
    });
    await key(nick, "Enter");
    await settled(() => entries().includes("Kick peer"));

    const focused = registry.get(focusedId);

    await press(document.querySelector<HTMLElement>('[role="menuitem"][aria-label="Kick peer"]'));
    await settled(() => daemon.acts.length === 1);

    expect({ act: daemon.acts[0]?.action, focused }).toStrictEqual({
      act: { _tag: "Kick", channel: "#iirc", nicks: ["peer"], reason: null },
      focused: "p0",
    });
  });
});
