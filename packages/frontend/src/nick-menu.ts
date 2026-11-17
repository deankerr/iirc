/**
 * The menu on a nick, wherever one is shown: what can be done with a User, each entry the
 * command the Composer would run, and whether the User is still in the Channel the menu
 * was opened in, read from the Daemon's members route while the menu is open.
 *
 * @packageDocumentation
 */
import type { TimelineId } from "@iirc/api";
import { casefold } from "@iirc/protocol/casemapping";
import type { Casemapping } from "@iirc/protocol/casemapping";

import { mayOperate } from "./channel.ts";
import { commandNamed, runIn } from "./commands.ts";
import type { CommandContext, Intent } from "./commands.ts";

/**
 * Whether a User is in the Channel: `Here`, `Gone`, or `Unknown`, as before the members
 * route answers, when it fails, or when it could not say.
 */
export type Presence = "Here" | "Gone" | "Unknown";

/** One entry of the menu: what it is, the word shown, its accessible name, and its intents. */
export interface NickEntry {
  readonly id: string;
  readonly text: string;
  readonly label: string;
  readonly intents: readonly Intent[];
}

/** What can be done with anyone, by the command that does it. */
const anyone = ["query", "whois"] as const;

/** What can be done in a Channel by an operator, by the command, and whether it needs the User there. */
const operating = [
  { name: "op", present: true },
  { name: "deop", present: true },
  { name: "voice", present: true },
  { name: "devoice", present: true },
  { name: "kick", present: true },
  { name: "ban", present: false },
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
 * Channel where Self may operate, op, deop, voice, devoice, kick, and ban. Each but mention
 * runs the command the Composer would, and is offered only when that command runs here.
 * Those that need the User in the Channel are offered only while they are `Here`. Nothing
 * is offered unless the context is the menu's own Pane's, its open Timeline the one the
 * menu was opened in, so no entry acts on another Pane's Channel.
 * @param nick - The nick.
 * @param timeline - The Timeline the menu was opened in.
 * @param presence - Whether the User is in its Channel.
 * @param context - The focused Pane's context.
 * @returns The entries.
 */
export const nickEntries = (
  nick: string,
  timeline: TimelineId,
  presence: Presence,
  context: CommandContext
): readonly NickEntry[] => {
  if (context.open !== timeline || context.focus?.timeline !== timeline) {
    return [];
  }

  const { focus, head } = context;

  const operator =
    focus.kind === "Channel" &&
    head !== undefined &&
    head.timeline === timeline &&
    mayOperate(head);

  return [
    ...anyone.flatMap((name) => commandEntry(name, nick, context)),
    {
      id: "mention",
      intents: [{ _tag: "FocusComposer", text: `${nick}: ` }],
      label: `Mention ${nick}`,
      text: "mention",
    },
    ...commandEntry("ignore", nick, context),
    ...(operator
      ? operating
          .filter((one) => !one.present || presence === "Here")
          .flatMap((one) => commandEntry(one.name, nick, context))
      : []),
  ];
};

/**
 * The menu open on a nick, if any, under the request that opened it: the nick, the Timeline
 * it was opened in, whether the User is there, and whether that is still being read.
 */
export interface NickMenu {
  readonly request: number;
  readonly nick: string;
  readonly timeline: TimelineId;
  readonly presence: Presence;
  readonly reading: boolean;
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
 * - `MembersRead`: the members route answered a request, with the nicks whose start is the
 *   nick's, whether more follow, and how the Connection folds names.
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
      readonly nicks: readonly string[];
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
          presence: "Unknown",
          reading: event.channel,
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

      if (open?.request !== event.request || !open.reading) {
        return state;
      }

      const key = casefold(event.casemapping, open.nick);
      const found = event.nicks.some((nick) => casefold(event.casemapping, nick) === key);

      let presence: Presence = "Unknown";

      if (found) {
        presence = "Here";
      } else if (!event.more) {
        presence = "Gone";
      }

      return { ...state, open: { ...open, presence, reading: false } };
    }

    case "MembersFailed": {
      const { open } = state;

      return open?.request === event.request && open.reading
        ? { ...state, open: { ...open, presence: "Unknown", reading: false } }
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
  state.open?.reading === true
    ? { prefix: state.open.nick, request: state.open.request, timeline: state.open.timeline }
    : undefined;
