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
import type { EndReason, Unrouted } from "./news.ts";

/** Facts a Feature keeps up to date. When it turns off, the core marks each one stale. */
export type Kept =
  | "user.away"
  | "user.account"
  | "user.mask"
  | "user.realname"
  /** Each member's prefixes in each Channel, as a complete listing made them known. */
  | "member.prefixes";

/**
 * What a hook may read of what the Client knew before this step: where the Session is,
 * how names fold, and Self. It is the part of Knowledge a hook needs, read from State in
 * constant time, so a step costs the same however many Channels and members the Network
 * has.
 */
export type KnownBefore = Pick<Knowledge, "session" | "casemapping" | "self">;

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
  /**
   * Caps to give up, among those it needs or uses. The core asks with `CAP REQ :-cap` for
   * each one still enabled, and awaits the answer as for any request.
   */
  readonly drop?: readonly CapName[];
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
  /** The value of a cap this Feature needs or uses, such as `PLAIN,EXTERNAL` for `sasl`. */
  readonly cap: (name: CapName) => string | undefined;
  /** Whether a cap this Feature needs or uses is enabled now. */
  readonly enabled: (name: CapName) => boolean;
  /** An ISUPPORT token's value, or `undefined` if the Ircd did not send it. */
  readonly token: (name: string) => string | undefined;
  readonly configuration: NetworkConfiguration;
  /** What the Client knew of the Session and Self before this step. */
  readonly known: KnownBefore;
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
  /** The intent this Line answers. Starts unknown. `labeled-response` works it out from `label`. */
  readonly answers: IntentId | undefined;
  /**
   * Starts true. A `chathistory` batch makes it false, so the Line is history, not news:
   * it is reported, with `live` false, and never changes what is known now, such as
   * membership, nicks, topics, or modes.
   */
  readonly live: boolean;
}

/**
 * What the core derived from a Line, before the model folds it in: News, and changes
 * that only the model sees. It grows as the core does. A Message or Activity has no
 * `where` yet: the step works that out as it folds it in.
 */
export type Meant =
  | Unrouted
  | {
      /** A `NAMES` listing, in part or whole. */
      readonly _tag: "Listed";
      readonly channel: string;
      readonly members: readonly MemberKnowledge[];
    };

/** A Line `egress` will not let leave, which the core does not send. */
export interface Refusal {
  readonly _tag: "Refusal";
}

/** One Line on its way out, and what it is for. */
export interface Departure {
  readonly line: OutboundLine;
  readonly for:
    | { readonly _tag: "Said"; readonly intent: IntentId }
    | { readonly _tag: "Protocol" };
  /**
   * Whether the Ircd will echo this Line back, tied to its intent. It starts false, and
   * only a Feature that can tie the echo to the intent sets it, as `labeled-response`
   * with `echo-message` does. A `Said` Line's Message reports it as `ours.echo`.
   */
  readonly echo: boolean;
}

/**
 * A Feature: the conditions for it to be on, the facts it keeps, and hooks for the
 * stages it refines. Every hook is optional, pure, and total.
 *
 * - **On and off.** A Feature is on while every cap in `needs` is enabled and every token
 *   is in ISUPPORT, unless the Owner declined it. This is worked out again on `CAP ACK`,
 *   `CAP NEW`, `CAP DEL`, ISUPPORT, and at the end of a Session.
 * - **Order.** Ingress runs `tags`, then `batch`, then `label`, then `react`, then
 *   `meaning`. Within a stage, Features run in the registry's order, which is one array
 *   in one file.
 * - **Refining, then acting.** `tags`, `batch`, `label`, and `meaning` refine: the core
 *   keeps what they return and their own state, and discards any Lines to send, say over
 *   registration, or caps to drop. Only `react` acts on what arrived, and only on a live
 *   Arrival, once history is told apart, so nothing from history sends or decides.
 * - **State.** `own` is the Feature's state when it first turns on in a Connection. It is
 *   kept while the Feature is off, so turned on again in the same Connection it goes on
 *   from where it was, and each Connection starts it again.
 * - **Failure.** A hook that throws is a bug. The core turns that Feature off for the
 *   rest of the Connection and records it, and a throw replays the same way.
 */
export interface Feature<Own = undefined> {
  readonly name: FeatureName;
  readonly needs: { readonly caps?: readonly CapName[]; readonly tokens?: readonly string[] };
  /**
   * Caps it reads but can be on without. They are asked for with `needs`, and only when
   * every one of both is offered, so a Feature never asks for part of what it wants.
   */
  readonly uses?: readonly CapName[];
  readonly keeps?: readonly Kept[];
  readonly own: Own;
  /** While on, how bytes become text. */
  readonly encoding?: Encoding;
  /**
   * When it turns on, such as SASL beginning to authenticate, and again when a cap it
   * `uses` is enabled or disabled while it is on.
   */
  readonly start?: (context: Context<Own>) => Effects<Own>;
  /**
   * When it is off and that matters: as negotiation settles with it off, which includes
   * an Ircd with no cap negotiation at all, and as it turns off. SASL gives up a
   * Connection here when a login is required and none happened.
   */
  readonly absent?: (context: Context<Own>) => Effects<Own>;
  /**
   * When a `Configured` arrives while negotiation is still open before `CAP END`, such
   * as SASL beginning a login the Configuration now names.
   */
  readonly configured?: (context: Context<Own>) => Effects<Own>;
  /**
   * When the core's deadline for a held registration passes, such as SASL hearing
   * nothing, and when a Feature holding registration turns off, or `001` ends it. The
   * Feature decides whether to `Continue` or `Abandon`. Left out, the core lets
   * registration go.
   */
  readonly expired?: (context: Context<Own>) => Effects<Own>;
  /**
   * While it holds registration, a `SecretLine` could not be filled, so nothing was sent,
   * such as SASL's `AuthenticatePlain` with no Credential. The Feature decides what follows.
   */
  readonly unfilled?: (line: SecretLine, context: Context<Own>) => Effects<Own>;
  readonly tags?: (arrival: Arrival, context: Context<Own>) => Refined<Arrival, Own>;
  /** Return no Arrivals to hold this one, and several to release those held. */
  readonly batch?: (arrival: Arrival, context: Context<Own>) => Refined<readonly Arrival[], Own>;
  readonly label?: (arrival: Arrival, context: Context<Own>) => Refined<Arrival, Own>;
  /**
   * Acts on a live Arrival, after `label`: Lines to send and a say over registration, as
   * SASL answers `AUTHENTICATE +`. An Arrival that is history never reaches it.
   */
  readonly react?: (arrival: Arrival, context: Context<Own>) => Effects<Own>;
  readonly meaning?: (
    meant: readonly Meant[],
    arrival: Arrival,
    context: Context<Own>
  ) => Refined<readonly Meant[], Own>;
  /** Refines a Line on its way out, or refuses it, so it is not sent. */
  readonly egress?: (
    departure: Departure,
    context: Context<Own>
  ) => Refined<Departure | Refusal, Own>;
}
