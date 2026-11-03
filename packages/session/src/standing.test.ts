import { defaultTuning } from "@iirc/lifecycle/tuning";
import type { Tuning } from "@iirc/lifecycle/tuning";
import { nickCandidates } from "@iirc/protocol/nick";
import type { Array as Arr } from "effect";
import { describe, expect, it } from "vitest";

import type { Entry, Ircd, Json, NetworkId, NewEntry } from "./entry.ts";
import { toEvent } from "./events.ts";
import {
  candidateNicks,
  channelKey,
  connectionView,
  consecutiveFailures,
  foldStandings,
  joinPlan,
  joinPlanMoved,
  kickStanding,
  kicksInForce,
  loginOf,
  nextAttempt,
  noStanding,
  noStandings,
  reduceStanding,
  sessionSince,
} from "./standing.ts";
import type { Gap, WantedChannel } from "./standing.ts";
import { attemptInput } from "./testing.ts";

const encoder = new TextEncoder();
const started = 1_000_000;

const first: Ircd = { host: "one.example", port: 6697, tls: true };
const second: Ircd = { host: "two.example", port: 6697, tls: true };
const third: Ircd = { host: "three.example", port: 6667, tls: false };

const oneIrcd: Arr.NonEmptyReadonlyArray<Ircd> = [first];
const threeIrcds: Arr.NonEmptyReadonlyArray<Ircd> = [first, second, third];

const initial = defaultTuning.reconnectInitialMillis;
const maximum = defaultTuning.reconnectMaxMillis;
const stable = defaultTuning.stableAfterMillis;
const joinRetry = defaultTuning.joinRetryMillis;
const registrationTimeout = defaultTuning.registrationTimeoutMillis;

const foldOne = (entries: readonly Entry[]) => {
  let standing = noStanding;

  for (const entry of entries) {
    standing = reduceStanding(standing, entry);
  }

  return standing;
};

// Writes a Log by hand: every call appends one Entry, at the time the script has got to.
class Script {
  readonly entries: Entry[] = [];
  readonly network: NetworkId;
  at = started;
  connection = 0;

  constructor(network: NetworkId = "libera") {
    this.network = network;
  }

  append(entry: NewEntry) {
    this.entries.push({ ...entry, at: this.at, sequence: this.entries.length + 1 });

    return this;
  }

  wait(millis: number) {
    this.at += millis;

    return this;
  }

  attempt(ircd: Ircd = first, nicks: readonly string[] = ["alice"]) {
    this.connection = this.entries.length + 1;

    return this.append({
      _tag: "Connection",
      ircd,
      network: this.network,
      nicks,
      ...attemptInput,
      phase: "attempt",
    });
  }

  opened() {
    return this.append({
      _tag: "Connection",
      connection: this.connection,
      ircd: first,
      network: this.network,
      phase: "opened",
    });
  }

  closing(reason = "leaving", chosen = true) {
    return this.append({
      _tag: "Connection",
      chosen,
      connection: this.connection,
      ircd: first,
      network: this.network,
      phase: "closing",
      reason,
    });
  }

  closed(reason?: string, connection = this.connection) {
    return this.append({
      _tag: "Connection",
      connection,
      ircd: first,
      network: this.network,
      phase: "closed",
      ...(reason !== undefined && { reason }),
    });
  }

  refused(reason: string) {
    return this.append({
      _tag: "Connection",
      connection: this.connection,
      ircd: first,
      network: this.network,
      phase: "closed",
      reason,
      refused: true,
    });
  }

  // Something the Owner altered, which only whoever reads Changes can make sense of.
  change(change: Json = null) {
    return this.append({ _tag: "Change", by: "local", change, network: this.network });
  }

  get head() {
    return this.entries.length;
  }

  daemon(phase: "started" | "stopped") {
    return this.append({ _tag: "Daemon", phase, version: "0.0.0" });
  }

  deadline(name = "burst") {
    return this.append({ _tag: "Deadline", name, network: this.network });
  }

  dropped(text = "PRIVMSG #iirc :too late") {
    return this.append({
      _tag: "Dropped",
      bytes: encoder.encode(text),
      cause: "api",
      connection: this.connection,
      network: this.network,
      reason: "the Connection ended",
    });
  }

  in(text: string, cut?: true) {
    return this.append({
      _tag: "Line",
      bytes: encoder.encode(text),
      connection: this.connection,
      ...(cut && { cut }),
      direction: "inbound",
      network: this.network,
    });
  }

  out(text: string, cause = "test") {
    return this.append({
      _tag: "Line",
      bytes: encoder.encode(text),
      cause,
      connection: this.connection,
      direction: "outbound",
      network: this.network,
    });
  }

  welcome(nick = "alice") {
    return this.in(`:ircd.example 001 ${nick} :Welcome`);
  }

  // A Connection that opened and reached a Session.
  session(ircd: Ircd = first) {
    return this.attempt(ircd).opened().welcome();
  }

  // A Connection that failed before reaching a Session.
  failure(reason = "connection refused") {
    return this.attempt().closed(reason);
  }

  get standing() {
    return foldOne(this.entries);
  }

  next(
    ircds: Arr.NonEmptyReadonlyArray<Ircd> = oneIrcd,
    tuning: Tuning = defaultTuning,
    retrySince?: number
  ) {
    return nextAttempt(this.standing, { ircds, retrySince, tuning });
  }

  delay() {
    return this.next().at - this.at;
  }

  failures(tuning: Tuning = defaultTuning) {
    return consecutiveFailures(this.standing, tuning, this.at);
  }
}

const plan = (script: Script, wanted: readonly WantedChannel[], tuning: Tuning = defaultTuning) =>
  joinPlan(script.standing, wanted, script.at, tuning);

const planned = (script: Script, wanted: readonly WantedChannel[]) =>
  plan(script, wanted).channels.map(({ name }) => name);

const wantedIirc: readonly WantedChannel[] = [{ name: "#iirc" }];

const expectUpperHalf = (delay: number, full: number) => {
  expect(delay).toBeGreaterThanOrEqual(full / 2);
  expect(delay).toBeLessThanOrEqual(full);
};

const busy = () =>
  new Script()
    .session()
    .in(":ircd.example 005 alice NICKLEN=30 CHANTYPES=# :are supported")
    .in(":alice!u@h JOIN #iirc")
    .in(":alice!u@h JOIN #rust")
    .in(":mod!u@h KICK #rust alice :out")
    .out("PING lag-1", "lag-check")
    .in(":ircd.example PONG ircd.example :lag-1");

const checked = () => new Script().session().wait(100).out("PING lag-1", "lag-check");

const session = () => new Script().session();

const kicked = () =>
  new Script().session().in(":alice!u@h JOIN #iirc").wait(10).in(":mod!u@h KICK #iirc alice :out");

// Every change to any Gap, the last of which is how each one stands.
const gapsOf = (entries: readonly Entry[]) => {
  const gaps = new Map<number, Gap>();

  foldStandings(noStandings, entries, ({ after, before }) => {
    if (after.gap !== undefined && after.gap !== before.gap) {
      gaps.set(after.gap.sequence, after.gap);
    }
  });

  return [...gaps.values()];
};

// A small seeded generator (MINSTD), so that a failure can be rerun from its seed.
const generator = (seed: number) => {
  let state = seed;

  const next = () => {
    state = (state * 48_271) % 2_147_483_647;

    return state / 2_147_483_647;
  };

  return {
    below: (limit: number) => Math.floor(next() * limit),
    pick: <A>(items: Arr.NonEmptyReadonlyArray<A>): A =>
      items[Math.floor(next() * items.length)] ?? items[0],
  };
};

describe("LIVE-4: when to reconnect", () => {
  it("LIVE-4: an empty Log attempts now, at the first Ircd", () => {
    expect(nextAttempt(noStanding, { ircds: threeIrcds, tuning: defaultTuning })).toStrictEqual({
      at: 0,
      delayMillis: 0,
      ircd: first,
    });
  });

  it("LIVE-4: the first failure waits in the upper half of the first delay", () => {
    const script = new Script().failure();

    expect(script.failures()).toBe(1);
    expectUpperHalf(script.delay(), initial);
  });

  it("LIVE-4: delays double up to the limit, and stay there", () => {
    const script = new Script();

    for (let failures = 1; failures <= 12; failures += 1) {
      script.failure();

      expect(script.failures()).toBe(failures);
      expectUpperHalf(script.delay(), Math.min(initial * 2 ** (failures - 1), maximum));
    }
  });

  it("LIVE-4: jitter is seeded by the last attempt, so it scatters between attempts", () => {
    const delays = Array.from({ length: 40 }, (_unused, padding) => {
      const script = new Script();

      for (let count = 0; count < padding; count += 1) {
        script.deadline();
      }

      return script.failure().delay();
    });

    expect(new Set(delays).size).toBeGreaterThan(20);

    for (const delay of delays) {
      expectUpperHalf(delay, initial);
    }
  });

  it("LIVE-4: a restart computes exactly the same time", () => {
    const script = new Script().failure().failure().failure();
    const before = script.next();

    script.wait(2000).daemon("stopped").wait(1000).daemon("started");

    expect(script.next()).toStrictEqual(before);
  });

  it("LIVE-4: nextAttempt needs no clock, so asking later changes nothing", () => {
    const script = new Script().failure();
    const { standing } = script;

    expect(nextAttempt(standing, { ircds: oneIrcd, tuning: defaultTuning })).toStrictEqual(
      nextAttempt(standing, { ircds: oneIrcd, tuning: defaultTuning })
    );
  });

  it("LIVE-4: a Session that lasted long enough resets the count", () => {
    const script = new Script().failure().failure();

    script.session().wait(stable).closed("gone");

    expect(script.failures()).toBe(0);
    expectUpperHalf(script.delay(), initial);

    script.failure();

    expect(script.failures()).toBe(1);
    expectUpperHalf(script.delay(), initial);
  });

  it("LIVE-4: a stable Session's unexpected close still waits the first delay", () => {
    const script = new Script().session().wait(stable).closed("gone");

    expect(script.failures()).toBe(0);
    expectUpperHalf(script.delay(), initial);
  });

  it("LIVE-4: a stable Session the process was killed in still waits the first delay", () => {
    const script = new Script().session().wait(stable).in(":ircd.example NOTICE alice :hi");

    script.wait(1000).daemon("started");

    expect(script.failures()).toBe(0);
    expectUpperHalf(script.delay(), initial);
  });

  it("LIVE-4: a Session one millisecond short of it does not", () => {
    const script = new Script().failure();

    script
      .session()
      .wait(stable - 1)
      .closed("gone");

    expect(script.failures()).toBe(2);
    expectUpperHalf(script.delay(), initial * 2);
  });

  it("LIVE-4: a Session is measured from its 001, not from the Connection", () => {
    const script = new Script().attempt().opened().wait(stable).welcome().wait(1000).closed("gone");

    expect(script.failures()).toBe(1);
    expectUpperHalf(script.delay(), initial);
  });

  it("LIVE-4: a Connection that never reached a Session fails however long it lasted", () => {
    const script = new Script()
      .attempt()
      .opened()
      .wait(stable * 2)
      .closed("registration timed out");

    expect(script.failures()).toBe(1);
  });

  it("LIVE-4: what counts as long enough comes from Tuning, not from the fold", () => {
    const script = new Script().failure().session().wait(10_000).closed("gone");

    expect(script.failures()).toBe(2);
    expect(script.failures({ ...defaultTuning, stableAfterMillis: 10_000 })).toBe(0);
    expectUpperHalf(
      script.next(oneIrcd, { ...defaultTuning, stableAfterMillis: 10_000 }).at - script.at,
      initial
    );
  });

  it("LOG-2: a close the Daemon decided but did not choose is still a failure", () => {
    const script = new Script().session().wait(1000).closing("write failed", false).closed("gone");

    expect(script.failures()).toBe(1);
    expectUpperHalf(script.delay(), initial);
  });

  it("LOG-2: a killed process after an unchosen `closing` counts a failure too", () => {
    const script = new Script().session().wait(1000).closing("silence", false);

    script.wait(1000).daemon("started");

    expect(script.failures()).toBe(1);
  });

  it("LIVE-7: nothing is planned once any close has been decided", () => {
    const script = session().closing("write failed", false);

    expect(plan(script, wantedIirc)).toStrictEqual({ channels: [], lookAgainAt: undefined });
  });

  it("LOG-8: says what wait `at` stands for, so a clock set back cannot stretch it", () => {
    const failed = new Script().failure();
    const refused = new Script().attempt().opened().refused("banned");

    expect(failed.next().delayMillis).toBe(failed.delay());
    expect(refused.next().delayMillis).toBe(defaultTuning.refusalBackoffMillis);
    expect(nextAttempt(noStanding, { ircds: oneIrcd, tuning: defaultTuning }).delayMillis).toBe(0);
  });

  it("LIVE-4: a close after `closing` is not a failure, and retries at once", () => {
    const script = new Script().session().wait(1000).closing().closed("leaving");

    expect(script.failures()).toBe(0);
    expect(script.next().at).toBe(script.at);
  });

  it("LIVE-4: a chosen close neither adds to the count nor resets it", () => {
    const script = new Script().failure().failure();

    script.session().wait(1000).closing().closed("leaving");

    expect(script.failures()).toBe(2);
    expect(script.delay()).toBe(0);

    script.failure();

    expect(script.failures()).toBe(3);
    expectUpperHalf(script.delay(), initial * 4);
  });

  it("LIVE-4: a stable Session resets the count, even if the close was chosen", () => {
    const script = new Script().failure().session().wait(stable).closing().closed("leaving");

    expect(script.failures()).toBe(0);
  });

  it("LIVE-4: the count stops at what is held, and the delay stays at its limit", () => {
    const script = new Script();

    for (let failures = 0; failures < 200; failures += 1) {
      script.failure();
    }

    expect(script.failures()).toBe(64);
    expectUpperHalf(script.delay(), maximum);
  });

  it("LIVE-4: a stray close of another Connection counts for nothing", () => {
    const script = new Script().session().wait(1000).closed("stale", 999);

    expect(script.standing.connection?.sequence).toBe(1);
    expect(script.standing.recent).toStrictEqual([]);
  });

  it("LIVE-4: a second close of the same Connection counts once", () => {
    const script = new Script().attempt().closed("gone").closed("gone again");

    expect(script.failures()).toBe(1);
  });
});

describe("LIVE-4: a killed process", () => {
  it("LIVE-4: `Daemon started` ends a Connection at its last Entry, as a failure", () => {
    const script = new Script().session().wait(1000).deadline().wait(9000);
    const end = script.at - 9000;

    script.daemon("started");

    expect(script.standing.connection).toBeUndefined();
    expect(script.failures()).toBe(1);
    expect(script.standing.recent.at(-1)?.at).toBe(end);
    expectUpperHalf(script.next().at - end, initial);
  });

  it("LIVE-4: a later `attempt` ends it too", () => {
    const script = new Script().session().wait(1000).deadline().wait(9000).attempt();

    expect(script.standing.recent).toStrictEqual([
      {
        at: started + 1000,
        deliberate: false,
        reason: "the Daemon was killed",
        sessionMillis: 1000,
      },
    ]);
    expect(script.failures()).toBe(1);
  });

  it("LIVE-4: its last Entry may be its own `attempt`", () => {
    const script = new Script().attempt().wait(5000).daemon("started");

    expect(script.standing.recent.at(-1)?.at).toBe(started);
    expect(script.failures()).toBe(1);
  });

  it("LIVE-4: any Entry of the Network counts as its last, whichever way it went", () => {
    const script = new Script().session().wait(1000).out("PRIVMSG #iirc :hi");

    script.wait(1000).dropped().wait(1000).in("not read properly", true).wait(1000);

    const end = script.at - 1000;

    script.daemon("started");

    expect(script.standing.recent.at(-1)?.at).toBe(end);
  });

  it("LIVE-4: a killed Session that had lasted long enough resets the count, not the wait", () => {
    const script = new Script().failure().session().wait(stable).deadline().daemon("started");

    expect(script.failures()).toBe(0);
    expectUpperHalf(script.delay(), initial);
  });

  it("LIVE-4: a killed Session that had not lasted long enough is one", () => {
    const script = new Script()
      .session()
      .wait(stable - 1)
      .deadline()
      .daemon("started");

    expect(script.failures()).toBe(1);
  });

  it("LIVE-4: `Daemon stopped` with no close ends it, and counts as chosen", () => {
    const script = new Script().session().wait(1000).deadline().daemon("stopped");

    expect(script.standing.connection).toBeUndefined();
    expect(script.failures()).toBe(0);
  });

  it("LIVE-4: `closing` before the kill still means the Daemon chose to leave", () => {
    const script = new Script().session().wait(1000).closing().daemon("started");

    expect(script.failures()).toBe(0);
  });

  it("LIVE-4: a crash loop backs off further on every go round", () => {
    const script = new Script();

    for (let round = 1; round <= 8; round += 1) {
      script.attempt().wait(100).daemon("started");

      expect(script.failures()).toBe(round);

      const { at } = script.next();

      expectUpperHalf(at - (script.at - 100), Math.min(initial * 2 ** (round - 1), maximum));

      // The service manager is quick, but the host waits for this before it attempts.
      script.wait(Math.max(0, at - script.at));
    }
  });

  it("LIVE-4: restarting while waiting cannot bring the attempt forward", () => {
    const script = new Script().attempt().daemon("started");
    const { at } = script.next();

    for (let restart = 0; restart < 5; restart += 1) {
      script.wait(10).daemon("started");

      expect(script.next().at).toBe(at);
    }
  });

  it("LIVE-4: an open Connection is judged as if it had just been killed", () => {
    const script = new Script().session().wait(1000).deadline();
    const open = script.next();

    script.wait(1000).daemon("started");

    expect(script.next()).toStrictEqual(open);
  });

  it("LIVE-4: the count while a Connection runs covers only those that have ended", () => {
    const script = new Script().failure().session();

    expect(script.failures()).toBe(1);
  });
});

describe("LIVE-4: rotating Ircds", () => {
  it("LIVE-4: rotates after the Ircd the last attempt used, then wraps", () => {
    expect(new Script().attempt(first).next(threeIrcds).ircd).toBe(second);
    expect(new Script().attempt(second).next(threeIrcds).ircd).toBe(third);
    expect(new Script().attempt(third).next(threeIrcds).ircd).toBe(first);
  });

  it("LIVE-4: one Ircd is always the next", () => {
    expect(new Script().attempt(first).next(oneIrcd).ircd).toBe(first);
    expect(new Script().next(oneIrcd).ircd).toBe(first);
  });

  it("LIVE-4: matches by value, because Configuration builds new objects", () => {
    expect(new Script().attempt({ ...first }).next(threeIrcds).ircd).toBe(second);
  });

  it("LIVE-4: a different port or TLS is a different Ircd", () => {
    expect(new Script().attempt({ ...second, port: 1 }).next(threeIrcds).ircd).toBe(first);
    expect(new Script().attempt({ ...second, tls: false }).next(threeIrcds).ircd).toBe(first);
  });

  it("LIVE-4: starts at the first if that Ircd is no longer configured", () => {
    expect(new Script().attempt(third).next([second, first]).ircd).toBe(second);
  });

  it("LIVE-4: a killed Connection still rotates", () => {
    expect(new Script().attempt(first).daemon("started").next(threeIrcds).ircd).toBe(second);
  });
});

describe("LIVE-5: refusals", () => {
  const refusal = defaultTuning.refusalBackoffMillis;

  it("LIVE-5: waits at least the refusal from its close, keeping its words", () => {
    const script = new Script().attempt().opened().refused("You are banned (K-Line)");

    expect(script.standing.refusal).toStrictEqual({
      at: started,
      reason: "You are banned (K-Line)",
    });
    expect(script.next().at).toBe(started + refusal);
  });

  it("LIVE-5: survives a restart", () => {
    const script = new Script().attempt().refused("banned").wait(1000).daemon("started");

    expect(script.next().at).toBe(started + refusal);
    expect(script.standing.refusal?.reason).toBe("banned");
  });

  it("LIVE-5: stays in force after a later failure, and normal backoff still applies", () => {
    const script = new Script().attempt().refused("banned").wait(refusal).failure("timed out");

    expect(script.standing.refusal?.reason).toBe("banned");
    expect(script.failures()).toBe(2);
    expectUpperHalf(script.delay(), initial * 2);
  });

  it("LIVE-5: an early attempt that fails still leaves the refusal's wait to run", () => {
    const script = new Script().attempt().refused("banned").wait(60_000).failure("timed out");

    expect(script.next().at).toBe(started + refusal);
  });

  it("LIVE-5: the delay is the later of backoff and the refusal", () => {
    const shortRefusal = { ...defaultTuning, refusalBackoffMillis: 1000 };
    const script = new Script();

    for (let failures = 0; failures < 8; failures += 1) {
      script.failure();
    }

    script.attempt().refused("banned");

    expect(script.failures()).toBe(9);
    expectUpperHalf(script.next(oneIrcd, shortRefusal).at - script.at, maximum);
  });

  it("LIVE-5: applies even after a close the Daemon chose", () => {
    const script = new Script().attempt().refused("banned").wait(1000);

    script.attempt().closing().closed("leaving");

    expect(script.next().at).toBe(started + refusal);
  });

  it("LIVE-5: a newer refusal replaces the old one", () => {
    const script = new Script().attempt().refused("first").wait(5000).attempt().refused("second");

    expect(script.standing.refusal).toStrictEqual({ at: started + 5000, reason: "second" });
    expect(script.next().at).toBe(started + 5000 + refusal);
  });

  it("LIVE-5: a Session clears it", () => {
    const script = new Script().attempt().refused("banned").wait(refusal).session();

    expect(script.standing.refusal).toBeUndefined();

    script.wait(1000).closing().closed("leaving");

    expect(script.next().at).toBe(script.at);
  });

  it("LIVE-5: a close with no refusal mark is not one, whatever it says", () => {
    expect(new Script().attempt().closed("You are banned").standing.refusal).toBeUndefined();
  });
});

describe("LIVE-6: a new Session starts clean", () => {
  it("LIVE-6: `attempt` clears Channels, Self, and lag, and keeps NICKLEN and kicks", () => {
    const { standing } = busy().attempt();

    expect(busy().standing.lagMillis).toBe(0);
    expect({ lagMillis: standing.lagMillis, self: standing.irc.self }).toStrictEqual({
      lagMillis: undefined,
      self: undefined,
    });
    expect([...standing.irc.channels.keys()]).toStrictEqual([]);
    expect(standing.nickLength).toBe(30);
    expect([...standing.kicked.keys()]).toStrictEqual(["#rust"]);
  });

  it("LIVE-6: a close clears them as well, since nobody is on the Network", () => {
    const { standing } = busy().closed("gone");

    expect(standing.irc.self).toBeUndefined();
    expect(standing.irc.channels.size).toBe(0);
    expect(standing.kicked.size).toBe(1);
  });

  it("LIVE-6: `attempt` clears what was left by Lines no Connection owned", () => {
    const { standing } = new Script().welcome().in(":alice!u@h JOIN #iirc").attempt();

    expect(standing.irc.self).toBeUndefined();
    expect(standing.irc.channels.size).toBe(0);
  });

  it("LIVE-6: a kill clears them", () => {
    const { standing } = busy().daemon("started");

    expect(standing.irc.self).toBeUndefined();
    expect(standing.irc.channels.size).toBe(0);
  });

  it("LIVE-6: lag is cleared on close, and old checks are forgotten", () => {
    const script = busy().out("PING lag-2", "lag-check").closed("gone");

    expect(script.standing.lagMillis).toBeUndefined();

    script.attempt().opened().welcome();

    expect(script.standing.lagChecks).toStrictEqual([]);

    script.wait(40).in(":ircd.example PONG ircd.example :lag-2");

    expect(script.standing.lagMillis).toBeUndefined();
  });
});

describe("CONN-4: which nicks to try", () => {
  const identity = { alternates: ["ally"], nick: "alice" };

  it("CONN-4: first contact uses the first-contact limit", () => {
    expect(candidateNicks(noStanding, identity, defaultTuning)).toStrictEqual(
      nickCandidates({ ...identity, limit: defaultTuning.firstContactNickLimit })
    );
  });

  it("CONN-4: then NICKLEN from the last Session, through a reconnect and a restart", () => {
    const script = new Script()
      .session()
      .in(":ircd.example 005 alice NICKLEN=12 :are supported")
      .closed("gone")
      .daemon("started");

    expect(candidateNicks(script.standing, identity, defaultTuning)).toStrictEqual(
      nickCandidates({ ...identity, limit: 12 })
    );
  });

  it("CONN-4: a Session that does not say keeps the last one that did", () => {
    const script = new Script()
      .session()
      .in(":ircd.example 005 alice NICKLEN=12 :are supported")
      .closed("gone")
      .session()
      .in(":ircd.example 005 alice CHANTYPES=# :are supported");

    expect(script.standing.nickLength).toBe(12);
  });

  it("CONN-4: a newer Session that says otherwise wins", () => {
    const script = new Script()
      .session()
      .in(":ircd.example 005 alice NICKLEN=12 :are supported")
      .closed("gone")
      .session()
      .in(":ircd.example 005 alice NICKLEN=20 :are supported");

    expect(script.standing.nickLength).toBe(20);
  });

  it("CONN-4: a Network's absurd NICKLEN still gives a short list", () => {
    const script = new Script().session().in(":x 005 alice NICKLEN=4294967295 :are supported");

    expect(candidateNicks(script.standing, identity, defaultTuning).length).toBeLessThan(200);
  });
});

describe("CONN-3: Self", () => {
  it("CONN-3: the nick in 001 is the truth, then later NICKs", () => {
    const script = new Script().attempt().opened().welcome("alice_");

    expect(script.standing.irc.self).toBe("alice_");

    script.in(":alice_!u@h NICK :alicia");

    expect(script.standing.irc.self).toBe("alicia");
  });

  it("CONN-3: a second 001 changes nothing, nor when the Session began", () => {
    const script = new Script().attempt().opened().welcome().wait(1000).welcome("mallory");

    expect(script.standing.irc.self).toBe("alice");
    expect(sessionSince(script.standing)).toBe(started);
  });

  it("CONN-3: a welcome that names nobody is no Session, as the machine agrees", () => {
    const script = new Script().attempt().opened().in(":ircd.example 001");

    expect(sessionSince(script.standing)).toBeUndefined();
  });
});

describe("LIVE-4: a Connection under way", () => {
  it("says whether one is under way, and keeps its `attempt` after it ends", () => {
    const script = new Script().attempt();

    expect(script.standing.attempt).toStrictEqual({ at: started, ircd: first, sequence: 1 });
    expect(connectionView(script.standing)?.registration).toStrictEqual({ _tag: "Connecting" });

    script.wait(5).opened();

    expect(connectionView(script.standing)?.registration).toStrictEqual({
      _tag: "Registering",
      nick: "alice",
    });

    script.closed("gone");

    expect(script.standing.connection).toBeUndefined();
    expect(script.standing.attempt?.sequence).toBe(1);
  });

  it("LIVE-2: knows its last Entry, whichever way it went, which is where a kill ends it", () => {
    const script = new Script().attempt().opened().wait(10).in("").wait(10).out("PONG :1");

    expect(script.standing.connection?.last).toStrictEqual({ at: started + 20, sequence: 4 });
  });
});

// A Network that had a Session, closed it, and then refused us: a Gap is open, and the
// refusal is in force, so a wrong welcome would end the one and clear the other.
const refusedAfterSession = () =>
  new Script()
    .session()
    .closed("gone")
    .attempt()
    .opened()
    .in("ERROR :You are banned")
    .refused("You are banned");

// What a welcome that starts no Session must leave as it was.
const sessionOf = ({ standing }: Script) => ({
  gapEnded: standing.gap?.ended,
  refusal: standing.refusal?.reason,
  self: standing.irc.self,
  since: sessionSince(standing),
});

const noSession = {
  gapEnded: undefined,
  refusal: "You are banned",
  self: undefined,
  since: undefined,
};

const joinedBoth = () => new Script().session().in(":alice!u@h JOIN #a").in(":alice!u@h JOIN #b");

describe("LIVE-11: a welcome starts a Session only while registering", () => {
  it("LIVE-11: not after the registration deadline, inside the drain", () => {
    const script = refusedAfterSession().attempt().opened().wait(registrationTimeout);

    script.deadline("registration").welcome();

    expect(sessionOf(script)).toStrictEqual(noSession);
    expect(script.closed("registration timed out").standing.gap?.reason).toBe("gone");
  });

  // The host writes one only once it is due, but a clock set back can stamp it earlier, and
  // the host's own machine passed over it then, and went on to its welcome (LOG-8).
  it("LOG-8: a registration Deadline Entry stamped before the deadline changes nothing", () => {
    const script = new Script()
      .attempt()
      .opened()
      .wait(registrationTimeout - 1);

    script.deadline("registration").welcome();

    expect(sessionSince(script.standing)).toBe(started + registrationTimeout - 1);
    expect(script.standing.irc.self).toBe("alice");
  });

  it("LIVE-5: not after a refusal in the same read", () => {
    expect(
      sessionOf(refusedAfterSession().attempt().opened().in(":x 464 * :Bad password").welcome())
    ).toStrictEqual(noSession);
  });

  it("LIVE-11: not after the host decided to close", () => {
    expect(
      sessionOf(refusedAfterSession().attempt().opened().closing("write failed", false).welcome())
    ).toStrictEqual(noSession);
  });

  it("LIVE-9: not after the Daemon chose to leave", () => {
    expect(
      sessionOf(refusedAfterSession().attempt().opened().closing("leaving").welcome())
    ).toStrictEqual(noSession);
  });

  it("CONN-2: not before the transport is up", () => {
    expect(sessionOf(refusedAfterSession().attempt().welcome())).toStrictEqual(noSession);
  });

  it("CONN-4: not once the nicks have run out", () => {
    expect(
      sessionOf(
        refusedAfterSession()
          .attempt(first, ["alice"])
          .opened()
          .in(":x 433 * alice :In use")
          .welcome()
      )
    ).toStrictEqual(noSession);
  });

  it("CONN-4: not when the attempt named no nick", () => {
    expect(sessionOf(refusedAfterSession().attempt(first, []).opened().welcome())).toStrictEqual(
      noSession
    );
  });

  it("LIVE-5: not after any ERROR, transient or not", () => {
    expect(
      sessionOf(refusedAfterSession().attempt().opened().in("ERROR :Ping timeout: 2m0s").welcome())
    ).toStrictEqual(noSession);
  });

  it("CONN-4: a taken nick with another to try still lets the welcome in", () => {
    const script = new Script().attempt(first, ["alice", "alice_"]).opened();

    script.in(":x 433 * alice :In use").welcome("alice_");

    expect(script.standing.irc.self).toBe("alice_");
  });

  it("CONN-4: a 437 for a Channel is not one for the nick", () => {
    const script = new Script().attempt().opened().in(":x 437 * #chan :Held").welcome();

    expect(sessionSince(script.standing)).toBe(started);
  });

  it("LIVE-5: FAIL NICK and other deadlines refuse nothing", () => {
    const script = new Script().attempt().opened().deadline("burst");

    script.in("FAIL NICK NICKNAME_RESERVED alice :Reserved").welcome();

    expect(script.standing.irc.self).toBe("alice");
  });

  it("CONN-2: a welcome from no Connection names nobody", () => {
    expect(new Script().welcome().standing.irc.self).toBeUndefined();
  });
});

describe("LOG-2: what a decision to close says", () => {
  it("LOG-2: a kill after it keeps its reason for the Gap, and an unchosen one is a failure", () => {
    const script = new Script()
      .session()
      .wait(1000)
      .closing("write failed", false)
      .daemon("started");

    expect(script.standing.gap?.reason).toBe("write failed");
    expect(script.failures()).toBe(1);
  });

  it("LOG-2: a stop after it says the same", () => {
    const script = new Script().session().closing("iirc stopping").daemon("stopped");

    expect(script.standing.gap?.reason).toBe("iirc stopping");
    expect(script.failures()).toBe(0);
  });

  it("LOG-2: the first reason counts, and a later chosen leave makes it chosen", () => {
    const script = new Script().session().closing("write failed", false).closing("leaving");

    expect(script.standing.connection?.closing).toStrictEqual({
      chosen: true,
      reason: "write failed",
    });
  });

  it("LOG-2: a chosen leave stays chosen, whatever is decided after it", () => {
    const script = new Script().session().closing("leaving").closing("write failed", false);

    expect(script.standing.connection?.closing).toStrictEqual({ chosen: true, reason: "leaving" });
    expect(script.closed().failures()).toBe(0);
  });

  it("LOG-2: a close with no reason of its own takes the decision's", () => {
    const script = new Script().session().closing("heard nothing", false).closed();

    expect(script.standing.recent.at(-1)?.reason).toBe("heard nothing");
    expect(script.standing.gap?.reason).toBe("heard nothing");
  });
});

describe("LIVE-8: which kicks count", () => {
  it("LIVE-8: a kick from a Channel Self is not in counts for nothing", () => {
    const script = new Script().session().in(":mod!u@h KICK #elsewhere alice");

    expect(script.standing.kicked.size).toBe(0);
    expect(planned(script, [{ name: "#elsewhere" }])).toStrictEqual(["#elsewhere"]);
  });

  it("LIVE-8: a listed KICK pairs Channels with Users in order", () => {
    expect([
      ...joinedBoth().in(":m!u@h KICK #a,#b alice,bob").standing.kicked.keys(),
    ]).toStrictEqual(["#a"]);
    expect([
      ...joinedBoth().in(":m!u@h KICK #a,#b bob,alice").standing.kicked.keys(),
    ]).toStrictEqual(["#b"]);
  });

  it("LIVE-8: one Channel with several Users is a kick of each", () => {
    const script = new Script()
      .session()
      .in(":alice!u@h JOIN #a")
      .in(":m!u@h KICK #a bob,alice :out");

    expect([...script.standing.kicked.keys()]).toStrictEqual(["#a"]);
    expect(script.standing.irc.channels.size).toBe(0);
  });
});

describe("LIVE-4: failures as status reads them", () => {
  it("LIVE-4: a Session under way that has lasted long enough shows none", () => {
    const script = new Script().failure().failure().session();

    expect(script.failures()).toBe(2);
    expect(script.wait(stable - 1).failures()).toBe(2);
    expect(script.wait(1).failures()).toBe(0);
  });

  it("LIVE-4: a Session not yet welcomed resets nothing, however long it runs", () => {
    expect(
      new Script()
        .failure()
        .attempt()
        .opened()
        .wait(stable * 2)
        .failures()
    ).toBe(1);
  });
});

describe("LIVE-3: lag", () => {
  it("LIVE-3: is the PONG's time less the matching PING's, in milliseconds", () => {
    expect(checked().wait(37).in(":ircd PONG ircd :lag-1").standing.lagMillis).toBe(37);
  });

  it("LIVE-3: takes a PONG that carries only the token", () => {
    expect(checked().wait(37).in("PONG :lag-1").standing.lagMillis).toBe(37);
  });

  it("LIVE-3: an unknown token changes nothing", () => {
    const script = checked();
    const before = script.wait(7).in(":ircd PONG ircd :lag-1").standing.lagMillis;

    script.wait(50).in(":ircd PONG ircd :something-else");

    expect(script.standing.lagMillis).toBe(before);
  });

  it("LIVE-3: an answered token cannot be answered twice", () => {
    const script = checked().wait(7).in(":ircd PONG ircd :lag-1");

    script.wait(1000).in(":ircd PONG ircd :lag-1");

    expect(script.standing.lagMillis).toBe(7);
  });

  it("LIVE-3: only a lag check counts, which its cause says", () => {
    const script = new Script().session().out("PING lag-1", "api").wait(9);

    script.in(":ircd PONG ircd :lag-1");

    expect(script.standing.lagMillis).toBeUndefined();
  });

  it("LIVE-3: keeps the latest of several answers", () => {
    const script = checked().wait(10).out("PING lag-2", "lag-check").wait(5);

    script.in(":ircd PONG ircd :lag-1").wait(5).in(":ircd PONG ircd :lag-2");

    expect(script.standing.lagMillis).toBe(10);
  });

  it("LOG-8: a clock that jumped back gives no negative lag", () => {
    expect(checked().wait(-500).in(":ircd PONG ircd :lag-1").standing.lagMillis).toBe(0);
  });

  it("HOST-2: a cut PONG proves nothing", () => {
    expect(checked().wait(9).in(":ircd PONG ircd :lag-1", true).standing.lagMillis).toBeUndefined();
  });
});

describe("LIVE-7: which Channels to join", () => {
  it("LIVE-7: asks for what is wanted and not joined, as spelled and with keys", () => {
    const script = session().in(":alice!u@h JOIN #in");

    expect(
      plan(script, [
        { key: "sesame", name: "#Keyed" },
        { name: "#in" },
        { name: "#Out", rejoinOnKick: true },
      ])
    ).toStrictEqual({
      channels: [{ key: "sesame", name: "#Keyed" }, { name: "#Out" }],
      lookAgainAt: script.at + joinRetry,
    });
  });

  it("LIVE-7: nothing can be joined without a Session", () => {
    expect(plan(new Script().attempt().opened(), wantedIirc).channels).toStrictEqual([]);
    expect(plan(new Script().session().closed("gone"), wantedIirc).channels).toStrictEqual([]);
    expect(joinPlan(noStanding, wantedIirc, 0, defaultTuning).channels).toStrictEqual([]);
  });

  it("LIVE-11: nothing is planned once a close has begun", () => {
    expect(plan(new Script().session().closing(), wantedIirc)).toStrictEqual({
      channels: [],
      lookAgainAt: undefined,
    });
  });

  it("LIVE-7: wanting nothing, there is nothing to look at again", () => {
    expect(plan(session(), [])).toStrictEqual({ channels: [], lookAgainAt: undefined });
  });

  it("LIVE-7: being in everything, there is nothing to look at again", () => {
    expect(plan(session().in(":alice!u@h JOIN #iirc"), wantedIirc)).toStrictEqual({
      channels: [],
      lookAgainAt: undefined,
    });
  });

  it("LIVE-7: compares names without regard to ASCII case, on every path", () => {
    expect(planned(session().in(":alice!u@h JOIN #IIRC"), wantedIirc)).toStrictEqual([]);

    const left = session().in(":alice!u@h JOIN #iirc").in(":alice!u@h PART #IIRC");

    expect(left.standing.irc.channels.size).toBe(0);

    const removed = session().in(":alice!u@h JOIN #iirc").in(":mod!u@h KICK #IIRC alice");

    expect(removed.standing.irc.channels.size).toBe(0);
    expect(planned(removed, [{ name: "#iIrC" }])).toStrictEqual([]);
  });

  it("LIVE-7: folds ASCII letters and nothing else, for now", () => {
    expect(channelKey("#IiRc[]")).toBe("#iirc[]");
    expect(channelKey("#\u00C9")).toBe("#\u00C9");
  });

  it("LIVE-7: keeps the spelling the Ircd last used", () => {
    const { standing } = session().in(":alice!u@h JOIN #IIRC");

    expect(standing.irc.channels.get("#iirc")?.name).toBe("#IIRC");
  });

  it("LIVE-7: an unsolicited JOIN is simply joined, so it is not asked for", () => {
    const script = session().in(":alice!u@h JOIN #iirc");

    expect(script.standing.asked.size).toBe(0);
    expect(planned(script, wantedIirc)).toStrictEqual([]);
  });

  it("LIVE-7: someone else's JOIN is not ours", () => {
    expect(planned(session().in(":bob!u@h JOIN #iirc"), wantedIirc)).toStrictEqual(["#iirc"]);
  });

  it("LIVE-7: an unanswered JOIN is not asked for again until its retry is due", () => {
    const script = session().out("JOIN #iirc", "rejoin");
    const due = script.at + joinRetry;

    expect(plan(script, wantedIirc)).toStrictEqual({ channels: [], lookAgainAt: due });

    script.wait(joinRetry - 1);

    expect(planned(script, wantedIirc)).toStrictEqual([]);

    script.wait(1);

    expect(planned(script, wantedIirc)).toStrictEqual(["#iirc"]);
  });

  it("LIVE-7: reads every Channel of a batched JOIN, whoever sent it", () => {
    const script = session().out("JOIN #a,#B,#c keya,keyb", "api");

    expect([...script.standing.asked.keys()]).toStrictEqual(["#a", "#b", "#c"]);
  });

  it("LIVE-7: a Dropped JOIN was never asked for", () => {
    expect(planned(session().dropped("JOIN #iirc"), wantedIirc)).toStrictEqual(["#iirc"]);
  });

  it.each(["471", "473", "474", "477", "437"])(
    "LIVE-7: %s retries with doubling backoff, capped",
    (numeric) => {
      const script = session();

      for (let asks = 1; asks <= 8; asks += 1) {
        script.out("JOIN #iirc", "rejoin").wait(10);
        script.in(`:ircd.example ${numeric} alice #iirc :cannot join`);

        const delay = Math.min(joinRetry * 2 ** (asks - 1), maximum);

        expect(plan(script, wantedIirc).lookAgainAt).toBe(script.at - 10 + delay);

        script.wait(delay - 11);

        expect(planned(script, wantedIirc)).toStrictEqual([]);

        script.wait(1);

        expect(planned(script, wantedIirc)).toStrictEqual(["#iirc"]);
      }
    }
  );

  it("LIVE-7: says what went wrong, and when, keeping the Network's words", () => {
    const script = session().out("JOIN #IIRC", "rejoin").wait(5);

    script.in(":ircd.example 474 alice #Iirc :Cannot join channel (+b)");

    expect(script.standing.joinFailures.get("#iirc")).toStrictEqual({
      at: started + 5,
      connection: 1,
      numeric: "474",
      text: "Cannot join channel (+b)",
    });
  });

  it("LIVE-7: the failure stays in status across a reconnect, until Self gets in", () => {
    const script = session().out("JOIN #iirc", "rejoin");

    script.in(":ircd.example 474 alice #iirc :banned").closed("gone").session();

    expect(script.standing.joinFailures.has("#iirc")).toBeTruthy();

    script.out("JOIN #iirc", "rejoin").in(":alice!u@h JOIN #iirc");

    expect(script.standing.joinFailures.has("#iirc")).toBeFalsy();
  });

  it("LIVE-7: 475 does not retry on this Connection", () => {
    const script = session().out("JOIN #iirc", "rejoin");

    script.in(":ircd.example 475 alice #iirc :bad key").wait(maximum * 10);

    expect(plan(script, wantedIirc)).toStrictEqual({ channels: [], lookAgainAt: undefined });
  });

  it.each(["403", "405", "407", "476", "479", "489", "520"])(
    "LIVE-7: %s shows in status and does not retry on this Connection",
    (numeric) => {
      const script = session().out("JOIN #iirc", "rejoin");

      script.in(`:ircd.example ${numeric} alice #iirc :no`);

      expect(script.standing.joinFailures.get("#iirc")).toMatchObject({ numeric, text: "no" });

      script.wait(maximum * 10);

      expect(plan(script, wantedIirc)).toStrictEqual({ channels: [], lookAgainAt: undefined });
    }
  );

  it.each(["437", "471", "473", "474", "477"])("LIVE-7: %s retries", (numeric) => {
    const script = session().out("JOIN #iirc", "rejoin");

    script.in(`:ircd.example ${numeric} alice #iirc :no`).wait(joinRetry);

    expect(planned(script, wantedIirc)).toStrictEqual(["#iirc"]);
  });

  it.each(["403", "476"])("LIVE-7: %s retries on a later Connection", (numeric) => {
    const script = session().out("JOIN #iirc", "rejoin");

    script.in(`:ircd.example ${numeric} alice #iirc :no`).closed("gone").session();

    expect(planned(script, wantedIirc)).toStrictEqual(["#iirc"]);
  });

  it("LIVE-7: 475 retries on a later Connection, even after a restart", () => {
    const script = session().out("JOIN #iirc", "rejoin");

    script.in(":ircd.example 475 alice #iirc :bad key").daemon("started").session();

    expect(planned(script, wantedIirc)).toStrictEqual(["#iirc"]);
  });

  it("LIVE-7: a new Connection asks again at once, and backoff starts over", () => {
    const script = session();

    for (let asks = 0; asks < 3; asks += 1) {
      script.out("JOIN #iirc", "rejoin").in(":ircd.example 474 alice #iirc :banned");
    }

    script.closed("gone").session();

    expect(script.standing.asked.size).toBe(0);
    expect(plan(script, wantedIirc)).toStrictEqual({
      channels: [{ name: "#iirc" }],
      lookAgainAt: script.at + joinRetry,
    });
  });

  it("LIVE-7: a failure nobody asked for is ignored, so it blocks nothing", () => {
    const script = session().in(":ircd.example 475 alice #iirc :bad key");

    expect(script.standing.joinFailures.size).toBe(0);
    expect(planned(script, wantedIirc)).toStrictEqual(["#iirc"]);
  });

  it("LIVE-7: a 437 for a nick lands nowhere", () => {
    const script = new Script().attempt().in(":ircd.example 437 * alice :Nick unavailable");

    expect(script.standing.joinFailures.size).toBe(0);
  });

  it("LIVE-7: repeating a numeric cannot put a retry off", () => {
    const script = session().out("JOIN #iirc", "rejoin");
    const due = script.at + joinRetry;

    for (let repeat = 1; repeat < 100; repeat += 1) {
      script.wait(joinRetry / 100).in(":ircd.example 474 alice #iirc :banned");

      expect(plan(script, wantedIirc)).toStrictEqual({ channels: [], lookAgainAt: due });
    }

    expect(planned(script.wait(joinRetry / 100), wantedIirc)).toStrictEqual(["#iirc"]);
  });

  it("LIVE-7: looks again at the soonest of what is waiting", () => {
    const script = session().out("JOIN #a", "rejoin").wait(1000).out("JOIN #b", "rejoin");

    expect(plan(script, [{ name: "#b" }, { name: "#a" }]).lookAgainAt).toBe(started + joinRetry);
  });

  it("KNOW-1: a Part takes the Channel away from what Self is in", () => {
    const script = session().in(":alice!u@h JOIN #iirc").in(":alice!u@h PART #iirc :bye");

    expect(script.standing.irc.channels.size).toBe(0);
  });
});

describe("LIVE-8: kicks", () => {
  const kickRejoin = defaultTuning.kickRejoinMillis;

  it("LIVE-8: a kick wins over autojoin in this Session", () => {
    const script = kicked();

    expect(script.standing.irc.channels.size).toBe(0);
    expect(plan(script, wantedIirc)).toStrictEqual({ channels: [], lookAgainAt: undefined });
    expect(planned(script.wait(maximum * 100), wantedIirc)).toStrictEqual([]);
  });

  it("LIVE-8: and in the next, and across a restart", () => {
    const script = kicked().closed("gone").session();

    expect(planned(script, wantedIirc)).toStrictEqual([]);

    script.daemon("started").session();

    expect(planned(script, wantedIirc)).toStrictEqual([]);
    expect(script.standing.kicked.get("#iirc")).toStrictEqual({ at: started + 10, sequence: 5 });
  });

  it("LIVE-8: a JOIN of that Channel by Self clears it", () => {
    const script = kicked().out("JOIN #iirc", "api").in(":alice!u@h JOIN #IIRC");

    expect(script.standing.kicked.size).toBe(0);

    script.in(":alice!u@h PART #iirc");

    expect(planned(script, wantedIirc)).toStrictEqual(["#iirc"]);
  });

  it("LIVE-8: rejoin-on-kick waits, then asks", () => {
    const script = kicked();
    const wanted = [{ name: "#iirc", rejoinOnKick: true }];
    const due = started + 10 + kickRejoin;

    expect(plan(script, wanted)).toStrictEqual({ channels: [], lookAgainAt: due });
    expect(planned(script.wait(kickRejoin - 1), wanted)).toStrictEqual([]);
    expect(planned(script.wait(1), wanted)).toStrictEqual(["#iirc"]);
  });

  it("LIVE-8: rejoin-on-kick then backs off like any other JOIN", () => {
    const script = kicked().wait(kickRejoin).out("JOIN #iirc", "rejoin");
    const wanted = [{ name: "#iirc", rejoinOnKick: true }];

    script.in(":ircd.example 474 alice #iirc :banned");

    expect(plan(script, wanted)).toStrictEqual({
      channels: [],
      lookAgainAt: script.at + joinRetry,
    });
  });

  it("LIVE-8: an INVITE is never followed", () => {
    const script = kicked();
    const before = script.standing;

    script.in(":mod!u@h INVITE alice #iirc");

    expect(planned(script, wantedIirc)).toStrictEqual([]);
    expect(planned(script, [{ name: "#elsewhere" }])).toStrictEqual(["#elsewhere"]);
    expect(script.standing.kicked).toStrictEqual(before.kicked);
    expect(script.standing.irc.channels).toStrictEqual(before.irc.channels);
  });

  it("LIVE-8: a kick of someone else is no kick of Self", () => {
    const script = new Script().session().in(":alice!u@h JOIN #iirc").in(":a!u@h KICK #iirc bob");

    expect(script.standing.kicked.size).toBe(0);
    expect(script.standing.irc.channels.size).toBe(1);
  });

  it("LIVE-8: after a rename, a kick of the new nick is a kick of Self", () => {
    const script = new Script()
      .session()
      .in(":alice!u@h JOIN #x")
      .in(":alice!u@h NICK :alicia")
      .in(":a!u@h KICK #x alicia");

    expect(script.standing.kicked.has("#x")).toBeTruthy();
  });
});

describe("LOG-2: Entries that move nothing", () => {
  it("an Entry for another Network leaves the Standing exactly as it was", () => {
    const libera = new Script("libera").session().in(":alice!u@h JOIN #iirc");
    const { standing } = libera;

    const oftc = new Script("oftc")
      .session()
      .in(":alice!u@h JOIN #other")
      .in(":a!u@h KICK #other alice")
      .out("JOIN #more", "rejoin")
      .deadline()
      .dropped()
      .closed("gone");

    for (const entry of oftc.entries) {
      expect(reduceStanding(standing, entry)).toBe(standing);
    }
  });

  it("belongs to the first Network it hears of", () => {
    const { entries } = new Script("oftc").attempt();
    const owned = foldOne(entries);

    expect(owned.network).toBe("oftc");
  });

  it("a Daemon Entry with no Connection under way changes nothing", () => {
    const { standing } = new Script().failure();
    const [entry] = new Script().daemon("started").entries;

    expect(entry && reduceStanding(standing, entry)).toBe(standing);
  });

  it("a Daemon Entry says nothing to a Standing that has heard of no Network", () => {
    const [entry] = new Script().daemon("started").entries;

    expect(entry && reduceStanding(noStanding, entry)).toBe(noStanding);
  });

  it("HOST-2: a cut Line is not obeyed", () => {
    const { standing } = new Script()
      .attempt()
      .in(":ircd.example 001 mallory :Welcome", true)
      .in(":mallory!u@h JOIN #fake", true);

    expect(standing.irc.self).toBeUndefined();
    expect(standing.irc.channels.size).toBe(0);
    expect(sessionSince(standing)).toBeUndefined();
  });

  it("HOST-1: an unparseable Line is not obeyed", () => {
    const { standing } = new Script().attempt().in("").in("   ").in(":only-a-source");

    expect(standing.irc.self).toBeUndefined();
  });

  it("MSG-1: our own outbound Lines never move Channels or Self", () => {
    const { standing } = new Script()
      .session()
      .out(":mallory!u@h NICK :mallory")
      .out(":alice!u@h JOIN #fake")
      .out("KICK #iirc alice");

    expect(standing.irc.self).toBe("alice");
    expect(standing.irc.channels.size).toBe(0);
    expect(standing.kicked.size).toBe(0);
  });
});

describe(foldStandings, () => {
  it("LOG-2: gives each Network its own Standing, and a Daemon Entry reaches them all", () => {
    const libera = new Script("libera").session();
    const oftc = new Script("oftc").session();
    const [started_] = new Script().daemon("started").entries;

    const interleaved = [...libera.entries, ...oftc.entries, ...(started_ ? [started_] : [])].map(
      (entry, index): Entry => ({ ...entry, sequence: index + 1 })
    );

    const standings = foldStandings(noStandings, interleaved);

    expect(standings.get("libera")?.connection).toBeUndefined();
    expect(standings.get("oftc")?.connection).toBeUndefined();
    expect(standings.get("libera")?.recent).toHaveLength(1);
    expect(standings.get("oftc")?.recent).toHaveLength(1);
  });

  it("leaves what it was given as it was", () => {
    const before = foldStandings(noStandings, new Script().session().entries);
    const copy = new Map(before);

    foldStandings(before, new Script().attempt().entries);

    expect(before).toStrictEqual(copy);
  });

  it("agrees with reduceStanding, and hands each Line over parsed", () => {
    const script = new Script().session().in("").in(":a!u@h PRIVMSG #iirc :hi").out("PING :1");
    const lines: (string | undefined)[] = [];

    const standings = foldStandings(noStandings, script.entries, ({ line }) => {
      lines.push(line?.command);
    });

    expect(standings.get("libera")).toStrictEqual(script.standing);
    expect(lines).toStrictEqual([undefined, undefined, "001", undefined, "PRIVMSG", "PING"]);
  });
});

describe("LIVE-10: Gaps", () => {
  it("LIVE-10: time before a Network's first Session is not a Gap", () => {
    const script = new Script().failure().failure().attempt().opened().wait(1000).welcome();

    expect(gapsOf(script.entries)).toStrictEqual([]);
  });

  it("LIVE-10: a failed Connection that never had a Session opens none", () => {
    expect(gapsOf(new Script().failure().daemon("started").entries)).toStrictEqual([]);
  });

  it("LIVE-10: runs from a Session's close to the next 001, with both ends", () => {
    const script = new Script().session().wait(1000).closed("Connection reset by peer");
    const end = script.entries.length;

    script.wait(5000).failure().wait(5000).attempt().opened().wait(1000).welcome();

    expect(gapsOf(script.entries)).toStrictEqual([
      {
        at: started + 1000,
        ended: { at: started + 12_000, sequence: script.entries.length },
        network: "libera",
        reason: "Connection reset by peer",
        sequence: end,
      },
    ]);
  });

  it("LIVE-10: an open Gap has no end", () => {
    const script = new Script().session().closed("gone").failure();
    const [gap] = gapsOf(script.entries);

    expect(gap).toBeDefined();
    expect(gap && "ended" in gap).toBeFalsy();
    expect(script.standing.gap).toStrictEqual(gap);
  });

  it("LIVE-10: a close that gave no reason still says one", () => {
    expect(gapsOf(new Script().session().closed().entries)[0]?.reason).toBe(
      "the Connection closed"
    );
  });

  it("LIVE-10: a killed process begins it at the Session's last Entry", () => {
    const script = new Script().session().wait(1000).deadline();
    const last = script.entries.length;

    script.wait(9000).daemon("started").wait(5000).session();

    expect(gapsOf(script.entries)).toStrictEqual([
      {
        at: started + 1000,
        ended: { at: started + 15_000, sequence: script.entries.length },
        network: "libera",
        reason: "the Daemon was killed",
        sequence: last,
      },
    ]);
  });

  it("LIVE-10: a later `attempt` says the same", () => {
    const script = new Script().session().wait(1000).deadline().wait(1000).attempt();

    expect(gapsOf(script.entries)[0]).toMatchObject({
      at: started + 1000,
      reason: "the Daemon was killed",
    });
  });

  it("LIVE-10: a stop that recorded no close says so", () => {
    expect(gapsOf(new Script().session().daemon("stopped").entries)[0]?.reason).toBe(
      "the Daemon stopped"
    );
  });

  it("LIVE-10: a stop that closed first keeps the close's words", () => {
    const script = new Script().session().closing("iirc stopping").closed("iirc stopping");

    expect(gapsOf(script.daemon("stopped").entries)[0]?.reason).toBe("iirc stopping");
  });

  it("LIVE-10: a Gap that spans a restart does not start over", () => {
    const script = new Script().session().closed("gone").daemon("stopped").daemon("started");

    expect(gapsOf(script.entries)).toHaveLength(1);
    expect(gapsOf(script.entries)[0]?.reason).toBe("gone");
  });

  it("LIVE-10: a killed Connection inside a Gap does not begin another", () => {
    const script = new Script().session().closed("gone").attempt().daemon("started").session();

    expect(gapsOf(script.entries)).toHaveLength(1);
  });

  it("LIVE-10: every Session's end has its own Gap", () => {
    const script = new Script();

    for (let session = 0; session < 3; session += 1) {
      script.session().wait(1000).closed(`gone ${session}`).wait(1000);
    }

    script.session();

    const gaps = gapsOf(script.entries);

    expect(gaps.map(({ reason }) => reason)).toStrictEqual(["gone 0", "gone 1", "gone 2"]);
    expect(gaps.every(({ ended }) => ended !== undefined)).toBeTruthy();
  });

  it("LIVE-10: Gaps key on the Network", () => {
    const libera = new Script("libera").session().closed("libera went");
    const oftc = new Script("oftc").session();

    const interleaved = [...libera.entries, ...oftc.entries].map((entry, index): Entry => ({
      ...entry,
      sequence: index + 1,
    }));

    expect(gapsOf(interleaved).map(({ network }) => network)).toStrictEqual(["libera"]);
  });

  it("LIVE-10: a second 001 in a Session ends nothing", () => {
    const script = new Script().session().closed("gone").session().closed("again");
    const reopened = script.at;

    script.welcome("mallory");

    expect(script.standing.gap).toMatchObject({ at: reopened, reason: "again" });
    expect(script.standing.gap && "ended" in script.standing.gap).toBeFalsy();
  });
});

describe("HOST-1: nothing a Network sends grows a Standing", () => {
  const flood = 5000;

  const flooded = (line: (index: number) => string) => {
    const script = new Script().session();

    for (let index = 0; index < flood; index += 1) {
      script.in(line(index));
    }

    return script.standing;
  };

  it("HOST-1: endless JOINs of made-up Channels are bounded", () => {
    const {
      irc: { channels },
    } = flooded((index) => `:alice!u@h JOIN #made-up-${index}`);

    expect(channels.size).toBe(1024);
    expect(channels.has(`#made-up-${flood - 1}`)).toBeTruthy();
  });

  it("HOST-1: endless KICKs from Channels Self is not in hold nothing", () => {
    const { kicked } = flooded((index) => `:mod!u@h KICK #made-up-${index} alice`);

    expect(kicked.size).toBe(0);
  });

  it("HOST-1: endless JOIN and KICK pairs are bounded", () => {
    const {
      irc: { channels },
      kicked,
    } = flooded((index) =>
      index % 2 === 0
        ? `:alice!u@h JOIN #made-up-${index}`
        : `:mod!u@h KICK #made-up-${index - 1} alice`
    );

    expect(channels.size).toBeLessThanOrEqual(1024);
    expect(kicked.size).toBeLessThanOrEqual(1024);
  });

  it("HOST-1: endless failure numerics hold nothing", () => {
    const numerics = [
      "403",
      "405",
      "407",
      "437",
      "471",
      "473",
      "474",
      "475",
      "476",
      "477",
      "479",
      "489",
      "520",
    ];

    for (const numeric of numerics) {
      const { joinFailures } = flooded((index) => `:x ${numeric} alice #made-up-${index} :no`);

      expect(joinFailures.size).toBe(0);
    }
  });

  it("HOST-1: a real failure outlives a flood of made-up ones", () => {
    const script = new Script().session().out("JOIN #real", "rejoin");

    script.in(":x 474 alice #real :banned");

    for (let index = 0; index < flood; index += 1) {
      script.in(`:x 474 alice #made-up-${index} :no`);
    }

    expect([...script.standing.joinFailures.keys()]).toStrictEqual(["#real"]);
  });

  it("HOST-1: endless PONGs hold nothing", () => {
    expect(flooded((index) => `:x PONG x :${index}`).lagChecks).toHaveLength(0);
  });

  it("HOST-1: an Ircd that never answers holds a bounded number of lag checks", () => {
    const script = new Script().session();

    for (let check = 0; check < 200; check += 1) {
      script.out(`PING lag-${check}`, "lag-check");
    }

    expect(script.standing.lagChecks).toHaveLength(16);
    expect(script.standing.lagChecks.at(-1)?.token).toBe("lag-199");
  });

  it("HOST-1: only a real join clears a real kick", () => {
    const script = new Script().session().in(":alice!u@h JOIN #iirc").in(":m!u@h KICK #iirc alice");

    script.in(":bob!u@h JOIN #iirc");

    expect(script.standing.kicked.has("#iirc")).toBeTruthy();
  });

  it("HOST-1: endless reconnects are bounded", () => {
    const script = new Script();

    for (let session = 0; session < 500; session += 1) {
      script.session().closed("flapping");
    }

    expect(script.standing.recent).toHaveLength(64);
  });

  it("HOST-1: endless sends to a Channel are bounded, even our own", () => {
    const script = new Script().session();

    for (let index = 0; index < flood; index += 1) {
      script.out(`JOIN #asked-${index}`, "api");
    }

    expect(script.standing.asked.size).toBe(1024);
  });
});

describe("properties over random Entries", () => {
  const lines = [
    ":ircd 001 alice :Welcome",
    ":ircd 001",
    ":ircd 001 mallory",
    ":ircd 005 alice NICKLEN=12 :are supported",
    ":ircd 005 alice -NICKLEN :are supported",
    ":ircd 005 alice NICKLEN=99999999999999999999999 :are supported",
    ":alice!u@h JOIN #a",
    ":alice!u@h JOIN",
    ":alice!u@h JOIN #A,#B",
    ":alice!u@h PART #a",
    ":alice!u@h PART",
    ":alice!u@h NICK :alicia",
    ":alice!u@h NICK",
    ":alicia!u@h NICK :alice",
    ":mod!u@h KICK #a alice",
    ":mod!u@h KICK #a",
    ":mod!u@h KICK",
    ":bob!u@h JOIN #a",
    ":ircd 437 alice #a :no",
    ":ircd 471 alice #a :no",
    ":ircd 473 alice #b :no",
    ":ircd 474 alice #B :no",
    ":ircd 475 alice #a :no",
    ":ircd 477 alice",
    ":ircd 474",
    ":ircd PONG ircd :lag-1",
    "PONG",
    ":mod!u@h INVITE alice #a",
    "ERROR :Closing Link",
    "PING :1",
    "",
    " ",
    ":",
    ":source",
    "@a=b",
    "@a=b :x PRIVMSG #a :tagged",
  ] as const;

  const sent = ["JOIN #a,#b", "JOIN", "JOIN ,", "PING lag-1", "PING", "PONG :1"] as const;

  const randomEntry = (random: ReturnType<typeof generator>, script: Script) => {
    const network = random.below(8) === 0 ? "oftc" : "libera";

    const moves: readonly (() => void)[] = [
      () => script.attempt(random.pick(threeIrcds)),
      () => script.opened(),
      () => script.closing(),
      () => script.closed(random.pick(["gone", "", "\u0000 text"])),
      () => script.closed(undefined),
      () => script.closed("stray", random.below(50)),
      () => script.refused("banned"),
      () => script.daemon(random.pick(["started", "stopped"] as const)),
      () => script.deadline(),
      () => script.dropped(),
      () => script.in(random.pick(lines)),
      () => script.in(random.pick(lines)),
      () => script.in(random.pick(lines)),
      () => script.in(random.pick(lines)),
      () => script.in(random.pick(lines), true),
      () => script.out(random.pick(sent), random.pick(["lag-check", "rejoin", "api"])),
      () => {
        script.append({
          _tag: "Line",
          bytes: Uint8Array.from({ length: random.below(32) }, () => random.below(256)),
          connection: script.connection,
          direction: "inbound",
          network,
        });
      },
    ];

    script.wait(random.pick([0, 1, 1000, 60_000, stable]));
    random.pick([moves[0] ?? (() => {}), ...moves])();
  };

  const scripts = (count: number, length: number) =>
    Array.from({ length: count }, (_unused, seed) => {
      const random = generator(seed + 1);
      const script = new Script();

      for (let step = 0; step < length; step += 1) {
        randomEntry(random, script);
      }

      return { random, script, seed };
    });

  const generated = scripts(200, 300);

  it("LOG-10: reduceStanding, and every read of it, never throws", () => {
    let reads = 0;

    for (const { script } of generated) {
      let standing = noStanding;

      for (const entry of script.entries) {
        standing = reduceStanding(standing, entry);
        reads += nextAttempt(standing, { ircds: threeIrcds, tuning: defaultTuning }).at > 0 ? 1 : 0;
        joinPlan(standing, [{ name: "#a" }, { name: "#B", rejoinOnKick: true }], 0, defaultTuning);
        consecutiveFailures(standing, defaultTuning, 0);
      }

      candidateNicks(standing, { alternates: [], nick: "alice" }, defaultTuning);
    }

    expect(reads).toBeGreaterThan(0);
  });

  it("LOG-10: folding in one go equals folding across any split", () => {
    for (const { random, script } of generated) {
      const whole = foldStandings(noStandings, script.entries);
      const cut = random.below(script.entries.length + 1);

      const split = foldStandings(
        foldStandings(noStandings, script.entries.slice(0, cut)),
        script.entries.slice(cut)
      );

      expect(split).toStrictEqual(whole);
    }
  });

  it("LOG-10: one Entry at a time equals one batch", () => {
    for (const { script } of generated) {
      let stepped = noStandings;

      for (const entry of script.entries) {
        stepped = foldStandings(stepped, [entry]);
      }

      expect(stepped).toStrictEqual(foldStandings(noStandings, script.entries));
    }
  });

  it("LOG-10: the same Entries give the same answers, in a fresh fold", () => {
    for (const { script } of generated) {
      const once = nextAttempt(script.standing, { ircds: threeIrcds, tuning: defaultTuning });
      const again = nextAttempt(script.standing, { ircds: threeIrcds, tuning: defaultTuning });

      expect(again).toStrictEqual(once);
    }
  });

  it("LIVE-4: whatever the Log holds, the wait stays within the rules", () => {
    for (const { script } of generated) {
      const { standing } = script;
      const failures = consecutiveFailures(standing, defaultTuning, 0);

      expect(failures).toBeGreaterThanOrEqual(0);
      expect(failures).toBeLessThanOrEqual(64);

      const { at } = nextAttempt(standing, { ircds: threeIrcds, tuning: defaultTuning });
      const end = standing.connection?.last.at ?? standing.recent.at(-1)?.at ?? started;

      expect(Number.isInteger(at)).toBeTruthy();
      expect(at).toBeLessThanOrEqual(
        Math.max(end + maximum, (standing.refusal?.at ?? 0) + defaultTuning.refusalBackoffMillis)
      );
    }
  });

  it("LIVE-6: what a Session held never outlives its Connection", () => {
    for (const { script } of generated) {
      const { standing } = script.attempt();

      expect(standing.irc.self).toBeUndefined();
      expect(standing.irc.channels.size).toBe(0);
      expect(standing.asked.size).toBe(0);
      expect(standing.lagChecks).toHaveLength(0);
    }
  });

  it("LIVE-7: what is planned is never joined, kicked, or refused for good here", () => {
    for (const { script } of generated) {
      const { standing } = script;
      const wanted = [{ name: "#a" }, { name: "#b" }, { name: "#c" }];
      const { channels } = joinPlan(standing, wanted, Number.MAX_SAFE_INTEGER, defaultTuning);

      for (const { name } of channels) {
        const key = channelKey(name);
        const failure = standing.joinFailures.get(key);

        expect(standing.irc.channels.has(key)).toBeFalsy();
        expect(standing.kicked.has(key)).toBeFalsy();
        expect(
          failure !== undefined &&
            !["437", "471", "473", "474", "477"].includes(failure.numeric) &&
            failure.connection === standing.attempt?.sequence
        ).toBeFalsy();
      }
    }
  });

  it("LIVE-10: a Gap's end, once set, never changes while it is the latest", () => {
    const unended: Gap[] = [];

    for (const { script } of generated) {
      foldStandings(noStandings, script.entries, ({ after, before }) => {
        const same = after.gap?.sequence === before.gap?.sequence;

        if (same && before.gap?.ended !== undefined && after.gap?.ended !== before.gap.ended) {
          unended.push(before.gap);
        }
      });
    }

    expect(unended).toStrictEqual([]);
  });
});

describe("LIVE-4: a retry the Owner asked for", () => {
  const refusal = defaultTuning.refusalBackoffMillis;

  it("LIVE-4: a Change no attempt has answered retries now, whatever the backoff", () => {
    const script = new Script().failure().failure().failure().change();

    expect(script.next().at).toBeGreaterThan(script.at);
    expect(script.next(oneIrcd, defaultTuning, script.head)).toStrictEqual({
      at: 0,
      delayMillis: 0,
      ircd: first,
    });
  });

  it("LIVE-4, LIVE-5: and whatever is left of a refusal's wait", () => {
    const script = new Script().attempt().refused("banned").wait(1000).change();

    expect(script.next().at).toBe(started + refusal);
    expect(script.next(oneIrcd, defaultTuning, script.head).at).toBe(0);
  });

  it("LIVE-4: an attempt after the Change answers it, and backoff resumes", () => {
    const script = new Script().failure().failure().change();
    const since = script.head;

    script.failure();

    expect(script.next(oneIrcd, defaultTuning, since)).toStrictEqual(script.next());
    expect(script.failures()).toBe(3);
  });

  it("LIVE-4: rotates Ircds as any attempt does", () => {
    const script = new Script().attempt(first).closed("gone").change();

    expect(script.next(threeIrcds, defaultTuning, script.head).ircd).toStrictEqual(second);
  });

  it("LIVE-4: a restart folding the same Log decides the same", () => {
    const script = new Script().failure().failure().change().wait(10).daemon("started");
    const since = script.head - 1;
    const restarted = foldStandings(noStandings, script.entries).get("libera") ?? noStanding;

    expect(
      nextAttempt(restarted, { ircds: oneIrcd, retrySince: since, tuning: defaultTuning })
    ).toStrictEqual(script.next(oneIrcd, defaultTuning, since));
    expect(script.next(oneIrcd, defaultTuning, since).at).toBe(0);
  });
});

describe("LIVE-8: the Owner joining again", () => {
  const kickRejoin = defaultTuning.kickRejoinMillis;

  it("LIVE-8, CONF-5: a Join recorded after the kick clears it, with no Session", () => {
    const script = kicked().closed("gone").change({ join: "#iirc" });
    const wanted = [{ name: "#iirc", since: script.head }];

    script.session();

    expect(planned(script, wantedIirc)).toStrictEqual([]);
    expect(planned(script, wanted)).toStrictEqual(["#iirc"]);
  });

  it("LIVE-8: a kick after the Join still counts", () => {
    const script = new Script().session().change({ join: "#iirc" });
    const wanted = [{ name: "#iirc", since: script.head }];

    script.in(":alice!u@h JOIN #iirc").in(":mod!u@h KICK #iirc alice :out");

    expect(planned(script, wanted)).toStrictEqual([]);
  });

  it("LIVE-8: a cleared kick leaves no rejoin-on-kick wait behind", () => {
    const script = kicked().change({ join: "#iirc" });
    const wanted = [{ name: "#iirc", rejoinOnKick: true, since: script.head }];

    expect(plan(script, wanted).channels.map(({ name }) => name)).toStrictEqual(["#iirc"]);
    expect(planned(script, [{ name: "#iirc", rejoinOnKick: true }])).toStrictEqual([]);
    expect(plan(script, [{ name: "#iirc", rejoinOnKick: true }]).lookAgainAt).toBe(
      started + 10 + kickRejoin
    );
  });

  it("LIVE-8: a restart folding the same Log plans the same", () => {
    const script = kicked().closed("gone").change({ join: "#iirc" });
    const wanted = [{ name: "#iirc", since: script.head }, { name: "#rust" }];

    script.daemon("started").session().in(":mod!u@h KICK #rust alice :out");

    const restarted = foldStandings(noStandings, script.entries).get("libera") ?? noStanding;

    expect(joinPlan(restarted, wanted, script.at, defaultTuning)).toStrictEqual(
      plan(script, wanted)
    );
  });
});

const withChanges = () =>
  new Script()
    .change({ network: "libera" })
    .session()
    .change(null)
    .in(":alice!u@h JOIN #iirc")
    .change([1, "two", { three: false }]);

const withoutChanges = (script: Script) => script.entries.filter(({ _tag }) => _tag !== "Change");

// A Log already written replays as it did (LOG-10), except where Standing was wrong about
// IRC before `@iirc/state` owned it. Each of these replays differently on purpose, and the
// Logs in replay.jsonl hold none of them.
const joined = ({ standing }: Script) =>
  [...standing.irc.channels.values()].map(({ name }) => name);

describe("LOG-10: what a Log already written replays differently, on purpose", () => {
  it("KNOW-5: a JOIN naming several Channels puts Self in each, not in one named for the list", () => {
    const script = new Script().session().out("JOIN #a,#b", "rejoin").in(":alice!u@h JOIN #a,#b");

    expect(joined(script)).toStrictEqual(["#a", "#b"]);
    expect(script.standing.asked.size).toBe(0);
    expect(planned(script, [{ name: "#a" }, { name: "#b" }])).toStrictEqual([]);
  });

  it("KNOW-5: a PART naming several Channels leaves each, where before it left none", () => {
    const script = new Script()
      .session()
      .in(":alice!u@h JOIN #a")
      .in(":alice!u@h JOIN #b")
      .in(":alice!u@h PART #a,#b :bye");

    expect(joined(script)).toStrictEqual([]);
  });

  it("KNOW-5: an empty name is no Channel, where before `JOIN :` put Self in one called ``", () => {
    expect(joined(new Script().session().in(":alice!u@h JOIN :"))).toStrictEqual([]);
  });

  it("KNOW-3: under rfc1459, the default, a kick spelled `{}` counts for a Channel spelled `[]`", () => {
    const script = new Script()
      .session()
      .in(":alice!u@h JOIN #x[1]")
      .in(":op!u@h KICK #X{1} alice");

    // Before, Self stayed in `#x[1]` and the kick held nothing, so nothing kept Self out.
    expect(joined(script)).toStrictEqual([]);
    expect([...script.standing.kicked.keys()]).toStrictEqual(["#x[1]"]);
    expect(planned(script, [{ name: "#x[1]" }])).toStrictEqual([]);
  });

  it("KNOW-3: under ascii, those are two Channels, as they always were", () => {
    const script = new Script()
      .session()
      .in(":ircd.example 005 alice CASEMAPPING=ascii :are supported")
      .in(":alice!u@h JOIN #x[1]")
      .in(":op!u@h KICK #X{1} alice");

    expect(joined(script)).toStrictEqual(["#x[1]"]);
    expect(script.standing.kicked.size).toBe(0);
  });

  it("KNOW-3: Self is Self however the Ircd cases the nick, where before only the exact spelling was", () => {
    const script = new Script().session().in(":ALICE!u@h JOIN #b").in(":op!u@h KICK #b Alice");

    expect([...script.standing.kicked.keys()]).toStrictEqual(["#b"]);
  });

  // Before, every spelling was its own record, so these held under one and were missed
  // under the other.
  it("KNOW-3: a kick under the Ircd's spelling stands against the Channel wanted under another", () => {
    const script = new Script()
      .session()
      .out("JOIN #X{1}", "rejoin")
      .in(":alice!u@h JOIN #x[1]")
      .wait(10)
      .in(":op!u@h KICK #x[1] alice :out");

    const wanted = { name: "#X{1}", rejoinOnKick: false };

    expect(kickStanding(script.standing, wanted)).toStrictEqual({
      at: script.at,
      sequence: script.head,
    });
    expect(planned(script.wait(60_000), [wanted])).toStrictEqual([]);
  });

  it("KNOW-3: a refusal under another spelling counts for the Channel asked for", () => {
    const script = new Script()
      .session()
      .out("JOIN #X{1}", "rejoin")
      .in(":ircd.example 475 alice #x[1] :Cannot join channel (+k)");

    expect([...script.standing.joinFailures.keys()]).toStrictEqual(["#x[1]"]);
    expect(planned(script.wait(600_000), [{ name: "#X{1}" }])).toStrictEqual([]);
  });

  it("KNOW-3: a JOIN under another spelling clears what was asked, refused, and kicked", () => {
    const script = new Script()
      .session()
      .in(":alice!u@h JOIN #x[1]")
      .in(":op!u@h KICK #x[1] alice :out")
      .out("JOIN #X{1}", "api")
      .in(":ircd.example 474 alice #X{1} :Banned")
      .in(":alice!u@h JOIN #X{1}");

    const { asked, joinFailures, kicked } = script.standing;

    expect([asked.size, joinFailures.size, kicked.size]).toStrictEqual([0, 0, 0]);
  });
});

const kickedFromBrackets = (casemapping?: string) => {
  const script = new Script().session();

  if (casemapping !== undefined) {
    script.in(`:ircd.example 005 alice CASEMAPPING=${casemapping} :are supported`);
  }

  return script.in(":alice!u@h JOIN #x[1]").in(":op!u@h KICK #x[1] alice :out");
};

const standsAgainst = ({ standing }: Script, name: string) =>
  kickStanding(standing, { name }) !== undefined;

describe("KNOW-3: what outlives a Session follows the mapping in force", () => {
  it("compares under a `CASEMAPPING` that arrives after the kick", () => {
    const script = kickedFromBrackets().in(":ircd.example 005 alice CASEMAPPING=ascii :ok");

    expect(standsAgainst(script, "#X[1]")).toBeTruthy();
    expect(standsAgainst(script, "#x{1}")).toBeFalsy();
  });

  it("compares under the next Session's mapping, which is rfc1459 until it says", () => {
    const script = kickedFromBrackets("ascii");

    expect(standsAgainst(script, "#x{1}")).toBeFalsy();

    script.closed("gone");

    expect(standsAgainst(script, "#x{1}")).toBeTruthy();

    script.session().in(":ircd.example 005 alice CASEMAPPING=ascii :ok");

    expect(standsAgainst(script, "#x{1}")).toBeFalsy();
    expect(standsAgainst(script, "#x[1]")).toBeTruthy();
  });

  it("keeps the newest of two records one mapping makes the same", () => {
    const script = kickedFromBrackets("ascii")
      .wait(10)
      .in(":alice!u@h JOIN #x{1}")
      .in(":op!u@h KICK #x{1} alice :again")
      .in(":ircd.example 005 alice CASEMAPPING=rfc1459 :ok");

    expect(kickStanding(script.standing, { name: "#X[1]" })?.sequence).toBe(script.head - 1);
  });
});

// Under ascii `#x[1]` and `#x{1}` were two Channels, and each was kicked from. A
// later Session with no `CASEMAPPING` makes them one.
const kickedUnderBoth = () =>
  new Script()
    .session()
    .in(":ircd.example 005 alice CASEMAPPING=ascii :are supported")
    .in(":alice!u@h JOIN #x[1]")
    .in(":op!u@h KICK #x[1] alice :out")
    .wait(10)
    .in(":alice!u@h JOIN #x{1}")
    .in(":op!u@h KICK #x{1} alice :out")
    .closed("gone")
    .session();

const cpuMillis = (work: () => void) => {
  const before = process.cpuUsage();

  work();

  const { system, user } = process.cpuUsage(before);

  return (system + user) / 1000;
};

describe("KNOW-3: a kick that was recorded under spellings the mapping in force joins", () => {
  it("lists each spelling while nobody wants the Channel since", () => {
    const script = kickedUnderBoth();

    expect(kicksInForce(script.standing, []).map(({ channel }) => channel)).toStrictEqual([
      "#x[1]",
      "#x{1}",
    ]);
    expect(
      kicksInForce(script.standing, [{ name: "#X{1}", since: 1 }]).map(({ channel }) => channel)
    ).toStrictEqual(["#x[1]", "#x{1}"]);
  });

  it("lists neither once the Channel is wanted since both, as the plan says", () => {
    const script = kickedUnderBoth();
    const wanted = { name: "#x{1}", since: script.head + 1 };

    expect(kickStanding(script.standing, wanted)).toBeUndefined();
    expect(kicksInForce(script.standing, [wanted])).toStrictEqual([]);
    expect(planned(script.wait(60_000), [wanted])).toStrictEqual(["#x{1}"]);
  });

  it("lists the spelling kicked since the Channel was wanted, and no other", () => {
    const script = kickedUnderBoth();
    const [older, newer] = [...script.standing.kicked.values()];
    const wanted = { name: "#x[1]", since: older?.sequence ?? 0 };

    expect(kicksInForce(script.standing, [wanted])).toStrictEqual([
      { at: newer?.at, channel: "#x{1}" },
    ]);
    expect(kickStanding(script.standing, wanted)).toStrictEqual(newer);
  });
});

const kickedFromAlias = () =>
  new Script().session().in(":alice!u@h JOIN #x[1]").in(":op!u@h KICK #x[1] alice :out");

describe("KNOW-3, LIVE-8: wanted Channels that are one Channel share the latest intent", () => {
  it("clears the kick in status and in the plan alike, when one spelling is wanted since it", () => {
    const script = kickedFromAlias();

    const wanted = [
      { name: "#x[1]", since: 1 },
      { name: "#x{1}", since: script.head + 1 },
    ];

    expect(kicksInForce(script.standing, wanted)).toStrictEqual([]);
    expect(planned(script.wait(60_000), wanted)).toStrictEqual(["#x[1]", "#x{1}"]);
  });

  it("keeps the kick in status and in the plan alike, when no spelling is wanted since it", () => {
    const script = kickedFromAlias();

    const wanted = [
      { name: "#x[1]", since: 1 },
      { name: "#x{1}", since: 2 },
    ];

    expect(kicksInForce(script.standing, wanted).map(({ channel }) => channel)).toStrictEqual([
      "#x[1]",
    ]);
    expect(planned(script.wait(60_000), wanted)).toStrictEqual([]);
  });
});

// Every call above scans nothing it need not: a Network can hold 1024 of each, and a plan
// or a status was once cubic in them.
describe("KNOW-3: the cost of many aliasable Channels", () => {
  const count = 1024;
  const names = Array.from({ length: count }, (_, index) => `#x{${index}}`);

  const crowded = () => {
    const base = new Script().session().standing;

    return {
      ...base,
      asked: new Map(names.map((name, index) => [name, { at: started, count: (index % 3) + 1 }])),
      joinFailures: new Map(
        names.map((name) => [
          name,
          { at: started, connection: undefined, numeric: "474", text: "" },
        ])
      ),
      kicked: new Map(
        names.map((name, index) => [
          name.replace("{", "[").replace("}", "]"),
          { at: started, sequence: index + 1 },
        ])
      ),
    };
  };

  it("lists the kicks of 1024 wanted Channels without scanning for each", () => {
    const standing = crowded();
    const wanted = names.map((name, index) => ({ name, since: index % 2 === 0 ? 0 : 5000 }));
    let listed: ReturnType<typeof kicksInForce> = [];

    const cpu = cpuMillis(() => {
      listed = kicksInForce(standing, wanted);
    });

    expect(listed).toHaveLength(count / 2);
    // Cubic, it took seconds. A scan per kick would still take a few hundred milliseconds.
    expect(cpu).toBeLessThan(50);
  });

  it("plans 1024 wanted Channels without scanning for each", () => {
    const standing = crowded();
    let planThis: ReturnType<typeof joinPlan> | undefined;

    const cpu = cpuMillis(() => {
      planThis = joinPlan(
        standing,
        names.map((name) => ({ name, rejoinOnKick: true })),
        started + 1_000_000,
        defaultTuning
      );
    });

    expect(planThis?.channels).toHaveLength(count);
    expect(cpu).toBeLessThan(50);
  });
});

describe(joinPlanMoved, () => {
  it("KNOW-3: sees a `CASEMAPPING` that changes which Channels match", () => {
    const script = new Script().session().in(":alice!u@h JOIN #x[1]");
    const before = script.standing;

    script.in(":ircd.example 005 alice CASEMAPPING=ascii :ok");

    expect(joinPlanMoved(before, script.standing)).toBeTruthy();
    expect(planned(script, [{ name: "#x{1}" }])).toStrictEqual(["#x{1}"]);
  });

  it("sees nothing in a Line that moves no input of a plan", () => {
    const script = new Script().session().in(":alice!u@h JOIN #a");
    const before = script.standing;
    const seen = script.head;

    script.in(":bob!u@h PRIVMSG #a :hi").in(":ircd.example 005 alice NICKLEN=30 :ok");

    let after = before;

    for (const entry of script.entries.slice(seen)) {
      after = reduceStanding(after, entry);
    }

    expect(joinPlanMoved(before, after)).toBeFalsy();
  });
});

describe("LOG-2: a Change says nothing to Standing", () => {
  it("LOG-2: a fold with Changes in it is the fold without them", () => {
    const script = withChanges();
    const without = foldOne(withoutChanges(script));

    expect(script.standing.irc.channels).toStrictEqual(without.irc.channels);
    expect(connectionView(script.standing)).toStrictEqual(connectionView(without));
    expect(sessionSince(script.standing)).toBe(sessionSince(without));
  });

  it("LOG-2: no machine event comes of one", () => {
    expect(
      withChanges()
        .entries.filter(({ _tag }) => _tag === "Change")
        .map(toEvent)
    ).toStrictEqual([undefined, undefined, undefined]);
  });

  it("LOG-2: one for no Network makes no Standing", () => {
    const entry: Entry = { _tag: "Change", at: 1, by: "phone", change: {}, sequence: 1 };

    expect(foldStandings(noStandings, [entry]).size).toBe(0);
  });
});

// A Connection whose login sequence is one `IDENTIFY` to NickServ, past its burst.
const identifying = () => {
  const script = new Script();

  script.append({
    _tag: "Connection",
    ircd: first,
    network: script.network,
    nicks: ["alice"],
    ...attemptInput,
    loginLines: 1,
    phase: "attempt",
    services: ["NickServ"],
  });

  script.connection = script.head;

  return script
    .opened()
    .welcome()
    .in(":ircd.example 422 alice :No MOTD")
    .out("PRIVMSG NickServ :IDENTIFY <redacted>", "identify");
};

const loginWait = defaultTuning.loginWaitMillis;
const acceptedText = "Password accepted - you are now recognized.";
const accepted = `:NickServ!s@h NOTICE alice :${acceptedText}`;

describe("CONN-6: the login, as Standing reads it from the machine", () => {
  it("CONN-6: waits once `IDENTIFY` is out, and holds joining up", () => {
    const script = identifying();

    expect(loginOf(script.standing)).toStrictEqual({ state: "waiting" });
    expect(planned(script, wantedIirc)).toStrictEqual([]);
  });

  it("CONN-6: a sign answers it, in the service's words, and joining goes on", () => {
    const script = identifying().wait(10).in(accepted);

    expect(loginOf(script.standing)).toStrictEqual({ state: "succeeded", text: acceptedText });
    expect(planned(script, wantedIirc)).toStrictEqual(["#iirc"]);
  });

  it("CONN-6: the wait running out lets joining go on", () => {
    const script = identifying().wait(loginWait).deadline("login");

    expect(loginOf(script.standing)).toStrictEqual({ state: "timedOut" });
    expect(planned(script, wantedIirc)).toStrictEqual(["#iirc"]);
  });

  // On purpose: how the login went is what the Owner wants to see, however late it says.
  it("CONN-6: a sign after the wait ran out still says how the login went", () => {
    const script = identifying().wait(loginWait).deadline("login").wait(500);

    script.in(":NickServ!s@h NOTICE alice :Invalid password for alice.");

    expect(loginOf(script.standing)).toStrictEqual({
      state: "failed",
      text: "Invalid password for alice.",
    });
  });

  // On purpose, as well: the Daemon leaving does not make the service's answer less true.
  it("CONN-6: a sign during a close the Daemon chose still says how the login went", () => {
    const script = identifying().wait(10).closing("leaving").in(accepted);

    expect(loginOf(script.standing).state).toBe("succeeded");
    expect(planned(script, wantedIirc)).toStrictEqual([]);
  });

  it("CONN-6: a Deadline Entry stamped before the wait is over changes nothing (LOG-8)", () => {
    const script = identifying()
      .wait(loginWait - 1)
      .deadline("login");

    expect(loginOf(script.standing)).toStrictEqual({ state: "waiting" });
  });

  it("CONN-6: nothing is left of it once the Connection has closed", () => {
    expect(loginOf(identifying().wait(10).in(accepted).closed("gone").standing)).toStrictEqual({
      state: "none",
    });
  });
});

describe("LIVE-11: nothing is joined once the machine has given up", () => {
  // On purpose: Standing used to go on planning until the `closing` Entry was recorded, and
  // the lanes the close had shut refused what it planned.
  it.each(["ERROR :Closing Link", "ERROR :Ping timeout: 2m0s"])(
    "LIVE-11: after %s, before any `closing` is recorded",
    (error) => {
      const script = session();

      expect(planned(script, wantedIirc)).toStrictEqual(["#iirc"]);
      expect(planned(script.in(error), wantedIirc)).toStrictEqual([]);
      expect(sessionSince(script.standing)).toBe(started);
    }
  );

  it("LIVE-2: after silence, though the Session is still measured from its 001", () => {
    const script = session().wait(defaultTuning.silenceMillis).deadline("silence");

    expect(planned(script, wantedIirc)).toStrictEqual([]);
    expect(sessionSince(script.standing)).toBe(started);
  });
});
