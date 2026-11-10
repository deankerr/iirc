/**
 * The Owner's Read Markers: how far each Timeline has been read, as an instant that only
 * moves forward (ADR 0014). They are keyed as `where` keys Timelines, follow a Direct
 * Message partner's nick as the Timeline does, and fold again when the Network declares
 * another casemapping.
 *
 * @packageDocumentation
 */
import { casefold } from "@iirc/protocol/casemapping";

import type { Instant } from "./ids.ts";
import type { Input } from "./input.ts";
import type { Casemapping } from "./known.ts";
import type { Marked, Named, Where } from "./news.ts";
import type { Run } from "./run.ts";
import { ignore } from "./run.ts";
import type { Marker, ReadMarkers } from "./state.ts";
import { markedBy } from "./where.ts";

const later = (left: Instant, right: Instant | undefined): Instant =>
  right === undefined || left >= right ? left : right;

const heldFor = (markers: ReadMarkers, where: Marked): Instant | undefined => {
  switch (where._tag) {
    case "Network": {
      return markers.network;
    }

    case "Channel": {
      return markers.channels.get(where.key)?.read;
    }

    case "Direct": {
      return markers.directs.get(where.key)?.read;
    }

    default: {
      return where satisfies never;
    }
  }
};

// A marker keeps the name it was first marked by, as a projection keeps the name a
// Timeline opened with, and a new casemapping folds that name again.
const withMarker = (
  markers: ReadonlyMap<string, Marker>,
  { key, name }: Named,
  read: Instant
): ReadonlyMap<string, Marker> =>
  new Map(markers).set(key, { name: markers.get(key)?.name ?? name, read });

const marked = (markers: ReadMarkers, where: Marked, read: Instant): ReadMarkers => {
  switch (where._tag) {
    case "Network": {
      return { ...markers, network: read };
    }

    case "Channel": {
      return {
        ...markers,
        channels: withMarker(markers.channels, where, read),
      };
    }

    case "Direct": {
      return {
        ...markers,
        directs: withMarker(markers.directs, where, read),
      };
    }

    default: {
      return where satisfies never;
    }
  }
};

/**
 * The Owner has read a Timeline up to an instant. A later instant than the one held
 * moves the marker and reports it. An earlier or equal one changes nothing and reports
 * nothing, so two Frontends marking at once cannot move it back. A Target that names no
 * one Timeline is `Ignored` as `NoTimeline`.
 * @param run - The step.
 * @param input - The `Read`.
 */
export const read = (run: Run, input: Input & { readonly _tag: "Read" }): void => {
  const where = markedBy(run, input.target);

  if (where === undefined) {
    ignore(run, { _tag: "NoTimeline" });

    return;
  }

  const held = heldFor(run.state.markers, where);

  if (held !== undefined && input.read <= held) {
    return;
  }

  run.state = { ...run.state, markers: marked(run.state.markers, where, input.read) };
  run.news.push({ _tag: "ReadMarker", read: input.read, where });
};

/**
 * Moves the Read Marker of each Direct Message Timeline a live rename moves, as the
 * Timeline follows its partner's nick. Where the new nick's key already had one, the
 * moved marker replaces it, and where the old nick had none, the new nick's is dropped, as
 * a projection detaches the Timeline already at that key: nothing says it is the same
 * person, so a renamed Timeline never takes a stranger's marker, and a later `Read` for
 * the partner is never judged against one.
 * @param run - The step.
 * @param where - Where an Activity belongs.
 */
export const followRenames = (run: Run, where: readonly Where[]): void => {
  for (const each of where) {
    if (each._tag === "DirectRenamed") {
      const { directs } = run.state.markers;
      const moving = directs.get(each.key);
      const next = new Map(directs);

      next.delete(each.key);
      next.delete(each.to.key);

      if (moving !== undefined) {
        next.set(each.to.key, { name: each.to.name, read: moving.read });
      }

      run.state = { ...run.state, markers: { ...run.state.markers, directs: next } };
    }
  }
};

// Each marker's name folded again by the mapping. Where keys now meet, the first held
// keeps its name, and the later instant is kept, as a merged Timeline has been read as
// far as either had.
const refolded = (
  markers: ReadonlyMap<string, Marker>,
  casemapping: Casemapping
): ReadonlyMap<string, Marker> => {
  const next = new Map<string, Marker>();

  for (const marker of markers.values()) {
    const key = casefold(casemapping, marker.name);
    const kept = next.get(key);

    next.set(
      key,
      kept === undefined ? marker : { name: kept.name, read: later(kept.read, marker.read) }
    );
  }

  return next;
};

/**
 * Folds every Read Marker's key again, by the casemapping a `Refolded` reports.
 * @param run - The step.
 * @param casemapping - The mapping keys fold by from now on.
 */
export const refoldMarkers = (run: Run, casemapping: Casemapping): void => {
  const { markers } = run.state;

  run.state = {
    ...run.state,
    markers: {
      ...markers,
      channels: refolded(markers.channels, casemapping),
      directs: refolded(markers.directs, casemapping),
    },
  };
};
