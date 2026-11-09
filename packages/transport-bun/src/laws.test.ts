import { holds, transportLaws } from "@iirc/runtime/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeCertificate, makeLoopbackHarness } from "./testing/loopback.ts";

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
