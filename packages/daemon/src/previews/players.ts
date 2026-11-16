import type { PlayerCandidate } from "./read.ts";

/** A player the Owner's list allows: its address, and the size its page gave, if any. */
export type Player = PlayerCandidate;

// Every host YouTube names its player from, all of which play from the privacy-enhanced one.
const YOUTUBE_HOSTS: ReadonlySet<string> = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
]);

const YOUTUBE_PLAYS_FROM = "www.youtube-nocookie.com";

/**
 * The address a link plays from, when it may: an `https` address with no credentials and no
 * port, whose host, once YouTube's is read as `www.youtube-nocookie.com`, is exactly one the
 * list names. Never a suffix, a prefix, or a look-alike: the host the URL parser wrote is
 * compared whole.
 * @param address - What a page named, as an address.
 * @param hosts - The hosts the Owner lists.
 * @returns The address as the URL parser writes it, YouTube's rewritten, or undefined when it
 * may not play.
 */
const playsFrom = (address: string, hosts: readonly string[]): string | undefined => {
  const url = URL.parse(address);

  if (
    url === null ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    return undefined;
  }

  if (YOUTUBE_HOSTS.has(url.hostname)) {
    url.hostname = YOUTUBE_PLAYS_FROM;
  }

  return hosts.includes(url.hostname) ? url.href : undefined;
};

/**
 * The player a page names, from the first of its candidates that is one.
 * @param candidates - What the page names, in the order they are tried.
 * @param hosts - The hosts the Owner lists.
 * @returns The first candidate that may play, its address as it plays from, or undefined
 * when none may.
 */
export const playerOf = (
  candidates: readonly PlayerCandidate[],
  hosts: readonly string[]
): Player | undefined => {
  for (const { link, size } of candidates) {
    const playable = playsFrom(link, hosts);

    if (playable !== undefined) {
      return { link: playable, size };
    }
  }

  return undefined;
};

/**
 * Whether a kept player's address is one the list allows now, by the same rules that chose it.
 * @param link - The address a kept Preview's player has.
 * @param hosts - The hosts the Owner lists now.
 * @returns Whether it may still play.
 */
export const stillListed = (link: string, hosts: readonly string[]): boolean =>
  playsFrom(link, hosts) !== undefined;
