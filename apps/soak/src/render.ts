import type { CheckPair } from "./pair.ts";
import type { Explained, Silence, Verdict } from "./verdict.ts";

/**
 * Numbers as the ranges they form, such as `1-3,7`.
 * @param numbers - Whole numbers, in any order.
 * @returns The ranges, ascending and comma separated, or `""` for none.
 */
export const ranges = (numbers: readonly number[]): string => {
  const runs: [from: number, to: number][] = [];

  for (const n of numbers.toSorted((a, b) => a - b)) {
    const last = runs.at(-1);

    if (last !== undefined && n === last[1] + 1) {
      last[1] = n;
    } else {
      runs.push([n, n]);
    }
  }

  return runs.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(",");
};

/**
 * A pair as the Owner typed it to `check`.
 * @param pair - The pair.
 * @returns Its text, such as `floor:floor=#soak`.
 */
export const pairLabel = ({ receiver, sender, target }: CheckPair) =>
  `${sender}:${receiver}=${target}`;

interface ExplainedGroup {
  readonly count: number;
  readonly numbers: string;
  readonly reason: string;
}

// One group for each reason, since a Gap explains a run of numbers, and a month of them
// should not take a month of lines.
const groupedByReason = (explained: readonly Explained[]): readonly ExplainedGroup[] =>
  [...new Set(explained.map(({ reason }) => reason))].map((reason) => {
    const numbers = explained.flatMap((each) => (each.reason === reason ? [each.n] : []));

    return { count: numbers.length, numbers: ranges(numbers), reason };
  });

const secondsPerMinute = 60;
const millisPerSecond = 1000;

const silenceText = ({ from, to }: Silence) => (from === to ? `${from}` : `${from}-${to}`);

const ago = (now: number, at: number | undefined) => {
  if (at === undefined) {
    return "nothing sent yet";
  }

  const seconds = Math.max(0, Math.round((now - at) / millisPerSecond));

  return seconds < secondsPerMinute
    ? `last sent ${seconds} s ago`
    : `last sent ${Math.round(seconds / secondsPerMinute)} min ago`;
};

/**
 * One pair's verdict as a line for a journal, saying what failed and which numbers.
 * Failures and pending are counted in minutes, not Messages: two Messages of one minute
 * count once there, while `sent` and `delivered` count Messages.
 * @param pair - The pair.
 * @param verdict - Its verdict.
 * @param now - When the check began, in epoch milliseconds.
 * @returns The line.
 */
export const summaryLine = (pair: CheckPair, verdict: Verdict, now: number) => {
  const problems = [
    ...(verdict.unexplained.length > 0
      ? [`UNEXPLAINED in minutes ${verdict.unexplained.length} (${ranges(verdict.unexplained)})`]
      : []),
    ...(verdict.duplicates.length > 0
      ? [`DUPLICATED in minutes ${verdict.duplicates.length} (${ranges(verdict.duplicates)})`]
      : []),
    ...(verdict.neverSent.length > 0
      ? [
          `RECEIVED BUT NEVER SENT in minutes ${verdict.neverSent.length} (${ranges(verdict.neverSent)})`,
        ]
      : []),
    ...(verdict.silent
      ? [
          verdict.silences.length === 0
            ? `SENDER SILENT (${ago(now, verdict.lastSentAt)})`
            : `SENDER SILENT (no send in minutes ${verdict.silences.map(silenceText).join(",")})`,
        ]
      : []),
  ];

  const facts = [
    `sent ${verdict.sent}`,
    `delivered ${verdict.delivered}`,
    ...(verdict.pending.length > 0 ? [`pending in minutes ${verdict.pending.length}`] : []),
    ...(verdict.repeated.length > 0
      ? [`repeated minutes ${verdict.repeated.length} (${ranges(verdict.repeated)})`]
      : []),
    ...groupedByReason(verdict.explained).map(
      ({ count, numbers, reason }) => `explained ${count} (${numbers}) by ${reason}`
    ),
    ago(now, verdict.lastSentAt),
  ];

  return `soak ${pairLabel(pair)} ${verdict.ok ? "OK" : "FAILED"}: ${[...problems, ...facts].join("; ")}`;
};

// What one pair adds to the report file. Lists of numbers are ranges, as `ranges` writes.
const pairRecord = (pair: CheckPair, verdict: Verdict, now: number) => ({
  delivered: verdict.delivered,
  duplicates: ranges(verdict.duplicates),
  explained: groupedByReason(verdict.explained),
  lastSentAgoMillis: verdict.lastSentAt === undefined ? null : now - verdict.lastSentAt,
  neverSent: ranges(verdict.neverSent),
  ok: verdict.ok,
  pair: pairLabel(pair),
  pendingMinutes: verdict.pending.length,
  repeated: ranges(verdict.repeated),
  sent: verdict.sent,
  silences: verdict.silences.map(silenceText).join(","),
  silent: verdict.silent,
  unexplained: ranges(verdict.unexplained),
});

/**
 * One run as a line of JSON for the report file: when, and for each pair the counts, the
 * failing numbers, and the explained misses with their reasons.
 * @param now - When the check began, in epoch milliseconds.
 * @param results - Each pair and its verdict.
 * @returns The line, with no line ending.
 */
export const reportLine = (
  now: number,
  results: readonly (readonly [CheckPair, Verdict])[]
): string =>
  JSON.stringify({
    at: new Date(now).toISOString(),
    ok: results.every(([, verdict]) => verdict.ok),
    pairs: results.map(([pair, verdict]) => pairRecord(pair, verdict, now)),
  });

/**
 * A run that could not read a Log, for the report file, so that the file records the run.
 * @param now - When the check began, in epoch milliseconds.
 * @param error - What stopped it.
 * @returns The line, with no line ending.
 */
export const unableLine = (now: number, error: string): string =>
  JSON.stringify({ at: new Date(now).toISOString(), error, ok: false });
