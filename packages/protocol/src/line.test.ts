import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { CredentialName, SecretLine } from "./line.ts";

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
