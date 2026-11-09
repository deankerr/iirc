import { Redacted, Result } from "effect";
import { Base64 } from "effect/encoding";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { CredentialName, encode, fillSecret, isRejected, maxAuthenticateBytes } from "./line.ts";
import type { OutboundLine, SecretLine } from "./line.ts";

const text = new TextDecoder();
const credential = CredentialName.make("libera");

const wires = (lines: ReturnType<typeof fillSecret>) => {
  if (isRejected(lines)) {
    throw new Error(`Expected Lines, not ${lines.reason}`);
  }

  return lines.map((line) => text.decode(encode(line)));
};

const plain = (authcid: string, authzid = ""): SecretLine => ({
  _tag: "AuthenticatePlain",
  authcid,
  authzid,
  credential,
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
    ["an authcid with NUL", plain("ii\0rc"), "x", "InvalidParameter"],
  ] as const)("refuses %s", (_name, line, value, reason) => {
    expect(fillSecret(line, Redacted.make(value))).toStrictEqual({ _tag: "Rejected", reason });
  });
});

const payloadOf = (line: OutboundLine) => {
  expect(line.command).toBe("AUTHENTICATE");
  expect(line.params).toHaveLength(1);

  return line.params[0] ?? "";
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
