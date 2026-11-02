/** How fast Lines may leave: a burst, then one for each interval (SEND-2). */
export interface FloodLimit {
  readonly burst: number;
  readonly intervalMillis: number;
}

/**
 * A token bucket, held as the time it will next be full, so there is no fraction of
 * a token to round. Only {@link fullBucket} and {@link takeToken} make one.
 */
export interface TokenBucket {
  readonly fullAt: number;
}

/** A bucket nothing has been taken from. */
export const fullBucket: TokenBucket = { fullAt: 0 };

// `fullAt` is at most a whole bucket ahead of a clock that only moves forward. Holding
// it there means a clock set back cannot stall every Line for as long as it moved.
const fullAtSeen = ({ fullAt }: TokenBucket, { burst, intervalMillis }: FloodLimit, now: number) =>
  Math.min(fullAt, now + burst * intervalMillis);

/**
 * When the next Line may leave.
 * @param bucket - The bucket so far.
 * @param limit - The limit in force.
 * @param now - The time, in milliseconds.
 * @returns `now` if a Line may leave now, and otherwise the later time when one may.
 */
export const nextSendAt = (bucket: TokenBucket, limit: FloodLimit, now: number): number =>
  Math.max(now, fullAtSeen(bucket, limit, now) - (limit.burst - 1) * limit.intervalMillis);

/**
 * Spends a token for one Line.
 * @param bucket - The bucket so far.
 * @param limit - The limit in force.
 * @param now - The time, in milliseconds.
 * @returns The bucket after that Line, or `undefined` if it may not leave yet.
 */
export const takeToken = (
  bucket: TokenBucket,
  limit: FloodLimit,
  now: number
): TokenBucket | undefined =>
  nextSendAt(bucket, limit, now) > now
    ? undefined
    : { fullAt: Math.max(fullAtSeen(bucket, limit, now), now) + limit.intervalMillis };
