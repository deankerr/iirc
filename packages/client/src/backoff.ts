/**
 * The one backoff. Every machine that waits to try again asks it for the delay, so a
 * redial, a rejoin after a kick, and a rejoin after a refusal all wait the same way.
 *
 * @packageDocumentation
 */

/** The first wait, in milliseconds. */
const first = 2000;

/** The longest wait, in milliseconds. */
const longest = 300_000;

/**
 * How long to wait before the next try: 2 s, doubling with each try that failed in a
 * row, and never more than 5 minutes. There is no jitter, because jitter needs
 * randomness and the Client takes none. One Daemon serves one Owner, so there is no herd
 * of Clients to spread out.
 * @param attempt - How many tries in a row have failed, from 0.
 * @returns The wait, in milliseconds.
 */
export const backoff = (attempt: number): number =>
  attempt >= 8 ? longest : Math.min(first * 2 ** Math.max(0, attempt), longest);

/** How long a Session must last for the next redial to start again from the first wait. */
export const lasting = 300_000;
