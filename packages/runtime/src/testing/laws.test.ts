import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { holds, journalLaws, transportLaws, vaultLaws } from "./laws.ts";
import type { Law } from "./laws.ts";
import { makeMemoryJournal } from "./memory-journal.ts";
import { makeMemoryTransport } from "./memory-transport.ts";
import { makeMemoryVault } from "./memory-vault.ts";

const check = async <Harness, E>(law: Law<Harness, E>, make: Effect.Effect<Harness>) => {
  await Effect.runPromise(holds(law, make));
};

describe("the in-memory Journal", () => {
  it.each(journalLaws)("$name", async (law) => {
    await expect(check(law, makeMemoryJournal)).resolves.toBeUndefined();
  });
});

describe("the in-memory Vault", () => {
  it.each(vaultLaws)("$name", async (law) => {
    await expect(check(law, makeMemoryVault)).resolves.toBeUndefined();
  });
});

describe("the in-memory Transport", () => {
  it.each(transportLaws)("$name", async (law) => {
    await expect(check(law, makeMemoryTransport)).resolves.toBeUndefined();
  });
});
