/**
 * Properties of the fold and of positions, over random steps: a rebuild gives the same
 * directory and changes, ids keep their order, and cursors sort as positions do.
 */
import { Instant, IntentId, MessageId } from "@iirc/client";
import type { News, Where } from "@iirc/client";
import type { Casemapping } from "@iirc/client/known";
import { impurity } from "@iirc/client/testing";
import { casefold } from "@iirc/protocol/casemapping";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Change } from "./change.ts";
import { emptyDirectory, step } from "./fold.ts";
import type { Directory, Happened } from "./fold.ts";
import { comparePositions, cursorOf, parseCursor } from "./position.ts";
import type { Position } from "./position.ts";
import type { TimelineId } from "./timeline.ts";

const position: fc.Arbitrary<Position> = fc.record({
  at: fc
    .integer({ max: Number.MAX_SAFE_INTEGER, min: Number.MIN_SAFE_INTEGER })
    .map((at) => Instant.make(at)),
  n: fc.integer({ max: 2 ** 32 - 1, min: 0 }),
  sequence: fc.integer({ max: Number.MAX_SAFE_INTEGER, min: 1 }),
});

// Positions close together, so ties on `at` and `sequence` are common.
const nearPosition: fc.Arbitrary<Position> = fc.record({
  at: fc.integer({ max: 3, min: -3 }).map((at) => Instant.make(at)),
  n: fc.integer({ max: 3, min: 0 }),
  sequence: fc.integer({ max: 3, min: 1 }),
});

const sign = (value: number) => Math.sign(value);

const textOrder = (left: string, right: string) => {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
};

describe("positions", () => {
  it("are totally ordered, and their cursors sort the same way", () => {
    fc.assert(
      fc.property(fc.oneof(position, nearPosition), fc.oneof(position, nearPosition), (a, b) => {
        expect(sign(comparePositions(a, b)) + sign(comparePositions(b, a))).toBe(0);
        expect(comparePositions(a, b) === 0).toBe(
          a.at === b.at && a.sequence === b.sequence && a.n === b.n
        );
        expect(sign(textOrder(cursorOf(a), cursorOf(b)))).toBe(sign(comparePositions(a, b)));
      })
    );
  });

  it("are transitive", () => {
    fc.assert(
      fc.property(nearPosition, nearPosition, nearPosition, (a, b, c) => {
        fc.pre(comparePositions(a, b) <= 0 && comparePositions(b, c) <= 0);
        expect(comparePositions(a, c)).toBeLessThanOrEqual(0);
      })
    );
  });

  it("read back from their cursors, which are safe in a URL path", () => {
    fc.assert(
      fc.property(position, (each) => {
        const cursor = cursorOf(each);

        expect(parseCursor(cursor)).toStrictEqual({ ...each });
        expect(encodeURIComponent(cursor)).toBe(cursor);
      })
    );
  });

  it("refuse anything else as a cursor", () => {
    const refused = [
      "",
      "x",
      "00000000000000-00000000000000-00000000",
      "7fffffffffffff-00000000000001-00000000",
      "00000000000000-00000000000001-00000000",
      "0020000000000000-00000000000001-00000000",
      "0020000000000-00000000000001-00000000",
      "2000000000000g-00000000000001-00000000",
      "2000000000000A-00000000000001-00000000",
      "20000000000000-00000000000001-00000000-",
    ];

    expect(refused.filter((each) => parseCursor(each) !== undefined)).toStrictEqual([]);
    expect(parseCursor("20000000000000-00000000000001-00000000")).toStrictEqual({
      at: 0,
      n: 0,
      sequence: 1,
    });
  });
});

const names = ["#a", "#A", "#a[", "#a{", "peer", "Peer", "x^", "x~"];
const casemappings: readonly Casemapping[] = ["ascii", "rfc1459", "rfc1459-strict"];

const named = fc
  .tuple(fc.constantFrom(...names), fc.constantFrom(...casemappings))
  .map(([name, mapping]) => ({ key: casefold(mapping, name), name }));

const where: fc.Arbitrary<Where> = fc.oneof(
  fc.constant<Where>({ _tag: "Network" }),
  named.map((each): Where => ({ _tag: "Channel", ...each })),
  fc
    .tuple(named, fc.boolean())
    .map(([each, existing]): Where => ({ _tag: "Direct", existing, ...each })),
  fc.tuple(named, named).map(([from, to]): Where => ({ _tag: "DirectRenamed", ...from, to }))
);

const at = fc.integer({ max: 100, min: -100 }).map((ms) => Instant.make(1_000_000 + ms));

const fact = <T>(value: fc.Arbitrary<T>) =>
  fc.oneof(
    value.map(
      (each) => ({ _tag: "Known", at: Instant.make(0), from: "ircd", value: each }) as const
    ),
    value.map((each) => ({ _tag: "Stale", since: Instant.make(0), was: each }) as const),
    fc.constant({ _tag: "Unknown" } as const)
  );

const intent = fc.constantFrom("i1", "i2", "i3").map((each) => IntentId.make(each));
const messageId = fc.constantFrom("m1", "m2").map((each) => MessageId.make(each));

const news: fc.Arbitrary<News> = fc.oneof(
  fc.record({
    _tag: fc.constant("Message"),
    at: fact(at),
    id: fact(messageId),
    kind: fc.constant("Privmsg"),
    live: fc.boolean(),
    ours: fc.option(fc.record({ echo: fc.boolean(), intent }), { nil: undefined }),
    sender: fc.constant("peer"),
    tags: fc.constant(new Map<string, string>()),
    target: fc.constant("#a"),
    text: fc.string(),
    where: fc.array(where, { maxLength: 4, minLength: 1 }),
  }),
  fc.record({
    _tag: fc.constant("Activity"),
    activity: fc.constant({ _tag: "NickChanged", from: "peer", to: "Peer" } as const),
    at: fact(at),
    id: fact(messageId),
    live: fc.boolean(),
    where: fc.array(where, { maxLength: 4, minLength: 1 }),
  }),
  fc.record({ _tag: fc.constant("Refolded"), casemapping: fc.constantFrom(...casemappings) }),
  fc.record({
    _tag: fc.constant("Confirmed"),
    at: fact(at),
    id: fact(messageId),
    intent,
    text: fc.string(),
  }),
  fc.record({
    _tag: fc.constant("Refused"),
    intent,
    reason: fc.constantFrom({ _tag: "Unsent" } as const, { _tag: "Offline" } as const),
  }),
  fc.record({ _tag: fc.constant("SessionBegan"), at, nick: fc.constant("iirc") }),
  fc.record({
    _tag: fc.constantFrom("SessionEnded", "ConnectionFailed"),
    at,
    reason: fc.constantFrom({ _tag: "Silent" } as const, { _tag: "Restarted" } as const),
  }),
  fc.constant<News>({ _tag: "Ignored", reason: { _tag: "UnmatchedEcho" } })
);

const steps: fc.Arbitrary<readonly Happened[]> = fc
  .array(
    fc.record({
      at,
      network: fc.constantFrom("libera", "oftc"),
      news: fc.array(news, { maxLength: 5, minLength: 1 }),
    }),
    { maxLength: 30 }
  )
  .map((each) => each.map((happened, index) => ({ ...happened, sequence: index * 2 + 1 })));

const foldAll = (all: readonly Happened[]) => {
  let directory: Directory = emptyDirectory;
  const changes: (readonly Change[])[] = [];

  for (const each of all) {
    const stepped = step(directory, each);

    ({ directory } = stepped);
    changes.push(stepped.changes);
  }

  return { changes, directory };
};

describe("the fold", () => {
  it("gives the same directory and changes when it folds the same steps again", () => {
    fc.assert(
      fc.property(steps, (all) => {
        expect(foldAll(all)).toStrictEqual(foldAll(all));
      })
    );
  });

  it("holds only plain data, and leaves the directory it was given as it was", () => {
    fc.assert(
      fc.property(steps, steps, (first, second) => {
        const before = foldAll(first).directory;
        const shown = JSON.stringify([...before.networks].map(([, each]) => [...each.keyed]));
        let directory = before;

        for (const each of second) {
          ({ directory } = step(directory, { ...each, sequence: each.sequence + 1000 }));
        }

        expect(impurity(directory)).toBeUndefined();
        expect(JSON.stringify([...before.networks].map(([, each]) => [...each.keyed]))).toBe(shown);
      })
    );
  });

  it("gives each change its step's sequence, and opens Timelines in id order", () => {
    fc.assert(
      fc.property(steps, (all) => {
        const { changes } = foldAll(all);
        const opened: TimelineId[] = [];
        const broken: string[] = [];

        for (const [index, each] of changes.entries()) {
          for (const change of each) {
            if (change.sequence !== all[index]?.sequence) {
              broken.push(`${change._tag} at ${change.sequence} in step ${index}`);
            }

            if (change._tag === "Described" && !opened.includes(change.timeline.id)) {
              if (opened.some((id) => id >= change.timeline.id)) {
                broken.push(`${change.timeline.id} opened out of order`);
              }

              opened.push(change.timeline.id);
            }
          }
        }

        expect(broken).toStrictEqual([]);
      })
    );
  });

  it("adds only to Timelines that are open and keyed, or the Network's, once per News", () => {
    fc.assert(
      fc.property(steps, (all) => {
        const live = new Map<TimelineId, boolean>();
        const placed = new Set<string>();
        const broken: string[] = [];

        for (const change of foldAll(all).changes.flat()) {
          if (change._tag === "Described") {
            live.set(
              change.timeline.id,
              change.timeline.key !== null || change.timeline.kind === "Network"
            );
          } else if (change._tag === "Merged") {
            if (live.get(change.from) !== true || live.get(change.into) !== true) {
              broken.push(`merged ${change.from} into ${change.into}`);
            }

            live.set(change.from, false);
          } else if (change._tag === "Added") {
            const once = `${change.timeline} ${cursorOf(change.position)}`;

            if (live.get(change.timeline) !== true || placed.has(once)) {
              broken.push(`added ${once}`);
            }

            placed.add(once);
          }
        }

        expect(broken).toStrictEqual([]);
      })
    );
  });

  it("keeps the directory's keys and Timelines in step", () => {
    fc.assert(
      fc.property(steps, (all) => {
        for (const each of foldAll(all).directory.networks.values()) {
          const byKey = [
            ...[...each.channels].map(([key, id]) => ["Channel", key, id] as const),
            ...[...each.directs].map(([key, id]) => ["Direct", key, id] as const),
          ];

          expect(byKey).toHaveLength(each.keyed.size);

          for (const [kind, key, id] of byKey) {
            expect(each.keyed.get(id)).toMatchObject({ id, key, kind });
          }
        }
      })
    );
  });
});
