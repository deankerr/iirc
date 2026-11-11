/**
 * A large Network: a step costs what its Line touches, not what the Network holds, and a
 * long listing reads as if each part and change had come on its own.
 * `bun run bench:scale` prints what each step costs.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { ConnectionId, Instant } from "../ids.ts";
import type { MemberKnowledge } from "../known.ts";
import { listedMembers } from "../members.ts";
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

// What a step should show of `#big`: its members, and the listing pending, in order.
interface Expected {
  readonly members: readonly string[];
  readonly listing: readonly string[] | undefined;
}

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
      const expected: Expected[] = [];

      // A plain Map of each, as `key=nick tag:prefixes`.
      const members = new Map([["iirc", "iirc Known:"]]);
      let listing: Map<string, string> | undefined;

      const receive = (line: string) => {
        transcript.push(`${line}\n`);
        expected.push({
          listing:
            listing === undefined ? undefined : [...listing].map(([key, at]) => `${key}=${at}`),
          members: [...members].map(([key, at]) => `${key}=${at}`),
        });
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

      listing = undefined;
      members.clear();
      receive("<< :irc.test 366 iirc #big :End of /NAMES list.");
      expected[expected.length - 1] = { listing: undefined, members: ended };

      const before = play(client, { configuration: base, transcript: prelude }).steps.length;
      const played = play(client, { configuration: base, transcript });

      const shownSteps = played.steps.slice(before).map(({ state }): Expected => {
        const phase = state.channels.get("#big")?.phase;
        const pending = phase?._tag === "Joined" ? phase.listing : undefined;

        return {
          listing: pending === undefined ? undefined : shownAll(listedMembers(pending)),
          members: shownAll(client.known(state).channels.get("#big")?.members ?? new Map()),
        };
      });

      expect(shownSteps).toStrictEqual(expected);
    },
    scaleTimeout
  );
});

const utf8 = new TextEncoder();

// oxlint-disable-next-line no-restricted-globals -- times a regression: work that grows with the Network takes seconds.
const now = (): number => performance.now();

describe("a Network of 30,000 members", () => {
  it(
    "costs each step what its Line touches",
    () => {
      const channels = ["#a", "#b", "#c"];
      const configuration = configured({ channels: channels.map((name) => ({ name })) });

      // Every Feature on, so each step reads what a hook may read.
      const played = replay(client, {
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

      let { state }: { state: State } = played;
      let at = 60_000;

      const receive = (line: string): void => {
        at += 1;
        ({ state } = client.step(state, {
          _tag: "Received",
          at: Instant.make(at),
          bytes: utf8.encode(line),
          connection: ConnectionId.make(1),
        }));
      };

      const began = now();

      for (const channel of channels) {
        receive(`:iirc!u@h JOIN ${channel}`);

        for (let start = 0; start < 10_000; start += 20) {
          const names = Array.from(
            { length: 20 },
            (_unused, index) => `u${channel.slice(1)}${start + index}`
          );

          receive(
            `:irc.test 353 iirc = ${channel} :${start === 0 ? "iirc " : ""}${names.join(" ")}`
          );
        }

        receive(`:irc.test 366 iirc ${channel} :End of /NAMES list.`);
      }

      const listing = now() - began;

      const median = (line: (index: number) => string): number => {
        const each = Array.from({ length: 101 }, (_unused, index) => {
          const started = now();
          receive(line(index));

          return now() - started;
        });

        return each.toSorted((left, right) => left - right)[50] ?? 0;
      };

      const steps = [
        median((index) => `:ua1!u@h PRIVMSG #a :hello ${index}`),
        median((index) => `:new${index}!u@h JOIN #a`),
        median((index) => `:new${index}!u@h PART #a`),
        median((index) => `:ua${index + 10}!u@h QUIT :bye`),
      ];

      expect(client.channel(state, "#a")?.channel.members.size).toBe(10_000 - 101 + 1);
      // Generous bounds, for a loaded machine. Reading the listings takes about 0.1 s, and
      // each step well under 1 ms, where work that grows with the Network took 6 s and 6 ms.
      expect(listing).toBeLessThan(2000);
      expect(Math.max(...steps)).toBeLessThan(2);
    },
    scaleTimeout
  );
});
