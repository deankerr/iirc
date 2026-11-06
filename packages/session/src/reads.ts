import { channelRead } from "@iirc/protocol/outbound";
import type { ChannelReadCommand, OutboundLine } from "@iirc/protocol/outbound";
import { casemappingOf } from "@iirc/state";
import type { Channel, Channels } from "@iirc/state";

import { connectionView, readErrors } from "./standing.ts";
import type { ChannelReads, ReadAsked, ReadKind, Standing } from "./standing.ts";

// These are named here, not in `Tuning`, until an Owner has a reason to change one. Each is
// a policy over what the Log holds, so changing one changes what happens next, never what
// a Log already written says happened.

/**
 * How long a `NAMES` after a prefix mode is removed waits for removals to stop (KNOW-5). A
 * `-o` usually comes in a handful, from one Line or a few, and one `NAMES` answers them all.
 */
export const namesSettleMillis = 2000;

/**
 * The longest a run of prefix removals can put its `NAMES` off, from the first of them, so
 * that a mode storm that never pauses still gets one `NAMES` this often.
 */
export const namesSettleLimitMillis = 10_000;

/**
 * How long a read waits for its reply before it may be asked again, and the first step of
 * the backoff after that, which doubles with each ask. A `NAMES` of 10,000 members is a few
 * hundred Lines, so an Ircd that answers at all answers well inside this.
 */
export const readTimeoutMillis = 60_000;

/**
 * How many times one read of one Channel is asked on a Session with nothing settling it.
 * After that, an Ircd that never answers, or a Channel too large to hold, is asked no more
 * until the next Session (LIVE-6), so neither can cost Lines for ever.
 */
export const readAsks = 3;

/**
 * How many reads may wait for a reply at once on one Network. One, as Halloy's `WHO`
 * queue keeps by default: the background lane's flood control sets the pace anyway, so a
 * second in flight gains almost nothing, and one at a time keeps 200 Channels at burst
 * from queueing 400 reads ahead of a CTCP reply or a rejoin (SEND-1).
 */
export const readsInFlight = 1;

/**
 * The most members a Channel may have and still be read with `WHO`. Each member costs one
 * `352` Line, and every Line is an Entry, so a Channel past this would cost the Log a Line
 * a member on every Session for `user@host` alone, which each member's own `JOIN` or
 * Message gives as they are seen (KNOW-7).
 */
export const whoMembersLimit = 1000;

/** The cause a read's Line is recorded with. */
export const readCause = "read";

/** A read to send now, and the Line that asks it. */
export interface PlannedRead {
  readonly channel: string;
  readonly kind: ReadKind;
  readonly line: OutboundLine;
}

/** Which reads to send now, in order, and when the answer could next differ. */
export interface ReadPlan {
  readonly lookAgainAt: number | undefined;
  readonly reads: readonly PlannedRead[];
}

const commands: Readonly<Record<ReadKind, ChannelReadCommand>> = {
  modes: "MODE",
  names: "NAMES",
  who: "WHO",
};

// Corrections before enrichment: what may be wrong is read before who members are.
const kinds: readonly ReadKind[] = ["modes", "names", "who"];

const isWhoSized = (channel: Channel) => channel.members.size <= whoMembersLimit;

// When a Channel first needs a read, for its own reasons, or `undefined` if it does not.
// `0` is at once. Modes are read once after joining, and again whenever they become
// uncertain (KNOW-6). Members come with the `JOIN`, so they are read only once uncertain,
// or once prefix removals settle. `WHO` follows the `JOIN`'s own `NAMES` once.
const neededAt = (kind: ReadKind, channel: Channel, reads: ChannelReads): number | undefined => {
  switch (kind) {
    case "modes": {
      return !reads.read.modes || channel.modesUncertain ? 0 : undefined;
    }

    case "names": {
      const removed = reads.prefixRemoved;

      if (channel.membersUncertain) {
        return 0;
      }

      return removed === undefined
        ? undefined
        : Math.min(
            removed.latest.at + namesSettleMillis,
            removed.first.at + namesSettleLimitMillis
          );
    }

    case "who": {
      return reads.read.names && !reads.read.who && isWhoSized(channel) ? 0 : undefined;
    }

    default: {
      return kind satisfies never;
    }
  }
};

const retryAt = ({ at, count }: ReadAsked) => at + readTimeoutMillis * 2 ** Math.max(count - 1, 0);

// A read asked and unsettled waits for its backoff, whether it was answered or not, and is
// asked no more once it has been asked `readAsks` times.
const dueAt = (kind: ReadKind, channel: Channel, reads: ChannelReads): number | undefined => {
  const needed = neededAt(kind, channel, reads);
  const asked = reads.asked[kind];

  if (needed === undefined || asked === undefined) {
    return needed;
  }

  return asked.count >= readAsks ? undefined : Math.max(needed, retryAt(asked));
};

const isInFlight = (asked: ReadAsked | undefined, now: number): asked is ReadAsked =>
  asked !== undefined && !asked.answered && now < asked.at + readTimeoutMillis;

const earlier = (one: number | undefined, other: number | undefined) =>
  one === undefined ? other : Math.min(one, other ?? one);

/**
 * Works out which reads of the Channels Self is in to send now (KNOW-5, KNOW-6): `MODE` once
 * joined and whenever modes are uncertain, `NAMES` once members are uncertain or 2 seconds
 * after prefix removals stop, and `WHO` once the `JOIN`'s `NAMES` has landed, for a Channel
 * of at most {@link whoMembersLimit} members. At most {@link readsInFlight} wait for a reply
 * at once. Like `joinPlan`, a read only counts as asked once its Line is recorded, so what
 * this returns may be returned again until then.
 * @param standing - The Network's Standing.
 * @param now - The time now, in epoch milliseconds.
 * @returns What to read now, in order, and when to look again if nothing else changes.
 * Nothing is read until joining may go on, or once a close has begun.
 */
export const readPlan = (standing: Standing, now: number): ReadPlan => {
  if (connectionView(standing)?.joinable !== true) {
    return { lookAgainAt: undefined, reads: [] };
  }

  const due: (PlannedRead & { readonly asks: number })[] = [];
  let inFlight = 0;
  let lookAgainAt: number | undefined;

  for (const kind of kinds) {
    for (const [key, channel] of standing.irc.channels) {
      const reads = standing.reads.get(key);
      const asked = reads?.asked[kind];
      const at = reads === undefined ? undefined : dueAt(kind, channel, reads);
      const built = at === undefined ? undefined : channelRead(commands[kind], channel.name);

      if (isInFlight(asked, now)) {
        inFlight += 1;
        lookAgainAt = earlier(lookAgainAt, asked.at + readTimeoutMillis);
      }

      // A name no Line can carry is never read, and costs no look again.
      if (at !== undefined && built?._tag === "Safe") {
        if (at <= now) {
          due.push({ asks: asked?.count ?? 0, channel: channel.name, kind, line: built.line });
        } else {
          lookAgainAt = earlier(lookAgainAt, at);
        }
      }
    }
  }

  // A read never asked goes ahead of one asked again, so that an Ircd that ignores one
  // Channel's read cannot hold up every other Channel's.
  const reads = due
    .toSorted((one, other) => one.asks - other.asks)
    .slice(0, Math.max(readsInFlight - inFlight, 0))
    .map(({ channel, kind, line }) => ({ channel, kind, line }));

  // What goes out now is looked at again as if it were already recorded as asked.
  return {
    lookAgainAt: reads.length > 0 ? earlier(lookAgainAt, now + readTimeoutMillis) : lookAgainAt,
    reads,
  };
};

// Whether any Channel's modes or members became uncertain or certain, or its size crossed
// `whoMembersLimit`, which is all of a Channel's state a plan reads besides its reads.
// Members coming and going move a Channel far more often than that, so a Channel the Line
// did not touch is passed over by identity, and one it did costs three comparisons.
const sameInputs = (one: Channels, other: Channels) => {
  if (one === other) {
    return true;
  }

  if (one.size !== other.size) {
    return false;
  }

  for (const [key, channel] of other) {
    const before = one.get(key);

    if (
      before !== channel &&
      (before === undefined ||
        before.modesUncertain !== channel.modesUncertain ||
        before.membersUncertain !== channel.membersUncertain ||
        isWhoSized(before) !== isWhoSized(channel))
    ) {
      return false;
    }
  }

  return true;
};

/**
 * Whether anything {@link readPlan} reads of a Standing moved between two of them,
 * including a Channel's size crossing {@link whoMembersLimit} either way.
 * @param before - The Standing a plan was last made from, or looked at for one.
 * @param after - The Standing now.
 * @returns Whether to plan again.
 */
export const readPlanMoved = (before: Standing, after: Standing): boolean =>
  before.reads !== after.reads ||
  before.attempt?.sequence !== after.attempt?.sequence ||
  casemappingOf(before.irc) !== casemappingOf(after.irc) ||
  connectionView(before)?.joinable !== connectionView(after)?.joinable ||
  !sameInputs(before.irc.channels, after.irc.channels);

// Every command whose Lines can move what a plan reads: which Channels Self is in and the
// mapping, a mode that leaves a Channel uncertain or removes a prefix, a member leaving,
// which can bring a Channel under `whoMembersLimit`, the numerics that end each read's
// reply, and the errors that answer one. `352` and `353` are inside a reply, and move
// nothing until its end.
const readCommands: ReadonlySet<string> = new Set([
  "001",
  "005",
  "315",
  "324",
  "366",
  "JOIN",
  "KICK",
  "MODE",
  "PART",
  "QUIT",
  ...readErrors,
]);

/**
 * Whether Lines of a command can move what {@link readPlan} reads, so a host can skip
 * looking again after any other Line, such as the Messages of a flood. Self's own reads
 * move it too, and a host that sent one plans again once it is recorded.
 * @param command - An inbound Line's command.
 * @returns Whether a Line of it can move a read plan.
 */
export const movesReads = (command: string): boolean => readCommands.has(command);
