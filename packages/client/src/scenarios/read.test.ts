/**
 * Read Markers: the Owner marks a Timeline read up to an instant, which only moves
 * forward, keyed as `where` keys Timelines (ADR 0014).
 */
import { describe, expect, it } from "vitest";

import type { Step } from "../client.ts";
import { client, makeClient } from "../core.ts";
import type { Feature } from "../feature.ts";
import { FeatureName, Instant } from "../ids.ts";
import { register, registry } from "../registry.ts";
import { configured, describeNews, joined, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

// Every Line in a batch is history, as `chathistory` will make it.
const history: Feature = {
  label: (arrival) => ({
    value: arrival.batch === undefined ? arrival : { ...arrival, live: false },
  }),
  name: FeatureName.make("history"),
  needs: {},
  own: undefined,
};

const withHistory = makeClient([...registry, register(history)]);

// Every Read Marker reported, in order, as `??` writes it. A step's own time does not
// show in a Read Marker, so any instant serves as `now`.
const markers = (played: { readonly steps: readonly Step<unknown>[] }): readonly string[] =>
  played.steps.flatMap((step) =>
    step.news.flatMap((news) =>
      news._tag === "ReadMarker" ? [describeNews(news, Instant.make(0))] : []
    )
  );

describe("marking a Timeline read", () => {
  it("moves its Read Marker forward only, and reports each move", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc", ["peer"]),
        lines(
          "!! read #iirc t+5s",
          "?? read-marker t+5s in=channel:#iirc",
          // An earlier or equal instant changes nothing, so two Frontends cannot move it back.
          "!! read #iirc t+3s",
          "!! read #iirc t+5s",
          "!! read #iirc t+8s",
          "?? read-marker t+8s in=channel:#iirc"
        ),
      ],
    });

    expect(markers(played)).toStrictEqual([
      "read-marker t+5s in=channel:#iirc",
      "read-marker t+8s in=channel:#iirc",
    ]);
  });

  it("keeps one per Target, folded by the Network's casemapping", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "!! read #Foo[ t+5s",
          "?? read-marker t+5s in=channel:#foo{:#Foo[",
          // `[` and `{` are one under rfc1459, so this is the same Channel.
          "!! read #foo{ t+4s",
          "!! read Peer[ t+4s",
          "?? read-marker t+4s in=existing-direct:peer{:Peer[",
          "!! read peer{ t+2s",
          // A Channel and a nick are apart, and so is the Network's own.
          "!! read t+1s",
          "?? read-marker t+1s in=network",
          "!! read t+1s",
          "!! read #iirc t+1s",
          "?? read-marker t+1s in=channel:#iirc"
        ),
      ],
    });

    expect(markers(played)).toStrictEqual([
      "read-marker t+5s in=channel:#foo{:#Foo[",
      "read-marker t+4s in=existing-direct:peer{:Peer[",
      "read-marker t+1s in=network",
      "read-marker t+1s in=channel:#iirc",
    ]);
  });

  it("is ignored for a Target that names no one Timeline", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "!! read #a,#b t+1s",
          "?? ignored NoTimeline",
          // A list with empty items is a list all the same, though one item is left.
          "!! read #a, t+1s",
          "?? ignored NoTimeline",
          "!! read ,#a t+1s",
          "?? ignored NoTimeline",
          "!! read #a,, t+1s",
          "?? ignored NoTimeline",
          "!! read , t+1s",
          "?? ignored NoTimeline",
          "!! read $*.test t+1s",
          "?? ignored NoTimeline",
          "!! read nick@server t+1s",
          "?? ignored NoTimeline"
        ),
      ],
    });

    expect(markers(played)).toStrictEqual([]);
  });

  it("works offline, and holds across a restart", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        lines(
          "!! configure",
          "-> dial irc.test:6697 tls",
          "== closed Refused",
          "!! read #iirc t+5s"
        ),
        "?? read-marker t+5s in=channel:#iirc\n",
        lines(
          "== started",
          "-> dial irc.test:6697 tls",
          "!! read #iirc t+4s",
          "!! read #iirc t+6s"
        ),
        "?? read-marker t+6s in=channel:#iirc\n",
      ],
    });

    expect(markers(played)).toStrictEqual([
      "read-marker t+5s in=channel:#iirc",
      "read-marker t+6s in=channel:#iirc",
    ]);
  });
});

describe("a Direct Message partner's Read Marker", () => {
  it("follows their nick, live", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc", ["peer"]),
        lines(
          "!! read peer t+5s",
          "?? read-marker t+5s in=existing-direct:peer",
          "<< :peer!u@h NICK pal",
          "?? activity NickChanged peer pal in=channel:#iirc in=renamed:peer>pal",
          // The marker went with the Timeline, so the old nick has none, and the new one
          // holds t+5s.
          "!! read pal t+5s",
          "!! read peer t+1s",
          "?? read-marker t+1s in=existing-direct:peer"
        ),
      ],
    });

    expect(markers(played)).toStrictEqual([
      "read-marker t+5s in=existing-direct:peer",
      "read-marker t+1s in=existing-direct:peer",
    ]);
  });

  it("replaces the new nick's, earlier or later, since nothing says it is the same person", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc", ["peer"]),
        lines(
          "!! read peer t+5s",
          "!! read pal t+9s",
          "<< :peer!u@h NICK pal",
          // pal now holds peer's t+5s, not the stranger's later t+9s.
          "!! read pal t+5s",
          "!! read pal t+6s",
          "?? read-marker t+6s in=existing-direct:pal",
          // And the later one where the stranger's was earlier.
          "!! read other t+20s",
          "!! read pal2 t+3s",
          "<< :other!u@h NICK pal2",
          "!! read pal2 t+20s",
          "!! read pal2 t+21s",
          "?? read-marker t+21s in=existing-direct:pal2",
          // A partner with no marker leaves the new nick with none, not the stranger's.
          "!! read pal3 t+30s",
          "<< :quiet!u@h NICK pal3",
          "!! read pal3 t+1s",
          "?? read-marker t+1s in=existing-direct:pal3"
        ),
      ],
    });

    expect(markers(played)).toStrictEqual([
      "read-marker t+5s in=existing-direct:peer",
      "read-marker t+9s in=existing-direct:pal",
      "read-marker t+6s in=existing-direct:pal",
      "read-marker t+20s in=existing-direct:other",
      "read-marker t+3s in=existing-direct:pal2",
      "read-marker t+21s in=existing-direct:pal2",
      "read-marker t+30s in=existing-direct:pal3",
      "read-marker t+1s in=existing-direct:pal3",
    ]);
  });

  it("stays with the old nick for a rename from history", () => {
    const played = play(withHistory, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["batch"] }),
        joined(base, "#iirc", ["peer"]),
        lines(
          "!! read peer t+5s",
          "<< :irc.test BATCH +h chathistory peer",
          "<< @batch=h :peer!u@h NICK pal",
          "<< :irc.test BATCH -h",
          "!! read peer t+5s",
          "!! read pal t+1s",
          "?? read-marker t+1s in=existing-direct:pal"
        ),
      ],
    });

    expect(markers(played)).toStrictEqual([
      "read-marker t+5s in=existing-direct:peer",
      "read-marker t+1s in=existing-direct:pal",
    ]);
  });
});

describe("a new casemapping", () => {
  it("folds Read Markers again, keeping the later where two meet", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          // Under rfc1459, `[` and `{` are one; under ascii, two.
          "!! read #a[ t+5s",
          "!! read Peer[ t+2s",
          "!! read peer{ t+3s",
          "<< :irc.test 005 iirc CASEMAPPING=ascii :are supported by this server",
          "?? refolded ascii",
          // Peer[ held t+3s, keyed again as peer[.
          "!! read peer[ t+3s",
          "!! read peer[ t+4s",
          "?? read-marker t+4s in=existing-direct:peer[",
          // peer{ and #a{ are apart from peer[ and #a[ now.
          "!! read PEER{ t+7s",
          "?? read-marker t+7s in=existing-direct:peer{:PEER{",
          "!! read #a{ t+1s",
          "?? read-marker t+1s in=channel:#a{",
          "!! read #a[ t+5s",
          // Back to rfc1459, they meet again: the first marked keeps its name, and the
          // later instant is kept.
          "<< :irc.test 005 iirc CASEMAPPING=rfc1459 :are supported by this server",
          "?? refolded rfc1459",
          "!! read peer{ t+7s",
          "!! read PEER[ t+8s",
          "?? read-marker t+8s in=existing-direct:peer{:PEER[",
          "!! read #A{ t+5s",
          "!! read #A{ t+6s",
          "?? read-marker t+6s in=channel:#a{:#A{"
        ),
      ],
    });

    expect(markers(played)).toStrictEqual([
      "read-marker t+5s in=channel:#a{:#a[",
      "read-marker t+2s in=existing-direct:peer{:Peer[",
      "read-marker t+3s in=existing-direct:peer{",
      "read-marker t+4s in=existing-direct:peer[",
      "read-marker t+7s in=existing-direct:peer{:PEER{",
      "read-marker t+1s in=channel:#a{",
      "read-marker t+8s in=existing-direct:peer{:PEER[",
      "read-marker t+6s in=channel:#a{:#A{",
    ]);
  });
});
