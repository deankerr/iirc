import { channelPrefixes } from "./join.ts";
import { isMiddleParameter, outbound } from "./outbound.ts";
import type { Outbound } from "./outbound.ts";

// Anywhere in a nick, these mean something else: a space or a comma ends it, `!` and `@`
// split a prefix, and `*` and `?` are masks.
const forbiddenAnywhere = /[\0\r\n ,*?!@]/u;

// Nor can a nick start with what marks something else there: a digit or `-` (RFC 2812),
// a Channel prefix, a membership prefix (`~`, `%`, `@`, `+`, `&`), `$` for a server mask, or
// `:` for the last parameter.
const forbiddenFirst = new RegExp(`^[\\d\\-~%@$:${channelPrefixes.join("")}]`, "u");

/**
 * Whether a nick can be offered at all, by the modern rules that refine RFC 2812's. An
 * Ircd may refuse more than this, and says so with `432` (CONN-4).
 * @param nick - The nick.
 * @returns Whether it is one.
 */
export const isNick = (nick: string): boolean =>
  isMiddleParameter(nick) && !forbiddenAnywhere.test(nick) && !forbiddenFirst.test(nick);

/**
 * Builds a `NICK`, which only a nick can go in.
 * @param nick - The nick to ask for.
 * @returns The safe Line, or why it can't be built.
 */
export const nickLine = (nick: string): Outbound =>
  isNick(nick) ? outbound("NICK", [nick]) : { _tag: "Rejected", reason: "InvalidParameter" };

// How many `_` the last candidates add to the nick. Enough to step past a nick held by
// an IRC client of our own, or a ghost, and few enough that a Network that refuses them
// all is soon left to the reconnect backoff (CONN-4).
const paddings = 3;

/**
 * Works out the fixed, finite list of nicks to try (CONN-4), in order and without
 * repeats: the nick, the alternates, then the nick with one, two, and three `_`. Each
 * goes as configured, and an Ircd that cannot take one says so, which moves to the next.
 * One no `NICK` could carry, such as a long nick with `_` past the Line limit, is left
 * out, because a Line that never leaves gets no answer to move on from.
 * @param options - The configured nick and alternates.
 * @returns The candidates, in the order to try them.
 */
export const nickCandidates = ({
  alternates,
  nick,
}: {
  readonly alternates: readonly string[];
  readonly nick: string;
}): readonly string[] =>
  [
    ...new Set([
      nick,
      ...alternates,
      // An empty nick is no nick, and `_` alone would be one.
      ...Array.from(
        { length: nick === "" ? 0 : paddings },
        (_unused, index) => `${nick}${"_".repeat(index + 1)}`
      ),
    ]),
  ].filter((candidate) => nickLine(candidate)._tag === "Safe");
