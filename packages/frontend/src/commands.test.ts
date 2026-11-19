import { ChannelHeader, NetworkId, ReadRequest, TimelineId } from "@iirc/api";
import type { ActionRequest } from "@iirc/api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { credentialRefusal, commands, interpret, typesCredential } from "./commands.ts";
import type { CommandContext, Focus, MarkRead, Unseen } from "./commands.ts";

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

  it("says nothing in a Direct Message that no longer follows its partner, saying why", () => {
    const detached: CommandContext = { ...inDirect, focus: focus("Direct", "x", true) };

    const why =
      "This Direct Message no longer follows its partner, who changed nick. Use /msg <nick> <text>.";

    expect([message("hello", detached), message("/me waves", detached)]).toStrictEqual([why, why]);
  });
});

const closing = (target: string) => ({
  _tag: "Parsed",
  value: [{ _tag: "CloseTimeline", network, target }],
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

  it("says what is typed in a Direct Message not yet begun to its nick, opening it once placed", () => {
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
      empty: "Say what? Type it after /say.",
      literal: { _tag: "Parsed", value: [say("bob", "/shrug", "Privmsg", true)] },
      offline: "libera is not connected, so nothing can be said there now.",
      // Any other command reads as anywhere else: with no Timeline in focus, it needs one.
      other: { _tag: "Invalid", message: "Open a Timeline first." },
      plain: { _tag: "Parsed", value: [say("bob", "hello", "Privmsg", true)] },
      said: { _tag: "Parsed", value: [say("bob", "hi", "Privmsg", true)] },
    });
  });

  it("connects and disconnects a Network by setting its `enabled`, the focused one unless named", () => {
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
      bad: 'A Network\'s id is 1 to 64 lower-case letters, digits, ., _, or -, not "Not-An-Id". /connect [id]',
      connect: enabled("on"),
      disconnect: enabled("off"),
      drafting: enabled("off"),
      named: enabled("on", oftc),
      namedOff: enabled("off", oftc),
      none: "Name a Network, or open one of its Timelines first. /connect [id]",
    });
  });

  it("asks to remove a Network, the focused one unless named, starting on keep or drop when given", () => {
    const oftc = Schema.decodeSync(NetworkId)("oftc");

    const asks = (on: typeof network, keep: boolean | undefined) => ({
      _tag: "Parsed",
      value: [{ _tag: "AskRemoval", keep, network: on }],
    });

    expect({
      bad: message("/network remove Not-An-Id", inChannel),
      drafting: interpret("/network remove", { ...nowhere, draft: { network, nick: "bob" } }),
      dropping: interpret("/network remove oftc drop", nowhere),
      focused: interpret("/network remove", inChannel),
      keeping: interpret("/network  remove  oftc  keep ", nowhere),
      // A removed Network's own Timeline asks again, which drops what was kept.
      kept: interpret("/network remove", { ...inChannel, focus: removedFocus }),
      named: interpret("/network remove oftc", inChannel),
      none: message("/network remove", nowhere),
      unknownChoice: message("/network remove oftc forget", nowhere),
    }).toStrictEqual({
      bad: 'A Network\'s id is 1 to 64 lower-case letters, digits, ., _, or -, not "Not-An-Id". /network remove [id] [keep|drop]',
      drafting: asks(network, undefined),
      dropping: asks(oftc, false),
      focused: asks(network, undefined),
      keeping: asks(oftc, true),
      kept: asks(network, undefined),
      named: asks(oftc, undefined),
      none: "Name a Network, or open one of its Timelines first. /network remove [id] [keep|drop]",
      unknownChoice: "Usage: /network remove [id] [keep|drop]",
    });
  });

  it("closes a Timeline by its Target, the focused one unless named, never a Network's own or a pane", () => {
    expect({
      channel: interpret("/close-timeline", inChannel),
      detached: message("/close-timeline", { ...inDirect, focus: focus("Direct", "x", true) }),
      direct: interpret("/close-timeline", inDirect),
      list: message("/close-timeline #a,#b", inChannel),
      named: interpret("/close-timeline  bob ", inNetwork),
      network: message("/close-timeline", inNetwork),
      // Offline, it is closed all the same: the Daemon journals it.
      offline: interpret("/close-timeline", offline),
      // `/close` closes a Pane, and never a Timeline.
      pane: message("/close", inChannel),
      removed: message("/close-timeline", { ...inChannel, focus: removedFocus }),
    }).toStrictEqual({
      channel: closing("#iirc"),
      detached:
        "This Direct Message no longer follows its partner, so it has no Target to close it by.",
      direct: closing("peer"),
      list: "Close one Timeline at a time. /close-timeline [#channel|nick]",
      named: closing("bob"),
      network:
        "A Network's own Timeline is never closed. Name a Channel or a nick, or open its Timeline. /close-timeline [#channel|nick]",
      offline: closing("#iirc"),
      pane: "There is only one Pane. /split makes another.",
      removed:
        "libera was removed, and its Timelines are kept only to read. Nothing can be said or done there. /network remove libera drops them.",
    });
  });

  it("says and does nothing in a removed Network's Timeline, but reads it and moves on", () => {
    const removed: CommandContext = { ...inChannel, focus: removedFocus, session: false };

    const refusal =
      "libera was removed, and its Timelines are kept only to read. Nothing can be said or done there. /network remove libera drops them.";

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

  it("shows the Uploads with `/uploads`, from anywhere, and takes nothing after it", () => {
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

  it("refuses to say anything while whether the Network has a Session is not known, without calling it not connected", () => {
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
      "Whether libera is connected is not known yet, so nothing can be said there now.",
      "Whether libera is connected is not known yet, so nothing can be said there now.",
      "Whether libera is connected is not known yet, so nothing can be said there now.",
    ]);
  });

  it("moves to the next and previous Timeline, and focuses the composer or starts a command in it, from anywhere", () => {
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
      none: "There are no Timelines yet. Add a Network with /network add.",
      palette: "There is no command /palette. Start with // to say text that begins with /.",
      prev: { _tag: "Parsed", value: [{ _tag: "Open", timeline: other }] },
      started: { _tag: "Parsed", value: [{ _tag: "StartCommand", text: "/go " }] },
      trailing: "/next takes nothing after it.",
    });
  });

  it("moves the open Timeline up or down with /move, and pins or unpins it with /pin, which the Network's own Timeline never is", () => {
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
        "libera's own Timeline is the Network's row, so it is not pinned. /move moves the Network.",
      networkMoved: [{ _tag: "Arrange", edit: { _tag: "Move", direction: "Up", timeline } }],
      nowhere: "Open a Timeline first.",
      pin: [{ _tag: "Arrange", edit: { _tag: "Pin", timeline } }],
      trailing: "/pin takes nothing after it.",
      which: "Move it which way? /move up|down",
    });
  });

  it("jumps to the open Timeline's latest with /latest, and takes nothing after it", () => {
    const run = (line: string) => interpret(line, inChannel);

    expect([run("/latest"), run("/latest now"), interpret("/latest", nowhere)]).toStrictEqual([
      { _tag: "Parsed", value: [{ _tag: "Latest", timeline: inChannel.focus?.timeline }] },
      { _tag: "Invalid", message: "/latest takes nothing after it." },
      { _tag: "Invalid", message: "Open a Timeline first." },
    ]);
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

describe("going to a Timeline by name", () => {
  const oftc = Schema.decodeSync(NetworkId)("oftc");
  const id = idAt;

  const named = [
    { kind: "Network", name: "libera", network, timeline: id(1) },
    { kind: "Channel", name: "#iirc", network, timeline: id(2) },
    { kind: "Direct", name: "Peer", network, timeline: id(3) },
    { kind: "Channel", name: "#iirc", network: oftc, timeline: id(4) },
    { kind: "Channel", name: "#debian", network: oftc, timeline: id(5) },
  ] as const;

  it("opens the one on the Network in focus, the one Network that has it, or the one on the Network named", () => {
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

  it("refuses a name no Timeline has, or one on several Networks with none in focus, in words with the usage", () => {
    const away: CommandContext = { ...nowhere, named };

    expect({
      ambiguous: chosen("/go #iirc", away),
      empty: chosen("/go", away),
      tooMany: chosen("/go libera #iirc more", away),
      unknown: chosen("/go #nowhere", away),
      unknownOnNetwork: chosen("/go oftc peer", away),
    }).toStrictEqual({
      ambiguous:
        "#iirc is on libera, oftc. Name its Network, as in /go libera #iirc. Usage: /go [network] <name>",
      empty: "Name a Timeline. Usage: /go [network] <name>",
      tooMany: "Give a name, or a Network's id and a name. Usage: /go [network] <name>",
      unknown: "There is no Timeline named #nowhere. Usage: /go [network] <name>",
      unknownOnNetwork: "There is no Timeline peer on oftc. Usage: /go [network] <name>",
    });
  });

  it("goes from a Direct Message not yet begun on its Network", () => {
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
          "tokyo_night is not a theme's name: 1 to 32 letters and digits, in words joined by -, such as tokyo-night.",
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
      set: outcome("/set -device ui.light nord", nowhere),
      setSystem: outcome("/set ui.dark system", nowhere),
      system: outcome("/theme -light system", nowhere),
      twice: outcome("/theme -device -device nord", nowhere),
    }).toStrictEqual({
      both: usage,
      dark: [{ _tag: "UseTheme", device: true, name: "dracula", option: "dark" }],
      darkFirst: [{ _tag: "UseTheme", device: true, name: "mine", option: "dark" }],
      deviceAlone: usage,
      light: [{ _tag: "UseTheme", device: false, name: "nord", option: "light" }],
      listed: [{ _tag: "StartCommand", text: "/theme -dark " }],
      listedLight: [{ _tag: "StartCommand", text: "/theme -light " }],
      set: [{ _tag: "ChangeUi", device: true, option: "light", value: "nord" }],
      setSystem:
        "ui.dark must not be system, which follows the device and draws no theme of its own.",
      system:
        "system follows the device, so it is never the theme drawn while the device is light. Name a theme, such as light.",
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
    ["a line that types a Credential", "/alias add p /quote PASS $1"],
    ["a line with no name", "/alias add"],
    ["a name with no line", "/alias add j"],
    ["a removal with no name", "/alias remove"],
    ["a removal of two names", "/alias remove j k"],
    ["a word it does not know", "/alias frob j"],
  ])("refuses %s", (_what, line) => {
    expect(interpret(line, inChannel)._tag).toBe("Invalid");
  });

  it("clears a line that makes an alias of a Credential's value, as it clears the Credential", () => {
    expect([
      credentialRefusal("/alias add p /quote PASS $1", []),
      credentialRefusal("/alias add p /quote PRIVMSG $1", []),
      credentialRefusal("/alias list", []),
    ]).toStrictEqual([
      "A Credential never goes in a raw Line: PASS and AUTHENTICATE carry one, and a raw Line is journaled whole. It was cleared, and nothing was sent.",
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

  it("refuses a line an alias expands to a Credential's value of, and clears it", () => {
    const aliases = [{ line: "/quote $*", name: "p" }];

    expect([
      typesCredential("/p PASS x", aliases),
      typesCredential("/P authenticate PLAIN", aliases),
      typesCredential("/p PRIVMSG #a :pass", aliases),
      typesCredential("/p PASS x", []),
      credentialRefusal("/p PASS x", aliases),
    ]).toStrictEqual([
      true,
      true,
      false,
      false,
      "A Credential never goes in a raw Line: PASS and AUTHENTICATE carry one, and a raw Line is journaled whole. It was cleared, and nothing was sent.",
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

  it("chooses the focused Timeline's own Previews with /previews, or returns it to ui.previews", () => {
    expect({
      default: chosen("/previews default"),
      links: chosen("/previews links"),
      linksOnly: chosen("/previews Links Only"),
      network: chosen("/previews off", inNetwork),
      none: chosen("/previews"),
      nowhere: chosen("/previews on", nowhere),
      on: chosen("/previews on"),
      removed: chosen("/previews on", { ...inChannel, focus: removedFocus }),
      sometimes: chosen("/previews sometimes"),
    }).toStrictEqual({
      default: [{ _tag: "ChoosePreviews", mode: undefined, timeline }],
      links: [{ _tag: "ChoosePreviews", mode: "links only", timeline }],
      linksOnly: [{ _tag: "ChoosePreviews", mode: "links only", timeline }],
      network: [{ _tag: "ChoosePreviews", mode: "off", timeline }],
      none: "Use /previews off, links, on, or default.",
      nowhere: "Open a Timeline first.",
      on: [{ _tag: "ChoosePreviews", mode: "on", timeline }],
      removed: [{ _tag: "ChoosePreviews", mode: "on", timeline }],
      sometimes: "Use /previews off, links, on, or default.",
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
      typesCredential("/rAw @+a=b oPeR admin pw", []),
      typesCredential("/QUOTE Pass x", []),
      typesCredential("/raw @+a=b :me AUTHENTICATE +", []),
      typesCredential("/quote PRIVMSG #a :pass", []),
      typesCredential("//quote PASS x", []),
    ]).toStrictEqual([
      "A Credential never goes in a raw Line: PASS and AUTHENTICATE carry one, and a raw Line is journaled whole. It was cleared, and nothing was sent.",
      "A Credential never goes in a raw Line: PASS and AUTHENTICATE carry one, and a raw Line is journaled whole. It was cleared, and nothing was sent.",
      "OPER carries a Credential, and a raw Line is journaled whole. Set network.<id>.oper.name and network.<id>.oper.credential instead, and Self opers as each Session begins. It was cleared, and nothing was sent.",
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
      "OPER carries a Credential, and a raw Line is journaled whole. Set network.<id>.oper.name and network.<id>.oper.credential instead, and Self opers as each Session begins. It was cleared, and nothing was sent.",
      "OPER carries a Credential, and a raw Line is journaled whole. Set network.<id>.oper.name and network.<id>.oper.credential instead, and Self opers as each Session begins. It was cleared, and nothing was sent.",
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
        "A CTCP request goes to one nick, never a Channel, a mask, or a list. /ctcp <nick> <command> [text]",
      ctcpDcc: "DCC is not sent. /ctcp <nick> <command> [text]",
      ctcpMask:
        "A CTCP request goes to one nick, never a Channel, a mask, or a list. /ctcp <nick> <command> [text]",
      ctcpNoCommand: "Which request? /ctcp <nick> <command> [text]",
      ctcpNone: "To whom? /ctcp <nick> <command> [text]",
      ctcpOffline: "libera is not connected, so nothing can be said there now.",
      ctcpPrefix:
        "Leave off the prefix @: a nick does not start with it. /ctcp <nick> <command> [text]",
      ctcpText: act({ _tag: "Ctcp", args: " are  you there ", command: "FINGER", nick: "peer" }),
      ping: act({ _tag: "Ping", nick: "peer" }),
      pingChannel:
        "A CTCP request goes to one nick, never a Channel, a mask, or a list. /ping <nick>",
      pingNone: "To whom? /ping <nick>",
      pingTwo: "Give one nick. /ping <nick>",
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
