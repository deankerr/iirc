import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { IrcdAddress } from "./configuration.ts";

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
