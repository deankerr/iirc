import type { CredentialName } from "@iirc/protocol/line";
import { Effect, Ref } from "effect";
import type { Redacted } from "effect";

import { CredentialMissing } from "../vault.ts";
import type { VaultService } from "../vault.ts";

/**
 * A Vault in memory.
 * @returns A fresh, empty Vault.
 */
export const makeMemoryVault: Effect.Effect<VaultService> = Effect.map(
  Ref.make<ReadonlyMap<CredentialName, Redacted.Redacted>>(new Map()),
  (held) => ({
    forget: (name) =>
      Ref.update(held, (values) => {
        const next = new Map(values);

        next.delete(name);

        return next;
      }),
    hold: (name, value) => Ref.update(held, (values) => new Map(values).set(name, value)),
    names: Effect.map(Ref.get(held), (values) => new Set(values.keys())),
    reveal: (name) =>
      Effect.flatMap(Ref.get(held), (values) => {
        const value = values.get(name);

        return value === undefined
          ? Effect.fail(new CredentialMissing({ credential: name }))
          : Effect.succeed(value);
      }),
  })
);
