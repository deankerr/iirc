import type { NetworkSettings } from "@iirc/api";
import { describe, expect, it } from "vitest";

import { channelKeyName, keyNameFor } from "./channel-keys.ts";

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

describe(channelKeyName, () => {
  it("CRED-4: is `key.` and 16 hex digits of the SHA-256 of the ID, a NUL, and the folded Channel", () => {
    expect(channelKeyName("libera", "#Plain")).toBe(
      `key.${new Bun.CryptoHasher("sha256").update("libera\0#plain").digest("hex").slice(0, 16)}`
    );
  });

  // Logs already name kept keys this way, including a running Daemon's, so it must never
  // change.
  it("CRED-4: names the same key it always has", () => {
    // What `printf 'libera\0#plain' | sha256sum | cut -c1-16` says.
    expect(channelKeyName("libera", "#Plain")).toBe("key.9d288b84fca9e37c");
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
