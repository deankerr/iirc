// What one Line costs `stepState` at the sizes KNOW-4 and HOST-1 care about, beside what
// the same changes would cost if members were copy-on-write Maps. Run with
// `bun packages/state/bench/fold.ts`. Not a test: the numbers depend on the machine.
import { parseLine } from "@iirc/protocol/line";
import type { Line } from "@iirc/protocol/line";

import { SortedMap } from "../src/sorted-map.ts";
import { initialState, stepState } from "../src/state.ts";
import type { IrcState } from "../src/state.ts";

const lineOf = (text: string): Line => {
  const parsed = parseLine(text);

  if (parsed._tag === "Unparseable") {
    throw new Error(`Not a Line: ${text}`);
  }

  return parsed.line;
};

interface Spread {
  readonly max: number;
  readonly p50: number;
  readonly p99: number;
}

const spread = (micros: readonly number[]): Spread => {
  const sorted = micros.toSorted((one, other) => one - other);

  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;

  return { max: at(1), p50: at(0.5), p99: at(0.99) };
};

const shown = ({ max, p50, p99 }: Spread) =>
  `${p50.toFixed(1)} µs p50, ${p99.toFixed(1)} µs p99, ${max.toFixed(0)} µs max`;

// Each Line through `stepState`, timed alone, from the state the one before it left, all
// of them `rounds` times from the same start after a collection. Pauses for collection
// fall where they fall, so they are in the numbers.
const timed = (from: IrcState, lines: readonly Line[], rounds = 10) => {
  const micros: number[] = [];
  let state = from;

  for (let round = 0; round < rounds; round += 1) {
    Bun.gc(true);
    state = from;

    for (const line of lines) {
      const started = Bun.nanoseconds();

      state = stepState(state, line).next;
      micros.push((Bun.nanoseconds() - started) / 1000);
    }
  }

  return { spread: spread(micros), state };
};

const replayed = (from: IrcState, lines: readonly Line[]) => {
  let state = from;

  for (const line of lines) {
    state = stepState(state, line).next;
  }

  return state;
};

const nick = (index: number) => `user${index}`;

// `353`s as an Ircd sends them, about 450 bytes of names each, a tenth of them prefixed.
const namesBurst = (channel: string, nicks: readonly string[]): Line[] => {
  const lines: Line[] = [];
  let names: string[] = [];
  let length = 0;

  for (const [index, each] of nicks.entries()) {
    const name = index % 10 === 0 ? `@${each}` : each;

    names.push(name);
    length += name.length + 1;

    if (length > 450) {
      lines.push(lineOf(`:irc 353 me = ${channel} :${names.join(" ")}`));
      names = [];
      length = 0;
    }
  }

  if (names.length > 0) {
    lines.push(lineOf(`:irc 353 me = ${channel} :${names.join(" ")}`));
  }

  return [...lines, lineOf(`:irc 366 me ${channel} :End of /NAMES list.`)];
};

const welcomed = replayed(initialState, [lineOf(":irc 001 me :Welcome")]);

// A deterministic generator, so each run takes the same Lines.
const seeded = (seed: number) => {
  let state = seed;

  return () => {
    state = (state * 48_271) % 2_147_483_647;

    return state / 2_147_483_647;
  };
};

const withChannels = (count: number, membersEach: number, pool: number) => {
  const random = seeded(count);
  const lines: Line[] = [];

  for (let channel = 0; channel < count; channel += 1) {
    const name = `#c${channel}`;
    const members = new Set<string>();

    while (members.size < membersEach) {
      members.add(nick(Math.floor(random() * pool)));
    }

    lines.push(lineOf(`:me!u@h JOIN ${name}`), ...namesBurst(name, [...members]));
  }

  return replayed(welcomed, lines);
};

const report: [string, Spread][] = [];

// 1. A 10,000 member `NAMES` burst: `353`s, then the `366` that swaps them in.
{
  const joined = replayed(welcomed, [lineOf(":me!u@h JOIN #big")]);

  const burst = namesBurst(
    "#big",
    Array.from({ length: 10_000 }, (_, index) => nick(index))
  );

  // Once to warm up, then timed.
  timed(joined, burst, 1);
  report.push([
    `10,000 member NAMES burst, ${burst.length} Lines`,
    timed(joined, burst, 50).spread,
  ]);
}

// 2. A netsplit: 5,000 QUITs across 20 shared Channels of 2,000 members each.
{
  const split = withChannels(20, 2000, 6000);

  const quits = Array.from({ length: 5000 }, (_, index) =>
    lineOf(`:${nick(index)}!u@h QUIT :a.net b.net`)
  );

  timed(split, quits.slice(0, 500), 1);
  const after = timed(split, quits, 4);
  report.push(["5,000 QUITs across 20 Channels of 2,000", after.spread]);

  // And the rejoin: each User back into the Channels it left.
  const rejoins = Array.from({ length: 5000 }, (_, index) =>
    lineOf(`:${nick(index)}!u@h JOIN #c${index % 20}`)
  );

  report.push(["5,000 rejoins after it", timed(after.state, rejoins, 4).spread]);
}

// 3. A steady JOIN and PART stream in a 10,000 member Channel, beside 19 others.
{
  const busy = withChannels(20, 500, 20_000);

  const big = replayed(busy, [
    lineOf(":me!u@h JOIN #big"),
    ...namesBurst(
      "#big",
      Array.from({ length: 10_000 }, (_, index) => nick(index))
    ),
  ]);

  const stream = Array.from({ length: 10_000 }, (_, index) =>
    lineOf(index % 2 === 0 ? `:new${index}!u@h JOIN #big` : `:new${index - 1}!u@h PART #big :bye`)
  );

  timed(big, stream.slice(0, 1000), 1);
  report.push(["JOIN and PART in a 10,000 member Channel", timed(big, stream, 4).spread]);
}

// 4. The same netsplit with Self in 1,024 Channels, the most held, 20 of them shared.
{
  const many = replayed(
    withChannels(20, 2000, 6000),
    Array.from({ length: 1004 }, (_, index) => lineOf(`:me!u@h JOIN #quiet${index}`))
  );

  const quits = Array.from({ length: 5000 }, (_, index) =>
    lineOf(`:${nick(index)}!u@h QUIT :a.net b.net`)
  );

  timed(many, quits.slice(0, 500), 1);
  report.push(["5,000 QUITs with Self in 1,024 Channels", timed(many, quits, 2).spread]);
}

// 6. Messages, the commonest Line: 500 regular speakers already seen, then 10,000 who
// each speak once.
{
  const busy = withChannels(20, 500, 20_000);

  const regulars = Array.from({ length: 10_000 }, (_, index) =>
    lineOf(`:${nick(index % 500)}!u@h PRIVMSG #c0 :hello there`)
  );

  const warmed = replayed(busy, regulars.slice(0, 500));

  const strangers = Array.from({ length: 10_000 }, (_, index) =>
    lineOf(`:stranger${index}!u@h PRIVMSG me :hello`)
  );

  timed(warmed, regulars.slice(0, 1000), 1);
  report.push(
    ["PRIVMSG from someone seen as they are", timed(warmed, regulars, 4).spread],
    ["PRIVMSG from someone new", timed(warmed, strangers, 4).spread]
  );
}

// 5. What a copy-on-write Map pays to add one member to a Channel of each size.
for (const size of [2000, 10_000]) {
  const members = new Map(
    Array.from({ length: size }, (_, index) => [nick(index), { nick: nick(index), prefixes: "" }])
  );

  const sorted = SortedMap.from(members);
  const copied: number[] = [];
  const persistent: number[] = [];

  for (let index = 0; index < 2000; index += 1) {
    let started = Bun.nanoseconds();

    new Map(members).set(`new${index}`, { nick: "new", prefixes: "" });
    copied.push((Bun.nanoseconds() - started) / 1000);

    started = Bun.nanoseconds();
    sorted.with(`new${index}`, { nick: "new", prefixes: "" });
    persistent.push((Bun.nanoseconds() - started) / 1000);
  }

  report.push(
    [`One member into ${size.toLocaleString("en")}: copied Map`, spread(copied)],
    [`One member into ${size.toLocaleString("en")}: SortedMap`, spread(persistent)]
  );
}

for (const [what, measured] of report) {
  console.log(`| ${what} | ${shown(measured)} |`);
}
