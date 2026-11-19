/**
 * The message of the day is one Activity in the Network's own Timeline, collected between
 * its `375` and its `376` by those numerics alone, and bounded, so an Ircd that never ends
 * it, or sends it without end, cannot fill a Timeline.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import type { Activity } from "../news.ts";
import { maxMotdLines } from "../state.ts";
import { configured, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

// Each message of the day shown, in order.
const motdsOf = (played: ReturnType<typeof play>): readonly Activity[] =>
  played.steps.flatMap((step) =>
    step.news.flatMap((news) =>
      news._tag === "Activity" && news.activity._tag === "Motd" ? [news.activity] : []
    )
  );

const motdLine = (n: number): string => `<< :irc.test 372 iirc :- line ${n}`;

describe("the message of the day", () => {
  it("is one Activity, shown once it ends, with each line as it came", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "<< :irc.test 375 iirc :- irc.test Message of the Day -",
          "<< :irc.test 372 iirc :-   /\\_/\\",
          "<<\\ :irc.test 372 iirc :-  ( o.o ) \\x02bold\\x02\\x20",
          "<< :irc.test 372 iirc :-",
          "<< :irc.test 376 iirc :End of /MOTD command.",
          "?? activity Motd lines=3 in=network"
        ),
      ],
    });

    expect(motdsOf(played)).toStrictEqual([
      { _tag: "Motd", cut: false, lines: ["-   /\\_/\\", "-  ( o.o ) \u0002bold\u0002 ", "-"] },
    ]);
  });

  it("is cut at its bound, which says so, and drops the rest until its end", () => {
    const sent = Array.from({ length: maxMotdLines + 5 }, (_, n) => motdLine(n));

    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "<< :irc.test 375 iirc :- MOTD -",
          ...sent.slice(0, maxMotdLines),
          sent[maxMotdLines] ?? "",
          `?? activity Motd lines=${maxMotdLines} cut in=network`,
          ...sent.slice(maxMotdLines + 1),
          "<< :irc.test 376 iirc :End of /MOTD command.",
          "<< :irc.test 251 iirc :There are 3 users",
          "?? activity Numeric 251 in=network :There are 3 users"
        ),
      ],
    });

    const [motd, ...more] = motdsOf(played);

    expect(more).toStrictEqual([]);
    expect(motd?._tag === "Motd" ? motd.lines.at(-1) : undefined).toBe(
      `- line ${maxMotdLines - 1}`
    );
  });

  it("that never ends is shown cut when its Connection ends", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "<< :irc.test 375 iirc :- MOTD -",
          "<< :irc.test 372 iirc :- hello",
          "== closed Reset",
          "?? activity Motd lines=1 cut in=network",
          "?? session-ended Closed Reset",
          "..."
        ),
      ],
    });

    expect(motdsOf(played)).toHaveLength(1);
  });

  it("is cut short by the next one's start", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "<< :irc.test 375 iirc :- MOTD -",
          "<< :irc.test 372 iirc :- first",
          "<< :irc.test 375 iirc :- MOTD -",
          "?? activity Motd lines=1 cut in=network",
          "<< :irc.test 372 iirc :- second",
          "<< :irc.test 376 iirc :End of /MOTD command.",
          "?? activity Motd lines=1 in=network"
        ),
      ],
    });

    expect(motdsOf(played).map((motd) => motd._tag === "Motd" && motd.lines)).toStrictEqual([
      ["- first"],
      ["- second"],
    ]);
  });

  it("takes no line or end outside one, which shows as any numeric does", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "<< :irc.test 372 iirc :- stray",
          "?? activity Numeric 372 in=network :- stray",
          "<< :irc.test 376 iirc :End of /MOTD command.",
          "?? activity Numeric 376 in=network :End of /MOTD command."
        ),
      ],
    });

    expect.assertions(0);
  });
});
