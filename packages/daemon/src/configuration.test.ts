import type { NetworkSettings } from "@iirc/api";
import { describe, expect, it } from "vitest";

import type { Change } from "./change.ts";
import {
  droppedChannels,
  foldConfiguration,
  noConfiguration,
  reduceConfiguration,
} from "./configuration.ts";
import type { Configuration, RecordedChange } from "./configuration.ts";

const libera: NetworkSettings = {
  channels: [
    { autojoin: true, name: "#iirc", rejoinOnKick: false },
    { autojoin: false, name: "#quiet", rejoinOnKick: false },
  ],
  enabled: true,
  id: "libera",
  identity: { alternates: [], nick: "iirc", realname: "iirc", username: "iirc" },
  ircds: [{ host: "irc.libera.chat", port: 6697, tls: true }],
  name: "Libera",
  quitReason: "iirc",
  tuning: {},
};

const oftc: NetworkSettings = { ...libera, channels: [], id: "oftc", name: "OFTC" };

// Changes as the Log would number them, from 1, each recorded a second after the last.
const recorded = (...changes: readonly Change[]): readonly RecordedChange[] =>
  changes.map((change, index) => ({ at: 1000 * (index + 1), change, sequence: index + 1 }));

const fold = (...changes: readonly Change[]) =>
  foldConfiguration(noConfiguration, recorded(...changes));

const networkIn = (configuration: Configuration, id = "libera") => {
  const network = configuration.networks.get(id);

  if (network === undefined) {
    throw new Error(`${id} is not configured`);
  }

  return network;
};

const added = (settings: NetworkSettings = libera): Change => ({ _tag: "NetworkAdded", settings });

const changed = (settings: NetworkSettings): Change => ({ _tag: "NetworkChanged", settings });

const joined = (name: string, rejoinOnKick?: boolean): Change => ({
  _tag: "ChannelJoined",
  channel: { name, ...(rejoinOnKick !== undefined && { rejoinOnKick }) },
  network: "libera",
});

describe("the Configuration fold", () => {
  it("CONF-1: starts with no Networks and no keys", () => {
    expect(fold()).toStrictEqual(noConfiguration);
  });

  it("CONF-3: adds a Network as given, and LIVE-4: asks for a retry with it", () => {
    const network = networkIn(fold(added()));

    expect(network.settings).toStrictEqual(libera);
    expect(network.retrySince).toBe(1);
  });

  it("LIVE-8: wants each Channel with autojoin on as of the Change that added it", () => {
    expect(networkIn(fold(added())).wantedSince).toStrictEqual(new Map([["#iirc", 1]]));
  });

  it.each([
    ["Ircds", { ircds: [{ host: "irc.eu.libera.chat", port: 6697, tls: true }] }],
    ["Identity", { identity: { ...libera.identity, nick: "other" } }],
    ["Tuning", { tuning: { reconnectInitialMillis: 1000 } }],
  ] as const)("CONF-2: a change to its %s retries at once", (_name, change) => {
    expect(networkIn(fold(added(), changed({ ...libera, ...change }))).retrySince).toBe(2);
  });

  it.each([
    ["display name", { name: "Libera.Chat" }],
    ["QUIT reason", { quitReason: "bye" }],
    ["enabled flag", { enabled: false }],
    ["Channels", { channels: [] }],
  ] as const)("CONF-2: a change to its %s applies without a retry", (_name, change) => {
    const network = networkIn(fold(added(), changed({ ...libera, ...change })));

    expect(network.retrySince).toBe(1);
    expect(network.settings).toStrictEqual({ ...libera, ...change });
  });

  it("CONF-2: Tuning is compared by value, whatever order its overrides came in", () => {
    const tuned = { ...libera, tuning: { floodBurst: 2, laneLimit: 10 } };
    const reordered = { ...libera, tuning: { floodBurst: 2, laneLimit: 10 } };

    expect(networkIn(fold(added(tuned), changed(reordered))).retrySince).toBe(1);
  });

  it("keeps the very same Network for settings that did not change, so no host wakes", () => {
    const before = fold(added());

    const after = reduceConfiguration(before, {
      at: 5,
      change: changed({ ...libera }),
      sequence: 2,
    });

    expect(networkIn(after)).toBe(networkIn(before));
  });

  it("LIVE-8: a Channel keeps the Change that wanted it while it stays wanted", () => {
    const more = {
      ...libera,
      channels: [...libera.channels, { autojoin: true, name: "#new", rejoinOnKick: false }],
    };

    expect(networkIn(fold(added(), changed(more))).wantedSince).toStrictEqual(
      new Map([
        ["#iirc", 1],
        ["#new", 2],
      ])
    );
  });

  it("LIVE-8: a Channel whose autojoin turns on is wanted from that Change", () => {
    const loud = {
      ...libera,
      channels: libera.channels.map((channel) => ({ ...channel, autojoin: true })),
    };

    expect(networkIn(fold(added(), changed(loud))).wantedSince.get("#quiet")).toBe(2);
  });

  it("removes a Network, and a Change to one that is not there changes nothing", () => {
    const configuration = fold(added(), { _tag: "NetworkRemoved", id: "libera" });

    expect(configuration.networks.size).toBe(0);
    expect(
      reduceConfiguration(configuration, {
        at: 1,
        change: { _tag: "NetworkConnected", id: "libera" },
        sequence: 3,
      })
    ).toBe(configuration);
  });

  it("LIVE-4: connect enables and retries, and disconnect only disables", () => {
    const disconnected = fold(added(), { _tag: "NetworkDisconnected", id: "libera" });

    const connected = reduceConfiguration(disconnected, {
      at: 1,
      change: { _tag: "NetworkConnected", id: "libera" },
      sequence: 3,
    });

    expect(networkIn(disconnected).settings.enabled).toBeFalsy();
    expect(networkIn(disconnected).retrySince).toBe(1);
    expect(networkIn(connected).settings.enabled).toBeTruthy();
    expect(networkIn(connected).retrySince).toBe(3);
  });

  describe("Join and Part (CONF-5)", () => {
    it("adds a Channel with autojoin on, wanted as of the Join", () => {
      const network = networkIn(fold(added(), joined("#new")));

      expect(network.settings.channels.at(-1)).toStrictEqual({
        autojoin: true,
        name: "#new",
        rejoinOnKick: false,
      });
      expect(network.wantedSince.get("#new")).toBe(2);
    });

    it("LIVE-8: wants a Channel already wanted as of the Join, which clears an older kick", () => {
      const network = networkIn(fold(added(), joined("#IIRC")));

      expect(network.settings.channels).toHaveLength(2);
      expect(network.settings.channels[0]?.name).toBe("#IIRC");
      expect(network.wantedSince.get("#iirc")).toBe(2);
    });

    it("turns autojoin on for a Channel listed without it, keeping rejoin-on-kick", () => {
      const listed = {
        ...libera,
        channels: [{ autojoin: false, name: "#quiet", rejoinOnKick: true }],
      };

      const network = networkIn(fold(added(listed), joined("#quiet")));

      expect(network.settings.channels).toStrictEqual([
        { autojoin: true, name: "#quiet", rejoinOnKick: true },
      ]);
      expect(network.wantedSince.get("#quiet")).toBe(2);
    });

    it("takes rejoin-on-kick when a Join gives it", () => {
      const network = networkIn(fold(added(), joined("#iirc", true)));

      expect(network.settings.channels[0]?.rejoinOnKick).toBeTruthy();
    });

    it("removes a Channel however it is spelt, and wants it no more", () => {
      const network = networkIn(
        fold(added(), { _tag: "ChannelParted", channel: "#IIRC", network: "libera" })
      );

      expect(network.settings.channels.map(({ name }) => name)).toStrictEqual(["#quiet"]);
      expect(network.wantedSince.size).toBe(0);
    });

    it("leaves a Network that is not there alone", () => {
      const configuration = fold(added());

      expect(
        reduceConfiguration(configuration, {
          at: 1,
          change: { _tag: "ChannelJoined", channel: { name: "#x" }, network: "oftc" },
          sequence: 2,
        })
      ).toBe(configuration);
    });
  });

  describe("replacing it all (CONF-6)", () => {
    it("adds, keeps, and removes Networks as the whole replacement says", () => {
      const configuration = fold(added(), added(oftc), {
        _tag: "ConfigurationReplaced",
        networks: [
          { ...oftc, name: "Renamed" },
          { ...libera, id: "efnet", name: "EFnet" },
        ],
      });

      expect([...configuration.networks.keys()].toSorted()).toStrictEqual(["efnet", "oftc"]);
      expect(networkIn(configuration, "oftc").settings.name).toBe("Renamed");
      expect(networkIn(configuration, "oftc").retrySince).toBe(2);
      expect(networkIn(configuration, "efnet").retrySince).toBe(3);
    });

    it("keeps the very same Network where nothing changed", () => {
      const before = fold(added(), added(oftc));

      const after = reduceConfiguration(before, {
        at: 1,
        change: { _tag: "ConfigurationReplaced", networks: [libera, { ...oftc, quitReason: "x" }] },
        sequence: 3,
      });

      expect(networkIn(after)).toBe(networkIn(before));
      expect(networkIn(after, "oftc")).not.toBe(networkIn(before, "oftc"));
    });

    it("CONF-2: retries a Network whose Ircds it changes", () => {
      const moved: NetworkSettings = {
        ...libera,
        ircds: [{ host: "irc.eu.libera.chat", port: 6697, tls: true }],
      };

      expect(
        networkIn(fold(added(), { _tag: "ConfigurationReplaced", networks: [moved] })).retrySince
      ).toBe(2);
    });
  });

  describe("keys (AUTH-2)", () => {
    const created: Change = {
      _tag: "KeyCreated",
      hash: "ab".repeat(32),
      name: "phone",
      scope: "chat",
    };

    it("holds each key's scope, hash, and when it was created, and never touches Networks", () => {
      const before = fold(added());
      const after = reduceConfiguration(before, { at: 1234, change: created, sequence: 2 });

      expect(after.keys).toStrictEqual(
        new Map([["phone", { created: 1234, hash: "ab".repeat(32), scope: "chat" }]])
      );
      expect(after.networks).toBe(before.networks);
    });

    it("forgets a revoked key", () => {
      expect(
        fold(created, { _tag: "KeyRevoked", hash: created.hash, name: "phone", scope: "chat" }).keys
          .size
      ).toBe(0);
    });
  });

  it("LOG-10: folds the same Changes to the same Configuration every time", () => {
    const changes: readonly Change[] = [
      added(),
      added(oftc),
      { _tag: "ChannelJoined", channel: { name: "#more" }, network: "oftc" },
      { _tag: "NetworkDisconnected", id: "libera" },
      { _tag: "KeyCreated", hash: "cd".repeat(32), name: "owner", scope: "admin" },
    ];

    expect(fold(...changes)).toStrictEqual(fold(...changes));
    expect(
      foldConfiguration(fold(...changes.slice(0, 2)), recorded(...changes).slice(2))
    ).toStrictEqual(fold(...changes));
  });
});

describe(droppedChannels, () => {
  it("CONF-2: names the Channels a Change took off each Network still configured", () => {
    const before = fold(added(), added({ ...oftc, channels: libera.channels }));

    const after = fold(
      added({ ...libera, channels: [] }),
      added({ ...oftc, channels: [{ autojoin: true, name: "#IIRC", rejoinOnKick: false }] })
    );

    expect(droppedChannels(before, after)).toStrictEqual([
      { channels: ["#iirc", "#quiet"], id: "libera" },
      { channels: ["#quiet"], id: "oftc" },
    ]);
  });

  it("names nothing for a Network that is gone, which leaves with a `QUIT` instead", () => {
    expect(droppedChannels(fold(added()), noConfiguration)).toStrictEqual([]);
  });
});
