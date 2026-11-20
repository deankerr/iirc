/**
 * `invite-notify`, end to end: a real Daemon on a private Ergo, driven only through its HTTP
 * API, with raw IRC connections as the other Users. Ergo tells a Channel's operators when a
 * member invites someone, so Self joins first and holds the Channel, and another User's
 * invitation shows in its Timeline as `UserInvited`.
 */
import { NetworkId } from "@iirc/api";
import type { Knowledge, Timeline, TimelineItem } from "@iirc/api";
import { configured } from "@iirc/client/testing";
import { Effect } from "effect";
import type { Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startErgo } from "../testing/ircd.ts";
import type { Ircd } from "../testing/ircd.ts";
import { connectPeer } from "../testing/peer.ts";
import { eventually, startDaemon } from "../testing/running.ts";
import type { Api } from "../testing/running.ts";
import { makeKey, temporaryDirectory } from "../testing/world.ts";

const network = NetworkId.make("private");

const run = async <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(test));

const timelineOf = (api: Api, name: string) =>
  Effect.gen(function* () {
    const listed = yield* api.timelines.list({ params: { network }, query: {} });
    const found: Timeline | undefined = listed.timelines.find((one) => one.name === name);

    if (found === undefined) {
      return yield* Effect.die(`${name}'s Timeline was not listed`);
    }

    return found;
  });

const itemsOf = (api: Api, timeline: Timeline) =>
  Effect.map(
    api.timelines.window({ params: { timeline: timeline.id }, query: {} }),
    ({ items }) => items
  );

const joined = (channel: string) => (state: Knowledge) =>
  state.channels.some((one) => one.name === channel && one.standing === "Joined");

const membersOf = (state: Knowledge, channel: string): readonly string[] =>
  state.channels.find((one) => one.name === channel)?.members.map((one) => one.nick) ?? [];

const said = (text: string) => (items: readonly TimelineItem[]) =>
  items.some((item) => item.content._tag === "Message" && item.content.text === text);

describe("ergo, invite-notify", () => {
  let ergo: Ircd;

  beforeAll(async () => {
    ergo = await startErgo();
  }, 120_000);

  afterAll(async () => {
    await ergo.stop();
  });

  it("shows another User's invitation as Activity in the Channel's Timeline", async () => {
    const channel = "#iirc-invite";

    const activity = await run(
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

        yield* eventually(api.networks.known({ params: { network } }), joined(channel));

        const pal = yield* Effect.promise(
          async () =>
            await connectPeer({ host: ergo.host, nick: "palinviter", port: ergo.plainPort })
        );

        const guest = yield* Effect.promise(
          async () => await connectPeer({ host: ergo.host, nick: "palguest", port: ergo.plainPort })
        );

        pal.send(`JOIN ${channel}`);
        yield* eventually(api.networks.known({ params: { network } }), (state) =>
          membersOf(state, channel).includes("palinviter")
        );

        pal.send(`INVITE palguest ${channel}`);
        // A Message after the invitation, so the window holds everything that came before it.
        pal.send(`PRIVMSG ${channel} :after the invitation`);

        const timeline = yield* timelineOf(api, channel);
        const items = yield* eventually(itemsOf(api, timeline), said("after the invitation"));

        pal.close();
        guest.close();
        yield* daemon.stop;

        return items.flatMap((item) =>
          item.content._tag === "Activity" && item.content.activity._tag === "UserInvited"
            ? [item.content.activity]
            : []
        );
      })
    );

    expect(activity).toStrictEqual([
      { _tag: "UserInvited", by: "palinviter", channel, nick: "palguest" },
    ]);
  }, 120_000);
});
