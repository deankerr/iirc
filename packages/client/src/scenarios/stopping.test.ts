/**
 * Shutting down and Lines that never left: `Stopping` says `QUIT`, hangs up, and shuts
 * the gate until the next `Started`. `Unsent` refuses a `Say` whose Line did not leave.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import type { News } from "../news.ts";
import { configured, joined, play, registered } from "../testing/index.ts";
import type { Played } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const inChannel = (...offered: readonly string[]) => [
  registered(base, { offered }),
  joined(base, "#iirc", ["peer"]),
];

const said = (intent: number, text = "hello") =>
  lines(
    `!! say #iirc :${text}`,
    `>> PRIVMSG #iirc ${text}`,
    `?? message Privmsg iirc #iirc at=ours:t+0s ours=i${intent} :${text}`
  );

// Every `Refused` the last step reported.
const refusedLast = <State>(played: Played<State>): readonly News[] =>
  (played.steps.at(-1)?.news ?? []).filter((news) => news._tag === "Refused");

describe("Stopping", () => {
  it("says QUIT and hangs up a Session, and dials nothing until the next Started", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        ...inChannel(),
        lines(
          "== stopping",
          ">> QUIT",
          "-> hangup",
          "!! say #iirc :too late",
          "?? refused i1 Offline",
          "== closed HungUp",
          "?? session-ended Closed HungUp",
          "!! configure",
          "!! retry",
          "?? ignored NotNow Retry",
          "+10m",
          "!! say #iirc :still too late",
          "?? refused i2 Offline",
          "== started",
          "-> dial irc.test:6697 tls"
        ),
      ],
    });

    expect(client.inspect(played.state).states.network).toBe("Connection.Dialing");
  });

  it("ends a wait to redial, and fires nothing", () => {
    const played = play(client, {
      configuration: base,
      transcript: lines(
        "!! configure",
        "-> dial irc.test:6697 tls",
        "== closed Refused",
        "== stopping",
        "+10m",
        "== started",
        "-> dial irc.test:6697 tls"
      ),
    });

    expect(played.steps[2]?.outputs).toStrictEqual([{ _tag: "Wake", at: null, timer: "redial" }]);
  });

  it("hangs up a Connection still dialling without a QUIT", () => {
    play(client, {
      configuration: base,
      transcript: lines(
        "!! configure",
        "-> dial irc.test:6697 tls",
        "== stopping",
        "-> hangup",
        "== closed HungUp",
        "?? connection-failed Closed HungUp",
        "+10m"
      ),
    });

    expect.assertions(0);
  });

  it("says QUIT while registering, before any Session", () => {
    play(client, {
      configuration: base,
      transcript: lines(
        "!! configure",
        "-> dial irc.test:6697 tls",
        "== opened",
        ">> CAP LS 302",
        ">> NICK iirc",
        ">> USER iirc 0 * iirc",
        "== stopping",
        ">> QUIT",
        "-> hangup"
      ),
    });

    expect.assertions(0);
  });

  it("with no Connection only shuts the gate, even before the first Configured", () => {
    const played = play(client, {
      configuration: base,
      transcript: lines(
        "== stopping",
        "!! configure",
        "+1m",
        "== started",
        "-> dial irc.test:6697 tls"
      ),
    });

    expect(played.steps.slice(0, 2).map((step) => step.outputs)).toStrictEqual([[], []]);
  });

  it("leaves a disabled Network idle after the next Started", () => {
    const off = configured({ enabled: false });

    const played = play(client, {
      configuration: off,
      transcript: lines("!! configure", "== stopping", "== started", "+1m"),
    });

    expect(client.inspect(played.state).states.network).toBe("Idle");
  });

  it("sends nothing more after a Stopping that came while hanging up", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel(),
        lines(
          "!! configure disable",
          ">> QUIT",
          "-> hangup",
          "== stopping",
          "== closed HungUp",
          "?? session-ended Disabled",
          "!! configure enable",
          "== started",
          "-> dial irc.test:6697 tls"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("dials again on the Started after a stop that began mid-hangup", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        ...inChannel(),
        lines("== stopping", ">> QUIT", "-> hangup", "== started", "-> dial irc.test:6697 tls"),
      ],
    });

    expect(client.inspect(played.state).connection).toBe(2);
  });
});

describe("Unsent", () => {
  it("refuses a Say whose Line never left", () => {
    const played = play(client, {
      configuration: base,
      transcript: [...inChannel(), said(1), lines("== unsent 1", "?? refused i1 Unsent")],
    });

    expect(played.steps.at(-1)?.outputs).toStrictEqual([]);
  });

  it("names the Say's intent on its Send, and on no other Line", () => {
    const played = play(client, {
      configuration: base,
      transcript: [...inChannel(), said(1)],
    });

    const sends = played.steps.flatMap((step) =>
      step.outputs.flatMap((output) => (output._tag === "Send" ? [output] : []))
    );

    expect(
      sends.filter((send) => send.intent !== undefined).map((send) => send.intent)
    ).toStrictEqual(["i1"]);
    expect(sends.at(-1)).toMatchObject({ intent: "i1" });
  });

  it("refuses each Say once, in the order its Lines were sent", () => {
    const played = play(client, {
      configuration: base,
      transcript: [...inChannel(), said(1), said(2, "again"), lines("== unsent 2")],
    });

    expect(refusedLast(played)).toStrictEqual([
      { _tag: "Refused", intent: "i1", reason: { _tag: "Unsent" } },
      { _tag: "Refused", intent: "i2", reason: { _tag: "Unsent" } },
    ]);
  });

  it("changes nothing for a Line that is not a Say's", () => {
    const played = play(client, {
      configuration: base,
      transcript: [...inChannel(), lines("<< PING :keep", ">> PONG keep", "== unsent 1")],
    });

    expect(played.steps.at(-1)).toMatchObject({ news: [], outputs: [] });
  });

  it("refuses nothing the Ircd already confirmed", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        ...inChannel("batch", "echo-message", "labeled-response"),
        lines(
          "!! say #iirc :hello",
          ">> @label=l1 PRIVMSG #iirc hello",
          "<< @label=l1 :iirc!u@h PRIVMSG #iirc :hello",
          "?? confirmed i1 :hello",
          "== unsent 1"
        ),
      ],
    });

    expect(refusedLast(played)).toStrictEqual([]);
  });

  it("refuses a Say whose Connection has ended since", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel(),
        said(1),
        lines(
          "== closed Reset",
          "?? session-ended Closed Reset",
          "== connection 1",
          "== unsent 1",
          "?? refused i1 Unsent"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("refuses a Say left queued behind the QUIT when the Ircd closes first", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel(),
        said(1),
        lines(
          "== stopping",
          ">> QUIT",
          "-> hangup",
          "== unsent 2",
          "?? refused i1 Unsent",
          "== closed Ended",
          "?? session-ended Closed HungUp"
        ),
      ],
    });

    expect.assertions(0);
  });
});
