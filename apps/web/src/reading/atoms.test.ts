import { TimelineId } from "@iirc/api";
import type { Timeline, TimelineChangesEvent, TimelineItem } from "@iirc/api";
import { draftOf } from "@iirc/frontend/composer";
import type { Place } from "@iirc/frontend/composer";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { composerState, edit, send } from "../composer/atoms.ts";
import { pageState } from "../page/atoms.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run, until } from "../testing/fake-daemon.ts";
import { testNotifier } from "../testing/notifier.ts";
import { following, open, openTimeline, sync, timelinesState } from "../timelines/atoms.ts";
import { documentTitle, marking } from "./atoms.ts";

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const cursor = (at: number, sequence: number) =>
  `${hex(BigInt(at) + 2n ** 53n, 14)}-${hex(BigInt(sequence), 14)}-${hex(0n, 8)}`;

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;
const timelineId = Schema.decodeSync(TimelineId);

const own = idOf(1);
const iirc = idOf(2);
const other = idOf(3);
const peer = idOf(4);

type Counts = (typeof Timeline.Encoded)["unread"];

const none: Counts = { activity: 0, direct: 0, highlights: 0, messages: 0 };

const names = new Map<string, readonly [string, "Network" | "Channel" | "Direct"]>([
  [iirc, ["#iirc", "Channel"]],
  [other, ["#other", "Channel"]],
  [own, ["libera", "Network"]],
  [peer, ["peer", "Direct"]],
]);

/**
 * A Timeline as the Daemon lists it.
 * @param id - Its id.
 * @param more - How far it was read, what is unread, where its latest stands, and its step.
 * @returns The Timeline, as the wire carries it.
 */
const listed = (
  id: string,
  more: {
    readonly read?: number | null;
    readonly unread?: Partial<Counts>;
    readonly latest?: number;
    readonly changed?: number;
  } = {}
): typeof Timeline.Encoded => {
  const [name, kind] = names.get(id) ?? ["?", "Channel"];

  return {
    changed: more.changed ?? 1,
    detached: false,
    id,
    key: kind === "Network" ? null : name,
    kind,
    latest: more.latest === undefined ? null : cursor(more.latest, 1),
    name,
    network: "libera",
    read: more.read ?? null,
    unread: { ...none, ...more.unread },
  };
};

/**
 * A Message from `peer`.
 * @param timeline - Where.
 * @param sequence - Its step, and its time in seconds.
 * @param level - How much it calls for the Owner.
 * @returns The item, as the wire carries it.
 */
const message = (
  timeline: string,
  sequence: number,
  level: (typeof TimelineItem.Encoded)["level"] = "Message"
): typeof TimelineItem.Encoded => ({
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
    target: names.get(timeline)?.[0] ?? "?",
    text: level === "Highlight" ? `iirc: ping ${sequence}` : `line ${sequence}`,
  },
  level,
  network: "libera",
  position: cursor(sequence * 1000, sequence),
  sequence,
  timeline,
});

const changed = (
  sequence: number,
  items: readonly (typeof TimelineItem.Encoded)[],
  timelines: readonly (typeof Timeline.Encoded)[]
): typeof TimelineChangesEvent.Encoded => ({
  data: JSON.stringify({ gaps: [], items, merged: [], sequence, timelines }),
  event: "changed",
  id: `1.${sequence}`,
});

const seeing = { focused: true, visible: true };
const away = { focused: false, visible: false };

/**
 * A Daemon with libera's own Timeline, `#iirc` holding two unread Messages, `#other`, and a
 * Direct Message with `peer`, folded through step 2, and a browser signed in to it, its page
 * as given, following the Timelines and marking read.
 * @param page - Whether the Owner can see the page.
 * @returns The fake, the registry, and the test's Notifier.
 */
const reading = async (page = seeing) => {
  const fake = fakeDaemon();
  const notifier = testNotifier();

  fake.daemon.signedIn = true;
  fake.daemon.through = 2;
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: listed(own) },
    {
      gaps: [],
      items: [message(iirc, 1), message(iirc, 2)],
      timeline: listed(iirc, { latest: 2000, unread: { messages: 2 } }),
    },
    { gaps: [], items: [], timeline: listed(other) },
    { gaps: [], items: [], timeline: listed(peer) },
  ]);

  const registry = registryFor(fake.fetch, {}, notifier.port);

  registry.set(pageState, page);
  await run(registry, check, undefined);
  registry.mount(sync);
  registry.mount(marking);
  await eventually(() => fake.daemon.followers.length === 1);

  /**
   * Types a line into a composer and presses Enter.
   * @param place - Which composer.
   * @param text - What is typed.
   */
  const type = async (place: Place, text: string) => {
    registry.set(edit, { text, timeline: place });
    await run(registry, send, place);
  };

  /**
   * Says what the view would: the open Timeline is at its latest, its last item in view.
   * @param holding - How many items the window must hold by then.
   */
  const viewLatest = async (holding = 1) => {
    const shown = await until(
      registry,
      openTimeline,
      (one) => one._tag === "Shown" && one.window.items.length >= holding
    );

    if (shown._tag === "Shown") {
      registry.set(following, {
        following: true,
        seen: shown.window.items.at(-1)?.position,
        timeline: shown.timeline,
      });
    }
  };

  /**
   * Opens a Timeline, as the sidebar does, and says it is shown at its latest, as the view
   * does once it has laid out.
   * @param id - The Timeline.
   */
  const opening = async (id: string) => {
    registry.set(open, timelineId(id));
    await viewLatest();
  };

  return { ...fake, notifier: notifier.held, opening, registry, type, viewLatest };
};

/**
 * Waits a while, for what should not happen to have its chance.
 * @param millis - How long.
 */
const wait = async (millis: number) => {
  await Effect.runPromise(Effect.sleep(`${millis} millis`));
};

describe("marking read", () => {
  it("marks the open Timeline read once seen for a moment, up to its last item, and again for a new one", async () => {
    const { daemon, opening, send, viewLatest } = await reading();

    await opening(iirc);
    const before = daemon.reads.length;

    await eventually(() => daemon.reads.length === 1);

    // The Daemon's marker comes back: nothing more is due.
    send(changed(3, [], [listed(iirc, { changed: 3, latest: 2000, read: 2000 })]));
    await wait(150);
    const settled = daemon.reads.length;

    // A live item arrives while the Owner watches.
    send(
      changed(
        4,
        [message(iirc, 4)],
        [listed(iirc, { changed: 4, latest: 4000, read: 2000, unread: { messages: 1 } })]
      )
    );
    await viewLatest(3);
    await eventually(() => daemon.reads.length === 2);

    expect({ before, reads: daemon.reads, settled }).toStrictEqual({
      before: 0,
      reads: [
        { read: 2000, target: "#iirc" },
        { read: 4000, target: "#iirc" },
      ],
      settled: 1,
    });
  });

  it("marks nothing while the page is hidden or the Owner scrolled back, and marks once seen", async () => {
    const { daemon, opening, registry, viewLatest } = await reading(away);

    await opening(iirc);
    await wait(150);
    const hidden = daemon.reads.length;

    registry.set(following, { following: false, seen: undefined, timeline: timelineId(iirc) });
    registry.set(pageState, seeing);
    await wait(150);
    const back = daemon.reads.length;

    await viewLatest();
    await eventually(() => daemon.reads.length === 1);

    expect({ back, hidden, reads: daemon.reads }).toStrictEqual({
      back: 0,
      hidden: 0,
      reads: [{ read: 2000, target: "#iirc" }],
    });
  });

  it("marks nothing for a Timeline just opened until the view says it shows its latest", async () => {
    const { daemon, registry, viewLatest } = await reading();

    registry.set(open, timelineId(iirc));
    await until(registry, openTimeline, (shown) => shown._tag === "Shown");
    await wait(150);
    const unconfirmed = daemon.reads.length;

    await viewLatest();
    await eventually(() => daemon.reads.length === 1);

    expect({ reads: daemon.reads, unconfirmed }).toStrictEqual({
      reads: [{ read: 2000, target: "#iirc" }],
      unconfirmed: 0,
    });
  });

  it("asks again after a mark that got no answer", async () => {
    const { daemon, opening } = await reading();

    daemon.readFailures = 2;
    await opening(iirc);
    await eventually(() => daemon.reads.length === 1);

    expect(daemon.reads).toStrictEqual([{ read: 2000, target: "#iirc" }]);
  });

  it("marks the open Timeline read with /read, and every one with /read all", async () => {
    const { daemon, opening, registry, send, type } = await reading(away);

    await opening(iirc);
    await type(timelineId(iirc), "/read");
    const one = [...daemon.reads];

    send(
      changed(
        3,
        [message(other, 3), message(peer, 3, "Direct")],
        [
          listed(other, { changed: 3, latest: 3000, unread: { messages: 1 } }),
          listed(peer, { changed: 3, latest: 3000, unread: { direct: 1 } }),
        ]
      )
    );
    await until(registry, documentTitle, (title) => title === "(1) iirc");
    await type(timelineId(iirc), "/read all");

    expect({ all: daemon.reads.slice(one.length), one }).toStrictEqual({
      // `#iirc` once more, since the Daemon's marker never came back here.
      all: [
        { read: 2000, target: "#iirc" },
        { read: 3000, target: "#other" },
        { read: 3000, target: "peer" },
      ],
      one: [{ read: 2000, target: "#iirc" }],
    });
  });
});

describe("what calls for the Owner", () => {
  it("jumps to the Timeline calling most with /next-unread, and titles the page by it", async () => {
    const { opening, registry, send, type } = await reading(away);

    await opening(iirc);
    const calm = registry.get(documentTitle);

    send(
      changed(
        3,
        [message(other, 3, "Highlight"), message(peer, 3, "Direct")],
        [
          listed(other, { changed: 3, latest: 3000, unread: { highlights: 2, messages: 4 } }),
          listed(peer, { changed: 3, latest: 3000, unread: { direct: 1 } }),
        ]
      )
    );
    const calling = await until(registry, documentTitle, (title) => title !== calm);

    await type(timelineId(iirc), "/next-unread");
    const first = registry.get(timelinesState).open;

    await type(timelineId(other), "/next-unread");
    const second = registry.get(timelinesState).open;

    expect({ calling, calm, first, second }).toStrictEqual({
      calling: "(3) iirc",
      calm: "iirc",
      first: other,
      second: peer,
    });
  });
});

/**
 * The changes stream giving a Highlight from `peer`.
 * @param sequence - Its step.
 * @param timeline - Where.
 * @returns The event.
 */
const highlight = (sequence: number, timeline = other) =>
  changed(
    sequence,
    [message(timeline, sequence, "Highlight")],
    [listed(timeline, { changed: sequence, latest: sequence * 1000, unread: { highlights: 1 } })]
  );

describe("notifications", () => {
  it("notifies once turned on, a Timeline's latest replacing its last, and opens it when chosen", async () => {
    const { notifier, opening, registry, send, type } = await reading();

    await opening(iirc);

    // Off: nothing shows.
    send(highlight(3));
    await until(registry, documentTitle, (title) => title === "(1) iirc");
    const off = notifier.shown.length;

    await type(timelineId(iirc), "/notify on");
    const turnedOn = { on: notifier.on, requests: notifier.requests };

    send(highlight(4));
    send(highlight(5));
    // In the Timeline the Owner is looking at, nothing shows.
    send(highlight(6, iirc));
    await eventually(() => notifier.shown.length === 2);
    await wait(50);

    const shown = notifier.shown.map((one) => ({ body: one.body, tag: one.tag, title: one.title }));
    const showing = [...notifier.showing.keys()];

    notifier.showing.get(`iirc:${other}`)?.choose();
    const chosen = registry.get(timelinesState).open;

    await type(timelineId(other), "/notify off");
    send(highlight(7, iirc));
    await wait(50);

    expect({
      after: notifier.shown.length,
      chosen,
      off,
      showing,
      shown,
      turnedOn,
    }).toStrictEqual({
      after: 2,
      chosen: other,
      off: 0,
      showing: [`iirc:${other}`],
      shown: [
        {
          body: "<⁨peer⁩> ⁨iirc: ping 4⁩",
          tag: `iirc:${other}`,
          title: "⁨#other⁩ · libera",
        },
        {
          body: "<⁨peer⁩> ⁨iirc: ping 5⁩",
          tag: `iirc:${other}`,
          title: "⁨#other⁩ · libera",
        },
      ],
      turnedOn: { on: true, requests: 1 },
    });
  });

  it("notifies of the open Timeline while the page is hidden, and stays off when the browser refuses", async () => {
    const { notifier, opening, registry, send, type } = await reading(away);

    notifier.answer = "Denied";
    await opening(iirc);
    await type(timelineId(iirc), "/notify on");

    const refused = {
      notice: draftOf(registry.get(composerState), timelineId(iirc)).notice?.message,
      on: notifier.on,
    };

    notifier.answer = "Granted";
    await type(timelineId(iirc), "/notify on");
    send(highlight(3, iirc));
    await eventually(() => notifier.shown.length === 1);

    expect({ refused, tag: notifier.shown[0]?.tag }).toStrictEqual({
      refused: {
        notice:
          "This browser blocks notifications from iirc. Allow them in its settings for this site, then /notify on again.",
        on: false,
      },
      tag: `iirc:${iirc}`,
    });
  });
});
