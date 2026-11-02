import { describe, expect, it } from "vitest";

import { isRefusal } from "./refusal.ts";

describe(isRefusal, () => {
  it.each(["463", "464", "465"])("LIVE-5: %s is a refusal", (numeric) => {
    expect(isRefusal(numeric, ["*", "Not welcome"])).toBeTruthy();
  });

  it("LIVE-5: a numeric stays a refusal whatever it says", () => {
    expect(isRefusal("465", ["*", "Banned for your ping timeout flood"])).toBeTruthy();
  });

  it.each([
    ["ERROR", ["Closing Link: you are banned"]],
    ["ERROR", ["You are banned from this server (spam)"]],
    ["ERROR", []],
    ["ERROR", [""]],
    ["FAIL", ["*", "ACCOUNT_REQUIRED", "An account is required to connect"]],
    ["FAIL", ["*", "SOMETHING_NEW"]],
  ])("LIVE-5: %s %j is a refusal, as wording cannot make one", (command, params) => {
    expect(isRefusal(command, params)).toBeTruthy();
  });

  it.each([
    "Ping timeout: 2m0s",
    "Registration timeout: 1m0s",
    "Closing Link: claude (Ping timeout: 120 seconds)",
    "Registration timed out",
    "Closing Link: 10.0.0.1 (Connection timed out)",
  ])("LIVE-5: an ERROR saying %j is transient", (text) => {
    expect(isRefusal("ERROR", [text])).toBeFalsy();
  });

  it.each([
    "Closing connection: a[~@127.0.0.1] (Server going down)",
    "Connection limit reached",
    "Connection refused, too many connections from your IP address",
    "You have attempted to connect too many times within a short duration. Wait a while, and you will be able to connect.",
    "Too many clients from your network",
    "Too many clients from the Tor network",
    "New connections to this server are temporarily restricted",
  ])("LIVE-5: a limit or a restart, %j, is transient", (text) => {
    expect(isRefusal("ERROR", [text])).toBeFalsy();
  });

  it.each([
    "You are banned from this server (Too many clients from your network)",
    "Closing Link: banned (Server going down)",
    "Access denied",
    "Closing connection: Access denied",
  ])("LIVE-5: a ban or a denial, %j, stays a refusal whatever else it says", (text) => {
    expect(isRefusal("ERROR", [text])).toBeTruthy();
  });

  it("LIVE-5: a FAIL saying it timed out is transient too", () => {
    expect(isRefusal("FAIL", ["*", "TIMEOUT", "Registration timed out"])).toBeFalsy();
  });

  it.each([
    "You are banned for flooding after a timeout warning",
    "Time out of range",
    "Closing connection: Timeout",
  ])("LIVE-5: %j only sounds transient, so it is a refusal", (text) => {
    expect(isRefusal("ERROR", [text])).toBeTruthy();
  });

  it("CONN-4: Ergo's FAIL NICK after a 433 is the nick's failure, not a refusal", () => {
    expect(
      isRefusal("FAIL", ["NICK", "NICKNAME_RESERVED", "claude", "Nickname is reserved"])
    ).toBeFalsy();
  });

  it.each(["001", "433", "PRIVMSG", "NOTICE", "PING", ""])("LIVE-5: %j is not one", (command) => {
    expect(isRefusal(command, ["*", "banned"])).toBeFalsy();
  });
});
