import { rmSync } from "node:fs";
import path from "node:path";

/**
 * A Timeline marked read and closed by its id, end to end: a real Daemon on a private
 * ngircd, driven only through its HTTP API, with raw IRC connections as the other Users.
 * A detached Direct Message Timeline, and a Timeline a removed Network kept, which no
 * Client can name, are read and closed by id, and stay so once the Daemon starts again
 * and folds its Timelines afresh from the Journal.
 */
import { NetworkId, SearchText } from "@iirc/api";
import type { Timeline } from "@iirc/api";
import { configured } from "@iirc/client/testing";
import type { TimelineId } from "@iirc/timelines";
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
const channel = "#iirc-by-id";

const noneUnread = {
  activity: 0,
  botDirect: 0,
  botMessages: 0,
  direct: 0,
  highlights: 0,
  messages: 0,
};

const run = async <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(test));

const connect = (ircd: Ircd, nick: string) =>
  Effect.promise(async () => await connectPeer({ host: ircd.host, nick, port: ircd.plainPort }));

const waitFor = (peer: Peer, matches: Parameters<Peer["waitFor"]>[0], what: string) =>
  Effect.promise(async () => await peer.waitFor(matches, what));

const outcome = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.match(effect, { onFailure: (error) => error._tag, onSuccess: () => "ok" });

const listed = (api: Api) => api.timelines.list({ params: { network }, query: {} });

const byId = (timelines: readonly Timeline[], id: TimelineId) =>
  timelines.find((one) => one.id === id);

// What tells the two Timelines' states apart here.
const stateOf = (timeline: Timeline | undefined) =>
  timeline === undefined
    ? undefined
    : {
        closed: timeline.closed,
        detached: timeline.detached,
        removed: timeline.removed,
        unread: timeline.unread,
      };

// Marks a Timeline read up to its latest item, as a Frontend does, and closes it.
const readAndClose = (api: Api, timeline: Timeline) =>
  Effect.gen(function* () {
    const params = { timeline: timeline.id };

    if (timeline.latest === null) {
      return yield* Effect.die(`${timeline.name} has no item`);
    }

    const read = yield* outcome(
      api.timelines.read({ params, payload: { read: timeline.latest.at } })
    );

    const closing = yield* api.timelines.close({ params });

    return { closing, read };
  });

describe("ngircd, a Timeline read and closed by its id", () => {
  let ngircd: Ircd;

  beforeAll(async () => {
    ngircd = await startNgircd();
  });

  afterAll(async () => {
    await ngircd.stop();
  });

  it("reads and closes a detached Direct Message Timeline and a removed Network's kept one, which stay so after a restart", async () => {
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
            ircds: [{ host: ngircd.host, port: ngircd.plainPort, tls: false }],
            nicks: ["iirc"],
          }),
          query: {},
        });
        yield* eventually(api.networks.known({ params: { network } }), (known) =>
          known.channels.some((one) => one.name === channel && one.standing === "Joined")
        );

        // `pal` whispers and leaves. `peer`, who shares the Channel with Self, whispers and
        // takes `pal`'s nick, so the Timeline `pal` had is detached.
        const pal = yield* connect(ngircd, "pal");
        const peer = yield* connect(ngircd, "peer");

        pal.send("PRIVMSG iirc :pal whispers first");
        peer.send(`JOIN ${channel}`);
        peer.send("PRIVMSG iirc :peer whispers second");

        const opened = yield* eventually(listed(api), ({ timelines }) =>
          ["pal", "peer"].every((name) =>
            timelines.some((one) => one.kind === "Direct" && one.name === name)
          )
        );

        const palId = opened.timelines.find((one) => one.name === "pal")?.id;
        const peerId = opened.timelines.find((one) => one.name === "peer")?.id;

        if (palId === undefined || peerId === undefined) {
          return yield* Effect.die("the Direct Message Timelines were not listed");
        }

        pal.send("QUIT :bye");
        yield* waitFor(pal, (line) => line.command === "ERROR", "the end of pal's Connection");
        pal.close();
        peer.send("NICK pal");
        yield* waitFor(
          peer,
          (line) => line.command === "NICK" && line.params[0] === "pal",
          "peer's new nick"
        );

        const renamed = yield* eventually(listed(api), ({ timelines }) => {
          const detached = byId(timelines, palId);

          return detached?.detached === true && byId(timelines, peerId)?.name === "pal";
        });

        const detached = byId(renamed.timelines, palId);

        if (detached === undefined) {
          return yield* Effect.die("the detached Timeline was not listed");
        }

        const detachedActs = yield* readAndClose(api, detached);

        const detachedDone = yield* eventually(
          listed(api),
          ({ through }) => detachedActs.closing.sequence <= (through ?? 0)
        );

        const found = yield* api.timelines.search({
          query: { network, text: SearchText.make("first") },
        });

        // The Network is removed, keeping its Timelines, and `peer`'s, now `pal`'s, is read
        // and closed by id, with no Client left to name it.
        const live = (yield* api.networks.list()).find((one) => one.network === network);

        if (live === undefined) {
          return yield* Effect.die("the Network was not listed");
        }

        yield* api.networks.remove({ params: { network }, query: { keep: true, life: live.life } });

        const removed = yield* eventually(
          listed(api),
          ({ timelines }) => byId(timelines, peerId)?.removed === true
        );

        const kept = byId(removed.timelines, peerId);

        if (kept === undefined) {
          return yield* Effect.die("the kept Timeline was not listed");
        }

        const keptActs = yield* readAndClose(api, kept);

        const keptDone = yield* eventually(
          listed(api),
          ({ through }) => keptActs.closing.sequence <= (through ?? 0)
        );

        peer.close();
        yield* daemon.stop;

        // Started again with its Timelines folded afresh from the Journal.
        for (const file of ["views.sqlite", "views.sqlite-wal", "views.sqlite-shm"]) {
          rmSync(path.join(dataDir, file), { force: true });
        }

        const again = yield* startDaemon({ dataDir }, key);

        const restarted = yield* eventually(
          listed(again.api),
          ({ through }) => keptActs.closing.sequence <= (through ?? 0)
        );

        yield* again.stop;

        return {
          after: {
            detached: stateOf(byId(detachedDone.timelines, palId)),
            kept: stateOf(byId(keptDone.timelines, peerId)),
          },
          before: { detached: stateOf(detached), kept: stateOf(kept) },
          detached: { closing: detachedActs.closing._tag, read: detachedActs.read },
          found: found.items.map((item) => item.timeline === palId),
          kept: { closing: keptActs.closing._tag, read: keptActs.read },
          restarted: {
            detached: stateOf(byId(restarted.timelines, palId)),
            kept: stateOf(byId(restarted.timelines, peerId)),
          },
        };
      })
    );

    expect(result).toStrictEqual({
      after: {
        detached: { closed: true, detached: true, removed: false, unread: noneUnread },
        kept: { closed: true, detached: false, removed: true, unread: noneUnread },
      },
      before: {
        detached: {
          closed: false,
          detached: true,
          removed: false,
          unread: { ...noneUnread, direct: 1 },
        },
        // What `peer` said, and their rename.
        kept: {
          closed: false,
          detached: false,
          removed: true,
          unread: { ...noneUnread, activity: 1, direct: 1 },
        },
      },
      detached: { closing: "Closed", read: "ok" },
      found: [true],
      kept: { closing: "Closed", read: "ok" },
      restarted: {
        detached: { closed: true, detached: true, removed: true, unread: noneUnread },
        kept: { closed: true, detached: false, removed: true, unread: noneUnread },
      },
    });
  }, 120_000);
});
