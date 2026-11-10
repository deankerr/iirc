import type { IntentId, MessageId } from "@iirc/client";
import { cursorOf, emptyDirectory } from "@iirc/timelines";
import type { Change, Descriptor, Directory, Position, TimelineId } from "@iirc/timelines";
import { Effect, Option, Ref } from "effect";

import type {
  Anchor,
  Applied,
  Changed,
  Gap,
  Item,
  Summary,
  TimelineStoreService,
  Tombstone,
  Window,
} from "../store.ts";

/** An item and what it is found by. */
interface Stored {
  readonly item: Item;
  readonly messageId: MessageId | undefined;
  readonly intent: IntentId | undefined;
}

interface Memory {
  version: number | undefined;
  through: number | undefined;
  directory: Directory;
  readonly timelines: Map<TimelineId, { descriptor: Descriptor; changed: number }>;
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
const deliver = (
  memory: Memory,
  change: Extract<Change, { readonly _tag: "Confirmed" | "Unsent" }>
) => {
  for (const [timeline, items] of memory.items) {
    for (const [cursor, stored] of items) {
      const { content } = stored.item;

      if (
        stored.item.network !== change.network ||
        stored.intent !== change.intent ||
        content._tag !== "Message" ||
        content.ours === undefined ||
        content.ours.delivery._tag === "Confirmed" ||
        (change._tag === "Unsent" && content.ours.delivery._tag === "Unsent")
      ) {
        continue;
      }

      const delivery =
        change._tag === "Confirmed"
          ? { _tag: "Confirmed" as const, at: change.at, id: change.id, text: change.text }
          : { _tag: "Unsent" as const };

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
      memory.timelines.set(change.timeline.id, {
        changed: change.sequence,
        descriptor: change.timeline,
      });
      break;
    }

    case "Added": {
      keep(memory, {
        intent: change.intent,
        item: {
          changed: change.sequence,
          content: change.content,
          network: change.network,
          position: change.position,
          timeline: change.timeline,
        },
        messageId: change.messageId,
      });
      break;
    }

    case "Confirmed":
    case "Unsent": {
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

const summaryOf = (
  memory: Memory,
  { descriptor, changed }: { descriptor: Descriptor; changed: number }
): Summary => ({
  ...descriptor,
  changed,
  latest: sortedItems(memory, descriptor.id).at(-1)?.position,
});

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

  // Whole sequences, until at least `limit` things have been given.
  let through: number | undefined;
  let given = 0;

  for (const sequence of sequences) {
    if (limit !== undefined && given >= limit) {
      break;
    }

    through = sequence;
    given += [...timelines, ...items, ...merged, ...gaps].filter(
      ({ changed }) => changed === sequence
    ).length;
  }

  const more = sequences.some((sequence) => through === undefined || sequence > through);
  const last = through;

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
    through: upTo,
    timelines: within(timelines).toSorted(
      (left, right) => left.changed - right.changed || textOrder(left.id, right.id)
    ),
  };
};

const overlaps = (gap: Gap, from: Position | undefined, to: Position | undefined) =>
  (to === undefined || textOrder(cursorOf(gap.from), cursorOf(to)) <= 0) &&
  (from === undefined || gap.to === undefined || textOrder(cursorOf(gap.to), cursorOf(from)) >= 0);

/**
 * A Timeline store in memory. Each step is applied to a copy and swapped in at once, so
 * an apply is whole or absent.
 * @returns A fresh, empty store, built by no projection version.
 */
export const makeMemoryTimelineStore: Effect.Effect<TimelineStoreService> = Effect.gen(
  function* () {
    const memory = yield* Ref.make(empty(undefined));
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
        }),
      changedAfter: (after, limit) => read((now) => changedAfter(now, after, limit)),
      directory: read((now) => now.directory),
      folded: read((now) => ({ through: now.through, version: now.version })),
      gaps: (network, range) =>
        read((now) =>
          [...(now.gaps.get(network)?.values() ?? [])]
            .filter((gap) => overlaps(gap, range.from, range.to))
            .toSorted((left, right) => textOrder(cursorOf(left.from), cursorOf(right.from)))
        ),
      locate: (network, sequence) =>
        read((now) =>
          allItems(now)
            .filter((item) => item.network === network && item.position.sequence === sequence)
            .toSorted(byPosition)
        ),
      reset: (version) => Ref.set(memory, empty(version)),
      timelines: (network) =>
        read((now) =>
          [...now.timelines.values()]
            .flatMap((entry) =>
              entry.descriptor.network === network ? [summaryOf(now, entry)] : []
            )
            .toSorted((left, right) => textOrder(left.id, right.id))
        ),
      window: (timeline, anchor, limit) =>
        read((now) => {
          const id = now.timelines.has(timeline) ? timeline : now.merged.get(timeline)?.into;

          return id === undefined
            ? Option.none<Window>()
            : Option.some({ timeline: id, ...windowOf(sortedItems(now, id), anchor, limit) });
        }),
    };
  }
);
