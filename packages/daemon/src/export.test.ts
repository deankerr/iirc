import { Instant, IntentId } from "@iirc/client";
import type { Activity, SayKind } from "@iirc/client";
import type { Content, Delivery } from "@iirc/timelines";
import { describe, expect, it } from "vitest";

import { exportDisposition, exportLine } from "./export.ts";

/** 2026-11-20T05:54:27.123Z. */
const at = Instant.make(Date.UTC(2026, 10, 20, 5, 54, 27, 123));

const message = (
  text: string,
  kind: SayKind = "Privmsg",
  sender = "alice",
  delivery?: Delivery
): Content => ({
  _tag: "Message",
  answers: undefined,
  at: { _tag: "Unknown" },
  bot: false,
  context: undefined,
  id: { _tag: "Unknown" },
  kind,
  live: true,
  ours: delivery === undefined ? undefined : { delivery, intent: IntentId.make("i") },
  sender,
  tags: [],
  target: "#iirc",
  text,
});

const activity = (each: Activity): Content => ({
  _tag: "Activity",
  activity: each,
  at: { _tag: "Unknown" },
  id: { _tag: "Unknown" },
  live: true,
});

// What an item is written as, without its time.
const textOf = (content: Content) =>
  exportLine({ content, position: { at, n: 0, sequence: 1 } }).slice(
    "2026-11-20T05:54:27.123Z ".length
  );

describe("an export's line", () => {
  it("begins with the time in UTC, to the millisecond, and ends with one line feed", () => {
    expect(exportLine({ content: message("hi"), position: { at, n: 0, sequence: 1 } })).toBe(
      "2026-11-20T05:54:27.123Z <alice> hi\n"
    );
  });

  it.each<[string, Content, string]>([
    ["a Privmsg", message("hello there"), "<alice> hello there\n"],
    ["an Action", message("waves", "Action"), "* alice waves\n"],
    ["a Notice", message("heads up", "Notice"), "-alice- heads up\n"],
    [
      "ours the Ircd confirmed, by its text",
      message("helo", "Privmsg", "iirc", {
        _tag: "Confirmed",
        at: { _tag: "Unknown" },
        id: { _tag: "Unknown" },
        text: "hello",
      }),
      "<iirc> hello\n",
    ],
    [
      "ours still pending, by ours",
      message("helo", "Privmsg", "iirc", { _tag: "Pending" }),
      "<iirc> helo\n",
    ],
    [
      "bold and colour stripped",
      message("\u0002bold\u0002 \u000304,01red\u0003 done"),
      "<alice> bold red done\n",
    ],
    [
      "line breaks, tabs, escapes, DEL, and C1 controls made spaces",
      message("one\r\ntwo\tthree\u001B[31m\u007F\u009Bfour"),
      "<alice> one  two three [31m  four\n",
    ],
    ["a nick's formatting and controls", message("hi", "Privmsg", "\u0002ev\nil"), "<ev il> hi\n"],
    ["bidirectional controls made spaces", message("a\u202Eb\u2066c\u200Fd"), "<alice> a b c d\n"],
  ])("writes %s", (_name, content, expected) => {
    expect(textOf(content)).toBe(expected);
  });

  it.each<[Activity, string]>([
    [{ _tag: "Joined", channel: "#iirc", nick: "alice" }, "--> alice joined #iirc"],
    [{ _tag: "CameOnline", nick: "alice" }, "--> alice is online"],
    [{ _tag: "Parted", channel: "#iirc", nick: "bob", reason: "bye" }, "<-- bob left #iirc (bye)"],
    [{ _tag: "Parted", channel: "#iirc", nick: "bob", reason: undefined }, "<-- bob left #iirc"],
    [{ _tag: "Quit", nick: "bob", reason: "Ping timeout" }, "<-- bob quit (Ping timeout)"],
    [
      { _tag: "Kicked", by: "op", channel: "#iirc", nick: "bob", reason: "spam" },
      "<-- op kicked bob from #iirc (spam)",
    ],
    [{ _tag: "WentOffline", nick: "alice" }, "<-- alice went offline"],
    [{ _tag: "NickChanged", from: "alice", to: "alice_" }, "-- alice is now known as alice_"],
    [
      {
        _tag: "TopicChanged",
        by: "carol",
        channel: "#iirc",
        topic: { setAt: undefined, setBy: "carol", text: "welcome" },
      },
      '-- carol set the topic of #iirc to "welcome"',
    ],
    [
      { _tag: "TopicChanged", by: "carol", channel: "#iirc", topic: null },
      "-- carol cleared the topic of #iirc",
    ],
    [
      {
        _tag: "ModeChanged",
        by: "op",
        changes: [
          { mode: "o", param: "alice", set: true },
          { mode: "m", param: undefined, set: false },
        ],
        target: "#iirc",
      },
      "-- op set +o alice -m on #iirc",
    ],
    [{ _tag: "AwayChanged", away: { message: "lunch" }, nick: "bob" }, "-- bob is away: lunch"],
    [{ _tag: "AwayChanged", away: { message: "" }, nick: "bob" }, "-- bob is away"],
    [{ _tag: "AwayChanged", away: null, nick: "bob" }, "-- bob is back"],
    [{ _tag: "AccountChanged", account: "bobby", nick: "bob" }, "-- bob logged in as bobby"],
    [{ _tag: "AccountChanged", account: null, nick: "bob" }, "-- bob logged out"],
    [{ _tag: "Invited", by: "carol", channel: "#secret" }, "-- carol invited you to #secret"],
    [{ _tag: "OperGranted", nick: "iirc" }, "-- iirc is now an IRC operator"],
    [
      { _tag: "OperRefused", nick: "iirc", reply: "464" },
      "-- iirc was refused as an IRC operator (464)",
    ],
    [
      {
        _tag: "StandardReply",
        code: "NEED_REGISTRATION",
        command: "JOIN",
        context: ["#iirc"],
        description: "Register first",
        kind: "FAIL",
      },
      "-- FAIL JOIN NEED_REGISTRATION #iirc: Register first",
    ],
    [{ _tag: "Numeric", numeric: "001", params: ["iirc", "Welcome"] }, "001 iirc Welcome"],
    [
      { _tag: "Motd", cut: false, lines: ["- Hello", "- \u0002Be nice\u0002"] },
      "-- Message of the day: - Hello / - Be nice",
    ],
    [{ _tag: "Motd", cut: true, lines: ["- Hello"] }, "-- Message of the day: - Hello (cut short)"],
    [
      {
        _tag: "CtcpRequest",
        answer: { _tag: "Answered", text: "iirc" },
        args: "",
        command: "VERSION",
        nick: "bob",
        target: "iirc",
      },
      "-- bob asked for VERSION, answered iirc",
    ],
    [
      {
        _tag: "CtcpRequest",
        answer: { _tag: "Unanswered", reason: "Off" },
        args: "x",
        command: "TIME",
        nick: "bob",
        target: "iirc",
      },
      "-- bob asked for TIME x, not answered: answers are off",
    ],
    [
      {
        _tag: "CtcpReply",
        args: "1",
        command: "PING",
        nick: "bob",
        roundTrip: 250,
        target: "iirc",
      },
      "-- bob replied to PING in 0.250 s",
    ],
    [
      {
        _tag: "CtcpReply",
        args: "irssi 1.4",
        command: "VERSION",
        nick: "bob",
        roundTrip: null,
        target: "iirc",
      },
      "-- bob replied to VERSION: irssi 1.4",
    ],
    [
      { _tag: "CtcpSent", args: "", command: "VERSION", nick: "bob" },
      "-- You asked bob for VERSION",
    ],
    [
      { _tag: "CtcpUnsent", command: "VERSION", nick: "bob", target: "iirc" },
      "-- bob asked for VERSION, the answer never left",
    ],
  ])("writes the Activity %j", (each, expected) => {
    expect(textOf(activity(each))).toBe(`${expected}\n`);
  });

  it.each<[string, Content, string]>([
    ["a Session beginning", { _tag: "SessionBegan", at, nick: "iirc" }, "-- Connected as iirc"],
    [
      "a Session ending",
      { _tag: "SessionEnded", at, reason: { _tag: "Closed", reason: "Reset" } },
      "-- Disconnected: the connection was reset",
    ],
    [
      "a failed Connection",
      {
        _tag: "ConnectionFailed",
        at,
        ircd: { host: "irc.test", port: 6697, tls: true },
        opened: false,
        reason: { _tag: "Silent" },
      },
      "-- Could not connect to irc.test:6697 with TLS: the Ircd stopped answering",
    ],
    [
      "an action the Ircd refused",
      {
        _tag: "ActionRefused",
        at,
        attempted: { _tag: "Topic", channel: "#iirc" },
        intent: IntentId.make("i"),
        reason: { _tag: "Rejected", reply: "482" },
      },
      "-- Your topic change for #iirc was refused (482)",
    ],
    [
      "an action that never left",
      {
        _tag: "ActionRefused",
        at,
        attempted: { _tag: "Kick", channel: "#iirc", nicks: ["a", "b"] },
        intent: IntentId.make("i"),
        reason: { _tag: "Unsent" },
      },
      "-- Your kick of a, b from #iirc was not sent: its connection ended first",
    ],
  ])("writes %s", (_name, content, expected) => {
    expect(textOf(content)).toBe(`${expected}\n`);
  });
});

describe("an export's file name", () => {
  it.each<
    [string, { network: string; kind: "Network" | "Channel" | "Direct"; name: string }, string]
  >([
    [
      "a Channel's, by its Network and name",
      { kind: "Channel", name: "#iirc", network: "libera" },
      `attachment; filename="libera-#iirc.txt"; filename*=UTF-8''libera-%23iirc.txt`,
    ],
    [
      "the Network's own, by the Network alone",
      { kind: "Network", name: "libera", network: "libera" },
      `attachment; filename="libera.txt"; filename*=UTF-8''libera.txt`,
    ],
    [
      "a name a path, a quote, or a header could be broken by, made safe",
      { kind: "Direct", name: '../a"b\\c:*?<>|\r\nd e\u0000', network: "libera" },
      `attachment; filename="libera-.._a_b_c________d_e_.txt"; filename*=UTF-8''libera-.._a_b_c________d_e_.txt`,
    ],
    [
      "a name beyond ASCII, as underscores in filename and in UTF-8 in filename*",
      { kind: "Channel", name: "#café\u00A0☕", network: "libera" },
      `attachment; filename="libera-#caf___.txt"; filename*=UTF-8''libera-%23caf%C3%A9_%E2%98%95.txt`,
    ],
    [
      "what RFC 8187 does not allow in filename*, percent-encoded",
      { kind: "Channel", name: "#it's(ok)", network: "libera" },
      `attachment; filename="libera-#it's(ok).txt"; filename*=UTF-8''libera-%23it%27s%28ok%29.txt`,
    ],
    [
      "a name that reorders itself, its bidirectional controls made safe",
      { kind: "Channel", name: "#a\u202Etxt.exe", network: "libera" },
      `attachment; filename="libera-#a_txt.exe.txt"; filename*=UTF-8''libera-%23a_txt.exe.txt`,
    ],
  ])("names %s", (_name, timeline, expected) => {
    expect(exportDisposition(timeline)).toBe(expected);
  });
});
