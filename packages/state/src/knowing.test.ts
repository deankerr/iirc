import type { Line } from "@iirc/protocol/line";
import { parseLine } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import {
  casefold,
  casemappingOf,
  channelOf,
  heldMembers,
  heldTokens,
  initialState,
  longestField,
  memberOf,
  membersPerChannel,
  modesPerChannel,
  movesChannels,
  readsCommand,
  sessionState,
  stepState,
  userOf,
  usersPerGeneration,
} from "./state.ts";
import type { IrcState, StateChange } from "./state.ts";

const lineOf = (text: string): Line => {
  const parsed = parseLine(text);

  if (parsed._tag === "Unparseable") {
    throw new Error(`Expected a Line from ${text}`);
  }

  return parsed.line;
};

const fed = (from: IrcState, lines: Iterable<string>) => {
  let state = from;
  const changes: StateChange[] = [];

  for (const text of lines) {
    const stepped = stepState(state, lineOf(text));

    state = stepped.next;
    changes.push(...stepped.changes);
  }

  return { changes, state };
};

const replay = (...lines: readonly string[]) => fed(initialState, lines).state;

// `353`s of 50 names each, then the `366`.
const names = (channel: string, nicks: readonly string[]) => [
  ...Array.from(
    { length: Math.ceil(nicks.length / 50) },
    (_, index) => `:irc 353 me = ${channel} :${nicks.slice(index * 50, index * 50 + 50).join(" ")}`
  ),
  `:irc 366 me ${channel} :End of /NAMES list.`,
];

const many = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`);

const nicksOf = (state: IrcState, channel: string) =>
  [...(channelOf(state, channel)?.members.values() ?? [])].map(({ nick }) => nick).toSorted();

// A deterministic generator, so a failure replays.
const seeded = (seed: number) => {
  let state = seed;

  return () => {
    state = (state * 48_271) % 2_147_483_647;

    return state / 2_147_483_647;
  };
};

describe("KNOW-8: a netsplit and the rejoin after it", () => {
  const channels = ["#a", "#b", "#c"];
  const random = seeded(3);
  const everyone = Array.from({ length: 600 }, (_, index) => `user${index}`);

  const memberships = new Map(
    channels.map((channel) => [channel, everyone.filter(() => random() < 0.5)])
  );

  const before = fed(initialState, [
    ":irc 001 me :Hi",
    `:me!u@h JOIN ${channels.join(",")}`,
    ...channels.flatMap((channel) => [
      ...names(channel, [
        "me",
        ...(memberships.get(channel) ?? []).map((nick, index) =>
          index % 7 === 0 ? `@${nick}` : nick
        ),
      ]),
    ]),
  ]).state;

  const split = everyone.slice(0, 400);

  const quit = fed(
    before,
    split.map((nick) => `:${nick}!u@h QUIT :hub.example leaf.example`)
  );

  it("names, for each QUIT, the Channels that User shared with Self just before it", () => {
    const quits = quit.changes.filter((change) => change._tag === "UserQuit");

    expect(quits).toHaveLength(400);

    for (const change of quits) {
      const shared = channels.filter(
        (channel) => memberships.get(channel)?.includes(change.nick) === true
      );

      expect(change.channels).toStrictEqual(shared);
    }
  });

  it("leaves only those who stayed", () => {
    for (const channel of channels) {
      expect(nicksOf(quit.state, channel)).toStrictEqual(
        [
          "me",
          ...(memberships.get(channel) ?? []).filter((nick) => !split.includes(nick)),
        ].toSorted()
      );
    }
  });

  it("is whole again once everyone rejoins and the Ircd restores their modes", () => {
    const rejoined = fed(
      quit.state,
      split.flatMap((nick) => {
        const back = channels.filter(
          (channel) => memberships.get(channel)?.includes(nick) === true
        );

        return back.length === 0 ? [] : [`:${nick}!u@h JOIN ${back.join(",")}`];
      })
    );

    const restored = fed(
      rejoined.state,
      channels.flatMap((channel) =>
        (memberships.get(channel) ?? [])
          .filter((nick, index) => index % 7 === 0 && split.includes(nick))
          .map((nick) => `:hub.example MODE ${channel} +o ${nick}`)
      )
    ).state;

    for (const channel of channels) {
      expect(channelOf(restored, channel)?.members).toStrictEqual(
        channelOf(before, channel)?.members
      );
    }

    expect(rejoined.changes.every(({ _tag }) => _tag === "MemberJoined")).toBeTruthy();
  });
});

describe("LIVE-6: a reconnect is a new Session", () => {
  const lived = replay(
    ":irc 001 me :Hi",
    ":irc 005 me CASEMAPPING=ascii NETWORK=x :are supported",
    ":me!u@h JOIN #a",
    ":irc 353 me = #a :me @bob",
    ":irc 366 me #a :End",
    ":irc 332 me #a :topic",
    ":carol!c@h JOIN #a",
    ":irc 306 me :away"
  );

  it("begins from nothing, and keeps nothing of the Session before", () => {
    const next = fed(initialState, [":irc 001 me :Hi again"]).state;

    expect(next).toStrictEqual({
      ...initialState,
      self: { away: false, host: undefined, modes: "", nick: "me", user: undefined },
    });
    expect(lived.channels.size).toBe(1);
  });

  it("ignores a second welcome within one Session", () => {
    expect(stepState(lived, lineOf(":irc 001 other :Hi")).next).toBe(lived);
  });

  it("keeps an Owner's mapping through the welcome", () => {
    const forced = fed(sessionState({ casemapping: "rfc1459-strict" }), [":irc 001 me :Hi"]).state;

    expect(casemappingOf(forced)).toBe("rfc1459-strict");
  });
});

describe("KNOW-3: the mapping in force", () => {
  it("is the Owner's when forced, whatever the Ircd says", () => {
    const { state } = fed(sessionState({ casemapping: "ascii" }), [
      ":irc 001 me :Hi",
      ":irc 005 me CASEMAPPING=rfc1459 :are supported",
      ":me!u@h JOIN #a[1]",
    ]);

    expect(casemappingOf(state)).toBe("ascii");
    expect(state.isupport.casemapping).toBe("rfc1459");
    expect(channelOf(state, "#a{1}")).toBeUndefined();
    expect(channelOf(state, "#A[1]")?.name).toBe("#a[1]");
  });

  it("refolds members and Users when the Ircd's mapping arrives late", () => {
    const state = replay(
      ":irc 001 me :Hi",
      ":me!u@h JOIN #a",
      ":irc 353 me = #a :me Dan[1]",
      ":irc 366 me #a :End",
      ":Dan[1]!d@h PRIVMSG #a :hi",
      ":eve[x]!e@h JOIN #a",
      ":irc 005 me CASEMAPPING=ascii :are supported"
    );

    expect(memberOf(state, "#a", "dan[1]")?.nick).toBe("Dan[1]");
    expect(memberOf(state, "#a", "dan{1}")).toBeUndefined();
    expect(userOf(state, "EVE[X]")?.user).toBe("e");
  });

  it.each([
    ["fullwidth letters to ASCII", "ＢＯＢ", "bob"],
    ["a capital sigma to the medial form, even last", "ΟΔΥΣ", "οδυσ"],
    ["a decomposed accent to the composed form", "Café", "café"],
    ["halfwidth katakana to fullwidth", "ｶﾞ", "ガ"],
    ["capitals beyond the BMP", "𐐀", "𐐨"],
    ["ASCII as ascii does", "Me[]", "me[]"],
  ])("rfc8265 takes %s", (_what, name, folded) => {
    expect(casefold("rfc8265", name)).toBe(folded);
  });

  it.each([
    ["ascii", "ÉMILE", "Émile"],
    ["rfc1459", "ÉMILE[]", "Émile{}"],
    ["rfc1459-strict", "ÉMILE~", "Émile~"],
  ] as const)("%s leaves letters beyond ASCII alone", (casemapping, name, folded) => {
    expect(casefold(casemapping, name)).toBe(casefold(casemapping, folded));
    expect(casefold(casemapping, name).startsWith("É")).toBeTruthy();
  });
});

describe("KNOW-4: a TOPIC is dated when it arrived", () => {
  it("by the time its host gives", () => {
    const joined = replay(":irc 001 me :Hi", ":me!u@h JOIN #a");
    const { next } = stepState(joined, lineOf(":bob!b@h TOPIC #a :new"), 1_700_000_000_000);

    expect(channelOf(next, "#a")?.topic).toStrictEqual({
      setAt: 1_700_000_000_000,
      setBy: "bob!b@h",
      text: "new",
    });
  });
});

describe("HOST-1: nothing a Network sends grows a Session's state without bound", () => {
  const joined = replay(":irc 001 me :Hi", ":me!u@h JOIN #a,#b,#c");

  it(`holds at most ${membersPerChannel} members in a Channel, then is uncertain`, () => {
    const { changes, state } = fed(joined, names("#a", many("n", membersPerChannel + 10)));

    expect(channelOf(state, "#a")?.members.size).toBe(membersPerChannel);
    expect(channelOf(state, "#a")?.membersUncertain).toBeTruthy();
    expect(changes.at(-1)).toStrictEqual({
      _tag: "ChannelUncertain",
      channel: "#a",
      field: "members",
    });

    const later = stepState(state, lineOf(":late!l@h JOIN #a")).next;

    expect(channelOf(later, "#a")?.members.has("late")).toBeFalsy();
  });

  it(`holds at most ${heldMembers} members in all`, () => {
    const { state } = fed(joined, [
      ...names("#a", many("a", membersPerChannel)),
      ...names("#b", many("b", membersPerChannel)),
      ...names("#c", many("c", 100)),
    ]);

    const held = [...state.channels.values()].reduce((sum, { members }) => sum + members.size, 0);

    // A Channel's members and the reply that will replace them count together until the
    // swap, so the bound can stop a few short of full.
    expect(held).toBeLessThanOrEqual(heldMembers);
    expect(held).toBeGreaterThan(heldMembers - 4);
    expect(channelOf(state, "#c")?.membersUncertain).toBeTruthy();
  });

  it(`holds no nick longer than ${longestField}, and says the members are uncertain`, () => {
    const long = "x".repeat(longestField + 1);
    const { state } = fed(joined, names("#a", ["me", long]));

    expect(nicksOf(state, "#a")).toStrictEqual(["me"]);
    expect(channelOf(state, "#a")?.membersUncertain).toBeTruthy();
  });

  it(`remembers at most ${usersPerGeneration * 2} Users, forgetting the longest unseen`, () => {
    const lines = many("u", usersPerGeneration * 2 + 5).map(
      (nick) => `:irc 311 me ${nick} u h * :R`
    );

    const { state } = fed(joined, lines);

    expect(state.users.size).toBeLessThanOrEqual(usersPerGeneration * 2);
    expect(userOf(state, `u${usersPerGeneration * 2 + 4}`)?.realname).toBe("R");
    expect(userOf(state, "u0")).toBeUndefined();
  });

  it(`holds at most ${modesPerChannel} modes in a Channel, then is uncertain`, () => {
    const letters = Array.from({ length: modesPerChannel + 6 }, (_, index) =>
      String.fromCodePoint(0x4e_00 + index)
    ).join("");

    const state = replay(":irc 001 me :Hi", ":me!u@h JOIN #a", `:op MODE #a +${letters}`);

    expect(channelOf(state, "#a")?.modes.size).toBe(modesPerChannel);
    expect(channelOf(state, "#a")?.modesUncertain).toBeTruthy();
  });

  it(`holds at most ${heldTokens} RPL_ISUPPORT tokens, but always those it reads`, () => {
    const lines = Array.from(
      { length: 30 },
      (_, line) => `:irc 005 me ${many(`T${line}X`, 12).join(" ")} :are supported`
    );

    const { state } = fed(joined, [...lines, ":irc 005 me NICKLEN=12 :are supported"]);

    expect(state.isupport.tokens.size).toBe(heldTokens + 1);
    expect(state.isupport.tokensDropped).toBeTruthy();
    expect(state.isupport.nickLength).toBe(12);
  });
});

// Commands the state reads and Lines built from them, at random, with parameters that
// are often missing, empty, or hostile.
const commands = [
  "001",
  "005",
  "221",
  "301",
  "305",
  "306",
  "311",
  "324",
  "329",
  "331",
  "332",
  "333",
  "352",
  "353",
  "366",
  "396",
  "470",
  "900",
  "901",
  "JOIN",
  "KICK",
  "MODE",
  "NICK",
  "PART",
  "QUIT",
  "TOPIC",
  "PRIVMSG",
  "474",
  "476",
];

const words = [
  "me",
  "Me",
  "#a",
  "#A",
  "bob",
  "",
  "*",
  "+o",
  "-o+v",
  "+k",
  "@+me",
  "=",
  "#a,#b",
  "me,bob",
  "+Xl",
  "10",
  "x!y@z",
  "PREFIX=(ov)@+",
  "CASEMAPPING=ascii",
  "-PREFIX",
  "1700000000",
  "@",
  "!",
  ":",
  "G*@",
];

describe("HOST-1: no sequence of Lines makes the fold throw", () => {
  it("survives 20,000 random Lines, and keeps what it does not read the very same", () => {
    const random = seeded(11);
    const pick = (items: readonly string[]) => items[Math.floor(random() * items.length)] ?? "";
    const unread: Line[] = [];
    let state = replay(":irc 001 me :Hi", ":me!u@h JOIN #a");

    for (let step = 0; step < 20_000; step += 1) {
      const params = Array.from({ length: Math.floor(random() * 6) }, () => pick(words));
      const source = random() < 0.2 ? undefined : pick(["me!u@h", "bob!b@h", "op", "me"]);
      const line: Line = { command: pick(commands), params, source, tags: new Map() };
      const { next } = stepState(state, line);

      if (!readsCommand(line.command) && next !== state) {
        unread.push(line);
      }

      state = next;
    }

    expect(unread).toStrictEqual([]);
    expect(state.channels.size).toBeLessThanOrEqual(1024);
  });
});

const whois = (nick: string) => `:irc 311 me ${nick} u h * :R`;

describe("Regressions from the step 2 review", () => {
  const joinedA = replay(":irc 001 me :Hi", ":me!u@h JOIN #a");

  it("HOST-1: a JOIN during a NAMES reply cannot take a Channel past its bound", () => {
    const reply = names("#a", many("n", membersPerChannel));
    const { state } = fed(joinedA, [...reply.slice(0, -1), ":new!u@h JOIN #a", ...reply.slice(-1)]);

    expect(channelOf(state, "#a")?.members.size).toBe(membersPerChannel);
    expect(channelOf(state, "#a")?.membersUncertain).toBeTruthy();
  });

  it("KNOW-8: a QUIT or NICK names a Channel that holds its User only in a NAMES reply under way", () => {
    const listed = fed(joinedA, [":irc 353 me = #a :me bob carol"]).state;

    expect(stepState(listed, lineOf(":bob!b@h QUIT :bye")).changes).toStrictEqual([
      { _tag: "UserQuit", channels: ["#a"], nick: "bob", reason: "bye" },
    ]);
    expect(stepState(listed, lineOf(":carol!c@h NICK caro")).changes).toStrictEqual([
      { _tag: "UserRenamed", channels: ["#a"], from: "carol", to: "caro" },
    ]);
    expect(channelOf(listed, "#a")?.members.size).toBe(1);
  });

  it("KNOW-6: each field that becomes uncertain is named, whichever came first", () => {
    const cut = fed(joinedA, names("#a", ["me", "x".repeat(longestField + 1)]));

    expect(cut.changes.at(-1)).toStrictEqual({
      _tag: "ChannelUncertain",
      channel: "#a",
      field: "members",
    });
    expect(stepState(cut.state, lineOf(":op!o@h MODE #a +o")).changes).toStrictEqual([
      { _tag: "ChannelUncertain", channel: "#a", field: "modes" },
    ]);
  });

  it("KNOW-7: seeing a User again, unchanged, keeps them among the newest", () => {
    const others = (from: number) => many(`o${from}-`, usersPerGeneration).map(whois);

    const { state } = fed(joinedA, [
      whois("frequent"),
      ...others(1),
      whois("frequent"),
      ...others(2),
    ]);

    expect(userOf(state, "frequent")?.realname).toBe("R");
  });

  it("KNOW-7: an unchanged sighting says nothing", () => {
    const once = fed(joinedA, [":irc 311 me bob u h * :R"]).state;

    expect(stepState(once, lineOf(":irc 311 me bob u h * :R"))).toStrictEqual({
      changes: [],
      next: once,
    });
  });

  it("KNOW-4: members are ranked again when PREFIX changes, and again when it is taken back", () => {
    const ranked = fed(joinedA, [
      ...names("#a", ["me", "@+both"]),
      ":irc 353 me = #a :me @+both",
      ":irc 005 me PREFIX=(vo)+@ :are supported",
    ]).state;

    expect(memberOf(ranked, "#a", "both")?.prefixes).toBe("vo");
    expect(
      [...(channelOf(ranked, "#a")?.pending?.members.values() ?? [])].map(
        ({ prefixes }) => prefixes
      )
    ).toStrictEqual(["vo", ""]);

    const restored = fed(ranked, [
      ":irc 005 me -PREFIX :are supported",
      ":irc 366 me #a :End",
    ]).state;

    expect(memberOf(restored, "#a", "both")?.prefixes).toBe("ov");
  });

  it("KNOW-7: a Direct Message partner who shares no Channel is remembered", () => {
    const { state } = fed(joinedA, [":friend!~f@friend.example PRIVMSG me :hello"]);

    expect(userOf(state, "friend")).toStrictEqual({
      away: undefined,
      host: "friend.example",
      nick: "friend",
      realname: undefined,
      user: "~f",
    });
    expect(readsCommand("PRIVMSG") && readsCommand("NOTICE")).toBeTruthy();
  });

  it("KNOW-7: a Message from someone seen as they are gives back the very same state", () => {
    const seen = fed(joinedA, [":friend!~f@h PRIVMSG me :one"]).state;

    expect(stepState(seen, lineOf(":friend!~f@h PRIVMSG #a :two")).next).toBe(seen);
  });

  it("KNOW-7: a notice from an Ircd, or a source with no user@host, is no User", () => {
    const { state } = fed(joinedA, [":irc.example NOTICE me :hi", ":bare NOTICE me :hi"]);

    expect(state).toBe(joinedA);
  });
});

describe("LIVE-7: what can move which Channels Self is in", () => {
  it.each(["001", "005", "JOIN", "PART", "KICK", "474"])("%s can", (command) => {
    expect(movesChannels(command)).toBeTruthy();
  });

  it.each(["PRIVMSG", "NOTICE", "QUIT", "NICK", "MODE", "353", "366", "311"])(
    "%s cannot",
    (command) => {
      expect(movesChannels(command)).toBeFalsy();
    }
  );
});
