/* oxlint-disable anti-slop/no-unknown-parameters -- The laws show any value as JSON, Maps shown as their entries. */
/**
 * The laws every Timeline store adapter keeps, as data, so the in-memory store and a
 * durable one agree. Each is checked with `holds` from `@iirc/runtime/testing`.
 *
 * @packageDocumentation
 */
import { Instant, IntentId, MessageId } from "@iirc/client";
import type { Fact } from "@iirc/client/known";
import { LawBroken } from "@iirc/runtime/testing";
import type { Law } from "@iirc/runtime/testing";
import {
  SearchText,
  comparePositions,
  cursorOf,
  emptyDirectory,
  levels,
  searchableOf,
  step,
  timelineIdOf,
  unreadCap,
} from "@iirc/timelines";
import type {
  Change,
  Content,
  Delivery,
  Directory,
  Kind,
  Level,
  Position,
  TimelineId,
} from "@iirc/timelines";
import { Deferred, Effect, Equal, Fiber, Option, Scheduler, Schema } from "effect";

import type {
  Anchor,
  Gap,
  Item,
  Search,
  Summary,
  TimelineStoreFailed,
  TimelineStoreService,
  Tombstone,
  Unread,
} from "../store.ts";
import { noneUnread, unreadOf } from "../store.ts";

// Maps are shown as their entries, so a failure says what each held.
const entries = (_key: string, each: unknown) => (each instanceof Map ? [...each] : each);

const show = (value: unknown): string => JSON.stringify(value, entries) ?? "undefined";

// Two values are the same when they are structurally equal: arrays in order, objects by
// their keys whatever order they came in, and Maps and Sets by what they hold, with no
// order. No read promises an order from a Map or a Set.
const same = <T>(what: string, actual: T, expected: T) =>
  Equal.equals(actual, expected)
    ? Effect.void
    : Effect.fail(new LawBroken({ actual: show(actual), expected: show(expected), what }));

// A law's step must differ from what it is checked against, or the law proves nothing.
const differs = <T>(what: string, left: T, right: T) =>
  Equal.equals(left, right)
    ? Effect.fail(new LawBroken({ actual: show(left), expected: `not ${show(right)}`, what }))
    : Effect.void;

const libera = "libera";
const oftc = "oftc";
const t0 = 1_762_560_000_000;

const at = (ms: number) => Instant.make(t0 + ms);

const position = (ms: number, sequence: number, n = 0): Position => ({
  at: at(ms),
  n,
  sequence,
});

const known = <T>(value: T): Fact<T> => ({ _tag: "Known", at: at(0), from: "ircd", value });

const network = timelineIdOf(1, 0, 0);
const channel = timelineIdOf(1, 0, 1);
const other = timelineIdOf(1, 0, 2);
const third = timelineIdOf(1, 0, 3);
const oftcNetwork = timelineIdOf(1, 0, 4);

const described = (
  sequence: number,
  id: TimelineId,
  kind: Kind,
  name: string,
  key: string | null,
  on = libera
): Change => ({ _tag: "Described", sequence, timeline: { id, key, kind, name, network: on } });

const opened = (sequence: number, on = libera): readonly Change[] => [
  described(sequence, network, "Network", on, null, on),
  described(sequence, channel, "Channel", "#a", "#a", on),
  described(sequence, other, "Channel", "#b", "#b", on),
];

const said = (text: string, delivery?: "Pending" | "Unconfirmed"): Content => ({
  _tag: "Message",
  at: known(at(0)),
  id: { _tag: "Unknown" },
  kind: "Privmsg",
  live: true,
  ours:
    delivery === undefined
      ? undefined
      : { delivery: { _tag: delivery }, intent: IntentId.make(`intent-${text}`) },
  sender: "peer",
  tags: [],
  target: "#a",
  text,
});

// A Message of ours and a refused action of ours have no level, and anything else said
// is a Message, as in a Channel.
const levelOf = (content: Content): Level | undefined => {
  if (content._tag === "ActionRefused") {
    return undefined;
  }

  if (content._tag !== "Message") {
    return "Activity";
  }

  return content.ours === undefined ? "Message" : undefined;
};

const added = (
  sequence: number,
  timeline: TimelineId,
  where: Position,
  content: Content,
  messageId?: string,
  on = libera,
  level = levelOf(content)
): Extract<Change, { readonly _tag: "Added" }> => ({
  _tag: "Added",
  content,
  intent: content._tag === "Message" ? content.ours?.intent : undefined,
  level,
  messageId: messageId === undefined ? undefined : MessageId.make(messageId),
  network: on,
  position: where,
  sequence,
  timeline,
});

const textOf = (item: Item) =>
  item.content._tag === "Message" ? item.content.text : item.content._tag;

const deliveryOf = (item: Item) =>
  item.content._tag === "Message" ? item.content.ours?.delivery : undefined;

const apply = (store: TimelineStoreService, through: number, changes: readonly Change[]) =>
  store.apply({ changes, directory: emptyDirectory, through });

// The directory after a step that began a Session on a Network. It is never empty, and
// differs from the one before it whenever the sequence does.
const directoryAfter = (before: Directory, on: string, sequence: number): Directory =>
  step(before, {
    at: at(sequence),
    network: on,
    news: [{ _tag: "SessionBegan", at: at(sequence), nick: "iirc" }],
    sequence,
  }).directory;

const inOrder = <A, B, E, R>(items: Iterable<A>, f: (item: A) => Effect.Effect<B, E, R>) =>
  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes the iterable first; it has no thisArg.
  Effect.forEach(items, f);

const isSearchText = Schema.is(SearchText);

// The text of each Message among items that a search can look for, folded, once each.
const searchTexts = (items: readonly Item[]) =>
  [
    ...new Set(
      items.flatMap((item) => {
        const found = searchableOf(item.content);

        return found === undefined || !isSearchText(found.text) ? [] : [found.text];
      })
    ),
  ].toSorted();

// What a search found, as each item's Timeline and cursor, in the order given.
const placesOf = (items: readonly Item[]) =>
  items.map(({ position: where, timeline }) => [timeline, cursorOf(where)] as const);

// Everything a store holds that a reader can see, to compare before and after: each read
// that returns what a step may have changed, in full.
const snapshot = (store: TimelineStoreService) =>
  Effect.gen(function* () {
    const changed = yield* store.changedAfter(undefined);
    const timelines = yield* store.timelines(libera);

    // Each Message's text searched for, so an index half kept is seen.
    const searched = yield* inOrder(searchTexts(changed.items), (text) =>
      store
        .search({ limit: 1000, text: SearchText.make(text) })
        .pipe(Effect.map((found) => [text, placesOf(found)] as const))
    );

    const windows = yield* inOrder(timelines, ({ id }) =>
      store
        .window(id, { _tag: "After" }, 1000)
        .pipe(Effect.map((window) => [id, Option.getOrUndefined(window)] as const))
    );

    return {
      changedTimelines: changed.timelines,
      directory: yield* store.directory,
      folded: yield* store.folded,
      gaps: changed.gaps,
      gapsRead: yield* store.gaps(libera, {}),
      items: changed.items,
      merged: changed.merged,
      searched,
      timelines,
      windows,
    };
  });

type Snapshot = Effect.Success<ReturnType<typeof snapshot>>;

const compareText = (left: string, right: string) => {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
};

// What a store holds, as the reads in a snapshot show it. A law says what a step leaves by
// changing a model of what was there, and `project` gives the snapshot a store must show
// for a model, ordered as the reads order it.
interface Model {
  readonly directory: Directory;
  readonly folded: Snapshot["folded"];
  readonly gaps: readonly Gap[];
  readonly items: readonly Item[];
  readonly merged: readonly Tombstone[];
  readonly timelines: readonly Summary[];
}

const modelOf = (shown: Snapshot): Model => ({
  directory: shown.directory,
  folded: shown.folded,
  gaps: shown.gaps,
  items: shown.items,
  merged: shown.merged,
  timelines: shown.timelines,
});

// How many items of each level stand after a Read Marker, counted one by one and capped.
const countUnread = (items: readonly Item[], read: Instant | undefined): Unread => {
  const counts = { ...noneUnread };

  for (const { level, position: where } of items) {
    if (level !== undefined && (read === undefined || where.at > read)) {
      const field = unreadOf[level];

      counts[field] = Math.min(counts[field] + 1, unreadCap + 1);
    }
  }

  return counts;
};

// The order a search gives: by position, latest first, and at one position by Timeline id,
// last first.
const newestFirst = (left: Item, right: Item) =>
  comparePositions(right.position, left.position) || compareText(right.timeline, left.timeline);

const project = (model: Model): Snapshot => {
  const itemsIn = (timeline: TimelineId) =>
    model.items
      .filter((item) => item.timeline === timeline)
      .toSorted((left, right) => comparePositions(left.position, right.position));

  const timelines = model.timelines
    .map((each) => ({
      ...each,
      latest: itemsIn(each.id).at(-1)?.position,
      unread: countUnread(itemsIn(each.id), each.read),
    }))
    .toSorted((left, right) => compareText(left.id, right.id));

  return {
    changedTimelines: timelines.toSorted(
      (left, right) => left.changed - right.changed || compareText(left.id, right.id)
    ),
    directory: model.directory,
    folded: model.folded,
    gaps: model.gaps.toSorted(
      (left, right) =>
        left.changed - right.changed ||
        compareText(left.network, right.network) ||
        comparePositions(left.from, right.from)
    ),
    gapsRead: model.gaps
      .filter(({ network: on }) => on === libera)
      .toSorted((left, right) => comparePositions(left.from, right.from)),
    items: model.items.toSorted(
      (left, right) =>
        left.changed - right.changed ||
        compareText(left.timeline, right.timeline) ||
        comparePositions(left.position, right.position)
    ),
    merged: model.merged.toSorted(
      (left, right) => left.changed - right.changed || compareText(left.id, right.id)
    ),
    searched: searchTexts(model.items).map(
      (text) =>
        [
          text,
          placesOf(
            model.items
              .filter((item) => searchableOf(item.content)?.text.includes(text) === true)
              .toSorted(newestFirst)
          ),
        ] as const
    ),
    timelines,
    windows: timelines.map(
      ({ id, network: on }) =>
        [
          id,
          { earlier: false, items: itemsIn(id), later: false, network: on, timeline: id },
        ] as const
    ),
  };
};

const texts = (store: TimelineStoreService, timeline: TimelineId, anchor: Anchor, limit = 100) =>
  store.window(timeline, anchor, limit).pipe(
    Effect.map(
      Option.match({
        onNone: () => "none",
        onSome: (window) =>
          `${window.earlier ? "<" : "|"} ${window.items.map(textOf).join(" ")} ${window.later ? ">" : "|"}`,
      })
    )
  );

const all: Anchor = { _tag: "After" };

const gap = (sequence: number, from: Position, to: Position | undefined, on = libera): Change => ({
  _tag: "Gap",
  from,
  network: on,
  sequence,
  to,
});

// A step to interrupt, and what it leaves.
interface Interruption {
  /** Changes applied whole in a step of their own just before the one interrupted, at `sequence - 1`, to be changed by it. */
  readonly seed: (sequence: number) => readonly Change[];
  /** The step interrupted, at `sequence`. Each step differs from every one before it. */
  readonly step: (sequence: number) => readonly Change[];
  /** What the store holds after it, but for the directory and how far it has folded. */
  readonly edit: (before: Model, sequence: number) => Model;
}

// Interrupts applies at every point between two operations, by making the scheduler yield
// every few operations. The step is applied whole, or not at all: afterwards everything a
// read returns is together exactly what it was before, or exactly what the step leaves,
// and never part of each. A budget below 3 livelocks Effect 4.1.1's scheduler.
const interrupting =
  ({ seed, step: stepOf, edit }: Interruption) =>
  (store: TimelineStoreService) =>
    Effect.gen(function* () {
      yield* store.reset(3);
      yield* store.apply({
        changes: opened(1),
        directory: directoryAfter(emptyDirectory, libera, 1),
        through: 1,
      });

      const applied = yield* inOrder(
        Array.from({ length: 40 }, (_, steps) => steps),
        (steps) =>
          Effect.gen(function* () {
            const first = ((yield* store.folded).through ?? 0) + 1;
            const seeding = seed(first);

            if (seeding.length > 0) {
              yield* store.apply({
                changes: seeding,
                directory: directoryAfter(yield* store.directory, libera, first),
                through: first,
              });
            }

            const sequence = seeding.length > 0 ? first + 1 : first;
            const before = yield* snapshot(store);
            const directory = directoryAfter(before.directory, libera, sequence);
            const changes = stepOf(sequence);

            yield* differs("the step's directory", directory, before.directory);
            // The model says what the store shows, or what it says of the step means nothing.
            yield* same("the model of what was there", project(modelOf(before)), before);

            const applying = yield* Effect.forkChild(
              store.apply({ changes, directory, through: sequence })
            );

            for (let yielded = 0; yielded < steps; yielded += 1) {
              yield* Effect.yieldNow;
            }

            yield* Fiber.interrupt(applying);

            const after = yield* snapshot(store);
            const where = `after ${steps} steps`;

            if (after.folded.through !== sequence) {
              yield* same(`${where}, nothing applied`, after, before);

              return false;
            }

            yield* same(
              `${where}, applied`,
              after,
              project({
                ...edit(modelOf(before), sequence),
                directory,
                folded: { through: sequence, version: before.folded.version },
              })
            );

            return true;
          }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 3))
      );

      // The budget was enough for the step to be applied, or the law checked nothing of it.
      yield* same("the step was applied at the last", applied.at(-1), true);
    });

// A step that carries items, Timelines described anew, and a directory of its own.
const additions: Interruption = {
  edit: (before, sequence) => {
    const fresh: Summary = {
      changed: sequence,
      id: timelineIdOf(sequence, 0, 1),
      key: `#new-${sequence}`,
      kind: "Channel",
      latest: undefined,
      name: `#new-${sequence}`,
      network: libera,
      read: undefined,
      unread: noneUnread,
    };

    return {
      ...before,
      items: [
        ...before.items,
        ...Array.from({ length: 5 }, (_, n) => ({
          changed: sequence,
          content: said(`${sequence}.${n}`),
          level: "Message" as const,
          network: libera,
          position: position(n, sequence, n),
          timeline: channel,
        })),
      ],
      timelines: [
        ...before.timelines.map((each) =>
          each.id === channel ? { ...each, changed: sequence, name: `#a-${sequence}` } : each
        ),
        fresh,
      ],
    };
  },
  seed: () => [],
  step: (sequence) => [
    described(sequence, channel, "Channel", `#a-${sequence}`, "#a"),
    described(
      sequence,
      timelineIdOf(sequence, 0, 1),
      "Channel",
      `#new-${sequence}`,
      `#new-${sequence}`
    ),
    ...Array.from({ length: 5 }, (_, n) =>
      added(sequence, channel, position(n, sequence, n), said(`${sequence}.${n}`))
    ),
  ],
};

const redelivered = (
  before: Model,
  sequence: number,
  intent: string,
  delivery: Delivery
): Model => {
  const touched = new Set<TimelineId>();

  const items = before.items.map((item) => {
    if (item.content._tag !== "Message") {
      return item;
    }

    const { ours } = item.content;

    if (ours === undefined || ours.intent !== intent || ours.delivery._tag === "Confirmed") {
      return item;
    }

    touched.add(item.timeline);

    return {
      ...item,
      changed: sequence,
      content: { ...item.content, ours: { ...ours, delivery } },
    };
  });

  return {
    ...before,
    items,
    timelines: before.timelines.map((each) =>
      touched.has(each.id) ? { ...each, changed: sequence } : each
    ),
  };
};

// A step that confirms one intent of ours and marks another Unsent, each with an item in two
// Timelines, so each is more than one write, and a third is left alone.
const deliveries: Interruption = {
  edit: (before, sequence) =>
    redelivered(
      redelivered(before, sequence, `intent-c${sequence - 1}`, {
        _tag: "Confirmed",
        at: known(at(7)),
        id: known(MessageId.make(`m${sequence}`)),
        text: `c${sequence - 1}!`,
      }),
      sequence,
      `intent-u${sequence - 1}`,
      { _tag: "Unsent" }
    ),
  seed: (sequence) =>
    [network, channel].flatMap((timeline) =>
      ["c", "u", "k"].map((label, n) =>
        added(
          sequence,
          timeline,
          position(sequence, sequence, n),
          said(`${label}${sequence}`, "Pending")
        )
      )
    ),
  step: (sequence) => [
    {
      _tag: "Confirmed",
      at: known(at(7)),
      id: known(MessageId.make(`m${sequence}`)),
      intent: IntentId.make(`intent-c${sequence - 1}`),
      messageId: MessageId.make(`m${sequence}`),
      network: libera,
      sequence,
      text: `c${sequence - 1}!`,
    },
    { _tag: "Unsent", intent: IntentId.make(`intent-u${sequence - 1}`), network: libera, sequence },
  ],
};

// A step that closes a Gap that was open and opens the next.
const gaps: Interruption = {
  edit: (before, sequence) => ({
    ...before,
    gaps: [
      ...before.gaps.map((each) =>
        comparePositions(each.from, position(sequence - 1, sequence - 1)) === 0
          ? { ...each, changed: sequence, to: position(sequence + 5, sequence) }
          : each
      ),
      { changed: sequence, from: position(sequence, sequence), network: libera, to: undefined },
    ],
  }),
  seed: (sequence) => [gap(sequence, position(sequence, sequence), undefined)],
  step: (sequence) => [
    gap(sequence, position(sequence - 1, sequence - 1), position(sequence + 5, sequence)),
    gap(sequence, position(sequence, sequence), undefined),
  ],
};

// A step that merges one Timeline into another, with items in both: one that moves, one
// that moves with an id, one whose id the other has, and one that stands where one of the
// other's does, which are dropped. Half of it is items moved with no tombstone, or the
// tombstone with no items.
const merging: Interruption = {
  edit: (before, sequence) => {
    const from = timelineIdOf(sequence - 1, 0, 1);
    const into = timelineIdOf(sequence - 1, 0, 2);
    const moved = new Set([`moved${sequence - 1}`, `moved-too${sequence - 1}`]);

    return {
      ...before,
      items: [
        ...before.items.filter(({ timeline }) => timeline !== from),
        ...before.items.flatMap((item) =>
          item.timeline === from && moved.has(textOf(item))
            ? [{ ...item, changed: sequence, timeline: into }]
            : []
        ),
      ],
      merged: [...before.merged, { changed: sequence, id: from, into, network: libera }],
      timelines: before.timelines.flatMap((each) => {
        if (each.id === from) {
          return [];
        }

        return [each.id === into ? { ...each, changed: sequence } : each];
      }),
    };
  },
  seed: (sequence) => {
    const from = timelineIdOf(sequence, 0, 1);
    const into = timelineIdOf(sequence, 0, 2);

    return [
      described(sequence, from, "Channel", `#from-${sequence}`, `#from-${sequence}`),
      described(sequence, into, "Channel", `#into-${sequence}`, `#into-${sequence}`),
      added(sequence, into, position(1, sequence, 0), said(`kept${sequence}`), `k${sequence}`),
      added(sequence, into, position(5, sequence, 1), said(`standing${sequence}`)),
      added(sequence, from, position(2, sequence, 2), said(`moved${sequence}`)),
      added(sequence, from, position(3, sequence, 3), said(`same-id${sequence}`), `k${sequence}`),
      added(sequence, from, position(5, sequence, 1), said(`same-place${sequence}`)),
      added(sequence, from, position(6, sequence, 4), said(`moved-too${sequence}`), `v${sequence}`),
    ];
  },
  step: (sequence) => [
    {
      _tag: "Merged",
      from: timelineIdOf(sequence - 1, 0, 1),
      into: timelineIdOf(sequence - 1, 0, 2),
      network: libera,
      sequence,
    },
  ],
};

const marker = (sequence: number, timeline: TimelineId, read: Instant, on = libera): Change => ({
  _tag: "ReadMarker",
  network: on,
  read,
  sequence,
  timeline,
});

// A step that moves two Read Markers, one past items of every level, and one that moves
// the first time and is moved back after, which changes nothing, and adds an item after
// the first, so a recount half done is seen.
const marking: Interruption = {
  edit: (before, sequence) => ({
    ...before,
    items: [
      ...before.items,
      {
        changed: sequence,
        content: said(`late${sequence}`),
        level: "Highlight",
        network: libera,
        position: position(sequence * 10 + 9, sequence),
        timeline: channel,
      },
    ],
    timelines: before.timelines.map((each) => {
      if (each.id === channel) {
        return { ...each, changed: sequence, read: at(sequence * 10 + 4) };
      }

      // The Network's moves the first time, and never back after.
      return each.id === network && each.read === undefined
        ? { ...each, changed: sequence, read: at(-1) }
        : each;
    }),
  }),
  seed: (sequence) =>
    levels.flatMap((level, n) => [
      added(
        sequence,
        channel,
        position(sequence * 10 + n, sequence, n),
        said(`${level}${sequence}`),
        undefined,
        libera,
        level
      ),
      added(
        sequence,
        channel,
        position(sequence * 10 + 5 + n, sequence, n + 4),
        said(`${level}+${sequence}`),
        undefined,
        libera,
        level
      ),
    ]),
  step: (sequence) => [
    marker(sequence, channel, at(sequence * 10 + 4)),
    marker(sequence, network, at(-1)),
    marker(sequence, network, at(-2)),
    added(
      sequence,
      channel,
      position(sequence * 10 + 9, sequence),
      said(`late${sequence}`),
      undefined,
      libera,
      "Highlight"
    ),
  ],
};

// Park and Miller's generator, exact in a double, so a law that walks random steps walks
// the same ones on every adapter and every run.
const modulus = 2_147_483_647;

const random = (seed: number) => {
  let state = (seed % (modulus - 1)) + 1;

  return (below: number) => {
    state = (state * 48_271) % modulus;

    return Math.floor((state / modulus) * below);
  };
};

/**
 * Random steps over a Network's Timelines: items of every level, at any time, some sharing
 * a message id or a position with one already there, Read Markers moved either way, Messages
 * of ours confirmed or marked Unsent, and merges, each as the fold would send them: nothing
 * is told of a Timeline once it has been merged.
 * @param seed - Which steps.
 * @returns Each step's changes, from sequence 2.
 */
const randomSteps = (seed: number): readonly (readonly Change[])[] => {
  const pick = random(seed);
  const open = [network, channel, other, third];
  const steps: Change[][] = [];

  for (let sequence = 2; sequence < 26; sequence += 1) {
    const changes: Change[] = [];

    const count = 1 + pick(4);

    for (let n = 0; n < count; n += 1) {
      const timeline = open[pick(open.length)] ?? channel;
      const roll = pick(10);

      if (roll < 6) {
        const level = [...levels, undefined][pick(levels.length + 1)];
        const ours = level === undefined && pick(2) === 0;
        const messageId = pick(3) === 0 ? `m${pick(4)}` : undefined;

        // The level is set as chosen: with none and not ours, a Message Self said elsewhere.
        changes.push({
          ...added(
            sequence,
            timeline,
            position(pick(40), sequence, pick(3)),
            said(`r${sequence}.${n}`, ours ? "Pending" : undefined),
            messageId
          ),
          level,
        });
      } else if (roll < 8) {
        changes.push(marker(sequence, timeline, at(pick(40))));
      } else if (roll < 9) {
        changes.push(
          pick(2) === 0
            ? {
                _tag: "Unsent",
                intent: IntentId.make(`intent-r${pick(sequence)}.0`),
                network: libera,
                sequence,
              }
            : {
                _tag: "Confirmed",
                at: known(at(1)),
                id: known(MessageId.make(`m${pick(4)}`)),
                intent: IntentId.make(`intent-r${pick(sequence)}.0`),
                messageId: MessageId.make(`m${pick(4)}`),
                network: libera,
                sequence,
                text: "confirmed",
              }
        );
      } else {
        const from = open.findLast((each) => each !== channel && each !== network);

        if (from !== undefined) {
          open.splice(open.indexOf(from), 1);
          changes.push({ _tag: "Merged", from, into: channel, network: libera, sequence });
        }
      }
    }

    steps.push(changes);
  }

  return steps;
};

// Something a participant said, as `said` says it, from a sender of its own.
const spoken = (text: string, sender: string): Content => {
  const content = said(text);

  return content._tag === "Message" ? { ...content, sender } : content;
};

type Searching = Omit<Search, "text" | "limit"> & {
  readonly text: string;
  readonly limit?: number | undefined;
};

// The texts of what a search finds, in the order found, 100 at most unless it says.
const searchFor = (store: TimelineStoreService, search: Searching) =>
  store
    .search({ ...search, limit: search.limit ?? 100, text: SearchText.make(search.text) })
    .pipe(Effect.map((found) => found.map(textOf)));

// Every page of a search, each given after where the one before ended.
const pagesOf = (store: TimelineStoreService, search: Searching, limit: number) =>
  Effect.gen(function* () {
    const pages: (readonly Item[])[] = [];
    let after: Search["after"];

    for (;;) {
      const page = yield* store.search({
        ...search,
        after,
        limit,
        text: SearchText.make(search.text),
      });

      pages.push(page);

      const last = page.at(-1);

      if (page.length < limit || last === undefined) {
        return pages;
      }

      after = { position: last.position, timeline: last.timeline };
    }
  });

const searchLaws: readonly Law<TimelineStoreService, TimelineStoreFailed>[] = [
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* apply(store, 2, [
          ...opened(2),
          added(2, channel, position(10, 2, 0), said("Hello IIRC world")),
          added(2, other, position(20, 2, 1), said("iirc rocks")),
          added(2, channel, position(5, 2, 2), said("Über alles")),
          added(2, channel, position(6, 2, 3), said("caf\u00E9 au lait")),
          // The same letter written with a combining accent.
          added(2, channel, position(7, 2, 4), said("cafe\u0301 noir")),
          added(2, network, position(8, 2, 5), { _tag: "SessionBegan", at: at(8), nick: "iirc" }),
          added(2, channel, position(9, 2, 6), spoken("someone", "iirc")),
        ]);

        yield* same("by its text, newest first", yield* searchFor(store, { text: "iirc" }), [
          "iirc rocks",
          "Hello IIRC world",
        ]);
        yield* same("in any case", yield* searchFor(store, { text: "IiRc" }), [
          "iirc rocks",
          "Hello IIRC world",
        ]);
        yield* same("beyond ASCII", yield* searchFor(store, { text: "über" }), ["Über alles"]);
        // Nothing is composed, so a letter written whole and one written with a combining
        // accent are different text.
        yield* same("composed", yield* searchFor(store, { text: "CAF\u00C9" }), [
          "caf\u00E9 au lait",
        ]);
        yield* same("decomposed", yield* searchFor(store, { text: "CAFE\u0301" }), [
          "cafe\u0301 noir",
        ]);
        yield* same("diacritics kept", yield* searchFor(store, { text: "cafe " }), []);
        yield* same("anywhere in it", yield* searchFor(store, { text: "c w" }), [
          "Hello IIRC world",
        ]);
        yield* same("up to the limit", yield* searchFor(store, { limit: 1, text: "iirc" }), [
          "iirc rocks",
        ]);
        yield* same("nothing", yield* searchFor(store, { text: "nowhere" }), []);
      }),
    name: "finds the Messages whose text holds the search's, lower-cased, newest first",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* apply(store, 2, [
          ...opened(2),
          described(2, oftcNetwork, "Network", oftc, null, oftc),
          added(2, channel, position(1, 2, 0), spoken("deploy one", "Alice")),
          added(2, other, position(2, 2, 1), spoken("deploy two", "bob")),
          added(2, channel, position(3, 2, 2), spoken("deploy three", "alice")),
          added(2, oftcNetwork, position(4, 2, 3), spoken("deploy four", "ALICE"), undefined, oftc),
        ]);

        const text = "deploy";

        yield* same("all", yield* searchFor(store, { text }), [
          "deploy four",
          "deploy three",
          "deploy two",
          "deploy one",
        ]);
        yield* same("a Network's", yield* searchFor(store, { network: libera, text }), [
          "deploy three",
          "deploy two",
          "deploy one",
        ]);
        yield* same("a Timeline's", yield* searchFor(store, { text, timeline: channel }), [
          "deploy three",
          "deploy one",
        ]);
        yield* same("a sender's, folded", yield* searchFor(store, { from: "aLiCe", text }), [
          "deploy four",
          "deploy three",
          "deploy one",
        ]);
        yield* same("a sender's, whole", yield* searchFor(store, { from: "ali", text }), []);
        yield* same("since, at it included", yield* searchFor(store, { since: at(2), text }), [
          "deploy four",
          "deploy three",
          "deploy two",
        ]);
        yield* same("until, at it left out", yield* searchFor(store, { text, until: at(3) }), [
          "deploy two",
          "deploy one",
        ]);
        yield* same(
          "every filter at once",
          yield* searchFor(store, {
            from: "alice",
            network: libera,
            since: at(1),
            text,
            timeline: channel,
            until: at(4),
          }),
          ["deploy three", "deploy one"]
        );
        yield* same(
          "a Timeline of another Network",
          yield* searchFor(store, { network: oftc, text, timeline: channel }),
          []
        );
      }),
    name: "filters by Network, Timeline, sender, and time",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        // One Message in two Timelines at one position, late history among the rest, and
        // Messages in two Networks.
        yield* apply(store, 2, [
          ...opened(2),
          described(2, oftcNetwork, "Network", oftc, null, oftc),
          ...Array.from({ length: 7 }, (_, n) =>
            added(2, n % 2 === 0 ? channel : other, position(n * 10, 2, n), said(`page ${n}`))
          ),
          added(2, channel, position(35, 2, 9), said("page both")),
          added(2, other, position(35, 2, 9), said("page both")),
          added(2, oftcNetwork, position(36, 2, 10), said("page oftc"), undefined, oftc),
        ]);
        yield* apply(store, 3, [added(3, channel, position(15, 3), said("page late"))]);

        const whole = yield* store.search({ limit: 100, text: SearchText.make("page") });

        yield* same(
          "newest first, by position and then Timeline id, each later first",
          whole.map((item) => [item.timeline, textOf(item)]),
          [
            [channel, "page 6"],
            [other, "page 5"],
            [channel, "page 4"],
            [oftcNetwork, "page oftc"],
            [other, "page both"],
            [channel, "page both"],
            [other, "page 3"],
            [channel, "page 2"],
            [channel, "page late"],
            [other, "page 1"],
            [channel, "page 0"],
          ]
        );

        for (const limit of [1, 2, 3, 4]) {
          const pages = yield* pagesOf(store, { text: "page" }, limit);

          yield* same(`pages of ${limit}, fitted together`, pages.flat(), whole);
          yield* same(
            `pages of ${limit}, each within it`,
            pages.every((page) => page.length <= limit),
            true
          );
        }

        const filtered = yield* store.search({
          limit: 100,
          network: libera,
          text: SearchText.make("page"),
          timeline: channel,
        });

        yield* same(
          "pages of a filtered search",
          (yield* pagesOf(store, { network: libera, text: "page", timeline: channel }, 2)).flat(),
          filtered
        );
      }),
    name: "pages a search newest first, with nothing lost or given twice",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        // `other` is merged into `channel`, whose id is lower, so an item that moves stands
        // after where a page that ended on it in `other` ended, and is given again.
        yield* apply(store, 2, [
          ...opened(2),
          added(2, channel, position(1, 2, 0), said("hop a1")),
          added(2, other, position(2, 2, 1), said("hop b2")),
          added(2, other, position(3, 2, 2), said("hop b3")),
        ]);

        const text = SearchText.make("hop");
        const [first] = yield* store.search({ limit: 1, text });

        yield* same("the first page", first === undefined ? undefined : textOf(first), "hop b3");

        const after = { position: position(3, 2, 2), timeline: other };
        yield* same(
          "the next page, with no merge between",
          (yield* store.search({ after, limit: 1, text })).map(textOf),
          ["hop b2"]
        );

        yield* apply(store, 3, [
          { _tag: "Merged", from: other, into: channel, network: libera, sequence: 3 },
        ]);

        yield* same(
          "the next page, after a merge between, repeats what moved",
          (yield* store.search({ after, limit: 1, text })).map(textOf),
          ["hop b3"]
        );
      }),
    name: "repeats nothing across pages, unless a merge moved what a page ended on",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* apply(store, 2, [
          ...opened(2),
          described(2, third, "Channel", "#c", "#c"),
          added(2, channel, position(1, 2, 0), said("merge kept"), "m1"),
          added(2, other, position(2, 2, 1), said("merge moved")),
          // Its id is the kept Timeline's too, so it is dropped as it moves.
          added(2, other, position(3, 2, 2), said("merge twice"), "m1"),
          added(2, third, position(4, 2, 3), said("merge detached")),
        ]);
        yield* apply(store, 3, [
          described(3, third, "Channel", "#c", null),
          { _tag: "Merged", from: other, into: channel, network: libera, sequence: 3 },
        ]);

        const found = yield* store.search({ limit: 100, text: SearchText.make("merge") });

        yield* same(
          "moved, the duplicate dropped, and the detached one kept",
          found.map((item) => [item.timeline, textOf(item)]),
          [
            [third, "merge detached"],
            [channel, "merge moved"],
            [channel, "merge kept"],
          ]
        );
        yield* same(
          "a merged id searches the Timeline it went to",
          yield* searchFor(store, { text: "merge", timeline: other }),
          ["merge moved", "merge kept"]
        );
        yield* same(
          "a detached Timeline",
          yield* searchFor(store, { text: "merge", timeline: third }),
          ["merge detached"]
        );
        yield* same(
          "an id never given",
          yield* searchFor(store, { text: "merge", timeline: timelineIdOf(99, 0, 1) }),
          []
        );
      }),
    name: "searches a merged Timeline through its tombstone, and a detached one",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* apply(store, 2, [
          ...opened(2),
          added(2, channel, position(1, 2, 0), said("helo wrld", "Pending")),
          added(2, channel, position(2, 2, 1), said("lost words", "Unconfirmed")),
        ]);
        yield* apply(store, 3, [
          {
            _tag: "Confirmed",
            at: known(at(4)),
            id: known(MessageId.make("m1")),
            intent: IntentId.make("intent-helo wrld"),
            messageId: MessageId.make("m1"),
            network: libera,
            sequence: 3,
            text: "hello world",
          },
          {
            _tag: "Unsent",
            intent: IntentId.make("intent-lost words"),
            network: libera,
            sequence: 3,
          },
        ]);

        yield* same("by the text confirmed", yield* searchFor(store, { text: "hello" }), [
          "helo wrld",
        ]);
        yield* same("not by ours", yield* searchFor(store, { text: "helo" }), []);
        yield* same("unsent, by ours", yield* searchFor(store, { text: "lost" }), ["lost words"]);
        yield* same("by its sender", yield* searchFor(store, { from: "PEER", text: "wor" }), [
          "lost words",
          "helo wrld",
        ]);
      }),
    name: "finds our Message by the text the Ircd confirmed, once it did",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        // Text that would be an operator, a column filter, or a quote in a query.
        const hostile = [
          'say "hi" now',
          "a*b star",
          "NEAR(x y) here",
          "this OR that",
          "^caret first",
          "text: colon",
          "{text}: braces",
          "it's -minus +plus (paren)",
          "back\\slash",
          "AND NOT done",
        ];

        yield* apply(store, 2, [
          ...opened(2),
          ...hostile.map((text, n) => added(2, channel, position(n, 2, n), said(text))),
        ]);

        const queries: readonly (readonly [string, readonly string[]])[] = [
          ['"hi"', ['say "hi" now']],
          ['"', []],
          ['" OR "', []],
          ["a*b", ["a*b star"]],
          ["***", []],
          ["NEAR(x", ["NEAR(x y) here"]],
          ["near(", ["NEAR(x y) here"]],
          ["S OR T", ["this OR that"]],
          ["^ca", ["^caret first"]],
          ["text:", ["text: colon"]],
          ["{text}:", ["{text}: braces"]],
          ["-minus +plus", ["it's -minus +plus (paren)"]],
          ["(paren)", ["it's -minus +plus (paren)"]],
          ["\\sl", ["back\\slash"]],
          ["AND NOT", ["AND NOT done"]],
          ["NOT", ["AND NOT done"]],
        ];

        for (const [text, expected] of queries) {
          // A search shorter than the least is no search, so it is padded to be one.
          const padded = isSearchText(text) ? text : `${text}${text}${text}`;

          yield* same(`searching ${padded}`, yield* searchFor(store, { text: padded }), expected);
        }
      }),
    name: "takes a search's text as text, never as a query's syntax",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        const steps = [...opened(2), added(2, channel, position(1, 2), said("forgotten"))];

        yield* apply(store, 2, steps);
        yield* store.reset(5);
        yield* same("after a reset", yield* searchFor(store, { text: "forgot" }), []);
        yield* apply(store, 2, steps);
        yield* same("folded again", yield* searchFor(store, { text: "forgot" }), ["forgotten"]);
      }),
    name: "forgets what it found on reset, and finds it once when folded again",
  },
];

/** The laws every Timeline store adapter keeps, starting from a fresh, empty store. */
export const timelineStoreLaws: readonly Law<TimelineStoreService, TimelineStoreFailed>[] = [
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* same("folded", yield* store.folded, { through: undefined, version: undefined });
        yield* same("directory", yield* store.directory, emptyDirectory);
        yield* same("timelines", yield* store.timelines(libera), []);
        yield* same("window", yield* texts(store, channel, all), "none");
        yield* same("read together", yield* store.consistent(store.timelines(libera)), {
          through: undefined,
          value: [],
          version: undefined,
        });
        yield* same("changed", yield* store.changedAfter(undefined), {
          gaps: [],
          items: [],
          merged: [],
          more: false,
          overflowed: undefined,
          through: undefined,
          timelines: [],
        });
      }),
    name: "starts empty, built by no projection version",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        const stepped = step(emptyDirectory, {
          at: at(0),
          network: libera,
          news: [{ _tag: "SessionBegan", at: at(0), nick: "iirc" }],
          sequence: 5,
        });

        yield* store.reset(3);
        yield* store.apply({ changes: stepped.changes, directory: stepped.directory, through: 5 });
        yield* same("folded", yield* store.folded, { through: 5, version: 3 });
        yield* same("directory", yield* store.directory, stepped.directory);
        yield* store.reset(4);
        yield* same("reset", yield* store.folded, { through: undefined, version: 4 });
        yield* same("emptied", yield* store.timelines(libera), []);
        yield* same("directory emptied", yield* store.directory, emptyDirectory);
      }),
    name: "records the last step folded, its directory, and the version it was reset to",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        const atTwo = directoryAfter(emptyDirectory, libera, 2);
        const atThree = directoryAfter(atTwo, libera, 3);
        const atFour = directoryAfter(atThree, libera, 4);

        // Items under message ids and at positions, one of ours confirmed under the Ircd's
        // id, Gaps open and closed on two Networks, and a merge with its tombstone.
        const history: readonly {
          readonly changes: readonly Change[];
          readonly directory: Directory;
          readonly through: number;
        }[] = [
          {
            changes: [
              ...opened(2),
              described(2, third, "Channel", "#c", "#c"),
              described(2, oftcNetwork, "Network", oftc, null, oftc),
              added(2, channel, position(0, 2), said("one"), "m1"),
              added(2, other, position(1, 2, 1), said("two"), "m2"),
              added(2, third, position(2, 2, 2), said("three"), "m3"),
              added(2, channel, position(3, 2, 3), said("hi", "Pending")),
              gap(2, position(9, 2), undefined),
              gap(2, position(20, 2), undefined, oftc),
            ],
            directory: atTwo,
            through: 2,
          },
          {
            changes: [
              {
                _tag: "Confirmed",
                at: known(at(4)),
                id: known(MessageId.make("m9")),
                intent: IntentId.make("intent-hi"),
                messageId: MessageId.make("m9"),
                network: libera,
                sequence: 3,
                text: "hi!",
              },
              { _tag: "Merged", from: third, into: other, network: libera, sequence: 3 },
              gap(3, position(9, 2), position(12, 3)),
            ],
            directory: atThree,
            through: 3,
          },
          {
            changes: [added(4, channel, position(5, 4), said("again"), "m9")],
            directory: atFour,
            through: 4,
          },
        ];

        const fold = () => inOrder(history, (applied) => store.apply(applied));

        yield* store.reset(3);
        yield* fold();

        const seeded = yield* snapshot(store);

        yield* differs("items", seeded.items, []);
        yield* differs("tombstones", seeded.merged, []);
        yield* differs("Gaps", seeded.gaps, []);
        yield* differs("the directory", seeded.directory, emptyDirectory);

        yield* store.reset(4);

        // Nothing of the history is left, whatever a read asks.
        yield* same("folded", yield* store.folded, { through: undefined, version: 4 });
        yield* same("directory", yield* store.directory, emptyDirectory);
        yield* same("changed", yield* store.changedAfter(undefined), {
          gaps: [],
          items: [],
          merged: [],
          more: false,
          overflowed: undefined,
          through: undefined,
          timelines: [],
        });
        yield* same("changed after 0", (yield* store.changedAfter(0)).timelines, []);
        yield* same("timelines", yield* store.timelines(libera), []);
        yield* same("another Network's timelines", yield* store.timelines(oftc), []);
        yield* inOrder([network, channel, other, third, oftcNetwork], (id) =>
          Effect.flatMap(texts(store, id, all), (actual) => same(`window of ${id}`, actual, "none"))
        );
        yield* inOrder([2, 3, 4], (sequence) =>
          Effect.flatMap(store.locate(libera, sequence), (found) =>
            same(`located at ${sequence}`, found, [])
          )
        );
        yield* same("Gaps", yield* store.gaps(libera, {}), []);
        yield* same("another Network's Gaps", yield* store.gaps(oftc, {}), []);

        // The same steps, at the same positions and under the same message ids, are all
        // accepted again, so nothing was kept to refuse them by.
        yield* fold();
        yield* same("folded again", yield* snapshot(store), {
          ...seeded,
          folded: { through: 4, version: 4 },
        });
      }),
    name: "leaves no history behind on reset, so the same steps are accepted again",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* apply(store, 5, [...opened(5), added(5, channel, position(0, 5), said("one"))]);
        yield* apply(store, 5, [added(5, channel, position(1, 5), said("again"))]);
        yield* apply(store, 4, [added(4, channel, position(2, 4), said("earlier"))]);
        yield* same("items", yield* texts(store, channel, all), "| one |");
        yield* same("folded", (yield* store.folded).through, 5);
      }),
    name: "changes nothing for a step at or before the last one folded",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        const seeded = directoryAfter(emptyDirectory, libera, 3);
        const first = directoryAfter(seeded, libera, 5);
        const awaiting = IntentId.make("intent-awaiting");
        const refused = IntentId.make("intent-refused");

        yield* store.reset(3);
        // Two of our Messages, one awaiting its echo and one that will be refused.
        yield* store.apply({
          changes: [
            ...opened(3),
            added(3, channel, position(1, 3), said("awaiting", "Pending")),
            added(3, channel, position(2, 3, 1), said("refused", "Unconfirmed")),
          ],
          directory: seeded,
          through: 3,
        });
        yield* store.apply({
          changes: [
            added(5, channel, position(0, 5), said("one"), "m1"),
            gap(5, position(9, 5), undefined),
          ],
          directory: first,
          through: 5,
        });

        const before = yield* snapshot(store);

        // Steps at the last one folded and before it, each with changes of every kind,
        // delivery updates for our Messages included, and a directory of its own, are all
        // dropped whole, the directory too.
        yield* inOrder([5, 4, 1], (through) =>
          Effect.gen(function* () {
            const directory = directoryAfter(first, oftc, through + 10);

            yield* differs("the obsolete step's directory", directory, before.directory);
            yield* store.apply({
              changes: [
                described(through, channel, "Channel", "#renamed", null),
                described(through, third, "Channel", "#c", "#c"),
                added(through, channel, position(1, through), said("two"), "m2"),
                {
                  _tag: "Confirmed",
                  at: known(at(7)),
                  id: known(MessageId.make("m7")),
                  intent: awaiting,
                  messageId: MessageId.make("m7"),
                  network: libera,
                  sequence: through,
                  text: "awaiting!",
                },
                { _tag: "Unsent", intent: refused, network: libera, sequence: through },
                gap(through, position(9, 5), position(10, through)),
                { _tag: "Merged", from: other, into: channel, network: libera, sequence: through },
              ],
              directory,
              through,
            });
            yield* same(`after applying through ${through}`, yield* snapshot(store), before);
          })
        );

        // The step was obsolete, and our Messages are as they were: still awaiting.
        yield* same("delivery", (yield* store.locate(libera, 3)).map(deliveryOf), [
          { _tag: "Pending" },
          { _tag: "Unconfirmed" },
        ]);
      }),
    name: "drops a step at or before the last one folded whole, its directory too",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* apply(store, 2, [
          ...opened(2),
          added(2, channel, position(0, 2), said("first"), "m1"),
          added(2, channel, position(5, 2, 1), said("unknown-a")),
        ]);
        yield* apply(store, 3, [
          added(3, channel, position(1, 3), said("second"), "m1"),
          added(3, other, position(1, 3), said("elsewhere"), "m1"),
          added(3, channel, position(5, 3), said("unknown-b")),
          added(3, channel, position(5, 2, 1), said("same-place")),
        ]);
        yield* same("kept", yield* texts(store, channel, all), "| first unknown-a unknown-b |");
        yield* same("other Timeline", yield* texts(store, other, all), "| elsewhere |");
      }),
    name: "keeps one item per message id and position in a Timeline, the first",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* apply(store, 2, [...opened(2), added(2, channel, position(10, 2), said("ten"))]);
        yield* apply(store, 3, [added(3, channel, position(30, 3), said("thirty"))]);
        // History arrives late, and stands where its time puts it.
        yield* apply(store, 4, [
          added(4, channel, position(20, 4), said("twenty")),
          added(4, channel, position(10, 4, 1), said("ten-later")),
          added(4, channel, position(-5, 4, 2), said("before-all")),
        ]);
        yield* same(
          "order",
          yield* texts(store, channel, all),
          "| before-all ten ten-later twenty thirty |"
        );

        const [, summary] = yield* store.timelines(libera);

        yield* same("latest", summary?.latest, position(30, 3));
        yield* same("changed", summary?.changed, 4);
      }),
    name: "orders items by position, wherever and whenever they arrive",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* apply(store, 2, [
          ...opened(2),
          described(2, oftcNetwork, "Network", oftc, null, oftc),
          added(2, channel, position(0, 2), said("hi", "Pending")),
          added(2, network, position(0, 2), said("hi", "Pending")),
          added(2, oftcNetwork, position(0, 2), said("hi", "Pending"), undefined, oftc),
        ]);
        yield* apply(store, 3, [
          {
            _tag: "Confirmed",
            at: known(at(4)),
            id: known(MessageId.make("m9")),
            intent: IntentId.make("intent-hi"),
            messageId: MessageId.make("m9"),
            network: libera,
            sequence: 3,
            text: "hi!",
          },
        ]);
        // The echo's id is now the item's, so the same Message from history is dropped.
        yield* apply(store, 4, [added(4, channel, position(1, 4), said("hi-again"), "m9")]);

        const confirmed: Delivery = {
          _tag: "Confirmed",
          at: known(at(4)),
          id: known(MessageId.make("m9")),
          text: "hi!",
        };

        const window = yield* store.window(channel, all, 10);
        const items = Option.getOrUndefined(window)?.items ?? [];
        const oftcItems = yield* store.locate(oftc, 2);

        yield* same("items", items.map(textOf), ["hi"]);
        yield* same("delivery", items.map(deliveryOf), [confirmed]);
        yield* same("unmoved", items[0]?.position, position(0, 2));
        yield* same("changed", items[0]?.changed, 3);
        yield* same(
          "in the Network's Timeline too",
          (yield* store.locate(libera, 2)).map(deliveryOf),
          [confirmed, confirmed]
        );
        yield* same("another Network's", oftcItems.map(deliveryOf), [{ _tag: "Pending" }]);
      }),
    name: "confirms our Message in place, and keeps it under the Ircd's id",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* apply(store, 2, [
          ...opened(2),
          added(2, channel, position(0, 2), said("lost", "Unconfirmed")),
          added(2, channel, position(1, 2, 1), said("echoed", "Pending")),
        ]);
        yield* apply(store, 3, [
          {
            _tag: "Confirmed",
            at: known(at(4)),
            id: { _tag: "Unknown" },
            intent: IntentId.make("intent-echoed"),
            messageId: undefined,
            network: libera,
            sequence: 3,
            text: "echoed",
          },
        ]);
        yield* apply(store, 4, [
          { _tag: "Unsent", intent: IntentId.make("intent-lost"), network: libera, sequence: 4 },
          { _tag: "Unsent", intent: IntentId.make("intent-echoed"), network: libera, sequence: 4 },
        ]);

        const items = yield* store.locate(libera, 2);

        yield* same(
          "deliveries",
          items.map((item) => [textOf(item), deliveryOf(item)?._tag, item.changed]),
          [
            ["lost", "Unsent", 4],
            ["echoed", "Confirmed", 3],
          ]
        );
      }),
    name: "marks our Message Unsent in place, unless it was confirmed",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        const intent = IntentId.make("intent-topic");

        const refused: Content = {
          _tag: "ActionRefused",
          at: at(3),
          attempted: { _tag: "Kick", channel: "#a", nicks: ["peer", "other"] },
          intent,
          reason: { _tag: "Rejected", reply: "482" },
        };

        yield* apply(store, 2, [...opened(2), added(2, channel, position(3, 2), refused)]);
        yield* apply(store, 3, [
          { _tag: "Unsent", intent, network: libera, sequence: 3 },
          { _tag: "Rejected", intent, network: libera, reply: "401", sequence: 3 },
        ]);

        const items = yield* store.locate(libera, 2);
        const summary = (yield* store.timelines(libera)).find(({ id }) => id === channel);

        yield* same(
          "the item",
          items.map((item) => [item.content, item.level, item.changed]),
          [[refused, undefined, 2]]
        );
        yield* same("its Timeline's counts", summary?.unread, noneUnread);
      }),
    name: "keeps a refused action as told, with no level, never unread, and no delivery to change",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* apply(store, 2, [
          ...opened(2),
          added(2, channel, position(0, 2), said("refused", "Pending")),
          added(2, channel, position(1, 2, 1), said("echoed", "Pending")),
        ]);
        yield* apply(store, 3, [
          {
            _tag: "Confirmed",
            at: known(at(4)),
            id: { _tag: "Unknown" },
            intent: IntentId.make("intent-echoed"),
            messageId: undefined,
            network: libera,
            sequence: 3,
            text: "echoed",
          },
        ]);
        yield* apply(store, 4, [
          {
            _tag: "Rejected",
            intent: IntentId.make("intent-refused"),
            network: libera,
            reply: "404",
            sequence: 4,
          },
          {
            _tag: "Rejected",
            intent: IntentId.make("intent-echoed"),
            network: libera,
            reply: "404",
            sequence: 4,
          },
        ]);
        // The same again changes nothing, so the item keeps the step that last changed it.
        yield* apply(store, 5, [
          {
            _tag: "Rejected",
            intent: IntentId.make("intent-refused"),
            network: libera,
            reply: "404",
            sequence: 5,
          },
        ]);

        const items = yield* store.locate(libera, 2);

        yield* same(
          "deliveries",
          items.map((item) => {
            const delivery = deliveryOf(item);

            return [
              textOf(item),
              delivery?._tag === "Rejected" ? `Rejected ${delivery.reply}` : delivery?._tag,
              item.changed,
            ];
          }),
          [
            ["refused", "Rejected 404", 4],
            ["echoed", "Confirmed", 3],
          ]
        );
      }),
    name: "marks our Message Rejected in place with the Ircd's reply, unless it was confirmed",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* apply(store, 2, [
          ...opened(2),
          described(2, third, "Channel", "#c", "#c"),
          added(2, channel, position(0, 2), said("a-first"), "m1"),
          added(2, channel, position(2, 2, 1), said("a-second")),
          added(2, other, position(1, 2, 2), said("b-duplicate"), "m1"),
          added(2, other, position(2, 2, 1), said("b-same-place")),
          added(2, other, position(3, 2, 3), said("b-moved")),
          added(2, third, position(4, 2, 4), said("c-moved")),
        ]);
        yield* apply(store, 3, [
          { _tag: "Merged", from: third, into: other, network: libera, sequence: 3 },
        ]);
        yield* apply(store, 4, [
          { _tag: "Merged", from: other, into: channel, network: libera, sequence: 4 },
        ]);

        const changed = yield* store.changedAfter(3);

        yield* same(
          "kept",
          yield* texts(store, channel, all),
          "| a-first a-second b-moved c-moved |"
        );
        yield* same(
          "read through a merged id",
          yield* texts(store, third, all),
          yield* texts(store, channel, all)
        );
        yield* same(
          "listed",
          (yield* store.timelines(libera)).map(({ id }) => id),
          [network, channel]
        );
        yield* same(
          "one Timeline read through a merged id",
          yield* store.timeline(third),
          Option.fromUndefinedOr((yield* store.timelines(libera)).find(({ id }) => id === channel))
        );
        yield* same(
          "tombstones name a Timeline that exists",
          changed.merged.map(({ id, into, changed: when }) => [id, into, when]),
          [
            [other, channel, 4],
            [third, channel, 4],
          ]
        );
        yield* same(
          "moved items changed",
          changed.items.map((item) => [textOf(item), item.timeline]),
          [
            ["b-moved", channel],
            ["c-moved", channel],
          ]
        );
      }),
    name: "merges a Timeline's items into the one kept, and leaves a tombstone its id reads through",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        const tieA = timelineIdOf(1, 0, 5);
        const tieB = timelineIdOf(1, 0, 6);
        const tieC = timelineIdOf(1, 0, 7);
        const tieD = timelineIdOf(1, 0, 8);
        const privateUse = "\u{E000}";
        const supplementary = "\u{10000}";

        // Each Timeline with the Network it is on, a label for its items, and the times of
        // its items, in the order they are applied. They are listed, and applied, against
        // the order of their ids, and their items against the order of their positions.
        const made: readonly (readonly [TimelineId, string, string, readonly number[]])[] = [
          [oftcNetwork, oftc, "oc", [2, 1, 0]],
          [tieD, libera, "td", [13]],
          [tieC, libera, "tc", [12]],
          [tieB, libera, "tb", [11]],
          [tieA, libera, "ta", [10]],
          [third, libera, "th", [2, 1, 0]],
          [other, libera, "ot", [2, 1, 0]],
          [channel, libera, "ch", [2, 1, 0]],
          [network, libera, "n", [2, 1, 0]],
        ];

        // Everything below changes in one sequence, so only the order among ties tells.
        yield* apply(store, 2, [
          ...made.map(([id, on, label]) =>
            described(
              2,
              id,
              id === network || id === oftcNetwork ? "Network" : "Channel",
              label,
              id === network || id === oftcNetwork ? null : label,
              on
            )
          ),
          ...made.flatMap(([id, on, label, times]) =>
            times.map((time) =>
              added(2, id, position(time, 2, time), said(`${label}${time}`), undefined, on)
            )
          ),
          // Gaps on Networks ordered by code point, applied against that order: U+E000 comes
          // before U+10000 by code point, and after it as UTF-16 code units, which is how
          // JavaScript compares strings. The store takes any text as a Network's id, so
          // these are the store's to order, though the API admits only `[a-z0-9._-]`.
          gap(2, position(5, 2), undefined, supplementary),
          gap(2, position(40, 2), undefined, privateUse),
          gap(2, position(50, 2), undefined, ""),
          gap(2, position(30, 2), undefined),
          gap(2, position(20, 2), undefined, oftc),
          gap(2, position(10, 2), position(15, 2)),
        ]);
        // Three Timelines merge into two, in an order that is not the order of their ids.
        yield* apply(store, 3, [
          { _tag: "Merged", from: tieC, into: other, network: libera, sequence: 3 },
          { _tag: "Merged", from: tieD, into: channel, network: libera, sequence: 3 },
          { _tag: "Merged", from: tieB, into: other, network: libera, sequence: 3 },
        ]);

        const brief = (after: number | undefined, limit?: number) =>
          store.changedAfter(after, limit).pipe(
            Effect.map((changed) => ({
              gaps: changed.gaps.map(({ network: on, from }) => [on, from.at - t0]),
              items: changed.items.map(textOf),
              merged: changed.merged.map(({ id, into }) => [id, into]),
              timelines: changed.timelines.map(({ id }) => id),
            }))
          );

        // By `changed`, then by id: Timelines and tombstones by id, items by their
        // Timeline's id and then position, and Gaps by Network, by code point, and then where
        // they began.
        yield* same("everything", yield* brief(undefined), {
          gaps: [
            ["", 50],
            [libera, 10],
            [libera, 30],
            [oftc, 20],
            [privateUse, 40],
            [supplementary, 5],
          ],
          items: [
            "n0",
            "n1",
            "n2",
            "ch0",
            "ch1",
            "ch2",
            "ot0",
            "ot1",
            "ot2",
            "th0",
            "th1",
            "th2",
            "oc0",
            "oc1",
            "oc2",
            "ta10",
            // Moved at 3: into `channel`, then into `other`, by position.
            "td13",
            "tb11",
            "tc12",
          ],
          merged: [
            [tieB, other],
            [tieC, other],
            [tieD, channel],
          ],
          timelines: [network, third, oftcNetwork, tieA, channel, other],
        });
        yield* same("after 2", yield* brief(2), {
          gaps: [],
          items: ["td13", "tb11", "tc12"],
          merged: [
            [tieB, other],
            [tieC, other],
            [tieD, channel],
          ],
          timelines: [channel, other],
        });
        // A page holds whole sequences, ordered the same way.
        const everything = yield* store.changedAfter(undefined);

        const atTwo = [
          ...everything.timelines,
          ...everything.items,
          ...everything.merged,
          ...everything.gaps,
        ].filter(({ changed }) => changed === 2).length;

        yield* same("first page", (yield* brief(undefined, atTwo)).timelines, [
          network,
          third,
          oftcNetwork,
          tieA,
        ]);
        yield* same(
          "listed by id",
          (yield* store.timelines(libera)).map(({ id }) => id),
          [network, channel, other, third, tieA]
        );
        yield* same(
          "Gaps by where they began",
          (yield* store.gaps(libera, {})).map(({ from }) => from.at - t0),
          [10, 30]
        );
      }),
    name: "orders what changed in one sequence by id, whatever order it was applied in",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* apply(store, 2, [
          ...opened(2),
          ...Array.from({ length: 10 }, (_, index) =>
            added(2, channel, position(index, 2, index), said(String(index)))
          ),
        ]);

        const p = (index: number) => position(index, 2, index);

        const cases: readonly (readonly [Anchor, number, string])[] = [
          [{ _tag: "Before", position: p(5) }, 3, "< 2 3 4 >"],
          [{ _tag: "Before" }, 3, "< 7 8 9 |"],
          [{ _tag: "Before", position: p(0) }, 3, "|  >"],
          [{ _tag: "After", position: p(5) }, 3, "< 6 7 8 >"],
          [{ _tag: "After" }, 20, "| 0 1 2 3 4 5 6 7 8 9 |"],
          [{ _tag: "After", position: p(9) }, 3, "<  |"],
          [{ _tag: "Around", position: p(5) }, 4, "< 3 4 5 6 >"],
          [{ _tag: "Around", position: p(5) }, 5, "< 3 4 5 6 7 >"],
          [{ _tag: "Around", position: p(0) }, 4, "| 0 1 2 3 >"],
          [{ _tag: "Around", position: p(9) }, 4, "< 6 7 8 9 |"],
          [{ _tag: "Around", position: position(4, 2, 99) }, 2, "< 4 5 >"],
          [{ _tag: "Around", position: p(5) }, 20, "| 0 1 2 3 4 5 6 7 8 9 |"],
        ];

        yield* inOrder(cases, ([anchor, limit, expected]) =>
          Effect.flatMap(texts(store, channel, anchor, limit), (actual) =>
            same(`${anchor._tag} ${show(anchor.position ?? null)} ${limit}`, actual, expected)
          )
        );
        yield* same("unknown", yield* texts(store, timelineIdOf(9, 0, 0), all), "none");
      }),
    name: "reads windows before, after, and around a position, and says what lies beyond",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* apply(store, 2, [
          ...opened(2),
          added(2, other, position(5, 2, 1), said("late")),
          added(2, channel, position(5, 2, 1), said("late")),
          added(2, network, position(0, 2, 0), said("early")),
        ]);
        yield* apply(store, 3, [added(3, channel, position(1, 3), said("next"))]);
        yield* same(
          "located",
          (yield* store.locate(libera, 2)).map((item) => [textOf(item), item.timeline]),
          [
            ["early", network],
            ["late", channel],
            ["late", other],
          ]
        );
        yield* same("another Network", yield* store.locate(oftc, 2), []);

        // A page at a time, in the same order, from just after the last item seen.
        const first = yield* store.locate(libera, 2, { limit: 2 });
        const last = first.at(-1);

        yield* same(
          "first page",
          first.map((item) => [textOf(item), item.timeline]),
          [
            ["early", network],
            ["late", channel],
          ]
        );
        yield* same(
          "next page",
          last === undefined
            ? []
            : (yield* store.locate(libera, 2, {
                after: { position: last.position, timeline: last.timeline },
                limit: 2,
              })).map((item) => [textOf(item), item.timeline]),
          [["late", other]]
        );
      }),
    name: "locates the items a step made, a page at a time",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* apply(store, 2, [...opened(2), gap(2, position(10, 2), position(20, 2))]);
        yield* apply(store, 3, [gap(3, position(30, 3), undefined)]);

        const found = (from?: Position, to?: Position) =>
          store
            .gaps(libera, { from, to })
            .pipe(
              Effect.map((gaps) =>
                gaps.map((each) => [
                  each.from.at - t0,
                  each.to === undefined ? null : each.to.at - t0,
                ])
              )
            );

        yield* same("all", yield* found(), [
          [10, 20],
          [30, null],
        ]);
        yield* same("before both", yield* found(undefined, position(5, 1)), []);
        yield* same("between", yield* found(position(21, 9), position(29, 9)), []);
        yield* same("in the first", yield* found(position(15, 9), position(16, 9)), [[10, 20]]);
        yield* same("in the open one", yield* found(position(99, 9)), [[30, null]]);

        yield* apply(store, 4, [gap(4, position(30, 3), position(40, 4))]);
        yield* same("closed", yield* found(position(35, 9)), [[30, 40]]);
        // Found from the last that began before the range, never from older ones.
        yield* same("ending where it begins", yield* found(position(20, 2)), [
          [10, 20],
          [30, 40],
        ]);
        yield* same("ending just before it", yield* found(position(21, 2)), [[30, 40]]);
        // Gaps may touch: one may begin exactly where the one before it ended.
        yield* apply(store, 5, [gap(5, position(40, 4), position(45, 5))]);
        yield* same("touching, read from where they meet", yield* found(position(40, 4)), [
          [30, 40],
          [40, 45],
        ]);
        yield* same("another Network", yield* store.gaps(oftc, {}), []);
      }),
    name: "finds the Gaps that overlap a range, and closes one in place",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* apply(store, 2, [
          ...opened(2).slice(0, 2),
          added(2, channel, position(0, 2), said("a", "Pending")),
        ]);
        yield* apply(store, 3, [added(3, channel, position(1, 3), said("b"))]);
        yield* apply(store, 4, [
          {
            _tag: "Confirmed",
            at: known(at(2)),
            id: { _tag: "Unknown" },
            intent: IntentId.make("intent-a"),
            messageId: undefined,
            network: libera,
            sequence: 4,
            text: "a",
          },
        ]);
        yield* apply(store, 5, [
          { _tag: "Gap", from: position(9, 5), network: libera, sequence: 5, to: undefined },
        ]);
        yield* apply(store, 6, []);

        const brief = (after: number | undefined, limit?: number) =>
          store.changedAfter(after, limit).pipe(
            Effect.map((changed) => ({
              gaps: changed.gaps.map(({ changed: when }) => when),
              items: changed.items.map((item) => [textOf(item), item.changed]),
              merged: changed.merged.length,
              more: changed.more,
              overflowed: changed.overflowed,
              through: changed.through,
              timelines: changed.timelines.map(({ name, changed: when }) => [name, when]),
            }))
          );

        yield* same("everything", yield* brief(undefined), {
          gaps: [5],
          items: [
            ["b", 3],
            ["a", 4],
          ],
          merged: 0,
          more: false,
          overflowed: undefined,
          through: 6,
          timelines: [
            ["libera", 2],
            ["#a", 4],
          ],
        });
        yield* same("after 3", yield* brief(3), {
          gaps: [5],
          items: [["a", 4]],
          merged: 0,
          more: false,
          overflowed: undefined,
          through: 6,
          timelines: [["#a", 4]],
        });
        // With a limit, whole sequences, resumed after `through`.
        yield* same("first page", yield* brief(undefined, 1), {
          gaps: [],
          items: [],
          merged: 0,
          more: true,
          overflowed: undefined,
          through: 2,
          timelines: [["libera", 2]],
        });
        yield* same("second page", yield* brief(2, 1), {
          gaps: [],
          items: [["b", 3]],
          merged: 0,
          more: true,
          overflowed: undefined,
          through: 3,
          timelines: [],
        });
        // A step that alone is more than the page is given as overflowed, and nothing of it.
        yield* same("third page, overflowed", yield* brief(3, 1), {
          gaps: [],
          items: [],
          merged: 0,
          more: true,
          overflowed: { sequence: 4, timelines: [channel] },
          through: 4,
          timelines: [],
        });
        yield* same("third page, whole", yield* brief(3, 2), {
          gaps: [],
          items: [["a", 4]],
          merged: 0,
          more: true,
          overflowed: undefined,
          through: 4,
          timelines: [["#a", 4]],
        });
        yield* same("last page", yield* brief(4, 1), {
          gaps: [5],
          items: [],
          merged: 0,
          more: false,
          overflowed: undefined,
          through: 6,
          timelines: [],
        });
      }),
    name: "gives what changed after a sequence, as it stands, by whole sequences",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* apply(store, 2, [...opened(2), added(2, channel, position(0, 2), said("x"))]);
        yield* apply(store, 3, [
          described(3, channel, "Channel", "#A", "#a"),
          described(3, other, "Channel", "#b", null),
        ]);

        const listed = yield* store.timelines(libera);

        yield* same(
          "described",
          listed.map(({ name, key, changed }) => [name, key, changed]),
          [
            ["libera", null, 2],
            ["#A", "#a", 3],
            ["#b", null, 3],
          ]
        );
        yield* same("still readable", yield* texts(store, channel, all), "| x |");
        yield* same(
          "one Timeline as listed",
          [yield* store.timeline(channel), yield* store.timeline(other)],
          listed.map((summary) => Option.some(summary)).slice(1)
        );
        yield* same("an id never given", yield* store.timeline(third), Option.none());
      }),
    name: "describes each Timeline as last told, a detached one with no key, and reads one by id",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* store.reset(7);
        yield* apply(store, 2, [...opened(2), added(2, channel, position(0, 2), said("x"))]);
        yield* apply(store, 3, [
          described(3, oftcNetwork, "Network", oftc, null, oftc),
          added(3, oftcNetwork, position(0, 3), said("y"), undefined, oftc),
        ]);
        yield* apply(store, 4, []);

        const read = yield* store.consistent(
          Effect.all({
            located: Effect.map(store.locate(libera, 2), (items) => items.map(textOf)),
            timelines: Effect.map(store.timelines(libera), (each) => each.map(({ id }) => id)),
            window: texts(store, channel, all),
          })
        );

        yield* same("read together", read, {
          through: 4,
          value: {
            located: ["x"],
            timelines: [network, channel, other],
            window: "| x |",
          },
          version: 7,
        });

        const window = yield* store.window(channel, all, 10);

        yield* same(
          "a window's Network",
          window.pipe(Option.map(({ network: on, timeline }) => [on, timeline])),
          Option.some([libera, channel])
        );
      }),
    name: "reads together, with the last step folded and its version, and says a window's Network",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* apply(store, 2, [...opened(2), added(2, channel, position(0, 2), said("x"))]);

        // The step is forked outside the reads, and let go once they have begun, so it can
        // only wait for them, never join them.
        const begun = yield* Deferred.make<boolean>();

        const applying = yield* Effect.forkChild(
          Deferred.await(begun).pipe(
            Effect.andThen(apply(store, 3, [added(3, channel, position(1, 3), said("y"))]))
          )
        );

        const read = yield* store.consistent(
          Effect.gen(function* () {
            const first = yield* texts(store, channel, all);

            yield* Deferred.succeed(begun, true);

            for (let yielded = 0; yielded < 20; yielded += 1) {
              yield* Effect.yieldNow;
            }

            return {
              first,
              folded: (yield* store.folded).through,
              second: yield* texts(store, channel, all),
            };
          })
        );

        yield* same("while reading together", read, {
          through: 2,
          value: { first: "| x |", folded: 2, second: "| x |" },
          version: undefined,
        });
        yield* Fiber.join(applying);
        yield* same("afterwards", yield* store.consistent(texts(store, channel, all)), {
          through: 3,
          value: "| x y |",
          version: undefined,
        });
      }),
    name: "holds a step back while reads made together run",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        // Two Timelines with many items each, merged in one step, which then changes every
        // item it moves.
        const many = 30;

        yield* apply(store, 2, [
          ...opened(2),
          ...Array.from({ length: many }, (_, n) =>
            added(2, channel, position(n, 2, n), said(`a${n}`))
          ),
          ...Array.from({ length: many }, (_, n) =>
            added(2, other, position(n, 2, many + n), said(`b${n}`))
          ),
        ]);
        yield* apply(store, 3, [
          { _tag: "Merged", from: other, into: channel, network: libera, sequence: 3 },
        ]);
        yield* apply(store, 4, [added(4, channel, position(99, 4), said("after"))]);

        const page = (after: number, limit: number) =>
          store.changedAfter(after, limit).pipe(
            Effect.map((changed) => ({
              items: changed.items.map(textOf),
              more: changed.more,
              overflowed: changed.overflowed,
              through: changed.through,
              timelines: changed.timelines.map(({ id }) => id),
            }))
          );

        yield* same("the merge, overflowed", yield* page(2, 10), {
          items: [],
          more: true,
          overflowed: { sequence: 3, timelines: [channel, other] },
          through: 3,
          timelines: [],
        });
        yield* same("its Timelines, more than the page", yield* page(2, 1), {
          items: [],
          more: true,
          overflowed: { sequence: 3, timelines: undefined },
          through: 3,
          timelines: [],
        });
        yield* same("the step after it", yield* page(3, 10), {
          items: ["after"],
          more: false,
          overflowed: undefined,
          through: 4,
          timelines: [channel],
        });
        // A page that holds it gives it whole: every item it moved.
        yield* same(
          "the merge, whole, and the step after it",
          (yield* page(2, 1000)).items.length,
          many + 1
        );
      }),
    name: "gives a step bigger than the page as overflowed, with the Timelines it touched",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* apply(store, 2, opened(2));
        yield* apply(store, 3, [described(3, oftcNetwork, "Network", oftc, null, oftc)]);

        const ids = (page?: { readonly after?: TimelineId; readonly limit?: number }) =>
          Effect.map(store.timelines(libera, page), (each) => each.map(({ id }) => id));

        yield* same("all", yield* ids(), [network, channel, other]);
        yield* same("first page", yield* ids({ limit: 2 }), [network, channel]);
        yield* same("next page", yield* ids({ after: channel, limit: 2 }), [other]);
        yield* same("past the last", yield* ids({ after: other, limit: 2 }), []);
      }),
    name: "pages a Network's Timelines by id",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        // A quiet Timeline, with items at 5 and 100, across many Gaps.
        yield* apply(store, 2, [
          ...opened(2),
          added(2, channel, position(5, 2), said("early")),
          added(2, channel, position(100, 2, 1), said("late")),
          gap(2, position(1, 2, 2), position(2, 2, 3)),
          ...[10, 30, 50, 70].map((ms, n) =>
            gap(2, position(ms, 2, 4 + n), position(ms + 10, 2, 8 + n))
          ),
          gap(2, position(120, 2, 12), undefined),
          gap(2, position(130, 2, 13), position(131, 2, 14), oftc),
        ]);

        const runs = (range: {
          readonly from?: Position;
          readonly to?: Position;
          readonly at: readonly Position[];
        }) =>
          Effect.map(store.collapsedGaps(libera, range), (each) =>
            each.map(({ count, from, to }) => [
              count,
              from.at - t0,
              to === undefined ? null : to.at - t0,
            ])
          );

        const early = position(5, 2);
        const late = position(100, 2, 1);

        yield* same("every run, open at both ends", yield* runs({ at: [early, late] }), [
          [1, 1, 2],
          [4, 10, 80],
          [1, 120, null],
        ]);
        yield* same(
          "closed at both ends",
          yield* runs({ at: [early, late], from: early, to: late }),
          [[4, 10, 80]]
        );
        yield* same("one item", yield* runs({ at: [late] }), [
          [5, 1, 80],
          [1, 120, null],
        ]);
        yield* same("no item", yield* runs({ at: [] }), [[6, 1, null]]);
        yield* same(
          "between two Gaps",
          yield* runs({ at: [], from: position(21, 9), to: position(29, 9) }),
          []
        );
      }),
    name: "collapses the Gaps between a Timeline's items, one run for each span",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        // The same quiet Timeline, read as pages fitted together at a cursor: every Gap is
        // in exactly one page, and one that reaches the cursor is the window's holding it.
        yield* apply(store, 2, [
          ...opened(2),
          added(2, channel, position(5, 2), said("early")),
          added(2, channel, position(100, 2, 1), said("late")),
          gap(2, position(1, 2, 2), position(2, 2, 3)),
          ...[10, 30, 50, 70].map((ms, n) =>
            gap(2, position(ms, 2, 4 + n), position(ms + 10, 2, 8 + n))
          ),
          gap(2, position(120, 2, 12), undefined),
        ]);

        const runs = (range: {
          readonly from?: Position;
          readonly to?: Position;
          readonly at: readonly Position[];
          readonly beganAfter?: Position;
          readonly endedBefore?: Position;
        }) =>
          Effect.map(store.collapsedGaps(libera, range), (each) =>
            each.map(({ count, from, to }) => [
              count,
              from.at - t0,
              to === undefined ? null : to.at - t0,
            ])
          );

        const early = position(5, 2);
        const late = position(100, 2, 1);
        // Inside the Gap from 50 to 60, which reaches it.
        const inside = position(55, 2, 20);

        yield* same(
          "before the late item, the runs that ended before it",
          yield* runs({ at: [early], endedBefore: late }),
          [
            [1, 1, 2],
            [4, 10, 80],
          ]
        );
        yield* same("the window holding the late item", yield* runs({ at: [late], from: late }), [
          [1, 120, null],
        ]);
        yield* same(
          "before a cursor a Gap reaches, without that Gap",
          yield* runs({ at: [early], endedBefore: inside }),
          [
            [1, 1, 2],
            [2, 10, 40],
          ]
        );
        yield* same(
          "the window holding the cursor, with it",
          yield* runs({ at: [inside, late], from: inside }),
          [
            [1, 50, 60],
            [1, 70, 80],
            [1, 120, null],
          ]
        );
        yield* same(
          "after a cursor a Gap reaches, without that Gap",
          yield* runs({ at: [late], beganAfter: inside }),
          [
            [1, 70, 80],
            [1, 120, null],
          ]
        );
        yield* same(
          "the window ending at the cursor, with it",
          yield* runs({ at: [early, inside], to: inside }),
          [
            [1, 1, 2],
            [3, 10, 60],
          ]
        );
      }),
    name: "splits the runs at a cursor, so pages fitted together give each Gap once",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        // A failed Connection opens a Gap, a Session closes it at P, and a restart before any
        // more News opens the next Gap at the last step folded, which is P too.
        const steps = [
          [
            {
              _tag: "ConnectionFailed",
              at: at(10),
              ircd: { host: "irc.test", port: 6697, tls: true },
              opened: false,
              reason: { _tag: "Closed", reason: "Reset" },
            },
          ],
          [{ _tag: "SessionBegan", at: at(20), nick: "iirc" }],
          [{ _tag: "SessionEnded", at: at(30), reason: { _tag: "Restarted" } }],
        ] as const;

        yield* inOrder(steps.entries(), ([index, news]) =>
          Effect.gen(function* () {
            const sequence = index + 2;

            const stepped = step(yield* store.directory, {
              at: news[0].at,
              network: libera,
              news,
              sequence,
            });

            yield* store.apply({
              changes: stepped.changes,
              directory: stepped.directory,
              through: sequence,
            });
          })
        );

        const all = yield* store.gaps(libera, {});
        const [first, second] = all;
        const shared = first?.to;

        yield* same("two Gaps", all.length, 2);
        yield* same(
          "the second begins where the first ended",
          shared !== undefined &&
            second !== undefined &&
            cursorOf(second.from) === cursorOf(shared),
          true
        );

        if (shared === undefined) {
          return;
        }

        yield* same(
          "read from that point",
          (yield* store.gaps(libera, { from: shared })).length,
          2
        );
        yield* same(
          "collapsed from that point",
          (yield* store.collapsedGaps(libera, { at: [], from: shared })).map(({ count }) => count),
          [2]
        );
      }),
    name: "keeps a Gap that ends where the next began, after a restart, read from that point",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        const unread = (timeline: TimelineId) =>
          Effect.map(store.timelines(libera), (each) => {
            const found = each.find(({ id }) => id === timeline);

            return { changed: found?.changed, read: found?.read, unread: found?.unread };
          });

        yield* apply(store, 2, [
          ...opened(2),
          ...levels.map((level, n) =>
            added(2, channel, position(10 + n, 2, n), said(level), undefined, libera, level)
          ),
          added(2, channel, position(20, 2, 4), said("ours", "Pending")),
          added(
            2,
            channel,
            position(21, 2, 5),
            said("Activity, later"),
            undefined,
            libera,
            "Activity"
          ),
        ]);
        yield* same("everything, before any Read Marker", yield* unread(channel), {
          changed: 2,
          read: undefined,
          unread: { activity: 2, direct: 1, highlights: 1, messages: 1 },
        });

        yield* apply(store, 3, [marker(3, channel, at(11))]);
        yield* same("what lies after the Read Marker", yield* unread(channel), {
          changed: 3,
          read: at(11),
          unread: { activity: 2, direct: 0, highlights: 0, messages: 1 },
        });

        yield* apply(store, 4, [marker(4, channel, at(11)), marker(4, channel, at(5))]);
        yield* same("a Read Marker never moves back", yield* unread(channel), {
          changed: 3,
          read: at(11),
          unread: { activity: 2, direct: 0, highlights: 0, messages: 1 },
        });

        yield* apply(store, 5, [
          // History from before the Read Marker is read, and from after it is not.
          added(5, channel, position(1, 5), said("early"), undefined, libera, "Highlight"),
          added(5, channel, position(15, 5), said("late"), "m1", libera, "Highlight"),
          // A duplicate is dropped, and never counts.
          added(5, channel, position(16, 5), said("again"), "m1", libera, "Highlight"),
          added(5, channel, position(21, 2, 5), said("same place"), undefined, libera, "Direct"),
        ]);
        yield* same("late history, and duplicates", yield* unread(channel), {
          changed: 5,
          read: at(11),
          unread: { activity: 2, direct: 0, highlights: 1, messages: 1 },
        });

        yield* apply(store, 6, [
          {
            _tag: "Confirmed",
            at: known(at(30)),
            id: known(MessageId.make("m9")),
            intent: IntentId.make("intent-ours"),
            messageId: MessageId.make("m9"),
            network: libera,
            sequence: 6,
            text: "ours!",
          },
          described(6, channel, "Channel", "#a", "#a"),
        ]);
        yield* same("delivery and a new description leave the counts", yield* unread(channel), {
          changed: 6,
          read: at(11),
          unread: { activity: 2, direct: 0, highlights: 1, messages: 1 },
        });

        yield* apply(store, 7, [marker(7, channel, at(100))]);
        yield* same("all read", yield* unread(channel), {
          changed: 7,
          read: at(100),
          unread: noneUnread,
        });
        yield* same(
          "the changes carry it",
          (yield* store.changedAfter(6)).timelines.map(({ id, read, unread: counts }) => [
            id,
            read,
            counts,
          ]),
          [[channel, at(100), noneUnread]]
        );
      }),
    name: "keeps a Read Marker that moves only forward, and counts what lies after it by level",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        const counts = (timeline: TimelineId) =>
          Effect.map(
            store.timelines(libera),
            (each) => each.find(({ id }) => id === timeline)?.unread
          );

        yield* apply(store, 2, [
          ...opened(2),
          ...Array.from({ length: unreadCap + 2 }, (_, n) =>
            added(2, channel, position(n, 2, n), said(`${n}`), undefined, libera, "Message")
          ),
        ]);
        yield* same("more than the cap", yield* counts(channel), {
          ...noneUnread,
          messages: unreadCap + 1,
        });

        yield* apply(store, 3, [
          added(3, channel, position(5000, 3), said("more"), undefined, libera, "Message"),
        ]);
        yield* same("still more than the cap", yield* counts(channel), {
          ...noneUnread,
          messages: unreadCap + 1,
        });

        yield* apply(store, 4, [marker(4, channel, at(2))]);
        yield* same("exactly the cap", yield* counts(channel), {
          ...noneUnread,
          messages: unreadCap,
        });

        yield* apply(store, 5, [marker(5, channel, at(unreadCap - 2))]);
        yield* same("a few", yield* counts(channel), { ...noneUnread, messages: 4 });
      }),
    name: "caps each count, one past the cap meaning more",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        const largest = Instant.make(Number.MAX_SAFE_INTEGER);
        const least = Instant.make(Number.MIN_SAFE_INTEGER);

        const summary = Effect.map(store.timelines(libera), (each) =>
          each.flatMap(({ id, read, unread }) => (id === channel ? [{ read, unread }] : []))
        );

        yield* apply(store, 2, [
          ...opened(2),
          added(2, channel, { at: least, n: 0, sequence: 2 }, said("first"), undefined, libera),
          added(2, channel, position(1, 2, 1), said("now"), undefined, libera),
          added(2, channel, { at: largest, n: 2, sequence: 2 }, said("last"), undefined, libera),
        ]);
        yield* apply(store, 3, [marker(3, channel, least)]);
        yield* same("all but the first after the least instant", yield* summary, [
          { read: least, unread: { ...noneUnread, messages: 2 } },
        ]);

        yield* apply(store, 4, [marker(4, channel, largest)]);
        yield* same("nothing after the largest instant", yield* summary, [
          { read: largest, unread: noneUnread },
        ]);

        yield* apply(store, 5, [
          added(
            5,
            channel,
            { at: largest, n: 0, sequence: 5 },
            said("at the last"),
            undefined,
            libera
          ),
        ]);
        yield* same("nor at it", yield* summary, [{ read: largest, unread: noneUnread }]);
        yield* same("applied", (yield* store.folded).through, 5);
      }),
    name: "counts nothing after the largest instant, and everything after the least",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        yield* apply(store, 2, [
          ...opened(2),
          added(2, channel, position(1, 2, 0), said("kept, read"), "k", libera, "Message"),
          added(2, channel, position(9, 2, 1), said("kept"), undefined, libera, "Message"),
          added(2, other, position(2, 2, 2), said("moved, read"), undefined, libera, "Highlight"),
          added(2, other, position(8, 2, 3), said("moved"), undefined, libera, "Highlight"),
          added(2, other, position(9, 2, 4), said("same id"), "k", libera, "Highlight"),
          added(2, other, position(9, 2, 1), said("same place"), undefined, libera, "Direct"),
          marker(2, channel, at(5)),
        ]);
        yield* apply(store, 3, [
          { _tag: "Merged", from: other, into: channel, network: libera, sequence: 3 },
        ]);

        const kept = (yield* store.timelines(libera)).find(({ id }) => id === channel);

        yield* same(
          "the kept Timeline, counted again",
          kept && [kept.read, kept.unread, kept.changed],
          [at(5), { ...noneUnread, highlights: 1, messages: 1 }, 3]
        );
      }),
    name: "counts the kept Timeline again on a merge, by its own Read Marker",
  },
  {
    check: (store) =>
      Effect.gen(function* () {
        const seeds = Array.from({ length: 12 }, (_, seed) => seed);

        // The runs hold a Message Self said elsewhere, with no level and not ours.
        yield* same(
          "a Message Self said elsewhere among the runs",
          seeds
            .flatMap((seed) => randomSteps(seed).flat())
            .some(
              (change) =>
                change._tag === "Added" &&
                change.level === undefined &&
                change.content._tag === "Message" &&
                change.content.ours === undefined
            ),
          true
        );

        yield* inOrder(seeds, (seed) =>
          Effect.gen(function* () {
            yield* store.reset(3);
            yield* apply(store, 1, opened(1));

            const marked = new Map<TimelineId, Instant>();
            let before = yield* store.timelines(libera);

            for (const [index, changes] of randomSteps(seed).entries()) {
              const sequence = index + 2;

              yield* apply(store, sequence, changes);

              for (const change of changes) {
                const was = change._tag === "ReadMarker" ? marked.get(change.timeline) : undefined;

                if (change._tag === "ReadMarker" && (was === undefined || change.read > was)) {
                  marked.set(change.timeline, change.read);
                }
              }

              const after = yield* store.timelines(libera);

              for (const summary of after) {
                const where = `seed ${seed}, step ${sequence}, ${summary.id}`;
                const window = yield* store.window(summary.id, all, 100_000);

                const items = Option.match(window, {
                  onNone: () => [],
                  onSome: ({ items: each }) => each,
                });

                const was = before.find(({ id }) => id === summary.id);

                yield* same(`${where}: its Read Marker`, summary.read, marked.get(summary.id));
                yield* same(
                  `${where}: what lies after it`,
                  summary.unread,
                  countUnread(items, summary.read)
                );

                if (
                  was !== undefined &&
                  (was.read !== summary.read || !Equal.equals(was.unread, summary.unread))
                ) {
                  yield* same(`${where}: changed`, summary.changed, sequence);
                }
              }

              before = after;
            }
          })
        );
      }),
    name: "counts what lies after each Read Marker as counting one by one does, after any steps",
  },
  ...searchLaws,
  {
    check: interrupting(additions),
    name: "applies a step whole, or not at all",
  },
  {
    check: interrupting(deliveries),
    name: "applies a step that confirms and marks our Messages Unsent whole, or not at all",
  },
  {
    check: interrupting(gaps),
    name: "applies a step that closes a Gap and opens another whole, or not at all",
  },
  {
    check: interrupting(merging),
    name: "applies a step that merges Timelines whole, or not at all",
  },
  {
    check: interrupting(marking),
    name: "applies a step that moves Read Markers whole, or not at all",
  },
];
