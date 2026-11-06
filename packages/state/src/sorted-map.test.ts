import { describe, expect, it } from "vitest";

import { SortedMap } from "./sorted-map.ts";

// A small deterministic generator, so a failure replays.
const seeded = (seed: number) => {
  let state = seed;

  return () => {
    state = (state * 48_271) % 2_147_483_647;

    return state / 2_147_483_647;
  };
};

// Every `gap`th item, from the first.
const every = <A>(items: readonly A[], gap: number) =>
  items.filter((_, index) => index % gap === 0);

const sorted = (entries: Iterable<[string, number]>) =>
  [...entries].toSorted(([one], [other]) => (one < other ? -1 : 1));

describe(SortedMap, () => {
  it("HOST-1: agrees with a Map over many random changes, and keeps every earlier map", () => {
    const random = seeded(7);
    let map = SortedMap.empty<number>();
    const model = new Map<string, number>();
    const history: [SortedMap<number>, Map<string, number>][] = [];

    for (let step = 0; step < 20_000; step += 1) {
      const key = `k${Math.floor(random() * 3000)}`;

      if (random() < 0.6) {
        map = map.with(key, step);
        model.set(key, step);
      } else {
        map = map.without(key);
        model.delete(key);
      }

      if (step % 1000 === 0) {
        history.push([map, new Map(model)]);
      }
    }

    expect([...map]).toStrictEqual(sorted(model));
    expect(map.size).toBe(model.size);

    for (const [earlier, then] of history) {
      expect([...earlier]).toStrictEqual(sorted(then));
      expect(earlier.size).toBe(then.size);
    }

    for (const key of ["k1", "k2999", "nothing", ""]) {
      expect(map.get(key)).toBe(model.get(key));
      expect(map.has(key)).toBe(model.has(key));
    }
  });

  it("gives back the very same map for a change that changes nothing", () => {
    const map = SortedMap.from([["a", 1]]);

    expect(map.with("a", 1)).toBe(map);
    expect(map.without("b")).toBe(map);
    expect(SortedMap.empty().without("a").size).toBe(0);
  });

  it("empties completely, and fills again", () => {
    let map = SortedMap.empty<string>();

    for (let index = 0; index < 5000; index += 1) {
      map = map.with(`${index}`, `${index}`);
    }

    for (let index = 0; index < 5000; index += 1) {
      map = map.without(`${index}`);
    }

    expect(map.size).toBe(0);
    expect([...map.keys()]).toStrictEqual([]);
    expect(map.with("x", "y").get("x")).toBe("y");
  });

  describe("KNOW-4: pages from after a key", () => {
    const random = seeded(11);
    let map = SortedMap.empty<number>();
    const removed = new Set<string>();

    // Removals leave a branch's keys lower than they need be, so a removed key can still
    // be a separator, which a page must read past as any other.
    for (let step = 0; step < 5000; step += 1) {
      const key = `k${String(Math.floor(random() * 2000)).padStart(4, "0")}`;

      if (random() < 0.7) {
        map = map.with(key, step);
        removed.delete(key);
      } else if (map.has(key)) {
        map = map.without(key);
        removed.add(key);
      }
    }

    const whole = [...map];
    const keys = whole.map(([key]) => key);

    it("gives the whole suffix after held, removed, and absent keys across the range", () => {
      const cursors = [
        "",
        "a",
        "k",
        "k0000",
        "k1999",
        "k9",
        "z",
        ...every(keys, 64),
        ...keys.slice(-3),
        ...every([...removed].toSorted(), 16),
      ];

      for (const after of cursors) {
        const from = keys.findIndex((key) => key > after);

        expect([...map.entriesAfter(after)]).toStrictEqual(from === -1 ? [] : whole.slice(from));
      }

      expect([...SortedMap.empty().entriesAfter("a")]).toStrictEqual([]);
    });

    it("traverses the whole map in bounded pages, each from the last key of the one before", () => {
      const paged: (readonly [string, number])[] = [];
      let after = "";

      for (;;) {
        const page: (readonly [string, number])[] = [];

        for (const entry of map.entriesAfter(after)) {
          if (page.length === 37) {
            break;
          }

          page.push(entry);
        }

        if (page.length === 0) {
          break;
        }

        paged.push(...page);
        after = page.at(-1)?.[0] ?? after;
      }

      expect(paged).toStrictEqual(whole);
    });
  });

  it("iterates in key order, as a ReadonlyMap does", () => {
    const map = SortedMap.from([
      ["b", 2],
      ["a", 1],
      ["c", 3],
    ]);

    expect([...map.keys()]).toStrictEqual(["a", "b", "c"]);
    expect([...map.values()]).toStrictEqual([1, 2, 3]);
    expect([...map.entries()]).toStrictEqual([...map]);
  });
});
