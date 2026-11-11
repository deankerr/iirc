import { TimelineId } from "@iirc/api";
import type { Timeline } from "@iirc/api";
import { draftOf } from "@iirc/frontend/composer";
import { Effect, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { composerState, edit, send } from "../composer/atoms.ts";
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
import { dismissCard, lookupSync, lookupsState, paneCard } from "./atoms.ts";

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;
const timelineId = Schema.decodeSync(TimelineId);

const own = idOf(1);
const iirc = idOf(2);

const none = { activity: 0, direct: 0, highlights: 0, messages: 0 };

const listed = (
  id: string,
  name: string,
  kind: "Network" | "Channel" | "Direct"
): typeof Timeline.Encoded => ({
  changed: 1,
  detached: false,
  id,
  key: kind === "Network" ? null : name.toLowerCase(),
  kind,
  latest: null,
  name,
  network: "libera",
  read: null,
  unread: none,
});

/** `peer`, as a `WHOIS` describes them, in `#iirc` as an operator and in `#elsewhere`. */
const found: LookScript["result"] = {
  _tag: "Found",
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

const wait = async (millis: number) => {
  await Effect.runPromise(Effect.sleep(`${millis} millis`));
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

  it("says in words what found no one, and what the Client refused", async () => {
    const { registry } = await inChannel(
      { answer: "LookedUp", pending: 0, result: { _tag: "NotFound", reply: "401" } },
      { answer: "LookedUp", pending: 0, result: { _tag: "Refused", reason: "Offline" } }
    );

    const words = async () => {
      const shown = await until(registry, paneCard("p0"), (card) => card?.body._tag === "Said");

      return shown?.body._tag === "Said" ? shown.body.words : undefined;
    };

    await typeAndSend(registry, "/whois nobody");
    const notFound = await words();

    await typeAndSend(registry, "/whois peer");
    await until(registry, lookupsState, (state) => state.next === 3);
    const refused = await words();

    expect([notFound, refused]).toStrictEqual([
      "No one uses the nick nobody now (401).",
      "Not looked up: the Network is not connected.",
    ]);
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
      stopped: "The Network stopped before it was looked up. Try again.",
    });
  });

  it("is let go of when its card is put away, and gives up once its time has passed", async () => {
    const { daemon, registry } = await inChannel(
      { answer: "Pending", pending: 1000, result: found },
      { answer: "Pending", pending: 1000, result: found }
    );

    await typeAndSend(registry, "/whois peer");
    await eventually(() => daemon.looked.length >= 2);
    registry.set(dismissCard, "p0");

    const after = daemon.looked.length;

    await wait(150);

    const letGo = daemon.looked.length - after;

    await typeAndSend(registry, "/whois peer");

    const gaveUp = await until(registry, paneCard("p0"), (shown) => shown?.body._tag === "Said");

    expect({
      gaveUp: gaveUp?.body._tag === "Said" ? gaveUp.body.words : undefined,
      letGo,
    }).toStrictEqual({
      gaveUp: "No result came from the Daemon in time. Try again.",
      letGo: 0,
    });
  });

  it("is refused in words before anything is sent, for a name that is no nick", async () => {
    const { daemon, registry } = await inChannel();

    await typeAndSend(registry, "/whois #iirc");

    expect({
      looks: daemon.looks,
      notice: draftOf(registry.get(composerState), timelineId(iirc)).notice?.message,
    }).toStrictEqual({
      looks: [],
      notice: "That is a Channel's name. A Lookup takes a nick. /whois <nick>",
    });
  });

  it("shows a signon no Date can hold as unavailable, and the rest of the User", async () => {
    // `317 self peer 0 9000000000000`: seconds past what a Date holds, yet an Instant.
    const { registry } = await inChannel({
      answer: "LookedUp",
      pending: 0,
      result: { _tag: "Found", profiles: [profileOf({ realname: "Peer Pal", signon: 9e15 })] },
    });

    await typeAndSend(registry, "/whois peer");

    const card = await until(registry, paneCard("p0"), (shown) => shown?.body._tag === "Profiles");
    const profile = card?.body._tag === "Profiles" ? card.body.profiles[0] : undefined;

    expect([profile?.signon, profile?.realname]).toStrictEqual([
      "sign-on time unavailable",
      "Peer Pal",
    ]);
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
      gaveUp: "No result came from the Daemon in time. Try again.",
      heldAsked: [],
      timedOut: [1, ["web-1"]],
    });
  });

  it("asked after by a request never answered gives up at its deadline, and one answered just before it holds", async () => {
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

    const answered = await inChannelWaiting(
      { lookRequest: "5 seconds", lookup: "500 millis" },
      { answer: "Pending", pending: 0, result: found }
    );

    answered.daemon.holdLooked = true;
    await typeAndSend(answered.registry, "/whois peer");
    await eventually(() => answered.daemon.lookedHeld.length === 1);
    await wait(300);

    for (const release of answered.daemon.lookedHeld.splice(0)) {
      release();
    }

    await until(answered.registry, paneCard("p0"), (shown) => shown?.body._tag === "Profiles");
    await wait(400);

    expect({
      after: answered.registry.get(paneCard("p0"))?.body._tag,
      gaveUp: gaveUp?.body._tag === "Said" ? gaveUp.body.words : undefined,
      heldAsked: held.daemon.looked,
    }).toStrictEqual({
      after: "Profiles",
      gaveUp: "No result came from the Daemon in time. Try again.",
      heldAsked: ["web-1"],
    });
  });

  it("is let go of with its Pane, kept while a zoom hides it, and gone after signing out and in", async () => {
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
    await wait(50);

    const zoomed = registry.get(lookupsState).cards.has("p0");

    registry.set(paned, { _tag: "Zoom" });
    registry.set(paned, { _tag: "Focus", pane: "p0" });

    const unzoomed = registry.get(paneCard("p0")) !== undefined;

    // Closing its Pane lets the card go, and its asking with it.
    registry.set(paned, { _tag: "Close" });
    await until(registry, lookupsState, (state) => state.cards.size === 0);

    const asked = daemon.looked.length;

    await wait(150);

    const askedAfterClose = daemon.looked.length - asked;

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
      askedAfterClose,
      cards: registry.get(lookupsState).cards.size,
      shown: registry.get(paneCard("p0")),
      unzoomed,
      zoomed,
    }).toStrictEqual({
      askedAfterClose: 0,
      cards: 0,
      shown: undefined,
      unzoomed: true,
      zoomed: true,
    });
  });
});
