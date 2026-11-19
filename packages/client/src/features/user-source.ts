/**
 * Who a Line came from, when it came from a User, for the Features that learn something
 * of a User from what they said.
 *
 * @packageDocumentation
 */
import { parseSource } from "@iirc/protocol/line";
import type { Line, Source } from "@iirc/protocol/line";
import { IgnoreMask } from "@iirc/protocol/mask";
import { Schema } from "effect";

/**
 * A Line's source, when it is a User's. Only a User's has a user or a host, so the Ircd,
 * and another server, whose names are all nick, are not read as one, and a Line with no
 * source has none.
 * @param line - The Line.
 * @returns The source, or `undefined` when no User sent it.
 */
export const userSource = (line: Line): Source | undefined => {
  const source = line.source === undefined ? undefined : parseSource(line.source);

  return source !== undefined &&
    source.nick !== "" &&
    (source.user !== undefined || source.host !== undefined)
    ? source
    : undefined;
};

/**
 * A User's user and host, as a Line says them apart from a source, when together with a
 * nick they make a mask the protocol accepts: each non-empty, no `!` or `@` in either, and
 * no space, comma, or control character.
 * @param nick - The User's nick.
 * @param user - Their user.
 * @param host - Their host.
 * @returns The user and host, or `undefined` when they are not a mask.
 */
export const maskOf = (
  nick: string,
  user: string,
  host: string
): { readonly user: string; readonly host: string } | undefined =>
  Schema.is(IgnoreMask)(`${nick}!${user}@${host}`) ? { host, user } : undefined;
