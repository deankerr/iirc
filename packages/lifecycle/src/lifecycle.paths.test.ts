import { describe, expect, it } from "vitest";
import { getShortestPaths } from "xstate/graph";

import { closeReason, deadline, phase, start, step } from "./lifecycle.ts";
import type { NetworkEvent, NetworkInput, Phase } from "./lifecycle.ts";
import { network } from "./machine.ts";

// The one test allowed to know about XState. It asks the machine's graph where
// the machine can go, then checks each place through the public API alone.

const input: NetworkInput = {
  channels: ["#first", "#second"],
  nick: "claude",
  realname: "Claude Code",
  username: "cc",
};

const lines = [
  { at: 3000, command: "001", params: ["claude", "Welcome"] },
  { at: 3000, command: "433", params: ["*", "claude", "Taken"] },
  { at: 3000, command: "465", params: ["claude", "Banned"] },
  { at: 3000, command: "ERROR", params: ["Closing Link"] },
  { at: 3000, command: "NOTICE", params: ["*", "hello"] },
  { at: 3000, command: "PING", params: ["token"] },
] as const;

const deadlines = [
  { at: 62_000, name: "registration" },
  { at: 2500, name: "registration" },
  { at: 62_000, name: "burst" },
] as const;

const samples = {
  ATTEMPT: [{ at: 1000 }],
  CLOSED: [{ at: 9000, reason: "peer hung up" }],
  DEADLINE: deadlines,
  LINE: lines,
  OPENED: [{ at: 2000 }],
} as const;

const everyEvent: readonly NetworkEvent[] = [
  { at: 1000, type: "ATTEMPT" },
  { at: 2000, type: "OPENED" },
  { at: 9000, reason: "peer hung up", type: "CLOSED" },
  ...lines.map((line) => ({ ...line, type: "LINE" as const })),
  ...deadlines.map((deadline) => ({ ...deadline, type: "DEADLINE" as const })),
];

const withoutConnection: ReadonlySet<Phase> = new Set(["closed", "idle"]);

// Every place the machine can reach, extended by every event from there, because
// a shortest path alone never takes an edge that lands back on a known state. Each
// path opens with XState's own `xstate.init` step, which is not an event of ours.
// `limit` makes context that grows without bound fail here rather than never end.
const walks = getShortestPaths(network, { events: samples, input, limit: 1000 }).flatMap((path) => {
  const reached = path.steps.slice(1).map(({ event }) => event);

  return everyEvent.map((event) => [...reached, event]);
});

const outcomes = walks.flatMap((walk) => {
  let snapshot = start(input);

  return walk.map((event) => {
    const from = phase(snapshot);
    const { commands, next } = step(snapshot, event);
    snapshot = next;

    return {
      commands,
      event,
      from,
      pending: deadline(next),
      reason: closeReason(next),
      to: phase(next),
    };
  });
});

describe("every path through the machine", () => {
  it("visits every Phase and every kind of Command", () => {
    expect(new Set(outcomes.map(({ to }) => to))).toStrictEqual(
      new Set(["closed", "connecting", "idle", "registering", "session"])
    );
    expect(
      new Set(outcomes.flatMap(({ commands }) => commands.map((command) => command.type)))
    ).toStrictEqual(new Set(["closeConnection", "sendLine"]));
  });

  it("never commands a Connection that does not exist", () => {
    expect(
      outcomes.filter(({ commands, from }) => withoutConnection.has(from) && commands.length > 0)
    ).toStrictEqual([]);
  });

  it("only waits on a deadline while registering", () => {
    expect(
      outcomes.filter(({ pending, to }) => pending !== undefined && to !== "registering")
    ).toStrictEqual([]);
  });

  it("has a close reason exactly while closed", () => {
    expect(
      outcomes.filter(({ reason, to }) => (reason !== undefined) !== (to === "closed"))
    ).toStrictEqual([]);
  });

  it("joins only on the way into a Session", () => {
    expect(
      outcomes.filter(
        ({ commands, from, to }) =>
          commands.some((command) => command.type === "sendLine" && command.command === "JOIN") &&
          (from !== "registering" || to !== "session")
      )
    ).toStrictEqual([]);
  });
});
