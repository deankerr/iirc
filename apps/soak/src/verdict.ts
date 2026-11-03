// PROOF-5: what the two Logs say of one pair, as a pure function of what they hold. The
// reading that fills it in lives elsewhere, so every rule here is tested on its own.

/** What became of a counted Message that the sender's Log shows it sending. */
type Outcome =
  | { readonly _tag: "Written" }
  /** A Dropped Entry: the Line never left, or its write did not complete (SEND-4). */
  | { readonly _tag: "Dropped"; readonly reason: string };

/** One thing the sender's Log records of a counted Message. */
export interface Send {
  /** When the sender recorded it, in epoch milliseconds. */
  readonly at: number;
  /** The Unix minute the sender ran in, which silence is judged by (PROOF-5). */
  readonly n: number;
  /**
   * The millisecond the sender's run began, which with the minute names this Message. Two
   * Messages are the same one only if this is the same.
   */
  readonly millis: number;
  readonly outcome: Outcome;
  /** The sequence of the sender's Entry. */
  readonly sequence: number;
}

/** A counted Message the receiver's Log records from the sender. */
export interface Receipt {
  readonly at: number;
  readonly millis: number;
  readonly n: number;
  /** The sequence of the receiver's Entry. */
  readonly sequence: number;
}

/**
 * A Gap in one Daemon's Log, with what the Log shows of when the Daemon could and could
 * not have taken a Message in and around it.
 */
export interface Span {
  readonly at: number;
  /** When the next Session began. A Gap still open has none. */
  readonly endedAt: number | undefined;
  /**
   * When the Daemon last heard anything from the Ircd before the Gap began. It was
   * demonstrably listening up to then, so a Message sent before this is not lost to the
   * Gap. A Connection that died unnoticed was dead from some time after this.
   */
  readonly lastHeardAt: number | undefined;
  /**
   * When the Daemon was listening on the Target again after the Gap: the recorded echo of
   * its own `JOIN` of a Channel, or the `001` that ended the Gap for a Target that is a
   * nick. `undefined` while that has not happened, and the Gap stays open until it does.
   */
  readonly listeningAgainAt: number | undefined;
  readonly reason: string;
  readonly sequence: number;
}

/**
 * How much slack the rules give, in milliseconds. Each is a named number so that a rule
 * is a decision somebody can read and change, not a constant inside a comparison. Gaps
 * need none, because their edges come from the Logs.
 */
export interface Tolerances {
  /**
   * How long a Message is given to arrive before it counts as missing. A Message sent a
   * moment before the check ran has not been missed yet.
   */
  readonly settleMillis: number;
  /**
   * The longest the sender may go between two sent minutes, and since its last, before
   * that is a failure.
   */
  readonly silenceMillis: number;
}

/** The tolerances that need no choice from the Owner. */
export const defaultTolerances = { settleMillis: 120_000 } as const;

/** Everything one pair is judged on. */
export interface Evidence {
  readonly gaps: {
    readonly receiver: readonly Span[];
    readonly sender: readonly Span[];
  };
  /** When the check began, before it read either Log. */
  readonly now: number;
  readonly receipts: readonly Receipt[];
  readonly sends: readonly Send[];
  readonly tolerances: Tolerances;
}

/** A Message that did not arrive, and what accounts for it. */
export interface Explained {
  readonly n: number;
  readonly reason: string;
}

/** Minutes with no send, from the first to the last of them. */
export interface Silence {
  readonly from: number;
  readonly to: number;
}

/** What the Logs say of one pair. `ok` is the whole verdict. */
export interface Verdict {
  /** How many of the Messages sent arrived. */
  readonly delivered: number;
  /** Minutes of a Message sent, or received, more than once, which is always a failure. */
  readonly duplicates: readonly number[];
  /** Numbers that did not arrive and have an account (PROOF-5: every Gap explained). */
  readonly explained: readonly Explained[];
  /** When the sender last recorded sending anything, if it ever did. */
  readonly lastSentAt: number | undefined;
  /** Numbers the receiver has from the sender's nick that the sender never sent. */
  readonly neverSent: readonly number[];
  readonly ok: boolean;
  /** Numbers too recent to have been missed yet. */
  readonly pending: readonly number[];
  /**
   * Minutes the sender sent in more than once, as different Messages, which a clock stepped
   * back makes a timer do. It is told and not judged: each Message stands on its own.
   */
  readonly repeated: readonly number[];
  /** How many different Messages the sender sent. */
  readonly sent: number;
  /** The sender never sent, or went quiet at some time for longer than the tolerance. */
  readonly silent: boolean;
  /**
   * The minutes in which the sender did not run, for each stretch longer than the
   * tolerance: between two sent minutes, or since the last. They are history, so they
   * stay in every later verdict, however well the sender runs afterwards.
   */
  readonly silences: readonly Silence[];
  /** Numbers that did not arrive and have no account, which is the failure we look for. */
  readonly unexplained: readonly number[];
}

const ascending = (numbers: Iterable<number>) => [...numbers].toSorted((a, b) => a - b);

const group = <Item>(items: readonly Item[], key: (item: Item) => number): Map<number, Item[]> => {
  const groups = new Map<number, Item[]>();

  for (const item of items) {
    const held = groups.get(key(item));

    if (held === undefined) {
      groups.set(key(item), [item]);
    } else {
      held.push(item);
    }
  }

  return groups;
};

// A Message sent in this window may have been lost to the Gap: from when the Daemon last
// heard from the Ircd, to when it was listening on the Target again. A window with an end
// the Log has not recorded yet is open.
const covers = (span: Span, at: number) =>
  at >= Math.min(span.lastHeardAt ?? span.at, span.at) &&
  (span.endedAt === undefined ||
    span.listeningAgainAt === undefined ||
    at <= span.listeningAgainAt);

const gapReason = (who: string, span: Span) =>
  `${who} Gap at Entry ${span.sequence}: ${span.reason}`;

// Why a Message that did not arrive is accounted for, if it is: its own Dropped Entry first,
// because that is certain, and then the Gaps, whose windows the Logs bound. A Drop is tied
// to a Message by its identity, so it explains that Message and no other.
const accountFor = (sends: readonly Send[], gaps: Evidence["gaps"]): string | undefined => {
  const dropped = sends.find(({ outcome }) => outcome._tag === "Dropped")?.outcome;

  if (dropped?._tag === "Dropped") {
    return `Dropped: ${dropped.reason}`;
  }

  const at = Math.min(...sends.map((send) => send.at));
  const receiver = gaps.receiver.find((span) => covers(span, at));
  const sender = gaps.sender.find((span) => covers(span, at));

  if (receiver !== undefined) {
    return gapReason("receiver", receiver);
  }

  return sender === undefined ? undefined : gapReason("sender", sender);
};

const minuteMillis = 60_000;

// The stretches the sender did not run for longer than the tolerance, from the minutes it
// did. A minute with only a Dropped send still ran, so it counts. The last stretch ends
// at the minute `now` less the settle time falls in, so that a sender that is merely
// between two runs is not silent.
const silencesIn = (
  sends: readonly Send[],
  now: number,
  { settleMillis, silenceMillis }: Tolerances
): readonly Silence[] => {
  const minutes = ascending(new Set(sends.map(({ n }) => n)));
  const stretches: Silence[] = [];

  for (const [index, minute] of minutes.entries()) {
    const next = minutes[index + 1];

    if (next !== undefined && (next - minute) * minuteMillis > silenceMillis) {
      stretches.push({ from: minute + 1, to: next - 1 });
    }
  }

  const last = minutes.at(-1);

  if (last !== undefined && now - settleMillis - last * minuteMillis > silenceMillis) {
    stretches.push({
      from: last + 1,
      to: Math.floor((now - settleMillis) / minuteMillis),
    });
  }

  return stretches;
};

// What the Messages the sender sent came to, each judged alone by its identity.
const judgeSent = (
  sent: ReadonlyMap<number, readonly Send[]>,
  received: ReadonlyMap<number, readonly Receipt[]>,
  { gaps, now, tolerances }: Pick<Evidence, "gaps" | "now" | "tolerances">
) => {
  let delivered = 0;
  const pending = new Set<number>();
  const unexplained = new Set<number>();
  const duplicates = new Set<number>();
  const explained: Explained[] = [];

  for (const [millis, these] of sent) {
    const n = these[0]?.n ?? 0;
    const heard = received.get(millis)?.length ?? 0;

    // A Line and the Dropped Entry for its write that did not complete are one send.
    const lines = these.filter(({ outcome }) => outcome._tag === "Written").length;

    if (lines > 1 || these.length - lines > 1 || heard > 1) {
      duplicates.add(n);
    }

    if (heard > 0) {
      delivered += 1;
    } else if (these.some(({ at }) => at > now - tolerances.settleMillis)) {
      pending.add(n);
    } else {
      const reason = accountFor(these, gaps);

      if (reason === undefined) {
        unexplained.add(n);
      } else {
        explained.push({ n, reason });
      }
    }
  }

  return { delivered, duplicates, explained, pending, unexplained };
};

// The minutes the sender sent in more than once, as different Messages.
const repeatedMinutes = (sent: ReadonlyMap<number, readonly Send[]>) => {
  const identities = new Map<number, number>();

  for (const these of sent.values()) {
    const n = these[0]?.n ?? 0;

    identities.set(n, (identities.get(n) ?? 0) + 1);
  }

  return ascending([...identities].flatMap(([n, count]) => (count > 1 ? [n] : [])));
};

/**
 * Judges one pair from what both Logs hold (PROOF-5).
 *
 * Every Message is its own, named by its minute and millisecond, and is judged alone. One
 * the receiver has is delivered. One it has not is *missing*, and is *explained* if the
 * sender's Log shows that Message Dropped, or a Gap in either Daemon's Log covers the time
 * it was sent: from when that Daemon last heard from the Ircd before the Gap, to when it
 * was listening on the Target again. Otherwise it is *unexplained*, and the check fails. A
 * Message too recent to have been missed is *pending*. The check also fails on a Message
 * sent or received more than once, a Message received that was never sent, and a sender
 * that went quiet at any time, because a Log with nothing missing is no proof if nothing
 * was sent. Minutes are Unix minutes, so a minute the sender did not run is a minute
 * without a Message, and stays one.
 * @param evidence - The sender's sends, the receiver's receipts, both Daemons' Gaps, and
 * the time and tolerances to judge by.
 * @returns The verdict.
 */
export const judge = ({ gaps, now, receipts, sends, tolerances }: Evidence): Verdict => {
  const sent = group(sends, ({ millis }) => millis);
  const received = group(receipts, ({ millis }) => millis);
  const judged = judgeSent(sent, received, { gaps, now, tolerances });

  const neverSent = new Set(
    [...received].flatMap(([millis, these]) => (sent.has(millis) ? [] : [these[0]?.n ?? 0]))
  );

  let lastSentAt: number | undefined;

  for (const { at } of sends) {
    lastSentAt = lastSentAt === undefined ? at : Math.max(lastSentAt, at);
  }

  const silences = silencesIn(sends, now, tolerances);
  const silent = sends.length === 0 || silences.length > 0;

  return {
    delivered: judged.delivered,
    duplicates: ascending(judged.duplicates),
    explained: judged.explained.toSorted((a, b) => a.n - b.n),
    lastSentAt,
    neverSent: ascending(neverSent),
    ok:
      judged.unexplained.size === 0 &&
      judged.duplicates.size === 0 &&
      neverSent.size === 0 &&
      !silent,
    pending: ascending(judged.pending),
    repeated: repeatedMinutes(sent),
    sent: sent.size,
    silences,
    silent,
    unexplained: ascending(judged.unexplained),
  };
};
