import { describe, expect, it } from "vitest";

import { replayFresh } from "./fresh.ts";
import { replay } from "./play.ts";
import { configured } from "./preludes.ts";
import { failure, knowsSeededClient, seededClient } from "./test-clients.ts";

const base = configured();
const module = new URL("test-clients.ts", import.meta.url);

describe("the fresh-process replay check", () => {
  it("catches a Client seeded once per process, which replay in one process cannot", async () => {
    const played = replay(seededClient, { configuration: base, transcript: "!! configure\n" });

    await expect(
      replayFresh(seededClient, played.inputs, { module, name: "seededClient" })
    ).rejects.toThrow(/a fresh process folds 1 inputs differently/u);
  });
});

describe("the fresh-process digest of Knowledge", () => {
  it("catches Knowledge seeded per process, which replay in one process cannot", async () => {
    const played = replay(knowsSeededClient, { configuration: base, transcript: "!! configure\n" });

    expect(
      failure(() =>
        replay(knowsSeededClient, { configuration: base, transcript: "!! configure\n" })
      )
    ).toBe("it held");
    await expect(
      replayFresh(knowsSeededClient, played.inputs, { module, name: "knowsSeededClient" })
    ).rejects.toThrow(/folds 1 inputs differently/u);
  });

  it("compares the initial Knowledge, with no inputs at all", async () => {
    await expect(
      replayFresh(knowsSeededClient, [], { module, name: "knowsSeededClient" })
    ).rejects.toThrow(/folds 0 inputs differently/u);
  });
});
