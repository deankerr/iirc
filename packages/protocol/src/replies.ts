import { upperCaseAscii } from "./line.ts";
import type { Line } from "./line.ts";

/** The three standard replies, which differ in how serious they are. */
export type ReplyKind = "FAIL" | "WARN" | "NOTE";

/**
 * A standard reply: `<kind> <command> <code> [<context>...] <description>`.
 * The description is for a person, and is whatever the Ircd sent.
 */
export interface StandardReply {
  readonly kind: ReplyKind;
  /** The command it answers, or `*` for none, made upper-case. */
  readonly command: string;
  /** The machine-readable code, made upper-case. Take `command` into account too. */
  readonly code: string;
  /** Extra parameters for a developer, in order. Often none. */
  readonly context: readonly string[];
  readonly description: string;
}

const kinds: ReadonlyMap<string, ReplyKind> = new Map([
  ["FAIL", "FAIL"],
  ["NOTE", "NOTE"],
  ["WARN", "WARN"],
]);

/**
 * Reads a `FAIL`, `WARN`, or `NOTE` Line (PROT-6), whatever was negotiated, without ever
 * throwing. It decides from the Line's shape, never from the words in it.
 * @param line - Any Line.
 * @returns The reply, or `undefined` if the Line is another command or has fewer than
 * three parameters.
 */
export const parseStandardReply = (line: Line): StandardReply | undefined => {
  const kind = kinds.get(line.command);
  const [command, code, ...rest] = line.params;
  const description = rest.pop();

  if (
    kind === undefined ||
    command === undefined ||
    command === "" ||
    code === undefined ||
    code === "" ||
    description === undefined
  ) {
    return undefined;
  }

  return {
    code: upperCaseAscii(code),
    command: upperCaseAscii(command),
    context: rest,
    description,
    kind,
  };
};
