import { ChannelName, KeyName, KeyScope, NetworkId, NetworkSettings } from "@iirc/api";
import type { NetworkSettings as Settings } from "@iirc/api";
import type { Json } from "@iirc/session/entry";
import { channelKey } from "@iirc/session/standing";
import { Result, Schema } from "effect";

import { TuningOverrides } from "./tuning.ts";

const decodeOverrides = Schema.decodeUnknownResult(TuningOverrides);

// Where a key first repeats one before it, or -1. A Set keeps it linear, because a body
// can list tens of thousands of Channels, and this runs on the event loop (HOST-5).
const firstRepeat = (keys: readonly string[]) => {
  const seen = new Set<string>();

  return keys.findIndex((key) => seen.size === seen.add(key).size);
};

// What the Daemon asks of a Network's settings beyond the published Schema: its own Tuning
// rules, and Channels told apart as the host tells them apart, so that no two are one.
const daemonRules = Schema.makeFilter(({ channels, tuning }: Settings) => {
  const repeated = firstRepeat(channels.map(({ name }) => channelKey(name)));

  return [
    ...Result.match(decodeOverrides(tuning), {
      onFailure: ({ issue }) => [{ issue, path: ["tuning"] }],
      onSuccess: () => [],
    }),
    ...(repeated === -1
      ? []
      : [{ issue: "is the same Channel as another", path: ["channels", repeated, "name"] }]),
  ];
});

/**
 * A Network's settings as the Daemon will run them: the published Schema, the Daemon's
 * Tuning rules, and no Channel listed twice.
 */
export const DaemonSettings = NetworkSettings.check(daemonRules);

const ConfigurationNetworks = Schema.Array(DaemonSettings).check(
  Schema.makeFilter((networks) => {
    const repeated = firstRepeat(networks.map(({ id }) => id));

    return repeated === -1 || { issue: "is another Network's ID", path: [repeated, "id"] };
  })
);

// A SHA-256, in lowercase hex.
const KeyHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

/**
 * What the Owner altered, as a Change Entry stores it (CONF-1, LOG-2). Each Network's
 * settings are whole, so that a Change can be read alone. A key is stored only as its
 * SHA-256 (AUTH-2). This is the Log's format, and the Daemon will not start on a Change it
 * cannot read.
 */
export const Change = Schema.Union([
  Schema.TaggedStruct("NetworkAdded", { settings: DaemonSettings }),
  Schema.TaggedStruct("NetworkChanged", { settings: DaemonSettings }),
  Schema.TaggedStruct("NetworkRemoved", { id: NetworkId }),
  /** Enabled on, and a retry now (LIVE-4). */
  Schema.TaggedStruct("NetworkConnected", { id: NetworkId }),
  /** Enabled off (LIVE-9). */
  Schema.TaggedStruct("NetworkDisconnected", { id: NetworkId }),
  /** Wanted, with autojoin on, as of this Change, which outranks an older kick (LIVE-8). */
  Schema.TaggedStruct("ChannelJoined", {
    channel: Schema.Struct({
      name: ChannelName,
      rejoinOnKick: Schema.optionalKey(Schema.Boolean),
    }),
    network: NetworkId,
  }),
  Schema.TaggedStruct("ChannelParted", { channel: ChannelName, network: NetworkId }),
  /** The whole of Configuration at once, as an import is (CONF-6). */
  Schema.TaggedStruct("ConfigurationReplaced", { networks: ConfigurationNetworks }),
  Schema.TaggedStruct("KeyCreated", { hash: KeyHash, name: KeyName, scope: KeyScope }),
  Schema.TaggedStruct("KeyRevoked", { hash: KeyHash, name: KeyName, scope: KeyScope }),
]);

/** The decoded form of {@link Change}. */
export type Change = typeof Change.Type;

const ChangeJson = Schema.toCodecJson(Change);

/** Writes a Change as the JSON its Entry stores. */
export const encodeChange: (change: Change) => Json = Schema.encodeSync(ChangeJson);

/** Reads a Change from the JSON its Entry stored, or says why it cannot. */
export const decodeChange = Schema.decodeUnknownResult(ChangeJson);

/**
 * The Network a Change concerns, which its Entry carries so that a Network's history
 * can be read alone (LOG-2).
 * @param change - The Change.
 * @returns The Network's ID, or nothing for a Change to the whole Daemon.
 */
export const networkOf = (change: Change): string | undefined => {
  switch (change._tag) {
    case "NetworkAdded":
    case "NetworkChanged": {
      return change.settings.id;
    }

    case "NetworkRemoved":
    case "NetworkConnected":
    case "NetworkDisconnected": {
      return change.id;
    }

    case "ChannelJoined":
    case "ChannelParted": {
      return change.network;
    }

    case "ConfigurationReplaced":
    case "KeyCreated":
    case "KeyRevoked": {
      return undefined;
    }

    default: {
      return change satisfies never;
    }
  }
};
