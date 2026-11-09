import { Effect, Fiber } from "effect";
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

// A Journal whose write goes on after its Effect is interrupted, as a Promise-backed
// adapter's might: the laws must catch it.
const lateCommitting = makeMemoryJournal.pipe(
  Effect.map((journal) => ({
    ...journal,
    append: (record: Parameters<typeof journal.append>[0]) =>
      Effect.forkDetach(Effect.delay(journal.append(record), "1 millis")).pipe(
        Effect.flatMap((writing) => Fiber.join(writing))
      ),
  }))
);

const settles = journalLaws.filter((each) => each.name.startsWith("settles"));

describe("a Journal whose write settles after an interrupt", () => {
  it.each(settles)("breaks the law that it $name", async (law) => {
    const failure = await Effect.runPromise(Effect.flip(holds(law, lateCommitting)));

    expect(
      failure._tag === "LawBroken" && failure.what.includes("after an interrupt")
    ).toBeTruthy();
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
