import { afterEach, describe, expect, it, vi } from "vitest";

import { closeReason, deadline, fold, phase, start, step } from "./lifecycle.ts";
import type { Command, NetworkEvent, NetworkInput, NetworkSnapshot, Phase } from "./lifecycle.ts";

const input: NetworkInput = {
  channels: ["#first", "#second", "#third"],
  nick: "claude",
  realname: "Claude Code",
  username: "cc",
};

const attempt: NetworkEvent = { at: 1000, type: "ATTEMPT" };
const opened: NetworkEvent = { at: 2000, type: "OPENED" };
const closed: NetworkEvent = { at: 9000, reason: "peer hung up", type: "CLOSED" };

const line = (command: string, ...params: readonly string[]): NetworkEvent => ({
  at: 3000,
  command,
  params,
  type: "LINE",
});

const welcome = line("001", "claude", "Welcome");

const histories: Record<Phase, readonly NetworkEvent[]> = {
  closed: [attempt, closed],
  connecting: [attempt],
  idle: [],
  registering: [attempt, opened],
  session: [attempt, opened, welcome],
};

const phases: readonly Phase[] = ["idle", "connecting", "registering", "session", "closed"];
const connected: readonly Phase[] = ["connecting", "registering", "session"];
const unconnected: readonly Phase[] = ["idle", "closed"];

const inPhase = (name: Phase) => fold(histories[name], input);

const closeWith = (reason: string): readonly Command[] => [{ reason, type: "closeConnection" }];

const observe = (snapshot: NetworkSnapshot) => ({
  closeReason: closeReason(snapshot),
  deadline: deadline(snapshot),
  phase: phase(snapshot),
});

// Everything a host can see of a run: each step's Commands, and where it ended.
const run = (events: readonly NetworkEvent[]) => {
  let snapshot = start(input);
  const commands: Command[][] = [];

  for (const event of events) {
    const stepped = step(snapshot, event);
    commands.push([...stepped.commands]);
    snapshot = stepped.next;
  }

  return { commands, end: observe(snapshot), serialized: JSON.stringify(snapshot) };
};

// The types forbid such an event, but a Log written by a newer Daemon does not.
const isForged = (value: { readonly at: number; readonly type: string }): value is NetworkEvent =>
  value.type.length > 0;

describe(start, () => {
  it("begins idle, with nothing pending", () => {
    expect(observe(start(input))).toStrictEqual({
      closeReason: undefined,
      deadline: undefined,
      phase: "idle",
    });
  });
});

describe("ATTEMPT", () => {
  it.each(phases)("connects from %s", (from) => {
    const { commands, next } = step(inPhase(from), attempt);

    expect(phase(next)).toBe("connecting");
    expect(commands).toStrictEqual([]);
  });

  it("leaves the previous Connection behind after a crash mid-registration", () => {
    const { next } = step(inPhase("registering"), { at: 5000, type: "ATTEMPT" });

    expect(observe(next)).toStrictEqual({
      closeReason: undefined,
      deadline: undefined,
      phase: "connecting",
    });
  });

  it("forgets why the last Connection closed", () => {
    expect(closeReason(step(inPhase("closed"), attempt).next)).toBeUndefined();
  });

  it("registers afresh after a crash during a Session", () => {
    const { next } = step(inPhase("session"), attempt);

    expect(step(next, opened).commands.map((command) => command.type)).toStrictEqual([
      "sendLine",
      "sendLine",
    ]);
  });
});

describe("connecting", () => {
  it("registers once the Connection opens, NICK before USER", () => {
    const { commands, next } = step(inPhase("connecting"), opened);

    expect(phase(next)).toBe("registering");
    expect(commands).toStrictEqual([
      { cause: "registration", command: "NICK", params: ["claude"], type: "sendLine" },
      {
        cause: "registration",
        command: "USER",
        params: ["cc", "0", "*", "Claude Code"],
        type: "sendLine",
      },
    ]);
  });

  it("gives registration 60 seconds from the event's own time", () => {
    const { next } = step(inPhase("connecting"), { at: 123_456, type: "OPENED" });

    expect(deadline(next)).toStrictEqual({ at: 183_456, name: "registration" });
  });

  it("sets no deadline of its own", () => {
    expect(deadline(inPhase("connecting"))).toBeUndefined();
  });
});

describe("registering", () => {
  it("reaches a Session on 001 and clears the deadline", () => {
    const { next } = step(inPhase("registering"), welcome);

    expect(phase(next)).toBe("session");
    expect(deadline(next)).toBeUndefined();
  });

  it("closes when the registration deadline passes", () => {
    const { commands, next } = step(inPhase("registering"), {
      at: 62_000,
      name: "registration",
      type: "DEADLINE",
    });

    expect(commands).toStrictEqual(closeWith("registration timed out"));
    expect(phase(next)).toBe("registering");
  });

  it("closes once for one deadline, and stops asking the host to wake", () => {
    const expired: NetworkEvent = { at: 62_000, name: "registration", type: "DEADLINE" };
    const { next } = step(inPhase("registering"), expired);

    expect(deadline(next)).toBeUndefined();
    expect(step(next, expired).commands).toStrictEqual([]);
  });

  it.each(["432", "433", "436", "464", "465"])(
    "closes with the Ircd's own text on %s",
    (command) => {
      const { commands } = step(inPhase("registering"), line(command, "*", "claude", "Not today"));

      expect(commands).toStrictEqual(closeWith("Not today"));
    }
  );

  it("still has a reason when a refusal carries no text", () => {
    expect(step(inPhase("registering"), line("465")).commands).toStrictEqual(closeWith("465"));
  });
});

describe("session", () => {
  it("joins each configured Channel in order, once, on entry", () => {
    const { commands } = step(inPhase("registering"), welcome);

    expect(commands).toStrictEqual([
      { cause: "autojoin", command: "JOIN", params: ["#first"], type: "sendLine" },
      { cause: "autojoin", command: "JOIN", params: ["#second"], type: "sendLine" },
      { cause: "autojoin", command: "JOIN", params: ["#third"], type: "sendLine" },
    ]);
  });

  it("joins nothing when no Channel is configured", () => {
    const snapshot = fold([attempt, opened], { ...input, channels: [] });

    expect(step(snapshot, welcome).commands).toStrictEqual([]);
  });

  it("does not rejoin on a repeated 001", () => {
    expect(step(inPhase("session"), welcome).commands).toStrictEqual([]);
  });

  it("joins again in the next Session", () => {
    const snapshot = fold([...histories.session, closed, attempt, opened], input);

    expect(step(snapshot, welcome).commands).toHaveLength(input.channels.length);
  });
});

describe("PING", () => {
  it.each(connected)("is answered in %s with its first parameter", (from) => {
    const { commands } = step(inPhase(from), line("PING", "token", "ignored"));

    expect(commands).toStrictEqual([
      { cause: "ping-reply", command: "PONG", params: ["token"], type: "sendLine" },
    ]);
  });

  it("still gets a PONG when it carries no parameter", () => {
    const { commands } = step(inPhase("session"), line("PING"));

    expect(commands).toStrictEqual([
      { cause: "ping-reply", command: "PONG", params: [], type: "sendLine" },
    ]);
  });

  it.each(unconnected)("needs a Connection, so is ignored in %s", (from) => {
    expect(step(inPhase(from), line("PING", "token")).commands).toStrictEqual([]);
  });

  it("does not disturb the registration deadline", () => {
    const snapshot = inPhase("registering");

    expect(deadline(step(snapshot, line("PING", "token")).next)).toStrictEqual(deadline(snapshot));
  });
});

describe("ERROR", () => {
  it.each(connected)("closes with its text in %s", (from) => {
    const { commands, next } = step(inPhase(from), line("ERROR", "Closing Link: banned"));

    expect(commands).toStrictEqual(closeWith("Closing Link: banned"));
    expect(phase(next)).toBe(from);
  });

  it("still has a reason when it carries no text", () => {
    expect(step(inPhase("session"), line("ERROR")).commands).toStrictEqual(closeWith("ERROR"));
  });

  it.each(unconnected)("needs a Connection, so is ignored in %s", (from) => {
    expect(step(inPhase(from), line("ERROR", "gone")).commands).toStrictEqual([]);
  });
});

describe("CLOSED", () => {
  it.each(phases)("closes from %s and keeps the reason", (from) => {
    const { commands, next } = step(inPhase(from), closed);

    expect(observe(next)).toStrictEqual({
      closeReason: "peer hung up",
      deadline: undefined,
      phase: "closed",
    });
    expect(commands).toStrictEqual([]);
  });

  it("keeps the latest reason", () => {
    const { next } = step(inPhase("closed"), { at: 9500, reason: "again", type: "CLOSED" });

    expect(closeReason(next)).toBe("again");
  });

  it("has no reason while the Connection is up", () => {
    expect(closeReason(inPhase("session"))).toBeUndefined();
  });
});

describe("stale DEADLINE", () => {
  it.each(phases.filter((name) => name !== "registering"))("is ignored in %s", (from) => {
    const snapshot = inPhase(from);

    const { commands, next } = step(snapshot, {
      at: 99_000,
      name: "registration",
      type: "DEADLINE",
    });

    expect(commands).toStrictEqual([]);
    expect(observe(next)).toStrictEqual(observe(snapshot));
  });

  it("is ignored under a name that is not pending", () => {
    const snapshot = inPhase("registering");
    const { commands, next } = step(snapshot, { at: 99_000, name: "burst", type: "DEADLINE" });

    expect(commands).toStrictEqual([]);
    expect(deadline(next)).toStrictEqual(deadline(snapshot));
  });

  it("is ignored when it was written for an earlier Connection's deadline", () => {
    // The first deadline is 62_000. A second Connection opens before its Deadline
    // Entry lands, so that Entry now arrives with the name of a live deadline.
    const snapshot = fold(
      [attempt, opened, closed, attempt, { at: 61_000, type: "OPENED" }],
      input
    );

    const { commands, next } = step(snapshot, {
      at: 62_000,
      name: "registration",
      type: "DEADLINE",
    });

    expect(commands).toStrictEqual([]);
    expect(deadline(next)).toStrictEqual({ at: 121_000, name: "registration" });
  });

  it("fires at exactly its deadline", () => {
    const { commands } = step(inPhase("registering"), {
      at: 62_000,
      name: "registration",
      type: "DEADLINE",
    });

    expect(commands).toHaveLength(1);
  });
});

describe("events that matter to nothing", () => {
  const irrelevant: readonly NetworkEvent[] = [
    line("NOTICE", "*", "Looking up your hostname"),
    line("372", "claude", "Message of the day"),
    line(""),
    opened,
  ];

  const cases = phases
    .filter((name) => name !== "connecting")
    .flatMap((from) => irrelevant.map((event) => ({ event, from })));

  it.each(cases)("leaves $from alone on $event.type $event.command", ({ event, from }) => {
    const snapshot = inPhase(from);
    const { commands, next } = step(snapshot, event);

    expect(commands).toStrictEqual([]);
    expect(observe(next)).toStrictEqual(observe(snapshot));
  });

  it.each(phases.filter((name) => name !== "registering"))("ignores 001 in %s", (from) => {
    expect(phase(step(inPhase(from), welcome).next)).toBe(from);
  });

  it.each(phases.filter((name) => name !== "registering"))("ignores a refusal in %s", (from) => {
    expect(step(inPhase(from), line("433", "*", "claude", "Taken")).commands).toStrictEqual([]);
  });

  it.each(phases)("survives an event kind it has never heard of in %s", (from) => {
    const forged = { at: 1, type: "FROM_THE_FUTURE" };

    expect(isForged(forged) && step(inPhase(from), forged).commands).toStrictEqual([]);
  });
});

describe(fold, () => {
  const history: readonly NetworkEvent[] = [
    attempt,
    opened,
    line("NOTICE", "*", "Looking up your hostname"),
    line("PING", "one"),
    welcome,
    line("PING", "two"),
    line("ERROR", "Closing Link"),
    closed,
    attempt,
    opened,
    // A crash: no close was recorded before the next attempt.
    attempt,
    opened,
    line("433", "*", "claude", "Taken"),
    { at: 62_000, name: "registration", type: "DEADLINE" },
    closed,
  ];

  it("equals stepping one event at a time, at every point", () => {
    const stepped = history.map((_event, index) => run(history.slice(0, index + 1)));

    const folded = history.map((_event, index) => {
      const snapshot = fold(history.slice(0, index + 1), input);

      return { end: observe(snapshot), serialized: JSON.stringify(snapshot) };
    });

    expect(folded).toStrictEqual(stepped.map(({ end, serialized }) => ({ end, serialized })));
  });

  it("takes any iterable", () => {
    const events = function* events() {
      yield* history;
    };

    expect(observe(fold(events(), input))).toStrictEqual(observe(fold(history, input)));
  });

  it("discards Commands, so none is left to run after replay", () => {
    const snapshot = fold(histories.session, input);

    expect(step(snapshot, line("NOTICE", "*", "hello")).commands).toStrictEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain("NICK");
  });
});

describe(step, () => {
  it("returns only what this event caused", () => {
    const first = step(inPhase("registering"), line("PING", "one"));
    const second = step(first.next, line("PING", "two"));

    expect(second.commands).toStrictEqual([
      { cause: "ping-reply", command: "PONG", params: ["two"], type: "sendLine" },
    ]);
  });

  it("leaves the snapshot it was given usable", () => {
    const snapshot = inPhase("connecting");
    const first = step(snapshot, opened);
    const second = step(snapshot, opened);

    expect(second.commands).toStrictEqual(first.commands);
    expect(phase(snapshot)).toBe("connecting");
  });
});

describe(deadline, () => {
  it("is nothing without a pending deadline", () => {
    expect(deadline(inPhase("session"))).toBeUndefined();
  });
});

describe("the clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const history = [...histories.session, line("PING", "one"), closed, attempt, opened];

  it("is never read: the same events give identical results at any time", () => {
    vi.useFakeTimers({ now: 0 });
    const early = run(history);

    vi.setSystemTime(4_000_000_000_000);
    const late = run(history);

    expect(late).toStrictEqual(early);
    expect(late.end.deadline).toStrictEqual({ at: 62_000, name: "registration" });
  });
});
