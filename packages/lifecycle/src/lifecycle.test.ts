import { afterEach, describe, expect, it, vi } from "vitest";

import { closeReason, deadline, fold, inspect, phase, start, step } from "./lifecycle.ts";
import type { Command, NetworkEvent, NetworkInput, NetworkSnapshot, Phase } from "./lifecycle.ts";
import { defaultTuning } from "./tuning.ts";

const input: NetworkInput = {
  loginLines: 0,
  realname: "Claude Code",
  services: [],
  tuning: defaultTuning,
  username: "cc",
};

const nicks = ["claude", "claudia", "cc"];

const attempt: NetworkEvent = { ...input, at: 1000, nicks, type: "ATTEMPT" };
const opened: NetworkEvent = { at: 2000, type: "OPENED" };
const closed: NetworkEvent = { at: 9000, reason: "peer hung up", type: "CLOSED" };
const stopping: NetworkEvent = { at: 4000, reason: "Owner stopped", type: "CLOSING" };

const line = (command: string, ...params: readonly string[]): NetworkEvent => ({
  at: 3000,
  command,
  params,
  type: "LINE",
});

const lineAt = (at: number, command: string, ...params: readonly string[]): NetworkEvent => ({
  at,
  command,
  params,
  type: "LINE",
});

const token = new TextEncoder().encode("token");
const ping: NetworkEvent = { at: 3000, token, type: "PING" };

const expire = (name: string, at: number): NetworkEvent => ({ at, name, type: "DEADLINE" });

const welcome = line("001", "claude", "Welcome");

const histories: Record<Phase, readonly NetworkEvent[]> = {
  closed: [attempt, closed],
  closing: [attempt, opened, welcome, stopping],
  connecting: [attempt],
  idle: [],
  registering: [attempt, opened],
  session: [attempt, opened, welcome],
};

const phases: readonly Phase[] = [
  "idle",
  "connecting",
  "registering",
  "session",
  "closing",
  "closed",
];

const answering: readonly Phase[] = ["connecting", "registering", "session"];

const inPhase = (name: Phase) => fold(histories[name], input);

// Deadlines in a Session: the burst ends at 13_000, a lag check goes at 63_000, and
// silence ends it at 93_000, all counted from the `001` at 3000.
const burstEnds = 13_000;
const lagChecks = 63_000;
const silenceEnds = 93_000;

const closeWith = (reason: string): readonly Command[] => [{ reason, type: "closeConnection" }];

const refusedWith = (reason: string): readonly Command[] => [
  { reason, refused: true, type: "closeConnection" },
];

const sendNick = (nick: string, cause: string): Command => ({
  cause,
  command: "NICK",
  lane: "control",
  params: [nick],
  type: "sendLine",
});

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
    const { next } = step(inPhase("registering"), { ...input, at: 5000, nicks, type: "ATTEMPT" });

    expect(observe(next)).toStrictEqual({
      closeReason: undefined,
      deadline: undefined,
      phase: "connecting",
    });
  });

  it("forgets why the last Connection closed", () => {
    const refused = fold(
      [attempt, { at: 9000, reason: "banned", refused: true, type: "CLOSED" }],
      input
    );

    const { next } = step(refused, attempt);

    expect(closeReason(next)).toBeUndefined();
  });

  it("LIVE-6: drops every deadline of a Session a crash left behind", () => {
    expect(deadline(step(inPhase("session"), attempt).next)).toBeUndefined();
  });

  it("registers afresh after a crash during a Session", () => {
    const { next } = step(inPhase("session"), attempt);

    expect(step(next, opened).commands.map((command) => command.type)).toStrictEqual([
      "sendLine",
      "sendLine",
    ]);
  });

  it("CONN-4: starts each Connection from the top of its own list", () => {
    const moved = step(inPhase("registering"), line("433", "*", "claude", "Taken")).next;

    const { next } = step(moved, {
      ...input,
      at: 5000,
      nicks: ["other", "fallback"],
      type: "ATTEMPT",
    });

    expect(step(next, opened).commands[0]).toStrictEqual(sendNick("other", "registration"));
  });

  it("runs each Connection on the input its ATTEMPT brought, not the last one's", () => {
    const tuned = { ...defaultTuning, registrationTimeoutMillis: 5000 };
    const first = fold([{ ...attempt, realname: "Old Name", tuning: tuned }, opened], input);
    const second = { ...input, at: 20_000, nicks, realname: "New Name", type: "ATTEMPT" } as const;

    expect(deadline(first)).toStrictEqual({ at: 7000, name: "registration" });

    const { commands, next } = step(step(first, second).next, { at: 21_000, type: "OPENED" });

    expect(deadline(next)).toStrictEqual({ at: 81_000, name: "registration" });
    expect(commands[1]).toMatchObject({ params: ["cc", "0", "*", "New Name"] });
  });
});

describe("connecting", () => {
  it("CONN-2: registers once the Connection opens, NICK before USER, on the control lane", () => {
    const { commands, next } = step(inPhase("connecting"), opened);

    expect(phase(next)).toBe("registering");
    expect(commands).toStrictEqual([
      sendNick("claude", "registration"),
      {
        cause: "registration",
        command: "USER",
        lane: "control",
        params: ["cc", "0", "*", "Claude Code"],
        type: "sendLine",
      },
    ]);
  });

  it("CONN-4: closes rather than registering with no nick to try", () => {
    const { commands, next } = step(
      fold([{ ...input, at: 1000, nicks: [], type: "ATTEMPT" }], input),
      opened
    );

    expect(commands).toStrictEqual(closeWith("no nicks to try"));
    expect(observe(next)).toMatchObject({ deadline: undefined, phase: "closing" });
  });

  it("CONN-2: gives registration 60 seconds from the event's own time", () => {
    const { next } = step(inPhase("connecting"), { at: 123_456, type: "OPENED" });

    expect(deadline(next)).toStrictEqual({ at: 183_456, name: "registration" });
  });

  it("sets no deadline of its own", () => {
    expect(deadline(inPhase("connecting"))).toBeUndefined();
  });
});

describe("registering", () => {
  it("stays put on a 001 that names nobody, with the deadline still running", () => {
    const snapshot = fold([...histories.registering, line("001")], input);

    expect(phase(snapshot)).toBe("registering");
    expect(deadline(snapshot)).toStrictEqual({ at: 62_000, name: "registration" });
  });

  it("reaches a Session on 001 and drops the registration deadline", () => {
    const { commands, next } = step(inPhase("registering"), welcome);

    expect(phase(next)).toBe("session");
    expect(commands).toStrictEqual([]);
    expect(deadline(next)).toStrictEqual({ at: burstEnds, name: "burst" });
  });

  it("CONN-2: closes when the registration deadline passes", () => {
    const { commands, next } = step(inPhase("registering"), expire("registration", 62_000));

    expect(commands).toStrictEqual(closeWith("registration timed out"));
    expect(phase(next)).toBe("closing");
  });

  it("closes once for one deadline, and stops asking the host to wake", () => {
    const expired = expire("registration", 62_000);
    const { next } = step(inPhase("registering"), expired);

    expect(deadline(next)).toBeUndefined();
    expect(step(next, expired).commands).toStrictEqual([]);
  });

  it("LIVE-2: silence is not a rule yet, so Lines leave the deadline alone", () => {
    const snapshot = inPhase("registering");

    expect(deadline(step(snapshot, { at: 5000, type: "HEARD" }).next)).toStrictEqual(
      deadline(snapshot)
    );
    expect(deadline(step(snapshot, line("NOTICE", "*", "hello")).next)).toStrictEqual(
      deadline(snapshot)
    );
  });
});

describe("CONN-4: nick fallback", () => {
  const taken = line("433", "*", "claude", "Nickname is already in use");

  it.each(["432", "433", "436"])("%s moves to the next candidate", (numeric) => {
    const { commands, next } = step(inPhase("registering"), line(numeric, "*", "claude", "No"));

    expect(commands).toStrictEqual([sendNick("claudia", "nick-fallback")]);
    expect(phase(next)).toBe("registering");
  });

  it("437 moves on when its parameter is the nick we are trying", () => {
    const { commands } = step(inPhase("registering"), line("437", "*", "claude", "Unavailable"));

    expect(commands).toStrictEqual([sendNick("claudia", "nick-fallback")]);
  });

  it("437 follows the list, comparing against the current candidate", () => {
    const snapshot = step(inPhase("registering"), taken).next;

    expect(step(snapshot, line("437", "*", "claudia", "Unavailable")).commands).toStrictEqual([
      sendNick("cc", "nick-fallback"),
    ]);
    expect(step(snapshot, line("437", "*", "claude", "Unavailable")).commands).toStrictEqual([]);
  });

  it("437 about a Channel says nothing about our nick", () => {
    const { commands, next } = step(inPhase("registering"), line("437", "*", "#chan", "Held"));

    expect(commands).toStrictEqual([]);
    expect(phase(next)).toBe("registering");
  });

  it("437 with no parameter names nothing", () => {
    expect(step(inPhase("registering"), line("437")).commands).toStrictEqual([]);
  });

  it("walks the list in order, once each", () => {
    const { commands } = run([...histories.registering, taken, taken]);

    expect(commands.slice(2)).toStrictEqual([
      [sendNick("claudia", "nick-fallback")],
      [sendNick("cc", "nick-fallback")],
    ]);
  });

  it("closes when the list runs out, says so, and is not a refusal", () => {
    const snapshot = fold([...histories.registering, taken, taken], input);
    const { commands, next } = step(snapshot, taken);

    expect(commands).toStrictEqual(
      closeWith("ran out of nicks after 3: Nickname is already in use")
    );
    expect(phase(next)).toBe("closing");
    expect(deadline(next)).toBeUndefined();
  });

  it("does not extend the registration deadline", () => {
    expect(deadline(fold([...histories.registering, taken], input))).toStrictEqual({
      at: 62_000,
      name: "registration",
    });
  });

  it("reaches a Session on a later candidate", () => {
    const snapshot = fold([...histories.registering, taken, line("001", "claudia", "Hi")], input);

    expect(phase(snapshot)).toBe("session");
  });

  it("means nothing after 001, when a nick is no longer being registered", () => {
    expect(step(inPhase("session"), taken).commands).toStrictEqual([]);
  });

  it("carries the tried position in replay, not in anything outside the events", () => {
    const history = [...histories.registering, taken];

    expect(JSON.stringify(fold(history, input))).toBe(run(history).serialized);
  });
});

describe("LIVE-5: refusals", () => {
  it.each(["463", "464", "465"])("%s closes with the Ircd's text, marked refused", (numeric) => {
    const { commands, next } = step(inPhase("registering"), line(numeric, "*", "Not today"));

    expect(commands).toStrictEqual(refusedWith("Not today"));
    expect(phase(next)).toBe("closing");
    expect(deadline(next)).toBeUndefined();
  });

  it("keeps the Network's text verbatim", () => {
    const text = "  You are BANNED: see https://example.test/ban?id=1 ";

    expect(step(inPhase("registering"), line("ERROR", text)).commands).toStrictEqual(
      refusedWith(text)
    );
  });

  it("still has a reason when a refusal carries no text", () => {
    expect(step(inPhase("registering"), line("465")).commands).toStrictEqual(refusedWith("465"));
  });

  it("a bare ERROR before 001 is a refusal", () => {
    expect(step(inPhase("registering"), line("ERROR")).commands).toStrictEqual(
      refusedWith("ERROR")
    );
  });

  it("a FAIL before 001 is a refusal", () => {
    const { commands } = step(
      inPhase("registering"),
      line("FAIL", "*", "ACCOUNT_REQUIRED", "An account is required")
    );

    expect(commands).toStrictEqual(refusedWith("An account is required"));
  });

  it("an ERROR for a known transient cause closes, unmarked", () => {
    const { commands, next } = step(
      inPhase("registering"),
      line("ERROR", "Registration timeout: 1m0s")
    );

    expect(commands).toStrictEqual(closeWith("Registration timeout: 1m0s"));
    expect(phase(next)).toBe("closing");
  });

  it("a FAIL for a known transient cause keeps registering", () => {
    const { commands, next } = step(inPhase("registering"), line("FAIL", "*", "T", "Ping timeout"));

    expect(commands).toStrictEqual([]);
    expect(phase(next)).toBe("registering");
  });

  it("CONN-4: Ergo's FAIL NICK after a 433 neither refuses nor skips a candidate", () => {
    const { commands } = run([
      ...histories.registering,
      line("433", "*", "claude", "Nickname is reserved"),
      line("FAIL", "NICK", "NICKNAME_RESERVED", "claude", "Nickname is reserved"),
      line("001", "claudia", "Hi"),
    ]);

    expect(commands.slice(2)).toStrictEqual([[sendNick("claudia", "nick-fallback")], [], []]);
  });

  it("an ERROR after 001 is not a refusal", () => {
    const { commands, next } = step(inPhase("session"), line("ERROR", "Closing Link: banned"));

    expect(commands).toStrictEqual(closeWith("Closing Link: banned"));
    expect(phase(next)).toBe("closing");
  });

  it.each(["463", "464", "465"])("%s after 001 is not a refusal", (numeric) => {
    expect(step(inPhase("session"), line(numeric, "claude", "You are not")).commands).toStrictEqual(
      []
    );
  });

  it("a FAIL after 001 closes nothing", () => {
    expect(step(inPhase("session"), line("FAIL", "*", "NOPE", "No")).commands).toStrictEqual([]);
  });

  it("has no opinion on a Line that cannot be read, even while registering", () => {
    const { commands, next } = step(inPhase("registering"), { at: 3000, type: "HEARD" });

    expect(commands).toStrictEqual([]);
    expect(phase(next)).toBe("registering");
  });
});

describe("CONN-7: the burst", () => {
  it("sets a burst deadline 10 seconds after 001", () => {
    expect(
      deadline(step(inPhase("registering"), lineAt(5000, "001", "claude")).next)
    ).toStrictEqual({ at: 15_000, name: "burst" });
  });

  it.each(["376", "422"])("%s completes it", (numeric) => {
    const { commands, next } = step(inPhase("session"), line(numeric, "claude", "End"));

    expect(commands).toStrictEqual([{ type: "burstComplete" }]);
    expect(deadline(next)?.name).not.toBe("burst");
  });

  it("the deadline completes it when the Ircd never says", () => {
    const { commands, next } = step(inPhase("session"), expire("burst", burstEnds));

    expect(commands).toStrictEqual([{ type: "burstComplete" }]);
    expect(phase(next)).toBe("session");
    expect(deadline(next)?.name).not.toBe("burst");
  });

  it.each([
    ["376 then 422", [line("376"), line("422")]],
    ["422 then 376", [line("422"), line("376")]],
    ["376 then the deadline", [line("376"), expire("burst", burstEnds)]],
    ["the deadline then 376", [expire("burst", burstEnds), line("376")]],
    ["the deadline twice", [expire("burst", burstEnds), expire("burst", burstEnds)]],
    ["376 twice", [line("376"), line("376")]],
  ])("completes exactly once: %s", (_name, events) => {
    const { commands } = run([...histories.session, ...events]);

    expect(commands.flat().filter(({ type }) => type === "burstComplete")).toHaveLength(1);
  });

  it("completes again in the next Session", () => {
    const { commands } = run([
      ...histories.session,
      line("376"),
      closed,
      attempt,
      opened,
      welcome,
      line("376"),
    ]);

    expect(commands.flat().filter(({ type }) => type === "burstComplete")).toHaveLength(2);
  });

  it("does not complete before 001", () => {
    expect(step(inPhase("registering"), line("376", "*", "End")).commands).toStrictEqual([]);
  });

  it("LIVE-7: joins nothing itself, because the reconciler does", () => {
    const { commands } = run([...histories.session, line("376"), expire("burst", burstEnds)]);

    expect(
      commands.flat().filter((command) => command.type === "sendLine" && command.command === "JOIN")
    ).toStrictEqual([]);
  });

  it("does not disturb a repeated 001", () => {
    const { commands, next } = step(inPhase("session"), welcome);

    expect(commands).toStrictEqual([]);
    expect(phase(next)).toBe("session");
  });
});

const sent = (at: number, identify: boolean, written = true): NetworkEvent => ({
  at,
  identify,
  type: "LOGIN_SENT",
  written,
});

const walk = (events: readonly NetworkEvent[]) => {
  let next = start(input);
  const commands: Command[][] = [];

  for (const event of events) {
    const stepped = step(next, event);

    commands.push([...stepped.commands]);
    ({ next } = stepped);
  }

  return { commands, next };
};

const settledOnce = (commands: readonly (readonly Command[])[]) =>
  commands.flat().filter(({ type }) => type === "loginSettled");

const noticeFrom = (source: string): NetworkEvent => ({
  at: 5000,
  command: "NOTICE",
  params: ["claude", "You are now identified for claude."],
  source,
  type: "LINE",
});

describe("CONN-6: the login wait", () => {
  // `IDENTIFY` and two connect commands, with NickServ as the only service.
  const withLogin: NetworkEvent = { ...attempt, loginLines: 3, services: ["NickServ"] };
  const inLogin = [withLogin, opened, welcome, line("376")];

  const allSent = [...inLogin, sent(4000, true), sent(4100, false), sent(4200, false)];

  it("waits from the last Line of the sequence, for `loginWaitMillis`", () => {
    expect(deadline(fold(allSent, input))).toStrictEqual({ at: 6200, name: "login" });
  });

  it("does not start until the last Line is out", () => {
    expect(deadline(fold(allSent.slice(0, -1), input))?.name).not.toBe("login");
  });

  it("counts a Line that was Dropped, so one never sent cannot hold joining up", () => {
    const events = [...inLogin, sent(4000, true), sent(4100, false), sent(4500, false, false)];

    expect(deadline(fold(events, input))).toStrictEqual({ at: 6500, name: "login" });
  });

  it("settles when the wait runs out, once", () => {
    const { commands, next } = walk([...allSent, expire("login", 6200), expire("login", 6300)]);

    expect(settledOnce(commands)).toHaveLength(1);
    expect(deadline(next)?.name).not.toBe("login");
    expect(phase(next)).toBe("session");
  });

  it.each([
    ["900", lineAt(5000, "900", "claude", "claude!c@h", "claude", "Logged in")],
    ["904", lineAt(5000, "904", "claude", "SASL authentication failed")],
    ["+r", lineAt(5000, "MODE", "claude", "+r")],
  ])("settles early on %s, and leaves nothing to expire", (_name, sign) => {
    const { commands, next } = walk([...allSent, sign]);

    expect(settledOnce(commands)).toHaveLength(1);
    expect(deadline(next)?.name).not.toBe("login");
  });

  it("settles early on a service's `NOTICE`, and not on anyone else's", () => {
    expect(deadline(walk([...allSent, noticeFrom("mallory!m@h")]).next)?.name).toBe("login");
    expect(settledOnce(walk([...allSent, noticeFrom("NickServ!s@h")]).commands)).toHaveLength(1);
  });

  it("takes a sign before the rest of the sequence, and then never waits", () => {
    const { commands, next } = walk([
      ...inLogin,
      sent(4000, true),
      lineAt(4050, "900", "claude", "Logged in"),
      sent(4100, false),
      sent(4200, false),
    ]);

    expect(settledOnce(commands)).toHaveLength(1);
    expect(commands.at(-1)).toStrictEqual([{ type: "loginSettled" }]);
    expect(deadline(next)?.name).not.toBe("login");
  });

  it("does not wait when the `IDENTIFY` was Dropped, and settles with the last Line", () => {
    const { commands, next } = walk([
      ...inLogin,
      sent(4000, true, false),
      sent(4100, false),
      sent(4200, false),
    ]);

    expect(commands.at(-1)).toStrictEqual([{ type: "loginSettled" }]);
    expect(deadline(next)?.name).not.toBe("login");
  });

  it("takes no sign before an `IDENTIFY` is out", () => {
    const { next } = walk([
      ...inLogin,
      lineAt(3500, "900", "claude", "Logged in"),
      ...allSent.slice(4),
    ]);

    expect(deadline(next)).toStrictEqual({ at: 6200, name: "login" });
  });

  it("has nothing to wait for with no sequence, and says nothing", () => {
    const { commands } = walk([...histories.session, line("376"), lineAt(5000, "900", "c", "x")]);

    expect(settledOnce(commands)).toHaveLength(0);
  });

  it("counts nothing past the last Line, such as one Dropped after it was recorded", () => {
    const { next } = walk([...allSent, sent(4300, false, false)]);

    expect(deadline(next)).toStrictEqual({ at: 6200, name: "login" });
  });
});

describe("LIVE-2: silence", () => {
  const past = (at: number) => step(fold(histories.session, input), expire("silence", at));

  // The burst is over and the lag check is far off, so silence is what comes next.
  const onlySilence = fold(
    [
      { ...attempt, tuning: { ...defaultTuning, lagCheckMillis: 1_000_000 } },
      opened,
      welcome,
      line("376"),
    ],
    input
  );

  it("closes a Connection nothing has been heard on, saying so", () => {
    const { commands, next } = past(silenceEnds);

    expect(commands).toStrictEqual(closeWith("heard nothing for 90 seconds"));
    expect(phase(next)).toBe("closing");
  });

  it("clears every deadline as it closes", () => {
    expect(deadline(past(silenceEnds).next)).toBeUndefined();
  });

  it.each([
    ["a parsed Line", lineAt(50_000, "PRIVMSG", "#a", "hello")],
    ["a Line that matters to nothing", lineAt(50_000, "372", "claude", "motd")],
    ["a PONG", lineAt(50_000, "PONG", "irc.test", "lag-1")],
    ["a numeric ending the burst", lineAt(50_000, "376", "claude", "End")],
    ["a cut or unparseable Line", { at: 50_000, type: "HEARD" } as const],
    ["a PING", { at: 50_000, token, type: "PING" } as const],
  ])("moves forward on %s", (_name, event) => {
    const snapshot = step(fold(histories.session, input), event).next;

    expect(step(snapshot, expire("silence", silenceEnds)).commands).toStrictEqual([]);
    expect(step(snapshot, expire("silence", 139_999)).commands).toStrictEqual([]);
    expect(step(snapshot, expire("silence", 140_000)).commands).toStrictEqual(
      closeWith("heard nothing for 90 seconds")
    );
  });

  it("is the deadline a host waits on once the others have gone", () => {
    expect(deadline(step(onlySilence, lineAt(70_000, "NOTICE", "x", "y")).next)).toStrictEqual({
      at: 160_000,
      name: "silence",
    });
  });

  it("is not moved by the lag check going out, only by what comes back", () => {
    const stepped = step(fold(histories.session, input), expire("lag-check", lagChecks));

    expect(step(stepped.next, expire("silence", silenceEnds)).commands).toStrictEqual(
      closeWith("heard nothing for 90 seconds")
    );
  });

  it("uses the tuning its ATTEMPT brought, whatever the machine started with", () => {
    const tuned = fold(
      [{ ...attempt, tuning: { ...defaultTuning, silenceMillis: 1000 } }, opened, welcome],
      { ...input, tuning: { ...defaultTuning, silenceMillis: 1_000_000 } }
    );

    expect(step(tuned, expire("silence", 4000)).commands).toStrictEqual(
      closeWith("heard nothing for 1 seconds")
    );
  });
});

describe("a Deadline Entry racing a flood of Lines", () => {
  const flood = Array.from({ length: 200 }, (_unused, index) =>
    lineAt(50_000 + index * 25, "PRIVMSG", "#a", `line ${index}`)
  );

  const flooded = fold([...histories.session, ...flood], input);
  const lastLineAt = 50_000 + 199 * 25;

  it("LIVE-2: an Entry stamped before the deadline moved does nothing", () => {
    const { commands, next } = step(flooded, expire("silence", lastLineAt - 1));

    expect(commands).toStrictEqual([]);
    expect(phase(next)).toBe("session");
  });

  it("LIVE-2: nor does one stamped at the old deadline, however it was earned", () => {
    expect(step(flooded, expire("silence", silenceEnds)).commands).toStrictEqual([]);
  });

  it("LIVE-2: nor one stamped at the moment of the Line that moved it", () => {
    expect(step(flooded, expire("silence", lastLineAt)).commands).toStrictEqual([]);
  });

  it("LIVE-2: a stale Entry leaves the live deadline where it was", () => {
    const { next } = step(flooded, expire("silence", silenceEnds));

    expect(step(next, expire("silence", lastLineAt + 89_999)).commands).toStrictEqual([]);
    expect(step(next, expire("silence", lastLineAt + 90_000)).commands).toHaveLength(1);
  });

  it("LIVE-2: a Line in the same millisecond as an Entry keeps the Connection", () => {
    const { commands } = run([
      ...histories.session,
      lineAt(silenceEnds, "PRIVMSG", "#a", "just in time"),
      expire("silence", silenceEnds),
    ]);

    expect(commands.at(-1)).toStrictEqual([]);
  });

  it("LIVE-2: an Entry cannot close a Connection once the Lines are behind it", () => {
    const snapshot = fold(
      [
        ...histories.session,
        expire("burst", burstEnds),
        lineAt(90_000, "PRIVMSG", "#a", "still here"),
        expire("silence", 92_000),
      ],
      input
    );

    expect(phase(snapshot)).toBe("session");
  });

  it("LIVE-2: decides by the gap alone, at any spacing of Lines", () => {
    const spacings = [1, 7, 1000, 44_999, 89_999];

    for (const spacing of spacings) {
      let snapshot = fold(histories.session, input);
      let at = 3000;

      for (let round = 0; round < 50; round += 1) {
        at += spacing;
        const stepped = step(snapshot, expire("silence", at));

        expect(stepped.commands).toStrictEqual([]);

        snapshot = step(stepped.next, { at, type: "HEARD" }).next;
      }

      expect(step(snapshot, expire("silence", at + 89_999)).commands).toStrictEqual([]);
      expect(step(snapshot, expire("silence", at + 90_000)).commands).toHaveLength(1);
    }
  });

  it("LIVE-3: a lag check is not put off by traffic, so a flood still gets one", () => {
    expect(deadline(step(flooded, expire("burst", burstEnds)).next)).toStrictEqual({
      at: lagChecks,
      name: "lag-check",
    });
  });
});

describe("LIVE-3: lag checks", () => {
  const session = fold(histories.session, input);

  it("sends a PING on the control lane when the deadline passes", () => {
    expect(step(session, expire("lag-check", lagChecks)).commands).toStrictEqual([
      {
        cause: "lag-check",
        command: "PING",
        lane: "control",
        params: [`lag-${lagChecks}`],
        type: "sendLine",
      },
    ]);
  });

  it("does not fire early", () => {
    expect(step(session, expire("lag-check", lagChecks - 1)).commands).toStrictEqual([]);
  });

  it("sets the next one a period after it fired", () => {
    const { next } = step(session, expire("lag-check", lagChecks + 500));

    expect(step(next, expire("lag-check", lagChecks + 59_999)).commands).toStrictEqual([]);
    expect(step(next, expire("lag-check", lagChecks + 60_500)).commands).toHaveLength(1);
  });

  it("does not catch up on checks a stalled host missed", () => {
    const { next } = step(session, expire("lag-check", 500_000));

    expect(step(next, expire("lag-check", 500_001)).commands).toStrictEqual([]);
  });

  const lagTokens = (events: readonly NetworkEvent[]) =>
    run([...histories.session, ...events]).commands.flatMap((commands) =>
      commands.flatMap((command) =>
        command.type === "sendLine" && command.cause === "lag-check" ? command.params : []
      )
    );

  it("fires once for one deadline, however many Entries name it", () => {
    expect(
      lagTokens([expire("lag-check", lagChecks), expire("lag-check", lagChecks)])
    ).toHaveLength(1);
  });

  it("gives every check its own token", () => {
    const tokens = lagTokens([
      expire("lag-check", 63_000),
      lineAt(64_000, "PONG", "irc.test", "lag-63000"),
      expire("lag-check", 123_000),
      lineAt(124_000, "PONG", "irc.test", "lag-123000"),
      expire("lag-check", 183_000),
    ]);

    expect(tokens).toHaveLength(3);
    expect(new Set(tokens).size).toBe(3);
  });

  it("gives the same token on a replay", () => {
    const events = [...histories.session, expire("lag-check", lagChecks)];

    expect(run(events).commands).toStrictEqual(run(events).commands);
  });

  it("goes out however busy the Connection is", () => {
    const busy = Array.from({ length: 20 }, (_unused, index) =>
      lineAt(10_000 + index * 2000, "PRIVMSG", "#a", "hello")
    );

    expect(
      step(fold([...histories.session, ...busy], input), expire("lag-check", lagChecks)).commands
    ).toHaveLength(1);
  });

  it("is not moved by Lines", () => {
    const { next } = step(session, lineAt(50_000, "PONG", "irc.test", "x"));

    expect(step(next, expire("lag-check", lagChecks)).commands).toHaveLength(1);
  });
});

describe("LIVE-1: PING", () => {
  it.each(answering)("is answered in %s, echoing its token on the control lane", (from) => {
    const { commands } = step(inPhase(from), ping);

    expect(commands).toStrictEqual([
      { cause: "ping-reply", lane: "control", token, type: "sendPong" },
    ]);
  });

  it("still gets a PONG when it carries no parameter", () => {
    const { commands } = step(inPhase("session"), { at: 3000, token: undefined, type: "PING" });

    expect(commands).toStrictEqual([
      { cause: "ping-reply", lane: "control", token: undefined, type: "sendPong" },
    ]);
  });

  it("carries bytes that are not text, untouched", () => {
    const hostile = Uint8Array.of(0xff, 0xfe, 0x80);
    const { commands } = step(inPhase("session"), { at: 3000, token: hostile, type: "PING" });

    expect(commands[0]).toMatchObject({ token: hostile });
  });

  it.each(["idle", "closed"] as const)("needs a Connection, so is ignored in %s", (from) => {
    expect(step(inPhase(from), ping).commands).toStrictEqual([]);
  });

  it("does not disturb the registration deadline", () => {
    const snapshot = inPhase("registering");

    expect(deadline(step(snapshot, ping).next)).toStrictEqual(deadline(snapshot));
  });

  it("is not read from a LINE, so a fragment cannot be answered", () => {
    expect(step(inPhase("session"), line("PING", "token")).commands).toStrictEqual([]);
  });
});

describe("ERROR", () => {
  it("closes a Session with its text", () => {
    const { commands, next } = step(inPhase("session"), line("ERROR", "Closing Link: banned"));

    expect(commands).toStrictEqual(closeWith("Closing Link: banned"));
    expect(observe(next)).toMatchObject({ deadline: undefined, phase: "closing" });
  });

  it("still has a reason when it carries no text", () => {
    expect(step(inPhase("session"), line("ERROR")).commands).toStrictEqual(closeWith("ERROR"));
  });

  it.each(["idle", "closing", "closed"] as const)("is ignored in %s", (from) => {
    expect(step(inPhase(from), line("ERROR", "gone")).commands).toStrictEqual([]);
  });
});

describe("LIVE-9: closing", () => {
  it.each(["registering", "session"] as const)(
    "sends QUIT on the control lane and then closes, from %s",
    (from) => {
      const { commands, next } = step(inPhase(from), stopping);

      expect(commands).toStrictEqual([
        {
          cause: "quit",
          command: "QUIT",
          lane: "control",
          params: ["Owner stopped"],
          type: "sendLine",
        },
        { reason: "Owner stopped", type: "closeConnection" },
      ]);
      expect(phase(next)).toBe("closing");
    }
  );

  it("sends no QUIT from connecting, where nothing is connected to hear it", () => {
    const { commands, next } = step(inPhase("connecting"), stopping);

    expect(commands).toStrictEqual(closeWith("Owner stopped"));
    expect(phase(next)).toBe("closing");
  });

  it.each(["idle", "closed"] as const)("needs a Connection, so is ignored in %s", (from) => {
    const { commands, next } = step(inPhase(from), stopping);

    expect(commands).toStrictEqual([]);
    expect(phase(next)).toBe(from);
  });

  it.each(["registering", "session"] as const)("clears every deadline from %s", (from) => {
    expect(deadline(step(inPhase(from), stopping).next)).toBeUndefined();
  });

  it("asks only once, though another close is decided while one is under way", () => {
    expect(step(inPhase("closing"), stopping).commands).toStrictEqual([]);
  });

  it("LIVE-9: answers no PING, as a PONG could only follow the QUIT", () => {
    const { commands, next } = step(inPhase("closing"), ping);

    expect(commands).toStrictEqual([]);
    expect(phase(next)).toBe("closing");
  });

  it.each([
    ["a Line", lineAt(5000, "PRIVMSG", "#a", "hello")],
    ["an ERROR", lineAt(5000, "ERROR", "Closing Link")],
    ["a 001", lineAt(5000, "001", "claude")],
    ["a 376", lineAt(5000, "376", "claude")],
    ["a nick refusal", lineAt(5000, "433", "*", "claude", "Taken")],
    ["a refusal", lineAt(5000, "465", "*", "Banned")],
    ["a fragment", { at: 5000, type: "HEARD" } as const],
    ["an expired deadline", expire("silence", 500_000)],
    ["an expired lag check", expire("lag-check", 500_000)],
    ["an expired burst", expire("burst", 500_000)],
    ["a late OPENED", { at: 5000, type: "OPENED" } as const],
  ])("does nothing on %s", (_name, event) => {
    const snapshot = inPhase("closing");
    const { commands, next } = step(snapshot, event);

    expect(commands).toStrictEqual([]);
    expect(observe(next)).toStrictEqual(observe(snapshot));
  });

  it("reaches closed when the close is recorded", () => {
    const { next } = step(inPhase("closing"), closed);

    expect(observe(next)).toStrictEqual({
      closeReason: "peer hung up",
      deadline: undefined,
      phase: "closed",
    });
  });

  it("can be left by a new attempt", () => {
    expect(phase(step(inPhase("closing"), attempt).next)).toBe("connecting");
  });
});

describe("a close the machine decided", () => {
  const closes: readonly (readonly [string, readonly NetworkEvent[]])[] = [
    ["silence", [...histories.session, expire("silence", silenceEnds)]],
    ["an ERROR in a Session", [...histories.session, line("ERROR", "gone")]],
    ["a registration timeout", [...histories.registering, expire("registration", 62_000)]],
    ["a refusal", [...histories.registering, line("465", "*", "Banned")]],
    [
      "a list that ran out",
      [
        { ...input, at: 1000, nicks: ["claude"], type: "ATTEMPT" },
        opened,
        line("433", "*", "claude", "Taken"),
      ],
    ],
  ];

  it.each(closes)("stops acting on the Connection after %s", (_name, events) => {
    const snapshot = fold(events, input);

    expect(phase(snapshot)).toBe("closing");
    expect(deadline(snapshot)).toBeUndefined();
    expect(step(snapshot, ping).commands).toStrictEqual([]);
    expect(step(snapshot, line("ERROR", "again")).commands).toStrictEqual([]);
    expect(step(snapshot, stopping).commands).toStrictEqual([]);
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

  it("LIVE-5: says why a refused Connection closed", () => {
    const { next } = step(inPhase("closing"), {
      at: 9000,
      reason: "banned",
      refused: true,
      type: "CLOSED",
    });

    expect(closeReason(next)).toBe("banned");
  });
});

describe("LEAVING", () => {
  const leaving: NetworkEvent = { at: 3000, type: "LEAVING" };

  const welcome: NetworkEvent = {
    at: 3500,
    command: "001",
    params: ["claude", "hi"],
    type: "LINE",
  };

  it("LOG-2: a welcome after the host began to leave starts no Session", () => {
    expect(phase(step(step(inPhase("registering"), leaving).next, welcome).next)).toBe(
      "registering"
    );
  });

  it("LOG-2: a refusal after it is still read as one", () => {
    const refusal: NetworkEvent = { at: 3500, command: "465", params: ["banned"], type: "LINE" };

    expect(step(step(inPhase("registering"), leaving).next, refusal).commands).toStrictEqual([
      { reason: "banned", refused: true, type: "closeConnection" },
    ]);
  });

  it("LOG-2: asks for nothing, and leaves a Session as it is", () => {
    const stepped = step(inPhase("session"), leaving);

    expect(stepped.commands).toStrictEqual([]);
    expect(phase(stepped.next)).toBe("session");
  });

  it("LIVE-6: is forgotten by the next attempt", () => {
    const next = fold([leaving, attempt, { at: 4000, type: "OPENED" }, welcome], input);

    expect(phase(step(inPhase("registering"), attempt).next)).toBe("connecting");
    expect(phase(next)).toBe("session");
  });
});

describe("stale DEADLINE", () => {
  it.each(phases.filter((name) => name !== "registering"))("is ignored in %s", (from) => {
    const snapshot = inPhase(from);

    const { commands, next } = step(snapshot, expire("registration", 99_000));

    expect(commands).toStrictEqual([]);
    expect(observe(next)).toStrictEqual(observe(snapshot));
  });

  it("is ignored under a name that is not pending", () => {
    const snapshot = inPhase("registering");
    const { commands, next } = step(snapshot, expire("burst", 99_000));

    expect(commands).toStrictEqual([]);
    expect(deadline(next)).toStrictEqual(deadline(snapshot));
  });

  it("is ignored under a name nobody uses", () => {
    expect(step(inPhase("session"), expire("from-the-future", 900_000)).commands).toStrictEqual([]);
  });

  it("is ignored when it was written for an earlier Connection's deadline", () => {
    // The first deadline is 62_000. A second Connection opens before its Deadline
    // Entry lands, so that Entry now arrives with the name of a live deadline.
    const snapshot = fold(
      [attempt, opened, closed, attempt, { at: 61_000, type: "OPENED" }],
      input
    );

    const { commands, next } = step(snapshot, expire("registration", 62_000));

    expect(commands).toStrictEqual([]);
    expect(deadline(next)).toStrictEqual({ at: 121_000, name: "registration" });
  });

  it("is ignored when it was written for an earlier Session's silence", () => {
    const snapshot = fold(
      [...histories.session, closed, attempt, opened, lineAt(90_000, "001", "claude")],
      input
    );

    expect(step(snapshot, expire("silence", silenceEnds)).commands).toStrictEqual([]);
  });

  it("fires at exactly its deadline", () => {
    expect(step(inPhase("registering"), expire("registration", 62_000)).commands).toHaveLength(1);
  });

  it("does not fire a millisecond before", () => {
    expect(step(inPhase("registering"), expire("registration", 61_999)).commands).toStrictEqual([]);
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
    expect(phase(next)).toBe(from);
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
    ping,
    line("433", "*", "claude", "Taken"),
    welcome,
    { at: 3500, type: "HEARD" },
    ping,
    expire("burst", burstEnds),
    expire("lag-check", lagChecks),
    line("ERROR", "Closing Link"),
    closed,
    attempt,
    opened,
    // A crash: no close was recorded before the next attempt.
    attempt,
    opened,
    line("465", "*", "Banned"),
    expire("registration", 62_000),
    closed,
    attempt,
    opened,
    welcome,
    stopping,
    ping,
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
    expect(JSON.stringify(snapshot)).not.toContain("USER");
  });

  it("OBS-4: gives the same answer as a live run, deadlines included", () => {
    const live = run(history.slice(0, 10));

    expect(observe(fold(history.slice(0, 10), input))).toStrictEqual(live.end);
    expect(live.end).toMatchObject({ phase: "session" });
  });
});

describe(step, () => {
  it("returns only what this event caused", () => {
    const first = step(inPhase("registering"), ping);
    const second = step(first.next, { at: 3000, token: Uint8Array.of(0x32), type: "PING" });

    expect(second.commands).toStrictEqual([
      { cause: "ping-reply", lane: "control", token: Uint8Array.of(0x32), type: "sendPong" },
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
    expect(deadline(inPhase("connecting"))).toBeUndefined();
  });

  it("is the soonest of several", () => {
    const afterBurst = fold([...histories.session, line("376")], input);
    const afterLag = step(afterBurst, expire("lag-check", lagChecks)).next;

    expect(deadline(inPhase("session"))).toStrictEqual({ at: burstEnds, name: "burst" });
    expect(deadline(afterBurst)).toStrictEqual({ at: lagChecks, name: "lag-check" });
    expect(deadline(afterLag)).toStrictEqual({ at: silenceEnds, name: "silence" });
  });
});

describe("the clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const history = [...histories.session, ping, closed, attempt, opened];

  it("is never read: the same events give identical results at any time", () => {
    vi.useFakeTimers({ now: 0 });
    const early = run(history);

    vi.setSystemTime(4_000_000_000_000);
    const late = run(history);

    expect(late).toStrictEqual(early);
    expect(late.end.deadline).toStrictEqual({ at: 62_000, name: "registration" });
  });
});

const view = (events: readonly NetworkEvent[]) => inspect(fold(events, input));

describe(inspect, () => {
  const withLogin: NetworkEvent = { ...attempt, loginLines: 1, services: ["NickServ"] };
  const identified = [withLogin, opened, welcome, line("376"), sent(4000, true)];

  it("says there is no Connection before an ATTEMPT, and after a close", () => {
    expect(view([]).registration).toStrictEqual({ _tag: "None" });
    expect(view(histories.closed).registration).toStrictEqual({ _tag: "None" });
  });

  it("CONN-4: names the nick being offered while registering", () => {
    expect(view([attempt]).registration).toStrictEqual({ _tag: "Connecting" });
    expect(view([attempt, opened]).registration).toStrictEqual({
      _tag: "Registering",
      nick: "claude",
    });
    expect(view([attempt, opened, line("433", "*", "claude", "Taken")]).registration).toStrictEqual(
      { _tag: "Registering", nick: "claudia" }
    );
  });

  it("CONN-3: keeps when the Session began, through the close the Daemon chose", () => {
    const welcomed = { _tag: "Welcomed", at: 3000, nick: "claude" };

    expect(view(histories.session).registration).toStrictEqual(welcomed);
    expect(view(histories.closing).registration).toStrictEqual(welcomed);
  });

  it("calls a Connection given up on before any welcome abandoned", () => {
    expect(view([attempt, opened, expire("registration", 62_000)]).registration).toStrictEqual({
      _tag: "Abandoned",
    });
  });

  it("CONN-6: joins only in a Session, once the login is settled", () => {
    expect(view(histories.registering).joinable).toBeFalsy();
    expect(view(histories.session).joinable).toBeTruthy();
    expect(view(identified).joinable).toBeFalsy();
    expect(view([...identified, expire("login", 6000)]).joinable).toBeTruthy();
  });

  it("LIVE-11: joins nothing once the Session is being left, whoever decided it", () => {
    expect(view([...histories.session, { at: 5000, type: "LEAVING" }]).joinable).toBeFalsy();
    expect(view(histories.closing).joinable).toBeFalsy();
  });

  it("CONN-6: reads how the login went, in the service's words", () => {
    expect(view(histories.session).login).toStrictEqual({ state: "none" });
    expect(view(identified).login).toStrictEqual({ state: "waiting" });
    expect(view([...identified, expire("login", 6000)]).login).toStrictEqual({
      state: "timedOut",
    });
    expect(view([...identified, noticeFrom("NickServ!s@h")]).login).toStrictEqual({
      state: "succeeded",
      text: "You are now identified for claude.",
    });
  });

  it("CONN-6: takes a late sign as the answer, and asks the host for nothing", () => {
    const timedOut = fold([...identified, expire("login", 6000)], input);
    const { commands, next } = step(timedOut, { ...noticeFrom("NickServ!s@h"), at: 7000 });

    expect(commands).toStrictEqual([]);
    expect(inspect(next).login.state).toBe("succeeded");
  });

  it("CONN-6: still takes a sign once closing, and asks the host for nothing", () => {
    const leaving = fold([...identified, { at: 4500, reason: "bye", type: "CLOSING" }], input);
    const { commands, next } = step(leaving, noticeFrom("NickServ!s@h"));

    expect(commands).toStrictEqual([]);
    expect(deadline(next)).toBeUndefined();
    expect(inspect(next).login.state).toBe("succeeded");
  });
});
