/**
 * CTCP: what the text of a `PRIVMSG` or `NOTICE` holds, and the text and Lines to send
 * one. Nothing here acts on anything: whether to answer a request is the caller's choice,
 * and a `DCC` is only ever read.
 *
 * @packageDocumentation
 */
import { Schema } from "effect";

import { notice, privmsg, upperCaseAscii } from "./line.ts";
import type { OutboundLine, Rejected } from "./line.ts";

/** What the text of a `PRIVMSG` or `NOTICE` holds, as CTCP sees it. */
export type Ctcp =
  | { readonly _tag: "NotCtcp" }
  | { readonly _tag: "Action"; readonly text: string }
  | { readonly _tag: "Dcc"; readonly subcommand: string; readonly args: string }
  | { readonly _tag: "Other"; readonly command: string; readonly args: string };

const delimiter = "\u0001";
const notCtcp: Ctcp = { _tag: "NotCtcp" };

/**
 * Reads CTCP out of the text of a `PRIVMSG` or `NOTICE`, and never throws.
 *
 * CTCP is `\x01COMMAND args\x01`. The closing `\x01` is optional, because many IRC
 * clients leave it out, and anything after it is ignored. The command is upper-cased,
 * and the arguments are everything after the one space that follows it, spaces and all.
 * A `\x01` with no command is not CTCP. Low-level quoting (`\x10`) is not undone.
 * Whether it is a request or a reply is for the carrying command to say.
 * @param text - The last parameter of the Line.
 * @returns What it holds. `ACTION` has its text, which may be empty, and `DCC` its
 * subcommand and raw arguments. A `DCC` with no subcommand is `Other`.
 */
export const parseCtcp = (text: string): Ctcp => {
  if (!text.startsWith(delimiter)) {
    return notCtcp;
  }

  const close = text.indexOf(delimiter, 1);
  const body = text.slice(1, close === -1 ? text.length : close);
  const space = body.indexOf(" ");
  const command = upperCaseAscii(space === -1 ? body : body.slice(0, space));
  const args = space === -1 ? "" : body.slice(space + 1);

  if (command === "") {
    return notCtcp;
  }

  if (command === "ACTION") {
    return { _tag: "Action", text: args };
  }

  if (command === "DCC") {
    const split = args.indexOf(" ");
    const subcommand = upperCaseAscii(split === -1 ? args : args.slice(0, split));

    if (subcommand !== "") {
      return { _tag: "Dcc", args: split === -1 ? "" : args.slice(split + 1), subcommand };
    }
  }

  return { _tag: "Other", args, command };
};

const forbidden = ["\0", "\r", "\n", delimiter];
const hasForbidden = (text: string) => forbidden.some((char) => text.includes(char));

// `\x01`, a command with no space, then a space and arguments if there are any, and the
// closing `\x01`, with no other `\x01`, CR, LF, or NUL.
const isCtcpText = (text: string) => {
  const body = text.slice(1, -1);
  const space = body.indexOf(" ");
  const command = space === -1 ? body : body.slice(0, space);

  return (
    text.length >= 3 &&
    text.startsWith(delimiter) &&
    text.endsWith(delimiter) &&
    !hasForbidden(body) &&
    command !== ""
  );
};

/**
 * The text of a CTCP message that is safe to send: `\x01`, a command, its arguments, and
 * the closing `\x01`, with no other `\x01`, CR, LF, or NUL. Built by {@link ctcpText}.
 */
export const CtcpText = Schema.String.pipe(
  Schema.check(Schema.makeFilter(isCtcpText, { expected: "CTCP text that is safe to send" })),
  Schema.brand("CtcpText")
);

/** The decoded form of {@link CtcpText}. */
export type CtcpText = typeof CtcpText.Type;

/** Why some CTCP text cannot be built. */
export type CtcpRejection = "InvalidCommand" | "InvalidArguments";

/**
 * Builds the text of a CTCP message, such as an `ACTION` or a `VERSION` reply. The
 * command goes as it is given.
 * @param command - The CTCP command, which has no space and is not empty.
 * @param args - What follows it, which may be empty.
 * @returns The text, or why it cannot be built.
 */
export const ctcpText = (
  command: string,
  args: string
): CtcpText | { readonly _tag: "Rejected"; readonly reason: CtcpRejection } => {
  if (command === "" || command.includes(" ") || hasForbidden(command)) {
    return { _tag: "Rejected", reason: "InvalidCommand" };
  }

  if (hasForbidden(args)) {
    return { _tag: "Rejected", reason: "InvalidArguments" };
  }

  const body = args === "" ? command : `${command} ${args}`;

  return CtcpText.make(`${delimiter}${body}${delimiter}`, { disableChecks: true });
};

/**
 * A CTCP `ACTION`, as a `PRIVMSG` to one Target.
 * @param target - A Channel or User, one only.
 * @param text - What Self does. An empty action is allowed, as `/me` alone sends one.
 * @returns The Line, or why it cannot be sent.
 */
export const action = (target: string, text: string): OutboundLine | Rejected => {
  const built = ctcpText("ACTION", text);

  return Schema.is(CtcpText)(built)
    ? privmsg(target, built)
    : { _tag: "Rejected", reason: "InvalidParameter" };
};

/**
 * A User's nick that an automatic reply may be addressed to, and never a Channel, a
 * `STATUSMSG` Target, or a mask. Read by {@link parseReplyTarget}.
 */
export const ReplyTarget = Schema.String.pipe(Schema.brand("ReplyTarget"));

/** The decoded form of {@link ReplyTarget}. */
export type ReplyTarget = typeof ReplyTarget.Type;

/** What marks a Channel or a `STATUSMSG` Target on a Network, from ISUPPORT. */
export interface TargetPrefixes {
  /** `CHANTYPES`, such as `#&`. */
  readonly chantypes: string;
  /** `STATUSMSG`, such as `@+`. */
  readonly statusmsg: string;
}

// Anywhere in a nick, these mean something else: a space or a comma ends it, `!` and `@`
// split a source, and `*` and `?` are masks.
const notInNicks = /[\0\r\n ,*?!@]/u;

// Nor can a nick start with a digit or `-` (RFC 2812), `$` for a server mask, `:` for the
// last parameter, or a membership prefix, whatever the Network says.
const notFirstInNicks = /^[\d\-~%@&+$:#]/u;

/**
 * Reads the nick of a request's sender as a User to reply to. A source is whatever the
 * Ircd relayed, so a forged `#victims!u@h` or `$*.test!u@h` would turn a reply into a
 * `NOTICE` to a Channel or a mask. Only a nick passes: nothing holding a space, `,`, `*`,
 * `?`, `!`, or `@`, and nothing starting with a digit, `-`, `$`, `:`, a common prefix,
 * or a Channel or `STATUSMSG` prefix the Network has in force.
 * @param nick - The sender's nick, from its source.
 * @param prefixes - What marks a Channel or a `STATUSMSG` Target on the Network now.
 * @returns The Target, or `undefined` if the nick could name anything but a User.
 */
export const parseReplyTarget = (
  nick: string,
  { chantypes, statusmsg }: TargetPrefixes
): ReplyTarget | undefined => {
  const first = nick.charAt(0);

  return nick === "" ||
    notInNicks.test(nick) ||
    notFirstInNicks.test(nick) ||
    chantypes.includes(first) ||
    statusmsg.includes(first)
    ? undefined
    : ReplyTarget.make(nick);
};

/**
 * The `NOTICE` that carries a CTCP reply, to a User and nothing else.
 * @param target - The User to answer, from {@link parseReplyTarget}.
 * @param text - The reply, from {@link ctcpText}.
 * @returns The Line, or why it cannot be sent, such as a reply too long to fit.
 */
export const ctcpReply = (target: ReplyTarget, text: CtcpText): OutboundLine | Rejected =>
  notice(target, text);
