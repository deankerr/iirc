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
