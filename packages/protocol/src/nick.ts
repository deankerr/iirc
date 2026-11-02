import { channelPrefixes } from "./join.ts";
import { isMiddleParameter, outbound } from "./outbound.ts";
import type { Outbound } from "./outbound.ts";

const encoder = new TextEncoder();

const padding = "_";
const highestNumber = 99;

// `NICKLEN` comes from the Network. Without a bound, one saying 4294967295 would have
// us pad, and record, a candidate for every length up to it.
const longestLimit = 64;

const byteLength = (text: string) => encoder.encode(text).length;

// Ircds count `NICKLEN` in bytes or in characters, and bytes fit under either.
const fit = (text: string, limit: number) => {
  let fitted = "";

  for (const character of text) {
    if (byteLength(fitted + character) > limit) {
      return fitted;
    }

    fitted += character;
  }

  return fitted;
};

// A number replaces the tail and never the whole nick, because no nick starts with a
// digit, so a limit too short for the number leaves nothing to try.
const numbered = (padded: string, limit: number) =>
  Array.from({ length: highestNumber }, (_unused, index) => {
    const number = String(index + 1);
    const stem = fit(padded, limit - number.length);

    return stem === "" ? [] : [`${stem}${number}`];
  }).flat();

const derived = (nick: string, limit: number) => {
  const stem = fit(nick, limit);

  if (stem === "") {
    return [];
  }

  const padded = Array.from(
    { length: limit - byteLength(stem) + 1 },
    (_unused, width) => `${stem}${padding.repeat(width)}`
  );

  return [...padded, ...numbered(padded.at(-1) ?? stem, limit)];
};

/**
 * Works out the fixed, finite list of nicks to try (CONN-4), in order and without
 * repeats: the nick, the alternates, the nick padded with `_`, then its tail
 * overwritten with 1 to 99. A nick over the limit still goes first as configured,
 * because on first contact the limit is a guess, and what follows is cut to fit.
 * Every other candidate is within the limit, so an alternate over it is left out.
 * @param options - The configured nick and alternates, and the limit in bytes.
 * @returns The candidates, in the order to try them.
 */
export const nickCandidates = ({
  alternates,
  limit,
  nick,
}: {
  readonly alternates: readonly string[];
  readonly limit: number;
  readonly nick: string;
}): readonly string[] => {
  const bound = Math.min(limit, longestLimit);

  return [
    ...new Set([
      nick,
      ...alternates.filter((alternate) => byteLength(alternate) <= bound),
      ...derived(nick, bound),
    ]),
  ].filter((candidate) => candidate !== "");
};

// Anywhere in a nick, these mean something else: a space or a comma ends it, `!` and `@`
// split a prefix, and `*` and `?` are masks.
const forbiddenAnywhere = /[\0\r\n ,*?!@]/u;

// Nor can a nick start with what marks something else there: a digit or `-` (RFC 2812),
// a Channel prefix, a membership prefix (`~`, `%`, `@`, `+`, `&`), `$` for a server mask, or
// `:` for the last parameter.
const forbiddenFirst = new RegExp(`^[\\d\\-~%@$:${channelPrefixes.join("")}]`, "u");

/**
 * Whether a nick can be offered at all, by the modern rules that refine RFC 2812's. A nick
 * that starts with a digit is never one, which is also what lets {@link nickCandidates}
 * number a tail. An Ircd may refuse more than this, and says so with `432` (CONN-4).
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
