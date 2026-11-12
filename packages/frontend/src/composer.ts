/**
 * The composer: what the Owner is writing in each Timeline, what they sent from it, and
 * what became of it. Submitting reads the draft through the command registry into intents,
 * which the runtime carries out; this only decides. What `say` answered, a refusal or a
 * failure, is said in words under the composer it came from. How a Message said fares
 * after that is its Timeline item's delivery.
 *
 * @packageDocumentation
 */
import type { ActionRequest, CallerIntent, NetworkId, StepRefusal, TimelineId } from "@iirc/api";

import { levelOf, markLatest } from "./activity.ts";
import { channelIn, initialChannels } from "./channel.ts";
import type { Channels } from "./channel.ts";
import { credentialRefusal, interpret } from "./commands.ts";
import type { CommandContext, Focus, Intent } from "./commands.ts";
import { panesOf } from "./layout.ts";
import { attemptedText, contained, requested } from "./render.ts";
import { mainOf, opened, openOf, resolve, sidebar } from "./timelines.ts";
import type { Timelines } from "./timelines.ts";

/**
 * Where a composer is: under a Timeline, under a Direct Message not yet begun, by
 * `placeOfDraft`, or `Nowhere`, under the main view while no Timeline is open, where
 * commands that need none, such as `/network add`, are typed. A Timeline's id is hex and
 * `-`, so it is never `Nowhere` nor a draft's, which begins `draft `.
 */
export type Place = TimelineId | "Nowhere" | `draft ${string}`;

/**
 * The place of the composer under a Direct Message not yet begun: its Network and its nick,
 * neither of which holds a space.
 * @param network - Its Network.
 * @param nick - The nick it is to.
 * @returns The place.
 */
export const placeOfDraft = (network: NetworkId, nick: string): Place => `draft ${network} ${nick}`;

/**
 * Where the composer under the Panes is: under the focused Pane's Direct Message not yet
 * begun while it shows one, else under its open Timeline once that is shown, else nowhere.
 * @param timelines - The Timelines.
 * @returns Its place.
 */
export const placeIn = (timelines: Timelines): Place => {
  const main = mainOf(timelines);

  if (main._tag === "DirectDraft") {
    return placeOfDraft(main.network, main.nick);
  }

  const shown = opened(timelines);

  return shown._tag === "Shown" ? shown.timeline : "Nowhere";
};

/**
 * Whether a place is under a Timeline, rather than under a Direct Message not yet begun or
 * nowhere.
 * @param place - The place.
 * @returns Whether it is a Timeline's id.
 */
export const isTimelinePlace = (place: Place): place is TimelineId =>
  place !== "Nowhere" && !place.startsWith("draft ");

/** The id a Say or an Act is made under, which the runtime names. */
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

/**
 * Something to say under the composer, by what it is about, which is how long it is true.
 *
 * - `AboutText`: what a submit could not read in the text as typed, such as no such command,
 *   wrong arguments, or a refused Credential. It is let go of when the text is edited, and
 *   when the composer turns to another Timeline, so it never comes back for text it no
 *   longer sits under.
 * - `Offering`: what became of a Say or an Act, with something the Owner can do about it. It
 *   stays with its Timeline until the offer is taken or the notice dismissed.
 * - `Outcome`: what became of something that arrived later, such as a change that did not go
 *   as asked, or a Say that failed with nothing to offer. An edit does not hide it, since
 *   the Owner may not have read it yet. It stays until dismissed or the next submit.
 */
export type Notice =
  | { readonly _tag: "AboutText"; readonly message: string }
  | { readonly _tag: "Offering"; readonly message: string; readonly offer: Offer }
  | { readonly _tag: "Outcome"; readonly message: string };

const aboutText = (message: string): Notice => ({ _tag: "AboutText", message });

const outcome = (message: string): Notice => ({ _tag: "Outcome", message });

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
  /**
   * Each draft's place that came to show a Timeline, and that Timeline's: what is said of a
   * Say or an Act sent from the draft, once it answers, is said under the Timeline, where
   * the composer now is.
   */
  readonly carried: ReadonlyMap<Place, Place>;
}

/**
 * Why a Say or an Act did not go as asked, as the runtime found it out.
 *
 * - `Refused`: `say` or `act` answered that the Client refused it in the step that took it:
 *   a Message to `target`, or with `action`, that action.
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
  | {
      readonly _tag: "Refused";
      readonly reason: StepRefusal;
      readonly target: string;
      readonly action: ActionRequest | undefined;
    }
  | { readonly _tag: "Journaled" }
  | { readonly _tag: "NotJournaled" }
  | { readonly _tag: "Unknown"; readonly network: NetworkId }
  | { readonly _tag: "UnknownNetwork"; readonly network: NetworkId }
  | { readonly _tag: "Malformed" }
  | { readonly _tag: "Unexpected" };

/**
 * What happened to a composer.
 *
 * - `Edited`: the Owner changed the text, which lets go of lines waiting to be confirmed,
 *   and of a notice about the text. Text left as it was changes nothing.
 * - `Recalled`: Up or Down through the history, which changes the text as an edit does.
 * - `Left`: the composer turned to another Timeline, which lets go of a notice about the
 *   text it holds, since the text stays and the complaint about it does not come back.
 * - `Dismissed`: Escape, which lets go of a notice and a confirmation.
 * - `Failed`: a Say or an Act failed; `intents` are it and those after it, none carried out after it.
 * - `Noticed`: an intent other than a Say or an Act did not go as asked, such as a change of
 *   Configuration, in words. Nothing after it was carried out.
 * - `Carried`: a draft came to show its Timeline, so what was typed under it, unsent, goes
 *   to the Timeline's composer, unless that holds text of its own, with its notice unless
 *   that holds one, and what is said later of a Say sent from the draft is said there. A
 *   notice about the text stays behind.
 */
export type ComposerEvent =
  | { readonly _tag: "Edited"; readonly timeline: Place; readonly text: string }
  | {
      readonly _tag: "Recalled";
      readonly timeline: Place;
      readonly direction: "Older" | "Newer";
    }
  | { readonly _tag: "Left"; readonly timeline: Place }
  | { readonly _tag: "Dismissed"; readonly timeline: Place }
  | {
      readonly _tag: "Failed";
      readonly timeline: Place;
      readonly intent: IntentId;
      readonly failure: SayFailure;
      readonly intents: readonly Intent[];
    }
  | { readonly _tag: "Noticed"; readonly timeline: Place; readonly message: string }
  | { readonly _tag: "Carried"; readonly from: Place; readonly to: Place };

/** A composer's next state, and the intents it asks the runtime to carry out. */
export interface Submitted {
  readonly state: Composers;
  readonly intents: readonly Intent[];
}

/** No composer touched yet. */
export const initialComposers: Composers = { carried: new Map(), drafts: new Map() };

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

/**
 * Says a notice under a composer, or under the Timeline its draft came to show, where the
 * composer now is.
 * @param state - The composers.
 * @param timeline - Where what it is of was sent from.
 * @param notice - The notice.
 * @returns The composers.
 */
const noticed = (state: Composers, timeline: Place, notice: Notice): Composers =>
  withDraft(state, state.carried.get(timeline) ?? timeline, (draft) => ({ ...draft, notice }));

/**
 * The context commands are judged in: the focused Pane's open Timeline as its Network lists
 * it, whether that Network has a Session, every Timeline in the sidebar's order, those open
 * in any Pane, those with something unread, and the head of the Channel in focus, as read.
 * @param timelines - The Timelines.
 * @param channels - The Channels the Panes show, as read.
 * @returns The context.
 */
export const contextOf = (
  timelines: Timelines,
  channels: Channels = initialChannels
): CommandContext => {
  const shown = opened(timelines);
  const open = openOf(timelines);
  const main = mainOf(timelines);

  const listed = sidebar(timelines).flatMap((one) => one.timelines);

  // A Timeline behind the options, the search, or a draft is not the one shown, so
  // `/next-unread` may go to it, which shows it.
  const around = {
    behind: main._tag !== "Timeline",
    open: open === undefined ? undefined : resolve(timelines, open),
    panes: panesOf(timelines.layout.root).length,
    shown: panesOf(timelines.layout.root).flatMap((pane) =>
      pane.view.open === undefined ? [] : [resolve(timelines, pane.view.open)]
    ),
    timelines: listed.map((timeline) => timeline.id),
    unread: listed.flatMap((timeline) => {
      const level = levelOf(timeline.unread);

      return level === undefined
        ? []
        : [{ level, mark: markLatest(timeline), timeline: timeline.id }];
    }),
  };

  // A Direct Message not yet begun stands in front of any Timeline, and has no focus of its
  // own: what is said there goes to its nick, on its Network.
  if (main._tag === "DirectDraft") {
    const network = timelines.networks.get(main.network);

    return {
      ...around,
      draft: { network: main.network, nick: main.nick },
      focus: undefined,
      head: undefined,
      session: network?.connection._tag === "Connected" && network.running?._tag !== "Stopped",
    };
  }

  if (shown._tag !== "Shown" || shown.description === undefined) {
    return { ...around, draft: undefined, focus: undefined, head: undefined, session: false };
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

  const { header } = channelIn(channels, description.id).head;

  return {
    ...around,
    draft: undefined,
    focus,
    head:
      description.kind === "Channel" && header?.timeline === description.id ? header : undefined,
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
    state: noticed(state, timeline, aboutText(message)),
  });

  // A Credential's value typed here is let go of at once: the draft, what was kept while
  // recalling, and what waits to be confirmed, and none of it enters the history.
  const credential = lines
    .map((line) => credentialRefusal(line))
    .find((message) => message !== undefined);

  if (credential !== undefined) {
    return {
      intents: [],
      state: withDraft(state, timeline, (one) => ({
        ...emptyDraft,
        history: one.history,
        notice: aboutText(credential),
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
  const { notice } = draftOf(state, timeline);

  return notice?._tag === "Offering"
    ? {
        offer: notice.offer,
        state: withDraft(state, timeline, (draft) => ({ ...draft, notice: undefined })),
      }
    : { offer: undefined, state };
};

/**
 * A refusal in words.
 * @param reason - Why the Client refused it in the step that took it.
 * @param target - Whom a Message was for.
 * @param action - The action, when it was one rather than a Message.
 * @returns The words.
 */
export const refusal = (reason: StepRefusal, target: string, action?: ActionRequest): string => {
  const what =
    action === undefined
      ? `Not said to ${contained(target)}`
      : `${attemptedText(requested(action))} was not sent`;

  switch (reason._tag) {
    case "Offline": {
      return `${what}: the Network had no Session when it arrived.`;
    }

    case "Unsendable": {
      return action === undefined
        ? `${what}: no IRC Line can carry it there.`
        : `${what}: the Network cannot carry it whole, as its ISUPPORT says, or it is not one the Client sends.`;
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
  const more = rest.some((one) => one._tag === "Say" || one._tag === "Act");
  const acted = intents[0]?._tag === "Act";

  switch (failure._tag) {
    case "Refused": {
      return outcome(
        more
          ? `${refusal(failure.reason, failure.target, failure.action)} Nothing after it was sent.`
          : refusal(failure.reason, failure.target, failure.action)
      );
    }

    case "Journaled": {
      const journaled = acted
        ? "This was journaled, but whether it reached the Ircd is unknown, and it is not sent again on its own. What the Ircd did shows in the Timeline, and a refusal there too."
        : "This was journaled, but whether it reached the Ircd is unknown, and it is not sent again on its own. Its item in the Timeline shows its delivery.";

      return more
        ? {
            _tag: "Offering",
            message: `${journaled} What came after it was not sent.`,
            offer: { _tag: "SendAgain", intent: undefined, intents: rest },
          }
        : outcome(journaled);
    }

    case "NotJournaled": {
      return {
        _tag: "Offering",
        message: `The Network stopped before this was journaled, so it was not ${acted ? "sent" : "said"}.`,
        offer: { _tag: "SendAgain", intent, intents },
      };
    }

    case "Unknown": {
      return {
        _tag: "Offering",
        message: `The Daemon did not answer, so whether this was ${acted ? "sent" : "said"} is unknown. Nothing after it was sent.`,
        offer: { _tag: "CheckAgain", intent, intents, network: failure.network },
      };
    }

    case "UnknownNetwork": {
      return outcome(`The Daemon has no Network ${failure.network}.`);
    }

    case "Malformed": {
      return outcome(`The Daemon could not read this as something to ${acted ? "do" : "say"}.`);
    }

    case "Unexpected": {
      return outcome(
        `The Daemon answered in a way the Frontend could not read, so whether this was ${acted ? "sent" : "said"} is unknown.`
      );
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
 * A notice, once the text it may be about is edited or not: a notice about the text is let
 * go of, and any other stays.
 * @param notice - The notice.
 * @param edited - Whether the text changed.
 * @returns The notice after.
 */
const unlessAboutText = (notice: Notice | undefined, edited: boolean): Notice | undefined =>
  edited && notice?._tag === "AboutText" ? undefined : notice;

/**
 * The composers after an event.
 * @param state - The state before.
 * @param event - What happened.
 * @returns The state after.
 */
export const reduceComposers = (state: Composers, event: ComposerEvent): Composers => {
  switch (event._tag) {
    // The draft's text goes over unless the Timeline's composer holds text of its own, and
    // its notice unless that holds one, and anything said of it later follows. A notice about
    // the text does not: it was said under a draft that is gone.
    case "Carried": {
      const from = draftOf(state, event.from);
      const to = draftOf(state, event.to);
      const kept = from.notice?._tag === "AboutText" ? undefined : from.notice;
      const moving = from.text.trim() !== "" && to.text.trim() === "";
      const drafts = new Map(state.drafts);

      drafts.delete(event.from);

      return {
        carried: new Map(state.carried).set(event.from, event.to),
        drafts: drafts.set(
          event.to,
          moving
            ? {
                ...to,
                confirming: from.confirming,
                notice: to.notice ?? kept,
                recalled: undefined,
                text: from.text,
              }
            : { ...to, notice: to.notice ?? kept }
        ),
      };
    }

    case "Edited": {
      // Lines waiting to be confirmed were read from the text before it changed, and a
      // complaint about the text is about the text as it was.
      return withDraft(state, event.timeline, (draft) => ({
        ...draft,
        confirming: undefined,
        notice: unlessAboutText(draft.notice, draft.text !== event.text),
        recalled: undefined,
        text: event.text,
      }));
    }

    case "Left": {
      return draftOf(state, event.timeline).notice?._tag === "AboutText"
        ? withDraft(state, event.timeline, (draft) => ({ ...draft, notice: undefined }))
        : state;
    }

    case "Recalled": {
      return withDraft(state, event.timeline, (before) => {
        const after = recalledIn(before, event.direction);

        // Lines waiting to be confirmed were read from the text it showed before, and a
        // complaint about the text is about that.
        return after.text === before.text
          ? after
          : { ...after, confirming: undefined, notice: unlessAboutText(after.notice, true) };
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
      return noticed(state, event.timeline, outcome(event.message));
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * Starts a composer with text, as the palette does for a command that needs arguments. A
 * draft with more than whitespace in it is never replaced: it is kept as it is, and the
 * composer says what was not put in, so the Owner can clear it and choose again.
 * @param state - The composers.
 * @param timeline - The composer's place.
 * @param text - What to start it with, or nothing, only to focus it.
 * @returns The composers after.
 */
export const started = (state: Composers, timeline: Place, text: string | undefined): Composers => {
  if (text === undefined) {
    return state;
  }

  const draft = draftOf(state, timeline);

  if (draft.text.trim() === "") {
    return reduceComposers(state, { _tag: "Edited", text, timeline });
  }

  return noticed(
    state,
    timeline,
    aboutText(
      `${contained(text.trim())} was not put in, since the composer has text. Clear it and choose again.`
    )
  );
};
