/**
 * Ignoring by mask: a Message or an Activity from a User one of the Owner's masks matches
 * is stamped with it, folded, and nothing is dropped. Self is never stamped. A mask taken
 * out of the Configuration is reported once, folded.
 */
import { IgnoreMask } from "@iirc/protocol/mask";
import { describe, expect, it } from "vitest";

import { client, makeClient } from "../core.ts";
import type { Feature } from "../feature.ts";
import { FeatureName } from "../ids.ts";
import { register, registry } from "../registry.ts";
import { configured, floorIsupport, joined, play, registered } from "../testing/index.ts";

// Every Line in a batch is history, as `chathistory` will make it.
const history: Feature = {
  label: (arrival) => ({
    value: arrival.batch === undefined ? arrival : { ...arrival, live: false },
  }),
  name: FeatureName.make("history"),
  needs: {},
  own: undefined,
};

const withHistory = makeClient([...registry, register(history)]);

const masks = (...texts: readonly string[]) => texts.map((text) => IgnoreMask.make(text));

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const ignoring = (...texts: readonly string[]) => configured({ ignores: masks(...texts) });

const unignored = (played: ReturnType<typeof play>) =>
  played.steps.flatMap((step) => step.news.filter((news) => news._tag === "Unignored"));

describe("a Message from an ignored User", () => {
  it("is stamped with the mask, and one from another User is not", () => {
    const base = ignoring("spam!*@*.bad.test");

    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc", ["spam", "peer"]),
        lines(
          "<< :spam!u@h.bad.test PRIVMSG #iirc :buy now",
          '?? message Privmsg spam #iirc ignored="spam!*@*.bad.test" in=channel:#iirc :buy now',
          "<< :spam!u@good.test PRIVMSG #iirc :hello",
          "?? message Privmsg spam #iirc in=channel:#iirc :hello",
          "<< :peer!u@h.bad.test PRIVMSG #iirc :hello",
          "?? message Privmsg peer #iirc in=channel:#iirc :hello"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is stamped as a Direct Message, a notice, and an action", () => {
    const base = ignoring("*!*@bad.test");

    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "<< :spam!u@bad.test PRIVMSG iirc :psst",
          '?? message Privmsg spam iirc ignored="*!*@bad.test" in=direct:spam :psst',
          "<< :spam!u@bad.test NOTICE iirc :psst",
          '?? message Notice spam iirc ignored="*!*@bad.test" in=direct:spam :psst',
          "<<\\ :spam!u@bad.test PRIVMSG iirc :\\x01ACTION waves\\x01",
          '?? message Action spam iirc ignored="*!*@bad.test" in=direct:spam :waves'
        ),
      ],
    });

    expect.assertions(0);
  });

  it("lists each mask it matches once, folded, in the Configuration's order", () => {
    const base = ignoring("*!*@*", "SPAM!*@*", "spam!*@*", "nobody!*@*");

    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc", ["spam"]),
        lines(
          "<< :Spam!u@h PRIVMSG #iirc :hi",
          '?? message Privmsg Spam #iirc ignored="*!*@*","spam!*@*" in=channel:#iirc :hi'
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is stamped from history too", () => {
    const base = ignoring("spam!*@*");

    play(withHistory, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["batch"] }),
        lines(
          "<< :irc.test BATCH +h chathistory iirc",
          "<< @batch=h :spam!u@h PRIVMSG iirc :old",
          '?? message Privmsg spam iirc history ignored="spam!*@*" in=direct:spam :old',
          "<< :irc.test BATCH -h"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is never stamped when the Ircd or a server said it", () => {
    const base = ignoring("*!*@*");

    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "<< :irc.test NOTICE iirc :welcome",
          "?? message Notice irc.test iirc in=network :welcome"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("an Activity by an ignored User", () => {
  it("is stamped when they join, part, quit, change nick, or are away", () => {
    const base = ignoring("spam!*@*");

    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc"),
        lines(
          "<< :spam!u@h JOIN #iirc",
          '?? activity Joined #iirc spam ignored="spam!*@*" in=channel:#iirc',
          "<< :spam!u@h NICK eggs",
          '?? activity NickChanged spam eggs ignored="spam!*@*" in=channel:#iirc in=renamed:spam>eggs',
          "<< :eggs!u@h PART #iirc :bye",
          "?? activity Parted #iirc eggs in=channel:#iirc :bye",
          "<< :spam2!u@h JOIN #iirc",
          "?? activity Joined #iirc spam2 in=channel:#iirc",
          "<< :spam!u@h JOIN #iirc",
          '?? activity Joined #iirc spam ignored="spam!*@*" in=channel:#iirc',
          "<< :spam!u@h QUIT :gone",
          '?? activity Quit spam ignored="spam!*@*" in=channel:#iirc in=existing-direct:spam :gone'
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is stamped for the one who set a mode or a topic or kicked, not the one it is about", () => {
    const base = ignoring("op!*@*");

    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc", ["op", "peer"]),
        lines(
          "<< :op!u@h MODE #iirc +v peer",
          '?? activity ModeChanged #iirc by=op +v=peer ignored="op!*@*" in=channel:#iirc',
          "<< :op!u@h TOPIC #iirc :new",
          '?? activity TopicChanged #iirc by=op setBy=op setAt=t+0s ignored="op!*@*" in=channel:#iirc :new',
          "<< :peer!u@h TOPIC #iirc :newer",
          "?? activity TopicChanged #iirc by=peer setBy=peer setAt=t+0s in=channel:#iirc :newer",
          "<< :op!u@h KICK #iirc peer :out",
          '?? activity Kicked #iirc peer by=op ignored="op!*@*" in=channel:#iirc :out'
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is stamped for an invitation", () => {
    const base = ignoring("spam!*@*");

    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "<< :spam!u@h INVITE iirc #elsewhere",
          '?? activity Invited #elsewhere by=spam ignored="spam!*@*" in=network'
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is stamped for a CTCP request", () => {
    const base = configured({ answerCtcp: false, ignores: masks("spam!*@*") });

    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "<<\\ :spam!u@h PRIVMSG iirc :\\x01VERSION\\x01",
          '?? activity CtcpRequest spam iirc VERSION unanswered=Off ignored="spam!*@*" in=existing-direct:spam in=network'
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("Self", () => {
  const base = ignoring("*!*@*");

  it("is never ignored, in what it says or does", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc", ["peer"]),
        lines(
          "!! say #iirc :hello",
          ">> PRIVMSG #iirc hello",
          "?? message Privmsg iirc #iirc at=ours:t+0s in=channel:#iirc ours=i1 :hello",
          // Said elsewhere, as from another IRC client.
          "<< :iirc!~iirc@iirc.test PRIVMSG #iirc :from my phone",
          "?? message Privmsg iirc #iirc self in=channel:#iirc :from my phone",
          "<< :iirc!~iirc@iirc.test NICK eggs",
          "?? activity NickChanged iirc eggs in=network in=channel:#iirc",
          "<< :eggs!~iirc@iirc.test MODE #iirc +o eggs",
          "?? activity ModeChanged #iirc by=eggs +o=eggs in=channel:#iirc",
          "<< :eggs!~iirc@iirc.test PART #iirc",
          "?? activity Parted #iirc eggs in=channel:#iirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is never ignored in the echo of its own Message", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["batch", "echo-message", "labeled-response"] }),
        joined(base, "#iirc"),
        lines(
          "!! say #iirc :hello",
          ">> @label=l1 PRIVMSG #iirc hello",
          "?? message Privmsg iirc #iirc at=ours:t+0s in=channel:#iirc ours=i1 echo :hello",
          "<< @label=l1 :iirc!u@h PRIVMSG #iirc :hello",
          "?? confirmed i1 :hello"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("a mask under the casemapping", () => {
  it("matches [Foo] with {foo} under rfc1459, and is reported folded", () => {
    const base = ignoring("{FOO}!*@*");

    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc"),
        lines(
          "<< :[Foo]!u@h PRIVMSG #iirc :hi",
          '?? message Privmsg [Foo] #iirc ignored="{foo}!*@*" in=channel:#iirc :hi'
        ),
      ],
    });

    expect.assertions(0);
  });

  it("does not under ascii, which keeps [ and { apart", () => {
    const base = ignoring("{foo}!*@*");

    const isupport = floorIsupport.map((token) =>
      token.startsWith("CASEMAPPING=") ? "CASEMAPPING=ascii" : token
    );

    play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport }),
        joined(base, "#iirc"),
        lines(
          "<< :[Foo]!u@h PRIVMSG #iirc :hi",
          "?? message Privmsg [Foo] #iirc in=channel:#iirc :hi",
          "<< :{FOO}!u@h PRIVMSG #iirc :hi",
          '?? message Privmsg {FOO} #iirc ignored="{foo}!*@*" in=channel:#iirc :hi'
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("a source with no user or host", () => {
  it("is matched with them empty", () => {
    const base = ignoring("peer!*@*", "other!?*@*", "bare!*@?*");

    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc"),
        lines(
          "<< :peer PRIVMSG #iirc :hi",
          '?? message Privmsg peer #iirc ignored="peer!*@*" in=channel:#iirc :hi',
          "<< :other PRIVMSG #iirc :hi",
          "?? message Privmsg other #iirc in=channel:#iirc :hi",
          "<< :bare@host PRIVMSG #iirc :hi",
          '?? message Privmsg bare #iirc ignored="bare!*@?*" in=channel:#iirc :hi',
          "<< :bare@ PRIVMSG #iirc :hi",
          "?? message Privmsg bare #iirc in=channel:#iirc :hi"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("taking a mask out of the Configuration", () => {
  it("reports it, folded, and the Messages already stamped stay as they were", () => {
    const base = ignoring("Spam!*@*", "{Foo}!*@*");

    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc"),
        lines(
          "<< :spam!u@h PRIVMSG #iirc :hi",
          '?? message Privmsg spam #iirc ignored="spam!*@*" in=channel:#iirc :hi',
          "!! configure ignores={Foo}!*@*",
          '?? unignored "spam!*@*"',
          "<< :spam!u@h PRIVMSG #iirc :again",
          "?? message Privmsg spam #iirc in=channel:#iirc :again",
          "!! configure ignores=",
          '?? unignored "{foo}!*@*"'
        ),
      ],
    });

    expect(unignored(played)).toHaveLength(2);
  });

  it("reports nothing for a mask respelt in another case, or for a new one", () => {
    const base = ignoring("spam!*@*");

    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "!! configure ignores=SPAM!*@*",
          "!! configure ignores=SPAM!*@*,[x]!*@*",
          "!! configure ignores={X}!*@*,spam!*@*"
        ),
      ],
    });

    expect(unignored(played)).toStrictEqual([]);
  });

  it("reports every mask a Configuration drops at once, in the old order", () => {
    const base = ignoring("b!*@*", "a!*@*", "B!*@*", "c!*@*");

    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("!! configure ignores=c!*@*", '?? unignored "b!*@*" "a!*@*"'),
      ],
    });

    expect.assertions(0);
  });

  it("restores what a mask stamped on an ascii Network, though it is dropped while redialling", () => {
    const base = ignoring("[Bot]!*@*");

    const isupport = floorIsupport.map((token) =>
      token.startsWith("CASEMAPPING=") ? "CASEMAPPING=ascii" : token
    );

    play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport }),
        joined(base, "#iirc"),
        lines(
          "<< :[bot]!u@h PRIVMSG #iirc :hi",
          '?? message Privmsg [bot] #iirc ignored="[bot]!*@*" in=channel:#iirc :hi',
          "# The next Connection folds by rfc1459 until its own ISUPPORT says otherwise.",
          "== closed Reset",
          "+2s",
          "-> dial irc.test:6697 tls",
          "!! configure ignores=",
          '?? unignored "[bot]!*@*" "{bot}!*@*"'
        ),
      ],
    });

    expect.assertions(0);
  });
});
