import type { Tuning } from "@iirc/lifecycle/tuning";
import { parseFrame } from "@iirc/protocol/line";
import type { Line } from "@iirc/protocol/line";
import { loginSign } from "@iirc/protocol/login";
import { modeTypes, parseModes, withModeTokens } from "@iirc/protocol/mode";
import type { ModeTokens } from "@iirc/protocol/mode";
import { nickCandidates } from "@iirc/protocol/nick";
import { isRefusal } from "@iirc/protocol/refusal";
import { initialState, reduce } from "@iirc/state";
import type { JoinFailure, SessionState } from "@iirc/state";
import type { Array as Arr } from "effect";

import { connectCommandCause, identifyCause } from "./credentials.ts";
import type { Entry, Ircd, NetworkId } from "./entry.ts";
import { redactedText } from "./redact.ts";

/** A place in the Log. */
export interface Moment {
  readonly at: number;
  readonly sequence: number;
}

/** The `attempt` Entry a Network last made, and the Ircd it used. */
export interface Attempted extends Moment {
  readonly ircd: Ircd;
}

/** The Daemon's decision to end a Connection, as its first `closing` Entry said (LOG-2). */
export interface Closing {
  /** The Daemon chose to leave (LIVE-9), so however this ends, it is not a failure. */
  readonly chosen: boolean;
  readonly reason: string;
}

/**
 * How far a Connection got towards a Session, by the machine's own rules, so that the two
 * folds agree on when a Session began. `Abandoned` is a Connection the machine gave up on
 * before its welcome, which no later `001` can turn into a Session.
 */
export type Registration =
  | { readonly _tag: "Connecting" }
  | {
      readonly _tag: "Registering";
      /** Which of the `attempt`'s nicks is being tried (CONN-4). */
      readonly nickIndex: number;
    }
  | {
      readonly _tag: "Welcomed";
      /** When its `001` arrived, which is when its Session began. */
      readonly at: number;
    }
  | { readonly _tag: "Abandoned" };

/**
 * Where a login to services stands (CONN-6). `waiting` starts with an `IDENTIFY` written,
 * and the rest are how the wait ended, with the service's own words where it gave any.
 */
export interface Login {
  readonly state: "none" | "waiting" | "succeeded" | "failed" | "timedOut";
  readonly text?: string;
}

/** How far a Connection's login sequence has got, by the machine's own rules (CONN-6). */
export interface LoginProgress extends Login {
  /** How many Lines its `attempt` said the sequence holds. */
  readonly lines: number;
  /** How many of them have been written or Dropped. */
  readonly seen: number;
  /** The nicks whose `NOTICE` can be a sign, as its `attempt` named them. */
  readonly services: readonly string[];
}

/** A Connection with no end recorded yet. It may not have reached the Ircd. */
export interface LiveConnection {
  /** Set once the Daemon has decided to end it. */
  readonly closing: Closing | undefined;
  /** Its latest Entry, which is where it ended if the process was killed. */
  readonly last: Moment;
  readonly login: LoginProgress;
  readonly network: NetworkId;
  /** The nicks its `attempt` named, in the order they are tried. */
  readonly nicks: readonly string[];
  readonly registration: Registration;
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

/** The Network's own words for why it will not have us (LIVE-5). */
export interface Refusal {
  /** When the Connection it ended closed. */
  readonly at: number;
  readonly reason: string | undefined;
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
 * Connection with the Tuning its `attempt` recorded. The machine says what a Connection
 * did, which cannot change. Backoff and rejoining decide what to do next, which is policy,
 * so a tuned value applies to the past as well, and a lowered delay takes effect at once.
 */
export interface Standing {
  /** Channels whose `JOIN` was sent on this Connection and has not worked yet. */
  readonly asked: ReadonlyMap<string, JoinAsked>;
  /** The last `attempt`, which outlives its Connection. */
  readonly attempt: Attempted | undefined;
  /** Channels Self is in now, with the spelling the Ircd used. */
  readonly channels: ReadonlyMap<string, string>;
  /** The Connection under way, if any. */
  readonly connection: LiveConnection | undefined;
  /** The Network's latest Gap, which is open while it has no `ended`. */
  readonly gap: Gap | undefined;
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
  /** `PREFIX` and `CHANMODES` as this Session last heard them, to read a `MODE` by (KNOW-6). */
  readonly modeTokens: ModeTokens;
  /** The Network this belongs to, which is whichever one it first heard of. */
  readonly network: NetworkId | undefined;
  /** `NICKLEN` from the last Session that gave one (CONN-4). */
  readonly nickLength: number | undefined;
  /** How the latest Connections ended, oldest first. */
  readonly recent: readonly EndedConnection[];
  /** The refusal in force, until a Session is reached. */
  readonly refusal: Refusal | undefined;
  /** Self's nick in the current Session. */
  readonly self: string | undefined;
}

/** Each Network's {@link Standing}. */
export type Standings = ReadonlyMap<NetworkId, Standing>;

/** One Network's change from one Entry. */
export interface StandingStep {
  readonly after: Standing;
  readonly before: Standing;
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

/** A Channel's key, as a `MODE` on it set it or took it away (CRED-4). */
export interface KeyChange {
  /** The Channel, as the `MODE` spelled it. */
  readonly channel: string;
  /** The `MODE` that did it, as recorded. */
  readonly entry: Entry;
  /** The key as recorded, or nothing for a key taken away. */
  readonly key: string | undefined;
  /**
   * Which `<redacted>` of the Line the key is, and how many the Line holds, when the key
   * was scrubbed. The Entry's `redacted` names them in that order (LOG-6).
   */
  readonly placeholder: { readonly of: number; readonly slot: number } | undefined;
}

type ConnectionEntry = Extract<Entry, { readonly _tag: "Connection" }>;

type AttemptEntry = Extract<ConnectionEntry, { readonly phase: "attempt" }>;

type ClosingEntry = Extract<ConnectionEntry, { readonly phase: "closing" }>;

type DaemonEntry = Extract<Entry, { readonly _tag: "Daemon" }>;

type LineEntry = Extract<Entry, { readonly _tag: "Line" }>;

type DeadlineEntry = Extract<Entry, { readonly _tag: "Deadline" }>;

type DroppedEntry = Extract<Entry, { readonly _tag: "Dropped" }>;

// A Network chooses what goes in these, so each is bounded and drops its oldest. A real
// Network stops far short of this many Channels, and past it, only that Network suffers.
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
  channels: noChannels,
  connection: undefined,
  gap: undefined,
  joinFailures: noChannels,
  kicked: noChannels,
  lagChecks: [],
  lagMillis: undefined,
  modeTokens: {},
  network: undefined,
  nickLength: undefined,
  recent: [],
  refusal: undefined,
  self: undefined,
};

/** No Networks at all. */
export const noStandings: Standings = new Map();

/**
 * The form Channel names are compared in. ASCII lower-casing for now, which can only
 * split names and never merge them. Casefolding proper arrives with KNOW-3 in
 * milestone 2.
 * @param name - A Channel name, as spelled anywhere.
 * @returns What every spelling of it shares.
 */
export const channelKey = (name: string): string =>
  name.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());

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

const withoutHeld = <Value>(
  held: ReadonlyMap<string, Value>,
  key: string
): ReadonlyMap<string, Value> => {
  if (!held.has(key)) {
    return held;
  }

  const next = new Map(held);

  next.delete(key);

  return next;
};

// What belongs to one Session and is never carried over (LIVE-6). `NICKLEN` is the only
// `RPL_ISUPPORT` token held, and it stays, because CONN-4 wants the last one given.
const withoutSession = (standing: Standing): Standing => ({
  ...standing,
  asked: noChannels,
  channels: noChannels,
  lagChecks: [],
  lagMillis: undefined,
  modeTokens: {},
  self: undefined,
});

/**
 * When the current Session began, if there is one.
 * @param standing - The Network's Standing.
 * @returns The time of its `001`, or `undefined` with no Session under way.
 */
export const sessionSince = ({ connection }: Standing): number | undefined =>
  connection?.registration._tag === "Welcomed" ? connection.registration.at : undefined;

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

  return {
    ...withoutSession(standing),
    connection: undefined,
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

const afterAttempt = (standing: Standing, entry: AttemptEntry): Standing => {
  const { at, ircd, loginLines, network, nicks, sequence, services } = entry;

  return {
    ...withoutSession(endedWithoutClose(standing, killed)),
    attempt: { at, ircd, sequence },
    connection: {
      closing: undefined,
      last: { at, sequence },
      login: { lines: loginLines, seen: 0, services, state: "none" },
      network,
      nicks,
      registration: { _tag: "Connecting" },
      sequence,
    },
  };
};

const withLast = (
  standing: Standing,
  connection: LiveConnection,
  { at, sequence }: Moment
): Standing => ({
  ...standing,
  connection: { ...connection, last: { at, sequence } },
});

// The machine registers once the transport is up, unless the `attempt` named no nick.
const afterOpened = (connection: LiveConnection): Registration => {
  if (connection.registration._tag !== "Connecting") {
    return connection.registration;
  }

  return connection.nicks.length > 0
    ? { _tag: "Registering", nickIndex: 0 }
    : { _tag: "Abandoned" };
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
      return withLast(standing, { ...connection, registration: afterOpened(connection) }, entry);
    }

    case "closing": {
      return withLast(standing, { ...connection, closing: afterClosing(connection, entry) }, entry);
    }

    case "closed": {
      const { at, endedAt, reason, refused } = entry;

      // A close recorded late says when the Connection really ended, which is where the
      // time away began. Its place in order is still its sequence (LOG-8).
      const closed = ended(standing, entry, {
        deliberate: connection.closing?.chosen === true,
        reason: reason ?? connection.closing?.reason ?? "the Connection closed",
        ...(endedAt !== undefined && { endedAt }),
      });

      return refused === true ? { ...closed, refusal: { at, reason } } : closed;
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
    const key = channelKey(name);

    asked = withHeld(asked, key, { at, count: (asked.get(key)?.count ?? 0) + 1 });
  }

  return { ...standing, asked };
};

const withLogin = (standing: Standing, login: LoginProgress): Standing =>
  standing.connection === undefined
    ? standing
    : { ...standing, connection: { ...standing.connection, login } };

// Each Line of the login sequence counts once it is written or Dropped, and only an
// `IDENTIFY` written starts a wait, as the machine has it (CONN-6).
const afterLoginLine = (
  standing: Standing,
  { cause }: LineEntry | DroppedEntry,
  written: boolean
): Standing => {
  const login = standing.connection?.login;

  if (login === undefined || (cause !== identifyCause && cause !== connectCommandCause)) {
    return standing;
  }

  const identified = written && cause === identifyCause && login.state === "none";

  return withLogin(standing, {
    ...login,
    seen: login.seen + 1,
    ...(identified && { state: "waiting" }),
  });
};

// A sign settles a wait, and one that comes after the wait ran out still says how the
// login went, which is what the Owner wants to see (CONN-6).
const afterLoginSign = (standing: Standing, line: Line): Standing => {
  const login = standing.connection?.login;

  if (login?.state !== "waiting" && login?.state !== "timedOut") {
    return standing;
  }

  const sign = loginSign(line, login.services);

  if (sign === undefined) {
    return standing;
  }

  const { lines, seen, services } = login;
  const state = sign._tag === "LoggedIn" ? "succeeded" : "failed";

  return withLogin(standing, { lines, seen, services, state, text: sign.text });
};

const afterOutbound = (standing: Standing, entry: LineEntry, line: Line): Standing => {
  const [first] = line.params;

  if (line.command === "JOIN") {
    return afterAsked(standing, entry, first);
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

const afterWelcome = (standing: Standing, { at, sequence }: Moment): Standing => {
  const { connection, gap } = standing;

  return connection === undefined
    ? standing
    : {
        ...standing,
        connection: { ...connection, registration: { _tag: "Welcomed", at } },
        gap:
          gap === undefined || gap.ended !== undefined ? gap : { ...gap, ended: { at, sequence } },
        refusal: undefined,
      };
};

// `437` also applies to Channels, so it is a nick's only when it names the one being tried.
const rejectsNick: ReadonlySet<string> = new Set(["432", "433", "436"]);

/** What an inbound Line does to a Connection that is registering, by the machine's rules. */
type RegistrationStep =
  | { readonly _tag: "Abandon" }
  | { readonly _tag: "NextNick"; readonly nickIndex: number }
  | { readonly _tag: "Welcome" }
  | { readonly _tag: "Nothing" };

const nothing: RegistrationStep = { _tag: "Nothing" };

// In the machine's order: a nick refused, a refusal, any other `ERROR`, then a welcome that
// names Self. A welcome after the Daemon decided to close starts no Session (LIVE-11).
const registrationStep = (connection: LiveConnection | undefined, line: Line): RegistrationStep => {
  if (connection?.registration._tag !== "Registering") {
    return nothing;
  }

  const { nickIndex } = connection.registration;
  const { command, params } = line;

  if (
    rejectsNick.has(command) ||
    (command === "437" && params[1] === connection.nicks[nickIndex])
  ) {
    return nickIndex + 1 < connection.nicks.length
      ? { _tag: "NextNick", nickIndex: nickIndex + 1 }
      : { _tag: "Abandon" };
  }

  if (command === "ERROR" || isRefusal(command, params)) {
    return { _tag: "Abandon" };
  }

  return command === "001" && params.length > 0 && connection.closing === undefined
    ? { _tag: "Welcome" }
    : nothing;
};

const withRegistration = (standing: Standing, registration: Registration): Standing =>
  standing.connection === undefined
    ? standing
    : { ...standing, connection: { ...standing.connection, registration } };

// Only a Channel we asked for has a failure worth holding. That leaves a Network nothing
// to flood this with, and `437` also names nicks, which were never asked for.
const afterJoinFailure = (
  standing: Standing,
  { at }: Entry,
  channel: string,
  failure: JoinFailure
): Standing => {
  const key = channelKey(channel);

  return standing.asked.has(key)
    ? {
        ...standing,
        joinFailures: withHeld(standing.joinFailures, key, {
          ...failure,
          at,
          connection: standing.attempt?.sequence,
        }),
      }
    : standing;
};

const afterJoined = (standing: Standing, channel: string): Standing => {
  const key = channelKey(channel);

  return {
    ...standing,
    asked: withoutHeld(standing.asked, key),
    channels: withHeld(standing.channels, key, channel),
    joinFailures: withoutHeld(standing.joinFailures, key),
    kicked: withoutHeld(standing.kicked, key),
  };
};

// A kick from a Channel Self is not in removes nothing, and would otherwise block it until
// the Owner joins again.
const afterKicked = (standing: Standing, { at, sequence }: Entry, channel: string): Standing => {
  const key = channelKey(channel);

  return standing.channels.has(key)
    ? {
        ...standing,
        channels: withoutHeld(standing.channels, key),
        kicked: withHeld(standing.kicked, key, { at, sequence }),
      }
    : standing;
};

const afterParted = (standing: Standing, channel: string | undefined): Standing =>
  channel === undefined
    ? standing
    : { ...standing, channels: withoutHeld(standing.channels, channelKey(channel)) };

// One Line does at most one of these, because each comes from a different command.
const afterSelf = (
  standing: Standing,
  entry: LineEntry,
  line: Line,
  session: SessionState
): Standing => {
  const current = {
    ...standing,
    nickLength: session.nickLength ?? standing.nickLength,
    self: session.self,
  };

  const [failure] = session.joinFailures;
  const [joined] = session.channels;
  const [kickedFrom] = session.kicked;

  if (failure !== undefined) {
    return afterJoinFailure(current, entry, ...failure);
  }

  if (kickedFrom !== undefined) {
    return afterKicked(current, entry, kickedFrom);
  }

  if (joined !== undefined) {
    return afterJoined(current, joined);
  }

  return line.command === "PART" ? afterParted(current, line.params[0]) : current;
};

// `reduce` decides what a Line did to Self. It starts from a blank Session every time and
// the results land in maps here, because what it holds has no times, no folded names, and
// no bound, and because a flood costs one small object instead of a copy of everything.
const afterSaid = (standing: Standing, entry: LineEntry, line: Line): Standing => {
  const blank: SessionState = { ...initialState, self: standing.self };
  const session = reduce(blank, line);

  return session === blank ? standing : afterSelf(standing, entry, line, session);
};

// A `KICK` may name several Channels and Users, which pair up in order, or one Channel and
// several Users. Each pair is a kick of its own.
const kicksOf = (line: Line): readonly Line[] => {
  const [channels = "", users = "", ...rest] = line.params;
  const named = channels.split(",");

  return users
    .split(",")
    .map((user, index) => ({
      ...line,
      params: [named.length === 1 ? channels : (named[index] ?? ""), user, ...rest],
    }))
    .filter(({ params: [channel] }) => channel !== "");
};

// A Session's `PREFIX` and `CHANMODES`, which only an `RPL_ISUPPORT` changes (KNOW-2).
const afterTokens = (standing: Standing, line: Line): Standing =>
  line.command === "005" && standing.connection?.registration._tag === "Welcomed"
    ? { ...standing, modeTokens: withModeTokens(standing.modeTokens, line.params.slice(1)) }
    : standing;

const afterInbound = (standing: Standing, entry: LineEntry, line: Line): Standing => {
  const answered = afterTokens(
    afterLoginSign(line.command === "PONG" ? afterPong(standing, entry, line) : standing, line),
    line
  );

  const step = registrationStep(answered.connection, line);

  switch (step._tag) {
    case "Abandon": {
      return withRegistration(answered, { _tag: "Abandoned" });
    }

    case "NextNick": {
      return withRegistration(answered, { _tag: "Registering", nickIndex: step.nickIndex });
    }

    case "Welcome": {
      return afterSaid(afterWelcome(answered, entry), entry, line);
    }

    case "Nothing": {
      break;
    }

    default: {
      return step satisfies never;
    }
  }

  // Only a welcome names Self, so a `001` that starts no Session says nothing.
  if (line.command === "001") {
    return answered;
  }

  if (line.command !== "KICK") {
    return afterSaid(answered, entry, line);
  }

  let kicked = answered;

  for (const kick of kicksOf(line)) {
    kicked = afterSaid(kicked, entry, kick);
  }

  return kicked;
};

// A registration Deadline Entry is written only once the deadline has passed, and then the
// machine gives up on registering.
const afterDeadline = (standing: Standing, entry: DeadlineEntry): Standing => {
  const { connection } = standing;

  if (connection === undefined) {
    return standing;
  }

  const timedOut = entry.name === "registration" && connection.registration._tag === "Registering";
  const loginOver = entry.name === "login" && connection.login.state === "waiting";

  const next: LiveConnection = {
    ...connection,
    ...(timedOut && { registration: { _tag: "Abandoned" } }),
    ...(loginOver && { login: { ...connection.login, state: "timedOut" } }),
  };

  return withLast(standing, next, entry);
};

const afterLine = (standing: Standing, entry: LineEntry, line: Line | undefined): Standing => {
  const { connection } = standing;
  const seen = connection === undefined ? standing : withLast(standing, connection, entry);

  if (line === undefined) {
    return seen;
  }

  return entry.direction === "inbound"
    ? afterInbound(seen, entry, line)
    : afterOutbound(afterLoginLine(seen, entry, true), entry, line);
};

// An unparseable Line stays an Entry, but it says nothing. Nor does a cut one, because a
// fragment is not a Line to trust, and `toEvent` gives it no command either (HOST-2).
const readLine = (entry: Entry): Line | undefined => {
  if (entry._tag !== "Line" || entry.cut === true) {
    return undefined;
  }

  const parsed = parseFrame(entry.bytes);

  return parsed._tag === "Line" ? parsed.line : undefined;
};

const advance = (standing: Standing, entry: Entry, line: Line | undefined): Standing => {
  if (entry._tag === "Daemon") {
    return afterDaemon(standing, entry);
  }

  // What the Owner wants is not what happened, and whoever reads Changes compares the two.
  if (entry._tag === "Change") {
    return standing;
  }

  if (standing.network !== undefined && standing.network !== entry.network) {
    return standing;
  }

  const own = standing.network === undefined ? { ...standing, network: entry.network } : standing;

  switch (entry._tag) {
    case "Connection": {
      return afterConnection(own, entry);
    }

    case "Line": {
      return afterLine(own, entry, line);
    }

    case "Deadline": {
      return afterDeadline(own, entry);
    }

    case "Dropped": {
      return own.connection === undefined
        ? own
        : afterLoginLine(withLast(own, own.connection, entry), entry, false);
    }

    default: {
      return entry satisfies never;
    }
  }
};

/**
 * Advances one Network's {@link Standing} by one Entry. Reads no clock and no `Tuning`,
 * so it depends only on Entries and the code (LOG-10), and it never throws.
 * @param standing - The Standing so far, which stays as it is.
 * @param entry - The next Entry. One for another Network changes nothing.
 * @returns The Standing after that Entry.
 */
export const reduceStanding = (standing: Standing, entry: Entry): Standing =>
  advance(standing, entry, readLine(entry));

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
    const after = advance(before, entry, line);

    folded.set(network, after);
    onStep?.({ after, before, entry, line });
  };

  for (const entry of entries) {
    if (entry._tag === "Daemon") {
      for (const [network, before] of folded) {
        advanced(network, before, entry, undefined);
      }
    } else if (entry._tag !== "Change") {
      advanced(entry.network, folded.get(entry.network) ?? noStanding, entry, readLine(entry));
    }
  }

  return folded;
};

/**
 * Where the current Connection's login to services stands (CONN-6).
 * @param standing - The Network's Standing.
 * @returns The state, with the service's own words if it gave any.
 */
export const loginOf = ({ connection }: Standing): Login => {
  if (connection === undefined) {
    return { state: "none" };
  }

  const { state, text } = connection.login;

  return text === undefined ? { state } : { state, text };
};

/**
 * Whether joining may go on: every Line of the login sequence is out, and no login wait
 * is still running (CONN-6). Nothing waits with no Connection under way.
 * @param standing - The Network's Standing.
 * @returns Whether the login is settled.
 */
export const isLoginSettled = ({ connection }: Standing): boolean =>
  connection === undefined ||
  (connection.login.seen >= connection.login.lines && connection.login.state !== "waiting");

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

  // A retry no `attempt` has answered yet outranks backoff and a refusal alike.
  if (retrySince !== undefined && (settled.attempt?.sequence ?? 0) < retrySince) {
    return { at: 0, delayMillis: 0, ircd };
  }

  const endedAt = settled.recent.at(-1)?.at;
  const { refusal } = settled;
  const delay = endedAt === undefined ? 0 : reconnectDelay(settled, tuning);
  const afterFailure = endedAt === undefined ? 0 : endedAt + delay;
  const afterRefusal = refusal === undefined ? 0 : refusal.at + tuning.refusalBackoffMillis;

  return {
    at: Math.max(afterFailure, afterRefusal),
    delayMillis: afterRefusal > afterFailure ? tuning.refusalBackoffMillis : delay,
    ircd,
  };
};

/**
 * The nicks an `attempt` will try (CONN-4), limited by `NICKLEN` from the last Session
 * that gave one, or by `firstContactNickLimit` if none has.
 * @param standing - The Network's Standing.
 * @param identity - The configured nick and alternates.
 * @param tuning - The Network's Tuning.
 * @returns The candidates, in the order to try them.
 */
export const candidateNicks = (
  standing: Standing,
  { alternates, nick }: { readonly alternates: readonly string[]; readonly nick: string },
  tuning: Tuning
): readonly string[] =>
  nickCandidates({
    alternates,
    limit: standing.nickLength ?? tuning.firstContactNickLimit,
    nick,
  });

// Doubles for every `JOIN` already sent. Capped by the longest reconnect delay, because
// `Tuning` has no number of its own for this, and a Channel is no more urgent than that.
const joinRetryDelay = (asks: number, tuning: Tuning) =>
  Math.min(tuning.joinRetryMillis * 2 ** Math.max(asks - 1, 0), tuning.reconnectMaxMillis);

// A refusal that only stands while the Channel's mode or the Network's mood does. Anything
// else, such as a wrong key or a name the Ircd cannot accept, says the same on a retry, so
// it waits for a later Connection (LIVE-7).
const retriedJoinFailures: ReadonlySet<string> = new Set(["437", "471", "473", "474", "477"]);

const isClosedUntilReconnect = (standing: Standing, key: string) => {
  const failure = standing.joinFailures.get(key);

  return (
    failure !== undefined &&
    !retriedJoinFailures.has(failure.numeric) &&
    failure.connection === standing.attempt?.sequence
  );
};

/**
 * The kick that still stands against a wanted Channel, if any. The Owner wanting it again
 * after the kick clears it, with or without a Session (LIVE-8, CONF-5).
 * @param standing - The Network's Standing.
 * @param wanted - The Channel, as Configuration wants it.
 * @returns Where the kick was recorded, or `undefined` if none counts.
 */
export const kickStanding = (standing: Standing, { name, since }: WantedChannel) => {
  const kick = standing.kicked.get(channelKey(name));

  return kick !== undefined && (since === undefined || kick.sequence > since) ? kick : undefined;
};

// The wait runs from the ask and not from the failure, so that a Network repeating a
// numeric cannot put a retry off for ever.
const dueAt = (standing: Standing, want: WantedChannel, tuning: Tuning): number | undefined => {
  const { name, rejoinOnKick } = want;
  const key = channelKey(name);
  const kickedAt = kickStanding(standing, want)?.at;
  const asked = standing.asked.get(key);

  const isOut =
    standing.channels.has(key) ||
    isClosedUntilReconnect(standing, key) ||
    (kickedAt !== undefined && rejoinOnKick !== true);

  return isOut
    ? undefined
    : Math.max(
        asked === undefined ? 0 : asked.at + joinRetryDelay(asked.count, tuning),
        kickedAt === undefined ? 0 : kickedAt + tuning.kickRejoinMillis
      );
};

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

  // Sends are refused once a close has begun (LIVE-11). Joining waits for the login
  // sequence and any login wait, which say when they are over (CONN-6).
  if (
    sessionSince(standing) === undefined ||
    standing.connection?.closing !== undefined ||
    !isLoginSettled(standing)
  ) {
    return { channels, lookAgainAt };
  }

  for (const want of wanted) {
    const { key, name } = want;
    const due = dueAt(standing, want, tuning);
    const isDue = due !== undefined && due <= now;

    if (isDue) {
      channels.push(key === undefined ? { name } : { key, name });
    }

    // What goes out now is looked at again as if it were already recorded as asked.
    const asks = (standing.asked.get(channelKey(name))?.count ?? 0) + 1;
    const next = isDue ? now + joinRetryDelay(asks, tuning) : due;

    lookAgainAt = next === undefined ? lookAgainAt : Math.min(next, lookAgainAt ?? next);
  }

  return { channels, lookAgainAt };
};

const placeholdersIn = (text: string) => text.split(redactedText).length - 1;

// The last `k` a `MODE` touches is the key it leaves. A key shown as `*` is hidden, and says
// nothing of what the key is (CRED-4, KNOW-6). It also says which placeholder of the Line
// the key is when it was scrubbed, counted from the end: what stands in the parameters after
// it is read as it is, and the whole Line's count is the rest.
const keyLeft = (
  standing: Standing,
  line: Line,
  entry: Entry
): Pick<KeyChange, "key" | "placeholder"> | undefined => {
  const parsed = parseModes(line.params.slice(1), modeTypes(standing.modeTokens));
  const at = parsed.changes.findLastIndex(({ letter }) => letter === "k");
  const last = parsed.changes[at];

  if (parsed._tag === "Uneven" || last === undefined) {
    return undefined;
  }

  if (!last.adding) {
    return { key: undefined, placeholder: undefined };
  }

  if (last.param === undefined || last.param === "*") {
    return undefined;
  }

  if (last.param !== redactedText || entry._tag !== "Line") {
    return { key: last.param, placeholder: undefined };
  }

  // Each change that took a parameter took the next one after the letters, so the key's
  // is as far along as the changes before it that took one.
  const index = 2 + parsed.changes.slice(0, at).filter(({ param }) => param !== undefined).length;

  const of = placeholdersIn(new TextDecoder("latin1").decode(entry.bytes));
  const after = placeholdersIn(line.params.slice(index + 1).join(" "));

  return { key: last.param, placeholder: { of, slot: of - 1 - after } };
};

/**
 * The Channel keys that inbound `MODE` Lines set or took away, each read with `PREFIX`
 * and `CHANMODES` as they stood at its Entry, and only on a Channel Self was in then
 * (CRED-4). A `MODE` whose parameters do not add up says nothing.
 * @param standing - The Network's Standing before the first of `entries`.
 * @param entries - Entries recorded after it, in sequence order.
 * @returns Each change, in order.
 */
export const channelKeyChanges = (
  standing: Standing,
  entries: Iterable<Entry>
): readonly KeyChange[] => {
  const changes: KeyChange[] = [];
  let current = standing;

  for (const entry of entries) {
    const line = readLine(entry);
    const [channel] = line?.params ?? [];

    const isMode =
      line?.command === "MODE" &&
      entry._tag === "Line" &&
      entry.direction === "inbound" &&
      channel !== undefined &&
      current.channels.has(channelKey(channel));

    const left = isMode ? keyLeft(current, line, entry) : undefined;

    if (left !== undefined && channel !== undefined) {
      changes.push({ channel, entry, ...left });
    }

    current = advance(current, entry, line);
  }

  return changes;
};
