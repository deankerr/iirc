import { ChannelHeader, NetworkId, ReadRequest, TimelineId } from "@iirc/api";
import type { ActionRequest } from "@iirc/api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { commandNamed, commands, interpret, typesCredential, unmet } from "./commands.ts";
import type { CommandContext, Focus, MarkRead, Unseen } from "./commands.ts";

const network = Schema.decodeSync(NetworkId)("libera");
const timeline = Schema.decodeSync(TimelineId)("00000000000002-00000000-00000000");

const focus = (kind: Focus["kind"], name: string, detached = false): Focus => ({
  detached,
  key: kind === "Network" || detached ? undefined : name.toLowerCase(),
  kind,
  name,
  network,
  timeline,
});

const around = { head: undefined, open: undefined, panes: 1, shown: [], timelines: [], unread: [] };
const inChannel: CommandContext = { ...around, focus: focus("Channel", "#iirc"), session: true };
const inDirect: CommandContext = { ...around, focus: focus("Direct", "peer"), session: true };
const inNetwork: CommandContext = { ...around, focus: focus("Network", "libera"), session: true };
const offline: CommandContext = { ...around, focus: focus("Channel", "#iirc"), session: false };
const nowhere: CommandContext = { ...around, focus: undefined, session: false };

const say = (target: string, text: string, kind = "Privmsg", opens = false) => ({
  _tag: "Say",
  kind,
  network,
  opens,
  target,
  text,
});

const message = (line: string, context: CommandContext) => {
  const read = interpret(line, context);

  return read._tag === "Invalid" ? read.message : undefined;
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

  it("finds a command by name or alias in any case, and none for an unknown name", () => {
    expect({
      action: commandNamed("ACTION")?.id,
      me: commandNamed("Me")?.id,
      nothing: commandNamed("frobnicate"),
    }).toStrictEqual({ action: "say.action", me: "say.action", nothing: undefined });
  });

  it("says why a command cannot run, by its first unmet condition", () => {
    const me = commandNamed("me");

    expect(
      me === undefined
        ? []
        : [
            inChannel,
            inNetwork,
            offline,
            nowhere,
            { ...inDirect, focus: focus("Direct", "x", true) },
          ].map((context) => unmet(me.when, context) !== undefined)
    ).toStrictEqual([false, true, true, true, true]);
  });
});

describe("reading a line", () => {
  it("says plain text to the open Channel or Direct Message", () => {
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

  it("says `//text` as `/text`", () => {
    expect(interpret("//shrug", inChannel)).toStrictEqual({
      _tag: "Parsed",
      value: [say("#iirc", "/shrug")],
    });
  });

  it("says `/msg` to its Target and opens the Direct Message, from any Timeline", () => {
    expect(interpret("/msg peer hi  there", inNetwork)).toStrictEqual({
      _tag: "Parsed",
      value: [say("peer", "hi  there", "Privmsg", true)],
    });
  });

  it("sends `/notice` to its Target, opening nothing", () => {
    expect(interpret("/NOTICE #other heads up", inChannel)).toStrictEqual({
      _tag: "Parsed",
      value: [say("#other", "heads up", "Notice")],
    });
  });

  it("opens a Timeline by name with `/query`, from any Timeline of the Network", () => {
    expect({
      channel: interpret("/query peer", inChannel),
      list: message("/query a,b", inChannel),
      network: interpret("/QUERY  {bob} ", inNetwork),
      none: message("/query", inChannel),
      nowhere: message("/query peer", nowhere),
      text: message("/query peer hi", inChannel),
    }).toStrictEqual({
      channel: { _tag: "Parsed", value: [{ _tag: "Query", name: "peer", network }] },
      list: "Give one nick. To say something to them, use /msg <nick> <text>.",
      network: { _tag: "Parsed", value: [{ _tag: "Query", name: "{bob}", network }] },
      none: "With whom? /query <nick>",
      nowhere: "Open a Timeline first.",
      text: "Give one nick. To say something to them, use /msg <nick> <text>.",
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

  it("refuses an unknown command, and a bare `/`, sending nothing", () => {
    expect([message("/frobnicate x", inChannel), message("/ x", inChannel)]).toStrictEqual([
      "There is no command /frobnicate. Start with // to say text that begins with /.",
      "Type a command after /, or start with // to say text that begins with /.",
    ]);
  });

  it("refuses missing arguments and a list of Targets", () => {
    expect([
      message("/me", inChannel),
      message("/msg", inChannel),
      message("/msg peer", inChannel),
      message("/msg a,b hi", inChannel),
    ]).toStrictEqual([
      "Say what? /me <text>",
      "To whom? /msg <target> <text>",
      "Say what? /msg <target> <text>",
      "Say it to one Target at a time.",
    ]);
  });

  it("refuses plain text in the Network's own Timeline, saying why, and takes commands there", () => {
    expect({
      msg: interpret("/msg peer hi", inNetwork)._tag,
      plain: message("hello", inNetwork),
    }).toStrictEqual({
      msg: "Parsed",
      plain:
        "The Network's own Timeline has no Target to say it to. Open a Channel or a Direct Message, or use /msg <target> <text>.",
    });
  });

  it("refuses to say anything on a Network with no Session", () => {
    expect([message("hello", offline), message("/msg peer hi", offline)]).toStrictEqual([
      "libera is not connected, so nothing can be said there now.",
      "libera is not connected, so nothing can be said there now.",
    ]);
  });

  it("moves to the next and previous Timeline, opens the palette, and focuses the composer, from anywhere", () => {
    const other = Schema.decodeSync(TimelineId)("00000000000003-00000000-00000000");
    const listed: CommandContext = { ...nowhere, open: timeline, timelines: [timeline, other] };

    expect({
      focus: interpret("/focus", nowhere),
      next: interpret("/next", listed),
      none: message("/next", nowhere),
      palette: interpret("/palette", nowhere),
      prev: interpret("/PREV", listed),
      trailing: message("/next 2", listed),
    }).toStrictEqual({
      focus: { _tag: "Parsed", value: [{ _tag: "FocusComposer", text: undefined }] },
      next: { _tag: "Parsed", value: [{ _tag: "Open", timeline: other }] },
      none: "There are no Timelines yet. Add a Network with /network add.",
      palette: { _tag: "Parsed", value: [{ _tag: "OpenPalette" }] },
      prev: { _tag: "Parsed", value: [{ _tag: "Open", timeline: other }] },
      trailing: "/next takes nothing after it.",
    });
  });

  it("says which commands take arguments, for the palette", () => {
    expect(
      Object.fromEntries(commands.map((one) => [one.id, one.arguments] as const))
    ).toStrictEqual({
      "act.away": "Optional",
      "act.back": "None",
      "act.ban": "Required",
      "act.deop": "Required",
      "act.devoice": "Required",
      "act.invite": "Required",
      "act.kick": "Required",
      "act.mode": "Required",
      "act.nick": "Required",
      "act.op": "Required",
      "act.quote": "Required",
      "act.topic": "Optional",
      "act.unban": "Required",
      "act.voice": "Required",
      "channels.join": "Required",
      "channels.part": "Optional",
      "composer.focus": "None",
      "members.toggle": "Optional",
      "network.add": "Required",
      "notify.set": "Required",
      "options.set": "Optional",
      "options.unset": "Required",
      "palette.open": "None",
      "pane.close": "None",
      "pane.equalize": "None",
      "pane.focus": "Required",
      "pane.grow": "None",
      "pane.shrink": "None",
      "pane.split": "Optional",
      "pane.swap": "Required",
      "pane.zoom": "None",
      "say.action": "Required",
      "say.notice": "Required",
      "say.privmsg": "Required",
      "say.to": "Required",
      "timeline.next": "None",
      "timeline.previous": "None",
      "timeline.query": "Required",
      "timeline.read": "Optional",
      "timeline.unread": "None",
    });
  });
});

const mark = (id: TimelineId, target: string | null): MarkRead => ({
  _tag: "MarkRead",
  network,
  read: Schema.decodeSync(ReadRequest)({ read: 1000, target: null }).read,
  target,
  timeline: id,
});

const unseen = (id: TimelineId, level: Unseen["level"], target: string | null): Unseen => ({
  level,
  mark: mark(id, target),
  timeline: id,
});

const outcome = (line: string, context: CommandContext) => {
  const read = interpret(line, context);

  return read._tag === "Parsed" ? read.value : read.message;
};

describe("what is unread", () => {
  const idOf = Schema.decodeSync(TimelineId);
  const own = idOf("00000000000001-00000000-00000000");
  const first = idOf("00000000000004-00000000-00000000");
  const second = idOf("00000000000005-00000000-00000000");
  const dm = idOf("00000000000006-00000000-00000000");

  // In the sidebar's order: the Network's own, two Channels, and a Direct Message.
  const unread: readonly Unseen[] = [
    unseen(own, "Activity", null),
    unseen(timeline, "Message", "#iirc"),
    unseen(first, "Highlight", "#a"),
    unseen(second, "Highlight", "#b"),
    unseen(dm, "Direct", "peer"),
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
      onlyActivity: outcome("/next-unread", opened(timeline, [unseen(own, "Activity", null)])),
      onlyOpen: outcome("/next-unread", opened(dm, [unseen(dm, "Direct", "peer")])),
    }).toStrictEqual({
      fromFirst: [{ _tag: "Open", timeline: second }],
      fromNone: [{ _tag: "Open", timeline: first }],
      lower: [{ _tag: "Open", timeline: dm }],
      // Activity alone is not worth a jump, and nothing to jump to takes the key quietly.
      onlyActivity: [],
      onlyOpen: [],
    });
  });

  it("marks the open Timeline read with /read, every one with /read all, and nothing when read", () => {
    expect({
      all: outcome("/read all", opened(timeline)),
      nothing: outcome("/read", opened(timeline, [])),
      nowhere: outcome("/read", { ...nowhere, unread }),
      open: outcome("/read", opened(timeline)),
      other: outcome("/read everything", opened(timeline)),
    }).toStrictEqual({
      all: unread.map((one) => one.mark),
      nothing: [],
      nowhere: "Open a Timeline first, or use /read all.",
      open: [mark(timeline, "#iirc")],
      other: "Use /read for the open Timeline, or /read all for every Timeline.",
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

describe("the Panes", () => {
  const idOf = Schema.decodeSync(TimelineId);
  const calling = idOf("00000000000004-00000000-00000000");
  const shown = idOf("00000000000005-00000000-00000000");

  it("splits side by side, or one above another, opening what calls most that no Pane shows", () => {
    const unread: readonly Unseen[] = [
      unseen(shown, "Highlight", "#shown"),
      unseen(calling, "Direct", "peer"),
    ];

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

  it("closes, moves, swaps, equalizes, zooms, grows, and shrinks, with more than one Pane", () => {
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
      oneOnly: "There is only one Pane. /split makes another.",
      shrink: [{ _tag: "Shrink" }],
      swap: [{ _tag: "Swap", direction: "Down" }],
      trailing: "/zoom takes nothing after it.",
      zoom: [{ _tag: "Zoom" }],
    });
  });
});

const headOf = (
  options: {
    readonly topic?: (typeof ChannelHeader.Encoded)["topic"];
    readonly ranks?: (typeof ChannelHeader.Encoded)["ranks"];
    readonly chanmodes?: (typeof ChannelHeader.Encoded)["chanmodes"];
    readonly chantypes?: string;
  } = {}
) =>
  Schema.decodeSync(ChannelHeader)({
    chanmodes: options.chanmodes ?? { always: "k", flags: "imnpst", list: "beI", whenSet: "l" },
    chantypes: options.chantypes ?? "#&",
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

describe("acting on a Network", () => {
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
      none: "Kick whom? /kick <nick>[,<nick>…] [reason]",
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
      extra: "Nothing takes x. /mode [target] <changes> [parameters…]",
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
      selfParams: "Self's modes take no parameters here. Use /quote MODE iirc … for that.",
      unknownLetter: "libera has no Channel mode q, as its CHANMODES and PREFIX say.",
      unsigned: '"o" is not a mode change: give signs and letters, such as +o or -v+l.',
    });
  });

  it("takes a first word as a `+` Channel only where CHANTYPES has `+` and changes follow", () => {
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
      typesCredential("/rAw @+a=b oPeR admin pw"),
      typesCredential("/QUOTE Pass x"),
      typesCredential("/raw @+a=b :me AUTHENTICATE +"),
      typesCredential("/quote PRIVMSG #a :pass"),
      typesCredential("//quote PASS x"),
    ]).toStrictEqual([
      "A Credential never goes in a raw Line: PASS, AUTHENTICATE, and OPER carry one, and a raw Line is journaled whole. It was cleared, and nothing was sent.",
      "A Credential never goes in a raw Line: PASS, AUTHENTICATE, and OPER carry one, and a raw Line is journaled whole. It was cleared, and nothing was sent.",
      "A Credential never goes in a raw Line: PASS, AUTHENTICATE, and OPER carry one, and a raw Line is journaled whole. It was cleared, and nothing was sent.",
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it("needs the Network's rules for a Channel's modes, and a target outside a Channel", () => {
    expect({
      fromNetwork: words("/mode +m", { ...inNetwork, head: undefined }),
      unread: words("/mode +m", inChannel),
    }).toStrictEqual({
      fromNetwork:
        "Name whose modes to change, or open the Channel. /mode [target] <changes> [parameters…]",
      unread:
        "The modes libera has are not known yet: open a Channel on it, wait for its head to be read, and try again.",
    });
  });

  it("gives and takes ranks as Mode, and says when the Network's PREFIX has no such rank", () => {
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
      noVoice: "libera has no voice rank (v): its PREFIX gives @ (o).",
      none: "Whom? /op <nick>…",
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
      noBans: "libera has no ban list (b) in its CHANMODES.",
      unban: act({
        _tag: "Mode",
        changes: [{ mode: "b", param: "*!*@bad.test", set: false }],
        target: "#iirc",
      }),
    });
  });

  it("invites to the open Channel or one named, sets away and back, a nick, and a raw Line", () => {
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
      inviteFromNetwork: "To which Channel? /invite <nick> <channel>, or open the Channel.",
      inviteNamed: act({ _tag: "Invite", channel: "#other", nick: "peer" }),
      nick: act({ _tag: "Nick", nick: "other" }),
      nickTwo: 'Give one nick, not "a b".',
      quote: act({ _tag: "Raw", line: "WHOIS peer" }),
      quoteNone: "Send what? /quote <raw line>",
      raw: act({ _tag: "Raw", line: "PING x" }),
    });
  });

  it("acts only where it can: a Channel's commands in a Channel, and with a Session but for away", () => {
    expect({
      awayOffline: interpret("/away brb", offline),
      kickInDirect: message("/kick peer", inDirect),
      kickOffline: message("/kick peer", offline),
      nickOffline: message("/nick other", offline),
      topicInNetwork: message("/topic hi", inNetwork),
    }).toStrictEqual({
      awayOffline: act({ _tag: "Away", message: "brb" }),
      kickInDirect: "Open a Channel first.",
      kickOffline: "libera is not connected, so nothing can be said there now.",
      nickOffline: "libera is not connected, so nothing can be said there now.",
      topicInNetwork: "Open a Channel first.",
    });
  });
});
