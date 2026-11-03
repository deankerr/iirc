import type { LogEntry } from "@iirc/api";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { boundedBy, folder, heardFrom } from "./folding.ts";
import type { Folded, RawGap } from "./folding.ts";
import { pageStream } from "./log-reading.ts";
import { soakText } from "./soak-text.ts";
import { defaultTolerances, judge } from "./verdict.ts";

const minute = 60_000;

// The counted Message of a minute, said five seconds into it.
const said = (n: number) => soakText(n * minute + 5000);

const line = (
  sequence: number,
  at: number,
  text: string,
  direction: "inbound" | "outbound" = "inbound",
  connection = 1
): LogEntry => ({
  _tag: "Line",
  at,
  bytes: new TextEncoder().encode(text),
  connection,
  direction,
  network: "floor",
  sequence,
  text,
});

const welcome = (sequence: number, at: number, nick: string, connection = 1) =>
  line(sequence, at, `:ircd 001 ${nick} :Welcome`, "inbound", connection);

const mapping = (sequence: number, at: number, value: string, connection = 1) =>
  line(sequence, at, `:ircd 005 me CASEMAPPING=${value} :are supported`, "inbound", connection);

const joined = (sequence: number, at: number, who: string, channel: string, connection = 1) =>
  line(sequence, at, `:${who}!~u@host JOIN :${channel}`, "inbound", connection);

// The Gap that began at Entry 10 (time 1000) and ended with the `001` at Entry 20 (time 2000).
const gap: RawGap = {
  at: 1000,
  endedAt: 2000,
  endedSequence: 20,
  reason: "the Daemon was killed",
  sequence: 10,
};

const foldAll = (
  entries: readonly LogEntry[],
  gaps: readonly RawGap[] = [gap],
  target = "#soak"
) => {
  const pass = folder(target, gaps);

  for (const entry of entries) {
    pass.step(entry);
  }

  return pass.finish();
};

const windowOf = (entries: readonly LogEntry[], gaps?: readonly RawGap[], target?: string) =>
  foldAll(entries, gaps, target).gaps[0];

describe("PROOF-5: a Gap's window, read from the Daemon's own Log", () => {
  it("PROOF-5: begins at the last inbound Line before the Gap, and not at an outbound one", () => {
    const window = windowOf([
      welcome(1, 100, "soak-b"),
      line(5, 900, "PING :a"),
      line(8, 950, "PONG :out", "outbound"),
      line(9, 980, ":ircd NOTICE soak-b :hi"),
      line(30, 2500, "PING :after"),
    ]);

    expect(window?.lastHeardAt).toBe(980);
  });

  it("PROOF-5: ends at Self's own JOIN of the Channel after the Gap, and not at anyone else's or another Channel's", () => {
    const window = windowOf([
      welcome(1, 100, "soak-b"),
      welcome(20, 2000, "soak-b", 2),
      joined(22, 2100, "somebody", "#soak", 2),
      joined(23, 2150, "soak-b", "#other", 2),
      joined(24, 2200, "SOAK-B", "#SOAK", 2),
    ]);

    expect(window?.listeningAgainAt).toBe(2200);
  });

  it("PROOF-5: counts Self's JOIN in a list of Channels, and with an account and a name after it", () => {
    const first = windowOf([
      welcome(20, 2000, "soak-b", 2),
      line(22, 2100, ":soak-b!~u@h JOIN #a,#soak", "inbound", 2),
    ]);

    const second = windowOf([
      welcome(20, 2000, "soak-b", 2),
      line(22, 2100, ":soak-b!~u@h JOIN #soak acct :Real Name", "inbound", 2),
    ]);

    expect([first?.listeningAgainAt, second?.listeningAgainAt]).toStrictEqual([2100, 2100]);
  });

  it("PROOF-5: follows Self through a NICK, so a JOIN under the new nick is its own", () => {
    const window = windowOf([
      welcome(20, 2000, "soak-b", 2),
      line(21, 2050, ":soak-b!~u@h NICK :soak-b_", "inbound", 2),
      joined(22, 2100, "soak-b_", "#soak", 2),
    ]);

    expect(window?.listeningAgainAt).toBe(2100);
  });

  it("PROOF-5: does not take a JOIN from before the Gap ended, or from a Self of another Connection", () => {
    expect(
      windowOf([
        welcome(1, 100, "soak-b"),
        joined(3, 150, "soak-b", "#soak"),
        welcome(20, 2000, "soak-b", 2),
      ])?.listeningAgainAt
    ).toBeUndefined();
    expect(
      windowOf([
        welcome(1, 100, "soak-b"),
        welcome(20, 2000, "other", 2),
        joined(22, 2100, "soak-b", "#soak", 2),
      ])?.listeningAgainAt
    ).toBeUndefined();
  });

  it("PROOF-5: has no end while the Gap has not ended", () => {
    const window = windowOf(
      [welcome(1, 100, "soak-b"), joined(30, 3000, "soak-b", "#soak")],
      [{ ...gap, endedAt: undefined, endedSequence: undefined }]
    );

    expect(window?.listeningAgainAt).toBeUndefined();
    expect(window?.endedAt).toBeUndefined();
  });

  it("PROOF-5: ends with the Gap for a Target that is a nick, which needs no JOIN", () => {
    expect(windowOf([welcome(1, 100, "soak-b")], [gap], "soak-b")?.listeningAgainAt).toBe(2000);
  });

  it("PROOF-5: gives each Gap its own window", () => {
    const later: RawGap = { at: 5000, endedAt: 6000, endedSequence: 60, reason: "x", sequence: 50 };

    const { gaps } = foldAll(
      [
        welcome(1, 100, "soak-b"),
        line(9, 980, "PING :a"),
        welcome(20, 2000, "soak-b", 2),
        joined(22, 2100, "soak-b", "#soak", 2),
        line(49, 4900, "PING :b", "inbound", 2),
        welcome(60, 6000, "soak-b", 3),
        joined(62, 6100, "soak-b", "#soak", 3),
      ],
      [gap, later]
    );

    expect(
      gaps.map(({ lastHeardAt, listeningAgainAt }) => [lastHeardAt, listeningAgainAt])
    ).toStrictEqual([
      [980, 2100],
      [4900, 6100],
    ]);
  });
});

describe("PROOF-5: names compared as the Ircd compares them", () => {
  // A Channel whose name holds `[` and `]`, which an rfc1459 Ircd folds to `{` and `}`.
  const target = "#soak[1]";

  const rejoinedAs = (spelling: string, announced?: string) =>
    windowOf(
      [
        welcome(1, 100, "soak-b"),
        ...(announced === undefined ? [] : [mapping(2, 101, announced)]),
        welcome(20, 2000, "soak-b", 2),
        ...(announced === undefined ? [] : [mapping(21, 2001, announced, 2)]),
        joined(22, 2100, "soak-b", spelling, 2),
      ],
      [gap],
      target
    )?.listeningAgainAt;

  it("PROOF-5: takes a JOIN spelled the other way as the same Channel when no CASEMAPPING is given, which means rfc1459", () => {
    expect(rejoinedAs("#soak{1}")).toBe(2100);
  });

  it("PROOF-5: takes it so when the Ircd announces CASEMAPPING=rfc1459", () => {
    expect(rejoinedAs("#SOAK{1}", "rfc1459")).toBe(2100);
  });

  it("PROOF-5: takes the two spellings as two Channels when the Ircd announces CASEMAPPING=ascii", () => {
    expect(rejoinedAs("#soak{1}", "ascii")).toBeUndefined();
    expect(rejoinedAs("#SOAK[1]", "ascii")).toBe(2100);
  });

  it("PROOF-5: a loss after a JOIN spelled the other way is unexplained, and not excused by a window left open", () => {
    const folded = foldAll(
      [
        welcome(1, 100, "soak-b"),
        welcome(20, 2000, "soak-b", 2),
        joined(22, 2100, "soak-b", "#soak{1}", 2),
      ],
      [gap],
      target
    );

    // Number 7 was sent after that JOIN, which was recorded, and never arrived.
    const verdict = judge({
      gaps: { receiver: folded.gaps, sender: [] },
      now: 10 * minute,
      receipts: [],
      sends: [
        {
          at: 5000,
          millis: 29_000_007 * minute,
          n: 29_000_007,
          outcome: { _tag: "Written" },
          sequence: 100,
        },
      ],
      tolerances: { ...defaultTolerances, silenceMillis: 10 * minute },
    });

    expect(verdict.unexplained).toStrictEqual([29_000_007]);
  });

  it("PROOF-5: matches Self's nick through the mapping, so a JOIN from a nick spelled the other way is Self's", () => {
    const window = windowOf([
      welcome(20, 2000, "Soak[B]", 2),
      joined(22, 2100, "soak{b}", "#soak", 2),
    ]);

    expect(window?.listeningAgainAt).toBe(2100);
  });

  it("PROOF-5: hears a counted Message to the Target however the Ircd spells it, and from the sender's nick however it is spelled", () => {
    const sender = foldAll(
      [
        welcome(1, 100, "soak{a}"),
        line(5, 500, `PRIVMSG #soak[1] :${said(29_000_005)}`, "outbound"),
      ],
      [],
      target
    );

    const receiver = foldAll(
      [
        welcome(1, 100, "soak-b"),
        line(5, 510, `:Soak[A]!~u@h PRIVMSG #SOAK{1} :${said(29_000_005)}`),
        line(6, 520, `:somebody!~u@h PRIVMSG #soak{1} :${said(29_000_006)}`),
        line(7, 530, `:soak[a]!~u@h NOTICE #soak{1} :${said(29_000_007)}`),
      ],
      [],
      target
    );

    expect([...sender.nicks]).toStrictEqual(["soak{a}"]);
    expect(heardFrom(receiver.heard, sender.nicks)).toStrictEqual([
      { at: 510, millis: 29_000_005 * minute + 5000, n: 29_000_005, sequence: 5 },
    ]);
  });

  it.each([
    [":soak-a@host PRIVMSG #soak[1] :", "nick@host"],
    [":soak-a!~u@host PRIVMSG #soak[1] :", "nick!user@host"],
    [":soak-a PRIVMSG #soak[1] :", "a bare nick"],
  ])("PROOF-5: takes the sender's nick from a source of the form %s (%s)", (prefix) => {
    const receiver = foldAll(
      [welcome(1, 100, "soak-b"), line(5, 510, `${prefix}${said(29_000_005)}`)],
      [],
      target
    );

    expect(receiver.heard.map(({ sender }) => sender)).toStrictEqual(["soak-a"]);
    expect(heardFrom(receiver.heard, new Set(["soak-a"]))).toHaveLength(1);
  });

  it("PROOF-5: does not match a nick spelled differently under ascii", () => {
    const receiver = foldAll(
      [
        welcome(1, 100, "soak-b"),
        mapping(2, 101, "ascii"),
        line(5, 510, `:Soak[A]!~u@h PRIVMSG #soak[1] :${said(29_000_005)}`),
      ],
      [],
      target
    );

    expect(heardFrom(receiver.heard, new Set(["soak{a}"]))).toStrictEqual([]);
    expect(heardFrom(receiver.heard, new Set(["soak[a]"]))).toHaveLength(1);
  });
});

// A Log of three Connections, with Gaps between, a counted Message every so often among
// other Lines, in the order the Daemon wrote them.
const log = (): LogEntry[] => {
  const entries: LogEntry[] = [];
  let sequence = 0;

  const add = (build: (sequence: number) => LogEntry) => {
    sequence += 1;
    entries.push(build(sequence));
  };

  for (const connection of [1, 2, 3]) {
    add((s) => welcome(s, s * 10, connection === 2 ? "Soak[B]" : "soak-b", connection));
    add((s) => joined(s, s * 10, connection === 2 ? "soak{b}" : "soak-b", "#soak", connection));

    for (let each = 0; each < 40; each += 1) {
      add((s) => line(s, s * 10, `:ircd NOTICE x :noise ${each}`, "inbound", connection));

      if (each % 8 === 0) {
        add((s) =>
          line(
            s,
            s * 10,
            `:soak-a!u@h PRIVMSG #soak :${said(29_000_000 + s)}`,
            "inbound",
            connection
          )
        );
      }
    }

    sequence += 1;
  }

  return entries;
};

const gapsOf = (entries: readonly LogEntry[]): readonly RawGap[] =>
  [1, 2].map((connection) => {
    const last = entries.findLast(
      (entry) => entry._tag === "Line" && entry.connection === connection
    );

    const next = entries.find(
      (entry) => entry._tag === "Line" && entry.connection === connection + 1
    );

    return {
      at: (last?.at ?? 0) + 5,
      endedAt: next?.at,
      endedSequence: next?.sequence,
      reason: "closed",
      sequence: (last?.sequence ?? 0) + 1,
    };
  });

// Everything about a pass that the verdict reads, in a form that compares.
const summary = ({ gaps, heard, nicks, sends }: Folded) => ({
  gaps,
  heard,
  nicks: [...nicks],
  sends,
});

const throughPages = async (entries: readonly LogEntry[], sizes: readonly number[]) => {
  const pass = folder("#soak", gapsOf(entries));
  let asked = 0;

  await Effect.runPromise(
    pageStream(
      0,
      (after) => {
        const size = sizes[asked % sizes.length] ?? 1;

        asked += 1;

        return Effect.succeed(entries.filter(({ sequence }) => sequence > after).slice(0, size));
      },
      ({ sequence }) => sequence
    ).pipe(
      Stream.runForEach((entry) =>
        Effect.sync(() => {
          pass.step(entry);
        })
      )
    )
  );

  return pass.finish();
};

// The Line a long Log has at a sequence: a welcome, a counted Message now and then, noise.
const textOf = (sequence: number) => {
  if (sequence === 1) {
    return ":ircd 001 soak-b :Welcome";
  }

  return sequence % 50_000 === 0
    ? `:soak-a!u@h PRIVMSG #soak :${said(29_000_000 + sequence)}`
    : `:ircd NOTICE soak-b :noise ${sequence}`;
};

describe("PROOF-5: what a pass keeps of a Log", () => {
  it("PROOF-5: keeps counted Messages sent and Dropped to the Target, and no other Line", () => {
    const { sends } = foldAll(
      [
        welcome(1, 100, "soak-a"),
        line(2, 10, `PRIVMSG #soak :${said(29_000_001)}`, "outbound"),
        line(3, 11, `PRIVMSG #other :${said(29_000_002)}`, "outbound"),
        line(4, 12, `:soak-a!u@h PRIVMSG #soak :${said(29_000_003)}`),
        line(5, 13, "PRIVMSG #soak :hello", "outbound"),
        {
          _tag: "Dropped",
          at: 20,
          bytes: new Uint8Array(),
          cause: "key:soak",
          connection: 1,
          network: "floor",
          reason: "the Connection closed",
          sequence: 6,
          text: `PRIVMSG #SOAK :${said(29_000_005)}`,
        },
      ],
      []
    );

    expect(sends).toStrictEqual([
      {
        at: 10,
        millis: 29_000_001 * minute + 5000,
        n: 29_000_001,
        outcome: { _tag: "Written" },
        sequence: 2,
      },
      {
        at: 20,
        millis: 29_000_005 * minute + 5000,
        n: 29_000_005,
        outcome: { _tag: "Dropped", reason: "the Connection closed" },
        sequence: 6,
      },
    ]);
  });

  it("PROOF-5: a pass over pages of any size gives what a pass over all the Entries at once does", async () => {
    const entries = log();
    const whole = foldAll(entries, gapsOf(entries));

    expect(whole.heard.length).toBeGreaterThan(10);
    expect(whole.gaps.map(({ listeningAgainAt }) => listeningAgainAt)).not.toContain(undefined);

    const results = await Promise.all([
      throughPages(entries, [1]),
      throughPages(entries, [7, 3, 11]),
      throughPages(entries, [1000]),
    ]);

    for (const result of results) {
      expect(summary(result)).toStrictEqual(summary(whole));
    }
  });

  it("PROOF-5: a pass over a long Log holds only the counted Messages and the Gaps, as pages go by", async () => {
    const pass = folder("#soak", [
      { at: 500_000, endedAt: 600_000, endedSequence: 600, reason: "closed", sequence: 500 },
    ]);

    // Four hundred thousand Lines, made as they are asked for, so nothing here holds them.
    const total = 400_000;
    const page = 1000;

    await Effect.runPromise(
      pageStream(
        0,
        (after) =>
          Effect.succeed(
            Array.from({ length: Math.max(0, Math.min(page, total - after)) }, (_, index) => {
              const sequence = after + index + 1;

              return line(
                sequence,
                sequence,
                textOf(sequence),
                sequence === 500 ? "outbound" : "inbound"
              );
            })
          ),
        ({ sequence }) => sequence
      ).pipe(
        Stream.runForEach((entry) =>
          Effect.sync(() => {
            pass.step(entry);
          })
        )
      )
    );

    const folded = pass.finish();

    expect(folded.heard).toHaveLength(8);
    expect(folded.sends).toHaveLength(0);
    expect(folded.gaps).toHaveLength(1);
    expect(folded.gaps[0]?.lastHeardAt).toBe(499);
  });
});

describe("PROOF-5: the Gaps as the Log stood at one moment", () => {
  const closed: RawGap = { at: 10, endedAt: 20, endedSequence: 15, reason: "x", sequence: 12 };

  it("PROOF-5: leaves out a Gap recorded after the head", () => {
    expect(
      boundedBy(30, [
        closed,
        { ...closed, endedAt: undefined, endedSequence: undefined, sequence: 31 },
      ])
    ).toStrictEqual([closed]);
  });

  it("PROOF-5: takes a Gap that ended after the head as still open", () => {
    expect(boundedBy(14, [closed])).toStrictEqual([
      { ...closed, endedAt: undefined, endedSequence: undefined },
    ]);
  });

  it("PROOF-5: keeps a Gap that began and ended by the head, and one that stands at it", () => {
    expect(boundedBy(15, [closed])).toStrictEqual([closed]);
    expect(
      boundedBy(12, [{ ...closed, endedAt: undefined, endedSequence: undefined }])
    ).toHaveLength(1);
  });
});
