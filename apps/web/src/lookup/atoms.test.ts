import { TimelineId } from "@iirc/api";
import type { TimeShown, Timeline } from "@iirc/api";
import { draftOf } from "@iirc/frontend/composer";
import { Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { edit, send } from "../composer/atoms.ts";
import { composerState } from "../composer/composer-state.ts";
import { deviceUi } from "../options/device.ts";
import { check, signInWithKey, signOut } from "../sign-in/atoms.ts";
import {
  eventually,
  fakeDaemon,
  profileOf,
  registryFor,
  run,
  theKey,
  until,
} from "../testing/fake-daemon.ts";
import type { LookScript } from "../testing/fake-daemon.ts";
import { open, openTimeline, paned, sync } from "../timelines/atoms.ts";
import type { WaitTimes } from "../timelines/atoms.ts";
import { lookupSync, lookupsState, paneCard } from "./atoms.ts";

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;
const timelineId = Schema.decodeSync(TimelineId);

const own = idOf(1);
const iirc = idOf(2);

const none = { activity: 0, botDirect: 0, botMessages: 0, direct: 0, highlights: 0, messages: 0 };

const listed = (
  id: string,
  name: string,
  kind: "Network" | "Channel" | "Direct"
): typeof Timeline.Encoded => ({
  changed: 1,
  closed: false,
  detached: false,
  head: null,
  id,
  key: kind === "Network" ? null : name.toLowerCase(),
  kind,
  latest: null,
  life: 1,
  name,
  network: "libera",
  read: null,
  removed: false,
  unread: none,
});

/** `peer`, as a `WHOIS` describes them, in `#iirc` as an operator and in `#elsewhere`. */
const found: LookScript["result"] = {
  _tag: "Found",
  notes: [],
  profiles: [
    profileOf({
      channels: [
        { name: "#iirc", prefixes: ["o"] },
        { name: "#elsewhere", prefixes: [] },
      ],
      host: "example.test",
      realname: "Peer Pal",
      user: "~peer",
    }),
  ],
};

/**
 * As `inChannel`, with waits other than the tests'.
 * @param waits - The waits.
 * @param scripts - How the Daemon answers each `look`, first to last.
 * @returns The fake and the registry.
 */
const inChannelWaiting = async (waits: Partial<WaitTimes>, ...scripts: readonly LookScript[]) => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: listed(own, "libera", "Network") },
    { gaps: [], items: [], timeline: listed(iirc, "#iirc", "Channel") },
  ]);
  fake.daemon.lookScripts.push(...scripts);

  const registry = registryFor(fake.fetch, waits);

  await run(registry, check, undefined);
  registry.mount(sync);
  registry.mount(lookupSync);
  await eventually(() => fake.daemon.followers.length === 1);
  registry.set(open, timelineId(iirc));
  await until(registry, openTimeline, (shown) => shown._tag === "Shown");

  return { ...fake, registry };
};

/**
 * A Daemon with libera's own Timeline and `#iirc`, and a browser signed in to it,
 * following the Timelines, with `#iirc` open.
 * @param scripts - How the Daemon answers each `look`, first to last.
 * @returns The fake and the registry.
 */
const inChannel = async (...scripts: readonly LookScript[]) =>
  await inChannelWaiting({}, ...scripts);

/**
 * Types a line into `#iirc`'s composer and sends it.
 * @param registry - The registry.
 * @param line - The line.
 */
const typeAndSend = async (
  registry: Awaited<ReturnType<typeof inChannel>>["registry"],
  line: string
) => {
  registry.set(edit, { text: line, timeline: timelineId(iirc) });
  await run(registry, send, timelineId(iirc));
};

describe("a Lookup", () => {
  it("is asked once under the intent the runtime named, and shows its User in the Pane", async () => {
    const { daemon, registry } = await inChannel({ answer: "LookedUp", pending: 0, result: found });

    await typeAndSend(registry, "/whois peer");

    const card = await until(
      registry,
      paneCard("p0"),
      (shown) =>
        shown?.body._tag === "Profiles" &&
        shown.body.profiles[0]?.channels[0]?.choose?._tag === "Open"
    );

    const profile = card?.body._tag === "Profiles" ? card.body.profiles[0] : undefined;

    expect({
      channels: profile?.channels.map((channel) => [channel.symbols, channel.name, channel.choose]),
      draft: draftOf(registry.get(composerState), timelineId(iirc)).text,
      looks: daemon.looks,
      mask: profile?.mask,
      realname: profile?.realname,
    }).toStrictEqual({
      channels: [
        ["@", "#iirc", { _tag: "Open", timeline: timelineId(iirc) }],
        ["", "#elsewhere", { _tag: "FocusComposer", text: "/join #elsewhere" }],
      ],
      draft: "",
      looks: [{ intent: "web-1", lookup: { _tag: "Whois", nick: "peer" }, network: "libera" }],
      mask: "~peer@example.test",
      realname: "Peer Pal",
    });
  });

  it("still pending is asked after by its intent until it settles, and never sent again", async () => {
    const { daemon, registry } = await inChannel({ answer: "Pending", pending: 2, result: found });

    await typeAndSend(registry, "/whowas peer");

    await until(registry, paneCard("p0"), (shown) => shown?.body._tag === "Profiles");

    expect({
      looked: daemon.looked,
      looks: daemon.looks.map((one) => [one.intent, one.lookup._tag]),
    }).toStrictEqual({ looked: ["web-1", "web-1", "web-1"], looks: [["web-1", "Whowas"]] });
  });

  it("with no answer, or stopped, is asked after by its intent, and never sent again", async () => {
    const { daemon, registry } = await inChannel(
      { answer: "Lost", pending: 1, result: found },
      { answer: "NetworkStopped", pending: 0, result: found }
    );

    await typeAndSend(registry, "/whois peer");
    await until(registry, paneCard("p0"), (shown) => shown?.body._tag === "Profiles");

    await typeAndSend(registry, "/whois peer");

    const stopped = await until(registry, paneCard("p0"), (shown) => shown?.body._tag === "Said");

    expect({
      looked: daemon.looked,
      looks: daemon.looks.map((one) => one.intent),
      stopped: stopped?.body._tag === "Said" ? stopped.body.words : undefined,
    }).toStrictEqual({
      looked: ["web-1", "web-1", "web-2"],
      looks: ["web-1", "web-2"],
      stopped: "The network stopped before the request finished. Try again.",
    });
  });

  it("shows a signon no Date can hold as unavailable, and the rest of the User", async () => {
    // `317 self peer 0 9000000000000`: seconds past what a Date holds, yet an Instant.
    const { registry } = await inChannel({
      answer: "LookedUp",
      pending: 0,
      result: {
        _tag: "Found",
        notes: [],
        profiles: [profileOf({ realname: "Peer Pal", signon: 9e15 })],
      },
    });

    await typeAndSend(registry, "/whois peer");

    const card = await until(registry, paneCard("p0"), (shown) => shown?.body._tag === "Profiles");
    const profile = card?.body._tag === "Profiles" ? card.body.profiles[0] : undefined;

    expect([profile?.signon, profile?.realname]).toStrictEqual([
      "sign-on time unavailable",
      "Peer Pal",
    ]);
  });

  it("shows a signon in the form ui.conversation.timeFormat gives, as HH:mm under none", async () => {
    // Local mid-afternoon, so no form of the clock writes it as another does.
    const signon = new Date(2026, 10, 15, 15, 7, 9);

    const { registry } = await inChannel({
      answer: "LookedUp",
      pending: 0,
      result: {
        _tag: "Found",
        notes: [],
        profiles: [profileOf({ realname: "Peer Pal", signon: signon.getTime() })],
      },
    });

    await typeAndSend(registry, "/whois peer");
    await until(registry, paneCard("p0"), (shown) => shown?.body._tag === "Profiles");

    const drawn = (time: TimeShown) => {
      registry.set(deviceUi, { "conversation.timeFormat": time });
      const card = registry.get(paneCard("p0"));

      return card?.body._tag === "Profiles" ? card.body.profiles[0]?.signon : undefined;
    };

    const written = (options: Intl.DateTimeFormatOptions) =>
      `signed on ${new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        ...options,
      }).format(signon)}`;

    const twentyFour = { hour: "2-digit", hourCycle: "h23", minute: "2-digit" } as const;
    const twelve = { hour: "numeric", hourCycle: "h12", minute: "2-digit" } as const;

    expect({ none: drawn("none"), twelve: drawn("h:mm a") }).toStrictEqual({
      none: written(twentyFour),
      twelve: written(twelve),
    });
    expect(drawn("h:mm a")).not.toBe(drawn("none"));
  });

  it("whose look is never answered gives up at its deadline, and asks after it by intent once its request times out", async () => {
    const held = await inChannelWaiting(
      { lookRequest: "5 seconds", lookup: "300 millis" },
      { answer: "LookedUp", pending: 0, result: found }
    );

    held.daemon.holdLooks = true;
    await typeAndSend(held.registry, "/whois peer");

    const gaveUp = await until(
      held.registry,
      paneCard("p0"),
      (shown) => shown?.body._tag === "Said"
    );

    const timedOut = await inChannelWaiting(
      { lookRequest: "100 millis", lookup: "2 seconds" },
      { answer: "LookedUp", pending: 0, result: found }
    );

    timedOut.daemon.holdLooks = true;
    await typeAndSend(timedOut.registry, "/whois peer");
    await until(timedOut.registry, paneCard("p0"), (shown) => shown?.body._tag === "Profiles");

    expect({
      gaveUp: gaveUp?.body._tag === "Said" ? gaveUp.body.words : undefined,
      heldAsked: held.daemon.looked,
      timedOut: [timedOut.daemon.looks.length, timedOut.daemon.looked],
    }).toStrictEqual({
      gaveUp: "The daemon did not answer in time. Try again.",
      heldAsked: [],
      timedOut: [1, ["web-1"]],
    });
  });

  it("asked after by a request never answered gives up at its deadline", async () => {
    const held = await inChannelWaiting(
      { lookRequest: "5 seconds", lookup: "300 millis" },
      { answer: "Pending", pending: 0, result: found }
    );

    held.daemon.holdLooked = true;
    await typeAndSend(held.registry, "/whois peer");

    const gaveUp = await until(
      held.registry,
      paneCard("p0"),
      (shown) => shown?.body._tag === "Said"
    );

    expect({
      gaveUp: gaveUp?.body._tag === "Said" ? gaveUp.body.words : undefined,
      heldAsked: held.daemon.looked,
    }).toStrictEqual({
      gaveUp: "The daemon did not answer in time. Try again.",
      heldAsked: ["web-1"],
    });
  });

  it("is let go of with its Pane, shown again after a zoom, and gone after signing out and in", async () => {
    const { daemon, registry } = await inChannel(
      { answer: "Pending", pending: 1000, result: found },
      { answer: "Pending", pending: 1000, result: found }
    );

    // Two Panes, the card in the first, which a zoom of the second hides.
    registry.set(paned, { _tag: "Split", axis: "Horizontal", timeline: undefined });
    registry.set(paned, { _tag: "Focus", pane: "p0" });
    await typeAndSend(registry, "/whois peer");
    await until(registry, paneCard("p0"), (shown) => shown?.body._tag === "Waiting");
    registry.set(paned, { _tag: "Focus", pane: "p1" });
    registry.set(paned, { _tag: "Zoom" });
    registry.set(paned, { _tag: "Zoom" });
    registry.set(paned, { _tag: "Focus", pane: "p0" });

    const unzoomed = registry.get(paneCard("p0")) !== undefined;

    // Closing its Pane lets the card go.
    registry.set(paned, { _tag: "Close" });
    await until(registry, lookupsState, (state) => state.cards.size === 0);

    // A card made again, then signing out and in, and the same Timeline opened again.
    registry.set(open, timelineId(iirc));
    await until(registry, openTimeline, (shown) => shown._tag === "Shown");
    await typeAndSend(registry, "/whois peer");
    await until(registry, lookupsState, (state) => state.cards.size === 1);
    await run(registry, signOut, undefined);
    await run(registry, signInWithKey, Redacted.make(theKey));
    await eventually(() => daemon.followers.length >= 1);
    registry.set(open, timelineId(iirc));
    await until(registry, openTimeline, (shown) => shown._tag === "Shown");

    expect({
      cards: registry.get(lookupsState).cards.size,
      shown: registry.get(paneCard("p0")),
      unzoomed,
    }).toStrictEqual({
      cards: 0,
      shown: undefined,
      unzoomed: true,
    });
  });
});
