/**
 * Banning by account where the Ircd offers none, end to end: a real Daemon on a private
 * Ergo, which sends no `ACCOUNTEXTBAN`, driven only through its HTTP API, with a raw IRC
 * connection logged in to an account as the other User. Knowing the account is not enough:
 * with no way to name it in a ban, nothing is sent and the Channel's bans stay as they were.
 */
import { CallerIntent, NetworkId } from "@iirc/api";
import type { Member } from "@iirc/api";
import { configured } from "@iirc/client/testing";
import { Effect } from "effect";
import type { Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startErgo } from "../testing/ircd.ts";
import type { Ircd } from "../testing/ircd.ts";
import { connectPeer } from "../testing/peer.ts";
import { eventually, startDaemon } from "../testing/running.ts";
import { makeKey, temporaryDirectory } from "../testing/world.ts";

const network = NetworkId.make("private");
const channel = "#iirc-ban";

const run = async <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(test));

const accountOf = (members: readonly Member[], nick: string) => {
  const account = members.find((one) => one.nick === nick)?.account;

  return account?._tag === "Known" ? account.value : account?._tag;
};

describe("ergo, banning by account", () => {
  let ergo: Ircd;

  beforeAll(async () => {
    ergo = await startErgo();
  });

  afterAll(async () => {
    await ergo.stop();
  });

  it("offers no ban by account without ACCOUNTEXTBAN, and sends none for a User whose account is known", async () => {
    const result = await run(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);
        const daemon = yield* startDaemon({ dataDir }, key);
        const { api } = daemon;

        yield* api.networks.configure({
          params: { network },
          payload: configured({
            channels: [{ name: channel }],
            ircds: [{ host: ergo.host, port: ergo.plainPort, tls: false }],
            nicks: ["iirc"],
          }),
          query: {},
        });
        yield* eventually(api.networks.known({ params: { network } }), (known) =>
          known.channels.some((one) => one.name === channel && one.standing === "Joined")
        );

        const pal = yield* Effect.promise(
          async () =>
            await connectPeer({
              caps: ["draft/account-registration"],
              host: ergo.host,
              nick: "pal",
              port: ergo.plainPort,
            })
        );

        yield* Effect.promise(async () => {
          pal.send("REGISTER * * a-password-nobody-reads");
          await pal.waitFor((line) => line.command === "REGISTER", "REGISTER's reply");
        });
        pal.send(`JOIN ${channel}`);

        const listed = yield* api.timelines.list({ params: { network }, query: {} });
        const timeline = listed.timelines.find((one) => one.name === channel)?.id;

        if (timeline === undefined) {
          return yield* Effect.die("the Channel's Timeline was not listed");
        }

        // The Client knows pal's account, so only the Network's offer is missing.
        const members = yield* eventually(
          api.timelines.members({ params: { timeline }, query: {} }),
          (page) => accountOf(page.members, "pal") === "pal"
        );

        const head = yield* api.timelines.channel({ params: { timeline } });

        const banned = yield* api.networks.act({
          params: { network },
          payload: {
            action: { _tag: "BanAccount", channel, nick: "pal" },
            intent: CallerIntent.make("ban"),
          },
        });

        // The Ircd answers a Connection's Lines in order, so a ban sent would be listed.
        const bans = yield* api.networks.look({
          params: { network },
          payload: { lookup: { _tag: "Bans", channel } },
          query: {},
        });

        pal.close();
        yield* daemon.stop;

        return {
          account: accountOf(members.members, "pal"),
          accountBan: head.accountBan,
          banList: head.lists?.bans,
          banned,
          bans: bans._tag === "LookedUp" ? bans.result : bans,
        };
      })
    );

    expect(result).toMatchObject({
      account: "pal",
      accountBan: null,
      banList: "b",
      banned: { _tag: "Refused", reason: { _tag: "Unsendable" } },
      bans: { _tag: "Listed", masks: [] },
    });
  }, 120_000);
});
