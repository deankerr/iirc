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

const around = { open: undefined, timelines: [], unread: [] };
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
      "network.add": "Required",
      "notify.set": "Required",
      "options.set": "Optional",
      "options.unset": "Required",
      "palette.open": "None",
      "say.action": "Required",
      "say.notice": "Required",
      "say.privmsg": "Required",
      "say.to": "Required",
      "timeline.next": "None",
      "timeline.previous": "None",
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
