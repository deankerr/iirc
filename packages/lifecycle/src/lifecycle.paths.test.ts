import { describe, expect, it } from "vitest";
import { getShortestPaths } from "xstate/graph";

import { closeReason, deadline, phase, start, step } from "./lifecycle.ts";
import type { Command, NetworkEvent, NetworkInput, Phase } from "./lifecycle.ts";
import { network } from "./machine.ts";
import { defaultTuning } from "./tuning.ts";

// The one test allowed to know about XState. It asks the machine's graph where
// the machine can go, then checks each place through the public API alone.

const input: NetworkInput = {
  realname: "Claude Code",
  tuning: defaultTuning,
  username: "cc",
};

const lines = [
  { at: 3000, command: "001", params: ["claude", "Welcome"] },
  { at: 3000, command: "376", params: ["claude", "End"] },
  { at: 3000, command: "433", params: ["*", "claude", "Taken"] },
  { at: 3000, command: "437", params: ["*", "#chan", "Held"] },
  { at: 3000, command: "465", params: ["claude", "Banned"] },
  { at: 3000, command: "ERROR", params: ["Closing Link"] },
  { at: 3000, command: "ERROR", params: ["Ping timeout: 2m0s"] },
  { at: 3000, command: "FAIL", params: ["*", "ACCOUNT_REQUIRED", "No"] },
  { at: 3000, command: "NOTICE", params: ["*", "hello"] },
] as const;

const deadlines = [
  { at: 62_000, name: "registration" },
  { at: 2500, name: "registration" },
  { at: 62_000, name: "burst" },
  { at: 62_000, name: "lag-check" },
  { at: 92_500, name: "silence" },
  { at: 93_000, name: "silence" },
] as const;

const attempts = [{ ...input, at: 1000, nicks: ["claude", "claude_"] }] as const;

const samples = {
  ATTEMPT: attempts,
  CLOSED: [{ at: 9000, reason: "peer hung up" }],
  CLOSING: [{ at: 4000, reason: "Owner stopped" }],
  DEADLINE: deadlines,
  HEARD: [{ at: 3500 }],
  LEAVING: [{ at: 2500 }],
  LINE: lines,
  OPENED: [{ at: 2000 }],
  PING: [{ at: 3000, token: new TextEncoder().encode("token") }],
} as const;

const everyEvent: readonly NetworkEvent[] = [
  { ...input, at: 1000, nicks: ["claude", "claude_"], type: "ATTEMPT" },
  { at: 2000, type: "OPENED" },
  { at: 9000, reason: "peer hung up", type: "CLOSED" },
  { at: 4000, reason: "Owner stopped", type: "CLOSING" },
  { at: 3500, type: "HEARD" },
  { at: 2500, type: "LEAVING" },
  { at: 3000, token: new TextEncoder().encode("token"), type: "PING" },
  ...lines.map((line) => ({ ...line, type: "LINE" as const })),
  ...deadlines.map((deadline) => ({ ...deadline, type: "DEADLINE" as const })),
];

const withoutConnection: ReadonlySet<Phase> = new Set(["closed", "idle"]);
const waiting: ReadonlySet<Phase> = new Set(["registering", "session"]);

// Listed as a record so that a new Command will not compile until it is walked here.
const everyCommand: Record<Command["type"], true> = {
  burstComplete: true,
  closeConnection: true,
  sendLine: true,
  sendPong: true,
};

const everyPhase: Record<Phase, true> = {
  closed: true,
  closing: true,
  connecting: true,
  idle: true,
  registering: true,
  session: true,
};

// Every place the machine can reach, extended by every event from there, because
// a shortest path alone never takes an edge that lands back on a known state. Each
// path opens with XState's own `xstate.init` step, which is not an event of ours.
// `limit` makes context that grows without bound fail here rather than never end.
const walks = getShortestPaths(network, { events: samples, input, limit: 2000 }).flatMap((path) => {
  const reached = path.steps.slice(1).map(({ event }) => event);

  return everyEvent.map((event) => [...reached, event]);
});

const walked = walks.map((walk) => {
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

const outcomes = walked.flat();

const sent = (command: Command) => (command.type === "sendLine" ? [command] : []);

describe("every path through the machine", () => {
  it("visits every Phase and every kind of Command", () => {
    expect(new Set(outcomes.map(({ to }) => to))).toStrictEqual(new Set(Object.keys(everyPhase)));
    expect(
      new Set(outcomes.flatMap(({ commands }) => commands.map((command) => command.type)))
    ).toStrictEqual(new Set(Object.keys(everyCommand)));
  });

  it("never commands a Connection that does not exist", () => {
    expect(
      outcomes.filter(({ commands, from }) => withoutConnection.has(from) && commands.length > 0)
    ).toStrictEqual([]);
  });

  it("only waits on a deadline while registering or in a Session", () => {
    expect(
      outcomes.filter(({ pending, to }) => pending !== undefined && !waiting.has(to))
    ).toStrictEqual([]);
  });

  it("has a close reason exactly while closed", () => {
    expect(
      outcomes.filter(({ reason, to }) => (reason !== undefined) !== (to === "closed"))
    ).toStrictEqual([]);
  });

  it("LIVE-9: does nothing at all once a close is under way", () => {
    expect(
      outcomes.filter(({ commands, from }) => from === "closing" && commands.length > 0)
    ).toStrictEqual([]);
  });

  it("moves to closing with every close it asks for, so it asks only once", () => {
    expect(
      outcomes.filter(
        ({ commands, to }) =>
          commands.some(({ type }) => type === "closeConnection") && to !== "closing"
      )
    ).toStrictEqual([]);
  });

  it("LIVE-7: never joins, which is the reconciler's job", () => {
    expect(
      outcomes.filter(({ commands }) =>
        commands.flatMap(sent).some(({ command }) => command === "JOIN")
      )
    ).toStrictEqual([]);
  });

  it("SEND-1: sends everything it decides on the control lane", () => {
    expect(
      outcomes.filter(({ commands }) =>
        commands.some((command) => "lane" in command && command.lane !== "control")
      )
    ).toStrictEqual([]);
  });

  it("CONN-7: completes the burst at most once on any path", () => {
    expect(
      walked.filter(
        (walk) =>
          walk
            .slice(walk.findLastIndex(({ event }) => event.type === "ATTEMPT") + 1)
            .flatMap(({ commands }) => commands)
            .filter(({ type }) => type === "burstComplete").length > 1
      )
    ).toStrictEqual([]);
  });

  it("LIVE-5: only ever marks a close refused before a Session", () => {
    expect(
      outcomes.filter(
        ({ commands, from }) =>
          commands.some(
            (command) => command.type === "closeConnection" && command.refused === true
          ) && from !== "registering"
      )
    ).toStrictEqual([]);
  });
});
