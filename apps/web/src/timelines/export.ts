/**
 * Saving a Timeline as a text file: the browser is sent to the Daemon's export route, which
 * answers as an attachment that the Daemon names for the Network and the Timeline, so the
 * browser saves it under that name. The Sign-in is the cookie the request carries.
 *
 * @packageDocumentation
 */
import type { TimelineId } from "@iirc/api";
import type { Instant } from "@iirc/frontend/activity";
import type { Export } from "@iirc/frontend/commands";
import { instantAt } from "@iirc/frontend/search";

import { dayStart } from "../search/atoms.ts";

/**
 * Where a Timeline's export is, from an instant, inclusive, and until another, exclusive,
 * each as far as there is when none.
 * @param timeline - The Timeline.
 * @param since - Where to start, or none for its beginning.
 * @param until - Where to stop, or none for its end.
 * @returns The route, relative to the page.
 */
const exportPath = (
  timeline: TimelineId,
  since: Instant | undefined,
  until: Instant | undefined
): string => {
  const range = new URLSearchParams();

  if (since !== undefined) {
    range.set("since", String(since));
  }

  if (until !== undefined) {
    range.set("until", String(until));
  }

  const query = range.toString();

  return `/api/timelines/${encodeURIComponent(timeline)}/export${query === "" ? "" : `?${query}`}`;
};

/**
 * Starts the download of a Timeline's export, as a press on a link to it would, placing a
 * day in the Owner's time zone as this browser keeps it. Nothing is downloaded when a bound
 * has no instant that can be kept, or the range holds none, and why is said instead.
 * @param intent - The export asked for.
 * @returns Why nothing was downloaded, or none when the download started.
 */
export const exportTimeline = (intent: Export): string | undefined => {
  const since = intent.since === undefined ? undefined : instantAt(intent.since, dayStart);
  const until = intent.until === undefined ? undefined : instantAt(intent.until, dayStart);

  if (
    (intent.since !== undefined && since === undefined) ||
    (intent.until !== undefined && until === undefined)
  ) {
    return "/export: that day has no matching time in your time zone.";
  }

  if (since !== undefined && until !== undefined && since >= until) {
    return "/export: the start must come before the end.";
  }

  const link = document.createElement("a");

  link.href = exportPath(intent.timeline, since, until);
  link.download = "";
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();

  return undefined;
};
