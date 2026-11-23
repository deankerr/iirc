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
import type { FilledLine, OutboundLine } from "./line.ts";

// The bytes `encode` writes for a Line our own builders made, which it never rejects.
const encodedBytes = (line: OutboundLine): Uint8Array => {
  const bytes = encode(line);

  if (isRejected(bytes)) {
    throw new Error(`Expected bytes, not ${bytes.reason}`);
  }

  return bytes;
};

// A response may start with U+FEFF, which is text here and not a byte order mark.
const text = new TextDecoder("utf-8", { ignoreBOM: true });
const credential = CredentialName.make("libera");

const wires = (lines: ReturnType<typeof fillSecret>) => {
  if (isRejected(lines)) {
    throw new Error(`Expected Lines, not ${lines.reason}`);
  }

  return lines.map((line) => text.decode(encodedBytes(line)));
};

const plain = (authcid: string, authzid = ""): FilledLine => ({
  _tag: "AuthenticatePlain",
  authcid,
  authzid,
  credential,
});

const identify = (service: string, account = "iirc"): FilledLine => ({
  _tag: "Identify",
  account,
  credential,
  service,
});

const oper = (name: string): FilledLine => ({ _tag: "Oper", credential, name });

describe(fillSecret, () => {
  it("fills OPER, with the password trailing when it must be", () => {
    expect(wires(fillSecret(oper("admin"), Redacted.make("hunter2")))).toStrictEqual([
      "OPER admin hunter2\r\n",
    ]);
    expect(wires(fillSecret(oper("admin"), Redacted.make("two words")))).toStrictEqual([
      "OPER admin :two words\r\n",
    ]);
    expect(wires(fillSecret(oper("a:b,c"), Redacted.make(":pw")))).toStrictEqual([
      "OPER a:b,c ::pw\r\n",
    ]);
  });

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

  it("tells a service the password alone when there is no account", () => {
    const alone: FilledLine = { _tag: "Identify", credential, service: "NickServ" };

    expect(wires(fillSecret(alone, Redacted.make("hunter2")))).toStrictEqual([
      "PRIVMSG NickServ :IDENTIFY hunter2\r\n",
    ]);
    expect(fillSecret(alone, Redacted.make("a b"))).toStrictEqual({
      _tag: "Rejected",
      reason: "InvalidParameter",
    });
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
    ["an identify to two Users", identify("NickServ,peer"), "pw", "InvalidTarget"],
    ["an identify to a service with a space", identify("Nick Serv"), "pw", "InvalidTarget"],
    ["an identify to no service", identify(""), "pw", "InvalidTarget"],
    ["an identify with a space in its password", identify("NickServ"), "a b", "InvalidParameter"],
    ["an identify with NUL", identify("NickServ"), "a\0", "InvalidParameter"],
    ["an identify with no password", identify("NickServ"), "", "InvalidParameter"],
    [
      "an identify with a space in its account",
      identify("NickServ", "a b"),
      "pw",
      "InvalidParameter",
    ],
    ["an identify with an empty account", identify("NickServ", ""), "pw", "InvalidParameter"],
    ["an identify too long to fit", identify("NickServ"), "x".repeat(600), "TooLong"],
    ["an identify to a STATUSMSG Target", identify("@#staff"), "pw", "InvalidTarget"],
    ["an identify to a nick with a !", identify("NickServ!s@h"), "pw", "InvalidTarget"],
    ["an identify to a server mask", identify("NickServ@*.test"), "pw", "InvalidTarget"],
    ["an identify with a no-break space", identify("NickServ"), "a\u00A0b", "InvalidParameter"],
    ["an identify with a next line", identify("NickServ"), "a\u0085b", "InvalidParameter"],
    ["an authcid with NUL", plain("ii\0rc"), "x", "InvalidParameter"],
    ["an OPER with no name", oper(""), "pw", "InvalidParameter"],
    ["an OPER with a space in its name", oper("ad min"), "pw", "InvalidParameter"],
    ["an OPER with a no-break space in its name", oper("ad\u00A0min"), "pw", "InvalidParameter"],
    ["an OPER with a line break in its name", oper("a\r\nQUIT"), "pw", "InvalidParameter"],
    ["an OPER with NUL in its name", oper("a\0"), "pw", "InvalidParameter"],
    ["an OPER whose name starts with a colon", oper(":admin"), "pw", "InvalidParameter"],
    ["an OPER whose name is a lone surrogate", oper("\uD800"), "pw", "InvalidParameter"],
    ["an OPER with a line break in its password", oper("admin"), "a\r\nQUIT", "InvalidParameter"],
    ["an OPER with no password", oper("admin"), "", "InvalidParameter"],
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
        // An authzid of U+FEFF puts it first in the response, where a decoder may take it for a BOM.
        { examples: [["", "\uFEFF", ""]], numRuns: 2000 }
      );
    }).not.toThrow();
  });
});
