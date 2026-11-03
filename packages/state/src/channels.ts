import { casefold } from "./isupport.ts";
import type { Casemapping } from "./isupport.ts";

/** A Channel Self is in. */
export interface Channel {
  /** Its name as the Ircd last spelled it, for display (KNOW-3). */
  readonly name: string;
  /** Its key, as the latest `MODE` that showed one left it (KNOW-6). */
  readonly key: string | undefined;
}

/** The Channels Self is in, by casefolded name, oldest first. */
export type Channels = ReadonlyMap<string, Channel>;

// A Network chooses what goes in here, so it is bounded and drops its oldest. A real
// Network stops far short of this many Channels, and past it, only that Network suffers.
const heldChannels = 1024;

/**
 * Self is in a Channel, which counts as the newest, spelled as the Ircd spelled it now.
 * @param channels - The Channels so far.
 * @param casemapping - The mapping in force.
 * @param name - The Channel.
 * @returns The Channels after it.
 */
export const withChannel = (
  channels: Channels,
  casemapping: Casemapping,
  name: string
): Channels => {
  const folded = casefold(casemapping, name);
  const next = new Map(channels);

  // Deleted first, so that a Channel joined again counts as the newest.
  next.delete(folded);
  next.set(folded, { key: channels.get(folded)?.key, name });

  if (next.size > heldChannels) {
    const [oldest] = next.keys();

    next.delete(oldest ?? folded);
  }

  return next;
};

/**
 * Self has left a Channel.
 * @param channels - The Channels so far.
 * @param folded - The Channel's casefolded name.
 * @returns The Channels after it, and the very same map if Self was not in it.
 */
export const withoutChannel = (channels: Channels, folded: string): Channels => {
  if (!channels.has(folded)) {
    return channels;
  }

  const next = new Map(channels);

  next.delete(folded);

  return next;
};

/**
 * A Channel's key moved.
 * @param channels - The Channels so far.
 * @param folded - The Channel's casefolded name.
 * @param key - The key it has now, or `undefined` for none.
 * @returns The Channels after it.
 */
export const withKey = (channels: Channels, folded: string, key: string | undefined): Channels => {
  const channel = channels.get(folded);

  return channel === undefined || channel.key === key
    ? channels
    : new Map(channels).set(folded, { ...channel, key });
};

/**
 * The same Channels, compared under a new mapping. Each keeps its place, and of two that
 * the new mapping makes one, the later stands (KNOW-3).
 * @param channels - The Channels so far.
 * @param casemapping - The mapping in force from now on.
 * @returns The Channels, keyed under it.
 */
export const refolded = (channels: Channels, casemapping: Casemapping): Channels => {
  const next = new Map<string, Channel>();

  for (const channel of channels.values()) {
    const folded = casefold(casemapping, channel.name);

    next.delete(folded);
    next.set(folded, channel);
  }

  return next;
};
