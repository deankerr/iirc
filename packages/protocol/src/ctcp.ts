import { upperCaseAscii } from "./line.ts";
import { notice } from "./outbound.ts";
import type { Outbound } from "./outbound.ts";

/**
 * What the text of a `PRIVMSG` or `NOTICE` holds, as CTCP sees it. Nothing here acts on
 * anything: whether a request is answered is for the Daemon to decide (PROT-3), and a
 * `DCC` is only ever recorded (PROT-5).
 */
export type Ctcp =
  | { readonly _tag: "NotCtcp" }
  | { readonly _tag: "Action"; readonly text: string }
  | { readonly _tag: "Dcc"; readonly subcommand: string; readonly args: string }
  | { readonly _tag: "Other"; readonly command: string; readonly args: string };

const delimiter = "\u0001";
const notCtcp: Ctcp = { _tag: "NotCtcp" };

/**
 * Reads CTCP out of the text of a `PRIVMSG` or `NOTICE`, without ever throwing (PROT-2).
 *
 * CTCP is `\u0001COMMAND args\u0001`. The closing `\u0001` is optional, because many IRC
 * clients leave it out, and anything after it is ignored. The command is made upper-case
 * and the arguments are everything after the one space that follows it, spaces and all.
 * A `\u0001` with no command is not CTCP. Low-level CTCP quoting (`\u0010`) is not undone.
 *
 * Whether it is a request or a reply is the carrying command's to say, and is not
 * decided here.
 * @param text - The last parameter of the Line.
 * @returns What it holds. `ACTION` has its text, which may be empty, and `DCC` has its
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

class Payload {
  // Private, so that nothing but this module can make one that was not checked.
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  /**
   * @returns The text, `\u0001` and all, ready to be the last parameter of a `NOTICE`.
   */
  toString() {
    return this.#text;
  }
}

/**
 * The text of a CTCP message that is safe to send: `\u0001`, a command, and arguments,
 * with the closing `\u0001`, and no other `\u0001`, CR, LF, or NUL. The only way to get
 * one is {@link ctcpText}.
 */
export type CtcpText = Payload;

/** Why some CTCP text cannot be built. */
export type CtcpRejection = "InvalidCommand" | "InvalidArguments";

/** Either a {@link CtcpText}, or the reason it can't exist. */
export type CtcpTextResult =
  | { readonly _tag: "Safe"; readonly text: CtcpText }
  | { readonly _tag: "Rejected"; readonly reason: CtcpRejection };

const forbidden = ["\0", "\r", "\n", delimiter];
const hasForbidden = (text: string) => forbidden.some((char) => text.includes(char));

/**
 * Builds the text of a CTCP message, such as the argument of a `VERSION` reply. It
 * takes the command as it is given, so pass the one {@link parseCtcp} returned.
 * @param command - The CTCP command, which has no space and is not empty.
 * @param args - What follows it, which may be empty.
 * @returns The safe text, or why it can't be built.
 */
export const ctcpText = (command: string, args: string): CtcpTextResult => {
  if (command === "" || command.includes(" ") || hasForbidden(command)) {
    return { _tag: "Rejected", reason: "InvalidCommand" };
  }

  if (hasForbidden(args)) {
    return { _tag: "Rejected", reason: "InvalidArguments" };
  }

  const body = args === "" ? command : `${command} ${args}`;

  return { _tag: "Safe", text: new Payload(`${delimiter}${body}${delimiter}`) };
};

/**
 * Builds the `NOTICE` that carries a CTCP reply (PROT-4).
 * @param target - The User to answer.
 * @param text - The reply, from {@link ctcpText}.
 * @returns The safe Line, or why it can't be built, such as a reply too long to fit.
 */
export const ctcpReply = (target: string, text: CtcpText): Outbound =>
  notice(target, text.toString());
