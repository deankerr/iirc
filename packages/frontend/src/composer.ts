/**
 * The composer: what the Owner is writing in each Timeline, what they sent from it, and
 * what became of it. Submitting reads the draft through the command registry into intents,
 * which the runtime carries out; this only decides. What `say` answered, a refusal or a
 * failure, is said in words under the composer it came from. How a Message said fares
 * after that is its Timeline item's delivery.
 *
 * @packageDocumentation
 */
import type {
  ActionRequest,
  Answered,
  CallerIntent,
  NetworkId,
  SayRequest,
  StepRefusal,
  Timeline,
  TimelineId,
  TimelineItem,
} from "@iirc/api";
import type { Aliases } from "@iirc/api/ui";
import { Option, Schema } from "effect";

import { levelOf, markLatest } from "./activity.ts";
import { arranged, shownOrder, unarranged } from "./arrangement.ts";
import type { Arrangement } from "./arrangement.ts";
import { channelIn, initialChannels } from "./channel.ts";
import type { Channels } from "./channel.ts";
import { commandRunBy, credentialRefusal, interpret, namedIn } from "./commands.ts";
import type { CommandContext, Focus, Intent, Unseen } from "./commands.ts";
import { commandKey } from "./entries.ts";
import { merged, formattedIn, pendingAfter, plainOf } from "./formatting.ts";
import type { Format, Hint, Pending } from "./formatting.ts";
import { panesOf } from "./layout.ts";
import { attemptedText, contained, requested } from "./render.ts";
import { isRemoved, mainOf, opened, openOf, resolve, sidebar } from "./timelines.ts";
import type { NetworkView, Timelines } from "./timelines.ts";

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
 *   stays with its Timeline, through later submits, until the offer is taken, the notice
 *   dismissed, or a newer notice takes its place, since a composer says one thing at a time.
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

/**
 * The Message a draft answers: its id, as a Line can carry it in a `+reply` tag, and the
 * Message as it was when chosen, which a view shows above the draft.
 */
export interface Answering {
  readonly id: AnswersId;
  readonly message: Answered;
}

/**
 * A draft set aside while a command is written over it: its text, with its formatting codes,
 * and the Message it answered. Nothing else of it is kept, since the rest is derived again
 * from the text.
 */
export interface Aside {
  readonly text: string;
  readonly answering: Answering | undefined;
}

/** One Timeline's composer. */
export interface Draft {
  /**
   * What is sent, kept, and recalled, with IRC's formatting codes in it. What the Owner sees
   * and edits is its plain text, `plainOf` it.
   */
  readonly text: string;
  /** A style chosen at a caret with nothing selected, for what is typed there next. */
  readonly typing: Pending | undefined;
  /** The Message its first Say answers, until it is sent or dropped. */
  readonly answering: Answering | undefined;
  /** What was sent from this Timeline, newest first. */
  readonly history: readonly string[];
  /** Which of `history` is shown while recalling, or none while at the draft. */
  readonly recalled: number | undefined;
  /** The draft, kept while recalling, to come back to. */
  readonly kept: string;
  readonly confirming: Confirming | undefined;
  readonly notice: Notice | undefined;
  /**
   * The draft set aside by a command started over it, blank or not, which comes back when
   * what was written runs or is sent, and on Escape. It is never sent, and never enters
   * `history`, so Up never recalls it.
   */
  readonly aside: Aside | undefined;
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
 * - `Edited`: the Owner changed the plain text to `text`, which is merged into the draft's
 *   formatting, and lets go of lines waiting to be confirmed, and of a notice about the
 *   text. Over a command started over a draft, text edited to nothing puts the command away,
 *   as `Restored` does. `caret`, where the caret is after it, places an edit the text alone could place
 *   in several ways. Text left as it was changes nothing. Once the text changes, a style
 *   pending is let go of, after it was typed if the edit put text in where it was.
 * - `Formatted`: the Owner put a format over the plain text from `start` to `end`. With
 *   nothing selected, it is pending at the caret instead, for what is typed there next.
 * - `Recalled`: Up or Down through the history, which changes the text as an edit does.
 * - `Left`: the composer turned to another Timeline, which lets go of a notice about the
 *   text it holds, since the text stays and the complaint about it does not come back.
 * - `Dismissed`: Escape, which lets go of a notice and a confirmation.
 * - `Restored`: Escape over a command started over a draft: the command goes, and the draft
 *   set aside comes back, with what it answered. With none set aside, nothing changes.
 * - `Failed`: a Say or an Act failed; `intents` are it and those after it, none carried out after it.
 * - `Noticed`: an intent other than a Say or an Act did not go as asked, such as a change of
 *   Configuration, in words. Nothing after it was carried out.
 * - `ReplyChosen`: the Owner chose to answer a Message, which the draft holds until it is
 *   sent or dropped, through edits and turning away. Lines waiting to be confirmed go.
 * - `ReplyDropped`: the Owner chose not to answer it after all. The text stays, and lines
 *   waiting to be confirmed go.
 * - `Carried`: a draft came to show its Timeline, so what was typed under it, unsent, goes
 *   to the Timeline's composer, unless that holds text of its own, with its notice unless
 *   that holds one, and what is said later of a Say sent from the draft is said there. A
 *   notice about the text stays behind. A draft set aside goes with the text.
 */
export type ComposerEvent =
  | {
      readonly _tag: "Edited";
      readonly timeline: Place;
      readonly text: string;
      readonly caret?: number;
    }
  | {
      readonly _tag: "Formatted";
      readonly timeline: Place;
      readonly start: number;
      readonly end: number;
      readonly format: Format;
    }
  | {
      readonly _tag: "Recalled";
      readonly timeline: Place;
      readonly direction: "Older" | "Newer";
    }
  | { readonly _tag: "Left"; readonly timeline: Place }
  | { readonly _tag: "Dismissed"; readonly timeline: Place }
  | { readonly _tag: "Restored"; readonly timeline: Place }
  | {
      readonly _tag: "Failed";
      readonly timeline: Place;
      readonly intent: IntentId;
      readonly failure: SayFailure;
      readonly intents: readonly Intent[];
    }
  | { readonly _tag: "Noticed"; readonly timeline: Place; readonly message: string }
  | { readonly _tag: "ReplyChosen"; readonly timeline: Place; readonly answering: Answering }
  | { readonly _tag: "ReplyDropped"; readonly timeline: Place }
  | { readonly _tag: "Carried"; readonly from: Place; readonly to: Place };

/**
 * A composer's next state, the intents it asks the runtime to carry out, and the keys of the
 * commands those run, in order, as the Composer's list remembers them, none for plain text.
 */
export interface Submitted {
  readonly state: Composers;
  readonly intents: readonly Intent[];
  readonly ran: readonly string[];
}

/** No composer touched yet. */
export const initialComposers: Composers = { carried: new Map(), drafts: new Map() };

/** A composer never touched. */
export const emptyDraft: Draft = {
  answering: undefined,
  aside: undefined,
  confirming: undefined,
  history: [],
  kept: "",
  notice: undefined,
  recalled: undefined,
  text: "",
  typing: undefined,
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
 * The Timelines with something unread, as a command sees them.
 * @param timelines - The Timelines.
 * @returns Those with something unread, in their order.
 */
const unseenIn = (timelines: readonly Timeline[]): readonly Unseen[] =>
  timelines.flatMap((timeline) => {
    const level = levelOf(timeline.unread);

    return level === undefined
      ? []
      : [{ level, mark: markLatest(timeline), timeline: timeline.id }];
  });

/**
 * Whether a Network has a Session: not while the Daemon stops it, and not known while it is
 * not read or its connection is not known yet.
 * @param network - The Network, as held.
 * @returns Whether it has one, or `undefined` while that is not known.
 */
const sessionOf = (network: NetworkView | undefined): boolean | undefined => {
  if (network?.running?._tag === "Stopped") {
    return false;
  }

  if (network === undefined || network.connection._tag === "Unknown") {
    return undefined;
  }

  return network.connection._tag === "Connected";
};

/**
 * The context commands are judged in: the focused Pane's open Timeline as its Network lists
 * it, whether that Network has a Session, every Timeline in the order the sidebar shows, and
 * by name, those closed too, those open in any Pane, those with something
 * unread, and the head of the Channel in focus, as read.
 * @param timelines - The Timelines.
 * @param channels - The Channels the Panes show, as read.
 * @param arrangement - The Owner's order of the sidebar.
 * @param aliases - The aliases the Owner made.
 * @returns The context.
 */
export const contextOf = (
  timelines: Timelines,
  channels: Channels = initialChannels,
  arrangement: Arrangement = unarranged,
  aliases: Aliases = []
): CommandContext => {
  const shown = opened(timelines);
  const open = openOf(timelines);
  const main = mainOf(timelines);

  const networks = sidebar(timelines);
  const shownAs = arranged(networks, arrangement);

  // A removed Network's Timelines are read, never marked, so what is unread there calls
  // for nothing. Ties among what calls go by the order shown, the pinned first.
  const marked = networks.filter((one) => !one.removed);

  const calling = [
    ...shownAs.pinned.filter((pin) => !pin.network.removed).map((pin) => pin.timeline),
    ...shownAs.networks.filter((one) => !one.removed).flatMap((one) => one.timelines),
  ];

  const closed = marked.flatMap((one) => one.closed);

  // A Timeline behind the options, the search, or a draft is not the one shown, so
  // `/next-unread` may go to it, which shows it.
  const around = {
    aliases,
    behind: main._tag !== "Timeline",
    named: namedIn(networks),
    open: open === undefined ? undefined : resolve(timelines, open),
    panes: panesOf(timelines.layout.root).length,
    shown: panesOf(timelines.layout.root).flatMap((pane) =>
      pane.view.open === undefined ? [] : [resolve(timelines, pane.view.open)]
    ),
    timelines: shownOrder(shownAs),
    unread: unseenIn(calling),
    unreadClosed: unseenIn(closed),
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
      session: sessionOf(network),
    };
  }

  if (shown._tag !== "Shown" || shown.description === undefined) {
    return { ...around, draft: undefined, focus: undefined, head: undefined, session: false };
  }

  const { description } = shown;
  const network = timelines.networks.get(description.network);

  const removed = description.removed || (network !== undefined && isRemoved(network));

  const focus: Focus = {
    detached: description.detached,
    key: description.key ?? undefined,
    kind: description.kind,
    name: description.name,
    network: description.network,
    removed,
    timeline: description.id,
  };

  const { header } = channelIn(channels, description.id).head;

  return {
    ...around,
    draft: undefined,
    focus,
    head:
      description.kind === "Channel" && header?.timeline === description.id ? header : undefined,
    session: removed ? false : sessionOf(network),
  };
};

/**
 * The lines of input that say something, in order: every line with more than whitespace.
 * @param text - The input.
 * @returns Its lines.
 */
export const linesOf = (text: string): readonly string[] =>
  text.split(/\r\n|\r|\n/u).filter((line) => plainOf(line).trim() !== "");

/**
 * The keys of the commands lines run, in order, as the Composer's list remembers them: a line that
 * starts with `/`, but not `//`, and names a command. Plain text runs none.
 * @param lines - The lines, each read already.
 * @param aliases - The aliases, one of which a line may run.
 * @returns The keys.
 */
const ranBy = (lines: readonly string[], aliases: Aliases): readonly string[] =>
  lines.flatMap((line) => {
    const name = /^\/(?<name>[^\s/]\S*)/u.exec(line)?.groups?.name;
    const found = name === undefined ? undefined : commandRunBy(name, aliases);

    return found === undefined ? [] : [commandKey(found.id)];
  });

/**
 * A notice once the Owner submits: an offer stays, since it can still be taken, and anything
 * else is let go of.
 * @param notice - The notice.
 * @returns What is left of it.
 */
const afterSubmit = (notice: Notice | undefined): Notice | undefined =>
  notice?._tag === "Offering" ? notice : undefined;

/** The id of a Message a Say answers, as `say` takes it. */
type AnswersId = NonNullable<SayRequest["answers"]>;

/**
 * Reads a Message's id as `say` takes it to answer: 1 to 256 characters, none a space or a
 * control character, as a `+reply` tag can carry. The core takes the API's types alone, so
 * this repeats the Client's `SendableMessageId` rule, which must change with it.
 */
const sendableId: (id: string) => Option.Option<AnswersId> = Schema.decodeUnknownOption(
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
    Schema.isPattern(/^[^\p{Cc} ]+$/u)
  ).pipe(Schema.brand("MessageId"))
);

/**
 * What answering a Message would answer, if it can be answered: a Message with an id a
 * `+reply` tag can carry, the Ircd's own for one of ours it confirmed, on a Network whose
 * Session carries tags. Anywhere else, nothing is offered.
 * @param item - The item.
 * @param tags - Whether its Network's Session carries tags.
 * @returns What a draft would answer, or nothing.
 */
export const replyOf = (item: TimelineItem, tags: boolean): Answering | undefined => {
  const { content } = item;

  if (!tags || content._tag !== "Message") {
    return undefined;
  }

  const delivery = content.ours?.delivery;
  const confirmed = delivery?._tag === "Confirmed" ? delivery : undefined;
  const fact = content.id._tag === "Known" ? content.id : confirmed?.id;
  const id = fact?._tag === "Known" ? sendableId(fact.value) : Option.none();

  return Option.isSome(id)
    ? {
        id: id.value,
        message: {
          kind: content.kind,
          position: item.position,
          sender: content.sender,
          text: confirmed?.text ?? content.text,
        },
      }
    : undefined;
};

/**
 * Puts what a draft answers on the first Say of its intents to the Timeline it is under,
 * and on none after it, so a reply too long for one Line is tagged on its first.
 * @param intents - The intents read from the draft.
 * @param answering - What the draft answers, if anything.
 * @param focus - The Timeline it is under, as commands see it.
 * @returns The intents.
 */
const answered = (
  intents: readonly Intent[],
  answering: Answering | undefined,
  focus: Focus | undefined
): readonly Intent[] => {
  const first = intents.findIndex(
    (one) => one._tag === "Say" && one.network === focus?.network && one.target === focus.name
  );

  const intent = intents[first];

  return answering === undefined || intent?._tag !== "Say"
    ? intents
    : intents.with(first, { ...intent, answers: answering.id });
};

/**
 * The composer once its text was sent: cleared, or showing the draft that was set aside, with
 * what it answered, and its text the newest in its history, unless it is already, which the
 * draft set aside never is. An offer made of an earlier Say or Act stays.
 * @param draft - The composer.
 * @returns The composer after.
 */
const sent = (draft: Draft): Draft => ({
  ...emptyDraft,
  answering: draft.aside?.answering,
  history:
    draft.history[0] === draft.text
      ? draft.history
      : [draft.text, ...draft.history].slice(0, historyCap),
  notice: afterSubmit(draft.notice),
  text: draft.aside?.text ?? "",
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

  // Nothing to send still counts as a submit to an outcome, which often arrives once the
  // composer is empty again: Enter lets go of it.
  if (lines.length === 0) {
    return {
      intents: [],
      ran: [],
      state:
        draft.notice?._tag === "Outcome"
          ? withDraft(state, timeline, (one) => ({ ...one, notice: undefined }))
          : state,
    };
  }

  const refuse = (message: string): Submitted => ({
    intents: [],
    ran: [],
    state: noticed(state, timeline, aboutText(message)),
  });

  // A Credential's value typed here is let go of at once: the draft, what was kept while
  // recalling, and what waits to be confirmed, and none of it enters the history.
  const credential = lines
    .map((line) => credentialRefusal(line, context.aliases))
    .find((message) => message !== undefined);

  if (credential !== undefined) {
    return {
      intents: [],
      ran: [],
      state: withDraft(state, timeline, (one) => ({
        ...emptyDraft,
        aside: one.aside,
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

  const replies = answered(
    intents,
    draft.answering,
    context.focus?.timeline === timeline ? context.focus : undefined
  );

  if (lines.length > confirmAbove) {
    return {
      intents: [],
      ran: [],
      state: withDraft(state, timeline, (one) => ({
        ...one,
        confirming: { intents: replies, lines: lines.length },
        notice: afterSubmit(one.notice),
      })),
    };
  }

  return {
    intents: replies,
    ran: ranBy(lines, context.aliases),
    state: withDraft(state, timeline, sent),
  };
};

/**
 * Confirms the lines waiting in a Timeline's composer, which are then sent.
 * @param state - The composers.
 * @param timeline - The Timeline.
 * @param aliases - The aliases, one of which a line may run.
 * @returns The state after, and the intents to carry out.
 */
export const confirm = (state: Composers, timeline: Place, aliases: Aliases): Submitted => {
  const { confirming, text } = draftOf(state, timeline);

  // What waits was read from the text shown, which an edit lets go of it.
  return confirming === undefined
    ? { intents: [], ran: [], state }
    : {
        intents: confirming.intents,
        ran: ranBy(linesOf(text), aliases),
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
          typing: undefined,
        };
  }

  if (recalled === undefined) {
    return draft;
  }

  const text = recalled === 0 ? undefined : history[recalled - 1];

  return text === undefined
    ? { ...draft, kept: "", recalled: undefined, text: draft.kept, typing: undefined }
    : { ...draft, recalled: recalled - 1, text, typing: undefined };
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
 * A draft once a command started over it is put away: the draft set aside comes back, with
 * what it answered, and what the command left, a recall or lines to confirm among it, goes.
 * With none set aside, it is as it was.
 * @param draft - The draft.
 * @returns The draft after.
 */
const restored = (draft: Draft): Draft =>
  draft.aside === undefined
    ? draft
    : {
        ...draft,
        answering: draft.aside.answering,
        aside: undefined,
        confirming: undefined,
        kept: "",
        notice: unlessAboutText(draft.notice, true),
        recalled: undefined,
        text: draft.aside.text,
        typing: undefined,
      };

/**
 * Whether a draft that came to show its Timeline brings what it holds to the Timeline's
 * composer: it holds text, or a draft set aside, and the composer holds neither.
 * @param from - The draft's composer.
 * @param to - The Timeline's composer.
 * @returns Whether it does.
 */
const brings = (from: Draft, to: Draft): boolean =>
  (plainOf(from.text).trim() !== "" || from.aside !== undefined) &&
  plainOf(to.text).trim() === "" &&
  to.aside === undefined;

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

      const moving = brings(from, to);

      const drafts = new Map(state.drafts);

      drafts.delete(event.from);

      return {
        carried: new Map(state.carried).set(event.from, event.to),
        drafts: drafts.set(
          event.to,
          moving
            ? {
                ...to,
                aside: from.aside,
                confirming: from.confirming,
                notice: to.notice ?? kept,
                recalled: undefined,
                text: from.text,
                typing: undefined,
              }
            : { ...to, notice: to.notice ?? kept }
        ),
      };
    }

    case "Edited": {
      // Lines waiting to be confirmed were read from the text before it changed, and a
      // complaint about the text is about the text as it was.
      return withDraft(state, event.timeline, (draft) => {
        const hint: Hint =
          event.caret === undefined
            ? { pending: draft.typing }
            : { caret: event.caret, pending: draft.typing };

        const text = merged(draft.text, event.text, hint);

        const edited: Draft = {
          ...draft,
          confirming: undefined,
          notice: unlessAboutText(draft.notice, plainOf(draft.text) !== event.text),
          recalled: undefined,
          text,
          typing: text === draft.text ? draft.typing : undefined,
        };

        // A command edited away to nothing is put away, as Escape does, so the draft set
        // aside is never left behind a draft typed over the empty command.
        return plainOf(text).trim() === "" ? restored(edited) : edited;
      });
    }

    // Nothing selected, the format waits at the caret for what is typed there; anything
    // selected takes it at once.
    case "Formatted": {
      return withDraft(state, event.timeline, (draft) =>
        event.start === event.end
          ? { ...draft, typing: pendingAfter(draft.text, draft.typing, event.start, event.format) }
          : {
              ...draft,
              confirming: undefined,
              text: formattedIn(draft.text, event.start, event.end, event.format),
              typing: undefined,
            }
      );
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

    case "Restored": {
      return withDraft(state, event.timeline, restored);
    }

    case "Failed": {
      return noticed(state, event.timeline, failed(event.failure, event.intent, event.intents));
    }

    case "Noticed": {
      return noticed(state, event.timeline, outcome(event.message));
    }

    // Lines waiting to be confirmed were read under the reply as it was.
    case "ReplyChosen": {
      return withDraft(state, event.timeline, (draft) => ({
        ...draft,
        answering: event.answering,
        confirming: undefined,
      }));
    }

    case "ReplyDropped": {
      return withDraft(state, event.timeline, (draft) => ({
        ...draft,
        answering: undefined,
        confirming: undefined,
      }));
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * Starts a composer with text, as `/topic` does with the Channel's topic. A
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

  if (plainOf(draft.text).trim() === "") {
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

/**
 * Starts a command in a composer: `text`, which the Owner goes on to write. The draft is set
 * aside, with what it answers, and comes back when the command runs, or the text is sent, or
 * on Escape; one already set aside stays the one set aside, and only the command is
 * replaced. A blank draft is set aside as it is, so that a second key over the command it
 * started puts nothing of it aside, and Escape clears it. What the draft answered, a recall,
 * lines waiting to be confirmed, a style pending, and a notice about the text are let go of,
 * as they are for any other text.
 * @param state - The composers.
 * @param timeline - The composer's place.
 * @param text - What to start it with.
 * @returns The composers after.
 */
export const commandStarted = (state: Composers, timeline: Place, text: string): Composers =>
  withDraft(state, timeline, (draft) => ({
    ...draft,
    answering: undefined,
    aside: draft.aside ?? { answering: draft.answering, text: draft.text },
    confirming: undefined,
    kept: "",
    notice: unlessAboutText(draft.notice, true),
    recalled: undefined,
    text,
    typing: undefined,
  }));

/**
 * The text the files added to a composer belong to: the draft set aside while a command
 * stands over it, else the draft. Their anchors and links are in it.
 * @param state - The composers.
 * @param timeline - The composer's place.
 * @returns Its text, with its formatting codes.
 */
export const filesTextOf = (state: Composers, timeline: Place): string => {
  const draft = draftOf(state, timeline);

  return draft.aside?.text ?? draft.text;
};

/**
 * Changes the text the files added to a composer belong to, as `filesTextOf` says: the draft
 * set aside, left as it is where a command stands over it, or else the draft, as an edit does.
 * @param state - The composers.
 * @param timeline - The composer's place.
 * @param text - The plain text after.
 * @returns The composers after.
 */
export const withFilesText = (state: Composers, timeline: Place, text: string): Composers => {
  const { aside } = draftOf(state, timeline);

  return aside === undefined
    ? reduceComposers(state, { _tag: "Edited", text, timeline })
    : withDraft(state, timeline, (draft) => ({
        ...draft,
        aside: { ...aside, text: merged(aside.text, text, { pending: undefined }) },
      }));
};
