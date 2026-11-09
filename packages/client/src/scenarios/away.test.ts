/**
 * `away-notify`: `AWAY` Lines keep away status up to date, and once the cap is deleted,
 * every away fact goes stale.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { configured, joined, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const awayOf = (transcript: readonly string[], nick: string) =>
  client.known(play(client, { configuration: base, transcript }).state).users.get(nick)?.away;

describe("away-notify", () => {
  const notified = [
    registered(base, { offered: ["cap-notify", "away-notify"] }),
    joined(base, "#iirc", ["peer", "other"]),
    lines(
      "<< :peer!u@h AWAY :gone fishing",
      "?? activity AwayChanged peer :gone fishing",
      "<< :other!u@h AWAY :lunch",
      "<< :other!u@h AWAY",
      "?? activity AwayChanged other back"
    ),
  ];

  it("keeps away status from AWAY Lines", () => {
    expect(awayOf(notified, "peer")).toMatchObject({
      _tag: "Known",
      from: "ircd",
      value: { message: "gone fishing" },
    });
    expect(awayOf(notified, "other")).toMatchObject({ _tag: "Known", value: null });
  });

  it("reads an AWAY with an empty message as back", () => {
    expect(awayOf([...notified, lines("<< :peer!u@h AWAY :")], "peer")).toMatchObject({
      _tag: "Known",
      value: null,
    });
  });

  it("knows nothing of a User no AWAY was heard for", () => {
    expect(
      awayOf(
        [registered(base, { offered: ["away-notify"] }), joined(base, "#iirc", ["peer"])],
        "peer"
      )
    ).toStrictEqual({ _tag: "Unknown" });
  });

  it("makes away status stale on CAP DEL, until an AWAY says again", () => {
    const deleted = [...notified, lines("+1s", "<< :irc.test CAP iirc DEL :away-notify")];

    expect(awayOf(deleted, "peer")).toMatchObject({
      _tag: "Stale",
      was: { message: "gone fishing" },
    });

    const again = [...deleted, lines("+1s", "<< :peer!u@h AWAY :still fishing")];

    expect(awayOf(again, "peer")).toMatchObject({
      _tag: "Known",
      value: { message: "still fishing" },
    });
  });

  it("reads AWAY Lines all the same without the cap", () => {
    expect(
      awayOf(
        [registered(base), joined(base, "#iirc", ["peer"]), lines("<< :peer!u@h AWAY :out")],
        "peer"
      )
    ).toMatchObject({ _tag: "Known", value: { message: "out" } });
  });
});
