const safe: unique symbol = Symbol("OutboundLine");

/** The most bytes a Line may hold before its line ending. */
export const maxLineBytes = 510;

/**
 * A Line that is safe to send, as the bytes it will be on the wire. The only ways to
 * get one are {@link outbound} and {@link pong}.
 */
export interface OutboundLine {
  readonly [safe]: true;
  readonly bytes: Uint8Array;
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
const lineEnding = encoder.encode("\r\n");
const space = 0x20;
const colon = 0x3a;
const forbiddenBytes: ReadonlySet<number> = new Set([0x00, 0x0a, 0x0d]);

const rejected = (reason: OutboundRejection): Outbound => ({ _tag: "Rejected", reason });
const hasLineBreakOrNull = (text: string) => /[\0\r\n]/u.test(text);

const safeLine = (bytes: Uint8Array): Outbound =>
  bytes.length > maxLineBytes
    ? rejected("TooLong")
    : { _tag: "Safe", line: { bytes, [safe]: true } };

const concatenate = (head: Uint8Array, tail: Uint8Array) => {
  const joined = new Uint8Array(head.length + tail.length);

  joined.set(head);
  joined.set(tail, head.length);

  return joined;
};

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

  return safeLine(encoder.encode(text));
};

/**
 * Builds the reply to a `PING`, echoing its token byte for byte (LIVE-1). A token is
 * whatever the Ircd sent, in any encoding, so this never goes through text.
 * @param token - The `PING`'s first parameter, from `pingToken`, if it had one.
 * @returns The safe Line, or why it can't be built, such as a token too long to fit.
 */
export const pong = (token: Uint8Array | undefined): Outbound => {
  if (token === undefined) {
    return safeLine(encoder.encode("PONG"));
  }

  if (token.some((byte) => forbiddenBytes.has(byte))) {
    return rejected("InvalidParameter");
  }

  const isTrailing = token.length === 0 || token.includes(space) || token[0] === colon;

  return safeLine(concatenate(encoder.encode(isTrailing ? "PONG :" : "PONG "), token));
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
export const encodeLine = (line: OutboundLine) => concatenate(line.bytes, lineEnding);
