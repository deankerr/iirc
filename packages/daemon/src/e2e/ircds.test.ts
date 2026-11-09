/**
 * End-to-end runs: a real Daemon, driven only through its HTTP API, on private Ircds, with
 * a raw IRC connection as the other User. They are run on purpose with `bun run e2e`, and
 * never in `bun run test`.
 */
import { CallerIntent, CredentialPathName, NetworkId } from "@iirc/api";
import type { Happened } from "@iirc/api";
import { configured } from "@iirc/client/testing";
import { Effect, Redacted } from "effect";
import type { Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startErgo, startNgircd } from "../testing/ircd.ts";
import type { Ircd } from "../testing/ircd.ts";
import { connectPeer, registerAccount } from "../testing/peer.ts";
import { eventually, followNews, startDaemon } from "../testing/running.ts";
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

const joined = (api: Api) =>
  eventually(api.networks.known({ params: { network } }), (known) =>
    known.channels.some((one) => one.name === channel && one.standing === "Joined")
  );

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

  it("configures, registers, joins, says, and hears the other User as News", async () => {
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
        yield* api.networks.configure({ params: { network }, payload: floor() });
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

        peer.send(`PRIVMSG ${channel} :hello from peer`);

        const happened = yield* followNews(api, 0, (all) => said(all, "peer", "hello from peer"));

        const inspected = yield* api.networks.inspect({ params: { network } });

        peer.close();
        yield* daemon.stop;

        return {
          features: inspected.client.features,
          heardFrom: heard.source?.split("!")[0],
          ours: said(happened, "iirc", "hello from iirc"),
          peer: said(happened, "peer", "hello from peer"),
          session: known.session._tag,
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
      wasSaid: true,
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

        yield* first.api.networks.configure({ params: { network }, payload: floor() });
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
