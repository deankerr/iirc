import { ChannelHeader, Member, NetworkId, TimelineId } from "@iirc/api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { interpret } from "./commands.ts";
import type { CommandContext, Focus } from "./commands.ts";
import { initialNickMenus, nickEntries, presenceWanted, reduceNickMenus } from "./nick-menu.ts";
import type { NickMenus, NickMenusEvent, Presence } from "./nick-menu.ts";

const network = Schema.decodeSync(NetworkId)("libera");
const timeline = Schema.decodeSync(TimelineId)("00000000000002-00000000-00000000");
const other = Schema.decodeSync(TimelineId)("00000000000003-00000000-00000000");

const focus = (kind: Focus["kind"], name: string): Focus => ({
  detached: false,
  key: kind === "Network" ? undefined : name.toLowerCase(),
  kind,
  name,
  network,
  removed: false,
  timeline,
});

type Held = (typeof ChannelHeader.Encoded)["held"];

/**
 * `#iirc`'s head, on a Network whose `PREFIX` is `(qohv)~@%+`, with Self holding what is given.
 * @param held - The prefix modes Self holds, as far as known.
 * @returns The head.
 */
const headOf = (held: Held) =>
  Schema.decodeSync(ChannelHeader)({
    chanmodes: { always: "k", flags: "imnpst", list: "beI", whenSet: "l" },
    chantypes: "#&",
    held,
    lists: { bans: "b", exceptions: "e", invitations: "I" },
    members: 2,
    modes: { _tag: "Unknown" },
    name: "#iirc",
    network: "libera",
    ranks: [
      { mode: "q", symbol: "~" },
      { mode: "o", symbol: "@" },
      { mode: "h", symbol: "%" },
      { mode: "v", symbol: "+" },
    ],
    standing: "Joined",
    timeline,
    topic: { _tag: "Unknown" },
  });

const known = (value: readonly string[]): Held => ({
  _tag: "Known",
  at: 1,
  from: "ircd",
  value: [...value],
});

const around = {
  behind: false,
  draft: undefined,
  open: timeline,
  panes: 1,
  session: true,
  shown: [timeline],
  timelines: [timeline],
  unread: [],
  unreadClosed: [],
};

const inChannel = (held: Held): CommandContext => ({
  ...around,
  focus: focus("Channel", "#iirc"),
  head: headOf(held),
});

const here = (prefixes: readonly string[] | undefined): Presence => ({ _tag: "Here", prefixes });

const ids = (context: CommandContext, presence: Presence = here([])) =>
  nickEntries("peer", timeline, presence, context).map((entry) => entry.id);

const knownSet = (value: readonly string[]) =>
  Schema.decodeSync(Member.fields.prefixes)({
    _tag: "Known",
    at: 1,
    from: "ircd",
    value: [...value],
  });

const everyone = ["query", "whois", "mention", "ignore"];
const operator = [...everyone, "ban", "op", "deop", "voice", "devoice", "kick"];

describe("the menu on a nick", () => {
  it("runs the command the Composer would for each entry, and starts the Composer to mention", () => {
    const context = inChannel(known(["o"]));
    const entries = nickEntries("peer", timeline, here([]), context);

    const composed = (line: string) => {
      const read = interpret(line, context);

      return read._tag === "Parsed" ? read.value : read.message;
    };

    expect(entries.map((entry) => [entry.id, entry.label, entry.intents])).toStrictEqual([
      ["query", "Query peer", composed("/query peer")],
      ["whois", "Whois peer", composed("/whois peer")],
      ["mention", "Mention peer", [{ _tag: "FocusComposer", text: "peer: " }]],
      ["ignore", "Ignore peer", composed("/ignore peer")],
      ["ban", "Ban peer", composed("/ban peer")],
      ["op", "Op peer", composed("/op peer")],
      ["deop", "Deop peer", composed("/deop peer")],
      ["voice", "Voice peer", composed("/voice peer")],
      ["devoice", "Devoice peer", composed("/devoice peer")],
      ["kick", "Kick peer", composed("/kick peer")],
    ]);
  });

  it("offers to operate only where Self holds operator or a rank above it", () => {
    expect({
      halfop: ids(inChannel(known(["h"]))),
      none: ids(inChannel(known([]))),
      operator: ids(inChannel(known(["o"]))),
      owner: ids(inChannel(known(["q"]))),
      partial: ids(inChannel({ _tag: "Partial", at: 1, atLeast: ["o"], from: "ircd" })),
      stale: ids(inChannel({ _tag: "Stale", since: 1, was: ["o"] })),
      unknown: ids(inChannel({ _tag: "Unknown" })),
      unread: ids(inChannel(null)),
      voice: ids(inChannel(known(["v"]))),
    }).toStrictEqual({
      halfop: everyone,
      none: everyone,
      operator,
      owner: operator,
      partial: operator,
      stale: everyone,
      unknown: everyone,
      unread: everyone,
      voice: everyone,
    });
  });

  it("leaves out what needs the User there for one gone or not known to be there", () => {
    const context = inChannel(known(["o"]));

    expect({
      gone: ids(context, { _tag: "Gone" }),
      unknown: ids(context, { _tag: "Unknown" }),
    }).toStrictEqual({
      gone: [...everyone, "ban"],
      unknown: [...everyone, "ban"],
    });
  });

  it("offers no kick, deop, or devoice of a member who outranks Self, though op, voice, and ban", () => {
    const op = inChannel(known(["o"]));

    expect({
      founder: ids(op, here(["q"])),
      founderAndOp: ids(op, here(["q", "o"])),
    }).toStrictEqual({
      founder: [...everyone, "ban", "op", "voice"],
      founderAndOp: [...everyone, "ban", "op", "voice"],
    });
  });

  it("offers kick, deop, and devoice of a member of equal or lower rank", () => {
    const op = inChannel(known(["o"]));

    expect({
      equal: ids(op, here(["o"])),
      ownerOfOp: ids(inChannel(known(["q"])), here(["o"])),
      plain: ids(op, here([])),
      voiced: ids(op, here(["v"])),
    }).toStrictEqual({
      equal: operator,
      ownerOfOp: operator,
      plain: operator,
      voiced: operator,
    });
  });

  it("offers no kick, deop, or devoice of a member whose prefixes are not known", () => {
    expect(ids(inChannel(known(["o"])), here(undefined))).toStrictEqual([
      ...everyone,
      "ban",
      "op",
      "voice",
    ]);
  });

  it("places ban straight after ignore, before the entries that need the User there", () => {
    const context = inChannel(known(["o"]));

    expect(ids(context, { _tag: "Unknown" }).slice(3)).toStrictEqual(["ignore", "ban"]);
    expect(ids(context, here([])).slice(3, 5)).toStrictEqual(["ignore", "ban"]);
  });

  it("offers nothing to operate outside a Channel", () => {
    const direct: CommandContext = { ...around, focus: focus("Direct", "peer"), head: undefined };
    const own: CommandContext = { ...around, focus: focus("Network", "libera"), head: undefined };

    expect({ direct: ids(direct), own: ids(own) }).toStrictEqual({
      direct: everyone,
      own: everyone,
    });
  });

  it("acts only on its own Pane's Timeline, never the focused Pane's when that is another", () => {
    const elsewhere: CommandContext = {
      ...inChannel(known(["o"])),
      focus: { ...focus("Channel", "#other"), timeline: other },
      open: other,
    };

    const otherHead: CommandContext = {
      ...inChannel(known(["o"])),
      head: { ...headOf(known(["o"])), timeline: other },
    };

    expect({
      elsewhere: ids(elsewhere),
      otherHead: ids(otherHead),
    }).toStrictEqual({ elsewhere: [], otherHead: everyone });
  });

  it("offers only what runs without a Session, where nothing can be sent", () => {
    expect(ids({ ...inChannel(known(["o"])), session: false })).toStrictEqual([
      "query",
      "mention",
      "ignore",
    ]);
  });
});

const fold = (events: readonly NickMenusEvent[], from: NickMenus = initialNickMenus) => {
  let state = from;

  for (const event of events) {
    state = reduceNickMenus(state, event);
  }

  return state;
};

const opened: NickMenusEvent = { _tag: "Opened", channel: true, nick: "Peer", timeline };

describe("whether the User of a nick menu is in its Channel", () => {
  it("reads the Channel's members whose nick starts with theirs, under the menu's request", () => {
    const state = fold([opened]);

    expect({
      direct: presenceWanted(fold([{ _tag: "Opened", channel: false, nick: "peer", timeline }])),
      read: presenceWanted(
        fold(
          [
            {
              _tag: "MembersRead",
              casemapping: "rfc1459",
              members: [],
              more: false,
              request: 1,
            },
          ],
          state
        )
      ),
      wanted: presenceWanted(state),
    }).toStrictEqual({
      direct: undefined,
      read: undefined,
      wanted: { prefix: "Peer", request: 1, timeline },
    });
  });

  it("is there when a member's nick folds as theirs, gone when none does and none follow, and unknown otherwise", () => {
    const answered = (nicks: readonly string[], more: boolean, casemapping = "rfc1459" as const) =>
      fold([
        opened,
        {
          _tag: "MembersRead",
          casemapping,
          members: nicks.map((nick) => ({ nick, prefixes: knownSet(["o"]) })),
          more,
          request: 1,
        },
      ]).open?.presence;

    expect({
      failed: fold([opened, { _tag: "MembersFailed", request: 1 }]).open?.presence,
      folded: answered(["peer"], false),
      gone: answered(["peers"], false),
      longer: answered(["peerless"], true),
      unanswered: fold([opened]).open?.presence,
    }).toStrictEqual({
      failed: { _tag: "Unknown" },
      folded: here(["o"]),
      gone: { _tag: "Gone" },
      longer: { _tag: "Unknown" },
      unanswered: { _tag: "Unknown" },
    });
  });

  it("takes an answer only for the menu that asked", () => {
    const answer: NickMenusEvent = {
      _tag: "MembersRead",
      casemapping: "ascii",
      members: [{ nick: "Peer", prefixes: knownSet([]) }],
      more: false,
      request: 1,
    };

    const reopened = fold([opened, { _tag: "Closed", request: 1 }, opened, answer]);

    expect({
      closed: fold([opened, { _tag: "Closed", request: 1 }, answer]).open,
      reopened: reopened.open?.presence,
      wanted: presenceWanted(reopened),
    }).toStrictEqual({
      closed: undefined,
      reopened: { _tag: "Unknown" },
      wanted: { prefix: "Peer", request: 2, timeline },
    });
  });

  it("closes only the menu of the request closed", () => {
    expect(fold([opened, opened, { _tag: "Closed", request: 1 }]).open?.request).toBe(2);
  });
});
