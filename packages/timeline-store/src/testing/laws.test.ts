import { holds } from "@iirc/runtime/testing";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { timelineStoreLaws } from "./laws.ts";
import { makeMemoryTimelineStore } from "./memory-store.ts";

// A law carries its own ten-second guard against a hang (`holds`), so Vitest must wait longer
// than that, or a law that is only slow under a loaded machine fails as Vitest's timeout.
vi.setConfig({ testTimeout: 20_000 });

describe("the in-memory Timeline store", () => {
  it.each(timelineStoreLaws)("$name", async (law) => {
    await expect(Effect.runPromise(holds(law, makeMemoryTimelineStore))).resolves.toBeUndefined();
  });
});
