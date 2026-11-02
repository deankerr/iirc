import type { KeyScope, NetworkId, NetworkSettings } from "@iirc/api";
import { templateReferences } from "@iirc/protocol/template";
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

/** The last Change to a Credential, which a Network that refers to it will act on. */
interface CredentialChange {
  readonly sequence: number;
  /** Whether that Change set it, rather than deleted it. */
  readonly set: boolean;
}

/** What the Owner wants, and the keys that may ask for more, as of some Change (CONF-1). */
export interface Configuration {
  /**
   * For each Credential name the Log has seen, its last Change (CRED-1). Its value is
   * never here, and whether a value is kept now is for the Credentials service to say.
   */
  readonly credentials: ReadonlyMap<string, CredentialChange>;
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
export const noConfiguration: Configuration = {
  credentials: new Map(),
  keys: new Map(),
  networks: new Map(),
};

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

// Ircds, Identity, Credentials, services, connect commands, and Tuning apply at the next
// Connection, so a change to any of them is worth one now (CONF-2), and so is a Network
// that is new.
const asksForRetry = (before: NetworkSettings | undefined, after: NetworkSettings) =>
  before === undefined ||
  !Equal.equals(before.ircds, after.ircds) ||
  !Equal.equals(before.identity, after.identity) ||
  !Equal.equals(before.credentials, after.credentials) ||
  !Equal.equals(before.connectCommands, after.connectCommands) ||
  !Equal.equals(before.services, after.services) ||
  !Equal.equals(before.tuning, after.tuning);

// The Credentials a Network's Connections use, by name: `PASS`, the service login, the
// client certificate, and those its connect commands refer to (CONF-3).
const connectionCredentials = ({
  connectCommands,
  credentials,
}: NetworkSettings): ReadonlySet<string> =>
  new Set([
    ...(credentials.password === undefined ? [] : [credentials.password]),
    ...(credentials.service === undefined ? [] : [credentials.service.password]),
    ...(credentials.clientCertificate === undefined ? [] : [credentials.clientCertificate]),
    ...connectCommands.flatMap(templateReferences),
  ]);

const holdsKey = ({ channels }: NetworkSettings, name: string) =>
  channels.some(({ key }) => key === name);

// A Credential a Network's Connections use asks for a retry (CRED-1, LIVE-4). A Channel
// key only wakes the host, so that its reconciler builds the next `JOIN` with the key as
// it is now: a Network sets a key itself with `+k`, and would otherwise skip its own
// backoff by setting one each time it closes a Connection.
const credentialChanged = (
  networks: ReadonlyMap<NetworkId, ConfiguredNetwork>,
  name: string,
  sequence: number
) =>
  new Map(
    [...networks].map(([id, network]) => {
      if (connectionCredentials(network.settings).has(name)) {
        return [id, { ...network, retrySince: sequence }] as const;
      }

      return [id, holdsKey(network.settings, name) ? { ...network } : network] as const;
    })
  );

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
  {
    key: credential,
    name,
    rejoinOnKick,
  }: Extract<Change, { readonly _tag: "ChannelJoined" }>["channel"],
  sequence: number
) => {
  const key = channelKey(name);
  const { channels } = network.settings;
  const existing = channels.find((channel) => channelKey(channel.name) === key);
  const keyName = credential ?? existing?.key;

  const channel = {
    autojoin: true,
    ...(keyName !== undefined && { key: keyName }),
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

// Only the key's name changes, so the Channel is as wanted, or as kicked, as it was.
const keyNamed = (network: ConfiguredNetwork, name: string, key: string): ConfiguredNetwork => ({
  ...network,
  settings: {
    ...network.settings,
    channels: network.settings.channels.map((channel) =>
      channelKey(channel.name) === channelKey(name) ? { ...channel, key } : channel
    ),
  },
});

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

    case "ChannelKeyNamed": {
      return updateNetwork(configuration, change.network, (network) =>
        keyNamed(network, change.channel, change.key)
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

    case "CredentialSet":
    case "CredentialDeleted": {
      return {
        ...configuration,
        credentials: new Map(configuration.credentials).set(change.name, {
          sequence,
          set: change._tag === "CredentialSet",
        }),
        networks: credentialChanged(networks, change.name, sequence),
      };
    }

    // The Log's own bytes changed, and Configuration did not (LOG-7).
    case "EntryRedacted": {
      return configuration;
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
