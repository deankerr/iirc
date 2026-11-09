/**
 * The Vault port: hold Credentials, and give one's value at the last moment. A value is
 * always `Redacted`, so it cannot be logged or journaled by accident, and only
 * `fillSecret` in `@iirc/protocol` unwraps it.
 *
 * @packageDocumentation
 */
import { CredentialName } from "@iirc/protocol/line";
import { Context, Schema } from "effect";
import type { Effect, Redacted } from "effect";

/** The Vault holds no Credential by this name. */
export class CredentialMissing extends Schema.TaggedError<
  CredentialMissing,
  { readonly brand: unique symbol }
>()("CredentialMissing", { credential: CredentialName }) {}

/** The Vault could not be read or written. */
export class VaultFailed extends Schema.TaggedError<
  VaultFailed,
  { readonly brand: unique symbol }
>()("VaultFailed", {
  reason: Schema.String,
}) {}

/** What a Vault adapter provides. */
export interface VaultService {
  /** A Credential's value, for the Runtime to fill a `SecretLine` with and then let go of. */
  readonly reveal: (
    name: CredentialName
  ) => Effect.Effect<Redacted.Redacted, CredentialMissing | VaultFailed>;
  /** Holds a value under a name, replacing any earlier one. */
  readonly hold: (
    name: CredentialName,
    value: Redacted.Redacted
  ) => Effect.Effect<void, VaultFailed>;
  /** Lets go of a Credential. Forgetting one that is not held does nothing. */
  readonly forget: (name: CredentialName) => Effect.Effect<void, VaultFailed>;
  /** The names held, and never their values. */
  readonly names: Effect.Effect<ReadonlySet<CredentialName>, VaultFailed>;
}

/** The Vault port. */
export class Vault extends Context.Service<Vault, VaultService>()("@iirc/runtime/Vault") {}
