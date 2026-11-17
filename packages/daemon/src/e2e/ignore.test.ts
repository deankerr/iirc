/**
 * Ignoring by mask, end to end: a real Daemon on a private ngircd, driven only through its
 * HTTP API, with raw IRC connections as the other Users. What an ignored User says is kept
 * and hidden from every read, and shown again where it stood once the mask is dropped.
 */
import { NetworkId, SearchText } from "@iirc/api";
import type { Timeline, TimelineItem } from "@iirc/api";
import { configured } from "@iirc/client/testing";
import { IgnoreMask } from "@iirc/protocol/mask";
import { Effect } from "effect";
import type { Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startNgircd } from "../testing/ircd.ts";
import type { Ircd } from "../testing/ircd.ts";
import { connectPeer } from "../testing/peer.ts";
import type { Peer } from "../testing/peer.ts";
import { eventually, startDaemon } from "../testing/running.ts";
import type { Api } from "../testing/running.ts";
import { makeKey, temporaryDirectory } from "../testing/world.ts";

const network = NetworkId.make("private");
const channel = "#iirc-ignore";

const run = async <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(test));

const connect = (ircd: Ircd, nick: string) =>
  Effect.promise(async () => await connectPeer({ host: ircd.host, nick, port: ircd.plainPort }));

// Waits for the Ircd to answer a `PING`, which it does in order, so everything the Peer
// sent before has been taken, before anyone else speaks.
const flushed = (peer: Peer) =>
  Effect.promise(async () => {
    peer.send("PING :flushed");
    await peer.waitFor((each) => each.command === "PONG", "the answer to PING");
  });

const place = (item: TimelineItem) => JSON.stringify(item.position);

// How much Activity a Timeline counts, which the Ircd's own joins and modes decide.
const activity = (unread: { readonly activity: number }) => unread.activity;

// What an item shows: who said what, or what happened and to whom.
const shown = (item: TimelineItem) => {
  const { content } = item;

  if (content._tag === "Message") {
    return `<${content.sender}> ${content.text}`;
  }

  return content._tag === "Activity" ? content.activity._tag : content._tag;
};

const timelines = (api: Api) =>
  Effect.map(
    api.timelines.list({ params: { network }, query: {} }),
    ({ timelines: listed }) => listed
  );

const named = (listed: readonly Timeline[], name: string) =>
  listed.find((one) => one.name.toLowerCase() === name.toLowerCase());

const windowOf = (api: Api, timeline: Timeline) =>
  Effect.map(
    api.timelines.window({ params: { timeline: timeline.id }, query: {} }),
    ({ items }) => items
  );

// The Channel's Timeline, its window, the Timelines listed, and what a search for the
// ignored User's word finds.
const read = (api: Api) =>
  Effect.gen(function* () {
    const listed = yield* timelines(api);
    const found = named(listed, channel);

    if (found === undefined) {
      return yield* Effect.die(`${channel} was not listed`);
    }

    const searched = yield* api.timelines.search({
      query: { network, text: SearchText.make("spam") },
    });

    return {
      channel: found,
      direct: named(listed, "spam"),
      items: yield* windowOf(api, found),
      searched: searched.items.map(shown),
    };
  });

describe("ngircd, ignoring by mask", () => {
  let ngircd: Ircd;

  beforeAll(async () => {
    ngircd = await startNgircd();
  });

  afterAll(async () => {
    await ngircd.stop();
  });

  it("hides what an ignored User says and does, and shows it again where it stood once the mask is dropped", async () => {
    const result = await run(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);
        const daemon = yield* startDaemon({ dataDir }, key);
        const { api } = daemon;

        const configuration = (ignores: readonly string[]) =>
          configured({
            channels: [{ name: channel }],
            ignores: ignores.map((mask) => IgnoreMask.make(mask)),
            ircds: [{ host: ngircd.host, port: ngircd.plainPort, tls: false }],
            nicks: ["iirc"],
          });

        // A mask that matches Self too, which never hides what Self says.
        yield* api.networks.configure({
          params: { network },
          payload: configuration(["spam!*@*", "iirc!*@*"]),
          query: {},
        });
        yield* eventually(api.networks.known({ params: { network } }), (known) =>
          known.channels.some((one) => one.name === channel && one.standing === "Joined")
        );

        const pal = yield* connect(ngircd, "pal");
        const spam = yield* connect(ngircd, "spam");

        pal.send(`JOIN ${channel}`);
        pal.send(`PRIVMSG ${channel} :pal says hello`);
        yield* flushed(pal);
        spam.send(`JOIN ${channel}`);
        spam.send(`PRIVMSG ${channel} :spam says hello`);
        spam.send(`PRIVMSG ${channel} :spam calls iirc`);
        spam.send("PRIVMSG iirc :spam whispers");
        spam.send(`PART ${channel}`);
        yield* flushed(spam);

        yield* api.networks.say({
          params: { network },
          payload: { kind: "Privmsg", target: channel, text: "iirc says hello" },
        });
        yield* Effect.promise(
          async () =>
            await pal.waitFor(
              (line) => line.command === "PRIVMSG" && line.params[1] === "iirc says hello",
              "Self's Message"
            )
        );
        pal.send(`PRIVMSG ${channel} :pal says goodbye`);

        const hidden = yield* eventually(read(api), ({ items }) =>
          items.some((item) => shown(item) === "<pal> pal says goodbye")
        );

        yield* api.networks.configure({
          params: { network },
          payload: configuration(["iirc!*@*"]),
          query: {},
        });

        const restored = yield* eventually(
          read(api),
          ({ items, direct }) =>
            direct !== undefined && items.some((item) => shown(item) === "<spam> spam says hello")
        );

        const directItems =
          restored.direct === undefined ? [] : yield* windowOf(api, restored.direct);

        pal.close();
        spam.close();
        yield* daemon.stop;

        // Every item hidden before is shown now, and every one shown before still stands
        // where it stood, unchanged.
        const before = new Set(hidden.items.map(place));
        const again = restored.items.filter((item) => !before.has(place(item)));
        const restoredAt = Math.min(...again.map(({ changed }) => changed));

        return {
          again: again.map((item) => [
            shown(item),
            item.sequence < restoredAt,
            item.changed === restoredAt,
          ]),
          direct: [
            hidden.direct,
            directItems.map(shown),
            restored.direct?.unread,
            directItems.every(({ sequence }) => sequence < restoredAt),
          ],
          hidden: {
            items: hidden.items.map(shown).filter((each) => each.startsWith("<")),
            spamless: hidden.items.every((item) => !shown(item).includes("spam")),
            unread: hidden.channel.unread,
          },
          kept: restored.items.filter((item) => before.has(place(item))).length,
          order: restored.items.map(shown).filter((each) => each.startsWith("<")),
          searched: [hidden.searched, restored.searched],
          shownBefore: hidden.items.length,
          unread: restored.channel.unread,
        };
      })
    );

    expect(result).toStrictEqual({
      // The join and the part, then what was said, all from before the mask was dropped.
      again: [
        ["Joined", true, true],
        ["<spam> spam says hello", true, true],
        ["<spam> spam calls iirc", true, true],
        ["Parted", true, true],
      ],
      direct: [
        undefined,
        ["<spam> spam whispers"],
        { activity: 0, direct: 1, highlights: 0, messages: 0 },
        true,
      ],
      hidden: {
        items: ["<pal> pal says hello", "<iirc> iirc says hello", "<pal> pal says goodbye"],
        spamless: true,
        unread: { activity: activity(result.hidden.unread), direct: 0, highlights: 0, messages: 2 },
      },
      kept: result.shownBefore,
      order: [
        "<pal> pal says hello",
        "<spam> spam says hello",
        "<spam> spam calls iirc",
        "<iirc> iirc says hello",
        "<pal> pal says goodbye",
      ],
      searched: [[], ["<spam> spam whispers", "<spam> spam calls iirc", "<spam> spam says hello"]],
      shownBefore: result.shownBefore,
      unread: {
        activity: activity(result.hidden.unread) + 2,
        direct: 0,
        highlights: 1,
        messages: 3,
      },
    });
  }, 120_000);
});
