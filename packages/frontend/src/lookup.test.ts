import type { Profile, Timeline } from "@iirc/api";
import {
  ChannelHeader,
  LookResult,
  NetworkEntry,
  NetworkId,
  SessionKnowledge,
  TimelineChange,
  TimelineId,
  TimelineList,
  TimelineWindow,
} from "@iirc/api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { nickVectors } from "../../../fixtures/nicks/vectors.ts";
import { commandNamed, interpret, unmet } from "./commands.ts";
import type { CommandContext } from "./commands.ts";
import { contextOf } from "./composer.ts";
import {
  cardShown,
  cardWithId,
  idleText,
  initialLookups,
  isLookupNick,
  listedChannels,
  listLookOf,
  lookOf,
  mayChangeLists,
  nickRulesOf,
  parseLookupNick,
  reduceLookups,
  rfcRanks,
  shownCard,
} from "./lookup.ts";
import type { Card, Look, Lookups, LookupsEvent } from "./lookup.ts";
import { nickColour } from "./render.ts";
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
  closed: false,
  detached: false,
  head: null,
  id,
  key,
  kind,
  latest: null,
  life: 1,
  name,
  network: "libera",
  read: null,
  removed: false,
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
    _tag: "Live",
    life: 1,
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
      life: 1,
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
  held: null,
  lists: { bans: "b", exceptions: "e", invitations: "I" },
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
  decodeResult({ _tag: "Found", notes: [], profiles });

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
 * A `WARN` or `NOTE` about `WHOIS`, with a hostile code.
 * @param kind - Its kind.
 * @param context - Its context.
 * @param description - Its description.
 * @returns The reply, as the wire has it.
 */
const note = (kind: "WARN" | "NOTE", context: readonly string[], description: string) => ({
  code: "CODE\u202E",
  command: "WHOIS",
  context,
  description,
  kind,
});

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
            colour: nickColour("peer"),
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
      kind: "Whois",
      notes: [],
      subject: { _tag: "Nick", colour: nickColour("peer"), nick: "peer" },
    });
  });

  it("says a signon that cannot be formatted is unavailable, and keeps the rest", () => {
    const card = cardAfter([
      result({
        _tag: "Found",
        notes: [],
        profiles: [profile({ realname: "Peer Pal", signon: 9e15 })],
      }),
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

  it("shows each WARN and NOTE of the reply by its fields, contained, and none before a result", () => {
    const noted = cardShown(
      world(iirc),
      cardAfter([
        result({
          _tag: "Failed",
          notes: [note("WARN", ["peer\u0007"], "Slow"), note("NOTE", [], "")],
          reply: "TEMPORARILY_UNAVAILABLE",
        }),
      ]),
      time
    );

    expect([noted.notes, cardShown(world(iirc), cardAfter([]), time).notes]).toStrictEqual([
      ["WARN WHOIS CODE\u202E\u202C peer\u2407: Slow", "NOTE WHOIS CODE\u202E\u202C"],
      [],
    ]);
  });

  it("says in words what it waits on, and what found no User", () => {
    const words = (more: readonly LookupsEvent[], look = whois()) => {
      const { body } = cardShown(world(iirc), cardAfter(more, look), time);

      return body._tag === "Profiles" || body._tag === "Masks" ? body.note : body.words;
    };

    const whowas: Look = { ...whois(), lookup: { _tag: "Whowas", nick: "old" } };

    expect({
      asking: words([]),
      bounded: words([
        result({ _tag: "Partial", notes: [], profiles: [profile()], reason: "Bounded" }),
      ]),
      busy: words([result({ _tag: "Refused", reason: "Busy" })]),
      ended: words([result({ _tag: "Partial", notes: [], profiles: [], reason: "Ended" })]),
      failed: words([result({ _tag: "Failed", notes: [], reply: "402" })]),
      lost: words([{ _tag: "Failed", failure: "NoAnswer", id: 1 }]),
      notFound: words([result({ _tag: "NotFound", notes: [], reply: "401" })]),
      offline: words([result({ _tag: "Refused", reason: "Offline" })]),
      pending: words([{ _tag: "Waited", id: 1 }]),
      stopped: words([{ _tag: "Failed", failure: "Stopped", id: 1 }]),
      timedOut: words([
        result({ _tag: "Partial", notes: [], profiles: [profile()], reason: "TimedOut" }),
      ]),
      unknown: words([{ _tag: "Failed", failure: "UnknownNetwork", id: 1 }]),
      unsendable: words([result({ _tag: "Refused", reason: "Unsendable" })]),
      unsent: words([result({ _tag: "Unsent" })]),
      wasNotFound: words([result({ _tag: "NotFound", notes: [], reply: "406" })], whowas),
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

/**
 * `#iirc` in focus, its head read.
 * @returns The context.
 */
const inIirc = (): CommandContext => ({ ...contextOf(world(iirc)), head });

/**
 * Why a line is refused, in words.
 * @param line - The line.
 * @param at - The context.
 * @returns The words, or none when it is not.
 */
const refusalOf = (line: string, at: CommandContext = inIirc()) => {
  const read = interpret(line, at);

  return read._tag === "Invalid" ? read.message : undefined;
};

const whenOf = (name: string) => commandNamed(name)?.when ?? [];

const withHeld = (held: (typeof ChannelHeader.Encoded)["held"]) =>
  decodeHeader({ ...Schema.encodeSync(ChannelHeader)(head), held });

const held = (value: readonly string[]) =>
  withHeld({ _tag: "Known", at: 1, from: "ircd", value: [...value] });

const masksOf = (shown: ReturnType<typeof cardShown>) =>
  shown.body._tag === "Masks" ? shown.body.masks.map((each) => each.mask) : [];

/**
 * `#Other`'s head, with Self holding the prefixes given there.
 * @param value - The prefix modes Self holds.
 * @returns The head.
 */
const otherHead = (value: readonly string[]) =>
  decodeHeader({
    ...Schema.encodeSync(ChannelHeader)(head),
    held: { _tag: "Known", at: 1, from: "ircd", value: [...value] },
    name: "#Other",
    timeline: other,
  });

/**
 * A step of the changes stream in which the Ircd refused an act of `#iirc`'s under an intent.
 * @param intent - The act's intent.
 * @returns The step.
 */
const refusedChange = (intent: string) =>
  Schema.decodeSync(TimelineChange)({
    dropped: [],
    gaps: [],
    items: [
      {
        answered: null,
        changed: 11,
        content: {
          _tag: "ActionRefused",
          at: 1,
          attempted: { _tag: "Mode", modes: "-b", target: "#IIRC" },
          intent,
          reason: { _tag: "Rejected", reply: "482" },
        },
        level: null,
        network: "libera",
        position: `${hex(2n ** 53n + 11_000n, 14)}-${hex(11n, 14)}-${hex(0n, 8)}`,
        sequence: 11,
        timeline: iirc,
      },
    ],
    merged: [],
    removals: [],
    sequence: 11,
    timelines: [],
  });

const removals = (shown: ReturnType<typeof cardShown>) =>
  shown.body._tag === "Masks" ? shown.body.masks.map((one) => one.remove !== undefined) : [];

describe("/bans, /exceptions, and /invexes", () => {
  const context = inIirc();

  it("give a Look of the Channel in focus, or of the one named, on its Network", () => {
    expect([
      interpret("/bans", context),
      interpret("/exceptions #Other", context),
      interpret("/excepts", context),
      interpret("/invexes", context),
      interpret("/invitations &local", context),
    ]).toStrictEqual([
      { _tag: "Parsed", value: [listLookOf("Bans", "#iirc", network, timelineId(iirc))] },
      { _tag: "Parsed", value: [listLookOf("Exceptions", "#Other", network, timelineId(iirc))] },
      { _tag: "Parsed", value: [listLookOf("Exceptions", "#iirc", network, timelineId(iirc))] },
      { _tag: "Parsed", value: [listLookOf("Invitations", "#iirc", network, timelineId(iirc))] },
      { _tag: "Parsed", value: [listLookOf("Invitations", "&local", network, timelineId(iirc))] },
    ]);
  });

  it("leave a Channel's prefix to the Client while no head says the Network's CHANTYPES", () => {
    const unread = { ...contextOf(world(own)), head: undefined };

    expect(interpret("/bans $local", unread)).toMatchObject({
      _tag: "Parsed",
      value: [{ _tag: "Look", lookup: { _tag: "Bans", channel: "$local" } }],
    });
  });

  it("say in words why there is no Channel to look up", () => {
    expect({
      network: refusalOf("/bans", { ...contextOf(world(own)), head: undefined }),
      nick: refusalOf("/bans peer"),
      two: refusalOf("/invexes #a #b"),
    }).toStrictEqual({
      network: "Of which Channel? Open it, or name it: /bans [channel]",
      nick: "peer is no Channel's name. /bans [channel]",
      two: "Give one Channel. /invexes [channel]",
    });
  });

  it("are not offered where the head says the Network keeps no such list", () => {
    const keeps = { ...head, lists: { bans: "b", exceptions: null, invitations: "I" } };
    const unread = { ...contextOf(world(iirc)), head: undefined };

    expect({
      bans: unmet(whenOf("bans"), { ...context, head: keeps }),
      exceptions: unmet(whenOf("exceptions"), { ...context, head: keeps }),
      unread: unmet(whenOf("exceptions"), unread),
    }).toStrictEqual({
      bans: undefined,
      exceptions: "libera keeps no ban exceptions, by its ISUPPORT.",
      unread: undefined,
    });
  });
});

describe("a card of a Channel's list", () => {
  const named: LookupsEvent = { _tag: "Named", chantypes: "#&", declared: "rfc1459", id: 1 };
  const bans = listLookOf("Bans", "#IIRC", network, timelineId(iirc));

  const listed = result({
    _tag: "Listed",
    cut: null,
    masks: [
      { mask: "bad!*@*", setAt: 1_700_000_000_000, setBy: "peer!u@h" },
      { mask: "‮evil!*@*", setAt: null, setBy: null },
    ],
    notes: [],
  });

  const unban = (mask: string) => ({
    act: {
      _tag: "Act",
      action: { _tag: "Mode", changes: [{ mode: "b", param: mask, set: false }], target: "#IIRC" },
      network,
    },
    mask,
  });

  it("shows each mask, who set it and when where said, and removes one while Self may", () => {
    const card = cardAfter([named, listed], bans);

    expect(cardShown(world(iirc), card, time, held(["o"]))).toStrictEqual({
      body: {
        _tag: "Masks",
        masks: [
          { mask: "bad!*@*", remove: unban("bad!*@*"), setAt: "T1700000000000", setBy: "peer!u@h" },
          {
            mask: "‮evil!*@*‬",
            remove: unban("‮evil!*@*"),
            setAt: undefined,
            setBy: undefined,
          },
        ],
        note: undefined,
      },
      kind: "Bans",
      notes: [],
      subject: { _tag: "Channel", name: "#IIRC" },
    });
  });

  it("offers removal only to an operator or higher, by the head of the list's own Channel", () => {
    const card = cardAfter([named, listed], bans);

    const elsewhereLook = listLookOf("Bans", "#Other", network, timelineId(iirc));
    const elsewhere = cardAfter([named, listed], elsewhereLook);

    expect({
      // Another Channel's list goes by its own head, never the one its Pane shows.
      elsewhere: removals(cardShown(world(iirc), elsewhere, time, held(["o"]))),
      elsewhereMember: removals(cardShown(world(iirc), elsewhere, time, otherHead(["v"]))),
      elsewhereOperator: removals(cardShown(world(iirc), elsewhere, time, otherHead(["o"]))),
      member: removals(cardShown(world(iirc), card, time, held(["v"]))),
      noHead: removals(cardShown(world(iirc), card, time)),
      notKept: removals(
        cardShown(world(iirc), card, time, {
          ...held(["o"]),
          lists: { bans: null, exceptions: null, invitations: null },
        })
      ),
      owner: removals(cardShown(world(iirc), card, time, held(["q"]))),
    }).toStrictEqual({
      elsewhere: [false, false],
      elsewhereMember: [false, false],
      elsewhereOperator: [true, true],
      member: [false, false],
      noHead: [false, false],
      notKept: [false, false],
      owner: [true, true],
    });
    expect([
      mayChangeLists(held(["o", "v"])),
      mayChangeLists({ ...held(["h"]), ranks: [...head.ranks, { mode: "h", symbol: "%" }] }),
      mayChangeLists(withHeld({ _tag: "Partial", at: 1, atLeast: ["o"], from: "ircd" })),
      mayChangeLists(withHeld({ _tag: "Stale", since: 1, was: ["o"] })),
      mayChangeLists(head),
    ]).toStrictEqual([true, false, true, false, false]);
  });

  it("follows the Channel of each list's card, once its Timeline is found by its naming", () => {
    const state = fold([
      { _tag: "Asked", look: listLookOf("Bans", "#OTHER", network, timelineId(iirc)), pane: "p0" },
      {
        _tag: "Asked",
        look: listLookOf("Exceptions", "#other", network, timelineId(own)),
        pane: "p1",
      },
      { _tag: "Asked", look: whois(), pane: "p2" },
      {
        _tag: "Asked",
        look: listLookOf("Bans", "#nowhere", network, timelineId(iirc)),
        pane: "p3",
      },
    ]);

    let named2 = state;

    for (const id of [1, 2, 3, 4]) {
      named2 = reduceLookups(named2, { _tag: "Named", chantypes: "#&", declared: "rfc1459", id });
    }

    expect([listedChannels(state, world(iirc)), listedChannels(named2, world(iirc))]).toStrictEqual(
      [[], [{ network, timeline: timelineId(other) }]]
    );
  });

  it("hides a mask while its removal is in flight, and says when none is left", () => {
    const one = cardAfter(
      [named, listed, { _tag: "Removing", id: 1, intent: "web-1", mask: "bad!*@*" }],
      bans
    );

    const none = cardAfter(
      [
        named,
        listed,
        { _tag: "Removing", id: 1, intent: "web-1", mask: "bad!*@*" },
        { _tag: "Removing", id: 1, intent: "web-2", mask: "‮evil!*@*" },
      ],
      bans
    );

    expect({
      none: cardShown(world(iirc), none, time, held(["o"])).body,
      one: masksOf(cardShown(world(iirc), one, time, held(["o"]))),
    }).toStrictEqual({
      none: { _tag: "Said", words: "#IIRC has no bans." },
      one: ["‮evil!*@*‬"],
    });
  });

  it("shows a mask again when the act removing it is refused, at once or by the Ircd", () => {
    const removingBoth: readonly LookupsEvent[] = [
      named,
      listed,
      { _tag: "Removing", id: 1, intent: "web-1", mask: "bad!*@*" },
      { _tag: "Removing", id: 1, intent: "web-2", mask: "‮evil!*@*" },
    ];

    const atOnce = cardAfter([...removingBoth, { _tag: "Restored", intent: "web-2" }], bans);

    const byIrcd = cardAfter(
      [...removingBoth, { _tag: "Changed", change: refusedChange("web-1") }],
      bans
    );

    const other = fold([{ _tag: "Asked", look: bans, pane: "p0" }, ...removingBoth.slice(1)]);

    expect({
      atOnce: masksOf(cardShown(world(iirc), atOnce, time, held(["o"]))),
      byIrcd: masksOf(cardShown(world(iirc), byIrcd, time, held(["o"]))),
      missed: masksOf(
        cardShown(world(iirc), cardAfter([...removingBoth, { _tag: "Missed" }], bans), time)
      ),
      unrelated:
        reduceLookups(other, { _tag: "Changed", change: refusedChange("web-9") }) === other,
    }).toStrictEqual({
      atOnce: ["‮evil!*@*‬"],
      byIrcd: ["bad!*@*"],
      missed: ["bad!*@*", "‮evil!*@*‬"],
      unrelated: true,
    });
  });

  it("says in words a list cut short, refused, or of no Channel", () => {
    const words = (more: LookupsEvent, look: Look = bans) => {
      const { body } = cardShown(world(iirc), cardAfter([more], look), time);

      return body._tag === "Profiles" || body._tag === "Masks" ? body.note : body.words;
    };

    expect({
      bounded: words(
        result({
          _tag: "Listed",
          cut: "Bounded",
          masks: [{ mask: "a!*@*", setAt: null, setBy: null }],
          notes: [],
        })
      ),
      empty: words(result({ _tag: "Listed", cut: null, masks: [], notes: [] })),
      failed: words(result({ _tag: "Failed", notes: [], reply: "482" })),
      invitations: words(
        result({ _tag: "Listed", cut: null, masks: [], notes: [] }),
        listLookOf("Invitations", "#iirc", network, timelineId(iirc))
      ),
      noChannel: words(result({ _tag: "NotFound", notes: [], reply: "403" })),
      notOffered: words(result({ _tag: "Refused", reason: "NotOffered" })),
      unsendable: words(result({ _tag: "Refused", reason: "Unsendable" })),
    }).toStrictEqual({
      bounded: "The reply ran longer than a Lookup keeps, so this is how it began.",
      empty: "#IIRC has no bans.",
      failed: "The Network refused the Lookup (482).",
      invitations: "#iirc has no invitation masks.",
      noChannel: "The Network has no Channel #IIRC (403).",
      notOffered: "Not looked up: the Network keeps no such list, by its ISUPPORT.",
      unsendable: "Not looked up: the Network cannot be asked about that Channel.",
    });
  });
});
