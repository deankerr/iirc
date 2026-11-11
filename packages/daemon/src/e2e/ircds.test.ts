/**
 * End-to-end runs: a real Daemon, driven only through its HTTP API, on private Ircds, with
 * a raw IRC connection as the other User. They are run on purpose with `bun run e2e`, and
 * never in `bun run test`.
 */
import { CallerIntent, CredentialPathName, NetworkId } from "@iirc/api";
import type { ActionRequest, Happened, TimelineItem } from "@iirc/api";
import { configured } from "@iirc/client/testing";
import { Effect, Fiber, Redacted } from "effect";
import type { Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startErgo, startNgircd } from "../testing/ircd.ts";
import type { Ircd } from "../testing/ircd.ts";
import { connectPeer, registerAccount } from "../testing/peer.ts";
import type { Parsed } from "../testing/peer.ts";
import { eventually, followChanges, followNews, startDaemon } from "../testing/running.ts";
import type { Api } from "../testing/running.ts";
import { makeKey, temporaryDirectory } from "../testing/world.ts";

const network = NetworkId.make("private");
const channel = "#iirc-e2e";

const run = async <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(test));

const said = (happened: readonly Happened[], sender: string, text: string) =>
  happened.some(({ news }) =>
    news.some((one) => one._tag === "Message" && one.sender === sender && one.text === text)
  );

const sequences = (happened: readonly Happened[]) => happened.map((one) => one.sequence);

const sent = (item: TimelineItem, sender: string, text: string) =>
  item.content._tag === "Message" && item.content.sender === sender && item.content.text === text;

const joined = (api: Api) =>
  eventually(api.networks.known({ params: { network } }), (known) =>
    known.channels.some((one) => one.name === channel && one.standing === "Joined")
  );

// The Session that ended, and why, from News: the stopped Daemon's Journal, as one
// started after it on the same data directory reads it.
const endings = (happened: readonly Happened[]) =>
  happened.flatMap(({ news }) =>
    news.flatMap((one) => (one._tag === "SessionEnded" ? [one.reason] : []))
  );

/** How long a stop may take: the Runtime's 5 s bound, and serving's 500 ms. */
const stopBound = 6000;

/**
 * Stops a Daemon in a Channel with a Peer, and reads back how its Session ended. The Peer
 * must hear a `QUIT` from our nick, decided by the Line's command and source alone.
 * @param ircd - The Ircd, by its plaintext port.
 * @param nick - The Peer's nick.
 * @returns What the Peer heard, how long the stop took, and how the Session ended.
 */
const stopGracefully = (ircd: Ircd, nick: string) =>
  Effect.gen(function* () {
    const dataDir = yield* temporaryDirectory;
    const key = yield* makeKey(dataDir);

    const configuration = configured({
      channels: [{ name: channel }],
      ircds: [{ host: ircd.host, port: ircd.plainPort, tls: false }],
      nicks: ["iirc"],
    });

    const peer = yield* Effect.promise(
      async () => await connectPeer({ host: ircd.host, nick, port: ircd.plainPort })
    );

    peer.send(`JOIN ${channel}`);

    const daemon = yield* startDaemon({ dataDir }, key);

    yield* daemon.api.networks.configure({
      params: { network },
      payload: configuration,
      query: {},
    });
    yield* joined(daemon.api);

    const quitting = Effect.promise(
      async () =>
        await peer.waitFor(
          (line) => line.command === "QUIT" && line.source?.split("!")[0] === "iirc",
          "the Daemon's QUIT"
        )
    );

    const started = performance.now();

    yield* daemon.stop;
    const took = performance.now() - started;
    const quit = yield* quitting;

    // Another Daemon on the same data directory reads the first's Journal.
    const again = yield* startDaemon({ dataDir }, key);
    const happened = yield* followNews(again.api, 0, (all) => endings(all).length > 0);

    yield* again.stop;
    peer.close();

    // Printed so a run shows how long the stop took.
    console.log(`${ircd.kind}: the stop took ${Math.round(took)} ms`);

    return { ended: endings(happened)[0], quit: quit.command, within: took < stopBound };
  });

describe("ngircd, on the floor", () => {
  let ngircd: Ircd;

  beforeAll(async () => {
    ngircd = await startNgircd();
  });

  afterAll(async () => {
    await ngircd.stop();
  });

  const floor = () =>
    configured({
      channels: [{ name: channel }],
      ircds: [{ host: ngircd.host, port: ngircd.plainPort, tls: false }],
      nicks: ["iirc"],
    });

  it("configures, registers, joins, says, and hears the other User as News and in its Timeline", async () => {
    const result = await run(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);
        const daemon = yield* startDaemon({ dataDir }, key);
        const { api } = daemon;

        const peer = yield* Effect.promise(
          async () => await connectPeer({ host: ngircd.host, nick: "peer", port: ngircd.plainPort })
        );

        peer.send(`JOIN ${channel}`);
        yield* api.networks.configure({ params: { network }, payload: floor(), query: {} });
        const known = yield* joined(api);

        const saying = yield* api.networks.say({
          params: { network },
          payload: { kind: "Privmsg", target: channel, text: "hello from iirc" },
        });

        const heard = yield* Effect.promise(
          async () =>
            await peer.waitFor(
              (line) => line.command === "PRIVMSG" && line.params[1] === "hello from iirc",
              "the Daemon's Message"
            )
        );

        // The Timelines as they stand, and their changes followed from there, live.
        const before = yield* api.timelines.list({ params: { network }, query: {} });

        const resume = { sequence: before.through ?? 0, version: before.version };

        const following = yield* followChanges(api, resume, (changed) =>
          changed.some((event) =>
            event.data.items.some((item) => sent(item, "peer", "hello from peer"))
          )
        ).pipe(Effect.forkChild);

        peer.send(`PRIVMSG ${channel} :hello from peer`);

        const happened = yield* followNews(api, 0, (all) => said(all, "peer", "hello from peer"));
        const changes = yield* Fiber.join(following);

        const carried = changes.find((event) =>
          event.data.items.some((item) => sent(item, "peer", "hello from peer"))
        );

        const listed = yield* api.timelines.list({ params: { network }, query: {} });
        const timeline = listed.timelines.find((one) => one.name === channel);

        const window =
          timeline === undefined
            ? undefined
            : yield* api.timelines.window({ params: { timeline: timeline.id }, query: {} });

        const read = window?.items.find((item) => sent(item, "peer", "hello from peer"));

        const inspected = yield* api.networks.inspect({ params: { network } });

        peer.close();
        yield* daemon.stop;

        return {
          features: inspected.client.features,
          heardFrom: heard.source?.split("!")[0],
          ours: said(happened, "iirc", "hello from iirc"),
          peer: said(happened, "peer", "hello from peer"),
          session: known.session._tag,
          timeline: {
            carriedAt: carried?.id.sequence === read?.sequence,
            kind: timeline?.kind,
            ours: window?.items.some((item) => sent(item, "iirc", "hello from iirc")),
            projection: listed.projection._tag,
            read: read !== undefined,
            through: (listed.through ?? 0) >= (carried?.id.sequence ?? Number.POSITIVE_INFINITY),
            version: carried?.id.version === listed.version,
          },
          wasSaid: saying.sequence > 0,
        };
      })
    );

    expect(result).toStrictEqual({
      // ngircd offers only `multi-prefix`.
      features: ["multi-prefix"],
      heardFrom: "iirc",
      ours: true,
      peer: true,
      session: "Registered",
      timeline: {
        carriedAt: true,
        kind: "Channel",
        ours: true,
        projection: "Running",
        read: true,
        through: true,
        version: true,
      },
      wasSaid: true,
    });
  }, 60_000);

  it("acts as a Channel operator: sets a topic, ops the other User, kicks them, and goes away", async () => {
    const acting = "#iirc-acts";
    const elsewhere = "#iirc-elsewhere";

    const result = await run(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);
        const daemon = yield* startDaemon({ dataDir }, key);
        const { api } = daemon;

        // The Daemon joins first, so the Ircd makes it the Channel's operator.
        yield* api.networks.configure({
          params: { network },
          payload: configured({
            channels: [{ name: acting }],
            ircds: [{ host: ngircd.host, port: ngircd.plainPort, tls: false }],
            nicks: ["iirc"],
          }),
          query: {},
        });

        yield* eventually(api.networks.known({ params: { network } }), (known) =>
          known.channels.some((one) => one.name === acting && one.standing === "Joined")
        );

        const peer = yield* Effect.promise(
          async () =>
            await connectPeer({ host: ngircd.host, nick: "target", port: ngircd.plainPort })
        );

        peer.send(`JOIN ${elsewhere}`);
        peer.send(`JOIN ${acting}`);

        yield* eventually(api.networks.known({ params: { network } }), (known) =>
          known.channels.some(
            (one) => one.name === acting && one.members.some((member) => member.nick === "target")
          )
        );

        const act = (action: ActionRequest, intent?: string) =>
          api.networks.act({
            params: { network },
            payload:
              intent === undefined ? { action } : { action, intent: CallerIntent.make(intent) },
          });

        const hear = (what: string, matches: (line: Parsed) => boolean) =>
          Effect.promise(async () => await peer.waitFor(matches, what));

        const topic = yield* act({ _tag: "Topic", channel: acting, text: "set by iirc" });
        const topicLine = yield* hear("the topic", (line) => line.command === "TOPIC");

        yield* act({
          _tag: "Mode",
          changes: [{ mode: "o", param: "target", set: true }],
          target: acting,
        });
        const modeLine = yield* hear("the op", (line) => line.command === "MODE");

        // A topic for a Channel the Daemon is not in is refused by the Ircd, tied by its name.
        yield* act({ _tag: "Topic", channel: elsewhere, text: "not mine" }, "not-mine");

        const refused = yield* followNews(api, 0, (all) =>
          all.some(({ news }) =>
            news.some((one) => one._tag === "Refused" && one.intent === "not-mine")
          )
        );

        yield* act({ _tag: "Kick", channel: acting, nicks: ["target"], reason: "bye now" });
        const kickLine = yield* hear("the kick", (line) => line.command === "KICK");

        yield* act({ _tag: "Away", message: "gone fishing" });

        const known = yield* eventually(
          api.networks.known({ params: { network } }),
          (now) => now.self?.away._tag === "Known" && now.self.away.value !== null
        );

        const channel = known.channels.find((one) => one.name === acting);

        peer.close();
        yield* daemon.stop;

        return {
          away: known.self?.away._tag === "Known" ? known.self.away.value : undefined,
          kick: [kickLine.source?.split("!")[0], ...kickLine.params],
          members: channel?.members.map((member) => member.nick),
          mode: [modeLine.source?.split("!")[0], ...modeLine.params],
          refused: refused.flatMap(({ news }) =>
            news.flatMap((one) =>
              one._tag === "Refused" && one.intent === "not-mine" ? [one.reason] : []
            )
          ),
          topic: topic._tag,
          topicLine: [topicLine.source?.split("!")[0], ...topicLine.params],
        };
      })
    );

    expect(result).toStrictEqual({
      away: { message: "gone fishing" },
      kick: ["iirc", acting, "target", "bye now"],
      members: ["iirc"],
      mode: ["iirc", acting, "+o", "target"],
      // ngircd answers a topic for a Channel Self is not in with 442 ERR_NOTONCHANNEL.
      refused: [{ _tag: "Rejected", reply: "442" }],
      topic: "Acted",
      topicLine: ["iirc", acting, "set by iirc"],
    });
  }, 60_000);

  it("comes back after a restart on the same data directory, with no News lost across `after`", async () => {
    const result = await run(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);

        const peer = yield* Effect.promise(
          async () =>
            await connectPeer({ host: ngircd.host, nick: "witness", port: ngircd.plainPort })
        );

        peer.send(`JOIN ${channel}`);

        // The first Daemon: on, joined, and told something.
        const first = yield* startDaemon({ dataDir }, key);

        yield* first.api.networks.configure({ params: { network }, payload: floor(), query: {} });
        yield* joined(first.api);
        peer.send(`PRIVMSG ${channel} :before the restart`);

        const before = yield* followNews(first.api, 0, (all) =>
          said(all, "witness", "before the restart")
        );

        const intent = CallerIntent.make("said-before-restart");

        yield* first.api.networks.say({
          params: { network },
          payload: { intent, kind: "Privmsg", target: channel, text: "about to restart" },
        });
        const last = before.at(-1)?.sequence ?? 0;

        yield* first.stop;

        // The second Daemon, on the same data directory.
        const second = yield* startDaemon({ dataDir }, key);
        const listed = yield* second.api.networks.list();

        yield* joined(second.api);
        peer.send(`PRIVMSG ${channel} :after the restart`);

        const resumed = yield* followNews(second.api, last, (all) =>
          said(all, "witness", "after the restart")
        );

        const everything = yield* followNews(second.api, 0, (all) =>
          said(all, "witness", "after the restart")
        );

        const recovered = yield* second.api.networks.said({ params: { intent, network } });

        peer.close();
        yield* second.stop;

        // What the first Daemon showed is what the second folds again, Entry for Entry,
        // and resuming after the last sequence seen gives exactly what came after it.
        const refolded =
          JSON.stringify(everything.slice(0, before.length)) === JSON.stringify(before);

        const resumedExactly =
          JSON.stringify(sequences(resumed)) ===
          JSON.stringify(sequences(everything).filter((sequence) => sequence > last));

        return {
          listed,
          recovered: recovered._tag,
          refolded,
          resumed: resumedExactly,
          resumedHasOurs: said(resumed, "iirc", "about to restart"),
          sessions: everything.flatMap(({ news }) =>
            news.flatMap((one) => (one._tag === "SessionBegan" ? [one._tag] : []))
          ).length,
        };
      })
    );

    expect(result).toStrictEqual({
      listed: [{ network: "private", status: { _tag: "Running" } }],
      recovered: "Journaled",
      refolded: true,
      resumed: true,
      resumedHasOurs: true,
      sessions: 2,
    });
  }, 90_000);
});

describe("ngircd, paced and stopped gracefully", () => {
  let ngircd: Ircd;

  beforeAll(async () => {
    ngircd = await startNgircd();
  });

  afterAll(async () => {
    await ngircd.stop();
  });

  it("paces 20 Lines said in a row: all heard in order, a burst, then one about every 2 s", async () => {
    const lines = 20;

    const result = await run(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);
        const daemon = yield* startDaemon({ dataDir }, key);
        const { api } = daemon;

        const peer = yield* Effect.promise(
          async () =>
            await connectPeer({ host: ngircd.host, nick: "counter", port: ngircd.plainPort })
        );

        peer.send(`JOIN ${channel}`);
        yield* api.networks.configure({
          params: { network },
          payload: configured({
            channels: [{ name: channel }],
            ircds: [{ host: ngircd.host, port: ngircd.plainPort, tls: false }],
            nicks: ["iirc"],
          }),
          query: {},
        });
        yield* joined(api);

        // Long enough idle for the bucket to fill again after registering and joining.
        yield* Effect.sleep("10 seconds");

        const started = performance.now();

        for (let index = 1; index <= lines; index += 1) {
          yield* api.networks.say({
            params: { network },
            payload: { kind: "Privmsg", target: channel, text: `paced ${index}` },
          });
        }

        // Each must be the next Message from us, in turn: one out of order fails.
        const heard = yield* Effect.forEach(
          Array.from({ length: lines }, (_, index) => index + 1),
          (index) =>
            Effect.promise(
              async () =>
                await peer.waitFor(
                  (each) => each.command === "PRIVMSG" && each.source?.split("!")[0] === "iirc",
                  `paced ${index}`,
                  10_000
                )
            ).pipe(Effect.map((line) => ({ at: line.at - started, text: line.params[1] })))
        );

        const known = yield* api.networks.known({ params: { network } });

        const happened = yield* followNews(api, 0, (all) =>
          all.some(({ news }) =>
            news.some((one) => one._tag === "Message" && one.text === `paced ${lines}`)
          )
        );

        peer.close();
        yield* daemon.stop;

        const gaps = heard.slice(1).map((each, index) => each.at - (heard[index]?.at ?? 0));

        return {
          ended: endings(happened),
          gaps,
          heard,
          session: known.session._tag,
        };
      })
    );

    // Printed so a run shows the timing it checked.
    console.log(result.heard.map(({ at, text }) => `${Math.round(at)} ms ${text}`).join("\n"));

    const [first, ...rest] = result.heard;
    const quick = result.gaps.filter((gap) => gap < 1000).length;
    const paced = result.gaps.slice(5).every((gap) => gap > 1500 && gap < 3000);

    expect({
      ended: result.ended,
      firstSoon: (first?.at ?? Number.POSITIVE_INFINITY) < 1500,
      order: result.heard.map(({ text }) => text),
      paced,
      // The burst: at most 4 quick gaps between its 5 Lines, then the steady pace.
      quickAtMostBurst: quick <= 4,
      session: result.session,
      tookPaced: (rest.at(-1)?.at ?? 0) > 25_000,
    }).toStrictEqual({
      ended: [],
      firstSoon: true,
      order: Array.from({ length: lines }, (_, index) => `paced ${index + 1}`),
      paced: true,
      quickAtMostBurst: true,
      session: "Registered",
      tookPaced: true,
    });
  }, 120_000);

  it("says QUIT on stopping, hangs up, and stops within the bound", async () => {
    const result = await run(stopGracefully(ngircd, "watcher"));

    expect(result).toStrictEqual({
      ended: { _tag: "Closed", reason: "HungUp" },
      quit: "QUIT",
      within: true,
    });
  }, 90_000);
});

describe("Ergo, over TLS with SASL PLAIN", () => {
  let ergo: Ircd;

  beforeAll(async () => {
    ergo = await startErgo();
  }, 120_000);

  afterAll(async () => {
    await ergo.stop();
  });

  it("logs in with a Credential set through the API, trusting Ergo's root, never skipping verification", async () => {
    const password = "a-password-only-the-vault-holds";

    const result = await run(
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await registerAccount({
            account: "iirc",
            host: ergo.host,
            password,
            port: ergo.plainPort,
          });
        });

        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);
        const tlsPort = ergo.tlsPort ?? 0;

        // The Daemon dials `ergo.test`, routed to loopback, and checks the certificate
        // against that name with Ergo's own root added to the system's.
        const daemon = yield* startDaemon(
          {
            dataDir,
            transport: {
              route: () => Effect.succeed({ host: ergo.host, port: tlsPort }),
              trust: [ergo.ca ?? ""],
            },
          },
          key
        );

        const { api } = daemon;
        const credential = CredentialPathName.make("ergo-password");

        yield* api.credentials.set({
          params: { name: credential },
          payload: { value: Redacted.make(password) },
        });

        const peer = yield* Effect.promise(
          async () => await connectPeer({ host: ergo.host, nick: "peer", port: ergo.plainPort })
        );

        peer.send(`JOIN ${channel}`);
        yield* api.networks.configure({
          params: { network },
          payload: configured({
            channels: [{ name: channel }],
            ircds: [{ host: "ergo.test", port: tlsPort, tls: true }],
            login: { _tag: "Sasl", account: "iirc", credential, required: true },
            nicks: ["iirc"],
          }),
          query: {},
        });
        const known = yield* joined(api);

        yield* api.networks.say({
          params: { network },
          payload: { kind: "Privmsg", target: channel, text: "hello over TLS" },
        });
        yield* Effect.promise(
          async () =>
            await peer.waitFor(
              (line) => line.command === "PRIVMSG" && line.params[1] === "hello over TLS",
              "the Daemon's Message"
            )
        );
        peer.send(`PRIVMSG ${channel} :hello back`);
        const happened = yield* followNews(api, 0, (all) => said(all, "peer", "hello back"));
        const inspected = yield* api.networks.inspect({ params: { network } });
        const names = yield* api.credentials.list();

        peer.close();
        yield* daemon.stop;

        const confirmed = happened.some(({ news }) => news.some((one) => one._tag === "Confirmed"));

        return {
          account: known.self?.account,
          confirmed,
          features: inspected.client.features.some((feature) => feature === "sasl"),
          names,
          session: known.session._tag,
          shown: JSON.stringify(happened).includes(password),
        };
      })
    );

    expect(result).toMatchObject({
      account: { _tag: "Known", value: "iirc" },
      confirmed: true,
      features: true,
      names: { names: ["ergo-password"] },
      session: "Registered",
      shown: false,
    });
  }, 120_000);

  it("says QUIT on stopping, hangs up, and stops within the bound", async () => {
    const result = await run(stopGracefully(ergo, "watcher"));

    expect(result).toStrictEqual({
      ended: { _tag: "Closed", reason: "HungUp" },
      quit: "QUIT",
      within: true,
    });
  }, 90_000);

  it("refuses Ergo's certificate without its root, and never falls back to plaintext", async () => {
    const result = await run(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);
        const tlsPort = ergo.tlsPort ?? 0;

        const daemon = yield* startDaemon(
          {
            dataDir,
            transport: { route: () => Effect.succeed({ host: ergo.host, port: tlsPort }) },
          },
          key
        );

        yield* daemon.api.networks.configure({
          params: { network },
          payload: configured({ ircds: [{ host: "ergo.test", port: tlsPort, tls: true }] }),
          query: {},
        });

        const happened = yield* followNews(daemon.api, 0, (all) =>
          all.some(({ news }) => news.some((one) => one._tag === "ConnectionFailed"))
        );

        const inspected = yield* daemon.api.networks.inspect({ params: { network } });

        yield* daemon.stop;

        return {
          failed: happened.flatMap(({ news }) =>
            news.flatMap((one) => (one._tag === "ConnectionFailed" ? [one.reason] : []))
          ),
          network: inspected.client.states.find((one) => one.machine === "network")?.state,
        };
      })
    );

    expect(result).toStrictEqual({
      failed: [{ _tag: "Closed", reason: "Tls" }],
      network: "Waiting",
    });
  }, 60_000);
});
