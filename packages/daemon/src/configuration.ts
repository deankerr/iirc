import type { KeyScope, NetworkId, NetworkSettings } from "@iirc/api";
import { channelKey } from "@iirc/session/standing";
import { Equal } from "effect";

import type { Change } from "./change.ts";

/** One configured Network: what the Owner said, and what the fold derived from when. */
export interface ConfiguredNetwork {
  /** The sequence of the last Change that asked for a retry (LIVE-4, CONF-2). */
  readonly retrySince: number;
  readonly settings: NetworkSettings;
  /**
   * For each Channel wanted, by {@link channelKey}, the sequence of the Change that last
   * wanted it. A kick recorded before it no longer keeps Self out (LIVE-8).
   */
  readonly wantedSince: ReadonlyMap<string, number>;
}

/** An API key as the Daemon holds it, which is never the key itself (AUTH-2). */
export interface Key {
  /** When the Change that created it was recorded, in epoch milliseconds. */
  readonly created: number;
  /** Its SHA-256, in lowercase hex. */
  readonly hash: string;
  readonly scope: KeyScope;
}

/** What the Owner wants, and the keys that may ask for more, as of some Change (CONF-1). */
export interface Configuration {
  readonly keys: ReadonlyMap<string, Key>;
  readonly networks: ReadonlyMap<NetworkId, ConfiguredNetwork>;
}

/** A Change as the Log recorded it. */
export interface RecordedChange {
  readonly at: number;
  readonly change: Change;
  readonly sequence: number;
}

/** Configuration before any Change. */
export const noConfiguration: Configuration = { keys: new Map(), networks: new Map() };

const isWanted = ({ autojoin }: NetworkSettings["channels"][number]) => autojoin;

// A Channel keeps the sequence that first wanted it for as long as it stays wanted, and a
// Channel newly wanted, by being added or by autojoin turning on, takes this one.
const wantedSinceFor = (
  settings: NetworkSettings,
  previous: ConfiguredNetwork | undefined,
  sequence: number
) =>
  new Map(
    settings.channels.filter(isWanted).map(({ name }) => {
      const key = channelKey(name);

      return [key, previous?.wantedSince.get(key) ?? sequence] as const;
    })
  );

// Ircds, Identity, and Tuning apply at the next Connection, so a change to any of them is
// worth one now (CONF-2), and so is a Network that is new.
const asksForRetry = (before: NetworkSettings | undefined, after: NetworkSettings) =>
  before === undefined ||
  !Equal.equals(before.ircds, after.ircds) ||
  !Equal.equals(before.identity, after.identity) ||
  !Equal.equals(before.tuning, after.tuning);

// The same object back for settings that did not change, so that a host watching its own
// Network is not woken by a Change to another.
const withSettings = (
  previous: ConfiguredNetwork | undefined,
  settings: NetworkSettings,
  sequence: number
): ConfiguredNetwork => {
  if (previous !== undefined && Equal.equals(previous.settings, settings)) {
    return previous;
  }

  return {
    retrySince: asksForRetry(previous?.settings, settings)
      ? sequence
      : (previous?.retrySince ?? sequence),
    settings,
    wantedSince: wantedSinceFor(settings, previous, sequence),
  };
};

const setNetwork = (
  networks: ReadonlyMap<NetworkId, ConfiguredNetwork>,
  network: ConfiguredNetwork
) => new Map(networks).set(network.settings.id, network);

// A Change to a Network that is not there changes nothing, because the Daemon never
// records one, and a fold must still be total.
const updateNetwork = (
  configuration: Configuration,
  id: NetworkId,
  update: (network: ConfiguredNetwork) => ConfiguredNetwork
): Configuration => {
  const network = configuration.networks.get(id);

  return network === undefined
    ? configuration
    : { ...configuration, networks: setNetwork(configuration.networks, update(network)) };
};

const withChannels = (
  network: ConfiguredNetwork,
  channels: NetworkSettings["channels"],
  wantedSince: ReadonlyMap<string, number>
): ConfiguredNetwork => ({ ...network, settings: { ...network.settings, channels }, wantedSince });

const joined = (
  network: ConfiguredNetwork,
  { name, rejoinOnKick }: Extract<Change, { readonly _tag: "ChannelJoined" }>["channel"],
  sequence: number
) => {
  const key = channelKey(name);
  const { channels } = network.settings;
  const existing = channels.find((channel) => channelKey(channel.name) === key);

  const channel = {
    autojoin: true,
    name,
    rejoinOnKick: rejoinOnKick ?? existing?.rejoinOnKick ?? false,
  };

  return withChannels(
    network,
    existing === undefined
      ? [...channels, channel]
      : channels.map((held) => (held === existing ? channel : held)),
    new Map(network.wantedSince).set(key, sequence)
  );
};

const parted = (network: ConfiguredNetwork, name: string) => {
  const key = channelKey(name);
  const wantedSince = new Map(network.wantedSince);

  wantedSince.delete(key);

  return withChannels(
    network,
    network.settings.channels.filter((channel) => channelKey(channel.name) !== key),
    wantedSince
  );
};

const replaced = (
  { networks }: Configuration,
  settings: readonly NetworkSettings[],
  sequence: number
) =>
  new Map(
    settings.map((each) => [each.id, withSettings(networks.get(each.id), each, sequence)] as const)
  );

/**
 * Applies one Change to Configuration. It is pure, so a restart folds the same Log to the
 * same Configuration, and a test needs no Effect to check it.
 * @param configuration - Configuration before the Change.
 * @param recorded - The Change, with where and when the Log recorded it.
 * @returns Configuration after it.
 */
export const reduceConfiguration = (
  configuration: Configuration,
  { at, change, sequence }: RecordedChange
): Configuration => {
  const { keys, networks } = configuration;

  switch (change._tag) {
    case "NetworkAdded":
    case "NetworkChanged": {
      const { settings } = change;

      return {
        ...configuration,
        networks: setNetwork(networks, withSettings(networks.get(settings.id), settings, sequence)),
      };
    }

    case "NetworkRemoved": {
      const remaining = new Map(networks);

      remaining.delete(change.id);

      return { ...configuration, networks: remaining };
    }

    case "NetworkConnected": {
      return updateNetwork(configuration, change.id, (network) => ({
        ...network,
        retrySince: sequence,
        settings: { ...network.settings, enabled: true },
      }));
    }

    case "NetworkDisconnected": {
      return updateNetwork(configuration, change.id, (network) => ({
        ...network,
        settings: { ...network.settings, enabled: false },
      }));
    }

    case "ChannelJoined": {
      return updateNetwork(configuration, change.network, (network) =>
        joined(network, change.channel, sequence)
      );
    }

    case "ChannelParted": {
      return updateNetwork(configuration, change.network, (network) =>
        parted(network, change.channel)
      );
    }

    case "ConfigurationReplaced": {
      return { ...configuration, networks: replaced(configuration, change.networks, sequence) };
    }

    case "KeyCreated": {
      const { hash, name, scope } = change;

      return { ...configuration, keys: new Map(keys).set(name, { created: at, hash, scope }) };
    }

    case "KeyRevoked": {
      const remaining = new Map(keys);

      remaining.delete(change.name);

      return { ...configuration, keys: remaining };
    }

    default: {
      return change satisfies never;
    }
  }
};

/**
 * Folds Changes in the order the Log recorded them (CONF-1).
 * @param configuration - Where to start, which is {@link noConfiguration} for a whole Log.
 * @param changes - The Changes, in sequence order.
 * @returns Configuration after the last.
 */
export const foldConfiguration = (
  configuration: Configuration,
  changes: Iterable<RecordedChange>
): Configuration => {
  let folded = configuration;

  for (const recorded of changes) {
    folded = reduceConfiguration(folded, recorded);
  }

  return folded;
};

/**
 * The Channels a Configuration change took off a Network's list, which Self should leave
 * if it is in them (CONF-2).
 * @param before - Configuration before the Change.
 * @param after - Configuration after it.
 * @returns Each Network still configured, with the names of the Channels it lost.
 */
export const droppedChannels = (before: Configuration, after: Configuration) =>
  [...after.networks].flatMap(([id, network]) => {
    const kept = new Set(network.settings.channels.map(({ name }) => channelKey(name)));

    const dropped = (before.networks.get(id)?.settings.channels ?? []).flatMap(({ name }) =>
      kept.has(channelKey(name)) ? [] : [name]
    );

    return dropped.length === 0 ? [] : [{ channels: dropped, id }];
  });
