/**
 * The fold: each step's News in, the changes a store applies out. The fold holds only the
 * directory of Timelines, which News finds them by, so its state stays small. Everything
 * that grows with history, items and what they are found by, is the store's.
 *
 * @packageDocumentation
 */
import type { Instant, Marked, MessageId, Named, News, RefusedAction, Where } from "@iirc/client";
import type { Casemapping, Fact } from "@iirc/client/known";
import { casefold } from "@iirc/protocol/casemapping";

import type { Change } from "./change.ts";
import type { Content, Level } from "./content.ts";
import type { Position } from "./position.ts";
import { timelineIdOf } from "./timeline.ts";
import type { Kind, TimelineId } from "./timeline.ts";

/**
 * The version of the projection. Bump it whenever News or the fold changes what it
 * gives, so a store built by another version is reset and folded again from the Journal.
 */
export const projectionVersion = 6;

/**
 * What one step to one Network made happen, as the Runtime's News stream gives it: its
 * Network, the sequence of its Input, the Input's `at`, and its News, in order.
 */
export interface Happened {
  readonly network: string;
  readonly sequence: number;
  readonly at: Instant;
  readonly news: readonly News[];
}

/** A Channel or Direct Message Timeline that News can still find, by its key. */
export interface Keyed {
  readonly id: TimelineId;
  readonly kind: Exclude<Kind, "Network">;
  readonly name: string;
  readonly key: string;
  /** How far the Owner has read it, or `undefined` before any Read Marker. */
  readonly read: Instant | undefined;
}

/** What the fold keeps for one Network. */
export interface NetworkDirectory {
  /** The Network's own Timeline. */
  readonly timeline: TimelineId;
  /** How far the Owner has read the Network's own Timeline, or `undefined` before any Read Marker. */
  readonly read: Instant | undefined;
  /** Each Channel and Direct Message Timeline that has a key, by id. */
  readonly keyed: ReadonlyMap<TimelineId, Keyed>;
  /** Channel Timelines, by key. */
  readonly channels: ReadonlyMap<string, TimelineId>;
  /** Direct Message Timelines, by key. */
  readonly directs: ReadonlyMap<string, TimelineId>;
  /** Where the Gap the Network is in began, while it is in one. */
  readonly gap: Position | undefined;
  /** The last step folded for the Network, as a position, where a Gap begins when the Daemon restarts. */
  readonly last: Position;
}

/** The fold's state: the Timelines News can find, for each Network. Plain data. */
export interface Directory {
  readonly networks: ReadonlyMap<string, NetworkDirectory>;
}

/** The directory before any step. */
export const emptyDirectory: Directory = { networks: new Map() };

/** What one step gives: the directory after it, and the changes for a store, in order. */
export interface Stepped {
  readonly directory: Directory;
  readonly changes: readonly Change[];
}

interface Maps {
  keyed: Map<TimelineId, Keyed>;
  channels: Map<string, TimelineId>;
  directs: Map<string, TimelineId>;
}

// One step's work on one Network. The maps are shared with the directory given until the
// step first changes one, and copied then, so a step that opens nothing copies nothing.
interface Draft {
  readonly network: string;
  readonly sequence: number;
  readonly at: Instant;
  readonly timeline: TimelineId;
  readonly last: Position | undefined;
  readonly changes: Change[];
  maps: {
    readonly keyed: ReadonlyMap<TimelineId, Keyed>;
    readonly channels: ReadonlyMap<string, TimelineId>;
    readonly directs: ReadonlyMap<string, TimelineId>;
  };
  written: Maps | undefined;
  gap: Position | undefined;
  read: Instant | undefined;
}

const write = (draft: Draft): Maps => {
  if (draft.written === undefined) {
    draft.written = {
      channels: new Map(draft.maps.channels),
      directs: new Map(draft.maps.directs),
      keyed: new Map(draft.maps.keyed),
    };
    draft.maps = draft.written;
  }

  return draft.written;
};

const describe = (draft: Draft, kind: Kind, id: TimelineId, name: string, key: string | null) => {
  draft.changes.push({
    _tag: "Described",
    sequence: draft.sequence,
    timeline: { id, key, kind, name, network: draft.network },
  });
};

const byKind = (maps: Maps, kind: Keyed["kind"]) =>
  kind === "Channel" ? maps.channels : maps.directs;

/**
 * Opens a Timeline, keyed as News named it.
 * @param draft - The step.
 * @param kind - A Channel's or a Direct Message partner's.
 * @param named - Its key and name.
 * @param n - The News's index in the step.
 * @param w - The index of the `where` entry that opens it.
 * @returns Its id.
 */
const open = (draft: Draft, kind: Keyed["kind"], named: Named, n: number, w: number) => {
  const id = timelineIdOf(draft.sequence, n, w + 1);
  const maps = write(draft);

  maps.keyed.set(id, { id, key: named.key, kind, name: named.name, read: undefined });
  byKind(maps, kind).set(named.key, id);
  describe(draft, kind, id, named.name, named.key);

  return id;
};

/**
 * Moves a Direct Message Timeline to its partner's new nick. A Timeline already keyed by
 * the new nick is detached, since nothing says it is the same person: it keeps its id,
 * name, and items, and receives nothing more.
 * @param draft - The step.
 * @param where - The rename.
 * @returns The Timeline that takes the item, or `undefined` when none is keyed by the old nick.
 */
const rename = (
  draft: Draft,
  where: Extract<Where, { readonly _tag: "DirectRenamed" }>
): TimelineId | undefined => {
  const id = draft.maps.directs.get(where.key);
  const entry = id === undefined ? undefined : draft.maps.keyed.get(id);

  if (entry === undefined) {
    return entry;
  }

  if (entry.key === where.to.key && entry.name === where.to.name) {
    return entry.id;
  }

  const maps = write(draft);
  const other = maps.directs.get(where.to.key);
  const detached = other === undefined ? undefined : maps.keyed.get(other);

  if (detached !== undefined && detached.id !== entry.id) {
    maps.keyed.delete(detached.id);
    describe(draft, "Direct", detached.id, detached.name, null);
  }

  maps.directs.delete(entry.key);
  maps.directs.set(where.to.key, entry.id);
  maps.keyed.set(entry.id, { ...entry, key: where.to.key, name: where.to.name });
  describe(draft, "Direct", entry.id, where.to.name, where.to.key);

  return entry.id;
};

/**
 * The Timeline one `where` entry names, opened when it may be.
 * @param draft - The step.
 * @param where - The entry.
 * @param n - The News's index in the step.
 * @param w - The entry's index in `where`.
 * @returns The Timeline, or `undefined` when the entry touches only one that does not exist.
 */
const resolve = (draft: Draft, where: Where, n: number, w: number): TimelineId | undefined => {
  switch (where._tag) {
    case "Network": {
      return draft.timeline;
    }

    case "Channel": {
      return draft.maps.channels.get(where.key) ?? open(draft, "Channel", where, n, w);
    }

    case "Direct": {
      const found = draft.maps.directs.get(where.key);

      return found ?? (where.existing ? undefined : open(draft, "Direct", where, n, w));
    }

    case "DirectRenamed": {
      return rename(draft, where);
    }

    default: {
      return where satisfies never;
    }
  }
};

const later = (left: Instant | undefined, right: Instant | undefined) =>
  left === undefined || (right !== undefined && right > left) ? right : left;

const marked = (draft: Draft, timeline: TimelineId, read: Instant) => {
  draft.changes.push({
    _tag: "ReadMarker",
    network: draft.network,
    read,
    sequence: draft.sequence,
    timeline,
  });
};

/**
 * Folds every keyed Timeline's name again by a new casemapping. Of Timelines whose keys
 * now meet, the first opened is kept, and each other is merged into it, which has then
 * been read as far as either.
 * @param draft - The step.
 * @param casemapping - The mapping keys fold by from now on.
 */
const refold = (draft: Draft, casemapping: Casemapping) => {
  // Ids sort in the order the Timelines were opened.
  const entries = [...draft.maps.keyed.values()].toSorted((left, right) =>
    left.id < right.id ? -1 : 1
  );

  const next: Pick<Maps, "channels" | "directs"> = { channels: new Map(), directs: new Map() };
  let changed = false;

  for (const entry of entries) {
    const key = casefold(casemapping, entry.name);
    const keys = entry.kind === "Channel" ? next.channels : next.directs;
    const into = keys.get(key);

    if (into === undefined) {
      keys.set(key, entry.id);

      if (key !== entry.key) {
        changed = true;
        write(draft).keyed.set(entry.id, { ...entry, key });
        describe(draft, entry.kind, entry.id, entry.name, key);
      }
    } else {
      changed = true;

      const maps = write(draft);
      const kept = maps.keyed.get(into);

      maps.keyed.delete(entry.id);
      draft.changes.push({
        _tag: "Merged",
        from: entry.id,
        into,
        network: draft.network,
        sequence: draft.sequence,
      });

      const read = later(kept?.read, entry.read);

      if (kept !== undefined && read !== undefined && read !== kept.read) {
        maps.keyed.set(into, { ...kept, read });
        marked(draft, into, read);
      }
    }
  }

  if (changed) {
    const maps = write(draft);

    maps.channels = next.channels;
    maps.directs = next.directs;
  }
};

const instantOf = (fact: Fact<Instant>, otherwise: Instant): Instant => {
  if (fact._tag === "Known") {
    return fact.value;
  }

  return fact._tag === "Stale" ? fact.was : otherwise;
};

const idOf = (fact: Fact<MessageId>): MessageId | undefined =>
  fact._tag === "Known" ? fact.value : undefined;

type Routed = Extract<News, { readonly where: readonly Where[] }>;

const contentOf = (news: Routed): Content => {
  if (news._tag === "Activity") {
    return { _tag: "Activity", activity: news.activity, at: news.at, id: news.id, live: news.live };
  }

  return {
    _tag: "Message",
    at: news.at,
    id: news.id,
    kind: news.kind,
    live: news.live,
    ours:
      news.ours === undefined
        ? undefined
        : {
            delivery: { _tag: news.ours.echo ? "Pending" : "Unconfirmed" },
            intent: news.ours.intent,
          },
    sender: news.sender,
    tags: [...news.tags],
    target: news.target,
    text: news.text,
  };
};

const kindOf = (where: Where): Kind => {
  switch (where._tag) {
    case "Network":
    case "Channel": {
      return where._tag;
    }

    case "Direct":
    case "DirectRenamed": {
      return "Direct";
    }

    default: {
      return where satisfies never;
    }
  }
};

/**
 * How much a Message or an Activity calls for the Owner in one Timeline.
 * @param news - The News.
 * @param kind - The Timeline's kind.
 * @returns Its level, or `undefined` for a Message Self said.
 */
const levelOf = (news: Routed, kind: Kind): Level | undefined => {
  if (news._tag === "Activity") {
    return "Activity";
  }

  if (news.self || news.ours !== undefined) {
    return undefined;
  }

  if (news.highlight) {
    return "Highlight";
  }

  switch (kind) {
    case "Direct": {
      return "Direct";
    }

    case "Channel": {
      return "Message";
    }

    case "Network": {
      return "Activity";
    }

    default: {
      return kind satisfies never;
    }
  }
};

const add = (
  draft: Draft,
  timeline: TimelineId,
  position: Position,
  content: Content,
  routed: Routed | undefined,
  level: Level | undefined
) => {
  draft.changes.push({
    _tag: "Added",
    content,
    intent: routed?._tag === "Message" ? routed.ours?.intent : undefined,
    level,
    messageId: routed === undefined ? undefined : idOf(routed.id),
    network: draft.network,
    position,
    sequence: draft.sequence,
    timeline,
  });
};

/**
 * Places a Message or an Activity in each Timeline its `where` names, once each.
 * @param draft - The step.
 * @param news - The News.
 * @param n - Its index in the step.
 */
const place = (draft: Draft, news: Routed, n: number) => {
  const position: Position = { at: instantOf(news.at, draft.at), n, sequence: draft.sequence };
  const content = contentOf(news);
  const touched = new Set<TimelineId>();

  for (const [w, where] of news.where.entries()) {
    const timeline = resolve(draft, where, n, w);

    if (timeline !== undefined && !touched.has(timeline)) {
      touched.add(timeline);
      add(draft, timeline, position, content, news, levelOf(news, kindOf(where)));
    }
  }
};

/**
 * Moves the Read Marker of the Timeline `where` names forward, and only forward, whatever
 * the News says. Marking read opens no Timeline.
 * @param draft - The step.
 * @param where - The Timeline.
 * @param read - How far the Owner has read it.
 */
const mark = (draft: Draft, where: Marked, read: Instant) => {
  if (where._tag === "Network") {
    if (later(draft.read, read) !== draft.read) {
      draft.read = read;
      marked(draft, draft.timeline, read);
    }

    return;
  }

  const id = (where._tag === "Channel" ? draft.maps.channels : draft.maps.directs).get(where.key);
  const entry = id === undefined ? undefined : draft.maps.keyed.get(id);

  if (entry !== undefined && later(entry.read, read) !== entry.read) {
    write(draft).keyed.set(entry.id, { ...entry, read });
    marked(draft, entry.id, read);
  }
};

/**
 * Places an action's refusal that came after it left, `Rejected` or `Unsent`, in the
 * Timeline it belongs to, at the step's time, with no level: it is ours, and never
 * unread. One refused in the step that took it, `Offline` or `Unsendable`, places nothing,
 * as a `Say`'s does: whoever acted heard so in the answer.
 * @param draft - The step.
 * @param news - The refusal.
 * @param action - What it tried, and where it belongs.
 * @param n - Its index in the step.
 */
const refuseAction = (
  draft: Draft,
  news: Extract<News, { readonly _tag: "Refused" }>,
  action: RefusedAction,
  n: number
) => {
  const { reason } = news;

  if (reason._tag !== "Rejected" && reason._tag !== "Unsent") {
    return;
  }

  const timeline = resolve(draft, action.where, n, 0);

  if (timeline !== undefined) {
    add(
      draft,
      timeline,
      { at: draft.at, n, sequence: draft.sequence },
      {
        _tag: "ActionRefused",
        at: draft.at,
        attempted: action.attempted,
        intent: news.intent,
        reason,
      },
      undefined,
      undefined
    );
  }
};

const gap = (draft: Draft, from: Position, to: Position | undefined) => {
  draft.changes.push({ _tag: "Gap", from, network: draft.network, sequence: draft.sequence, to });
};

/**
 * A refusal: an action's placed where it belongs, and a `Say`'s marks its Message, when it
 * came after the Line left.
 * @param draft - The step.
 * @param news - The refusal.
 * @param n - Its index in the step.
 */
const refused = (draft: Draft, news: Extract<News, { readonly _tag: "Refused" }>, n: number) => {
  if (news.action !== undefined) {
    refuseAction(draft, news, news.action, n);
  } else if (news.reason._tag === "Unsent") {
    draft.changes.push({
      _tag: "Unsent",
      intent: news.intent,
      network: draft.network,
      sequence: draft.sequence,
    });
  } else if (news.reason._tag === "Rejected") {
    draft.changes.push({
      _tag: "Rejected",
      intent: news.intent,
      network: draft.network,
      reply: news.reason.reply,
      sequence: draft.sequence,
    });
  }
};

/**
 * What the Client learned of a Channel shows in no item, only in its head, which a
 * Frontend reads again. A Channel with no Timeline yet has nothing to read again, so it
 * opens none.
 * @param draft - The step.
 * @param key - The Channel's key.
 */
const learned = (draft: Draft, key: string) => {
  const id = draft.maps.channels.get(key);

  if (id !== undefined && draft.maps.keyed.has(id)) {
    draft.changes.push({
      _tag: "HeadChanged",
      network: draft.network,
      sequence: draft.sequence,
      timeline: id,
    });
  }
};

/**
 * Folds one News.
 * @param draft - The step.
 * @param news - The News.
 * @param n - Its index in the step.
 */
const foldNews = (draft: Draft, news: News, n: number) => {
  switch (news._tag) {
    case "Message":
    case "Activity": {
      place(draft, news, n);

      break;
    }

    case "Confirmed": {
      draft.changes.push({
        _tag: "Confirmed",
        at: news.at,
        id: news.id,
        intent: news.intent,
        messageId: idOf(news.id),
        network: draft.network,
        sequence: draft.sequence,
        text: news.text,
      });

      break;
    }

    case "Refused": {
      refused(draft, news, n);

      break;
    }

    case "SessionBegan": {
      const position: Position = { at: news.at, n, sequence: draft.sequence };

      add(
        draft,
        draft.timeline,
        position,
        { _tag: "SessionBegan", at: news.at, nick: news.nick },
        undefined,
        "Activity"
      );

      if (draft.gap !== undefined) {
        gap(draft, draft.gap, position);
        draft.gap = undefined;
      }

      break;
    }

    case "SessionEnded":
    case "ConnectionFailed": {
      const position: Position = { at: news.at, n, sequence: draft.sequence };

      add(
        draft,
        draft.timeline,
        position,
        news._tag === "ConnectionFailed"
          ? {
              _tag: news._tag,
              at: news.at,
              ircd: news.ircd,
              opened: news.opened,
              reason: news.reason,
            }
          : { _tag: news._tag, at: news.at, reason: news.reason },
        undefined,
        "Activity"
      );

      // A restart learns only now that the Network was off, so the Gap began no later
      // than the last step folded before it.
      if (draft.gap === undefined) {
        const from =
          news.reason._tag === "Restarted" && draft.last !== undefined ? draft.last : position;

        gap(draft, from, undefined);
        draft.gap = from;
      }

      break;
    }

    case "Refolded": {
      refold(draft, news.casemapping);

      break;
    }

    case "ReadMarker": {
      mark(draft, news.where, news.read);

      break;
    }

    case "ChannelLearned": {
      learned(draft, news.channel.key);

      break;
    }

    // A Lookup's result is the Owner's answer, read from the API, and places nothing.
    case "Ignored":
    case "LookedUp": {
      break;
    }

    default: {
      news satisfies never;
      break;
    }
  }
};

/**
 * Folds one step. It is total and deterministic: the same directory and step always
 * give the same directory and changes, so a rebuild gives every Timeline the id it had
 * and every item the position it had.
 * @param directory - The directory before the step.
 * @param happened - The step.
 * @returns The directory after it, and the changes for a store.
 */
export const step = (directory: Directory, happened: Happened): Stepped => {
  const known = directory.networks.get(happened.network);
  const changes: Change[] = [];
  const timeline = known?.timeline ?? timelineIdOf(happened.sequence, 0, 0);

  const draft: Draft = {
    at: happened.at,
    changes,
    gap: known?.gap,
    last: known?.last,
    maps: known ?? { channels: new Map(), directs: new Map(), keyed: new Map() },
    network: happened.network,
    read: known?.read,
    sequence: happened.sequence,
    timeline,
    written: undefined,
  };

  if (known === undefined) {
    describe(draft, "Network", timeline, happened.network, null);
  }

  for (const [n, news] of happened.news.entries()) {
    foldNews(draft, news, n);
  }

  const folded: NetworkDirectory = {
    channels: draft.maps.channels,
    directs: draft.maps.directs,
    gap: draft.gap,
    keyed: draft.maps.keyed,
    last: {
      at: happened.at,
      n: Math.max(0, happened.news.length - 1),
      sequence: happened.sequence,
    },
    read: draft.read,
    timeline,
  };

  return {
    changes,
    directory: { networks: new Map(directory.networks).set(happened.network, folded) },
  };
};
