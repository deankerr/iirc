/**
 * Whether what is seen of a monitored User is kept: a Feature keeps it, and `MONITOR`
 * says they are online. It is apart from `monitor.ts` so the Channels can ask it without
 * an import cycle.
 *
 * @packageDocumentation
 */
import type { Run } from "./run.ts";
import { onNow, openOf } from "./views.ts";

/**
 * Whether a User is kept as monitored: `MONITOR` says they are online, and a Feature on
 * now keeps what is seen of such a User.
 * @param run - The step.
 * @param folded - The User's nick, folded by the Connection's casemapping.
 * @returns Whether they are.
 */
export const keptWatched = (run: Run, folded: string): boolean => {
  const here = openOf(run.state)?.monitoring.watched.get(folded)?.here;

  return (
    here !== undefined &&
    here._tag === "Known" &&
    here.value &&
    onNow(run.registry, run.state).some(
      (feature) => feature.keeps?.includes("user.monitored") === true
    )
  );
};
