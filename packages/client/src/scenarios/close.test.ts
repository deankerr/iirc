/**
 * Closing a Timeline: the Owner puts a Direct Message Timeline, or a Channel's Self is not
 * in, out of the Sidebar. The Client only says which Timeline, keyed as `where` keys them,
 * and keeps nothing: whether it is closed is the projection's to derive.
 */
import { describe, expect, it } from "vitest";

import type { Step } from "../client.ts";
import { client } from "../core.ts";
import { Instant } from "../ids.ts";
import { configured, describeNews, joined, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

// Every close reported and every close ignored, in order, as `??` writes them.
const closes = (played: { readonly steps: readonly Step<unknown>[] }): readonly string[] =>
  played.steps.flatMap((step) =>
    step.news.flatMap((news) =>
      news._tag === "TimelineClosed" || news._tag === "Ignored"
        ? [describeNews(news, Instant.make(0))]
        : []
    )
  );

describe("closing a Timeline", () => {
  it("reports a Direct Message partner's, keyed by the Network's casemapping", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("!! close Peer[", "?? timeline-closed in=existing-direct:peer{:Peer["),
      ],
    });

    expect(closes(played)).toStrictEqual(["timeline-closed in=existing-direct:peer{:Peer["]);
  });

  it("is ignored for a Channel Self is in, and reported once Self has left it", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc", ["peer"]),
        lines(
          "!! close #IIRC",
          "?? ignored Joined",
          "<< :iirc!~iirc@iirc.test PART #iirc :forced",
          "!! close #iirc",
          "?? timeline-closed in=channel:#iirc"
        ),
      ],
    });

    expect(closes(played)).toStrictEqual(["ignored Joined", "timeline-closed in=channel:#iirc"]);
  });

  it("reports a Channel Self never joined, which may hold what was said before", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("!! close #elsewhere", "?? timeline-closed in=channel:#elsewhere"),
      ],
    });

    expect(closes(played)).toStrictEqual(["timeline-closed in=channel:#elsewhere"]);
  });

  it("is ignored for a Target that names no one Timeline, or the Network's own", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "!! close #a,#b",
          "?? ignored NoTimeline",
          "!! close $*.test",
          "?? ignored NoTimeline",
          "!! close nick@server",
          "?? ignored NoTimeline"
        ),
      ],
    });

    expect(closes(played)).toStrictEqual([
      "ignored NoTimeline",
      "ignored NoTimeline",
      "ignored NoTimeline",
    ]);
  });

  it("works offline", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        lines(
          "!! configure",
          "-> dial irc.test:6697 tls",
          "== closed Refused",
          "!! close peer",
          "?? timeline-closed in=existing-direct:peer"
        ),
      ],
    });

    expect(closes(played)).toStrictEqual(["timeline-closed in=existing-direct:peer"]);
  });
});
