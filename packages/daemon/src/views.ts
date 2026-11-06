import type {
  ActivityCursor,
  ChannelDetails,
  Formatted,
  LoggedActivity,
  MembersCursor,
  NetworkKnowledge,
  Span,
} from "@iirc/api";
import type { ReadActivity, StandingAt } from "@iirc/log";
import { parseFormatting } from "@iirc/protocol/format";
import type { Span as ParsedSpan } from "@iirc/protocol/format";
import { casefold, casemappingOf, channelOf } from "@iirc/state";
import type { Casemapping, IrcState, Member } from "@iirc/state";

// Only what is on is said, so a plain Message costs one small object.
const spanOf = ({ style, text }: ParsedSpan): Span => ({
  text,
  ...(style.bold && { bold: true }),
  ...(style.italic && { italic: true }),
  ...(style.underline && { underline: true }),
  ...(style.strikethrough && { strikethrough: true }),
  ...(style.monospace && { monospace: true }),
  ...(style.reverse && { reverse: true }),
  ...(style.foreground !== undefined && { foreground: style.foreground }),
  ...(style.background !== undefined && { background: style.background }),
});

/**
 * Text a participant wrote, raw, beside its spans, so that a Frontend never interprets a
 * formatting code (MSG-3). Only a Channel's topic, one at a time, is formatted here: what a
 * page of the Log holds is formatted on the reader's Worker, within its page bound.
 * @param text - The text, codes and all.
 * @returns Both forms.
 */
const formatted = (text: string): Formatted => ({
  spans: parseFormatting(text).map(spanOf),
  text,
});

/**
 * An Activity as the API gives it, formatted on the reader's Worker (MSG-3). Its ordinal
 * and its row's mapping are no Frontend's business: the page's `next` carries the one, and
 * a place filter reads the other (MSG-5, KNOW-3).
 * @param activity - As the reader gave it.
 * @returns It, for a Frontend.
 */
const activityView = ({
  casemapping: _casemapping,
  ordinal: _ordinal,
  ...activity
}: ReadActivity): LoggedActivity => activity;

/**
 * A page of Activity, and the cursor that resumes after it, which is where it was asked
 * from when it holds nothing.
 * @param rows - The page, as the reader gave it.
 * @param after - Where it was read from.
 * @returns The page, for a Frontend.
 */
export const activityPage = (rows: readonly ReadActivity[], after: ActivityCursor) => {
  const last = rows.at(-1);

  return {
    activity: rows.map(activityView),
    next: last === undefined ? after : { ordinal: last.ordinal, sequence: last.sequence },
  };
};

/**
 * What a Network's Session knows of Self and of its Ircd, with `at` from the same snapshot
 * (KNOW-1, KNOW-2, API-6).
 * @param snapshot - The Network's Standing, and the sequence it reflects.
 * @returns It, for a Frontend.
 */
export const knownOf = ({ at, standing: { irc } }: StandingAt): NetworkKnowledge => ({
  at,
  isupport: {
    tokens: Object.fromEntries(
      [...irc.isupport.tokens].toSorted(([one], [other]) => (one < other ? -1 : 1))
    ),
    tokensDropped: irc.isupport.tokensDropped,
  },
  self:
    irc.self === undefined
      ? null
      : {
          away: irc.self.away,
          host: irc.self.host ?? null,
          modes: irc.self.modes,
          user: irc.self.user ?? null,
        },
});

/** Which page of a Channel's members to read. */
export interface MembersPage {
  /** The `next` the page before gave: the last member's casefolded nick, and its mapping. */
  readonly after?: MembersCursor;
  readonly limit: number;
}

/** What a read of a Target found. */
export type TargetRead =
  | { readonly _tag: "Channel"; readonly details: ChannelDetails }
  | {
      readonly _tag: "CursorStale";
      readonly casemapping: Casemapping;
      readonly inForce: Casemapping;
    }
  | { readonly _tag: "NotAChannel" }
  | { readonly _tag: "NotHeld" };

// `PREFIX`'s symbol for each letter a member holds, in the same order. A letter `PREFIX`
// no longer names has none.
const symbolsOf = (irc: IrcState, prefixes: string) =>
  prefixes
    .split("")
    .map((letter) => irc.isupport.prefixSymbols.charAt(irc.isupport.modes.prefix.indexOf(letter)))
    .join("");

const memberView = (irc: IrcState, folded: string, { nick, prefixes }: Member) => {
  const seen = irc.users.get(folded);

  return {
    nick,
    prefixes,
    symbols: symbolsOf(irc, prefixes),
    ...(seen?.user !== undefined && { user: seen.user }),
    ...(seen?.host !== undefined && { host: seen.host }),
    ...(seen?.realname !== undefined && { realname: seen.realname }),
    ...(seen?.away !== undefined && { away: seen.away }),
  };
};

// The key is shown as set and never with its value, which can be the Owner's own Channel
// key, a Credential (CRED-4).
const keyMode = "k";

/**
 * A Channel Self is in, as one Standing knows it, with `at` from the same snapshot, so the
 * two can never disagree (KNOW-4, API-6). A page of members costs the path to where it
 * starts and the members it holds, however large the Channel.
 * @param snapshot - The Network's Standing, and the sequence it reflects.
 * @param network - The Network's ID.
 * @param target - The Target as the Frontend spelled it.
 * @param page - Which members to give.
 * @returns The Channel, or why there is none.
 */
export const targetRead = (
  { at, standing: { irc } }: StandingAt,
  network: string,
  target: string,
  { after, limit }: MembersPage
): TargetRead => {
  if (!irc.isupport.chantypes.includes(target.charAt(0))) {
    return { _tag: "NotAChannel" };
  }

  const channel = channelOf(irc, target);

  if (channel === undefined) {
    return { _tag: "NotHeld" };
  }

  const casemapping = casemappingOf(irc);

  // Members are in their casefolded order, which a cursor of another mapping is no place in.
  if (after !== undefined && after.casemapping !== casemapping) {
    return { _tag: "CursorStale", casemapping: after.casemapping, inForce: casemapping };
  }

  const items: ReturnType<typeof memberView>[] = [];
  let next: MembersCursor | null = null;
  let last: string | undefined;

  for (const [folded, member] of after === undefined
    ? channel.members.entries()
    : channel.members.entriesAfter(after.after)) {
    if (items.length === limit) {
      next = last === undefined ? null : { after: last, casemapping };
      break;
    }

    items.push(memberView(irc, folded, member));
    last = folded;
  }

  return {
    _tag: "Channel",
    details: {
      _tag: "Channel",
      at,
      createdAt: channel.createdAt ?? null,
      key: casefold(casemapping, channel.name),
      members: { count: channel.members.size, items, next },
      modes: [...channel.modes]
        .toSorted(([one], [other]) => (one < other ? -1 : 1))
        .map(([letter, param]) => ({
          letter,
          ...(param !== undefined && letter !== keyMode && { param }),
        })),
      name: channel.name,
      network,
      topic:
        channel.topic === undefined
          ? null
          : {
              ...formatted(channel.topic.text),
              setAt: channel.topic.setAt ?? null,
              setBy: channel.topic.setBy ?? null,
            },
      uncertain: { members: channel.membersUncertain, modes: channel.modesUncertain },
    },
  };
};
