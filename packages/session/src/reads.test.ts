import { describe, expect, it } from "vitest";

import type { Entry, NetworkId, NewEntry } from "./entry.ts";
import {
  movesReads,
  namesSettleLimitMillis,
  namesSettleMillis,
  readAsks,
  readPlan,
  readPlanMoved,
  readTimeoutMillis,
  whoMembersLimit,
} from "./reads.ts";
import { readErrors, foldStandings, noStanding, noStandings, reduceStanding } from "./standing.ts";
import type { Standing } from "./standing.ts";
import { attemptInput } from "./testing.ts";

const encoder = new TextEncoder();
const network: NetworkId = "libera";

// Writes a Log by hand, one Entry a call, at the time the script has got to.
class Log {
  readonly entries: Entry[] = [];
  at = 1_000_000;
  connection = 0;
  standing: Standing = noStanding;

  append(entry: NewEntry) {
    this.entries.push({ ...entry, at: this.at, sequence: this.entries.length + 1 });

    const recorded = this.entries.at(-1);

    this.standing =
      recorded === undefined ? this.standing : reduceStanding(this.standing, recorded);

    return this;
  }

  wait(millis: number) {
    this.at += millis;

    return this;
  }

  session() {
    this.connection = this.entries.length + 1;

    return this.append({
      _tag: "Connection",
      ircd: { host: "irc.example", port: 6697, tls: true },
      network,
      nicks: ["alice"],
      ...attemptInput,
      phase: "attempt",
    })
      .append({
        _tag: "Connection",
        connection: this.connection,
        ircd: { host: "irc.example", port: 6697, tls: true },
        network,
        phase: "opened",
      })
      .in(":irc 001 alice :Welcome");
  }

  closed() {
    return this.append({
      _tag: "Connection",
      connection: this.connection,
      ircd: { host: "irc.example", port: 6697, tls: true },
      network,
      phase: "closed",
      reason: "gone",
    });
  }

  in(...texts: readonly string[]) {
    for (const text of texts) {
      this.append({
        _tag: "Line",
        bytes: encoder.encode(text),
        connection: this.connection,
        direction: "inbound",
        network,
      });
    }

    return this;
  }

  out(text: string, cause = "read") {
    return this.append({
      _tag: "Line",
      bytes: encoder.encode(text),
      cause,
      connection: this.connection,
      direction: "outbound",
      network,
    });
  }

  // Self joins, and the Ircd answers as a JOIN is answered: topic, then members (KNOW-5).
  joined(channel: string, members = "alice @bob") {
    return this.in(
      `:alice!u@h JOIN ${channel}`,
      `:irc 332 alice ${channel} :a topic`,
      `:irc 353 alice = ${channel} :${members}`,
      `:irc 366 alice ${channel} :End of /NAMES list.`
    );
  }

  get plan() {
    return readPlan(this.standing, this.at);
  }

  get planned() {
    return this.plan.reads.map(({ line }) => new TextDecoder().decode(line.toBytes()));
  }

  // Sends whatever is planned, one Line at a time, as the reconciler does.
  sendPlanned() {
    for (const text of this.planned) {
      this.out(text);
    }

    return this;
  }
}

const joinedOne = () => new Log().session().joined("#one");

const many = (count: number) =>
  Array.from({ length: count }, (_unused, index) => `m${index}`).join(" ");

const movedBy = (log: Log, ...texts: readonly string[]) => {
  const before = log.standing;

  log.in(...texts);

  return readPlanMoved(before, log.standing);
};

// Joined, with its modes and its users read, so that nothing is left to read.
const settled = () =>
  joinedOne()
    .out("MODE #one")
    .in(":irc 324 alice #one +nt", ":irc 329 alice #one 1700000000")
    .out("WHO #one")
    .in(
      ":irc 352 alice #one u h irc alice H :0 Alice",
      ":irc 352 alice #one u h irc bob H@ :0 Bob",
      ":irc 315 alice #one :End of /WHO list."
    );

describe("KNOW-5: what a JOIN is followed by", () => {
  it("KNOW-5: asks `MODE` at once, and no `NAMES` or `TOPIC`, which the JOIN brought", () => {
    expect(joinedOne().planned).toStrictEqual(["MODE #one"]);
  });

  it("KNOW-5: asks `MODE` before the JOIN's `NAMES` has landed, and `WHO` only after", () => {
    const log = new Log().session().in(":alice!u@h JOIN #one");

    expect(log.planned).toStrictEqual(["MODE #one"]);

    log.sendPlanned().in(":irc 324 alice #one +nt");

    expect(log.plan).toStrictEqual({ lookAgainAt: undefined, reads: [] });

    log.in(":irc 353 alice = #one :alice", ":irc 366 alice #one :End");

    expect(log.planned).toStrictEqual(["WHO #one"]);
  });

  it("KNOW-5: `WHO` waits for the `MODE` in flight, because one read is in flight at once", () => {
    const log = joinedOne().sendPlanned();

    expect(log.plan).toStrictEqual({ lookAgainAt: log.at + readTimeoutMillis, reads: [] });

    log.in(":irc 324 alice #one +nt");

    expect(log.planned).toStrictEqual(["WHO #one"]);
  });

  it("KNOW-5: a `315` ends the `WHO`, and nothing is read again", () => {
    expect(settled().plan).toStrictEqual({ lookAgainAt: undefined, reads: [] });
    expect(settled().wait(readTimeoutMillis * 10).plan.reads).toStrictEqual([]);
  });

  it(`KNOW-5: a Channel of more than ${whoMembersLimit} members gets no \`WHO\``, () => {
    const big = new Log()
      .session()
      .joined("#big", `alice ${many(whoMembersLimit)}`)
      .sendPlanned();

    const small = new Log().session().joined("#ok", `alice ${many(whoMembersLimit - 1)}`);

    small.sendPlanned();

    big.in(":irc 324 alice #big +nt");
    small.in(":irc 324 alice #ok +nt");

    expect(big.standing.irc.channels.get("#big")?.members.size).toBe(whoMembersLimit + 1);
    expect(big.planned).toStrictEqual([]);
    expect(small.planned).toStrictEqual(["WHO #ok"]);
  });

  it("KNOW-5: a `324` for a Channel Self is not in reads nothing", () => {
    const log = joinedOne().sendPlanned().in(":irc 324 alice #elsewhere +nt");

    expect(log.planned).toStrictEqual([]);
  });

  it("KNOW-5: reads nothing until joining may go on, or once a close has begun", () => {
    const log = new Log();

    log.connection = 1;
    log.in(":alice!u@h JOIN #one");

    expect(log.plan).toStrictEqual({ lookAgainAt: undefined, reads: [] });
    expect(readPlan(noStanding, 0).reads).toStrictEqual([]);

    const closing = joinedOne().append({
      _tag: "Connection",
      chosen: true,
      connection: 1,
      ircd: { host: "irc.example", port: 6697, tls: true },
      network,
      phase: "closing",
      reason: "bye",
    });

    expect(closing.plan).toStrictEqual({ lookAgainAt: undefined, reads: [] });
  });

  it("KNOW-5: reads the Channels joined in the order they were joined, modes first", () => {
    const log = new Log().session().joined("#a").joined("#b");

    expect(log.planned).toStrictEqual(["MODE #a"]);

    log.sendPlanned().in(":irc 324 alice #a +nt");

    expect(log.planned).toStrictEqual(["MODE #b"]);

    log.sendPlanned().in(":irc 324 alice #b +nt");

    expect(log.planned).toStrictEqual(["WHO #a"]);
  });

  it("KNOW-3: a reply under another spelling the mapping in force allows reads the Channel", () => {
    const log = new Log().session().joined("#x[1]").sendPlanned();

    log.in(":irc 324 alice #X{1} +nt");

    expect(log.planned).toStrictEqual(["WHO #x[1]"]);
  });

  it("KNOW-5: a Frontend's own `MODE` read counts as asked, as a reply answers it", () => {
    const log = joinedOne().out("MODE #one", "api");

    expect(log.planned).toStrictEqual([]);
  });

  it("KNOW-5: a `MODE` that sets letters is not a read", () => {
    const log = joinedOne().out("MODE #one +m", "api");

    expect(log.planned).toStrictEqual(["MODE #one"]);
  });
});

describe("KNOW-5: a `NAMES` after a prefix mode is removed", () => {
  it(`KNOW-5: waits ${namesSettleMillis} ms after the last removal, then asks once`, () => {
    const log = settled().in(":op!o@h MODE #one -o bob");

    expect(log.plan).toStrictEqual({ lookAgainAt: log.at + namesSettleMillis, reads: [] });

    log.wait(namesSettleMillis - 1);

    expect(log.planned).toStrictEqual([]);

    log.wait(1);

    expect(log.planned).toStrictEqual(["NAMES #one"]);

    log.sendPlanned();

    expect(log.planned).toStrictEqual([]);
  });

  it("KNOW-5: a removal of a prefix nobody held asks nothing", () => {
    expect(settled().in(":op!o@h MODE #one -v bob").wait(namesSettleMillis).planned).toStrictEqual(
      []
    );
  });

  it("KNOW-5: each removal puts it off again", () => {
    const log = settled().in(":op!o@h MODE #one -o bob").wait(1500);

    log.in(":op!o@h MODE #one +o bob", ":op!o@h MODE #one -o bob");

    expect(log.wait(namesSettleMillis - 1).planned).toStrictEqual([]);
    expect(log.wait(1).planned).toStrictEqual(["NAMES #one"]);
  });

  it(`KNOW-5: a storm that never pauses still gets one after ${namesSettleLimitMillis} ms`, () => {
    const log = settled();
    const began = log.at;
    const plannedEachSecond: (readonly string[])[] = [];

    while (log.at < began + namesSettleLimitMillis) {
      log.in(":op!o@h MODE #one +o bob", ":op!o@h MODE #one -o bob");
      plannedEachSecond.push(log.planned);
      log.wait(1000);
    }

    expect(plannedEachSecond).toStrictEqual(Array.from({ length: 10 }, () => []));
    expect(log.planned).toStrictEqual(["NAMES #one"]);
  });

  it("KNOW-5: its `366` clears the removals it was asked after", () => {
    const log = settled().in(":op!o@h MODE #one -o bob").wait(namesSettleMillis).sendPlanned();

    log.in(":irc 353 alice = #one :alice +bob", ":irc 366 alice #one :End");

    expect(log.wait(readTimeoutMillis * 10).plan).toStrictEqual({
      lookAgainAt: undefined,
      reads: [],
    });
    expect(log.standing.irc.channels.get("#one")?.members.get("bob")?.prefixes).toBe("v");
  });

  it("KNOW-5: a removal while it is in flight gets a `NAMES` of its own", () => {
    const log = settled().in(":op!o@h MODE #one -o bob").wait(namesSettleMillis).sendPlanned();

    // Given back and taken away again while the reply is on its way.
    log.wait(100).in(":op!o@h MODE #one +o bob", ":irc 353 alice = #one :alice @bob");
    log.in(":op!o@h MODE #one -o bob", ":irc 366 alice #one :End");

    expect(log.planned).toStrictEqual([]);
    expect(log.wait(namesSettleMillis).planned).toStrictEqual(["NAMES #one"]);
  });

  it("KNOW-5: a removal before the JOIN's own `NAMES` landed is not answered by it", () => {
    const log = new Log()
      .session()
      .in(":alice!u@h JOIN #one", ":irc 353 alice = #one :alice @bob")
      .in(":op!o@h MODE #one -o bob")
      .in(":irc 366 alice #one :End")
      .sendPlanned()
      .in(":irc 324 alice #one +nt");

    expect(log.wait(namesSettleMillis).planned).toStrictEqual(["NAMES #one"]);
  });
});

describe("KNOW-6: reading an uncertain Channel again", () => {
  it("KNOW-6: a `MODE` that does not add up reads modes and members again", () => {
    const log = settled().in(":op!o@h MODE #one +l");

    expect(log.standing.irc.channels.get("#one")?.modesUncertain).toBeTruthy();
    expect(log.planned).toStrictEqual(["MODE #one"]);

    log.sendPlanned().in(":irc 324 alice #one +ntl 10");

    expect(log.planned).toStrictEqual(["NAMES #one"]);

    log.sendPlanned().in(":irc 353 alice = #one :alice @bob", ":irc 366 alice #one :End");

    expect(log.plan).toStrictEqual({ lookAgainAt: undefined, reads: [] });
  });

  it("KNOW-6: a `324` that does not add up leaves modes to be asked again, with backoff", () => {
    const log = settled().in(":op!o@h MODE #one +l");
    const askedAt = log.at;

    log.sendPlanned().in(":irc 324 alice #one +l");

    expect(log.standing.irc.channels.get("#one")?.modesUncertain).toBeTruthy();
    // Answered, so it holds nothing in flight, and the `NAMES` goes first.
    expect(log.planned).toStrictEqual(["NAMES #one"]);

    log.sendPlanned().in(":irc 353 alice = #one :alice @bob", ":irc 366 alice #one :End");

    expect(log.plan).toStrictEqual({ lookAgainAt: askedAt + readTimeoutMillis, reads: [] });
    expect(log.wait(readTimeoutMillis).planned).toStrictEqual(["MODE #one"]);
  });
});

describe("KNOW-5: a read that gets no reply", () => {
  it(`KNOW-5: may be asked again after ${readTimeoutMillis} ms, doubling, ${readAsks} times`, () => {
    // Before the JOIN's `NAMES` lands, so that `MODE` is the only read there is.
    const log = new Log().session().in(":alice!u@h JOIN #one");
    const asks: number[] = [];

    for (let minute = 0; minute < 20; minute += 1) {
      if (log.planned.length > 0) {
        asks.push(log.at);
        log.sendPlanned();
      }

      log.wait(readTimeoutMillis);
    }

    const began = asks[0] ?? 0;

    expect(asks.map((at) => at - began)).toStrictEqual([
      0,
      readTimeoutMillis,
      readTimeoutMillis * 3,
    ]);
    expect(log.plan).toStrictEqual({ lookAgainAt: undefined, reads: [] });
  });

  it("KNOW-5: one timed out frees its place in flight for the next", () => {
    const log = new Log().session().joined("#a").joined("#b").sendPlanned();

    expect(log.planned).toStrictEqual([]);
    expect(log.wait(readTimeoutMillis).planned).toStrictEqual(["MODE #b"]);
  });

  it("KNOW-5: 200 Channels at burst keep one read in flight", () => {
    const log = new Log().session();

    for (let index = 0; index < 200; index += 1) {
      log.joined(`#c${index}`);
    }

    for (let round = 0; round < 400; round += 1) {
      const { reads } = log.plan;

      expect(reads.length).toBeLessThanOrEqual(1);
      log.sendPlanned();

      const [read] = reads;

      if (read?.kind === "modes") {
        log.in(`:irc 324 alice ${read.channel} +nt`);
      } else if (read?.kind === "who") {
        log.in(`:irc 315 alice ${read.channel} :End`);
      }
    }

    expect(log.plan).toStrictEqual({ lookAgainAt: undefined, reads: [] });

    const sent = log.entries.filter((entry) => entry._tag === "Line" && entry.cause === "read");

    expect(sent).toHaveLength(400);
  });
});

describe("LIVE-6: what a Session asked does not outlive it", () => {
  it("LIVE-6: a new Session starts clean, and reads what it joins at once", () => {
    const log = joinedOne().sendPlanned().closed();

    expect(log.standing.reads.size).toBe(0);

    log.session().joined("#one");

    expect(log.planned).toStrictEqual(["MODE #one"]);
  });

  it("KNOW-5: a Channel Self parted, or was kicked from, drops everything pending", () => {
    const parted = joinedOne().sendPlanned().in(":alice!u@h PART #one");
    const kicked = joinedOne().sendPlanned().in(":op!o@h KICK #one alice :out");

    expect(parted.standing.reads.size).toBe(0);
    expect(kicked.standing.reads.size).toBe(0);
  });

  it("KNOW-5: a JOIN echoed for a Channel Self is in keeps what was read", () => {
    const log = settled().in(":alice!u@h JOIN #one");

    expect(log.plan).toStrictEqual({ lookAgainAt: undefined, reads: [] });
  });

  it("HOST-1: endless JOINs and reads of made-up Channels are bounded", () => {
    const log = new Log().session();

    for (let index = 0; index < 3000; index += 1) {
      log.in(`:alice!u@h JOIN #made-up-${index}`).out(`MODE #made-up-${index}`);
    }

    expect(log.standing.reads.size).toBe(1024);
  });
});

describe("LOG-10: a restart mid-read", () => {
  it("LOG-10: rebuilds the same reads from the Log, and asks nothing twice before its timeout", () => {
    const log = new Log().session().joined("#a").joined("#b").sendPlanned();
    const replayed = foldStandings(noStandings, log.entries).get(network);

    expect(replayed?.reads).toStrictEqual(log.standing.reads);
    expect(replayed && readPlan(replayed, log.at)).toStrictEqual(log.plan);
    expect(log.plan.reads).toStrictEqual([]);

    const later = replayed && readPlan(replayed, log.at + readTimeoutMillis);

    expect(later?.reads.map(({ channel }) => channel)).toStrictEqual(["#b"]);
  });
});

describe("HOST-1, KNOW-3: reads follow the Channels IrcState holds", () => {
  it("HOST-1: past 1024 Channels, reads drop the Channel IrcState drops, and no other", () => {
    const log = new Log().session();

    for (let index = 0; index < 1024; index += 1) {
      log.in(`:alice!u@h JOIN #c${index}`);
    }

    log.out("MODE #c0").in(":irc 324 alice #c0 +nt").in(":alice!u@h JOIN #c1024");

    const { irc, reads } = log.standing;

    expect([...reads.keys()]).toStrictEqual([...irc.channels.keys()]);
    expect(irc.channels.has("#c0")).toBeFalsy();
    expect(reads.get("#c1")?.read.modes).toBeFalsy();
    expect(log.planned).toStrictEqual(["MODE #c1"]);
  });

  it("KNOW-3: of two Channels a new mapping merges, the one kept keeps its own reads", () => {
    const log = new Log()
      .session()
      .in(":irc 005 alice CASEMAPPING=ascii :are supported")
      .in(":alice!u@h JOIN #x[1]", ":alice!u@h JOIN #x{1}")
      .out("MODE #x[1]")
      .in(":irc 324 alice #x[1] +nt")
      .in(":irc 005 alice CASEMAPPING=rfc1459 :are supported");

    const { irc, reads } = log.standing;

    expect([...irc.channels.values()].map(({ name }) => name)).toStrictEqual(["#x{1}"]);
    expect([...reads.keys()]).toStrictEqual([...irc.channels.keys()]);
    expect(log.planned).toStrictEqual(["MODE #x{1}"]);
  });

  it("KNOW-3: a new mapping that merges nothing keeps every Channel's reads", () => {
    const log = new Log()
      .session()
      .in(":irc 005 alice CASEMAPPING=ascii :are supported")
      .joined("#A")
      .sendPlanned()
      .in(":irc 324 alice #A +nt")
      .in(":irc 005 alice CASEMAPPING=rfc1459 :are supported");

    expect(log.planned).toStrictEqual(["WHO #A"]);
  });
});

describe("KNOW-5: only a read in the Daemon's own shape is asked, or answered", () => {
  it("KNOW-5: a filtered `WHO` and its `315` read nothing", () => {
    const log = joinedOne().sendPlanned().in(":irc 324 alice #one +nt");

    log.out("WHO #one o", "api").in(":irc 315 alice #one :End");

    expect(log.standing.reads.get("#one")?.read.who).toBeFalsy();
    expect(log.planned).toStrictEqual(["WHO #one"]);
  });

  it("KNOW-5: a `315` with no `WHO` asked reads nothing", () => {
    const log = joinedOne().sendPlanned().in(":irc 324 alice #one +nt", ":irc 315 alice #one :x");

    expect(log.planned).toStrictEqual(["WHO #one"]);
  });

  it("KNOW-5: a `NAMES` of a list asks nothing, and a later `366` with none asked reads nothing", () => {
    const log = settled().in(":op!o@h MODE #one -o bob").out("NAMES #one,#two", "api");

    expect(log.standing.reads.get("#one")?.asked.names).toBeUndefined();

    log.in(":irc 353 alice = #one :alice +bob", ":irc 366 alice #one :End");

    expect(log.wait(namesSettleMillis).planned).toStrictEqual(["NAMES #one"]);
  });

  it("KNOW-5: the JOIN's own `NAMES` still lets `WHO` go", () => {
    expect(joinedOne().sendPlanned().in(":irc 324 alice #one +nt").planned).toStrictEqual([
      "WHO #one",
    ]);
  });
});

describe("KNOW-5: an error naming the Channel answers its read", () => {
  it.each([
    ["403", ":irc 403 alice #a :No such channel"],
    ["442", ":irc 442 alice #a :You're not on that channel"],
    ["476", ":irc 476 #a :Bad Channel Mask"],
    ["479", ":irc 479 alice #a :Illegal channel name"],
  ])("KNOW-5: a %s frees the read in flight, and its backoff carries on", (numeric, text) => {
    const log = new Log().session().in(":alice!u@h JOIN #a", ":alice!u@h JOIN #b");
    const askedAt = log.at;

    log.sendPlanned().in(text);

    expect([readErrors.has(numeric), movesReads(numeric)]).toStrictEqual([true, true]);
    expect(log.standing.reads.get("#a")?.asked.modes).toMatchObject({
      answered: true,
      count: 1,
      failed: true,
    });
    expect(log.planned).toStrictEqual(["MODE #b"]);

    log.sendPlanned().in(":irc 324 alice #b +nt");

    expect(log.plan).toStrictEqual({ lookAgainAt: askedAt + readTimeoutMillis, reads: [] });
    expect(log.wait(readTimeoutMillis).planned).toStrictEqual(["MODE #a"]);
  });

  it("KNOW-5: an error naming another Channel answers nothing", () => {
    const log = new Log().session().in(":alice!u@h JOIN #a", ":alice!u@h JOIN #b").sendPlanned();

    log.in(":irc 403 alice #b :No such channel");

    expect(log.planned).toStrictEqual([]);
  });
});

const big = () =>
  new Log()
    .session()
    .joined("#big", `alice ${many(whoMembersLimit)}`)
    .sendPlanned()
    .in(":irc 324 alice #big +nt");

describe("KNOW-5: a Channel shrinking under the `WHO` limit", () => {
  it.each([
    ["PART", ":m0!u@h PART #big"],
    ["KICK", ":op!o@h KICK #big m0 :out"],
    ["QUIT", ":m0!u@h QUIT :gone"],
  ])("KNOW-5: a %s that brings it under the limit moves the plan to a `WHO`", (command, text) => {
    const log = big();

    expect(log.planned).toStrictEqual([]);
    expect(movesReads(command)).toBeTruthy();
    expect(movedBy(log, text)).toBeTruthy();
    expect(log.planned).toStrictEqual(["WHO #big"]);
  });

  it("KNOW-5: a netsplit's QUITs cost the wake check a small part of what folding them does", () => {
    const log = new Log().session();
    const nicks = Array.from({ length: 2000 }, (_unused, index) => `u${index}`);

    for (let channel = 0; channel < 20; channel += 1) {
      log.joined(`#c${channel}`, nicks.join(" "));
    }

    let { standing } = log;
    let folding = 0;
    let checking = 0;
    let wakes = 0;

    for (const [index, nick] of nicks.entries()) {
      const entry: Entry = {
        _tag: "Line",
        at: log.at,
        bytes: encoder.encode(`:${nick}!u@h QUIT :*.net *.split`),
        connection: log.connection,
        direction: "inbound",
        network,
        sequence: log.entries.length + index + 1,
      };

      const began = performance.now();
      const after = reduceStanding(standing, entry);
      const folded = performance.now();

      wakes += readPlanMoved(standing, after) ? 1 : 0;
      checking += performance.now() - folded;
      folding += folded - began;
      standing = after;
    }

    // Every Channel crosses the limit on the same `QUIT`, and nothing else wakes a plan.
    expect(wakes).toBe(1);
    expect(checking).toBeLessThan(folding / 2);
  });
});

describe(readPlanMoved, () => {
  it("KNOW-5: sees nothing in Messages, a member's JOIN, or a WHO reply's own Lines", () => {
    expect(movedBy(settled(), ":bob!u@h PRIVMSG #one :hi")).toBeFalsy();
    expect(movedBy(settled(), ":carol!u@h JOIN #one")).toBeFalsy();
    expect(movedBy(settled(), ":irc 352 alice #one u h irc carol H :0 Carol")).toBeFalsy();
    expect(movedBy(settled(), ":op!o@h MODE #one +m")).toBeFalsy();
  });

  it("KNOW-5, KNOW-6: sees a Channel joined, a reply, a removal, and an uneven MODE", () => {
    expect(movedBy(settled(), ":alice!u@h JOIN #two")).toBeTruthy();
    expect(movedBy(joinedOne().sendPlanned(), ":irc 324 alice #one +nt")).toBeTruthy();
    expect(movedBy(settled(), ":op!o@h MODE #one -o bob")).toBeTruthy();
    expect(movedBy(settled(), ":op!o@h MODE #one +l")).toBeTruthy();
  });

  it("KNOW-5: Lines of a command it never names cannot move a plan", () => {
    expect(["PRIVMSG", "NOTICE", "352", "353"].map(movesReads)).toStrictEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(["315", "QUIT", "MODE"].map(movesReads)).toStrictEqual([true, true, true]);
  });
});
