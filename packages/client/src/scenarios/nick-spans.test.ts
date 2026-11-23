/**
 * A Message's text names a User who counts as a whole word: its spans are fixed when it is
 * said, as offsets into the text with its formatting stripped. Who counts is a Channel's
 * members, or Self and the partner of a Direct Message.
 */
import { describe, expect, it } from "vitest";

import { client, makeClient } from "../core.ts";
import type { Feature } from "../feature.ts";
import { FeatureName } from "../ids.ts";
import { register, registry } from "../registry.ts";
import { configured, joined, play, registered, replay } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const inChannel = (names: readonly string[]) => [registered(base), joined(base, "#iirc", names)];

const run = (transcript: readonly string[]) => {
  play(client, { configuration: base, transcript });
};

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

describe("the spans of a Message that name a Channel's members", () => {
  it("are found at the start, after a word, and inside punctuation, and not inside a longer word", () => {
    run([
      ...inChannel(["bob", "al"]),
      lines(
        "<< :peer!u@h PRIVMSG #iirc :bob: hi",
        "?? message Privmsg peer #iirc nicks=0-3 in=channel:#iirc :bob: hi",
        "<< :peer!u@h PRIVMSG #iirc :hi bob",
        "?? message Privmsg peer #iirc nicks=3-6 in=channel:#iirc :hi bob",
        "<< :peer!u@h PRIVMSG #iirc :(bob) and al.",
        "?? message Privmsg peer #iirc nicks=1-4,10-12 in=channel:#iirc :(bob) and al.",
        "<< :peer!u@h PRIVMSG #iirc :bobby and bob_ and abob",
        "?? message Privmsg peer #iirc in=channel:#iirc :bobby and bob_ and abob"
      ),
    ]);

    expect.assertions(0);
  });

  it("count Self, as a nick in a Message from anyone", () => {
    run([
      ...inChannel(["bob"]),
      lines(
        "<< :peer!u@h PRIVMSG #iirc :iirc and bob",
        "?? message Privmsg peer #iirc highlight nicks=0-4,9-12 in=channel:#iirc :iirc and bob"
      ),
    ]);

    expect.assertions(0);
  });

  it("are offsets into the text with its formatting stripped", () => {
    run([
      ...inChannel(["bob", "al"]),
      lines(
        "<<\\ :peer!u@h PRIVMSG #iirc :\\x02hi\\x02 \\x0304,01al\\x03 and \\x1dbob",
        "?? message Privmsg peer #iirc nicks=3-5,10-13 in=channel:#iirc :\u0002hi\u0002 \u000304,01al\u0003 and \u001Dbob"
      ),
    ]);

    expect.assertions(0);
  });

  it("count in UTF-16 units, as the text is, past characters outside the plane", () => {
    run([
      ...inChannel(["bob"]),
      lines(
        "<< :peer!u@h PRIVMSG #iirc :\u{1F600} bob",
        "?? message Privmsg peer #iirc nicks=3-6 in=channel:#iirc :\u{1F600} bob"
      ),
    ]);

    expect.assertions(0);
  });

  it("are found by the Network's casemapping", () => {
    run([
      registered(base, {
        isupport: ["CASEMAPPING=rfc1459", "CHANTYPES=#", "PREFIX=(ov)@+"],
      }),
      joined(base, "#iirc", ["{a"]),
      lines(
        "<< :peer!u@h PRIVMSG #iirc :hi [a and [A",
        "?? message Privmsg peer #iirc nicks=3-5,10-12 in=channel:#iirc :hi [a and [A"
      ),
    ]);

    expect.assertions(0);
  });

  it("are those of every Channel in a list of Targets", () => {
    run([
      registered(base),
      joined(base, "#a", ["bob"]),
      joined(base, "#b", ["al"]),
      lines(
        "<< :peer!u@h PRIVMSG #a,#b :bob and al and cy",
        "?? message Privmsg peer #a,#b nicks=0-3,8-10 in=channel:#a in=channel:#b :bob and al and cy"
      ),
    ]);

    expect.assertions(0);
  });

  it("leave out a User who left before it was said", () => {
    run([
      ...inChannel(["bob", "al", "cy"]),
      lines(
        "<< :bob!u@h PART #iirc",
        "<< :al!u@h QUIT :gone",
        "<< :peer!u@h PRIVMSG #iirc :bob al cy",
        "?? message Privmsg peer #iirc nicks=7-9 in=channel:#iirc :bob al cy"
      ),
    ]);

    expect.assertions(0);
  });

  it("leave out a User in a Channel Self is not in", () => {
    run([
      ...inChannel(["bob"]),
      lines(
        "<< :peer!u@h PRIVMSG #elsewhere :hi bob",
        "?? message Privmsg peer #elsewhere in=channel:#elsewhere :hi bob"
      ),
    ]);

    expect.assertions(0);
  });

  it("are worked out for a Message Self says", () => {
    run([
      ...inChannel(["bob"]),
      lines(
        "!! say #iirc :hi bob",
        "?? message Privmsg iirc #iirc at=ours:t+0s nicks=3-6 in=channel:#iirc ours=i1 :hi bob",
        ">> PRIVMSG #iirc :hi bob"
      ),
    ]);

    expect.assertions(0);
  });

  it("are worked out for a Message from history, by who is a member now", () => {
    play(withHistory, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["batch"] }),
        joined(base, "#iirc", ["bob"]),
        lines(
          "<< :irc.test BATCH +h chathistory #iirc",
          "<< @batch=h :peer!u@h PRIVMSG #iirc :bob, earlier",
          "?? message Privmsg peer #iirc history nicks=0-3 in=channel:#iirc :bob, earlier",
          "<< :irc.test BATCH -h"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("count a member a NAMES listing still arriving has shown", () => {
    run([
      registered(base),
      lines(
        "!! configure +#iirc",
        ">> JOIN #iirc",
        "<< :iirc!~iirc@iirc.test JOIN #iirc",
        ">> MODE #iirc",
        "<< :irc.test 353 iirc = #iirc :iirc bob",
        "<< :peer!u@h PRIVMSG #iirc :hi bob",
        "?? message Privmsg peer #iirc nicks=3-6 in=channel:#iirc :hi bob",
        "<< :irc.test 366 iirc #iirc :End of /NAMES list."
      ),
    ]);

    expect.assertions(0);
  });
});

describe("the spans of a Direct Message", () => {
  it("name only the partner and Self, not another who shares a Channel", () => {
    run([
      ...inChannel(["peer", "third"]),
      lines(
        "<< :peer!u@h PRIVMSG iirc :third and peer and iirc",
        "?? message Privmsg peer iirc highlight nicks=10-14,19-23 in=direct:peer :third and peer and iirc"
      ),
    ]);

    expect.assertions(0);
  });

  it("name the partner and Self in a Message Self says", () => {
    run([
      ...inChannel(["peer", "third"]),
      lines(
        "!! say peer :third and peer and iirc",
        "?? message Privmsg iirc peer at=ours:t+0s nicks=10-14,19-23 in=direct:peer ours=i1 :third and peer and iirc",
        ">> PRIVMSG peer :third and peer and iirc"
      ),
    ]);

    expect.assertions(0);
  });
});

describe("the spans of a Message that belongs to the Network's own Timeline", () => {
  it("are none, whoever it names", () => {
    run([
      ...inChannel(["peer", "bob"]),
      lines(
        "<< :irc.test NOTICE iirc :peer and iirc and bob",
        "?? message Notice irc.test iirc in=network :peer and iirc and bob",
        "<< :peer!u@h NOTICE $*.test :peer and iirc and bob",
        "?? message Notice peer $*.test highlight in=network :peer and iirc and bob",
        "<< :irc.test NOTICE #iirc :peer and iirc and bob",
        "?? message Notice irc.test #iirc in=channel:#iirc :peer and iirc and bob"
      ),
    ]);

    expect.assertions(0);
  });
});

describe("the spans of our Message's echo", () => {
  it("are those of the Ircd's own text", () => {
    run([
      registered(base, { offered: ["batch", "echo-message", "labeled-response"] }),
      joined(base, "#iirc", ["bob", "al"]),
      lines(
        "!! say #iirc :hello bob",
        ">> @label=l1 PRIVMSG #iirc :hello bob",
        "?? message Privmsg iirc #iirc at=ours:t+0s nicks=6-9 in=channel:#iirc ours=i1 echo :hello bob",
        "<< @label=l1 :iirc!u@h PRIVMSG #iirc :hello bob and al",
        "?? confirmed i1 nicks=6-9,14-16 :hello bob and al"
      ),
    ]);

    expect.assertions(0);
  });
});

describe("a replay of the Journal", () => {
  it("gives the same spans", () => {
    const { transcript } = replay(client, {
      configuration: base,
      transcript: [
        ...inChannel(["bob"]),
        lines("<< :peer!u@h PRIVMSG #iirc :hi bob", "<< :peer!u@h PRIVMSG iirc :psst iirc"),
      ],
    });

    expect(transcript).toContain("nicks=3-6");
    expect(transcript).toContain("nicks=5-9");
  });
});
