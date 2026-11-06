// What placing and Activity add to the fold every append runs (MSG-2, MSG-5), beside the
// Standings fold alone, and what a netsplit's rows cost a commit. Run with
// `bun packages/log/bench/fold.ts`. Not a test: the numbers depend on the machine.
import { mkdtempSync, rmSync } from "node:fs";

import { BunServices } from "@effect/platform-bun";
import type { Entry, NewEntry } from "@iirc/session/entry";
import { Recorder } from "@iirc/session/recorder";
import { foldStandings } from "@iirc/session/standing";
import { attemptInput } from "@iirc/session/testing";
import { Array as Arr, Effect } from "effect";
import { constVoid } from "effect/Function";

import { foldEntries, noProjection } from "../src/fold.ts";
import type { Projection } from "../src/fold.ts";
import { Log } from "../src/log.ts";

const encoder = new TextEncoder();
const network = "libera";
const ircd = { host: "irc.example", port: 6697, tls: true };

let sequence = 0;

const entryOf = (entry: NewEntry): Entry => {
  sequence += 1;

  return { ...entry, at: sequence, sequence };
};

const heard = (text: string): NewEntry => ({
  _tag: "Line",
  bytes: encoder.encode(text),
  connection: 1,
  direction: "inbound",
  network,
});

const attempt: NewEntry = {
  _tag: "Connection",
  ircd,
  network,
  nicks: ["alice"],
  ...attemptInput,
  phase: "attempt",
};

const spread = (micros: readonly number[]) => {
  const sorted = micros.toSorted((one, other) => one - other);

  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;

  return `${at(0.5).toFixed(1)} µs p50, ${at(0.99).toFixed(1)} µs p99`;
};

// Twenty Channels of 500, each sharing 100 Users with the next, and 50 partners.
const users = Array.from({ length: 2000 }, (_, index) => `user${index}`);
const channels = Array.from({ length: 20 }, (_, index) => `#c${index}`);

// The Connection's ID is its `attempt`'s sequence, which is 1 in a fresh Log.
const welcomed: readonly NewEntry[] = [
  { _tag: "Connection", connection: 1, ircd, network, phase: "opened" },
  heard(":irc 001 alice :Welcome"),
  ...channels.flatMap((channel, index) => [
    heard(`:alice!a@h JOIN ${channel}`),
    ...Array.from({ length: 10 }, (_, chunk) =>
      heard(
        `:irc 353 alice = ${channel} :${users
          .slice(index * 100 + chunk * 50, index * 100 + chunk * 50 + 50)
          .join(" ")}`
      )
    ),
    heard(`:irc 366 alice ${channel} :End of /NAMES list.`),
  ]),
  ...users.slice(0, 50).map((nick) => heard(`:${nick}!u@h PRIVMSG alice :hi`)),
];

const setup = [attempt, ...welcomed].map(entryOf);

// Sequences were assigned once, so each round starts from the same place.
const after = (from: Projection) => foldEntries(from, setup).projection;
const start = after(noProjection);

const timed = (lines: readonly Entry[], rounds: number, fold: (entry: Entry) => void) => {
  const micros: number[] = [];

  for (let round = 0; round < rounds; round += 1) {
    Bun.gc(true);

    for (const entry of lines) {
      const started = Bun.nanoseconds();

      fold(entry);
      micros.push((Bun.nanoseconds() - started) / 1000);
    }
  }

  return spread(micros);
};

const compare = (name: string, lines: readonly Entry[]) => {
  let { standings } = start;
  let projection = start;

  const alone = timed(lines, 10, (entry) => {
    standings = foldStandings(standings, [entry]);
  });

  const whole = timed(lines, 10, (entry) => {
    ({ projection } = foldEntries(projection, [entry]));
  });

  console.log(`${name}: Standings alone ${alone}; with Messages and Activity ${whole}`);
};

const inChannel = Array.from({ length: 1000 }, (_, index) =>
  entryOf(heard(`:user${index % 500}!u@h PRIVMSG #c0 :line ${index}`))
);

const fromPartners = Array.from({ length: 1000 }, (_, index) =>
  entryOf(heard(`:user${index % 50}!u@h PRIVMSG alice :again ${index}`))
);

const motd = Array.from({ length: 1000 }, (_, index) =>
  entryOf(heard(`:irc 372 alice :- line ${index} of the message of the day`))
);

compare("PRIVMSG in a Channel", inChannel);

compare("PRIVMSG from a partner", fromPartners);

compare("A numeric", motd);

// What a netsplit's rows cost a commit: 1000 QUITs in one socket read, each in about two
// Channels, against the same number of Lines that derive nothing but one row each.
const quits = users.slice(0, 1000).map((nick) => heard(`:${nick}!u@h QUIT :a.example b.example`));
const numerics = users.slice(0, 1000).map((nick) => heard(`:irc 372 alice :- ${nick}`));
const said = users.slice(0, 1000).map((nick) => heard(`:${nick}!u@h PRIVMSG #c0 :hello`));

// How many rows a batch derives, from where the setup leaves the fold.
const rowsOf = (batch: readonly NewEntry[]) => {
  const { activity, messages } = foldEntries(start, batch.map(entryOf));

  return activity.length + messages.length;
};

const committed = (batch: readonly NewEntry[]) =>
  Effect.gen(function* () {
    const dataDir = mkdtempSync("/var/tmp/iirc-bench-");

    const millis = yield* Effect.gen(function* () {
      const { record } = yield* Recorder;

      yield* record([attempt], constVoid);

      if (!Arr.isReadonlyArrayNonEmpty(welcomed) || !Arr.isReadonlyArrayNonEmpty(batch)) {
        return 0;
      }

      yield* record(welcomed, constVoid);

      const started = performance.now();

      yield* record(batch, constVoid);

      return performance.now() - started;
    }).pipe(Effect.provide(Log.layer({ dataDir })), Effect.scoped);

    rmSync(dataDir, { force: true, recursive: true });

    return millis;
  });

const program = Effect.gen(function* () {
  for (const [name, batch] of [
    ["PRIVMSGs, a Message each", said],
    ["numerics, an Activity each", numerics],
    ["QUITs, each in every Channel it shares", quits],
  ] as const) {
    const runs = [];

    for (let round = 0; round < 5; round += 1) {
      runs.push(yield* committed(batch));
    }

    console.log(
      `${name}: one commit of ${batch.length} Lines and ${rowsOf(batch)} rows took ${runs
        .toSorted((one, other) => one - other)
        .map((millis) => millis.toFixed(1))
        .join(", ")} ms`
    );
  }
}).pipe(Effect.provide(BunServices.layer));

await Effect.runPromise(program);
