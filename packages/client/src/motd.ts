/**
 * The message of the day: the Lines between a `375` and a `376`, collected by those
 * numerics alone and shown as one Activity in the Network's own Timeline. It is bounded,
 * so an Ircd that never ends one, or sends one without end, cannot fill a Timeline.
 *
 * @packageDocumentation
 */
import type { Line } from "@iirc/protocol/line";

import type { Arrival } from "./feature.ts";
import type { Instant } from "./ids.ts";
import type { Fact } from "./known.ts";
import type { Run } from "./run.ts";
import { updateOpen } from "./run.ts";
import type { Link, MotdCollecting } from "./state.ts";
import { maxMotdLines } from "./state.ts";
import { openOf } from "./views.ts";

/** The numerics of a message of the day: its start, a line of it, and its end. */
const motdNumerics: ReadonlySet<string> = new Set(["372", "375", "376"]);

const setMotd = (run: Run, motd: MotdCollecting | undefined): void => {
  updateOpen(run, (open) => ({ ...open, motd }));
};

const show = (run: Run, at: Fact<Instant>, lines: readonly string[], cut: boolean): void => {
  run.news.push({
    _tag: "Activity",
    activity: { _tag: "Motd", cut, lines },
    at,
    id: { _tag: "Unknown" },
    live: true,
    where: [{ _tag: "Network" }],
  });
};

// A line's text is its last parameter, after the one that names Self.
const textOf = (line: Line): string => (line.params.length > 1 ? (line.params.at(-1) ?? "") : "");

/**
 * Takes a live numeric of a message of the day that nothing else took: a `375` starts one,
 * cutting short one still open, a `372` adds its line to the one open, and a `376` shows
 * it whole. A line past {@link maxMotdLines} shows it cut, and the rest is dropped until its
 * `376`. A `372` or `376` with none open is no part of one.
 * @param run - The step.
 * @param arrival - The numeric, live, outside any batch, and with no label.
 * @returns Whether it took the numeric, which is then shown no other way.
 */
export const collectMotd = (run: Run, arrival: Arrival): boolean => {
  const { command } = arrival.line;
  const motd = openOf(run.state)?.motd;

  if (!motdNumerics.has(command)) {
    return false;
  }

  if (command === "375") {
    if (motd?._tag === "Collecting") {
      show(run, motd.at, motd.lines, true);
    }

    setMotd(run, { _tag: "Collecting", at: arrival.time, lines: [] });

    return true;
  }

  if (motd === undefined) {
    return false;
  }

  if (command === "376") {
    if (motd._tag === "Collecting") {
      show(run, motd.at, motd.lines, false);
    }

    setMotd(run, undefined);
  } else if (motd._tag === "Collecting") {
    if (motd.lines.length >= maxMotdLines) {
      show(run, motd.at, motd.lines, true);
      setMotd(run, { _tag: "Spent" });
    } else {
      setMotd(run, { ...motd, lines: [...motd.lines, textOf(arrival.line)] });
    }
  }

  return true;
};

/**
 * A Connection ended: a message of the day it was still receiving is shown, cut.
 * @param run - The step.
 * @param link - The Connection, as it was.
 */
export const endMotd = (run: Run, link: Link): void => {
  const motd = link.phase._tag === "Open" ? link.phase.motd : undefined;

  if (motd?._tag === "Collecting") {
    show(run, motd.at, motd.lines, true);
  }
};
