/**
 * Times what one step costs on a large Network: three Channels of `n` members each,
 * with every Feature on and with none. Run it with `bun run bench:scale` from
 * `packages/client`, optionally with the sizes, such as `bun run bench:scale 1000 30000`.
 *
 * A step's cost should follow the Line and the part of State it touches, so a Message
 * costs the same whatever `n` is, a listing costs in proportion to the names it lists,
 * and a join, part, or quit in a Channel costs no more than that Channel holds.
 *
 * @packageDocumentation
 */
import { client } from "../src/core.ts";
import { ConnectionId, Instant } from "../src/ids.ts";
import type { State } from "../src/state.ts";
import { configured, floorIsupport, registered, replay } from "../src/testing/index.ts";

const channels = ["#a", "#b", "#c"];

const everyCap = [
  "cap-notify",
  "message-tags",
  "server-time",
  "batch",
  "echo-message",
  "labeled-response",
  "multi-prefix",
  "away-notify",
];

const utf8 = new TextEncoder();
const connection = ConnectionId.make(1);

interface Clocked {
  state: State;
  at: number;
}

const receive = (clocked: Clocked, line: string): void => {
  clocked.at += 1;
  clocked.state = client.step(clocked.state, {
    _tag: "Received",
    at: Instant.make(clocked.at),
    bytes: utf8.encode(line),
    connection,
  }).state;
};

// oxlint-disable-next-line no-restricted-globals -- a benchmark reads the clock.
const now = (): number => performance.now();

const timed = (run: () => void): number => {
  const began = now();
  run();

  return now() - began;
};

// The names a `353` carries, 20 to a Line, as Ircds send them.
const perLine = 20;

const names = (channel: string, size: number): readonly string[] =>
  Array.from({ length: size }, (_unused, index) => `${channel.slice(1)}${index}`);

const setUp = (features: boolean): Clocked => {
  const base = configured({ channels: channels.map((name) => ({ name })) });

  const played = replay(client, {
    configuration: base,
    transcript: registered(base, {
      isupport: features ? [...floorIsupport, "UTF8ONLY"] : floorIsupport,
      offered: features ? everyCap : [],
    }),
  });

  const clocked = { at: 60_000, state: played.state };

  for (const channel of channels) {
    receive(clocked, `:iirc!u@h JOIN ${channel}`);
  }

  return clocked;
};

const listAll = (clocked: Clocked, size: number): number =>
  timed(() => {
    for (const channel of channels) {
      const all = ["iirc", ...names(channel, size)];

      for (let start = 0; start < all.length; start += perLine) {
        const some = all.slice(start, start + perLine).join(" ");

        receive(clocked, `:irc.test 353 iirc = ${channel} :${some}`);
      }

      receive(clocked, `:irc.test 366 iirc ${channel} :End of /NAMES list.`);
    }
  });

// The median of `times` runs of a step, in microseconds.
const median = (clocked: Clocked, times: number, line: (index: number) => string): number => {
  const each = Array.from({ length: times }, (_unused, index) =>
    timed(() => {
      receive(clocked, line(index));
    })
  ).toSorted((left, right) => left - right);

  return Math.round((each[Math.floor(times / 2)] ?? 0) * 1000);
};

const measure = (size: number, features: boolean) => {
  const clocked = setUp(features);
  const listing = Math.round(listAll(clocked, size));
  const listed = client.channel(clocked.state, "#a")?.channel.members.size;

  // Self, and every name listed.
  if (listed !== size + 1) {
    throw new Error(`#a holds ${listed} members, not ${size + 1}`);
  }

  const privmsg = median(clocked, 200, (index) => `:a1!u@h PRIVMSG #a :hello ${index}`);
  const join = median(clocked, 100, (index) => `:new${index}!u@h JOIN #a`);
  const part = median(clocked, 100, (index) => `:new${index}!u@h PART #a`);
  const quit = median(clocked, 100, (index) => `:a${index + 10}!u@h QUIT :bye`);

  return {
    features: features ? "all" : "none",
    "join µs": join,
    "listing ms": listing,
    members: size * channels.length,
    "part µs": part,
    "privmsg µs": privmsg,
    "quit µs": quit,
  };
};

const sizes = process.argv.slice(2).map(Number);

const rows = (sizes.length === 0 ? [1000, 10_000] : sizes).flatMap((size) => [
  measure(size, false),
  measure(size, true),
]);

console.table(rows);
