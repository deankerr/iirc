import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { decodeChange, encodeChange, networkOf } from "./change.ts";
import type { Change } from "./change.ts";

const decoded = (json: Schema.Json) => {
  const result = decodeChange(json);

  if (Result.isFailure(result)) {
    throw new Error(result.failure.message);
  }

  return result.success;
};

const refusal = (json: Schema.Json) => {
  const result = decodeChange(json);

  return Result.isFailure(result) ? result.failure.message : undefined;
};

const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const minimal = { id: "libera", identity: { nick: "iirc" }, ircds: [{ host: "irc.libera.chat" }] };

describe("a Change, as the Log stores it (LOG-2)", () => {
  it("CONF-3: fills in every default a Network's settings leave out", () => {
    expect(decoded({ _tag: "NetworkAdded", settings: minimal })).toStrictEqual({
      _tag: "NetworkAdded",
      settings: {
        channels: [],
        connectCommands: [],
        credentials: {},
        enabled: true,
        id: "libera",
        identity: { alternates: [], nick: "iirc", realname: "iirc", username: "iirc" },
        ircds: [{ host: "irc.libera.chat", port: 6697, tls: true }],
        name: "libera",
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
    });
  });

  it("reads back exactly what it wrote", () => {
    const changes: readonly Change[] = [
      decoded({
        _tag: "NetworkChanged",
        settings: { ...minimal, name: "Libera", tuning: { floodBurst: 2 } },
      }),
      decoded({
        _tag: "NetworkAdded",
        settings: {
          ...minimal,
          channels: [{ key: "key.libera.iirc", name: "#iirc" }],
          connectCommands: ["PRIVMSG Q :AUTH iirc {{libera.q}}"],
          credentials: {
            clientCertificate: "libera.cert",
            password: "libera.pass",
            service: { account: "iirc", password: "libera.nickserv" },
          },
          services: ["NickServ", "Q"],
        },
      }),
      { _tag: "ChannelJoined", channel: { name: "#iirc", rejoinOnKick: true }, network: "libera" },
      {
        _tag: "ChannelJoined",
        channel: { key: "key.0123456789abcdef", name: "#keyed" },
        network: "libera",
      },
      { _tag: "ChannelParted", channel: "#iirc", network: "libera" },
      {
        _tag: "ChannelKeyNamed",
        channel: "#keyed",
        key: "key.0123456789abcdef",
        network: "libera",
      },
      { _tag: "CredentialSet", name: "key.0123456789abcdef" },
      { _tag: "CredentialDeleted", name: "key.0123456789abcdef" },
      { _tag: "EntryRedacted", sequence: 42 },
      { _tag: "KeyCreated", hash: "0f".repeat(32), name: "phone", scope: "read" },
      { _tag: "ConfigurationReplaced", networks: [] },
    ];

    // Through the text the Log stores, so that nothing JSON cannot hold slips through.
    for (const change of changes) {
      const stored = JSON.stringify(encodeChange(change));

      expect(decoded(parseJson(stored))).toStrictEqual(change);
    }
  });

  it.each([
    ["an unknown tag", { _tag: "NetworkRenamed", id: "libera" }],
    ["an ID CONF-3 does not allow", { _tag: "NetworkRemoved", id: "Libera Chat" }],
    [
      "a pin that is not one",
      { _tag: "NetworkAdded", settings: { ...minimal, ircds: [{ host: "h", pin: "sha256/x" }] } },
    ],
    [
      "a key stored as anything but its SHA-256",
      { _tag: "KeyCreated", hash: "iirc_secret", name: "a", scope: "read" },
    ],
    [
      "a scope that does not exist",
      { _tag: "KeyCreated", hash: "0f".repeat(32), name: "a", scope: "root" },
    ],
    [
      "a Credential named as no Credential can be",
      { _tag: "NetworkAdded", settings: { ...minimal, credentials: { password: "Libera Pass" } } },
    ],
    [
      "a Channel key that is a value and not a name",
      {
        _tag: "ChannelJoined",
        channel: { key: "two words", name: "#iirc" },
        network: "libera",
      },
    ],
    [
      "a client certificate on an Ircd without TLS",
      {
        _tag: "NetworkAdded",
        settings: {
          ...minimal,
          credentials: { clientCertificate: "libera.cert" },
          ircds: [{ host: "h", tls: false }],
        },
      },
    ],
  ])("CONF-1: will not read %s", (_name, json) => {
    expect(refusal(json)).toBeDefined();
  });

  it("holds a Network's Tuning to the Daemon's rules", () => {
    expect(
      refusal({ _tag: "NetworkAdded", settings: { ...minimal, tuning: { silenceMilis: 5 } } })
    ).toContain("not a Tuning key: silenceMilis");
    expect(
      refusal({ _tag: "NetworkAdded", settings: { ...minimal, tuning: { silenceMillis: 1000 } } })
    ).toContain("silenceMillis must be above lagCheckMillis");
  });

  it("will not list one Channel twice, however it is spelt", () => {
    const twice = { ...minimal, channels: [{ name: "#iirc" }, { name: "#IIRC" }] };

    expect(refusal({ _tag: "NetworkAdded", settings: twice })).toContain("same Channel");
  });

  // About 100 ms here once warm, against seconds while each Channel was compared with
  // every other. What is left is the Schema's own work for each Channel.
  it("HOST-5: decodes a 1 MiB body of Channels in a fraction of a second, on the event loop", () => {
    const channels = Array.from({ length: 66_000 }, (_unused, index) => ({
      name: `#${index.toString(36)}`,
    }));

    const settings = { ...minimal, channels };
    const body = JSON.stringify({ _tag: "NetworkAdded", settings });

    // Warmed once, as a running Daemon is.
    decoded(parseJson(body));

    const started = performance.now();
    const change = decoded(parseJson(body));
    const millis = performance.now() - started;

    expect(body.length).toBeGreaterThan(1024 * 1024);
    expect(change._tag === "NetworkAdded" && change.settings.channels).toHaveLength(66_000);
    expect(millis).toBeLessThan(250);
  });

  it("will not replace Configuration with two Networks of one ID", () => {
    expect(refusal({ _tag: "ConfigurationReplaced", networks: [minimal, minimal] })).toContain(
      "another Network's ID"
    );
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
