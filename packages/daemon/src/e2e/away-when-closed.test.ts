/**
 * Away while no Frontend is open, end to end: a real Daemon on a private ngircd marks Self
 * away once no Frontend has followed News for `away.after`, and back once one has followed
 * it a short while, and another User's `WHOIS` sees each, as the Ircd holds it.
 */
import { NetworkId } from "@iirc/api";
import { configured } from "@iirc/client/testing";
import { Effect, Stream } from "effect";
import type { Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startNgircd } from "../testing/ircd.ts";
import type { Ircd } from "../testing/ircd.ts";
import { connectPeer } from "../testing/peer.ts";
import type { Peer } from "../testing/peer.ts";
import { eventually, startDaemon } from "../testing/running.ts";
import { makeKey, temporaryDirectory } from "../testing/world.ts";

const network = NetworkId.make("private");

const run = async <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(test));

/**
 * Self's away message, as a `WHOIS` from another User finds it, or `null` while back.
 * @param pal - The other User.
 * @returns The message, or `null`.
 */
const awayAsSeen = (pal: Peer) =>
  Effect.promise(async () => {
    pal.send("WHOIS iirc");

    const line = await pal.waitFor(
      (each) => each.command === "301" || each.command === "318",
      "the WHOIS of iirc"
    );

    if (line.command === "318") {
      return null;
    }

    await pal.waitFor((each) => each.command === "318", "the end of the WHOIS");

    return line.params.at(-1) ?? "";
  });

describe("ngircd, away while no Frontend is open", () => {
  let ngircd: Ircd;

  beforeAll(async () => {
    ngircd = await startNgircd();
  });

  afterAll(async () => {
    await ngircd.stop();
  });

  it("marks Self away after the wait, and back once News is followed a while", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pal = yield* Effect.promise(
          async () => await connectPeer({ host: ngircd.host, nick: "pal", port: ngircd.plainPort })
        );

        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);
        const daemon = yield* startDaemon({ dataDir }, key);
        const { api } = daemon;

        yield* api.networks.configure({
          params: { network },
          payload: configured({
            channels: [],
            ircds: [{ host: ngircd.host, port: ngircd.plainPort, tls: false }],
            nicks: ["iirc"],
          }),
          query: {},
        });

        yield* eventually(
          api.networks.known({ params: { network } }),
          (known) => known.session._tag === "Registered"
        );

        const before = yield* awayAsSeen(pal);

        for (const [option, value] of [
          ["away.message", "gone fishing"],
          ["away.after", 1],
        ] as const) {
          const { sequence } = yield* api.options.read();

          yield* api.options.set({
            params: { option },
            payload: { value },
            query: { ifSequence: sequence },
          });
        }

        // A `WHOIS` every couple of seconds, so the Ircd never holds pal back for flooding.
        const asked = Effect.andThen(Effect.sleep("2 seconds"), awayAsSeen(pal));
        const away = yield* eventually(asked, (seen) => seen !== null, "90 seconds");

        // A Frontend opens. Self is still away as it does, and back a short while after.
        const stream = yield* api.news.follow({ headers: {}, query: {} });

        yield* Effect.forkScoped(Stream.runDrain(stream));
        const opening = yield* awayAsSeen(pal);
        const back = yield* eventually(asked, (seen) => seen === null, "60 seconds");

        pal.close();
        yield* daemon.stop;

        return { away, back, before, opening };
      })
    );

    expect(result).toStrictEqual({
      away: "gone fishing",
      back: null,
      before: null,
      opening: "gone fishing",
    });
  }, 180_000);
});
