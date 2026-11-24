/**
 * A Network's id, apart from the rest of the Schemas so the `ui` options can name Networks
 * without a cycle: `schemas.ts` holds `ui`'s Schema, and so cannot be imported by it.
 *
 * @packageDocumentation
 */
import { Schema } from "effect";

/**
 * A Network, by the id the Owner gave it: up to 64 lower-case letters, digits, `.`, `_`,
 * and `-`, starting with a letter or digit. It is a path segment, so it holds nothing that
 * needs escaping.
 */
export const NetworkId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/u, {
    message:
      "must be 1 to 64 lowercase letters, digits, `.`, `_`, or `-`, starting with a letter or digit",
  })
).pipe(Schema.brand("NetworkId"));

/** The decoded form of {@link NetworkId}. */
export type NetworkId = typeof NetworkId.Type;
