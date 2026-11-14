/**
 * Standard replies, by IRCv3: `FAIL`, `WARN`, and `NOTE`, read by structure alone. The
 * command they are about, their code, and their context are what a program reads, and
 * the description is text for people, which nothing is decided from.
 *
 * @packageDocumentation
 */
import type { Line } from "@iirc/protocol/line";

import type { StandardReply } from "./news.ts";

const kinds: ReadonlySet<string> = new Set<StandardReply["kind"]>(["FAIL", "WARN", "NOTE"]);

/**
 * Whether a command is a standard reply's.
 * @param command - The command.
 * @returns Whether it is.
 */
export const isStandardReply = (command: string): command is StandardReply["kind"] =>
  kinds.has(command);

/**
 * A standard reply, read from its Line: `<command> <code> [<context>…] <description>`.
 * @param line - The Line.
 * @returns The reply, or `undefined` for one with fewer than a command, a code, and a
 * description, or a Line that is not one.
 */
export const readReply = (line: Line): StandardReply | undefined => {
  const { command: kind, params } = line;
  const [command, code, ...rest] = params;
  const description = rest.at(-1);

  if (
    !isStandardReply(kind) ||
    command === undefined ||
    code === undefined ||
    description === undefined
  ) {
    return undefined;
  }

  return { code, command, context: rest.slice(0, -1), description, kind };
};
