/**
 * What a name in a Line's parameters is: a Channel, a User's nick, or neither, such as a
 * mask or a server. Each is read position by position, by the protocol's rules for names
 * and the Network's `CHANTYPES`, `PREFIX`, and `STATUSMSG`, never from an Ircd's text.
 * Every reader of a name goes through here, so a Channel is the same Channel and a nick
 * the same nick whichever way a Line goes.
 *
 * @packageDocumentation
 */
import { chantypesOf, defaultPrefix, prefixOf, statusmsgOf } from "@iirc/protocol/isupport";

/** What the Network says marks a name, from ISUPPORT, with the protocol's defaults. */
export interface Naming {
  /** `CHANTYPES`: what a Channel's name starts with. */
  readonly chantypes: string;
  /** The symbols of `PREFIX`, such as `@+`, which no nick starts with. */
  readonly prefixes: string;
  /** `STATUSMSG`: what a Target may carry before a Channel's name. */
  readonly statusmsg: string;
}

/**
 * The naming rules ISUPPORT gives. A `PREFIX` that does not pair its modes and symbols
 * reads as the default.
 * @param isupport - The tokens the Ircd has sent.
 * @returns The rules.
 */
export const namingOf = (isupport: ReadonlyMap<string, string>): Naming => ({
  chantypes: chantypesOf(isupport.get("CHANTYPES")),
  prefixes: (prefixOf(isupport.get("PREFIX")) ?? defaultPrefix)
    .map((membership) => membership.symbol)
    .join(""),
  statusmsg: statusmsgOf(isupport.get("STATUSMSG")),
});

const firstOf = (name: string): string => {
  const first = name.codePointAt(0);

  return first === undefined ? "" : String.fromCodePoint(first);
};

// A Channel's name holds no space, BELL, or comma, which separates a list.
const notInChannels: readonly string[] = [" ", String.fromCodePoint(7), ","];

/**
 * Reads a Channel's name: it starts with a character of `CHANTYPES`, and holds no space,
 * BELL, or comma.
 * @param naming - The Network's rules.
 * @param name - The name, as said.
 * @returns The name, or `undefined` if it cannot be a Channel's.
 */
export const parseChannel = (naming: Naming, name: string): string | undefined => {
  const first = firstOf(name);

  return first !== "" &&
    naming.chantypes.includes(first) &&
    !notInChannels.some((character) => name.includes(character))
    ? name
    : undefined;
};

// Anywhere in a nick, these mean something else: a space or a comma ends it, `!` and `@`
// split a source, and `*` and `?` are masks. A `.` is allowed: modern IRC says a nick
// should not hold one, and does not forbid it. Telling a nick from a server's name is
// left to whoever has the source, which a name alone does not give.
const notInNicks = /[ ,*?!@]/u;

// Nor can a nick start with `$`, a server mask, or `:`, the last parameter.
const notFirstInNicks = /^[$:]/u;

/**
 * Reads a nick: it holds no space, `,`, `*`, `?`, `!`, or `@`, and does not start
 * with `$`, `:`, a character of `CHANTYPES`, or a membership prefix of `PREFIX` or
 * `STATUSMSG`.
 * @param naming - The Network's rules.
 * @param name - The name, as said.
 * @returns The nick, or `undefined` if it cannot be one.
 */
export const parseNick = (naming: Naming, name: string): string | undefined => {
  const first = firstOf(name);

  return first === "" ||
    notInNicks.test(name) ||
    notFirstInNicks.test(name) ||
    naming.chantypes.includes(first) ||
    naming.prefixes.includes(first) ||
    naming.statusmsg.includes(first)
    ? undefined
    : name;
};

/** One Target of a Message, as its structure reads. */
export type Target =
  /** A Channel, after any `STATUSMSG` prefixes, so `@#iirc` is `#iirc`. */
  | { readonly _tag: "Channel"; readonly name: string }
  | { readonly _tag: "Nick"; readonly nick: string }
  /** Anything else, such as a mask like `$*.test`, `*`, or `nick@server`. */
  | { readonly _tag: "Other" };

const other: Target = { _tag: "Other" };

/**
 * Reads one Target: a Channel by `CHANTYPES`, else one after the `STATUSMSG` prefixes it
 * starts with, else a nick, else neither. A name that is already a Channel's is one, so
 * with `CHANTYPES=#&` and `STATUSMSG=~&@%+`, `&#iirc` is the Channel `&#iirc`, not `#iirc`
 * at `&`, and `@&iirc` is `&iirc`. With no `STATUSMSG`, `@#iirc` is neither.
 * @param naming - The Network's rules.
 * @param target - The Target, as said.
 * @returns What it is.
 */
const parseTarget = (naming: Naming, target: string): Target => {
  let rest = target;

  while (true) {
    const channel = parseChannel(naming, rest);

    if (channel !== undefined) {
      return { _tag: "Channel", name: channel };
    }

    if (rest === "" || !naming.statusmsg.includes(rest.charAt(0))) {
      break;
    }

    rest = rest.slice(1);
  }

  const nick = parseNick(naming, target);

  return nick === undefined ? other : { _tag: "Nick", nick };
};

/**
 * Reads a Message's Targets: a comma-separated list, each read by itself, where empty
 * items name nothing.
 * @param naming - The Network's rules.
 * @param targets - The Target parameter, as said.
 * @returns Each Target, in order.
 */
export const parseTargets = (naming: Naming, targets: string): readonly Target[] =>
  targets
    .split(",")
    .filter((target) => target !== "")
    .map((target) => parseTarget(naming, target));
