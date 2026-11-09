/**
 * The registry of Features: one array, in the order their hooks run within each stage.
 * It is empty on the floor. Stage 2 adds `sasl`, `multi-prefix`, `server-time`, and the
 * rest here, and nothing else in the core changes to take them.
 *
 * @packageDocumentation
 */
import type { Feature } from "./feature.ts";

/** A Feature as the core holds it, with its own state's type forgotten. */
export type Registered = Feature<unknown>;

/**
 * Puts a Feature in a registry. The core keeps each Feature's own state beside it, and
 * only ever gives a hook the state that Feature began with or returned, so forgetting
 * the type here loses nothing.
 * @param feature - The Feature.
 * @returns The Feature, as the registry holds it.
 */
export const register = <Own>(feature: Feature<Own>): Registered =>
  // SAFETY: a Feature's hooks are only ever called with that same Feature's own state,
  // which began as its `own` and was only ever replaced by what its hooks returned.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- the one place a Feature's own type is forgotten, as the comment above says
  feature as unknown as Registered;

/** Every Feature the Client has, in the order their hooks run. */
export const registry: readonly Registered[] = [];
