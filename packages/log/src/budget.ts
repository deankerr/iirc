import type { Database } from "bun:sqlite";

import { Data, Effect } from "effect";

import { ReadFailed, ReadTimedOut } from "./errors.ts";

/**
 * The SQL function that stops a statement once its read is out of time. A statement
 * calls it on every row it looks at, as `iirc_in_budget(?)` with the read's deadline.
 */
export const inBudget = "iirc_in_budget";

// Only a throw stops SQLite once a statement is running, and `bun:sqlite` rethrows the
// same value from the call that ran it, so this is how a read knows it ran out.
class OutOfTime extends Data.TaggedError("OutOfTime") {}

/**
 * Throws once `deadline` has passed. It is the body of {@link inBudget}, and a test may
 * wrap it to make every row cost more.
 * @param deadline - When the read must stop, in `performance.now()` milliseconds.
 * @returns 1, so that it can stand in a `WHERE` clause.
 */
export const checkDeadline = (deadline: number): 1 => {
  if (performance.now() > deadline) {
    throw new OutOfTime();
  }

  return 1;
};

/**
 * Lets a connection's statements call {@link inBudget}. Call it once, as it opens.
 * @param database - The connection.
 */
export const allowBudgets = (database: Database) => {
  database.function(inBudget, checkDeadline);
};

/**
 * One read's time, which `bun:sqlite` cannot take back: a running statement cannot be
 * interrupted, even by terminating its Worker (LOG-11). So each statement stops itself
 * through {@link inBudget}, and a read that runs several calls `check` between them.
 */
export interface Budget {
  /** When the read must stop, in `performance.now()` milliseconds, to bind to {@link inBudget}. */
  readonly deadline: number;
  /** Throws once the deadline has passed, and only inside `withinBudget`. */
  readonly check: () => void;
}

/**
 * Runs a read on a budget that starts now. The read is synchronous, as `bun:sqlite` is,
 * so nothing else on its connection can run between its statements.
 * @param budgetMillis - How long the read may take.
 * @param read - The read, which must keep to the budget.
 * @returns What it read, or ReadTimedOut once it is out of time.
 */
export const withinBudget = <A>(
  budgetMillis: number,
  read: (budget: Budget) => A
): Effect.Effect<A, ReadFailed | ReadTimedOut> =>
  Effect.try({
    catch: (cause) =>
      cause instanceof OutOfTime
        ? new ReadTimedOut({ budgetMillis })
        : new ReadFailed({ reason: String(cause) }),
    try: () => {
      const deadline = performance.now() + budgetMillis;

      return read({ check: () => checkDeadline(deadline), deadline });
    },
  });
