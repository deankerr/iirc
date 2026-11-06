/**
 * A persistent map from strings, kept in order by key: a B+tree whose every change copies
 * only the path to the key it touches, so a change costs `O(log n)` whatever the size, and
 * every earlier map stays as it was. It holds no hash, so no choice of names a Network
 * makes can slow it down, and it iterates in key order on every run.
 *
 * It implements `ReadonlyMap`, so anything that reads a `Map` reads it. Changes come from
 * {@link SortedMap.with}, {@link SortedMap.withEntries} and {@link SortedMap.without},
 * which return the very same map when nothing changed.
 */

// The most entries a node holds before it splits. Wide enough that 100,000 keys sit three
// levels deep, and narrow enough that copying a node is cheap.
const widest = 32;

type Entry<Value> = readonly [key: string, value: Value];

interface Leaf<Value> {
  readonly entries: readonly Entry<Value>[];
}

// `keys[i]` is no greater than any key under `children[i]`, and greater than every key
// under `children[i - 1]`. Removing a key can leave one lower than it need be, which still
// routes every key to the one child that can hold it.
interface Branch<Value> {
  readonly children: readonly Node<Value>[];
  readonly keys: readonly string[];
}

type Node<Value> = Leaf<Value> | Branch<Value>;

const isBranch = <Value>(node: Node<Value>): node is Branch<Value> => "children" in node;

const keyAt = <Value>(entries: readonly Entry<Value>[], index: number) => entries[index]?.[0];

// The first entry whose key is not below `key`. Searches are written out for entries and
// for keys alike, as a key read through a callback made every lookup slower by half.
const entryIndex = <Value>(entries: readonly Entry<Value>[], key: string) => {
  let low = 0;
  let high = entries.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if ((keyAt(entries, middle) ?? "") < key) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
};

// The child of a branch that holds `key`, if any child does: the last whose lowest key is
// not above it, or the first.
const childFor = (keys: readonly string[], key: string) => {
  let low = 0;
  let high = keys.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if ((keys[middle] ?? "") <= key) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return Math.max(0, low - 1);
};

const firstKey = <Value>(node: Node<Value>) =>
  (isBranch(node) ? node.keys[0] : keyAt(node.entries, 0)) ?? "";

const spliced = <Item>(
  items: readonly Item[],
  start: number,
  deleting: number,
  ...inserting: readonly Item[]
): Item[] => {
  const copy = [...items];

  copy.splice(start, deleting, ...inserting);

  return copy;
};

// Items cut into runs of at most `widest`, as even as can be.
const runs = <Item>(items: readonly Item[]): Item[][] => {
  const count = Math.ceil(items.length / widest);
  const each = Math.ceil(items.length / count);
  const cut: Item[][] = [];

  for (let start = 0; start < items.length; start += each) {
    cut.push(items.slice(start, start + each));
  }

  return cut;
};

const leavesOf = <Value>(entries: Entry<Value>[]): readonly Node<Value>[] =>
  entries.length <= widest ? [{ entries }] : runs(entries).map((run) => ({ entries: run }));

const branchesOf = <Value>(children: Node<Value>[]): readonly Node<Value>[] =>
  runs(children).map((run) => ({ children: run, keys: run.map(firstKey) }));

interface Inserted<Value> {
  readonly added: boolean;
  /** What stands in the node's place: itself changed, or two halves of it. */
  readonly nodes: readonly Node<Value>[];
}

const insert = <Value>(
  node: Node<Value>,
  key: string,
  value: Value
): Inserted<Value> | undefined => {
  if (!isBranch(node)) {
    const index = entryIndex(node.entries, key);
    const held = node.entries[index];

    if (held?.[0] === key) {
      return Object.is(held[1], value)
        ? undefined
        : { added: false, nodes: [{ entries: spliced(node.entries, index, 1, [key, value]) }] };
    }

    return { added: true, nodes: leavesOf(spliced(node.entries, index, 0, [key, value])) };
  }

  const index = childFor(node.keys, key);
  const child = node.children[index];
  const inserted = child === undefined ? undefined : insert(child, key, value);

  if (inserted === undefined) {
    return undefined;
  }

  const children = spliced(node.children, index, 1, ...inserted.nodes);

  return {
    added: inserted.added,
    nodes:
      children.length <= widest
        ? [{ children, keys: spliced(node.keys, index, 1, ...inserted.nodes.map(firstKey)) }]
        : branchesOf(children),
  };
};

// What stands in a node's place once `key` is gone: the node changed, `null` for a node
// left empty, or `undefined` when `key` was never there.
const remove = <Value>(node: Node<Value>, key: string): Node<Value> | null | undefined => {
  if (!isBranch(node)) {
    const index = entryIndex(node.entries, key);

    if (keyAt(node.entries, index) !== key) {
      return undefined;
    }

    return node.entries.length === 1 ? null : { entries: spliced(node.entries, index, 1) };
  }

  const index = childFor(node.keys, key);
  const child = node.children[index];
  const removed = child === undefined ? undefined : remove(child, key);

  if (removed === undefined) {
    return undefined;
  }

  if (removed !== null) {
    return { children: spliced(node.children, index, 1, removed), keys: node.keys };
  }

  return node.children.length === 1
    ? null
    : { children: spliced(node.children, index, 1), keys: spliced(node.keys, index, 1) };
};

interface Batch<Value> {
  added: number;
  readonly entries: readonly Entry<Value>[];
}

// A leaf with a sorted run of the batch merged in, the batch's value winning a tie, cut
// into leaves no wider than `widest`.
const mergedLeaf = <Value>(
  leaf: Leaf<Value>,
  batch: Batch<Value>,
  from: number,
  to: number
): readonly Node<Value>[] => {
  const merged: Entry<Value>[] = [];
  let held = 0;
  let taken = from;

  while (held < leaf.entries.length || taken < to) {
    const kept = leaf.entries[held];
    const given = taken < to ? batch.entries[taken] : undefined;

    if (kept !== undefined && (given === undefined || kept[0] < given[0])) {
      merged.push(kept);
      held += 1;
    } else if (given !== undefined) {
      held += kept?.[0] === given[0] ? 1 : 0;
      batch.added += kept?.[0] === given[0] ? 0 : 1;
      merged.push(given);
      taken += 1;
    }
  }

  return leavesOf(merged);
};

// Where the run of the batch below `bound` ends, from `start`.
const runEnd = <Value>(
  batch: Batch<Value>,
  start: number,
  to: number,
  bound: string | undefined
) => {
  if (bound === undefined) {
    return to;
  }

  let end = start;

  while (end < to && (keyAt(batch.entries, end) ?? "") < bound) {
    end += 1;
  }

  return end;
};

// A node with a sorted run of the batch inserted, each node it touches copied once.
const insertBatch = <Value>(
  node: Node<Value>,
  batch: Batch<Value>,
  from: number,
  to: number
): readonly Node<Value>[] => {
  if (!isBranch(node)) {
    return mergedLeaf(node, batch, from, to);
  }

  const children: Node<Value>[] = [];
  let start = from;

  for (const [index, child] of node.children.entries()) {
    const end = runEnd(batch, start, to, node.keys[index + 1]);

    children.push(...(end === start ? [child] : insertBatch(child, batch, start, end)));
    start = end;
  }

  return branchesOf(children);
};

const emptyLeaf: Leaf<never> = { entries: [] };

const walk = function* walk<Value>(node: Node<Value>): Generator<Entry<Value>> {
  if (isBranch(node)) {
    for (const child of node.children) {
      yield* walk(child);
    }

    return;
  }

  yield* node.entries;
};

const leafFor = <Value>(root: Node<Value>, key: string): Leaf<Value> | undefined => {
  let node = root;

  while (isBranch(node)) {
    const child = node.children[childFor(node.keys, key)];

    if (child === undefined) {
      return undefined;
    }

    node = child;
  }

  return node;
};

/** A persistent map from strings, in key order. */
export class SortedMap<Value> implements ReadonlyMap<string, Value> {
  readonly #root: Node<Value>;
  readonly #size: number;

  private constructor(root: Node<Value>, size: number) {
    this.#root = root;
    this.#size = size;
  }

  /**
   * A map with nothing in it.
   * @returns The empty map.
   */
  static empty<Value>(): SortedMap<Value> {
    return new SortedMap<Value>(emptyLeaf, 0);
  }

  /**
   * A map holding each entry, the later of two with one key standing.
   * @param entries - The entries, in any order.
   * @returns The map.
   */
  static from<Value>(entries: Iterable<readonly [string, Value]>): SortedMap<Value> {
    return SortedMap.empty<Value>().withEntries(entries);
  }

  /**
   * How many entries the map holds.
   * @returns The count.
   */
  get size(): number {
    return this.#size;
  }

  /**
   * The value held for a key.
   * @param key - The key.
   * @returns Its value, or `undefined` if it has none.
   */
  get(key: string): Value | undefined {
    const entries = leafFor(this.#root, key)?.entries ?? [];
    const held = entries[entryIndex(entries, key)];

    return held?.[0] === key ? held[1] : undefined;
  }

  /**
   * Whether the map holds a key.
   * @param key - The key.
   * @returns Whether it does.
   */
  has(key: string): boolean {
    const entries = leafFor(this.#root, key)?.entries ?? [];

    return keyAt(entries, entryIndex(entries, key)) === key;
  }

  /**
   * This map with `key` set to `value`.
   * @param key - The key.
   * @param value - Its value.
   * @returns A new map, or this one if `key` already held that very value.
   */
  with(key: string, value: Value): SortedMap<Value> {
    const inserted = insert(this.#root, key, value);

    if (inserted === undefined) {
      return this;
    }

    const [only, ...rest] = inserted.nodes;

    const root: Node<Value> =
      only !== undefined && rest.length === 0
        ? only
        : { children: inserted.nodes, keys: inserted.nodes.map(firstKey) };

    return new SortedMap(root, this.#size + (inserted.added ? 1 : 0));
  }

  /**
   * This map with every entry set, the later of two with one key standing. Each node they
   * touch is copied once, which for a few dozen entries at a time, as a `353` brings, is
   * several times cheaper than {@link SortedMap.with} for each.
   * @param entries - The entries, in any order.
   * @returns A new map, or this one if there were none.
   */
  withEntries(entries: Iterable<readonly [string, Value]>): SortedMap<Value> {
    const latest = new Map<string, Value>(entries);

    if (latest.size === 0) {
      return this;
    }

    const batch: Batch<Value> = {
      added: 0,
      entries: [...latest].toSorted(([one], [other]) => (one < other ? -1 : 1)),
    };

    let nodes = insertBatch(this.#root, batch, 0, batch.entries.length);

    while (nodes.length > 1) {
      nodes = branchesOf([...nodes]);
    }

    return new SortedMap(nodes[0] ?? emptyLeaf, this.#size + batch.added);
  }

  /**
   * This map without `key`.
   * @param key - The key.
   * @returns A new map, or this one if it never held `key`.
   */
  without(key: string): SortedMap<Value> {
    const removed = remove(this.#root, key);

    if (removed === undefined) {
      return this;
    }

    let root: Node<Value> = removed ?? emptyLeaf;

    // A branch left with one child is only a longer path to it.
    while (isBranch(root) && root.children.length === 1 && root.children[0] !== undefined) {
      [root] = root.children;
    }

    return new SortedMap(root, this.#size - 1);
  }

  /**
   * Every entry, in key order.
   * @returns An iterator over them.
   */
  *entries(): MapIterator<[string, Value]> {
    for (const [key, value] of walk(this.#root)) {
      yield [key, value];
    }
  }

  /**
   * Every key, in order.
   * @returns An iterator over them.
   */
  *keys(): MapIterator<string> {
    for (const [key] of walk(this.#root)) {
      yield key;
    }
  }

  /**
   * Every value, in key order.
   * @returns An iterator over them.
   */
  *values(): MapIterator<Value> {
    for (const [, value] of walk(this.#root)) {
      yield value;
    }
  }

  /**
   * Every entry, in key order, as a `Map` iterates.
   * @returns An iterator over them.
   */
  [Symbol.iterator](): MapIterator<[string, Value]> {
    return this.entries();
  }

  /**
   * Visits every entry, in key order, as `Map.forEach` does.
   * @param visit - What to do with each value, its key, and this map.
   */
  forEach(visit: (value: Value, key: string, map: ReadonlyMap<string, Value>) => void): void {
    for (const [key, value] of walk(this.#root)) {
      visit(value, key, this);
    }
  }
}
