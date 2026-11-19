/**
 * Masks and real names kept current, end to end: a real Daemon on a private Ergo, driven
 * only through its HTTP API, with a raw IRC connection as the other User. A member's user
 * and host are known from the Daemon's joining, a changed host arrives as one `HostChanged`
 * with no quit and join, and a real name set by `Setname`, or by the other User, is known.
 */
import { CallerIntent, NetworkId } from "@iirc/api";
import type { Knowledge, Timeline, TimelineItem, UserKnowledge } from "@iirc/api";
import { configured } from "@iirc/client/testing";
import { Effect } from "effect";
import type { Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ergoOperName, ergoOperPassword, ergoOperVhost, startErgo } from "../testing/ircd.ts";
import type { Ircd } from "../testing/ircd.ts";
import { connectPeer } from "../testing/peer.ts";
import { eventually, startDaemon } from "../testing/running.ts";
import type { Api } from "../testing/running.ts";
import { makeKey, temporaryDirectory } from "../testing/world.ts";

const network = NetworkId.make("private");

const run = async <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(test));

// What a Fact holds while it is known, or its tag.
const valueOf = <T>(
  fact:
    | { readonly _tag: "Known"; readonly value: T }
    | { readonly _tag: "Stale" | "Unknown" }
    | undefined
): T | "Absent" | "Stale" | "Unknown" => {
  if (fact === undefined) {
    return "Absent";
  }

  return fact._tag === "Known" ? fact.value : fact._tag;
};

const userNamed = (users: readonly UserKnowledge[], nick: string) =>
  users.find((one) => one.nick === nick);

const maskOf = (users: readonly UserKnowledge[], nick: string) =>
  valueOf(userNamed(users, nick)?.mask);

const hostOf = (users: readonly UserKnowledge[], nick: string) => {
  const mask = userNamed(users, nick)?.mask;

  return mask?._tag === "Known" ? mask.value.host : undefined;
};

const realnameOf = (users: readonly UserKnowledge[], nick: string) =>
  valueOf(userNamed(users, nick)?.realname);

const timelineOf = (api: Api, name: string | null) =>
  Effect.gen(function* () {
    const listed = yield* api.timelines.list({ params: { network }, query: {} });

    const found: Timeline | undefined = listed.timelines.find((one) =>
      name === null ? one.kind === "Network" : one.name === name
    );

    if (found === undefined) {
      return yield* Effect.die(`${name ?? "the Network"}'s Timeline was not listed`);
    }

    return found;
  });

const itemsOf = (api: Api, timeline: Timeline) =>
  Effect.map(
    api.timelines.window({ params: { timeline: timeline.id }, query: {} }),
    ({ items }) => items
  );

// The Activity an item shows, or nothing for a Message.
const activityOf = (item: TimelineItem) =>
  item.content._tag === "Activity" ? item.content.activity : undefined;

const known = (api: Api) => api.networks.known({ params: { network } });

const joined = (channel: string) => (state: Knowledge) =>
  state.channels.some((one) => one.name === channel && one.standing === "Joined");

describe("ergo, masks and real names", () => {
  let ergo: Ircd;

  beforeAll(async () => {
    ergo = await startErgo();
  });

  afterAll(async () => {
    await ergo.stop();
  });

  const start = (channel: string) =>
    Effect.gen(function* () {
      const dataDir = yield* temporaryDirectory;
      const key = yield* makeKey(dataDir);
      const daemon = yield* startDaemon({ dataDir }, key);

      yield* daemon.api.networks.configure({
        params: { network },
        payload: configured({
          channels: [{ name: channel }],
          ircds: [{ host: ergo.host, port: ergo.plainPort, tls: false }],
          nicks: ["iirc"],
        }),
        query: {},
      });

      return daemon;
    });

  it("knows a member's user and host from joining, before they say anything", async () => {
    const channel = "#iirc-mask-join";

    const result = await run(
      Effect.gen(function* () {
        const pal = yield* Effect.promise(
          async () => await connectPeer({ host: ergo.host, nick: "palmask", port: ergo.plainPort })
        );

        pal.send(`JOIN ${channel}`);
        yield* Effect.promise(
          async () =>
            await pal.waitFor(
              (line) => line.command === "JOIN" && line.params[0] === channel,
              "its own JOIN"
            )
        );

        const daemon = yield* start(channel);

        const state = yield* eventually(
          known(daemon.api),
          (each) => joined(channel)(each) && maskOf(each.users, "palmask") !== "Unknown"
        );

        pal.close();
        yield* daemon.stop;

        return maskOf(state.users, "palmask");
      })
    );

    // Ergo coerces every ident to `~u`, and shows a loopback Connection by its address.
    expect(result).toStrictEqual({ host: "127.0.0.1", user: "~u" });
  }, 120_000);

  it("shows a changed host as one HostChanged, with no quit and join", async () => {
    const channel = "#iirc-mask-host";

    const result = await run(
      Effect.gen(function* () {
        const daemon = yield* start(channel);
        const { api } = daemon;

        yield* eventually(known(api), joined(channel));

        const pal = yield* Effect.promise(
          async () => await connectPeer({ host: ergo.host, nick: "palhost", port: ergo.plainPort })
        );

        pal.send(`JOIN ${channel}`);

        const before = yield* eventually(
          known(api),
          (each) => maskOf(each.users, "palhost") !== "Absent"
        );

        pal.send(`OPER ${ergoOperName} ${ergoOperPassword}`);

        const after = yield* eventually(
          known(api),
          (each) => hostOf(each.users, "palhost") === ergoOperVhost
        );

        const timeline = yield* timelineOf(api, channel);
        const items = yield* itemsOf(api, timeline);

        pal.close();
        yield* daemon.stop;

        return {
          activity: items.flatMap((item) => activityOf(item) ?? []),
          after: maskOf(after.users, "palhost"),
          before: maskOf(before.users, "palhost"),
        };
      })
    );

    const palActivity = result.activity
      .filter((one) => "nick" in one && one.nick === "palhost")
      .map((one) => one._tag);

    expect(result.before).toStrictEqual({ host: "127.0.0.1", user: "~u" });
    expect(result.after).toStrictEqual({ host: ergoOperVhost, user: "~u" });

    // Joined once, when it came, then the host changed, and nothing left or came back.
    expect(palActivity).toStrictEqual(["Joined", "HostChanged"]);
    expect(result.activity.find((one) => one._tag === "HostChanged")).toMatchObject({
      host: ergoOperVhost,
      nick: "palhost",
      user: "~u",
    });
  }, 120_000);

  it("sets Self's real name by Setname, and learns another User's by SETNAME", async () => {
    const channel = "#iirc-mask-name";

    const result = await run(
      Effect.gen(function* () {
        const daemon = yield* start(channel);
        const { api } = daemon;

        yield* eventually(known(api), joined(channel));

        const pal = yield* Effect.promise(
          async () =>
            await connectPeer({
              caps: ["setname"],
              host: ergo.host,
              nick: "palname",
              port: ergo.plainPort,
            })
        );

        pal.send(`JOIN ${channel}`);
        yield* eventually(known(api), (each) => realnameOf(each.users, "palname") !== "Absent");

        const set = yield* api.networks.act({
          params: { network },
          payload: {
            action: { _tag: "Setname", realname: "New Real Name" },
            intent: CallerIntent.make("setname"),
          },
        });

        const self = yield* eventually(
          known(api),
          (each) => valueOf(each.self?.realname) === "New Real Name"
        );

        pal.send("SETNAME :Pal Renamed");

        const peer = yield* eventually(
          known(api),
          (each) => realnameOf(each.users, "palname") === "Pal Renamed"
        );

        const items = yield* itemsOf(api, yield* timelineOf(api, null));
        const channelItems = yield* itemsOf(api, yield* timelineOf(api, channel));

        pal.close();
        yield* daemon.stop;

        return {
          channelActivity: channelItems.flatMap((item) => activityOf(item) ?? []),
          networkActivity: items.flatMap((item) => activityOf(item) ?? []),
          peer: realnameOf(peer.users, "palname"),
          self: valueOf(self.self?.realname),
          set,
        };
      })
    );

    expect(result.set).toMatchObject({ _tag: "Acted" });
    expect(result.self).toBe("New Real Name");
    expect(result.peer).toBe("Pal Renamed");
    expect(result.networkActivity).toContainEqual(
      expect.objectContaining({ _tag: "RealnameChanged", nick: "iirc", realname: "New Real Name" })
    );
    expect(result.channelActivity).toContainEqual(
      expect.objectContaining({ _tag: "RealnameChanged", nick: "palname", realname: "Pal Renamed" })
    );
  }, 120_000);
});
