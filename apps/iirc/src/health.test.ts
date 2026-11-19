import { describe, expect, it } from "vitest";

import { askedAt } from "./health.ts";

describe("where iirc health asks", () => {
  it.each([
    ["0.0.0.0", "127.0.0.1"],
    ["::", "::1"],
    ["0:0:0:0:0:0:0:0", "::1"],
    ["::0", "::1"],
    ["127.0.0.1", "127.0.0.1"],
    ["::1", "::1"],
    ["192.0.2.7", "192.0.2.7"],
    ["2001:db8::7", "2001:db8::7"],
    ["daemon.internal", "daemon.internal"],
  ])("asks a Daemon listening on %s at %s", (host, asked) => {
    expect(askedAt({ host, port: 7667 })).toStrictEqual({ host: asked, port: 7667 });
  });
});
