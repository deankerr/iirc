import { NetworkSettings } from "@iirc/api";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { decodeStoredChange, encodeChange, networkOf } from "./change.ts";
import type { Change } from "./change.ts";
import { foldConfiguration, noConfiguration } from "./configuration.ts";

const decoded = (json: Schema.Json) => {
  const result = decodeStoredChange(json);

  if (Result.isFailure(result)) {
    throw new Error(result.failure.message);
  }

  return result.success;
};

const refusal = (json: Schema.Json) => {
  const result = decodeStoredChange(json);

  return Result.isFailure(result) ? result.failure.message : undefined;
};

const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

// Read as the Log hands them over, numbered from 1.
const folded = (changes: readonly Schema.Json[]) =>
  foldConfiguration(
    noConfiguration,
    changes.map((json, index) => ({ at: 1000 + index, change: decoded(json), sequence: index + 1 }))
  );

const channel = (name: string) => ({ autojoin: true, name, rejoinOnKick: false });

const minimal = { id: "libera", identity: { nick: "iirc" }, ircds: [{ host: "irc.libera.chat" }] };

const allDefaults = {
  channels: [],
  connectCommands: [],
  credentials: {},
  enabled: true,
  id: "libera",
  identity: { alternates: [], nick: "iirc", realname: "iirc", username: "iirc" },
  ircds: [{ host: "irc.libera.chat", port: 6697, tls: true }],
  name: "libera",
  quitReason: "iirc",
  services: ["NickServ", "ChanServ", "MemoServ", "OperServ", "BotServ", "HostServ", "HelpServ"],
  tuning: {},
};

// Every kind of Change, as the Daemon at the end of milestone 1 wrote it to the Log. These are history now, and must read the same for as long as the Log keeps them.
const milestoneOne: readonly Schema.Json[] = [
  {
    _tag: "NetworkAdded",
    settings: {
      channels: [
        { autojoin: true, name: "#iirc", rejoinOnKick: false },
        { autojoin: false, key: "key.libera.secret", name: "#Secret", rejoinOnKick: true },
      ],
      connectCommands: ["PRIVMSG Q :AUTH iirc {{libera.q}}"],
      credentials: {
        clientCertificate: "libera.cert",
        password: "libera.pass",
        service: { account: "iirc", nick: "NickServ", password: "libera.nickserv" },
      },
      enabled: true,
      id: "libera",
      identity: {
        alternates: ["iirc_", "iirc__"],
        nick: "iirc",
        realname: "iirc bot",
        username: "iirc",
      },
      ircds: [
        {
          host: "irc.libera.chat",
          pin: "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          port: 6697,
          tls: true,
        },
        { host: "irc.eu.libera.chat", port: 6697, tls: true },
      ],
      name: "Libera Chat",
      quitReason: "back soon",
      services: ["NickServ", "ChanServ", "Q"],
      tuning: { floodBurst: 2, lagCheckMillis: 1000, silenceMillis: 5000 },
    },
  },
  {
    _tag: "NetworkAdded",
    settings: {
      channels: [],
      connectCommands: [],
      credentials: {},
      enabled: false,
      id: "oftc",
      identity: { alternates: [], nick: "iirc", realname: "iirc", username: "iirc" },
      ircds: [{ host: "irc.oftc.net", port: 6667, tls: false }],
      name: "oftc",
      quitReason: "iirc",
      services: ["NickServ", "ChanServ", "MemoServ", "OperServ", "BotServ", "HostServ", "HelpServ"],
      tuning: {},
    },
  },
  {
    _tag: "NetworkChanged",
    settings: {
      channels: [{ autojoin: true, name: "#iirc", rejoinOnKick: false }],
      connectCommands: [],
      credentials: {},
      enabled: true,
      id: "oftc",
      identity: { alternates: [], nick: "iirc", realname: "iirc", username: "iirc" },
      ircds: [{ host: "irc.oftc.net", port: 6697, tls: true }],
      name: "OFTC",
      quitReason: "iirc",
      services: ["NickServ", "ChanServ", "MemoServ", "OperServ", "BotServ", "HostServ", "HelpServ"],
      tuning: { quitWaitMillis: 10_000, reconnectInitialMillis: 1000, reconnectMaxMillis: 1000 },
    },
  },
  { _tag: "NetworkDisconnected", id: "oftc" },
  { _tag: "NetworkConnected", id: "oftc" },
  { _tag: "ChannelJoined", channel: { name: "#new", rejoinOnKick: true }, network: "libera" },
  {
    _tag: "ChannelJoined",
    channel: { key: "key.0123456789abcdef", name: "#keyed" },
    network: "libera",
  },
  { _tag: "ChannelKeyNamed", channel: "#keyed", key: "key.fedcba9876543210", network: "libera" },
  { _tag: "ChannelParted", channel: "#new", network: "libera" },
  { _tag: "CredentialSet", name: "libera.pass" },
  { _tag: "CredentialDeleted", name: "libera.cert" },
  {
    _tag: "KeyCreated",
    hash: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
    name: "phone",
    scope: "chat",
  },
  {
    _tag: "KeyRevoked",
    hash: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
    name: "phone",
    scope: "chat",
  },
  { _tag: "EntryRedacted", sequence: 42 },
  { _tag: "NetworkRemoved", id: "libera" },
  {
    _tag: "ConfigurationReplaced",
    networks: [
      {
        channels: [{ autojoin: true, name: "#iirc", rejoinOnKick: false }],
        connectCommands: [],
        credentials: {},
        enabled: true,
        id: "oftc",
        identity: { alternates: [], nick: "iirc", realname: "iirc", username: "iirc" },
        ircds: [{ host: "irc.oftc.net", port: 6697, tls: true }],
        name: "OFTC",
        quitReason: "iirc",
        services: [
          "NickServ",
          "ChanServ",
          "MemoServ",
          "OperServ",
          "BotServ",
          "HostServ",
          "HelpServ",
        ],
        tuning: {},
      },
      {
        channels: [],
        connectCommands: [],
        credentials: { service: { nick: "NickServ", password: "rizon.nickserv" } },
        enabled: true,
        id: "rizon",
        identity: { alternates: [], nick: "iirc", realname: "iirc", username: "iirc" },
        ircds: [{ host: "irc.rizon.net", port: 6697, tls: true }],
        name: "rizon",
        quitReason: "iirc",
        services: ["NickServ"],
        tuning: { drainMillis: 0 },
      },
    ],
  },
];

describe("a Change, as the Log stores it (LOG-2)", () => {
  it("CONF-3: fills in what a Change from before a setting existed meant", () => {
    expect(decoded({ _tag: "NetworkAdded", settings: minimal })).toStrictEqual({
      _tag: "NetworkAdded",
      settings: allDefaults,
    });
  });

  it("CONF-1: reads every Change milestone 1 wrote, and writes it back the same", () => {
    for (const json of milestoneOne) {
      const change = decoded(parseJson(JSON.stringify(json)));

      expect(encodeChange(change)).toStrictEqual(json);
    }
  });

  it("CONF-1: folds milestone 1's Changes to the Configuration they made then", () => {
    const replaced = decoded(milestoneOne.at(-1) ?? null);
    const [oftc, rizon] = replaced._tag === "ConfigurationReplaced" ? replaced.networks : [];

    expect(folded(milestoneOne)).toStrictEqual({
      credentials: new Map([
        ["libera.pass", { sequence: 10, set: true }],
        ["libera.cert", { sequence: 11, set: false }],
      ]),
      keys: new Map(),
      networks: new Map([
        ["oftc", { retrySince: 16, settings: oftc, wantedSince: new Map([["#iirc", 3]]) }],
        ["rizon", { retrySince: 16, settings: rizon, wantedSince: new Map() }],
      ]),
    });
  });

  it("reads back exactly what it wrote", () => {
    const changes: readonly Change[] = [
      ...milestoneOne.map(decoded),
      { _tag: "ChannelJoined", channel: { name: "#iirc", rejoinOnKick: true }, network: "libera" },
      { _tag: "ConfigurationReplaced", networks: [] },
    ];

    // Through the text the Log stores, so that nothing JSON cannot hold slips through.
    for (const change of changes) {
      const stored = JSON.stringify(encodeChange(change));

      expect(decoded(parseJson(stored))).toStrictEqual(change);
    }
  });

  // Each of these breaks a rule the API holds a request to today. Were one of them a rule
  // made after the Change was recorded, refusing it would keep the Daemon from starting on
  // a Log it had accepted, however long ago that Change was replaced.
  it.each([
    [
      "a pin that is not one",
      { ircds: [{ host: "h", pin: "sha256/x" }] },
      { ircds: [{ host: "h", pin: "sha256/x", port: 6697, tls: true }] },
    ],
    [
      "one Channel twice",
      { channels: [{ name: "#iirc" }, { name: "#IIRC" }] },
      { channels: [channel("#iirc"), channel("#IIRC")] },
    ],
    [
      "a Channel name with no prefix",
      { channels: [{ name: "iirc" }] },
      { channels: [channel("iirc")] },
    ],
    [
      "a Tuning number out of bounds",
      { tuning: { quitWaitMillis: 60_000 } },
      { tuning: { quitWaitMillis: 60_000 } },
    ],
    [
      "Tuning numbers that clash",
      { tuning: { silenceMillis: 1000 } },
      { tuning: { silenceMillis: 1000 } },
    ],
    [
      "an ID CONF-3 does not allow",
      { id: "Libera Chat" },
      { id: "Libera Chat", name: "Libera Chat" },
    ],
    [
      "a Credential named as none can be",
      { credentials: { password: "A Pass" } },
      { credentials: { password: "A Pass" } },
    ],
    [
      "a client certificate on an Ircd without TLS",
      { credentials: { clientCertificate: "c" }, ircds: [{ host: "h", tls: false }] },
      { credentials: { clientCertificate: "c" }, ircds: [{ host: "h", port: 6697, tls: false }] },
    ],
  ])("CONF-1: reads and folds a Network with %s, as it was recorded", (_name, given, meant) => {
    const settings = { ...allDefaults, ...meant };
    const configuration = folded([{ _tag: "NetworkAdded", settings: { ...minimal, ...given } }]);

    expect(configuration.networks.get(settings.id)?.settings).toStrictEqual(settings);
  });

  it("CONF-1: still folds a Change that a rule tightened since it was recorded refuses", () => {
    const request = { ...minimal, tuning: { quitWaitMillis: 5000 } };
    const accepted = Schema.decodeUnknownSync(NetworkSettings)(request);

    // Tomorrow's rule, as a later iirc might make it.
    const tightened = NetworkSettings.check(
      Schema.makeFilter(
        ({ tuning }) =>
          (tuning.quitWaitMillis ?? 0) <= 1000 || {
            issue: "too long",
            path: ["tuning", "quitWaitMillis"],
          }
      )
    );

    expect(Result.isFailure(Schema.decodeUnknownResult(tightened)(request))).toBeTruthy();

    const stored = encodeChange({ _tag: "NetworkAdded", settings: accepted });

    expect(folded([stored]).networks.get("libera")?.settings).toStrictEqual(accepted);
  });

  it("drops a Tuning number that is no longer one, since nothing runs it", () => {
    expect(
      decoded({
        _tag: "NetworkAdded",
        settings: { ...minimal, tuning: { floodBurst: 2, retiredMillis: 5 } },
      })
    ).toStrictEqual({
      _tag: "NetworkAdded",
      settings: { ...allDefaults, tuning: { floodBurst: 2 } },
    });
  });

  it("lets the later of two Networks of one ID stand in a replacement", () => {
    const configuration = folded([
      { _tag: "ConfigurationReplaced", networks: [minimal, { ...minimal, name: "Later" }] },
    ]);

    expect(configuration.networks.get("libera")?.settings.name).toBe("Later");
  });

  it.each([
    ["an unknown tag", { _tag: "NetworkRenamed", id: "libera" }],
    ["no tag", { id: "libera" }],
    [
      "settings without Ircds",
      { _tag: "NetworkAdded", settings: { id: "a", identity: { nick: "n" } } },
    ],
    ["no Ircd at all", { _tag: "NetworkAdded", settings: { ...minimal, ircds: [] } }],
    ["an ID that is not text", { _tag: "NetworkRemoved", id: 7 }],
    [
      "Tuning that is not numbers",
      { _tag: "NetworkAdded", settings: { ...minimal, tuning: { floodBurst: "2" } } },
    ],
    [
      "a scope that does not exist",
      { _tag: "KeyCreated", hash: "0f".repeat(32), name: "a", scope: "root" },
    ],
    ["something other than an object", "NetworkAdded"],
  ])("CONF-1: cannot read %s", (_name, json) => {
    expect(refusal(json)).toBeDefined();
  });

  // About 100 ms here once warm. What is left is the Schema's own work for each Channel.
  // The requirement is how much work the event loop is given, so it is the CPU the decode
  // takes that is bounded, and not the wall clock, which stretches on a busy machine
  // without the decode doing any more. CPU time also counts the collector's threads, so
  // here it reads about twice the wall time of a quiet machine, and the bound is set to
  // match: about 160 ms measured, against 400.
  it("HOST-5: decodes a 1 MiB body of Channels in a fraction of a second, on the event loop", () => {
    const channels = Array.from({ length: 66_000 }, (_unused, index) => ({
      name: `#${index.toString(36)}`,
    }));

    const settings = { ...minimal, channels };
    const body = JSON.stringify({ _tag: "NetworkAdded", settings });

    // Warmed once, as a running Daemon is.
    decoded(parseJson(body));

    const started = process.cpuUsage();
    const change = decoded(parseJson(body));
    const { system, user } = process.cpuUsage(started);
    const millis = (system + user) / 1000;

    expect(body.length).toBeGreaterThan(1024 * 1024);
    expect(change._tag === "NetworkAdded" && change.settings.channels).toHaveLength(66_000);
    expect(millis).toBeLessThan(400);
  });

  it("LOG-2: names the Network it concerns, if any", () => {
    expect(networkOf(decoded({ _tag: "NetworkAdded", settings: minimal }))).toBe("libera");
    expect(networkOf({ _tag: "ChannelParted", channel: "#a", network: "oftc" })).toBe("oftc");
    expect(
      networkOf({ _tag: "KeyRevoked", hash: "ab".repeat(32), name: "phone", scope: "chat" })
    ).toBeUndefined();
    expect(networkOf({ _tag: "ConfigurationReplaced", networks: [] })).toBeUndefined();
  });
});
