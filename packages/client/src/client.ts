import type { CapName, ConnectionId, FeatureName } from "./ids.ts";
import type { Input } from "./input.ts";
import type { Knowledge } from "./known.ts";
import type { News } from "./news.ts";
import type { Output, TimerTable } from "./output.ts";

/** One step's result. */
export interface Step<State> {
  readonly state: State;
  /** What the Runtime must do, in order. Journaled. */
  readonly outputs: readonly Output[];
  /** What happened, in order. Derived, so never journaled. */
  readonly news: readonly News[];
}

/** Everything else a Client holds, for agents and debugging. Views read {@link Knowledge} instead. */
export interface Inspection {
  /** Each machine's current state, named as in the statechart, such as `caps: "Steady"`. */
  readonly states: Readonly<Record<string, string>>;
  readonly connection: ConnectionId | undefined;
  /** Caps the Ircd offers, with their values, and those enabled. */
  readonly caps: {
    readonly offered: ReadonlyMap<CapName, string>;
    readonly enabled: ReadonlySet<CapName>;
  };
  readonly isupport: ReadonlyMap<string, string>;
  /** Features on now, in registry order. */
  readonly features: readonly FeatureName[];
  readonly timers: TimerTable;
}

/**
 * The pure IRC client for one Network. It does no I/O and reads no clock: every input
 * carries its time, and every effect is an output.
 */
export interface Client<State> {
  /** Before anything has happened. The first input that does anything is `Configured`. */
  readonly initial: State;
  /** Total: never throws, for any input in any state. */
  readonly step: (state: State, input: Input) => Step<State>;
  /** What is known, for Views. */
  readonly known: (state: State) => Knowledge;
  /** Everything else, for agents and debugging. */
  readonly inspect: (state: State) => Inspection;
}
