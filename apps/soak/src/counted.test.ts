import { describe, expect, it } from "vitest";

import { soakText } from "./soak-text.ts";
import { isCounted } from "./world.fixture.ts";

describe("counting what the receiver heard", () => {
  const heard = {
    at: 1,
    kind: "PRIVMSG",
    network: "floor",
    place: { _tag: "Channel", key: "#soak", name: "#soak" },
    sender: "sender",
    sequence: 2,
    spans: [],
    target: "#soak",
    text: soakText(120_000),
  } as const;

  it("MSG-1, PROOF-5: counts a PRIVMSG, and never an ACTION that reads like one", () => {
    expect(isCounted(heard)).toBeTruthy();
    expect(isCounted({ ...heard, kind: "ACTION" })).toBeFalsy();
    expect(isCounted({ ...heard, kind: "NOTICE" })).toBeFalsy();
  });
});
