/**
 * The commands, as data: one registry behind the composer's `/commands`, the palette, the
 * keymap, and later agents, since each is a way of naming the same action. A
 * command parses its arguments into typed values or says in words why it cannot, and
 * gives intents, plain data the runtime carries out. It never does anything itself.
 *
 * @packageDocumentation
 */
import type { ActionRequest, ChannelHeader, Level, NetworkId, TimelineId } from "@iirc/api";
import type { UiOptionName } from "@iirc/api/ui";

import { rank } from "./activity.ts";
import type { Instant } from "./activity.ts";
import type { Axis, Direction } from "./layout.ts";
import {
  channelsOf,
  isUiName,
  networkIdOf,
  parseIrcd,
  parseText,
  parseUiText,
  resolve,
  resolveUi,
  starting,
} from "./options.ts";
import type { Configuration, Edit, Json, Path } from "./options.ts";
import type { PaneChange } from "./timelines.ts";

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
}

/** What a command's `when` and its arguments are judged against. */
export interface CommandContext {
  /** The Timeline in focus, if any. */
  readonly focus: Focus | undefined;
  /** Whether the focused Timeline's Network has a Session. */
  readonly session: boolean;
  /** Every Timeline, in the sidebar's order. */
  readonly timelines: readonly TimelineId[];
  /**
   * The Timeline open in the focused Pane, as a merge resolves it, even while it is still
   * read.
   */
  readonly open: TimelineId | undefined;
  /** Every Timeline open in a Pane, as a merge resolves it. */
  readonly shown: readonly TimelineId[];
  /** How many Panes there are. */
  readonly panes: number;
  /** Every Timeline with something unread, in the sidebar's order. */
  readonly unread: readonly Unseen[];
  /**
   * The head of the Channel in focus, as last read, or none before it is read or when the
   * focus is no Channel's: its topic, and the Network's `PREFIX`, `CHANMODES`, and
   * `CHANTYPES`, which an action on a Channel is parsed by, as the Client checks it.
   */
  readonly head: ChannelHeader | undefined;
}

/** A Timeline with something unread, as a command sees it. */
export interface Unseen {
  readonly timeline: TimelineId;
  /** The highest level unread in it. */
  readonly level: Level;
  /** Marking it read up to its latest item, unless that would change nothing. */
  readonly mark: MarkRead | undefined;
}

/**
 * Mark a Timeline read up to an instant: the Daemon's `read`, with `target` the Timeline's
 * name, or `null` for the Network's own.
 */
export interface MarkRead {
  readonly _tag: "MarkRead";
  readonly network: NetworkId;
  readonly timeline: TimelineId;
  readonly target: string | null;
  readonly read: Instant;
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
}

/**
 * Act on a Network, as the Daemon's `act` does: set a topic, kick, change modes, invite,
 * change Self's nick, be away or back, or send a Line written as text. It is carried out
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
 * - `Configure`: read the Network's Configuration, apply the edit to it, and send the whole
 *   of it back, made from the one read. On a conflict, read it again and apply the same
 *   edit once more, since an edit is a pure function of the Configuration.
 * - `AddNetwork`: configure a Network that must not exist yet, as a new one starts.
 * - `ChangeUi`: set an option under `ui` to a value, as JSON its Schema took, or unset it
 *   with none: for every device, through the Daemon, made from the options read, or with
 *   `device`, for this device alone, which keeps it and never sends it.
 * - `PromptCredential`: ask for a Credential option's value in a password prompt, which
 *   gives it to the Vault and points the option at it. A value never goes through the
 *   composer, nor through an intent.
 * - `Open`: open a Timeline in the focused Pane, or focus the Pane it is open in.
 * - `Latest`: read a Timeline's latest again and follow it, wherever its window stands.
 * - `OpenPalette`: open the command palette.
 * - `FocusComposer`: focus the composer under the main view, starting it with `text` when
 *   there is one, as the palette starts a command that needs arguments. A draft with text
 *   in it is never replaced: the composer says what was not put in.
 * - `MarkRead`: mark a Timeline read, above.
 * - `Notify`: turn notifications on or off on this device, asking the browser's permission
 *   to turn them on.
 * - `ShowMembers`: show or hide the open Channel's members on this device, or turn them
 *   over when `shown` is none.
 * - `Query`: open the Timeline of a name on a Network, as the Daemon keyed it, such as a
 *   Direct Message's. A Timeline exists only once something was said in it, so with none,
 *   the composer starts `/msg <name> ` to say the first Message, which opens it.
 * - `Pane`: change the Panes: split, close, focus, swap, resize, or zoom.
 */
export type Intent =
  | Say
  | Act
  | { readonly _tag: "OpenOptions"; readonly filter: string }
  | { readonly _tag: "Configure"; readonly network: NetworkId; readonly edit: Edit }
  | {
      readonly _tag: "AddNetwork";
      readonly network: NetworkId;
      readonly configuration: Configuration;
    }
  | {
      readonly _tag: "ChangeUi";
      readonly option: UiOptionName;
      readonly value: Json | undefined;
      readonly device: boolean;
    }
  | { readonly _tag: "PromptCredential"; readonly network: NetworkId; readonly path: Path }
  | { readonly _tag: "Open"; readonly timeline: TimelineId }
  | { readonly _tag: "Latest"; readonly timeline: TimelineId }
  | { readonly _tag: "OpenPalette" }
  | { readonly _tag: "FocusComposer"; readonly text: string | undefined }
  | MarkRead
  | { readonly _tag: "Notify"; readonly on: boolean }
  | { readonly _tag: "ShowMembers"; readonly shown: boolean | undefined }
  | { readonly _tag: "Query"; readonly network: NetworkId; readonly name: string }
  | { readonly _tag: "Pane"; readonly change: PaneChange };

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
 * - `Panes`: there is more than one Pane.
 */
export type Condition =
  | { readonly _tag: "Focused" }
  | { readonly _tag: "Target" }
  | { readonly _tag: "Channel" }
  | { readonly _tag: "Session" }
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
   * Whether it takes arguments: `None`, `Optional`, or `Required`. The palette runs one that
   * needs none, and starts one that does in the composer.
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
        return invalid("Open a Timeline first.");
      }

      const value = parse(args, focus);

      return value._tag === "Parsed" ? parsed(intents(value.value, focus)) : value;
    },
  };
};

/**
 * Text to say, which must not be empty.
 * @param usage - How the command is typed, to say when it is.
 * @returns The parser.
 */
const textOf =
  (usage: string) =>
  (args: string): Parsed<string> =>
    args === "" ? invalid(`Say what? ${usage}`) : parsed(args);

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
      return invalid(`To whom? ${usage}`);
    }

    // A list of Targets is never one Timeline, and the Client sends none.
    if (target.includes(",")) {
      return invalid("Say it to one Target at a time.");
    }

    return text === "" ? invalid(`Say what? ${usage}`) : parsed({ target, text });
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

/**
 * Why a Credential's value typed after `/set` is refused, in words.
 * @param name - The option's name.
 * @returns The words.
 */
const credentialRefused = (name: string) =>
  `A Credential's value is never typed into the composer. It was cleared, and nothing was sent. Use /set ${name} alone, which asks for it in a password prompt.`;

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

const deviceOnlyUi = `Only an option under ui is kept for this device, as in /set ${deviceFlag} ui.theme light.`;

/**
 * An option under `ui` set to a value given as text, for every device or this one.
 * @param name - The option's name.
 * @param text - The value.
 * @param device - Whether for this device alone.
 * @returns The intent, or why there is none.
 */
const setUi = (name: string, text: string, device: boolean): Parsed<Intent> => {
  const found = resolveUi(name);

  if (found._tag === "Invalid") {
    return found;
  }

  if (text.trim() === "") {
    return invalid(`Give ${name} a value, or use /unset ${device ? `${deviceFlag} ` : ""}${name}.`);
  }

  const value = parseUiText(found.value.option, text);

  return value._tag === "Invalid"
    ? value
    : parsed({ _tag: "ChangeUi", device, option: found.value.option, value: value.value });
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
    ? setUi(name, space === -1 ? "" : args.slice(space + 1), true)
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

    return found._tag === "Invalid"
      ? found
      : parsed({
          _tag: "ChangeUi",
          device: onDevice !== undefined,
          option: found.value.option,
          value: undefined,
        });
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

  if (alone?._tag === "Parsed" && alone.value.field.kind._tag === "Credential") {
    return parsed({
      _tag: "PromptCredential",
      network: alone.value.network,
      path: alone.value.path,
    });
  }

  if (space === -1) {
    return parsed({ _tag: "OpenOptions", filter: args });
  }

  const name = args.slice(0, space);
  const text = args.slice(space + 1);

  if (isUiName(name)) {
    return setUi(name, text, false);
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

const networkUsage = "/network add <id> <host>[/port] [-tls] <nick>";

/**
 * What `/network add` was given: an id, an Ircd, and a nick.
 * @param args - The text after `/network`.
 * @returns The intent, or why there is none.
 */
const networkArguments = (args: string): Parsed<Intent> => {
  const [verb, id = "", ...rest] = args.split(/\s+/u).filter((one) => one !== "");
  const nick = rest.at(-1);
  const ircdText = rest.slice(0, -1).join(" ");

  if (verb !== "add") {
    return invalid(`Use ${networkUsage}.`);
  }

  const network = networkIdOf(id);

  if (network === undefined) {
    return invalid(
      `A Network's id is 1 to 64 lower-case letters, digits, ., _, or -, not "${id}". ${networkUsage}`
    );
  }

  if (nick === undefined || ircdText === "") {
    return invalid(`Give an Ircd and a nick. ${networkUsage}`);
  }

  const ircd = parseIrcd(ircdText);

  if (ircd._tag === "Invalid") {
    return ircd;
  }

  const configuration = starting(network, { ircds: [ircd.value], nicks: [nick] });

  return configuration._tag === "Invalid"
    ? configuration
    : parsed({ _tag: "AddNetwork", configuration: configuration.value, network });
};

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
    : invalid("Name a Channel to part, such as /part #iirc, or open the Channel.");
};

/**
 * The Timeline next to the open one in the sidebar's order, wrapping around at either end,
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
      return invalid("There are no Timelines yet. Add a Network with /network add.");
    }

    const at = open === undefined ? -1 : timelines.indexOf(open);
    const step = direction === "Next" ? 1 : -1;
    const from = at === -1 && direction === "Previous" ? 0 : at;
    const to = timelines[(((from + step) % count) + count) % count];

    return parsed(to === open ? undefined : to);
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
    return parsed(marksOf(context.unread));
  }

  if (what !== "") {
    return invalid("Use /read for the open Timeline, or /read all for every Timeline.");
  }

  const { focus } = context;

  return focus === undefined
    ? invalid("Open a Timeline first, or use /read all.")
    : parsed(marksOf(context.unread.filter((one) => one.timeline === focus.timeline)));
};

/** The least a Timeline's highest level must be for `/next-unread` to go to it. */
const worthJumping = rank("Message");

/**
 * The Timeline with the most calling for the Owner, of those not skipped: the highest level
 * unread, at least Messages, and ties by the sidebar's order.
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
 * The Timeline with the most calling for the Owner, other than the open one: the highest
 * level unread, Highlights first, then Direct Messages, then Messages, and ties by the
 * sidebar's order. Activity alone is not enough, since joins and quits pile up everywhere.
 * @param args - The text after `/next-unread`.
 * @param context - The context.
 * @returns The Timeline to open, or none when nothing else calls.
 */
const nextUnread = (args: string, context: CommandContext): Parsed<TimelineId | undefined> =>
  args.trim() === ""
    ? parsed(calling(context, (timeline) => timeline === context.open))
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

/**
 * What `/members` was given: nothing, to turn the members over, or `on` or `off`.
 * @param args - The text after `/members`.
 * @returns Whether to show them, none to turn them over, or why it cannot tell.
 */
const membersArguments = (args: string): Parsed<boolean | undefined> => {
  const what = args.trim().toLowerCase();

  if (what === "") {
    return parsed(undefined);
  }

  if (what === "on" || what === "off") {
    return parsed(what === "on");
  }

  return invalid("Use /members to show or hide them, or /members on or /members off.");
};

/**
 * What `/query` was given: one name, with no space or `,`.
 * @param args - The text after `/query`.
 * @returns The name, or why it is not one.
 */
const queryArguments = (args: string): Parsed<string> => {
  const name = args.trim();

  if (name === "") {
    return invalid("With whom? /query <nick>");
  }

  if (/[\s,]/u.test(name)) {
    return invalid("Give one nick. To say something to them, use /msg <nick> <text>.");
  }

  return parsed(name);
};

const target: readonly Condition[] = [{ _tag: "Target" }, { _tag: "Session" }];
const anywhere: readonly Condition[] = [{ _tag: "Focused" }, { _tag: "Session" }];
const anywhereActing = anywhere;
const focused: readonly Condition[] = [{ _tag: "Focused" }];

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
        return invalid("Open a Timeline first.");
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
  "A Credential never goes in a raw Line: PASS, AUTHENTICATE, and OPER carry one, and a raw Line is journaled whole. It was cleared, and nothing was sent.";

/**
 * A raw Line's command, as an Ircd reads it: after any tags and source, in upper case.
 * @param line - The raw Line, as typed.
 * @returns Its command, or `""` for none.
 */
const rawCommandOf = (line: string): string => {
  const words = wordsOf(line);
  const tags = words[0]?.startsWith("@") === true ? 1 : 0;
  const start = tags + (words[tags]?.startsWith(":") === true ? 1 : 0);

  return (words[start] ?? "").replaceAll(/[a-z]/gu, (letter) => letter.toUpperCase());
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
    return invalid("Kick whom? /kick <nick>[,<nick>…] [reason]");
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
  `The modes ${focus.network} has are not known yet: open a Channel on it, wait for its head to be read, and try again.`;

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
      return invalid(
        `${focus.network} has no Channel mode ${change.mode}, as its CHANMODES and PREFIX say.`
      );
    }

    const param = takes ? given.shift() : undefined;

    if (takes && param === undefined) {
      return invalid(`${sign}${change.mode} needs a parameter. ${modeUsage}`);
    }

    requests.push({ ...change, param: param ?? null });
  }

  if (given.length > 0) {
    return invalid(`Nothing takes ${given.join(" ")}. ${modeUsage}`);
  }

  const [one, ...others] = requests;

  return one === undefined
    ? invalid(`Change which modes? ${modeUsage}`)
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
    return invalid(`Change which modes? ${modeUsage}`);
  }

  if (!named && focus.kind !== "Channel") {
    return invalid(`Name whose modes to change, or open the Channel. ${modeUsage}`);
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
      return invalid(`Self's modes take no parameters here. Use /quote MODE ${target} … for that.`);
    }

    return one === undefined
      ? invalid(`Change which modes? ${modeUsage}`)
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
      return invalid(`Whom? ${usage}`);
    }

    if (head === undefined) {
      return invalid(rulesUnknown(focus));
    }

    if (!head.ranks.some((one) => one.mode === mode)) {
      const ranks = head.ranks.map((one) => `${one.symbol} (${one.mode})`).join(", ");

      return invalid(
        `${focus.network} has no ${rankNames.get(mode) ?? mode} rank (${mode}): its PREFIX gives ${ranks === "" ? "none" : ranks}.`
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
      return invalid(`Whom? ${usage}`);
    }

    const rules = rulesOf(head);

    if (rules === undefined) {
      return invalid(rulesUnknown(focus));
    }

    if (!rules.chanmodes.list.includes("b")) {
      return invalid(`${focus.network} has no ban list (b) in its CHANMODES.`);
    }

    return parsed({
      _tag: "Mode",
      changes: [change(first), ...rest.map(change)],
      target: focus.name,
    });
  };
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
    return invalid("Invite whom? /invite <nick> [channel]");
  }

  if (rest.length > 0) {
    return invalid("Invite one nick to one Channel: /invite <nick> [channel]");
  }

  if (channel === undefined && focus.kind !== "Channel") {
    return invalid("To which Channel? /invite <nick> <channel>, or open the Channel.");
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

/** Sending a Line written as text, which never carries a Credential. */
const quoteCommand = acting({
  aliases: ["raw"],
  arguments: "Required",
  description:
    "Send a Line written as text to the open Timeline's Network, for what no other command covers.",
  id: "act.quote",
  name: "quote",
  parse: (args) => {
    if (args.trim() === "") {
      return invalid("Send what? /quote <raw line>");
    }

    return credentialCommands.has(rawCommandOf(args))
      ? invalid(rawCredentialRefused)
      : parsed({ _tag: "Raw", line: args });
  },
  usage: "/quote <raw line>",
  when: anywhereActing,
});

const actingOn: readonly Condition[] = [{ _tag: "Channel" }, { _tag: "Session" }];

/** The commands that act on a Network: each gives an `Act`, as `act` takes it. */
const actions: readonly Command[] = [
  acting({
    aliases: [],
    arguments: "Optional",
    description:
      "Set the open Channel's topic, clear it with -delete, or, with nothing, edit the topic as it is.",
    id: "act.topic",
    name: "topic",
    parse: topicArguments,
    usage: topicUsage,
    when: actingOn,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description: "Kick nicks from the open Channel, with a reason or none.",
    id: "act.kick",
    name: "kick",
    parse: kickArguments,
    usage: "/kick <nick>[,<nick>…] [reason]",
    when: actingOn,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description: "Change modes of the open Channel, another target, or Self.",
    id: "act.mode",
    name: "mode",
    parse: modeArguments,
    usage: modeUsage,
    when: anywhereActing,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description: "Make nicks operators of the open Channel.",
    id: "act.op",
    name: "op",
    parse: ranked("o", true, "/op <nick>…"),
    usage: "/op <nick>…",
    when: actingOn,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description: "Take operator from nicks in the open Channel.",
    id: "act.deop",
    name: "deop",
    parse: ranked("o", false, "/deop <nick>…"),
    usage: "/deop <nick>…",
    when: actingOn,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description: "Give nicks voice in the open Channel.",
    id: "act.voice",
    name: "voice",
    parse: ranked("v", true, "/voice <nick>…"),
    usage: "/voice <nick>…",
    when: actingOn,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description: "Take voice from nicks in the open Channel.",
    id: "act.devoice",
    name: "devoice",
    parse: ranked("v", false, "/devoice <nick>…"),
    usage: "/devoice <nick>…",
    when: actingOn,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description: "Ban masks from the open Channel; a bare nick bans nick!*@*.",
    id: "act.ban",
    name: "ban",
    parse: banned(true, "/ban <nick|mask>…"),
    usage: "/ban <nick|mask>…",
    when: actingOn,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description: "Lift bans from the open Channel; a bare nick lifts nick!*@*.",
    id: "act.unban",
    name: "unban",
    parse: banned(false, "/unban <mask>…"),
    usage: "/unban <mask>…",
    when: actingOn,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description: "Invite a nick to the open Channel, or to another.",
    id: "act.invite",
    name: "invite",
    parse: inviteArguments,
    usage: "/invite <nick> [channel]",
    when: anywhereActing,
  }),
  acting({
    aliases: [],
    arguments: "Optional",
    description:
      "Be away on the open Timeline's Network, with a message, kept across reconnects; with none, be back.",
    id: "act.away",
    name: "away",
    parse: (args) => parsed({ _tag: "Away", message: args.trim() === "" ? null : args }),
    usage: "/away [message]",
    when: focused,
  }),
  acting({
    aliases: [],
    arguments: "None",
    description: "Be back on the open Timeline's Network, no longer away.",
    id: "act.back",
    name: "back",
    parse: (args) =>
      args.trim() === ""
        ? parsed({ _tag: "Away", message: null })
        : invalid("/back takes nothing after it. To be away with a message, use /away <message>."),
    usage: "/back",
    when: focused,
  }),
  acting({
    aliases: [],
    arguments: "Required",
    description:
      "Change Self's nick on the open Timeline's Network for this Session; set network.<id>.nicks to keep it.",
    id: "act.nick",
    name: "nick",
    parse: (args) => {
      const nick = oneName(args.trim(), "nick");

      return nick._tag === "Invalid" ? nick : parsed({ _tag: "Nick", nick: nick.value });
    },
    usage: "/nick <nick>",
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
  description: "Say a Message to the open Channel or Direct Message.",
  id: "say.privmsg",
  intents: (text: string, focus) => [say(focus, "Privmsg", text)],
  name: "say",
  parse: textOf("/say <text>"),
  usage: "/say <text>",
  when: target,
});

/** Opening the options, setting an option, or asking for a Credential option's value. */
const setCommand = unfocused({
  aliases: [],
  arguments: "Optional",
  description:
    "Open the options, filtered by a pattern such as network.libera.* or *nick*, set an option to a value, set an option under ui for this device alone with -device, or ask for a Credential's value in a password prompt.",
  id: "options.set",
  intents: (intent: Intent) => [intent],
  name: "set",
  parse: setArguments,
  usage: "/set [<pattern> | [-device] <option> [<value>]]",
  when: [],
});

/** Every command, in the order a list of them shows. */
export const commands: readonly Command[] = [
  sayCommand,
  command({
    aliases: ["action"],
    arguments: "Required",
    description: "Say what you are doing, as a CTCP ACTION, to the open Channel or Direct Message.",
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
    description: "Say a Message to any Target, and open the Direct Message with a nick.",
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
    description: "Send a NOTICE to any Target.",
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
      "Join Channels on the open Timeline's Network, by adding them to its Configuration.",
    id: "channels.join",
    intents: (channels: readonly string[], focus) => [
      { _tag: "Configure", edit: { _tag: "Join", channels }, network: focus.network },
    ],
    name: "join",
    parse: (args) =>
      args.trim().includes(" ")
        ? invalid(
            "Give Channels comma-separated. A key is a Credential: set it with /set network.<id>.channels.<channel>.key <key>."
          )
        : channelsOf(args),
    usage: "/join <#channel>[,<#channel>…]",
    when: focused,
  }),
  command({
    aliases: ["leave"],
    arguments: "Optional",
    description: "Part Channels, or the open one, by taking them from its Network's Configuration.",
    id: "channels.part",
    intents: (edit: Edit, focus) => [{ _tag: "Configure", edit, network: focus.network }],
    name: "part",
    parse: partArguments,
    usage: "/part [#channel[,#channel…]]",
    when: focused,
  }),
  ...actions,
  setCommand,
  unfocused({
    aliases: [],
    arguments: "Required",
    description:
      "Return an option to what it starts as, or leave it unset, or with -device, stop this device overriding an option under ui.",
    id: "options.unset",
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
      "Add a Network, enabled, with one Ircd and one nick, and everything else as a new Network starts.",
    id: "network.add",
    intents: (intent: Intent) => [intent],
    name: "network",
    parse: networkArguments,
    usage: networkUsage,
    when: [],
  }),
  command({
    aliases: [],
    arguments: "None",
    description: "Jump to the open Timeline's latest, and follow it from there.",
    id: "timeline.latest",
    intents: (_: undefined, focus) => [{ _tag: "Latest", timeline: focus.timeline }],
    name: "latest",
    parse: (args) =>
      args.trim() === "" ? parsed(undefined) : invalid("/latest takes nothing after it."),
    usage: "/latest",
    when: focused,
  }),
  unfocused({
    aliases: [],
    arguments: "None",
    description: "Open the next Timeline in the sidebar.",
    id: "timeline.next",
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
    description: "Open the previous Timeline in the sidebar.",
    id: "timeline.previous",
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
      "Open the Timeline with the most calling for you: Highlights, then Direct Messages, then Messages.",
    id: "timeline.unread",
    intents: (to: TimelineId | undefined) =>
      to === undefined ? [] : [{ _tag: "Open", timeline: to }],
    name: "next-unread",
    parse: nextUnread,
    usage: "/next-unread",
    when: [],
  }),
  unfocused({
    aliases: [],
    arguments: "Optional",
    description:
      "Mark the open Timeline read up to its latest, or every Timeline with /read all, for every Frontend.",
    id: "timeline.read",
    intents: (marks: readonly MarkRead[]) => marks,
    name: "read",
    parse: readArguments,
    usage: "/read [all]",
    when: [],
  }),
  unfocused({
    aliases: [],
    arguments: "Required",
    description:
      "Notify on this device of Highlights and Direct Messages you are not looking at, or stop.",
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
      "Open the Direct Message with a nick, or start /msg to them when nothing was said yet.",
    id: "timeline.query",
    intents: (name: string, focus) => [{ _tag: "Query", name, network: focus.network }],
    name: "query",
    parse: queryArguments,
    usage: "/query <nick>",
    when: focused,
  }),
  unfocused({
    aliases: [],
    arguments: "Optional",
    description: "Show or hide the open Channel's members, on this device.",
    id: "members.toggle",
    intents: (shown: boolean | undefined) => [{ _tag: "ShowMembers", shown }],
    name: "members",
    parse: membersArguments,
    usage: "/members [on|off]",
    when: [],
  }),
  unfocused({
    aliases: [],
    arguments: "None",
    description: "Open the command palette, to run a command, open a Timeline, or set an option.",
    id: "palette.open",
    intents: () => [{ _tag: "OpenPalette" }],
    name: "palette",
    parse: nothingAfter("palette"),
    usage: "/palette",
    when: [],
  }),
  paneCommand({
    aliases: [],
    arguments: "Optional",
    description:
      "Split the focused Pane, side by side or one above another, opening what calls for you most.",
    id: "pane.split",
    name: "split",
    parse: splitArguments,
    usage: "/split [h|v]",
    when: [],
  }),
  paneCommand({
    aliases: [],
    arguments: "None",
    description: "Close the focused Pane, the Pane beside it taking its place.",
    id: "pane.close",
    name: "close",
    parse: ofPanes("close", { _tag: "Close" }),
    usage: "/close",
    when: panesNeeded,
  }),
  paneCommand({
    aliases: [],
    arguments: "Required",
    description: "Focus the Pane to the left, right, above, or below.",
    id: "pane.focus",
    name: "pane",
    parse: towards("pane", (direction) => ({ _tag: "Move", direction })),
    usage: "/pane left|right|up|down",
    when: panesNeeded,
  }),
  paneCommand({
    aliases: [],
    arguments: "Required",
    description: "Swap what the focused Pane shows with the Pane in a direction, and follow it.",
    id: "pane.swap",
    name: "swap",
    parse: towards("swap", (direction) => ({ _tag: "Swap", direction })),
    usage: "/swap left|right|up|down",
    when: panesNeeded,
  }),
  paneCommand({
    aliases: [],
    arguments: "None",
    description: "Give every Pane an equal share of the space it splits.",
    id: "pane.equalize",
    name: "equalize",
    parse: ofPanes("equalize", { _tag: "Equalize" }),
    usage: "/equalize",
    when: panesNeeded,
  }),
  paneCommand({
    aliases: [],
    arguments: "None",
    description: "Show the focused Pane alone, or every Pane again.",
    id: "pane.zoom",
    name: "zoom",
    parse: ofPanes("zoom", { _tag: "Zoom" }),
    usage: "/zoom",
    when: panesNeeded,
  }),
  paneCommand({
    aliases: [],
    arguments: "None",
    description: "Make the focused Pane larger, by a step.",
    id: "pane.grow",
    name: "grow",
    parse: ofPanes("grow", { _tag: "Grow" }),
    usage: "/grow",
    when: panesNeeded,
  }),
  paneCommand({
    aliases: [],
    arguments: "None",
    description: "Make the focused Pane smaller, by a step.",
    id: "pane.shrink",
    name: "shrink",
    parse: ofPanes("shrink", { _tag: "Shrink" }),
    usage: "/shrink",
    when: panesNeeded,
  }),
  unfocused({
    aliases: [],
    arguments: "None",
    description: "Put the caret in the composer, to type into it.",
    id: "composer.focus",
    intents: () => [{ _tag: "FocusComposer", text: undefined }],
    name: "focus",
    parse: nothingAfter("focus"),
    usage: "/focus",
    when: [],
  }),
];

const byName: ReadonlyMap<string, Command> = new Map(
  commands.flatMap((one) => [one.name, ...one.aliases].map((name) => [name, one] as const))
);

const byId: ReadonlyMap<string, Command> = new Map(commands.map((one) => [one.id, one] as const));

/**
 * The command with an id, as a keybinding names it.
 * @param id - Its id, such as `timeline.next`.
 * @returns The command, or none.
 */
export const commandWithId = (id: string): Command | undefined => byId.get(id);

/**
 * The command a name stands for, in any ASCII case.
 * @param name - The name, without its `/`.
 * @returns The command, or none.
 */
export const commandNamed = (name: string): Command | undefined =>
  byName.get(name.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase()));

/**
 * Why a line that types a Credential is refused, in words, or nothing when it types none:
 * a value after `/set <credential option>`, or a `/quote` or `/raw` of `PASS`,
 * `AUTHENTICATE`, or `OPER`, in any ASCII case. The composer refuses and clears such a
 * line at once, keeping it nowhere.
 * @param line - The line.
 * @returns The words, or none.
 */
export const credentialRefusal = (line: string): string | undefined => {
  const [command = "", name = "", ...rest] = line.split(" ");
  const found = commandNamed(command.slice(1));

  if (!command.startsWith("/") || command.startsWith("//")) {
    return undefined;
  }

  if (found === quoteCommand) {
    return credentialCommands.has(rawCommandOf(line.slice(command.length)))
      ? rawCredentialRefused
      : undefined;
  }

  const option = resolve(name);

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
 * @returns Whether it does.
 */
export const typesCredential = (line: string): boolean => credentialRefusal(line) !== undefined;

/**
 * Why a command cannot run in a context, in words, or nothing when it can.
 * @param when - Its conditions.
 * @param context - The context.
 * @returns The first condition that does not hold, in words.
 */
export const unmet = (when: readonly Condition[], context: CommandContext): string | undefined => {
  const { focus } = context;

  for (const condition of when) {
    switch (condition._tag) {
      case "Focused": {
        if (focus === undefined) {
          return "Open a Timeline first.";
        }

        break;
      }

      case "Target": {
        if (focus === undefined) {
          return "Open a Channel or a Direct Message first.";
        }

        if (focus.kind === "Network") {
          return "The Network's own Timeline has no Target to say it to. Open a Channel or a Direct Message, or use /msg <target> <text>.";
        }

        if (focus.detached) {
          return "This Direct Message no longer follows its partner, who changed nick. Use /msg <nick> <text>.";
        }

        break;
      }

      case "Channel": {
        if (focus?.kind !== "Channel") {
          return "Open a Channel first.";
        }

        break;
      }

      case "Session": {
        if (!context.session) {
          return `${focus?.network ?? "The Network"} is not connected, so nothing can be said there now.`;
        }

        break;
      }

      case "Panes": {
        if (context.panes < 2) {
          return "There is only one Pane. /split makes another.";
        }

        break;
      }

      default: {
        return condition satisfies never;
      }
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

/**
 * One line of input, read: plain text is said to the open Timeline, `//text` says
 * `/text`, and `/name args` runs the command it names, if it can run here.
 * @param line - The line, with no line break.
 * @param context - The context.
 * @returns Its intents, or why there are none.
 */
export const interpret = (line: string, context: CommandContext): Parsed<readonly Intent[]> => {
  const literal = line.startsWith("//");

  if (!line.startsWith("/") || literal) {
    return runIn(sayCommand, literal ? line.slice(1) : line, context);
  }

  const space = line.indexOf(" ");
  const name = space === -1 ? line.slice(1) : line.slice(1, space);
  const args = space === -1 ? "" : line.slice(space + 1);

  if (name === "") {
    return invalid("Type a command after /, or start with // to say text that begins with /.");
  }

  const found = commandNamed(name);

  if (found === undefined) {
    return invalid(`There is no command /${name}. Start with // to say text that begins with /.`);
  }

  return runIn(found, args, context);
};
