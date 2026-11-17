/**
 * End-to-end runs: a real Daemon, driven only through its HTTP API, on private Ircds, with
 * a raw IRC connection as the other User. They are run on purpose with `bun run e2e`, and
 * never in `bun run test`.
 */
import { CallerIntent, CredentialPathName, NetworkId } from "@iirc/api";
import type { ActionRequest, Happened, LookupRequest, Member, TimelineItem } from "@iirc/api";
import { SendableMessageId } from "@iirc/client";
import { configured } from "@iirc/client/testing";
import { Effect, Fiber, Redacted } from "effect";
import type { Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ngircdOperName, ngircdOperPassword, startErgo, startNgircd } from "../testing/ircd.ts";
import type { Ircd } from "../testing/ircd.ts";
import { connectPeer, registerAccount } from "../testing/peer.ts";
import type { Parsed, Peer } from "../testing/peer.ts";
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

// An answer to Self's `OPER`, as News.
const answered = (news: Happened["news"][number]) =>
  news._tag === "Activity" &&
  (news.activity._tag === "OperGranted" || news.activity._tag === "OperRefused");

const sequences = (happened: readonly Happened[]) => happened.map((one) => one.sequence);

const sent = (item: TimelineItem, sender: string, text: string) =>
  item.content._tag === "Message" && item.content.sender === sender && item.content.text === text;

// A Timeline's Messages, as the Owner reads them: what each says, what it answers by id,
// and what that is, resolved in the same Timeline.
const reading = (api: Api, name: string) =>
  Effect.gen(function* () {
    const listed = yield* api.timelines.list({ params: { network }, query: {} });
    const timeline = listed.timelines.find((one) => one.name === name);

    if (timeline === undefined) {
      return yield* Effect.die(`${name} was not listed`);
    }

    const window = yield* api.timelines.window({ params: { timeline: timeline.id }, query: {} });

    return window.items.flatMap((item) =>
      item.content._tag === "Message"
        ? [
            {
              answered: item.answered === null ? null : item.answered.text,
              answers: item.content.answers,
              id: item.content.id._tag === "Known" ? item.content.id.value : undefined,
              level: item.level,
              sender: item.content.sender,
              text: item.content.text,
            },
          ]
        : []
    );
  });

// Registering an account logs a Peer's Connection in to it, named as its nick is.
const register = (peer: Peer) =>
  Effect.promise(async () => {
    peer.send("REGISTER * * a-password-nobody-reads");
    await peer.waitFor((line) => line.command === "REGISTER", "REGISTER's reply");
  });

// Each member's account, as the members route gives it: the account, `null` for logged out,
// or the fact's tag.
const accounts = (page: { readonly members: readonly Member[] }) =>
  Object.fromEntries(
    page.members.map(({ account, nick }) => [
      nick,
      account._tag === "Known" ? account.value : account._tag,
    ])
  );

// The Network's own Timeline, as the Owner reads it, and its Numeric items in order.
const networkTimeline = (api: Api) =>
  Effect.gen(function* () {
    const listed = yield* api.timelines.list({ params: { network }, query: {} });
    const timeline = listed.timelines.find((one) => one.kind === "Network");

    if (timeline === undefined) {
      return yield* Effect.die("the Network's Timeline was not listed");
    }

    const window = yield* api.timelines.window({ params: { timeline: timeline.id }, query: {} });

    return {
      items: window.items.flatMap((item) =>
        item.content._tag === "Activity" && item.content.activity._tag === "Numeric"
          ? [
              {
                level: item.level,
                numeric: item.content.activity.numeric,
                params: item.content.activity.params,
                sequence: item.sequence,
              },
            ]
          : []
      ),
      later: window.later,
      unread: timeline.unread,
    };
  });

const numericsOf = (items: readonly { readonly numeric: string }[]) =>
  items.map(({ numeric }) => numeric);

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

/**
 * Sets a ban as a Channel's operator and reads its lists back, and reads another Channel's
 * as one of its members only, as Lookups. A Peer makes the other Channel, so it is its
 * operator, and bans a mask there first.
 * @param ircd - The Ircd, by its plaintext port.
 * @returns What each Lookup found.
 */
const masksOn = (ircd: Ircd) =>
  Effect.gen(function* () {
    const ours = "#iirc-lists";
    const theirs = "#iirc-theirs";
    const dataDir = yield* temporaryDirectory;
    const key = yield* makeKey(dataDir);
    const daemon = yield* startDaemon({ dataDir }, key);
    const { api } = daemon;

    const peer = yield* Effect.promise(
      async () => await connectPeer({ host: ircd.host, nick: "owner", port: ircd.plainPort })
    );

    peer.send(`JOIN ${theirs}`);
    peer.send(`MODE ${theirs} +b spam!*@*`);
    yield* Effect.promise(
      async () => await peer.waitFor((line) => line.command === "MODE", "the Peer's ban")
    );

    yield* api.networks.configure({
      params: { network },
      payload: configured({
        channels: [{ name: ours }, { name: theirs }],
        ircds: [{ host: ircd.host, port: ircd.plainPort, tls: false }],
        nicks: ["lister"],
      }),
      query: {},
    });

    yield* eventually(api.networks.known({ params: { network } }), (known) =>
      [ours, theirs].every((name) =>
        known.channels.some((one) => one.name === name && one.standing === "Joined")
      )
    );

    // The Ircd answers a Connection's Lines in order, so the list read after it holds the ban.
    const banned = yield* api.networks.act({
      params: { network },
      payload: {
        action: {
          _tag: "Mode",
          changes: [{ mode: "b", param: "bad!*@*", set: true }],
          target: ours,
        },
      },
    });

    const look = (lookup: LookupRequest) =>
      api.networks
        .look({ params: { network }, payload: { lookup } })
        .pipe(Effect.map((looked) => (looked._tag === "LookedUp" ? looked.result : looked)));

    const bans = yield* look({ _tag: "Bans", channel: ours });
    const exceptions = yield* look({ _tag: "Exceptions", channel: ours });
    const invitations = yield* look({ _tag: "Invitations", channel: ours });
    const others = yield* look({ _tag: "Bans", channel: theirs });
    const otherExceptions = yield* look({ _tag: "Exceptions", channel: theirs });
    const nowhere = yield* look({ _tag: "Bans", channel: "#iirc-nowhere" });

    peer.close();
    yield* daemon.stop;

    // Who set a mask and when vary by Ircd, so only whether each was said is compared.
    const shown = (result: typeof bans) =>
      result._tag === "Listed"
        ? result.masks.map((one) => ({
            mask: one.mask,
            setAt: one.setAt !== null,
            setBy: one.setBy?.split("!")[0] ?? null,
          }))
        : result;

    return {
      banned: banned._tag,
      bans: shown(bans),
      exceptions: shown(exceptions),
      invitations: shown(invitations),
      nowhere,
      otherExceptions: shown(otherExceptions),
      others: shown(others),
    };
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

  // Opers with a Credential set through the API, and reads the answer from News. The
  // password reaches neither News nor any file of the data directory.
  const operWith = (password: string, nick: string) =>
    Effect.gen(function* () {
      const dataDir = yield* temporaryDirectory;
      const key = yield* makeKey(dataDir);
      const daemon = yield* startDaemon({ dataDir }, key);
      const { api } = daemon;
      const credential = CredentialPathName.make("oper-password");

      yield* api.credentials.set({
        params: { name: credential },
        payload: { value: Redacted.make(password) },
      });
      yield* api.networks.configure({
        params: { network },
        payload: configured({
          ircds: [{ host: ngircd.host, port: ngircd.plainPort, tls: false }],
          nicks: [nick],
          oper: { _tag: "Login", credential, name: ngircdOperName },
        }),
        query: {},
      });

      const happened = yield* followNews(api, 0, (all) =>
        all.some((one) => one.news.some(answered))
      );

      yield* daemon.stop;

      const stored = yield* Effect.promise(
        async () =>
          await Promise.all(
            ["journal.sqlite", "journal.sqlite-wal", "views.sqlite", "views.sqlite-wal"].map(
              async (name) => {
                const file = Bun.file(`${dataDir}/${name}`);

                return (await file.exists()) ? await file.text() : "";
              }
            )
          )
      );

      return {
        answer: happened.flatMap(({ news }) =>
          news.flatMap((one) =>
            one._tag === "Activity" && answered(one) ? [{ ...one.activity, where: one.where }] : []
          )
        ),
        shown: JSON.stringify(happened).includes(password),
        stored: stored.some((text) => text.includes(password)),
      };
    });

  it("opers as the Session begins, reports it granted, and never journals the Credential", async () => {
    const result = await run(operWith(ngircdOperPassword, "operator"));

    expect(result).toStrictEqual({
      answer: [{ _tag: "OperGranted", nick: "operator", where: [{ _tag: "Network" }] }],
      shown: false,
      stored: false,
    });
  }, 60_000);

  it("reports an OPER the Ircd refused by its numeric, and never journals the Credential", async () => {
    const result = await run(operWith("not-the-oper-password", "refused"));

    expect(result).toStrictEqual({
      answer: [
        { _tag: "OperRefused", nick: "refused", reply: "464", where: [{ _tag: "Network" }] },
      ],
      shown: false,
      stored: false,
    });
  }, 60_000);

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

  it("says a Message that answers another without a tag, where the Ircd offers no tags", async () => {
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
          payload: {
            answers: SendableMessageId.make("not-a-msgid-here"),
            kind: "Privmsg",
            target: channel,
            text: "an answer",
          },
        });

        const heard = yield* Effect.promise(
          async () =>
            await peer.waitFor(
              (line) => line.command === "PRIVMSG" && line.params[1] === "an answer",
              "the Daemon's Message"
            )
        );

        const messages = yield* reading(api, channel);

        peer.close();
        yield* daemon.stop;

        return {
          heardTags: [...heard.tags],
          messages: messages.map(({ answers, text }) => [text, answers]),
          said: saying._tag,
          tags: known.session._tag === "Registered" ? known.session.tags : undefined,
        };
      })
    );

    expect(result).toStrictEqual({
      heardTags: [],
      messages: [["an answer", null]],
      said: "Said",
      tags: false,
    });
  }, 60_000);

  it("looks the other User up, and a nick no one holds or held", async () => {
    const result = await run(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);
        const daemon = yield* startDaemon({ dataDir }, key);
        const { api } = daemon;

        const peer = yield* Effect.promise(
          async () => await connectPeer({ host: ngircd.host, nick: "seen", port: ngircd.plainPort })
        );

        peer.send(`JOIN ${channel}`);

        // A nick of its own: ngircd holds back what a client sends after a burst of
        // Lookups, so the Daemon's QUIT may land after the next test registers.
        yield* api.networks.configure({
          params: { network },
          payload: { ...floor(), nicks: ["looker"] },
          query: {},
        });
        yield* joined(api);

        const look = (lookup: LookupRequest) =>
          api.networks.look({ params: { network }, payload: { lookup } });

        const whois = yield* look({ _tag: "Whois", nick: "seen" });
        // ngircd keeps no history of a connection as short as a test's, so this one is
        // never found, as a nick no one held is not.
        const whowas = yield* look({ _tag: "Whowas", nick: "neverwas" });
        const nobody = yield* look({ _tag: "Whois", nick: "nobody" });

        const found =
          whois._tag === "LookedUp" && whois.result._tag === "Found"
            ? whois.result.profiles[0]
            : undefined;

        const stored = yield* api.networks.looked({ params: { intent: whois.intent, network } });

        peer.close();
        yield* daemon.stop;

        return {
          channels: found?.channels.map((one) => one.name),
          nick: found?.nick,
          nobody: nobody._tag === "LookedUp" ? nobody.result : nobody,
          server: found?.server !== null && found?.server.name !== "",
          stored: stored._tag === "LookedUp" ? stored.result._tag : stored._tag,
          user: found?.user !== null && found?.user !== undefined,
          whowas: whowas._tag === "LookedUp" ? whowas.result : whowas,
        };
      })
    );

    expect(result).toStrictEqual({
      channels: [channel],
      nick: "seen",
      nobody: { _tag: "NotFound", notes: [], reply: "401" },
      server: true,
      stored: "Found",
      user: true,
      whowas: { _tag: "NotFound", notes: [], reply: "406" },
    });
  }, 60_000);

  it("sets a ban and reads it back, and a Channel's lists as one of its members only", async () => {
    const result = await run(masksOn(ngircd));

    expect(result).toStrictEqual({
      banned: "Acted",
      bans: [{ mask: "bad!*@*", setAt: true, setBy: "lister" }],
      exceptions: [],
      invitations: [],
      nowhere: { _tag: "NotFound", notes: [], reply: "403" },
      // ngircd shows a Channel's exceptions to any member.
      otherExceptions: [],
      others: [{ mask: "spam!*@*", setAt: true, setBy: "owner" }],
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
      listed: [{ _tag: "Live", life: 1, network: "private", status: { _tag: "Running" } }],
      recovered: "Journaled",
      refolded: true,
      resumed: true,
      resumedHasOurs: true,
      sessions: 2,
    });
  }, 90_000);

  it("shows the numerics nothing else reports in the Network's Timeline, never unread, and the same after a restart", async () => {
    const result = await run(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);

        const first = yield* startDaemon({ dataDir }, key);

        yield* first.api.networks.configure({ params: { network }, payload: floor(), query: {} });
        yield* joined(first.api);

        const before = yield* networkTimeline(first.api);

        yield* first.stop;

        const second = yield* startDaemon({ dataDir }, key);

        // The second Session's own numerics come after the first's, so wait for them.
        yield* joined(second.api);

        const after = yield* eventually(networkTimeline(second.api), (read) =>
          read.items.some(({ sequence }) => sequence > (before.items.at(-1)?.sequence ?? 0))
        );

        yield* second.stop;

        return { after, before };
      })
    );

    const { after, before } = result;
    const welcome = before.items.find(({ numeric }) => numeric === "001");
    const users = before.items.find(({ numeric }) => numeric === "251");

    // A restart refolds the first Session's numerics as they were, and the second Session
    // adds its own once, so none is doubled.
    expect({
      // The welcome and the count of Users, with the params after the one naming Self.
      counts: users?.params.map((param) => param.includes("users")),
      doubled: numericsOf(after.items),
      // Nothing else reports these, and a Channel's names go to the Channel's own Timeline.
      hidden: ["005", "353", "366"].filter((numeric) => numericsOf(before.items).includes(numeric)),
      replayed: after.items.slice(0, before.items.length),
      unread: [
        before.items.every(({ level }) => level === null),
        before.unread.messages,
        before.unread.highlights,
      ],
      welcome: welcome?.params.map((param) => param.includes("iirc")),
    }).toStrictEqual({
      counts: [true],
      doubled: [...numericsOf(before.items), ...numericsOf(before.items)],
      hidden: [],
      replayed: before.items,
      unread: [true, 0, 0],
      welcome: [true],
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

        // Labelled, so each reply is collected by its label.
        const self = yield* api.networks.look({
          params: { network },
          payload: { lookup: { _tag: "Whois", nick: "iirc" } },
        });

        const other = yield* api.networks.look({
          params: { network },
          payload: { lookup: { _tag: "Whois", nick: "peer" } },
        });

        const leaving = yield* Effect.promise(
          async () => await connectPeer({ host: ergo.host, nick: "leaver", port: ergo.plainPort })
        );

        leaving.send("QUIT :bye");
        yield* Effect.promise(
          async () => await leaving.waitFor((line) => line.command === "ERROR", "the Ircd's ERROR")
        );

        const left = yield* api.networks.look({
          params: { network },
          payload: { lookup: { _tag: "Whowas", nick: "leaver" } },
        });

        const profileOf = (looked: typeof self) =>
          looked._tag === "LookedUp" && looked.result._tag === "Found"
            ? looked.result.profiles[0]
            : undefined;

        peer.close();
        yield* daemon.stop;

        const confirmed = happened.some(({ news }) => news.some((one) => one._tag === "Confirmed"));

        return {
          account: known.self?.account,
          confirmed,
          features: inspected.client.features.some((feature) => feature === "sasl"),
          left:
            left._tag === "LookedUp" && left.result._tag === "Found"
              ? left.result.profiles.map((one) => one.nick)
              : left,
          names,
          other: {
            account: profileOf(other)?.account,
            channels: profileOf(other)?.channels.map((one) => one.name),
            nick: profileOf(other)?.nick,
          },
          self: {
            account: profileOf(self)?.account,
            channels: profileOf(self)?.channels.map((one) => one.name),
            secure: profileOf(self)?.secure,
          },
          session: known.session._tag,
          shown: JSON.stringify(happened).includes(password),
        };
      })
    );

    expect(result).toMatchObject({
      account: { _tag: "Known", value: "iirc" },
      confirmed: true,
      features: true,
      left: ["leaver"],
      names: { names: ["ergo-password"] },
      other: { account: null, channels: [channel], nick: "peer" },
      self: { account: "iirc", channels: [channel], secure: true },
      session: "Registered",
      shown: false,
    });
  }, 120_000);

  it("sets a ban and reads it back, and a Channel's lists as one of its members only", async () => {
    const result = await run(masksOn(ergo));

    expect(result).toStrictEqual({
      banned: "Acted",
      bans: [{ mask: "bad!*@*", setAt: true, setBy: "lister" }],
      exceptions: [],
      invitations: [],
      nowhere: { _tag: "NotFound", notes: [], reply: "403" },
      // Ergo shows a Channel's exceptions only to its operators.
      otherExceptions: { _tag: "Failed", notes: [], reply: "482" },
      others: [{ mask: "spam!*@*", setAt: true, setBy: "owner" }],
    });
  }, 90_000);

  // Ergo answers a NickServ login with a NOTICE alone, with no `900` and no `+r`, so the
  // Channel waits out the bound, and Self's account is known only from the `ACCOUNT` that
  // `account-notify` sends of Self.
  it("logs in by telling NickServ, joins after the bound, and never journals the Credential", async () => {
    const password = "a-service-password-only-the-vault-holds";

    const result = await run(
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await registerAccount({
            account: "svcacct",
            host: ergo.host,
            password,
            port: ergo.plainPort,
          });
        });

        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);
        const daemon = yield* startDaemon({ dataDir }, key);
        const { api } = daemon;
        const credential = CredentialPathName.make("nickserv-password");

        yield* api.credentials.set({
          params: { name: credential },
          payload: { value: Redacted.make(password) },
        });

        // `extended-join` names the account a User joined with, so the Peer sees whether
        // Self was logged in when it joined.
        const peer = yield* Effect.promise(
          async () =>
            await connectPeer({
              caps: ["extended-join"],
              host: ergo.host,
              nick: "witness",
              port: ergo.plainPort,
            })
        );

        peer.send(`JOIN ${channel}`);
        yield* api.networks.configure({
          params: { network },
          payload: configured({
            channels: [{ name: channel }],
            ircds: [{ host: ergo.host, port: ergo.plainPort, tls: false }],
            login: {
              _tag: "Service",
              account: "svcacct",
              credential,
              service: "NickServ",
              wait: 5,
            },
            nicks: ["servicenick"],
          }),
          query: {},
        });

        const join = yield* Effect.promise(
          async () =>
            await peer.waitFor(
              (line) => line.command === "JOIN" && line.source?.split("!")[0] === "servicenick",
              "the Daemon's JOIN"
            )
        );

        const known = yield* joined(api);
        const happened = yield* followNews(api, 0, (all) => all.length > 0);

        const self = yield* api.networks.look({
          params: { network },
          payload: { lookup: { _tag: "Whois", nick: "servicenick" } },
        });

        peer.close();
        yield* daemon.stop;

        const stored = yield* Effect.promise(
          async () =>
            await Promise.all(
              ["journal.sqlite", "journal.sqlite-wal", "views.sqlite", "views.sqlite-wal"].map(
                async (name) => {
                  const file = Bun.file(`${dataDir}/${name}`);

                  return (await file.exists()) ? await file.text() : "";
                }
              )
            )
        );

        return {
          account: known.self?.account,
          joinedAs: join.params[1],
          looked:
            self._tag === "LookedUp" && self.result._tag === "Found"
              ? self.result.profiles[0]?.account
              : self,
          shown: JSON.stringify(happened).includes(password),
          stored: stored.some((text) => text.includes(password)),
        };
      })
    );

    expect(result).toMatchObject({
      account: { _tag: "Known", from: "ircd", value: "svcacct" },
      joinedAs: "svcacct",
      looked: "svcacct",
      shown: false,
      stored: false,
    });
  }, 120_000);

  // Ergo has no command that logs a connection out and leaves it connected, so a User logged
  // out is one that joined with `*` for an account, and the account of one logged in later
  // arrives with `ACCOUNT`.
  it("gives each member's account, from how they joined or logged in after, in the members and a Whois", async () => {
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
            ircds: [{ host: ergo.host, port: ergo.plainPort, tls: false }],
            nicks: ["iirc"],
          }),
          query: {},
        });
        yield* joined(api);

        const connect = (nick: string) =>
          Effect.promise(
            async () =>
              await connectPeer({
                caps: ["draft/account-registration"],
                host: ergo.host,
                nick,
                port: ergo.plainPort,
              })
          );

        const anon = yield* connect("anon");
        const member = yield* connect("member");
        const late = yield* connect("late");

        yield* register(member);
        anon.send(`JOIN ${channel}`);
        member.send(`JOIN ${channel}`);
        late.send(`JOIN ${channel}`);

        const listed = yield* api.timelines.list({ params: { network }, query: {} });
        const timeline = listed.timelines.find((one) => one.name === channel)?.id;

        if (timeline === undefined) {
          return yield* Effect.die("the Channel's Timeline was not listed");
        }

        const members = api.timelines.members({ params: { timeline }, query: {} });

        // Each joined as `extended-join` says: with an account, or with none.
        const onJoining = yield* eventually(members, (page) =>
          ["anon", "member", "late"].every((nick) => nick in accounts(page))
        );

        yield* register(late);

        const afterLogin = yield* eventually(members, (page) => accounts(page).late === "late");

        const whois = yield* api.networks.look({
          params: { network },
          payload: { lookup: { _tag: "Whois", nick: "member" } },
        });

        for (const peer of [anon, member, late]) {
          peer.close();
        }

        yield* daemon.stop;

        return {
          afterLogin: accounts(afterLogin),
          onJoining: accounts(onJoining),
          whois:
            whois._tag === "LookedUp" && whois.result._tag === "Found"
              ? whois.result.profiles.map((one) => [one.nick, one.account])
              : whois,
        };
      })
    );

    expect(result).toStrictEqual({
      afterLogin: { anon: null, iirc: "Unknown", late: "late", member: "member" },
      onJoining: { anon: null, iirc: "Unknown", late: null, member: "member" },
      whois: [["member", "member"]],
    });
  }, 120_000);

  // Ergo offers `WHOX`, so the Daemon's own `WHO` on joining tells the account and away
  // status of members who were there first, which no Line about them has said since.
  it("learns who was there before it joined, away and with an account, with no Activity for each", async () => {
    const result = await run(
      Effect.gen(function* () {
        const there = yield* Effect.promise(
          async () =>
            await connectPeer({
              caps: ["draft/account-registration"],
              host: ergo.host,
              nick: "there",
              port: ergo.plainPort,
            })
        );

        yield* register(there);
        there.send(`JOIN ${channel}`);
        there.send("AWAY :out to lunch");
        yield* Effect.promise(
          async () => await there.waitFor((line) => line.command === "306", "306, away")
        );

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
            whoOnJoin: true,
          }),
          query: {},
        });
        yield* joined(api);

        const listed = yield* api.timelines.list({ params: { network }, query: {} });
        const timeline = listed.timelines.find((one) => one.name === channel)?.id;

        if (timeline === undefined) {
          return yield* Effect.die("the Channel's Timeline was not listed");
        }

        const page = yield* eventually(
          api.timelines.members({ params: { timeline }, query: {} }),
          (members) =>
            members.members.some(
              (member) =>
                member.nick === "there" &&
                member.account._tag === "Known" &&
                member.away._tag === "Known"
            )
        );

        const window = yield* api.timelines.window({ params: { timeline }, query: {} });

        there.close();
        yield* daemon.stop;

        const member = page.members.find((one) => one.nick === "there");

        return {
          account: member?.account._tag === "Known" ? member.account.value : member?.account,
          activity: window.items.flatMap((item) =>
            item.content._tag === "Activity" ? [item.content.activity._tag] : []
          ),
          away: member?.away._tag === "Known" ? member.away.value !== null : member?.away,
        };
      })
    );

    expect(result).toStrictEqual({ account: "there", activity: ["Joined"], away: true });
  }, 120_000);

  it("says a Message that answers another with a +reply tag the other User hears, and shows Self's reply as one", async () => {
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
            ircds: [{ host: ergo.host, port: ergo.plainPort, tls: false }],
            nicks: ["iirc"],
          }),
          query: {},
        });
        yield* joined(api);

        const peer = yield* Effect.promise(
          async () =>
            await connectPeer({
              caps: ["message-tags"],
              host: ergo.host,
              nick: "peer",
              port: ergo.plainPort,
            })
        );

        peer.send(`JOIN ${channel}`);
        peer.send(`PRIVMSG ${channel} :a question`);

        const asked = yield* eventually(reading(api, channel), (all) =>
          all.some(({ id, text }) => text === "a question" && id !== undefined)
        );

        const question = asked.find(({ text }) => text === "a question")?.id;

        if (question === undefined) {
          return yield* Effect.die("the question has no id");
        }

        const saying = yield* api.networks.say({
          params: { network },
          payload: {
            answers: SendableMessageId.make(question),
            kind: "Privmsg",
            target: channel,
            text: "an answer",
          },
        });

        const heard = yield* Effect.promise(
          async () =>
            await peer.waitFor(
              (line) => line.command === "PRIVMSG" && line.params[1] === "an answer",
              "the Daemon's reply"
            )
        );

        const messages = yield* eventually(reading(api, channel), (all) =>
          all.some(({ answers, sender }) => sender === "iirc" && answers !== null)
        );

        const known = yield* api.networks.known({ params: { network } });

        peer.close();
        yield* daemon.stop;

        return {
          heard: heard.tags.get("+reply") === question,
          messages: messages.map(({ answered, answers, level, sender, text }) => [
            sender,
            text,
            answers === question ? "the question" : answers,
            answered,
            level,
          ]),
          said: saying._tag,
          tags: known.session._tag === "Registered" ? known.session.tags : undefined,
        };
      })
    );

    expect(result).toStrictEqual({
      heard: true,
      messages: [
        ["peer", "a question", null, null, "Message"],
        ["iirc", "an answer", "the question", "a question", null],
      ],
      said: "Said",
      tags: true,
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
