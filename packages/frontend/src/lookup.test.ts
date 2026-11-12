import type { Profile, Timeline } from "@iirc/api";
import {
  ChannelHeader,
  LookResult,
  NetworkEntry,
  NetworkId,
  SessionKnowledge,
  TimelineId,
  TimelineList,
  TimelineWindow,
} from "@iirc/api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { nickVectors } from "../../../fixtures/nicks/vectors.ts";
import { commandNamed, interpret, unmet } from "./commands.ts";
import { contextOf } from "./composer.ts";
import {
  cardShown,
  cardWithId,
  idleText,
  initialLookups,
  isLookupNick,
  lookOf,
  nickRulesOf,
  parseLookupNick,
  reduceLookups,
  rfcRanks,
  shownCard,
} from "./lookup.ts";
import type { Card, Look, Lookups, LookupsEvent } from "./lookup.ts";
import { initialTimelines, reduceTimelines } from "./timelines.ts";
import type { Timelines, TimelinesEvent } from "./timelines.ts";

// Wire forms, parsed as the API parses them.

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;

const timelineId = Schema.decodeSync(TimelineId);
const network = Schema.decodeSync(NetworkId)("libera");
const decodeHeader = Schema.decodeSync(ChannelHeader);
const decodeResult = Schema.decodeSync(LookResult);

const own = idOf(1);
const iirc = idOf(2);
const other = idOf(3);
const peer = idOf(4);
const square = idOf(5);

const nothing = { activity: 0, direct: 0, highlights: 0, messages: 0 };

const described = (
  id: string,
  name: string,
  kind: "Network" | "Channel" | "Direct" = "Channel",
  key: string | null = kind === "Network" ? null : name.toLowerCase()
): typeof Timeline.Encoded => ({
  changed: 1,
  detached: false,
  head: null,
  id,
  key,
  kind,
  latest: null,
  name,
  network: "libera",
  read: null,
  unread: nothing,
});

const timelines = [
  described(own, "libera", "Network"),
  described(iirc, "#iirc"),
  described(other, "#Other"),
  described(peer, "peer", "Direct"),
  // Keyed as `rfc1459` folds it: `[` and `{` alike.
  described(square, "#{a}", "Channel", "#{a}"),
];

/**
 * Timelines with libera's listed and connected, and `open` opened and read.
 * @param open - The Timeline opened, if any.
 * @returns The state.
 */
const world = (open: string | undefined): Timelines => {
  const libera = Schema.decodeSync(NetworkEntry)({
    network: "libera",
    status: { _tag: "Running" },
  });

  const list = { _tag: "List", after: undefined, attempt: 0, network } as const;
  const status = { _tag: "Status", attempt: 0, network } as const;

  const events: TimelinesEvent[] = [
    { _tag: "ReadStarted", read: { _tag: "Networks", attempt: 0 } },
    { _tag: "NetworksRead", entries: [libera] },
    { _tag: "ReadStarted", read: list },
    {
      _tag: "ListRead",
      after: undefined,
      network,
      page: Schema.decodeSync(TimelineList)({
        more: false,
        projection: { _tag: "Running" },
        through: 10,
        timelines: [...timelines],
        version: 1,
      }),
    },
    { _tag: "ReadStarted", read: status },
    { _tag: "Requesting", read: status },
    {
      _tag: "StatusRead",
      network,
      self: null,
      session: Schema.decodeSync(SessionKnowledge)({
        _tag: "Registered",
        ircd: "ircd.test",
        since: 1,
      }),
    },
  ];

  if (open !== undefined) {
    const read = {
      _tag: "Latest",
      attempt: 0,
      generation: 0,
      limit: 1000,
      timeline: timelineId(open),
    } as const;

    events.push(
      { _tag: "Opened", timeline: timelineId(open) },
      { _tag: "ReadStarted", read },
      {
        _tag: "WindowRead",
        read,
        window: Schema.decodeSync(TimelineWindow)({
          earlier: false,
          gaps: [],
          items: [],
          later: false,
          network: "libera",
          through: 10,
          timeline: open,
          version: 1,
        }),
      }
    );
  }

  let state = initialTimelines;

  for (const event of events) {
    state = reduceTimelines(state, event);
  }

  return state;
};

/** `#iirc`'s head, on a Network whose `PREFIX` is `(qov)~@+` and `CHANTYPES` `#&`. */
const head = decodeHeader({
  chanmodes: { always: "k", flags: "imnpst", list: "beI", whenSet: "l" },
  chantypes: "#&",
  members: 3,
  modes: { _tag: "Known", at: 1, from: "ircd", value: [] },
  name: "#iirc",
  network: "libera",
  ranks: [
    { mode: "q", symbol: "~" },
    { mode: "o", symbol: "@" },
    { mode: "v", symbol: "+" },
  ],
  standing: "Joined",
  timeline: iirc,
  topic: { _tag: "Unknown" },
});

const profile = (fields: Partial<typeof Profile.Encoded> = {}): typeof Profile.Encoded => ({
  account: null,
  actual: null,
  away: null,
  channels: [],
  host: null,
  idle: null,
  modes: null,
  nick: "peer",
  operator: false,
  other: [],
  realname: null,
  secure: false,
  server: null,
  signon: null,
  user: null,
  ...fields,
});

const found = (...profiles: (typeof Profile.Encoded)[]) =>
  decodeResult({ _tag: "Found", profiles });

const whois = (ranks = rfcRanks): Look => ({
  _tag: "Look",
  lookup: { _tag: "Whois", nick: "peer" },
  network,
  ranks,
  timeline: timelineId(iirc),
});

const fold = (events: readonly LookupsEvent[], from: Lookups = initialLookups) => {
  let state = from;

  for (const event of events) {
    state = reduceLookups(state, event);
  }

  return state;
};

/**
 * The one card in a Pane, asked and folded with more.
 * @param more - What happened after it was asked, each of card 1.
 * @param look - The Lookup.
 * @returns The card.
 */
const cardAfter = (more: readonly LookupsEvent[], look: Look = whois()): Card => {
  const card = fold([{ _tag: "Asked", look, pane: "p0" }, ...more]).cards.get("p0");

  if (card === undefined) {
    throw new Error("no card");
  }

  return card;
};

const time = (at: number) => `T${at}`;

/**
 * The result of card 1, as the wire carries it.
 * @param encoded - The result.
 * @returns The event.
 */
const result = (encoded: typeof LookResult.Encoded): LookupsEvent => ({
  _tag: "Answered",
  id: 1,
  result: decodeResult(encoded),
});

/**
 * Why `/whois` refuses a name, in words.
 * @param args - The text after the command.
 * @param rules - The Network's rules.
 * @returns The words, or none when it is a nick.
 */
const message = (args: string, rules = nickRulesOf(undefined)) => {
  const read = parseLookupNick("Whois", args, rules);

  return read._tag === "Invalid" ? read.message : undefined;
};

describe("reading the nick of a Lookup", () => {
  it("reads every shared vector as the Client does, but where it says otherwise on purpose", () => {
    const read = nickVectors.map((vector) => ({
      name: vector.name,
      nick: isLookupNick({ chantypes: vector.chantypes, symbols: vector.prefixes }, vector.name),
    }));

    expect(read).toStrictEqual(
      nickVectors.map((vector) => ({
        name: vector.name,
        nick: vector.frontend?.nick ?? vector.nick,
      }))
    );
  });

  it("parses a command's text as the vectors read it, trimmed", () => {
    const parsed = nickVectors.map((vector) => {
      const rules = { chantypes: vector.chantypes, symbols: vector.prefixes };

      return parseLookupNick("Whois", ` ${vector.name} `, rules)._tag === "Parsed";
    });

    // Trimming drops a name's own edges only, and none of these has any.
    expect(parsed).toStrictEqual(nickVectors.map((vector) => vector.frontend?.nick ?? vector.nick));
  });

  it("says in words why a name is no nick", () => {
    expect({
      channel: message("#iirc"),
      channelOnTheNetwork: message("&local", nickRulesOf(head)),
      empty: message(" "),
      list: message("a,b"),
      mask: message("*!*@host"),
      nul: message("pe\0er"),
      prefix: message("~peer", nickRulesOf(head)),
      server: message("$*.test"),
      space: message("peer pal"),
    }).toStrictEqual({
      channel: "That is a Channel's name. A Lookup takes a nick. /whois <nick>",
      channelOnTheNetwork: "That is a Channel's name. A Lookup takes a nick. /whois <nick>",
      empty: "Whom? /whois <nick>",
      list: "Give one nick. /whois <nick>",
      mask: "A Lookup takes one nick, never a mask or a source. /whois <nick>",
      nul: "A nick holds no line break or NUL. /whois <nick>",
      prefix: "Leave off the prefix ~: a nick does not start with it. /whois <nick>",
      server: "A Lookup takes one nick, never a mask or a source. /whois <nick>",
      space: "Give one nick. /whois <nick>",
    });
  });

  it("reads by the head's CHANTYPES and ranks, or the Client's before an Ircd says", () => {
    expect([nickRulesOf(undefined), nickRulesOf(head)]).toStrictEqual([
      { chantypes: "#&", symbols: "@+" },
      { chantypes: "#&", symbols: "~@+" },
    ]);
  });
});

describe("/whois and /whowas", () => {
  it("give a Look on the open Timeline's Network, with the head's ranks", () => {
    const context = { ...contextOf(world(iirc)), head };

    expect(interpret("/whois peer", context)).toStrictEqual({
      _tag: "Parsed",
      value: [lookOf("Whois", "peer", network, timelineId(iirc), head)],
    });
    expect(lookOf("Whois", "peer", network, timelineId(iirc), head).ranks).toBe(head.ranks);

    expect(interpret("/WHOWAS old", contextOf(world(peer)))).toStrictEqual({
      _tag: "Parsed",
      value: [
        {
          _tag: "Look",
          lookup: { _tag: "Whowas", nick: "old" },
          network,
          ranks: rfcRanks,
          timeline: timelineId(peer),
        },
      ],
    });
  });

  it("need a Timeline open and its Network's Session, and a nick", () => {
    const command = commandNamed("whois");

    expect(command?.arguments).toBe("Required");
    expect(
      command === undefined ? undefined : unmet(command.when, contextOf(world(undefined)))
    ).toMatchInlineSnapshot(`"Open a Timeline first."`);

    const offline = { ...contextOf(world(iirc)), session: false };

    expect(command === undefined ? undefined : unmet(command.when, offline)).toBeDefined();
    expect(interpret("/whois #iirc", contextOf(world(iirc)))._tag).toBe("Invalid");
  });
});

describe("the Lookups", () => {
  it("hold one card a Pane, which an answer for a card replaced never changes", () => {
    const state = fold([
      { _tag: "Asked", look: whois(), pane: "p0" },
      { _tag: "Asked", look: whois(), pane: "p0" },
      { _tag: "Answered", id: 1, result: found(profile()) },
      { _tag: "Waited", id: 2 },
    ]);

    expect(state.cards.size).toBe(1);
    expect(state.cards.get("p0")?.id).toBe(2);
    expect(state.cards.get("p0")?.phase).toStrictEqual({ _tag: "Pending" });
    expect(cardWithId(state, 1)).toBeUndefined();
  });

  it("keep a result once it came", () => {
    const result = found(profile());

    expect(
      cardAfter([
        { _tag: "Answered", id: 1, result },
        { _tag: "Failed", failure: "NoAnswer", id: 1 },
        { _tag: "Waited", id: 1 },
      ]).phase
    ).toStrictEqual({ _tag: "Done", result });

    expect(cardAfter([{ _tag: "Failed", failure: "Stopped", id: 1 }]).phase).toStrictEqual({
      _tag: "Lost",
      failure: "Stopped",
    });
  });

  it("put a card away, and name Channels as `known` said", () => {
    const state = fold([
      { _tag: "Asked", look: whois(), pane: "p0" },
      { _tag: "Named", chantypes: null, declared: null, id: 1 },
    ]);

    expect(state.cards.get("p0")?.naming).toStrictEqual({
      casemapping: "rfc1459",
      chantypes: "#&+!",
    });
    expect(reduceLookups(state, { _tag: "Dismissed", pane: "p0" }).cards.size).toBe(0);
    expect(reduceLookups(state, { _tag: "Dismissed", pane: "p1" })).toBe(state);
  });

  it("keep the cards of the Panes there are, shown or not, and none once signed out", () => {
    const state = fold([
      { _tag: "Asked", look: whois(), pane: "p0" },
      { _tag: "Asked", look: whois(), pane: "p1" },
    ]);

    const kept = reduceLookups(state, { _tag: "Kept", panes: ["p0", "p2"] });
    const cleared = reduceLookups(state, { _tag: "Cleared" });

    expect({
      again: reduceLookups(kept, { _tag: "Kept", panes: ["p0"] }) === kept,
      cleared: [cleared.cards.size, cleared.next],
      kept: [...kept.cards.keys()],
    }).toStrictEqual({ again: true, cleared: [0, 3], kept: ["p0"] });
  });

  it("show a card only while its Pane has open the Timeline it was asked from", () => {
    const state = fold([{ _tag: "Asked", look: whois(), pane: "p0" }]);

    expect(shownCard(state, world(iirc), "p0")?.id).toBe(1);
    expect(shownCard(state, world(other), "p0")).toBeUndefined();
    expect(shownCard(state, world(undefined), "p0")).toBeUndefined();
    expect(shownCard(state, world(iirc), "p1")).toBeUndefined();
  });

  it("survive structuredClone", () => {
    const state = fold([
      { _tag: "Asked", look: whois(), pane: "p0" },
      { _tag: "Answered", id: 1, result: found(profile({ channels: [] })) },
    ]);

    expect(structuredClone(state)).toStrictEqual(state);
  });
});

describe("how long a User was idle", () => {
  it("is said in its two largest units", () => {
    expect(
      [0, 42, 180, 3600, 7500, 86_400, 273_600, -1, 1.5].map((seconds) => idleText(seconds))
    ).toStrictEqual([
      "idle 0s",
      "idle 42s",
      "idle 3m",
      "idle 1h",
      "idle 2h 5m",
      "idle 1d",
      "idle 3d 4h",
      undefined,
      undefined,
    ]);
  });
});

describe("a card as a view draws it", () => {
  const named: LookupsEvent = { _tag: "Named", chantypes: "#&", declared: "rfc1459", id: 1 };

  it("shows a User whole, with the signon in the time format given", () => {
    const card = cardAfter(
      [
        named,
        {
          _tag: "Answered",
          id: 1,
          result: found(
            profile({
              account: "peeraccount",
              actual: { ip: "121.200.5.82", mask: null },
              away: "lunch",
              channels: [
                { name: "#iirc", prefixes: ["o", "v"] },
                { name: "#new", prefixes: [] },
                { name: "#[A]", prefixes: ["q", "y"] },
              ],
              host: "example.test",
              idle: 180,
              modes: "+Zi",
              operator: true,
              other: [{ numeric: "378", params: ["is connecting from", "*@10.0.0.1"] }],
              realname: "Peer Pal",
              secure: true,
              server: { info: "the test server", name: "ircd.test" },
              signon: 1_700_000_000_000,
              user: "~peer",
            })
          ),
        },
      ],
      whois(head.ranks)
    );

    const shown = cardShown(world(iirc), card, time);

    expect(shown).toStrictEqual({
      body: {
        _tag: "Profiles",
        note: undefined,
        profiles: [
          {
            account: "peeraccount",
            actual: "121.200.5.82",
            away: "lunch",
            channels: [
              {
                choose: { _tag: "Open", timeline: timelineId(iirc) },
                label: "#iirc, operator, voice",
                name: "#iirc",
                symbols: "@+",
              },
              {
                choose: { _tag: "FocusComposer", text: "/join #new" },
                label: "#new",
                name: "#new",
                symbols: "",
              },
              {
                // `#[A]` folds by rfc1459 to `#{a}`, as the Daemon keyed it.
                choose: { _tag: "Open", timeline: timelineId(square) },
                label: "#[A], mode q, mode y",
                name: "#[A]",
                symbols: "~",
              },
            ],
            colour: shown.colour,
            idle: "idle 3m",
            mask: "~peer@example.test",
            modes: "+Zi",
            nick: "peer",
            operator: true,
            other: [{ numeric: "378", text: "is connecting from *@10.0.0.1" }],
            realname: "Peer Pal",
            secure: true,
            server: { info: "the test server", name: "ircd.test" },
            signon: "signed on T1700000000000",
          },
        ],
      },
      colour: shown.colour,
      kind: "Whois",
      nick: "peer",
    });
  });

  it("says a signon that cannot be formatted is unavailable, and keeps the rest", () => {
    const card = cardAfter([
      result({ _tag: "Found", profiles: [profile({ realname: "Peer Pal", signon: 9e15 })] }),
    ]);

    const shown = cardShown(world(iirc), card, () => {});
    const profiled = shown.body._tag === "Profiles" ? shown.body.profiles[0] : undefined;

    expect([profiled?.signon, profiled?.realname]).toStrictEqual([
      "sign-on time unavailable",
      "Peer Pal",
    ]);
  });

  it("offers no Channel to choose until the Network's naming is read, nor one no Channel", () => {
    // A bell, or an override the composer would show unseen, is no Channel's to join.
    const result = found(
      profile({
        channels: [
          { name: "#iirc", prefixes: [] },
          { name: "#a\u0007b", prefixes: [] },
          { name: "#\u202Eevil", prefixes: [] },
        ],
      })
    );

    const before = cardShown(world(iirc), cardAfter([{ _tag: "Answered", id: 1, result }]), time);

    const after = cardShown(
      world(iirc),
      cardAfter([named, { _tag: "Answered", id: 1, result }]),
      time
    );

    const chosen = (shown: typeof before) =>
      shown.body._tag === "Profiles"
        ? shown.body.profiles[0]?.channels.map((channel) => channel.choose?._tag)
        : [];

    expect([chosen(before), chosen(after)]).toStrictEqual([
      [undefined, undefined, undefined],
      ["Open", undefined, undefined],
    ]);
  });

  it("contains hostile text, and keeps it text", () => {
    const card = cardAfter([
      named,
      {
        _tag: "Answered",
        id: 1,
        result: found(
          profile({
            actual: { ip: "1.2.3.4", mask: "u\u0007@h‮" },
            channels: [{ name: "#‮evil", prefixes: [] }],
            host: "<b>host</b>",
            modes: "+i‮",
            nick: "pe‮er",
            other: [{ numeric: "999", params: ["a\u0000b", "⁦open"] }],
            realname: "line\nbreak‮",
            user: "u\u0007",
          })
        ),
      },
    ]);

    const shown = cardShown(world(iirc), card, time);
    const profiled = shown.body._tag === "Profiles" ? shown.body.profiles[0] : undefined;

    expect({
      actual: profiled?.actual,
      channel: profiled?.channels[0]?.name,
      mask: profiled?.mask,
      modes: profiled?.modes,
      nick: profiled?.nick,
      other: profiled?.other,
      realname: profiled?.realname,
    }).toStrictEqual({
      actual: "u␇@h‮‬ 1.2.3.4",
      channel: "#‮evil‬",
      mask: "u␇@<b>host</b>",
      modes: "+i‮‬",
      nick: "pe‮er‬",
      other: [{ numeric: "999", text: "a␀b ⁦open⁩" }],
      realname: "line␊break‮‬",
    });
  });

  it("says in words what it waits on, and what found no User", () => {
    const words = (more: readonly LookupsEvent[], look = whois()) => {
      const { body } = cardShown(world(iirc), cardAfter(more, look), time);

      return body._tag === "Profiles" ? body.note : body.words;
    };

    const whowas: Look = { ...whois(), lookup: { _tag: "Whowas", nick: "old" } };

    expect({
      asking: words([]),
      bounded: words([result({ _tag: "Partial", profiles: [profile()], reason: "Bounded" })]),
      busy: words([result({ _tag: "Refused", reason: "Busy" })]),
      ended: words([result({ _tag: "Partial", profiles: [], reason: "Ended" })]),
      failed: words([result({ _tag: "Failed", reply: "402" })]),
      lost: words([{ _tag: "Failed", failure: "NoAnswer", id: 1 }]),
      notFound: words([result({ _tag: "NotFound", reply: "401" })]),
      offline: words([result({ _tag: "Refused", reason: "Offline" })]),
      pending: words([{ _tag: "Waited", id: 1 }]),
      stopped: words([{ _tag: "Failed", failure: "Stopped", id: 1 }]),
      timedOut: words([result({ _tag: "Partial", profiles: [profile()], reason: "TimedOut" })]),
      unknown: words([{ _tag: "Failed", failure: "UnknownNetwork", id: 1 }]),
      unsendable: words([result({ _tag: "Refused", reason: "Unsendable" })]),
      unsent: words([result({ _tag: "Unsent" })]),
      wasNotFound: words([result({ _tag: "NotFound", reply: "406" })], whowas),
    }).toStrictEqual({
      asking: "Looking up…",
      bounded: "The reply ran longer than a Lookup keeps, so this is how it began.",
      busy: "Not looked up: too many Lookups are waiting on this Network. Try again in a moment.",
      ended: "The connection ended before the reply did, so this is what had come.",
      failed: "The Network refused the Lookup (402).",
      lost: "No result came from the Daemon in time. Try again.",
      notFound: "No one uses the nick peer now (401).",
      offline: "Not looked up: the Network is not connected.",
      pending: "Still waiting for the Network's reply…",
      stopped: "The Network stopped before it was looked up. Try again.",
      timedOut: "The Network had not finished replying after 30 seconds, so this is what had come.",
      unknown: "The Daemon has no such Network.",
      unsendable: "Not looked up: the Network cannot be asked about that nick.",
      unsent: "Not looked up: the connection ended before it was sent.",
      wasNotFound: "The Network remembers no one who used the nick old (406).",
    });
  });
});
