import { describe, expect, it } from "vitest";

import { loginSign } from "./login.ts";

const services = ["NickServ"];

const notice = (source: string, text: string) => ({
  command: "NOTICE",
  params: ["iirc", text],
  source,
});

describe(loginSign, () => {
  it("CONN-6: `900` is a login, in its own words", () => {
    expect(
      loginSign(
        { command: "900", params: ["iirc", "iirc!u@h", "iirc", "You are now logged in"] },
        []
      )
    ).toStrictEqual({ _tag: "LoggedIn", text: "You are now logged in" });
  });

  it("CONN-6: `904` is a failure", () => {
    expect(
      loginSign({ command: "904", params: ["iirc", "SASL authentication failed"] }, [])
    ).toStrictEqual({ _tag: "LoginFailed", text: "SASL authentication failed" });
  });

  it.each([["+r"], ["+ir"], ["-x+r"], ["+i", "-r+r"]])(
    "CONN-6: `MODE` on Self adding `r` is a login (%s)",
    (...letters) => {
      expect(loginSign({ command: "MODE", params: ["iirc", letters.join("")] }, [])?._tag).toBe(
        "LoggedIn"
      );
    }
  );

  it.each(["-r", "+i-r", "+x"])("CONN-6: `MODE` on Self with %s is no sign", (letters) => {
    expect(loginSign({ command: "MODE", params: ["iirc", letters] }, [])).toBeUndefined();
  });

  it("CONN-6: `+r` on a Channel is a Channel's mode, and no sign", () => {
    expect(loginSign({ command: "MODE", params: ["#iirc", "+r"] }, [])).toBeUndefined();
  });

  it.each([
    "You are now identified for \u0002iirc\u0002.",
    "Password accepted - you are now recognized.",
    "You're now logged in as iirc",
    "You are now logged in as iirc.",
  ])("CONN-6: a service saying %j is a login", (text) => {
    expect(loginSign(notice("NickServ!s@services.", text), services)).toStrictEqual({
      _tag: "LoggedIn",
      text,
    });
  });

  it.each([
    "Invalid password for \u0002iirc\u0002.",
    "Password incorrect.",
    "\u0002iirc\u0002 is not registered.",
    "Nick \u000304iirc\u0003 isn't registered.",
  ])("CONN-6: a service saying %j is a failure, with its words kept", (text) => {
    expect(loginSign(notice("NickServ!s@services.", text), services)).toStrictEqual({
      _tag: "LoginFailed",
      text,
    });
  });

  it("CONN-6: a service is known whatever the case of its nick", () => {
    expect(loginSign(notice("nickserv!s@h", "Password accepted"), services)?._tag).toBe("LoggedIn");
  });

  it("CONN-6: anyone else can say the words and it means nothing", () => {
    expect(loginSign(notice("mallory!m@h", "You are now identified"), services)).toBeUndefined();
    expect(
      loginSign({ command: "NOTICE", params: ["iirc", "Password accepted"] }, services)
    ).toBeUndefined();
  });

  it("CONN-6: anything else a service says is no sign", () => {
    expect(
      loginSign(notice("NickServ!s@h", "This nickname is registered."), services)
    ).toBeUndefined();
  });

  it("CONN-6: a `PRIVMSG` with the words is no sign", () => {
    expect(
      loginSign(
        { command: "PRIVMSG", params: ["iirc", "Password accepted"], source: "NickServ" },
        services
      )
    ).toBeUndefined();
  });
});
