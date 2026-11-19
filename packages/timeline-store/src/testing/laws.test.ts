import { holds } from "@iirc/runtime/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { timelineStoreLaws } from "./laws.ts";
import { makeMemoryTimelineStore } from "./memory-store.ts";

describe("the in-memory Timeline store", () => {
  it.each(timelineStoreLaws)("$name", async (law) => {
    await expect(Effect.runPromise(holds(law, makeMemoryTimelineStore))).resolves.toBeUndefined();
  });
});
