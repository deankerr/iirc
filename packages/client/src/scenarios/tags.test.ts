/**
 * `message-tags` and `server-time`: a Message's id and time from the Ircd's tags, and
 * what is left when a tag is missing or does not parse.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { configured, epoch, joined, play, registered } from "../testing/index.ts";

const base = configured();

const day = 86_400_000;

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const withCaps = (...offered: readonly string[]) => [
  registered(base, { offered }),
  joined(base, "#iirc", ["peer"]),
];

describe("message-tags", () => {
  it("reads msgid into a Message's and an Activity's id", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...withCaps("message-tags"),
        lines(
          "<< @msgid=abc-123 :peer!u@h PRIVMSG #iirc :hi",
          "?? message Privmsg peer #iirc id=ircd:abc-123 :hi",
          "<< @msgid=m@2;foo=bar :peer!u@h TOPIC #iirc :new",
          '?? activity TopicChanged #iirc by=peer setBy=peer setAt=t+0s id=ircd:"m@2" :new'
        ),
      ],
    });

    expect.assertions(0);
  });

  it("carries tags it does not read, and reports client-only ones with the Message", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...withCaps("message-tags"),
        lines(
          "<< @+draft/reply=m0;example.com/vendor=x;+typing;msgid=m1 :peer!u@h PRIVMSG #iirc :hi",
          '?? message Privmsg peer #iirc id=ircd:m1 tags=+draft/reply="m0";+typing="" :hi'
        ),
      ],
    });

    expect.assertions(0);
  });

  it("leaves the id unknown with an empty msgid, or none", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...withCaps("message-tags"),
        lines(
          "<< @msgid= :peer!u@h PRIVMSG #iirc :a",
          "?? message Privmsg peer #iirc :a",
          "<< :peer!u@h PRIVMSG #iirc :b",
          "?? message Privmsg peer #iirc :b"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("reads no msgid without the cap", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...withCaps(),
        lines("<< @msgid=m1 :peer!u@h PRIVMSG #iirc :hi", "?? message Privmsg peer #iirc :hi"),
      ],
    });

    expect.assertions(0);
  });
});

describe("server-time", () => {
  it("takes a Message's time from the Ircd", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...withCaps("server-time"),
        lines(
          "+30s",
          "<< @time=2026-01-01T00:00:05.250Z :peer!u@h PRIVMSG #iirc :hi",
          "?? message Privmsg peer #iirc at=ircd:t+5250ms@t+5250ms :hi"
        ),
      ],
    });

    expect.assertions(0);
  });

  it.each([
    ["the spec's own form", "2026-01-01T00:00:01.000Z", 1000],
    ["no milliseconds", "2026-01-01T00:00:01Z", 1000],
    ["more precision", "2026-01-01T00:00:01.123456789Z", 1123],
    ["less precision", "2026-01-01T00:00:01.5Z", 1500],
    ["lower-case T and Z", "2026-01-01t00:00:01.500z", 1500],
    ["a leap second, as the last millisecond of its minute", "2025-12-31T23:59:60.419Z", -1],
    ["a leap day", "2028-02-29T00:00:00.000Z", (365 + 365 + 59) * day],
    ["a time before the epoch", "1999-12-31T23:59:59.999Z", -9497 * day - 1],
    ["the end of a century that is not a leap year", "2100-03-01T00:00:00.000Z", 27_087 * day],
  ])("reads %s", (_name, time, sinceEpoch) => {
    const played = play(client, {
      configuration: base,
      transcript: [
        ...withCaps("server-time"),
        lines(`<< @time=${time} :peer!u@h PRIVMSG #iirc :hi`),
      ],
    });

    const instant = epoch + sinceEpoch;

    expect(played.steps.at(-1)?.news[0]).toMatchObject({
      _tag: "Message",
      at: { _tag: "Known", at: instant, from: "ircd", value: instant },
    });
  });

  it.each([
    ["yesterday"],
    [""],
    ["2026-01-01"],
    ["2026-01-01T00:00:01.000"],
    ["2026-01-01T00:00:01.000+01:00"],
    ["2026-13-01T00:00:00.000Z"],
    ["2026-02-30T00:00:00.000Z"],
    ["2026-01-01T24:00:00.000Z"],
    ["2026-01-01T00:60:00.000Z"],
    ["2026-01-01T00:00:61.000Z"],
    ["2026-01-01T00:00:00.Z"],
    ["2026-01-01T00:00:00.1234567890Z"],
    ["+02026-01-01T00:00:00.000Z"],
  ])("keeps the time of receipt for a malformed time %j", (time) => {
    play(client, {
      configuration: base,
      transcript: [
        ...withCaps("server-time"),
        lines(`<< @time=${time} :peer!u@h PRIVMSG #iirc :hi`, "?? message Privmsg peer #iirc :hi"),
      ],
    });

    expect.assertions(0);
  });

  it("keeps the time of receipt without a time tag, and without the cap", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...withCaps("server-time"),
        lines("<< :peer!u@h PRIVMSG #iirc :hi", "?? message Privmsg peer #iirc :hi"),
      ],
    });
    play(client, {
      configuration: base,
      transcript: [
        ...withCaps(),
        lines(
          "<< @time=2026-01-01T00:00:01.000Z :peer!u@h PRIVMSG #iirc :hi",
          "?? message Privmsg peer #iirc :hi"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("takes a topic's time from the Ircd", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        ...withCaps("server-time"),
        lines("+30s", "<< @time=2026-01-01T00:00:30.000Z :peer!u@h TOPIC #iirc :new"),
      ],
    });

    expect(client.known(played.state).channels.get("#iirc")?.topic).toMatchObject({
      value: { setAt: 1_767_225_630_000, text: "new" },
    });
  });
});
