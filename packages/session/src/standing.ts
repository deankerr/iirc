import { inspect, start } from "@iirc/lifecycle";
import type { ConnectionView, Login, NetworkSnapshot } from "@iirc/lifecycle";
import type { Tuning } from "@iirc/lifecycle/tuning";
import { parseFallbackEncoding } from "@iirc/protocol/decode";
import type { FallbackEncoding } from "@iirc/protocol/decode";
import { channelKey } from "@iirc/protocol/join";
import { parseFrame } from "@iirc/protocol/line";
import type { Line } from "@iirc/protocol/line";
import {
  casefold,
  casemappingOf,
  channelOf,
  initialState,
  mayFoldFurther,
  sessionState,
  stepState,
} from "@iirc/state";
import type { Casemapping, Channels, IrcState, JoinFailure, StateChange } from "@iirc/state";
import type { Array as Arr } from "effect";

import {
  afterCtcpDropped,
  afterCtcpRequest,
  afterCtcpSent,
  noCtcpReplies,
  withoutPending,
} from "./ctcp.ts";
import type { CtcpReplies } from "./ctcp.ts";
import type { Entry, Ircd, NetworkId } from "./entry.ts";
import { stepEntry } from "./events.ts";

/** A place in the Log. */
export interface Moment {
  readonly at: number;
  readonly sequence: number;
}

/**
 * The `attempt` Entry a Network last made, the Ircd it used, and the Tuning it recorded,
 * which its Connection's Lines are read with: its fallback encoding (MSG-4), its forced
 * casemapping (KNOW-3), and its CTCP replies (PROT-3, PROT-4). So decoding and CTCP replies
 * are folds over the Log, and a rebuild reads each Connection as live did, whatever the
 * Owner has changed since.
 */
export interface Attempted extends Moment {
  /** The fallback `tuning.encoding` names, if it has one this runtime can decode with. */
  readonly fallback: FallbackEncoding | undefined;
  readonly ircd: Ircd;
  readonly tuning: Tuning;
}

/** The Daemon's decision to end a Connection, as its first `closing` Entry said (LOG-2). */
export interface Closing {
  /** The Daemon chose to leave (LIVE-9), so however this ends, it is not a failure. */
  readonly chosen: boolean;
  readonly reason: string;
}

/**
 * A Connection with no end recorded yet. It may not have reached the Ircd. How far it got,
 * and how its login went, are its machine's to say, folded over its own Entries, and read
 * through {@link connectionView}. What is kept here beside the
 * machine is what only the Log knows: who decided to end it, and where it last was.
 */
export interface LiveConnection {
  /** Set once the Daemon has decided to end it. */
  readonly closing: Closing | undefined;
  /** Its latest Entry, which is where it ended if the process was killed. */
  readonly last: Moment;
  /**
   * Its machine, which {@link connectionView} reads, and which the host steps on from and
   * waits on the deadline of. The host keeps no machine of its own.
   */
  readonly machine: NetworkSnapshot;
  readonly network: NetworkId;
  /** The sequence of its `attempt` Entry. */
  readonly sequence: number;
}

/** How a Connection ended, as backoff and status need it. */
export interface EndedConnection {
  readonly at: number;
  /** The Daemon chose to leave. */
  readonly deliberate: boolean;
  /** Why it ended, as its `closed` Entry said, or as the fold worked out if none did. */
  readonly reason: string;
  /** How long its Session lasted, if it reached one. */
  readonly sessionMillis: number | undefined;
}

/** A Channel's latest `JOIN` failure, and when and on which Connection it came. */
export interface HeldJoinFailure extends JoinFailure {
  readonly at: number;
  readonly connection: number | undefined;
}

/** A Channel's `JOIN`s on this Connection since Self was last in it. */
export interface JoinAsked {
  /** When the latest one was sent. */
  readonly at: number;
  /** How many have been sent. */
  readonly count: number;
}

/** A read of a Channel the Daemon asks for (KNOW-5): its modes, its members, or who they are. */
export type ReadKind = "modes" | "names" | "who";

/** The latest ask for one read on this Session, which nothing has settled yet (KNOW-5). */
export interface ReadAsked extends Moment {
  /**
   * The Ircd answered: with a reply that left what it read uncertain, as a `NAMES` cut by a
   * bound does, or with an error naming the Channel. Either way it is no longer in flight.
   */
  readonly answered: boolean;
  /** How many have been sent since one last settled it. */
  readonly count: number;
  /** The answer was an error, such as `403` or `442`, which says nothing more (KNOW-5). */
  readonly failed: boolean;
}

/**
 * Prefix modes removed since the latest `NAMES` asked, which only another `NAMES` can show
 * the rest of, because without `multi-prefix` a member with `@+` shows only `@` (KNOW-5).
 */
export interface PrefixRemovals {
  readonly first: Moment;
  readonly latest: Moment;
}

/**
 * What has been read of a Channel Self is in on this Session, and what is asked. Self's own
 * outbound Lines say what was asked, and the Ircd's replies what was read, so this is a fold
 * of the Log like the rest, and apart from {@link IrcState}, which only an Ircd moves. It
 * belongs to a Channel `IrcState` holds, under `IrcState`'s key for it, and to nothing else.
 */
export interface ChannelReads {
  /** Each read sent and not yet settled, by kind. */
  readonly asked: Readonly<Partial<Record<ReadKind, ReadAsked>>>;
  readonly prefixRemoved: PrefixRemovals | undefined;
  /** Whether a `324`, a `366`, and a `315` have each come since Self joined. */
  readonly read: Readonly<Record<ReadKind, boolean>>;
}

/** An outbound lag check with no answer yet (LIVE-3). */
export interface LagCheck {
  readonly at: number;
  readonly token: string;
}

/**
 * Time the Daemon was not on a Network (LIVE-10). `at` and `sequence` are where it
 * began: the Session's `closed` Entry, or its last Entry if nothing closed it.
 */
export interface Gap extends Moment {
  /** The next Session's `001`. An open Gap has none. */
  readonly ended?: Moment;
  readonly network: NetworkId;
  /** Why it began. */
  readonly reason: string;
}

/**
 * Everything a host needs from a Network's past, which outlasts any one Connection.
 * Channel maps are keyed by {@link channelKey}, and the reads that depend on `Tuning`
 * are functions below, because an Entry's meaning cannot depend on today's numbers.
 *
 * Those reads take today's Tuning on purpose, unlike the machine, which replays each
 * Connection with the Tuning its `attempt` recorded, as the fold itself does for how a
 * Connection's Lines decode, which mapping it forces, and which CTCP requests it answers.
 * The machine says what a Connection did, which cannot change. Backoff and rejoining decide
 * what to do next, which is policy, so a tuned value applies to the past as well, and a
 * lowered delay takes effect at once.
 */
export interface Standing {
  /** Channels whose `JOIN` was sent on this Connection and has not worked yet. */
  readonly asked: ReadonlyMap<string, JoinAsked>;
  /** The last `attempt`, which outlives its Connection. */
  readonly attempt: Attempted | undefined;
  /** The Connection under way, if any. */
  readonly connection: LiveConnection | undefined;
  /**
   * The CTCP replies that count against the limits, which outlast every Connection, so a
   * reconnect or a restart resets no limit (PROT-4, HOST-3).
   */
  readonly ctcp: CtcpReplies;
  /** The Network's latest Gap, which is open while it has no `ended`. */
  readonly gap: Gap | undefined;
  /**
   * What the current Session's Ircd has said of Self, its Channels, and `RPL_ISUPPORT`,
   * as `@iirc/state` folds it. Only the welcome the machine took begins a Session, and it
   * starts again from nothing with every `attempt` and every end (LIVE-6).
   */
  readonly irc: IrcState;
  /** Each Channel's last `JOIN` failure, until Self gets in. These outlive Connections. */
  readonly joinFailures: ReadonlyMap<string, HeldJoinFailure>;
  /**
   * Where Self was kicked from each Channel. A `JOIN` by Self clears one here, and the
   * Owner wanting the Channel again outranks it in {@link joinPlan} (LIVE-8).
   */
  readonly kicked: ReadonlyMap<string, Moment>;
  /** Lag checks waiting for a `PONG` on this Connection. */
  readonly lagChecks: readonly LagCheck[];
  /** The round trip of the latest lag check answered on this Connection. */
  readonly lagMillis: number | undefined;
  /** The Network this belongs to, which is whichever one it first heard of. */
  readonly network: NetworkId | undefined;
  /**
   * What has been read and asked of each Channel Self is in on this Session (KNOW-5,
   * KNOW-6), which `readPlan` decides from, keyed as `irc.channels` is. It follows
   * `irc.channels` after every Line, so it holds exactly the Channels that does, and is
   * bounded by it. Nothing here outlives the Session (LIVE-6).
   */
  readonly reads: ReadonlyMap<string, ChannelReads>;
  /** How the latest Connections ended, oldest first. */
  readonly recent: readonly EndedConnection[];
}

/** Each Network's {@link Standing}. */
export type Standings = ReadonlyMap<NetworkId, Standing>;

/** One Network's change from one Entry. */
export interface StandingStep {
  readonly after: Standing;
  readonly before: Standing;
  /** What the Line did to the Session's state, as `@iirc/state` named it. */
  readonly changes: readonly StateChange[];
  readonly entry: Entry;
  /** What a Line Entry says, once parsed, or nothing if it says nothing. */
  readonly line: Line | undefined;
}

/** A Channel to `JOIN`, with its key by Credential name (CRED-4). */
export interface PlannedChannel {
  /** The name of the Credential holding its key, if it has one. */
  readonly key?: string;
  readonly name: string;
}

/** A Channel Configuration wants Self in. */
export interface WantedChannel extends PlannedChannel {
  /** Go back after a kick, once `kickRejoinMillis` has passed (LIVE-8). */
  readonly rejoinOnKick?: boolean;
  /**
   * The sequence of the Change that last wanted it. A kick recorded before it no longer
   * counts, because the Owner asked for the Channel after it (LIVE-8, CONF-5).
   */
  readonly since?: number;
}

/**
 * When to make the next `attempt`, in epoch milliseconds, and where. `delayMillis` is the
 * wait that `at` stands for, which caps any wait, because a clock set back would otherwise
 * put `at` arbitrarily far ahead of now (LOG-8).
 */
export interface NextAttempt {
  readonly at: number;
  readonly delayMillis: number;
  readonly ircd: Ircd;
}

/** What to `JOIN` now, and when the answer could next differ if nothing else happens. */
export interface JoinPlan {
  readonly channels: readonly PlannedChannel[];
  readonly lookAgainAt: number | undefined;
}

type ConnectionEntry = Extract<Entry, { readonly _tag: "Connection" }>;

type AttemptEntry = Extract<ConnectionEntry, { readonly phase: "attempt" }>;

type ClosingEntry = Extract<ConnectionEntry, { readonly phase: "closing" }>;

type DaemonEntry = Extract<Entry, { readonly _tag: "Daemon" }>;

type LineEntry = Extract<Entry, { readonly _tag: "Line" }>;

// A Network chooses what goes in these, so each is bounded and drops its oldest, as
// `@iirc/state` bounds the Channels Self is in. A real Network stops far short of this many
// Channels, and past it, only that Network suffers.
const heldChannels = 1024;

// Enough for any doubling to reach its cap, so a count that stops here delays the same.
const heldConnections = 64;

// One a minute, so an Ircd that never answers holds a quarter of an hour of them.
const heldLagChecks = 16;

const lagCheckCause = "lag-check";

const killed = "the Daemon was killed";

const noChannels = new Map<string, never>();

/** A Network nothing has been recorded for. */
export const noStanding: Standing = {
  asked: noChannels,
  attempt: undefined,
  connection: undefined,
  ctcp: noCtcpReplies,
  gap: undefined,
  irc: initialState,
  joinFailures: noChannels,
  kicked: noChannels,
  lagChecks: [],
  lagMillis: undefined,
  network: undefined,
  reads: noChannels,
  recent: [],
};

/** No Networks at all. */
export const noStandings: Standings = new Map();

// Channel names are compared the way the protocol package says, and hosts that read
// Standing get the same comparison from here.
export { channelKey } from "@iirc/protocol/join";

const withHeld = <Value>(
  held: ReadonlyMap<string, Value>,
  key: string,
  value: Value
): ReadonlyMap<string, Value> => {
  const next = new Map(held);

  // Deleted first, so that a key seen again counts as the newest.
  next.delete(key);
  next.set(key, value);

  if (next.size > heldChannels) {
    const [oldest] = next.keys();

    next.delete(oldest ?? key);
  }

  return next;
};

// What outlives a Session is keyed by `channelKey`, which splits whatever any mapping a
// Session can have splits, as each of them lower-cases `A` to `Z` first. So a key is
// compared by folding it again under the mapping in force when it is read (KNOW-3), and a
// `CASEMAPPING` mid-Session, or a new Session with another, leaves nothing to rekey. Two
// keys that one mapping makes the same Channel are aliases, and the newest stands for both.
// Only a name the mapping can fold further than `ascii` can have an alias.
const keysFor = <Value>(
  held: ReadonlyMap<string, Value>,
  irc: IrcState,
  name: string
): readonly string[] => {
  const key = channelKey(name);
  const casemapping = casemappingOf(irc);

  if (!mayFoldFurther(casemapping, key)) {
    return held.has(key) ? [key] : [];
  }

  const folded = casefold(casemapping, key);

  return [...held.keys()].filter((other) => casefold(casemapping, other) === folded);
};

// What is held for the Channel by that name under the mapping in force, the newest of
// any aliases.
const heldFor = <Value>(held: ReadonlyMap<string, Value>, irc: IrcState, name: string) => {
  const key = keysFor(held, irc, name).at(-1);

  return key === undefined ? undefined : held.get(key);
};

// Everything held, by the name the mapping in force makes of its key. A key that comes
// later replaces an alias before it, so what stands is the newest, as `heldFor` finds it.
// A host that looks up many names builds this once, where `heldFor` scans for each.
const foldedHeld = <Value>(
  held: ReadonlyMap<string, Value>,
  irc: IrcState
): ReadonlyMap<string, Value> => {
  const casemapping = casemappingOf(irc);
  const folded = new Map<string, Value>();

  for (const [key, value] of held) {
    folded.set(casefold(casemapping, key), value);
  }

  return folded;
};

const foldedFor = <Value>(folded: ReadonlyMap<string, Value>, irc: IrcState, name: string) =>
  folded.get(casefold(casemappingOf(irc), name));

const withoutChannel = <Value>(
  held: ReadonlyMap<string, Value>,
  irc: IrcState,
  name: string
): ReadonlyMap<string, Value> => {
  const keys = keysFor(held, irc, name);

  if (keys.length === 0) {
    return held;
  }

  const next = new Map(held);

  for (const key of keys) {
    next.delete(key);
  }

  return next;
};

// Held under the name as it was spelled now, in place of any alias, as the newest.
const withChannel = <Value>(
  held: ReadonlyMap<string, Value>,
  irc: IrcState,
  name: string,
  value: Value
): ReadonlyMap<string, Value> => withHeld(withoutChannel(held, irc, name), channelKey(name), value);

// A Session's state before any Line, under the mapping the Owner forced on its `attempt`,
// if any (KNOW-3). Between Sessions it keeps the last one's, so a kick is compared as the
// Owner said.
const freshState = (attempt: Attempted | undefined): IrcState => {
  const forced: Casemapping | undefined = attempt?.tuning.casemapping;

  return forced === undefined ? initialState : sessionState({ casemapping: forced });
};

// What belongs to one Session and is never carried over (LIVE-6).
const withoutSession = (standing: Standing): Standing => ({
  ...standing,
  asked: noChannels,
  irc: freshState(standing.attempt),
  lagChecks: [],
  lagMillis: undefined,
  reads: noChannels,
});

/**
 * What the current Connection's machine says of it, with nothing under way.
 * @param standing - The Network's Standing.
 * @returns How far it got, how its login stands, and whether joining may go on, or
 * `undefined` with no Connection under way.
 */
export const connectionView = ({ connection }: Standing): ConnectionView | undefined =>
  connection === undefined ? undefined : inspect(connection.machine);

// A Session's welcome outlives the decision to close it, so a Session the Daemon left is
// still measured from its `001`, and only the `closed` Entry ends it.
const welcomedAt = (connection: LiveConnection | undefined) => {
  const registration =
    connection === undefined ? undefined : inspect(connection.machine).registration;

  return registration?._tag === "Welcomed" ? registration.at : undefined;
};

/**
 * When the current Session began, if there is one.
 * @param standing - The Network's Standing.
 * @returns The time of its `001`, or `undefined` with no Session under way.
 */
export const sessionSince = ({ connection }: Standing): number | undefined =>
  welcomedAt(connection);

const ended = (
  standing: Standing,
  { at, sequence }: Moment,
  {
    deliberate,
    endedAt = at,
    reason,
  }: { readonly deliberate: boolean; readonly endedAt?: number; readonly reason: string }
): Standing => {
  const { connection } = standing;

  if (connection === undefined) {
    return standing;
  }

  const { network } = connection;
  const since = sessionSince(standing);

  // Whatever reply was still queued went with the Connection, recorded as Dropped or not.
  return {
    ...withoutSession(standing),
    connection: undefined,
    ctcp: withoutPending(standing.ctcp),
    gap: since === undefined ? standing.gap : { at: endedAt, network, reason, sequence },
    recent: [
      ...standing.recent,
      { at, deliberate, reason, sessionMillis: since === undefined ? undefined : at - since },
    ].slice(-heldConnections),
  };
};

// A Connection nothing closed ended at its last Entry, and whether it failed is judged
// from there. A decision to close was made before the end, so it says why, and whether
// the Daemon chose it.
const endedWithoutClose = (standing: Standing, reason: string): Standing =>
  standing.connection === undefined
    ? standing
    : ended(standing, standing.connection.last, {
        deliberate: standing.connection.closing?.chosen === true,
        reason: standing.connection.closing?.reason ?? reason,
      });

// The machine runs on what the `attempt` recorded, as it did when the host stepped it, and
// so do decoding, the mapping, and CTCP replies. A label this runtime cannot decode with
// gives no fallback, and the bytes are read as UTF-8 or else Latin-1.
const afterAttempt = (standing: Standing, entry: AttemptEntry): Standing => {
  const { at, ircd, loginLines, network, realname, sequence, services, tuning, username } = entry;
  const machine = stepEntry(start({ loginLines, realname, services, tuning, username }), entry);

  const fallback =
    tuning.encoding === undefined ? undefined : parseFallbackEncoding(tuning.encoding);

  const attempt: Attempted = { at, fallback, ircd, sequence, tuning };

  return {
    ...withoutSession({ ...endedWithoutClose(standing, killed), attempt }),
    attempt,
    connection: {
      closing: undefined,
      last: { at, sequence },
      machine: machine.next,
      network,
      sequence,
    },
  };
};

/**
 * The fallback encoding a Connection's Lines are decoded with, from its `attempt` (MSG-4).
 * @param standing - The Network's Standing.
 * @param connection - The sequence of the Connection's `attempt` Entry.
 * @returns The fallback, or `undefined` for none, or for a Connection not the latest.
 */
export const fallbackOf = (standing: Standing, connection: number): FallbackEncoding | undefined =>
  standing.attempt?.sequence === connection ? standing.attempt.fallback : undefined;

// The fallback for an Entry's bytes, if it has any.
const entryFallback = (standing: Standing, entry: Entry) =>
  entry._tag === "Line" || entry._tag === "Dropped"
    ? fallbackOf(standing, entry.connection)
    : undefined;

// Every Entry of a Connection under way moves its machine, as the host's commit stepped it,
// and is where the Connection last was.
const withEntry = (
  connection: LiveConnection,
  entry: Entry,
  fallback: FallbackEncoding | undefined
): LiveConnection => ({
  ...connection,
  last: { at: entry.at, sequence: entry.sequence },
  machine: stepEntry(connection.machine, entry, fallback).next,
});

const withConnection = (standing: Standing, entry: Entry): Standing =>
  standing.connection === undefined
    ? standing
    : {
        ...standing,
        connection: withEntry(standing.connection, entry, entryFallback(standing, entry)),
      };

// The first decision to close says why, and a chosen one stays chosen. Once any is made,
// no welcome can start a Session, which is what the machine hears as LEAVING or CLOSING.
const afterClosing = ({ closing }: LiveConnection, entry: ClosingEntry): Closing => ({
  chosen: closing?.chosen === true || entry.chosen,
  reason: closing?.reason ?? entry.reason,
});

const afterConnection = (standing: Standing, entry: ConnectionEntry): Standing => {
  if (entry.phase === "attempt") {
    return afterAttempt(standing, entry);
  }

  const { connection } = standing;

  // Only the Connection under way can end, or a stray close would count as a failure.
  if (connection?.sequence !== entry.connection) {
    return standing;
  }

  switch (entry.phase) {
    case "opened": {
      return { ...standing, connection: withEntry(connection, entry, undefined) };
    }

    case "closing": {
      const closing = afterClosing(connection, entry);

      return { ...standing, connection: { ...withEntry(connection, entry, undefined), closing } };
    }

    case "closed": {
      const { endedAt, reason } = entry;

      // A close recorded late says when the Connection really ended, which is where the
      // time away began. Its place in order is still its sequence (LOG-8).
      return ended(standing, entry, {
        deliberate: connection.closing?.chosen === true,
        reason: reason ?? connection.closing?.reason ?? "the Connection closed",
        ...(endedAt !== undefined && { endedAt }),
      });
    }

    default: {
      return entry satisfies never;
    }
  }
};

const afterDaemon = (standing: Standing, { phase }: DaemonEntry): Standing => {
  if (phase === "started" || standing.connection === undefined) {
    return endedWithoutClose(standing, killed);
  }

  return ended(standing, standing.connection.last, {
    deliberate: true,
    reason: standing.connection.closing?.reason ?? "the Daemon stopped",
  });
};

const afterAsked = (standing: Standing, { at }: Entry, channels: string | undefined): Standing => {
  let { asked } = standing;

  for (const name of channels?.split(",") ?? []) {
    const count = (heldFor(asked, standing.irc, name)?.count ?? 0) + 1;

    asked = withChannel(asked, standing.irc, name, { at, count });
  }

  return { ...standing, asked };
};

// The key `irc.channels` holds a Channel under, which `reads` shares.
const readsKey = (irc: IrcState, name: string) => casefold(casemappingOf(irc), name);

const heldReads = (standing: Standing, name: string) =>
  standing.reads.get(readsKey(standing.irc, name));

// Only a Channel `IrcState` holds has reads, so this changes nothing for any other.
const withReads = (standing: Standing, name: string, reads: ChannelReads): Standing => {
  const key = readsKey(standing.irc, name);

  if (!standing.reads.has(key)) {
    return standing;
  }

  const next = new Map(standing.reads);

  next.set(key, reads);

  return { ...standing, reads: next };
};

const readCommands: ReadonlyMap<string, ReadKind> = new Map([
  ["MODE", "modes"],
  ["NAMES", "names"],
  ["WHO", "who"],
]);

// Which read an outbound Line asks, if it is one. Only the very shape the Daemon sends
// counts, one Channel and nothing else, whoever sent it: a `WHO #a o` or a `NAMES #a,#b` is
// answered by replies that do not say what a read of `#a` says, so it asks nothing here.
const askedRead = ({ command, params }: Line): ReadKind | undefined => {
  const [channel] = params;

  return params.length === 1 && channel !== undefined && !channel.includes(",")
    ? readCommands.get(command)
    : undefined;
};

const afterReadAsked = (
  standing: Standing,
  { at, sequence }: Entry,
  kind: ReadKind,
  name: string
): Standing => {
  const held = heldReads(standing, name);

  if (held === undefined) {
    return standing;
  }

  const count = (held.asked[kind]?.count ?? 0) + 1;
  const ask: ReadAsked = { answered: false, at, count, failed: false, sequence };

  return withReads(standing, name, { ...held, asked: { ...held.asked, [kind]: ask } });
};

const afterOutbound = (before: Standing, entry: LineEntry, line: Line): Standing => {
  const [first] = line.params;
  const ctcp = afterCtcpSent(before, entry, line);
  const standing = ctcp === before.ctcp ? before : { ...before, ctcp };

  if (line.command === "JOIN") {
    return afterAsked(standing, entry, first);
  }

  const read = askedRead(line);

  if (read !== undefined && first !== undefined) {
    return afterReadAsked(standing, entry, read, first);
  }

  return entry.cause === lagCheckCause && first !== undefined
    ? {
        ...standing,
        lagChecks: [...standing.lagChecks, { at: entry.at, token: first }].slice(-heldLagChecks),
      }
    : standing;
};

// A `PONG` answers with its last parameter, and an Ircd may send only that one. Clocks
// can jump (LOG-8), and a round trip that went backwards is still a very short one.
const afterPong = (standing: Standing, { at }: Entry, line: Line): Standing => {
  const token = line.params.at(-1);
  const check = standing.lagChecks.find((held) => held.token === token);

  return check === undefined
    ? standing
    : {
        ...standing,
        lagChecks: standing.lagChecks.filter((held) => held !== check),
        lagMillis: Math.max(0, at - check.at),
      };
};

// A Session began, which ends the Gap before it (LIVE-10).
const afterWelcome = (standing: Standing, { at, sequence }: Moment): Standing => {
  const { gap } = standing;

  return {
    ...standing,
    gap: gap === undefined || gap.ended !== undefined ? gap : { ...gap, ended: { at, sequence } },
  };
};

// Only a Channel we asked for has a failure worth holding. That leaves a Network nothing
// to flood this with, and `437` also names nicks, which were never asked for.
const afterJoinFailure = (
  standing: Standing,
  { at }: Entry,
  channel: string,
  failure: JoinFailure
): Standing =>
  heldFor(standing.asked, standing.irc, channel) === undefined
    ? standing
    : {
        ...standing,
        joinFailures: withChannel(standing.joinFailures, standing.irc, channel, {
          ...failure,
          at,
          connection: standing.attempt?.sequence,
        }),
      };

// Self is in, so nothing asked, refused, or kicked stands against the Channel any more.
const afterJoined = (standing: Standing, channel: string): Standing => ({
  ...standing,
  asked: withoutChannel(standing.asked, standing.irc, channel),
  joinFailures: withoutChannel(standing.joinFailures, standing.irc, channel),
  kicked: withoutChannel(standing.kicked, standing.irc, channel),
});

const unread: ChannelReads = {
  asked: {},
  prefixRemoved: undefined,
  read: { modes: false, names: false, who: false },
};

// The changes that can change which Channels `IrcState` holds, or under which keys.
const movesChannelKeys: ReadonlySet<StateChange["_tag"]> = new Set([
  "IsupportChanged",
  "Joined",
  "Kicked",
  "Parted",
  "Welcomed",
]);

// `reads` follows `irc.channels`, never the other way: the Channels `IrcState` holds, under
// its keys, and nothing else, so its bound and its choice of which to drop are the only
// ones. A new mapping folds Channels again, and each keeps what was held under the key its
// name had before, so of two that merge, the one `IrcState` kept keeps its own. A Channel
// with nothing held, such as one just joined, starts with nothing read, which at worst
// costs one read more. A `JOIN` echoed for a Channel Self is in keeps what was read of it,
// as `@iirc/state` keeps the Channel.
const realigned = (
  reads: ReadonlyMap<string, ChannelReads>,
  before: IrcState,
  after: IrcState
): ReadonlyMap<string, ChannelReads> => {
  const beforeMapping = casemappingOf(before);
  const isRefolded = beforeMapping !== casemappingOf(after);
  const next = new Map<string, ChannelReads>();

  for (const [key, channel] of after.channels) {
    const held = reads.get(isRefolded ? casefold(beforeMapping, channel.name) : key);

    next.set(key, held ?? unread);
  }

  return next;
};

// A removal after the latest `NAMES` was asked starts a new run of them, which that
// `NAMES` cannot answer, so the debounce runs from it (KNOW-5).
const afterPrefixRemoved = (standing: Standing, moment: Moment, channel: string): Standing => {
  const held = heldReads(standing, channel);

  if (held === undefined) {
    return standing;
  }

  const { prefixRemoved } = held;
  const asked = held.asked.names;

  const isNewRun =
    prefixRemoved === undefined ||
    (asked !== undefined && asked.sequence > prefixRemoved.latest.sequence);

  return withReads(standing, channel, {
    ...held,
    prefixRemoved: { first: isNewRun ? moment : prefixRemoved.first, latest: moment },
  });
};

// The changes whose whole meaning is in the state they came with: Self, the Channels Self
// is in, the Users seen, and what the Ircd supports. Every tag `afterChange` does not
// handle must be here, so a new one fails to compile until someone decides.
type KeptChange = Exclude<
  StateChange["_tag"],
  "Joined" | "JoinRefused" | "Kicked" | "PrefixRemoved"
>;

const kept = (standing: Standing): Standing => standing;

const keptChanges: Readonly<Record<KeptChange, (standing: Standing) => Standing>> = {
  ChannelRead: kept,
  ChannelUncertain: kept,
  Forwarded: kept,
  IsupportChanged: kept,
  MemberJoined: kept,
  MemberKicked: kept,
  MemberParted: kept,
  ModesChanged: kept,
  NamesReplaced: kept,
  NickChanged: kept,
  Parted: kept,
  SelfAwayChanged: kept,
  SelfMaskChanged: kept,
  SelfModesChanged: kept,
  TopicChanged: kept,
  UserQuit: kept,
  UserRenamed: kept,
  UserSeen: kept,
  Welcomed: kept,
};

// What outlives the Session, or needs the Entry's place in the Log.
const afterChange = (standing: Standing, entry: Entry, change: StateChange): Standing => {
  const { at, sequence } = entry;

  if (change._tag === "Joined") {
    return afterJoined(standing, change.channel);
  }

  if (change._tag === "Kicked") {
    return {
      ...standing,
      kicked: withChannel(standing.kicked, standing.irc, change.channel, { at, sequence }),
    };
  }

  if (change._tag === "PrefixRemoved") {
    return afterPrefixRemoved(standing, { at, sequence }, change.channel);
  }

  if (change._tag === "JoinRefused") {
    const { channel, numeric, text } = change;

    return afterJoinFailure(standing, entry, channel, { numeric, text });
  }

  return keptChanges[change._tag](standing);
};

/** One Network's Standing after one Entry, and what it did to the Session's state. */
interface Stepped {
  readonly changes: readonly StateChange[];
  readonly standing: Standing;
}

const noChanges: readonly StateChange[] = [];

// An Entry that changed nothing in the Session's state, whatever it did to Standing.
const saidNothing = (standing: Standing): Stepped => ({ changes: noChanges, standing });

// `@iirc/state` says what a Line did, and this keeps what outlasts the Session.
const afterHeard = (standing: Standing, entry: Entry, line: Line): Stepped => {
  const { changes, next } = stepState(standing.irc, line, entry.at);

  if (next === standing.irc && changes.length === 0) {
    return saidNothing(standing);
  }

  let after = next === standing.irc ? standing : { ...standing, irc: next };

  if (
    next.channels.size !== standing.reads.size ||
    changes.some(({ _tag }) => movesChannelKeys.has(_tag))
  ) {
    after = { ...after, reads: realigned(standing.reads, standing.irc, next) };
  }

  for (const change of changes) {
    after = afterChange(after, entry, change);
  }

  return { changes, standing: after };
};

// The numeric that ends each read's reply, naming the Channel second.
const replies: ReadonlyMap<string, ReadKind> = new Map([
  ["315", "who"],
  ["324", "modes"],
  ["366", "names"],
]);

// Whether what a read reads is certain now that its reply is in. A `324` or a `NAMES` that
// did not fit leaves its Channel uncertain, and asking again waits out the backoff.
const isSettled = (irc: IrcState, kind: ReadKind, name: string) => {
  const channel = channelOf(irc, name);

  switch (kind) {
    case "modes": {
      return channel?.modesUncertain === false;
    }

    case "names": {
      return channel?.membersUncertain === false;
    }

    case "who": {
      return true;
    }

    default: {
      return kind satisfies never;
    }
  }
};

// Whether a reply ends a read of its Channel. A `324` always says the Channel's modes. A
// `315` and a `366` end whatever `WHO` or `NAMES` came before them, which may have been
// filtered, so only one asked in the Daemon's own shape counts, and the `JOIN`'s own
// `NAMES`, which is the first `366` since Self joined.
const endsRead = (kind: ReadKind, held: ChannelReads) => {
  switch (kind) {
    case "modes": {
      return true;
    }

    case "names": {
      return !held.read.names || held.asked.names !== undefined;
    }

    case "who": {
      return held.asked.who !== undefined;
    }

    default: {
      return kind satisfies never;
    }
  }
};

// A reply says the read was answered, whoever asked, and the state it left says whether
// it settled anything. It is read after `@iirc/state` has folded the same Line. A `NAMES`
// clears the prefixes removed only if it was asked after the latest of them.
const afterReply = (standing: Standing, kind: ReadKind, line: Line): Standing => {
  const [, name] = line.params;
  const held = name === undefined ? undefined : heldReads(standing, name);

  if (name === undefined || held === undefined || !endsRead(kind, held)) {
    return standing;
  }

  const { [kind]: asked, ...others } = held.asked;
  const { prefixRemoved } = held;
  const settled = isSettled(standing.irc, kind, name);

  const answered =
    kind === "names" &&
    asked !== undefined &&
    prefixRemoved !== undefined &&
    asked.sequence > prefixRemoved.latest.sequence;

  let stillAsked = held.asked;

  if (settled) {
    stillAsked = others;
  } else if (asked !== undefined) {
    stillAsked = { ...others, [kind]: { ...asked, answered: true } };
  }

  return withReads(standing, name, {
    asked: stillAsked,
    prefixRemoved: answered ? undefined : prefixRemoved,
    read: { ...held.read, [kind]: true },
  });
};

/**
 * The errors that answer a read by naming its Channel: no such Channel (`403`), not on it
 * (`442`), a bad mask (`476`), and a name the Ircd will not take (`479`). An error says the
 * read is over and nothing else, so only the reads in flight for that Channel take it.
 */
export const readErrors: ReadonlySet<string> = new Set(["403", "442", "476", "479"]);

// The Channel an error names: second after the client, or first where the Ircd leaves the
// client out, as RFC 2812 gives `476`.
const erredChannel = ({ params }: Line) => (params.length >= 3 ? params[1] : params[0]);

const afterReadError = (standing: Standing, line: Line): Standing => {
  const name = erredChannel(line);
  const held = name === undefined ? undefined : heldReads(standing, name);

  if (name === undefined || held === undefined) {
    return standing;
  }

  const asked: Partial<Record<ReadKind, ReadAsked>> = { ...held.asked };
  let changed = false;

  for (const kind of readCommands.values()) {
    const ask = asked[kind];

    if (ask !== undefined && !ask.answered) {
      asked[kind] = { ...ask, answered: true, failed: true };
      changed = true;
    }
  }

  return changed ? withReads(standing, name, { ...held, asked }) : standing;
};

// What ends a read, if a Line of this command can.
const afterReadAnswer = (standing: Standing, line: Line): Standing => {
  const kind = replies.get(line.command);

  if (kind !== undefined) {
    return afterReply(standing, kind, line);
  }

  return readErrors.has(line.command) ? afterReadError(standing, line) : standing;
};

// Whether a Session began is the machine's to say, and the Line it began on has already
// moved it, so `before` is the Connection as it was without that Line.
const afterInbound = (
  before: LiveConnection | undefined,
  standing: Standing,
  entry: LineEntry,
  line: Line
): Stepped => {
  const ctcp = line.command === "PRIVMSG" ? afterCtcpRequest(standing, entry, line) : standing.ctcp;
  const replied = ctcp === standing.ctcp ? standing : { ...standing, ctcp };
  const answered = line.command === "PONG" ? afterPong(replied, entry, line) : replied;
  const welcomed = welcomedAt(before) === undefined && sessionSince(answered) !== undefined;

  // Only the welcome the machine took begins a Session, so one it refused names nobody.
  if (line.command === "001" && !welcomed) {
    return saidNothing(answered);
  }

  const heard = afterHeard(welcomed ? afterWelcome(answered, entry) : answered, entry, line);

  return replies.has(line.command) || readErrors.has(line.command)
    ? { changes: heard.changes, standing: afterReadAnswer(heard.standing, line) }
    : heard;
};

const afterLine = (standing: Standing, entry: LineEntry, line: Line | undefined): Stepped => {
  const seen = withConnection(standing, entry);

  if (line === undefined) {
    return saidNothing(seen);
  }

  return entry.direction === "inbound"
    ? afterInbound(standing.connection, seen, entry, line)
    : saidNothing(afterOutbound(seen, entry, line));
};

// An unparseable Line stays an Entry, but it says nothing. Nor does a cut one, because a
// fragment is not a Line to trust, and `toEvent` gives it no command either (HOST-2). Its
// bytes are decoded with its Connection's fallback (MSG-4).
const readLine = (standing: Standing, entry: Entry): Line | undefined => {
  if (entry._tag !== "Line" || entry.cut === true) {
    return undefined;
  }

  const parsed = parseFrame(entry.bytes, fallbackOf(standing, entry.connection));

  return parsed._tag === "Line" ? parsed.line : undefined;
};

const advance = (standing: Standing, entry: Entry, line: Line | undefined): Stepped => {
  if (entry._tag === "Daemon") {
    return saidNothing(afterDaemon(standing, entry));
  }

  // What the Owner wants is not what happened, and whoever reads Changes compares the two.
  if (entry._tag === "Change") {
    return saidNothing(standing);
  }

  if (standing.network !== undefined && standing.network !== entry.network) {
    return saidNothing(standing);
  }

  const own = standing.network === undefined ? { ...standing, network: entry.network } : standing;

  switch (entry._tag) {
    case "Connection": {
      return saidNothing(afterConnection(own, entry));
    }

    case "Line": {
      return afterLine(own, entry, line);
    }

    // What these do to a Connection is its machine's to say (CONN-2, CONN-6).
    case "Deadline": {
      return saidNothing(withConnection(own, entry));
    }

    // A CTCP reply that never left counts no more (PROT-4).
    case "Dropped": {
      const ctcp = afterCtcpDropped(own.ctcp, entry);

      return saidNothing(withConnection(ctcp === own.ctcp ? own : { ...own, ctcp }, entry));
    }

    default: {
      return entry satisfies never;
    }
  }
};

/**
 * Advances one Network's {@link Standing} by one Entry. Reads no clock and no `Tuning` but
 * what an `attempt` recorded, so it depends only on Entries and the code (LOG-10), and it
 * never throws.
 * @param standing - The Standing so far, which stays as it is.
 * @param entry - The next Entry. One for another Network changes nothing.
 * @returns The Standing after that Entry.
 */
export const reduceStanding = (standing: Standing, entry: Entry): Standing =>
  advance(standing, entry, readLine(standing, entry)).standing;

/**
 * Advances every Network's {@link Standing} by a run of Entries, parsing each Line once.
 * @param standings - The Standings so far, which stay as they are.
 * @param entries - The Entries that follow them, in sequence order.
 * @param onStep - Told each change as it happens, for deriving more from the same read.
 * @returns The Standings after those Entries.
 */
export const foldStandings = (
  standings: Standings,
  entries: Iterable<Entry>,
  onStep?: (step: StandingStep) => void
): Standings => {
  const folded = new Map(standings);

  const advanced = (network: NetworkId, before: Standing, entry: Entry, line: Line | undefined) => {
    const { changes, standing: after } = advance(before, entry, line);

    folded.set(network, after);
    onStep?.({ after, before, changes, entry, line });
  };

  for (const entry of entries) {
    if (entry._tag === "Daemon") {
      for (const [network, before] of folded) {
        advanced(network, before, entry, undefined);
      }
    } else if (entry._tag !== "Change") {
      const before = folded.get(entry.network) ?? noStanding;

      advanced(entry.network, before, entry, readLine(before, entry));
    }
  }

  return folded;
};

/**
 * Where the current Connection's login to services stands (CONN-6).
 * @param standing - The Network's Standing.
 * @returns The state, with the service's own words if it gave any.
 */
export const loginOf = (standing: Standing): Login =>
  connectionView(standing)?.login ?? { state: "none" };

const isStable = ({ sessionMillis }: EndedConnection, tuning: Tuning) =>
  sessionMillis !== undefined && sessionMillis >= tuning.stableAfterMillis;

const failuresInRow = (recent: readonly EndedConnection[], tuning: Tuning) => {
  let failures = 0;

  for (const connection of recent.toReversed()) {
    if (isStable(connection, tuning)) {
      return failures;
    }

    failures += connection.deliberate ? 0 : 1;
  }

  return failures;
};

/**
 * How many Connections have failed in a row (LIVE-4). A Session that has lasted
 * `stableAfterMillis` resets the count, whether it has ended or is still under way, and a
 * close the Daemon chose neither adds to it nor resets it. It stops counting at the 64
 * Connections held.
 * @param standing - The Network's Standing.
 * @param tuning - The Network's Tuning.
 * @param now - The time now, in epoch milliseconds, which only a Session under way needs.
 * @returns The number of failures.
 */
export const consecutiveFailures = (standing: Standing, tuning: Tuning, now: number): number => {
  const since = sessionSince(standing);

  return since !== undefined && now - since >= tuning.stableAfterMillis
    ? 0
    : failuresInRow(standing.recent, tuning);
};

// The fractional part of a multiple of this spreads consecutive sequences evenly over
// the interval, which is all that stops two Daemons reconnecting in step.
const goldenRatio = 0.6180339887498949;

const jitter = (seed: number) => (seed * goldenRatio) % 1;

// A stable Session resets the count, not the wait: its unexpected end is still an
// unexpected close, so the count of 0 it leaves starts again from the first delay.
const reconnectDelay = (standing: Standing, tuning: Tuning) => {
  const last = standing.recent.at(-1);

  if (last === undefined || last.deliberate) {
    return 0;
  }

  const delay = Math.min(
    tuning.reconnectInitialMillis * 2 ** Math.max(failuresInRow(standing.recent, tuning) - 1, 0),
    tuning.reconnectMaxMillis
  );

  return Math.ceil(delay / 2 + (jitter(standing.attempt?.sequence ?? 0) * delay) / 2);
};

const isSameIrcd = (one: Ircd, other: Ircd) =>
  one.host === other.host && one.port === other.port && one.tls === other.tls;

// `findIndex` missing is -1, and so is having no `attempt`: both start at the first.
const ircdAfter = (ircds: Arr.NonEmptyReadonlyArray<Ircd>, used: Ircd | undefined) => {
  const index = used === undefined ? -1 : ircds.findIndex((ircd) => isSameIrcd(ircd, used));

  return ircds[(index + 1) % ircds.length] ?? ircds[0];
};

/** What {@link nextAttempt} needs from Configuration. */
export interface AttemptOptions {
  readonly ircds: Arr.NonEmptyReadonlyArray<Ircd>;
  /** The sequence of the Change that last asked for a retry (LIVE-4). */
  readonly retrySince?: number | undefined;
  readonly tuning: Tuning;
}

/**
 * When to make the next `attempt` and where (LIVE-4, LIVE-5). It needs no clock, so a
 * restart computes exactly the same answer from the same Entries and Configuration.
 * @param standing - The Network's Standing.
 * @param options - The Ircds configured now, the Network's Tuning, and the latest retry.
 * @returns When, in epoch milliseconds, and which Ircd. A time already past, which is 0
 * for a Network never attempted, means now.
 */
export const nextAttempt = (
  standing: Standing,
  { ircds, retrySince, tuning }: AttemptOptions
): NextAttempt => {
  const settled = endedWithoutClose(standing, killed);
  const ircd = ircdAfter(ircds, settled.attempt?.ircd);

  // A retry no `attempt` has answered yet outranks backoff.
  if (retrySince !== undefined && (settled.attempt?.sequence ?? 0) < retrySince) {
    return { at: 0, delayMillis: 0, ircd };
  }

  const endedAt = settled.recent.at(-1)?.at;
  const delay = endedAt === undefined ? 0 : reconnectDelay(settled, tuning);

  return { at: endedAt === undefined ? 0 : endedAt + delay, delayMillis: delay, ircd };
};

// Doubles for every `JOIN` already sent. Capped by the longest reconnect delay, because
// `Tuning` has no number of its own for this, and a Channel is no more urgent than that.
const joinRetryDelay = (asks: number, tuning: Tuning) =>
  Math.min(tuning.joinRetryMillis * 2 ** Math.max(asks - 1, 0), tuning.reconnectMaxMillis);

// A refusal that only stands while the Channel's mode or the Network's mood does. Anything
// else, such as a wrong key or a name the Ircd cannot accept, says the same on a retry, so
// it waits for a later Connection (LIVE-7).
const retriedJoinFailures: ReadonlySet<string> = new Set(["437", "471", "473", "474", "477"]);

const isClosedUntilReconnect = (standing: Standing, failure: HeldJoinFailure | undefined) =>
  failure !== undefined &&
  !retriedJoinFailures.has(failure.numeric) &&
  failure.connection === standing.attempt?.sequence;

// A kick stands against a Channel unless the Owner has wanted it since (LIVE-8, CONF-5).
// Every reader of kicks asks this, so they cannot disagree.
const kicksAgainst = (kick: Moment | undefined, { since }: WantedChannel) =>
  kick !== undefined && (since === undefined || kick.sequence > since) ? kick : undefined;

/**
 * The kick that still stands against a wanted Channel, if any, under any spelling the
 * mapping in force allows, which is `rfc1459` with no Session (KNOW-3). The Owner wanting it
 * again after the kick clears it, with or without a Session (LIVE-8, CONF-5).
 * @param standing - The Network's Standing.
 * @param wanted - The Channel, as Configuration wants it.
 * @returns Where the kick was recorded, or `undefined` if none counts.
 */
export const kickStanding = (standing: Standing, wanted: WantedChannel) =>
  kicksAgainst(heldFor(standing.kicked, standing.irc, wanted.name), wanted);

// Several wanted Channels can be one Channel under the mapping in force, such as `#x[1]` and
// `#x{1}` under rfc1459. The Owner's latest wanting of any of them speaks for all, so that
// status and planning read one intent for the one Channel (LIVE-8, KNOW-3).
const latestIntents = (
  casemapping: Casemapping,
  wanted: readonly WantedChannel[]
): ReadonlyMap<string, number | undefined> => {
  const intents = new Map<string, number | undefined>();

  for (const { name, since } of wanted) {
    const folded = casefold(casemapping, name);
    const held = intents.get(folded);

    if (held === undefined || since === undefined) {
      intents.set(folded, held ?? since);
    } else {
      intents.set(folded, Math.max(held, since));
    }
  }

  return intents;
};

const withIntent = (
  want: WantedChannel,
  intents: ReadonlyMap<string, number | undefined>,
  casemapping: Casemapping
): WantedChannel => {
  const { since: _since, ...rest } = want;
  const since = intents.get(casefold(casemapping, want.name));

  return since === undefined ? rest : { ...rest, since };
};

/**
 * Every kick recorded that still counts, one for each spelling recorded, in the order
 * recorded. A kick is dropped if a wanted Channel of the same name under the mapping in
 * force was wanted since it, as {@link kickStanding} says; when several wanted Channels are
 * that one name, the latest wanting of any of them speaks for it, as it does in planning.
 * @param standing - The Network's Standing.
 * @param wanted - The Channels Configuration wants.
 * @returns Each kick still in force, and the Channel as it was recorded.
 */
export const kicksInForce = (
  standing: Standing,
  wanted: readonly WantedChannel[]
): readonly { readonly at: number; readonly channel: string }[] => {
  const casemapping = casemappingOf(standing.irc);
  const intents = latestIntents(casemapping, wanted);

  return [...standing.kicked].flatMap(([channel, kick]) => {
    const folded = casefold(casemapping, channel);

    if (!intents.has(folded)) {
      return [{ at: kick.at, channel }];
    }

    const since = intents.get(folded);

    return since === undefined || kick.sequence > since ? [{ at: kick.at, channel }] : [];
  });
};

// What a plan reads of a Standing, each folded once, so that planning many Channels does not
// scan for every one of them.
interface FoldedStanding {
  readonly asked: ReadonlyMap<string, JoinAsked>;
  readonly joinFailures: ReadonlyMap<string, HeldJoinFailure>;
  readonly kicked: ReadonlyMap<string, Moment>;
}

const foldedStanding = (standing: Standing): FoldedStanding => ({
  asked: foldedHeld(standing.asked, standing.irc),
  joinFailures: foldedHeld(standing.joinFailures, standing.irc),
  kicked: foldedHeld(standing.kicked, standing.irc),
});

// The wait runs from the ask and not from the failure, so that a Network repeating a
// numeric cannot put a retry off for ever.
const dueAt = (
  standing: Standing,
  folded: FoldedStanding,
  want: WantedChannel,
  tuning: Tuning
): number | undefined => {
  const { name, rejoinOnKick } = want;
  const { irc } = standing;
  const kickedAt = kicksAgainst(foldedFor(folded.kicked, irc, name), want)?.at;
  const asked = foldedFor(folded.asked, irc, name);

  const isOut =
    channelOf(irc, name) !== undefined ||
    isClosedUntilReconnect(standing, foldedFor(folded.joinFailures, irc, name)) ||
    (kickedAt !== undefined && rejoinOnKick !== true);

  return isOut
    ? undefined
    : Math.max(
        asked === undefined ? 0 : asked.at + joinRetryDelay(asked.count, tuning),
        kickedAt === undefined ? 0 : kickedAt + tuning.kickRejoinMillis
      );
};

// Whether Self is in the same Channels, whatever moved inside them. Members and topics move
// a Channel far more often than Self joins or leaves one, and only that matters to a plan.
const sameChannelsIn = (one: Channels, other: Channels) => {
  if (one === other) {
    return true;
  }

  if (one.size !== other.size) {
    return false;
  }

  const keys = other.keys();

  for (const key of one.keys()) {
    if (keys.next().value !== key) {
      return false;
    }
  }

  return true;
};

/**
 * Whether anything {@link joinPlan} reads of a Standing moved between two of them, so
 * that a plan made from the first could differ from one made from the second.
 * @param before - The Standing a plan was last made from, or looked at for one.
 * @param after - The Standing now.
 * @returns Whether to plan again.
 */
export const joinPlanMoved = (before: Standing, after: Standing): boolean =>
  !sameChannelsIn(before.irc.channels, after.irc.channels) ||
  casemappingOf(before.irc) !== casemappingOf(after.irc) ||
  before.asked !== after.asked ||
  before.kicked !== after.kicked ||
  before.joinFailures !== after.joinFailures ||
  before.attempt?.sequence !== after.attempt?.sequence ||
  connectionView(before)?.joinable !== connectionView(after)?.joinable;

/**
 * Works out which wanted Channels to `JOIN` (LIVE-7, LIVE-8): those wanted, less those
 * Self is in, less kicks, less anything already asked for whose retry is not due. A `JOIN`
 * only counts as asked once it is recorded, so what this returns may be returned again
 * if it is still queued at `lookAgainAt`, and a Dropped `JOIN` is simply asked for again.
 * @param standing - The Network's Standing.
 * @param wanted - The Channels Configuration wants, each spelled as it should be sent.
 * @param now - The time now, in epoch milliseconds.
 * @param tuning - The Network's Tuning.
 * @returns What to `JOIN` now, and when to look again if nothing else changes. Nothing
 * can be joined without a Session, or once it has begun to close, so those plan nothing.
 */
export const joinPlan = (
  standing: Standing,
  wanted: readonly WantedChannel[],
  now: number,
  tuning: Tuning
): JoinPlan => {
  const channels: PlannedChannel[] = [];
  let lookAgainAt: number | undefined;

  // The machine says when joining may go on: in a Session nobody has begun to close
  // (LIVE-11), once the login sequence and any login wait are over (CONN-6).
  if (connectionView(standing)?.joinable !== true) {
    return { channels, lookAgainAt };
  }

  const folded = foldedStanding(standing);
  const casemapping = casemappingOf(standing.irc);
  const intents = latestIntents(casemapping, wanted);

  for (const want of wanted) {
    const { key, name } = want;
    const due = dueAt(standing, folded, withIntent(want, intents, casemapping), tuning);
    const isDue = due !== undefined && due <= now;

    if (isDue) {
      channels.push(key === undefined ? { name } : { key, name });
    }

    // What goes out now is looked at again as if it were already recorded as asked.
    const asks = (foldedFor(folded.asked, standing.irc, name)?.count ?? 0) + 1;
    const next = isDue ? now + joinRetryDelay(asks, tuning) : due;

    lookAgainAt = next === undefined ? lookAgainAt : Math.min(next, lookAgainAt ?? next);
  }

  return { channels, lookAgainAt };
};
