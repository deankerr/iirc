import { describe, expect, it } from "vitest";

import { soakIdentity, soakLine, soakText } from "./soak-text.ts";

const minute = 29_833_333;

// Five seconds into the minute.
const millis = minute * 60_000 + 5000;

describe("PROOF-5: the counted Message", () => {
  it("PROOF-5: says the minute and the millisecond, and reads both back", () => {
    expect(soakText(millis)).toBe(`soak ${minute} ${millis}`);
    expect(soakIdentity(soakText(millis))).toStrictEqual({ millis, n: minute });
  });

  it("PROOF-5: two runs of one minute say different Messages", () => {
    expect(soakText(millis + 40_000)).not.toBe(soakText(millis));
    expect(soakIdentity(soakText(millis + 40_000))?.n).toBe(minute);
  });

  it.each([
    "soak 0 0",
    "soak 29000000",
    `soak 0${minute} ${millis}`,
    `soak ${minute} 0${millis}`,
    `soak ${minute + 1} ${millis}`,
    `soak ${minute} ${millis} `,
    ` soak ${minute} ${millis}`,
    `soak  ${minute} ${millis}`,
    `Soak ${minute} ${millis}`,
    `soak -${minute} ${millis}`,
    `soak ${minute} ${millis}.5`,
    "soak",
    "hello",
  ])("PROOF-5: does not mistake %j for a counted Message", (text) => {
    expect(soakIdentity(text)).toBeUndefined();
  });

  it("PROOF-5: reads the identity and Target from the PRIVMSG Line that carried it", () => {
    expect(soakLine(`PRIVMSG #soak :${soakText(millis)}`)).toStrictEqual({
      millis,
      n: minute,
      source: undefined,
      target: "#soak",
    });
  });

  it.each([
    [`:soak-a!u@h PRIVMSG somebody :${soakText(millis)}`, "soak-a"],
    [`:soak-a@host PRIVMSG somebody :${soakText(millis)}`, "soak-a"],
    [`:soak-a PRIVMSG somebody :${soakText(millis)}`, "soak-a"],
  ])("PROOF-5: takes the nick from the source in %j", (text, nick) => {
    expect(soakLine(text)?.source).toBe(nick);
  });

  it.each([
    `NOTICE #soak :${soakText(millis)}`,
    `PRIVMSG #soak :${soakText(millis)} and more`,
    "PRIVMSG #soak :soak 29000000",
    "PRIVMSG #soak :hello",
    "JOIN #soak",
    "",
  ])("PROOF-5: reads no counted Message from the Line %j", (text) => {
    expect(soakLine(text)).toBeUndefined();
  });
});
