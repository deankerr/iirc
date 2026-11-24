import { ChannelHeader, NetworkId, TimelineId, TimelineReadRequest } from "@iirc/api";
import type { ActionRequest } from "@iirc/api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { credentialRefusal, commands, interpret, typesCredential } from "./commands.ts";
import type { CommandContext, Focus, MarkRead, Unseen } from "./commands.ts";
import type { Moment } from "./search.ts";

const network = Schema.decodeSync(NetworkId)("libera");
const timeline = Schema.decodeSync(TimelineId)("00000000000002-00000000-00000000");

const focus = (kind: Focus["kind"], name: string, detached = false): Focus => ({
  detached,
  key: kind === "Network" || detached ? undefined : name.toLowerCase(),
  kind,
  name,
  network,
  removed: false,
  timeline,
});

const around = {
  aliases: [],
  behind: false,
  draft: undefined,
  head: undefined,
  named: [],
  open: undefined,
  panes: 1,
  shown: [],
  timelines: [],
  unread: [],
  unreadClosed: [],
};

const inChannel: CommandContext = { ...around, focus: focus("Channel", "#iirc"), session: true };
const inDirect: CommandContext = { ...around, focus: focus("Direct", "peer"), session: true };
const inNetwork: CommandContext = { ...around, focus: focus("Network", "libera"), session: true };
const offline: CommandContext = { ...around, focus: focus("Channel", "#iirc"), session: false };
const nowhere: CommandContext = { ...around, focus: undefined, session: false };
const removedFocus: Focus = { ...focus("Channel", "#iirc"), removed: true };

const say = (target: string, text: string, kind = "Privmsg", opens = false) => ({
  _tag: "Say",
  kind,
  network,
  opens,
  target,
  text,
});

/**
 * What going to a moment in the open Channel gives.
 * @param moment - The moment.
 * @returns The intents.
 */
const goes = (moment: Moment) => [
  { _tag: "GoToDate", moment, timeline: inChannel.focus?.timeline },
];

const dayOf = (year: number, month: number, day: number): Moment => ({
  _tag: "Day",
  day: { day, month, year },
});

const exports = (since: Moment | undefined, until: Moment | undefined) => [
  { _tag: "Export", since, timeline, until },
];

const atOf = (ms: number): Moment => ({
  _tag: "At",
  at: Schema.decodeSync(TimelineReadRequest)({ read: ms }).read,
});

const message = (line: string, context: CommandContext) => {
  const read = interpret(line, context);

  return read._tag === "Invalid" ? read.message : undefined;
};

/**
 * What a line gives, or why it gives nothing.
 * @param line - The line.
 * @param context - Where it is typed, a Direct Message unless given.
 * @returns Its intents, or the refusal's words.
 */
const chosen = (line: string, context: CommandContext = inDirect) => {
  const read = interpret(line, context);

  return read._tag === "Parsed" ? read.value : read.message;
};

describe("the command registry", () => {
  it("names each command once, by its name and aliases, in lower case", () => {
    const names = commands.flatMap((one) => [one.name, ...one.aliases]);

    expect({
      ids: new Set(commands.map((one) => one.id)).size,
      lower: names.every((name) => name === name.toLowerCase()),
      unique: new Set(names).size === names.length,
    }).toStrictEqual({ ids: commands.length, lower: true, unique: true });
  });

  it("says nothing in a direct message that no longer follows its partner, saying why", () => {
    const detached: CommandContext = { ...inDirect, focus: focus("Direct", "x", true) };

    const why =
      "The other person changed nick, so this direct message no longer follows them. Use /msg <nick> <text>.";

    expect([message("hello", detached), message("/me waves", detached)]).toStrictEqual([why, why]);
  });
});

const closing = (held: TimelineId) => ({
  _tag: "Parsed",
  value: [{ _tag: "CloseTimeline", network, timeline: held }],
});

const closingTarget = (target: string) => ({
  _tag: "Parsed",
  value: [{ _tag: "CloseTarget", network, target }],
});

describe("reading a line", () => {
  it("says plain text to the open channel or direct message", () => {
    expect([interpret("hello", inChannel), interpret("hi there", inDirect)]).toStrictEqual([
      { _tag: "Parsed", value: [say("#iirc", "hello")] },
      { _tag: "Parsed", value: [say("peer", "hi there")] },
    ]);
  });

  it("says `/me` as an action, and `/say` as plain text", () => {
    expect([interpret("/me waves", inChannel), interpret("/say /etc", inChannel)]).toStrictEqual([
      { _tag: "Parsed", value: [say("#iirc", "waves", "Action")] },
      { _tag: "Parsed", value: [say("#iirc", "/etc")] },
    ]);
  });

  it("says what is typed in a direct message not yet begun to its nick, opening it once placed", () => {
    const drafting: CommandContext = { ...nowhere, draft: { network, nick: "bob" }, session: true };
    const offline: CommandContext = { ...drafting, session: false };

    expect({
      action: interpret("/me waves", drafting),
      empty: message("/say", drafting),
      literal: interpret("//shrug", drafting),
      offline: message("hello", offline),
      other: interpret("/whois bob", drafting),
      plain: interpret("hello", drafting),
      said: interpret("/SAY hi", drafting),
    }).toStrictEqual({
      action: { _tag: "Parsed", value: [say("bob", "waves", "Action", true)] },
      empty: "Add a message after /say.",
      literal: { _tag: "Parsed", value: [say("bob", "/shrug", "Privmsg", true)] },
      offline: "libera is not connected, so you can't send there now.",
      // Any other command reads as anywhere else: with no Timeline in focus, it needs one.
      other: { _tag: "Invalid", message: "Open a conversation first." },
      plain: { _tag: "Parsed", value: [say("bob", "hello", "Privmsg", true)] },
      said: { _tag: "Parsed", value: [say("bob", "hi", "Privmsg", true)] },
    });
  });

  it("connects and disconnects a network by setting its `enabled`, the focused one unless named", () => {
    const enabled = (text: "on" | "off", on = network) => ({
      _tag: "Parsed",
      value: [{ _tag: "Configure", edit: { _tag: "Set", path: ["enabled"], text }, network: on }],
    });

    const oftc = Schema.decodeSync(NetworkId)("oftc");

    expect({
      bad: message("/connect Not-An-Id", inChannel),
      connect: interpret("/connect", inChannel),
      disconnect: interpret("/disconnect", inNetwork),
      drafting: interpret("/disconnect", { ...nowhere, draft: { network, nick: "bob" } }),
      named: interpret("/CONNECT  oftc ", nowhere),
      namedOff: interpret("/disconnect oftc", inChannel),
      none: message("/connect", nowhere),
    }).toStrictEqual({
      bad: 'A network\'s id is 1 to 64 lowercase letters, digits, ., _, or -, not "Not-An-Id". /connect [id]',
      connect: enabled("on"),
      disconnect: enabled("off"),
      drafting: enabled("off"),
      named: enabled("on", oftc),
      namedOff: enabled("off", oftc),
      none: "Name a network, or open one of its conversations first. /connect [id]",
    });
  });

  it("asks to remove a network, the focused one unless named, starting on keep or drop when given", () => {
    const oftc = Schema.decodeSync(NetworkId)("oftc");

    const asks = (on: typeof network, keep: boolean | undefined) => ({
      _tag: "Parsed",
      value: [{ _tag: "AskRemoval", keep, network: on }],
    });

    expect({
      bad: message("/network remove Not-An-Id", inChannel),
      drafting: interpret("/network remove", { ...nowhere, draft: { network, nick: "bob" } }),
      // One word that is a choice is the choice, about the focused Network or the draft's.
      dropFocused: interpret("/network remove drop", inChannel),
      dropNone: message("/network remove drop", nowhere),
      dropping: interpret("/network remove oftc drop", nowhere),
      focused: interpret("/network remove", inChannel),
      keepDrafting: interpret("/network remove keep", {
        ...nowhere,
        draft: { network, nick: "bob" },
      }),
      keepFocused: interpret("/network remove keep", inChannel),
      keepNone: message("/network remove keep", nowhere),
      keeping: interpret("/network  remove  oftc  keep ", nowhere),
      // A removed Network's own Timeline asks again, which drops what was kept.
      kept: interpret("/network remove", { ...inChannel, focus: removedFocus }),
      named: interpret("/network remove oftc", inChannel),
      // A Network whose id is a choice is named with both words.
      namedDrop: interpret("/network remove drop keep", nowhere),
      namedKeep: interpret("/network remove keep keep", nowhere),
      none: message("/network remove", nowhere),
      unknownChoice: message("/network remove oftc forget", nowhere),
    }).toStrictEqual({
      bad: 'A network\'s id is 1 to 64 lowercase letters, digits, ., _, or -, not "Not-An-Id". /network remove [id] [keep|drop]',
      drafting: asks(network, undefined),
      dropFocused: asks(network, false),
      dropNone:
        "Name a network, or open one of its conversations first. /network remove [id] [keep|drop]",
      dropping: asks(oftc, false),
      focused: asks(network, undefined),
      keepDrafting: asks(network, true),
      keepFocused: asks(network, true),
      keepNone:
        "Name a network, or open one of its conversations first. /network remove [id] [keep|drop]",
      keeping: asks(oftc, true),
      kept: asks(network, undefined),
      named: asks(oftc, undefined),
      namedDrop: asks(Schema.decodeSync(NetworkId)("drop"), true),
      namedKeep: asks(Schema.decodeSync(NetworkId)("keep"), true),
      none: "Name a network, or open one of its conversations first. /network remove [id] [keep|drop]",
      unknownChoice: "Usage: /network remove [id] [keep|drop]",
    });
  });

  it("closes a conversation by its id, the focused one unless named, never a network's own or a pane", () => {
    const held = Schema.decodeSync(TimelineId)("00000000000009-00000000-00000000");
    const named = [{ kind: "Direct", name: "Bob", network, timeline: held }] as const;

    expect({
      channel: interpret("/close-timeline", inChannel),
      // A Direct Message that no longer follows its partner has no Target, and closes by its id.
      detached: interpret("/close-timeline", { ...inDirect, focus: focus("Direct", "x", true) }),
      direct: interpret("/close-timeline", inDirect),
      list: message("/close-timeline #a,#b", inChannel),
      // A name is a Target, which the Network's Client resolves by its own naming, held or not.
      named: interpret("/close-timeline  bob ", { ...inNetwork, named }),
      network: message("/close-timeline", inNetwork),
      notHeld: interpret("/close-timeline @#elsewhere", { ...inNetwork, named }),
      // Offline, it is closed all the same: the Daemon journals it.
      offline: interpret("/close-timeline", offline),
      own: interpret("/close-timeline libera", {
        ...inChannel,
        named: [{ kind: "Network", name: "libera", network, timeline: held }],
      }),
      // `/close` closes a Pane, and never a Timeline.
      pane: message("/close", inChannel),
      // What a removed Network kept is closed too.
      removed: interpret("/close-timeline", { ...inChannel, focus: removedFocus }),
    }).toStrictEqual({
      channel: closing(timeline),
      detached: closing(timeline),
      direct: closing(timeline),
      list: "Close one conversation at a time. /close-timeline [#channel|nick]",
      named: closingTarget("bob"),
      network:
        "A network's own conversation can't be closed. Name a channel or nick, or open one. /close-timeline [#channel|nick]",
      notHeld: closingTarget("@#elsewhere"),
      offline: closing(timeline),
      own: closingTarget("libera"),
      pane: "There is only one pane. /split makes another.",
      removed: closing(timeline),
    });
  });

  it("names a removed network whose id is keep or drop with drop, in how to drop its conversations", () => {
    const removedAs = (["drop", "keep"] as const).map((id): CommandContext => ({
      ...inChannel,
      focus: { ...removedFocus, network: Schema.decodeSync(NetworkId)(id) },
    }));

    expect({
      drop: message("hello", removedAs[0] ?? inChannel),
      keep: message("hello", removedAs[1] ?? inChannel),
    }).toStrictEqual({
      drop: "drop was removed, so its conversations are read-only. /network remove drop drop drops them.",
      keep: "keep was removed, so its conversations are read-only. /network remove keep drop drops them.",
    });
  });

  it("says and does nothing in a removed network's conversation, but reads it and moves on", () => {
    const removed: CommandContext = { ...inChannel, focus: removedFocus, session: false };

    const refusal =
      "libera was removed, so its conversations are read-only. /network remove libera drops them.";

    expect({
      connect: message("/connect", removed),
      join: message("/join #more", removed),
      latest: interpret("/latest", removed)._tag,
      next: interpret("/next", { ...removed, timelines: [timeline] })._tag,
      say: message("hello", removed),
      topic: message("/topic new", removed),
      whois: message("/whois bob", removed),
    }).toStrictEqual({
      connect: refusal,
      join: refusal,
      latest: "Parsed",
      next: "Parsed",
      say: refusal,
      topic: refusal,
      whois: refusal,
    });
  });

  it("says `//text` as `/text`", () => {
    expect(interpret("//shrug", inChannel)).toStrictEqual({
      _tag: "Parsed",
      value: [say("#iirc", "/shrug")],
    });
  });

  it("says `/msg` to its channel or user and opens the direct message, from any conversation", () => {
    expect(interpret("/msg peer hi  there", inNetwork)).toStrictEqual({
      _tag: "Parsed",
      value: [say("peer", "hi  there", "Privmsg", true)],
    });
  });

  it("sends `/notice` to its channel or user, opening nothing", () => {
    expect(interpret("/NOTICE #other heads up", inChannel)).toStrictEqual({
      _tag: "Parsed",
      value: [say("#other", "heads up", "Notice")],
    });
  });

  it("opens a conversation by name with `/query`, from any conversation of the network", () => {
    expect({
      channel: interpret("/query peer", inChannel),
      list: message("/query a,b", inChannel),
      network: interpret("/QUERY  {bob} ", inNetwork),
      none: message("/query", inChannel),
      nowhere: message("/query peer", nowhere),
      text: message("/query peer hi", inChannel),
    }).toStrictEqual({
      channel: { _tag: "Parsed", value: [{ _tag: "Query", name: "peer", network }] },
      list: "Give one nick. To message them, use /msg <nick> <text>.",
      network: { _tag: "Parsed", value: [{ _tag: "Query", name: "{bob}", network }] },
      none: "Add a nick. /query <nick>",
      nowhere: "Open a conversation first.",
      text: "Give one nick. To message them, use /msg <nick> <text>.",
    });
  });

  it("shows, hides, or turns over the members with `/members`, from anywhere", () => {
    expect([
      interpret("/members", nowhere),
      interpret("/members ON", inChannel),
      interpret("/members off", inDirect),
      message("/members maybe", inChannel),
    ]).toStrictEqual([
      { _tag: "Parsed", value: [{ _tag: "ShowMembers", shown: undefined }] },
      { _tag: "Parsed", value: [{ _tag: "ShowMembers", shown: true }] },
      { _tag: "Parsed", value: [{ _tag: "ShowMembers", shown: false }] },
      "Use /members to show or hide them, or /members on or /members off.",
    ]);
  });

  it("shows, hides, or turns over the sidebar with `/sidebar`, from anywhere", () => {
    expect([
      interpret("/sidebar", nowhere),
      interpret("/sidebar on", inChannel),
      interpret("/sidebar OFF", inDirect),
      message("/sidebar later", inChannel),
    ]).toStrictEqual([
      { _tag: "Parsed", value: [{ _tag: "ShowSidebar", shown: undefined }] },
      { _tag: "Parsed", value: [{ _tag: "ShowSidebar", shown: true }] },
      { _tag: "Parsed", value: [{ _tag: "ShowSidebar", shown: false }] },
      "Use /sidebar to show or hide it, or /sidebar on or /sidebar off.",
    ]);
  });

  it("shows the uploads with `/uploads`, from anywhere, and takes nothing after it", () => {
    expect([
      interpret("/uploads", nowhere),
      interpret("/UPLOADS ", inChannel),
      message("/uploads all", inChannel),
    ]).toStrictEqual([
      { _tag: "Parsed", value: [{ _tag: "OpenUploads" }] },
      { _tag: "Parsed", value: [{ _tag: "OpenUploads" }] },
      "/uploads takes nothing after it.",
    ]);
  });

  it("refuses an unknown command, and a bare `/`, sending nothing", () => {
    expect([message("/frobnicate x", inChannel), message("/ x", inChannel)]).toStrictEqual([
      "There is no command /frobnicate. Start with // to send text that begins with /.",
      "Type a command after /, or start with // to send text that begins with /.",
    ]);
  });

  it("refuses missing arguments and a list of channels or users", () => {
    expect([
      message("/me", inChannel),
      message("/msg", inChannel),
      message("/msg peer", inChannel),
      message("/msg a,b hi", inChannel),
    ]).toStrictEqual([
      "Add a message. /me <text>",
      "Add a channel or user. /msg <target> <text>",
      "Add a message. /msg <target> <text>",
      "Send to one channel or user at a time.",
    ]);
  });

  it("refuses plain text in the network's own conversation, saying why, and takes commands there", () => {
    expect({
      msg: interpret("/msg peer hi", inNetwork)._tag,
      plain: message("hello", inNetwork),
    }).toStrictEqual({
      msg: "Parsed",
      plain:
        "You can't send from the network's own conversation. Open a channel or a direct message, or use /msg <target> <text>.",
    });
  });

  it("refuses to say anything on a network with no connection", () => {
    expect([message("hello", offline), message("/msg peer hi", offline)]).toStrictEqual([
      "libera is not connected, so you can't send there now.",
      "libera is not connected, so you can't send there now.",
    ]);
  });

  it("refuses to say anything while whether the network has a connection is not known, without calling it not connected", () => {
    const unknown: CommandContext = { ...offline, session: undefined };

    const drafting: CommandContext = {
      ...nowhere,
      draft: { network, nick: "bob" },
      session: undefined,
    };

    expect([
      message("hello", unknown),
      message("/msg peer hi", unknown),
      message("hello", drafting),
    ]).toStrictEqual([
      "Whether libera is connected is not known yet, so you can't send there now.",
      "Whether libera is connected is not known yet, so you can't send there now.",
      "Whether libera is connected is not known yet, so you can't send there now.",
    ]);
  });

  it("moves to the next and previous conversation, and focuses the composer or starts a command in it, from anywhere", () => {
    const other = Schema.decodeSync(TimelineId)("00000000000003-00000000-00000000");
    const listed: CommandContext = { ...nowhere, open: timeline, timelines: [timeline, other] };

    expect({
      focus: interpret("/focus", nowhere),
      next: interpret("/next", listed),
      none: message("/next", nowhere),
      palette: message("/palette", nowhere),
      prev: interpret("/PREV", listed),
      started: interpret("/focus /go ", nowhere),
      trailing: message("/next 2", listed),
    }).toStrictEqual({
      focus: { _tag: "Parsed", value: [{ _tag: "FocusComposer", text: undefined }] },
      next: { _tag: "Parsed", value: [{ _tag: "Open", timeline: other }] },
      none: "There are no conversations yet. Add a network with /network add.",
      palette: "There is no command /palette. Start with // to send text that begins with /.",
      prev: { _tag: "Parsed", value: [{ _tag: "Open", timeline: other }] },
      started: { _tag: "Parsed", value: [{ _tag: "StartCommand", text: "/go " }] },
      trailing: "/next takes nothing after it.",
    });
  });

  it("moves the open conversation up or down with /move, and pins or unpins it with /pin, which the network's own conversation never is", () => {
    expect({
      down: chosen("/move DOWN", inChannel),
      network: chosen("/pin", inNetwork),
      networkMoved: chosen("/move up", inNetwork),
      nowhere: message("/move up", nowhere),
      pin: chosen("/pin", inChannel),
      trailing: message("/pin now", inChannel),
      which: message("/move sideways", inChannel),
    }).toStrictEqual({
      down: [{ _tag: "Arrange", edit: { _tag: "Move", direction: "Down", timeline } }],
      network:
        "libera's own conversation is the network's row, so it can't be pinned. /move moves the network.",
      networkMoved: [{ _tag: "Arrange", edit: { _tag: "Move", direction: "Up", timeline } }],
      nowhere: "Open a conversation first.",
      pin: [{ _tag: "Arrange", edit: { _tag: "Pin", timeline } }],
      trailing: "/pin takes nothing after it.",
      which: "Move it up or down: /move up|down",
    });
  });

  it("mutes or unmutes the open conversation with /mute and /unmute, a network's own included, and refuses anything after them or no conversation", () => {
    expect({
      mute: chosen("/mute", inChannel),
      muteNetwork: chosen("/mute", inNetwork),
      nowhere: [message("/mute", nowhere), message("/unmute", nowhere)],
      trailing: [message("/mute now", inChannel), message("/unmute now", inChannel)],
      unmute: chosen("/unmute", inChannel),
    }).toStrictEqual({
      mute: [{ _tag: "Mute", muted: true, timeline }],
      muteNetwork: [{ _tag: "Mute", muted: true, timeline }],
      nowhere: ["Open a conversation first.", "Open a conversation first."],
      trailing: ["/mute takes nothing after it.", "/unmute takes nothing after it."],
      unmute: [{ _tag: "Mute", muted: false, timeline }],
    });
  });

  it("jumps to the open conversation's latest with /latest, and takes nothing after it", () => {
    const run = (line: string) => interpret(line, inChannel);

    expect([run("/latest"), run("/latest now"), interpret("/latest", nowhere)]).toStrictEqual([
      { _tag: "Parsed", value: [{ _tag: "Latest", timeline: inChannel.focus?.timeline }] },
      { _tag: "Invalid", message: "/latest takes nothing after it." },
      { _tag: "Invalid", message: "Open a conversation first." },
    ]);
  });

  it("goes to a date or a time with its zone in the open conversation with /date, as search reads them", () => {
    const run = (line: string) => chosen(line, inChannel);

    const usage =
      "/date takes a date, such as 2026-11-10, or a time with its zone, such as 2026-11-10T09:30Z or 2026-11-10T09:30+01:00.";

    expect([
      run("/date 2026-11-10"),
      run("/date  2026-11-10T09:30:15.25+01:00 "),
      run("/date 1969-12-31T23:59Z"),
      run("/date"),
      run("/date yesterday"),
      run("/date 2026-02-30"),
      run("/date 2026-11-10T09:30"),
      run("/date 2026-11-10 09:30"),
      chosen("/date 2026-11-10", nowhere),
    ]).toStrictEqual([
      goes({ _tag: "Day", day: { day: 10, month: 11, year: 2026 } }),
      [{ _tag: "GoToDate", moment: { _tag: "At", at: 1_794_299_415_250 }, timeline }],
      [{ _tag: "GoToDate", moment: { _tag: "At", at: -60_000 }, timeline }],
      `Add a date or time. ${usage}`,
      usage,
      `2026-02-30 is not a valid date. ${usage}`,
      `2026-11-10T09:30 needs a time zone, such as Z or +01:00, or a date alone. ${usage}`,
      usage,
      "Open a conversation first.",
    ]);
  });

  it("exports the open conversation with /export, the whole or between two moments read as search reads them, a day taken whole as until", () => {
    const run = (line: string) => chosen(line, inChannel);

    const usage =
      "/export takes an optional start and an optional end. Each is a date, such as 2026-11-10, or a time with its zone, such as 2026-11-10T09:30Z or 2026-11-10T09:30+01:00.";

    expect([
      run("/export"),
      run("/export 2026-11-01"),
      run("/export  2026-11-01   2026-11-02 "),
      run("/export 2026-11-02 2026-11-02"),
      run("/export 2026-12-30 2026-12-31"),
      run("/export 2026-11-01T09:30+01:00 2026-11-01T09:31Z"),
      run("/export 2026-11-01 2026-11-01T09:31Z"),
      run("/export 2026-11-03 2026-11-02"),
      run("/export 2026-11-01T09:31Z 2026-11-01T09:31Z"),
      run("/export 2026-11-01T09:31Z 2026-11-01T08:30Z"),
      run("/export yesterday"),
      run("/export 2026-11-01 2026-02-30"),
      run("/export 2026-11-01 2026-11-02 2026-11-03"),
      chosen("/export", nowhere),
    ]).toStrictEqual([
      exports(undefined, undefined),
      exports(dayOf(2026, 11, 1), undefined),
      exports(dayOf(2026, 11, 1), dayOf(2026, 11, 3)),
      exports(dayOf(2026, 11, 2), dayOf(2026, 11, 3)),
      exports(dayOf(2026, 12, 30), dayOf(2027, 1, 1)),
      exports(atOf(1_793_521_800_000), atOf(1_793_525_460_000)),
      exports(dayOf(2026, 11, 1), atOf(1_793_525_460_000)),
      "/export: the start must come before the end.",
      "/export: the start must come before the end.",
      "/export: the start must come before the end.",
      usage,
      `2026-02-30 is not a valid date. ${usage}`,
      usage,
      "Open a conversation first.",
    ]);
  });
});

const mark = (id: TimelineId): MarkRead => ({
  _tag: "MarkRead",
  network,
  read: Schema.decodeSync(TimelineReadRequest)({ read: 1000 }).read,
  timeline: id,
});

const unseen = (id: TimelineId, level: Unseen["level"]): Unseen => ({
  level,
  mark: mark(id),
  timeline: id,
});

const outcome = (line: string, context: CommandContext) => {
  const read = interpret(line, context);

  return read._tag === "Parsed" ? read.value : read.message;
};

/**
 * A Timeline's id, by its sequence.
 * @param sequence - Its sequence.
 * @returns The id.
 */
const idAt = (sequence: number) =>
  Schema.decodeSync(TimelineId)(`${sequence.toString(16).padStart(14, "0")}-00000000-00000000`);

/**
 * What opening a Timeline gives.
 * @param timeline - The Timeline.
 * @returns The intents.
 */
const opens = (timeline: TimelineId) => [{ _tag: "Open", timeline }];

describe("going to a conversation by name", () => {
  const oftc = Schema.decodeSync(NetworkId)("oftc");
  const id = idAt;

  const named = [
    { kind: "Network", name: "libera", network, timeline: id(1) },
    { kind: "Channel", name: "#iirc", network, timeline: id(2) },
    { kind: "Direct", name: "Peer", network, timeline: id(3) },
    { kind: "Channel", name: "#iirc", network: oftc, timeline: id(4) },
    { kind: "Channel", name: "#debian", network: oftc, timeline: id(5) },
  ] as const;

  it("opens the one on the network in focus, the one network that has it, or the one on the network named", () => {
    const here: CommandContext = { ...inChannel, named };

    expect({
      folded: chosen("/go peer", here),
      here: chosen("/go #IIRC", here),
      named: chosen("/go oftc #iirc", here),
      namedLoud: chosen("/go OFTC   #iirc ", here),
      network: chosen("/go libera", here),
      only: chosen("/go #debian", here),
    }).toStrictEqual({
      folded: opens(id(3)),
      here: opens(id(2)),
      named: opens(id(4)),
      namedLoud: opens(id(4)),
      network: opens(id(1)),
      only: opens(id(5)),
    });
  });

  it("refuses a name no conversation has, or one on several networks with none in focus, in words with the usage", () => {
    const away: CommandContext = { ...nowhere, named };

    expect({
      ambiguous: chosen("/go #iirc", away),
      empty: chosen("/go", away),
      tooMany: chosen("/go libera #iirc more", away),
      unknown: chosen("/go #nowhere", away),
      unknownOnNetwork: chosen("/go oftc peer", away),
    }).toStrictEqual({
      ambiguous:
        "#iirc is on libera, oftc. Name its network, as in /go libera #iirc. Usage: /go [network] <name>",
      empty: "Name a conversation. Usage: /go [network] <name>",
      tooMany: "Give a name, or a network's id and a name. Usage: /go [network] <name>",
      unknown: "There is no conversation named #nowhere. Usage: /go [network] <name>",
      unknownOnNetwork: "There is no conversation peer on oftc. Usage: /go [network] <name>",
    });
  });

  it("goes from a direct message not yet begun on its network", () => {
    const drafting: CommandContext = {
      ...nowhere,
      draft: { network: oftc, nick: "someone" },
      named,
      session: true,
    };

    expect(chosen("/go #iirc", drafting)).toStrictEqual(opens(id(4)));
  });
});

describe("themes", () => {
  it("lists, imports, draws in, and removes themes by /theme", () => {
    const usage = {
      _tag: "Invalid",
      message:
        "Usage: /theme [[-device] [-light | -dark] <name> | -light | -dark | import | remove <name>]",
    };

    expect({
      badName: interpret("/theme tokyo_night", nowhere),
      device: interpret("/theme -device Dracula", nowhere),
      deviceAlone: interpret("/theme -device", nowhere),
      importAfter: interpret("/theme import more", nowhere),
      imported: interpret("/theme IMPORT", nowhere),
      listed: interpret("/theme", nowhere),
      named: interpret("/theme Nord", nowhere),
      removeAlone: interpret("/theme remove", nowhere),
      removed: interpret("/theme remove mine", nowhere),
      twoWords: interpret("/theme nord dracula", nowhere),
    }).toStrictEqual({
      badName: {
        _tag: "Invalid",
        message:
          "tokyo_night is not a valid theme name: use 1 to 32 letters and digits, with words joined by -, such as tokyo-night.",
      },
      device: {
        _tag: "Parsed",
        value: [{ _tag: "UseTheme", device: true, name: "dracula", option: "theme" }],
      },
      deviceAlone: usage,
      importAfter: {
        _tag: "Invalid",
        message: "/theme import takes nothing after it: paste the theme into the dialog it opens.",
      },
      imported: { _tag: "Parsed", value: [{ _tag: "ImportTheme" }] },
      listed: { _tag: "Parsed", value: [{ _tag: "StartCommand", text: "/theme " }] },
      named: {
        _tag: "Parsed",
        value: [{ _tag: "UseTheme", device: false, name: "nord", option: "theme" }],
      },
      removeAlone: usage,
      removed: {
        _tag: "Parsed",
        value: [{ _tag: "EditThemes", edit: { _tag: "Remove", name: "mine" } }],
      },
      twoWords: usage,
    });
  });

  it("chooses the theme system draws while the device is light or dark by /theme -light and -dark, or by /set, never system", () => {
    const usage =
      "Usage: /theme [[-device] [-light | -dark] <name> | -light | -dark | import | remove <name>]";

    expect({
      both: outcome("/theme -light -dark nord", nowhere),
      dark: outcome("/theme -device -dark Dracula", nowhere),
      darkFirst: outcome("/theme -DARK -device mine", nowhere),
      deviceAlone: outcome("/theme -device -light", nowhere),
      light: outcome("/theme -light nord", nowhere),
      listed: outcome("/theme -dark", nowhere),
      listedLight: outcome("/theme -LIGHT", nowhere),
      set: outcome("/set -device ui.theme.light nord", nowhere),
      setSystem: outcome("/set ui.theme.dark system", nowhere),
      system: outcome("/theme -light system", nowhere),
      twice: outcome("/theme -device -device nord", nowhere),
    }).toStrictEqual({
      both: usage,
      dark: [{ _tag: "UseTheme", device: true, name: "dracula", option: "theme.dark" }],
      darkFirst: [{ _tag: "UseTheme", device: true, name: "mine", option: "theme.dark" }],
      deviceAlone: usage,
      light: [{ _tag: "UseTheme", device: false, name: "nord", option: "theme.light" }],
      listed: [{ _tag: "StartCommand", text: "/theme -dark " }],
      listedLight: [{ _tag: "StartCommand", text: "/theme -light " }],
      set: [{ _tag: "ChangeUi", device: true, option: "theme.light", value: "nord" }],
      setSystem:
        "ui.theme.dark must not be system, which follows the device and draws no theme of its own.",
      system:
        "system follows the device, so it can't be the theme for a light device. Name a theme, such as light.",
      twice: usage,
    });
  });
});

/**
 * A context with aliases made.
 * @param aliases - The aliases.
 * @param context - The context, in a Channel unless given.
 * @returns The context.
 */
const withAliases = (
  aliases: CommandContext["aliases"],
  context: CommandContext = inChannel
): CommandContext => ({ ...context, aliases });

describe("aliases of the Owner's own", () => {
  const join = { line: "/join", name: "j" };
  const me = { line: "/me $*", name: "m" };

  it("starts /alias with the aliases listed, and makes an alias of a name and a line, in any case", () => {
    expect([
      chosen("/alias"),
      chosen("/alias add j /join $1"),
      chosen("/ALIAS Add J   /Join  $1 "),
      chosen("/alias remove J"),
    ]).toStrictEqual([
      [{ _tag: "StartCommand", text: "/alias " }],
      [{ _tag: "EditAliases", edit: { _tag: "Add", alias: { line: "/join $1", name: "j" } } }],
      [{ _tag: "EditAliases", edit: { _tag: "Add", alias: { line: "/Join  $1", name: "j" } } }],
      [{ _tag: "EditAliases", edit: { _tag: "Remove", name: "j" } }],
    ]);
  });

  it.each([
    ["a name that is no alias's", "/alias add Bad_Name /join"],
    ["a name that is too long", `/alias add ${"x".repeat(33)} /join`],
    ["a command's name", "/alias add me /join $1"],
    ["a command's fixed alias", "/alias add raw /join $1"],
    ["/alias itself", "/alias add alias /join $1"],
    ["a line that is no command line", "/alias add j join $1"],
    ["a line that says text, with //", "/alias add j //join $1"],
    ["a line that is only a /", "/alias add j /"],
    ["a line that names another alias", "/alias add j /k $1"],
    ["a line that names no command", "/alias add j /frobnicate $1"],
    ["a line that names its command by a placeholder", "/alias add j /$1"],
    ["a line that types a password", "/alias add p /quote PASS $1"],
    ["a line with no name", "/alias add"],
    ["a name with no line", "/alias add j"],
    ["a removal with no name", "/alias remove"],
    ["a removal of two names", "/alias remove j k"],
    ["a word it does not know", "/alias frob j"],
  ])("refuses %s", (_what, line) => {
    expect(interpret(line, inChannel)._tag).toBe("Invalid");
  });

  it("clears a line that makes an alias of a password's value, as it clears the password", () => {
    expect([
      credentialRefusal("/alias add p /quote PASS $1", []),
      credentialRefusal("/alias add p /quote PRIVMSG $1", []),
      credentialRefusal("/alias list", []),
    ]).toStrictEqual([
      "Don't put a password in a raw command. PASS and AUTHENTICATE carry one, and history records raw commands whole. It was cleared and nothing was sent.",
      undefined,
      undefined,
    ]);
  });

  it("runs an alias as the command it stands for, under that command's own conditions", () => {
    const aliases = [join, me];

    expect({
      appended: chosen("/j #a", withAliases(aliases)),
      folded: chosen("/J #a", withAliases(aliases)),
      nowhere: chosen("/m waves", withAliases(aliases, nowhere)),
      offline: chosen("/m waves", withAliases(aliases, offline)),
      placeholder: chosen("/m  waves  hello ", withAliases(aliases)),
    }).toStrictEqual({
      appended: chosen("/join #a", inChannel),
      folded: chosen("/join #a", inChannel),
      nowhere: chosen("/me waves", nowhere),
      offline: chosen("/me waves", offline),
      placeholder: chosen("/me waves  hello", inChannel),
    });
  });

  it("refuses what an alias is given too few or too many words of, and runs nothing", () => {
    const aliases = [{ line: "/msg $1 $2", name: "tell" }];

    expect([
      interpret("/tell ann", withAliases(aliases))._tag,
      interpret("/tell ann hi there", withAliases(aliases))._tag,
      interpret("/tell ann hi", withAliases(aliases))._tag,
    ]).toStrictEqual(["Invalid", "Invalid", "Parsed"]);
  });

  it("never runs an alias a command's name or fixed alias takes", () => {
    const aliases = [
      { line: "/join #x", name: "me" },
      { line: "/join #x", name: "raw" },
    ];

    expect([
      chosen("/me waves", withAliases(aliases)),
      chosen("/raw PING x", withAliases(aliases)),
    ]).toStrictEqual([chosen("/me waves", inChannel), chosen("/quote PING x", inChannel)]);
  });

  it("runs an alias against the commands alone, so none runs another or says text", () => {
    const aliases = [
      { line: "/k #a", name: "j" },
      { line: "/join", name: "k" },
      { line: "/nothing $*", name: "z" },
      { line: "/$1", name: "y" },
    ];

    expect([
      interpret("/j", withAliases(aliases))._tag,
      interpret("/z #a", withAliases(aliases))._tag,
      interpret("/y /join", withAliases(aliases))._tag,
    ]).toStrictEqual(["Invalid", "Invalid", "Invalid"]);
  });

  it("says what an alias expands to in a direct message not yet begun to its nick", () => {
    const drafting: CommandContext = {
      ...withAliases([{ line: "/say $*", name: "s" }]),
      draft: { network, nick: "bob" },
      focus: undefined,
      session: true,
    };

    expect(interpret("/s hello there", drafting)).toStrictEqual({
      _tag: "Parsed",
      value: [say("bob", "hello there", "Privmsg", true)],
    });
  });

  it("refuses a line an alias expands to a password's value of, and clears it", () => {
    const aliases = [{ line: "/quote $*", name: "p" }];

    expect([
      typesCredential("/p PASS x", aliases),
      typesCredential("/P authenticate PLAIN", aliases),
      typesCredential("/p PRIVMSG #a :pass", aliases),
      typesCredential("/p PASS x", []),
      typesCredential("/q PASS x extra", [{ line: "/quote $1 $2", name: "q" }]),
      typesCredential("/q PASS", [{ line: "/quote $1 $2", name: "q" }]),
      credentialRefusal("/p PASS x", aliases),
    ]).toStrictEqual([
      true,
      true,
      false,
      false,
      true,
      true,
      "Don't put a password in a raw command. PASS and AUTHENTICATE carry one, and history records raw commands whole. It was cleared and nothing was sent.",
    ]);
  });
});

describe("what is unread", () => {
  const idOf = Schema.decodeSync(TimelineId);
  const own = idOf("00000000000001-00000000-00000000");
  const first = idOf("00000000000004-00000000-00000000");
  const second = idOf("00000000000005-00000000-00000000");
  const dm = idOf("00000000000006-00000000-00000000");

  // In the sidebar's order: the Network's own, two Channels, and a Direct Message.
  const unread: readonly Unseen[] = [
    unseen(own, "Activity"),
    unseen(timeline, "Message"),
    unseen(first, "Highlight"),
    unseen(second, "Highlight"),
    unseen(dm, "Direct"),
  ];

  const opened = (open: TimelineId | undefined, more: readonly Unseen[] = unread) => ({
    ...inChannel,
    open,
    timelines: [own, timeline, first, second, dm],
    unread: more,
  });

  it("jumps to the highest level, ties by the sidebar's order, skipping the open one", () => {
    expect({
      fromFirst: outcome("/next-unread", opened(first)),
      fromNone: outcome("/next-unread", opened(undefined)),
      lower: outcome(
        "/next-unread",
        opened(
          timeline,
          unread.filter((one) => one.level !== "Highlight")
        )
      ),
      onlyActivity: outcome("/next-unread", opened(timeline, [unseen(own, "Activity")])),
      onlyOpen: outcome("/next-unread", opened(dm, [unseen(dm, "Direct")])),
    }).toStrictEqual({
      fromFirst: [{ _tag: "Open", timeline: second }],
      fromNone: [{ _tag: "Open", timeline: first }],
      lower: [{ _tag: "Open", timeline: dm }],
      // Activity alone is not worth a jump, and nothing to jump to takes the key quietly.
      onlyActivity: [],
      onlyOpen: [],
    });
  });

  it("marks the open conversation read with /read, every one with /read all, and nothing when read", () => {
    expect({
      all: outcome("/read all", opened(timeline)),
      nothing: outcome("/read", opened(timeline, [])),
      nowhere: outcome("/read", { ...nowhere, unread }),
      open: outcome("/read", opened(timeline)),
      other: outcome("/read everything", opened(timeline)),
    }).toStrictEqual({
      all: unread.map((one) => one.mark),
      nothing: [],
      nowhere: "Open a conversation first, or use /read all.",
      open: [mark(timeline)],
      other: "Use /read for the open conversation, or /read all for every conversation.",
    });
  });

  it("turns notifications on or off, and says how otherwise", () => {
    expect([
      interpret("/notify on", nowhere),
      interpret("/notify OFF", nowhere),
      message("/notify", nowhere),
    ]).toStrictEqual([
      { _tag: "Parsed", value: [{ _tag: "Notify", on: true }] },
      { _tag: "Parsed", value: [{ _tag: "Notify", on: false }] },
      "Use /notify on or /notify off.",
    ]);
  });

  it("chooses the focused conversation's own Previews with /previews, or returns it to ui.previews", () => {
    expect({
      default: chosen("/previews default"),
      linksOnly: chosen("/previews links only"),
      network: chosen("/previews off", inNetwork),
      none: chosen("/previews"),
      nowhere: chosen("/previews on", nowhere),
      on: chosen("/previews on"),
      removed: chosen("/previews on", { ...inChannel, focus: removedFocus }),
      sometimes: chosen("/previews sometimes"),
      text: chosen("/previews Text"),
    }).toStrictEqual({
      default: [{ _tag: "ChoosePreviews", mode: undefined, timeline }],
      linksOnly: "Use /previews off, text, on, or default.",
      network: [{ _tag: "ChoosePreviews", mode: "off", timeline }],
      none: "Use /previews off, text, on, or default.",
      nowhere: "Open a conversation first.",
      on: [{ _tag: "ChoosePreviews", mode: "on", timeline }],
      removed: [{ _tag: "ChoosePreviews", mode: "on", timeline }],
      sometimes: "Use /previews off, text, on, or default.",
      text: [{ _tag: "ChoosePreviews", mode: "text", timeline }],
    });
  });
});

/**
 * What a line typed with two Panes changes of them, or why it does not.
 * @param line - The line.
 * @returns The changes, or the words.
 */
const pane = (line: string) => {
  const read = interpret(line, { ...inChannel, panes: 2 });

  return read._tag === "Parsed"
    ? read.value.map((intent) => (intent._tag === "Pane" ? intent.change : intent))
    : read.message;
};

describe("the panes", () => {
  const idOf = Schema.decodeSync(TimelineId);
  const calling = idOf("00000000000004-00000000-00000000");
  const shown = idOf("00000000000005-00000000-00000000");

  it("splits side by side, or one above another, opening what calls most that no pane shows", () => {
    const unread: readonly Unseen[] = [unseen(shown, "Highlight"), unseen(calling, "Direct")];

    const context = { ...inChannel, shown: [timeline, shown], unread };

    expect({
      bad: outcome("/split x", context),
      h: outcome("/split", context),
      nothing: outcome("/split v", { ...inChannel, shown: [timeline, shown] }),
      v: outcome("/split V", context),
    }).toStrictEqual({
      bad: "Use /split h for side by side, or /split v for one above another.",
      h: [{ _tag: "Pane", change: { _tag: "Split", axis: "Horizontal", timeline: calling } }],
      nothing: [{ _tag: "Pane", change: { _tag: "Split", axis: "Vertical", timeline: undefined } }],
      v: [{ _tag: "Pane", change: { _tag: "Split", axis: "Vertical", timeline: calling } }],
    });
  });

  it("closes, moves, swaps, equalizes, zooms, grows, and shrinks, with more than one pane", () => {
    expect({
      bad: pane("/pane over"),
      close: pane("/close"),
      equalize: pane("/equalize"),
      grow: pane("/grow"),
      move: pane("/pane LEFT"),
      oneOnly: outcome("/close", inChannel),
      shrink: pane("/shrink"),
      swap: pane("/swap down"),
      trailing: pane("/zoom in"),
      zoom: pane("/zoom"),
    }).toStrictEqual({
      bad: "Use /pane left, right, up, or down.",
      close: [{ _tag: "Close" }],
      equalize: [{ _tag: "Equalize" }],
      grow: [{ _tag: "Grow" }],
      move: [{ _tag: "Move", direction: "Left" }],
      oneOnly: "There is only one pane. /split makes another.",
      shrink: [{ _tag: "Shrink" }],
      swap: [{ _tag: "Swap", direction: "Down" }],
      trailing: "/zoom takes nothing after it.",
      zoom: [{ _tag: "Zoom" }],
    });
  });
});

const headOf = (
  options: {
    readonly accountBan?: (typeof ChannelHeader.Encoded)["accountBan"];
    readonly topic?: (typeof ChannelHeader.Encoded)["topic"];
    readonly ranks?: (typeof ChannelHeader.Encoded)["ranks"];
    readonly chanmodes?: (typeof ChannelHeader.Encoded)["chanmodes"];
    readonly chantypes?: string;
  } = {}
) =>
  Schema.decodeSync(ChannelHeader)({
    accountBan: options.accountBan ?? null,
    chanmodes: options.chanmodes ?? { always: "k", flags: "imnpst", list: "beI", whenSet: "l" },
    chantypes: options.chantypes ?? "#&",
    held: null,
    lists: { bans: "b", exceptions: "e", invitations: "I" },
    members: 2,
    modes: { _tag: "Unknown" },
    name: "#iirc",
    network: "libera",
    ranks: options.ranks ?? [
      { mode: "o", symbol: "@" },
      { mode: "v", symbol: "+" },
    ],
    standing: "Joined",
    timeline,
    topic: options.topic ?? {
      _tag: "Known",
      at: 1,
      from: "ircd",
      value: { setAt: null, setBy: null, text: "the \u0002old\u0002 topic" },
    },
  });

const acting: CommandContext = { ...inChannel, head: headOf() };

const act = (action: ActionRequest) => ({
  _tag: "Parsed",
  value: [{ _tag: "Act", action, network }],
});

const words = (line: string, context = acting) => {
  const read = interpret(line, context);

  return read._tag === "Invalid" ? read.message : read.value;
};

describe("acting on a network", () => {
  it("sets the topic exactly, clears it with -delete, and with nothing starts it for editing", () => {
    expect({
      clear: interpret("/topic -delete", acting),
      edit: interpret("/topic", acting),
      none: interpret("/topic", {
        ...acting,
        head: headOf({ topic: { _tag: "Known", at: 1, from: "ircd", value: null } }),
      }),
      set: interpret("/topic  a  new topic ", acting),
      stale: interpret("/topic", {
        ...acting,
        head: headOf({
          topic: { _tag: "Stale", since: 1, was: { setAt: null, setBy: null, text: "was" } },
        }),
      }),
      unknown: message("/topic", { ...acting, head: headOf({ topic: { _tag: "Unknown" } }) }),
      unread: message("/topic", inChannel),
    }).toStrictEqual({
      clear: act({ _tag: "Topic", channel: "#iirc", text: "" }),
      edit: {
        _tag: "Parsed",
        value: [{ _tag: "FocusComposer", text: "/topic the \u0002old\u0002 topic" }],
      },
      none: { _tag: "Parsed", value: [{ _tag: "FocusComposer", text: "/topic " }] },
      set: act({ _tag: "Topic", channel: "#iirc", text: " a  new topic " }),
      stale: { _tag: "Parsed", value: [{ _tag: "FocusComposer", text: "/topic was" }] },
      unknown:
        "The topic of #iirc is not known yet. Give the new topic: /topic [<text> | -delete].",
      unread: "The topic of #iirc is not known yet. Give the new topic: /topic [<text> | -delete].",
    });
  });

  it("kicks nicks, comma-separated, with the rest of the line as the reason", () => {
    expect({
      empty: words("/kick a,,b"),
      none: words("/kick"),
      one: interpret("/kick peer", acting),
      reason: interpret("/kick a,b  go away", acting),
    }).toStrictEqual({
      empty: 'Give nicks separated by single commas, not "a,,b".',
      none: "Add a nick. /kick <nick>[,<nick>…] [reason]",
      one: act({ _tag: "Kick", channel: "#iirc", nicks: ["peer"], reason: null }),
      reason: act({ _tag: "Kick", channel: "#iirc", nicks: ["a", "b"], reason: " go away" }),
    });
  });

  it("parses modes into changes, each taking a parameter as PREFIX and CHANMODES say", () => {
    expect({
      ban: words("/mode +b"),
      extra: words("/mode +m x"),
      many: interpret("/mode +ov-l+k a b key", acting),
      missing: words("/mode +o"),
      named: interpret("/mode #other -k+l key 5", acting),
      self: interpret("/mode iirc +i-w", acting),
      selfParams: words("/mode iirc +i x"),
      unknownLetter: words("/mode +q"),
      unsigned: words("/mode #iirc o peer"),
    }).toStrictEqual({
      ban: "+b needs a parameter. /mode [target] <changes> [parameters…]",
      extra: "No mode takes x. /mode [target] <changes> [parameters…]",
      many: act({
        _tag: "Mode",
        changes: [
          { mode: "o", param: "a", set: true },
          { mode: "v", param: "b", set: true },
          { mode: "l", param: null, set: false },
          { mode: "k", param: "key", set: true },
        ],
        target: "#iirc",
      }),
      missing: "+o needs a parameter. /mode [target] <changes> [parameters…]",
      named: act({
        _tag: "Mode",
        changes: [
          { mode: "k", param: "key", set: false },
          { mode: "l", param: "5", set: true },
        ],
        target: "#other",
      }),
      self: act({
        _tag: "Mode",
        changes: [
          { mode: "i", param: null, set: true },
          { mode: "w", param: null, set: false },
        ],
        target: "iirc",
      }),
      selfParams: "Your modes take no parameters here. Use /quote MODE iirc … for that.",
      unknownLetter: "libera does not support the channel mode q.",
      unsigned: '"o" is not a mode change: give signs and letters, such as +o or -v+l.',
    });
  });

  it("takes a first word as a `+` channel only where CHANTYPES has `+` and changes follow", () => {
    const plus = { ...acting, head: headOf({ chantypes: "#&+!" }) };

    expect({
      explicit: interpret("/mode +local +m", plus),
      focused: interpret("/mode +m", plus),
      focusedParam: interpret("/mode +l 5", plus),
      noPlus: words("/mode +local +m"),
    }).toStrictEqual({
      explicit: act({
        _tag: "Mode",
        changes: [{ mode: "m", param: null, set: true }],
        target: "+local",
      }),
      focused: act({
        _tag: "Mode",
        changes: [{ mode: "m", param: null, set: true }],
        target: "#iirc",
      }),
      focusedParam: act({
        _tag: "Mode",
        changes: [{ mode: "l", param: "5", set: true }],
        target: "#iirc",
      }),
      noPlus: "+o needs a parameter. /mode [target] <changes> [parameters…]",
    });
  });

  it("refuses a raw PASS, AUTHENTICATE, or OPER, by either name, in any case", () => {
    expect([
      words("/quote PASS x", inNetwork),
      words("/Raw authenticate PLAIN", inNetwork),
      words("/quote OPER admin pw", inNetwork),
      typesCredential("/rAw @+a=b oPeR admin pw", []),
      typesCredential("/QUOTE Pass x", []),
      typesCredential("/raw @+a=b :me AUTHENTICATE +", []),
      typesCredential("/quote PRIVMSG #a :pass", []),
      typesCredential("//quote PASS x", []),
    ]).toStrictEqual([
      "Don't put a password in a raw command. PASS and AUTHENTICATE carry one, and history records raw commands whole. It was cleared and nothing was sent.",
      "Don't put a password in a raw command. PASS and AUTHENTICATE carry one, and history records raw commands whole. It was cleared and nothing was sent.",
      "OPER carries a password, and history records raw commands whole. Set network.<id>.oper.name and network.<id>.oper.credential instead, and iirc signs in as an operator each time it connects. It was cleared and nothing was sent.",
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it("refuses /oper, which is configured instead, and clears it like a raw OPER", () => {
    expect([
      words("/oper admin pw", inNetwork),
      words("/OPER", inNetwork),
      typesCredential("/Oper admin pw", []),
      typesCredential("/pass x", []),
      typesCredential("/operator x", []),
      typesCredential("//oper admin pw", []),
    ]).toStrictEqual([
      "OPER carries a password, and history records raw commands whole. Set network.<id>.oper.name and network.<id>.oper.credential instead, and iirc signs in as an operator each time it connects. It was cleared and nothing was sent.",
      "OPER carries a password, and history records raw commands whole. Set network.<id>.oper.name and network.<id>.oper.credential instead, and iirc signs in as an operator each time it connects. It was cleared and nothing was sent.",
      true,
      true,
      false,
      false,
    ]);
  });

  it("needs the network's rules for a channel's modes, and a target outside a channel", () => {
    expect({
      fromNetwork: words("/mode +m", { ...inNetwork, head: undefined }),
      unread: words("/mode +m", inChannel),
    }).toStrictEqual({
      fromNetwork:
        "Name a nick or channel, or open a channel. /mode [target] <changes> [parameters…]",
      unread:
        "The modes libera supports are not known yet. Open a channel on it, wait for it to load, and try again.",
    });
  });

  it("gives and takes ranks as Mode, and says when the network's PREFIX has no such rank", () => {
    const noVoice = { ...acting, head: headOf({ ranks: [{ mode: "o", symbol: "@" }] }) };

    expect({
      deop: interpret("/deop a", acting),
      devoice: interpret("/devoice a", acting),
      noVoice: words("/voice peer", noVoice),
      none: words("/op"),
      op: interpret("/op a b,c", acting),
      voice: interpret("/voice peer", acting),
    }).toStrictEqual({
      deop: act({
        _tag: "Mode",
        changes: [{ mode: "o", param: "a", set: false }],
        target: "#iirc",
      }),
      devoice: act({
        _tag: "Mode",
        changes: [{ mode: "v", param: "a", set: false }],
        target: "#iirc",
      }),
      noVoice: "libera has no voice rank (v). Its ranks are @ (o).",
      none: "Add a nick. /op <nick>…",
      op: act({
        _tag: "Mode",
        changes: [
          { mode: "o", param: "a", set: true },
          { mode: "o", param: "b", set: true },
          { mode: "o", param: "c", set: true },
        ],
        target: "#iirc",
      }),
      voice: act({
        _tag: "Mode",
        changes: [{ mode: "v", param: "peer", set: true }],
        target: "#iirc",
      }),
    });
  });

  it("bans a bare nick as nick!*@*, and a mask as given", () => {
    const noBans = {
      ...acting,
      head: headOf({ chanmodes: { always: "k", flags: "imnpst", list: "", whenSet: "l" } }),
    };

    expect({
      ban: interpret("/ban peer *!*@bad.test", acting),
      noBans: words("/ban peer", noBans),
      unban: interpret("/unban *!*@bad.test", acting),
    }).toStrictEqual({
      ban: act({
        _tag: "Mode",
        changes: [
          { mode: "b", param: "peer!*@*", set: true },
          { mode: "b", param: "*!*@bad.test", set: true },
        ],
        target: "#iirc",
      }),
      noBans: "libera does not support bans.",
      unban: act({
        _tag: "Mode",
        changes: [{ mode: "b", param: "*!*@bad.test", set: false }],
        target: "#iirc",
      }),
    });
  });

  it("bans a user by account with /ban -a, one nick, where the network names accounts in bans", () => {
    const byAccount = {
      ...acting,
      head: headOf({ accountBan: { names: ["account", "a"], prefix: "~" } }),
    };

    const noBans = {
      ...byAccount,
      head: headOf({
        accountBan: { names: ["account"], prefix: "~" },
        chanmodes: { always: "k", flags: "imnpst", list: "", whenSet: "l" },
      }),
    };

    const usage = "Name the nick whose account to ban. /ban -a <nick>";

    expect({
      ban: interpret("/ban -a bob", byAccount),
      bareFlag: words("/ban -a", byAccount),
      channel: words("/ban -a #other", byAccount),
      mask: words("/ban -a bob!*@*", byAccount),
      noAccountBan: words("/ban -a bob", acting),
      noBans: words("/ban -a bob", noBans),
      noHead: words("/ban -a bob", { ...byAccount, head: undefined }),
      plain: interpret("/ban bob", byAccount),
      prefixed: words("/ban -a @bob", byAccount),
      // A nick is read whole, never cut at a space other than U+0020, so a ban by account
      // never falls on another User whose nick is its first part.
      spacedNick: interpret("/ban -a bob\u00A0", byAccount),
      spacedNickFirst: interpret("/ban -a \u00A0bob", byAccount),
      tabbed: interpret("/ban -a\tbob", byAccount),
      tabbedSpaced: interpret("/ban -a\t bob", byAccount),
      two: words("/ban -a bob eve", byAccount),
    }).toStrictEqual({
      ban: act({ _tag: "BanAccount", channel: "#iirc", nick: "bob" }),
      bareFlag: usage,
      channel: "A ban by account takes one nick, never a channel or a mask. /ban -a <nick>",
      mask: "A ban by account takes one nick, never a channel or a mask. /ban -a <nick>",
      noAccountBan: "libera does not support bans by account.",
      noBans: "libera does not support bans.",
      noHead:
        "The modes libera supports are not known yet. Open a channel on it, wait for it to load, and try again.",
      plain: act({
        _tag: "Mode",
        changes: [{ mode: "b", param: "bob!*@*", set: true }],
        target: "#iirc",
      }),
      prefixed: "Leave off the prefix @: a nick does not start with it. /ban -a <nick>",
      spacedNick: act({ _tag: "BanAccount", channel: "#iirc", nick: "bob\u00A0" }),
      spacedNickFirst: act({ _tag: "BanAccount", channel: "#iirc", nick: "\u00A0bob" }),
      tabbed: act({ _tag: "BanAccount", channel: "#iirc", nick: "bob" }),
      tabbedSpaced: act({ _tag: "BanAccount", channel: "#iirc", nick: "bob" }),
      two: "Ban one nick's account at a time. /ban -a <nick>",
    });
  });

  it("invites to the open channel or one named, sets away and back, a nick, and a raw command", () => {
    expect({
      away: interpret("/away gone fishing", acting),
      awayNone: interpret("/away", inNetwork),
      back: interpret("/back", inNetwork),
      backWords: words("/back now"),
      invite: interpret("/invite peer", acting),
      inviteFromNetwork: words("/invite peer", inNetwork),
      inviteNamed: interpret("/invite peer #other", inNetwork),
      nick: interpret("/nick other", inNetwork),
      nickTwo: words("/nick a b"),
      quote: interpret("/quote WHOIS peer", inNetwork),
      quoteNone: words("/quote "),
      raw: interpret("/raw PING x", inNetwork),
    }).toStrictEqual({
      away: act({ _tag: "Away", message: "gone fishing" }),
      awayNone: act({ _tag: "Away", message: null }),
      back: act({ _tag: "Away", message: null }),
      backWords: "/back takes nothing after it. To be away with a message, use /away <message>.",
      invite: act({ _tag: "Invite", channel: "#iirc", nick: "peer" }),
      inviteFromNetwork: "Add a channel. /invite <nick> <channel>, or open the channel.",
      inviteNamed: act({ _tag: "Invite", channel: "#other", nick: "peer" }),
      nick: act({ _tag: "Nick", nick: "other" }),
      nickTwo: 'Give one nick, not "a b".',
      quote: act({ _tag: "Raw", line: "WHOIS peer" }),
      quoteNone: "Add a raw command. /quote <raw command>",
      raw: act({ _tag: "Raw", line: "PING x" }),
    });
  });

  it("sets your real name for the connection, the rest of the line as typed, and only with a connection", () => {
    expect({
      none: words("/setname   "),
      offline: message("/setname Someone", offline),
      setname: interpret("/setname  Some  One ", inNetwork),
      setnameInChannel: interpret("/setname Someone", acting),
    }).toStrictEqual({
      none: "Add a name. /setname <real name>",
      offline: "libera is not connected, so you can't send there now.",
      setname: act({ _tag: "Setname", realname: " Some  One " }),
      setnameInChannel: act({ _tag: "Setname", realname: "Someone" }),
    });
  });

  it("sends a CTCP request to a nick, the rest of the line its text, and a PING", () => {
    expect({
      ctcp: interpret("/ctcp peer version", inNetwork),
      ctcpAction: words("/ctcp peer ACTION waves"),
      ctcpChannel: words("/ctcp #iirc VERSION", acting),
      ctcpDcc: words("/ctcp peer dcc send x"),
      ctcpMask: words("/ctcp *!*@host VERSION"),
      ctcpNoCommand: words("/ctcp peer"),
      ctcpNone: words("/ctcp "),
      ctcpOffline: message("/ctcp peer VERSION", offline),
      ctcpPrefix: words("/ctcp @peer VERSION", acting),
      ctcpText: interpret("/ctcp peer FINGER  are  you there ", inDirect),
      ping: interpret("/ping peer", acting),
      pingChannel: words("/ping #iirc", acting),
      pingNone: words("/ping"),
      pingTwo: words("/ping a b"),
    }).toStrictEqual({
      ctcp: act({ _tag: "Ctcp", args: "", command: "VERSION", nick: "peer" }),
      ctcpAction: "ACTION is what /me sends: /me <text>",
      ctcpChannel:
        "A CTCP request goes to one nick, never a channel, a mask, or a list. /ctcp <nick> <command> [text]",
      ctcpDcc: "DCC is not sent. /ctcp <nick> <command> [text]",
      ctcpMask:
        "A CTCP request goes to one nick, never a channel, a mask, or a list. /ctcp <nick> <command> [text]",
      ctcpNoCommand: "Add a request. /ctcp <nick> <command> [text]",
      ctcpNone: "Add a nick. /ctcp <nick> <command> [text]",
      ctcpOffline: "libera is not connected, so you can't send there now.",
      ctcpPrefix:
        "Leave off the prefix @: a nick does not start with it. /ctcp <nick> <command> [text]",
      ctcpText: act({ _tag: "Ctcp", args: " are  you there ", command: "FINGER", nick: "peer" }),
      ping: act({ _tag: "Ping", nick: "peer" }),
      pingChannel:
        "A CTCP request goes to one nick, never a channel, a mask, or a list. /ping <nick>",
      pingNone: "Add a nick. /ping <nick>",
      pingTwo: "Give one nick. /ping <nick>",
    });
  });

  it("acts only where it can: a channel's commands in a channel, and with a connection but for away", () => {
    expect({
      awayOffline: interpret("/away brb", offline),
      kickInDirect: message("/kick peer", inDirect),
      kickOffline: message("/kick peer", offline),
      nickOffline: message("/nick other", offline),
      topicInNetwork: message("/topic hi", inNetwork),
    }).toStrictEqual({
      awayOffline: act({ _tag: "Away", message: "brb" }),
      kickInDirect: "Open a channel first.",
      kickOffline: "libera is not connected, so you can't send there now.",
      nickOffline: "libera is not connected, so you can't send there now.",
      topicInNetwork: "Open a channel first.",
    });
  });
});

describe("the formatting commands", () => {
  it("open the formatting list by /format, and know no /colour", () => {
    expect({
      colour: interpret("/colour", inChannel),
      format: interpret("/format", inChannel),
      formatWith: interpret("/format bold", inChannel)._tag,
    }).toStrictEqual({
      colour: {
        _tag: "Invalid",
        message: "There is no command /colour. Start with // to send text that begins with /.",
      },
      format: { _tag: "Parsed", value: [{ _tag: "ChooseFormat" }] },
      formatWith: "Invalid",
    });
  });
});
