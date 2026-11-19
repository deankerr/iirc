/**
 * A large Network: a step costs what its Line touches, not what the Network holds, and a
 * long listing reads as if each part and change had come on its own.
 * `bun run bench:scale` prints what each step costs.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { ConnectionId, Instant } from "../ids.ts";
import type { MemberKnowledge } from "../known.ts";
import type { State } from "../state.ts";
import { configured, floorIsupport, joined, play, registered, replay } from "../testing/index.ts";

const base = configured();

// A member as a step shows it: their nick, and what is known of their prefixes.
const shown = ({ nick, prefixes }: MemberKnowledge): string => {
  const held = prefixes._tag === "Known" ? prefixes.value : undefined;
  const atLeast = prefixes._tag === "Partial" ? prefixes.atLeast : undefined;

  return `${nick} ${prefixes._tag}:${[...(held ?? atLeast ?? [])].join("")}`;
};

const shownAll = (members: ReadonlyMap<string, MemberKnowledge>): readonly string[] =>
  [...members].map(([key, member]) => `${key}=${shown(member)}`);

/**
 * How long each test here may run. They build Channels of thousands of members, which
 * takes a few seconds under a full suite's load, past Vitest's default of 5 s. The cost
 * bounds inside each test, not this, are what catch work that grows with the Network.
 */
const scaleTimeout = 60_000;

describe("a long NAMES listing", () => {
  it(
    "reads each step as if each part and each change had come on its own",
    () => {
      const prelude = [registered(base), joined(base, "#big", [])];
      const transcript = [...prelude];
      // What each step shows of `#big`'s members, in order.
      const expected: (readonly string[])[] = [];

      // A plain Map of each, as `key=nick tag:prefixes`.
      const members = new Map([["iirc", "iirc Known:"]]);
      let listing: Map<string, string> | undefined;

      const receive = (line: string) => {
        transcript.push(`${line}\n`);
        expected.push([...members].map(([key, at]) => `${key}=${at}`));
      };

      const part = (index: number, extra: readonly string[] = []) => {
        const names = Array.from({ length: 10 }, (_unused, each) => `n${index * 10 + each}`);
        const listed = [...(index === 0 ? ["iirc"] : []), ...names, ...extra];

        listing ??= new Map();

        for (const name of listed) {
          const nick = name.replace("@", "");

          listing.set(nick, `${nick} ${name.startsWith("@") ? "Partial:o" : "Known:"}`);
        }

        receive(`<< :irc.test 353 iirc = #big :${listed.join(" ")}`);
      };

      // 130 parts with nothing between them: the listing folds its parts in at the 128th.
      for (let index = 0; index < 129; index += 1) {
        part(index);
      }

      // n30, listed before the fold, is listed again after it, and keeps their place.
      part(129, ["@n30"]);

      // Changes while the listing is pending, each folding in the parts before it.
      members.set("late", "late Known:");
      listing?.set("late", "late Known:");
      receive("<< :late!u@h JOIN #big");
      listing?.delete("n3");
      receive("<< :n3!u@h PART #big");

      for (let index = 130; index < 134; index += 1) {
        part(index);
      }

      listing?.delete("n15");
      listing?.set("m15", "m15 Known:");
      receive("<< :n15!u@h NICK m15");

      for (let index = 134; index < 137; index += 1) {
        part(index);
      }

      // n1365 is in a part not yet folded in, and is placed in the Channel all the same.
      listing?.delete("n1365");
      receive("<< :n1365!u@h QUIT :bye");
      transcript.push("?? activity Quit n1365 in=channel:#big in=existing-direct:n1365 :bye\n");
      listing?.set("n20", "n20 Known:o");
      receive("<< :op!u@h MODE #big +o n20");

      for (let index = 137; index < 140; index += 1) {
        part(index);
      }

      const ended = [...(listing ?? [])].map(([key, at]) => `${key}=${at}`);

      receive("<< :irc.test 366 iirc #big :End of /NAMES list.");
      expected[expected.length - 1] = ended;

      const before = play(client, { configuration: base, transcript: prelude }).steps.length;
      const played = play(client, { configuration: base, transcript });

      const shownSteps = played.steps
        .slice(before)
        .map(({ state }) =>
          shownAll(client.known(state).channels.get("#big")?.members ?? new Map())
        );

      expect(shownSteps).toStrictEqual(expected);
    },
    scaleTimeout
  );
});

const utf8 = new TextEncoder();

// oxlint-disable-next-line no-restricted-globals -- times a regression: work that grows with the Network takes seconds.
const now = (): number => performance.now();

// A Line as the Runtime hands it to the Client.
const received = (line: string) =>
  ({
    _tag: "Received",
    at: Instant.make(120_000),
    bytes: utf8.encode(line),
    connection: ConnectionId.make(1),
  }) as const;

// The middle of 101 timings.
const middle = (each: readonly number[]) => each.toSorted((low, high) => low - high)[50] ?? 0;

// A State, and the Line to step it with each time.
type Side = readonly [State, (index: number) => string];

// The median cost of each side's step, over 101 Lines each, timed in turn so a loaded
// machine slows both alike.
const inTurn = (sides: readonly [Side, Side]): readonly [number, number] => {
  const each: readonly [number[], number[]] = [[], []];

  for (let index = 0; index < 101; index += 1) {
    for (const [side, [from, line]] of sides.entries()) {
      const input = received(line(index));
      const started = now();
      client.step(from, input);
      each[side]?.push(now() - started);
    }
  }

  return [middle(each[0]), middle(each[1])];
};

// A part of a listing of `#a`, of 20 Users new to it.
const part = (index: number) =>
  `:irc.test 353 iirc = #a :${Array.from({ length: 20 }, (_unused, each) => `p${index}x${each}`).join(" ")}`;

describe("a Network of 30,000 members", () => {
  it(
    "costs each step what its Line touches",
    () => {
      const channels = ["#a", "#b", "#c"];
      const configuration = configured({ channels: channels.map((name) => ({ name })) });

      // Every Feature on, so each step reads what a hook may read.
      const { state: registeredState } = replay(client, {
        configuration,
        transcript: registered(configuration, {
          isupport: [...floorIsupport, "UTF8ONLY"],
          offered: [
            "cap-notify",
            "message-tags",
            "server-time",
            "batch",
            "echo-message",
            "labeled-response",
            "multi-prefix",
            "away-notify",
          ],
        }),
      });

      // Three Channels of `size` members each, and two States of `#a`'s listing on the way:
      // one a few parts in, one most of the way through.
      const network = (size: number) => {
        let state = registeredState;
        const listing: State[] = [];

        const receive = (line: string): void => {
          ({ state } = client.step(state, received(line)));
        };

        for (const channel of channels) {
          receive(`:iirc!u@h JOIN ${channel}`);

          for (let start = 0; start < size; start += 20) {
            const names = Array.from(
              { length: 20 },
              (_unused, index) => `u${channel.slice(1)}${start + index}`
            );

            receive(
              `:irc.test 353 iirc = ${channel} :${start === 0 ? "iirc " : ""}${names.join(" ")}`
            );

            if (channel === "#a" && (start === 500 || start === size - 500)) {
              listing.push(state);
            }
          }

          receive(`:irc.test 366 iirc ${channel} :End of /NAMES list.`);
        }

        return { listing, state };
      };

      const small = network(200);
      const large = network(10_000);

      const both = (line: (index: number) => string) =>
        inTurn([
          [small.state, line],
          [large.state, line],
        ]);

      const steps = [
        both((index) => `:ua1!u@h PRIVMSG #a :hello ${index}`),
        both((index) => `:new${index}!u@h JOIN #a`),
        both((index) => `:ua${index + 10}!u@h PART #a`),
        both((index) => `:ua${index + 10}!u@h QUIT :bye`),
        both((index) => `:irc.test 353 iirc = #a :new${index}`),
      ];

      // A part of a listing costs the same late in it as early, where work that grows with
      // the listing made the late one cost some 20 times as much.
      const [early, late] = large.listing;

      const parts = inTurn([
        [early ?? large.state, part],
        [late ?? large.state, part],
      ]);

      expect(client.channel(large.state, "#a")?.channel.members.size).toBe(10_001);
      expect(large.listing).toHaveLength(2);

      // A step on a Network 50 times the size costs about twice as much, where work that
      // grows with the Network made it some 50 times as much.
      for (const [smaller, larger] of [...steps, parts]) {
        expect(larger).toBeLessThan(smaller * 10);
      }
    },
    scaleTimeout
  );
});

// One User a WHOX reply describes, with a token.
const reply = (token: string, nick: string) =>
  `:irc.test 354 iirc ${token} #big ~${nick} ${nick}.test ${nick} G acct :${nick}`;

// An account-tagged Message from a member of `#big`.
const message = (index: number) => `@account=acct${index} :u${index}!u@h PRIVMSG #big :hi`;

describe("a WHO answer of a Channel of 10,000 members", () => {
  it(
    "costs each reply what it describes, and leaves a Message costing what it did",
    () => {
      const configuration = configured({ channels: [{ name: "#big" }], whoOnJoin: true });

      const played = replay(client, {
        configuration,
        transcript: registered(configuration, {
          isupport: [...floorIsupport, "WHOX"],
          offered: ["message-tags", "account-tag"],
        }),
      });

      let { state }: { state: State } = played;

      const receive = (line: string): void => {
        ({ state } = client.step(state, received(line)));
      };

      const nicks = Array.from({ length: 10_000 }, (_unused, index) => `u${index}`);

      receive(":iirc!u@h JOIN #big");

      for (let start = 0; start < nicks.length; start += 20) {
        const names = nicks.slice(start, start + 20).join(" ");

        receive(`:irc.test 353 iirc = #big :${start === 0 ? "iirc " : ""}${names}`);
      }

      receive(":irc.test 366 iirc #big :End of /NAMES list.");

      const asked = state;

      // A reply costs about what one with another's token, which changes nothing, does.
      const [idle, answering] = inTurn([
        [asked, (index) => reply("999", `u${index}`)],
        [asked, (index) => reply("152", `u${index}`)],
      ]);

      for (const nick of nicks) {
        receive(reply("152", nick));
      }

      receive(":irc.test 315 iirc #big :End of WHO list");

      // An account-tagged Message refreshes its sender, before the answer and after it.
      const [before, after] = inTurn([
        [asked, message],
        [state, message],
      ]);

      expect(client.known(state).users.get("u9999")?.away).toMatchObject({ _tag: "Known" });
      // Copying every User on each reply made it cost many times as much.
      expect(answering).toBeLessThan(idle * 5);
      // A Message costs the same once 10,000 Users are known, where it took twice as long.
      expect(after).toBeLessThan(before * 1.5);
    },
    scaleTimeout
  );
});
