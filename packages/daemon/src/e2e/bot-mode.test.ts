/**
 * Bot mode, end to end: a real Daemon on a private Ergo, which names its bot mode with
 * `BOT=B`, driven only through its HTTP API, with raw IRC connections as the other Users.
 * Self, configured as a bot, sets the mode as its Session begins, and a User who set it is
 * marked: their Message, their place among the members, and a `WHOIS` of them.
 */
import { NetworkId } from "@iirc/api";
import type { Member, Timeline, TimelineItem } from "@iirc/api";
import { configured } from "@iirc/client/testing";
import { Effect } from "effect";
import type { Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startErgo } from "../testing/ircd.ts";
import type { Ircd } from "../testing/ircd.ts";
import { connectPeer } from "../testing/peer.ts";
import type { Peer } from "../testing/peer.ts";
import { eventually, startDaemon } from "../testing/running.ts";
import type { Api } from "../testing/running.ts";
import { makeKey, temporaryDirectory } from "../testing/world.ts";

const network = NetworkId.make("private");

const run = async <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(test));

// What a Fact holds while it is known, or its tag.
const valueOf = <T>(
  fact: { readonly _tag: "Known"; readonly value: T } | { readonly _tag: "Stale" | "Unknown" }
): T | "Stale" | "Unknown" => (fact._tag === "Known" ? fact.value : fact._tag);

const timelineOf = (api: Api, name: string) =>
  Effect.gen(function* () {
    const listed = yield* api.timelines.list({ params: { network }, query: {} });
    const found: Timeline | undefined = listed.timelines.find((one) => one.name === name);

    if (found === undefined) {
      return yield* Effect.die(`${name}'s Timeline was not listed`);
    }

    return found;
  });

const membersOf = (api: Api, timeline: Timeline) =>
  Effect.map(
    api.timelines.members({ params: { timeline: timeline.id }, query: {} }),
    ({ members }) => members
  );

// Whether each member is a bot, by nick, as the members' route says.
const botsOf = (members: readonly Member[]) =>
  Object.fromEntries(members.map((one) => [one.nick, valueOf(one.bot)]));

const itemsOf = (api: Api, timeline: Timeline) =>
  Effect.map(
    api.timelines.window({ params: { timeline: timeline.id }, query: {} }),
    ({ items }) => items
  );

// Whether each Message said this was a bot's, by its text.
const saidByBots = (items: readonly TimelineItem[]) =>
  Object.fromEntries(
    items.flatMap((item) =>
      item.content._tag === "Message" ? [[item.content.text, item.content.bot]] : []
    )
  );

// Whether a `WHOIS` of a nick says they are a bot.
const whoisBot = (api: Api, nick: string) =>
  Effect.map(
    api.networks.look({
      params: { network },
      payload: { lookup: { _tag: "Whois", nick } },
      query: {},
    }),
    (looked) =>
      looked._tag === "LookedUp" && looked.result._tag === "Found"
        ? looked.result.profiles[0]?.bot
        : looked._tag
  );

const peer = (ergo: Ircd, nick: string) =>
  Effect.promise(async () => await connectPeer({ host: ergo.host, nick, port: ergo.plainPort }));

const waitFor = (one: Peer, matches: Parameters<Peer["waitFor"]>[0], what: string) =>
  Effect.promise(async () => await one.waitFor(matches, what));

describe("ergo, bot mode", () => {
  let ergo: Ircd;

  beforeAll(async () => {
    ergo = await startErgo();
  }, 120_000);

  afterAll(async () => {
    await ergo.stop();
  });

  const start = (channel: string, bot: boolean) =>
    Effect.gen(function* () {
      const dataDir = yield* temporaryDirectory;
      const key = yield* makeKey(dataDir);
      const daemon = yield* startDaemon({ dataDir }, key);

      yield* daemon.api.networks.configure({
        params: { network },
        payload: configured({
          bot,
          channels: [{ name: channel }],
          nicks: ["iirc"],
          servers: [{ host: ergo.host, port: ergo.plainPort, tls: false }],
        }),
        query: {},
      });

      return daemon;
    });

  it("sets Self's bot mode as its Session begins, where the Configuration says Self is one", async () => {
    const channel = "#iirc-bot-self";

    const result = await run(
      Effect.gen(function* () {
        const daemon = yield* start(channel, true);
        const { api } = daemon;
        const known = api.networks.known({ params: { network } });

        // Self's own Lines before the mode was set say it is not one, and its `MODE` says it is.
        const state = yield* eventually(
          known,
          (each) => each.self !== null && valueOf(each.self.bot) === true
        );

        const timeline = yield* timelineOf(api, channel);

        const members = yield* eventually(
          membersOf(api, timeline),
          (each) => botsOf(each).iirc === true
        );

        const whois = yield* whoisBot(api, "iirc");

        yield* daemon.stop;

        return { members: botsOf(members).iirc, self: state.self?.bot, whois };
      })
    );

    expect(result).toMatchObject({
      members: true,
      self: { _tag: "Known", value: true },
      whois: true,
    });
  }, 120_000);

  it("marks a User who set the bot mode: their Message, among the members, and by WHOIS", async () => {
    const channel = "#iirc-bot-peer";

    const result = await run(
      Effect.gen(function* () {
        const daemon = yield* start(channel, false);
        const { api } = daemon;

        yield* eventually(api.networks.known({ params: { network } }), (each) =>
          each.channels.some((one) => one.name === channel && one.standing === "Joined")
        );

        const robo = yield* peer(ergo, "robopal");
        const human = yield* peer(ergo, "humanpal");

        robo.send("MODE robopal +B");
        yield* waitFor(
          robo,
          (line) => line.command === "MODE" && line.params[0] === "robopal",
          "its own MODE"
        );

        for (const one of [robo, human]) {
          one.send(`JOIN ${channel}`);
        }

        robo.send(`PRIVMSG ${channel} :beep`);
        human.send(`PRIVMSG ${channel} :hello`);

        const timeline = yield* timelineOf(api, channel);

        const items = yield* eventually(itemsOf(api, timeline), (each) => {
          const said = saidByBots(each);

          return "beep" in said && "hello" in said;
        });

        const members = yield* eventually(
          membersOf(api, timeline),
          (each) => botsOf(each).robopal === true && botsOf(each).humanpal === false
        );

        const whois = {
          humanpal: yield* whoisBot(api, "humanpal"),
          robopal: yield* whoisBot(api, "robopal"),
        };

        robo.close();
        human.close();
        yield* daemon.stop;

        const bots = botsOf(members);

        return {
          members: { humanpal: bots.humanpal, robopal: bots.robopal },
          said: saidByBots(items),
          whois,
        };
      })
    );

    expect(result).toStrictEqual({
      members: { humanpal: false, robopal: true },
      said: { beep: true, hello: false },
      whois: { humanpal: false, robopal: true },
    });
  }, 120_000);
});
