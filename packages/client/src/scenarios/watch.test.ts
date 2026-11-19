/**
 * `WATCH`: where an Ircd offers it and not `MONITOR`, the Client keeps the same list
 * through it, and a Frontend sees exactly what it sees with `MONITOR`. Only the Lines differ.
 */
import { encode, isRejected } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import type { News } from "../news.ts";
import type { State } from "../state.ts";
import { configured, floorIsupport, play, registered } from "../testing/index.ts";
import type { Played } from "../testing/index.ts";

const base = configured({ nicks: ["iirc", "other"] });

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

// Registration on a Connection that is already open, where `iirc` is taken, so Self
// settles for `other`. The `005` carries `offer`, and what that sends is the caller's.
const registering = (offer: string) =>
  lines(
    "== opened",
    ">> CAP LS 302",
    ">> NICK iirc",
    ">> USER iirc 0 * iirc",
    "<< :irc.test 421 * CAP :Unknown command",
    "<< :irc.test 433 * iirc :Nickname is already in use",
    ">> NICK other",
    "<< :irc.test 001 other :Welcome other",
    `<< :irc.test 005 other ${[...floorIsupport, offer].join(" ")} :are supported by this server`
  );

// The first Session, settled for `other`, with the token given.
const settled = (offer: string) =>
  lines("!! configure", "-> dial irc.test:6697 tls") + registering(offer);

const reconnected = (offer: string) =>
  lines("== closed Reset", "+2s", "-> dial irc.test:6697 tls") + registering(offer);

const played = (...transcript: readonly string[]) =>
  play(client, { configuration: base, transcript });

const text = new TextDecoder();

// Every Line with this command the Client sent, as it went on the wire, without CRLF.
const sent = (run: Played<State>, command: string): readonly string[] =>
  run.steps
    .flatMap((step) => step.outputs)
    .flatMap((output) => {
      const bytes =
        output._tag === "Send" && output.line.command === command ? encode(output.line) : undefined;

      return bytes === undefined || isRejected(bytes) ? [] : [text.decode(bytes).trimEnd()];
    });

const news = (run: Played<State>): readonly News[] => run.steps.flatMap((step) => step.news);

describe("WATCH", () => {
  it("keeps the same list as MONITOR, cut to WATCH's limit", () => {
    played(
      settled("WATCH=3"),
      lines(
        ">> WATCH +iirc",
        "<< :alice!u@h PRIVMSG other :hi",
        ">> WATCH +alice",
        "<< :bob!u@h PRIVMSG other :hi",
        ">> WATCH +bob",
        "<< :carol!u@h PRIVMSG other :hi",
        ">> WATCH -alice",
        ">> WATCH +carol",
        "!! close carol",
        "?? timeline-closed in=existing-direct:carol",
        ">> WATCH -carol",
        ">> WATCH +alice"
      ),
      reconnected("WATCH=2"),
      lines(">> WATCH +iirc +bob")
    );

    expect.assertions(0);
  });

  it("splits a long list so each Line has no more parameters than a Line may", () => {
    const partners = Array.from(
      { length: 40 },
      (_unused, index) => `partner${String(index).padStart(2, "0")}`
    );

    const again = play(client, {
      configuration: configured(),
      transcript: [
        registered(configured(), { isupport: [...floorIsupport, "WATCH=128"] }),
        lines(...partners.flatMap((nick) => [`<< :${nick}!u@h PRIVMSG iirc :hi`, "..."])),
        lines("== closed Reset", "+2s", "-> dial irc.test:6697 tls", "== opened", "..."),
        lines(
          "<< :irc.test 001 iirc :Welcome",
          `<< :irc.test 005 iirc ${[...floorIsupport, "WATCH=128"].join(" ")} :are supported`,
          "..."
        ),
      ],
    });

    const resent = sent(again, "WATCH").slice(partners.length);

    expect(resent).toHaveLength(3);
    expect(resent.flatMap((each) => each.replace("WATCH ", "").split(" "))).toStrictEqual(
      partners.toReversed().map((nick) => `+${nick}`)
    );
  });

  it("takes the preferred nick back when WATCH first says it is offline, and asks once each time", () => {
    played(
      settled("WATCH"),
      lines(
        ">> WATCH +iirc",
        "<< :irc.test 605 other iirc * * 0 :is offline",
        ">> NICK iirc",
        "<< :irc.test 433 other iirc :Nickname is already in use",
        "<< :irc.test 601 other iirc u h 1767225600 :logged offline",
        "<< :irc.test 600 other iirc u h 1767225601 :logged online",
        "<< :irc.test 601 other iirc u h 1767225602 :logged offline",
        ">> NICK iirc",
        "<< :other!~iirc@iirc.test NICK :iirc",
        ">> WATCH -iirc",
        "<< :irc.test 602 iirc iirc u h 1767225602 :stopped watching"
      )
    );

    expect.assertions(0);
  });

  it("never resends a nick a full list refused, for the rest of the Connection", () => {
    played(
      settled("WATCH"),
      lines(
        ">> WATCH +iirc",
        "<< :alice!u@h PRIVMSG other :hi",
        ">> WATCH +alice",
        "<< :irc.test 512 other alice :Maximum size for WATCH-list is 1 entries",
        "<< :bob!u@h PRIVMSG other :hi",
        ">> WATCH +bob",
        "<< :alice!u@h PRIVMSG other :hello?"
      )
    );

    expect.assertions(0);
  });

  it("turns watching off for the Connection when the Ircd refuses the command", () => {
    played(
      settled("WATCH"),
      lines(
        ">> WATCH +iirc",
        "<< :irc.test 421 other WATCH :Unknown command",
        "<< :alice!u@h PRIVMSG other :hi"
      ),
      reconnected("WATCH"),
      lines(">> WATCH +iirc +alice")
    );

    expect.assertions(0);
  });
});

// One story, told by each: alice is messaged, found online, goes, and comes back, a
// stranger's word is no partner's, and bob is found offline.
const story = (monitor: boolean) =>
  played(
    settled(monitor ? "MONITOR=100" : "WATCH=128"),
    lines(monitor ? ">> MONITOR + iirc" : ">> WATCH +iirc"),
    lines(
      "<< :alice!u@h PRIVMSG other :hi",
      monitor ? ">> MONITOR + alice" : ">> WATCH +alice",
      monitor
        ? "<< :irc.test 730 other :alice!a@alice.host"
        : "<< :irc.test 604 other alice a alice.host 1767225600 :is online",
      "?? partner-learned partner:alice",
      monitor
        ? "<< :irc.test 731 other :alice"
        : "<< :irc.test 601 other alice a alice.host 1767225601 :logged offline",
      "?? activity WentOffline alice in=existing-direct:alice",
      monitor
        ? "<< :irc.test 730 other :alice!a@alice.host"
        : "<< :irc.test 600 other alice a alice.host 1767225602 :logged online",
      "?? activity CameOnline alice in=existing-direct:alice",
      monitor
        ? "<< :irc.test 730 other :stranger!u@h"
        : "<< :irc.test 600 other stranger u h 1767225603 :logged online",
      "<< :bob!u@h PRIVMSG other :hi",
      monitor ? ">> MONITOR + bob" : ">> WATCH +bob",
      monitor ? "<< :irc.test 731 other :bob" : "<< :irc.test 605 other bob * * 0 :is offline",
      "?? partner-learned partner:bob"
    )
  );

describe("the same presence through MONITOR and WATCH", () => {
  it("tells a Frontend the same News and Knowledge", () => {
    const monitored = story(true);
    const watched = story(false);

    expect(news(watched)).toStrictEqual(news(monitored));
    expect(client.known(watched.state).partners).toStrictEqual(
      client.known(monitored.state).partners
    );
  });
});

describe("choosing between MONITOR and WATCH", () => {
  it("uses MONITOR where both are offered", () => {
    played(settled("MONITOR=100 WATCH=128"), lines(">> MONITOR + iirc"));

    expect.assertions(0);
  });

  it("moves the list to MONITOR when a later 005 offers it", () => {
    played(
      settled("WATCH=128"),
      lines(
        ">> WATCH +iirc",
        "<< :irc.test 005 other MONITOR=100 :are supported by this server",
        ">> WATCH -iirc",
        ">> MONITOR + iirc"
      )
    );

    expect.assertions(0);
  });

  it("reads no WATCH numeric while it uses MONITOR", () => {
    played(
      settled("MONITOR WATCH"),
      lines(">> MONITOR + iirc", "<< :irc.test 605 other iirc * * 0 :is offline")
    );

    expect.assertions(0);
  });
});
