// @vitest-environment happy-dom
import { TimelineId } from "@iirc/api";
import type { Timeline } from "@iirc/api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { readChoice } from "../page/device.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run, until } from "../testing/fake-daemon.ts";
import { layoutKey, open, openTimeline, paned, sync } from "./atoms.ts";

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;

const listed = (
  id: string,
  name: string,
  kind: "Network" | "Channel"
): typeof Timeline.Encoded => ({
  changed: 1,
  detached: false,
  head: null,
  id,
  key: kind === "Network" ? null : name,
  kind,
  latest: null,
  name,
  network: "libera",
  read: null,
  unread: { activity: 0, direct: 0, highlights: 0, messages: 0 },
});

describe("the layout kept on this device", () => {
  it("is kept in the same tick as it changes, and never written again as the same text", async () => {
    const fake = fakeDaemon();

    fake.daemon.signedIn = true;
    fake.daemon.timelines.set("libera", [
      { gaps: [], items: [], timeline: listed(idOf(1), "libera", "Network") },
      { gaps: [], items: [], timeline: listed(idOf(2), "#iirc", "Channel") },
    ]);

    const registry = registryFor(fake.fetch);

    await run(registry, check, undefined);
    registry.mount(sync);
    await eventually(() => fake.daemon.followers.length === 1);
    registry.set(open, Schema.decodeSync(TimelineId)(idOf(2)));
    await until(registry, openTimeline, (shown) => shown._tag === "Shown");

    // No await between a change and the read: a reload there would find it kept.
    registry.set(paned, { _tag: "Split", axis: "Horizontal", timeline: undefined });
    const split = readChoice(layoutKey) ?? "";

    registry.set(paned, { _tag: "Close" });
    const closed = readChoice(layoutKey) ?? "";

    // Text already kept is not written again, so a pagehide with nothing new writes nothing.
    localStorage.setItem(layoutKey, "written elsewhere");
    globalThis.dispatchEvent(new Event("pagehide"));

    expect({
      afterPagehide: readChoice(layoutKey),
      closed: closed.includes('"Split"'),
      split: split.includes('"Split"'),
    }).toStrictEqual({ afterPagehide: "written elsewhere", closed: false, split: true });
  });
});
