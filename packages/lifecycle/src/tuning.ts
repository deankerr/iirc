/**
 * Every number in LIVE, CONN, and SEND, in one value, so that an Owner can change any
 * of them per Network and tests need not wait minutes. Times are in milliseconds. The
 * machine reads what it needs from its input, and the host reads the rest.
 */
export interface Tuning {
  /** CONN-7: how long after `001` the burst is taken to be over. */
  readonly burstMillis: number;
  /** CONN-1: how long connecting may take. */
  readonly connectTimeoutMillis: number;
  /** SEND-1: how many Lines the control lane holds, past which a reader waits to offer. */
  readonly controlLaneLimit: number;
  /** LIVE-11: how long a close keeps recording what the Ircd already sent. */
  readonly drainMillis: number;
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

/** The spec's defaults. */
export const defaultTuning: Tuning = {
  burstMillis: 10_000,
  connectTimeoutMillis: 15_000,
  controlLaneLimit: 64,
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
