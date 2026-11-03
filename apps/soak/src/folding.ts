import type { LogEntry } from "@iirc/api";
import { parseLine } from "@iirc/protocol/line";
import { initialState, stepState, casefold } from "@iirc/state";
import type { Casemapping, IrcState } from "@iirc/state";

import { soakLine } from "./soak-text.ts";
import type { Receipt, Send, Span } from "./verdict.ts";

// One pass over a Daemon's Log, an Entry at a time, that keeps only what PROOF-5 needs of
// it: the counted Messages, who Self was, and for each Gap when the Daemon last heard from
// the Ircd and when its own `JOIN` came back. Nothing else is held, so a month of a busy
// Channel costs what its counted Messages and its Gaps do. Names are compared as the Ircd
// does, by the `CASEMAPPING` that Connection was told (KNOW-3), through the same fold the
// Daemon uses.

/** A Gap as the API gives it. */
export interface RawGap {
  readonly at: number;
  readonly endedAt: number | undefined;
  /** The sequence of the `001` that ended it. */
  readonly endedSequence: number | undefined;
  readonly reason: string;
  readonly sequence: number;
}

/**
 * Keeps the Gaps as a Log stood at `head`, which is as far as the Entries were read. A Gap
 * recorded after it is not yet seen, and neither is the end of one that ended after it,
 * so that Gap is open, and its window with it, for this run.
 * @param head - The newest sequence the Log had when it was read.
 * @param gaps - The Gaps, read after `head`.
 * @returns The Gaps as they were at `head`.
 */
export const boundedBy = (head: number, gaps: readonly RawGap[]): readonly RawGap[] =>
  gaps.flatMap((gap) => {
    if (gap.sequence > head) {
      return [];
    }

    return gap.endedSequence !== undefined && gap.endedSequence > head
      ? [{ ...gap, endedAt: undefined, endedSequence: undefined }]
      : [gap];
  });

/** A counted Message heard, and who from, with the mapping its Connection compared names by. */
export interface Heard extends Receipt {
  readonly casemapping: Casemapping;
  readonly sender: string;
}

/** What one pass over a Log leaves. */
export interface Folded {
  /** Each Gap, with its window. */
  readonly gaps: readonly Span[];
  /** Counted Messages the Daemon heard on the Target, from anyone. */
  readonly heard: readonly Heard[];
  /** Every nick Self had when it sent a counted Message to the Target, as spelled. */
  readonly nicks: ReadonlySet<string>;
  /** Counted Messages the Daemon sent to the Target, written or Dropped. */
  readonly sends: readonly Send[];
}

/** A pass in progress: feed it Entries in sequence order, then take what it holds. */
export interface Folder {
  readonly finish: () => Folded;
  readonly step: (entry: LogEntry) => void;
}

// Whether a Target is a Channel, which Self has to join to hear, and not a nick.
const isChannel = (target: string) => /^[#&+!]/u.test(target);

interface Pending {
  readonly gap: RawGap;
  lastHeardAt: number | undefined;
  listeningAgainAt: number | undefined;
  settled: boolean;
}

const sameName = (casemapping: Casemapping, one: string, other: string) =>
  casefold(casemapping, one) === casefold(casemapping, other);

/**
 * Starts a pass over one Daemon's Log for one Target.
 * @param target - The Target the soak sends to.
 * @param gaps - The Network's Gaps, by sequence.
 * @returns The pass.
 */
export const folder = (target: string, gaps: readonly RawGap[]): Folder => {
  const pending: Pending[] = gaps.map((gap) => ({
    gap,
    lastHeardAt: undefined,
    // A nick needs no `JOIN`, so listening is back when the Gap ends.
    listeningAgainAt: isChannel(target) ? undefined : gap.endedAt,
    settled: false,
  }));

  const sends: Send[] = [];
  const heard: Heard[] = [];
  const nicks = new Set<string>();
  let connection: number | undefined;
  let irc: IrcState = initialState;
  let lastInboundAt: number | undefined;

  // Every Gap that began before this Entry has had all the Lines it will have.
  const settleBefore = (sequence: number) => {
    for (const each of pending) {
      if (!each.settled && each.gap.sequence < sequence) {
        each.lastHeardAt = lastInboundAt;
        each.settled = true;
      }
    }
  };

  const joined = (at: number, sequence: number) => {
    for (const each of pending) {
      if (
        each.listeningAgainAt === undefined &&
        each.gap.endedSequence !== undefined &&
        sequence > each.gap.endedSequence
      ) {
        each.listeningAgainAt = at;
      }
    }
  };

  const inbound = (entry: Extract<LogEntry, { _tag: "Line" }>) => {
    lastInboundAt = entry.at;

    const parsed = parseLine(entry.text);

    if (parsed._tag !== "Line") {
      return;
    }

    const stepped = stepState(irc, parsed.line);

    irc = stepped.next;

    const { casemapping } = irc.isupport;

    for (const change of stepped.changes) {
      if (
        change._tag === "Joined" &&
        isChannel(target) &&
        sameName(casemapping, change.channel, target)
      ) {
        joined(entry.at, entry.sequence);
      }
    }

    const said = soakLine(entry.text);

    if (said?.source !== undefined && sameName(casemapping, said.target, target)) {
      heard.push({
        at: entry.at,
        casemapping,
        millis: said.millis,
        n: said.n,
        sender: said.source,
        sequence: entry.sequence,
      });
    }
  };

  const step = (entry: LogEntry) => {
    settleBefore(entry.sequence);

    if (entry._tag === "Line") {
      if (entry.connection !== connection) {
        ({ connection } = entry);
        irc = initialState;
      }

      if (entry.direction === "inbound") {
        inbound(entry);
      } else {
        const said = soakLine(entry.text);

        if (said !== undefined && sameName(irc.isupport.casemapping, said.target, target)) {
          sends.push({
            at: entry.at,
            millis: said.millis,
            n: said.n,
            outcome: { _tag: "Written" },
            sequence: entry.sequence,
          });

          if (irc.self !== undefined) {
            nicks.add(irc.self);
          }
        }
      }
    } else if (entry._tag === "Dropped") {
      const said = soakLine(entry.text);

      if (said !== undefined && sameName(irc.isupport.casemapping, said.target, target)) {
        sends.push({
          at: entry.at,
          millis: said.millis,
          n: said.n,
          outcome: { _tag: "Dropped", reason: entry.reason },
          sequence: entry.sequence,
        });
      }
    }
  };

  const finish = (): Folded => {
    settleBefore(Infinity);

    return {
      gaps: pending.map(({ gap, lastHeardAt, listeningAgainAt }) => ({
        at: gap.at,
        endedAt: gap.endedAt,
        lastHeardAt,
        listeningAgainAt,
        reason: gap.reason,
        sequence: gap.sequence,
      })),
      heard,
      nicks,
      sends,
    };
  };

  return { finish, step };
};

/**
 * Keeps what came from the sender's nicks.
 * @param heard - What the receiver heard.
 * @param nicks - The nicks the sender used, as spelled.
 * @returns The receipts from the sender.
 */
export const heardFrom = (
  heard: readonly Heard[],
  nicks: ReadonlySet<string>
): readonly Receipt[] =>
  heard.flatMap(({ at, casemapping, millis, n, sender, sequence }) =>
    [...nicks].some((nick) => sameName(casemapping, nick, sender))
      ? [{ at, millis, n, sequence }]
      : []
  );
