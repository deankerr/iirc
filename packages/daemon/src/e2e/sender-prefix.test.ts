/**
 * A Message's sender prefix, end to end: a real Daemon on a private Ergo, driven only
 * through its HTTP API, with raw IRC connections as the other Users. A Message an operator
 * said is stored with their `@`, and one a User with no prefix said with none.
 */
import { NetworkId } from "@iirc/api";
import type { Timeline, TimelineItem } from "@iirc/api";
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

const run = async <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(test));

const peer = (ergo: Ircd, nick: string) =>
  Effect.promise(async () => await connectPeer({ host: ergo.host, nick, port: ergo.plainPort }));

// The prefix each Message in a window was said with, by its text.
const prefixesOf = (items: readonly TimelineItem[]) =>
  Object.fromEntries(
    items.flatMap((item) =>
      item.content._tag === "Message" ? [[item.content.text, item.content.prefix]] : []
    )
  );

describe("ergo, a Message's sender prefix", () => {
  let ergo: Ircd;

  beforeAll(async () => {
    ergo = await startErgo();
  }, 120_000);

  afterAll(async () => {
    await ergo.stop();
  });

  it("stores a Message with the prefix its sender held when it was said", async () => {
    const channel = "#iirc-prefix";

    const result = await run(
      Effect.gen(function* () {
        // The first User into a Channel holds its operator prefix, and Self joins after.
        const op = yield* peer(ergo, "oppal");
        op.send(`JOIN ${channel}`);

        yield* Effect.promise(
          async () =>
            await op.waitFor((line) => line.command === "JOIN", "its own JOIN to the Channel")
        );

        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);
        const daemon = yield* startDaemon({ dataDir }, key);
        const { api } = daemon;

        yield* api.networks.configure({
          params: { network },
          payload: configured({
            channels: [{ name: channel }],
            nicks: ["iirc"],
            servers: [{ host: ergo.host, port: ergo.plainPort, tls: false }],
          }),
          query: {},
        });

        yield* eventually(api.networks.known({ params: { network } }), (each) =>
          each.channels.some((one) => one.name === channel && one.standing === "Joined")
        );

        const plain = yield* peer(ergo, "plainpal");
        plain.send(`JOIN ${channel}`);

        yield* Effect.promise(
          async () =>
            await plain.waitFor((line) => line.command === "JOIN", "its own JOIN to the Channel")
        );

        op.send(`PRIVMSG ${channel} :from the operator`);
        plain.send(`PRIVMSG ${channel} :from the plain one`);

        const listed = yield* api.timelines.list({ params: { network }, query: {} });
        const found: Timeline | undefined = listed.timelines.find((one) => one.name === channel);

        if (found === undefined) {
          return yield* Effect.die(`${channel}'s Timeline was not listed`);
        }

        const items = yield* eventually(
          Effect.map(
            api.timelines.window({ params: { timeline: found.id }, query: {} }),
            ({ items: window }) => window
          ),
          (each) => {
            const said = prefixesOf(each);

            return "from the operator" in said && "from the plain one" in said;
          }
        );

        op.close();
        plain.close();
        yield* daemon.stop;

        return prefixesOf(items);
      })
    );

    expect(result).toStrictEqual({ "from the operator": "@", "from the plain one": null });
  }, 120_000);
});
