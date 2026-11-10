/**
 * The commands, as data: one registry behind the composer's `/commands`, the palette, the
 * keymap, and later agents, since each is a way of naming the same action. A
 * command parses its arguments into typed values or says in words why it cannot, and
 * gives intents, plain data the runtime carries out. It never does anything itself.
 *
 * @packageDocumentation
 */
import type { Level, NetworkId, TimelineId } from "@iirc/api";

import { rank } from "./activity.ts";
import type { Instant } from "./activity.ts";
import { channelsOf, networkIdOf, parseIrcd, parseText, resolve, starting } from "./options.ts";
import type { Configuration, Edit, Path } from "./options.ts";

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
  /** The Timeline the Owner opened, as a merge resolves it, even while it is still read. */
  readonly open: TimelineId | undefined;
  /** Every Timeline with something unread, in the sidebar's order. */
  readonly unread: readonly Unseen[];
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
 * What a command asks for, which the runtime carries out, in order.
 *
 * - `Say`: say a Message, above.
 * - `OpenOptions`: show the options view, filtered as given.
 * - `Configure`: read the Network's Configuration, apply the edit to it, and send the whole
 *   of it back, made from the one read. On a conflict, read it again and apply the same
 *   edit once more, since an edit is a pure function of the Configuration.
 * - `AddNetwork`: configure a Network that must not exist yet, as a new one starts.
 * - `PromptCredential`: ask for a Credential option's value in a password prompt, which
 *   gives it to the Vault and points the option at it. A value never goes through the
 *   composer, nor through an intent.
 * - `Open`: open a Timeline in the main view.
 * - `OpenPalette`: open the command palette.
 * - `FocusComposer`: focus the composer under the main view, starting it with `text` when
 *   there is one, as the palette starts a command that needs arguments. A draft with text
 *   in it is never replaced: the composer says what was not put in.
 * - `MarkRead`: mark a Timeline read, above.
 * - `Notify`: turn notifications on or off on this device, asking the browser's permission
 *   to turn them on.
 */
export type Intent =
  | Say
  | { readonly _tag: "OpenOptions"; readonly filter: string }
  | { readonly _tag: "Configure"; readonly network: NetworkId; readonly edit: Edit }
  | {
      readonly _tag: "AddNetwork";
      readonly network: NetworkId;
      readonly configuration: Configuration;
    }
  | { readonly _tag: "PromptCredential"; readonly network: NetworkId; readonly path: Path }
  | { readonly _tag: "Open"; readonly timeline: TimelineId }
  | { readonly _tag: "OpenPalette" }
  | { readonly _tag: "FocusComposer"; readonly text: string | undefined }
  | MarkRead
  | { readonly _tag: "Notify"; readonly on: boolean };

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
 * - `Session`: the focused Timeline's Network has a Session.
 */
export type Condition =
  | { readonly _tag: "Focused" }
  | { readonly _tag: "Target" }
  | { readonly _tag: "Session" };

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

/**
 * What `/set` was given: nothing or a pattern, to open the options view filtered, or an
 * option's name and a value, to set it.
 * @param args - The text after `/set`.
 * @returns The intent, or why there is none.
 */
const setArguments = (args: string): Parsed<Intent> => {
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
 * The Timeline with the most calling for the Owner, other than the open one: the highest
 * level unread, Highlights first, then Direct Messages, then Messages, and ties by the
 * sidebar's order. Activity alone is not enough, since joins and quits pile up everywhere.
 * @param args - The text after `/next-unread`.
 * @param context - The context.
 * @returns The Timeline to open, or none when nothing else calls.
 */
const nextUnread = (args: string, context: CommandContext): Parsed<TimelineId | undefined> => {
  if (args.trim() !== "") {
    return invalid("/next-unread takes nothing after it.");
  }

  let best: Unseen | undefined;

  for (const one of context.unread) {
    const ranked = rank(one.level);

    if (
      one.timeline !== context.open &&
      ranked >= worthJumping &&
      (best === undefined || ranked > rank(best.level))
    ) {
      best = one;
    }
  }

  return parsed(best?.timeline);
};

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

const say = (focus: Focus, kind: SayKind, text: string): Say => ({
  _tag: "Say",
  kind,
  network: focus.network,
  opens: false,
  target: focus.name,
  text,
});

const target: readonly Condition[] = [{ _tag: "Target" }, { _tag: "Session" }];
const anywhere: readonly Condition[] = [{ _tag: "Focused" }, { _tag: "Session" }];
const focused: readonly Condition[] = [{ _tag: "Focused" }];

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
    "Open the options, filtered by a pattern such as network.libera.* or *nick*, set an option to a value, or ask for a Credential's value in a password prompt.",
  id: "options.set",
  intents: (intent: Intent) => [intent],
  name: "set",
  parse: setArguments,
  usage: "/set [<pattern> | <option> [<value>]]",
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
  setCommand,
  unfocused({
    aliases: [],
    arguments: "Required",
    description: "Return an option to what a new Network starts with, or leave it unset.",
    id: "options.unset",
    intents: (intent: Intent) => [intent],
    name: "unset",
    parse: (args) => {
      const found = resolve(args.trim());

      return found._tag === "Invalid"
        ? found
        : parsed<Intent>({
            _tag: "Configure",
            edit: { _tag: "Unset", path: found.value.path },
            network: found.value.network,
          });
    },
    usage: "/unset <option>",
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
 * Whether a line types a Credential's value after `/set`, which the composer refuses and
 * clears at once, so it is not kept as the draft.
 * @param line - The line.
 * @returns Whether it does.
 */
export const typesCredential = (line: string): boolean => {
  const [command = "", name = "", ...rest] = line.split(" ");
  const found = resolve(name);

  return (
    commandNamed(command.slice(1)) === setCommand &&
    command.startsWith("/") &&
    rest.join(" ") !== "" &&
    found._tag === "Parsed" &&
    found.value.field.kind._tag === "Credential"
  );
};

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

      case "Session": {
        if (!context.session) {
          return `${focus?.network ?? "The Network"} is not connected, so nothing can be said there now.`;
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
