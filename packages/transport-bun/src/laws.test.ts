import { holds, transportLaws } from "@iirc/runtime/testing";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeCertificate, makeLoopbackHarness } from "./testing/loopback.ts";

// A law carries its own ten-second guard against a hang (`holds`), so Vitest must wait longer
// than that, or a law that is only slow under a loaded machine fails as Vitest's timeout.
vi.setConfig({ testTimeout: 20_000 });

const certificate = makeCertificate("irc.test");

describe("the Bun Transport over TLS", () => {
  it.each(transportLaws)("$name", async (law) => {
    await expect(
      Effect.runPromise(Effect.asVoid(holds(law, makeLoopbackHarness({ certificate }))))
    ).resolves.toBeUndefined();
  });
});

describe("the Bun Transport over plain TCP", () => {
  it.each(transportLaws)("$name", async (law) => {
    await expect(
      Effect.runPromise(Effect.asVoid(holds(law, makeLoopbackHarness())))
    ).resolves.toBeUndefined();
  });
});
