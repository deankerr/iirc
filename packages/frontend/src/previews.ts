/**
 * Previews, as a Frontend holds them: which Messages were shown and so may be asked for,
 * what the Daemon answered for each, and each Preview by its id, kept up to date by the
 * stream of their changes. A Message is asked for only once it was shown, and only once
 * while the stream is followed, since the Daemon fetches on the ask. Whether a Message is
 * asked for, and what it shows, follows its Timeline's own mode: its choice in
 * `ui.previews.conversations`, or else `ui.previews`. Each Preview is open or closed, as the
 * toggle after its link leaves it, or else as `ui.previews.start` says, and a Message is
 * asked for only while one of its Previews is open, since a closed one fetches nothing. A
 * link the Daemon holds for a press is fetched only once the Owner opens it. A window's
 * Messages are read for what the Daemon already holds of them, which fetches nothing, so a
 * row held is drawn whole before it is ever asked for. What each Message shows, each
 * Preview's card, and a failure's words are derived as it is drawn, never held.
 *
 * @packageDocumentation
 */
import type {
  HeldPreviews,
  ItemContent,
  Preview,
  PreviewFailure,
  PreviewId,
  PreviewItem,
  PreviewsByTimeline,
  PreviewsPlayers,
  PreviewsShown,
  PreviewsStart,
  TimelineId,
  UiInForce,
} from "@iirc/api";
import { previewableLinksOf } from "@iirc/protocol/links";
import { cursorOf } from "@iirc/timelines";
import type { Position } from "@iirc/timelines";

import { contained } from "./contained.ts";

/**
 * Where a Message stands in asking for its Previews: `Wanted`, shown and not yet asked for,
 * or to be asked again; `Asking`, asked at the stream's `since`; `Answered`; or `Refused`,
 * as the Daemon refused it for good, which it is never asked for again.
 */
type Asking = "Wanted" | "Asking" | "Answered" | "Refused";

/**
 * One Message shown: where it is, how many links it holds that may be previewed, whether
 * its Timeline is a Direct Message, where its asking stands, the ids the Daemon answered
 * with, in the Message's order, kept while it is asked again, and its Timeline's own
 * choice when it was last asked for, which a link waiting for a press is answered by.
 */
interface MessageHeld {
  readonly timeline: TimelineId;
  readonly position: Position;
  readonly links: number;
  readonly direct: boolean;
  readonly asking: Asking;
  readonly since: number;
  readonly ids: readonly PreviewId[] | undefined;
  readonly chosen: PreviewsShown | undefined;
}

/** A Preview held: the item as last given, and the stream's count when it was. */
interface ItemHeld {
  readonly item: PreviewItem;
  readonly tick: number;
}

/**
 * What a Frontend holds of Previews: each Message shown, by `messageKey`; the ids a held
 * read gave each Message not yet answered, by `messageKey`, in its order; each item by its
 * id; each link pressed, by `linkKey`, which is never pressed again; how many changes the
 * stream gave, which orders a change against an answer; how many held reads are in flight,
 * whose answers may name any item; and whether the stream is followed now, which an ask
 * waits for, so no change it starts is missed.
 */
export interface Previews {
  readonly messages: ReadonlyMap<string, MessageHeld>;
  readonly held: ReadonlyMap<string, readonly PreviewId[]>;
  readonly items: ReadonlyMap<PreviewId, ItemHeld>;
  readonly pressed: ReadonlySet<string>;
  readonly tick: number;
  readonly reading: number;
  readonly following: boolean;
}

/** Nothing shown, read, held, or pressed, and the stream not followed. */
export const initialPreviews: Previews = {
  following: false,
  held: new Map(),
  items: new Map(),
  messages: new Map(),
  pressed: new Set(),
  reading: 0,
  tick: 0,
};

/**
 * A held read of a window's Messages: their Timeline, and the stream's count when it
 * began, which orders what it read against a change.
 */
export interface HeldRead {
  readonly timeline: TimelineId;
  readonly since: number;
}

/**
 * A held read of a Timeline's Messages, at the stream's count now.
 * @param state - The state.
 * @param timeline - The Timeline.
 * @returns The read.
 */
export const heldReadOf = (state: Previews, timeline: TimelineId): HeldRead => ({
  since: state.tick,
  timeline,
});

/**
 * An ask to make: of which Message, under its key, at which count of the stream, and under
 * which choice of its Timeline's own, if any.
 */
export interface PreviewsAsk {
  readonly key: string;
  readonly timeline: TimelineId;
  readonly position: Position;
  readonly since: number;
  readonly chosen: PreviewsShown | undefined;
}

/**
 * A press of a link waiting for one: its Message, under its key and by its place, the
 * link's index among the Message's links that may be previewed, and the stream's count
 * when it was pressed, which orders its answer against a change.
 */
export interface PreviewsPress {
  readonly key: string;
  readonly timeline: TimelineId;
  readonly position: Position;
  readonly link: number;
  readonly since: number;
}

/**
 * What happened.
 *
 * - `Shown`: a Message came into view, with how many links it holds that may be previewed,
 *   and whether its Timeline is a Direct Message. Shown again with another count, as an
 *   Ircd's echo of one of ours may change its text, it holds that count.
 * - `Asked`: the runtime began an ask.
 * - `Answered`: the Daemon answered an ask with the Message's items.
 * - `Refused`: the Daemon refused an ask for good: no such Timeline or Message, or Previews
 *   are off.
 * - `Pressing`: the runtime began a press.
 * - `PressDropped`: the runtime let go of a press before it was answered, as Previews
 *   stopped being followed, so the link may be pressed again.
 * - `Pressed`: the Daemon answered a press with the link's item.
 * - `PressRefused`: the Daemon refused a press, as the link was not waiting for one, so
 *   its Message is asked for again, to draw what the Daemon holds.
 * - `Followed`: the stream is followed, from now.
 * - `Changed`: the stream gave an item as it is now.
 * - `Lost`: the stream is no longer followed, and every ask in flight was let go of.
 * - `Reading`: the runtime began a held read of a window's Messages.
 * - `Read`: the Daemon answered a held read with what it holds of each Message.
 * - `ReadDropped`: a held read ended with no answer, which is let go of.
 * - `Forgotten`: the page signed out.
 */
export type PreviewsEvent =
  | {
      readonly _tag: "Shown";
      readonly timeline: TimelineId;
      readonly position: Position;
      readonly links: number;
      readonly direct: boolean;
    }
  | { readonly _tag: "Asked"; readonly ask: PreviewsAsk }
  | {
      readonly _tag: "Answered";
      readonly ask: PreviewsAsk;
      readonly previews: readonly PreviewItem[];
    }
  | { readonly _tag: "Refused"; readonly ask: PreviewsAsk }
  | { readonly _tag: "Pressing"; readonly press: PreviewsPress }
  | { readonly _tag: "Pressed"; readonly press: PreviewsPress; readonly item: PreviewItem }
  | { readonly _tag: "PressRefused"; readonly press: PreviewsPress }
  | { readonly _tag: "PressDropped"; readonly press: PreviewsPress }
  | { readonly _tag: "Followed" }
  | { readonly _tag: "Changed"; readonly item: PreviewItem }
  | { readonly _tag: "Lost" }
  | { readonly _tag: "Reading"; readonly read: HeldRead }
  | {
      readonly _tag: "Read";
      readonly read: HeldRead;
      readonly messages: HeldPreviews["messages"];
    }
  | { readonly _tag: "ReadDropped"; readonly read: HeldRead }
  | { readonly _tag: "Forgotten" };

/**
 * A Message's key: its Timeline and its place there, as one text.
 * @param timeline - Its Timeline.
 * @param position - Its place.
 * @returns The key.
 */
export const messageKey = (timeline: TimelineId, position: Position): string =>
  `${timeline} ${cursorOf(position)}`;

/**
 * A link's key: its Message's key and its index among the Message's links that may be
 * previewed, as one text.
 * @param key - Its Message's key.
 * @param index - Its index.
 * @returns The key.
 */
export const linkKey = (key: string, index: number): string => `${key} ${index}`;

/**
 * `ui.previews`, each Timeline's own choice over it, by its id, and the hosts
 * `ui.previews.players` lists now.
 */
export interface PreviewsModes {
  readonly players: PreviewsPlayers;
  readonly shown: PreviewsShown;
  readonly timelines: PreviewsByTimeline;
}

/**
 * The modes as the Daemon acts on them: the shared values alone, since no device overrides
 * them, and none until the shared options are read.
 * @param shared - The shared options, once read.
 * @returns The modes, or none.
 */
export const previewsModesOf = (shared: UiInForce | undefined): PreviewsModes | undefined =>
  shared === undefined
    ? undefined
    : {
        players: shared.options["previews.players"],
        shown: shared.options.previews,
        timelines: shared.options["previews.conversations"],
      };

/**
 * A Timeline's own choice over `ui.previews`, if it made one.
 * @param modes - The modes, once read.
 * @param timeline - The Timeline.
 * @returns Its choice, or none.
 */
export const chosenIn = (
  modes: PreviewsModes | undefined,
  timeline: TimelineId
): PreviewsShown | undefined => modes?.timelines[timeline];

/**
 * A Timeline's mode: its own choice, or else `ui.previews`, and none before they are read.
 * @param modes - The modes, once read.
 * @param timeline - The Timeline.
 * @returns Its mode, or none.
 */
export const modeIn = (
  modes: PreviewsModes | undefined,
  timeline: TimelineId
): PreviewsShown | undefined => chosenIn(modes, timeline) ?? modes?.shown;

/**
 * Each Timeline's own choice with one Timeline's made, or with none, removed, so it
 * follows `ui.previews`.
 * @param timelines - Each Timeline's own choice, as read.
 * @param timeline - The Timeline.
 * @param mode - Its choice, or none.
 * @returns Each Timeline's own choice now.
 */
export const choosing = (
  timelines: PreviewsByTimeline,
  timeline: TimelineId,
  mode: PreviewsShown | undefined
): PreviewsByTimeline => {
  const { [timeline]: _, ...others } = timelines;

  return mode === undefined ? others : { ...others, [timeline]: mode };
};

/**
 * Whether a Frontend asks for a Timeline's Previews: under `text` or `on`, never
 * under `off`, and never before the mode is known.
 * @param mode - The Timeline's mode.
 * @returns Whether it asks.
 */
export const asksFor = (mode: PreviewsShown | undefined): boolean =>
  mode === "text" || mode === "on";

/**
 * Whether a Frontend follows the stream of Previews: while any Timeline could ask, as
 * `ui.previews` asks or some Timeline's own choice does.
 * @param modes - The modes, once read.
 * @returns Whether it follows.
 */
export const asksAnywhere = (modes: PreviewsModes | undefined): boolean =>
  modes !== undefined &&
  (asksFor(modes.shown) || Object.values(modes.timelines).some((mode) => asksFor(mode)));

/**
 * Whether a Message's ids still wait on a Preview, so a stream followed again must ask for
 * it, since what changed meanwhile was never given.
 * @param held - The Message.
 * @param items - The items held.
 * @returns Whether any is pending.
 */
const waiting = (held: MessageHeld, items: ReadonlyMap<PreviewId, ItemHeld>): boolean =>
  held.ids === undefined ||
  held.ids.some((id) => (items.get(id)?.item.state._tag ?? "Pending") === "Pending");

/**
 * Whether a Message answered holds a link waiting for a press.
 * @param held - The Message.
 * @param items - The items held.
 * @returns Whether one waits.
 */
const pressable = (held: MessageHeld, items: ReadonlyMap<PreviewId, ItemHeld>): boolean =>
  held.ids?.some((id) => items.get(id)?.item.state._tag === "WaitingForPress") === true;

/**
 * Whether an answer in flight, of an ask or a held read, may name any item, so every
 * change the stream gives is held meanwhile.
 * @param state - The state.
 * @returns Whether one is.
 */
const inFlight = (state: Previews): boolean =>
  state.reading > 0 || [...state.messages.values()].some((held) => held.asking === "Asking");

/**
 * Only the items some answered Message names, or a held read named, unless an answer is in
 * flight, which may name any.
 * @param state - The state.
 * @returns It, holding no item no Message shows.
 */
const pruned = (state: Previews): Previews => {
  if (inFlight(state)) {
    return state;
  }

  const named = new Set([
    ...[...state.messages.values()].flatMap((held) => held.ids ?? []),
    ...[...state.held.values()].flat(),
  ]);

  return {
    ...state,
    items: new Map([...state.items].filter(([id]) => named.has(id))),
  };
};

/**
 * A map without one key.
 * @param map - The map.
 * @param key - The key.
 * @returns The map, without it.
 */
const without = <V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> => {
  if (!map.has(key)) {
    return map;
  }

  const left = new Map(map);

  left.delete(key);

  return left;
};

/**
 * One Message changed.
 * @param state - The state.
 * @param key - Its key.
 * @param held - It, as it is now.
 * @returns The state.
 */
const withMessage = (state: Previews, key: string, held: MessageHeld): Previews => ({
  ...state,
  messages: new Map(state.messages).set(key, held),
});

/**
 * The Message an answer or a refusal is for, while it is still the ask in flight.
 * @param state - The state.
 * @param ask - The ask.
 * @returns The Message, or none when it was let go of or asked again since.
 */
const askedOf = (state: Previews, ask: PreviewsAsk): MessageHeld | undefined => {
  const held = state.messages.get(ask.key);

  return held?.asking === "Asking" && held.since === ask.since ? held : undefined;
};

/**
 * An ask begun: of a Message wanted, or of one answered under another choice of its
 * Timeline's, and only while the stream is followed.
 * @param state - The state.
 * @param ask - The ask.
 * @returns The state.
 */
const asked = (state: Previews, ask: PreviewsAsk): Previews => {
  const held = state.messages.get(ask.key);

  const wanted =
    held?.asking === "Wanted" || (held?.asking === "Answered" && held.chosen !== ask.chosen);

  return held !== undefined && wanted && state.following
    ? withMessage(state, ask.key, {
        ...held,
        asking: "Asking",
        chosen: ask.chosen,
        since: ask.since,
      })
    : state;
};

/**
 * An answered Message wanted again, to be asked for once more.
 * @param state - The state.
 * @param key - Its key.
 * @returns The state.
 */
const wantedAgain = (state: Previews, key: string): Previews => {
  const held = state.messages.get(key);

  return held?.asking === "Answered"
    ? withMessage(state, key, { ...held, asking: "Wanted" })
    : state;
};

/**
 * An answer's items folded in: each in place of the one held, unless the stream changed
 * that one after the ask or the read began, which is then newer than the answer.
 * @param state - The state.
 * @param since - The stream's count when the ask or the read began.
 * @param previews - The items.
 * @returns The items held now.
 */
const answeredItems = (
  state: Previews,
  since: number,
  previews: readonly PreviewItem[]
): ReadonlyMap<PreviewId, ItemHeld> => {
  const items = new Map(state.items);

  for (const item of previews) {
    const held = items.get(item.id);

    if (held === undefined || held.tick <= since) {
      items.set(item.id, { item, tick: since });
    }
  }

  return items;
};

/**
 * A held read answered: each Message's ids kept, unless an ask already answered it, and
 * each item the Daemon holds folded in as an answer's are. A link nothing is held of folds
 * in no item, so it is drawn as whatever the stream later gives.
 * @param state - The state.
 * @param read - The read.
 * @param messages - What the Daemon holds of each Message.
 * @returns The state.
 */
const heldAnswered = (
  state: Previews,
  read: HeldRead,
  messages: HeldPreviews["messages"]
): Previews => {
  const held = new Map(state.held);

  for (const { position, previews } of messages) {
    const key = messageKey(read.timeline, position);

    if (previews.length > 0 && state.messages.get(key)?.ids === undefined) {
      held.set(
        key,
        previews.map((item) => item.id)
      );
    }
  }

  const items = messages
    .flatMap((message) => message.previews)
    .flatMap((item): PreviewItem[] =>
      item.state._tag === "NotHeld" ? [] : [{ ...item, state: item.state }]
    );

  return {
    ...state,
    held,
    items: answeredItems(state, read.since, items),
    reading: Math.max(0, state.reading - 1),
  };
};

/**
 * A Message come into view: wanted, the first time. Seen again with as many links, it is as
 * it was, but for whether its Timeline is a Direct Message.
 * @param state - The state.
 * @param event - What the view said.
 * @returns The state.
 */
const shown = (
  state: Previews,
  event: Extract<PreviewsEvent, { readonly _tag: "Shown" }>
): Previews => {
  const key = messageKey(event.timeline, event.position);
  const held = state.messages.get(key);

  if (held === undefined) {
    return withMessage(state, key, {
      asking: "Wanted",
      chosen: undefined,
      direct: event.direct,
      ids: undefined,
      links: event.links,
      position: event.position,
      since: 0,
      timeline: event.timeline,
    });
  }

  if (held.links === event.links) {
    return held.direct === event.direct
      ? state
      : withMessage(state, key, { ...held, direct: event.direct });
  }

  // Its links changed, so what was answered, or is being asked, was for other links:
  // it is wanted again, unless the Daemon refused it for good.
  return withMessage(state, key, {
    ...held,
    asking: held.asking === "Refused" ? "Refused" : "Wanted",
    direct: event.direct,
    ids: undefined,
    links: event.links,
  });
};

/**
 * A change the stream gave, held only for an item some Message names, or while an answer
 * is in flight, which may name any.
 * @param state - The state.
 * @param item - The item, as it is now.
 * @returns The state.
 */
const changed = (state: Previews, item: PreviewItem): Previews => {
  const tick = state.tick + 1;

  const named =
    state.items.has(item.id) ||
    inFlight(state) ||
    [...state.held.values()].some((ids) => ids.includes(item.id));

  return named
    ? { ...state, items: new Map(state.items).set(item.id, { item, tick }), tick }
    : { ...state, tick };
};

/**
 * Folds one event in. A Message is wanted once, when first shown, and asked for only while
 * the stream is followed. An answer is taken only by the ask in flight, though its items
 * are folded in whenever it lands, each unless the stream changed it since. A change is
 * held only for an item a Message or a held read names, or while an ask or a held read is
 * in flight. A held read's items are folded in as an answer's are. When the stream is lost,
 * every Message still waiting on a Preview, or on its answer, is wanted again, to be asked
 * once it is followed again.
 * @param state - The state.
 * @param event - What happened.
 * @returns The state now.
 */
export const reducePreviews = (state: Previews, event: PreviewsEvent): Previews => {
  switch (event._tag) {
    case "Shown": {
      return shown(state, event);
    }

    case "Asked": {
      return asked(state, event.ask);
    }

    case "Answered": {
      const items = answeredItems(state, event.ask.since, event.previews);
      const held = askedOf(state, event.ask);

      const answered =
        held === undefined
          ? { ...state, items }
          : withMessage(
              { ...state, held: without(state.held, event.ask.key), items },
              event.ask.key,
              {
                ...held,
                asking: "Answered",
                ids: event.previews.map((item) => item.id),
              }
            );

      return pruned(answered);
    }

    case "Refused": {
      const held = askedOf(state, event.ask);

      return held === undefined
        ? state
        : pruned(withMessage(state, event.ask.key, { ...held, asking: "Refused" }));
    }

    case "Pressing": {
      return {
        ...state,
        pressed: new Set(state.pressed).add(linkKey(event.press.key, event.press.link)),
      };
    }

    case "PressDropped": {
      const pressed = new Set(state.pressed);

      pressed.delete(linkKey(event.press.key, event.press.link));

      return { ...state, pressed };
    }

    case "Pressed": {
      return pruned({
        ...state,
        items: answeredItems(state, event.press.since, [event.item]),
      });
    }

    case "PressRefused": {
      return wantedAgain(state, event.press.key);
    }

    case "Followed": {
      return { ...state, following: true };
    }

    case "Changed": {
      return changed(state, event.item);
    }

    case "Lost": {
      const messages = new Map(
        [...state.messages].map(([key, held]): [string, MessageHeld] => [
          key,
          held.asking === "Asking" || (held.asking === "Answered" && waiting(held, state.items))
            ? { ...held, asking: "Wanted" }
            : held,
        ])
      );

      return pruned({ ...state, following: false, messages });
    }

    case "Reading": {
      return { ...state, reading: state.reading + 1 };
    }

    case "Read": {
      return pruned(heldAnswered(state, event.read, event.messages));
    }

    case "ReadDropped": {
      return pruned({ ...state, reading: Math.max(0, state.reading - 1) });
    }

    case "Forgotten": {
      return initialPreviews;
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * What the Owner opened or closed with the toggle after a link, by its `linkKey`: the
 * view's own, kept while a row scrolls away and back, and forgotten when the page is
 * loaded again.
 */
export type Toggles = ReadonlyMap<string, boolean>;

/** How a view opens Previews: `ui.previews.start` on this device, and what was toggled. */
export interface Opening {
  readonly start: PreviewsStart;
  readonly toggles: Toggles;
}

/**
 * Whether a Timeline's links wait for a press: in a Direct Message with no mode of its own,
 * as the Daemon fetches nothing there until the Owner presses.
 * @param direct - Whether it is a Direct Message.
 * @param chosen - Its own mode, if any.
 * @returns Whether they wait.
 */
const waitsIn = (direct: boolean, chosen: PreviewsShown | undefined): boolean =>
  direct && chosen === undefined;

/**
 * A Message's ids, in its order: as an ask answered, or else as a held read gave them.
 * @param state - The state.
 * @param key - Its key.
 * @returns Its ids, or none before either.
 */
const idsOf = (state: Previews, key: string): readonly PreviewId[] | undefined =>
  state.messages.get(key)?.ids ?? state.held.get(key);

/**
 * Whether a link's item, as the Daemon last gave it, waits for a press.
 * @param state - The state.
 * @param key - Its Message's key.
 * @param index - Its index among the Message's links that may be previewed.
 * @returns Whether it waits.
 */
const waitingAt = (state: Previews, key: string, index: number): boolean => {
  const id = idsOf(state, key)?.[index];

  return id !== undefined && state.items.get(id)?.item.state._tag === "WaitingForPress";
};

/** A Message, as whether its Previews are open is worked out. */
export interface MessageAt {
  readonly timeline: TimelineId;
  readonly position: Position;
  readonly direct: boolean;
}

/**
 * Whether one of a Message's Previews is open: as the Owner last toggled it, or else as its
 * Timeline starts, which is `ui.previews.start`, except where links wait for a press, in a
 * Direct Message with no mode of its own or one the Daemon said waits, which start closed.
 * @param state - The state.
 * @param modes - The modes, once read.
 * @param opening - `ui.previews.start`, and what was toggled.
 * @param at - The Message.
 * @param index - The link's index among its links that may be previewed.
 * @returns Whether it is open.
 */
export const isOpen = (
  state: Previews,
  modes: PreviewsModes | undefined,
  opening: Opening,
  at: MessageAt,
  index: number
): boolean => {
  const key = messageKey(at.timeline, at.position);
  const chosen = chosenIn(modes, at.timeline);
  const toggled = opening.toggles.get(linkKey(key, index));

  if (toggled !== undefined) {
    return toggled;
  }

  const waits =
    waitsIn(at.direct, chosen) || (chosen === undefined && waitingAt(state, key, index));

  return opening.start === "open" && !waits;
};

/**
 * Whether any of a Message's Previews is open.
 * @param state - The state.
 * @param modes - The modes, once read.
 * @param opening - `ui.previews.start`, and what was toggled.
 * @param held - The Message.
 * @returns Whether one is.
 */
const anyOpen = (
  state: Previews,
  modes: PreviewsModes | undefined,
  opening: Opening,
  held: MessageHeld
): boolean =>
  Array.from({ length: held.links }, (_, index) => index).some((index) =>
    isOpen(state, modes, opening, held, index)
  );

/**
 * The asks to make now, while the stream is followed, and none otherwise: each Message
 * wanted whose Timeline's mode asks and one of whose Previews is open, or whose links wait
 * for a press, as the Daemon then answers with what it holds and fetches nothing; and each
 * holding a link waiting for a press whose Timeline has since chosen a mode of its own that
 * asks, while one of its Previews is open, which the Daemon then fetches unpressed. A
 * Message whose Previews are all closed is not asked for.
 * @param state - The state.
 * @param modes - The modes, once read.
 * @param opening - `ui.previews.start`, and what was toggled.
 * @returns The asks.
 */
export const asksWanted = (
  state: Previews,
  modes: PreviewsModes | undefined,
  opening: Opening
): readonly PreviewsAsk[] =>
  state.following
    ? [...state.messages].flatMap(([key, held]) => {
        const chosen = chosenIn(modes, held.timeline);
        const open = anyOpen(state, modes, opening, held);

        const wanted =
          (held.asking === "Wanted" && (open || waitsIn(held.direct, chosen))) ||
          (held.asking === "Answered" &&
            asksFor(chosen) &&
            held.chosen !== chosen &&
            open &&
            pressable(held, state.items));

        return wanted && asksFor(modeIn(modes, held.timeline))
          ? [{ chosen, key, position: held.position, since: state.tick, timeline: held.timeline }]
          : [];
      })
    : [];

/**
 * A press of a link waiting for one, at the stream's count now.
 * @param state - The state.
 * @param timeline - The Message's Timeline.
 * @param position - Its place.
 * @param link - The link's index among its links that may be previewed.
 * @returns The press.
 */
export const pressOf = (
  state: Previews,
  timeline: TimelineId,
  position: Position,
  link: number
): PreviewsPress => ({
  key: messageKey(timeline, position),
  link,
  position,
  since: state.tick,
  timeline,
});

/**
 * The presses to make now: each link the Owner opened whose item waits for a press, and
 * was not pressed before. Only the Owner's own toggle presses, never how a Timeline starts.
 * @param state - The state.
 * @param toggles - What the Owner opened or closed.
 * @returns The presses.
 */
export const pressesWanted = (state: Previews, toggles: Toggles): readonly PreviewsPress[] =>
  [...state.messages].flatMap(([key, held]) =>
    (idsOf(state, key) ?? []).flatMap((_, index) =>
      toggles.get(linkKey(key, index)) === true &&
      waitingAt(state, key, index) &&
      !state.pressed.has(linkKey(key, index))
        ? [pressOf(state, held.timeline, held.position, index)]
        : []
    )
  );

/**
 * A failure's reason, in words, as its one line says it.
 * @param reason - The reason.
 * @returns The words.
 */
export const reasonWords = (reason: PreviewFailure): string => {
  switch (reason) {
    case "Refused": {
      return "No preview: the daemon never fetches this address.";
    }

    case "Unreachable": {
      return "No preview: the daemon could not reach this link.";
    }

    case "TimedOut": {
      return "No preview: this link took too long to answer.";
    }

    case "TooLarge": {
      return "No preview: this link's answer was too large to read.";
    }

    case "AnsweredError": {
      return "No preview: this link answered with an error.";
    }

    case "NothingToShow": {
      return "No preview: this link had nothing to show.";
    }

    default: {
      return reason satisfies never;
    }
  }
};

/**
 * A link as a Preview draws it: an anchor's `href`, only when the link reads as one
 * `http` or `https` link and nothing more, and its text, contained.
 */
export interface LinkShown {
  readonly href: string | undefined;
  readonly text: string;
}

/**
 * A link a Daemon gave, read as the Frontend reads a Message's.
 * @param link - The link.
 * @returns It, as drawn.
 */
const linkShown = (link: string): LinkShown => {
  const [found, ...more] = previewableLinksOf(link);

  return {
    href: found !== undefined && more.length === 0 && found.href === link ? link : undefined,
    text: contained(link),
  };
};

/** A width and a height, whose shape is all that matters unless said to be pixels. */
export interface Size {
  readonly height: number;
  readonly width: number;
}

/**
 * An image a Preview shows, as drawn: what it is said to show, the Preview's title or else
 * its link; where the Daemon serves it, from its own origin and never the host it came
 * from; whether it moves; its `dimensions` in pixels, when the Daemon read them from its
 * bytes; and how it is drawn, `Whole`, a page's image or a link that is itself the image,
 * or `Poster`, a player's or a video's, which a play button is drawn over.
 */
export interface ImageShown {
  readonly alt: string;
  readonly animated: boolean;
  readonly dimensions: Size | undefined;
  readonly drawn: "Poster" | "Whole";
  readonly src: string;
}

/** Whether an image is `Still`, at its first frame, or `Moving`. */
export type Motion = "Still" | "Moving";

/**
 * What decides whether an image moves: whether it is animated, `ui.previews.animate` on
 * this device, whether the device is set to reduce motion, and what the Owner last pressed
 * it into, if they did.
 */
export interface MotionAsked {
  readonly animated: boolean;
  readonly animate: boolean;
  readonly reducedMotion: boolean;
  readonly chosen: Motion | undefined;
}

/**
 * Whether an image moves. An image that is not animated is always `Still`. An animated one
 * is as the Owner last pressed it, which is a choice made, so it plays even where the
 * device is set to reduce motion, and until then moves only when `animate` is on and the
 * device is not set to reduce motion, which keeps it still.
 * @param asked - What decides it.
 * @returns Its motion.
 */
export const motionOf = ({ animated, animate, reducedMotion, chosen }: MotionAsked): Motion => {
  if (!animated) {
    return "Still";
  }

  return chosen ?? (animate && !reducedMotion ? "Moving" : "Still");
};

/**
 * What a press of an image does: `OpenLarge`, the larger view; `Play`, from its first
 * frame; or `Stop`, back to its first frame.
 */
export type PressDoes = "OpenLarge" | "Play" | "Stop";

/**
 * What a press of an image does. An image that is not animated opens large. An animated one
 * plays when it is still, and stops when it moves, so it opens large only from the control
 * beside it while it moves.
 * @param image - The image.
 * @param motion - Whether it moves now.
 * @returns What a press does.
 */
export const pressOn = (image: Pick<ImageShown, "animated">, motion: Motion): PressDoes => {
  if (!image.animated) {
    return "OpenLarge";
  }

  return motion === "Still" ? "Play" : "Stop";
};

/**
 * A ready Preview's image as drawn: a player's or a video's as its poster, and any other
 * whole.
 * @param preview - The Preview.
 * @returns The image, or none when the Daemon kept none.
 */
const imageOf = (preview: Preview): ImageShown | undefined =>
  preview.image === null
    ? undefined
    : {
        alt: contained(
          preview.title === null || preview.title === "" ? preview.link : preview.title
        ),
        animated: preview.image.animated,
        dimensions: preview.image.dimensions ?? undefined,
        drawn: preview.kind === "player" || preview.kind === "video" ? "Poster" : "Whole",
        src: `/api/previews/images/${preview.image.hash}`,
      };

/**
 * What a stranger wrote for a part of a card, contained, or none when they wrote nothing.
 * @param text - What they wrote.
 * @returns It, or none.
 */
const wordsOf = (text: string | null): string | undefined =>
  text === null || text.trim() === "" ? undefined : contained(text);

/**
 * How many bytes a file is, in words a reader weighs at a glance: a count under a thousand
 * as `0 B` or `999 B`, and above it KB, MB, GB, or TB in powers of a
 * thousand, to one decimal below ten and whole from ten up. It rounds before it picks the
 * unit, so 999,999 B is `1.0 MB` and never `1000 KB`. Plain arithmetic, the same in
 * every locale.
 * @param bytes - A length in bytes, a whole number from zero.
 * @returns The words.
 */
const sizeWords = (bytes: number): string => {
  if (bytes < 1000) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let index = 0;
  let amount = bytes / 1000;

  // A value that rounds up to a thousand is one of the next unit.
  while (index < units.length - 1 && Math.round(amount) >= 1000) {
    index += 1;
    amount /= 1000;
  }

  const rounded = Math.round(amount * 10) / 10;

  return `${rounded < 10 ? rounded.toFixed(1) : Math.round(amount)} ${units[index]}`;
};

/**
 * A file's name as its link gives it: the last part of the path of the link the Preview
 * was read from, percent-decoded where that decodes, and as written where it does not. A
 * path with no last part, as `/` or a trailing slash, or one that is blank, is named by its
 * host.
 * @param link - The link the Preview was read from.
 * @returns The name, as a stranger wrote it, or none when the link cannot be read.
 */
const fileNameOf = (link: string): string | undefined => {
  const url = URL.parse(link);

  if (url === null) {
    return undefined;
  }

  const written = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  let name = written;

  try {
    name = decodeURIComponent(written);
  } catch {
    // Not valid percent-encoding: it is as it was written.
  }

  return name.trim() === "" ? url.hostname : name;
};

/**
 * A text file's first lines, each contained on its own so no embedding one opens reaches
 * the next, and kept apart by line breaks. Blank lines before the first and after the last
 * are dropped, and a tab is four spaces, as a control picture would hide the indentation
 * it stands for.
 * @param text - The lines, as the Daemon read them, with `\n` between.
 * @returns Them, or none when they hold nothing.
 */
const linesOf = (text: string): string | undefined => {
  if (text.trim() === "") {
    return undefined;
  }

  return text
    .replace(/^(?:[\t\r ]*\n)+/u, "")
    .trimEnd()
    .split(/\r?\n/u)
    .map((line) => contained(line.replaceAll("\t", "    ")))
    .join("\n");
};

/**
 * A file's words: its name, and then its first lines when it has them, or else its type and
 * size, each left out when the host did not give it.
 * @param preview - A Preview of kind `file`.
 * @returns Its title and description.
 */
const fileWordsOf = (preview: Preview) => {
  const name = fileNameOf(preview.link);
  const lines = preview.description === null ? undefined : linesOf(preview.description);

  const about = [
    wordsOf(preview.type),
    preview.size === null ? undefined : sizeWords(preview.size),
  ].filter((part) => part !== undefined);

  return {
    description: lines ?? (about.length === 0 ? undefined : about.join(" \u00B7 ")),
    title: name === undefined ? undefined : wordsOf(name),
  };
};

/**
 * A host as a card compares it: lower case, without a leading `www.`.
 * @param link - A link.
 * @returns Its host, or none when it cannot be read.
 */
const hostCompared = (link: string): string | undefined => {
  const host = URL.parse(link)?.hostname.toLowerCase();

  return host === undefined || host === "" ? undefined : host.replace(/^www\./u, "");
};

/**
 * The host a Preview was read from, when it is another than its Message's link's, so a
 * link that led elsewhere, as a shortened one does, says where. A leading `www.` is no
 * other host.
 * @param address - The link as its Message holds it.
 * @param read - The link the Preview was read from, after any redirects.
 * @returns The host it was read from, contained, or none when it is the same, or either
 *   cannot be read.
 */
export const hostNamed = (address: string, read: string): string | undefined => {
  const said = hostCompared(address);
  const from = hostCompared(read);

  return said === undefined || from === undefined || said === from ? undefined : contained(from);
};

/**
 * A video or a sound, a link that is itself one or a page that names a video file, as drawn: which, where the Daemon streams it
 * from, its own origin and never the host it came from, by the Message's place, and its
 * media type as the Daemon read it. Nothing is fetched until the Owner presses play.
 */
export interface MediaShown {
  readonly kind: "audio" | "video";
  readonly src: string;
  readonly type: string | null;
}

/**
 * A ready Preview's media as drawn.
 * @param preview - The Preview.
 * @param id - The Preview's id.
 * @param timeline - The Message's Timeline.
 * @param position - Its place there.
 * @returns The media, or none for any other kind.
 */
const mediaOf = (
  preview: Preview,
  id: PreviewId,
  timeline: TimelineId,
  position: Position
): MediaShown | undefined =>
  preview.kind === "video" || preview.kind === "audio"
    ? {
        kind: preview.kind,
        src: `/api/previews/${id}/stream?${new URLSearchParams([
          ["timeline", timeline],
          ["position", cursorOf(position)],
        ]).toString()}`,
        type: preview.type,
      }
    : undefined;

/**
 * How a host's player is asked to start by itself: the query parameter that does it, and its
 * value. A host not named here has none, so its link is loaded as the page gave it.
 */
const autoplayBy: ReadonlyMap<string, readonly [name: string, value: string]> = new Map([
  ["player.vimeo.com", ["autoplay", "1"]],
  ["w.soundcloud.com", ["auto_play", "true"]],
  ["www.youtube-nocookie.com", ["autoplay", "1"]],
]);

/** The shape of a box for a video or a player when nothing else says. */
const sixteenByNine: Size = { height: 9, width: 16 };

/**
 * The shape of the one box a poster, the video it plays, and the player it plays share, so
 * pressing play moves nothing below it: a player's, if its page gave one; else the
 * poster's own; else 16 by 9. Where the poster fails to load, the box keeps its shape.
 * @param playing - The player, and the poster, each if there is one.
 * @returns The box's shape.
 */
export const playsIn = (playing: {
  readonly player?: Pick<PlayerShown, "size"> | undefined;
  readonly poster?: Pick<ImageShown, "dimensions"> | undefined;
}): Size => playing.player?.size ?? playing.poster?.dimensions ?? sixteenByNine;

/**
 * A player, as drawn: the host it plays from, the words that say so, and what a frame
 * needs once the Owner presses play. A view loads `src` only then, never before, and shows
 * the frame at `size`, in CSS pixels, whose shape is all that matters, if its page gave one.
 */
export interface PlayerShown {
  readonly host: string;
  readonly words: string;
  /** The player's address, set to start playing where its host allows that. */
  readonly src: string;
  readonly size: Size | undefined;
}

/**
 * A ready Preview's player as drawn.
 * @param preview - The Preview.
 * @returns The player, or none for any other kind, or when its address cannot be read.
 */
const playerOf = (preview: Preview): PlayerShown | undefined => {
  if (preview.kind !== "player" || preview.player === null) {
    return undefined;
  }

  const url = URL.parse(preview.player.link);

  if (url === null || url.hostname === "") {
    return undefined;
  }

  const autoplay = autoplayBy.get(url.hostname);

  if (autoplay !== undefined) {
    url.searchParams.set(...autoplay);
  }

  const host = contained(url.hostname);

  return {
    host,
    size: preview.player.size ?? undefined,
    src: url.href,
    words: `plays from ${host}`,
  };
};

/**
 * A Preview as the hosts listed now allow: a player whose host the list no longer names is
 * a page again, as the Daemon answers it, so a host removed stops showing as a player at
 * once, even in a Preview answered before.
 * @param preview - The Preview, as answered.
 * @param players - The hosts `ui.previews.players` lists now.
 * @returns The Preview.
 */
const listedNow = (preview: Preview, players: PreviewsPlayers): Preview => {
  const host = preview.player === null ? undefined : URL.parse(preview.player.link)?.hostname;

  return preview.player === null || (host !== undefined && players.includes(host))
    ? preview
    : { ...preview, kind: "page", player: null };
};

/**
 * A ready Preview as its card draws it, in this order, each part only when it has it: the
 * host it was read from when another than its link's; its `title`; its `description`; and
 * its media, an image, a video or a sound, or a player. A page, and a page that names a
 * video file or a listed player, is its title and description, with its image, or its
 * poster, under them. A file is its file name, and its first lines when it is a text file
 * that has some, or else its type and size, with no media. A link that is itself an image,
 * a video, or a sound is its media alone. The site's name is never drawn, since the link stands right above. Under `text`, a
 * card is its words alone. `name` is what the card is called: its title, or else its link.
 */
export interface CardShown {
  readonly _tag: "Ready";
  readonly key: string;
  readonly link: LinkShown;
  readonly name: string;
  readonly host: string | undefined;
  readonly title: string | undefined;
  readonly description: string | undefined;
  readonly image: ImageShown | undefined;
  readonly media: MediaShown | undefined;
  readonly player: PlayerShown | undefined;
}

/**
 * One Preview, as drawn:
 *
 * - `Pending`: a placeholder in its card's place, while it is fetched, before it is
 *   asked for, or while a link the Daemon holds for a press is pressed.
 * - `Ready`: its card.
 * - `Failed`: one line of why there is none, and never the link again.
 *
 * Its `key` is its index among the Message's links that may be previewed, as text.
 */
export type PreviewShown =
  | { readonly _tag: "Pending"; readonly key: string; readonly link: LinkShown }
  | CardShown
  | { readonly _tag: "Failed"; readonly key: string; readonly reason: string };

/**
 * A ready Preview's card.
 * @param preview - The Preview, as the hosts listed now allow.
 * @param id - Its id.
 * @param address - The link as its Message holds it.
 * @param key - Its key among its Message's.
 * @param on - Whether Previews are `on`, as media is shown only then.
 * @param timeline - The Message's Timeline.
 * @param position - Its place there.
 * @returns The card, or none when it would hold nothing.
 */
const cardOf = (
  preview: Preview,
  id: PreviewId,
  address: string,
  key: string,
  on: boolean,
  timeline: TimelineId,
  position: Position
): CardShown | undefined => {
  const link = linkShown(address);

  // Only a page and a file have words: the Daemon gives a link that is itself media neither.
  const { description, title } =
    preview.kind === "file"
      ? fileWordsOf(preview)
      : { description: wordsOf(preview.description), title: wordsOf(preview.title) };

  const image = on ? imageOf(preview) : undefined;
  const media = on ? mediaOf(preview, id, timeline, position) : undefined;
  const player = on ? playerOf(preview) : undefined;

  // The host it was read from says nothing on its own.
  if ([title, description, image, media, player].every((part) => part === undefined)) {
    return undefined;
  }

  return {
    _tag: "Ready",
    description,
    host: hostNamed(address, preview.link),
    image,
    key,
    link,
    media,
    name: title ?? link.text,
    player,
    title,
  };
};

/**
 * An item as drawn, under the link its Message holds, which may differ from the item's
 * by a fragment the id leaves out.
 * @param item - The item.
 * @param address - The link as the Message holds it.
 * @param index - Which of its Message's links it is.
 * @param on - Whether Previews are `on`, as media is shown only then.
 * @param players - The hosts `ui.previews.players` lists now.
 * @param timeline - The Message's Timeline.
 * @param position - Its place there.
 * @returns It, or none for a ready one whose card would hold nothing.
 */
const itemShown = (
  item: PreviewItem,
  address: string,
  index: number,
  on: boolean,
  players: PreviewsPlayers,
  timeline: TimelineId,
  position: Position
): PreviewShown | undefined => {
  const key = String(index);

  switch (item.state._tag) {
    case "Pending": {
      return { _tag: "Pending", key, link: linkShown(address) };
    }

    case "Ready": {
      const preview = listedNow(item.state.preview, players);

      return cardOf(preview, item.id, address, key, on, timeline, position);
    }

    case "Failed": {
      return { _tag: "Failed", key, reason: reasonWords(item.state.reason) };
    }

    // Drawn only while open, which presses it.
    case "WaitingForPress": {
      return { _tag: "Pending", key, link: linkShown(address) };
    }

    default: {
      return item.state satisfies never;
    }
  }
};

/**
 * The text a Message's links are found in: as it was said, or, for one of ours the Ircd
 * confirmed, as the Ircd gave it back, which is what a view draws.
 * @param content - The item's content.
 * @returns The text, or none for anything but a Message.
 */
const messageText = (content: ItemContent): string | undefined => {
  if (content._tag !== "Message") {
    return undefined;
  }

  const delivery = content.ours?.delivery;

  return delivery?._tag === "Confirmed" ? delivery.text : content.text;
};

/**
 * Whether a Message may have Previews at all: one that holds a link that may be previewed,
 * while its Timeline's mode asks. Only such a Message is watched for coming into view.
 * @param mode - Its Timeline's mode, once known.
 * @param content - The item's content.
 * @returns Whether it may.
 */
export const mayPreview = (mode: PreviewsShown | undefined, content: ItemContent): boolean => {
  const text = messageText(content);

  return asksFor(mode) && text !== undefined && previewableLinksOf(text).length > 0;
};

/**
 * A link without its fragment, as an id is made of it.
 * @param href - The link.
 * @returns It, without a fragment.
 */
const withoutFragment = (href: string): string => {
  const at = href.indexOf("#");

  return at === -1 ? href : href.slice(0, at);
};

/**
 * What a Message shows below it: nothing while its Timeline's mode does not ask, or for a Message
 * with no link that may be previewed, or one the Daemon refused; the items the Daemon
 * answered with, as each is now, but a card that would hold nothing; and before then, a
 * placeholder for each link.
 * @param state - The state.
 * @param mode - Its Timeline's mode, once known.
 * @param timeline - The Message's Timeline.
 * @param position - Its place.
 * @param content - What it holds.
 * @param players - The hosts `ui.previews.players` lists now.
 * @returns Its Previews, in its order.
 */
export const previewsOf = (
  state: Previews,
  mode: PreviewsShown | undefined,
  timeline: TimelineId,
  position: Position,
  content: ItemContent,
  players: PreviewsPlayers
): readonly PreviewShown[] => {
  const text = messageText(content);

  if (!asksFor(mode) || text === undefined) {
    return [];
  }

  const key = messageKey(timeline, position);
  const held = state.messages.get(key);

  if (held?.asking === "Refused") {
    return [];
  }

  const found = previewableLinksOf(text);

  // The answer's items are the Message's links, one for one, but an id leaves out a link's
  // fragment, so each Message draws its own links and shares only the state.
  if (held?.ids !== undefined) {
    return held.ids.flatMap((id, index) => {
      const item = state.items.get(id);

      const shown =
        item === undefined
          ? undefined
          : itemShown(
              item.item,
              found[index]?.href ?? item.item.link,
              index,
              mode === "on",
              players,
              timeline,
              position
            );

      return shown === undefined ? [] : [shown];
    });
  }

  // Before an answer, what a held read gave, and a placeholder for a link it held nothing of.
  const read = state.held.get(key);

  return found.flatMap((link, index): PreviewShown[] => {
    const id = read?.[index];
    const item = id === undefined ? undefined : state.items.get(id);

    // The read was of the Message as it was, so an item is drawn only under its own link: an
    // Ircd's echo may have changed the text since, and an id leaves out a fragment.
    if (item === undefined || withoutFragment(item.item.link) !== withoutFragment(link.href)) {
      return [{ _tag: "Pending", key: String(index), link: linkShown(link.href) }];
    }

    const shown = itemShown(
      item.item,
      link.href,
      index,
      mode === "on",
      players,
      timeline,
      position
    );

    return shown === undefined ? [] : [shown];
  });
};

/**
 * Which of a Message's links that may be previewed has its toggle after it, among the
 * runs of its text as drawn: the first run that is each such link, by the run's index, with
 * the link's index among those that may be previewed.
 * @param runs - The runs of its text, a link's with its `href`.
 * @param content - What the Message holds.
 * @returns Each toggle's link, by the index of the run it follows.
 */
export const togglesIn = (
  runs: readonly { readonly _tag: string; readonly href?: string }[],
  content: ItemContent
): ReadonlyMap<number, number> => {
  const text = messageText(content);
  const hrefs = text === undefined ? [] : previewableLinksOf(text).map((link) => link.href);
  const toggles = new Map<number, number>();
  const placed = new Set<number>();

  for (const [run, { href }] of runs.entries()) {
    const link = href === undefined ? -1 : hrefs.indexOf(href);

    if (link !== -1 && !placed.has(link)) {
      placed.add(link);
      toggles.set(run, link);
    }
  }

  return toggles;
};

/**
 * How many links a Message holds that may be previewed, each with a toggle after it.
 * @param content - What the Message holds.
 * @returns How many.
 */
export const previewableCount = (content: ItemContent): number => {
  const text = messageText(content);

  return text === undefined ? 0 : previewableLinksOf(text).length;
};
