import { holds } from "@iirc/runtime/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { byteStoreLaws } from "./laws.ts";
import { makeMemoryByteStore } from "./memory-store.ts";

describe("the in-memory byte store", () => {
  it.each(byteStoreLaws)("$name", async (law) => {
    await expect(Effect.runPromise(holds(law, makeMemoryByteStore))).resolves.toBeUndefined();
  });
});
