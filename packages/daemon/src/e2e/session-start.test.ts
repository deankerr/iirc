/**
 * The Owner's own start to a Session, end to end: a real Daemon on a private ngircd sets
 * Self's user modes and sends the Configuration's Lines in order, through pacing, before
 * it joins its Channels, and a raw IRC connection hears them in that order.
 */
import { NetworkId } from "@iirc/api";
import { configured } from "@iirc/client/testing";
import { Effect } from "effect";
import type { Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startNgircd } from "../testing/ircd.ts";
import type { Ircd } from "../testing/ircd.ts";
import { connectPeer } from "../testing/peer.ts";
import { eventually, startDaemon } from "../testing/running.ts";
import { makeKey, temporaryDirectory } from "../testing/world.ts";

const network = NetworkId.make("private");
const channel = "#iirc-start";

const run = async <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(test));

describe("ngircd, the Owner's start to a Session", () => {
  let ngircd: Ircd;

  beforeAll(async () => {
    ngircd = await startNgircd();
  });

  afterAll(async () => {
    await ngircd.stop();
  });

  it("sets Self's user modes, then sends the Lines in order, before joining", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pal = yield* Effect.promise(
          async () => await connectPeer({ host: ngircd.host, nick: "pal", port: ngircd.plainPort })
        );

        pal.send(`JOIN ${channel}`);
        yield* Effect.promise(
          async () => await pal.waitFor((line) => line.command === "JOIN", "pal's own JOIN")
        );

        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);
        const daemon = yield* startDaemon({ dataDir }, key);
        const { api } = daemon;

        yield* api.networks.configure({
          params: { network },
          payload: configured({
            channels: [{ name: channel }],
            ircds: [{ host: ngircd.host, port: ngircd.plainPort, tls: false }],
            lines: ["PRIVMSG pal :first", "PRIVMSG pal :second", "PRIVMSG pal :third"],
            nicks: ["iirc"],
            userModes: "+i",
          }),
          query: {},
        });

        // The Peer takes each Line in turn, so one that came out of order is passed over,
        // and the wait for it fails.
        const heard: string[] = [];

        for (const text of ["first", "second", "third"]) {
          const line = yield* Effect.promise(
            async () =>
              await pal.waitFor(
                (each) =>
                  each.command === "JOIN" ||
                  (each.command === "PRIVMSG" && each.params[0] === "pal"),
                `the Line saying ${text}`
              )
          );

          heard.push(line.command === "JOIN" ? "JOIN" : (line.params[1] ?? ""));
        }

        const joined = yield* Effect.promise(
          async () => await pal.waitFor((each) => each.command === "JOIN", "Self's JOIN")
        );

        // ngircd answers the `MODE` on Self, which shows in the Network's own Timeline.
        const modes = yield* eventually(
          Effect.gen(function* () {
            const { timelines } = yield* api.timelines.list({ params: { network }, query: {} });
            const own = timelines.find((one) => one.kind === "Network");

            if (own === undefined) {
              return [];
            }

            const { items } = yield* api.timelines.window({
              params: { timeline: own.id },
              query: {},
            });

            return items.flatMap((item) =>
              item.content._tag === "Activity" && item.content.activity._tag === "ModeChanged"
                ? item.content.activity.changes.map(
                    (change) => `${change.set ? "+" : "-"}${change.mode}`
                  )
                : []
            );
          }),
          (shown) => shown.length > 0
        );

        pal.close();
        yield* daemon.stop;

        return { heard, joined: joined.source?.split("!")[0], modes };
      })
    );

    expect(result).toStrictEqual({
      heard: ["first", "second", "third"],
      joined: "iirc",
      modes: ["+i"],
    });
  }, 60_000);
});
