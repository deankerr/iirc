import { holds } from "@iirc/runtime/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { previewCacheLaws } from "./laws.ts";
import { makeMemoryPreviewCache } from "./memory-cache.ts";

describe("the in-memory Preview cache", () => {
  it.each(previewCacheLaws)("$name", async (law) => {
    await expect(Effect.runPromise(holds(law, makeMemoryPreviewCache))).resolves.toBeUndefined();
  });
});
