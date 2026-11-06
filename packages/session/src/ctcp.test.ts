import { defaultTuning } from "@iirc/lifecycle/tuning";
import type { Tuning } from "@iirc/lifecycle/tuning";
import { describe, expect, it } from "vitest";

import {
  ctcpAnswer,
  ctcpRepliesIn,
  ctcpReplyCause,
  heldReplyTimes,
  heldRepliedUsers,
  longestPingArgument,
  replyExpired,
  utcTime,
} from "./ctcp.ts";
import type { Entry, NewEntry } from "./entry.ts";
import { foldStandings, noStanding, noStandings, reduceStanding } from "./standing.ts";
import type { Standing } from "./standing.ts";
import { attemptInput } from "./testing.ts";

const started = 1_700_000_000_000;
const ircd = { host: "irc.test", port: 6697, tls: true };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Writes a Log by hand, one Entry a call, at the time it has got to, and folds it as it
// goes. `answered` is what the Daemon decided to send for the Lines given so far.
class Script {
  readonly entries: Entry[] = [];
  standing: Standing = noStanding;
  at = started;
  connection = 0;

  append(entry: NewEntry) {
    const recorded: Entry = { ...entry, at: this.at, sequence: this.entries.length + 1 };

    this.entries.push(recorded);
    this.standing = reduceStanding(this.standing, recorded);

    return this;
  }

  wait(millis: number) {
    this.at += millis;

    return this;
  }

  attempt(tuning: Tuning = defaultTuning) {
    this.connection = this.entries.length + 1;

    return this.append({
      _tag: "Connection",
      ircd,
      network: "libera",
      nicks: ["iirc"],
      ...attemptInput,
      phase: "attempt",
      tuning,
    });
  }

  // A Connection, opened and welcomed as `iirc`.
  session(tuning: Tuning = defaultTuning) {
    return this.attempt(tuning)
      .append({
        _tag: "Connection",
        connection: this.connection,
        ircd,
        network: "libera",
        phase: "opened",
      })
      .in(":ircd 001 iirc :Welcome");
  }

  in(text: string) {
    return this.line(text, "inbound");
  }

  out(text: string, cause: string) {
    return this.line(text, "outbound", cause);
  }

  line(text: string, direction: "inbound" | "outbound", cause?: string) {
    return this.append({
      _tag: "Line",
      bytes: encoder.encode(text),
      connection: this.connection,
      direction,
      network: "libera",
      ...(cause !== undefined && { cause }),
    });
  }

  closing() {
    return this.append({
      _tag: "Connection",
      chosen: false,
      connection: this.connection,
      ircd,
      network: "libera",
      phase: "closing",
      reason: "going",
    });
  }

  closed() {
    return this.append({
      _tag: "Connection",
      connection: this.connection,
      ircd,
      network: "libera",
      phase: "closed",
      reason: "gone",
    });
  }

  restart() {
    return this.append({ _tag: "Daemon", phase: "stopped", version: "test" }).append({
      _tag: "Daemon",
      phase: "started",
      version: "test",
    });
  }

  // What the Daemon decided to send for the last Entry.
  get answered(): readonly string[] {
    return ctcpRepliesIn(this.standing, this.entries.slice(-1)).map(({ line }) =>
      decoder.decode(line.toBytes())
    );
  }

  // Records a reply as Dropped, as a host does for one that expired or found no room.
  dropped(text: string, reason = replyExpired) {
    return this.append({
      _tag: "Dropped",
      bytes: encoder.encode(text),
      cause: ctcpReplyCause,
      connection: this.connection,
      network: "libera",
      reason,
    });
  }

  // Sends what was decided for the last Entry, as a host's pump records it.
  sent() {
    for (const reply of this.answered) {
      this.out(reply, ctcpReplyCause);
    }

    return this;
  }
}

const request = (from: string, command: string, target = "iirc") =>
  `:${from}!u@h.test PRIVMSG ${target} :\u0001${command}\u0001`;

const version = (from = "bob") => request(from, "VERSION");

const notice = (to: string, text: string) => `NOTICE ${to} :\u0001${text}\u0001`;

// A TIME request answered with the process in a timezone, and that timezone's offset.
const timeAnsweredIn = (timezone: string) => {
  process.env.TZ = timezone;

  const script = new Script().session({ ...defaultTuning, ctcpTime: true }).wait(999);

  return {
    answered: script.in(request("bob", "TIME")).answered,
    offset: new Date(started).getTimezoneOffset(),
  };
};

describe("PROT-3: what a CTCP request is answered with", () => {
  it("PROT-3: answers VERSION with iirc, to the sender, as a NOTICE", () => {
    expect(new Script().session().in(version()).answered).toStrictEqual([
      notice("bob", "VERSION iirc"),
    ]);
  });

  it("PROT-3: echoes the argument to PING, spaces and all", () => {
    expect(new Script().session().in(request("bob", "PING 1700000000 123")).answered).toStrictEqual(
      [notice("bob", "PING 1700000000 123")]
    );
  });

  it("PROT-3: echoes a PING of at most 128 bytes, and answers a longer one with nothing", () => {
    const longest = "é".repeat(longestPingArgument / 2);

    expect(new Script().session().in(request("bob", `PING ${longest}`)).answered).toStrictEqual([
      notice("bob", `PING ${longest}`),
    ]);
    expect(new Script().session().in(request("bob", `PING ${longest}x`)).answered).toStrictEqual(
      []
    );
  });

  it("PROT-3: answers TIME only when the Owner has turned it on, with the Entry's time", () => {
    expect(new Script().session().in(request("bob", "TIME")).answered).toStrictEqual([]);

    const script = new Script().session({ ...defaultTuning, ctcpTime: true });

    expect(script.in(request("bob", "TIME")).answered).toStrictEqual([
      notice("bob", "TIME 2023-11-14T22:13:20Z"),
    ]);
  });

  it("PROT-3, LOG-10: gives TIME in UTC to the second, whatever the process's timezone", () => {
    const zone = process.env.TZ;

    try {
      const sydney = timeAnsweredIn("Australia/Sydney");
      const newYork = timeAnsweredIn("America/New_York");

      // The zones really did differ, or this would prove nothing.
      expect(sydney.offset).not.toBe(newYork.offset);
      expect(sydney.answered).toStrictEqual([notice("bob", "TIME 2023-11-14T22:13:20Z")]);
      expect(newYork.answered).toStrictEqual(sydney.answered);
      expect(utcTime(started + 999)).toBe("2023-11-14T22:13:20Z");
    } finally {
      if (zone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = zone;
      }
    }
  });

  it.each([
    ["VERSION", { ctcpVersion: false }],
    ["PING 1", { ctcpPing: false }],
  ])("PROT-3: answers %s with nothing once the Owner has turned it off", (command, off) => {
    expect(
      new Script().session({ ...defaultTuning, ...off }).in(request("bob", command)).answered
    ).toStrictEqual([]);
  });

  it.each(["CLIENTINFO", "USERINFO", "FINGER", "SOURCE", "DCC SEND file 1 2 3", "ACTION waves"])(
    "PROT-3, PROT-5: answers %s with nothing",
    (command) => {
      expect(new Script().session().in(request("bob", command)).answered).toStrictEqual([]);
    }
  );

  it("PROT-3: reads the command in any case, as CTCP does", () => {
    expect(new Script().session().in(request("bob", "version")).answered).toStrictEqual([
      notice("bob", "VERSION iirc"),
    ]);
  });

  it("PROT-3: answers a request to a Channel, to its sender", () => {
    expect(new Script().session().in(request("bob", "VERSION", "#iirc")).answered).toStrictEqual([
      notice("bob", "VERSION iirc"),
    ]);
  });
});

describe("PROT-4, HOST-3: what is never answered", () => {
  it("PROT-4: never answers a NOTICE, which is a reply", () => {
    expect(
      new Script().session().in(":bob!u@h.test NOTICE iirc :\u0001VERSION\u0001").answered
    ).toStrictEqual([]);
  });

  it("HOST-3: never answers Self, under the mapping in force", () => {
    expect(new Script().session().in(version("IIRC")).answered).toStrictEqual([]);
  });

  it.each([
    ["an Ircd", ":irc.test PRIVMSG iirc :\u0001VERSION\u0001"],
    ["a bare nick", ":bob PRIVMSG iirc :\u0001VERSION\u0001"],
    ["no source", "PRIVMSG iirc :\u0001VERSION\u0001"],
    ["a $ mask", request("bob", "VERSION", "$*.test")],
    ["*", request("bob", "VERSION", "*")],
  ])("HOST-3: never answers a request from or to %s", (_name, text) => {
    expect(new Script().session().in(text).answered).toStrictEqual([]);
  });

  it("HOST-3: never answers before the welcome", () => {
    const script = new Script().attempt().append({
      _tag: "Connection",
      connection: 1,
      ircd,
      network: "libera",
      phase: "opened",
    });

    expect(script.in(version()).answered).toStrictEqual([]);
  });

  it("HOST-3: never answers on a Connection that is closing", () => {
    expect(new Script().session().closing().in(version()).answered).toStrictEqual([]);
  });

  it("HOST-3: never answers a reply that cannot be built, such as one to a nick with a comma", () => {
    expect(new Script().session().in(version("a,b")).answered).toStrictEqual([]);
  });

  it("LOG-4: a Line that is only replayed decides as it did, with nothing sent", () => {
    const live = new Script().session().in(version());
    const replayed = foldStandings(noStandings, live.entries).get("libera") ?? noStanding;

    expect(ctcpRepliesIn(replayed, live.entries)).toHaveLength(1);
    expect(replayed.ctcp).toStrictEqual(live.standing.ctcp);
  });
});

describe("PROT-4, HOST-3: the limits, derived from the Log", () => {
  it("PROT-4: answers one User once in 10 seconds, and again at 10 seconds exactly", () => {
    const script = new Script().session().in(version()).sent().wait(1);

    expect(script.in(version()).answered).toStrictEqual([]);
    expect(script.wait(10_000 - 2).in(version()).answered).toStrictEqual([]);
    expect(script.wait(1).in(version()).answered).toStrictEqual([notice("bob", "VERSION iirc")]);
  });

  it("PROT-4: counts a User by nick under the mapping in force", () => {
    const script = new Script().session().in(version("Bob[1]")).sent();

    expect(script.in(version("bob{1}")).answered).toStrictEqual([]);
  });

  it("PROT-4: answers 5 Users a minute, and a sixth once the first reply is a minute old", () => {
    const script = new Script().session();

    for (const user of ["a", "b", "c", "d", "e"]) {
      expect(script.in(version(user)).answered).toHaveLength(1);
      script.sent();
    }

    expect(script.in(version("f")).answered).toStrictEqual([]);
    expect(script.wait(60_000 - 1).in(version("g")).answered).toStrictEqual([]);
    expect(script.wait(1).in(version("h")).answered).toStrictEqual([notice("h", "VERSION iirc")]);
  });

  it("PROT-4: counts a reply from when it was decided, not when it was sent", () => {
    const script = new Script().session();

    // Twenty in one read, none of whose replies the lane has let out yet.
    for (let index = 0; index < 20; index += 1) {
      script.in(version(`user${index}`));
    }

    expect(ctcpRepliesIn(script.standing, script.entries)).toHaveLength(5);
  });

  it("PROT-4: a reply the Daemon sent counts once, when it was decided", () => {
    const script = new Script().session();

    for (const user of ["a", "b", "c", "d"]) {
      script.in(version(user)).sent();
    }

    expect(script.in(version("e")).answered).toHaveLength(1);
  });

  it("PROT-4: counts a CTCP NOTICE the Owner sent raw", () => {
    const script = new Script().session().out(notice("bob", "VERSION mine"), "key:phone");

    expect(script.in(version()).answered).toStrictEqual([]);

    for (const user of ["a", "b", "c", "d"]) {
      script.out(notice(user, "PING 1"), "key:phone");
    }

    expect(script.in(version("e")).answered).toStrictEqual([]);
  });

  it("PROT-4: counts no NOTICE that is not CTCP", () => {
    const script = new Script().session().out("NOTICE bob :hello", "key:phone");

    expect(script.in(version()).answered).toHaveLength(1);
  });

  it("PROT-4, HOST-3: neither a reconnect nor a restart resets a limit", () => {
    const script = new Script().session();

    for (const user of ["a", "b", "c", "d", "e"]) {
      script.in(version(user)).sent();
    }

    script.closed().restart().wait(1000).session();

    expect(script.in(version("f")).answered).toStrictEqual([]);

    // A start folds the whole Log again, which gives the same window.
    const rebuilt = foldStandings(noStandings, script.entries).get("libera");

    expect(rebuilt?.ctcp).toStrictEqual(script.standing.ctcp);
    expect(script.wait(60_000).in(version("g")).answered).toHaveLength(1);
  });

  it("PROT-4: limits by the Connection's own Tuning, as its attempt recorded it", () => {
    const tuning = { ...defaultTuning, ctcpNetworkLimit: 1, ctcpUserIntervalMillis: 0 };
    const script = new Script().session(tuning).in(version()).sent();

    expect(script.in(version("other")).answered).toStrictEqual([]);
    expect(script.wait(60_000).in(version()).answered).toHaveLength(1);
  });

  it("HOST-3: holds a bounded window, however long the flood", () => {
    const tuning = {
      ...defaultTuning,
      ctcpNetworkLimit: 100,
      ctcpNetworkWindowMillis: 1,
      ctcpUserIntervalMillis: 0,
    };

    const script = new Script().session(tuning);

    for (let index = 0; index < 1000; index += 1) {
      script
        .wait(1)
        .in(version(`user${index}`))
        .sent();
    }

    expect(script.standing.ctcp.latest).toHaveLength(heldReplyTimes);
    expect(script.standing.ctcp.byUser.size).toBeLessThanOrEqual(256);
  });
});

describe("HOST-3: a reply goes to a User and nothing else", () => {
  it.each([
    ["a Channel", ":#victims!u@h.test PRIVMSG iirc :\u0001VERSION\u0001"],
    ["another kind of Channel", ":&local!u@h.test PRIVMSG iirc :\u0001VERSION\u0001"],
    ["a server mask", ":$*.test!u@h.test PRIVMSG iirc :\u0001VERSION\u0001"],
    ["a STATUSMSG Target", ":@#ops!u@h.test PRIVMSG iirc :\u0001VERSION\u0001"],
    ["a host mask", ":*!u@h.test PRIVMSG iirc :\u0001VERSION\u0001"],
    ["a wildcard", ":bo?!u@h.test PRIVMSG iirc :\u0001VERSION\u0001"],
  ])("HOST-3: never answers a source whose nick is %s", (_name, text) => {
    expect(new Script().session().in(text).answered).toStrictEqual([]);
  });

  it("HOST-3: reads Channel and STATUSMSG prefixes as the Network has them in force", () => {
    const forged = ":=odd!u@h.test PRIVMSG iirc :\u0001VERSION\u0001";

    expect(new Script().session().in(forged).answered).toStrictEqual([
      notice("=odd", "VERSION iirc"),
    ]);
    expect(
      new Script().session().in(":ircd 005 iirc CHANTYPES=#= :are supported").in(forged).answered
    ).toStrictEqual([]);
    expect(
      new Script().session().in(":ircd 005 iirc STATUSMSG== :are supported").in(forged).answered
    ).toStrictEqual([]);
  });
});

describe("PROT-4: a reply counts until it is sent or Dropped", () => {
  it("PROT-4: one still pending a window later keeps counting, so none is decided past the limit", () => {
    const script = new Script().session();
    const users = ["a", "b", "c", "d", "e"];

    for (const user of users) {
      script.in(version(user));
    }

    // The lane is held up behind other traffic, and nothing has been sent a minute on.
    expect(script.wait(60_000).in(version("f")).answered).toStrictEqual([]);

    // Each one reaches the head of the lane and is Dropped as expired.
    for (const user of users) {
      script.dropped(notice(user, "VERSION iirc"));
    }

    expect(script.in(version("g")).answered).toStrictEqual([notice("g", "VERSION iirc")]);
  });

  it("PROT-4: one sent late counts from when it was sent, so at most the limit leave in a window", () => {
    const script = new Script().session();
    const users = ["a", "b", "c", "d", "e"];

    for (const user of users) {
      script.in(version(user));
    }

    // All five leave 50 seconds later, together.
    script.wait(50_000);

    for (const user of users) {
      script.out(notice(user, "VERSION iirc"), ctcpReplyCause);
    }

    expect(
      script.standing.ctcp.latest.filter(({ pending }) => pending !== undefined)
    ).toStrictEqual([]);
    expect(script.wait(20_000).in(version("f")).answered).toStrictEqual([]);
    expect(script.wait(40_000).in(version("g")).answered).toHaveLength(1);
  });

  it("PROT-4: a User with a reply pending gets no other, whatever their interval", () => {
    const tuning = { ...defaultTuning, ctcpUserIntervalMillis: 0 };
    const script = new Script().session(tuning).in(version());

    expect(script.wait(1000).in(version()).answered).toStrictEqual([]);

    script.out(notice("bob", "VERSION iirc"), ctcpReplyCause);

    expect(script.in(version()).answered).toHaveLength(1);
  });

  it("SEND-4, PROT-4: one still queued when its Connection ended counts no more, killed or not", () => {
    const script = new Script().session();

    for (const user of ["a", "b", "c", "d", "e"]) {
      script.in(version(user));
    }

    // Killed: no Dropped Entry was ever recorded for them.
    script.restart().session();

    expect(script.standing.ctcp.latest).toStrictEqual([]);
    expect(script.in(version("f")).answered).toHaveLength(1);
  });

  it("PROT-4: lets go of the NOTICE it held once sent or Dropped", () => {
    const script = new Script().session().in(version("a")).in(version("b"));

    script.out(notice("a", "VERSION iirc"), ctcpReplyCause);
    script.dropped(notice("b", "VERSION iirc"));

    expect(script.standing.ctcp.latest.map(({ pending, to }) => [to, pending])).toStrictEqual([
      ["a", undefined],
    ]);
  });
});

describe("PROT-4, KNOW-3: a User's interval under a mapping that changes", () => {
  it("KNOW-3: keys Users again when the mapping changes mid-Session", () => {
    const script = new Script()
      .session()
      .in(":ircd 005 iirc CASEMAPPING=ascii :are supported")
      .in(version("Bob[1]"))
      .sent()
      .wait(1000);

    // Under ascii these are two Users, and under rfc1459 one.
    expect(
      new Script()
        .session()
        .in(":ircd 005 iirc CASEMAPPING=ascii :are supported")
        .in(version("Bob[1]"))
        .sent()
        .in(version("bob{1}")).answered
    ).toHaveLength(1);

    script.in(":ircd 005 iirc CASEMAPPING=rfc1459 :are supported");

    expect(script.in(version("bob{1}")).answered).toStrictEqual([]);
  });

  it("KNOW-3: keys Users again across a reconnect to another mapping", () => {
    const script = new Script()
      .session()
      .in(":ircd 005 iirc CASEMAPPING=ascii :are supported")
      .in(version("Bob[1]"))
      .sent()
      .closed()
      .wait(1000)
      .session();

    expect(script.in(version("bob{1}")).answered).toStrictEqual([]);
    expect(script.wait(10_000).in(version("bob{1}")).answered).toHaveLength(1);
  });

  it("KNOW-3: where two Users become one, the later time stands", () => {
    const script = new Script()
      .session()
      .in(":ircd 005 iirc CASEMAPPING=ascii :are supported")
      .in(version("Bob[1]"))
      .sent()
      .wait(5000)
      .in(version("bob{1}"))
      .sent()
      .wait(6000)
      .in(":ircd 005 iirc CASEMAPPING=rfc1459 :are supported");

    // 11 seconds after the first, and 6 after the second, which is the one that counts.
    expect(script.in(version("BOB[1]")).answered).toStrictEqual([]);
    expect(script.wait(4000).in(version("BOB[1]")).answered).toHaveLength(1);
  });
});

describe("PROT-4, HOST-3: the Users held are bounded without losing an interval", () => {
  // Each User's interval is an hour, and the Network's limit never binds.
  const tuning = {
    ...defaultTuning,
    ctcpNetworkLimit: 100,
    ctcpNetworkWindowMillis: 1,
    ctcpUserIntervalMillis: 3_600_000,
  };

  const full = () => {
    const script = new Script().session(tuning);

    for (let index = 0; index < heldRepliedUsers; index += 1) {
      script
        .wait(2)
        .in(version(`user${index}`))
        .sent();
    }

    return script;
  };

  it("PROT-4: refuses a new User while every User held is inside their interval", () => {
    const script = full();

    expect(script.standing.ctcp.byUser.size).toBe(heldRepliedUsers);
    expect(script.wait(2).in(version("newcomer")).answered).toStrictEqual([]);
    // The first User answered is still held, and still limited.
    expect(script.wait(2).in(version("user0")).answered).toStrictEqual([]);
    expect(script.standing.ctcp.byUser.size).toBe(heldRepliedUsers);
  });

  it("PROT-4: lets go of a User only once their interval has run out", () => {
    const script = full().wait(3_600_000);

    expect(script.in(version("newcomer")).answered).toHaveLength(1);
    expect(script.standing.ctcp.byUser.size).toBeLessThanOrEqual(heldRepliedUsers);
  });
});

describe(ctcpAnswer, () => {
  it("PROT-3: is a pure function of Standing and the Line, which it leaves as they were", () => {
    const script = new Script().session();
    const before = script.standing;

    const reply = ctcpAnswer(
      before,
      {
        _tag: "Line",
        at: script.at,
        bytes: encoder.encode(version()),
        connection: script.connection,
        direction: "inbound",
        network: "libera",
        sequence: script.entries.length + 1,
      },
      {
        command: "PRIVMSG",
        params: ["iirc", "\u0001VERSION\u0001"],
        source: "bob!u@h.test",
        tags: new Map(),
      }
    );

    expect(reply?.toBytes()).toStrictEqual(encoder.encode(notice("bob", "VERSION iirc")));
    expect(script.standing).toBe(before);
    expect(before.ctcp.latest).toStrictEqual([]);
  });
});
