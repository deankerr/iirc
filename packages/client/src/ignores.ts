import type { Source } from "@iirc/protocol/line";
/**
 * The Owner's ignore masks, as the Client applies them: a Message or an Activity from a
 * User is stamped with the masks it matches when it arrives, and a mask taken out of the
 * Configuration is reported once. Nothing is discarded here. Masks are compared folded by
 * the casemapping in force, so a mask means the same however it is spelt.
 *
 * @packageDocumentation
 */
import { canonicalMask, matches } from "@iirc/protocol/mask";
import type { IgnoreMask } from "@iirc/protocol/mask";

import { isSelf } from "./meaning.ts";
import type { Run } from "./run.ts";

const canonical = (run: Run, masks: readonly IgnoreMask[]): readonly IgnoreMask[] => [
  ...new Set(masks.map((mask) => canonicalMask(run.state.casemapping, mask))),
];

/**
 * The ignore masks a User matches, for the News they caused. Self is never ignored,
 * whatever the masks.
 * @param run - The step.
 * @param source - The Line's source, when it is a User's, else `undefined`.
 * @returns The masks it matches, folded, in the Configuration's order, each once, or
 * `undefined` when none.
 */
export const ignoredBy = (
  run: Run,
  source: Source | undefined
): readonly IgnoreMask[] | undefined => {
  const masks = run.state.configuration?.ignores ?? [];

  if (source === undefined || masks.length === 0 || isSelf(run, source.nick)) {
    return undefined;
  }

  const found = canonical(
    run,
    masks.filter((mask) => matches(run.state.casemapping, mask, source))
  );

  return found.length === 0 ? undefined : found;
};

/**
 * The masks a new Configuration no longer holds. A mask is held while any spelling of it
 * is.
 * @param run - The step.
 * @param was - The masks the old Configuration held.
 * @param now - The masks the new one does.
 * @returns The masks dropped, folded, in their old order, each once.
 */
export const dropped = (
  run: Run,
  was: readonly IgnoreMask[],
  now: readonly IgnoreMask[]
): readonly IgnoreMask[] => {
  const kept = new Set(canonical(run, now));

  return canonical(run, was).filter((mask) => !kept.has(mask));
};
