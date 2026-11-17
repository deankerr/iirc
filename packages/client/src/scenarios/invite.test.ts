/**
 * An invitation: a User's `INVITE` that names Self is Activity in the Network's own
 * Timeline, holding who invited and to which Channel.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { configured, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

describe("an INVITE", () => {
  it("naming Self is an Invited Activity in the Network's own Timeline", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "<< :peer!u@h INVITE iirc #elsewhere",
          "?? activity Invited #elsewhere by=peer in=network"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("names Self by the Network's casemapping", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "<< :peer!u@h INVITE IIRC #Elsewhere",
          "?? activity Invited #Elsewhere by=peer in=network"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("naming another User is reported nowhere", () => {
    const played = play(client, {
      configuration: base,
      transcript: [registered(base), lines("<< :peer!u@h INVITE other #elsewhere")],
    });

    const activities = played.steps.flatMap((step) =>
      step.news.filter((news) => news._tag === "Activity" && news.activity._tag !== "Numeric")
    );

    expect(activities).toStrictEqual([]);
  });

  it("to a name that is no Channel's is ignored", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("<< :peer!u@h INVITE iirc nowhere", "?? ignored Malformed INVITE"),
      ],
    });

    expect.assertions(0);
  });

  it.each([
    ["no Channel", "<< :peer!u@h INVITE iirc"],
    ["no source", "<< INVITE iirc #elsewhere"],
  ])("with %s is ignored", (_name, line) => {
    play(client, {
      configuration: base,
      transcript: [registered(base), lines(line, "?? ignored Malformed INVITE")],
    });

    expect.assertions(0);
  });

  it("leaves the reply to Self's own invite alone", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("<< :irc.test 341 iirc peer #elsewhere", "<< :peer!u@h INVITE iirc #there"),
      ],
    });

    expect.assertions(0);
  });
});
