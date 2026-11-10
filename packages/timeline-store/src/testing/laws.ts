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
import { comparePositions, cursorOf, emptyDirectory, step, timelineIdOf } from "@iirc/timelines";
import type {
  Change,
  Content,
  Delivery,
  Directory,
  Kind,
  Position,
  TimelineId,
} from "@iirc/timelines";
import { Deferred, Effect, Equal, Fiber, Option, Scheduler } from "effect";

import type {
  Anchor,
  Gap,
  Item,
  Summary,
  TimelineStoreFailed,
  TimelineStoreService,
  Tombstone,
} from "../store.ts";

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

const added = (
  sequence: number,
  timeline: TimelineId,
  where: Position,
  content: Content,
  messageId?: string,
  on = libera
): Change => ({
  _tag: "Added",
  content,
  intent: content._tag === "Message" ? content.ours?.intent : undefined,
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

// Everything a store holds that a reader can see, to compare before and after: each read
// that returns what a step may have changed, in full.
const snapshot = (store: TimelineStoreService) =>
  Effect.gen(function* () {
    const changed = yield* store.changedAfter(undefined);
    const timelines = yield* store.timelines(libera);

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

const project = (model: Model): Snapshot => {
  const itemsIn = (timeline: TimelineId) =>
    model.items
      .filter((item) => item.timeline === timeline)
      .toSorted((left, right) => comparePositions(left.position, right.position));

  const timelines = model.timelines
    .map((each) => ({ ...each, latest: itemsIn(each.id).at(-1)?.position }))
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
    };

    return {
      ...before,
      items: [
        ...before.items,
        ...Array.from({ length: 5 }, (_, n) => ({
          changed: sequence,
          content: said(`${sequence}.${n}`),
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
    name: "merges a Timeline's items into the one kept, and leaves a tombstone",
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
      }),
    name: "describes each Timeline as last told, a detached one with no key",
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
        // A failed Connection opens a Gap, a Session closes it at P, and a restart before any
        // more News opens the next Gap at the last step folded, which is P too.
        const steps = [
          [{ _tag: "ConnectionFailed", at: at(10), reason: { _tag: "Closed", reason: "Reset" } }],
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
];
