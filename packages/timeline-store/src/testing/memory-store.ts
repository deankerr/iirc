import type { Instant, IntentId, MessageId } from "@iirc/client";
import {
  cursorOf,
  delivered,
  emptyDirectory,
  foldForSearch,
  searchableOf,
  unreadCap,
} from "@iirc/timelines";
import type {
  Change,
  DeliveryChange,
  Descriptor,
  Directory,
  Position,
  TimelineId,
} from "@iirc/timelines";
import { Effect, Option, Ref, Semaphore } from "effect";

import type {
  Anchor,
  Applied,
  Changed,
  CollapsedGap,
  Gap,
  Item,
  Search,
  Summary,
  TimelineStoreService,
  Tombstone,
  Unread,
  Window,
} from "../store.ts";
import { noneUnread, unreadOf } from "../store.ts";

/** An item and what it is found by. */
interface Stored {
  readonly item: Item;
  readonly messageId: MessageId | undefined;
  readonly intent: IntentId | undefined;
}

/** A Timeline, its Read Marker, when its head last changed, and the last sequence that changed it. */
interface Entry {
  descriptor: Descriptor;
  changed: number;
  read: Instant | undefined;
  head: number | undefined;
}

interface Memory {
  version: number | undefined;
  through: number | undefined;
  directory: Directory;
  readonly timelines: Map<TimelineId, Entry>;
  /** Each Timeline's items, by cursor. */
  readonly items: Map<TimelineId, Map<string, Stored>>;
  readonly merged: Map<TimelineId, Tombstone>;
  /** Each Network's Gaps, by the cursor of where they began. */
  readonly gaps: Map<string, Map<string, Gap>>;
}

const empty = (version: number | undefined): Memory => ({
  directory: emptyDirectory,
  gaps: new Map(),
  items: new Map(),
  merged: new Map(),
  through: undefined,
  timelines: new Map(),
  version,
});

const textOrder = (left: string, right: string) => {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
};

// Networks are ordered by code point, as a database comparing UTF-8 bytes orders them.
const networkOrder = (left: string, right: string) => {
  const leftPoints = Array.from(left, (each) => each.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (each) => each.codePointAt(0) ?? 0);

  for (const [index, point] of leftPoints.entries()) {
    const other = rightPoints[index];

    if (other === undefined) {
      return 1;
    }

    if (point !== other) {
      return point < other ? -1 : 1;
    }
  }

  return leftPoints.length === rightPoints.length ? 0 : -1;
};

const itemsOf = (memory: Memory, timeline: TimelineId) => {
  const found = memory.items.get(timeline);

  if (found !== undefined) {
    return found;
  }

  const made = new Map<string, Stored>();

  memory.items.set(timeline, made);

  return made;
};

const touch = (memory: Memory, timeline: TimelineId, sequence: number) => {
  const found = memory.timelines.get(timeline);

  if (found !== undefined) {
    found.changed = sequence;
  }
};

/**
 * Keeps an item in a Timeline unless one already stands at its position or has its id.
 * @param memory - The store.
 * @param stored - The item.
 */
const keep = (memory: Memory, stored: Stored) => {
  const items = itemsOf(memory, stored.item.timeline);
  const cursor = cursorOf(stored.item.position);

  const taken =
    items.has(cursor) ||
    (stored.messageId !== undefined &&
      [...items.values()].some(({ messageId }) => messageId === stored.messageId));

  if (!taken) {
    items.set(cursor, stored);
    touch(memory, stored.item.timeline, stored.item.changed);
  }
};

/**
 * Updates the delivery of each item of ours for an intent in a Network.
 * @param memory - The store.
 * @param change - The confirmation or the news that it never left.
 */
const deliver = (memory: Memory, change: DeliveryChange) => {
  for (const [timeline, items] of memory.items) {
    for (const [cursor, stored] of items) {
      const { content } = stored.item;

      if (
        stored.item.network !== change.network ||
        stored.intent !== change.intent ||
        content._tag !== "Message" ||
        content.ours === undefined
      ) {
        continue;
      }

      const delivery = delivered(content.ours.delivery, change);

      if (delivery === undefined) {
        continue;
      }

      const idTaken =
        change._tag === "Confirmed" &&
        [...items.values()].some(({ messageId }) => messageId === change.messageId);

      items.set(cursor, {
        ...stored,
        item: {
          ...stored.item,
          changed: change.sequence,
          content: { ...content, ours: { ...content.ours, delivery } },
        },
        messageId:
          change._tag === "Confirmed" && change.messageId !== undefined && !idTaken
            ? change.messageId
            : stored.messageId,
      });
      touch(memory, timeline, change.sequence);
    }
  }
};

const merge = (memory: Memory, change: Extract<Change, { readonly _tag: "Merged" }>) => {
  const moving = [...(memory.items.get(change.from) ?? new Map<string, Stored>())].toSorted(
    ([left], [right]) => textOrder(left, right)
  );

  memory.items.delete(change.from);
  memory.timelines.delete(change.from);

  for (const [, stored] of moving) {
    keep(memory, {
      ...stored,
      item: { ...stored.item, changed: change.sequence, timeline: change.into },
    });
  }

  for (const [id, tombstone] of memory.merged) {
    if (tombstone.into === change.from) {
      memory.merged.set(id, { ...tombstone, changed: change.sequence, into: change.into });
    }
  }

  memory.merged.set(change.from, {
    changed: change.sequence,
    id: change.from,
    into: change.into,
    network: change.network,
  });
  touch(memory, change.into, change.sequence);
};

const applyChange = (memory: Memory, change: Change) => {
  switch (change._tag) {
    case "Described": {
      const was = memory.timelines.get(change.timeline.id);

      memory.timelines.set(change.timeline.id, {
        changed: change.sequence,
        descriptor: change.timeline,
        head: was?.head,
        read: was?.read,
      });
      break;
    }

    case "HeadChanged": {
      const found = memory.timelines.get(change.timeline);

      if (found !== undefined) {
        found.head = change.sequence;
        found.changed = change.sequence;
      }

      break;
    }

    case "ReadMarker": {
      const found = memory.timelines.get(change.timeline);

      // Only forward, whatever the change says.
      if (found !== undefined && (found.read === undefined || change.read > found.read)) {
        found.read = change.read;
        found.changed = change.sequence;
      }

      break;
    }

    case "Added": {
      keep(memory, {
        intent: change.intent,
        item: {
          changed: change.sequence,
          content: change.content,
          level: change.level,
          network: change.network,
          position: change.position,
          timeline: change.timeline,
        },
        messageId: change.messageId,
      });
      break;
    }

    case "Confirmed":
    case "Unsent":
    case "Rejected": {
      deliver(memory, change);
      break;
    }

    case "Merged": {
      merge(memory, change);
      break;
    }

    case "Gap": {
      const gaps = memory.gaps.get(change.network) ?? new Map<string, Gap>();

      gaps.set(cursorOf(change.from), {
        changed: change.sequence,
        from: change.from,
        network: change.network,
        to: change.to,
      });
      memory.gaps.set(change.network, gaps);
      break;
    }

    default: {
      change satisfies never;
      break;
    }
  }
};

const sortedItems = (memory: Memory, timeline: TimelineId): readonly Item[] =>
  [...(memory.items.get(timeline) ?? new Map<string, Stored>())]
    .toSorted(([left], [right]) => textOrder(left, right))
    .map(([, { item }]) => item);

// Counted by walking every item, as no adapter that must stay bounded may.
const unreadIn = (items: readonly Item[], read: Instant | undefined): Unread => {
  const counts = { ...noneUnread };

  for (const { level, position } of items) {
    if (level !== undefined && (read === undefined || position.at > read)) {
      const field = unreadOf[level];

      counts[field] = Math.min(counts[field] + 1, unreadCap + 1);
    }
  }

  return counts;
};

const summaryOf = (memory: Memory, { descriptor, changed, head, read }: Entry): Summary => {
  const items = sortedItems(memory, descriptor.id);

  return {
    ...descriptor,
    changed,
    head,
    latest: items.at(-1)?.position,
    read,
    unread: unreadIn(items, read),
  };
};

const allItems = (memory: Memory): readonly Item[] =>
  [...memory.items.values()].flatMap((items) => [...items.values()].map(({ item }) => item));

// The first index whose item comes at or after a position, or strictly after it.
const indexOf = (items: readonly Item[], position: Position, after: boolean) => {
  const cursor = cursorOf(position);

  const found = items.findIndex((item) => {
    const order = textOrder(cursorOf(item.position), cursor);

    return after ? order > 0 : order >= 0;
  });

  return found === -1 ? items.length : found;
};

const windowOf = (items: readonly Item[], anchor: Anchor, limit: number) => {
  const size = Math.max(0, Math.floor(limit));
  let start = 0;
  let end = 0;

  switch (anchor._tag) {
    case "Before": {
      end = anchor.position === undefined ? items.length : indexOf(items, anchor.position, false);
      start = Math.max(0, end - size);
      break;
    }

    case "After": {
      start = anchor.position === undefined ? 0 : indexOf(items, anchor.position, true);
      end = Math.min(items.length, start + size);
      break;
    }

    case "Around": {
      const at = indexOf(items, anchor.position, false);
      const later = Math.min(items.length - at, size - Math.min(at, Math.floor(size / 2)));
      const earlier = Math.min(at, size - later);

      start = at - earlier;
      end = at + later;
      break;
    }

    default: {
      anchor satisfies never;
      break;
    }
  }

  return { earlier: start > 0, items: items.slice(start, end), later: end < items.length };
};

const byPosition = (left: Item, right: Item) =>
  textOrder(cursorOf(left.position), cursorOf(right.position)) ||
  textOrder(left.timeline, right.timeline);

// The order `changedAfter` gives each list in: `changed`, then, among what changed in one
// sequence, Timelines and tombstones by id, items by Timeline id and then position, and Gaps
// by Network and then where they began.
const byTimelineThenPosition = (left: Item, right: Item) =>
  textOrder(left.timeline, right.timeline) ||
  textOrder(cursorOf(left.position), cursorOf(right.position));

const changedAfter = (
  memory: Memory,
  after: number | undefined,
  limit: number | undefined
): Changed => {
  const since = after ?? 0;

  const timelines = [...memory.timelines.values()].flatMap((entry) =>
    entry.changed > since ? [summaryOf(memory, entry)] : []
  );

  const items = allItems(memory).filter(({ changed }) => changed > since);
  const merged = [...memory.merged.values()].filter(({ changed }) => changed > since);

  const gaps = [...memory.gaps.values()].flatMap((each) =>
    [...each.values()].filter(({ changed }) => changed > since)
  );

  const sequences = [
    ...new Set([...timelines, ...items, ...merged, ...gaps].map(({ changed }) => changed)),
  ].toSorted((left, right) => left - right);

  const countOf = (sequence: number) =>
    [...timelines, ...items, ...merged, ...gaps].filter(({ changed }) => changed === sequence)
      .length;

  // Whole sequences, while they come to at most `limit` things, and a first one that alone
  // is more given as overflowed.
  let through: number | undefined;
  let overflowed: number | undefined;
  let given = 0;

  for (const sequence of sequences) {
    const count = countOf(sequence);

    if (limit !== undefined && given + count > limit) {
      if (given === 0) {
        overflowed = sequence;
        through = sequence;
      }

      break;
    }

    through = sequence;
    given += count;
  }

  const more = sequences.some((sequence) => through === undefined || sequence > through);
  const last = overflowed === undefined ? through : undefined;

  const touched =
    overflowed === undefined
      ? []
      : [
          ...new Set([
            ...timelines.flatMap(({ changed, id }) => (changed === overflowed ? [id] : [])),
            ...items.flatMap(({ changed, timeline }) => (changed === overflowed ? [timeline] : [])),
            ...merged.flatMap(({ changed, id }) => (changed === overflowed ? [id] : [])),
          ]),
        ].toSorted(textOrder);

  const within = <T extends { readonly changed: number }>(all: readonly T[]) =>
    all.filter(({ changed }) => last !== undefined && changed <= last);

  // With nothing more to give, everything through the last step folded has been given.
  const folded = [memory.through, after].filter((each) => each !== undefined);
  const upTo = more || folded.length === 0 ? through : Math.max(...folded);

  return {
    gaps: within(gaps).toSorted(
      (left, right) =>
        left.changed - right.changed ||
        networkOrder(left.network, right.network) ||
        textOrder(cursorOf(left.from), cursorOf(right.from))
    ),
    items: within(items).toSorted(
      (left, right) => left.changed - right.changed || byTimelineThenPosition(left, right)
    ),
    merged: within(merged).toSorted(
      (left, right) => left.changed - right.changed || textOrder(left.id, right.id)
    ),
    more,
    overflowed:
      overflowed === undefined
        ? undefined
        : {
            sequence: overflowed,
            timelines: limit !== undefined && touched.length > limit ? undefined : touched,
          },
    through: upTo,
    timelines: within(timelines).toSorted(
      (left, right) => left.changed - right.changed || textOrder(left.id, right.id)
    ),
  };
};

const gapsOf = (memory: Memory, network: string) =>
  [...(memory.gaps.get(network)?.values() ?? [])].toSorted((left, right) =>
    textOrder(cursorOf(left.from), cursorOf(right.from))
  );

/**
 * A Network's Gaps over a range, as the SQLite adapter finds them by its key: a Network's
 * Gaps follow one another, one at most beginning where the one before it ended, so of those
 * that began before `from`, only the last can reach it, and it is kept when it does. Every
 * Gap that began at or after `from` is in.
 * @param gaps - The Network's Gaps, in the order they began.
 * @param from - Where the range begins, or `undefined` for its start.
 * @param to - Where the range ends, or `undefined` for its end.
 * @returns The Gaps over the range, in the order they began.
 */
const overlapping = (
  gaps: readonly Gap[],
  from: Position | undefined,
  to: Position | undefined
): readonly Gap[] => {
  const before =
    from === undefined
      ? undefined
      : gaps.findLast((gap) => textOrder(cursorOf(gap.from), cursorOf(from)) < 0);

  const startsAt =
    before !== undefined &&
    from !== undefined &&
    (before.to === undefined || textOrder(cursorOf(before.to), cursorOf(from)) >= 0)
      ? before
      : undefined;

  return gaps.filter(
    (gap) =>
      (to === undefined || textOrder(cursorOf(gap.from), cursorOf(to)) <= 0) &&
      (from === undefined || gap === startsAt || textOrder(cursorOf(gap.from), cursorOf(from)) >= 0)
  );
};

/**
 * A Network's Gaps over a range, each run between two positions collapsed into one.
 * @param gaps - The Network's Gaps, in the order they began.
 * @param range - The range, and the positions that split it.
 * @returns One collapsed Gap for each run that has any.
 */
const collapse = (
  gaps: readonly Gap[],
  range: {
    readonly from?: Position | undefined;
    readonly to?: Position | undefined;
    readonly at: readonly Position[];
    readonly beganAfter?: Position | undefined;
    readonly endedBefore?: Position | undefined;
  }
): readonly CollapsedGap[] => {
  const runs = new Map<number, Gap[]>();
  const { beganAfter, endedBefore } = range;

  // At a cursor, a Gap that reaches it is the window's that holds the cursor's item.
  const kept = overlapping(gaps, range.from, range.to).filter(
    (gap) =>
      (beganAfter === undefined || textOrder(cursorOf(gap.from), cursorOf(beganAfter)) > 0) &&
      (endedBefore === undefined ||
        (gap.to !== undefined && textOrder(cursorOf(gap.to), cursorOf(endedBefore)) < 0))
  );

  for (const gap of kept) {
    // The run is how many positions come before where the Gap began.
    const run = range.at.filter(
      (position) => textOrder(cursorOf(position), cursorOf(gap.from)) < 0
    ).length;

    runs.set(run, [...(runs.get(run) ?? []), gap]);
  }

  return [...runs.entries()]
    .toSorted(([left], [right]) => left - right)
    .flatMap(([, run]) => {
      const [first] = run;
      const last = run.at(-1);

      return first === undefined || last === undefined
        ? []
        : [{ count: run.length, from: first.from, to: last.to }];
    });
};

/**
 * The Messages a search finds, by walking every item, as no adapter that must stay bounded
 * may: newest first, by position and then Timeline id, each later one first.
 * @param memory - The store.
 * @param search - The search.
 * @returns Up to its limit, after the item it names.
 */
const searched = (memory: Memory, search: Search): readonly Item[] => {
  const text = foldForSearch(search.text);
  const from = search.from === undefined ? undefined : foldForSearch(search.from);

  const timeline =
    search.timeline === undefined
      ? undefined
      : (memory.merged.get(search.timeline)?.into ?? search.timeline);

  const { after, since, until } = search;

  return allItems(memory)
    .filter((item) => {
      const found = searchableOf(item.content);

      return (
        found !== undefined &&
        found.text.includes(text) &&
        (from === undefined || found.sender === from) &&
        (search.network === undefined || item.network === search.network) &&
        (timeline === undefined || item.timeline === timeline) &&
        (since === undefined || item.position.at >= since) &&
        (until === undefined || item.position.at < until) &&
        (after === undefined || byPosition(item, { ...item, ...after }) < 0)
      );
    })
    .toSorted((left, right) => byPosition(right, left))
    .slice(0, Math.max(0, Math.floor(search.limit)));
};

/**
 * A Timeline store in memory. Each step is applied to a copy and swapped in at once, so
 * an apply is whole or absent. A write and reads made together take turns.
 * @returns A fresh, empty store, built by no projection version.
 */
export const makeMemoryTimelineStore: Effect.Effect<TimelineStoreService> = Effect.gen(
  function* () {
    const memory = yield* Ref.make(empty(undefined));
    const turn = yield* Semaphore.make(1);
    const read = <A>(f: (now: Memory) => A) => Ref.get(memory).pipe(Effect.map(f));

    return {
      apply: (applied: Applied) =>
        Ref.update(memory, (now) => {
          if (now.through !== undefined && applied.through <= now.through) {
            return now;
          }

          const next = structuredClone({ ...now, directory: emptyDirectory });

          for (const change of applied.changes) {
            applyChange(next, change);
          }

          next.through = applied.through;
          next.directory = applied.directory;

          return next;
        }).pipe(turn.withPermits(1)),
      changedAfter: (after, limit) => read((now) => changedAfter(now, after, limit)),
      collapsedGaps: (network, range) => read((now) => collapse(gapsOf(now, network), range)),
      consistent: (reads) =>
        Effect.all({
          through: read((now) => now.through),
          value: reads,
          version: read((now) => now.version),
        }).pipe(turn.withPermits(1)),
      directory: read((now) => now.directory),
      folded: read((now) => ({ through: now.through, version: now.version })),
      gaps: (network, range) =>
        read((now) => overlapping(gapsOf(now, network), range.from, range.to)),
      locate: (network, sequence, page = {}) =>
        read((now) => {
          const { after } = page;

          return allItems(now)
            .filter(
              (item) =>
                item.network === network &&
                item.position.sequence === sequence &&
                (after === undefined ||
                  byPosition(item, {
                    ...item,
                    position: after.position,
                    timeline: after.timeline,
                  }) > 0)
            )
            .toSorted(byPosition)
            .slice(0, page.limit);
        }),
      reset: (version) => Ref.set(memory, empty(version)).pipe(turn.withPermits(1)),
      search: (search) => read((now) => searched(now, search)),
      timeline: (timeline) =>
        read((now) => {
          const id = now.timelines.has(timeline) ? timeline : now.merged.get(timeline)?.into;
          const found = id === undefined ? undefined : now.timelines.get(id);

          return found === undefined ? Option.none<Summary>() : Option.some(summaryOf(now, found));
        }),
      timelines: (network, page = {}) =>
        read((now) =>
          [...now.timelines.values()]
            .flatMap((entry) =>
              entry.descriptor.network === network &&
              (page.after === undefined || textOrder(entry.descriptor.id, page.after) > 0)
                ? [summaryOf(now, entry)]
                : []
            )
            .toSorted((left, right) => textOrder(left.id, right.id))
            .slice(0, page.limit)
        ),
      window: (timeline, anchor, limit) =>
        read((now) => {
          const id = now.timelines.has(timeline) ? timeline : now.merged.get(timeline)?.into;
          const found = id === undefined ? undefined : now.timelines.get(id);

          return id === undefined || found === undefined
            ? Option.none<Window>()
            : Option.some({
                network: found.descriptor.network,
                timeline: id,
                ...windowOf(sortedItems(now, id), anchor, limit),
              });
        }),
    };
  }
);
