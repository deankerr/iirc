/**
 * The Feature seam, inside the Client. One Feature per IRCv3 cap or ISUPPORT token, or a
 * tight group of them. A Feature refines what the core derives, in the core's own
 * vocabulary, so the model never sees which Feature produced a fact.
 *
 * This seam is internal: it is not exported from the package, and Features are tested
 * only through `step`.
 *
 * @packageDocumentation
 */
import type { Encoding, Line, OutboundLine, SecretLine } from "@iirc/protocol/line";

import type { NetworkConfiguration } from "./configuration.ts";
import type { CapName, FeatureName, Instant, IntentId, MessageId } from "./ids.ts";
import type { Fact, Knowledge, MemberKnowledge } from "./known.ts";
import type { EndReason, News } from "./news.ts";

/** Facts a Feature keeps up to date. When it turns off, the core marks each one stale. */
export type Kept = "user.away" | "user.account" | "user.mask";

/** A Line to send, or one that carries a Credential. */
export type Sendable =
  | { readonly _tag: "Line"; readonly line: OutboundLine }
  | { readonly _tag: "Secret"; readonly line: SecretLine };

/** What a hook may do besides refining its value. */
export interface Effects<Own> {
  /** The Feature's own state after this hook. Left out, it is unchanged. */
  readonly own?: Own;
  /** Lines to send, after the step's own. */
  readonly send?: readonly Sendable[];
  /** What should happen to registration, which a Feature may hold open before `CAP END`. */
  readonly registration?: Registration;
}

/**
 * A Feature's say over registration. `Hold` keeps it open, `Continue` lets it go, and
 * `Abandon` ends the Connection: the core sends `QUIT`, hangs up, and reports why.
 * While any Feature holds, the core keeps one deadline, and calls `expired` when it passes.
 */
export type Registration =
  | { readonly _tag: "Hold" }
  | { readonly _tag: "Continue" }
  | { readonly _tag: "Abandon"; readonly reason: EndReason };

/** A hook's result: the refined value, and its effects. */
export interface Refined<V, Own> extends Effects<Own> {
  readonly value: V;
}

/** What a hook can read. */
export interface Context<Own> {
  readonly own: Own;
  readonly at: Instant;
  /** The value of a cap in this Feature's `needs`, such as `PLAIN,EXTERNAL` for `sasl`. */
  readonly cap: (name: CapName) => string | undefined;
  /** An ISUPPORT token's value, or `undefined` if the Ircd did not send it. */
  readonly token: (name: string) => string | undefined;
  readonly configuration: NetworkConfiguration;
  /** What the Client knew before this step. */
  readonly known: Knowledge;
}

/** One received Line as it moves through ingress. */
export interface Arrival {
  readonly line: Line;
  /** Starts known by receipt. `server-time` makes it known from the Ircd. */
  readonly time: Fact<Instant>;
  /** Starts unknown. `message-tags` makes it known from `msgid`. */
  readonly id: Fact<MessageId>;
  readonly batch: string | undefined;
  readonly label: string | undefined;
}

/**
 * What the core derived from a Line, before the model folds it in: News, and changes
 * that only the model sees. It grows as the core does.
 */
export type Meant =
  | News
  | {
      /** A `NAMES` listing, in part or whole. */
      readonly _tag: "Listed";
      readonly channel: string;
      readonly members: readonly MemberKnowledge[];
    };

/** One Line on its way out, and what it is for. */
export interface Departure {
  readonly line: OutboundLine;
  readonly for:
    | { readonly _tag: "Said"; readonly intent: IntentId }
    | { readonly _tag: "Protocol" };
}

/**
 * A Feature: the conditions for it to be on, the facts it keeps, and hooks for the
 * stages it refines. Every hook is optional, pure, and total.
 *
 * - **On and off.** A Feature is on while every cap in `needs` is enabled and every token
 *   is in ISUPPORT, unless the Owner declined it. This is worked out again on `CAP ACK`,
 *   `CAP NEW`, `CAP DEL`, ISUPPORT, and at the end of a Session.
 * - **Order.** Ingress runs `tags`, then `batch`, then `label`, then `meaning`. Within a
 *   stage, Features run in the registry's order, which is one array in one file.
 * - **State.** `own` is the Feature's state when it turns on, and again at each Session.
 * - **Failure.** A hook that throws is a bug. The core turns that Feature off for the
 *   rest of the Connection and records it, and a throw replays the same way.
 */
export interface Feature<Own = undefined> {
  readonly name: FeatureName;
  readonly needs: { readonly caps?: readonly CapName[]; readonly tokens?: readonly string[] };
  readonly keeps?: readonly Kept[];
  readonly own: Own;
  /** While on, how bytes become text. */
  readonly encoding?: Encoding;
  /** When it turns on, such as SASL beginning to authenticate. */
  readonly start?: (context: Context<Own>) => Effects<Own>;
  /**
   * When the core's deadline for a held registration passes, such as SASL hearing
   * nothing. The Feature decides whether to `Continue` or `Abandon`. Left out, the
   * core lets registration go.
   */
  readonly expired?: (context: Context<Own>) => Effects<Own>;
  readonly tags?: (arrival: Arrival, context: Context<Own>) => Refined<Arrival, Own>;
  /** Return no Arrivals to hold this one, and several to release those held. */
  readonly batch?: (arrival: Arrival, context: Context<Own>) => Refined<readonly Arrival[], Own>;
  readonly label?: (arrival: Arrival, context: Context<Own>) => Refined<Arrival, Own>;
  readonly meaning?: (
    meant: readonly Meant[],
    arrival: Arrival,
    context: Context<Own>
  ) => Refined<readonly Meant[], Own>;
  readonly egress?: (departure: Departure, context: Context<Own>) => Refined<Departure, Own>;
}
