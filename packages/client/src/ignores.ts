/**
 * The Owner's ignore masks, as the Client applies them: a Message or an Activity from a
 * User is stamped with the masks it matches when it arrives, and a mask taken out of the
 * Configuration is reported once. Nothing is discarded here. Masks are compared folded by
 * the casemapping in force, so a mask means the same however it is spelt.
 *
 * @packageDocumentation
 */
import { defaultCasemapping } from "@iirc/protocol/casemapping";
import type { Casemapping } from "@iirc/protocol/casemapping";
import type { Source } from "@iirc/protocol/line";
import { canonicalMask, matches } from "@iirc/protocol/mask";
import type { IgnoreMask } from "@iirc/protocol/mask";

import { isSelf } from "./meaning.ts";
import type { Run } from "./run.ts";

// Every casemapping an Ircd may declare, so a mask folded by any of them is found again.
const casemappings: readonly Casemapping[] = ["ascii", "rfc1459", "rfc1459-strict", "rfc8265"];

// A stamp is folded by the casemapping the Network last declared, which outlives each
// Connection, as Timelines are keyed, and never by the one a new Connection starts from.
const canonical = (run: Run, masks: readonly IgnoreMask[]): readonly IgnoreMask[] => [
  ...new Set(masks.map((mask) => canonicalMask(run.state.declared ?? defaultCasemapping, mask))),
];

// A mask as every casemapping folds it, since a stamp was folded by whichever the Network
// had declared when it was made, which may since have changed.
const everyFold = (masks: readonly IgnoreMask[]): readonly IgnoreMask[] => [
  ...new Set(
    masks.flatMap((mask) => casemappings.map((casemapping) => canonicalMask(casemapping, mask)))
  ),
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
 * The masks a new Configuration no longer holds, as every casemapping folds them, so each
 * stamp one of them made is found, whatever mapping the Network had then. A fold a mask
 * still held shares stays out, so nothing a held mask hid is shown.
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
  const held = new Set(canonical(run, now));
  const kept = new Set(everyFold(now));

  return everyFold(
    was.filter((mask) => !held.has(canonicalMask(run.state.declared ?? defaultCasemapping, mask)))
  ).filter((mask) => !kept.has(mask));
};
