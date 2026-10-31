const safe: unique symbol = Symbol("OutboundLine");

/** The most bytes a Line may hold before its line ending. */
export const maxLineBytes = 510;

/** A Line that is safe to send. The only way to get one is {@link outbound}. */
export interface OutboundLine {
  readonly [safe]: true;
  readonly text: string;
}

/** Why a Line cannot be sent. */
export type OutboundRejection =
  | "InvalidCommand"
  | "InvalidParameter"
  | "TooLong"
  | "InvalidTarget"
  | "EmptyText";

/** Either a {@link OutboundLine}, or the reason it can't exist. */
export type Outbound =
  | { readonly _tag: "Safe"; readonly line: OutboundLine }
  | { readonly _tag: "Rejected"; readonly reason: OutboundRejection };

const encoder = new TextEncoder();
const rejected = (reason: OutboundRejection): Outbound => ({ _tag: "Rejected", reason });
const hasLineBreakOrNull = (text: string) => /[\0\r\n]/u.test(text);

const isMiddleParameter = (param: string) =>
  param !== "" && !param.includes(" ") && !param.startsWith(":") && !hasLineBreakOrNull(param);

const formatLast = (param: string) =>
  param === "" || param.includes(" ") || param.startsWith(":") ? `:${param}` : param;

/**
 * Builds a Line that cannot smuggle in a second command or break the framing.
 * @param command - The command, such as `PRIVMSG`.
 * @param params - The parameters, where only the last may hold spaces.
 * @returns The safe Line, or why it can't be built.
 */
export const outbound = (command: string, params: readonly string[]): Outbound => {
  if (!/^(?:[A-Za-z]+|\d{3})$/u.test(command)) {
    return rejected("InvalidCommand");
  }

  const middle = params.slice(0, -1);
  const last = params.at(-1);

  if (!middle.every(isMiddleParameter) || (last !== undefined && hasLineBreakOrNull(last))) {
    return rejected("InvalidParameter");
  }

  const text = [command, ...middle, ...(last === undefined ? [] : [formatLast(last)])].join(" ");

  return encoder.encode(text).length > maxLineBytes
    ? rejected("TooLong")
    : { _tag: "Safe", line: { [safe]: true, text } };
};

/**
 * Builds a `PRIVMSG` to one Target.
 * @param target - The Channel or User to address.
 * @param text - What to say.
 * @returns The safe Line, or why it can't be built.
 */
export const privmsg = (target: string, text: string): Outbound => {
  if (target.includes(",") || !isMiddleParameter(target)) {
    return rejected("InvalidTarget");
  }

  return text === "" ? rejected("EmptyText") : outbound("PRIVMSG", [target, text]);
};

/**
 * Encodes a Line for the wire.
 * @param line - The Line to encode.
 * @returns The bytes to write, with the line ending.
 */
export const encodeLine = (line: OutboundLine) => encoder.encode(`${line.text}\r\n`);
