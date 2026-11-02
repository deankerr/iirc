import { createHash } from "node:crypto";

import type { NetworkSettings } from "@iirc/api";
import type { ChannelKey, Secrets } from "@iirc/session/network";
import { channelKey } from "@iirc/session/standing";
import { Redacted } from "effect";

// CRED-4: the hex digits of the hash that a key's name keeps, which is far more than one
// Daemon's Channels need to stay apart, and keeps the name well inside 64 characters.
const nameDigits = 16;

/**
 * The name of the Credential the Daemon keeps a Channel's key under, when the Channel
 * names none yet (CRED-4): `key.` and the first 16 hex digits of the SHA-256 of the
 * Network's ID, a NUL, and the Channel as it is compared. It is the same however the
 * Owner spells the Channel, and on every start.
 * @param network - The Network's ID.
 * @param channel - The Channel, spelled any way.
 * @returns The name.
 */
export const channelKeyName = (network: string, channel: string): string =>
  `key.${createHash("sha256")
    .update(`${network}\0${channelKey(channel)}`)
    .digest("hex")
    .slice(0, nameDigits)}`;

/**
 * The name a configured Channel's key is kept under: the one it names, or else the one
 * the Daemon would give it.
 * @param settings - The Network's settings.
 * @param channel - The Channel, spelled any way.
 * @returns The name.
 */
export const keyNameFor = (settings: NetworkSettings, channel: string): string =>
  settings.channels.find(({ name }) => channelKey(name) === channelKey(channel))?.key ??
  channelKeyName(settings.id, channel);

/** What to keep of a key seen set or taken away on a wanted Channel (CRED-4). */
export type KeyKeeping =
  /**
   * Store `value` under `name`, unless it is held there already, and have `channel`, as
   * Configuration spells it, name it if it named none.
   */
  | {
      readonly _tag: "Store";
      readonly channel: string;
      readonly name: string;
      readonly nameIt: boolean;
      readonly value: Redacted.Redacted | undefined;
    }
  /** Delete what is held under `name`. */
  | { readonly _tag: "Delete"; readonly name: string };

/**
 * Decides what a `+k` or `-k` seen on a Channel asks of the Credentials (CRED-4). Only a
 * wanted Channel's key is kept. A key already held under its name writes nothing, so a
 * Network repeating its own `MODE` costs no writes, and a `-k` deletes only a key the
 * Channel names.
 * @param settings - The Network's settings now.
 * @param seen - The Channel, and the key the `MODE` left it with.
 * @param secrets - Every Credential there is.
 * @returns What to do, or nothing.
 */
export const keepingFor = (
  settings: NetworkSettings,
  { channel, key }: ChannelKey,
  secrets: Secrets
): KeyKeeping | undefined => {
  const wanted = settings.channels.find(
    ({ autojoin, name }) => autojoin && channelKey(name) === channelKey(channel)
  );

  if (wanted === undefined) {
    return undefined;
  }

  const name = wanted.key ?? channelKeyName(settings.id, wanted.name);
  const held = secrets.get(name);

  if (key === undefined) {
    return wanted.key !== undefined && held !== undefined ? { _tag: "Delete", name } : undefined;
  }

  const value =
    held !== undefined && Redacted.value(held) === Redacted.value(key) ? undefined : key;

  const nameIt = wanted.key === undefined;

  return value === undefined && !nameIt
    ? undefined
    : { _tag: "Store", channel: wanted.name, name, nameIt, value };
};
