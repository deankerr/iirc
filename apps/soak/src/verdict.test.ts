import { describe, expect, it } from "vitest";

import { defaultTolerances, judge } from "./verdict.ts";
import type { Evidence, Receipt, Send, Span } from "./verdict.ts";

const minute = 60_000;
const second = 1000;

// Numbers are Unix minutes, so number `base + i` is sent at the start of its minute.
const base = 29_000_000;

const tolerances = { ...defaultTolerances, silenceMillis: 10 * minute };

const number = (i: number) => base + i;
const sentAt = (i: number) => number(i) * minute;

// The Message of minute `i`, sent `offset` milliseconds into it. Its millisecond names it.
const writtenAt = (i: number, offset: number): Send => ({
  at: sentAt(i) + offset,
  millis: sentAt(i) + offset,
  n: number(i),
  outcome: { _tag: "Written" },
  sequence: 100 + i,
});

const droppedAt = (i: number, offset: number, reason = "the Connection closed"): Send => ({
  at: sentAt(i) + offset,
  millis: sentAt(i) + offset,
  n: number(i),
  outcome: { _tag: "Dropped", reason },
  sequence: 100 + i,
});

const receivedAt = (i: number, offset: number, sequence = 500 + i): Receipt => ({
  at: sentAt(i) + offset + 400,
  millis: sentAt(i) + offset,
  n: number(i),
  sequence,
});

const written = (i: number) => writtenAt(i, 0);

const dropped = (i: number, reason = "the Connection closed") => droppedAt(i, 0, reason);

const received = (i: number) => receivedAt(i, 0);

interface GapTimes {
  readonly at: number;
  readonly endedAt?: number | undefined;
  readonly lastHeardAt?: number | undefined;
  readonly listeningAgainAt?: number | undefined;
  readonly reason?: string;
}

// A Gap whose window runs from the Daemon's last Line before it to its own `JOIN` after,
// each as the Log shows it unless the test says otherwise.
const gap = ({
  at,
  endedAt,
  lastHeardAt = at,
  listeningAgainAt = endedAt,
  reason = "the Daemon was killed",
}: GapTimes): Span => ({ at, endedAt, lastHeardAt, listeningAgainAt, reason, sequence: 7 });

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

const minutes = (from: number, to: number) => range(from, to);

// A checker running five minutes after number 30 was sent, with 1 to 30 all received.
const evidence = (over: Partial<Evidence> & { readonly last?: number } = {}): Evidence => {
  const last = over.last ?? 30;

  return {
    gaps: { receiver: [], sender: [] },
    now: sentAt(last) + 5 * minute,
    receipts: minutes(1, last).map(received),
    sends: minutes(1, last).map(written),
    tolerances,
    ...over,
  };
};

const without = (missing: readonly number[], last = 30) =>
  minutes(1, last)
    .filter((i) => !missing.includes(i))
    .map(received);

const quiet = (sendMinutes: readonly number[], now: number, extra: readonly Send[] = []) =>
  judge({
    gaps: { receiver: [], sender: [] },
    now,
    receipts: sendMinutes.map(received),
    sends: [...sendMinutes.map(written), ...extra],
    tolerances,
  });

describe("PROOF-5: the verdict of one pair", () => {
  it("PROOF-5: passes when every number sent was received once and the sender is still sending", () => {
    const verdict = judge(evidence({ now: sentAt(30) + 30 * second }));

    expect(verdict).toMatchObject({
      delivered: 30,
      duplicates: [],
      explained: [],
      neverSent: [],
      ok: true,
      repeated: [],
      sent: 30,
      silences: [],
      silent: false,
      unexplained: [],
    });
  });

  it("PROOF-5: a number sent and never received, with no Gap and no Dropped Entry, is unexplained and fails", () => {
    const verdict = judge(evidence({ receipts: without([12]) }));

    expect(verdict.unexplained).toStrictEqual([number(12)]);
    expect(verdict.ok).toBeFalsy();
  });

  it("PROOF-5: lists every unexplained number, not only the first", () => {
    const verdict = judge(evidence({ receipts: without([3, 4, 20]) }));

    expect(verdict.unexplained).toStrictEqual([number(3), number(4), number(20)]);
    expect(verdict.delivered).toBe(27);
  });

  it("PROOF-5: a number the sender's Log shows Dropped is explained by that, and passes", () => {
    const verdict = judge(
      evidence({
        receipts: without([9]),
        sends: minutes(1, 30).map((i) => (i === 9 ? dropped(i, "write timed out") : written(i))),
      })
    );

    expect(verdict.explained).toStrictEqual([{ n: number(9), reason: "Dropped: write timed out" }]);
    expect(verdict.unexplained).toStrictEqual([]);
    expect(verdict.ok).toBeTruthy();
  });

  it("PROOF-5: a Dropped number that was received anyway is delivered, because its write had left", () => {
    const verdict = judge(
      evidence({ sends: minutes(1, 30).map((i) => (i === 9 ? dropped(i) : written(i))) })
    );

    expect(verdict.delivered).toBe(30);
    expect(verdict.explained).toStrictEqual([]);
    expect(verdict.ok).toBeTruthy();
  });

  describe("a Gap's window, from the Daemon's last Line to its own JOIN", () => {
    // Down from minute 9.5 to 14.5, with a JOIN back at 14.8, having last heard at 9.2.
    const killed = gap({
      at: sentAt(9.5),
      endedAt: sentAt(14.5),
      lastHeardAt: sentAt(9.2),
      listeningAgainAt: sentAt(14.8),
    });

    it("PROOF-5: a number sent while the receiver's Gap stood is explained by that Gap", () => {
      const verdict = judge(
        evidence({
          gaps: { receiver: [killed], sender: [] },
          receipts: without([10, 11, 12, 13, 14]),
        })
      );

      expect(verdict.explained.map(({ n }) => n)).toStrictEqual(minutes(10, 14).map(number));
      expect(verdict.explained[0]?.reason).toBe("receiver Gap at Entry 7: the Daemon was killed");
      expect(verdict.unexplained).toStrictEqual([]);
      expect(verdict.ok).toBeTruthy();
    });

    it("PROOF-5: a number sent while the sender's Gap stood is explained by that Gap", () => {
      const verdict = judge(
        evidence({
          gaps: { receiver: [], sender: [gap({ ...killed, reason: "connection reset" })] },
          receipts: without([10]),
        })
      );

      expect(verdict.explained).toStrictEqual([
        { n: number(10), reason: "sender Gap at Entry 7: connection reset" },
      ]);
      expect(verdict.ok).toBeTruthy();
    });

    it("PROOF-5: a Gap in another stretch of time explains nothing", () => {
      const verdict = judge(
        evidence({
          gaps: { receiver: [gap({ at: sentAt(2), endedAt: sentAt(3) })], sender: [] },
          receipts: without([20]),
        })
      );

      expect(verdict.unexplained).toStrictEqual([number(20)]);
    });

    it("PROOF-5: a loss while both Daemons were joined and listening is unexplained, though the receiver disconnects a minute later", () => {
      // Number 12 was sent at minute 12 and never arrived. The receiver went on hearing the
      // Ircd for 20 seconds after that, so it was listening when 12 went, and its Gap
      // begins a minute and a half on. Padding the Gap's start would have excused 12.
      const verdict = judge(
        evidence({
          gaps: {
            receiver: [
              gap({
                at: sentAt(13.5),
                endedAt: sentAt(15),
                lastHeardAt: sentAt(12) + 20 * second,
                listeningAgainAt: sentAt(15.2),
              }),
            ],
            sender: [],
          },
          receipts: without([12]),
        })
      );

      expect(verdict.unexplained).toStrictEqual([number(12)]);
      expect(verdict.ok).toBeFalsy();
    });

    it("PROOF-5: a loss after the receiver's JOIN was recorded is unexplained, though the Gap ended within a minute and a half", () => {
      // The Gap ended at 10 and the JOIN was back at 10.2, so 11 went when the receiver was
      // on the Channel. Padding the Gap's end would have excused it.
      const verdict = judge(
        evidence({
          gaps: {
            receiver: [
              gap({ at: sentAt(9.5), endedAt: sentAt(10), listeningAgainAt: sentAt(10.2) }),
            ],
            sender: [],
          },
          receipts: without([11]),
        })
      );

      expect(verdict.unexplained).toStrictEqual([number(11)]);
    });

    it("PROOF-5: a loss in the real dead-detection window is explained, though the receiver's Gap begins a minute and a half later", () => {
      // The Connection died just after the receiver last heard from the Ircd, at 11:50. The
      // Daemon only noticed after 90 seconds of silence, so its Gap began at 13.4, and
      // number 12 went into the dead Connection.
      const verdict = judge(
        evidence({
          gaps: {
            receiver: [
              gap({
                at: sentAt(13.4),
                endedAt: sentAt(15),
                lastHeardAt: sentAt(12) - 10 * second,
                listeningAgainAt: sentAt(15.2),
              }),
            ],
            sender: [],
          },
          receipts: without([12]),
        })
      );

      expect(verdict.explained.map(({ n }) => n)).toStrictEqual([number(12)]);
      expect(verdict.ok).toBeTruthy();
    });

    it("PROOF-5: a window with no recorded JOIN yet stays open, so a Gap that has ended still explains what follows", () => {
      const verdict = judge(
        evidence({
          gaps: {
            receiver: [
              { ...gap({ at: sentAt(24.5), endedAt: sentAt(25) }), listeningAgainAt: undefined },
            ],
            sender: [],
          },
          receipts: without([25, 26, 27, 28, 29, 30]),
        })
      );

      expect(verdict.explained.map(({ n }) => n)).toStrictEqual(minutes(25, 30).map(number));
      expect(verdict.ok).toBeTruthy();
    });

    it("PROOF-5: a Gap still open explains every number from its window's start on", () => {
      const verdict = judge(
        evidence({
          gaps: { receiver: [gap({ at: sentAt(24.5), endedAt: undefined })], sender: [] },
          receipts: minutes(1, 24).map(received),
        })
      );

      expect(verdict.explained.map(({ n }) => n)).toStrictEqual(minutes(25, 30).map(number));
      expect(verdict.ok).toBeTruthy();
    });

    it("PROOF-5: the window includes the instant of the last Line and of the JOIN, and nothing either side", () => {
      const window = gap({
        at: sentAt(14),
        endedAt: sentAt(15),
        lastHeardAt: sentAt(12),
        listeningAgainAt: sentAt(16),
      });

      const sentAtTime = (at: number) =>
        judge(
          evidence({
            gaps: { receiver: [window], sender: [] },
            receipts: without([20]),
            sends: minutes(1, 30).map((i) => (i === 20 ? { ...written(i), at } : written(i))),
          })
        );

      expect(sentAtTime(sentAt(12)).explained.map(({ n }) => n)).toStrictEqual([number(20)]);
      expect(sentAtTime(sentAt(12) - 1).unexplained).toStrictEqual([number(20)]);
      expect(sentAtTime(sentAt(16)).explained.map(({ n }) => n)).toStrictEqual([number(20)]);
      expect(sentAtTime(sentAt(16) + 1).unexplained).toStrictEqual([number(20)]);
    });

    it("PROOF-5: a last Line recorded after the Gap's start does not shrink the window", () => {
      // Lines the Daemon drained while closing can be stamped after the Gap's start.
      const verdict = judge(
        evidence({
          gaps: {
            receiver: [
              gap({
                at: sentAt(10),
                endedAt: sentAt(11),
                lastHeardAt: sentAt(10) + 5 * second,
                listeningAgainAt: sentAt(11.2),
              }),
            ],
            sender: [],
          },
          receipts: without([10]),
        })
      );

      expect(verdict.explained.map(({ n }) => n)).toStrictEqual([number(10)]);
    });
  });

  it("PROOF-5: a number sent within the settle time is pending, not missing", () => {
    const verdict = judge(
      evidence({ now: sentAt(30) + 30 * second, receipts: minutes(1, 29).map(received) })
    );

    expect(verdict.pending).toStrictEqual([number(30)]);
    expect(verdict.unexplained).toStrictEqual([]);
    expect(verdict.ok).toBeTruthy();
  });

  it("PROOF-5: a pending number is judged once the settle time has passed", () => {
    const verdict = judge(
      evidence({
        now: sentAt(30) + tolerances.settleMillis + 1,
        receipts: minutes(1, 29).map(received),
      })
    );

    expect(verdict.pending).toStrictEqual([]);
    expect(verdict.unexplained).toStrictEqual([number(30)]);
  });

  it("PROOF-5: a number received twice is a duplicate and fails, Gap or no Gap", () => {
    const verdict = judge(
      evidence({
        gaps: { receiver: [gap({ at: 0, endedAt: undefined })], sender: [] },
        receipts: [...minutes(1, 30).map(received), received(17)],
      })
    );

    expect(verdict.duplicates).toStrictEqual([number(17)]);
    expect(verdict.ok).toBeFalsy();
  });

  it("PROOF-5: a number received that the sender never sent fails", () => {
    const verdict = judge(evidence({ receipts: [...minutes(1, 30).map(received), received(31)] }));

    expect(verdict.neverSent).toStrictEqual([number(31)]);
    expect(verdict.ok).toBeFalsy();
  });

  it("PROOF-5: a Written Line followed by its Dropped Entry is one send, not two", () => {
    const verdict = judge(evidence({ sends: [...minutes(1, 30).map(written), dropped(8)] }));

    expect(verdict.repeated).toStrictEqual([]);
    expect(verdict.sent).toBe(30);
    expect(verdict.ok).toBeTruthy();
  });

  describe("a minute sent twice, which a clock stepped back makes a timer do", () => {
    // Number 8 goes at 5 seconds into its minute and again at 45 seconds. They are two
    // Messages, named by their milliseconds, and each stands on its own.
    const early = 5 * second;
    const late = 45 * second;

    const twice = [
      ...minutes(1, 30)
        .filter((i) => i !== 8)
        .map(written),
      writtenAt(8, early),
      writtenAt(8, late),
    ];

    const withBoth = [...without([8]), receivedAt(8, early), receivedAt(8, late)];

    // A Gap whose window covers 5 seconds into minute 8 and not 45.
    const overEarly = {
      receiver: [gap({ at: sentAt(8), endedAt: sentAt(8) + 20 * second })],
      sender: [],
    };

    const overLate = {
      receiver: [gap({ at: sentAt(8) + 30 * second, endedAt: sentAt(8) + 50 * second })],
      sender: [],
    };

    it("PROOF-5: sent twice and received twice passes, and the repeated minute is noted", () => {
      const verdict = judge(evidence({ receipts: withBoth, sends: twice }));

      expect(verdict.repeated).toStrictEqual([number(8)]);
      expect(verdict).toMatchObject({ delivered: 31, duplicates: [], sent: 31, unexplained: [] });
      expect(verdict.ok).toBeTruthy();
    });

    it("PROOF-5: when only the later Message arrives, the earlier one's loss is judged by its own time, and a Gap over the later time does not excuse it", () => {
      const receipts = [...without([8]), receivedAt(8, late)];

      expect(judge(evidence({ receipts, sends: twice })).unexplained).toStrictEqual([number(8)]);
      expect(judge(evidence({ gaps: overLate, receipts, sends: twice })).unexplained).toStrictEqual(
        [number(8)]
      );
    });

    it("PROOF-5: when only the later Message arrives, a Gap over the earlier one's time explains the earlier one's loss", () => {
      const verdict = judge(
        evidence({
          gaps: overEarly,
          receipts: [...without([8]), receivedAt(8, late)],
          sends: twice,
        })
      );

      expect(verdict.explained.map(({ n }) => n)).toStrictEqual([number(8)]);
      expect(verdict.ok).toBeTruthy();
    });

    it("PROOF-5: when only the earlier Message arrives, the later one's loss is judged by its own time", () => {
      const receipts = [...without([8]), receivedAt(8, early)];

      expect(
        judge(evidence({ gaps: overEarly, receipts, sends: twice })).unexplained
      ).toStrictEqual([number(8)]);
      expect(judge(evidence({ gaps: overLate, receipts, sends: twice })).ok).toBeTruthy();
    });

    it("PROOF-5: a Drop of one Message does not explain another of the same minute", () => {
      // The earlier was written and lost. The later was queued and Dropped, never written.
      const verdict = judge(
        evidence({
          receipts: without([8]),
          sends: [
            ...minutes(1, 30)
              .filter((i) => i !== 8)
              .map(written),
            writtenAt(8, early),
            droppedAt(8, late, "the Connection closed"),
          ],
        })
      );

      expect(verdict.unexplained).toStrictEqual([number(8)]);
      expect(verdict.explained).toStrictEqual([
        { n: number(8), reason: "Dropped: the Connection closed" },
      ]);
      expect(verdict.ok).toBeFalsy();
    });

    it("PROOF-5: a Drop explains the Message it names, and a Line with its Drop is one send", () => {
      const verdict = judge(
        evidence({
          receipts: without([8]),
          sends: [
            ...minutes(1, 30)
              .filter((i) => i !== 8)
              .map(written),
            writtenAt(8, early),
            droppedAt(8, early, "write timed out"),
          ],
        })
      );

      expect(verdict.explained).toStrictEqual([
        { n: number(8), reason: "Dropped: write timed out" },
      ]);
      expect(verdict.sent).toBe(30);
      expect(verdict.ok).toBeTruthy();
    });

    it("PROOF-5: the same Message received twice is a duplicate and fails", () => {
      const verdict = judge(
        evidence({ receipts: [...minutes(1, 30).map(received), receivedAt(8, 0, 601)] })
      );

      expect(verdict.duplicates).toStrictEqual([number(8)]);
      expect(verdict.ok).toBeFalsy();
    });

    it("PROOF-5: the same Message sent twice is a duplicate and fails", () => {
      const verdict = judge(evidence({ sends: [...minutes(1, 30).map(written), written(8)] }));

      expect(verdict.duplicates).toStrictEqual([number(8)]);
      expect(verdict.ok).toBeFalsy();
    });

    it("PROOF-5: a Message of a minute that was sent, but not at that millisecond, was never sent", () => {
      const verdict = judge(
        evidence({ receipts: [...minutes(1, 30).map(received), receivedAt(8, late)] })
      );

      expect(verdict.neverSent).toStrictEqual([number(8)]);
      expect(verdict.ok).toBeFalsy();
    });
  });

  describe("the sender going quiet", () => {
    it("PROOF-5: a sender silent since its last send for longer than the tolerance fails, though nothing is missing", () => {
      const verdict = quiet(minutes(1, 30), sentAt(30) + tolerances.settleMillis + 10 * minute + 1);

      expect(verdict.unexplained).toStrictEqual([]);
      expect(verdict.silent).toBeTruthy();
      expect(verdict.silences).toStrictEqual([{ from: number(31), to: number(40) }]);
      expect(verdict.ok).toBeFalsy();
    });

    it("PROOF-5: a sender silent for exactly the tolerance, after the settle time, still passes", () => {
      const verdict = quiet(minutes(1, 30), sentAt(30) + tolerances.settleMillis + 10 * minute);

      expect(verdict.silent).toBeFalsy();
      expect(verdict.ok).toBeTruthy();
    });

    it("PROOF-5: a stop of 40 minutes followed by fresh successful sends fails", () => {
      const verdict = quiet([...minutes(1, 5), ...minutes(46, 50)], sentAt(50) + 30 * second);

      expect(verdict.silences).toStrictEqual([{ from: number(6), to: number(45) }]);
      expect(verdict.silent).toBeTruthy();
      expect(verdict.ok).toBeFalsy();
    });

    it("PROOF-5: a stop of 40 minutes keeps failing on later checks, however well the sender runs afterwards", () => {
      const stopped = [...minutes(1, 5), ...minutes(46, 50)];
      const later = [...stopped, ...minutes(51, 120)];

      for (const now of [sentAt(50) + minute, sentAt(70), sentAt(120) + 30 * second]) {
        const sent = later.filter((i) => sentAt(i) <= now);
        const verdict = quiet(sent, now);

        expect(verdict.silences).toStrictEqual([{ from: number(6), to: number(45) }]);
        expect(verdict.ok).toBeFalsy();
      }
    });

    it("PROOF-5: reports each stretch the sender did not run, and no other", () => {
      const verdict = quiet(
        [...minutes(1, 5), ...minutes(20, 25), ...minutes(26, 30), ...minutes(50, 52)],
        sentAt(52) + 30 * second
      );

      expect(verdict.silences).toStrictEqual([
        { from: number(6), to: number(19) },
        { from: number(31), to: number(49) },
      ]);
    });

    it("PROOF-5: two sent minutes exactly the tolerance apart pass, and one minute more fails", () => {
      expect(quiet([1, 11], sentAt(11) + minute).silences).toStrictEqual([]);
      expect(quiet([1, 12], sentAt(12) + minute).silences).toStrictEqual([
        { from: number(2), to: number(11) },
      ]);
    });

    it("PROOF-5: a minute whose only send was Dropped still counts as a run of the sender", () => {
      const sends = [...minutes(1, 5), ...minutes(16, 20)];
      const withDrop = quiet(sends, sentAt(20) + minute, [dropped(11)]);
      const without = quiet(sends, sentAt(20) + minute);

      expect(withDrop.silences).toStrictEqual([]);
      expect(without.silences).toStrictEqual([{ from: number(6), to: number(15) }]);
    });
  });

  it("PROOF-5: a sender that never sent anything fails as silent, because nothing missing proves nothing", () => {
    const verdict = judge(evidence({ receipts: [], sends: [] }));

    expect(verdict).toMatchObject({
      lastSentAt: undefined,
      ok: false,
      sent: 0,
      silences: [],
      silent: true,
    });
  });

  it("PROOF-5: the silence counts from the last send of any outcome, Dropped included", () => {
    const verdict = judge(
      evidence({
        now: sentAt(30) + 5 * minute,
        receipts: minutes(1, 29).map(received),
        sends: [...minutes(1, 29).map(written), dropped(30)],
      })
    );

    expect(verdict.lastSentAt).toBe(sentAt(30));
    expect(verdict.silent).toBeFalsy();
  });

  it("PROOF-5: reports every failure at once", () => {
    const verdict = judge(
      evidence({
        now: sentAt(30) + 20 * minute,
        receipts: [...without([5]), received(2), received(40)],
      })
    );

    expect(verdict).toMatchObject({
      duplicates: [number(2)],
      neverSent: [number(40)],
      ok: false,
      silent: true,
      unexplained: [number(5)],
    });
  });
});
