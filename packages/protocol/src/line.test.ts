import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { CredentialName, OutboundLine, SecretLine } from "./line.ts";

const json = Schema.toCodecJson(SecretLine);

describe("a secret Line", () => {
  it("is recorded with its Credential's name, and decodes back", () => {
    const line: SecretLine = {
      _tag: "AuthenticatePlain",
      authcid: "iirc",
      authzid: "",
      credential: CredentialName.make("libera"),
    };

    const recorded = JSON.stringify(Schema.encodeSync(json)(line));

    expect(JSON.parse(recorded)).toStrictEqual({
      _tag: "AuthenticatePlain",
      authcid: "iirc",
      authzid: "",
      credential: "libera",
    });
    expect(Schema.decodeUnknownSync(json)(JSON.parse(recorded))).toStrictEqual(line);
  });

  it("names only the places a Credential can go", () => {
    expect(Object.keys(SecretLine.cases)).toStrictEqual([
      "AuthenticatePlain",
      "JoinWithKey",
      "Pass",
    ]);
  });
});

// A Line as the Journal would hold it, before it is checked.
interface Recorded {
  readonly command: string;
  readonly params: readonly string[];
  readonly tags: Readonly<Record<string, string>>;
}

describe("an outbound Line", () => {
  const json = Schema.toCodecJson(OutboundLine);

  const safe = (line: Recorded) => {
    const recorded = JSON.stringify(line);

    return Result.isSuccess(Schema.decodeUnknownResult(json)(JSON.parse(recorded)));
  };

  const ok = { command: "PRIVMSG", params: ["#iirc", "hello: world"], tags: {} };

  it("decodes a recorded Line that is safe to send", () => {
    expect(safe(ok)).toBeTruthy();
    expect(safe({ ...ok, params: ["#iirc", ""] })).toBeTruthy();
    expect(safe({ ...ok, tags: { "+draft/reply": "abc; def" } })).toBeTruthy();
    expect(safe({ command: "001", params: [], tags: {} })).toBeTruthy();
  });

  it.each([
    ["a second Line in a parameter", { ...ok, params: ["#iirc", "hi\r\nOPER root bad"] }],
    ["NUL in a parameter", { ...ok, params: ["#iirc", "hi\0"] }],
    ["a space in a middle parameter", { ...ok, params: ["#a b", "hi"] }],
    ["an empty middle parameter", { ...ok, params: ["", "hi"] }],
    ["a middle parameter starting with a colon", { ...ok, params: [":x", "hi"] }],
    ["a command that is not one", { ...ok, command: "PRIV MSG" }],
    ["more than 15 parameters", { ...ok, params: Array.from({ length: 16 }, () => "x") }],
    ["more than 510 bytes", { ...ok, params: ["#iirc", "é".repeat(250)] }],
    ["a tag that is not client-only", { ...ok, tags: { time: "2026-11-08T00:00:00Z" } }],
    ["tags over 4094 bytes", { ...ok, tags: { "+big": ";".repeat(2100) } }],
  ])("refuses %s", (_, line) => {
    expect(safe(line)).toBeFalsy();
  });

  it("cannot be made unsafe", () => {
    expect(() => OutboundLine.make({ ...ok, params: ["#iirc", "hi\r\nQUIT"] })).toThrow(
      "Schema validation failed"
    );
  });
});
