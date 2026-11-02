import type { NetworkSettings } from "@iirc/api";
import { Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { channelKeyName, keepingFor, keyNameFor } from "./channel-keys.ts";

const settings: NetworkSettings = {
  channels: [
    { autojoin: true, name: "#Plain", rejoinOnKick: false },
    { autojoin: true, key: "libera.secret", name: "#named", rejoinOnKick: false },
    { autojoin: false, name: "#idle", rejoinOnKick: false },
  ],
  connectCommands: [],
  credentials: {},
  enabled: true,
  id: "libera",
  identity: { alternates: [], nick: "iirc", realname: "iirc", username: "iirc" },
  ircds: [{ host: "irc.test", port: 6697, tls: true }],
  name: "libera",
  quitReason: "iirc",
  services: [],
  tuning: {},
};

const held = (entries: Readonly<Record<string, string>>) =>
  new Map(Object.entries(entries).map(([name, value]) => [name, Redacted.make(value)]));

const seen = (channel: string, key?: string) => ({
  channel,
  key: key === undefined ? undefined : Redacted.make(key),
});

describe(channelKeyName, () => {
  it("CRED-4: is `key.` and 16 hex digits of the SHA-256 of the ID, a NUL, and the folded Channel", () => {
    expect(channelKeyName("libera", "#Plain")).toBe(
      `key.${new Bun.CryptoHasher("sha256").update("libera\0#plain").digest("hex").slice(0, 16)}`
    );
  });

  it("CRED-4: is the same however the Channel is spelt, and differs by Network", () => {
    expect(channelKeyName("libera", "#PLAIN")).toBe(channelKeyName("libera", "#plain"));
    expect(channelKeyName("oftc", "#plain")).not.toBe(channelKeyName("libera", "#plain"));
  });

  it("CRED-4: prefers the name a Channel already gives its key", () => {
    expect(keyNameFor(settings, "#NAMED")).toBe("libera.secret");
    expect(keyNameFor(settings, "#plain")).toBe(channelKeyName("libera", "#Plain"));
  });
});

describe(keepingFor, () => {
  const derived = channelKeyName("libera", "#Plain");

  it("CRED-4: stores a new key on a wanted Channel under the derived name, and names it", () => {
    expect(keepingFor(settings, seen("#plain", "pizza"), held({}))).toStrictEqual({
      _tag: "Store",
      channel: "#Plain",
      name: derived,
      nameIt: true,
      value: Redacted.make("pizza"),
    });
  });

  it("CRED-4: writes nothing for the key already held under the name the Channel gives it", () => {
    expect(
      keepingFor(settings, seen("#named", "pizza"), held({ "libera.secret": "pizza" }))
    ).toBeUndefined();
  });

  it("CRED-4: replaces a changed key, under the name the Channel gives it", () => {
    expect(
      keepingFor(settings, seen("#named", "calzone"), held({ "libera.secret": "pizza" }))
    ).toMatchObject({ _tag: "Store", name: "libera.secret", nameIt: false });
  });

  it("CRED-4: deletes on `-k` only a key the Channel names and the Daemon holds", () => {
    expect(keepingFor(settings, seen("#named"), held({ "libera.secret": "pizza" }))).toStrictEqual({
      _tag: "Delete",
      name: "libera.secret",
    });
    expect(keepingFor(settings, seen("#named"), held({}))).toBeUndefined();
    expect(keepingFor(settings, seen("#plain"), held({ [derived]: "pizza" }))).toBeUndefined();
  });

  it("CRED-4: keeps nothing for a Channel that is not wanted", () => {
    expect(keepingFor(settings, seen("#idle", "pizza"), held({}))).toBeUndefined();
    expect(keepingFor(settings, seen("#elsewhere", "pizza"), held({}))).toBeUndefined();
  });
});
