/**
 * The commands, as data: one registry behind the composer's `/commands`, the keymap, and
 * later agents, since each is a way of naming the same action. A
 * command parses its arguments into typed values or says in words why it cannot, and
 * gives intents, plain data the runtime carries out. It never does anything itself.
 *
 * @packageDocumentation
 */
import type {
  ActionRequest,
  ChannelHeader,
  Level,
  NetworkId,
  SayRequest,
  TimelineId,
} from "@iirc/api";
import type { OwnerOptionName } from "@iirc/api/options";
import { AliasLine, AliasName } from "@iirc/api/ui";
import type { Alias, Aliases, PreviewsShown, ThemeName, UiOptionName } from "@iirc/api/ui";
import { casefold } from "@iirc/protocol/casemapping";
import type { Casemapping } from "@iirc/protocol/casemapping";
import { IgnoreMask } from "@iirc/protocol/mask";
import { Schema } from "effect";

import { rank } from "./activity.ts";
import type { Instant } from "./activity.ts";
import { expand, substituted, takes, usageOf } from "./aliases.ts";
import type { AliasesEdit } from "./aliases.ts";
import type { ArrangeEdit } from "./arrangement.ts";
import type { Flag } from "./formatting.ts";
import type { Axis, Direction } from "./layout.ts";
import {
  isLookupNick,
  listCommandNames,
  listLookOf,
  directoryLookOf,
  listMode,
  listWords,
  lookOf,
  namesLookOf,
  nickRulesOf,
  parseConditions,
  parseListChannel,
  parseLookupNick,
  parseWhoMask,
  whoLookOf,
} from "./lookup.ts";
import type { ListKind, Look, UserKind } from "./lookup.ts";
import {
  channelsOf,
  isOwnerName,
  isUiName,
  networkIdOf,
  parseIrcd,
  parseOwnerText,
  parseText,
  parseUiText,
  resolve,
  resolveOwner,
  resolveUi,
  starting,
} from "./options.ts";
import type { Asked, Configuration, Edit, Json } from "./options.ts";
import { boundMoment, parseMoment, startsBefore } from "./search.ts";
import type { Moment } from "./search.ts";
import { parseThemeName, systemTheme } from "./theme.ts";
import type { ThemeOption, ThemesEdit } from "./theme.ts";
import type { PaneChange, SidebarNetwork } from "./timelines.ts";
import { isOverridable } from "./ui.ts";

/** What a Message is said as: a `PRIVMSG`, a `NOTICE`, or a CTCP `ACTION`. */
export type SayKind = "Privmsg" | "Notice" | "Action";

/** The Timeline in focus, as a command sees it. */
export interface Focus {
  readonly network: NetworkId;
  readonly timeline: TimelineId;
  readonly kind: "Network" | "Channel" | "Direct";
  readonly name: string;
  /** A Direct Message Timeline that no longer follows its partner, so has no Target. */
  readonly detached: boolean;
  /** Its key, its name as the Daemon folded it, or none for the Network's own or a detached one. */
  readonly key: string | undefined;
  /** Its Network was removed with its Timelines kept, so it is only read. */
  readonly removed: boolean;
}

/** A Direct Message not yet begun: the nick it is to, on a Network. */
export interface DraftTo {
  readonly network: NetworkId;
  readonly nick: string;
}

/** A Timeline as `/go` finds it: by its name, on its Network. */
export interface NamedTimeline {
  readonly timeline: TimelineId;
  readonly network: NetworkId;
  readonly kind: "Network" | "Channel" | "Direct";
  readonly name: string;
}

/**
 * Every Timeline by name: Network by Network in the sidebar's order, each Network's listed
 * Timelines, then those closed, which the sidebar leaves out.
 * @param networks - The sidebar.
 * @returns The Timelines.
 */
export const namedIn = (networks: readonly SidebarNetwork[]): readonly NamedTimeline[] =>
  networks.flatMap((network) =>
    [...network.timelines, ...network.closed].map((timeline) => ({
      kind: timeline.kind,
      name: timeline.name,
      network: network.network,
      timeline: timeline.id,
    }))
  );

/** What a command's `when` and its arguments are judged against. */
export interface CommandContext {
  /** The Timeline in focus, if any. */
  readonly focus: Focus | undefined;
  /**
   * The Direct Message not yet begun that the focused Pane shows, if any, in place of a
   * Timeline in focus: what is said there goes to its nick.
   */
  readonly draft: DraftTo | undefined;
  /**
   * Whether the open Timeline stands behind the options, the search, or a draft, so it is
   * not the one shown, and `/next-unread` may go to it, which shows it.
   */
  readonly behind: boolean;
  /**
   * Whether the focused Timeline's Network has a Session, or `undefined` while that is not
   * known yet. A command that needs one is refused until it does.
   */
  readonly session: boolean | undefined;
  /** Every Timeline, in the order the sidebar shows: the pinned, then each Network's. */
  readonly timelines: readonly TimelineId[];
  /** Every Timeline by name, those closed too, as `namedIn` lists them, which `/go` finds one in. */
  readonly named: readonly NamedTimeline[];
  /**
   * The Timeline open in the focused Pane, as a merge resolves it, even while it is still
   * read, and while something stands in front of it.
   */
  readonly open: TimelineId | undefined;
  /** Every Timeline open in a Pane, as a merge resolves it. */
  readonly shown: readonly TimelineId[];
  /** How many Panes there are. */
  readonly panes: number;
  /** Every Timeline the sidebar lists with something unread, in its order. */
  readonly unread: readonly Unseen[];
  /**
   * Every Timeline with something unread that navigation skips: one closed, which the
   * sidebar does not list, and one of a Network removed, which calls for nothing. `/read`
   * and `/read all` still mark them.
   */
  readonly unreadClosed: readonly Unseen[];
  /**
   * The head of the Channel in focus, as last read, or none before it is read or when the
   * focus is no Channel's: its topic, and the Network's `PREFIX`, `CHANMODES`, and
   * `CHANTYPES`, which an action on a Channel is parsed by, as the Client checks it.
   */
  readonly head: ChannelHeader | undefined;
  /** The aliases the Owner made, shared by every device, or none until they are read. */
  readonly aliases: Aliases;
}

/** A Timeline with something unread, as a command sees it. */
export interface Unseen {
  readonly timeline: TimelineId;
  /**
   * The highest level unread in it as shown, or none when it is muted and has no Highlight
   * unread, which `/next-unread` passes over.
   */
  readonly level: Level | undefined;
  /** Marking it read up to its latest item, unless that would change nothing. */
  readonly mark: MarkRead | undefined;
}

/**
 * Mark a Timeline read up to an instant: the Daemon's `read`, naming the Timeline by its id,
 * which every Timeline held has, detached or of a removed Network or not.
 */
export interface MarkRead {
  readonly _tag: "MarkRead";
  readonly network: NetworkId;
  readonly timeline: TimelineId;
  readonly read: Instant;
}

/** A Timeline saved as text: from `since`, inclusive, to `until`, exclusive, as far as there is when none. */
export interface Export {
  readonly _tag: "Export";
  readonly timeline: TimelineId;
  readonly since: Moment | undefined;
  readonly until: Moment | undefined;
}

/**
 * Close a Timeline held: the Daemon's `close`, naming the Timeline by its id. A Channel Self
 * is in is never closed: the Daemon answers so, and the runtime offers to leave it instead.
 */
export interface CloseTimeline {
  readonly _tag: "CloseTimeline";
  readonly network: NetworkId;
  readonly timeline: TimelineId;
}

/**
 * Close what the Owner named: the Daemon's `close` by a Target, a Channel's name or a Direct
 * Message partner's nick, which the Network's Client resolves by the Network's own naming.
 */
export interface CloseTarget {
  readonly _tag: "CloseTarget";
  readonly network: NetworkId;
  readonly target: string;
}

/**
 * Say a Message to a Target on a Network. With `opens`, once it is said, open the Direct
 * Message Timeline the Daemon placed it in, if it placed it in one. Which Timeline that
 * is, the Daemon's routing decides, never a name the Frontend folds.
 */
export interface Say {
  readonly _tag: "Say";
  readonly network: NetworkId;
  readonly target: string;
  readonly kind: SayKind;
  readonly text: string;
  readonly opens: boolean;
  /** The id of the Message it answers, sent as a `+reply` tag where the Session carries tags. */
  readonly answers?: NonNullable<SayRequest["answers"]>;
}

/**
 * Act on a Network, as the Daemon's `act` does: set a topic, kick, change modes, invite,
 * change Self's nick, be away or back, send a CTCP request or a `PING` to a nick, or send
 * a Line written as text. It is carried out
 * as a Say is, under an intent the runtime names, and never sent twice.
 */
export interface Act {
  readonly _tag: "Act";
  readonly network: NetworkId;
  readonly action: ActionRequest;
}

/**
 * What a command asks for, which the runtime carries out, in order.
 *
 * - `Say`: say a Message, above.
 * - `Act`: act on a Network, above.
 * - `OpenOptions`: show the options view, filtered as given.
 * - `OpenUploads`: show the Uploads view.
 * - `OpenTail`: show the Tail in the focused Pane, which then shows nothing else.
 * - `Configure`: read the Network's Configuration, apply the edit to it, and send the whole
 *   of it back, made from the one read. On a conflict, read it again and apply the same
 *   edit once more, since an edit is a pure function of the Configuration.
 * - `AddNetwork`: configure a Network that must not exist yet, as a new one starts.
 * - `AskRemoval`: ask the Owner to confirm removing a Network, and whether its Timelines
 *   stay readable, `keep` chosen to start with when given. Removed with them kept, removing
 *   it again drops them. Nothing is removed until the Owner confirms.
 * - `ChangeUi`: set an option under `ui` to a value, as JSON its Schema took, or unset it
 *   with none: for every device, through the Daemon, made from the options read, or with
 *   `device`, for this device alone, which keeps it and never sends it.
 * - `ChangeOwner`: set an option under `storage`, `uploads`, or `previews` to a value, as JSON its Schema
 *   took, or unset it with none, through the Daemon, made from the options read. No device
 *   overrides one.
 * - `UseTheme`: set `option` to the theme named, for every device, or with `device`, for
 *   this one, once the runtime has found it among the themes there are: `theme` to draw in
 *   it, or `light` or `dark` to have `system` draw it while the device is light or dark.
 * - `EditThemes`: read the themes imported, apply the edit, and send them whole, made from
 *   the options read, applying it once more after a conflict, as `Configure` does.
 * - `EditAliases`: read the aliases made, apply the edit, and send them whole, made from
 *   the options read, applying it once more after a conflict, as `EditThemes` does.
 * - `ImportTheme`: open the dialog that reads a theme from a terminal's theme file.
 * - `ChoosePreviews`: set a Timeline's own choice in `ui.previews.conversations` to `mode`, or
 *   remove it with none, so it follows `ui.previews`: the option read, the choice made,
 *   and the option sent whole, made once more after a conflict, as `EditThemes` is.
 * - `PromptCredential`: ask for a Credential option's value in a password prompt, which
 *   gives it to the Vault and points the option at it: a Network's, by its Network and
 *   path, or one under `storage`, `uploads`, or `previews`, by its name. A value never goes through the
 *   composer, nor through an intent.
 * - `Open`: open a Timeline in the focused Pane, or focus the Pane it is open in.
 * - `Latest`: read a Timeline's latest again and follow it, wherever its window stands.
 * - `GoToDate`: show a Timeline from its first item at or after a moment, which the runtime
 *   places in the Owner's time zone when it is a day, as jumping to a search's result does.
 * - `Export`: save a Timeline as a text file, the part of it from `since`, inclusive, to
 *   `until`, exclusive, when given, which the runtime places in the Owner's time zone when
 *   a bound is a day. `until` is already the start of the day after the one the Owner named.
 * - `StartCommand`: focus the composer under the main view and start `text` in it, with
 *   its list open, as a key that starts a command does. A draft with text in it is set
 *   aside, and comes back when the command runs or on Escape.
 * - `FocusComposer`: focus the composer under the main view, starting it with `text` when
 *   there is one, as `/topic` starts the Channel's topic. A draft with text in it is never
 *   replaced: the composer says what was not put in.
 * - `MarkRead`: mark a Timeline read, above.
 * - `CloseTimeline`: close a Timeline held, above.
 * - `CloseTarget`: close what the Owner named, above.
 * - `Mute`: mute a Timeline, or unmute it, for every device, which the runtime writes as
 *   `ui.unread.muted`, the whole list, as `muting` gives it.
 * - `Notify`: turn notifications on or off on this device, asking the browser's permission
 *   to turn them on.
 * - `ShowMembers`: show or hide the open Channel's members on this device, or turn them
 *   over when `shown` is none.
 * - `ShowSidebar`: show or hide the sidebar on this device, or turn it over when `shown`
 *   is none.
 * - `Query`: open the Timeline of a name on a Network, as the Daemon keyed it, such as a
 *   Direct Message's. A Timeline exists only once something was said in it, so with none,
 *   the composer starts `/msg <name> ` to say the first Message, which opens it.
 * - `Pane`: change the Panes: split, close, focus, swap, resize, or zoom.
 * - `Search`: show the search, searching the query when there is one, which the runtime
 *   reads against the Timelines and the Owner's time zone, or showing what it last found.
 * - `Look`: look a nick up on a Network, `WHOIS` or `WHOWAS`, or a Channel's list, under an
 *   intent the runtime names, and show what came back in a card over the Pane that asked.
 * - `Format`: turn a flag over in the composer's selection, or, with none, for what is
 *   typed next at its caret.
 * - `ChooseFormat`: open the formatting list for the composer's selection, or for what is
 *   typed next at its caret.
 */
export type Intent =
  | Say
  | Act
  | { readonly _tag: "OpenOptions"; readonly filter: string }
  | { readonly _tag: "OpenUploads" }
  | { readonly _tag: "OpenTail" }
  | { readonly _tag: "Configure"; readonly network: NetworkId; readonly edit: Edit }
  | {
      readonly _tag: "AddNetwork";
      readonly network: NetworkId;
      readonly configuration: Configuration;
    }
  | { readonly _tag: "AskRemoval"; readonly network: NetworkId; readonly keep: boolean | undefined }
  | {
      readonly _tag: "ChangeUi";
      readonly option: UiOptionName;
      readonly value: Json | undefined;
      readonly device: boolean;
    }
  | {
      readonly _tag: "ChangeOwner";
      readonly option: OwnerOptionName;
      readonly value: Json | undefined;
    }
  | {
      readonly _tag: "UseTheme";
      readonly option: ThemeOption;
      readonly name: ThemeName;
      readonly device: boolean;
    }
  | { readonly _tag: "EditThemes"; readonly edit: ThemesEdit }
  | { readonly _tag: "EditAliases"; readonly edit: AliasesEdit }
  | { readonly _tag: "ImportTheme" }
  | {
      readonly _tag: "ChoosePreviews";
      readonly timeline: TimelineId;
      readonly mode: PreviewsShown | undefined;
    }
  | ({ readonly _tag: "PromptCredential" } & Asked)
  | { readonly _tag: "Open"; readonly timeline: TimelineId }
  | { readonly _tag: "Latest"; readonly timeline: TimelineId }
  | { readonly _tag: "GoToDate"; readonly timeline: TimelineId; readonly moment: Moment }
  | Export
  | { readonly _tag: "StartCommand"; readonly text: string }
  | { readonly _tag: "FocusComposer"; readonly text: string | undefined }
  | MarkRead
  | CloseTimeline
  | CloseTarget
  | { readonly _tag: "Mute"; readonly timeline: TimelineId; readonly muted: boolean }
  | { readonly _tag: "Notify"; readonly on: boolean }
  | { readonly _tag: "ShowMembers"; readonly shown: boolean | undefined }
  | { readonly _tag: "ShowSidebar"; readonly shown: boolean | undefined }
  | { readonly _tag: "Query"; readonly network: NetworkId; readonly name: string }
  | {
      readonly _tag: "Draft";
      readonly network: NetworkId;
      readonly nick: string;
      /** How the Network folded names when this was read: its Timeline is found by it alone. */
      readonly declared: Casemapping | null;
    }
  | { readonly _tag: "Pane"; readonly change: PaneChange }
  | { readonly _tag: "Search"; readonly query: string | undefined }
  | Look
  | { readonly _tag: "Format"; readonly format: Flag }
  | { readonly _tag: "ChooseFormat" }
  | { readonly _tag: "Arrange"; readonly edit: ArrangeEdit };

/** A value parsed, or why it could not be, in words. */
export type Parsed<A> =
  | { readonly _tag: "Parsed"; readonly value: A }
  | { readonly _tag: "Invalid"; readonly message: string };

/**
 * When a command can run, each a condition on the context.
 *
 * - `Focused`: a Timeline is in focus.
 * - `Target`: the Timeline in focus has a Target: a Channel's, or a Direct Message
 *   partner's it still follows.
 * - `Channel`: the Timeline in focus is a Channel's.
 * - `Session`: the focused Timeline's Network has a Session.
 * - `Live`: the Timeline in focus, if any, is not of a Network removed with its Timelines
 *   kept, where nothing is said or done any more.
 * - `Panes`: there is more than one Pane.
 */
export type Condition =
  | { readonly _tag: "Focused" }
  /** The head of the Channel in focus, when read, does not say its Network keeps no such list. */
  | { readonly _tag: "Keeps"; readonly list: ListKind }
  | { readonly _tag: "Target" }
  | { readonly _tag: "Channel" }
  | { readonly _tag: "Session" }
  | { readonly _tag: "Live" }
  | { readonly _tag: "Panes" };

/** A command: how it is named and described, when it can run, and what it gives. */
export interface Command {
  /** Its stable id, such as `say.action`, for keybindings and agents. */
  readonly id: string;
  /** Its name after `/`, in lower case. */
  readonly name: string;
  /** Other names it answers to after `/`, in lower case. */
  readonly aliases: readonly string[];
  /** How it is typed, such as `/me <text>`. */
  readonly usage: string;
  /**
   * Whether it takes arguments: `None`, `Optional`, or `Required`. A key bound to one that
   * requires them, with none given, starts it in the composer.
   */
  readonly arguments: "None" | "Optional" | "Required";
  /** What it does, in one line. */
  readonly description: string;
  /** Every condition that must hold for it to run. */
  readonly when: readonly Condition[];
  /** Its intents for the text after its name, or why there are none. */
  readonly run: (args: string, context: CommandContext) => Parsed<readonly Intent[]>;
}

const parsed = <A>(value: A): Parsed<A> => ({ _tag: "Parsed", value });

const invalid = <A>(message: string): Parsed<A> => ({ _tag: "Invalid", message });

/**
 * A command whose arguments are parsed to a typed value before its intents are made.
 * @param spec - The command, with its parser and what it gives for a parsed value.
 * @returns The command.
 */
const command = <A>(
  spec: Omit<Command, "run"> & {
    readonly parse: (args: string, focus: Focus) => Parsed<A>;
    readonly intents: (value: A, focus: Focus) => readonly Intent[];
  }
): Command => {
  const { intents, parse, ...rest } = spec;

  return {
    ...rest,
    run: (args, context) => {
      const { focus } = context;

      if (focus === undefined) {
        return invalid("Open a conversation first.");
      }

      const value = parse(args, focus);

      return value._tag === "Parsed" ? parsed(intents(value.value, focus)) : value;
    },
  };
};

/** The range of a Timeline `/export` saves: each bound is none for as far as there is. */
interface ExportRange {
  readonly since: Moment | undefined;
  readonly until: Moment | undefined;
}

/**
 * The arguments of `/export`: none, a moment to start from, or two, to start from and to
 * stop before. A day stops after the whole of it, as `until:` does in a search.
 * @param args - The arguments.
 * @returns The range, or why it cannot be read, in words.
 */
const exportArguments = (args: string): Parsed<ExportRange> => {
  const usage =
    "/export takes an optional start and an optional end. Each is a date, such as 2026-11-10, or a time with its zone, such as 2026-11-10T09:30Z or 2026-11-10T09:30+01:00.";

  const words = args.split(/\s+/u).filter((word) => word !== "");

  if (words.length > 2) {
    return invalid(usage);
  }

  const [sinceText, untilText] = words;
  const since = sinceText === undefined ? undefined : parseMoment(sinceText, usage);
  const until = untilText === undefined ? undefined : parseMoment(untilText, usage);

  if (since?._tag === "Invalid") {
    return since;
  }

  if (until?._tag === "Invalid") {
    return until;
  }

  const range = {
    since: since === undefined ? undefined : boundMoment("since", since.value),
    until: until === undefined ? undefined : boundMoment("until", until.value),
  };

  return range.since !== undefined &&
    range.until !== undefined &&
    startsBefore(range.since, range.until) === false
    ? invalid("/export: the start must come before the end.")
    : parsed(range);
};

/**
 * Text to say, which must not be empty.
 * @param usage - How the command is typed, to say when it is.
 * @returns The parser.
 */
const textOf =
  (usage: string) =>
  (args: string): Parsed<string> =>
    args === "" ? invalid(`Add a message. ${usage}`) : parsed(args);

/**
 * A Target and text to say to it: one name, with no space or `,`, then the text.
 * @param usage - How the command is typed, to say when it is.
 * @returns The parser.
 */
const targetAndText =
  (usage: string) =>
  (args: string): Parsed<{ readonly target: string; readonly text: string }> => {
    const space = args.indexOf(" ");
    const target = space === -1 ? args : args.slice(0, space);
    const text = space === -1 ? "" : args.slice(space + 1);

    if (target === "") {
      return invalid(`Add a channel or user. ${usage}`);
    }

    // A list of Targets is never one Timeline, and the Client sends none.
    if (target.includes(",")) {
      return invalid("Send to one channel or user at a time.");
    }

    return text === "" ? invalid(`Add a message. ${usage}`) : parsed({ target, text });
  };

/**
 * A command that needs no Timeline in focus.
 * @param spec - The command, with its parser and what it gives for a parsed value.
 * @returns The command.
 */
const unfocused = <A>(
  spec: Omit<Command, "run"> & {
    readonly parse: (args: string, context: CommandContext) => Parsed<A>;
    readonly intents: (value: A) => readonly Intent[];
  }
): Command => {
  const { intents, parse, ...rest } = spec;

  return {
    ...rest,
    run: (args, context) => {
      const value = parse(args, context);

      return value._tag === "Parsed" ? parsed(intents(value.value)) : value;
    },
  };
};

/** The choices `/network remove` reads after an id, or alone, and whether each keeps. */
const removalChoices: ReadonlyMap<string | undefined, boolean | undefined> = new Map([
  [undefined, undefined],
  ["keep", true],
  ["drop", false],
]);

/**
 * The words after `/network remove` that name a Network: its id, with a choice after it
 * when the id is itself one, since a lone choice is about the focused Network.
 * @param network - The Network.
 * @param keep - Whether the choice, if one is needed, keeps its Timelines.
 * @returns The words.
 */
export const removalWords = (network: NetworkId, keep: boolean): string =>
  removalChoices.has(network) ? `${network} ${keep ? "keep" : "drop"}` : network;

/**
 * Why nothing is said or done in a removed Network's Timeline, in words.
 * @param network - The Network.
 * @returns The words.
 */
const removedRefusal = (network: NetworkId) =>
  `${network} was removed, so its conversations are read-only. /network remove ${removalWords(network, false)} drops them.`;

/**
 * Why nothing is said on a Network with no Session, in words: that it is not connected, or,
 * while that is not known yet, that it is not known.
 * @param network - The Network, or what stands for it.
 * @param session - `false` once it is known to have none, `undefined` while not known.
 * @returns The words.
 */
const noSession = (network: string, session: false | undefined) =>
  session === false
    ? `${network} is not connected, so you can't send there now.`
    : `Whether ${network} is connected is not known yet, so you can't send there now.`;

/**
 * Why a Credential's value typed after `/set` is refused, in words.
 * @param name - The option's name.
 * @returns The words.
 */
const credentialRefused = (name: string) =>
  `Don't type a password into the message input. It was cleared and nothing was sent. Use /set ${name} alone to enter it in a password prompt.`;

/** What `/set` and `/unset` take first to change an option under `ui` on this device alone. */
const deviceFlag = "-device";

/**
 * The arguments after `-device`, when they come first, or none.
 * @param args - The arguments.
 * @returns The rest, or none without the flag.
 */
const afterDevice = (args: string): string | undefined =>
  args === deviceFlag || args.startsWith(`${deviceFlag} `)
    ? args.slice(deviceFlag.length).trimStart()
    : undefined;

const deviceOnlyUi = `Only ui options can be set for this device alone, as in /set ${deviceFlag} ui.theme light.`;

/**
 * Why an option every device shares only is refused for this device alone, in words.
 * @param name - The option's name.
 * @returns The words.
 */
const sharedOnlyUi = (name: string) =>
  `${name} is shared by all your devices, so one device can't override it. Use /set ${name} without ${deviceFlag}.`;

/**
 * An option under `ui` set to a value given as text, for every device or this one.
 * @param name - The option's name.
 * @param text - The value, or none when nothing followed the name.
 * @param device - Whether for this device alone.
 * @returns The intent, or why there is none.
 */
const setUi = (name: string, text: string | undefined, device: boolean): Parsed<Intent> => {
  const found = resolveUi(name);

  if (found._tag === "Invalid") {
    return found;
  }

  if (device && !isOverridable(found.value.option)) {
    return invalid(sharedOnlyUi(name));
  }

  // Text takes the rest of the line after the name's space as it is, empty or spaces
  // included, as a Network's does. Anything else needs more than spaces.
  if (text === undefined || (text.trim() === "" && found.value.field.kind._tag !== "Text")) {
    return invalid(`Give ${name} a value, or use /unset ${device ? `${deviceFlag} ` : ""}${name}.`);
  }

  const value = parseUiText(found.value.option, text);

  return value._tag === "Invalid"
    ? value
    : parsed({ _tag: "ChangeUi", device, option: found.value.option, value: value.value });
};

/**
 * An option under `storage`, `uploads`, or `previews` set to a value given as text. A Credential option's
 * value is never typed: `/set` and its name alone asks for it in a password prompt.
 * @param name - The option's name.
 * @param text - The value.
 * @returns The intent, or why there is none.
 */
const setOwner = (name: string, text: string): Parsed<Intent> => {
  const found = resolveOwner(name);

  if (found._tag === "Invalid") {
    return found;
  }

  const { field, option } = found.value;

  if (field.kind._tag === "Credential") {
    return invalid(credentialRefused(name));
  }

  // Text takes the rest of the line as it is, as under `ui`. Anything else needs more.
  if (text.trim() === "" && field.kind._tag !== "Text") {
    return invalid(`Give ${name} a value, or use /unset ${name}.`);
  }

  const value = parseOwnerText(option, text);

  return value._tag === "Invalid"
    ? value
    : parsed({ _tag: "ChangeOwner", option, value: value.value });
};

/**
 * What `/set -device` was given: an option under `ui` and a value, for this device.
 * @param args - The text after `-device`.
 * @returns The intent, or why there is none.
 */
const setOnDevice = (args: string): Parsed<Intent> => {
  const space = args.indexOf(" ");
  const name = space === -1 ? args : args.slice(0, space);

  return isUiName(name)
    ? setUi(name, space === -1 ? undefined : args.slice(space + 1), true)
    : invalid(deviceOnlyUi);
};

/**
 * What `/unset` was given: an option, back to what it starts as, or with `-device`, an
 * option under `ui` back to the value every device shares.
 * @param args - The text after `/unset`.
 * @returns The intent, or why there is none.
 */
const unsetArguments = (args: string): Parsed<Intent> => {
  const onDevice = afterDevice(args.trim());
  const name = (onDevice ?? args).trim();

  if (onDevice !== undefined && !isUiName(name)) {
    return invalid(deviceOnlyUi);
  }

  if (isUiName(name)) {
    const found = resolveUi(name);

    if (found._tag === "Parsed" && onDevice !== undefined && !isOverridable(found.value.option)) {
      return invalid(sharedOnlyUi(name));
    }

    return found._tag === "Invalid"
      ? found
      : parsed({
          _tag: "ChangeUi",
          device: onDevice !== undefined,
          option: found.value.option,
          value: undefined,
        });
  }

  if (isOwnerName(name)) {
    const found = resolveOwner(name);

    return found._tag === "Invalid"
      ? found
      : parsed({ _tag: "ChangeOwner", option: found.value.option, value: undefined });
  }

  const found = resolve(name);

  return found._tag === "Invalid"
    ? found
    : parsed({
        _tag: "Configure",
        edit: { _tag: "Unset", path: found.value.path },
        network: found.value.network,
      });
};

/**
 * What `/set` was given: nothing or a pattern, to open the options view filtered, or an
 * option's name and a value, to set it, or with `-device` first, an option under `ui` and
 * a value for this device alone.
 * @param args - The text after `/set`.
 * @returns The intent, or why there is none.
 */
const setArguments = (args: string): Parsed<Intent> => {
  const onDevice = afterDevice(args);

  if (onDevice !== undefined) {
    return setOnDevice(onDevice);
  }

  const space = args.indexOf(" ");
  const alone = space === -1 ? resolve(args) : undefined;
  const owner = space === -1 ? resolveOwner(args) : undefined;

  if (alone?._tag === "Parsed" && alone.value.field.kind._tag === "Credential") {
    return parsed({
      _tag: "PromptCredential",
      network: alone.value.network,
      path: alone.value.path,
    });
  }

  if (owner?._tag === "Parsed" && owner.value.field.kind._tag === "Credential") {
    return parsed({ _tag: "PromptCredential", option: owner.value.option });
  }

  if (space === -1) {
    return parsed({ _tag: "OpenOptions", filter: args });
  }

  const name = args.slice(0, space);
  const text = args.slice(space + 1);

  if (isUiName(name)) {
    return setUi(name, text, false);
  }

  if (isOwnerName(name)) {
    return setOwner(name, text);
  }

  const found = resolve(name);

  if (found._tag === "Invalid") {
    return found;
  }

  const { field, network, path } = found.value;

  if (field.kind._tag === "Credential") {
    return invalid(credentialRefused(name));
  }

  // Text and lists take the rest of the line as it is, empty included.
  if (
    text === "" &&
    field.kind._tag !== "Text" &&
    field.kind._tag !== "Texts" &&
    field.kind._tag !== "Names"
  ) {
    return invalid(`Give ${name} a value, or use /unset ${name}.`);
  }

  const value = parseText(field.kind, text);

  return value._tag === "Invalid"
    ? invalid(`${name}: ${value.message}`)
    : parsed({ _tag: "Configure", edit: { _tag: "Set", path, text }, network });
};

/**
 * The Network `/connect` or `/disconnect` names: the one given, or else the focused one,
 * the Timeline's or the Direct Message not yet begun's.
 * @param usage - How the command is typed, to say when it is.
 * @returns The parser.
 */
const enabledArguments =
  (usage: string) =>
  (args: string, context: CommandContext): Parsed<NetworkId> => {
    const id = args.trim();

    if (id === "") {
      const { draft, focus } = context;

      if (focus?.removed === true) {
        return invalid(removedRefusal(focus.network));
      }

      const network = focus?.network ?? draft?.network;

      return network === undefined
        ? invalid(`Name a network, or open one of its conversations first. ${usage}`)
        : parsed(network);
    }

    const network = networkIdOf(id);

    return network === undefined
      ? invalid(
          `A network's id is 1 to 64 lowercase letters, digits, ., _, or -, not "${id}". ${usage}`
        )
      : parsed(network);
  };

/**
 * Turns a Network on or off, as `/set network.<id>.enabled on` or `off` does, through the
 * same edit, so a change another Frontend made meanwhile is applied to.
 * @param network - The Network.
 * @param on - Whether it is to be connected.
 * @returns The intent.
 */
const enabling = (network: NetworkId, on: boolean): Intent => ({
  _tag: "Configure",
  edit: { _tag: "Set", path: ["enabled"], text: on ? "on" : "off" },
  network,
});

const networkUsage = "/network add <id> <host>[/port] [plain] <nick>";
const removeUsage = "/network remove [id] [keep|drop]";

/**
 * What `/network remove` was given: the Network, the focused one unless named, and whether
 * its Timelines are to be kept, `keep` or `drop`, which the question starts with. One word
 * that is `keep` or `drop` is the choice, so a Network of that id is named with both words.
 * @param words - The words after `remove`.
 * @param context - The context, for the focused Network.
 * @returns The intent, or why there is none.
 */
const removeArguments = (words: readonly string[], context: CommandContext): Parsed<Intent> => {
  const [first, second, ...rest] =
    words.length === 1 && removalChoices.has(words[0]) ? [undefined, ...words] : words;

  if (rest.length > 0 || !removalChoices.has(second)) {
    return invalid(`Usage: ${removeUsage}`);
  }

  if (first === undefined) {
    const network = context.focus?.network ?? context.draft?.network;

    return network === undefined
      ? invalid(`Name a network, or open one of its conversations first. ${removeUsage}`)
      : parsed({ _tag: "AskRemoval", keep: removalChoices.get(second), network });
  }

  const network = networkIdOf(first);

  return network === undefined
    ? invalid(
        `A network's id is 1 to 64 lowercase letters, digits, ., _, or -, not "${first}". ${removeUsage}`
      )
    : parsed({ _tag: "AskRemoval", keep: removalChoices.get(second), network });
};

/**
 * What `/network` was given: `add` with an id, an Ircd, and a nick, or `remove`, with what
 * `removeArguments` reads.
 * @param args - The text after `/network`.
 * @param context - The context.
 * @returns The intent, or why there is none.
 */
const networkArguments = (args: string, context: CommandContext): Parsed<Intent> => {
  const words = args.split(/\s+/u).filter((one) => one !== "");
  const [verb, id = "", ...rest] = words;
  const nick = rest.at(-1);
  const ircdText = rest.slice(0, -1).join(" ");

  if (verb === "remove") {
    return removeArguments(words.slice(1), context);
  }

  if (verb !== "add") {
    return invalid(`Use ${networkUsage}, or ${removeUsage}.`);
  }

  const network = networkIdOf(id);

  if (network === undefined) {
    return invalid(
      `A network's id is 1 to 64 lowercase letters, digits, ., _, or -, not "${id}". ${networkUsage}`
    );
  }

  if (nick === undefined || ircdText === "") {
    return invalid(`Give a server and a nick. ${networkUsage}`);
  }

  const ircd = parseIrcd(ircdText);

  if (ircd._tag === "Invalid") {
    return ircd;
  }

  const configuration = starting(network, { nicks: [nick], servers: [ircd.value] });

  return configuration._tag === "Invalid"
    ? configuration
    : parsed({ _tag: "AddNetwork", configuration: configuration.value, network });
};

const closeUsage = "/close-conversation [#channel|nick]";

/**
 * What `/close-conversation` closes: a Channel or a nick given, as a Target the Network's Client
 * resolves by the Network's own naming, or else the one in focus, by its id, so one that no
 * Target names is closed all the same. The focused one is never a Network's own, which is
 * never closed.
 * @param args - The text after `/close-conversation`.
 * @param context - The context.
 * @returns The intent, or why there is none.
 */
const closeArguments = (
  args: string,
  context: CommandContext
): Parsed<CloseTimeline | CloseTarget> => {
  const { focus } = context;

  if (focus === undefined) {
    return invalid("Open a conversation first.");
  }

  const name = args.trim();

  if (name !== "") {
    // A list of Targets is never one Timeline.
    if (/[\s,]/u.test(name)) {
      return invalid(`Close one conversation at a time. ${closeUsage}`);
    }

    return parsed({ _tag: "CloseTarget", network: focus.network, target: name });
  }

  return focus.kind === "Network"
    ? invalid(
        `A network's own conversation can't be closed. Name a channel or nick, or open one. ${closeUsage}`
      )
    : parsed({ _tag: "CloseTimeline", network: focus.network, timeline: focus.timeline });
};

const ignoreUsage = "/ignore [<nick|mask>]";
const unignoreUsage = "/unignore <nick|mask>";

/**
 * The mask `/ignore` or `/unignore` was given: a bare nick as `nick!*@*`, or a mask as
 * written, parsed as the Client parses one.
 * @param usage - The command's usage.
 * @returns The parser.
 */
const ignoredMask =
  (usage: string) =>
  (args: string): Parsed<IgnoreMask> => {
    const given = args.trim();

    if (given === "" || /\s/u.test(given)) {
      return invalid(`Give one nick or mask. ${usage}`);
    }

    const text = given.includes("!") || given.includes("@") ? given : `${given}!*@*`;

    return Schema.is(IgnoreMask)(text)
      ? parsed(text)
      : invalid(
          `${given} is not a nick or a nick!user@host mask. Give every part, in at most 255 characters, with no space or comma.`
        );
  };

/**
 * What `/ignore` was given: a mask to ignore, or nothing, which lists those ignored.
 * @param args - The text after `/ignore`.
 * @returns The mask, or `undefined` for none.
 */
const ignoreArguments = (args: string): Parsed<IgnoreMask | undefined> =>
  args.trim() === "" ? parsed(undefined) : ignoredMask(ignoreUsage)(args);

/**
 * The Channels `/part` was given, or the one in focus.
 * @param args - The text after `/part`.
 * @param focus - The Timeline in focus.
 * @returns The Channels, or why there are none.
 */
const partArguments = (args: string, focus: Focus): Parsed<Edit> => {
  if (args.trim() !== "") {
    const channels = channelsOf(args);

    return channels._tag === "Invalid"
      ? channels
      : parsed({ _tag: "Part", channels: channels.value });
  }

  return focus.kind === "Channel" && focus.key !== undefined
    ? parsed({ _tag: "PartTimeline", key: focus.key, name: focus.name })
    : invalid("Name a channel to part, such as /part #iirc, or open the channel.");
};

/**
 * The Timeline next to the open one in the order the sidebar shows, wrapping around at either end,
 * or the first or the last when none is open.
 * @param direction - `Next` or `Previous`.
 * @returns The command's parser: the Timeline to open, or none when it is already open.
 */
const stepped =
  (direction: "Next" | "Previous") =>
  (args: string, context: CommandContext): Parsed<TimelineId | undefined> => {
    const { open, timelines } = context;
    const count = timelines.length;

    if (args.trim() !== "") {
      return invalid(`/${direction === "Next" ? "next" : "previous"} takes nothing after it.`);
    }

    if (count === 0) {
      return invalid("There are no conversations yet. Add a network with /network add.");
    }

    const at = open === undefined ? -1 : timelines.indexOf(open);
    const step = direction === "Next" ? 1 : -1;
    const from = at === -1 && direction === "Previous" ? 0 : at;
    const to = timelines[(((from + step) % count) + count) % count];

    return parsed(to === open ? undefined : to);
  };

/**
 * What `/move` was given: `up` or `down`.
 * @param args - The text after `/move`.
 * @returns The direction, or why there is none.
 */
const moveArguments = (args: string): Parsed<"Up" | "Down"> => {
  const way = args.trim().toLowerCase();

  if (way === "up") {
    return parsed("Up");
  }

  return way === "down" ? parsed("Down") : invalid("Move it up or down: /move up|down");
};

/**
 * What `/pin` does with the open Timeline: unpins it when it is pinned, else pins it, as the
 * options read when it is carried out say, unless it is a Network's own, whose row is the
 * Network.
 * @param args - The text after `/pin`.
 * @param context - The context.
 * @returns The edit, or why there is none.
 */
const pinArguments = (args: string, context: CommandContext): Parsed<ArrangeEdit> => {
  const { focus } = context;

  if (args.trim() !== "") {
    return invalid("/pin takes nothing after it.");
  }

  if (focus === undefined) {
    return invalid("Open a conversation first.");
  }

  if (focus.kind === "Network") {
    return invalid(
      `${focus.network}'s own conversation is the network's row, so it can't be pinned. /move moves the network.`
    );
  }

  return parsed({ _tag: "Pin", timeline: focus.timeline });
};

const goUsage = "/go [network] <name>";

/**
 * Whether two Timelines' names are the same, folded as RFC 1459 does, which only chooses
 * among the Timelines the Daemon already keeps, never names a Target.
 * @param left - One name.
 * @param right - The other.
 * @returns Whether they are.
 */
const sameName = (left: string, right: string) =>
  casefold("rfc1459", left) === casefold("rfc1459", right);

/**
 * The Timeline `/go` was given: a name, on the Network the composer is on if one there has
 * it, else on the one Network that has it, or a Network's id and a name. Of several on one
 * Network, the first listed, an open one before one closed, is taken.
 * @param named - Every Timeline by name.
 * @param here - The Network the composer is on, if any.
 * @param args - The text after `/go`.
 * @returns The Timeline, or why there is none.
 */
export const timelineNamed = (
  named: readonly NamedTimeline[],
  here: NetworkId | undefined,
  args: string
): Parsed<TimelineId> => {
  const [first, second, ...rest] = args
    .trim()
    .split(/\s+/u)
    .filter((one) => one !== "");

  if (first === undefined) {
    return invalid(`Name a conversation. Usage: ${goUsage}`);
  }

  if (rest.length > 0) {
    return invalid(`Give a name, or a network's id and a name. Usage: ${goUsage}`);
  }

  if (second !== undefined) {
    const network = first.toLowerCase();
    const found = named.find((one) => one.network === network && sameName(one.name, second));

    return found === undefined
      ? invalid(`There is no conversation ${second} on ${network}. Usage: ${goUsage}`)
      : parsed(found.timeline);
  }

  const all = named.filter((one) => sameName(one.name, first));
  const networks = [...new Set(all.map((one) => one.network))];

  const found =
    all.find((one) => one.network === here) ?? (networks.length === 1 ? all[0] : undefined);

  if (found !== undefined) {
    return parsed(found.timeline);
  }

  return networks.length === 0
    ? invalid(`There is no conversation named ${first}. Usage: ${goUsage}`)
    : invalid(
        `${first} is on ${networks.join(", ")}. Name its network, as in /go ${networks[0] ?? ""} ${first}. Usage: ${goUsage}`
      );
};

const themeUsage =
  "/theme [[-device] [-light | -dark] <name> | -light | -dark | import | remove <name>]";

/** The flags `/theme` reads before a theme's name, each naming the option it sets. */
const schemeFlags: ReadonlyMap<string, ThemeOption> = new Map([
  ["-dark", "theme.dark"],
  ["-light", "theme.light"],
]);

/**
 * Whether the device is light or dark where an option names the theme `system` draws, in
 * the word its flag is written with.
 * @param option - The option, never `theme` itself.
 * @returns The word.
 */
const schemeOf = (option: Exclude<ThemeOption, "theme">): "dark" | "light" =>
  option === "theme.dark" ? "dark" : "light";

/**
 * What `/theme` was given before a theme's name: `-device`, and `-light` or `-dark`, in
 * either order, each at most once.
 * @param words - The words after `/theme`, lowercased.
 * @returns The flags, and how many words they took, or none for a flag given twice.
 */
export const themeFlags = (
  words: readonly string[]
):
  | { readonly device: boolean; readonly option: ThemeOption; readonly taken: number }
  | undefined => {
  let device = false;
  let option: ThemeOption = "theme";
  let taken = 0;

  for (const word of words) {
    const scheme = schemeFlags.get(word);

    if (word === deviceFlag && !device) {
      device = true;
    } else if (scheme !== undefined && option === "theme") {
      option = scheme;
    } else if (word === deviceFlag || scheme !== undefined) {
      return undefined;
    } else {
      break;
    }

    taken += 1;
  }

  return { device, option, taken };
};

/**
 * What `/theme` was given: nothing, to start `/theme ` with the themes listed; `-light` or
 * `-dark` alone, to start it so to choose the one `system` draws while the device is light
 * or dark; `import`, to read
 * one from a file; `remove` and a name, to remove one imported; or a name, perhaps after
 * `-device`, `-light`, or `-dark`, to draw in it, or to have `system` draw it. `system` is
 * never the theme `system` draws.
 * @param args - The text after `/theme`.
 * @returns The intent, or why there is none.
 */
const themeArguments = (args: string): Parsed<Intent> => {
  const words = args
    .trim()
    .split(/\s+/u)
    .filter((one) => one !== "");

  const [first, second, ...rest] = words;
  const lowered = first?.toLowerCase();

  if (first === undefined) {
    return parsed({ _tag: "StartCommand", text: "/theme " });
  }

  if (lowered === "import") {
    return second === undefined
      ? parsed({ _tag: "ImportTheme" })
      : invalid("/theme import takes nothing after it: paste the theme into the dialog it opens.");
  }

  if (lowered === "remove") {
    const name =
      second === undefined || rest.length > 0
        ? invalid<ThemeName>(`Usage: ${themeUsage}`)
        : parseThemeName(second);

    return name._tag === "Invalid"
      ? name
      : parsed({ _tag: "EditThemes", edit: { _tag: "Remove", name: name.value } });
  }

  const flags = themeFlags(words.map((one) => one.toLowerCase()));
  const named = flags === undefined ? [] : words.slice(flags.taken);

  if (flags === undefined || named.length > 1) {
    return invalid(`Usage: ${themeUsage}`);
  }

  const [one] = named;

  if (one === undefined) {
    return flags.option === "theme" || flags.device
      ? invalid(`Usage: ${themeUsage}`)
      : parsed({ _tag: "StartCommand", text: `/theme -${schemeOf(flags.option)} ` });
  }

  const name = parseThemeName(one);

  if (name._tag === "Invalid") {
    return name;
  }

  if (flags.option !== "theme" && name.value === systemTheme) {
    const scheme = schemeOf(flags.option);

    return invalid(
      `system follows the device, so it can't be the theme for a ${scheme} device. Name a theme, such as ${scheme}.`
    );
  }

  return parsed({ _tag: "UseTheme", device: flags.device, name: name.value, option: flags.option });
};

/**
 * The parser of a command that takes nothing after its name.
 * @param name - Its name, to say so.
 * @returns Its parser.
 */
const nothingAfter =
  (name: string) =>
  (args: string): Parsed<undefined> =>
    args.trim() === "" ? parsed(undefined) : invalid(`/${name} takes nothing after it.`);

/**
 * The command that turns a flag over in the composer, named for it.
 * @param flag - The flag.
 * @param what - What it is called, in words.
 * @returns The command.
 */
const formatCommand = (flag: Flag, what: string): Command =>
  unfocused({
    aliases: [],
    arguments: "None",
    description: `Turn ${what} on or off for the selected text, or for what you type next.`,
    id: `format.${flag}`,
    intents: () => [{ _tag: "Format", format: flag }],
    name: flag,
    parse: nothingAfter(flag),
    usage: `/${flag}`,
    when: [],
  });

/**
 * The marks of Timelines with something unread, skipping any that would change nothing.
 * @param unseen - The Timelines.
 * @returns Their marks.
 */
const marksOf = (unseen: readonly Unseen[]): readonly MarkRead[] =>
  unseen.flatMap((one) => (one.mark === undefined ? [] : [one.mark]));

/**
 * What `/read` was given: nothing, to mark the open Timeline read, or `all`, to mark every
 * Timeline read, each up to its latest item.
 * @param args - The text after `/read`.
 * @param context - The context.
 * @returns The marks, none when nothing is unread, or why there are none.
 */
const readArguments = (args: string, context: CommandContext): Parsed<readonly MarkRead[]> => {
  const what = args.trim().toLowerCase();

  if (what === "all") {
    return parsed(marksOf([...context.unread, ...context.unreadClosed]));
  }

  if (what !== "") {
    return invalid("Use /read for the open conversation, or /read all for every conversation.");
  }

  const { focus } = context;

  return focus === undefined
    ? invalid("Open a conversation first, or use /read all.")
    : parsed(
        marksOf(
          [...context.unread, ...context.unreadClosed].filter(
            (one) => one.timeline === focus.timeline
          )
        )
      );
};

/** The least a Timeline's highest level must be for `/next-unread` to go to it. */
const worthJumping = rank("Message");

/**
 * The Timeline with the most calling for the Owner, of those not skipped: the highest level
 * unread, at least Messages, and ties by the order the sidebar shows, the pinned first.
 * @param context - The context.
 * @param skip - Whether a Timeline is skipped.
 * @returns The Timeline, or none when nothing calls.
 */
const calling = (
  context: CommandContext,
  skip: (timeline: TimelineId) => boolean
): TimelineId | undefined => {
  let best: Unseen | undefined;

  for (const one of context.unread) {
    const ranked = rank(one.level);

    if (
      !skip(one.timeline) &&
      ranked >= worthJumping &&
      (best === undefined || ranked > rank(best.level))
    ) {
      best = one;
    }
  }

  return best?.timeline;
};

/**
 * The Timeline with the most calling for the Owner, other than the one shown: the highest
 * level unread, Highlights first, then Direct Messages, then Messages, and ties by the
 * sidebar's order. Activity alone is not enough, since joins and quits pile up everywhere.
 * @param args - The text after `/next-unread`.
 * @param context - The context.
 * @returns The Timeline to open, or none when nothing else calls.
 */
const nextUnread = (args: string, context: CommandContext): Parsed<TimelineId | undefined> =>
  args.trim() === ""
    ? parsed(calling(context, (timeline) => !context.behind && timeline === context.open))
    : invalid("/next-unread takes nothing after it.");

const directions: ReadonlyMap<string, Direction> = new Map([
  ["left", "Left"],
  ["right", "Right"],
  ["up", "Up"],
  ["down", "Down"],
]);

/**
 * A direction, `left`, `right`, `up`, or `down`, in any ASCII case.
 * @param name - The command's name, to say how it is typed.
 * @returns The parser.
 */
const directionOf =
  (name: string) =>
  (args: string): Parsed<Direction> => {
    const direction = directions.get(args.trim().toLowerCase());

    return direction === undefined
      ? invalid(`Use /${name} left, right, up, or down.`)
      : parsed(direction);
  };

/**
 * What `/split` was given: `h`, side by side, as tmux and i3 mean it, the default, or `v`,
 * one above another. The new Pane opens the Timeline calling for the Owner most that no
 * Pane shows, as `/next-unread` would choose, or is empty when none does.
 * @param args - The text after `/split`.
 * @param context - The context.
 * @returns The change, or why there is none.
 */
const splitArguments = (args: string, context: CommandContext): Parsed<PaneChange> => {
  const what = args.trim().toLowerCase();
  let axis: Axis | undefined;

  if (what === "" || what === "h") {
    axis = "Horizontal";
  } else if (what === "v") {
    axis = "Vertical";
  }

  return axis === undefined
    ? invalid("Use /split h for side by side, or /split v for one above another.")
    : parsed({
        _tag: "Split",
        axis,
        timeline: calling(context, (timeline) => context.shown.includes(timeline)),
      });
};

/**
 * The parser of a change to the Panes that takes nothing after its name.
 * @param name - Its name, to say so.
 * @param change - The change.
 * @returns Its parser.
 */
const ofPanes =
  (name: string, change: PaneChange) =>
  (args: string): Parsed<PaneChange> =>
    args.trim() === "" ? parsed(change) : invalid(`/${name} takes nothing after it.`);

/**
 * The parser of a change to the Panes in a direction.
 * @param name - Its name, to say how it is typed.
 * @param change - The change in a direction.
 * @returns Its parser.
 */
const towards =
  (name: string, change: (direction: Direction) => PaneChange) =>
  (args: string): Parsed<PaneChange> => {
    const direction = directionOf(name)(args);

    return direction._tag === "Parsed" ? parsed(change(direction.value)) : direction;
  };

/** Needs more than one Pane. */
const panesNeeded: readonly Condition[] = [{ _tag: "Panes" }];

/**
 * A command that changes the Panes.
 * @param spec - The command, with its parser.
 * @returns The command.
 */
const paneCommand = (
  spec: Omit<Command, "run"> & {
    readonly parse: (args: string, context: CommandContext) => Parsed<PaneChange>;
  }
): Command => unfocused({ ...spec, intents: (change: PaneChange) => [{ _tag: "Pane", change }] });

/**
 * What `/notify` was given: `on` or `off`.
 * @param args - The text after `/notify`.
 * @returns Whether to turn notifications on, or why it cannot tell.
 */
const notifyArguments = (args: string): Parsed<boolean> => {
  const what = args.trim().toLowerCase();

  if (what === "on" || what === "off") {
    return parsed(what === "on");
  }

  return invalid("Use /notify on or /notify off.");
};

/** Each word `/previews` takes, and the choice it makes, none returning to `ui.previews`. */
const previewsWords: ReadonlyMap<string, PreviewsShown | undefined> = new Map([
  ["default", undefined],
  ["text", "text"],
  ["off", "off"],
  ["on", "on"],
]);

/**
 * What `/previews` was given: `off`, `text`, `on`, or `default`, in any case.
 * @param args - The text after `/previews`.
 * @returns The Timeline's own choice, none to follow `ui.previews`, or why it cannot tell.
 */
const previewsArguments = (args: string): Parsed<PreviewsShown | undefined> => {
  const said = args.trim().toLowerCase().replaceAll(/\s+/gu, " ");

  return previewsWords.has(said)
    ? parsed(previewsWords.get(said))
    : invalid("Use /previews off, text, on, or default.");
};

/**
 * What a command that shows or hides something was given: nothing, to turn it over, or
 * `on` or `off`.
 * @param name - The command's name, such as `members`.
 * @param what - What it shows, as said in a refusal, such as `them`.
 * @returns The parser, giving whether to show it, none to turn it over, or why it cannot
 * tell.
 */
const shownArguments =
  (name: string, what: string) =>
  (args: string): Parsed<boolean | undefined> => {
    const said = args.trim().toLowerCase();

    if (said === "") {
      return parsed(undefined);
    }

    if (said === "on" || said === "off") {
      return parsed(said === "on");
    }

    return invalid(`Use /${name} to show or hide ${what}, or /${name} on or /${name} off.`);
  };

/**
 * What `/query` was given: one name, with no space or `,`.
 * @param args - The text after `/query`.
 * @returns The name, or why it is not one.
 */
const queryArguments = (args: string): Parsed<string> => {
  const name = args.trim();

  if (name === "") {
    return invalid("Add a nick. /query <nick>");
  }

  if (/[\s,]/u.test(name)) {
    return invalid("Give one nick. To message them, use /msg <nick> <text>.");
  }

  return parsed(name);
};

const target: readonly Condition[] = [{ _tag: "Live" }, { _tag: "Target" }, { _tag: "Session" }];

/**
 * A Lookup's command: `/whois` or `/whowas` of one nick, read as the Client reads one, on
 * the open Timeline's Network.
 * @param kind - The Lookup.
 * @param description - What it does.
 * @returns The command.
 */
const lookupCommand = (kind: UserKind, description: string): Command => {
  const name = kind.toLowerCase();

  return {
    aliases: [],
    arguments: "Required",
    description,
    id: `lookup.${name}`,
    name,
    run: (args, context) => {
      const { focus, head } = context;

      if (focus === undefined) {
        return invalid("Open a conversation first.");
      }

      const nick = parseLookupNick(kind, args, nickRulesOf(head));

      return nick._tag === "Invalid"
        ? nick
        : parsed([lookOf(kind, nick.value, focus.network, focus.timeline, head)]);
    },
    usage: `/${name} <nick>`,
    when: [{ _tag: "Focused" }, { _tag: "Live" }, { _tag: "Session" }],
  };
};

/**
 * The head of the Channel in focus, when it was read for that Timeline.
 * @param context - The context.
 * @returns The head, or none.
 */
const focusHead = (context: CommandContext): ChannelHeader | undefined =>
  context.focus !== undefined && context.head?.timeline === context.focus.timeline
    ? context.head
    : undefined;

/**
 * A list's command: a Channel's bans, ban exceptions, or invitation masks, of the Channel
 * named, or the one in focus, on the open Timeline's Network. It is offered unless the head
 * of the Channel in focus says the Network keeps no such list.
 * @param kind - The list.
 * @param aliases - Its other names.
 * @param description - What it does.
 * @returns The command.
 */
const listCommand = (kind: ListKind, aliases: readonly string[], description: string): Command => {
  const name = listCommandNames[kind];

  return {
    aliases,
    arguments: "Optional",
    description,
    id: `lookup.${name}`,
    name,
    run: (args, context) => {
      const { focus } = context;

      if (focus === undefined) {
        return invalid("Open a conversation first.");
      }

      const head = focusHead(context);
      const channel = parseListChannel(kind, args, focus, head?.chantypes ?? undefined);

      return channel._tag === "Invalid"
        ? channel
        : parsed([listLookOf(kind, channel.value, focus.network, focus.timeline)]);
    },
    usage: `/${name} [channel]`,
    when: [
      { _tag: "Focused" },
      { _tag: "Live" },
      { _tag: "Session" },
      { _tag: "Keeps", list: kind },
    ],
  };
};

/**
 * `/names`: a Channel's members, of the Channel named, or the one in focus, on the open
 * Timeline's Network, shown with the Network's prefix symbols.
 * @returns The command.
 */
const namesCommand = (): Command => ({
  aliases: [],
  arguments: "Optional",
  description: "List the members of the open channel or another, with their ranks.",
  id: "lookup.names",
  name: "names",
  run: (args, context) => {
    const { focus } = context;

    if (focus === undefined) {
      return invalid("Open a conversation first.");
    }

    const head = focusHead(context);
    const channel = parseListChannel("Names", args, focus, head?.chantypes ?? undefined);

    return channel._tag === "Invalid"
      ? channel
      : parsed([namesLookOf(channel.value, focus.network, focus.timeline, head)]);
  },
  usage: "/names [channel]",
  when: [{ _tag: "Focused" }, { _tag: "Live" }, { _tag: "Session" }],
});

/**
 * `/who`: the Users a mask matches on the open Timeline's Network.
 * @returns The command.
 */
const whoCommand = (): Command => ({
  aliases: [],
  arguments: "Required",
  description: "List the users on the open conversation's network that match a mask.",
  id: "lookup.who",
  name: "who",
  run: (args, context) => {
    const { focus } = context;

    if (focus === undefined) {
      return invalid("Open a conversation first.");
    }

    const mask = parseWhoMask(args);

    return mask._tag === "Invalid"
      ? mask
      : parsed([whoLookOf(mask.value, focus.network, focus.timeline)]);
  },
  usage: "/who <mask>",
  when: [{ _tag: "Focused" }, { _tag: "Live" }, { _tag: "Session" }],
});

/**
 * `/list`: the Network's Channels, most members first, those whose names match a mask and
 * with at least a number of members, each where given, on the open Timeline's Network.
 * @returns The command.
 */
const directoryCommand = (): Command => ({
  aliases: [],
  arguments: "Optional",
  description:
    "List the channels on the open conversation's network, the largest first, to join one.",
  id: "lookup.list",
  name: "list",
  run: (args, context) => {
    const { focus } = context;

    if (focus === undefined) {
      return invalid("Open a conversation first.");
    }

    const conditions = parseConditions(args);

    return conditions._tag === "Invalid"
      ? conditions
      : parsed([directoryLookOf(conditions.value, focus.network, focus.timeline)]);
  },
  usage: "/list [mask] [least]",
  when: [{ _tag: "Focused" }, { _tag: "Live" }, { _tag: "Session" }],
});

const anywhere: readonly Condition[] = [{ _tag: "Focused" }, { _tag: "Live" }, { _tag: "Session" }];
const anywhereActing = anywhere;
const focused: readonly Condition[] = [{ _tag: "Focused" }];

/**
 * The command that mutes the open Timeline, or unmutes it, whatever it is, a Network's own
 * included.
 * @param muted - Whether it mutes.
 * @returns The command.
 */
const muteCommand = (muted: boolean): Command => {
  const name = muted ? "mute" : "unmute";

  return command({
    aliases: [],
    arguments: "None",
    description: muted
      ? "Mute the open conversation on every device. It shows no unread count and only notifies you of highlights."
      : "Unmute the open conversation, for every device.",
    id: `timeline.${name}`,
    intents: (_none: undefined, focus) => [{ _tag: "Mute", muted, timeline: focus.timeline }],
    name,
    parse: nothingAfter(name),
    usage: `/${name}`,
    when: focused,
  });
};

/** A Timeline in focus whose Network can still be changed. */
const live: readonly Condition[] = [{ _tag: "Focused" }, { _tag: "Live" }];

// Acting.

/** Starting the composer with text, as `/topic` alone does, rather than acting. */
type Starting = Extract<Intent, { readonly _tag: "FocusComposer" }>;

/**
 * A command that acts on the focused Timeline's Network, parsed with the head of the
 * Channel in focus, if read.
 * @param spec - The command, with its parser, which gives the action or other intents.
 * @returns The command.
 */
const acting = (
  spec: Omit<Command, "run"> & {
    readonly parse: (
      args: string,
      focus: Focus,
      head: ChannelHeader | undefined
    ) => Parsed<ActionRequest | Starting>;
  }
): Command => {
  const { parse, ...rest } = spec;

  return {
    ...rest,
    run: (args, context) => {
      const { focus } = context;

      if (focus === undefined) {
        return invalid("Open a conversation first.");
      }

      const head = context.head?.timeline === focus.timeline ? context.head : undefined;
      const value = parse(args, focus, head);

      if (value._tag === "Invalid") {
        return value;
      }

      const { value: action } = value;

      return parsed(
        action._tag === "FocusComposer"
          ? [action]
          : [{ _tag: "Act", action, network: focus.network }]
      );
    },
  };
};

/**
 * The words of a text, split at runs of whitespace, none empty.
 * @param text - The text.
 * @returns Its words.
 */
const wordsOf = (text: string): readonly string[] => text.split(/\s+/u).filter((one) => one !== "");

/**
 * The commands of a raw Line that carry a Credential, which the Client never sends written
 * as text, since a Line written as text is journaled as written.
 */
const credentialCommands: ReadonlySet<string> = new Set(["AUTHENTICATE", "OPER", "PASS"]);

const rawCredentialRefused =
  "Don't put a password in a raw command. PASS and AUTHENTICATE carry one, and history records raw commands whole. It was cleared and nothing was sent.";

const rawOperRefused =
  "OPER carries a password, and history records raw commands whole. Set network.<id>.oper.name and network.<id>.oper.password instead, and iirc signs in as an operator each time it connects. It was cleared and nothing was sent.";

/**
 * Why a raw Line with a command is refused, or nothing when it is not: `OPER` is
 * configured instead, and `PASS` and `AUTHENTICATE` are never typed.
 * @param command - The raw Line's command, in upper case.
 * @returns The words, or none.
 */
const rawRefusalOf = (command: string): string | undefined => {
  if (command === "OPER") {
    return rawOperRefused;
  }

  return credentialCommands.has(command) ? rawCredentialRefused : undefined;
};

/**
 * A text in lower case, ASCII letters only, as a command's name is matched.
 * @param text - The text.
 * @returns It, lowercased.
 */
const lowerCaseAscii = (text: string): string =>
  text.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());

/**
 * A text in upper case, ASCII letters only, as an Ircd reads a command.
 * @param text - The text.
 * @returns It, upper-cased.
 */
const upperCaseAscii = (text: string): string =>
  text.replaceAll(/[a-z]/gu, (letter) => letter.toUpperCase());

/**
 * A raw Line's command, as an Ircd reads it: after any tags and source, in upper case.
 * @param line - The raw Line, as typed.
 * @returns Its command, or `""` for none.
 */
const rawCommandOf = (line: string): string => {
  const words = wordsOf(line);
  const tags = words[0]?.startsWith("@") === true ? 1 : 0;
  const start = tags + (words[tags]?.startsWith(":") === true ? 1 : 0);

  return upperCaseAscii(words[start] ?? "");
};

/**
 * A name the Owner gives, one word with no `,`, or why it is not one.
 * @param name - The name.
 * @param what - What it names, to say so.
 * @returns The name.
 */
const oneName = (name: string, what: string): Parsed<string> =>
  name === "" || /[\s,]/u.test(name) ? invalid(`Give one ${what}, not "${name}".`) : parsed(name);

const topicUsage = "/topic [<text> | -delete]";

/**
 * The topic as last read, the text of a Known or Stale one, `null` when none is set, or
 * none when it is not known.
 * @param head - The Channel's head.
 * @returns The topic.
 */
const topicOf = (head: ChannelHeader | undefined): string | null | undefined => {
  const fact = head?.topic;

  if (fact === undefined || fact._tag === "Unknown") {
    return undefined;
  }

  const topic = fact._tag === "Known" ? fact.value : fact.was;

  return topic === null ? null : topic.text;
};

/**
 * What `/topic` was given: text to set the topic to, exactly, `-delete` to clear it, or
 * nothing, to put `/topic` and the topic as last read in the composer to edit.
 * @param args - The text after `/topic`.
 * @param focus - The Channel in focus.
 * @param head - Its head, if read.
 * @returns The action, or the intent that starts the composer.
 */
const topicArguments = (
  args: string,
  focus: Focus,
  head: ChannelHeader | undefined
): Parsed<ActionRequest | Starting> => {
  if (args.trim() === "-delete") {
    return parsed({ _tag: "Topic", channel: focus.name, text: "" });
  }

  if (args.trim() !== "") {
    return parsed({ _tag: "Topic", channel: focus.name, text: args });
  }

  const topic = topicOf(head);

  if (topic === undefined) {
    return invalid(
      `The topic of ${focus.name} is not known yet. Give the new topic: ${topicUsage}.`
    );
  }

  return parsed({ _tag: "FocusComposer", text: `/topic ${topic ?? ""}` });
};

/**
 * What `/kick` was given: nicks, comma-separated, and a reason, the rest of the line.
 * @param args - The text after `/kick`.
 * @param focus - The Channel in focus.
 * @returns The action.
 */
const kickArguments = (args: string, focus: Focus): Parsed<ActionRequest> => {
  const trimmed = args.trimStart();
  const space = trimmed.search(/\s/u);
  const list = space === -1 ? trimmed : trimmed.slice(0, space);
  const reason = space === -1 ? "" : trimmed.slice(space + 1);
  const [first, ...rest] = list.split(",");

  if (first === undefined || first === "") {
    return invalid("Add a nick. /kick <nick>[,<nick>…] [reason]");
  }

  if (rest.includes("")) {
    return invalid(`Give nicks separated by single commas, not "${list}".`);
  }

  return parsed({
    _tag: "Kick",
    channel: focus.name,
    nicks: [first, ...rest],
    reason: reason.trim() === "" ? null : reason,
  });
};

/** How the Channel modes take a parameter, as the head gave them. */
type Chanmodes = NonNullable<ChannelHeader["chanmodes"]>;

/** What an action on a Channel's modes is parsed by: the Network's rules, from the head. */
interface ModeRules {
  readonly ranks: ChannelHeader["ranks"];
  readonly chanmodes: Chanmodes;
  readonly chantypes: string;
}

/**
 * The rules of the Network in focus, from the head of the Channel in focus: `PREFIX`,
 * `CHANMODES`, and `CHANTYPES` are the Network's, so they hold for any Channel on it.
 * @param head - The head, if read.
 * @returns The rules, or none until a head is read.
 */
const rulesOf = (head: ChannelHeader | undefined): ModeRules | undefined =>
  head?.chanmodes === null ||
  head?.chanmodes === undefined ||
  head.chantypes === null ||
  head.chantypes === undefined
    ? undefined
    : { chanmodes: head.chanmodes, chantypes: head.chantypes, ranks: head.ranks };

const rulesUnknown = (focus: Focus) =>
  `The modes ${focus.network} supports are not known yet. Open a channel on it, wait for it to load, and try again.`;

/**
 * Whether a Channel's mode takes a parameter when set or unset, by `PREFIX` and
 * `CHANMODES`, or none when neither names it.
 * @param rules - The rules.
 * @param mode - The mode's letter.
 * @param set - Whether it is set.
 * @returns Whether it takes one.
 */
const takesParameter = (rules: ModeRules, mode: string, set: boolean): boolean | undefined => {
  const { always, flags, list, whenSet } = rules.chanmodes;

  if (
    rules.ranks.some((one) => one.mode === mode) ||
    list.includes(mode) ||
    always.includes(mode)
  ) {
    return true;
  }

  if (whenSet.includes(mode)) {
    return set;
  }

  return flags.includes(mode) ? false : undefined;
};

/** One mode change as typed, before its parameter is given. */
interface Change {
  readonly set: boolean;
  readonly mode: string;
}

/**
 * Reads a mode string, such as `+ov-l`: each letter after a sign is one change.
 * @param text - The mode string.
 * @returns The changes, or why it is not one.
 */
const changesOf = (text: string): Parsed<readonly Change[]> => {
  const changes: Change[] = [];
  let set: boolean | undefined;

  for (const letter of text) {
    if (letter === "+" || letter === "-") {
      set = letter === "+";
    } else if (set === undefined || !/^[!-~]$/u.test(letter) || letter === ":" || letter === ",") {
      return invalid(`"${text}" is not a mode change: give signs and letters, such as +o or -v+l.`);
    } else {
      changes.push({ mode: letter, set });
    }
  }

  return changes.length === 0
    ? invalid(`"${text}" changes no mode: give signs and letters, such as +o or -v+l.`)
    : parsed(changes);
};

const modeUsage = "/mode [target] <changes> [parameters…]";

/**
 * Whether `/mode`'s first word names its target. One starting with `+` or `-` is the
 * changes to the open Channel, unless it can name a Channel, by `CHANTYPES`, and a second
 * word reads as changes, as `/mode +local +m` does with `+` a Channel's prefix.
 * @param first - The first word.
 * @param second - The second word, or `""`.
 * @param chantypes - What starts a Channel's name.
 * @returns Whether it names the target.
 */
const namesTarget = (first: string, second: string, chantypes: string): boolean =>
  (!first.startsWith("+") && !first.startsWith("-")) ||
  (chantypes.includes(first[0] ?? " ") && changesOf(second)._tag === "Parsed");

/**
 * A Channel's mode changes, each given the next parameter when it takes one, as the
 * Network's `PREFIX` and `CHANMODES` say, the Client checking them the same way.
 * @param rules - The Network's rules.
 * @param focus - The Timeline in focus, to name its Network.
 * @param target - The Channel.
 * @param changes - The changes, in order.
 * @param params - The parameters, in order.
 * @returns The action.
 */
const onChannelOf = (
  rules: ModeRules,
  focus: Focus,
  target: string,
  changes: readonly Change[],
  params: readonly string[]
): Parsed<ActionRequest> => {
  const given = [...params];

  const requests: {
    readonly set: boolean;
    readonly mode: string;
    readonly param: string | null;
  }[] = [];

  for (const change of changes) {
    const takes = takesParameter(rules, change.mode, change.set);
    const sign = change.set ? "+" : "-";

    if (takes === undefined) {
      return invalid(`${focus.network} does not support the channel mode ${change.mode}.`);
    }

    const param = takes ? given.shift() : undefined;

    if (takes && param === undefined) {
      return invalid(`${sign}${change.mode} needs a parameter. ${modeUsage}`);
    }

    requests.push({ ...change, param: param ?? null });
  }

  if (given.length > 0) {
    return invalid(`No mode takes ${given.join(" ")}. ${modeUsage}`);
  }

  const [one, ...others] = requests;

  return one === undefined
    ? invalid(`Give the modes to change. ${modeUsage}`)
    : parsed({ _tag: "Mode", changes: [one, ...others], target });
};

/**
 * What `/mode` was given: a target, the open Channel when left out, a mode string, and its
 * parameters in order. On a Channel each change takes a parameter exactly as the Network's
 * `PREFIX` and `CHANMODES` say, as the Client checks it. On Self, none does.
 * @param args - The text after `/mode`.
 * @param focus - The Timeline in focus.
 * @param head - The head of the Channel in focus, if read.
 * @returns The action.
 */
const modeArguments = (
  args: string,
  focus: Focus,
  head: ChannelHeader | undefined
): Parsed<ActionRequest> => {
  const [first = "", second = "", ...more] = wordsOf(args);
  const rest = second === "" ? [] : [second, ...more];
  const rules = rulesOf(head);
  // RFC 2811's prefixes stand in until a head says the Network's.
  const chantypes = rules?.chantypes ?? "#&+!";

  const named = namesTarget(first, second, chantypes);

  if (first === "") {
    return invalid(`Give the modes to change. ${modeUsage}`);
  }

  if (!named && focus.kind !== "Channel") {
    return invalid(`Name a nick or channel, or open a channel. ${modeUsage}`);
  }

  const target = named ? first : focus.name;
  const [modes = "", ...params] = named ? rest : [first, ...rest];
  const changes = changesOf(modes);

  if (changes._tag === "Invalid") {
    return changes;
  }

  const onChannel = chantypes.includes(target[0] ?? " ");

  if (!onChannel) {
    const [one, ...others] = changes.value.map((change) => ({ ...change, param: null }));

    if (params.length > 0) {
      return invalid(`Your modes take no parameters here. Use /quote MODE ${target} … for that.`);
    }

    return one === undefined
      ? invalid(`Give the modes to change. ${modeUsage}`)
      : parsed({ _tag: "Mode", changes: [one, ...others], target });
  }

  return rules === undefined
    ? invalid(rulesUnknown(focus))
    : onChannelOf(rules, focus, target, changes.value, params);
};

/** What RFC 2811 names a rank's mode, to say which a Network lacks. */
const rankNames: ReadonlyMap<string, string> = new Map([
  ["o", "operator"],
  ["v", "voice"],
]);

/**
 * A membership mode given to or taken from nicks in the Channel in focus, as `/op`,
 * `/deop`, `/voice`, and `/devoice` do, once the Network's `PREFIX` has it.
 * @param mode - The rank's mode, `o` or `v`.
 * @param set - Whether it is given.
 * @param usage - How the command is typed.
 * @returns The command's parser.
 */
const ranked = (mode: string, set: boolean, usage: string) => {
  const change = (nick: string) => ({ mode, param: nick, set });

  return (args: string, focus: Focus, head: ChannelHeader | undefined): Parsed<ActionRequest> => {
    const [first, ...rest] = wordsOf(args.replaceAll(",", " "));

    if (first === undefined) {
      return invalid(`Add a nick. ${usage}`);
    }

    if (head === undefined) {
      return invalid(rulesUnknown(focus));
    }

    if (!head.ranks.some((one) => one.mode === mode)) {
      const ranks = head.ranks.map((one) => `${one.symbol} (${one.mode})`).join(", ");

      return invalid(
        `${focus.network} has no ${rankNames.get(mode) ?? mode} rank (${mode}). Its ranks are ${ranks === "" ? "none" : ranks}.`
      );
    }

    return parsed({
      _tag: "Mode",
      changes: [change(first), ...rest.map(change)],
      target: focus.name,
    });
  };
};

/**
 * A ban mask: a mask as given, or a bare nick as `nick!*@*`.
 * @param given - A nick or a mask.
 * @returns The mask.
 */
const maskOf = (given: string): string =>
  given.includes("!") || given.includes("@") ? given : `${given}!*@*`;

/**
 * Bans or unbans masks in the Channel in focus, once the Network's `CHANMODES` lists `b`.
 * @param set - Whether to ban.
 * @param usage - How the command is typed.
 * @returns The command's parser.
 */
const banned = (set: boolean, usage: string) => {
  const change = (given: string) => ({ mode: "b", param: maskOf(given), set });

  return (args: string, focus: Focus, head: ChannelHeader | undefined): Parsed<ActionRequest> => {
    const [first, ...rest] = wordsOf(args);

    if (first === undefined) {
      return invalid(`Add a nick. ${usage}`);
    }

    const rules = rulesOf(head);

    if (rules === undefined) {
      return invalid(rulesUnknown(focus));
    }

    if (!rules.chanmodes.list.includes("b")) {
      return invalid(`${focus.network} does not support bans.`);
    }

    return parsed({
      _tag: "Mode",
      changes: [change(first), ...rest.map(change)],
      target: focus.name,
    });
  };
};

const banAccountUsage = "/ban -a <nick>";

const banPlain = banned(true, "/ban <nick|mask>… | /ban -a <nick>");

/**
 * What `/ban -a` was given, as one `BanAccount` of the Channel in focus, once the Network's
 * `CHANMODES` lists `b` and its `ISUPPORT` says how a ban names an account. Which account
 * the nick has is the Client's to say, and it refuses, as the act's reason, when it has none.
 * @param rest - The words after `-a`.
 * @param focus - The Timeline in focus.
 * @param head - The head of the Channel in focus, if read.
 * @returns The action.
 */
const bannedByAccount = (
  rest: readonly string[],
  focus: Focus,
  head: ChannelHeader | undefined
): Parsed<ActionRequest> => {
  const [nick, ...more] = rest;

  if (nick === undefined) {
    return invalid(`Name the nick whose account to ban. ${banAccountUsage}`);
  }

  if (more.length > 0) {
    return invalid(`Ban one nick's account at a time. ${banAccountUsage}`);
  }

  const rules = rulesOf(head);

  if (head === undefined || rules === undefined) {
    return invalid(rulesUnknown(focus));
  }

  if (!rules.chanmodes.list.includes("b")) {
    return invalid(`${focus.network} does not support bans.`);
  }

  if (head.accountBan === null) {
    return invalid(`${focus.network} does not support bans by account.`);
  }

  const nickRules = nickRulesOf(head);

  if (nickRules.symbols.includes(nick.charAt(0))) {
    return invalid(
      `Leave off the prefix ${nick.charAt(0)}: a nick does not start with it. ${banAccountUsage}`
    );
  }

  return isLookupNick(nickRules, nick)
    ? parsed({ _tag: "BanAccount", channel: focus.name, nick })
    : invalid(`A ban by account takes one nick, never a channel or a mask. ${banAccountUsage}`);
};

/**
 * What `/ban` was given: masks to ban, or `-a` and a nick to ban by account. A nick never
 * starts with `-`, so the flag is never one.
 * @param args - The text after `/ban`.
 * @param focus - The Timeline in focus.
 * @param head - The head of the Channel in focus, if read.
 * @returns The action.
 */
const banArguments = (
  args: string,
  focus: Focus,
  head: ChannelHeader | undefined
): Parsed<ActionRequest> => {
  const [first] = wordsOf(args);

  if (first !== "-a") {
    return banPlain(args, focus, head);
  }

  // The nick is split at U+0020 alone, as the nick menu writes it, so one holding another
  // space is read whole, and never as another User whose nick is its first part. A typed
  // separator of other whitespace, such as a tab, is the separator, never the nick's.
  const after = args.slice(args.indexOf("-a") + 2);

  const nicks = (after.startsWith(" ") ? after : after.trimStart())
    .split(" ")
    .filter((one) => one !== "");

  return bannedByAccount(nicks, focus, head);
};

/**
 * What `/invite` was given: a nick, and a Channel, the one in focus when left out.
 * @param args - The text after `/invite`.
 * @param focus - The Timeline in focus.
 * @returns The action.
 */
const inviteArguments = (args: string, focus: Focus): Parsed<ActionRequest> => {
  const [nick, channel, ...rest] = wordsOf(args);

  if (nick === undefined) {
    return invalid("Add a nick. /invite <nick> [channel]");
  }

  if (rest.length > 0) {
    return invalid("Invite one nick to one channel: /invite <nick> [channel]");
  }

  if (channel === undefined && focus.kind !== "Channel") {
    return invalid("Add a channel. /invite <nick> <channel>, or open the channel.");
  }

  const to = oneName(channel ?? focus.name, "Channel");
  const who = oneName(nick, "nick");

  if (who._tag === "Invalid") {
    return who;
  }

  return to._tag === "Invalid"
    ? to
    : parsed({ _tag: "Invite", channel: to.value, nick: who.value });
};

const ctcpUsage = "/ctcp <nick> <command> [text]";
const pingUsage = "/ping <nick>";

/**
 * The nick a CTCP request goes to, read as the Client reads one, or why it is none, in
 * words: never a Channel, a mask, a list, or a nick with a membership prefix before it.
 * @param nick - The nick, as typed.
 * @param head - The head of the Channel in focus, if read, whose `CHANTYPES` and ranks it
 * is read by.
 * @param usage - The command's usage, to end a refusal with.
 * @returns The nick.
 */
const ctcpNick = (nick: string, head: ChannelHeader | undefined, usage: string): Parsed<string> => {
  const rules = nickRulesOf(head);
  const first = nick.charAt(0);

  if (rules.symbols.includes(first)) {
    return invalid(`Leave off the prefix ${first}: a nick does not start with it. ${usage}`);
  }

  return isLookupNick(rules, nick)
    ? parsed(nick)
    : invalid(`A CTCP request goes to one nick, never a channel, a mask, or a list. ${usage}`);
};

/**
 * What `/ctcp` was given: a nick, a command, upper-cased, and the rest of the line after
 * the one space that follows the command, as its text.
 * @param args - The text after `/ctcp`.
 * @param _focus - The Timeline in focus.
 * @param head - The head of the Channel in focus, if read.
 * @returns The action.
 */
const ctcpArguments = (
  args: string,
  _focus: Focus,
  head: ChannelHeader | undefined
): Parsed<ActionRequest> => {
  const read = /^\s*(?<nick>\S*)\s*(?<command>\S*)(?: (?<text>.*))?$/su.exec(args)?.groups;
  const { nick = "", command = "", text = "" } = read ?? {};

  if (nick === "") {
    return invalid(`Add a nick. ${ctcpUsage}`);
  }

  if (command === "") {
    return invalid(`Add a request. ${ctcpUsage}`);
  }

  const verb = command.replaceAll(/[a-z]/gu, (letter) => letter.toUpperCase());

  if (verb === "ACTION") {
    return invalid("ACTION is what /me sends: /me <text>");
  }

  if (verb === "DCC") {
    return invalid(`DCC is not sent. ${ctcpUsage}`);
  }

  const to = ctcpNick(nick, head, ctcpUsage);

  return to._tag === "Invalid"
    ? to
    : parsed({ _tag: "Ctcp", args: text, command: verb, nick: to.value });
};

/**
 * What `/ping` was given: one nick.
 * @param args - The text after `/ping`.
 * @param _focus - The Timeline in focus.
 * @param head - The head of the Channel in focus, if read.
 * @returns The action.
 */
const pingArguments = (
  args: string,
  _focus: Focus,
  head: ChannelHeader | undefined
): Parsed<ActionRequest> => {
  const [nick, ...rest] = wordsOf(args);

  if (nick === undefined) {
    return invalid(`Add a nick. ${pingUsage}`);
  }

  if (rest.length > 0) {
    return invalid(`Give one nick. ${pingUsage}`);
  }

  const to = ctcpNick(nick, head, pingUsage);

  return to._tag === "Invalid" ? to : parsed({ _tag: "Ping", nick: to.value });
};

/** Sending a Line written as text, which never carries a Credential. */
const quoteCommand = acting({
  aliases: ["raw"],
  arguments: "Required",
  description:
    "Send a raw command to the open conversation's network, for anything no other command covers.",
  id: "act.quote",
  name: "quote",
  parse: (args) => {
    if (args.trim() === "") {
      return invalid("Add a raw command. /quote <raw command>");
    }

    const refusal = rawRefusalOf(rawCommandOf(args));

    return refusal === undefined ? parsed({ _tag: "Raw", line: args }) : invalid(refusal);
  },
  usage: "/quote <raw command>",
  when: anywhereActing,
});

const actingOn: readonly Condition[] = [{ _tag: "Live" }, { _tag: "Channel" }, { _tag: "Session" }];

/** The commands that act on a Network: each gives an `Act`, as `act` takes it. */
const actions: readonly Command[] = [
  acting({
    aliases: [],
    arguments: "Optional",
    description:
      "Set the open channel's topic, clear it with -delete, or edit the current topic when you add nothing.",
    id: "act.topic",
    name: "topic",
    parse: topicArguments,
    usage: topicUsage,
    when: actingOn,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description: "Kick nicks from the open channel, with a reason or none.",
    id: "act.kick",
    name: "kick",
    parse: kickArguments,
    usage: "/kick <nick>[,<nick>…] [reason]",
    when: actingOn,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description: "Change modes on the open channel, another channel or user, or yourself.",
    id: "act.mode",
    name: "mode",
    parse: modeArguments,
    usage: modeUsage,
    when: anywhereActing,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description: "Make nicks operators of the open channel.",
    id: "act.op",
    name: "op",
    parse: ranked("o", true, "/op <nick>…"),
    usage: "/op <nick>…",
    when: actingOn,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description: "Take operator from nicks in the open channel.",
    id: "act.deop",
    name: "deop",
    parse: ranked("o", false, "/deop <nick>…"),
    usage: "/deop <nick>…",
    when: actingOn,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description: "Give nicks voice in the open channel.",
    id: "act.voice",
    name: "voice",
    parse: ranked("v", true, "/voice <nick>…"),
    usage: "/voice <nick>…",
    when: actingOn,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description: "Take voice from nicks in the open channel.",
    id: "act.devoice",
    name: "devoice",
    parse: ranked("v", false, "/devoice <nick>…"),
    usage: "/devoice <nick>…",
    when: actingOn,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description:
      "Ban masks from the open channel. A bare nick bans nick!*@*. With -a, ban a nick's account where the network supports it.",
    id: "act.ban",
    name: "ban",
    parse: banArguments,
    usage: "/ban <nick|mask>… | /ban -a <nick>",
    when: actingOn,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description: "Lift bans from the open channel. A bare nick lifts nick!*@*.",
    id: "act.unban",
    name: "unban",
    parse: banned(false, "/unban <mask>…"),
    usage: "/unban <mask>…",
    when: actingOn,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description: "Invite a nick to the open channel, or to another.",
    id: "act.invite",
    name: "invite",
    parse: inviteArguments,
    usage: "/invite <nick> [channel]",
    when: anywhereActing,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description:
      "Send a CTCP request, such as VERSION or TIME, to a nick on the open conversation's network, and show its reply.",
    id: "act.ctcp",
    name: "ctcp",
    parse: ctcpArguments,
    usage: ctcpUsage,
    when: anywhereActing,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description:
      "Send a CTCP PING to a nick on the open conversation's network, and show how long its reply took.",
    id: "act.ping",
    name: "ping",
    parse: pingArguments,
    usage: pingUsage,
    when: anywhereActing,
  }),
  acting({
    aliases: [],
    arguments: "Optional",
    description:
      "Mark yourself away on the open conversation's network, with a message that persists across reconnects. With no message, you come back.",
    id: "act.away",
    name: "away",
    parse: (args) => parsed({ _tag: "Away", message: args.trim() === "" ? null : args }),
    usage: "/away [message]",
    when: live,
  }),
  acting({
    aliases: [],
    arguments: "None",
    description: "Mark yourself back on the open conversation's network.",
    id: "act.back",
    name: "back",
    parse: (args) =>
      args.trim() === ""
        ? parsed({ _tag: "Away", message: null })
        : invalid("/back takes nothing after it. To be away with a message, use /away <message>."),
    usage: "/back",
    when: live,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description:
      "Change your nick on the open conversation's network for this connection. Set network.<id>.nicks to keep it.",
    id: "act.nick",
    name: "nick",
    parse: (args) => {
      const nick = oneName(args.trim(), "nick");

      return nick._tag === "Invalid" ? nick : parsed({ _tag: "Nick", nick: nick.value });
    },
    usage: "/nick <nick>",
    when: anywhereActing,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description:
      "Change your real name on the open conversation's network for this connection, where the network supports it.",
    id: "act.setname",
    name: "setname",
    parse: (args) =>
      args.trim() === ""
        ? invalid("Add a name. /setname <real name>")
        : parsed({ _tag: "Setname", realname: args }),
    usage: "/setname <real name>",
    when: anywhereActing,
  }),
  quoteCommand,
];

const say = (focus: Focus, kind: SayKind, text: string): Say => ({
  _tag: "Say",
  kind,
  network: focus.network,
  opens: false,
  target: focus.name,
  text,
});

/** Saying text to the open Timeline, which plain text does too. */
const sayCommand = command({
  aliases: [],
  arguments: "Required",
  description: "Send a message to the open channel or direct message.",
  id: "say.privmsg",
  intents: (text: string, focus) => [say(focus, "Privmsg", text)],
  name: "say",
  parse: textOf("/say <text>"),
  usage: "/say <text>",
  when: target,
});

/**
 * A line said in a Direct Message not yet begun: plain text, `//text`, `/say`, and `/me`
 * go to its nick, with `opens`, so its Timeline shows once the Daemon placed it there.
 * Any other line is read as anywhere else.
 * @param line - The line.
 * @param context - The context.
 * @param draft - The Direct Message not yet begun.
 * @returns What it says, or none when it is another command.
 */
const inDraft = (
  line: string,
  context: CommandContext,
  draft: DraftTo
): Parsed<readonly Intent[]> | undefined => {
  const space = line.indexOf(" ");
  const name = (space === -1 ? line : line.slice(0, space)).toLowerCase();
  const args = space === -1 ? "" : line.slice(space + 1);
  let kind: SayKind = "Privmsg";
  let text = line;

  if (line.startsWith("//")) {
    text = line.slice(1);
  } else if (name === "/say") {
    text = args;
  } else if (name === "/me" || name === "/action") {
    kind = "Action";
    text = args;
  } else if (line.startsWith("/")) {
    return undefined;
  }

  if (text === "") {
    return invalid(`Add a message after ${name}.`);
  }

  if (context.session !== true) {
    return invalid(noSession(draft.network, context.session));
  }

  return parsed([
    { _tag: "Say", kind, network: draft.network, opens: true, target: draft.nick, text },
  ]);
};

/** Opening the options, setting an option, or asking for a Credential option's value. */
const setCommand = unfocused({
  aliases: [],
  arguments: "Optional",
  description:
    "Open settings, filtered by a pattern such as network.libera.* or *nick*. Set an option to a value, set a ui option for this device alone with -device, or enter a password in a password prompt.",
  id: "options.set",
  intents: (intent: Intent) => [intent],
  name: "set",
  parse: setArguments,
  usage: "/set [<pattern> | [-device] <option> [<value>]]",
  when: [],
});

const aliasUsage = "/alias [add <name> <line> | remove <name>]";

/** Listing, adding, and removing the aliases the Owner made. */
const aliasesCommand = unfocused({
  aliases: [],
  arguments: "Optional",
  description:
    "List your aliases, add one that stands for a command, or remove one. Use $1 to $9 for the words after it and $* for all of them.",
  id: "aliases.edit",
  intents: (intent: Intent) => [intent],
  name: "alias",
  // oxlint-disable-next-line no-use-before-define -- `/alias` is one of the commands it checks a name against, which are read below it.
  parse: (args) => aliasArguments(args),
  usage: aliasUsage,
  when: [],
});

/** Every command, in the order a list of them shows. */
export const commands: readonly Command[] = [
  sayCommand,
  command({
    aliases: ["action"],
    arguments: "Required",
    description: "Act in the open channel or direct message, as in /me waves.",
    id: "say.action",
    intents: (text: string, focus) => [say(focus, "Action", text)],
    name: "me",
    parse: textOf("/me <text>"),
    usage: "/me <text>",
    when: target,
  }),
  command({
    aliases: ["privmsg"],
    arguments: "Required",
    description: "Message any channel or user, and open the direct message with a nick.",
    id: "say.to",
    intents: ({ target: to, text }, focus) => [
      { _tag: "Say", kind: "Privmsg", network: focus.network, opens: true, target: to, text },
    ],
    name: "msg",
    parse: targetAndText("/msg <target> <text>"),
    usage: "/msg <target> <text>",
    when: anywhere,
  }),
  command({
    aliases: [],
    arguments: "Required",
    description: "Send a NOTICE to any channel or user.",
    id: "say.notice",
    intents: ({ target: to, text }, focus) => [
      { _tag: "Say", kind: "Notice", network: focus.network, opens: false, target: to, text },
    ],
    name: "notice",
    parse: targetAndText("/notice <target> <text>"),
    usage: "/notice <target> <text>",
    when: anywhere,
  }),
  command({
    aliases: [],
    arguments: "Required",
    description:
      "Join channels on the open conversation's network, by adding them to its settings.",
    id: "channels.join",
    intents: (channels: readonly string[], focus) => [
      { _tag: "Configure", edit: { _tag: "Join", channels }, network: focus.network },
    ],
    name: "join",
    parse: (args) =>
      args.trim().includes(" ")
        ? invalid(
            "Separate channels with commas. A channel key is a password: set it with /set network.<id>.channels.<channel>.key <key>."
          )
        : channelsOf(args),
    usage: "/join <#channel>[,<#channel>…]",
    when: live,
  }),
  command({
    aliases: ["leave"],
    arguments: "Optional",
    description: "Part channels, or the open one, by taking them from its network's settings.",
    id: "channels.part",
    intents: (edit: Edit, focus) => [{ _tag: "Configure", edit, network: focus.network }],
    name: "part",
    parse: partArguments,
    usage: "/part [#channel[,#channel…]]",
    when: live,
  }),
  command({
    aliases: [],
    arguments: "Optional",
    description:
      "Hide a user's messages and activity on the open conversation's network, by nick or nick!user@host mask, or list the masks you ignore there.",
    id: "ignores.ignore",
    intents: (mask: IgnoreMask | undefined, focus) => [
      mask === undefined
        ? { _tag: "OpenOptions", filter: `network.${focus.network}.ignores` }
        : { _tag: "Configure", edit: { _tag: "Ignore", mask }, network: focus.network },
    ],
    name: "ignore",
    parse: ignoreArguments,
    usage: ignoreUsage,
    when: live,
  }),
  command({
    aliases: [],
    arguments: "Required",
    description: "Stop ignoring a nick or mask on the open conversation's network.",
    id: "ignores.unignore",
    intents: (mask: IgnoreMask, focus) => [
      { _tag: "Configure", edit: { _tag: "Unignore", mask }, network: focus.network },
    ],
    name: "unignore",
    parse: ignoredMask(unignoreUsage),
    usage: unignoreUsage,
    when: live,
  }),
  unfocused({
    aliases: [],
    arguments: "Optional",
    description:
      "Close a channel you left or a direct message, and remove it from the sidebar until something new arrives. This closes the open one unless you name another. If you are in the channel, you are asked to leave it instead.",
    id: "conversation.close",
    intents: (intent: CloseTimeline | CloseTarget) => [intent],
    name: "close-conversation",
    parse: closeArguments,
    usage: closeUsage,
    when: [{ _tag: "Focused" }],
  }),
  ...actions,
  setCommand,
  aliasesCommand,
  unfocused({
    aliases: [],
    arguments: "Optional",
    description:
      "List themes, switch to one for every device or just this one with -device, choose the theme system uses in light or dark mode with -light or -dark, import one from a terminal theme file, or remove an imported one.",
    id: "theme.set",
    intents: (intent: Intent) => [intent],
    name: "theme",
    parse: themeArguments,
    usage: themeUsage,
    when: [],
  }),
  unfocused({
    aliases: [],
    arguments: "Required",
    description:
      "Reset an option to its starting value, or leave it not set. With -device, stop this device overriding a ui option.",
    id: "settings.unset",
    intents: (intent: Intent) => [intent],
    name: "unset",
    parse: unsetArguments,
    usage: "/unset [-device] <option>",
    when: [],
  }),
  unfocused({
    aliases: [],
    arguments: "Required",
    description:
      "Add a network with one server and one nick, or remove one. Removing asks first whether its conversations stay readable.",
    id: "network.manage",
    intents: (intent: Intent) => [intent],
    name: "network",
    parse: networkArguments,
    usage: `${networkUsage} | remove [id] [keep|drop]`,
    when: [],
  }),
  unfocused({
    aliases: [],
    arguments: "Optional",
    description:
      "Connect to a network, the focused one unless named, by setting network.<id>.enabled on.",
    id: "network.connect",
    intents: (network: NetworkId) => [enabling(network, true)],
    name: "connect",
    parse: enabledArguments("/connect [id]"),
    usage: "/connect [id]",
    when: [],
  }),
  unfocused({
    aliases: [],
    arguments: "Optional",
    description:
      "Disconnect from a network, the focused one unless named, by setting network.<id>.enabled off.",
    id: "network.disconnect",
    intents: (network: NetworkId) => [enabling(network, false)],
    name: "disconnect",
    parse: enabledArguments("/disconnect [id]"),
    usage: "/disconnect [id]",
    when: [],
  }),
  command({
    aliases: [],
    arguments: "None",
    description: "Jump to the latest message in the open conversation and follow it.",
    id: "conversation.latest",
    intents: (_: undefined, focus) => [{ _tag: "Latest", timeline: focus.timeline }],
    name: "latest",
    parse: (args) =>
      args.trim() === "" ? parsed(undefined) : invalid("/latest takes nothing after it."),
    usage: "/latest",
    when: focused,
  }),
  command({
    aliases: [],
    arguments: "Required",
    description:
      "Go to a date or time in the open conversation: a day in your time zone, or a time with its zone. This opens the first item at or after it, the beginning if it's earlier, or the latest if it's later.",
    id: "conversation.date",
    intents: (moment: Moment, focus) => [{ _tag: "GoToDate", moment, timeline: focus.timeline }],
    name: "date",
    parse: (args) => {
      const usage =
        "/date takes a date, such as 2026-11-10, or a time with its zone, such as 2026-11-10T09:30Z or 2026-11-10T09:30+01:00.";

      const value = args.trim();

      return value === "" ? invalid(`Add a date or time. ${usage}`) : parseMoment(value, usage);
    },
    usage: "/date <date|time>",
    when: focused,
  }),
  command({
    aliases: [],
    arguments: "Optional",
    description:
      "Save the open conversation as a text file, all of it or between two dates or times. A date alone covers the whole day.",
    id: "conversation.export",
    intents: (range: ExportRange, focus) => [
      { _tag: "Export", since: range.since, timeline: focus.timeline, until: range.until },
    ],
    name: "export",
    parse: exportArguments,
    usage: "/export [since] [until]",
    when: focused,
  }),
  command({
    aliases: [],
    arguments: "Required",
    description:
      "Move the open conversation up or down in the sidebar on every device, among the pinned, the networks, or its network's conversations.",
    id: "conversation.move",
    intents: (direction: "Up" | "Down", focus) => [
      { _tag: "Arrange", edit: { _tag: "Move", direction, timeline: focus.timeline } },
    ],
    name: "move",
    parse: moveArguments,
    usage: "/move up|down",
    when: focused,
  }),
  muteCommand(true),
  muteCommand(false),
  unfocused({
    aliases: [],
    arguments: "None",
    description:
      "Pin the open conversation above the networks in the sidebar on every device, or unpin it if it is pinned.",
    id: "conversation.pin",
    intents: (edit: ArrangeEdit) => [{ _tag: "Arrange", edit }],
    name: "pin",
    parse: pinArguments,
    usage: "/pin",
    when: focused,
  }),
  unfocused({
    aliases: [],
    arguments: "None",
    description: "Open the next conversation in the sidebar.",
    id: "conversation.next",
    intents: (to: TimelineId | undefined) =>
      to === undefined ? [] : [{ _tag: "Open", timeline: to }],
    name: "next",
    parse: stepped("Next"),
    usage: "/next",
    when: [],
  }),
  unfocused({
    aliases: ["prev"],
    arguments: "None",
    description: "Open the previous conversation in the sidebar.",
    id: "conversation.previous",
    intents: (to: TimelineId | undefined) =>
      to === undefined ? [] : [{ _tag: "Open", timeline: to }],
    name: "previous",
    parse: stepped("Previous"),
    usage: "/previous",
    when: [],
  }),
  unfocused({
    aliases: ["jump"],
    arguments: "None",
    description:
      "Open the conversation that needs you most: highlights first, then direct messages, then other unread messages.",
    id: "conversation.unread",
    intents: (to: TimelineId | undefined) =>
      to === undefined ? [] : [{ _tag: "Open", timeline: to }],
    name: "next-unread",
    parse: nextUnread,
    usage: "/next-unread",
    when: [],
  }),
  unfocused({
    aliases: [],
    arguments: "Required",
    description:
      "Open a conversation by its name in the focused pane, on the current conversation's network unless you name another.",
    id: "conversation.go",
    intents: (to: TimelineId) => [{ _tag: "Open", timeline: to }],
    name: "go",
    parse: (args, context) =>
      timelineNamed(context.named, context.focus?.network ?? context.draft?.network, args),
    usage: goUsage,
    when: [],
  }),
  unfocused({
    aliases: [],
    arguments: "Optional",
    description:
      "Mark the open conversation read up to its latest, or every conversation with /read all, for every device.",
    id: "conversation.read",
    intents: (marks: readonly MarkRead[]) => marks,
    name: "read",
    parse: readArguments,
    usage: "/read [all]",
    when: [],
  }),
  command({
    aliases: [],
    arguments: "Required",
    description:
      "Choose whether links in the open conversation show previews on every device: off, text, on, or default to follow ui.previews. In a direct message, text or on shows previews without a click.",
    id: "previews.choose",
    intents: (mode: PreviewsShown | undefined, focus) => [
      { _tag: "ChoosePreviews", mode, timeline: focus.timeline },
    ],
    name: "previews",
    parse: previewsArguments,
    usage: "/previews off|text|on|default",
    when: focused,
  }),
  unfocused({
    aliases: [],
    arguments: "Required",
    description:
      "Notify this device of highlights and direct messages you are not looking at, or stop.",
    id: "notify.set",
    intents: (on: boolean) => [{ _tag: "Notify", on }],
    name: "notify",
    parse: notifyArguments,
    usage: "/notify on|off",
    when: [],
  }),
  command({
    aliases: [],
    arguments: "Required",
    description:
      "Open the direct message with a nick, or start one with /msg if there are no messages yet.",
    id: "conversation.query",
    intents: (name: string, focus) => [{ _tag: "Query", name, network: focus.network }],
    name: "query",
    parse: queryArguments,
    usage: "/query <nick>",
    when: live,
  }),
  lookupCommand(
    "Whois",
    "Show who a nick is on the open conversation's network: their name, server, and channels."
  ),
  lookupCommand("Whowas", "Show who last used a nick on the open conversation's network."),
  namesCommand(),
  whoCommand(),
  directoryCommand(),
  listCommand("Bans", [], "List the bans on the open channel or another, and lift them."),
  listCommand(
    "Exceptions",
    ["excepts"],
    "List the ban exceptions on the open channel or another, and remove them."
  ),
  listCommand(
    "Invitations",
    ["invitations"],
    "List the invitation masks on the open channel or another. A match can join while the channel is invite-only."
  ),
  unfocused({
    aliases: [],
    arguments: "Optional",
    description: "Show or hide the open channel's members, on this device.",
    id: "members.toggle",
    intents: (shown: boolean | undefined) => [{ _tag: "ShowMembers", shown }],
    name: "members",
    parse: shownArguments("members", "them"),
    usage: "/members [on|off]",
    when: [],
  }),
  unfocused({
    aliases: [],
    arguments: "Optional",
    description: "Show or hide the sidebar of networks and their conversations, on this device.",
    id: "sidebar.toggle",
    intents: (shown: boolean | undefined) => [{ _tag: "ShowSidebar", shown }],
    name: "sidebar",
    parse: shownArguments("sidebar", "it"),
    usage: "/sidebar [on|off]",
    when: [],
  }),
  formatCommand("bold", "bold"),
  formatCommand("italic", "italic"),
  formatCommand("underline", "underline"),
  formatCommand("monospace", "monospace"),
  formatCommand("reverse", "reversed colors"),
  formatCommand("strikethrough", "strikethrough"),
  unfocused({
    aliases: [],
    arguments: "None",
    description: "Choose a format or a color for the selected text, or for what you type next.",
    id: "format.open",
    intents: () => [{ _tag: "ChooseFormat" }],
    name: "format",
    parse: nothingAfter("format"),
    usage: "/format",
    when: [],
  }),
  unfocused({
    aliases: [],
    arguments: "Optional",
    description:
      "Search the messages of every conversation, newest first, narrowed by from:<nick>, in:<#channel|nick>, network:<id>, since:<date>, and until:<date>, or show the last search.",
    id: "search.open",
    intents: (query: string | undefined) => [{ _tag: "Search", query }],
    name: "search",
    parse: (args: string) => parsed(args.trim() === "" ? undefined : args.trim()),
    usage:
      "/search [<text>] [from:<nick>] [in:<name>] [network:<id>] [since:<date>] [until:<date>]",
    when: [],
  }),
  unfocused({
    aliases: [],
    arguments: "None",
    description: "Show your uploads, which you can copy a link to, rename, or delete.",
    id: "uploads.open",
    intents: () => [{ _tag: "OpenUploads" }],
    name: "uploads",
    parse: nothingAfter("uploads"),
    usage: "/uploads",
    when: [],
  }),
  unfocused({
    aliases: [],
    arguments: "None",
    description: "Show the daemon's recent logs in the focused pane.",
    id: "logs.open",
    intents: () => [{ _tag: "OpenTail" }],
    name: "logs",
    parse: nothingAfter("logs"),
    usage: "/logs",
    when: [],
  }),
  paneCommand({
    aliases: [],
    arguments: "Optional",
    description:
      "Split the focused pane side by side or one above the other, and open the conversation that needs you most.",
    id: "pane.split",
    name: "split",
    parse: splitArguments,
    usage: "/split [h|v]",
    when: [],
  }),
  paneCommand({
    aliases: [],
    arguments: "None",
    description: "Close the focused pane. The pane beside it takes its place.",
    id: "pane.close",
    name: "close",
    parse: ofPanes("close", { _tag: "Close" }),
    usage: "/close",
    when: panesNeeded,
  }),
  paneCommand({
    aliases: [],
    arguments: "Required",
    description: "Focus the pane to the left, right, above, or below.",
    id: "pane.focus",
    name: "pane",
    parse: towards("pane", (direction) => ({ _tag: "Move", direction })),
    usage: "/pane left|right|up|down",
    when: panesNeeded,
  }),
  paneCommand({
    aliases: [],
    arguments: "Required",
    description: "Swap the focused pane with the pane in a direction, and follow it.",
    id: "pane.swap",
    name: "swap",
    parse: towards("swap", (direction) => ({ _tag: "Swap", direction })),
    usage: "/swap left|right|up|down",
    when: panesNeeded,
  }),
  paneCommand({
    aliases: [],
    arguments: "None",
    description: "Make every pane the same size.",
    id: "pane.equalize",
    name: "equalize",
    parse: ofPanes("equalize", { _tag: "Equalize" }),
    usage: "/equalize",
    when: panesNeeded,
  }),
  paneCommand({
    aliases: [],
    arguments: "None",
    description: "Show the focused pane alone, or every pane again.",
    id: "pane.zoom",
    name: "zoom",
    parse: ofPanes("zoom", { _tag: "Zoom" }),
    usage: "/zoom",
    when: panesNeeded,
  }),
  paneCommand({
    aliases: [],
    arguments: "None",
    description: "Make the focused pane larger.",
    id: "pane.grow",
    name: "grow",
    parse: ofPanes("grow", { _tag: "Grow" }),
    usage: "/grow",
    when: panesNeeded,
  }),
  paneCommand({
    aliases: [],
    arguments: "None",
    description: "Make the focused pane smaller.",
    id: "pane.shrink",
    name: "shrink",
    parse: ofPanes("shrink", { _tag: "Shrink" }),
    usage: "/shrink",
    when: panesNeeded,
  }),
  unfocused({
    aliases: [],
    arguments: "Optional",
    description:
      "Focus the message input. With text, start there with its suggestions open and set your draft aside until the command runs or you press Escape.",
    id: "input.focus",
    intents: (text: string | undefined) => [
      text === undefined ? { _tag: "FocusComposer", text } : { _tag: "StartCommand", text },
    ],
    name: "focus",
    // The text keeps its trailing space, which `/focus /go ` is typed to leave.
    parse: (args): Parsed<string | undefined> =>
      parsed(args.trim() === "" ? undefined : args.trimStart()),
    usage: "/focus [text]",
    when: [],
  }),
];

const byName: ReadonlyMap<string, Command> = new Map(
  commands.flatMap((one) => [one.name, ...one.aliases].map((name) => [name, one] as const))
);

const byId: ReadonlyMap<string, Command> = new Map(commands.map((one) => [one.id, one] as const));

/**
 * The command with an id, as a keybinding names it.
 * @param id - Its id, such as `conversation.next`.
 * @returns The command, or none.
 */
export const commandWithId = (id: string): Command | undefined => byId.get(id);

/**
 * The command a name stands for, in any ASCII case.
 * @param name - The name, without its `/`.
 * @returns The command, or none.
 */
export const commandNamed = (name: string): Command | undefined => byName.get(lowerCaseAscii(name));

/**
 * The alias a name stands for, in any ASCII case.
 * @param aliases - The aliases.
 * @param name - The name, without its `/`.
 * @returns The alias, or none.
 */
const aliasFound = (aliases: Aliases, name: string): Alias | undefined => {
  const folded = lowerCaseAscii(name);

  return aliases.find((one) => one.name === folded);
};

/**
 * Why a line that types a Credential is refused, in words, or nothing when it types none:
 * a value after `/set <credential option>`, or a `/quote` or `/raw` of `PASS`,
 * `AUTHENTICATE`, or `OPER`, in any ASCII case, or one that an alias expands to, or
 * `/alias add` makes an alias of. The composer refuses and clears such a line at once,
 * keeping it nowhere.
 * @param line - The line.
 * @param aliases - The aliases, which a line that names one is judged by the expansion of.
 * @returns The words, or none.
 */
export const credentialRefusal = (line: string, aliases: Aliases): string | undefined => {
  const [command = "", name = "", ...rest] = line.split(" ");
  const found = commandNamed(command.slice(1));

  if (!command.startsWith("/") || command.startsWith("//")) {
    return undefined;
  }

  if (found === quoteCommand) {
    return rawRefusalOf(rawCommandOf(line.slice(command.length)));
  }

  if (found === aliasesCommand) {
    const made = /^\s*add\s+\S+\s+(?<line>.*)$/isu.exec(line.slice(command.length))?.groups?.line;

    // What an alias stands for is never another alias, so none is judged by its expansion.
    return made === undefined ? undefined : credentialRefusal(made, []);
  }

  if (found === undefined) {
    const alias = aliasFound(aliases, command.slice(1));

    if (alias !== undefined) {
      // Judged by what it would carry even when its words are refused, as the command it
      // stands for is when typed with too many or too few.
      return credentialRefusal(substituted(alias.line, line.slice(command.length + 1)), []);
    }

    // `/oper`, `/pass`, and `/authenticate` are no commands, and would carry a Credential.
    return rawRefusalOf(upperCaseAscii(command.slice(1)));
  }

  const option = isOwnerName(name) ? resolveOwner(name) : resolve(name);

  return found === setCommand &&
    rest.join(" ") !== "" &&
    option._tag === "Parsed" &&
    option.value.field.kind._tag === "Credential"
    ? credentialRefused(name)
    : undefined;
};

/**
 * Whether a line types a Credential, as `credentialRefusal` says, which the composer
 * refuses and clears at once, so it is not kept as the draft.
 * @param line - The line.
 * @param aliases - The aliases.
 * @returns Whether it does.
 */
export const typesCredential = (line: string, aliases: Aliases): boolean =>
  credentialRefusal(line, aliases) !== undefined;

/**
 * Why the Timeline in focus has no Target to say something to, in words, or nothing.
 * @param focus - The Timeline in focus.
 * @returns The words, or nothing when it has one.
 */
const noTarget = (focus: Focus | undefined): string | undefined => {
  if (focus === undefined) {
    return "Open a channel or a direct message first.";
  }

  if (focus.kind === "Network") {
    return "You can't send from the network's own conversation. Open a channel or a direct message, or use /msg <target> <text>.";
  }

  return focus.detached
    ? "The other person changed nick, so this direct message no longer follows them. Use /msg <nick> <text>."
    : undefined;
};

/**
 * Why one condition does not hold in a context, in words, or nothing when it does.
 * @param condition - The condition.
 * @param context - The context.
 * @returns The words, or nothing.
 */
const unmetOne = (condition: Condition, context: CommandContext): string | undefined => {
  const { focus } = context;

  switch (condition._tag) {
    case "Focused": {
      return focus === undefined ? "Open a conversation first." : undefined;
    }

    case "Target": {
      return noTarget(focus);
    }

    case "Channel": {
      return focus?.kind === "Channel" ? undefined : "Open a channel first.";
    }

    case "Session": {
      return context.session === true
        ? undefined
        : noSession(focus?.network ?? "The network", context.session);
    }

    case "Live": {
      return focus?.removed === true ? removedRefusal(focus.network) : undefined;
    }

    case "Panes": {
      return context.panes < 2 ? "There is only one pane. /split makes another." : undefined;
    }

    case "Keeps": {
      return listMode(focusHead(context), condition.list) === null
        ? `${focus?.network ?? "The network"} does not support ${listWords[condition.list]}.`
        : undefined;
    }

    default: {
      return condition satisfies never;
    }
  }
};

/**
 * Why a command cannot run in a context, in words, or nothing when it can.
 * @param when - Its conditions.
 * @param context - The context.
 * @returns The first condition that does not hold, in words.
 */
export const unmet = (when: readonly Condition[], context: CommandContext): string | undefined => {
  for (const condition of when) {
    const reason = unmetOne(condition, context);

    if (reason !== undefined) {
      return reason;
    }
  }

  return undefined;
};

/**
 * A command run in a context, once its conditions hold.
 * @param found - The command.
 * @param args - The text after its name.
 * @param context - The context.
 * @returns Its intents, or why there are none.
 */
export const runIn = (
  found: Command,
  args: string,
  context: CommandContext
): Parsed<readonly Intent[]> => {
  const reason = unmet(found.when, context);

  return reason === undefined ? found.run(args, context) : invalid<readonly Intent[]>(reason);
};

const decodeAliasName = Schema.decodeUnknownOption(AliasName);

const decodeAliasLine = Schema.decodeUnknownOption(AliasLine);

/**
 * Why a name cannot be given to a command that is not there, in words.
 * @param name - The name, without its `/`.
 * @returns The words.
 */
const unknownCommand = (name: string): string =>
  rawRefusalOf(upperCaseAscii(name)) ??
  `There is no command /${name}. Start with // to send text that begins with /.`;

/**
 * An alias's name as typed, in any ASCII case.
 * @param text - The name.
 * @returns The name, or why it is not one.
 */
const parseAliasName = (text: string): Parsed<AliasName> => {
  const name = decodeAliasName(lowerCaseAscii(text));

  return name._tag === "Some"
    ? parsed(name.value)
    : invalid(
        `${text} is not a valid alias name. Use 1 to 32 lowercase letters and digits, with words joined by -, such as j or join-quiet.`
      );
};

/**
 * The line an alias is to stand for: one command line, naming a command of the Frontend's
 * own, so an alias never stands for another, and none chains or loops. A line is refused
 * as a Credential is, which a Credential typed after `$1` would also carry.
 * @param text - The line, as typed.
 * @returns The line, or why it cannot be one.
 */
const parseAliasLine = (text: string): Parsed<AliasLine> => {
  if (text.startsWith("//")) {
    return invalid(
      "A line that starts with // sends text, not a command. An alias stands for a command, such as /join $1."
    );
  }

  const line = decodeAliasLine(text);

  if (line._tag === "None") {
    return invalid(
      `${text} is not a command. Use one line of at most 512 characters: / and the command's name, then its arguments.`
    );
  }

  const name = /^\/(?<name>[^ ]+)/u.exec(line.value)?.groups?.name ?? "";

  if (commandNamed(name) === undefined) {
    return invalid(
      `/${name} is not a command. An alias stands for one command, not another alias.`
    );
  }

  const refusal = credentialRefusal(line.value, []);

  return refusal === undefined ? parsed(line.value) : invalid(refusal);
};

/**
 * What `/alias` was given: nothing, to start `/alias ` with the aliases listed; `add`, a
 * name, and a line, to make an alias, replacing one of its name; or `remove` and a name.
 * A name that a command takes is never an alias, since a command always runs first.
 * @param args - The text after `/alias`.
 * @returns The intent, or why there is none.
 */
const aliasArguments = (args: string): Parsed<Intent> => {
  const text = args.trim();

  if (text === "") {
    return parsed({ _tag: "StartCommand", text: "/alias " });
  }

  const given = /^(?<verb>\S+)(?:\s+(?<name>\S+)(?:\s+(?<line>.*))?)?$/su.exec(text)?.groups;
  const verb = lowerCaseAscii(given?.verb ?? "");
  const named = given?.name;
  const line = given?.line;

  if (verb === "remove" && named !== undefined && line === undefined) {
    const name = parseAliasName(named);

    return name._tag === "Invalid"
      ? name
      : parsed({ _tag: "EditAliases", edit: { _tag: "Remove", name: name.value } });
  }

  if (verb !== "add" || named === undefined || line === undefined) {
    return invalid(`Usage: ${aliasUsage}`);
  }

  const name = parseAliasName(named);

  if (name._tag === "Invalid") {
    return name;
  }

  if (commandNamed(name.value) !== undefined) {
    return invalid(
      `/${name.value} is a command name, and commands run before aliases. Give the alias another name.`
    );
  }

  const parsedLine = parseAliasLine(line);

  return parsedLine._tag === "Invalid"
    ? parsedLine
    : parsed({
        _tag: "EditAliases",
        edit: { _tag: "Add", alias: { line: parsedLine.value, name: name.value } },
      });
};

/**
 * An expanded line, said to the nick of a Direct Message not yet begun as `/say` and `/me`
 * are there, or else run against the commands of the Frontend's own alone, so an alias
 * never runs another, and the command's own conditions apply.
 * @param line - The line.
 * @param context - The context.
 * @returns Its intents, or why there are none.
 */
const runExpanded = (line: string, context: CommandContext): Parsed<readonly Intent[]> => {
  const drafted = context.draft === undefined ? undefined : inDraft(line, context, context.draft);

  if (drafted !== undefined) {
    return drafted;
  }

  const space = line.indexOf(" ");
  const name = line.slice(1, space === -1 ? line.length : space);
  const found = commandNamed(name);

  return found === undefined
    ? invalid(unknownCommand(name))
    : runIn(found, space === -1 ? "" : line.slice(space + 1), context);
};

/**
 * The command an alias is: it expands its line for what is typed after it, and runs that.
 * @param alias - The alias.
 * @returns The command.
 */
const aliasCommand = (alias: Alias): Command => ({
  aliases: [],
  arguments: takes(alias.line).words > 0 ? "Required" : "Optional",
  description: `Your alias: ${alias.line}`,
  id: `alias.${alias.name}`,
  name: alias.name,
  run: (args, context) => {
    const expanded = expand(alias.line, args);

    return expanded._tag === "Invalid" ? expanded : runExpanded(expanded.value, context);
  },
  usage: usageOf(alias.name, alias.line),
  when: [],
});

/**
 * The aliases that run, each as a command: those whose name no command takes, since a
 * command always runs first.
 * @param aliases - The aliases.
 * @returns The commands.
 */
export const aliasCommands = (aliases: Aliases): readonly Command[] =>
  aliases.filter((one) => commandNamed(one.name) === undefined).map(aliasCommand);

/**
 * The command a name runs: a command of the Frontend's own, else an alias, in any ASCII case.
 * @param name - The name, without its `/`.
 * @param aliases - The aliases.
 * @returns The command, or none.
 */
export const commandRunBy = (name: string, aliases: Aliases): Command | undefined => {
  const found = commandNamed(name);

  if (found !== undefined) {
    return found;
  }

  const alias = aliasFound(aliases, name);

  return alias === undefined ? undefined : aliasCommand(alias);
};

/**
 * One line of input, read: plain text is said to the open Timeline, `//text` says
 * `/text`, and `/name args` runs the command it names, if it can run here: a command of
 * the Frontend's own, else an alias.
 * @param line - The line, with no line break.
 * @param context - The context.
 * @returns Its intents, or why there are none.
 */
export const interpret = (line: string, context: CommandContext): Parsed<readonly Intent[]> => {
  const drafted = context.draft === undefined ? undefined : inDraft(line, context, context.draft);

  if (drafted !== undefined) {
    return drafted;
  }

  const literal = line.startsWith("//");

  if (!line.startsWith("/") || literal) {
    return runIn(sayCommand, literal ? line.slice(1) : line, context);
  }

  const space = line.indexOf(" ");
  const name = space === -1 ? line.slice(1) : line.slice(1, space);
  const args = space === -1 ? "" : line.slice(space + 1);

  if (name === "") {
    return invalid("Type a command after /, or start with // to send text that begins with /.");
  }

  const found = commandRunBy(name, context.aliases);

  return found === undefined ? invalid(unknownCommand(name)) : runIn(found, args, context);
};
