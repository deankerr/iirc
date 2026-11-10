/**
 * The commands, as data: one registry behind the composer's `/commands`, and later the
 * palette, keybindings, and agents, since each is a way of naming the same action. A
 * command parses its arguments into typed values or says in words why it cannot, and
 * gives intents, plain data the runtime carries out. It never does anything itself.
 *
 * @packageDocumentation
 */
import type { NetworkId, TimelineId } from "@iirc/api";

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
}

/** What a command's `when` and its arguments are judged against. */
export interface CommandContext {
  /** The Timeline in focus, if any. */
  readonly focus: Focus | undefined;
  /** Whether the focused Timeline's Network has a Session. */
  readonly session: boolean;
}

/**
 * What a command asks for, which the runtime carries out, in order.
 *
 * - `Say`: say a Message to a Target on a Network. With `opens`, once it is said, open the
 *   Direct Message Timeline the Daemon placed it in, if it placed it in one. Which Timeline
 *   that is, the Daemon's routing decides, never a name the Frontend folds.
 */
export interface Intent {
  readonly _tag: "Say";
  readonly network: NetworkId;
  readonly target: string;
  readonly kind: SayKind;
  readonly text: string;
  readonly opens: boolean;
}

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
    readonly parse: (args: string) => Parsed<A>;
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

      const value = parse(args);

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

const say = (focus: Focus, kind: SayKind, text: string): Intent => ({
  _tag: "Say",
  kind,
  network: focus.network,
  opens: false,
  target: focus.name,
  text,
});

const target: readonly Condition[] = [{ _tag: "Target" }, { _tag: "Session" }];
const anywhere: readonly Condition[] = [{ _tag: "Focused" }, { _tag: "Session" }];

/** Saying text to the open Timeline, which plain text does too. */
const sayCommand = command({
  aliases: [],
  description: "Say a Message to the open Channel or Direct Message.",
  id: "say.privmsg",
  intents: (text: string, focus) => [say(focus, "Privmsg", text)],
  name: "say",
  parse: textOf("/say <text>"),
  usage: "/say <text>",
  when: target,
});

/** Every command, in the order a list of them shows. */
export const commands: readonly Command[] = [
  sayCommand,
  command({
    aliases: ["action"],
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
];

const byName: ReadonlyMap<string, Command> = new Map(
  commands.flatMap((one) => [one.name, ...one.aliases].map((name) => [name, one] as const))
);

/**
 * The command a name stands for, in any ASCII case.
 * @param name - The name, without its `/`.
 * @returns The command, or none.
 */
export const commandNamed = (name: string): Command | undefined =>
  byName.get(name.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase()));

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
const runIn = (found: Command, args: string, context: CommandContext) => {
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
