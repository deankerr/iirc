import { NetworkId, ReadRequest, TimelineId } from "@iirc/api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { commandNamed, commands, interpret, unmet } from "./commands.ts";
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

const around = { open: undefined, panes: 1, shown: [], timelines: [], unread: [] };
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
