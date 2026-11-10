/**
 * The composer: what the Owner is writing in each Timeline, what they sent from it, and
 * what became of it. Submitting reads the draft through the command registry into intents,
 * which the runtime carries out; this only decides. What `say` answered, a refusal or a
 * failure, is said in words under the composer it came from. How a Message said fares
 * after that is its Timeline item's delivery.
 *
 * @packageDocumentation
 */
import type { CallerIntent, NetworkId, StepRefusal, TimelineId } from "@iirc/api";

import { interpret, typesCredential } from "./commands.ts";
import type { CommandContext, Focus, Intent } from "./commands.ts";
import { contained } from "./render.ts";
import { opened } from "./timelines.ts";
import type { Timelines } from "./timelines.ts";

/**
 * Where a composer is: under a Timeline, or `Nowhere`, under the main view while no
 * Timeline is open, where commands that need none, such as `/network add`, are typed. A
 * Timeline's id is hex and `-`, so it is never `Nowhere`.
 */
export type Place = TimelineId | "Nowhere";

/** The id a Say is made under, which the runtime names. */
export type IntentId = typeof CallerIntent.Type;

/** How many inputs a Timeline's history keeps, newest first. */
export const historyCap = 100;

/** More non-empty lines than this are sent only once the Owner confirms them. */
export const confirmAbove = 5;

/**
 * What a notice offers the Owner to do next.
 *
 * - `SendAgain`: send these intents, the first under `intent` when it is kept, which is
 *   safe only once the Daemon has said the Say under it was never journaled, after the
 *   Network stopped and its append had settled.
 * - `CheckAgain`: ask `said` again about the Say under `intent`, whose request got no
 *   answer, so it may still be appended. Only `Journaled` settles it; `NotJournaled` stays
 *   unknown, so it is never sent again from here.
 */
export type Offer =
  | {
      readonly _tag: "SendAgain";
      readonly intents: readonly Intent[];
      readonly intent: IntentId | undefined;
    }
  | {
      readonly _tag: "CheckAgain";
      readonly network: NetworkId;
      readonly intent: IntentId;
      readonly intents: readonly Intent[];
    };

/** Something to say under the composer: an error, or what became of a Say. */
export interface Notice {
  readonly message: string;
  /** What the Owner can do next, if anything. */
  readonly offer: Offer | undefined;
}

/** Lines waiting for the Owner to confirm them before they are sent. */
export interface Confirming {
  readonly lines: number;
  readonly intents: readonly Intent[];
}

/** One Timeline's composer. */
export interface Draft {
  readonly text: string;
  /** What was sent from this Timeline, newest first. */
  readonly history: readonly string[];
  /** Which of `history` is shown while recalling, or none while at the draft. */
  readonly recalled: number | undefined;
  /** The draft, kept while recalling, to come back to. */
  readonly kept: string;
  readonly confirming: Confirming | undefined;
  readonly notice: Notice | undefined;
}

/** Every Timeline's composer, and the one under no Timeline. */
export interface Composers {
  readonly drafts: ReadonlyMap<Place, Draft>;
}

/**
 * Why a Say did not go as asked, as the runtime found it out.
 *
 * - `Refused`: `say` answered that the Client refused it in the step that took it.
 * - `Journaled`: the Network stopped, or the Daemon did not answer, and `said` says it was
 *   journaled. Whether it reached the Ircd is unknown, since a restart never carries out a
 *   past step's outputs, and it must not be sent again.
 * - `NotJournaled`: the Network stopped, which settles its append, and `said` says it never
 *   was journaled, so it can be sent again under the same intent.
 * - `Unknown`: the Daemon did not answer, and `said` did not say it was journaled, or did
 *   not answer either. The request may still be appended, so it is unknown, and only asking
 *   `said` again can settle it.
 * - `UnknownNetwork`, `Malformed`, `Unexpected`: the Daemon refused it, or answered with
 *   something the Frontend could not read.
 */
export type SayFailure =
  | { readonly _tag: "Refused"; readonly reason: StepRefusal; readonly target: string }
  | { readonly _tag: "Journaled" }
  | { readonly _tag: "NotJournaled" }
  | { readonly _tag: "Unknown"; readonly network: NetworkId }
  | { readonly _tag: "UnknownNetwork"; readonly network: NetworkId }
  | { readonly _tag: "Malformed" }
  | { readonly _tag: "Unexpected" };

/**
 * What happened to a composer.
 *
 * - `Edited`: the Owner changed the text, which lets go of lines waiting to be confirmed.
 * - `Recalled`: Up or Down through the history.
 * - `Dismissed`: Escape, which lets go of a notice and a confirmation.
 * - `Failed`: a Say failed; `intents` are it and those after it, none carried out after it.
 * - `Noticed`: an intent other than a Say did not go as asked, such as a change of
 *   Configuration, in words. Nothing after it was carried out.
 */
export type ComposerEvent =
  | { readonly _tag: "Edited"; readonly timeline: Place; readonly text: string }
  | {
      readonly _tag: "Recalled";
      readonly timeline: Place;
      readonly direction: "Older" | "Newer";
    }
  | { readonly _tag: "Dismissed"; readonly timeline: Place }
  | {
      readonly _tag: "Failed";
      readonly timeline: Place;
      readonly intent: IntentId;
      readonly failure: SayFailure;
      readonly intents: readonly Intent[];
    }
  | { readonly _tag: "Noticed"; readonly timeline: Place; readonly message: string };

/** A composer's next state, and the intents it asks the runtime to carry out. */
export interface Submitted {
  readonly state: Composers;
  readonly intents: readonly Intent[];
}

/** No composer touched yet. */
export const initialComposers: Composers = { drafts: new Map() };

/** A composer never touched. */
export const emptyDraft: Draft = {
  confirming: undefined,
  history: [],
  kept: "",
  notice: undefined,
  recalled: undefined,
  text: "",
};

/**
 * A Timeline's composer.
 * @param state - The composers.
 * @param timeline - The Timeline.
 * @returns Its composer, or an empty one.
 */
export const draftOf = (state: Composers, timeline: Place): Draft =>
  state.drafts.get(timeline) ?? emptyDraft;

const withDraft = (
  state: Composers,
  timeline: Place,
  change: (draft: Draft) => Draft
): Composers => ({
  ...state,
  drafts: new Map(state.drafts).set(timeline, change(draftOf(state, timeline))),
});

const noticed = (state: Composers, timeline: Place, notice: Notice): Composers =>
  withDraft(state, timeline, (draft) => ({ ...draft, notice }));

/**
 * The context commands are judged in: the open Timeline as its Network lists it, and
 * whether that Network has a Session.
 * @param timelines - The Timelines.
 * @returns The context.
 */
export const contextOf = (timelines: Timelines): CommandContext => {
  const shown = opened(timelines);

  if (shown._tag !== "Shown" || shown.description === undefined) {
    return { focus: undefined, session: false };
  }

  const { description } = shown;
  const network = timelines.networks.get(description.network);

  const focus: Focus = {
    detached: description.detached,
    key: description.key ?? undefined,
    kind: description.kind,
    name: description.name,
    network: description.network,
    timeline: description.id,
  };

  return {
    focus,
    session: network?.connection._tag === "Connected" && network.running?._tag !== "Stopped",
  };
};

/**
 * The lines of input that say something, in order: every line with more than whitespace.
 * @param text - The input.
 * @returns Its lines.
 */
export const linesOf = (text: string): readonly string[] =>
  text.split(/\r\n|\r|\n/u).filter((line) => line.trim() !== "");

/**
 * The composer once its text was sent: cleared, and its text the newest in its history,
 * unless it is already.
 * @param draft - The composer.
 * @returns The composer after.
 */
const sent = (draft: Draft): Draft => ({
  ...emptyDraft,
  history:
    draft.history[0] === draft.text
      ? draft.history
      : [draft.text, ...draft.history].slice(0, historyCap),
});

/**
 * Submits a Timeline's draft: each non-empty line read through the command registry.
 * Nothing is sent if any line cannot be, or if the text holds a NUL, and the composer says
 * why. More than `confirmAbove` lines wait for the Owner to confirm them.
 * @param state - The composers.
 * @param timeline - The Timeline whose draft it is.
 * @param context - The context commands are judged in.
 * @returns The state after, and the intents to carry out.
 */
export const submit = (state: Composers, timeline: Place, context: CommandContext): Submitted => {
  const draft = draftOf(state, timeline);
  const lines = linesOf(draft.text);

  if (lines.length === 0) {
    return { intents: [], state };
  }

  const refuse = (message: string): Submitted => ({
    intents: [],
    state: noticed(state, timeline, { message, offer: undefined }),
  });

  // A Credential's value typed here is let go of at once: the draft, what was kept while
  // recalling, and what waits to be confirmed, and none of it enters the history.
  const credential = lines.find((line) => typesCredential(line));

  if (credential !== undefined) {
    const read = interpret(credential, context);

    return {
      intents: [],
      state: withDraft(state, timeline, (one) => ({
        ...emptyDraft,
        history: one.history,
        notice: { message: read._tag === "Invalid" ? read.message : "", offer: undefined },
      })),
    };
  }

  if (draft.text.includes("\0")) {
    return refuse("It holds a NUL character, which no IRC Line can carry. Nothing was sent.");
  }

  const intents: Intent[] = [];

  for (const [index, line] of lines.entries()) {
    const read = interpret(line, context);

    if (read._tag === "Invalid") {
      return refuse(lines.length === 1 ? read.message : `Line ${index + 1}: ${read.message}`);
    }

    intents.push(...read.value);
  }

  if (lines.length > confirmAbove) {
    return {
      intents: [],
      state: withDraft(state, timeline, (one) => ({
        ...one,
        confirming: { intents, lines: lines.length },
        notice: undefined,
      })),
    };
  }

  return { intents, state: withDraft(state, timeline, sent) };
};

/**
 * Confirms the lines waiting in a Timeline's composer, which are then sent.
 * @param state - The composers.
 * @param timeline - The Timeline.
 * @returns The state after, and the intents to carry out.
 */
export const confirm = (state: Composers, timeline: Place): Submitted => {
  const { confirming } = draftOf(state, timeline);

  return confirming === undefined
    ? { intents: [], state }
    : {
        intents: confirming.intents,
        state: withDraft(state, timeline, sent),
      };
};

/**
 * Takes what a Timeline's notice offers, letting go of the notice.
 * @param state - The composers.
 * @param timeline - The Timeline.
 * @returns The state after, and what was offered, if anything.
 */
export const takeOffer = (
  state: Composers,
  timeline: Place
): { readonly state: Composers; readonly offer: Offer | undefined } => {
  const offered = draftOf(state, timeline).notice?.offer;

  return offered === undefined
    ? { offer: undefined, state }
    : {
        offer: offered,
        state: withDraft(state, timeline, (draft) => ({ ...draft, notice: undefined })),
      };
};

/**
 * A refusal in words.
 * @param reason - Why the Client refused it in the step that took it.
 * @param target - Whom it was for.
 * @returns The words.
 */
export const refusal = (reason: StepRefusal, target: string): string => {
  const to = contained(target);

  switch (reason._tag) {
    case "Offline": {
      return `Not said to ${to}: the Network had no Session when it arrived.`;
    }

    case "Unsendable": {
      return `Not said to ${to}: no IRC Line can carry it there.`;
    }

    default: {
      return reason satisfies never;
    }
  }
};

/**
 * A failed Say in words, and what can be sent again.
 * @param failure - Why it failed.
 * @param intent - Its intent id.
 * @param intents - It and the intents after it.
 * @returns The notice.
 */
export const failed = (
  failure: SayFailure,
  intent: IntentId,
  intents: readonly Intent[]
): Notice => {
  const rest = intents.slice(1);
  const more = rest.some((one) => one._tag === "Say");

  switch (failure._tag) {
    case "Refused": {
      return {
        message: more
          ? `${refusal(failure.reason, failure.target)} Nothing after it was sent.`
          : refusal(failure.reason, failure.target),
        offer: undefined,
      };
    }

    case "Journaled": {
      const journaled =
        "This was journaled, but whether it reached the Ircd is unknown, and it is not sent again on its own. Its item in the Timeline shows its delivery.";

      return {
        message: more ? `${journaled} What came after it was not sent.` : journaled,
        offer: more ? { _tag: "SendAgain", intent: undefined, intents: rest } : undefined,
      };
    }

    case "NotJournaled": {
      return {
        message: "The Network stopped before this was journaled, so it was not said.",
        offer: { _tag: "SendAgain", intent, intents },
      };
    }

    case "Unknown": {
      return {
        message:
          "The Daemon did not answer, so whether this was said is unknown. Nothing after it was sent.",
        offer: { _tag: "CheckAgain", intent, intents, network: failure.network },
      };
    }

    case "UnknownNetwork": {
      return { message: `The Daemon has no Network ${failure.network}.`, offer: undefined };
    }

    case "Malformed": {
      return { message: "The Daemon could not read this as something to say.", offer: undefined };
    }

    case "Unexpected": {
      return {
        message:
          "The Daemon answered in a way the Frontend could not read, so whether this was said is unknown.",
        offer: undefined,
      };
    }

    default: {
      return failure satisfies never;
    }
  }
};

/**
 * A draft after Up or Down through its history.
 * @param draft - The draft.
 * @param direction - Older or newer.
 * @returns The draft after.
 */
const recalledIn = (draft: Draft, direction: "Older" | "Newer"): Draft => {
  const { history, recalled } = draft;

  if (direction === "Older") {
    const next = recalled === undefined ? 0 : recalled + 1;
    const text = history[next];

    return text === undefined
      ? draft
      : {
          ...draft,
          kept: recalled === undefined ? draft.text : draft.kept,
          recalled: next,
          text,
        };
  }

  if (recalled === undefined) {
    return draft;
  }

  const text = recalled === 0 ? undefined : history[recalled - 1];

  return text === undefined
    ? { ...draft, kept: "", recalled: undefined, text: draft.kept }
    : { ...draft, recalled: recalled - 1, text };
};

/**
 * The composers after an event.
 * @param state - The state before.
 * @param event - What happened.
 * @returns The state after.
 */
export const reduceComposers = (state: Composers, event: ComposerEvent): Composers => {
  switch (event._tag) {
    case "Edited": {
      // Lines waiting to be confirmed were read from the text before it changed.
      return withDraft(state, event.timeline, (draft) => ({
        ...draft,
        confirming: undefined,
        recalled: undefined,
        text: event.text,
      }));
    }

    case "Recalled": {
      return withDraft(state, event.timeline, (before) => {
        const after = recalledIn(before, event.direction);

        // Lines waiting to be confirmed were read from the text it showed before.
        return after.text === before.text ? after : { ...after, confirming: undefined };
      });
    }

    case "Dismissed": {
      return withDraft(state, event.timeline, (draft) => ({
        ...draft,
        confirming: undefined,
        notice: undefined,
      }));
    }

    case "Failed": {
      return noticed(state, event.timeline, failed(event.failure, event.intent, event.intents));
    }

    case "Noticed": {
      return noticed(state, event.timeline, { message: event.message, offer: undefined });
    }

    default: {
      return event satisfies never;
    }
  }
};
