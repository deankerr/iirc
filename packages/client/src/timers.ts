/**
 * The Client's timers, derived from its State. Each state names the instants it waits
 * for, so leaving a state cancels its timers, and a step outputs a `Wake` for each
 * timer that differs from before. Nothing here is stored: `Fired` is matched against the
 * table derived from the State it arrives in.
 *
 * @packageDocumentation
 */
import { Instant, TimerId } from "./ids.ts";
import type { Output, TimerTable } from "./output.ts";
import type { State } from "./state.ts";

/** How long registration may take, from `Opened` to `001`. */
export const registrationTime = 60_000;

/** How long Features may hold registration open before `CAP END`, from when they began. */
export const holdTime = 30_000;

/** Silence before a lag `PING`. */
export const lagAfter = 60_000;

/** Silence before the Connection is given up. */
export const silentAfter = 90_000;

/** What a timer is for, which decides what its `Fired` does. */
export type Purpose =
  | { readonly _tag: "Redial" }
  | { readonly _tag: "Register" }
  | { readonly _tag: "Hold" }
  | { readonly _tag: "Keepalive" }
  | { readonly _tag: "Rejoin"; readonly channel: string };

/** A timer that is set: when it is due, and what it is for. */
export interface Timer {
  readonly due: Instant;
  readonly purpose: Purpose;
}

/**
 * The timers a State waits for, by id.
 * @param state - The State.
 * @returns Each timer, in id order.
 */
export const timersOf = (state: State): ReadonlyMap<TimerId, Timer> => {
  const table = new Map<TimerId, Timer>();
  const { network } = state;

  if (network._tag === "Waiting") {
    table.set(TimerId.make("redial"), { due: network.until, purpose: { _tag: "Redial" } });
  }

  const phase =
    network._tag === "Connection" && network.link.closing === undefined
      ? network.link.phase
      : undefined;

  if (phase?._tag === "Open") {
    const { presence } = phase;

    if (presence._tag === "Registering") {
      table.set(TimerId.make("register"), {
        due: presence.deadline,
        purpose: { _tag: "Register" },
      });

      if (presence.hold !== undefined) {
        table.set(TimerId.make("hold"), { due: presence.hold, purpose: { _tag: "Hold" } });
      }
    } else {
      table.set(TimerId.make("keepalive"), {
        due: presence.keepalive.check,
        purpose: { _tag: "Keepalive" },
      });

      for (const [key, channel] of state.channels) {
        const { phase: standing } = channel;

        const retry =
          standing._tag === "Kicked" || standing._tag === "Refused" ? standing.retry : undefined;

        if (retry !== undefined) {
          table.set(TimerId.make(`rejoin ${key}`), {
            due: retry,
            purpose: { _tag: "Rejoin", channel: key },
          });
        }
      }
    }
  }

  return new Map([...table].toSorted(([left], [right]) => (left < right ? -1 : 1)));
};

/**
 * The timer table, as `Inspection` shows it.
 * @param state - The State.
 * @returns When each timer is due.
 */
export const tableOf = (state: State): TimerTable =>
  new Map([...timersOf(state)].map(([id, timer]) => [id, timer.due]));

/**
 * The `Wake`s that take the table from before a step to after it. A timer that just
 * fired is gone from the table, so it is set again if the State still wants it.
 * @param before - The table before the step.
 * @param after - The table after it.
 * @param fired - The timer this step consumed, if it was a matching `Fired`.
 * @returns A `Wake` for each timer that differs, in id order.
 */
export const wakes = (
  before: TimerTable,
  after: TimerTable,
  fired: TimerId | undefined
): readonly Output[] => {
  const ids = [...new Set([...before.keys(), ...after.keys()])].toSorted();

  return ids.flatMap((id): readonly Output[] => {
    const was = id === fired ? undefined : before.get(id);
    const now = after.get(id);

    if (was === now) {
      return [];
    }

    return [{ _tag: "Wake", at: now === undefined ? null : Instant.make(now), timer: id }];
  });
};
