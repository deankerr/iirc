/**
 * `chghost`, `userhost-in-names`, and `setname`: the Client keeps a User's mask and realname
 * current as the Ircd says they change, and knows the masks of a Channel's members from its
 * `NAMES`, without asking. Without the caps nothing changes, and `/setname` is refused.
 */
import { IgnoreMask } from "@iirc/protocol/mask";
import { describe, expect, it } from "vitest";

import { client, makeClient } from "../core.ts";
import type { Feature } from "../feature.ts";
import { FeatureName } from "../ids.ts";
import type { LookResult, News } from "../news.ts";
import { register, registry } from "../registry.ts";
import type { State } from "../state.ts";
import { configured, joined, play, registered } from "../testing/index.ts";
import type { Played } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const caps = ["chghost", "setname"];

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

const known = (user: string, host: string) => ({
  _tag: "Known",
  from: "ircd",
  value: { host, user },
});

// Self and `peer` are in `#iirc`, and `peer` and `other` in `#two`. `new` joins `#iirc` with a mask.
const inChannels = (offered: readonly string[], configuration = base) => [
  registered(configuration, { offered: [...offered] }),
  joined(configuration, "#iirc", ["peer", "other"]),
  joined(configuration, "#two", ["peer"]),
  lines("<< :new!old@oldhost JOIN #iirc"),
];

const played = (transcript: readonly string[], configuration = base, custom = client) =>
  play(custom, { configuration, transcript });

const userOf = (run: Played<State>, nick: string) => client.known(run.state).users.get(nick);

const lookedUp = (run: Played<State>): readonly Extract<News, { _tag: "LookedUp" }>[] =>
  run.steps.flatMap((step) => step.news.filter((news) => news._tag === "LookedUp"));

const resultOf = (run: Played<State>): LookResult | undefined => lookedUp(run)[0]?.result;

// What a Session's `353` carries, joined as the prelude joins.
const joinedWith = (...entries: readonly string[]) =>
  lines(
    "!! configure +#iirc",
    ">> JOIN #iirc",
    "<< :iirc!~iirc@iirc.test JOIN #iirc",
    ">> MODE #iirc",
    `<< :irc.test 353 iirc = #iirc :${entries.join(" ")}`,
    "<< :irc.test 366 iirc #iirc :End of /NAMES list.",
    "<< :irc.test 324 iirc #iirc +nt"
  );

const membersOf = (run: Played<State>): readonly string[] => [
  ...(client.known(run.state).channels.get("#iirc")?.members.keys() ?? []),
];

describe("chghost", () => {
  it("changes a User's mask as Activity where they are, and is neither a quit nor a join", () => {
    const run = played([
      ...inChannels(caps),
      lines(
        "<< :new!old@oldhost CHGHOST newuser newhost",
        "?? activity HostChanged new user=newuser host=newhost in=channel:#iirc in=existing-direct:new"
      ),
    ]);

    expect(userOf(run, "new")?.mask).toMatchObject(known("newuser", "newhost"));
    expect(membersOf(run)).toContain("new");

    const activity = run.steps.flatMap((step) =>
      step.news.flatMap((news) => (news._tag === "Activity" ? [news.activity._tag] : []))
    );

    expect(activity.filter((tag) => tag === "Quit" || tag === "Parted")).toHaveLength(0);
    expect(activity.filter((tag) => tag === "Joined")).toHaveLength(3);
  });

  it("is told in each Channel the User shares with Self", () => {
    const run = played([
      ...inChannels(caps),
      lines(
        "<< :peer!u@h CHGHOST u2 h2",
        "?? activity HostChanged peer user=u2 host=h2 in=channel:#iirc in=channel:#two in=existing-direct:peer"
      ),
    ]);

    // `peer`'s mask was never said by a Line before, and now it is.
    expect(userOf(run, "peer")?.mask).toMatchObject(known("u2", "h2"));
  });

  it("reports a User who shares no Channel with Self, and keeps nothing of them", () => {
    const run = played([
      ...inChannels(caps),
      lines(
        "<< :stranger!u@h CHGHOST u2 h2",
        "?? activity HostChanged stranger user=u2 host=h2 in=existing-direct:stranger"
      ),
    ]);

    expect(userOf(run, "stranger")).toBeUndefined();
  });

  it("changes Self's mask, in the Network's own Timeline", () => {
    const run = played([
      ...inChannels(caps),
      lines(
        "<< :iirc!~iirc@iirc.test CHGHOST me my.host",
        "?? activity HostChanged iirc user=me host=my.host in=network"
      ),
    ]);

    expect(client.known(run.state).self?.mask).toMatchObject(known("me", "my.host"));
  });

  it("makes the room a Message needs for Self's source follow Self's new mask", () => {
    const text = "x".repeat(430);
    const long = "h".repeat(100);

    played([...inChannels(caps), lines(`!! say #iirc :${text}`, `>> PRIVMSG #iirc ${text}`)]);

    const run = played([
      ...inChannels(caps),
      lines(`<< :iirc!~iirc@iirc.test CHGHOST u ${long}`, `!! say #iirc :${text}`),
    ]);

    expect(run.steps.at(-1)?.news).toMatchObject([
      { _tag: "Refused", reason: { _tag: "Unsendable" } },
    ]);
  });

  it("knows the new mask of a User who changed nick afterwards", () => {
    const run = played([
      ...inChannels(caps),
      lines("<< :new!old@oldhost CHGHOST newuser newhost", "<< :new!newuser@newhost NICK newer"),
    ]);

    expect(userOf(run, "newer")?.mask).toMatchObject(known("newuser", "newhost"));
  });

  it.each([
    ["no source", "<< CHGHOST u h"],
    ["a server's source", "<< :irc.test CHGHOST u h"],
    ["no parameters", "<< :new!old@oldhost CHGHOST"],
    ["one parameter", "<< :new!old@oldhost CHGHOST u"],
    ["three parameters", "<< :new!old@oldhost CHGHOST u h x"],
    ["an empty user", "<< :new!old@oldhost CHGHOST :  "],
    ["an empty host", "<< :new!old@oldhost CHGHOST u :"],
    ["a user with a space", "<< :new!old@oldhost CHGHOST :a b h"],
    ["a host with a space", "<< :new!old@oldhost CHGHOST u :a b"],
    ["a user with a !", "<< :new!old@oldhost CHGHOST a!b h"],
    ["a host with an @", "<< :new!old@oldhost CHGHOST u a@b"],
    ["a host with a comma", "<< :new!old@oldhost CHGHOST u a,b"],
  ])("reads %s as malformed, and changes nothing", (_name, row) => {
    const run = played([...inChannels(caps), lines(row, "?? ignored Malformed CHGHOST")]);

    expect(userOf(run, "new")?.mask).toMatchObject(known("old", "oldhost"));
  });

  it("reports history, and changes nothing from it", () => {
    const run = played(
      [
        ...inChannels(["batch", ...caps]),
        lines(
          "<< :irc.test BATCH +h chathistory #iirc",
          "<< @batch=h :new!old@oldhost CHGHOST newuser newhost",
          "?? activity HostChanged new user=newuser host=newhost history in=channel:#iirc in=existing-direct:new",
          "<< :irc.test BATCH -h"
        ),
      ],
      base,
      withHistory
    );

    expect(userOf(run, "new")?.mask).toMatchObject(known("old", "oldhost"));
  });

  it("makes a mask stale on CAP DEL, and a later Line says it again", () => {
    const run = played([
      ...inChannels(["cap-notify", ...caps]),
      lines(
        "<< :new!old@oldhost CHGHOST newuser newhost",
        "+1s",
        "<< :irc.test CAP iirc DEL :chghost"
      ),
    ]);

    expect(userOf(run, "new")?.mask).toMatchObject({
      _tag: "Stale",
      was: { host: "newhost", user: "newuser" },
    });
  });

  it("changes nothing without the cap", () => {
    const run = played([...inChannels([]), lines("<< :new!old@oldhost CHGHOST newuser newhost")]);

    expect(userOf(run, "new")?.mask).toMatchObject(known("old", "oldhost"));
  });
});

const masks = (...texts: readonly string[]) => texts.map((text) => IgnoreMask.make(text));

describe("ignoring by mask follows a changed mask", () => {
  it("hides the change and the Messages after it, by the new mask, and nothing else", () => {
    const ignoring = configured({ ignores: masks("*!*@newhost") });

    played(
      [
        ...inChannels(caps, ignoring),
        lines(
          "<< :new!old@oldhost CHGHOST newuser newhost",
          '?? activity HostChanged new user=newuser host=newhost ignored="*!*@newhost" in=channel:#iirc in=existing-direct:new',
          "<< :new!newuser@newhost PRIVMSG #iirc :hi",
          '?? message Privmsg new #iirc ignored="*!*@newhost" in=channel:#iirc :hi'
        ),
      ],
      ignoring
    );

    expect.assertions(0);
  });

  it("hides the change by the old mask too, and lists a mask matching both once", () => {
    const ignoring = configured({
      ignores: masks("*!*@newhost", "new!*@*", "*!old@*", "nobody!*@*"),
    });

    played(
      [
        ...inChannels(caps, ignoring),
        lines(
          "<< :new!old@oldhost CHGHOST newuser newhost",
          '?? activity HostChanged new user=newuser host=newhost ignored="*!*@newhost","new!*@*","*!old@*" in=channel:#iirc in=existing-direct:new'
        ),
      ],
      ignoring
    );

    expect.assertions(0);
  });

  it("hides nothing an unrelated mask matches", () => {
    const ignoring = configured({ ignores: masks("*!*@elsewhere") });

    played(
      [
        ...inChannels(caps, ignoring),
        lines(
          "<< :new!old@oldhost CHGHOST newuser newhost",
          "?? activity HostChanged new user=newuser host=newhost in=channel:#iirc in=existing-direct:new",
          "<< :new!newuser@newhost PRIVMSG #iirc :hi",
          "?? message Privmsg new #iirc in=channel:#iirc :hi"
        ),
      ],
      ignoring
    );

    expect.assertions(0);
  });

  it("never hides Self's own change", () => {
    const ignoring = configured({ ignores: masks("*!*@*") });

    played(
      [
        ...inChannels(caps, ignoring),
        lines(
          "<< :iirc!~iirc@iirc.test CHGHOST me my.host",
          "?? activity HostChanged iirc user=me host=my.host in=network"
        ),
      ],
      ignoring
    );

    expect.assertions(0);
  });
});

const joinedAs = (offered: readonly string[], ...entries: readonly string[]) => [
  registered(base, { offered: [...offered] }),
  joinedWith(...entries),
];

describe("userhost-in-names", () => {
  const both = ["multi-prefix", "userhost-in-names"];

  it("knows each member's mask from the listing, and keeps their nick bare", () => {
    const run = played(
      joinedAs(
        ["userhost-in-names"],
        "iirc!~iirc@iirc.test",
        "@peer!pu@ph",
        "+other!ou@oh",
        "plain"
      )
    );

    expect(membersOf(run)).toStrictEqual(["iirc", "peer", "other", "plain"]);
    expect(userOf(run, "peer")?.mask).toMatchObject(known("pu", "ph"));
    expect(userOf(run, "other")?.mask).toMatchObject(known("ou", "oh"));
    expect(client.known(run.state).self?.mask).toMatchObject(known("~iirc", "iirc.test"));
    expect(userOf(run, "plain")?.mask).toStrictEqual({ _tag: "Unknown" });
  });

  it("is right about prefixes and masks together with multi-prefix", () => {
    const run = played(joinedAs(both, "iirc!~iirc@iirc.test", "@+peer!pu@ph", "~weird!wu@wh"));
    const channel = client.known(run.state).channels.get("#iirc");

    expect(channel?.members.get("peer")?.prefixes).toMatchObject({
      _tag: "Known",
      value: new Set(["o", "v"]),
    });
    expect(channel?.members.get("iirc")?.prefixes).toMatchObject({ _tag: "Known" });
    // A symbol `PREFIX` names nothing stays partial, as it does without the mask.
    expect(channel?.members.get("weird")?.prefixes).toMatchObject({ _tag: "Partial" });
    expect(userOf(run, "peer")?.mask).toMatchObject(known("pu", "ph"));
    expect(userOf(run, "weird")?.mask).toMatchObject(known("wu", "wh"));
  });

  it("gives a member with no mask the plain nick, as before", () => {
    const run = played(joinedAs(both, "iirc", "@+peer"));

    expect(membersOf(run)).toStrictEqual(["iirc", "peer"]);
    expect(userOf(run, "peer")?.mask).toStrictEqual({ _tag: "Unknown" });
  });

  it.each([
    ["no nick", "!u@h"],
    ["no user", "bad!@h"],
    ["no host", "bad!u@"],
    ["no host and no @", "bad!u"],
    ["no user and no !", "bad@h"],
    ["a second !", "bad!a!b@h"],
    ["a second @", "bad!a@b@h"],
    ["a comma", "bad!a@b,c"],
  ])("adds no member for an entry with %s, and no mask", (_name, entry) => {
    const run = played(joinedAs(both, "iirc!~iirc@iirc.test", entry, "fine!fu@fh"));

    expect(membersOf(run)).toStrictEqual(["iirc", "fine"]);
    expect(userOf(run, "fine")?.mask).toMatchObject(known("fu", "fh"));
    expect(userOf(run, "bad")).toBeUndefined();
  });

  it("reads each member's nick bare in a /names Lookup", () => {
    const run = played([
      ...joinedAs(both, "iirc!~iirc@iirc.test", "peer!pu@ph"),
      lines(
        "!! names #iirc",
        ">> NAMES #iirc",
        "<< :irc.test 353 iirc = #iirc :iirc!~iirc@iirc.test @+peer!pu@ph plain bad!@h",
        "<< :irc.test 366 iirc #iirc :End of /NAMES list.",
        "?? looked-up i1 names=#iirc members count=3"
      ),
    ]);

    expect(resultOf(run)).toMatchObject({
      members: [
        { nick: "iirc", prefixes: [] },
        { nick: "peer", prefixes: ["o", "v"] },
        { nick: "plain", prefixes: [] },
      ],
    });
    expect(membersOf(run)).toStrictEqual(["iirc", "peer", "plain"]);
  });

  it("changes nothing from history", () => {
    const run = played(
      [
        ...joinedAs(["batch", ...both], "iirc!~iirc@iirc.test"),
        lines(
          "<< :irc.test BATCH +h chathistory #iirc",
          "<< @batch=h :irc.test 353 iirc = #iirc :late!lu@lh",
          "<< :irc.test BATCH -h"
        ),
      ],
      base,
      withHistory
    );

    expect(userOf(run, "late")).toBeUndefined();
  });

  it("keeps a bare nick on the floor, with no cap", () => {
    const run = played(joinedAs([], "iirc", "peer"));

    expect(membersOf(run)).toStrictEqual(["iirc", "peer"]);
  });
});

const inChannel = (offered: readonly string[] = caps) => [
  registered(base, { offered: [...offered] }),
  joined(base, "#iirc", ["peer"]),
  joined(base, "#two", ["peer"]),
];

const realname = (value: string) => ({ _tag: "Known", from: "ircd", value });

describe("setname", () => {
  it("changes a User's realname as Activity where they are", () => {
    const run = played([
      ...inChannel(),
      lines(
        "<< :peer!u@h SETNAME :Peer Real",
        "?? activity RealnameChanged peer in=channel:#iirc in=channel:#two in=existing-direct:peer :Peer Real"
      ),
    ]);

    expect(userOf(run, "peer")?.realname).toMatchObject(realname("Peer Real"));
  });

  it("changes Self's realname, in the Network's own Timeline", () => {
    const run = played([
      ...inChannel(),
      lines("<< :iirc!u@h SETNAME :Me Now", "?? activity RealnameChanged iirc in=network :Me Now"),
    ]);

    expect(client.known(run.state).self?.realname).toMatchObject(realname("Me Now"));
  });

  it("reports a User who shares no Channel with Self, and keeps nothing of them", () => {
    const run = played([
      ...inChannel(),
      lines(
        "<< :stranger!u@h SETNAME :Who",
        "?? activity RealnameChanged stranger in=existing-direct:stranger :Who"
      ),
    ]);

    expect(userOf(run, "stranger")).toBeUndefined();
  });

  it.each([
    ["no source", "<< SETNAME :x"],
    ["a server's source", "<< :irc.test SETNAME :x"],
    ["no realname", "<< :peer!u@h SETNAME"],
    ["an empty realname", "<< :peer!u@h SETNAME :"],
  ])("reads %s as malformed, and changes nothing", (_name, row) => {
    const run = played([...inChannel(), lines(row, "?? ignored Malformed SETNAME")]);

    expect(userOf(run, "peer")?.realname).toStrictEqual({ _tag: "Unknown" });
    expect(client.known(run.state).self?.realname).toMatchObject({ value: "iirc" });
  });

  it("reports history, and changes nothing from it", () => {
    const run = played(
      [
        ...inChannel(["batch", ...caps]),
        lines(
          "<< :irc.test BATCH +h chathistory #iirc",
          "<< @batch=h :peer!u@h SETNAME :Old",
          "?? activity RealnameChanged peer history in=channel:#iirc in=channel:#two in=existing-direct:peer :Old",
          "<< :irc.test BATCH -h"
        ),
      ],
      base,
      withHistory
    );

    expect(userOf(run, "peer")?.realname).toStrictEqual({ _tag: "Unknown" });
  });

  it("makes a realname stale on CAP DEL", () => {
    const run = played([
      ...inChannel(["cap-notify", ...caps]),
      lines("<< :peer!u@h SETNAME :Peer Real", "+1s", "<< :irc.test CAP iirc DEL :setname"),
    ]);

    expect(userOf(run, "peer")?.realname).toMatchObject({ _tag: "Stale", was: "Peer Real" });
  });

  it("sends a SETNAME for /setname, and Self's realname is what the Ircd then says", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! setname :New Name",
        ">> SETNAME :New Name",
        "<< :iirc!u@h SETNAME :New Name",
        "?? activity RealnameChanged iirc in=network :New Name"
      ),
    ]);

    expect(client.known(run.state).self?.realname).toMatchObject(realname("New Name"));
  });

  it("is refused as unsendable without the cap, and sends nothing", () => {
    const run = played([
      ...inChannel([]),
      lines("!! setname :New Name", "?? refused i1 Unsendable setname in=network"),
    ]);

    expect(client.known(run.state).self?.realname).toMatchObject({ value: "iirc" });
  });

  it("is refused as unsendable with an empty realname, or one that does not fit", () => {
    played([
      ...inChannel(),
      lines(
        "!! setname :",
        "?? refused i1 Unsendable setname in=network",
        `!! setname :${"x".repeat(600)}`,
        "?? refused i2 Unsendable setname in=network"
      ),
    ]);

    expect.assertions(0);
  });

  it("is rejected when the Ircd fails it, with its code", () => {
    played([
      ...inChannel(),
      lines(
        "!! setname :New Name",
        ">> SETNAME :New Name",
        "<< :irc.test FAIL SETNAME INVALID_REALNAME :That realname is not allowed",
        "?? refused i1 Rejected INVALID_REALNAME setname in=network"
      ),
    ]);

    expect.assertions(0);
  });
});

describe("a Session with none of these caps", () => {
  it("registers exactly as before against an Ircd that offers none", () => {
    const run = played([registered(base), joined(base, "#iirc", ["peer"])]);

    expect(client.inspect(run.state).features).toStrictEqual([]);
  });

  it("asks for none of them when only other caps are offered", () => {
    const run = played([registered(base, { offered: ["multi-prefix", "away-notify"] })]);

    expect(client.inspect(run.state).features).toStrictEqual(["multi-prefix", "away-notify"]);
  });

  it("asks for each of them when the Ircd offers them", () => {
    const run = played([
      registered(base, { offered: ["chghost", "setname", "userhost-in-names"] }),
    ]);

    expect(client.inspect(run.state).features).toStrictEqual([
      "chghost",
      "setname",
      "userhost-in-names",
    ]);
  });
});
