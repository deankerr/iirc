/**
 * The menu on a nick, wherever one is shown: what can be done with a User, each entry the
 * command the Composer would run, and whether the User is still in the Channel the menu
 * was opened in, read from the Daemon's members route while the menu is open.
 *
 * @packageDocumentation
 */
import type { Member, TimelineId } from "@iirc/api";
import { casefold } from "@iirc/protocol/casemapping";
import type { Casemapping } from "@iirc/protocol/casemapping";

import { knownPrefixes, mayOperate, outranks } from "./channel.ts";
import { commandNamed, runIn } from "./commands.ts";
import type { CommandContext, Intent } from "./commands.ts";

/**
 * Whether a User is in the Channel: `Here`, with the prefixes they hold there, or none
 * while which they hold is not known, `Gone`, `Reading`, while the members route is asked,
 * or `Unknown`, when it fails, could not say, or is not asked, outside a Channel.
 */
export type Presence =
  | { readonly _tag: "Here"; readonly prefixes: readonly string[] | undefined }
  | { readonly _tag: "Gone" }
  | { readonly _tag: "Reading" }
  | { readonly _tag: "Unknown" };

/** One entry of the menu: what it is, the word shown, its accessible name, and its intents. */
export interface NickEntry {
  readonly id: string;
  readonly text: string;
  readonly label: string;
  readonly intents: readonly Intent[];
}

/**
 * What the menu offers now, and how many more entries may still come, none once all is
 * known: an operator's entries that wait on the Channel's head, whether its Network has a
 * Session, or whether the User is there, any of which is still being read. Leaving them
 * out meanwhile would read as Self may not use them, so a view draws the wait where they
 * will go, as tall as they may be, so a menu that grows upward moves nothing either.
 */
export interface NickEntries {
  readonly entries: readonly NickEntry[];
  readonly coming: number;
}

/** What can be done with anyone, by the command that does it. */
const anyone = ["query", "whois"] as const;

/**
 * What can be done in a Channel by an operator, by the command, and what it needs of the
 * User: nothing, to be there, or to be there and not outrank Self. Ban comes first, so
 * what a read of the members adds never moves it.
 */
const operating = [
  { name: "ban", needs: "nothing" },
  { name: "op", needs: "here" },
  { name: "deop", needs: "inferior" },
  { name: "voice", needs: "here" },
  { name: "devoice", needs: "inferior" },
  { name: "kick", needs: "inferior" },
] as const;

/**
 * An entry's word as its accessible name begins, capitalized.
 * @param text - The word.
 * @returns It, capitalized.
 */
const labelOf = (text: string) => `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;

/**
 * An entry that runs a command with the nick, as the Composer would, or none when the
 * command would not run here.
 * @param name - The command.
 * @param nick - The nick.
 * @param context - The context.
 * @returns The entry, or none.
 */
const commandEntry = (
  name: string,
  nick: string,
  context: CommandContext
): readonly NickEntry[] => {
  const command = commandNamed(name);
  const ran = command === undefined ? undefined : runIn(command, nick, context);

  return ran?._tag === "Parsed"
    ? [{ id: name, intents: ran.value, label: `${labelOf(name)} ${nick}`, text: name }]
    : [];
};

/**
 * What the menu on a nick offers, in order: query, whois, mention, and ignore, then, in a
 * Channel where Self may operate, ban, op, deop, voice, devoice, and kick. Each but mention
 * runs the command the Composer would, and is offered only when that command runs here.
 * Op and voice are offered only while the User is `Here`, and deop, devoice, and kick only
 * while they are too and do not outrank Self, or their rank is not known, which the
 * Network would refuse for want of status. Ban is placed before them, so what a read of
 * the members adds never moves it. More may come in a Channel while its head is not read,
 * or Self may operate and whether the Network has a Session, or whether the User is there,
 * is still being read, unless the Network is known to have no Session: as many of an
 * operator's entries as are not offered yet. Nothing is offered
 * unless the context is the menu's own Pane's, its open Timeline the one the menu was
 * opened in, so no entry acts on another Pane's Channel.
 * @param nick - The nick.
 * @param timeline - The Timeline the menu was opened in.
 * @param presence - Whether the User is in its Channel.
 * @param context - The focused Pane's context.
 * @returns The entries, and how many more may come.
 */
export const nickEntries = (
  nick: string,
  timeline: TimelineId,
  presence: Presence,
  context: CommandContext
): NickEntries => {
  if (context.open !== timeline || context.focus?.timeline !== timeline) {
    return { coming: 0, entries: [] };
  }

  const { focus, session } = context;
  const channel = focus.kind === "Channel";
  const head = context.head?.timeline === timeline ? context.head : undefined;
  const operator = channel && head !== undefined && mayOperate(head);

  const waiting =
    channel &&
    session !== false &&
    (head === undefined || (operator && (session === undefined || presence._tag === "Reading")));

  const operatorEntries = operator
    ? operating
        .filter((one) => {
          if (one.needs === "nothing") {
            return true;
          }

          return (
            presence._tag === "Here" && (one.needs === "here" || !outranks(head, presence.prefixes))
          );
        })
        .flatMap((one) => commandEntry(one.name, nick, context))
    : [];

  const entries: readonly NickEntry[] = [
    ...anyone.flatMap((name) => commandEntry(name, nick, context)),
    {
      id: "mention",
      intents: [{ _tag: "FocusComposer", text: `${nick}: ` }],
      label: `Mention ${nick}`,
      text: "mention",
    },
    ...commandEntry("ignore", nick, context),
    ...operatorEntries,
  ];

  return { coming: waiting ? operating.length - operatorEntries.length : 0, entries };
};

/**
 * The menu open on a nick, if any, under the request that opened it: the nick, the Timeline
 * it was opened in, and whether the User is there.
 */
export interface NickMenu {
  readonly request: number;
  readonly nick: string;
  readonly timeline: TimelineId;
  readonly presence: Presence;
}

/** The menu open on a nick, if any, and the request the next one opens under. */
export interface NickMenus {
  readonly next: number;
  readonly open: NickMenu | undefined;
}

export const initialNickMenus: NickMenus = { next: 1, open: undefined };

/**
 * What happens to the menu on a nick:
 *
 * - `Opened`: on a nick in a Timeline, and whether that is a Channel's, whose members are
 *   read to say whether the User is there. Elsewhere it is not known.
 * - `Closed`: the menu under a request was closed.
 * - `MembersRead`: the members route answered a request, with the members whose nick starts
 *   as the nick does, with the prefixes each holds, whether more follow, and how the Connection folds names.
 * - `MembersFailed`: it did not answer.
 */
export type NickMenusEvent =
  | {
      readonly _tag: "Opened";
      readonly nick: string;
      readonly timeline: TimelineId;
      readonly channel: boolean;
    }
  | { readonly _tag: "Closed"; readonly request: number }
  | {
      readonly _tag: "MembersRead";
      readonly request: number;
      readonly members: readonly { readonly nick: string; readonly prefixes: Member["prefixes"] }[];
      readonly more: boolean;
      readonly casemapping: Casemapping;
    }
  | { readonly _tag: "MembersFailed"; readonly request: number };

/**
 * Folds one event into the menu on a nick. An answer is taken only by the menu that asked
 * for it, so one that lands after its menu was closed, or another opened, changes nothing.
 * The User is there when a member's nick folds as theirs does, gone when none does and no
 * more follow, and unknown otherwise.
 * @param state - The state.
 * @param event - What happened.
 * @returns The state after.
 */
export const reduceNickMenus = (state: NickMenus, event: NickMenusEvent): NickMenus => {
  switch (event._tag) {
    case "Opened": {
      return {
        next: state.next + 1,
        open: {
          nick: event.nick,
          presence: event.channel ? { _tag: "Reading" } : { _tag: "Unknown" },
          request: state.next,
          timeline: event.timeline,
        },
      };
    }

    case "Closed": {
      return state.open?.request === event.request ? { ...state, open: undefined } : state;
    }

    case "MembersRead": {
      const { open } = state;

      if (open?.request !== event.request || open.presence._tag !== "Reading") {
        return state;
      }

      const key = casefold(event.casemapping, open.nick);

      const found = event.members.find((one) => casefold(event.casemapping, one.nick) === key);

      // A nick past the first page of prefix matches stays unknown, which only withholds entries.
      let presence: Presence = { _tag: "Unknown" };

      if (found !== undefined) {
        presence = { _tag: "Here", prefixes: knownPrefixes(found.prefixes) };
      } else if (!event.more) {
        presence = { _tag: "Gone" };
      }

      return { ...state, open: { ...open, presence } };
    }

    case "MembersFailed": {
      const { open } = state;

      return open?.request === event.request && open.presence._tag === "Reading"
        ? { ...state, open: { ...open, presence: { _tag: "Unknown" } } }
        : state;
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * The members route's request to make now, for the menu open on a nick: its Channel's
 * members whose nick starts with the nick, under the menu's request.
 * @param state - The state.
 * @returns The request, or none.
 */
export const presenceWanted = (
  state: NickMenus
):
  | { readonly request: number; readonly timeline: TimelineId; readonly prefix: string }
  | undefined =>
  state.open?.presence._tag === "Reading"
    ? { prefix: state.open.nick, request: state.open.request, timeline: state.open.timeline }
    : undefined;
