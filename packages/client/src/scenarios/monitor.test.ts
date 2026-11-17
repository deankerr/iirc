/**
 * `MONITOR`: where an Ircd offers it, the Client monitors the preferred nick it settled
 * without and each open Direct Message partner, and is told when they come and go.
 */
import { encode, isRejected } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import type { News } from "../news.ts";
import type { State } from "../state.ts";
import { configured, floorIsupport, joined, play, registered } from "../testing/index.ts";
import type { Played } from "../testing/index.ts";

const base = configured({ nicks: ["iirc", "other"] });

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const tokens = (monitor: string) => [...floorIsupport, monitor].join(" ");

// Registration on a Connection that is already open, where `iirc` is taken, so Self
// settles for `other`. The `005` carries `monitor`, and what that sends is the caller's.
const registering = (monitor: string) =>
  lines(
    "== opened",
    ">> CAP LS 302",
    ">> NICK iirc",
    ">> USER iirc 0 * iirc",
    "<< :irc.test 421 * CAP :Unknown command",
    "<< :irc.test 433 * iirc :Nickname is already in use",
    ">> NICK other",
    "<< :irc.test 001 other :Welcome other",
    `<< :irc.test 005 other ${tokens(monitor)} :are supported by this server`
  );

// The first Session, settled for `other`, with `MONITOR` as given.
const settled = (monitor: string) =>
  lines("!! configure", "-> dial irc.test:6697 tls") + registering(monitor);

// The Connection ends, and the next Session begins after the first wait.
const reconnected = (monitor: string) =>
  lines("== closed Reset", "+2s", "-> dial irc.test:6697 tls") + registering(monitor);

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

const presence = (run: Played<State>) =>
  news(run).flatMap((each) =>
    each._tag === "Activity" &&
    (each.activity._tag === "CameOnline" || each.activity._tag === "WentOffline")
      ? [`${each.activity._tag} ${each.activity.nick}`]
      : []
  );

describe("MONITOR", () => {
  it("monitors the preferred nick Self settled without, as the Session's ISUPPORT offers it", () => {
    const run = played(settled("MONITOR=100"), lines(">> MONITOR + iirc"));

    expect(sent(run, "MONITOR")).toStrictEqual(["MONITOR + iirc"]);
  });

  it("monitors each partner a Direct Message opens, most recent first, cut to MONITOR's limit", () => {
    const run = played(
      settled("MONITOR=3"),
      lines(
        ">> MONITOR + iirc",
        "<< :alice!u@h PRIVMSG other :hi",
        ">> MONITOR + alice",
        "<< :bob!u@h PRIVMSG other :hi",
        ">> MONITOR + bob",
        "# The limit leaves out the partner messaged longest ago.",
        "<< :carol!u@h PRIVMSG other :hi",
        ">> MONITOR - alice",
        ">> MONITOR + carol",
        "<< :alice!u@h PRIVMSG other :back again",
        ">> MONITOR - bob",
        ">> MONITOR + alice",
        "# A Message from a partner already monitored changes nothing that fits.",
        "<< :carol!u@h PRIVMSG other :still here"
      )
    );

    expect(sent(run, "MONITOR")).toStrictEqual([
      "MONITOR + iirc",
      "MONITOR + alice",
      "MONITOR + bob",
      "MONITOR - alice",
      "MONITOR + carol",
      "MONITOR - bob",
      "MONITOR + alice",
    ]);
  });

  it("monitors a partner Self wrote to first", () => {
    const run = played(
      settled("MONITOR"),
      lines(">> MONITOR + iirc", "!! say alice :hi", ">> PRIVMSG alice hi", ">> MONITOR + alice")
    );

    expect(sent(run, "MONITOR")).toStrictEqual(["MONITOR + iirc", "MONITOR + alice"]);
  });

  it("stops monitoring a partner whose Timeline the Owner closed", () => {
    const run = played(
      settled("MONITOR"),
      lines(
        ">> MONITOR + iirc",
        "<< :alice!u@h PRIVMSG other :hi",
        ">> MONITOR + alice",
        "!! close alice",
        "?? timeline-closed in=existing-direct:alice",
        ">> MONITOR - alice"
      )
    );

    expect(sent(run, "MONITOR")).toStrictEqual([
      "MONITOR + iirc",
      "MONITOR + alice",
      "MONITOR - alice",
    ]);
  });

  it("follows a partner's rename seen in a shared Channel", () => {
    const run = played(
      settled("MONITOR"),
      lines(">> MONITOR + iirc"),
      joined(base, "#iirc", ["alice"], { nick: "other" }),
      lines(
        "<< :alice!u@h PRIVMSG other :hi",
        ">> MONITOR + alice",
        "<< :alice!u@h NICK alicia",
        ">> MONITOR - alice",
        ">> MONITOR + alicia"
      )
    );

    expect(sent(run, "MONITOR")).toStrictEqual([
      "MONITOR + iirc",
      "MONITOR + alice",
      "MONITOR - alice",
      "MONITOR + alicia",
    ]);
  });

  it("stops monitoring the preferred nick once Self regains it", () => {
    const run = played(
      settled("MONITOR"),
      lines(
        ">> MONITOR + iirc",
        "<< :irc.test 731 other :iirc",
        ">> NICK iirc",
        "<< :other!~iirc@iirc.test NICK :iirc",
        ">> MONITOR - iirc"
      )
    );

    expect(client.known(run.state).self?.nick).toBe("iirc");
  });

  it("never asks again for a nick Self was renamed off unasked, until the next Session", () => {
    const run = played(
      settled("MONITOR"),
      lines(
        ">> MONITOR + iirc",
        "<< :irc.test 731 other :iirc",
        ">> NICK iirc",
        "<< :other!~iirc@iirc.test NICK :iirc",
        ">> MONITOR - iirc",
        "# Services rename Self off the nick, with no NICK of ours.",
        "<< :iirc!~iirc@iirc.test NICK :Guest1",
        "<< :irc.test 731 Guest1 :iirc"
      ),
      reconnected("MONITOR"),
      lines(">> MONITOR + iirc")
    );

    expect([sent(run, "NICK"), sent(run, "MONITOR")]).toStrictEqual([
      ["NICK iirc", "NICK other", "NICK iirc", "NICK iirc", "NICK other"],
      ["MONITOR + iirc", "MONITOR - iirc", "MONITOR + iirc"],
    ]);
  });

  it("lets a partner's rename onto another partner's nick take that nick's place, as its Timeline does", () => {
    const run = played(
      settled("MONITOR"),
      lines(">> MONITOR + iirc"),
      joined(base, "#iirc", ["alice"], { nick: "other" }),
      lines(
        "<< :alicia!u@h PRIVMSG other :an old Timeline",
        ">> MONITOR + alicia",
        "<< :bob!u@h PRIVMSG other :hi",
        ">> MONITOR + bob",
        "<< :alice!u@h PRIVMSG other :hi",
        ">> MONITOR + alice",
        "<< :alice!u@h NICK alicia",
        ">> MONITOR - alice"
      )
    );

    expect([...client.known(run.state).partners.keys()]).toStrictEqual(["bob", "alicia"]);
  });

  it("never monitors the preferred nick once the Owner chose a nick this Session", () => {
    const run = played(
      settled("MONITOR"),
      lines(
        ">> MONITOR + iirc",
        "!! nick mine",
        ">> NICK mine",
        ">> MONITOR - iirc",
        "<< :other!~iirc@iirc.test NICK :mine"
      )
    );

    expect(sent(run, "MONITOR")).toStrictEqual(["MONITOR + iirc", "MONITOR - iirc"]);
  });

  it("sends the whole list again as each Session begins, in the stated order", () => {
    const run = played(
      settled("MONITOR"),
      lines(
        ">> MONITOR + iirc",
        "<< :alice!u@h PRIVMSG other :hi",
        ">> MONITOR + alice",
        "<< :bob!u@h PRIVMSG other :hi",
        ">> MONITOR + bob"
      ),
      reconnected("MONITOR=2"),
      lines(">> MONITOR + iirc,bob")
    );

    expect(sent(run, "MONITOR")).toStrictEqual([
      "MONITOR + iirc",
      "MONITOR + alice",
      "MONITOR + bob",
      "MONITOR + iirc,bob",
    ]);
  });

  it("splits a long list so each Line fits", () => {
    const partners = Array.from(
      { length: 60 },
      (_unused, index) => `partner${String(index).padStart(2, "0")}`
    );

    const again = play(client, {
      configuration: configured(),
      transcript: [
        registered(configured(), { isupport: [...floorIsupport, "MONITOR"] }),
        lines(...partners.flatMap((nick) => [`<< :${nick}!u@h PRIVMSG iirc :hi`, "..."])),
        lines("== closed Reset", "+2s", "-> dial irc.test:6697 tls", "== opened", "..."),
        lines(
          "<< :irc.test 001 iirc :Welcome",
          `<< :irc.test 005 iirc ${tokens("MONITOR")} :are supported by this server`,
          "..."
        ),
      ],
    });

    const resent = sent(again, "MONITOR").slice(partners.length);

    expect(resent.length).toBeGreaterThan(1);
    expect(resent.flatMap((each) => each.replace("MONITOR + ", "").split(","))).toStrictEqual(
      partners.toReversed()
    );
  });

  it("reports a partner coming and going only on a change from what the Connection knew", () => {
    const run = played(
      settled("MONITOR"),
      lines(
        ">> MONITOR + iirc",
        "<< :alice!u@h PRIVMSG other :hi",
        ">> MONITOR + alice",
        "# The first status after `MONITOR +` is silent.",
        "<< :irc.test 730 other :alice!u@alice.host",
        "<< :irc.test 730 other :alice!u@alice.host",
        "<< :irc.test 731 other :alice",
        "?? activity WentOffline alice in=existing-direct:alice",
        "<< :irc.test 731 * :alice",
        "<< :irc.test 730 * :alice!u@alice.host",
        "?? activity CameOnline alice in=existing-direct:alice"
      )
    );

    expect(presence(run)).toStrictEqual(["WentOffline alice", "CameOnline alice"]);
  });

  it("is told nothing a second time of a partner seen to quit in a shared Channel", () => {
    const run = played(
      settled("MONITOR"),
      lines(">> MONITOR + iirc"),
      joined(base, "#iirc", ["alice"], { nick: "other" }),
      lines(
        "<< :alice!u@h PRIVMSG other :hi",
        ">> MONITOR + alice",
        "<< :irc.test 730 other :alice!u@h",
        "<< :alice!u@h QUIT :bye",
        "<< :irc.test 731 other :alice"
      )
    );

    expect(presence(run)).toStrictEqual([]);
  });

  it("reports nothing in a Timeline for a nick that is not a partner's", () => {
    const run = played(
      settled("MONITOR"),
      lines(
        ">> MONITOR + iirc",
        "<< :irc.test 730 other :iirc!u@h",
        "<< :irc.test 730 other :stranger!u@h"
      )
    );

    expect(presence(run)).toStrictEqual([]);
  });

  it("takes the preferred nick back when MONITOR first reports it offline", () => {
    const run = played(
      settled("MONITOR"),
      lines(">> MONITOR + iirc", "<< :irc.test 731 other :iirc", ">> NICK iirc")
    );

    expect(sent(run, "MONITOR")).toStrictEqual(["MONITOR + iirc"]);
  });

  it("asks once for each time the preferred nick goes offline, and never retries a refusal", () => {
    const run = played(
      settled("MONITOR"),
      lines(
        ">> MONITOR + iirc",
        "<< :irc.test 730 other :iirc!u@h",
        "<< :irc.test 731 other :iirc",
        ">> NICK iirc",
        "<< :irc.test 433 other iirc :Nickname is already in use",
        "+30s",
        "<< :irc.test 731 other :iirc",
        "+30s",
        "<< :irc.test 730 other :iirc!u@h",
        "<< :irc.test 731 other :iirc",
        ">> NICK iirc"
      )
    );

    expect(sent(run, "NICK")).toStrictEqual(["NICK iirc", "NICK other", "NICK iirc", "NICK iirc"]);
  });

  it("asks once when the holder is seen to quit and MONITOR then reports it", () => {
    const run = played(
      settled("MONITOR"),
      lines(">> MONITOR + iirc"),
      joined(base, "#iirc", ["iirc"], { nick: "other" }),
      lines(
        "<< :irc.test 730 other :iirc!u@h",
        "<< :iirc!u@h QUIT :bye",
        ">> NICK iirc",
        "<< :irc.test 433 other iirc :Nickname is already in use",
        "<< :irc.test 731 other :iirc"
      )
    );

    expect(sent(run, "NICK")).toStrictEqual(["NICK iirc", "NICK other", "NICK iirc"]);
  });

  it("asks once when MONITOR reports the holder gone before the quit is seen", () => {
    const run = played(
      settled("MONITOR"),
      lines(">> MONITOR + iirc"),
      joined(base, "#iirc", ["iirc"], { nick: "other" }),
      lines(
        "<< :irc.test 730 other :iirc!u@h",
        "<< :irc.test 731 other :iirc",
        ">> NICK iirc",
        "<< :irc.test 433 other iirc :Nickname is already in use",
        "<< :iirc!u@h QUIT :bye"
      )
    );

    expect(sent(run, "NICK")).toStrictEqual(["NICK iirc", "NICK other", "NICK iirc"]);
  });

  it("never resends targets a full list refused, for the rest of the Connection", () => {
    const run = played(
      settled("MONITOR"),
      lines(
        ">> MONITOR + iirc",
        "<< :alice!u@h PRIVMSG other :hi",
        ">> MONITOR + alice",
        "<< :irc.test 734 other 1 alice :Monitor list is full.",
        "<< :bob!u@h PRIVMSG other :hi",
        ">> MONITOR + bob",
        "<< :alice!u@h PRIVMSG other :hello?"
      ),
      reconnected("MONITOR"),
      lines(">> MONITOR + iirc,alice,bob")
    );

    expect(client.known(run.state).partners.get("alice")?.here).toStrictEqual({ _tag: "Unknown" });
  });

  it("turns monitoring off for the Connection when the Ircd refuses the command", () => {
    const run = played(
      settled("MONITOR"),
      lines(
        ">> MONITOR + iirc",
        "<< :irc.test 421 other MONITOR :Unknown command",
        "<< :alice!u@h PRIVMSG other :hi",
        "<< :irc.test 731 other :iirc"
      ),
      reconnected("MONITOR"),
      lines(">> MONITOR + iirc,alice")
    );

    expect(sent(run, "MONITOR")).toStrictEqual(["MONITOR + iirc", "MONITOR + iirc,alice"]);
  });

  it("turns monitoring off for the Connection on a FAIL naming MONITOR", () => {
    const run = played(
      settled("MONITOR"),
      lines(
        ">> MONITOR + iirc",
        "<< :irc.test FAIL MONITOR TEMPORARILY_UNAVAILABLE :Try later",
        "...",
        "<< :alice!u@h PRIVMSG other :hi"
      )
    );

    expect(sent(run, "MONITOR")).toStrictEqual(["MONITOR + iirc"]);
  });

  it("changes nothing without MONITOR in ISUPPORT", () => {
    const run = played(
      settled("NETWORK=iirc-test"),
      joined(base, "#iirc", ["iirc", "alice"], { nick: "other" }),
      lines(
        "<< :alice!u@h PRIVMSG other :hi",
        "<< :bob!u@h PRIVMSG other :hi",
        "!! close bob",
        "?? timeline-closed in=existing-direct:bob",
        "<< :irc.test 731 other :iirc",
        "<< :irc.test 730 other :alice!u@h",
        "<< :alice!u@h QUIT :bye",
        "<< :iirc!u@h QUIT :bye",
        ">> NICK iirc"
      )
    );

    expect(sent(run, "MONITOR")).toStrictEqual([]);
    expect(presence(run)).toStrictEqual([]);
  });
});

describe("whether a partner is here", () => {
  it("is known from a shared Channel, from MONITOR, and unknown otherwise", () => {
    const run = played(
      settled("MONITOR"),
      lines(">> MONITOR + iirc"),
      joined(base, "#iirc", ["alice"], { nick: "other" }),
      lines(
        "<< :alice!u@h PRIVMSG other :hi",
        ">> MONITOR + alice",
        "<< :bob!u@h PRIVMSG other :hi",
        ">> MONITOR + bob",
        "<< :carol!u@h PRIVMSG other :hi",
        ">> MONITOR + carol",
        "<< :irc.test 731 other :bob",
        "<< :irc.test 730 other :carol!u@h"
      )
    );

    const { partners } = client.known(run.state);

    expect([...partners.keys()]).toStrictEqual(["alice", "bob", "carol"]);
    expect(partners.get("alice")).toMatchObject({
      here: { _tag: "Known", value: true },
      nick: "alice",
    });
    expect(partners.get("bob")?.here).toMatchObject({ _tag: "Known", from: "ircd", value: false });
    expect(partners.get("carol")?.here).toMatchObject({ _tag: "Known", from: "ircd", value: true });
  });

  it("is unknown with no Session, and the partners outlive it", () => {
    const run = played(
      settled("MONITOR"),
      lines(
        ">> MONITOR + iirc",
        "<< :carol!u@h PRIVMSG other :hi",
        ">> MONITOR + carol",
        "<< :irc.test 730 other :carol!u@h",
        "== closed Reset"
      )
    );

    expect(client.known(run.state).partners.get("carol")).toStrictEqual({
      here: { _tag: "Unknown" },
      nick: "carol",
    });
  });
});

// The partners News says changed, in order, by key.
const learned = (run: Played<State>) =>
  news(run).flatMap((each) => (each._tag === "PartnerLearned" ? [each.partner.key] : []));

describe("telling that a partner's presence changed", () => {
  it("tells of the first status after MONITOR +, which no Activity reports, and of no repeat", () => {
    const run = played(
      settled("MONITOR"),
      lines(
        ">> MONITOR + iirc",
        "<< :alice!u@h PRIVMSG other :hi",
        ">> MONITOR + alice",
        "<< :irc.test 730 other :alice!u@alice.host",
        "?? partner-learned partner:alice",
        "<< :irc.test 730 other :alice!u@alice.host",
        "<< :bob!u@h PRIVMSG other :hi",
        ">> MONITOR + bob",
        "<< :irc.test 731 other :bob",
        "?? partner-learned partner:bob"
      )
    );

    expect(learned(run)).toStrictEqual(["alice", "bob"]);
  });

  it("leaves a change an Activity reports to that Activity", () => {
    const run = played(
      settled("MONITOR"),
      lines(
        ">> MONITOR + iirc",
        "<< :alice!u@h PRIVMSG other :hi",
        ">> MONITOR + alice",
        "<< :irc.test 730 other :alice!u@h",
        "<< :irc.test 731 other :alice",
        "<< :irc.test 730 other :alice!u@h"
      )
    );

    expect(presence(run)).toStrictEqual(["WentOffline alice", "CameOnline alice"]);
    expect(learned(run)).toStrictEqual(["alice"]);
  });

  it("tells of a partner who shares a Channel with Self from then, and of one gone from it", () => {
    const run = played(
      settled("MONITOR"),
      lines(">> MONITOR + iirc", "<< :alice!u@h PRIVMSG other :hi", ">> MONITOR + alice"),
      joined(base, "#iirc", ["alice", "bob"], { nick: "other" }),
      lines(
        "<< :bob!u@h PART #iirc",
        "<< :alice!u@h PART #iirc",
        "?? partner-learned partner:alice"
      )
    );

    expect(learned(run)).toStrictEqual(["alice", "alice"]);
  });

  it("tells of a partner who shared only a Channel the Owner no longer wants, without MONITOR", () => {
    const run = played(
      registered(base),
      joined(base, "#iirc", ["alice"]),
      lines("<< :alice!u@h PRIVMSG iirc :hi", "!! configure -#iirc", ">> PART #iirc")
    );

    expect(learned(run)).toStrictEqual(["alice"]);
  });

  it("tells of each partner when the Session ends and they are no longer known to be here", () => {
    const run = played(
      settled("MONITOR"),
      lines(
        ">> MONITOR + iirc",
        "<< :alice!u@h PRIVMSG other :hi",
        ">> MONITOR + alice",
        "<< :irc.test 730 other :alice!u@h",
        "== closed Reset"
      )
    );

    expect(learned(run)).toStrictEqual(["alice", "alice"]);
  });

  it("tells of nothing for a nick that is not a partner's, or with no MONITOR", () => {
    const monitored = played(
      settled("MONITOR"),
      lines(">> MONITOR + iirc", "<< :irc.test 730 other :stranger!u@h")
    );

    const without = played(
      settled("NETWORK=iirc-test"),
      lines("<< :alice!u@h PRIVMSG other :hi", "<< :irc.test 730 other :alice!u@h")
    );

    expect([learned(monitored), learned(without)]).toStrictEqual([[], []]);
  });
});

describe("extended-monitor", () => {
  const solo = configured();
  const caps = ["away-notify", "account-notify", "extended-monitor"];

  const watching = (offered: readonly string[]) => [
    registered(solo, { isupport: [...floorIsupport, "MONITOR"], offered }),
    lines(
      "<< :alice!u@h PRIVMSG iirc :hi",
      ">> MONITOR + alice",
      "<< :irc.test 730 iirc :alice!a@alice.host",
      "<< :alice!a@alice.host AWAY :lunch",
      "?? activity AwayChanged alice in=existing-direct:alice :lunch",
      "<< :alice!a@alice.host ACCOUNT alice",
      "?? activity AccountChanged alice account=alice in=existing-direct:alice"
    ),
  ];

  it("keeps a monitored User's away state, account, and host, as for a User in a shared Channel", () => {
    const run = play(client, { configuration: solo, transcript: watching(caps) });
    const alice = client.known(run.state).users.get("alice");

    expect(alice?.away).toMatchObject({ _tag: "Known", value: { message: "lunch" } });
    expect(alice?.account).toMatchObject({ _tag: "Known", value: "alice" });
    expect(alice?.mask).toMatchObject({ _tag: "Known", value: { host: "alice.host", user: "a" } });
  });

  it("forgets them once MONITOR says they are gone", () => {
    const run = play(client, {
      configuration: solo,
      transcript: [
        ...watching(caps),
        lines(
          "<< :irc.test 731 iirc :alice",
          "?? activity WentOffline alice in=existing-direct:alice"
        ),
      ],
    });

    expect(client.known(run.state).users.has("alice")).toBeFalsy();
  });

  it("makes their facts stale once the cap is deleted", () => {
    const run = play(client, {
      configuration: solo,
      transcript: [
        ...watching(["cap-notify", ...caps]),
        lines("+1s", "<< :irc.test CAP iirc DEL :extended-monitor"),
      ],
    });

    expect(client.known(run.state).users.get("alice")?.away).toMatchObject({
      _tag: "Stale",
      was: { message: "lunch" },
    });
  });

  it("keeps nothing but presence without it", () => {
    const run = play(client, {
      configuration: solo,
      transcript: watching(["away-notify", "account-notify"]),
    });

    expect(client.known(run.state).users.has("alice")).toBeFalsy();
    expect(client.known(run.state).partners.get("alice")?.here).toMatchObject({
      _tag: "Known",
      value: true,
    });
  });
});
