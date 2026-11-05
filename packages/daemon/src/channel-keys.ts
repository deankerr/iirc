// Not Effect's `Digest`: its SHA-256 runs on `crypto.subtle`, so it is asynchronous, and
// this name is derived in pure decisions such as `keyNameFor`, which would all become
// Effects for a hash. Effect offers no synchronous SHA-256.
import { createHash } from "node:crypto";

import type { NetworkSettings } from "@iirc/api";
import { channelKey } from "@iirc/session/standing";

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
