import { describe, expect, it } from "vitest";

import { closeReason, deadline, phase, start, step } from "./lifecycle.ts";
import type { Command, NetworkEvent, NetworkInput, NetworkSnapshot, Phase } from "./lifecycle.ts";
import { defaultTuning } from "./tuning.ts";

// Walks everywhere the machine can go from the sample events below, then checks each
// place through the public API alone.

const input: NetworkInput = {
  loginLines: 0,
  realname: "Claude Code",
  services: [],
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
  { at: 3000, command: "900", params: ["claude", "claude!c@host", "claude", "Logged in"] },
] as const;

const deadlines = [
  { at: 62_000, name: "registration" },
  { at: 2500, name: "registration" },
  { at: 62_000, name: "burst" },
  { at: 62_000, name: "lag-check" },
  { at: 92_500, name: "silence" },
  { at: 93_000, name: "silence" },
  { at: 6000, name: "login" },
] as const;

const attempts = [
  { ...input, at: 1000, nicks: ["claude", "claude_"] },
  { ...input, at: 1000, loginLines: 1, nicks: ["claude"], services: ["NickServ"] },
] as const;

const loginSent = [
  { at: 3000, identify: true, written: true },
  { at: 3000, identify: false, written: false },
] as const;

const everyEvent: readonly NetworkEvent[] = [
  ...attempts.map((attempt) => ({ ...attempt, type: "ATTEMPT" as const })),
  { at: 2000, type: "OPENED" },
  { at: 9000, reason: "peer hung up", type: "CLOSED" },
  { at: 4000, reason: "Owner stopped", type: "CLOSING" },
  { at: 3500, type: "HEARD" },
  { at: 2500, type: "LEAVING" },
  { at: 3000, token: new TextEncoder().encode("token"), type: "PING" },
  ...lines.map((line) => ({ ...line, type: "LINE" as const })),
  ...deadlines.map((deadline) => ({ ...deadline, type: "DEADLINE" as const })),
  ...loginSent.map((sent) => ({ ...sent, type: "LOGIN_SENT" as const })),
];

const withoutConnection: ReadonlySet<Phase> = new Set(["closed", "idle"]);
const waiting: ReadonlySet<Phase> = new Set(["registering", "session"]);

// Listed as a record so that a new Command will not compile until it is walked here.
const everyCommand: Record<Command["type"], true> = {
  burstComplete: true,
  closeConnection: true,
  loginSettled: true,
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

// Every place the machine can reach, by the shortest path to it, found breadth first.
// Places are told apart by everything a snapshot holds. `limit` makes context that grows
// without bound fail here rather than never end.
const limit = 4000;

const keyOf = (snapshot: NetworkSnapshot) => JSON.stringify(snapshot);

const shortestPaths = (): readonly (readonly NetworkEvent[])[] => {
  const first = start(input);
  const paths = new Map<string, readonly NetworkEvent[]>([[keyOf(first), []]]);
  let frontier: readonly (readonly [NetworkSnapshot, readonly NetworkEvent[]])[] = [[first, []]];

  while (frontier.length > 0) {
    const next: (readonly [NetworkSnapshot, readonly NetworkEvent[]])[] = [];

    for (const [snapshot, path] of frontier) {
      for (const event of everyEvent) {
        const reached = step(snapshot, event).next;
        const key = keyOf(reached);

        if (!paths.has(key)) {
          const longer = [...path, event];

          paths.set(key, longer);
          next.push([reached, longer]);
        }
      }
    }

    if (paths.size > limit) {
      throw new Error(`the machine reached more than ${limit} places`);
    }

    frontier = next;
  }

  return [...paths.values()];
};

// Each place, extended by every event from there, because a shortest path alone never
// takes an edge that lands back on a known place.
const walks = shortestPaths().flatMap((path) => everyEvent.map((event) => [...path, event]));

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
