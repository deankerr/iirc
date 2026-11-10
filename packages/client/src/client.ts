import type { CapName, ConnectionId, FeatureName, Instant } from "./ids.ts";
import type { Input } from "./input.ts";
import type { ChannelView, Knowledge } from "./known.ts";
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

/**
 * An Ircd's Strict Transport Security policy for one hostname: connect only over TLS, on
 * `port`, until `until`. It is learnt only over TLS, from `duration`, and `port` is the
 * port of the TLS Connection it arrived on: a `port` key over TLS is ignored, and over
 * plaintext only asks for an upgrade. `duration=0` removes it at once. It survives
 * Connections and restarts because it is derived from journaled Lines, and is never
 * ended by `CAP DEL`.
 */
export interface StsPolicy {
  readonly port: number;
  /** The `duration` last advertised, in seconds. The expiry moves to the end plus this when a Connection closes. */
  readonly duration: number;
  readonly until: Instant;
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
  /** STS policies by hostname, as `Dial` applies them. */
  readonly policies: ReadonlyMap<string, StsPolicy>;
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
  /**
   * What is known of one Channel, found by its name folded with the Connection's
   * casemapping, as Knowledge keys it, or `undefined` when the Client holds no such
   * Channel. It costs what that Channel holds, not what the Network does.
   */
  readonly channel: (state: State, name: string) => ChannelView | undefined;
  /** Everything else, for agents and debugging. */
  readonly inspect: (state: State) => Inspection;
}
