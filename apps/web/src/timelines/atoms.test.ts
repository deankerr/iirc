import { TimelineId } from "@iirc/api";
import type { Timeline, TimelineChange, TimelineChangesEvent, TimelineItem } from "@iirc/api";
import type { Opened } from "@iirc/frontend/timelines";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run, until } from "../testing/fake-daemon.ts";
import type { FakeTimeline } from "../testing/fake-daemon.ts";
import { older, open, openTimeline, sidebarNetworks, sync, timelinesState } from "./atoms.ts";

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

/**
 * A position as the wire writes it.
 * @param at - Its time.
 * @param sequence - Its step.
 * @returns Its cursor.
 */
const cursor = (at: number, sequence: number) =>
  `${hex(BigInt(at) + 2n ** 53n, 14)}-${hex(BigInt(sequence), 14)}-${hex(0n, 8)}`;

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;

const networkTimeline = idOf(1);
const channel = idOf(2);
const iirc = Schema.decodeSync(TimelineId)(channel);

const describeTimeline = (
  id: string,
  name: string,
  kind: "Network" | "Channel",
  changed = 1
): typeof Timeline.Encoded => ({
  changed,
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

const message = (sequence: number, text = `line ${sequence}`): typeof TimelineItem.Encoded => ({
  changed: sequence,
  content: {
    _tag: "Message",
    at: { _tag: "Unknown" },
    id: { _tag: "Unknown" },
    kind: "Privmsg",
    live: true,
    ours: null,
    sender: "peer",
    tags: [],
    target: "#iirc",
    text,
  },
  level: "Message",
  network: "libera",
  position: cursor(sequence * 1000, sequence),
  sequence,
  timeline: channel,
});

const changed = (
  sequence: number,
  change: Partial<typeof TimelineChange.Encoded>
): typeof TimelineChangesEvent.Encoded => ({
  data: JSON.stringify({ gaps: [], items: [], merged: [], sequence, timelines: [], ...change }),
  event: "changed",
  id: `1.${sequence}`,
});

/**
 * A Daemon with one Network, its own Timeline, and `#iirc` holding messages 1 to `count`,
 * folded through step `count`, and a browser signed in to it following its Timelines.
 * @param count - How many messages `#iirc` holds.
 * @returns The fake, and the registry.
 */
const following = async (count = 2) => {
  const fake = fakeDaemon();

  const held: FakeTimeline = {
    gaps: [],
    items: Array.from({ length: count }, (_, index) => message(index + 1)),
    timeline: describeTimeline(channel, "#iirc", "Channel"),
  };

  fake.daemon.signedIn = true;
  fake.daemon.through = count;
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: describeTimeline(networkTimeline, "libera", "Network") },
    held,
  ]);

  const registry = registryFor(fake.fetch);

  await run(registry, check, undefined);
  registry.mount(sync);
  await eventually(() => fake.daemon.followers.length === 1);

  return { ...fake, held, registry };
};

const shownItems = (shown: Opened) =>
  shown._tag === "Shown" ? shown.window.items.map((item) => item.sequence) : [];

describe("following the Timelines", () => {
  it("reads the Networks and their Timelines, then follows the changes after what it read", async () => {
    const { daemon, registry } = await following();
    const sidebar = registry.get(sidebarNetworks);

    expect({
      after: daemon.followers.map((follower) => follower.after),
      connection: sidebar[0]?.connection._tag,
      timelines: sidebar[0]?.timelines.map((timeline) => timeline.name),
    }).toStrictEqual({
      after: ["1.2"],
      connection: "Connected",
      timelines: ["libera", "#iirc"],
    });
  });

  it("opens a Timeline on its latest, and shows a live item as it is said", async () => {
    const { registry, send } = await following();

    registry.set(open, iirc);
    const before = await until(registry, openTimeline, (shown) => shown._tag === "Shown");

    send(
      changed(3, {
        items: [message(3)],
        timelines: [describeTimeline(channel, "#iirc", "Channel", 3)],
      })
    );
    const after = await until(registry, openTimeline, (shown) => shownItems(shown).length === 3);

    expect({ after: shownItems(after), before: shownItems(before) }).toStrictEqual({
      after: [1, 2, 3],
      before: [1, 2],
    });
  });

  it("follows again from the last place it was given when the stream ends", async () => {
    const { daemon, endStreams, registry, send } = await following();

    send(changed(3, { items: [message(3)] }));
    await until(registry, timelinesState, (state) =>
      state.follow._tag === "Following" ? state.follow.place?.sequence === 3 : false
    );

    endStreams();
    await eventually(() => daemon.followers.length === 1);

    expect(daemon.followers.map((follower) => follower.after)).toStrictEqual(["1.3"]);
  });

  it("gives up opening the stream when no answer begins, and follows again from the core's place", async () => {
    const fake = fakeDaemon();

    fake.daemon.signedIn = true;
    fake.daemon.through = 2;
    fake.daemon.timelines.set("libera", [
      { gaps: [], items: [], timeline: describeTimeline(networkTimeline, "libera", "Network") },
    ]);

    const registry = registryFor(fake.fetch, { idle: "100 millis" });

    await run(registry, check, undefined);
    registry.mount(sync);
    await eventually(() => fake.daemon.followers.length === 1);

    // The stream moves the core's place, then the Daemon stops answering followers.
    fake.send(changed(3, {}));
    await until(registry, timelinesState, (state) =>
      state.follow._tag === "Following" ? state.follow.place?.sequence === 3 : false
    );
    fake.daemon.hangChanges = true;
    fake.endStreams();
    await eventually(() => fake.daemon.abandoned >= 1);

    // It answers again: the next follower asks from where the core is.
    fake.daemon.hangChanges = false;
    await eventually(() => fake.daemon.followers.length === 1);

    expect({
      after: fake.daemon.followers.map((follower) => follower.after),
      hung: fake.daemon.hung[0],
    }).toStrictEqual({ after: ["1.3"], hung: "1.3" });
  });

  it("takes the Network list as current from when it was asked, after waiting to ask again", async () => {
    // The reducer's property drains the stream before it settles, so it never has overflows
    // arrive while the runtime waits to ask again and none while it asks. Here they do: the
    // list must be current from where the stream was when it was asked, not when the read
    // was taken on before the wait, or every attempt is stale while the traffic lasts.
    const fake = fakeDaemon();

    fake.daemon.signedIn = true;
    fake.daemon.through = 2;
    fake.daemon.timelines.set("libera", [
      { gaps: [], items: [], timeline: describeTimeline(networkTimeline, "libera", "Network") },
    ]);

    const registry = registryFor(fake.fetch, { longest: "300 millis", retry: "150 millis" });

    await run(registry, check, undefined);
    registry.mount(sync);
    await eventually(() => fake.daemon.followers.length === 1);
    await until(registry, timelinesState, (state) => state.entries.fresh);

    let sequence = 2;

    // An overflow that touched everything, as a step that configured a Network may be,
    // once the core has it.
    const overflow = async () => {
      sequence += 1;
      const sent = sequence;

      fake.send({
        data: JSON.stringify({ sequence: sent, timelines: null }),
        event: "overflowed",
        id: `1.${sent}`,
      });
      await until(registry, timelinesState, (state) =>
        state.follow._tag === "Following" ? state.follow.place?.sequence === sent : false
      );
    };

    // A Network is configured, which only the list will say. The list is asked for, and an
    // overflow comes while it is asked, so its answer is stale and it is asked for again.
    fake.daemon.timelines.set("beta", [
      { gaps: [], items: [], timeline: describeTimeline(idOf(9), "beta", "Network") },
    ]);
    fake.daemon.holdNetworks = true;
    await overflow();
    await eventually(() => fake.daemon.networksHeld.length === 1);
    await overflow();
    fake.daemon.networksHeld.shift()?.();

    // While the runtime waits to ask again, overflows keep coming. When it asks, they stop,
    // and its answer is released.
    for (let round = 0; round < 3 && !registry.get(timelinesState).entries.fresh; round += 1) {
      while (fake.daemon.networksHeld.length === 0) {
        // oxlint-disable-next-line no-await-in-loop -- one overflow at a time, until it asks
        await overflow();
        // oxlint-disable-next-line no-await-in-loop -- one overflow at a time, until it asks
        await Effect.runPromise(Effect.sleep("20 millis"));
      }

      fake.daemon.networksHeld.shift()?.();
      // oxlint-disable-next-line no-await-in-loop -- the answer is taken before the next round
      await until(
        registry,
        timelinesState,
        (state) => !state.entries.reading || state.entries.fresh
      );
    }

    const sidebar = await until(registry, sidebarNetworks, (held) => held.length === 2);

    expect({
      fresh: registry.get(timelinesState).entries.fresh,
      networks: sidebar.map((network) => network.network),
    }).toStrictEqual({ fresh: true, networks: ["beta", "libera"] });
  });

  it("ignores a heartbeat", async () => {
    const { registry, send } = await following();
    const state = registry.get(timelinesState);

    send({ data: "{}", event: "heartbeat" });
    send(changed(3, {}));
    await until(registry, timelinesState, (now) => now !== state);

    expect(registry.get(timelinesState).networks).toStrictEqual(state.networks);
  });

  it("reads the open window again when an overflow names it, and everything on a reset", async () => {
    const { daemon, registry, send } = await following();

    registry.set(open, iirc);
    await until(registry, openTimeline, (shown) => shown._tag === "Shown");
    const first = daemon.windowsRead.length;

    send({
      data: JSON.stringify({ sequence: 3, timelines: [channel] }),
      event: "overflowed",
      id: "1.3",
    });
    await eventually(() => daemon.windowsRead.length === first + 1);

    daemon.through = 9;
    send({ data: JSON.stringify({ through: 9, version: 1 }), event: "reset" });
    await eventually(() => daemon.windowsRead.length === first + 2);
    const shown = await until(registry, openTimeline, (now) => now._tag === "Shown");

    expect({
      place:
        registry.get(timelinesState).follow._tag === "Following"
          ? registry.get(timelinesState).follow
          : undefined,
      shown: shownItems(shown),
    }).toMatchObject({ place: { place: { sequence: 9, version: 1 } }, shown: [1, 2] });
  });

  it("reads older items before the first it holds, as the Owner scrolls up", async () => {
    const { daemon, registry } = await following(150);

    registry.set(open, iirc);
    const latest = await until(registry, openTimeline, (shown) => shown._tag === "Shown");

    registry.set(older, { mode: "Auto", timeline: iirc });
    const all = await until(registry, openTimeline, (shown) => shownItems(shown).length === 150);

    expect({
      all: shownItems(all).at(0),
      latest: shownItems(latest).at(0),
      reads: daemon.windowsRead,
    }).toStrictEqual({
      all: 1,
      latest: 51,
      reads: ["?limit=100", `?before=${cursor(51_000, 51)}&limit=100`],
    });
  });
});
