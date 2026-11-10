import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { defaultPacing, depth, makeOutbox, nextAt, offer, spend, take, takeAll } from "./outbox.ts";
import type { Outbox, Pacing } from "./outbox.ts";

/** A Line as the tests queue it: its command, and its place in the order offered. */
interface Queued {
  readonly command: string;
  readonly index: number;
}

const command = fc.constantFrom("PRIVMSG", "JOIN", "PART", "PING", "PONG", "ping", "QUIT", "NICK");

const pacing: fc.Arbitrary<Pacing> = fc.record({
  burst: fc.integer({ max: 10, min: 1 }),
  interval: fc.integer({ max: 5000, min: 1 }),
});

// Offers each command in turn, as a Line numbered by its place.
const queued = (outbox: Outbox<Queued>, commands: readonly string[]): Outbox<Queued> => {
  let current = outbox;

  for (const [index, name] of commands.entries()) {
    const offered = offer(current, { command: name, index }, name);

    current = offered._tag === "Queued" ? offered.outbox : current;
  }

  return current;
};

// Takes Lines as fast as the Outbox allows: a `Wait` is waited out, and the next `take`
// at its time must take a Line.
const drain = (outbox: Outbox<Queued>, start: number) => {
  const left: { readonly item: Queued; readonly at: number }[] = [];
  let now = start;
  let taken = take(outbox, now);

  while (taken._tag !== "Empty") {
    if (taken._tag === "Wait") {
      expect(nextAt(taken.outbox, now)).toBe(taken.until);
      now = taken.until;
      taken = take(taken.outbox, now);

      if (taken._tag !== "Taken") {
        throw new Error("take said to wait, and refused at the time it named");
      }
    }

    left.push({ at: now, item: taken.item });
    taken = take(taken.outbox, now);
  }

  return left;
};

const first = (name: string) => ["PING", "PONG"].includes(name.toUpperCase());

describe("order", () => {
  it("keeps every Line in the order offered, except PING and PONG, which go first in their own order", () => {
    fc.assert(
      fc.property(fc.array(command, { maxLength: 60 }), pacing, (commands, chosen) => {
        const outbox = queued(makeOutbox({ pacing: chosen }), commands);
        const order = drain(outbox, 0).map(({ item }) => item.index);
        const indexed = commands.map((name, index) => ({ index, name }));

        expect(order).toStrictEqual([
          ...indexed.filter(({ name }) => first(name)).map(({ index }) => index),
          ...indexed.filter(({ name }) => !first(name)).map(({ index }) => index),
        ]);
      })
    );
  });

  it("lets a PING offered later overtake Lines still waiting, never one already taken", () => {
    const start = queued(makeOutbox(), ["JOIN", "PRIVMSG", "PART"]);
    const taken = take(start, 0);
    const offered = offer(taken.outbox, { command: "PONG", index: 3 }, "PONG");
    const after = offered._tag === "Queued" ? offered.outbox : start;
    const index = taken._tag === "Taken" ? taken.item.index : undefined;

    expect([index, ...drain(after, 0).map(({ item }) => item.index)]).toStrictEqual([0, 3, 1, 2]);
  });

  it("takes everything in the order it would have left, and spends no token", () => {
    fc.assert(
      fc.property(fc.array(command, { maxLength: 40 }), (commands) => {
        const outbox = queued(makeOutbox(), commands);
        const all = takeAll(outbox);

        expect(all.items.map((item) => item.index)).toStrictEqual(
          drain(outbox, 0).map(({ item }) => item.index)
        );
        expect(depth(all.outbox)).toBe(0);
        expect(all.outbox.fullAt).toBe(outbox.fullAt);
        expect(nextAt(all.outbox, 0)).toBeUndefined();
      })
    );
  });
});

describe("pacing", () => {
  it("lets at most the burst leave at once", () => {
    fc.assert(
      fc.property(pacing, fc.integer({ max: 1e12, min: 0 }), (chosen, now) => {
        let outbox = queued(
          makeOutbox({ pacing: chosen }),
          Array.from({ length: 30 }, () => "PRIVMSG")
        );

        let count = 0;

        for (let taken = take(outbox, now); taken._tag === "Taken"; taken = take(outbox, now)) {
          ({ outbox } = taken);
          count += 1;
        }

        expect(count).toBe(chosen.burst);
        expect(nextAt(outbox, now)).toBe(now + chosen.interval);
      })
    );
  });

  it("never lets more than the burst plus one per interval leave in any window", () => {
    fc.assert(
      fc.property(
        pacing,
        fc.array(fc.integer({ max: 20_000, min: 0 }), { maxLength: 80, minLength: 1 }),
        (chosen, gaps) => {
          // Lines are taken at moments of the test's choosing, each when it may leave.
          let outbox = queued(
            makeOutbox({ pacing: chosen }),
            gaps.map(() => "PRIVMSG")
          );

          let now = 0;
          const at: number[] = [];

          for (const gap of gaps) {
            now += gap;
            const due = nextAt(outbox, now) ?? now;

            now = due;
            const taken = take(outbox, now);

            ({ outbox } = taken);

            if (taken._tag === "Taken") {
              at.push(now);
            }
          }

          for (const [index, start] of at.entries()) {
            for (const end of at.slice(index)) {
              const within = at.filter((each) => each >= start && each <= end).length;

              expect(within).toBeLessThanOrEqual(
                chosen.burst + Math.floor((end - start) / chosen.interval)
              );
            }
          }
        }
      )
    );
  });

  it("settles to one Line per interval after the burst", () => {
    fc.assert(
      fc.property(pacing, fc.integer({ max: 200, min: 0 }), (chosen, extra) => {
        const count = chosen.burst + extra;

        const left = drain(
          queued(
            makeOutbox({ pacing: chosen }),
            Array.from({ length: count }, () => "PRIVMSG")
          ),
          1000
        );

        expect(left).toHaveLength(count);
        expect(left.at(-1)?.at).toBe(1000 + extra * chosen.interval);
      })
    );
  });

  it("paces by default at a burst of 5, then one every 2 s", () => {
    const left = drain(
      queued(
        makeOutbox(),
        Array.from({ length: 8 }, () => "PRIVMSG")
      ),
      0
    );

    expect(defaultPacing).toStrictEqual({ burst: 5, interval: 2000 });
    expect(left.map(({ at }) => at)).toStrictEqual([0, 0, 0, 0, 0, 2000, 4000, 6000]);
  });

  it("refills while idle, up to the burst and no more", () => {
    const spent = drain(
      queued(
        makeOutbox(),
        Array.from({ length: 5 }, () => "PRIVMSG")
      ),
      0
    );

    const outbox = queued(
      { ...makeOutbox<Queued>(), fullAt: 2000 * 5 },
      Array.from({ length: 7 }, () => "PRIVMSG")
    );

    expect(spent).toHaveLength(5);
    expect(drain(outbox, 60_000).map(({ at }) => at - 60_000)).toStrictEqual([
      0, 0, 0, 0, 0, 2000, 4000,
    ]);
  });
});

describe("spending a token for a Line not queued", () => {
  it("paces the extra Lines of one item as any others, and the queue behind them", () => {
    const outbox = queued(makeOutbox({ pacing: { burst: 1, interval: 1000 } }), [
      "AUTHENTICATE",
      "JOIN",
    ]);

    const taken = take(outbox, 0);
    const early = spend(taken.outbox, 500);
    const spent = spend(early.outbox, 1000);
    const next = take(spent.outbox, 1000);

    expect([taken._tag, early._tag, spent._tag, next._tag]).toStrictEqual([
      "Taken",
      "Wait",
      "Spent",
      "Wait",
    ]);
    expect(early._tag === "Wait" ? early.until : undefined).toBe(1000);
    expect(next._tag === "Wait" ? next.until : undefined).toBe(2000);
    expect(depth(spent.outbox)).toBe(1);
  });
});

describe("a clock set back", () => {
  it("stalls the next Line for at most one interval, however far it moved", () => {
    fc.assert(
      fc.property(
        pacing,
        fc.integer({ max: 1e12, min: 1e9 }),
        fc.integer({ max: 1e12, min: 0 }),
        (chosen, ahead, back) => {
          // Spend the bucket at a time far ahead, then ask again from far behind it.
          let outbox = queued(
            makeOutbox({ pacing: chosen }),
            Array.from({ length: chosen.burst * 3 }, () => "PRIVMSG")
          );

          for (
            let taken = take(outbox, ahead);
            taken._tag === "Taken";
            taken = take(outbox, ahead)
          ) {
            ({ outbox } = taken);
          }

          const now = ahead - back;
          const left = drain(outbox, now);

          expect(nextAt(outbox, now)).toBeLessThanOrEqual(now + chosen.interval);
          // What is left, twice the burst, leaves at the steady rate from one interval on.
          expect(left).toHaveLength(chosen.burst * 2);
          expect(left.at(-1)?.at).toBeLessThanOrEqual(now + chosen.burst * 2 * chosen.interval);
        }
      )
    );
  });
});

describe("the bound", () => {
  it("refuses an ordinary Line to a full Outbox, and keeps what it holds", () => {
    fc.assert(
      fc.property(
        fc.integer({ max: 50, min: 0 }),
        fc.constantFrom("PRIVMSG", "JOIN", "PART", "NICK"),
        (capacity, name) => {
          const full = queued(
            makeOutbox({ capacity }),
            Array.from({ length: capacity }, () => "PRIVMSG")
          );

          expect(depth(full)).toBe(capacity);
          expect(offer(full, { command: name, index: capacity }, name)).toStrictEqual({
            _tag: "Full",
          });
        }
      )
    );
  });

  it("admits a QUIT, a PING, and a PONG past a full queue of ordinary Lines, and they leave", () => {
    const full = queued(makeOutbox({ capacity: 3 }), [
      "PRIVMSG",
      "PRIVMSG",
      "PRIVMSG",
      "PRIVMSG",
      "PONG",
      "PING",
      "QUIT",
    ]);

    expect(drain(full, 0).map(({ item }) => item.command)).toStrictEqual([
      "PONG",
      "PING",
      "PRIVMSG",
      "PRIVMSG",
      "PRIVMSG",
      "QUIT",
    ]);
  });

  it("bounds PING and PONG on their own, so a flood of them cannot grow the queue", () => {
    fc.assert(
      fc.property(
        fc.integer({ max: 100, min: 0 }),
        fc.integer({ max: 300, min: 0 }),
        (bound, flood) => {
          const outbox = queued(makeOutbox({ capacity: 5, firstCapacity: bound }), [
            ...Array.from({ length: flood }, () => "PING"),
            "PRIVMSG",
          ]);

          expect(outbox.ahead).toHaveLength(Math.min(bound, flood));
          expect(outbox.behind).toHaveLength(1);
        }
      )
    );
  });

  it("holds 64 PING and PONG by default", () => {
    expect(
      depth(
        queued(
          makeOutbox(),
          Array.from({ length: 100 }, () => "PONG")
        )
      )
    ).toBe(64);
  });

  it("holds 1,000 Lines by default", () => {
    const full = queued(
      makeOutbox(),
      Array.from({ length: 1001 }, () => "PRIVMSG")
    );

    expect(depth(full)).toBe(1000);
  });

  it("takes again once a Line has left", () => {
    const full = queued(makeOutbox({ capacity: 2 }), ["JOIN", "PRIVMSG"]);
    const taken = take(full, 0);

    expect(offer(taken.outbox, { command: "PART", index: 2 }, "PART")).toMatchObject({
      _tag: "Queued",
    });
  });
});

describe("plain data", () => {
  it("survives a structured clone, and never changes the Outbox it was given", () => {
    const outbox = queued(makeOutbox(), ["JOIN", "PING", "PRIVMSG"]);
    const copy = structuredClone(outbox);

    take(outbox, 0);
    offer(outbox, { command: "PART", index: 9 }, "PART");
    takeAll(outbox);

    expect(outbox).toStrictEqual(copy);
  });
});
