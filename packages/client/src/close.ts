/**
 * The Owner closes a Timeline, putting it out of the Sidebar until something arrives in it
 * again. The Client keeps nothing of it: it only says which Timeline was closed, keyed as
 * `where` keys Timelines, and whether a Timeline is closed is the projection's to derive.
 *
 * @packageDocumentation
 */
import type { Input } from "./input.ts";
import type { Run } from "./run.ts";
import { folder, ignore } from "./run.ts";
import { markedBy } from "./where.ts";

/**
 * The Owner closed a Timeline, named as `Read` names one, so a Target names a Channel or a
 * Direct Message partner and never the Network's own, which is never closed. A Target that
 * names no one Timeline is `Ignored` as `NoTimeline`, and a Channel Self is in now is
 * `Ignored` as `Joined`, since it stays where the Owner can see it. Otherwise it reports
 * `TimelineClosed`, whether or not any Timeline is there, which is the projection's to know.
 * @param run - The step.
 * @param input - The `CloseTimeline`.
 */
export const closeTimeline = (
  run: Run,
  input: Input & { readonly _tag: "CloseTimeline" }
): void => {
  const where = markedBy(run, input.target);

  if (where === undefined || where._tag === "Network") {
    ignore(run, { _tag: "NoTimeline" });

    return;
  }

  if (
    where._tag === "Channel" &&
    run.state.channels.get(folder(run.state)(where.name))?.phase._tag === "Joined"
  ) {
    ignore(run, { _tag: "Joined" });

    return;
  }

  run.news.push({ _tag: "TimelineClosed", where });
};
