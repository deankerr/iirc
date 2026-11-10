/**
 * The registry of Features: one array, in the order their hooks run within each stage,
 * and the order their caps are requested in.
 *
 * @packageDocumentation
 */
import type { Feature } from "./feature.ts";
import { awayNotify } from "./features/away-notify.ts";
import { batch } from "./features/batch.ts";
import { capNotify } from "./features/cap-notify.ts";
import { echo } from "./features/echo.ts";
import { messageTags } from "./features/message-tags.ts";
import { multiPrefix } from "./features/multi-prefix.ts";
import { saslPlain } from "./features/sasl.ts";
import { serverTime } from "./features/server-time.ts";
import { utf8Only } from "./features/utf8-only.ts";

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

/**
 * Every Feature the Client has, in the order their hooks run: `tags` before `batch`
 * before `label` before `meaning`, and within a stage, this order. SASL reads its replies
 * at `tags`, so it hears them before anything refines them.
 */
export const registry: readonly Registered[] = [
  register(capNotify),
  register(saslPlain),
  register(messageTags),
  register(serverTime),
  register(batch),
  register(echo),
  register(multiPrefix),
  register(awayNotify),
  register(utf8Only),
];
