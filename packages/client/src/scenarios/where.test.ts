/**
 * Where News belongs: each Message and Activity names the Timelines it touches, worked
 * out from what the Client knows as the step begins, by the protocol's structure.
 */
import { describe, expect, it } from "vitest";

import type { Step } from "../client.ts";
import { client } from "../core.ts";
import { configured, floorIsupport, joined, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const inChannel = [registered(base), joined(base, "#iirc", ["peer"])];

describe("a Message to a Channel", () => {
  it("belongs to the Channel, whoever said it", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "<< :peer!u@h PRIVMSG #iirc :hello all",
          "?? message Privmsg peer #iirc in=channel:#iirc :hello all",
          "<< :irc.test NOTICE #iirc :server notice",
          "?? message Notice irc.test #iirc in=channel:#iirc :server notice",
          "!! say #iirc :hi",
          ">> PRIVMSG #iirc hi",
          "?? message Privmsg iirc #iirc at=ours:t+0s in=channel:#iirc ours=i1 :hi"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("belongs to the Channel after its STATUSMSG prefixes", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: [...floorIsupport, "STATUSMSG=@+"] }),
        joined(base, "#iirc", ["@peer"]),
        lines(
          "<< :peer!u@h PRIVMSG @#iirc :ops only",
          '?? message Privmsg peer "@#iirc" in=channel:#iirc :ops only',
          "<< :peer!u@h NOTICE @+#iirc :voices and up",
          '?? message Notice peer "@+#iirc" in=channel:#iirc :voices and up',
          "!! say +#iirc :to voices",
          ">> PRIVMSG +#iirc :to voices",
          "?? message Privmsg iirc +#iirc at=ours:t+0s in=channel:#iirc ours=i1 :to voices",
          // A prefix that is not in STATUSMSG names no Channel.
          "<< :peer!u@h PRIVMSG %#iirc :halfops",
          "?? message Privmsg peer %#iirc in=network :halfops"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is the whole name when that is a Channel's, before any STATUSMSG prefix is stripped", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: [...floorIsupport, "CHANTYPES=#&", "STATUSMSG=~&@%+"] }),
        lines(
          "<< :peer!u@h PRIVMSG &local :local",
          "?? message Privmsg peer &local in=channel:&local :local",
          // `&` is a prefix and a Channel type, so `&#other` is a Channel of its own.
          "<< :peer!u@h PRIVMSG &#other :nested",
          "?? message Privmsg peer &#other in=channel:&#other :nested",
          // A prefix stops being stripped as soon as what is left is a Channel's.
          "<< :peer!u@h PRIVMSG @&local :ops",
          '?? message Privmsg peer "@&local" in=channel:&local :ops',
          "<< :peer!u@h PRIVMSG @#chan :ops",
          '?? message Privmsg peer "@#chan" in=channel:#chan :ops',
          "<< :peer!u@h PRIVMSG &@#chan :both",
          '?? message Privmsg peer "&@#chan" in=channel:"&@#chan" :both'
        ),
      ],
    });

    expect.assertions(0);
  });

  it("keys the Channel by the casemapping in force: rfc1459 folds #Foo[ and #foo{ together", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#Foo["),
        lines(
          "<< :peer!u@h PRIVMSG #Foo[ :one",
          "?? message Privmsg peer #Foo[ in=channel:#foo{:#Foo[ :one",
          "<< :peer!u@h PRIVMSG #foo{ :two",
          "?? message Privmsg peer #foo{ in=channel:#foo{ :two"
        ),
      ],
    });

    expect([...client.known(played.state).channels.keys()]).toStrictEqual(["#foo{"]);
  });

  it("keys the Channel by the casemapping in force: ascii tells #Foo[ from #foo{", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: ["CASEMAPPING=ascii", "CHANTYPES=#", "PREFIX=(ov)@+"] }),
        joined(base, "#Foo["),
        lines(
          "<< :peer!u@h PRIVMSG #Foo[ :one",
          "?? message Privmsg peer #Foo[ in=channel:#foo[:#Foo[ :one",
          "<< :peer!u@h PRIVMSG #foo{ :two",
          "?? message Privmsg peer #foo{ in=channel:#foo{ :two"
        ),
      ],
    });

    expect([...client.known(played.state).channels.keys()]).toStrictEqual(["#foo["]);
  });
});

describe("a Direct Message", () => {
  it("belongs to the other participant, in either direction", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "<< :Peer!u@h PRIVMSG iirc :psst",
          "?? message Privmsg Peer iirc in=direct:peer:Peer :psst",
          "<< :peer!u@h NOTICE IIRC :to Self, in another case",
          "?? message Notice peer IIRC in=direct:peer :to Self, in another case",
          "!! say Peer :psst back",
          ">> PRIVMSG Peer :psst back",
          "?? message Privmsg iirc Peer at=ours:t+0s in=direct:peer:Peer ours=i1 :psst back",
          // Self, said from another IRC client of the same account.
          "<< :iirc!u@h PRIVMSG stranger :from my phone",
          "?? message Privmsg iirc stranger self in=direct:stranger :from my phone",
          // A User with no mask in the source is still a User.
          "<< :NickServ NOTICE iirc :identify",
          "?? message Notice NickServ iirc in=direct:nickserv:NickServ :identify"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("to Self, from Self, is Self's own", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "!! say iirc :note to self",
          ">> PRIVMSG iirc :note to self",
          "?? message Privmsg iirc iirc at=ours:t+0s in=direct:iirc ours=i1 :note to self",
          "<< :iirc!u@h PRIVMSG iirc :note to self",
          "?? message Privmsg iirc iirc self in=direct:iirc :note to self"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is placed when said, and its echo only confirms it", () => {
    const echo = configured();

    play(client, {
      configuration: echo,
      transcript: [
        registered(echo, { offered: ["batch", "echo-message", "labeled-response"] }),
        lines(
          "!! say peer :psst",
          ">> @label=l1 PRIVMSG peer psst",
          "?? message Privmsg iirc peer at=ours:t+0s in=direct:peer ours=i1 echo :psst",
          "<< @label=l1 :iirc!u@h PRIVMSG peer :psst",
          "?? confirmed i1 :psst"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("a Message for the Network", () => {
  it("comes from the Ircd, or is to a mask or to no one Self can name", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "<< :irc.test NOTICE iirc :from the Ircd",
          "?? message Notice irc.test iirc in=network :from the Ircd",
          "<< NOTICE iirc :with no source",
          "?? message Notice irc.test iirc in=network :with no source",
          "<< :hub.irc.test NOTICE iirc :from another server",
          "?? message Notice hub.irc.test iirc in=network :from another server",
          "<< :op!u@h NOTICE $*.test :maintenance",
          "?? message Notice op $*.test in=network :maintenance",
          "<< :peer!u@h PRIVMSG other :not to Self",
          "?? message Privmsg peer other in=network :not to Self"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("knows the Ircd by its name even when the name has no dot", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base, { server: "localhost" }),
        lines("<< :localhost NOTICE iirc :hi", "?? message Notice localhost iirc in=network :hi"),
        lines(
          "<< :LOCALHOST NOTICE iirc :maintenance",
          "?? message Notice LOCALHOST iirc in=network :maintenance"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("Activity", () => {
  it("in a Channel belongs to the Channel, and a user mode to the Network", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "<< :other!u@h JOIN #iirc",
          "?? activity Joined #iirc other in=channel:#iirc",
          "<< :op!u@h MODE #iirc +v other",
          "?? activity ModeChanged #iirc by=op +v=other in=channel:#iirc",
          "<< :op!u@h TOPIC #IIRC :new",
          "?? activity TopicChanged #IIRC by=op setBy=op setAt=t+0s in=channel:#iirc:#IIRC :new",
          "<< :op!u@h KICK #iirc other :out",
          "?? activity Kicked #iirc other by=op in=channel:#iirc :out",
          "<< :peer!u@h PART #iirc",
          "?? activity Parted #iirc peer in=channel:#iirc",
          "<< :iirc MODE iirc :+i",
          "?? activity ModeChanged iirc by=iirc +i in=network"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("of a Quit belongs to exactly the Channels the User shared with Self, and their Direct Messages", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#a", ["peer"]),
        joined(base, "#b", ["other"]),
        joined(base, "#c", ["@peer", "other"]),
        lines(
          "<< :peer!u@h QUIT :bye",
          "?? activity Quit peer in=channel:#a in=channel:#c in=existing-direct:peer :bye",
          // Now gone from every Channel, a second Quit touches only their Direct Messages.
          "<< :peer!u@h QUIT :again",
          "?? activity Quit peer in=existing-direct:peer :again",
          "<< :other!u@h QUIT",
          "?? activity Quit other in=channel:#b in=channel:#c in=existing-direct:other"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("of another User's nick change moves their Direct Messages to the new nick", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "<< :peer!u@h PRIVMSG iirc :psst",
          "?? message Privmsg peer iirc in=direct:peer :psst",
          "<< :peer!u@h NICK pal",
          "?? activity NickChanged peer pal in=channel:#iirc in=renamed:peer>pal",
          "<< :pal!u@h PRIVMSG iirc :still me",
          "?? message Privmsg pal iirc in=direct:pal :still me",
          "<< :pal!u@h NICK Pal",
          "?? activity NickChanged pal Pal in=channel:#iirc in=renamed:pal>pal:Pal",
          // One who shares no Channel can still be followed, if Self can see it.
          "<< :stranger!u@h NICK wanderer",
          "?? activity NickChanged stranger wanderer in=renamed:stranger>wanderer"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("of Self's nick change belongs to the Network and every Channel Self is in", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#a", ["peer"]),
        joined(base, "#b"),
        lines(
          "<< :iirc!u@h NICK Renamed",
          "?? activity NickChanged iirc Renamed in=network in=channel:#a in=channel:#b",
          // The step that changed it has passed, so Self is now `Renamed`.
          "<< :peer!u@h PRIVMSG renamed :hi",
          "?? message Privmsg peer renamed in=direct:peer :hi"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("of away status belongs to another User's Direct Messages, and Self's to the Network", () => {
    const away = configured();

    play(client, {
      configuration: away,
      transcript: [
        registered(away, { offered: ["away-notify"] }),
        joined(away, "#iirc", ["peer"]),
        lines(
          "<< :peer!u@h AWAY :lunch",
          "?? activity AwayChanged peer in=existing-direct:peer :lunch",
          "<< :iirc!u@h AWAY :brb",
          "?? activity AwayChanged iirc in=network :brb"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("a Target list", () => {
  it("places each Target by itself, each Timeline once, and never the list as one", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#a", ["peer"]),
        joined(base, "#b"),
        lines(
          "<< :peer!u@h PRIVMSG #a,#b :hello",
          "?? message Privmsg peer #a,#b in=channel:#a in=channel:#b :hello",
          "<< :peer!u@h NOTICE #a,#A,,iirc,$*.test,IIRC :many",
          "?? message Notice peer #a,#A,,iirc,$*.test,IIRC in=channel:#a in=direct:peer in=network :many",
          "<< :peer!u@h PRIVMSG , :nobody",
          "?? message Privmsg peer , in=network :nobody",
          // The Owner names one Target: no Line is built to a list.
          "!! say #a,#b :both",
          "?? refused i1 Unsendable"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("a nick", () => {
  it("is read by position, the same whichever way a Direct Message goes", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          // `$` and `#` are only forbidden first.
          "!! say a$b :hi",
          ">> PRIVMSG a$b hi",
          "?? message Privmsg iirc a$b at=ours:t+0s in=direct:a$b ours=i1 :hi",
          "<< :a$b!u@h PRIVMSG iirc :hi back",
          "?? message Privmsg a$b iirc in=direct:a$b :hi back",
          "!! say a#b :hi",
          ">> PRIVMSG a#b hi",
          "?? message Privmsg iirc a#b at=ours:t+0s in=direct:a#b ours=i2 :hi",
          "<< :a#b!u@h PRIVMSG iirc :hi back",
          "?? message Privmsg a#b iirc in=direct:a#b :hi back"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("may hold a dot, which a source with a user or host shows is a User", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "<< :first.last!u@h PRIVMSG iirc :hello",
          "?? message Privmsg first.last iirc in=direct:first.last :hello",
          "!! say first.last :hi",
          ">> PRIVMSG first.last hi",
          "?? message Privmsg iirc first.last at=ours:t+0s in=direct:first.last ours=i1 :hi",
          // With no user or host, a name with a dot is a server's.
          "<< :first.last NOTICE iirc :from a server",
          "?? message Notice first.last iirc in=network :from a server"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("with a dot is followed when it changes, as any other", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "<< :first.last!u@h PRIVMSG iirc :psst",
          "?? message Privmsg first.last iirc in=direct:first.last :psst",
          "<< :first.last!u@h NICK pal",
          "?? activity NickChanged first.last pal in=renamed:first.last>pal",
          "<< :pal!u@h NICK second.name",
          "?? activity NickChanged pal second.name in=renamed:pal>second.name"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("never starts with a membership prefix, either way", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "!! say +peer :hi",
          ">> PRIVMSG +peer hi",
          "?? message Privmsg iirc +peer at=ours:t+0s in=network ours=i1 :hi",
          "<< :+peer!u@h PRIVMSG iirc :hi back",
          "?? message Privmsg +peer iirc in=network :hi back",
          "<< :+peer!u@h AWAY :gone",
          "?? activity AwayChanged +peer in=network :gone",
          "<< :peer!u@h NICK +pal",
          "?? activity NickChanged peer +pal in=channel:#iirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("follows the Network's PREFIX", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: ["CASEMAPPING=rfc1459", "CHANTYPES=#", "PREFIX=(qo)~@"] }),
        lines(
          "!! say +peer :hi",
          ">> PRIVMSG +peer hi",
          "?? message Privmsg iirc +peer at=ours:t+0s in=direct:+peer ours=i1 :hi",
          "!! say ~peer :hi",
          ">> PRIVMSG ~peer hi",
          "?? message Privmsg iirc ~peer at=ours:t+0s in=network ours=i2 :hi"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("a Channel parameter", () => {
  it("that is not a Channel's name is Malformed, and nothing is placed", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "<< :peer!u@h TOPIC iirc :x",
          "?? ignored Malformed TOPIC",
          "<< :peer!u@h JOIN iirc",
          "?? ignored Malformed JOIN",
          "<< :peer!u@h JOIN #iirc,iirc",
          "?? ignored Malformed JOIN",
          "<< :peer!u@h PART &iirc",
          "?? ignored Malformed PART",
          "<< :op!u@h KICK iirc peer",
          "?? ignored Malformed KICK",
          "<< :op!u@h KICK #iirc,#b peer",
          "?? ignored Malformed KICK"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("of a JOIN to several Channels is read per Channel", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#a"),
        joined(base, "#b"),
        lines(
          "<< :peer!u@h JOIN #a,#b",
          "?? activity Joined #a peer in=channel:#a",
          "?? activity Joined #b peer in=channel:#b",
          "<< :peer!u@h PART #a,#b :bye",
          "?? activity Parted #a peer in=channel:#a :bye",
          "?? activity Parted #b peer in=channel:#b :bye"
        ),
      ],
    });

    expect.assertions(0);
  });
});

// Each casemapping a `Refolded` reported, in order.
const refolds = (played: { readonly steps: readonly Step<unknown>[] }): readonly string[] =>
  played.steps.flatMap((step) =>
    step.news.flatMap((news) => (news._tag === "Refolded" ? [news.casemapping] : []))
  );

describe("the Network's casemapping", () => {
  const asciiIsupport = ["CASEMAPPING=ascii", "CHANTYPES=#", "PREFIX=(ov)@+"];

  it("keys Timelines until an Ircd declares another, which is reported once", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#Foo[", ["Peer["]),
        lines(
          "<< :Peer[!u@h PRIVMSG iirc :psst",
          "?? message Privmsg Peer[ iirc in=direct:peer{:Peer[ :psst",
          "<< :Peer[!u@h PRIVMSG #Foo[ :hi",
          "?? message Privmsg Peer[ #Foo[ in=channel:#foo{:#Foo[ :hi",
          "<< :irc.test 005 iirc CASEMAPPING=ascii :are supported by this server",
          "?? refolded ascii",
          "<< :Peer[!u@h PRIVMSG iirc :again",
          "?? message Privmsg Peer[ iirc in=direct:peer[:Peer[ :again",
          "<< :Peer[!u@h PRIVMSG #Foo[ :again",
          "?? message Privmsg Peer[ #Foo[ in=channel:#foo[:#Foo[ :again",
          "<< :Peer[!u@h NICK Pal",
          "?? activity NickChanged Peer[ Pal in=channel:#foo[:#Foo[ in=renamed:peer[:Peer[>pal:Pal",
          // Said again, or with another token, it is no change.
          "<< :irc.test 005 iirc CASEMAPPING=ascii NETWORK=iirc-test :are supported by this server",
          "<< :irc.test 005 iirc NICKLEN=30 :are supported by this server"
        ),
      ],
    });

    expect(refolds(played)).toStrictEqual(["ascii"]);
  });

  it("outlives a Connection, before and after the next Ircd declares it again", () => {
    const again = registered(base, { isupport: asciiIsupport }).replace(
      /^!! configure\n-> dial[^\n]*\n/u,
      ""
    );

    const welcome = again.indexOf("005 ");
    const cut = again.lastIndexOf("\n", welcome) + 1;

    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: asciiIsupport }),
        lines(
          "<< :Peer[!u@h PRIVMSG iirc :psst",
          "?? message Privmsg Peer[ iirc in=direct:peer[:Peer[ :psst",
          "== closed Reset",
          "+2s",
          "-> dial irc.test:6697 tls"
        ),
        again.slice(0, cut),
        // The new Connection folds by rfc1459 until its Ircd says, but Timelines do not.
        lines(
          "<< :Peer[!u@h PRIVMSG iirc :between",
          "?? message Privmsg Peer[ iirc in=direct:peer[:Peer[ :between"
        ),
        again.slice(cut),
        lines(
          "<< :Peer[!u@h PRIVMSG iirc :after",
          "?? message Privmsg Peer[ iirc in=direct:peer[:Peer[ :after"
        ),
      ],
    });

    expect(refolds(played)).toStrictEqual(["ascii"]);
  });

  it("reports a mapping the Client does not know as ascii, which it folds by", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "<< :irc.test 005 iirc CASEMAPPING=unheard-of :are supported by this server",
          "?? refolded ascii",
          "<< :Peer[!u@h PRIVMSG iirc :psst",
          "?? message Privmsg Peer[ iirc in=direct:peer[:Peer[ :psst",
          "<< :irc.test 005 iirc CASEMAPPING=ascii :are supported by this server",
          "<< :irc.test 005 iirc -CASEMAPPING :are supported by this server",
          "?? refolded rfc1459"
        ),
      ],
    });

    expect(refolds(played)).toStrictEqual(["ascii", "rfc1459"]);
  });
});
