/**
 * `BOT`: where the Ircd names a bot mode, the Client knows which Users are bots, from the
 * `bot` tag, from `WHO` flags, and from a `WHOIS`'s `335`, marks a bot's Message, and sets
 * the mode on Self as a Session begins when the Configuration says Self is a bot. Where it
 * names none, or names it badly, nothing changes, and nothing more is sent.
 */
import { describe, expect, it } from "vitest";

import { client, makeClient } from "../core.ts";
import type { Feature } from "../feature.ts";
import { FeatureName } from "../ids.ts";
import type { LookResult, News } from "../news.ts";
import { register, registry } from "../registry.ts";
import type { State } from "../state.ts";
import {
  configured,
  describeOutput,
  floorIsupport,
  joined,
  play,
  registered,
} from "../testing/index.ts";
import type { Played } from "../testing/index.ts";

const base = configured();
const asBot = configured({ bot: true });

const bot = [...floorIsupport, "BOT=B"];

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const played = (transcript: readonly string[], configuration = base, custom = client) =>
  play(custom, { configuration, transcript });

// Self is in `#iirc` with `robo` and `peer`.
const inChannel = ({
  isupport = bot,
  offered = ["message-tags"],
}: { readonly isupport?: readonly string[]; readonly offered?: readonly string[] } = {}) => [
  registered(base, { isupport, offered }),
  joined(base, "#iirc", ["robo", "peer"]),
];

const userOf = (run: Played<State>, nick: string) => client.known(run.state).users.get(nick);

// Every `MODE` on Self the Client sent.
const modesOnSelf = (run: Played<State>): readonly string[] =>
  run.steps
    .flatMap((step) => step.outputs)
    .flatMap((output) => (output._tag === "Send" ? [describeOutput(output)] : []))
    .filter((sent) => sent.startsWith(">> MODE iirc"));

const lookedUp = (run: Played<State>): LookResult | undefined =>
  run.steps
    .flatMap((step) => step.news)
    .find((news): news is Extract<News, { _tag: "LookedUp" }> => news._tag === "LookedUp")?.result;

const known = (value: boolean) => ({ _tag: "Known", from: "ircd", value });
const unknown = { _tag: "Unknown" };

// A Session that answers the Client's next `PING`, so every Line it sent is written before it.
const quiet = lines("<< PING :still", ">> PONG still");

// Every Line in a batch is history, as `chathistory` will make it.
const history: Feature = {
  label: (arrival) => ({
    value: arrival.batch === undefined ? arrival : { ...arrival, live: false },
  }),
  name: FeatureName.make("history"),
  needs: {},
  own: undefined,
};

const withHistory = makeClient([...registry, register(history)]);

describe("the bot tag", () => {
  it("marks the sender and their Message, whatever its value", () => {
    const run = played([
      ...inChannel(),
      lines(
        "<< @bot :robo!u@h PRIVMSG #iirc :beep",
        "?? message Privmsg robo #iirc bot in=channel:#iirc :beep",
        "<< @bot=anything :peer!u@h NOTICE #iirc :boop",
        "?? message Notice peer #iirc bot in=channel:#iirc :boop"
      ),
    ]);

    expect(userOf(run, "robo")?.bot).toMatchObject(known(true));
    expect(userOf(run, "peer")?.bot).toMatchObject(known(true));
  });

  it("marks the sender of an Activity, by the nick they have after it", () => {
    const run = played([...inChannel(), lines("<< @bot :robo!u@h NICK robot")]);

    expect(userOf(run, "robot")?.bot).toMatchObject(known(true));
  });

  it("says a User is not a bot by its absence, while the Session carries tags", () => {
    const run = played([
      ...inChannel(),
      lines(
        "<< @bot :robo!u@h PRIVMSG #iirc :beep",
        "<< :robo!u@h PRIVMSG #iirc :human now",
        "?? message Privmsg robo #iirc in=channel:#iirc :human now"
      ),
    ]);

    expect(userOf(run, "robo")?.bot).toMatchObject(known(false));
  });

  it("says nothing by its absence without tags", () => {
    const run = played([
      ...inChannel({ offered: [] }),
      lines(
        "<< @bot :robo!u@h PRIVMSG #iirc :beep",
        "<< :robo!u@h PRIVMSG #iirc :still a bot",
        "<< :peer!u@h PRIVMSG #iirc :hi"
      ),
    ]);

    expect(userOf(run, "robo")?.bot).toMatchObject(known(true));
    expect(userOf(run, "peer")?.bot).toStrictEqual(unknown);
  });

  it("marks a Message from history, and changes no one", () => {
    const run = played(
      [
        ...inChannel({ offered: ["message-tags", "batch"] }),
        lines(
          "<< :irc.test BATCH +h chathistory #iirc",
          "<< @batch=h;bot :robo!u@h PRIVMSG #iirc :old",
          "?? message Privmsg robo #iirc history bot in=channel:#iirc :old",
          "<< :irc.test BATCH -h"
        ),
      ],
      base,
      withHistory
    );

    expect(userOf(run, "robo")?.bot).toStrictEqual(unknown);
  });

  it.each([
    ["no BOT", floorIsupport],
    ["an empty BOT", [...floorIsupport, "BOT="]],
    ["a BOT of two letters", [...floorIsupport, "BOT=Bb"]],
    ["a BOT that is no letter", [...floorIsupport, "BOT=+"]],
  ])("marks no one with %s", (_why, isupport) => {
    const run = played([
      ...inChannel({ isupport }),
      lines(
        "<< @bot :robo!u@h PRIVMSG #iirc :beep",
        "?? message Privmsg robo #iirc in=channel:#iirc :beep",
        "<< :peer!u@h PRIVMSG #iirc :hi"
      ),
    ]);

    expect(userOf(run, "robo")?.bot).toStrictEqual(unknown);
    expect(userOf(run, "peer")?.bot).toStrictEqual(unknown);
  });

  it("goes stale when the Ircd takes BOT back", () => {
    const run = played([
      ...inChannel(),
      lines(
        "<< @bot :robo!u@h PRIVMSG #iirc :beep",
        "<< :irc.test 005 iirc -BOT :are supported by this server",
        "<< @bot :peer!u@h PRIVMSG #iirc :not read",
        "?? message Privmsg peer #iirc in=channel:#iirc :not read"
      ),
    ]);

    expect(userOf(run, "robo")?.bot).toMatchObject({ _tag: "Stale", was: true });
    expect(userOf(run, "peer")?.bot).toStrictEqual(unknown);
  });
});

describe("Self as a bot", () => {
  it("sets the bot mode once, when ISUPPORT names it after the welcome", () => {
    const run = played(
      [
        registered(asBot, { isupport: bot, offered: ["message-tags"] }),
        lines(
          ">> MODE iirc +B",
          // Sent again, or taken back and given again, it sends nothing more.
          "<< :irc.test 005 iirc BOT=B :are supported by this server",
          "<< :irc.test 005 iirc -BOT :are supported by this server",
          "<< :irc.test 005 iirc BOT=B :are supported by this server",
          "<< :iirc!~iirc@iirc.test MODE iirc +B"
        ),
        quiet,
      ],
      asBot
    );

    expect(client.known(run.state).self?.bot).toMatchObject(known(true));
  });

  it("sets it on the first Line after the welcome, when ISUPPORT named it before", () => {
    const early = registered(asBot, { isupport: floorIsupport }).replace(
      /(?<welcome><< :irc\.test 001 [^\n]*\n)/u,
      "<< :irc.test 005 * BOT=B :are supported by this server\n$<welcome>"
    );

    const run = played(
      [early.replace(/(?<host><< :irc\.test 002 [^\n]*\n)/u, "$<host>>> MODE iirc +B\n"), quiet],
      asBot
    );

    expect(modesOnSelf(run)).toStrictEqual([">> MODE iirc +B"]);
  });

  it("sets it again in the next Session", () => {
    const run = played(
      [
        registered(asBot, { isupport: bot }),
        lines(">> MODE iirc +B", "== closed Reset", "+60s", "..."),
        registered(asBot, { isupport: bot }).replace(/^!! configure\n/u, ""),
        lines(">> MODE iirc +B"),
        quiet,
      ],
      asBot
    );

    expect(modesOnSelf(run)).toStrictEqual([">> MODE iirc +B", ">> MODE iirc +B"]);
  });

  it("knows Self is no longer one when the mode is unset", () => {
    const run = played(
      [
        registered(asBot, { isupport: bot }),
        lines(
          ">> MODE iirc +B",
          "<< :iirc!~iirc@iirc.test MODE iirc +B",
          "<< :iirc!~iirc@iirc.test MODE iirc -B"
        ),
      ],
      asBot
    );

    expect(client.known(run.state).self?.bot).toMatchObject(known(false));
  });

  it.each([
    ["a Configuration that does not say so", base, bot],
    ["no BOT", asBot, floorIsupport],
    ["an empty BOT", asBot, [...floorIsupport, "BOT="]],
    ["a BOT of two letters", asBot, [...floorIsupport, "BOT=Bb"]],
    ["a BOT that is no letter", asBot, [...floorIsupport, "BOT=1"]],
  ])("sends nothing more with %s", (_why, configuration, isupport) => {
    const run = played(
      [registered(configuration, { isupport: [...isupport], offered: ["message-tags"] }), quiet],
      configuration
    );

    expect(modesOnSelf(run)).toStrictEqual([]);
  });
});

const asking = configured({ whoOnJoin: true });

// Self joins `#iirc` and asks who is in it: `robo`'s flags hold `B` after the `H`, and `peer`'s do not.
const answered = (isupport: readonly string[]) =>
  played(
    [
      registered(asking, { isupport }),
      lines(
        "!! configure +#iirc",
        ">> JOIN #iirc",
        "<< :iirc!~iirc@iirc.test JOIN #iirc",
        ">> MODE #iirc",
        "<< :irc.test 353 iirc = #iirc :iirc robo peer",
        "<< :irc.test 366 iirc #iirc :End of /NAMES list.",
        ">> WHO #iirc",
        "<< :irc.test 352 iirc #iirc ~r robo.test irc.test robo H*B@ :0 Robo",
        "<< :irc.test 352 iirc #iirc ~p peer.test irc.test peer G :0 Peer",
        "<< :irc.test 315 iirc #iirc :End of WHO list"
      ),
    ],
    asking
  );

describe("WHO flags", () => {
  it("say a User is a bot by the BOT mode among them, and not one without it", () => {
    const run = answered(bot);

    expect(userOf(run, "robo")?.bot).toMatchObject({ _tag: "Known", value: true });
    expect(userOf(run, "peer")?.bot).toMatchObject({ _tag: "Known", value: false });
  });

  it("say nothing without BOT", () => {
    const run = answered(floorIsupport);

    expect(userOf(run, "robo")?.bot).toStrictEqual(unknown);
    expect(userOf(run, "peer")?.bot).toStrictEqual(unknown);
  });
});

// A `WHOIS` of `robo`, whose reply holds a `335`.
const whois = (isupport: readonly string[]) =>
  lookedUp(
    played([
      ...inChannel({ isupport }),
      lines(
        "!! whois robo",
        ">> WHOIS robo",
        "<< :irc.test 311 iirc robo ~r robo.test * :Robo",
        "<< :irc.test 335 iirc robo :is a Bot on iirc-test",
        "<< :irc.test 318 iirc robo :End of WHOIS list"
      ),
    ])
  );

describe("a WHOIS's 335", () => {
  it("says the User is a bot where the Ircd names a bot mode", () => {
    expect(whois(bot)).toMatchObject({ profiles: [{ bot: true, other: [] }] });
  });

  it("is kept as it came where it names none, as Ircds used it for other things", () => {
    expect(whois(floorIsupport)).toMatchObject({
      profiles: [
        { bot: false, other: [{ numeric: "335", params: ["robo", "is a Bot on iirc-test"] }] },
      ],
    });
  });
});
