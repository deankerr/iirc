import type { Living } from "@iirc/runtime";
import { Sequence } from "@iirc/runtime/journal";
import type { Summary } from "@iirc/timeline-store";
import { TimelineId } from "@iirc/timelines";
import type { Kind } from "@iirc/timelines";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { routeOf } from "./marking.ts";

const life = Sequence.make(7);

const summary = (kind: Kind, key: string | null): Summary => ({
  changed: 1,
  closed: false,
  head: undefined,
  id: Schema.decodeSync(TimelineId)("00000000000007-00000000-00000001"),
  key,
  kind,
  latest: undefined,
  life,
  name: key ?? "pal",
  network: "libera",
  read: undefined,
  // What the store last folded, which may lag a removal the Runtime already made.
  removed: false,
  unread: { activity: 0, botDirect: 0, botMessages: 0, direct: 0, highlights: 0, messages: 0 },
});

const live: Living = { _tag: "Live", life, status: { _tag: "Running" } };

describe("how a Timeline named by its id is marked", () => {
  it("follows the Network the Runtime holds now, not what the store last folded", () => {
    expect({
      channel: routeOf(summary("Channel", "#iirc"), live),
      detached: routeOf(summary("Direct", null), live),
      direct: routeOf(summary("Direct", "pal"), live),
      // Removed without keeping, while the store still holds the Timeline.
      dropped: routeOf(summary("Direct", "pal"), undefined),
      // Given its id again after a removal, so the Timeline is an earlier life's.
      earlierLife: routeOf(summary("Channel", "#iirc"), { ...live, life: Sequence.make(9) }),
      kept: routeOf(summary("Channel", "#iirc"), { _tag: "Kept", life }),
      network: routeOf(summary("Network", null), live),
    }).toStrictEqual({
      channel: { _tag: "Client", target: { _tag: "Channel", key: "#iirc", name: "#iirc" } },
      detached: { _tag: "Change" },
      direct: { _tag: "Client", target: { _tag: "Direct", key: "pal", name: "pal" } },
      dropped: { _tag: "Unknown" },
      earlierLife: { _tag: "Unknown" },
      kept: { _tag: "Change" },
      network: { _tag: "Client", target: { _tag: "Network" } },
    });
  });
});
