/**
 * Previews, as a Frontend holds them: which Messages were shown and so may be asked for,
 * what the Daemon answered for each, and each Preview by its id, kept up to date by the
 * stream of their changes. A Message is asked for only once it was shown, and only once
 * while the stream is followed, since the Daemon fetches on the ask. Whether a Message is
 * asked for, and what it shows, follows its Timeline's own mode: its choice in
 * `ui.previews.timelines`, or else `ui.previews`. A link the Daemon holds for a press is
 * fetched only once the Owner presses it. What each Message shows, the summary line, and a
 * failure's words are derived as it is drawn, never held.
 *
 * @packageDocumentation
 */
import type {
  ItemContent,
  Preview,
  PreviewFailure,
  PreviewId,
  PreviewItem,
  PreviewsByTimeline,
  PreviewsPlayers,
  PreviewsShown,
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
 * One Message shown: where it is, where its asking stands, the ids the Daemon answered
 * with, in the Message's order, kept while it is asked again, and its Timeline's own
 * choice when it was last asked for, which a link waiting for a press is answered by.
 */
interface MessageHeld {
  readonly timeline: TimelineId;
  readonly position: Position;
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
 * What a Frontend holds of Previews: each Message shown, by `messageKey`; each item by its
 * id; how many changes the stream gave, which orders a change against an answer; and
 * whether the stream is followed now, which an ask waits for, so no change it starts is
 * missed.
 */
export interface Previews {
  readonly messages: ReadonlyMap<string, MessageHeld>;
  readonly items: ReadonlyMap<PreviewId, ItemHeld>;
  readonly tick: number;
  readonly following: boolean;
}

/** Nothing shown, nothing held, and the stream not followed. */
export const initialPreviews: Previews = {
  following: false,
  items: new Map(),
  messages: new Map(),
  tick: 0,
};

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
 * - `Shown`: a Message came into view.
 * - `Asked`: the runtime began an ask.
 * - `Answered`: the Daemon answered an ask with the Message's items.
 * - `Refused`: the Daemon refused an ask for good: no such Timeline or Message, or Previews
 *   are off.
 * - `Pressed`: the Daemon answered a press with the link's item.
 * - `PressRefused`: the Daemon refused a press, as the link was not waiting for one, so
 *   its Message is asked for again, to draw what the Daemon holds.
 * - `Followed`: the stream is followed, from now.
 * - `Changed`: the stream gave an item as it is now.
 * - `Lost`: the stream is no longer followed, and every ask in flight was let go of.
 * - `Forgotten`: the page signed out.
 */
export type PreviewsEvent =
  | { readonly _tag: "Shown"; readonly timeline: TimelineId; readonly position: Position }
  | { readonly _tag: "Asked"; readonly ask: PreviewsAsk }
  | {
      readonly _tag: "Answered";
      readonly ask: PreviewsAsk;
      readonly previews: readonly PreviewItem[];
    }
  | { readonly _tag: "Refused"; readonly ask: PreviewsAsk }
  | { readonly _tag: "Pressed"; readonly press: PreviewsPress; readonly item: PreviewItem }
  | { readonly _tag: "PressRefused"; readonly press: PreviewsPress }
  | { readonly _tag: "Followed" }
  | { readonly _tag: "Changed"; readonly item: PreviewItem }
  | { readonly _tag: "Lost" }
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
        timelines: shared.options["previews.timelines"],
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
 * Whether a Frontend asks for a Timeline's Previews: under `links only` or `on`, never
 * under `off`, and never before the mode is known.
 * @param mode - The Timeline's mode.
 * @returns Whether it asks.
 */
export const asksFor = (mode: PreviewsShown | undefined): boolean =>
  mode === "links only" || mode === "on";

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
 * Only the items some answered Message names, unless an ask is in flight, whose answer may
 * name any.
 * @param state - The state.
 * @returns It, holding no item no Message shows.
 */
const pruned = (state: Previews): Previews => {
  const messages = [...state.messages.values()];

  if (messages.some((held) => held.asking === "Asking")) {
    return state;
  }

  const named = new Set(messages.flatMap((held) => held.ids ?? []));

  return {
    ...state,
    items: new Map([...state.items].filter(([id]) => named.has(id))),
  };
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
 * that one after the ask began, which is then newer than the answer.
 * @param state - The state.
 * @param since - The stream's count when the ask began.
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
 * Folds one event in. A Message is wanted once, when first shown, and asked for only while
 * the stream is followed. An answer is taken only by the ask in flight, though its items
 * are folded in whenever it lands, each unless the stream changed it since. A change is
 * held only for an item a Message names, or while an ask is in flight. When the stream is
 * lost, every Message still waiting on a Preview, or on its answer, is wanted again, to
 * be asked once it is followed again.
 * @param state - The state.
 * @param event - What happened.
 * @returns The state now.
 */
export const reducePreviews = (state: Previews, event: PreviewsEvent): Previews => {
  switch (event._tag) {
    case "Shown": {
      const key = messageKey(event.timeline, event.position);

      return state.messages.has(key)
        ? state
        : withMessage(state, key, {
            asking: "Wanted",
            chosen: undefined,
            ids: undefined,
            position: event.position,
            since: 0,
            timeline: event.timeline,
          });
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
          : withMessage({ ...state, items }, event.ask.key, {
              ...held,
              asking: "Answered",
              ids: event.previews.map((item) => item.id),
            });

      return pruned(answered);
    }

    case "Refused": {
      const held = askedOf(state, event.ask);

      return held === undefined
        ? state
        : pruned(withMessage(state, event.ask.key, { ...held, asking: "Refused" }));
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
      const { item } = event;
      const tick = state.tick + 1;

      const named =
        state.items.has(item.id) ||
        [...state.messages.values()].some((held) => held.asking === "Asking");

      return named
        ? { ...state, items: new Map(state.items).set(item.id, { item, tick }), tick }
        : { ...state, tick };
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

    case "Forgotten": {
      return initialPreviews;
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * The asks to make now, while the stream is followed, and none otherwise: each Message
 * wanted whose Timeline's mode asks, and each holding a link waiting for a press whose
 * Timeline has since chosen a mode of its own that asks, which the Daemon then fetches
 * unpressed.
 * @param state - The state.
 * @param modes - The modes, once read.
 * @returns The asks.
 */
export const asksWanted = (
  state: Previews,
  modes: PreviewsModes | undefined
): readonly PreviewsAsk[] =>
  state.following
    ? [...state.messages].flatMap(([key, held]) => {
        const chosen = chosenIn(modes, held.timeline);

        const wanted =
          held.asking === "Wanted" ||
          (held.asking === "Answered" &&
            asksFor(chosen) &&
            held.chosen !== chosen &&
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
 * A failure's reason, in words, as a hover says it.
 * @param reason - The reason.
 * @returns The words.
 */
export const reasonWords = (reason: PreviewFailure): string => {
  switch (reason) {
    case "Refused": {
      return "No preview: the Daemon never fetches this address.";
    }

    case "Unreachable": {
      return "No preview: the Daemon could not reach this link.";
    }

    case "TimedOut": {
      return "No preview: this link took too long to answer.";
    }

    case "TooLarge": {
      return "No preview: this link's answer was too large to read.";
    }

    case "NothingToShow": {
      return "No preview: this link had nothing to show.";
    }

    default: {
      return reason satisfies never;
    }
  }
};

/** What a link to media itself is called in its summary. */
const kindWords = { audio: "sound", image: "image", video: "video" } as const;

/**
 * A ready Preview's summary, its one line: a page's site and title, or the site alone with
 * no title, as a player's is too, and a link to media itself as what it is, its type, and
 * its site. Every part a stranger wrote is contained.
 * @param preview - The Preview.
 * @returns The line.
 */
export const summaryOf = (preview: Preview): string => {
  const site = contained(preview.site);

  // A player is its page's summary: what it plays is its title, and where it plays from is
  // said by its play button.
  if (preview.kind === "page" || preview.kind === "player") {
    return preview.title === null ? site : `${site} · ${contained(preview.title)}`;
  }

  const parts = [kindWords[preview.kind], preview.type, preview.title];

  return [
    ...parts.flatMap((part) => (part === null || part === "" ? [] : [contained(part)])),
    site,
  ].join(" · ");
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

/**
 * An image a Preview shows, as drawn: what it is said to show, the Preview's title or else
 * its link; where the Daemon serves it, from its own origin and never the host it came
 * from; whether it moves; and how it is drawn, `Thumbnail` beside a page's summary,
 * `Whole` for a link that is itself the image, or `Poster` for a player's or a video's,
 * which a play button is drawn over.
 */
export interface ImageShown {
  readonly alt: string;
  readonly animated: boolean;
  readonly drawn: "Poster" | "Thumbnail" | "Whole";
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
 * How a Preview's image is drawn, by what the Preview is.
 * @param kind - The Preview's kind.
 * @returns How its image is drawn.
 */
const drawnOf = (kind: Preview["kind"]): ImageShown["drawn"] => {
  switch (kind) {
    case "image": {
      return "Whole";
    }

    case "player":
    case "video": {
      return "Poster";
    }

    case "page":
    case "audio": {
      return "Thumbnail";
    }

    default: {
      return kind satisfies never;
    }
  }
};

/**
 * A ready Preview's image as drawn.
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
        drawn: drawnOf(preview.kind),
        src: `/api/previews/media/${preview.image.hash}`,
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

/** The size of a player whose page gave none. */
const defaultPlayerSize = { height: 9, width: 16 } as const;

/**
 * A player, as drawn: the host it plays from, the words that say so, and what a frame
 * needs once the Owner presses play. A view loads `src` only then, never before, and shows
 * the frame at `size`, in CSS pixels, whose shape is all that matters.
 */
export interface PlayerShown {
  readonly host: string;
  readonly words: string;
  /** The player's address, set to start playing where its host allows that. */
  readonly src: string;
  readonly size: { readonly height: number; readonly width: number };
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
    size: preview.player.size ?? defaultPlayerSize,
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
 * One Preview, as drawn:
 *
 * - `Pending`: a pulsing placeholder, while it is fetched or before it is asked for.
 * - `Ready`: its summary, opening to its description when it has one, its image when the
 *   Daemon kept one, for a video or a sound, its media, and for a player, where it plays
 *   from. A video's image is its poster. Images, media, and players are shown only under
 *   `on`.
 * - `Plain`: the plain link, with why there is no Preview, when it failed.
 * - `Waiting`: the plain link, and a press that fetches it, by its `index` among the
 *   Message's links, as the Daemon holds it until the Owner presses.
 */
export type PreviewShown =
  | { readonly _tag: "Pending"; readonly key: string; readonly link: LinkShown }
  | {
      readonly _tag: "Ready";
      readonly key: string;
      readonly link: LinkShown;
      readonly summary: string;
      readonly description: string | undefined;
      readonly image: ImageShown | undefined;
      readonly media: MediaShown | undefined;
      readonly player: PlayerShown | undefined;
    }
  | {
      readonly _tag: "Plain";
      readonly key: string;
      readonly link: LinkShown;
      readonly reason: string | undefined;
    }
  | {
      readonly _tag: "Waiting";
      readonly key: string;
      readonly link: LinkShown;
      readonly index: number;
    };

/**
 * An item as drawn, under the link its Message holds, which may differ from the item's
 * by a fragment the id leaves out.
 * @param item - The item.
 * @param address - The link as the Message holds it.
 * @param index - Which of its Message's links it is.
 * @param on - Whether Previews are `on`, as images and media are shown only then.
 * @param players - The hosts `ui.previews.players` lists now.
 * @param timeline - The Message's Timeline.
 * @param position - Its place there.
 * @returns It.
 */
const itemShown = (
  item: PreviewItem,
  address: string,
  index: number,
  on: boolean,
  players: PreviewsPlayers,
  timeline: TimelineId,
  position: Position
): PreviewShown => {
  const link = linkShown(address);
  const key = String(index);

  switch (item.state._tag) {
    case "Pending": {
      return { _tag: "Pending", key, link };
    }

    case "Ready": {
      const preview = listedNow(item.state.preview, players);

      return {
        _tag: "Ready",
        description:
          preview.description === null || preview.description === ""
            ? undefined
            : contained(preview.description),
        image: on ? imageOf(preview) : undefined,
        key,
        link,
        media: on ? mediaOf(preview, item.id, timeline, position) : undefined,
        player: on ? playerOf(preview) : undefined,
        summary: summaryOf(preview),
      };
    }

    case "Failed": {
      return { _tag: "Plain", key, link, reason: reasonWords(item.state.reason) };
    }

    case "WaitingForPress": {
      return { _tag: "Waiting", index, key, link };
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
 * What a Message shows below it: nothing while its Timeline's mode does not ask, or for a Message
 * with no link that may be previewed, or one the Daemon refused; the items the Daemon
 * answered with, as each is now; and before then, a placeholder for each link, so the
 * Message's height is the same once it is answered.
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

  const held = state.messages.get(messageKey(timeline, position));

  if (held?.asking === "Refused") {
    return [];
  }

  const found = previewableLinksOf(text);

  // The answer's items are the Message's links, one for one, but an id leaves out a link's
  // fragment, so each Message draws its own links and shares only the state.
  if (held?.ids !== undefined) {
    return held.ids.flatMap((id, index) => {
      const item = state.items.get(id);

      return item === undefined
        ? []
        : [
            itemShown(
              item.item,
              found[index]?.href ?? item.item.link,
              index,
              mode === "on",
              players,
              timeline,
              position
            ),
          ];
    });
  }

  return found.map((link, index) => ({
    _tag: "Pending",
    key: String(index),
    link: linkShown(link.href),
  }));
};
