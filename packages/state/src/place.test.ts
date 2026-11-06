import { parseLine } from "@iirc/protocol/line";
import type { Line } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import { channelPlace, isUserMask, placeOf, placeOfSent, userPlace } from "./place.ts";
import type { Placed } from "./place.ts";
import { initialState, sessionState, stepState } from "./state.ts";
import type { IrcState } from "./state.ts";

const lineOf = (text: string): Line => {
  const parsed = parseLine(text);

  if (parsed._tag === "Unparseable") {
    throw new Error(`Expected a Line from ${text}`);
  }

  return parsed.line;
};

const replay = (from: IrcState, ...lines: readonly string[]) => {
  let state = from;

  for (const text of lines) {
    state = stepState(state, lineOf(text)).next;
  }

  return state;
};

const welcomed = replay(initialState, ":irc 001 me :Welcome");

const isupported = replay(
  welcomed,
  ":irc 005 me CHANTYPES=#&! STATUSMSG=@+ CASEMAPPING=rfc1459 :are supported"
);

// A place as the tests read it.
const shown = ({ place, statusmsg }: Placed) =>
  [
    place._tag === "Network" ? "network" : `${place._tag} ${place.key} (${place.name})`,
    ...(statusmsg === undefined ? [] : [`statusmsg ${statusmsg}`]),
  ].join(", ");

const placed = (state: IrcState, text: string) => shown(placeOf(state, lineOf(text)));

const sent = (state: IrcState, text: string) => shown(placeOfSent(state, lineOf(text)));

describe("placing a Line (MSG-2)", () => {
  it("MSG-2: anything before the welcome is the Network's, whatever it names", () => {
    expect(placed(initialState, ":bob!u@h PRIVMSG #iirc :early")).toBe("network");
    expect(placed(initialState, ":bob!u@h PRIVMSG me :early")).toBe("network");
    expect(placed(initialState, ":irc 001 me :Welcome")).toBe("network");
  });

  it.each([
    ["Target *", ":irc NOTICE * :*** Looking up your hostname"],
    ["Target AUTH", ":irc NOTICE AUTH :*** Checking Ident"],
    ["Target auth, in any case", ":bob!u@h NOTICE Auth :*** Checking Ident"],
    ["no source", "NOTICE me :who sent this?"],
    ["an Ircd's source", ":irc.example NOTICE me :Server is restarting"],
    ["an Ircd's source to a Channel", ":irc.example NOTICE #iirc :netsplit soon"],
    ["a bare nick", ":bob PRIVMSG me :hi"],
    ["a nick and host with no user", ":bob@h PRIVMSG me :hi"],
    ["no Target at all", ":bob!u@h PRIVMSG"],
  ])("MSG-2: %s is the Network's, so an Ircd's notice is no Direct Message", (_why, text) => {
    expect(placed(isupported, text)).toBe("network");
  });

  it("MSG-2: a Channel Target is that Channel's, keyed under the mapping in force (KNOW-3)", () => {
    expect(placed(isupported, ":bob!u@h PRIVMSG #Iirc[x] :hi")).toBe("Channel #iirc{x} (#Iirc[x])");
    expect(placed(isupported, ":bob!u@h PRIVMSG &local :hi")).toBe("Channel &local (&local)");
    expect(placed(isupported, ":bob!u@h PRIVMSG !safe :hi")).toBe("Channel !safe (!safe)");

    const ascii = replay(welcomed, ":irc 005 me CASEMAPPING=ascii :are supported");

    expect(placed(ascii, ":bob!u@h PRIVMSG #Iirc[x] :hi")).toBe("Channel #iirc[x] (#Iirc[x])");
  });

  it("MSG-2: a STATUSMSG prefix belongs to its Channel, and stays as an attribute", () => {
    expect(placed(isupported, ":bob!u@h NOTICE @#iirc :ops only")).toBe(
      "Channel #iirc (#iirc), statusmsg @"
    );
    expect(placed(isupported, ":bob!u@h PRIVMSG @+#iirc :voices too")).toBe(
      "Channel #iirc (#iirc), statusmsg @+"
    );
    // Without STATUSMSG, `@#iirc` names no Channel, and is a Direct Message from its sender.
    expect(placed(welcomed, ":bob!u@h NOTICE @#iirc :ops only")).toBe("User bob (bob)");
    // A prefix with nothing after it, or no Channel type after it, names no Channel.
    expect(placed(isupported, ":bob!u@h NOTICE @ :hm")).toBe("User bob (bob)");
    expect(placed(isupported, ":bob!u@h NOTICE @me :hm")).toBe("User bob (bob)");
  });

  describe("where STATUSMSG and CHANTYPES share a character", () => {
    const overlapping = replay(welcomed, ":irc 005 me CHANTYPES=#&+ STATUSMSG=@&+ :are supported");

    it("MSG-2: a prefix comes first, so `&#chan` is `#chan` for its `&` members", () => {
      expect(placed(overlapping, ":bob!u@h PRIVMSG &#chan :hello")).toBe(
        "Channel #chan (#chan), statusmsg &"
      );
      expect(placed(overlapping, ":bob!u@h PRIVMSG @+#chan :hello")).toBe(
        "Channel #chan (#chan), statusmsg @+"
      );
      expect(sent(overlapping, "PRIVMSG &#chan :hello")).toBe("Channel #chan (#chan), statusmsg &");
      expect(sent(overlapping, "NOTICE +#chan :hello")).toBe("Channel #chan (#chan), statusmsg +");
    });

    it("MSG-2: a Target that is no prefixed Channel is a Channel as it stands", () => {
      expect(placed(overlapping, ":bob!u@h PRIVMSG &local :hello")).toBe("Channel &local (&local)");
      expect(placed(overlapping, ":bob!u@h PRIVMSG +local :hello")).toBe("Channel +local (+local)");
      expect(sent(overlapping, "PRIVMSG &local :hello")).toBe("Channel &local (&local)");
      expect(sent(overlapping, "PRIVMSG +local :hello")).toBe("Channel +local (+local)");
      expect(placed(overlapping, ":bob!u@h PRIVMSG @local :hello")).toBe("User bob (bob)");
    });
  });

  it("MSG-2: a $ mask is the Network's", () => {
    expect(placed(isupported, ":oper!o@h NOTICE $*.example :maintenance")).toBe("network");
    expect(placed(isupported, ":oper!o@h PRIVMSG $$*.example :maintenance")).toBe("network");
  });

  it("MSG-2: a Line sourced from Self is Self's Message to its Target", () => {
    expect(placed(isupported, ":ME!u@h PRIVMSG Bob :from another session")).toBe("User bob (Bob)");
    expect(placed(isupported, ":me!u@h PRIVMSG #iirc :in a Channel")).toBe("Channel #iirc (#iirc)");
  });

  it("MSG-2: any other Target is a Direct Message from its sender, addressed to Self or not", () => {
    expect(placed(isupported, ":Bob[1]!u@h PRIVMSG me :hi")).toBe("User bob{1} (Bob[1])");
    expect(placed(isupported, ":bob!u@h PRIVMSG someone-else :misrouted")).toBe("User bob (bob)");
    expect(placed(isupported, ":bob!u@h INVITE me #secret")).toBe("User bob (bob)");
  });

  it("MSG-2: decides from the state before the Line, not from its words", () => {
    const named = replay(isupported, ":me!u@h NICK newme");

    expect(placed(named, ":newme!u@h PRIVMSG bob :mine")).toBe("User bob (bob)");
    expect(placed(named, ":me!u@h PRIVMSG bob :not mine any more")).toBe("User me (me)");
    expect(placed(isupported, ":bob!u@h PRIVMSG me :#iirc is where I am")).toBe("User bob (bob)");
  });

  it("KNOW-3: a forced mapping names places, over the Ircd's", () => {
    const forced = replay(
      sessionState({ casemapping: "ascii" }),
      ":irc 001 me :Welcome",
      ":irc 005 me CASEMAPPING=rfc1459 :are supported"
    );

    expect(placed(forced, ":Bob[1]!u@h PRIVMSG me :hi")).toBe("User bob[1] (Bob[1])");
  });

  it("an empty CHANTYPES names no Channel at all", () => {
    const none = replay(welcomed, ":irc 005 me CHANTYPES= :are supported");

    expect(placed(none, ":bob!u@h PRIVMSG #iirc :hi")).toBe("User bob (bob)");
  });
});

describe("placing a Line Self sent (MSG-2)", () => {
  it("MSG-2: is its Target's: a Channel, a $ mask's Network, or a User", () => {
    expect(sent(isupported, "PRIVMSG #Iirc :hello")).toBe("Channel #iirc (#Iirc)");
    expect(sent(isupported, "NOTICE +#iirc :voices")).toBe("Channel #iirc (#iirc), statusmsg +");
    expect(sent(isupported, "PRIVMSG $*.example :all")).toBe("network");
    expect(sent(isupported, "PRIVMSG Bob[1] :hi")).toBe("User bob{1} (Bob[1])");
    expect(sent(isupported, "PRIVMSG")).toBe("network");
  });
});

describe("places", () => {
  it("KNOW-3: a Channel and a User are keyed by their casefolded name, and keep its spelling", () => {
    expect(channelPlace(isupported, "#Foo[x]")).toStrictEqual({
      _tag: "Channel",
      key: "#foo{x}",
      name: "#Foo[x]",
    });
    expect(userPlace(isupported, "Bob\\")).toStrictEqual({
      _tag: "User",
      key: "bob|",
      name: "Bob\\",
    });
  });

  it.each([
    ["nick!user@host", true],
    ["n!u@", true],
    ["nick", false],
    ["nick@host", false],
    ["!user@host", false],
    ["nick!user", false],
    ["irc.example", false],
  ])("a source of %s is a User's mask: %s", (source, expected) => {
    expect(isUserMask(source)).toBe(expected);
  });
});
