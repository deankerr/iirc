import { Redacted, Result } from "effect";
import { Base64 } from "effect/encoding";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  CredentialName,
  encode,
  fillSecret,
  isRejected,
  maxAuthenticateBytes,
  parse,
} from "./line.ts";
import type { OutboundLine, SecretLine } from "./line.ts";

// The bytes `encode` writes for a Line our own builders made, which it never rejects.
const encodedBytes = (line: OutboundLine): Uint8Array => {
  const bytes = encode(line);

  if (isRejected(bytes)) {
    throw new Error(`Expected bytes, not ${bytes.reason}`);
  }

  return bytes;
};

const text = new TextDecoder();
const credential = CredentialName.make("libera");

const wires = (lines: ReturnType<typeof fillSecret>) => {
  if (isRejected(lines)) {
    throw new Error(`Expected Lines, not ${lines.reason}`);
  }

  return lines.map((line) => text.decode(encodedBytes(line)));
};

const plain = (authcid: string, authzid = ""): SecretLine => ({
  _tag: "AuthenticatePlain",
  authcid,
  authzid,
  credential,
});

const identify = (service: string, account = "iirc"): SecretLine => ({
  _tag: "Identify",
  account,
  credential,
  service,
});

describe(fillSecret, () => {
  it("fills PASS, as a trailing parameter when it must be", () => {
    expect(wires(fillSecret({ _tag: "Pass", credential }, Redacted.make("hunter2")))).toStrictEqual(
      ["PASS hunter2\r\n"]
    );
    expect(wires(fillSecret({ _tag: "Pass", credential }, Redacted.make("a b")))).toStrictEqual([
      "PASS :a b\r\n",
    ]);
  });

  it("fills a JOIN with a key", () => {
    expect(
      wires(
        fillSecret({ _tag: "JoinWithKey", channel: "#secret", credential }, Redacted.make("k3y"))
      )
    ).toStrictEqual(["JOIN #secret k3y\r\n"]);
  });

  it("tells a service to identify Self, in one PRIVMSG", () => {
    expect(wires(fillSecret(identify("NickServ"), Redacted.make("hunter2")))).toStrictEqual([
      "PRIVMSG NickServ :IDENTIFY iirc hunter2\r\n",
    ]);
    expect(
      wires(fillSecret(identify("NickServ@services.test"), Redacted.make(":a,b")))
    ).toStrictEqual(["PRIVMSG NickServ@services.test :IDENTIFY iirc :a,b\r\n"]);
    expect(
      wires(fillSecret(identify("[Nick_Serv]^`{|}-2", "a.b-c"), Redacted.make("é!#@")))
    ).toStrictEqual(["PRIVMSG [Nick_Serv]^`{|}-2 :IDENTIFY a.b-c é!#@\r\n"]);
  });

  it("fills the SASL PLAIN response as authzid, authcid, and password", () => {
    expect(wires(fillSecret(plain("iirc"), Redacted.make("hunter2")))).toStrictEqual([
      `AUTHENTICATE ${btoa("\0iirc\0hunter2")}\r\n`,
    ]);
  });

  it("ends a response that fills its last chunk exactly with +", () => {
    // 300 bytes of response are 400 of base64.
    const lines = wires(fillSecret(plain("u"), Redacted.make("p".repeat(297))));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveLength("AUTHENTICATE ".length + 400 + 2);
    expect(lines[1]).toBe("AUTHENTICATE +\r\n");
  });

  it.each([
    ["a PASS with a line break", { _tag: "Pass", credential }, "a\r\nQUIT", "InvalidParameter"],
    ["a PASS with NUL", { _tag: "Pass", credential }, "a\0", "InvalidParameter"],
    ["a PASS too long to fit", { _tag: "Pass", credential }, "x".repeat(600), "TooLong"],
    [
      "a key with a space",
      { _tag: "JoinWithKey", channel: "#a", credential },
      "a b",
      "InvalidParameter",
    ],
    [
      "a key with a comma, which would key another Channel",
      { _tag: "JoinWithKey", channel: "#a", credential },
      "a,b",
      "InvalidParameter",
    ],
    ["an empty key", { _tag: "JoinWithKey", channel: "#a", credential }, "", "InvalidParameter"],
    [
      "a key for two Channels",
      { _tag: "JoinWithKey", channel: "#a,#b", credential },
      "k",
      "InvalidTarget",
    ],
    ["a key for JOIN 0", { _tag: "JoinWithKey", channel: "0", credential }, "k", "InvalidTarget"],
    ["a password with NUL", plain("iirc"), "a\0b", "InvalidParameter"],
    ["an identify to a Channel", identify("#iirc"), "pw", "InvalidTarget"],
    ["an identify to a mask", identify("$*"), "pw", "InvalidTarget"],
    ["an identify to two Users", identify("NickServ,peer"), "pw", "InvalidTarget"],
    ["an identify to a service with a space", identify("Nick Serv"), "pw", "InvalidTarget"],
    ["an identify to no service", identify(""), "pw", "InvalidTarget"],
    ["an identify with a space in its password", identify("NickServ"), "a b", "InvalidParameter"],
    ["an identify with a line break", identify("NickServ"), "a\r\nQUIT", "InvalidParameter"],
    ["an identify with NUL", identify("NickServ"), "a\0", "InvalidParameter"],
    ["an identify with no password", identify("NickServ"), "", "InvalidParameter"],
    [
      "an identify with a space in its account",
      identify("NickServ", "a b"),
      "pw",
      "InvalidParameter",
    ],
    ["an identify with no account", identify("NickServ", ""), "pw", "InvalidParameter"],
    ["an identify too long to fit", identify("NickServ"), "x".repeat(600), "TooLong"],
    ["an identify to a STATUSMSG Target", identify("@#staff"), "pw", "InvalidTarget"],
    ["an identify to a halfop STATUSMSG Target", identify("%#staff"), "pw", "InvalidTarget"],
    ["an identify to an owner STATUSMSG Target", identify("~#staff"), "pw", "InvalidTarget"],
    ["an identify to a voiced STATUSMSG Target", identify("+#staff"), "pw", "InvalidTarget"],
    ["an identify to a & Channel", identify("&local"), "pw", "InvalidTarget"],
    ["an identify to a nick starting with a digit", identify("1NickServ"), "pw", "InvalidTarget"],
    ["an identify to a nick with a !", identify("NickServ!s@h"), "pw", "InvalidTarget"],
    ["an identify to a server mask", identify("NickServ@*.test"), "pw", "InvalidTarget"],
    [
      "an identify with a tab in its account",
      identify("NickServ", "acct\twrong"),
      "pw",
      "InvalidParameter",
    ],
    ["an identify with a tab in its password", identify("NickServ"), "a\tb", "InvalidParameter"],
    ["an identify with a vertical tab", identify("NickServ"), "a\vb", "InvalidParameter"],
    ["an identify with a form feed", identify("NickServ"), "a\fb", "InvalidParameter"],
    ["an identify with a no-break space", identify("NickServ"), "a\u00A0b", "InvalidParameter"],
    ["an identify with an en space", identify("NickServ"), "a\u2002b", "InvalidParameter"],
    ["an identify with a hair space", identify("NickServ"), "a\u200Ab", "InvalidParameter"],
    ["an identify with an ideographic space", identify("NickServ"), "a\u3000b", "InvalidParameter"],
    ["an identify with a next line", identify("NickServ"), "a\u0085b", "InvalidParameter"],
    ["an identify with a line separator", identify("NickServ"), "a\u2028b", "InvalidParameter"],
    [
      "an identify with an ogham space in its account",
      identify("NickServ", "a\u1680b"),
      "pw",
      "InvalidParameter",
    ],
    ["an authcid with NUL", plain("ii\0rc"), "x", "InvalidParameter"],
  ] as const)("refuses %s", (_name, line, value, reason) => {
    expect(fillSecret(line, Redacted.make(value))).toStrictEqual({ _tag: "Rejected", reason });
  });
});

// The payload as it goes on the wire, read back by the parser.
const payloadOf = (line: OutboundLine) => {
  const parsed = parse(encodedBytes(line).subarray(0, -2), { _tag: "Utf8Only" });
  const params = parsed._tag === "Line" ? parsed.line.params : [];

  expect(parsed).toMatchObject({ line: { command: "AUTHENTICATE" } });
  expect(params).toHaveLength(1);

  return params[0] ?? "";
};

describe("every SASL PLAIN response", () => {
  const anyText = fc.string({ maxLength: 1200, unit: "binary" });
  const name = fc.string({ maxLength: 40, unit: "binary" });

  it("is valid AUTHENTICATE Lines of at most 400 bytes, with the + rule, that decode to the response", () => {
    expect(() => {
      fc.assert(
        fc.property(name, name, anyText, (authcid, authzid, password) => {
          const lines = fillSecret(plain(authcid, authzid), Redacted.make(password));

          if (isRejected(lines)) {
            return [authcid, authzid, password].some(
              (part) => part.includes("\0") || !part.isWellFormed()
            );
          }

          const payloads = lines.map(payloadOf);
          const last = payloads.at(-1) ?? "";
          const full = payloads.slice(0, -1);

          expect(lines.length).toBeGreaterThan(0);
          expect(full.every((payload) => payload.length === maxAuthenticateBytes)).toBeTruthy();
          expect(
            last === "+" || (last.length > 0 && last.length < maxAuthenticateBytes)
          ).toBeTruthy();

          const joined = payloads.filter((payload) => payload !== "+").join("");
          const decoded = Base64.decode(joined);

          expect(Result.isSuccess(decoded)).toBeTruthy();
          expect(text.decode(Result.getOrThrow(decoded))).toBe(
            [authzid, authcid, password].join("\0")
          );

          return true;
        }),
        { numRuns: 2000 }
      );
    }).not.toThrow();
  });
});
