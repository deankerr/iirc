/**
 * A private Network for an end-to-end run: an Ircd, a real `iirc daemon`, and a Channel the
 * Daemon has joined with another User in it.
 *
 * @packageDocumentation
 */
import { connectPeer, startNgircd } from "@iirc/daemon/testing";
import type { Ircd } from "@iirc/daemon/testing";
import { Schema } from "effect";
import { expect } from "vitest";

import { run, startDaemon } from "../daemon.ts";

/** What the end-to-end run reads of `known`: which Channels the Client has joined. */
const decodeKnown = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      channels: Schema.Array(Schema.Struct({ name: Schema.String, standing: Schema.String })),
    })
  )
);

/**
 * A private ngircd on a loopback port the kernel picks, a real `iirc daemon` with a
 * key, a Network configured through the API to join a Channel there, joined as the Client
 * knows it, and a raw IRC connection as the other User, `peer`, in the Channel.
 * @param command - How to run `iirc`.
 * @param args - More arguments for its Daemon, such as `--web`.
 * @param dataDir - The Daemon's data directory.
 * @param channel - The Channel.
 * @returns Everything, for the test to stop.
 */
export const privateNetwork = async (
  command: readonly string[],
  args: readonly string[],
  dataDir: string,
  channel: string
) => {
  const ngircd: Ircd = await startNgircd();
  const created = await run(command, "key", "create", "browser", "--data-dir", dataDir);
  const key = created.stdout.trim();
  const { base, child } = await startDaemon(command, dataDir, ...args);
  const authorization = { authorization: `Bearer ${key}`, "content-type": "application/json" };

  const api = async (method: string, route: string, body: string | null = null) =>
    await fetch(`${base}/api${route}`, { body, headers: authorization, method });

  const peer = await connectPeer({ host: ngircd.host, nick: "peer", port: ngircd.plainPort });

  peer.send(`JOIN ${channel}`);

  const configured = await api(
    "PUT",
    "/networks/private",
    JSON.stringify({
      channels: [{ name: channel }],
      declined: [],
      enabled: true,
      fallbackEncoding: "windows-1252",
      ircds: [{ host: ngircd.host, port: ngircd.plainPort, tls: false }],
      login: { _tag: "None" },
      nicks: ["iirc"],
      realname: "iirc",
      username: "iirc",
    })
  );

  expect(configured.status).toBe(200);

  // Joined, as the Client knows it, decided from its Knowledge's structure.
  await expect
    .poll(
      async () => {
        const answer = await api("GET", "/networks/private/known");
        const known = decodeKnown(await answer.text());

        return known.channels.some((one) => one.name === channel && one.standing === "Joined");
      },
      { interval: 100, timeout: 20_000 }
    )
    .toBe(true);

  return { api, base, channel, child, key, ngircd, peer };
};
