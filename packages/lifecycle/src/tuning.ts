/**
 * The mappings an Owner can force on a Network, whatever its Ircd says (KNOW-3), as
 * `@iirc/state` names them.
 */
export const casemappings = ["ascii", "rfc1459", "rfc1459-strict", "rfc8265"] as const;

/** One of {@link casemappings}. */
export type TuningCasemapping = (typeof casemappings)[number];

/**
 * Every number in LIVE, CONN, and SEND, the fallback encoding, a forced casemapping, and
 * CTCP replies, in one value, so that an Owner can change any of them per Network and
 * tests need not wait minutes. Times are in milliseconds. The machine reads what it needs
 * from its input, and the host reads the rest. A Connection's `attempt` records it whole.
 */
export interface Tuning {
  /** CONN-7: how long after `001` the burst is taken to be over. */
  readonly burstMillis: number;
  /**
   * KNOW-3: the mapping names are compared under, whatever the Ircd advertises, because
   * Ergo's `permissive` mode looks the same as `ascii` on the wire. Absent, the Ircd's.
   */
  readonly casemapping?: TuningCasemapping;
  /** CONN-1: how long connecting may take. */
  readonly connectTimeoutMillis: number;
  /** PROT-4: how many CTCP replies may go out on the Network within `ctcpNetworkWindowMillis`. */
  readonly ctcpNetworkLimit: number;
  /** PROT-4: the window `ctcpNetworkLimit` counts over. */
  readonly ctcpNetworkWindowMillis: number;
  /** PROT-3: answer CTCP `PING` by echoing its argument. */
  readonly ctcpPing: boolean;
  /** PROT-3: answer CTCP `TIME` with the local time, which reveals a timezone. */
  readonly ctcpTime: boolean;
  /** PROT-4: the least time between two CTCP replies to one User. */
  readonly ctcpUserIntervalMillis: number;
  /** PROT-3: answer CTCP `VERSION` with `iirc`. */
  readonly ctcpVersion: boolean;
  /** SEND-1: how many Lines the control lane holds, past which a reader waits to offer. */
  readonly controlLaneLimit: number;
  /** LIVE-11: how long a close keeps recording what the Ircd already sent. */
  readonly drainMillis: number;
  /**
   * MSG-4: the WHATWG `TextDecoder` label inbound bytes that are not UTF-8 are tried in
   * before Latin-1, such as `windows-1251`. Absent, none.
   */
  readonly encoding?: string;
  /** SEND-2: how many Lines may leave at once. */
  readonly floodBurst: number;
  /** SEND-2: how often a Line may leave once the burst is spent. */
  readonly floodIntervalMillis: number;
  /** LIVE-7: the first wait before retrying a Channel that may let us in later. */
  readonly joinRetryMillis: number;
  /** LIVE-8: how long after a kick a Channel with rejoin-on-kick waits. */
  readonly kickRejoinMillis: number;
  /** LIVE-3: how often a lag check goes out, busy or not. */
  readonly lagCheckMillis: number;
  /** SEND-3: how many Lines the interactive and background lanes each hold. */
  readonly laneLimit: number;
  /**
   * CONN-6: how long joining waits for a sign of login, from when the last Line of the
   * login sequence was written.
   */
  readonly loginWaitMillis: number;
  /** LIVE-9: how long `QUIT` may wait for the queue. */
  readonly quitWaitMillis: number;
  /** LIVE-4: the first delay after a failed Connection. */
  readonly reconnectInitialMillis: number;
  /** LIVE-4: the longest delay after a failed Connection. */
  readonly reconnectMaxMillis: number;
  /** LIVE-7: how long rejoining waits after the burst, for `JOIN`s a Network replays. */
  readonly rejoinSettleMillis: number;
  /** CONN-2: how long registration may take. */
  readonly registrationTimeoutMillis: number;
  /** API-9: how long a send waits on its Line before reporting it still queued. */
  readonly sendWaitMillis: number;
  /** LIVE-2: how long with no inbound Line means the Connection is dead. */
  readonly silenceMillis: number;
  /** LIVE-4: how long a Session must last to reset the delay. */
  readonly stableAfterMillis: number;
  /** CONN-1: how long any single write may take. */
  readonly writeTimeoutMillis: number;
}

/** The keys of {@link Tuning} whose values are numbers. */
export type TuningNumberKey = {
  readonly [Key in keyof Tuning]-?: Tuning[Key] extends number ? Key : never;
}[keyof Tuning];

/** The keys of {@link Tuning} whose values are switches. */
export type TuningSwitchKey = {
  readonly [Key in keyof Tuning]-?: Tuning[Key] extends boolean ? Key : never;
}[keyof Tuning];

/** The spec's numbers, each a default. */
export const defaultTuningNumbers: Readonly<Record<TuningNumberKey, number>> = {
  burstMillis: 10_000,
  connectTimeoutMillis: 15_000,
  controlLaneLimit: 64,
  ctcpNetworkLimit: 5,
  ctcpNetworkWindowMillis: 60_000,
  ctcpUserIntervalMillis: 10_000,
  drainMillis: 5000,
  floodBurst: 5,
  floodIntervalMillis: 2000,
  joinRetryMillis: 60_000,
  kickRejoinMillis: 10_000,
  lagCheckMillis: 60_000,
  laneLimit: 1000,
  loginWaitMillis: 2000,
  quitWaitMillis: 2000,
  reconnectInitialMillis: 5000,
  reconnectMaxMillis: 300_000,
  registrationTimeoutMillis: 60_000,
  rejoinSettleMillis: 1000,
  sendWaitMillis: 10_000,
  silenceMillis: 90_000,
  stableAfterMillis: 300_000,
  writeTimeoutMillis: 10_000,
};

/**
 * The spec's defaults: its numbers, `VERSION` and `PING` answered and `TIME` not (PROT-3),
 * no fallback encoding (MSG-4), and no casemapping forced (KNOW-3).
 */
export const defaultTuning: Tuning = {
  ...defaultTuningNumbers,
  ctcpPing: true,
  ctcpTime: false,
  ctcpVersion: true,
};
