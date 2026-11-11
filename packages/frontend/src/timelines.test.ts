import {
  NetworkEntry,
  NetworkId,
  SearchResults,
  Sequence,
  SessionKnowledge,
  Timeline,
  TimelineChange,
  TimelineId,
  TimelineItem,
  TimelineList,
  TimelineWindow,
  WindowGap,
} from "@iirc/api";
import { Option, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { panesOf, single } from "./layout.ts";
import { parseQuery } from "./search.ts";
import type { SearchRequest } from "./search.ts";
import {
  emptyView,
  followFrom,
  initialTimelines,
  keptLayout,
  KeptLayoutSchema,
  layoutKept,
  layoutKeptText,
  longestKept,
  mainOf,
  openOf,
  olderUnasked,
  opened,
  reduceTimelines,
  resolve,
  rowsOf,
  sidebar,
  timelinesWith,
  wanted,
  windowCap,
} from "./timelines.ts";
import type {
  PaneChange,
  Place,
  Read,
  Row,
  Timelines,
  TimelinesEvent,
  WindowRequest,
} from "./timelines.ts";

// Wire forms, parsed as the API parses them, so every value here is one the runtime could
// hand the reducer.

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

/**
 * A position as the wire writes it.
 * @param at - Its time.
 * @param sequence - Its step.
 * @returns Its cursor.
 */
const cursor = (at: number, sequence: number) =>
  `${hex(BigInt(at) + 2n ** 53n, 14)}-${hex(BigInt(sequence), 14)}-${hex(0n, 8)}`;

/**
 * The id of the Timeline a step opened.
 * @param sequence - The step.
 * @returns The id, as the wire writes it.
 */
const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;

const decodeItem = Schema.decodeSync(TimelineItem);
const decodeTimeline = Schema.decodeSync(Timeline);
const decodeList = Schema.decodeSync(TimelineList);
const decodeWindow = Schema.decodeSync(TimelineWindow);
const decodeChange = Schema.decodeSync(TimelineChange);
const decodeKeptOption = Schema.decodeUnknownOption(Schema.fromJsonString(KeptLayoutSchema));

/**
 * A layout kept, read back from its JSON as the runtime reads it.
 * @param text - The JSON.
 * @returns The layout as kept, or none when it is not one.
 */
const decodeKept = (text: string) => Option.getOrUndefined(decodeKeptOption(text));
const decodeGap = Schema.decodeSync(WindowGap);
const decodeEntries = Schema.decodeSync(Schema.Array(NetworkEntry));
const decodeSession = Schema.decodeSync(SessionKnowledge);
const networkId = Schema.decodeSync(NetworkId);
const timelineId = Schema.decodeSync(TimelineId);
const sequenceOf = Schema.decodeSync(Sequence);

// A model Daemon: steps folded into Timelines, items, and Gaps, which it reads and whose
// changes it gives as the API does.

interface Spot {
  readonly at: number;
  readonly sequence: number;
}

const compareSpots = (left: Spot, right: Spot) =>
  left.at - right.at || left.sequence - right.sequence;

interface ModelTimeline {
  readonly id: string;
  readonly network: string;
  readonly kind: "Network" | "Channel";
  readonly changed: number;
  readonly latest: Spot | undefined;
}

type ItemKind = "Message" | "SessionBegan" | "SessionEnded";

interface ModelItem {
  readonly timeline: string;
  readonly network: string;
  readonly spot: Spot;
  readonly changed: number;
  readonly kind: ItemKind;
  readonly confirmed: boolean;
}

interface ModelGap {
  readonly network: string;
  readonly from: Spot;
  readonly to: Spot | undefined;
  readonly changed: number;
}

interface World {
  readonly timelines: readonly ModelTimeline[];
  readonly items: readonly ModelItem[];
  readonly gaps: readonly ModelGap[];
}

const emptyWorld: World = { gaps: [], items: [], timelines: [] };

/**
 * A choice the generator made, read against the world as it stands, so every step is one
 * the world allows.
 */
interface Choice {
  readonly what: number;
  readonly pick: number;
  readonly late: boolean;
  readonly overflow: "None" | "Named" | "All";
}

const networks = ["alpha", "beta"] as const;

/**
 * Touches a Timeline: its last change, and where its latest item stands.
 * @param world - The world.
 * @param id - The Timeline.
 * @param sequence - The step.
 * @param spot - Where its new item stands, if it has one.
 * @returns The world.
 */
const touch = (world: World, id: string, sequence: number, spot?: Spot): World => ({
  ...world,
  timelines: world.timelines.map((timeline) => {
    if (timeline.id !== id) {
      return timeline;
    }

    const latest =
      spot !== undefined &&
      (timeline.latest === undefined || compareSpots(spot, timeline.latest) > 0)
        ? spot
        : timeline.latest;

    return { ...timeline, changed: sequence, latest };
  }),
});

/**
 * Adds an item to a Timeline.
 * @param world - The world.
 * @param timeline - The Timeline.
 * @param item - The item.
 * @returns The world.
 */
const addItem = (world: World, timeline: ModelTimeline, item: ModelItem): World =>
  touch({ ...world, items: [...world.items, item] }, timeline.id, item.changed, item.spot);

/**
 * Opens a Timeline: a Network's own on its first step, or a Channel's.
 * @param world - The world.
 * @param network - Its Network.
 * @param kind - Its kind.
 * @param sequence - The step.
 * @returns The world.
 */
const openTimeline = (
  world: World,
  network: string,
  kind: ModelTimeline["kind"],
  sequence: number
): World => ({
  ...world,
  timelines: [
    ...world.timelines,
    { changed: sequence, id: idOf(sequence), kind, latest: undefined, network },
  ],
});

/**
 * Starts or ends a Session of a Network: an item in its own Timeline, and a Gap that begins
 * or ends where the item stands.
 * @param world - The world.
 * @param network - The Network.
 * @param sequence - The step.
 * @returns The world.
 */
const toggleSession = (world: World, network: string, sequence: number): World => {
  const own = world.timelines.find((one) => one.network === network && one.kind === "Network");
  const open = world.gaps.find((gap) => gap.network === network && gap.to === undefined);
  const spot = { at: sequence * 10, sequence };

  if (own === undefined) {
    return world;
  }

  const kind: ItemKind = open === undefined ? "SessionEnded" : "SessionBegan";

  const gaps =
    open === undefined
      ? [...world.gaps, { changed: sequence, from: spot, network, to: undefined }]
      : world.gaps.map((gap) => (gap === open ? { ...gap, changed: sequence, to: spot } : gap));

  return addItem({ ...world, gaps }, own, {
    changed: sequence,
    confirmed: false,
    kind,
    network,
    spot,
    timeline: own.id,
  });
};

/**
 * One step of the world, as a choice reads against it.
 * @param world - The world before.
 * @param choice - The choice.
 * @param sequence - The step's sequence.
 * @param quiet - Whether the second Network is never heard from once configured.
 * @returns The world after.
 */
const stepWorld = (world: World, choice: Choice, sequence: number, quiet = false): World => {
  // A quiet second Network is configured and then never heard from, so only a read of the
  // Network list can find it once the stream has passed its first step.
  const channels = world.timelines.filter(
    (one) => one.kind === "Channel" && !(quiet && one.network === "beta")
  );

  const present = networks.filter((network) =>
    world.timelines.some((one) => one.network === network)
  );

  const network = quiet ? "alpha" : (present[choice.pick % present.length] ?? "alpha");

  if (!world.timelines.some((one) => one.network === "alpha")) {
    return openTimeline(world, "alpha", "Network", sequence);
  }

  switch (choice.what) {
    case 0: {
      // A Network configured since, or a Channel joined.
      return present.length < networks.length && choice.pick % 4 === 0
        ? openTimeline(world, "beta", "Network", sequence)
        : openTimeline(world, network, "Channel", sequence);
    }

    case 3: {
      const ours = world.items.filter((item) => item.kind === "Message" && !item.confirmed);
      const confirming = ours[choice.pick % Math.max(1, ours.length)];

      if (confirming !== undefined) {
        return touch(
          {
            ...world,
            items: world.items.map((item) =>
              item === confirming ? { ...item, changed: sequence, confirmed: true } : item
            ),
          },
          confirming.timeline,
          sequence
        );
      }

      break;
    }

    case 4: {
      return toggleSession(world, network, sequence);
    }

    default: {
      break;
    }
  }

  const timeline = channels[choice.pick % Math.max(1, channels.length)];

  if (timeline === undefined) {
    return openTimeline(world, network, "Channel", sequence);
  }

  // History that arrives late stands where its time puts it, among what came before.
  const at = choice.late ? (choice.pick * 7) % (sequence * 10) : sequence * 10;

  return addItem(world, timeline, {
    changed: sequence,
    confirmed: false,
    kind: "Message",
    network: timeline.network,
    spot: { at, sequence },
    timeline: timeline.id,
  });
};

// The wire forms of the model.

const unknown = { _tag: "Unknown" } as const;

/**
 * What a model item shows, as the wire carries it.
 * @param item - The item.
 * @returns Its content.
 */
const wireContent = (item: ModelItem): (typeof TimelineItem.Encoded)["content"] => {
  switch (item.kind) {
    case "SessionBegan": {
      return { _tag: "SessionBegan", at: item.spot.at, nick: "iirc" };
    }

    case "SessionEnded": {
      return { _tag: "SessionEnded", at: item.spot.at, reason: { _tag: "Error" } };
    }

    case "Message": {
      return {
        _tag: "Message",
        at: unknown,
        id: unknown,
        kind: "Privmsg",
        live: true,
        ours: {
          delivery: item.confirmed
            ? { _tag: "Confirmed", at: unknown, id: unknown, text: "said" }
            : { _tag: "Pending" },
          intent: `i${item.spot.sequence}`,
        },
        sender: "iirc",
        tags: [],
        target: "#c",
        text: "said",
      };
    }

    default: {
      return item.kind satisfies never;
    }
  }
};

const wireItem = (item: ModelItem) =>
  decodeItem({
    changed: item.changed,
    content: wireContent(item),
    level: null,
    network: item.network,
    position: cursor(item.spot.at, item.spot.sequence),
    sequence: item.spot.sequence,
    timeline: item.timeline,
  });

const wireTimeline = (timeline: ModelTimeline) =>
  decodeTimeline({
    changed: timeline.changed,
    detached: false,
    id: timeline.id,
    key: timeline.kind === "Network" ? null : `#${timeline.id}`,
    kind: timeline.kind,
    latest:
      timeline.latest === undefined ? null : cursor(timeline.latest.at, timeline.latest.sequence),
    name: timeline.kind === "Network" ? timeline.network : `#${timeline.id}`,
    network: timeline.network,
    read: null,
    unread: { activity: 0, direct: 0, highlights: 0, messages: 0 },
  });

const wireGap = (gap: ModelGap) => ({
  changed: gap.changed,
  from: cursor(gap.from.at, gap.from.sequence),
  network: gap.network,
  to: gap.to === undefined ? null : cursor(gap.to.at, gap.to.sequence),
});

/** A span of positions to find Gaps in: open on a side with no bound. */
interface Span {
  readonly from: Spot | undefined;
  readonly to: Spot | undefined;
  /** For a page read after a cursor: only the Gaps that began after it. */
  readonly beganAfter?: Spot;
  /** For a page read before a cursor: only the Gaps that ended before it. */
  readonly endedBefore?: Spot;
}

/**
 * A Network's Gaps that overlap a span, with consecutive ones that have no item of the
 * Timeline between them as one.
 * @param world - The world.
 * @param network - The Network.
 * @param timeline - The Timeline.
 * @param span - The span.
 * @returns The collapsed Gaps, as the wire carries them.
 */
const collapsed = (world: World, network: string, timeline: string, span: Span) => {
  const items = world.items.filter((item) => item.timeline === timeline);
  const runs: { from: Spot; last: Spot; to: Spot | undefined; count: number }[] = [];

  const overlapping = world.gaps
    .filter(
      (gap) =>
        gap.network === network &&
        (span.to === undefined || compareSpots(gap.from, span.to) <= 0) &&
        (span.from === undefined || gap.to === undefined || compareSpots(gap.to, span.from) >= 0) &&
        (span.beganAfter === undefined || compareSpots(gap.from, span.beganAfter) > 0) &&
        (span.endedBefore === undefined ||
          (gap.to !== undefined && compareSpots(gap.to, span.endedBefore) < 0))
    )
    .toSorted((left, right) => compareSpots(left.from, right.from));

  for (const gap of overlapping) {
    const run = runs.at(-1);

    const between =
      run !== undefined &&
      items.some(
        (item) => compareSpots(item.spot, run.last) > 0 && compareSpots(item.spot, gap.from) <= 0
      );

    if (run === undefined || between) {
      runs.push({ count: 1, from: gap.from, last: gap.from, to: gap.to });
    } else {
      runs[runs.length - 1] = { count: run.count + 1, from: run.from, last: gap.from, to: gap.to };
    }
  }

  return runs.map((run) => ({
    count: run.count,
    from: cursor(run.from.at, run.from.sequence),
    to: run.to === undefined ? null : cursor(run.to.at, run.to.sequence),
  }));
};

/** How many items the model Daemon gives a window at most, so windows have more beyond. */
const modelPage = 2;

/** The most items a window holds in the simulation, so windows reach it. */
const modelCap = 4;

/** How many Timelines the model Daemon gives a page of a list. */
const modelListPage = 3;

/**
 * The model Daemon at one fold point and projection version.
 * @param world - What it has folded.
 * @param through - The last step folded.
 * @param version - The projection version.
 * @returns Its reads.
 */
/**
 * A position as the model writes it.
 * @param position - The position.
 * @returns Its time and step.
 */
const spotOf = (position: { readonly at: number; readonly sequence: number }): Spot => ({
  at: position.at,
  sequence: position.sequence,
});

/** Where a window is read from: the latest, before a cursor, or after one. */
type Cursor =
  | { readonly _tag: "Before"; readonly spot: Spot | undefined }
  | { readonly _tag: "After"; readonly spot: Spot };

const daemonAt = (world: World, through: number, version: number) => {
  const sortedItems = (timeline: string) =>
    world.items
      .filter((item) => item.timeline === timeline)
      .toSorted((left, right) => compareSpots(left.spot, right.spot));

  const window = (timeline: string, cursor: Cursor, limit: number) => {
    const all = sortedItems(timeline);
    const owner = world.timelines.find((one) => one.id === timeline);
    const page = Math.min(limit, modelPage);
    let items: readonly ModelItem[];
    let earlier: boolean;
    let later: boolean;
    let span: Span;

    if (cursor._tag === "After") {
      const candidates = all.filter((item) => compareSpots(item.spot, cursor.spot) > 0);

      items = candidates.slice(0, page);
      earlier = true;
      later = candidates.length > items.length;
      span = {
        beganAfter: cursor.spot,
        from: undefined,
        to: later ? (items.at(-1)?.spot ?? cursor.spot) : undefined,
      };
    } else {
      const { spot } = cursor;

      const candidates =
        spot === undefined ? all : all.filter((item) => compareSpots(item.spot, spot) < 0);

      items = candidates.slice(-page);
      earlier = candidates.length > items.length;
      later = spot !== undefined;

      const from = earlier ? items[0]?.spot : undefined;

      span =
        spot === undefined ? { from, to: undefined } : { endedBefore: spot, from, to: undefined };
    }

    return decodeWindow({
      earlier,
      gaps: collapsed(world, owner?.network ?? "alpha", timeline, span),
      items: items.map(wireItem).map((item) => Schema.encodeSync(TimelineItem)(item)),
      later,
      network: owner?.network ?? "alpha",
      through,
      timeline,
      version,
    });
  };

  return {
    entries: () =>
      decodeEntries(
        networks.flatMap((network) =>
          world.timelines.some((one) => one.network === network)
            ? [{ network, status: { _tag: "Running" } }]
            : []
        )
      ),
    known: (network: string) =>
      decodeSession(
        world.gaps.some((gap) => gap.network === network && gap.to === undefined)
          ? { _tag: "Offline", since: null }
          : { _tag: "Registered", ircd: "ircd.test", since: 0 }
      ),
    list: (network: string, after: string | undefined) => {
      const all = world.timelines
        .filter((one) => one.network === network && (after === undefined || one.id > after))
        .toSorted((left, right) => (left.id < right.id ? -1 : 1));

      return decodeList({
        more: all.length > modelListPage,
        projection: { _tag: "Running" },
        through,
        timelines: all
          .slice(0, modelListPage)
          .map((one) => Schema.encodeSync(Timeline)(wireTimeline(one))),
        version,
      });
    },
    window,
  };
};

/**
 * What one step changed, as the model Daemon at a later fold point gives it: everything
 * whose last change was that step, as it stands now.
 * @param world - What the Daemon has folded.
 * @param sequence - The step.
 * @returns Its changes, or `null` when it changed nothing.
 */
const changeAt = (world: World, sequence: number) => {
  const timelines = world.timelines.filter((one) => one.changed === sequence);
  const items = world.items.filter((one) => one.changed === sequence);
  const gaps = world.gaps.filter((one) => one.changed === sequence);

  if (timelines.length + items.length + gaps.length === 0) {
    return null;
  }

  return decodeChange({
    gaps: gaps.map(wireGap),
    items: items.map((item) => Schema.encodeSync(TimelineItem)(wireItem(item))),
    merged: [],
    sequence,
    timelines: timelines.map((one) => Schema.encodeSync(Timeline)(wireTimeline(one))),
  });
};

// The simulation: the reducer and a runtime in miniature, against the model Daemon.

type Action =
  | "Fold"
  | "Deliver"
  | "Serve"
  | "Answer"
  | "Open"
  | "Older"
  | "Newer"
  | "Leave"
  | "Return"
  | "Back"
  | "AnswerNewest"
  | "Detour"
  | "BlackOut"
  | "Pane";

interface Scenario {
  readonly choices: readonly Choice[];
  readonly actions: readonly { readonly action: Action; readonly pick: number }[];
  /** Every event comes twice. */
  readonly twice: boolean;
  /** The step at which the Daemon takes a new projection version, if it does. */
  readonly resetAt: number | undefined;
  /** Once the second Network is configured, nothing more happens on it. */
  readonly quiet: boolean;
}

const choice: fc.Arbitrary<Choice> = fc.record({
  late: fc.boolean(),
  overflow: fc.constantFrom("None", "None", "None", "None", "None", "None", "Named", "All"),
  pick: fc.nat(1000),
  what: fc.nat(5),
});

const scenario: fc.Arbitrary<Scenario> = fc.record({
  actions: fc.array(
    fc.record({
      action: fc.constantFrom<Action>(
        "Fold",
        "Fold",
        "Deliver",
        "Serve",
        "Answer",
        "Open",
        "Older",
        "Newer",
        "Leave",
        "Return",
        "Back",
        "AnswerNewest",
        "Detour",
        "BlackOut",
        "Pane",
        "Pane"
      ),
      pick: fc.nat(1000),
    }),
    { maxLength: 400, size: "max" }
  ),
  choices: fc.array(choice, { maxLength: 80, minLength: 1, size: "max" }),
  quiet: fc.boolean(),
  resetAt: fc.option(fc.nat(40), { nil: undefined }),
  twice: fc.boolean(),
});

interface Pending {
  readonly answer: TimelinesEvent;
}

/**
 * What a current window is missing at any moment: an item of its Timeline that the Daemon
 * had folded by the window's `through`, standing between its first and last items. A
 * window says it reflects every step up to `through`, so between its ends it holds all of
 * them, however its pages were read and whatever came late.
 * @param state - The state.
 * @param worlds - The Daemon's world after each step.
 * @returns One line for each item missing.
 */
const holesIn = (state: Timelines, worlds: readonly World[]): readonly string[] =>
  [...state.windows.values()].flatMap((window) => {
    const [first] = window.items;
    const last = window.items.at(-1);

    if (!window.fresh || first === undefined || last === undefined) {
      return [];
    }

    const held = new Set(window.items.map((item) => `${item.position.at}:${item.sequence}`));

    return (worlds[window.through]?.items ?? []).flatMap((item) =>
      item.timeline === window.timeline &&
      compareSpots(item.spot, spotOf(first.position)) > 0 &&
      compareSpots(item.spot, spotOf(last.position)) < 0 &&
      !held.has(`${item.spot.at}:${item.spot.sequence}`)
        ? [`${window.timeline} is missing ${item.spot.sequence}`]
        : []
    );
  });

const directions = ["Left", "Right", "Up", "Down"] as const;

/**
 * What must hold of the Panes after anything: a Timeline open in one Pane at most, the
 * focus on a Pane, and, with no closed window kept, a window only for a Timeline open in
 * a Pane.
 * @param state - The state.
 * @returns What is wrong, none when nothing is.
 */
const paneFaults = (state: Timelines): readonly string[] => {
  const open = panesOf(state.layout.root).flatMap((pane) =>
    pane.view.open === undefined ? [] : [resolve(state, pane.view.open)]
  );

  const faults: string[] = [];

  if (new Set(open).size !== open.length) {
    faults.push(`a Timeline open twice: ${open.join(", ")}`);
  }

  if (!panesOf(state.layout.root).some((pane) => pane.id === state.layout.focused)) {
    faults.push("the focus on no Pane");
  }

  for (const id of state.windows.keys()) {
    if (!open.includes(id)) {
      faults.push(`a window of ${id}, open in no Pane`);
    }
  }

  return faults;
};

/**
 * Plays a scenario: the Daemon folds steps one at a time, the stream lags it, and reads are
 * served at one fold point and answered later, in any order. At the end everything is
 * folded, delivered, read, and answered.
 * @param played - The scenario.
 * @returns The reducer's state, and the world the Daemon ended with.
 */
const simulate = (played: Scenario) => {
  const worlds = [emptyWorld];

  for (const [index, made] of played.choices.entries()) {
    worlds.push(stepWorld(worlds.at(-1) ?? emptyWorld, made, index + 1, played.quiet));
  }

  const last = played.choices.length;
  // No closed window kept, so a window is dropped whenever another opens, and read again
  // when it opens again, with replies for the one dropped still in flight.
  let state = timelinesWith(modelCap, 0);
  let folded = 1;
  let stream: { at: number; version: number } | undefined;
  const pending: Pending[] = [];
  // Steps the stream gives as an overflow that touched everything.
  const blackedOut = new Set<number>();
  const holes: string[] = [];

  const versionAt = (through: number) =>
    played.resetAt !== undefined && through >= played.resetAt ? 2 : 1;

  const dispatch = (event: TimelinesEvent) => {
    state = reduceTimelines(state, event);
  };

  const connect = () => {
    const from = followFrom(state);

    if (stream === undefined && from !== undefined) {
      stream = {
        at: from?.sequence ?? 0,
        version: from?.version ?? versionAt(folded),
      };
    }
  };

  const deliver = (): boolean => {
    connect();

    if (stream === undefined) {
      return false;
    }

    const world = worlds[folded] ?? emptyWorld;
    const version = versionAt(folded);

    if (stream.version !== version) {
      dispatch({ _tag: "Reset", reset: { through: sequenceOf(folded), version } });
      stream = { at: folded, version };

      return true;
    }

    for (let sequence = stream.at + 1; sequence <= folded; sequence += 1) {
      const change = changeAt(world, sequence);

      if (change !== null) {
        const place: Place = { sequence, version };

        const overflow = blackedOut.has(sequence)
          ? "All"
          : (played.choices[sequence - 1]?.overflow ?? "None");

        const event: TimelinesEvent =
          overflow === "None"
            ? { _tag: "Changed", change, place }
            : {
                _tag: "Overflowed",
                overflow: {
                  sequence: change.sequence,
                  timelines:
                    overflow === "All"
                      ? null
                      : [
                          ...new Set([
                            ...change.timelines.map((one) => one.id),
                            ...change.items.map((one) => one.timeline),
                          ]),
                        ],
                },
                place,
              };

        dispatch(event);

        if (played.twice) {
          dispatch(event);
        }

        stream = { at: sequence, version };

        return true;
      }
    }

    stream = { ...stream, at: folded };

    return false;
  };

  const answer = (read: Read): TimelinesEvent => {
    const daemon = daemonAt(worlds[folded] ?? emptyWorld, folded, versionAt(folded));

    switch (read._tag) {
      case "Networks": {
        return { _tag: "NetworksRead", entries: daemon.entries() };
      }

      case "List": {
        return {
          _tag: "ListRead",
          after: read.after,
          network: read.network,
          page: daemon.list(read.network, read.after),
        };
      }

      case "Status": {
        return {
          _tag: "StatusRead",
          network: read.network,
          self: null,
          session: daemon.known(read.network),
        };
      }

      case "Latest": {
        return {
          _tag: "WindowRead",
          read,
          window: daemon.window(read.timeline, { _tag: "Before", spot: undefined }, read.limit),
        };
      }

      case "Older": {
        return {
          _tag: "WindowRead",
          read,
          window: daemon.window(
            read.timeline,
            { _tag: "Before", spot: { at: read.before.at, sequence: read.before.sequence } },
            read.limit
          ),
        };
      }

      case "Newer": {
        return {
          _tag: "WindowRead",
          read,
          window: daemon.window(
            read.timeline,
            { _tag: "After", spot: { at: read.after.at, sequence: read.after.sequence } },
            read.limit
          ),
        };
      }

      // A run of these properties never jumps to a result or searches.
      case "Around":
      case "Search": {
        throw new Error(`a property run never reads ${read._tag}`);
      }

      default: {
        return read satisfies never;
      }
    }
  };

  const serve = (pick: number): boolean => {
    const reads = wanted(state);
    const read = reads[pick % Math.max(1, reads.length)];

    if (read === undefined) {
      return false;
    }

    dispatch({ _tag: "ReadStarted", read });
    pending.push({ answer: answer(read) });

    return true;
  };

  const respond = (pick: number): boolean => {
    const [answered] = pending.splice(pick % Math.max(1, pending.length), 1);

    if (answered === undefined) {
      return false;
    }

    dispatch(answered.answer);

    return true;
  };

  // The Timeline open before the one open now, to go back to.
  let previous: TimelineId | undefined;

  const openTimeline = (timeline: TimelineId) => {
    previous = openOf(state);
    dispatch({ _tag: "Opened", timeline });
  };

  const open = (pick: number) => {
    const timelines = sidebar(state).flatMap((network) => network.timelines);
    const chosen = timelines[pick % Math.max(1, timelines.length)];

    if (chosen !== undefined) {
      openTimeline(chosen.id);
    }
  };

  // The Owner asks for older items, and before they come, opens another Timeline and comes
  // back: the window is dropped and read again, with the page for the old one in flight.
  const detour = (pick: number) => {
    const timeline = openOf(state);

    if (timeline === undefined) {
      return;
    }

    // A detour reads on its own, as a view scrolled near the top does.
    dispatch({ _tag: "OlderWanted", mode: "Auto", timeline });
    const older = wanted(state).findIndex((read) => read._tag === "Older");

    if (older !== -1) {
      serve(older);
    }

    open(pick);
    openTimeline(timeline);
  };

  // The stream catches up and the Network list is read, if it is wanted. Before it lands,
  // the Daemon folds a few more steps, which the stream gives as overflows that touched
  // everything, as a step that configured a Network may be.
  const blackOut = (pick: number) => {
    while (deliver()) {
      // Caught up with what was folded.
    }

    const list = wanted(state).findIndex((read) => read._tag === "Networks");

    if (list !== -1) {
      serve(list);
    }

    const until = Math.min(last, folded + (pick % 4) + 1);

    for (folded += 1; folded <= until; folded += 1) {
      blackedOut.add(folded);
    }

    folded = until;

    while (deliver()) {
      // The overflows, given.
    }
  };

  // Opening a Timeline, going back to the one open before, a detour while older items are read, and
  // answering the newest read first, so a page often lands after its window was replaced.
  const aside = (
    action: "Open" | "Detour" | "AnswerNewest" | "Back" | "BlackOut",
    pick: number
  ) => {
    if (action === "BlackOut") {
      blackOut(pick);
    } else if (action === "Open") {
      open(pick);
    } else if (action === "Detour") {
      detour(pick);
    } else if (action === "AnswerNewest") {
      respond(pending.length - 1);
    } else if (previous !== undefined) {
      openTimeline(previous);
    }
  };

  // What the Owner does to the Panes: splits, opening a Timeline in the new Pane or none,
  // closes, focuses, moves the focus, and swaps, so windows are kept and dropped as
  // Timelines come into and leave the Panes.
  const paneAct = (pick: number) => {
    const timelines = sidebar(state).flatMap((network) => network.timelines);
    const panes = panesOf(state.layout.root);
    const towards = directions[pick % directions.length] ?? "Left";

    const changes: readonly PaneChange[] = [
      { _tag: "Split", axis: "Horizontal", timeline: timelines[pick % 7]?.id },
      { _tag: "Split", axis: "Vertical", timeline: timelines[pick % 5]?.id },
      { _tag: "Close" },
      { _tag: "Focus", pane: panes[pick % panes.length]?.id ?? "p0" },
      { _tag: "Move", direction: towards },
      { _tag: "Swap", direction: towards },
    ];

    dispatch({ _tag: "Pane", change: changes[Math.floor(pick / 4) % 6] ?? { _tag: "Close" } });
  };

  // What the Owner does in the open Timeline: scrolls to either end, or away from the latest
  // and back.
  const asOwner = (action: "Older" | "Newer" | "Leave" | "Return") => {
    const timeline = openOf(state);

    if (timeline === undefined) {
      return;
    }

    // The Owner asks for older items on purpose here, as "Load older" does.
    if (action === "Older") {
      dispatch({ _tag: "OlderWanted", mode: "Asked", timeline });
    } else if (action === "Newer") {
      dispatch({ _tag: "NewerWanted", timeline });
    } else {
      dispatch({ _tag: "Following", following: action === "Return", seen: undefined, timeline });
    }
  };

  const act = (action: Action, pick: number) => {
    switch (action) {
      case "Fold": {
        folded = Math.min(last, folded + 1);
        break;
      }

      case "Deliver": {
        deliver();
        break;
      }

      case "Serve": {
        serve(pick);
        break;
      }

      case "Answer": {
        respond(pick);
        break;
      }

      case "Open":
      case "Detour":
      case "BlackOut":
      case "AnswerNewest":
      case "Back": {
        aside(action, pick);
        break;
      }

      case "Older":
      case "Newer":
      case "Leave":
      case "Return": {
        asOwner(action);
        break;
      }

      case "Pane": {
        paneAct(pick);
        break;
      }

      default: {
        action satisfies never;
      }
    }
  };

  for (const { action, pick } of played.actions) {
    const before = state.navigation;

    act(action, pick);
    holes.push(...holesIn(state, worlds), ...paneFaults(state));

    if (state.navigation < before) {
      holes.push("navigation went back");
    }
  }

  folded = last;

  // Everything settles: every step delivered, every read the state calls for made and
  // answered, until nothing more is called for.
  for (let round = 0; round < 10_000; round += 1) {
    const moved = deliver() || respond(0) || serve(0);

    if (!moved) {
      break;
    }
  }

  return { holes, state, world: worlds[last] ?? emptyWorld };
};

/**
 * What a settled state must hold: each Network's Timelines exactly as the Daemon has them,
 * each Network's connection, and every window that is current exactly as a read now would
 * give it from its first item on, with its Gaps.
 * @param state - The settled state.
 * @param world - The Daemon's world.
 * @returns What the state holds, and what it should.
 */
const compare = (state: Timelines, world: World) => {
  const held = {
    connections: [...state.networks.values()].map((network) => [
      network.network,
      network.connection._tag,
    ]),
    // Every Network the Daemon has, a quiet one only an overflow or a reset hid included.
    networks: [...state.networks.keys()].toSorted(),
    timelines: [...state.networks.values()].map((network) => [
      network.network,
      [...network.timelines.values()].toSorted((left, right) => (left.id < right.id ? -1 : 1)),
    ]),
    windows: [...state.windows.values()].flatMap((window) =>
      window.fresh
        ? [[window.timeline, window.items, window.gaps, window.earlier, window.later]]
        : []
    ),
    // Every window within the cap, and no more windows than the open one's and the few
    // closed most recently.
    within:
      [...state.windows.values()].every((window) => window.items.length <= modelCap) &&
      state.windows.size <= panesOf(state.layout.root).length,
  };

  const expected = {
    connections: [...state.networks.keys()].map((network) => [
      network,
      world.gaps.some((gap) => gap.network === network && gap.to === undefined)
        ? "Offline"
        : "Connected",
    ]),
    networks: networks.filter((network) => world.timelines.some((one) => one.network === network)),
    timelines: [...state.networks.keys()].map((network) => [
      network,
      world.timelines
        .filter((one) => one.network === network)
        .toSorted((left, right) => (left.id < right.id ? -1 : 1))
        .map(wireTimeline),
    ]),
    windows: [...state.windows.values()].flatMap((window) => {
      if (!window.fresh) {
        return [];
      }

      const first = window.items[0]?.position;
      const last = window.items.at(-1)?.position;
      const from = window.earlier && first !== undefined ? spotOf(first) : undefined;
      const to = window.later && last !== undefined ? spotOf(last) : undefined;

      const all = world.items
        .filter((item) => item.timeline === window.timeline)
        .toSorted((left, right) => compareSpots(left.spot, right.spot));

      const items = all
        .filter(
          (item) =>
            (from === undefined || compareSpots(item.spot, from) >= 0) &&
            (to === undefined || compareSpots(item.spot, to) <= 0)
        )
        .map(wireItem);

      const gaps = collapsed(world, window.network ?? "alpha", window.timeline, { from, to }).map(
        (gap) => decodeGap(gap)
      );

      // The flags are true exactly when something lies beyond, so whatever was dropped can
      // be read again.
      const earlier =
        first === undefined
          ? false
          : all.some((item) => compareSpots(item.spot, spotOf(first)) < 0);

      const later =
        last === undefined ? false : all.some((item) => compareSpots(item.spot, spotOf(last)) > 0);

      return [[window.timeline, items, gaps, earlier, later]];
    }),
    within: true,
  };

  return { expected, held };
};

describe("following the changes", () => {
  it("misses nothing and applies nothing twice, however reads and the stream interleave", () => {
    fc.assert(
      fc.property(scenario, (played) => {
        const { holes, state, world } = simulate(played);
        const { expected, held } = compare(state, world);

        expect({ following: followFrom(state) !== undefined, holes, ...held }).toStrictEqual({
          following: true,
          holes: [],
          ...expected,
        });
      }),
      { numRuns: 200 }
    );
  });

  it("holds only plain data, which survives structuredClone", () => {
    fc.assert(
      fc.property(scenario, (played) => {
        const { state } = simulate(played);

        expect(structuredClone(state)).toStrictEqual(state);
      }),
      { numRuns: 50 }
    );
  });
});

/**
 * A read of a Timeline's latest window, for one generation of it.
 * @param timeline - The Timeline.
 * @param generation - Which window of it.
 * @returns The read.
 */
const latestOf = (timeline: TimelineId, generation: number): WindowRequest => ({
  _tag: "Latest",
  attempt: 0,
  generation,
  limit: 100,
  timeline,
});

// Examples.

const alpha = networkId("alpha");
const one = timelineId(idOf(1));
const two = timelineId(idOf(2));
const three = timelineId(idOf(3));

const timelineOf = (id: string, kind: "Network" | "Channel", name: string, changed: number) =>
  decodeTimeline({
    changed,
    detached: false,
    id,
    key: kind === "Network" ? null : name,
    kind,
    latest: null,
    name,
    network: "alpha",
    read: null,
    unread: { activity: 0, direct: 0, highlights: 0, messages: 0 },
  });

const listOf = (through: number, ...timelines: readonly ReturnType<typeof timelineOf>[]) =>
  decodeList({
    more: false,
    projection: { _tag: "Running" },
    through,
    timelines: timelines.map((timeline) => Schema.encodeSync(Timeline)(timeline)),
    version: 1,
  });

const message = (timeline: string, at: number, sequence: number, changed = sequence) =>
  decodeItem({
    changed,
    content: {
      _tag: "Message",
      at: unknown,
      id: unknown,
      kind: "Privmsg",
      live: true,
      ours: null,
      sender: "peer",
      tags: [],
      target: "#c",
      text: `m${sequence}`,
    },
    level: "Message",
    network: "alpha",
    position: cursor(at, sequence),
    sequence,
    timeline,
  });

const encodedItems = (items: readonly ReturnType<typeof message>[]) =>
  items.map((item) => Schema.encodeSync(TimelineItem)(item));

/**
 * A state following the stream from step 5, with alpha's Network Timeline and two Channels,
 * the second open, and its window holding items at steps 3 and 4.
 * @returns The state.
 */
const following = (): Timelines => {
  const events: TimelinesEvent[] = [
    { _tag: "ReadStarted", read: { _tag: "Networks", attempt: 0 } },
    {
      _tag: "NetworksRead",
      entries: decodeEntries([{ network: "alpha", status: { _tag: "Running" } }]),
    },
    { _tag: "ReadStarted", read: { _tag: "List", after: undefined, attempt: 0, network: alpha } },
    {
      _tag: "ListRead",
      after: undefined,
      network: alpha,
      page: listOf(
        5,
        timelineOf(idOf(1), "Network", "alpha", 1),
        timelineOf(idOf(2), "Channel", "#b", 2),
        timelineOf(idOf(3), "Channel", "#a", 4)
      ),
    },
    { _tag: "Opened", timeline: three },
    { _tag: "ReadStarted", read: latestOf(three, 0) },
    {
      _tag: "WindowRead",
      read: latestOf(three, 0),
      window: decodeWindow({
        earlier: false,
        gaps: [],
        items: encodedItems([message(idOf(3), 30, 3), message(idOf(3), 40, 4)]),
        later: false,
        network: "alpha",
        through: 5,
        timeline: idOf(3),
        version: 1,
      }),
    },
  ];

  let state = initialTimelines;

  for (const event of events) {
    state = reduceTimelines(state, event);
  }

  return state;
};

const changed = (sequence: number, change: Partial<typeof TimelineChange.Encoded>) =>
  ({
    _tag: "Changed",
    change: decodeChange({ gaps: [], items: [], merged: [], sequence, timelines: [], ...change }),
    place: { sequence, version: 1 },
  }) as const;

const shownItems = (state: Timelines) => {
  const shown = opened(state);

  return shown._tag === "Shown" ? shown.window.items.map((item) => item.sequence) : [];
};

/**
 * A row as a test compares it: an item's sequence, a Gap's count, or the divider.
 * @param row - The row.
 * @returns What it shows.
 */
const rowText = (row: Row) => {
  if (row._tag === "Item") {
    return row.item.sequence;
  }

  return row._tag === "Gap" ? `gap ${row.gap.count}` : "new";
};

// The page before the first item held carries the Gaps up to it, as the API gives them.
const olderPage = (held: (typeof WindowGap.Encoded)[], page: (typeof WindowGap.Encoded)[]) => {
  let state = reduceTimelines(following(), {
    _tag: "WindowRead",
    read: latestOf(three, 0),
    window: decodeWindow({
      earlier: true,
      gaps: held,
      items: encodedItems([message(idOf(3), 30, 3), message(idOf(3), 40, 4)]),
      later: false,
      network: "alpha",
      through: 5,
      timeline: idOf(3),
      version: 1,
    }),
  });

  state = reduceTimelines(state, { _tag: "OlderWanted", mode: "Asked", timeline: three });
  const read = wanted(state).find((one) => one._tag === "Older");

  state = reduceTimelines(state, {
    _tag: "WindowRead",
    read: read ?? latestOf(three, 0),
    window: decodeWindow({
      earlier: false,
      gaps: page,
      items: encodedItems([message(idOf(3), 20, 1)]),
      later: true,
      network: "alpha",
      through: 5,
      timeline: idOf(3),
      version: 1,
    }),
  });

  const shown = opened(state);

  return {
    before: read?._tag === "Older" ? read.before.sequence : undefined,
    rows: shown._tag === "Shown" ? rowsOf(shown.window).map((row) => rowText(row)) : [],
  };
};

const entries = (...names: readonly string[]) =>
  decodeEntries(names.map((network) => ({ network, status: { _tag: "Running" } })));

// Items numbered 0 to 1999, at 10 ms apart, each its own step.
const numbered = (from: number, to: number) =>
  encodedItems(
    Array.from({ length: to - from + 1 }, (_, index) =>
      message(idOf(3), (from + index) * 10, from + index + 1)
    )
  );

const numberedWindow = (from: number, to: number, earlier: boolean, later: boolean) =>
  decodeWindow({
    earlier,
    gaps: [],
    items: numbered(from, to),
    later,
    network: "alpha",
    through: 5,
    timeline: idOf(3),
    version: 1,
  });

const direct = (id: string, name: string, detached = false) =>
  Schema.encodeSync(Timeline)(
    decodeTimeline({
      changed: 6,
      detached,
      id,
      key: detached ? null : name.toLowerCase(),
      kind: "Direct",
      latest: null,
      name,
      network: "alpha",
      read: null,
      unread: { activity: 0, direct: 0, highlights: 0, messages: 0 },
    })
  );

describe("the Timelines' state", () => {
  it("follows the stream after the smallest `through` it read", () => {
    let state = initialTimelines;

    for (const event of [
      { _tag: "ReadStarted", read: { _tag: "Networks", attempt: 0 } },
      {
        _tag: "NetworksRead",
        entries: decodeEntries([
          { network: "alpha", status: { _tag: "Running" } },
          { network: "beta", status: { _tag: "Running" } },
        ]),
      },
      {
        _tag: "ListRead",
        after: undefined,
        network: alpha,
        page: listOf(9, timelineOf(idOf(1), "Network", "alpha", 1)),
      },
    ] as const satisfies readonly TimelinesEvent[]) {
      state = reduceTimelines(state, event);
    }

    const waiting = followFrom(state);

    state = reduceTimelines(state, {
      _tag: "ListRead",
      after: undefined,
      network: networkId("beta"),
      page: decodeList({
        more: false,
        projection: { _tag: "Running" },
        through: 6,
        timelines: [],
        version: 1,
      }),
    });

    expect({ after: followFrom(state), waiting }).toStrictEqual({
      after: { sequence: 6, version: 1 },
      waiting: undefined,
    });
  });

  it("asks for each read once, and the open window only once the stream is followed", () => {
    const state = following();

    expect({
      asked: wanted(state).map((read) => read._tag),
      whileReading: wanted(
        reduceTimelines(state, {
          _tag: "ReadStarted",
          read: { _tag: "Status", attempt: 0, network: alpha },
        })
      ),
    }).toStrictEqual({
      asked: ["Networks", "Status"],
      whileReading: [{ _tag: "Networks", attempt: 0 }],
    });
  });

  it("orders the sidebar: the Network's own first, then Channels by name", () => {
    expect(
      sidebar(following()).map((network) => [
        network.network,
        network.timelines.map((timeline) => timeline.name),
      ])
    ).toStrictEqual([["alpha", ["alpha", "#a", "#b"]]]);
  });

  it("appends a live item, inserts late history, updates in place, and skips what it read", () => {
    let state = following();

    state = reduceTimelines(state, changed(5, { items: encodedItems([message(idOf(3), 1, 5)]) }));
    state = reduceTimelines(state, changed(6, { items: encodedItems([message(idOf(3), 60, 6)]) }));
    state = reduceTimelines(state, changed(7, { items: encodedItems([message(idOf(3), 35, 7)]) }));
    state = reduceTimelines(
      state,
      changed(8, { items: encodedItems([message(idOf(3), 60, 6, 8)]) })
    );
    state = reduceTimelines(state, changed(9, { items: encodedItems([message(idOf(2), 90, 9)]) }));

    const shown = opened(state);

    expect({
      changedOfSix:
        shown._tag === "Shown"
          ? shown.window.items.find((item) => item.sequence === 6)?.changed
          : 0,
      items: shownItems(state),
    }).toStrictEqual({ changedOfSix: 8, items: [3, 7, 4, 6] });
  });

  it("opens the Direct Message Timeline the Daemon placed a Message in, by id, never by name", () => {
    // Under CASEMAPPING=ascii these are two Users, though rfc1459 folds them together.
    const square = timelineId(idOf(6));
    const curly = timelineId(idOf(7));

    let state = reduceTimelines(following(), changed(6, { timelines: [direct(idOf(6), "[bob]")] }));

    // Placed in `{bob}`'s, which is not listed yet: it opens once it is.
    state = reduceTimelines(state, { _tag: "Located", navigation: 1, timeline: curly });
    const waiting = [openOf(state), state.located];

    state = reduceTimelines(state, changed(7, { timelines: [direct(idOf(7), "{bob}")] }));
    const opens = [openOf(state), state.located];

    // Already listed: opened at once.
    const atOnce = openOf(
      reduceTimelines(state, {
        _tag: "Located",
        navigation: 1,
        timeline: square,
      })
    );

    // A Channel's, or a detached one, opens nothing.
    const channel = reduceTimelines(following(), {
      _tag: "Located",
      navigation: 1,
      timeline: timelineId(idOf(2)),
    });

    const detached = reduceTimelines(
      reduceTimelines(following(), changed(8, { timelines: [direct(idOf(8), "gone", true)] })),
      { _tag: "Located", navigation: 1, timeline: timelineId(idOf(8)) }
    );

    expect({
      atOnce,
      channel: [openOf(channel), channel.located],
      detached: [openOf(detached), detached.located],
      opens,
      waiting,
    }).toStrictEqual({
      atOnce: square,
      channel: [three, undefined],
      detached: [three, undefined],
      opens: [curly, undefined],
      waiting: [three, curly],
    });
  });

  it("ignores a placement from before the Owner opened another Timeline", () => {
    const listed = reduceTimelines(
      following(),
      changed(6, { timelines: [direct(idOf(6), "bob")] })
    );

    // Submitted at navigation 1, then the Owner opened the Channel `#b`.
    const elsewhere = reduceTimelines(listed, { _tag: "Opened", timeline: timelineId(idOf(2)) });

    const late = reduceTimelines(elsewhere, {
      _tag: "Located",
      navigation: 1,
      timeline: timelineId(idOf(6)),
    });

    expect({
      navigation: [listed.navigation, elsewhere.navigation],
      open: openOf(late),
      pending: late.located,
    }).toStrictEqual({ navigation: [1, 2], open: idOf(2), pending: undefined });
  });

  it("shows the Timeline a placement opens, though the options were showing when it was said", () => {
    const listed = reduceTimelines(
      following(),
      changed(6, { timelines: [direct(idOf(6), "bob")] })
    );

    // The options shown, then `/msg bob hello` submitted there, at that navigation.
    const options = reduceTimelines(listed, { _tag: "OptionsShown", filter: "" });
    const filtered = reduceTimelines(options, { _tag: "OptionsFiltered", filter: "*nick*" });

    const placed = reduceTimelines(filtered, {
      _tag: "Located",
      navigation: filtered.navigation,
      timeline: timelineId(idOf(6)),
    });

    // A placement from before the options were shown is let go, and they stay.
    const before = reduceTimelines(filtered, {
      _tag: "Located",
      navigation: listed.navigation,
      timeline: timelineId(idOf(6)),
    });

    expect({
      before: [mainOf(before), openOf(before)],
      filtered: mainOf(filtered),
      placed: [mainOf(placed), openOf(placed)],
      start: mainOf(listed),
    }).toStrictEqual({
      before: [{ _tag: "Options", filter: "*nick*" }, three],
      filtered: { _tag: "Options", filter: "*nick*" },
      placed: [{ _tag: "Timeline" }, idOf(6)],
      start: { _tag: "Timeline" },
    });
  });

  it("keeps an item outside what a window loaded out of it", () => {
    let state = following();

    state = reduceTimelines(state, {
      _tag: "WindowRead",
      read: latestOf(three, 0),
      window: decodeWindow({
        earlier: true,
        gaps: [],
        items: encodedItems([message(idOf(3), 30, 3), message(idOf(3), 40, 4)]),
        later: false,
        network: "alpha",
        through: 5,
        timeline: idOf(3),
        version: 1,
      }),
    });
    state = reduceTimelines(state, changed(6, { items: encodedItems([message(idOf(3), 1, 6)]) }));

    expect(shownItems(state)).toStrictEqual([3, 4]);
  });

  it("follows a merged Timeline to the one it went to, and reads that", () => {
    let state = reduceTimelines(following(), { _tag: "Opened", timeline: two });

    state = reduceTimelines(
      state,
      changed(6, {
        merged: [{ changed: 6, id: idOf(2), into: idOf(3), network: "alpha" }],
        timelines: [],
      })
    );

    expect({
      list: sidebar(state)[0]?.timelines.map((timeline) => timeline.name),
      resolved: resolve(state, two),
      shown: opened(state)._tag,
      wanted: wanted(state).filter((read) => read._tag === "Latest"),
    }).toStrictEqual({
      list: ["alpha", "#a"],
      resolved: three,
      shown: "Shown",
      wanted: [],
    });
  });

  it("learns a merge from a window read of the old id", () => {
    let state = reduceTimelines(following(), { _tag: "Opened", timeline: one });

    state = reduceTimelines(state, {
      _tag: "ReadStarted",
      read: latestOf(one, 1),
    });
    state = reduceTimelines(state, {
      _tag: "WindowRead",
      read: latestOf(one, 1),
      window: decodeWindow({
        earlier: false,
        gaps: [],
        items: [],
        later: false,
        network: "alpha",
        through: 5,
        timeline: idOf(2),
        version: 1,
      }),
    });

    expect({ resolved: resolve(state, one), windows: [...state.windows.keys()] }).toStrictEqual({
      resolved: two,
      windows: [three, two],
    });
  });

  it("reads again whatever an overflow named, and everything when it named all", () => {
    const named = reduceTimelines(following(), {
      _tag: "Overflowed",
      overflow: { sequence: sequenceOf(6), timelines: [three] },
      place: { sequence: 6, version: 1 },
    });

    const all = reduceTimelines(following(), {
      _tag: "Overflowed",
      overflow: { sequence: sequenceOf(6), timelines: null },
      place: { sequence: 6, version: 1 },
    });

    expect({
      all: wanted(all).map((read) => read._tag),
      named: wanted(named).map((read) => read._tag),
      place: followFrom(named),
    }).toStrictEqual({
      all: ["Networks", "List", "Status", "Latest"],
      named: ["Networks", "List", "Status", "Latest"],
      place: { sequence: 6, version: 1 },
    });
  });

  it("drops what it holds on a reset, and follows from the reset's place", () => {
    const state = reduceTimelines(following(), {
      _tag: "Reset",
      reset: { through: sequenceOf(3), version: 2 },
    });

    expect({
      place: followFrom(state),
      reads: wanted(state).map((read) => read._tag),
      shown: opened(state)._tag,
      timelines: sidebar(state)[0]?.timelines,
    }).toStrictEqual({
      place: { sequence: 3, version: 2 },
      reads: ["Networks", "List", "Status", "Latest"],
      shown: "Reading",
      timelines: [],
    });
  });

  it("reads the Network list again on a reset, so a Network only the reset reaches is found", () => {
    // An empty list, read in full, and followed: nothing more to read.
    let state = initialTimelines;

    for (const event of [
      { _tag: "ReadStarted", read: { _tag: "Networks", attempt: 0 } },
      { _tag: "NetworksRead", entries: entries() },
      { _tag: "ReadStarted", read: { _tag: "Networks", attempt: 0 } },
    ] as const satisfies readonly TimelinesEvent[]) {
      state = reduceTimelines(state, event);
    }

    // A read started before the reset, which lands after it.
    const settled = reduceTimelines(state, { _tag: "NetworksRead", entries: entries() });

    state = reduceTimelines(state, {
      _tag: "Reset",
      reset: { through: sequenceOf(9), version: 1 },
    });
    state = reduceTimelines(state, { _tag: "NetworksRead", entries: entries() });
    const late = wanted(state);

    state = reduceTimelines(state, {
      _tag: "ReadStarted",
      read: { _tag: "Networks", attempt: 1 },
    });
    state = reduceTimelines(state, { _tag: "NetworksRead", entries: entries("beta") });

    expect({
      afterReset: wanted(
        reduceTimelines(settled, { _tag: "Reset", reset: { through: sequenceOf(9), version: 1 } })
      ),
      found: wanted(state),
      late,
      settled: wanted(settled),
    }).toStrictEqual({
      afterReset: [{ _tag: "Networks", attempt: 0 }],
      found: [
        { _tag: "List", after: undefined, attempt: 0, network: networkId("beta") },
        { _tag: "Status", attempt: 0, network: networkId("beta") },
      ],
      late: [{ _tag: "Networks", attempt: 1 }],
      settled: [],
    });
  });

  it("ignores a page that lands after its window was dropped and read again", () => {
    // The window holds 100 to 199, and asks for what lies before 100.
    let state = reduceTimelines(following(), {
      _tag: "WindowRead",
      read: latestOf(three, 0),
      window: numberedWindow(100, 199, true, false),
    });

    state = reduceTimelines(state, { _tag: "OlderWanted", mode: "Asked", timeline: three });
    const older = wanted(state).find((one) => one._tag === "Older");

    if (older === undefined || older._tag !== "Older") {
      throw new Error("no read of older items");
    }

    state = reduceTimelines(state, { _tag: "ReadStarted", read: older });

    // Five other Timelines opened in turn drop its window, and opening it again reads it
    // again, as a new window holding 1900 to 1999.
    for (let other = 10; other < 15; other += 1) {
      state = reduceTimelines(state, { _tag: "Opened", timeline: timelineId(idOf(other)) });
    }

    const dropped = !state.windows.has(three);

    state = reduceTimelines(state, { _tag: "Opened", timeline: three });
    const latest = wanted(state).find((one) => one._tag === "Latest");

    if (latest === undefined || latest._tag !== "Latest") {
      throw new Error("no read of the latest");
    }

    state = reduceTimelines(state, { _tag: "ReadStarted", read: latest });
    state = reduceTimelines(state, {
      _tag: "WindowRead",
      read: latest,
      window: numberedWindow(1900, 1999, true, false),
    });

    // The old page, of 0 to 99, lands last.
    state = reduceTimelines(state, {
      _tag: "WindowRead",
      read: older,
      window: numberedWindow(0, 99, false, true),
    });

    const shown = opened(state);

    expect({
      dropped,
      earlier: shown._tag === "Shown" && shown.window.earlier,
      first: shownItems(state).at(0),
      held: shownItems(state).length,
      later: shown._tag === "Shown" && shown.window.later,
      wanted: wanted(state).filter((one) => one._tag !== "Networks" && one._tag !== "Status"),
    }).toStrictEqual({
      dropped: true,
      earlier: true,
      first: 1901,
      held: 100,
      later: false,
      wanted: [],
    });
  });

  it("keeps the Network list stale when an overflow touching everything came while it was read", () => {
    // The Network list is read, an overflow that touched everything comes, which may have
    // configured a Network, and then the list from before it lands.
    let state = reduceTimelines(following(), {
      _tag: "ReadStarted",
      read: { _tag: "Networks", attempt: 0 },
    });

    state = reduceTimelines(state, {
      _tag: "Overflowed",
      overflow: { sequence: sequenceOf(6), timelines: null },
      place: { sequence: 6, version: 1 },
    });
    state = reduceTimelines(state, { _tag: "NetworksRead", entries: entries("alpha") });

    const late = {
      fresh: state.entries.fresh,
      wanted: wanted(state).filter((one) => one._tag === "Networks"),
    };

    // Read again, it finds the Network the overflow hid.
    state = reduceTimelines(state, { _tag: "ReadStarted", read: { _tag: "Networks", attempt: 1 } });
    state = reduceTimelines(state, { _tag: "NetworksRead", entries: entries("alpha", "beta") });

    expect({
      found: wanted(state).filter(
        (one) => one._tag === "List" && one.network === networkId("beta")
      ),
      late,
    }).toStrictEqual({
      found: [{ _tag: "List", after: undefined, attempt: 0, network: networkId("beta") }],
      late: { fresh: false, wanted: [{ _tag: "Networks", attempt: 1 }] },
    });
  });

  it("takes the Network list as current from where the stream was when it was asked", () => {
    // Taken on, then an overflow that touched everything while the runtime waits, then asked.
    let state = reduceTimelines(following(), {
      _tag: "ReadStarted",
      read: { _tag: "Networks", attempt: 1 },
    });

    state = reduceTimelines(state, {
      _tag: "Overflowed",
      overflow: { sequence: sequenceOf(6), timelines: null },
      place: { sequence: 6, version: 1 },
    });
    state = reduceTimelines(state, {
      _tag: "Requesting",
      read: { _tag: "Networks", attempt: 1 },
    });
    state = reduceTimelines(state, { _tag: "NetworksRead", entries: entries("alpha", "beta") });

    expect({ fresh: state.entries.fresh, networks: [...state.networks.keys()] }).toStrictEqual({
      fresh: true,
      networks: [alpha, networkId("beta")],
    });
  });

  it("drops a read of another version, and asks again, waiting longer", () => {
    let state = reduceTimelines(following(), {
      _tag: "ReadStarted",
      read: latestOf(two, 1),
    });

    state = reduceTimelines(state, {
      _tag: "WindowRead",
      read: latestOf(two, 1),
      window: decodeWindow({
        earlier: false,
        gaps: [],
        items: [],
        later: false,
        network: "alpha",
        through: 5,
        timeline: idOf(2),
        version: 2,
      }),
    });
    state = reduceTimelines(state, { _tag: "Opened", timeline: two });

    expect(wanted(state).filter((read) => read._tag === "Latest")).toStrictEqual([
      { ...latestOf(two, 1), attempt: 1 },
    ]);
  });

  it("brings a read that lands after the stream passed it up to date", () => {
    let state = reduceTimelines(following(), { _tag: "Opened", timeline: two });

    state = reduceTimelines(state, {
      _tag: "ReadStarted",
      read: latestOf(two, 1),
    });
    state = reduceTimelines(state, changed(6, { items: encodedItems([message(idOf(2), 60, 6)]) }));
    state = reduceTimelines(state, {
      _tag: "WindowRead",
      read: latestOf(two, 1),
      window: decodeWindow({
        earlier: false,
        gaps: [],
        items: encodedItems([message(idOf(2), 20, 2)]),
        later: false,
        network: "alpha",
        through: 5,
        timeline: idOf(2),
        version: 1,
      }),
    });

    expect(shownItems(state)).toStrictEqual([2, 6]);
  });

  it("asks for older items before the first it holds, with the Gaps up to it", () => {
    expect(olderPage([], [{ count: 2, from: cursor(25, 2), to: cursor(28, 2) }])).toStrictEqual({
      before: 3,
      rows: [1, "gap 2", 3, 4],
    });
  });

  it("joins a run of Gaps the cursor split, one part on each side of it", () => {
    // Two Gaps that ended before the first item held, and one that reaches it, with no
    // item between them: one run, which the page and the window each gave a part of.
    expect(
      olderPage(
        [{ count: 1, from: cursor(29, 2), to: cursor(31, 2) }],
        [{ count: 2, from: cursor(25, 2), to: cursor(28, 2) }]
      )
    ).toStrictEqual({ before: 3, rows: [1, "gap 3", 3, 4] });
  });

  it("collapses a Gap that begins after another with no item between, and ends it", () => {
    const gap = (from: number, to: number | null, sequence: number) => ({
      changed: sequence,
      from: cursor(from, from / 10),
      network: "alpha",
      to: to === null ? null : cursor(to, to / 10),
    });

    let state = following();

    state = reduceTimelines(state, changed(5, { gaps: [gap(50, null, 5)] }));
    state = reduceTimelines(state, changed(6, { gaps: [gap(50, 60, 6)] }));
    state = reduceTimelines(state, changed(7, { gaps: [gap(70, null, 7)] }));
    const open = opened(state);
    state = reduceTimelines(state, changed(8, { gaps: [gap(70, 80, 8)] }));
    state = reduceTimelines(state, changed(9, { items: encodedItems([message(idOf(3), 90, 9)]) }));
    state = reduceTimelines(state, changed(10, { gaps: [gap(100, null, 10)] }));

    const shown = opened(state);

    expect({
      gaps: shown._tag === "Shown" ? shown.window.gaps : [],
      open: open._tag === "Shown" ? open.window.gaps : [],
    }).toStrictEqual({
      gaps: [
        decodeGap({ count: 2, from: cursor(50, 5), to: cursor(80, 8) }),
        decodeGap({ count: 1, from: cursor(100, 10), to: null }),
      ],
      open: [decodeGap({ count: 2, from: cursor(50, 5), to: null })],
    });
  });

  it("takes a Network's connection from known, then from later Session items", () => {
    let state = following();

    state = reduceTimelines(state, {
      _tag: "ReadStarted",
      read: { _tag: "Status", attempt: 0, network: alpha },
    });
    state = reduceTimelines(state, {
      _tag: "StatusRead",
      network: alpha,
      self: null,
      session: decodeSession({ _tag: "Registered", ircd: "ircd.test", since: 1 }),
    });
    const known = state.networks.get(alpha)?.connection;

    // A Session item from before the read's place says nothing new.
    state = reduceTimelines(state, {
      ...changed(6, {
        items: [
          {
            ...Schema.encodeSync(TimelineItem)(message(idOf(1), 40, 4)),
            content: { _tag: "SessionEnded", at: 40, reason: { _tag: "Error" } },
          },
        ],
      }),
    });
    const stale = state.networks.get(alpha)?.connection._tag;

    state = reduceTimelines(
      state,
      changed(7, {
        items: [
          {
            ...Schema.encodeSync(TimelineItem)(message(idOf(1), 70, 7)),
            content: { _tag: "SessionEnded", at: 70, reason: { _tag: "Error" } },
          },
        ],
      })
    );

    expect({
      after: state.networks.get(alpha)?.connection,
      known,
      stale,
    }).toStrictEqual({
      after: { _tag: "Offline", reason: { _tag: "Error" }, since: 70 },
      known: { _tag: "Connected", nick: undefined, since: 1 },
      stale: "Connected",
    });
  });

  it("places each collapsed Gap among the rows by where it began", () => {
    const state = reduceTimelines(following(), {
      _tag: "WindowRead",
      read: latestOf(three, 0),
      window: decodeWindow({
        earlier: false,
        gaps: [
          { count: 1, from: cursor(30, 3), to: cursor(35, 3) },
          { count: 3, from: cursor(40, 4), to: null },
        ],
        items: encodedItems([message(idOf(3), 30, 3), message(idOf(3), 40, 4)]),
        later: false,
        network: "alpha",
        through: 5,
        timeline: idOf(3),
        version: 1,
      }),
    });

    const shown = opened(state);

    expect(
      shown._tag === "Shown" ? rowsOf(shown.window).map((row) => rowText(row)) : []
    ).toStrictEqual([3, "gap 1", 4, "gap 3"]);
  });
});

/**
 * Splits the focused Pane, opening a Timeline in the new one.
 * @param state - The state.
 * @param timeline - The Timeline, or none for an empty Pane.
 * @param vertical - One above another, rather than side by side.
 * @returns The state.
 */
const split = (state: Timelines, timeline: TimelineId | undefined, vertical = false) =>
  reduceTimelines(state, {
    _tag: "Pane",
    change: { _tag: "Split", axis: vertical ? "Vertical" : "Horizontal", timeline },
  });

/**
 * What each Pane has open, by its id.
 * @param state - The state.
 * @returns Each Pane's id and open Timeline.
 */
const opens = (state: Timelines) =>
  panesOf(state.layout.root).map((pane) => [pane.id, pane.view.open]);

/**
 * Events folded in turn.
 * @param state - The state.
 * @param events - The events.
 * @returns The state after them.
 */
const folded = (state: Timelines, events: readonly TimelinesEvent[]) => {
  let after = state;

  for (const event of events) {
    after = reduceTimelines(after, event);
  }

  return after;
};

/**
 * A Pane as a device keeps it, as JSON text.
 * @param id - Its id.
 * @param open - The Timeline it has open.
 * @returns The JSON of the Pane, as a child of a Split.
 */
const keptPane = (id: string, open: string) =>
  `{"node":{"_tag":"Pane","id":"${id}","view":{"open":"${open}","options":null}},"ratio":0.5}`;

/**
 * A layout of two Panes side by side as a device keeps it, as JSON text.
 * @param left - The first, as `keptPane` writes it.
 * @param right - The second.
 * @returns The JSON.
 */
const keptOf = (left: string, right: string) =>
  `{"focused":"p0","next":2,"zoomed":false,"root":{"_tag":"Split","axis":"Horizontal","id":"s1","children":[${left},${right}]}}`;

describe("the Panes", () => {
  it("opens a Timeline in a new Pane, focused, and reads the window of each Pane", () => {
    const state = split(following(), two);

    expect({
      focused: state.layout.focused,
      opens: opens(state),
      reads: wanted(state).flatMap((read) => (read._tag === "Latest" ? [read.timeline] : [])),
    }).toStrictEqual({
      focused: "p1",
      opens: [
        ["p0", three],
        ["p1", two],
      ],
      reads: [two],
    });
  });

  it("splits into an empty Pane when the Timeline named is open in another already", () => {
    const state = split(following(), three);

    expect({ opened: opened(state)._tag, opens: opens(state) }).toStrictEqual({
      opened: "Closed",
      opens: [
        ["p0", three],
        ["p1", undefined],
      ],
    });
  });

  it("focuses the Pane a Timeline is open in rather than open it twice, keeping its window", () => {
    const state = split(following(), undefined);
    const window = state.windows.get(three);
    const again = reduceTimelines(state, { _tag: "Opened", timeline: three });

    expect({
      focused: again.layout.focused,
      navigation: again.navigation - state.navigation,
      opens: opens(again),
      same: again.windows.get(three) === window,
    }).toStrictEqual({
      focused: "p0",
      navigation: 1,
      opens: [
        ["p0", three],
        ["p1", undefined],
      ],
      same: true,
    });
  });

  it("opens in the focused Pane, and keeps the window of the one it replaced among the closed", () => {
    let state = split(following(), two);

    // The new Pane opens the Network's own Timeline in place of `#b`.
    state = reduceTimelines(state, { _tag: "Opened", timeline: one });

    expect({ closed: state.closed, opens: opens(state) }).toStrictEqual({
      closed: [two],
      opens: [
        ["p0", three],
        ["p1", one],
      ],
    });
  });

  it("closes the focused Pane, its window joining the closed, and the last never", () => {
    const state = split(following(), two);
    const closed = reduceTimelines(state, { _tag: "Pane", change: { _tag: "Close" } });
    const last = reduceTimelines(closed, { _tag: "Pane", change: { _tag: "Close" } });

    expect({
      closed: [closed.layout.focused, opens(closed), closed.closed, [...closed.windows.keys()]],
      last: last.layout,
    }).toStrictEqual({
      closed: ["p0", [["p0", three]], [two], [three]],
      last: closed.layout,
    });
  });

  it("lets a placement go when the Owner moves to another Pane, but not when a view moves with them", () => {
    const listed = reduceTimelines(
      split(following(), two),
      changed(6, { timelines: [direct(idOf(6), "bob")] })
    );

    const moved = reduceTimelines(listed, {
      _tag: "Pane",
      change: { _tag: "Move", direction: "Left" },
    });

    const swapped = reduceTimelines(listed, {
      _tag: "Pane",
      change: { _tag: "Swap", direction: "Left" },
    });

    const placed = (state: Timelines) =>
      openOf(
        reduceTimelines(state, {
          _tag: "Located",
          navigation: listed.navigation,
          timeline: timelineId(idOf(6)),
        })
      );

    expect({
      moved: [moved.navigation - listed.navigation, placed(moved)],
      swapped: [swapped.navigation - listed.navigation, swapped.layout.focused, opens(swapped)],
      swappedPlaced: placed(swapped),
    }).toStrictEqual({
      moved: [1, three],
      // The focused Pane itself moves to the left, its id, view, and focus with it.
      swapped: [
        0,
        "p1",
        [
          ["p1", two],
          ["p0", three],
        ],
      ],
      swappedPlaced: idOf(6),
    });
  });

  it("shows the options in one Pane, with its Timeline open behind them", () => {
    let state = split(following(), two);

    state = reduceTimelines(state, { _tag: "OptionsShown", filter: "a" });
    state = reduceTimelines(state, { _tag: "Pane", change: { _tag: "Focus", pane: "p0" } });
    // Shown again from the other Pane: the Pane that shows them takes the focus.
    state = reduceTimelines(state, { _tag: "OptionsShown", filter: "b" });

    const back = reduceTimelines(state, { _tag: "Opened", timeline: two });

    expect({
      back: [back.layout.focused, mainOf(back)],
      state: [state.layout.focused, mainOf(state), openOf(state)],
    }).toStrictEqual({
      back: ["p1", { _tag: "Timeline" }],
      state: ["p1", { _tag: "Options", filter: "b" }, two],
    });
  });

  it("keeps the layout as JSON and restores it once the Timelines are read, without a Timeline gone", () => {
    let state = split(following(), two, true);

    state = split(state, one);
    state = reduceTimelines(state, { _tag: "OptionsShown", filter: "x" });

    const kept = keptLayout(state);
    const decoded = decodeKept(JSON.stringify(kept));
    const read = decoded === undefined ? undefined : layoutKept(decoded);

    // A new page: the layout is set aside until every Network's Timelines are read, then
    // taken without `#b`, which the Daemon no longer lists.
    const fresh = reduceTimelines(timelinesWith(windowCap), {
      _tag: "Restore",
      layout: read ?? single(emptyView),
    });

    const waiting = [fresh.restoring !== undefined, keptLayout(fresh), opens(fresh)];

    const events: TimelinesEvent[] = [
      { _tag: "ReadStarted", read: { _tag: "Networks", attempt: 0 } },
      {
        _tag: "NetworksRead",
        entries: decodeEntries([{ network: "alpha", status: { _tag: "Running" } }]),
      },
      { _tag: "ReadStarted", read: { _tag: "List", after: undefined, attempt: 0, network: alpha } },
      {
        _tag: "ListRead",
        after: undefined,
        network: alpha,
        page: listOf(
          5,
          timelineOf(idOf(1), "Network", "alpha", 1),
          timelineOf(idOf(3), "Channel", "#a", 4)
        ),
      },
    ];

    const restored = folded(fresh, events);

    // The Owner opened a Timeline before the Timelines were read: the layout kept is let go.
    const elsewhere = folded(fresh, [
      ...events.slice(0, 2),
      { _tag: "Opened", timeline: one },
      ...events.slice(2),
    ]);

    expect({
      elsewhere: [elsewhere.restoring, opens(elsewhere)],
      kept,
      restored: [opens(restored), restored.layout.focused, mainOf(restored), restored.restoring],
      waiting,
      wants: wanted(restored).filter((one) => one._tag === "Latest").length,
    }).toStrictEqual({
      elsewhere: [undefined, [["p0", one]]],
      kept: {
        focused: "p2",
        next: 3,
        root: {
          _tag: "Split",
          axis: "Vertical",
          children: [
            { node: { _tag: "Pane", id: "p0", view: { open: three, options: null } }, ratio: 0.5 },
            {
              node: {
                _tag: "Split",
                axis: "Horizontal",
                children: [
                  {
                    node: { _tag: "Pane", id: "p1", view: { open: two, options: null } },
                    ratio: 0.5,
                  },
                  {
                    node: { _tag: "Pane", id: "p2", view: { open: one, options: "x" } },
                    ratio: 0.5,
                  },
                ],
                id: "s2",
              },
              ratio: 0.5,
            },
          ],
          id: "s1",
        },
        zoomed: false,
      },
      restored: [
        [
          ["p0", three],
          ["p2", one],
        ],
        "p2",
        { _tag: "Options", filter: "x" },
        undefined,
      ],
      waiting: [true, undefined, [["p0", undefined]]],
      wants: 2,
    });
  });

  it("refuses a kept layout that is not one, and opens a Timeline kept twice once", () => {
    const twice = decodeKept(keptOf(keptPane("p0", idOf(3)), keptPane("p1", idOf(3))));
    const twiceIds = decodeKept(keptOf(keptPane("p0", idOf(3)), keptPane("p0", idOf(2))));

    // Restored before the Owner went anywhere.
    const restored = reduceTimelines(
      { ...following(), navigation: 0 },
      { _tag: "Restore", layout: (twice && layoutKept(twice)) ?? single(emptyView) }
    );

    expect({
      badId: decodeKept(keptOf(keptPane("p0", "not an id"), keptPane("p1", idOf(3)))),
      notJson: decodeKept("{"),
      restored: [opens(restored), restored.navigation],
      twiceIds: twiceIds && layoutKept(twiceIds),
    }).toStrictEqual({
      badId: undefined,
      notJson: undefined,
      restored: [
        [
          ["p0", three],
          ["p1", undefined],
        ],
        0,
      ],
      twiceIds: undefined,
    });
  });

  it("empties the Pane not focused when a merge leaves two Panes on one Timeline", () => {
    // `#a` in the first Pane, `#b` in the second, focused; `#b` goes into `#a`.
    const both = split(following(), two);

    const merged = reduceTimelines(
      both,
      changed(6, { merged: [{ changed: 6, id: idOf(2), into: idOf(3), network: "alpha" }] })
    );

    // The other way: the focused Pane's Timeline goes into the other's, which is emptied.
    const other = reduceTimelines(
      reduceTimelines(both, { _tag: "Pane", change: { _tag: "Focus", pane: "p0" } }),
      changed(6, { merged: [{ changed: 6, id: idOf(2), into: idOf(3), network: "alpha" }] })
    );

    expect({
      merged: [merged.layout.focused, opens(merged), opened(merged, "p0")._tag],
      other: [other.layout.focused, opens(other)],
    }).toStrictEqual({
      merged: [
        "p1",
        [
          ["p0", undefined],
          ["p1", two],
        ],
        "Closed",
      ],
      other: [
        "p0",
        [
          ["p0", three],
          ["p1", undefined],
        ],
      ],
    });
  });

  it("never has a Timeline open in two Panes, whatever the Owner does and whatever merges", () => {
    const ids = [one, two, three];

    const action = fc.oneof(
      fc.record({ _tag: fc.constant("Open" as const), pick: fc.nat(2) }),
      fc.record({ _tag: fc.constant("Split" as const), pick: fc.nat(3), vertical: fc.boolean() }),
      fc.record({ _tag: fc.constant("Pane" as const), pick: fc.nat(20) }),
      fc.record({ _tag: fc.constant("Merge" as const), from: fc.nat(2), into: fc.nat(2) })
    );

    fc.assert(
      fc.property(fc.array(action, { maxLength: 30 }), (actions) => {
        let state = following();
        let sequence = 6;
        const faults: string[] = [];

        for (const one of actions) {
          const panes = panesOf(state.layout.root);
          const towards = directions[one._tag === "Pane" ? one.pick % 4 : 0] ?? "Left";
          let event: TimelinesEvent;

          if (one._tag === "Open") {
            event = { _tag: "Opened", timeline: ids[one.pick] ?? two };
          } else if (one._tag === "Split") {
            event = {
              _tag: "Pane",
              change: {
                _tag: "Split",
                axis: one.vertical ? "Vertical" : "Horizontal",
                timeline: ids[one.pick],
              },
            };
          } else if (one._tag === "Pane") {
            const changes: readonly PaneChange[] = [
              { _tag: "Close" },
              { _tag: "Focus", pane: panes[one.pick % panes.length]?.id ?? "p0" },
              { _tag: "Move", direction: towards },
              { _tag: "Swap", direction: towards },
            ];

            event = { _tag: "Pane", change: changes[one.pick % 4] ?? { _tag: "Close" } };
          } else {
            sequence += 1;
            event = changed(sequence, {
              merged:
                one.from === one.into
                  ? []
                  : [
                      {
                        changed: sequence,
                        id: ids[one.from] ?? two,
                        into: ids[one.into] ?? three,
                        network: "alpha",
                      },
                    ],
            });
          }

          state = reduceTimelines(state, event);
          faults.push(...paneFaults(state).filter((fault) => !fault.startsWith("a window")));
        }

        expect(faults).toStrictEqual([]);
      }),
      { numRuns: 300 }
    );
  });

  it("refuses a kept layout's text that is too long, too deep, of too many Panes, or no JSON, without throwing", () => {
    const deep = `${'{"a":'.repeat(5000)}1${"}".repeat(5000)}`;

    const many = `{"focused":"p0","next":99,"zoomed":false,"root":{"_tag":"Split","axis":"Horizontal","id":"s0","children":[${Array.from(
      { length: 65 },
      (_, index) =>
        `{"node":{"_tag":"Pane","id":"p${index}","view":{"open":null,"options":null}},"ratio":1}`
    ).join(",")}]}}`;

    const nested = (levels: number): string =>
      levels === 0
        ? keptPane("p0", idOf(3)).slice(8, -13)
        : `{"_tag":"Split","axis":"${levels % 2 === 0 ? "Vertical" : "Horizontal"}","id":"s${levels}","children":[{"node":${nested(levels - 1)},"ratio":0.5},{"node":{"_tag":"Pane","id":"p${levels}","view":{"open":null,"options":null}},"ratio":0.5}]}`;

    const layoutOf = (levels: number) =>
      `{"focused":"p0","next":99,"zoomed":false,"root":${nested(levels)}}`;

    expect({
      deep: layoutKeptText(deep),
      fine: layoutKeptText(keptOf(keptPane("p0", idOf(3)), keptPane("p1", idOf(2))))?.focused,
      long: layoutKeptText(" ".repeat(longestKept + 1)),
      many: layoutKeptText(many),
      notJson: layoutKeptText("{"),
      seventeen: layoutKeptText(layoutOf(17)),
      sixteen: layoutKeptText(layoutOf(16)) === undefined,
    }).toStrictEqual({
      deep: undefined,
      fine: "p0",
      long: undefined,
      many: undefined,
      notJson: undefined,
      seventeen: undefined,
      sixteen: false,
    });
  });
});

/**
 * A window as `olderUnasked` reads it.
 * @param length - How many items it holds.
 * @param earlier - Whether more lie before.
 * @param later - Whether more lie after.
 * @returns The window.
 */
const held = (length: number, earlier: boolean, later: boolean) => ({
  earlier,
  items: Array.from({ length }),
  later,
});

describe("reading without asking, and jumping to the latest", () => {
  it("reads the page before without asking only where it cannot push the latest past the cap", () => {
    expect([
      olderUnasked(held(100, true, false), windowCap),
      olderUnasked(held(windowCap - 100, true, false), windowCap),
      olderUnasked(held(windowCap - 99, true, false), windowCap),
      olderUnasked(held(windowCap, true, true), windowCap),
      olderUnasked(held(100, false, false), windowCap),
    ]).toStrictEqual([true, true, false, true, false]);
  });

  it("reads the latest again, whole, and follows it, from a window with newer items beyond it", () => {
    let state = reduceTimelines(following(), {
      _tag: "WindowRead",
      read: latestOf(three, 0),
      window: decodeWindow({
        earlier: false,
        gaps: [],
        items: encodedItems([message(idOf(3), 30, 3)]),
        later: true,
        network: "alpha",
        through: 5,
        timeline: idOf(3),
        version: 1,
      }),
    });

    state = reduceTimelines(state, {
      _tag: "Following",
      following: false,
      seen: undefined,
      timeline: three,
    });
    state = reduceTimelines(state, { _tag: "LatestWanted", timeline: three });
    const shown = opened(state);

    expect({
      following: shown._tag === "Shown" ? shown.window.following : undefined,
      latest: wanted(state).some((one) => one._tag === "Latest" && one.timeline === three),
    }).toStrictEqual({ following: true, latest: true });
  });
});

describe("a page read on its own before a window that holds the latest", () => {
  it("keeps the latest, a live item that arrived while it was read included, and drops its own oldest", () => {
    // The window holds 950 items up to the latest, at step 1950, and follows it.
    let state = reduceTimelines(following(), {
      _tag: "WindowRead",
      read: latestOf(three, 0),
      window: numberedWindow(1000, 1949, true, false),
    });

    state = reduceTimelines(state, {
      _tag: "Following",
      following: true,
      seen: undefined,
      timeline: three,
    });

    // Read on its own, as scrolling near the top does.
    state = reduceTimelines(state, { _tag: "OlderWanted", mode: "Auto", timeline: three });
    const older = wanted(state).find((one) => one._tag === "Older");

    if (older === undefined || older._tag !== "Older") {
      throw new Error("no read of older items");
    }

    state = reduceTimelines(state, { _tag: "ReadStarted", read: older });

    // A live item arrives between the request and its answer.
    state = reduceTimelines(
      state,
      changed(6, { items: encodedItems([message(idOf(3), 19_500, 1951)]) })
    );

    state = reduceTimelines(state, {
      _tag: "WindowRead",
      read: older,
      window: numberedWindow(900, 999, true, true),
    });

    const shown = opened(state);
    const items = shownItems(state);

    expect({
      earlier: shown._tag === "Shown" ? shown.window.earlier : undefined,
      first: items[0],
      last: items.at(-1),
      later: shown._tag === "Shown" ? shown.window.later : undefined,
      length: items.length,
      mode: older.mode,
    }).toStrictEqual({
      earlier: true,
      first: 952,
      last: 1951,
      later: false,
      length: windowCap,
      mode: "Auto",
    });
  });

  it("drops the newest instead when the Owner asked for it", () => {
    let state = reduceTimelines(following(), {
      _tag: "WindowRead",
      read: latestOf(three, 0),
      window: numberedWindow(1000, 1949, true, false),
    });

    state = reduceTimelines(state, { _tag: "OlderWanted", mode: "Auto", timeline: three });
    // Asked on purpose meanwhile, which stays asked.
    state = reduceTimelines(state, { _tag: "OlderWanted", mode: "Asked", timeline: three });
    state = reduceTimelines(state, { _tag: "OlderWanted", mode: "Auto", timeline: three });
    const older = wanted(state).find((one) => one._tag === "Older");

    if (older === undefined || older._tag !== "Older") {
      throw new Error("no read of older items");
    }

    state = reduceTimelines(state, { _tag: "ReadStarted", read: older });
    state = reduceTimelines(state, {
      _tag: "WindowRead",
      read: older,
      window: numberedWindow(900, 999, true, true),
    });

    const shown = opened(state);
    const items = shownItems(state);

    expect({
      first: items[0],
      last: items.at(-1),
      later: shown._tag === "Shown" ? shown.window.later : undefined,
      mode: older.mode,
    }).toStrictEqual({ first: 901, last: 1900, later: true, mode: "Asked" });
  });
});

// Searching, and jumping to what was found.

const decodeResults = Schema.decodeSync(SearchResults);

/**
 * The search shown in the focused Pane, searching a query read against the Timelines.
 * @param state - The state.
 * @param query - The query.
 * @returns The state.
 */
const searching = (state: Timelines, query: string) =>
  reduceTimelines(state, {
    _tag: "SearchShown",
    parsed: parseQuery(query, {
      dayStart: () => 0,
      focused: alpha,
      networks: sidebar(state),
    }),
    query,
  });

/**
 * The page of the search the state wants, started.
 * @param state - The state.
 * @returns The state, and the read.
 */
const searchStarted = (state: Timelines) => {
  const read = wanted(state).find((one): one is SearchRequest => one._tag === "Search");

  if (read === undefined) {
    throw new Error("no page of the search wanted");
  }

  return { read, state: reduceTimelines(state, { _tag: "ReadStarted", read }) };
};

const resultsPage = (more: boolean, ...items: readonly ReturnType<typeof message>[]) =>
  decodeResults({
    items: encodedItems(items),
    more,
    next: more ? `${cursor(10, 1)}.${idOf(2)}` : null,
    through: 5,
    version: 1,
  });

const windowOf = (state: Timelines, timeline: TimelineId) => state.windows.get(timeline);

describe("searching", () => {
  it("shows in the focused Pane in front of its Timeline, reads a page at a time while shown, and closes back", () => {
    let state = searching(following(), "word in:#b");
    const first = searchStarted(state);

    state = reduceTimelines(first.state, {
      _tag: "SearchRead",
      page: resultsPage(true, message(idOf(2), 20, 2)),
      read: first.read,
    });

    const afterFirst = wanted(state).filter((one) => one._tag === "Search");

    state = reduceTimelines(state, { _tag: "SearchChanged", change: { _tag: "More" } });
    const next = searchStarted(state);
    const closed = reduceTimelines(next.state, { _tag: "SearchClosed" });

    expect({
      after: next.read.after?.position.sequence,
      afterFirst,
      closed: [mainOf(closed), openOf(closed)],
      filters: [first.read.filters.text, first.read.filters.timeline],
      hidden: wanted(reduceTimelines(state, { _tag: "SearchClosed" })).filter(
        (one) => one._tag === "Search"
      ),
      main: mainOf(state),
      results: state.search.results.map((item) => item.sequence),
    }).toStrictEqual({
      after: 1,
      afterFirst: [],
      closed: [{ _tag: "Timeline" }, three],
      filters: ["word", two],
      // Hidden, it reads nothing, and what it found is kept.
      hidden: [],
      main: { _tag: "Search", back: { _tag: "Timeline" } },
      results: [2],
    });
  });

  it("shows the options again when closed, if it was opened in front of them", () => {
    let state = reduceTimelines(following(), { _tag: "OptionsShown", filter: "nick" });

    state = searching(state, "word");
    const kept = keptLayout(state);

    state = reduceTimelines(state, { _tag: "SearchClosed" });

    expect({
      kept: kept?.root._tag === "Pane" ? kept.root.view : undefined,
      main: mainOf(state),
    }).toStrictEqual({
      // A search is never kept: what it shows in front of is.
      kept: { open: three, options: "nick" },
      main: { _tag: "Options", filter: "nick" },
    });
  });

  it("begins again from the first page when the changes report a merge, an overflow, or a reset", () => {
    let state = searching(following(), "m2 word");
    const first = searchStarted(state);

    state = reduceTimelines(first.state, {
      _tag: "SearchRead",
      page: resultsPage(true, message(idOf(2), 20, 2)),
      read: first.read,
    });

    const restartedBy = (event: TimelinesEvent) => {
      const after = reduceTimelines(state, event);
      const read = wanted(after).find((one): one is SearchRequest => one._tag === "Search");

      return [after.search.results.length, read?.after, read?.generation];
    };

    expect({
      merged: restartedBy(
        changed(6, {
          merged: [{ changed: 6, id: idOf(3), into: idOf(2), network: "alpha" }],
        })
      ),
      overflowed: restartedBy({
        _tag: "Overflowed",
        overflow: { sequence: sequenceOf(6), timelines: [two] },
        place: { sequence: 6, version: 1 },
      }),
      quiet: restartedBy(changed(6, { items: encodedItems([message(idOf(3), 50, 6)]) })),
      reset: restartedBy({ _tag: "Reset", reset: { through: sequenceOf(6), version: 2 } }),
    }).toStrictEqual({
      merged: [0, undefined, 2],
      overflowed: [0, undefined, 2],
      // A step with no merge keeps the pages read, and wants none.
      quiet: [1, undefined, undefined],
      reset: [0, undefined, 2],
    });
  });
});

describe("jumping to a result", () => {
  it("opens its Timeline in the search's Pane, read around its position as a new window, never following", () => {
    let state = searching(following(), "m2 word");

    state = reduceTimelines(state, {
      _tag: "Jumped",
      position: message(idOf(2), 20, 2).position,
      timeline: two,
    });

    const around = wanted(state).find((one) => one._tag === "Around");

    if (around === undefined || around._tag !== "Around") {
      throw new Error("no read around the result");
    }

    const reading = opened(state)._tag;

    state = reduceTimelines(state, { _tag: "ReadStarted", read: around });
    state = reduceTimelines(state, {
      _tag: "WindowRead",
      read: around,
      window: decodeWindow({
        earlier: true,
        gaps: [],
        items: encodedItems([message(idOf(2), 10, 1), message(idOf(2), 20, 2)]),
        later: true,
        network: "alpha",
        through: 5,
        timeline: idOf(2),
        version: 1,
      }),
    });

    // A live item past the end waits beyond it, since the Owner is not at the latest.
    state = reduceTimelines(state, changed(6, { items: encodedItems([message(idOf(2), 60, 6)]) }));
    const window = windowOf(state, two);

    expect({
      around: [around.around.sequence, around.generation],
      main: mainOf(state),
      open: openOf(state),
      reading,
      window: [
        window?.items.map((item) => item.sequence),
        window?.following,
        window?.later,
        window?.target?.sequence,
        window?.seen,
      ],
    }).toStrictEqual({
      around: [2, 1],
      main: { _tag: "Timeline" },
      open: two,
      reading: "Reading",
      window: [[1, 2], false, true, 2, undefined],
    });
  });

  it("takes no answer of the window it replaced, and reads around again after an overflow", () => {
    // The latest of three is being read when the Owner jumps into it.
    let state = reduceTimelines(following(), { _tag: "LatestWanted", timeline: three });
    const latest = wanted(state).find((one) => one._tag === "Latest");

    if (latest === undefined) {
      throw new Error("no read of the latest");
    }

    state = reduceTimelines(state, { _tag: "ReadStarted", read: latest });
    state = reduceTimelines(state, {
      _tag: "Jumped",
      position: message(idOf(3), 30, 3).position,
      timeline: three,
    });

    const around = wanted(state).find((one) => one._tag === "Around");

    // The latest lands, for the window replaced: it is not taken.
    state = reduceTimelines(state, {
      _tag: "WindowRead",
      read: latest,
      window: numberedWindow(1900, 1999, true, false),
    });

    const ignored = windowOf(state, three)?.items.length;

    if (around === undefined || around._tag !== "Around") {
      throw new Error("no read around the result");
    }

    state = reduceTimelines(state, { _tag: "ReadStarted", read: around });
    state = reduceTimelines(state, {
      _tag: "WindowRead",
      read: around,
      window: numberedWindow(100, 199, true, true),
    });

    state = reduceTimelines(state, {
      _tag: "Overflowed",
      overflow: { sequence: sequenceOf(6), timelines: [three] },
      place: { sequence: 6, version: 1 },
    });

    expect({
      again: wanted(state).find((one) => one._tag === "Around" || one._tag === "Latest")?._tag,
      ignored,
      latest: latest.generation,
      now: around.generation,
    }).toStrictEqual({ again: "Around", ignored: 0, latest: 0, now: 1 });
  });

  it("takes the latest as seen only when the Owner moved there themselves", () => {
    let state = reduceTimelines(following(), {
      _tag: "Jumped",
      position: message(idOf(3), 40, 4).position,
      timeline: three,
    });

    const around = wanted(state).find((one) => one._tag === "Around");

    if (around === undefined || around._tag !== "Around") {
      throw new Error("no read around the result");
    }

    // The newest is the result: the window around it holds the latest.
    state = reduceTimelines(state, { _tag: "ReadStarted", read: around });
    state = reduceTimelines(state, {
      _tag: "WindowRead",
      read: around,
      window: decodeWindow({
        earlier: false,
        gaps: [],
        items: encodedItems([message(idOf(3), 30, 3), message(idOf(3), 40, 4)]),
        later: false,
        network: "alpha",
        through: 5,
        timeline: idOf(3),
        version: 1,
      }),
    });

    const at = message(idOf(3), 40, 4).position;

    const laidOut = reduceTimelines(state, {
      _tag: "Following",
      following: true,
      seen: at,
      timeline: three,
    });

    const owned = reduceTimelines(laidOut, {
      _tag: "Following",
      following: true,
      owned: true,
      seen: at,
      timeline: three,
    });

    expect({
      laidOut: [
        windowOf(laidOut, three)?.following,
        windowOf(laidOut, three)?.seen,
        windowOf(laidOut, three)?.anchor?.sequence,
      ],
      owned: [
        windowOf(owned, three)?.following,
        windowOf(owned, three)?.seen?.sequence,
        windowOf(owned, three)?.anchor,
      ],
    }).toStrictEqual({
      laidOut: [false, undefined, 4],
      owned: [true, 4, undefined],
    });
  });

  it("marks nothing read, and reads the latest again once the Owner asks or reaches it", () => {
    let state = reduceTimelines(following(), {
      _tag: "Jumped",
      position: message(idOf(3), 30, 3).position,
      timeline: three,
    });

    const around = wanted(state).find((one) => one._tag === "Around");

    if (around === undefined || around._tag !== "Around") {
      throw new Error("no read around the result");
    }

    state = reduceTimelines(state, { _tag: "ReadStarted", read: around });
    state = reduceTimelines(state, {
      _tag: "WindowRead",
      read: around,
      window: numberedWindow(100, 199, true, true),
    });

    const jumped = windowOf(state, three);
    const left = reduceTimelines(state, { _tag: "TargetLeft", timeline: three });
    const latest = reduceTimelines(state, { _tag: "LatestWanted", timeline: three });

    expect({
      jumped: [jumped?.seen, jumped?.following, jumped?.target?.sequence],
      latest: [
        wanted(latest).find((one) => one._tag === "Latest" || one._tag === "Around")?._tag,
        windowOf(latest, three)?.target,
        windowOf(latest, three)?.following,
      ],
      left: windowOf(left, three)?.target,
    }).toStrictEqual({
      jumped: [undefined, false, 3],
      latest: ["Latest", undefined, true],
      left: undefined,
    });
  });

  it("jumps in the Pane that has the Timeline open, which takes the focus, leaving the search where it is", () => {
    // Two Panes: p0 has three open, p1 has two, and the search shows in p1.
    let state = split(following(), two);

    state = searching(state, "m3 word");
    state = reduceTimelines(state, {
      _tag: "Jumped",
      position: message(idOf(3), 30, 3).position,
      timeline: three,
    });

    expect({
      focused: state.layout.focused,
      mains: panesOf(state.layout.root).map((pane) => pane.view.main._tag),
      opens: opens(state),
    }).toStrictEqual({
      focused: "p0",
      mains: ["Timeline", "Search"],
      opens: [
        ["p0", three],
        ["p1", two],
      ],
    });
  });
});
