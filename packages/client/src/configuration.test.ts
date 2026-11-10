import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { IrcdAddress, NetworkConfiguration } from "./configuration.ts";

const decode = Schema.decodeUnknownResult(IrcdAddress);

describe("an Ircd's address", () => {
  it.each([1, 6667, 6697, 65_535])("takes port %d", (port) => {
    expect(Result.isSuccess(decode({ host: "irc.test", port, tls: true }))).toBeTruthy();
  });

  it.each([0, -1, 65_536, 6667.5])("refuses port %d", (port) => {
    expect(Result.isFailure(decode({ host: "irc.test", port, tls: true }))).toBeTruthy();
  });

  it("refuses an empty host", () => {
    expect(Result.isFailure(decode({ host: "", port: 6697, tls: true }))).toBeTruthy();
  });
});

describe("highlight words", () => {
  const old = {
    channels: [],
    declined: [],
    enabled: true,
    fallbackEncoding: "windows-1252",
    ircds: [{ host: "irc.test", port: 6697, tls: true }],
    login: { _tag: "None" },
    nicks: ["iirc"],
    realname: "iirc",
    username: "iirc",
  };

  it("decode as none from a Configuration written before they existed", () => {
    const decoded = Schema.decodeUnknownSync(NetworkConfiguration)(old);

    expect(decoded.highlights).toStrictEqual([]);
  });

  it("are kept, and encoded as given", () => {
    const decoded = Schema.decodeUnknownSync(NetworkConfiguration)({
      ...old,
      highlights: ["iirc", "release"],
    });

    expect(decoded.highlights).toStrictEqual(["iirc", "release"]);
    expect(Schema.encodeSync(NetworkConfiguration)(decoded)).toMatchObject({
      highlights: ["iirc", "release"],
    });
  });

  const takes = (highlights: readonly string[]) =>
    Result.isSuccess(Schema.decodeUnknownResult(NetworkConfiguration)({ ...old, highlights }));

  it("are at most 64, of at most 64 characters each", () => {
    expect([
      takes(Array.from({ length: 64 }, () => "x".repeat(64))),
      takes(Array.from({ length: 65 }, () => "x")),
      takes(["x".repeat(65)]),
    ]).toStrictEqual([true, false, false]);
  });
});
