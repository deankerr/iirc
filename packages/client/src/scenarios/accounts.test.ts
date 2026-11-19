/**
 * `account-tag`, `account-notify`, and `extended-join`: the Client knows another User's
 * account, and from a join their realname, without asking. Logged out is known, and is
 * not the same as not known. Without the caps, nothing changes, and a `WHOIS` is what
 * says.
 */
import { describe, expect, it } from "vitest";

import { client, makeClient } from "../core.ts";
import type { Feature } from "../feature.ts";
import { FeatureName } from "../ids.ts";
import { register, registry } from "../registry.ts";
import { configured, joined, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const accounts = ["account-tag", "account-notify", "extended-join"];

const bob = { _tag: "Known", from: "ircd", value: "bob" };
const loggedOut = { _tag: "Known", from: "ircd", value: null };
const unknown = { _tag: "Unknown" };

const inChannels = (offered: readonly string[] = accounts) => [
  registered(base, { offered: [...offered] }),
  joined(base, "#iirc", ["peer", "other"]),
  joined(base, "#two", ["peer"]),
];

const userOf = (transcript: readonly string[], nick: string, custom = client) => {
  const { state } = play(custom, { configuration: base, transcript });

  return client.known(state).users.get(nick);
};

const selfOf = (transcript: readonly string[]) =>
  client.known(play(client, { configuration: base, transcript }).state).self;

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

const tagged = (...rows: readonly string[]) => [...inChannels(), lines(...rows)];

const notified = (...rows: readonly string[]) => [...inChannels(), lines(...rows)];

const joinedBy = (...rows: readonly string[]) => [...inChannels(), lines(...rows)];

const without = (...rows: readonly string[]) => [
  registered(base),
  joined(base, "#iirc", ["peer"]),
  lines(...rows),
];

const whois = (offered: readonly string[], ...replies: readonly string[]) => [
  registered(base, { offered: [...offered] }),
  joined(base, "#iirc", ["peer"]),
  lines(
    "!! whois peer",
    ">> WHOIS peer",
    ...replies.map((reply) => `<< :irc.test ${reply}`),
    "<< :irc.test 318 iirc peer :End"
  ),
];

describe("account-tag", () => {
  it("sets a sender's account from a Message's tag", () => {
    expect(
      userOf(tagged("<< @account=bob :peer!u@h PRIVMSG #iirc :hi"), "peer")?.account
    ).toMatchObject(bob);
  });

  it("takes a Message with no tag from a User as logged out, which is known", () => {
    const account = userOf(tagged("<< :peer!u@h PRIVMSG #iirc :hi"), "peer")?.account;

    expect(account).toMatchObject(loggedOut);
  });

  it("sets a User's account from a Direct Message, and a NOTICE", () => {
    expect(
      userOf(
        tagged("<< @account=bob :peer!u@h PRIVMSG iirc :psst", "<< :other!u@h NOTICE #iirc :hey"),
        "peer"
      )?.account
    ).toMatchObject(bob);
    expect(
      userOf(tagged("<< @account=bob :peer!u@h NOTICE #iirc :hey"), "peer")?.account
    ).toMatchObject(bob);
  });

  it("sets an account from an Activity's tag", () => {
    expect(
      userOf(tagged("<< @account=bob :peer!u@h MODE #iirc +m"), "peer")?.account
    ).toMatchObject(bob);
    expect(userOf(tagged("<< :peer!u@h TOPIC #iirc :new"), "peer")?.account).toMatchObject(
      loggedOut
    );
  });

  it("names a User who changed nick by the nick they changed to", () => {
    const transcript = tagged("<< @account=bob :peer!u@h NICK pal");

    expect(userOf(transcript, "pal")?.account).toMatchObject(bob);
    expect(userOf(transcript, "peer")).toBeUndefined();
  });

  it("follows a login and a logout in the next Message", () => {
    expect(
      userOf(
        tagged(
          "<< @account=bob :peer!u@h PRIVMSG #iirc :hi",
          "<< :peer!u@h PRIVMSG #iirc :still here"
        ),
        "peer"
      )?.account
    ).toMatchObject(loggedOut);
  });

  it("changes nothing from history", () => {
    const transcript = [
      ...inChannels(["batch", ...accounts]),
      lines(
        "<< :irc.test BATCH +h chathistory #iirc",
        "<< @batch=h;account=bob :peer!u@h PRIVMSG #iirc :old",
        "<< @batch=h :other!u@h PRIVMSG #iirc :older",
        "<< :irc.test BATCH -h"
      ),
    ];

    expect(userOf(transcript, "peer", withHistory)?.account).toStrictEqual(unknown);
    expect(userOf(transcript, "other", withHistory)?.account).toStrictEqual(unknown);
  });

  it("does not change Self's own account from Self's Line", () => {
    expect(
      selfOf(tagged("<< @account=bob :iirc!u@h PRIVMSG #iirc :said elsewhere"))?.account
    ).toStrictEqual(unknown);
    expect(selfOf(tagged("<< :iirc!u@h PRIVMSG #iirc :said elsewhere"))?.account).toStrictEqual(
      unknown
    );
  });

  it("describes no one a server said", () => {
    const transcript = tagged(
      "<< @account=bob :irc.test NOTICE #iirc :hi",
      "<< @account=bob :irc.test PRIVMSG iirc :hi"
    );

    expect(userOf(transcript, "irc.test")).toBeUndefined();
  });

  it("describes no one who shares no Channel with Self", () => {
    expect(
      userOf(tagged("<< @account=bob :stranger!u@h PRIVMSG iirc :hi"), "stranger")
    ).toBeUndefined();
  });

  it("reads a tag with no value as saying nothing", () => {
    expect(
      userOf(tagged("<< @account :peer!u@h PRIVMSG #iirc :hi"), "peer")?.account
    ).toStrictEqual(unknown);
    expect(
      userOf(tagged("<< @account= :peer!u@h PRIVMSG #iirc :hi"), "peer")?.account
    ).toStrictEqual(unknown);
  });

  it("still reports a tagged Message as a Message", () => {
    play(client, {
      configuration: base,
      transcript: tagged(
        "<< @account=bob :peer!u@h PRIVMSG #iirc :hi",
        "?? message Privmsg peer #iirc in=channel:#iirc :hi"
      ),
    });

    expect.assertions(0);
  });
});

describe("account-notify", () => {
  it("sets a User's account from an ACCOUNT Line, as Activity in each Channel they share", () => {
    const transcript = notified(
      "<< :peer!u@h ACCOUNT bob",
      "?? activity AccountChanged peer account=bob in=channel:#iirc in=channel:#two in=existing-direct:peer"
    );

    expect(userOf(transcript, "peer")?.account).toMatchObject(bob);
    expect(userOf(transcript, "other")?.account).toStrictEqual(unknown);
  });

  it("takes `*` as logged out, which is known and not the same as not known", () => {
    const transcript = notified("<< :peer!u@h ACCOUNT bob", "<< :peer!u@h ACCOUNT *");
    const account = userOf(transcript, "peer")?.account;

    expect(account).toMatchObject(loggedOut);
    expect(userOf(notified("<< :peer!u@h ACCOUNT *"), "peer")?.account).toMatchObject(loggedOut);
  });

  it("reports a logout as AccountChanged with no account", () => {
    play(client, {
      configuration: base,
      transcript: notified(
        "<< :peer!u@h ACCOUNT *",
        "?? activity AccountChanged peer logged-out in=channel:#iirc in=channel:#two in=existing-direct:peer"
      ),
    });

    expect.assertions(0);
  });

  it("sets Self's account, and shows it in the Network's own Timeline", () => {
    const transcript = notified(
      "<< :iirc!u@h ACCOUNT carol",
      "?? activity AccountChanged iirc account=carol in=network"
    );

    expect(selfOf(transcript)?.account).toMatchObject({ _tag: "Known", value: "carol" });
    expect(selfOf([...transcript, lines("<< :iirc!u@h ACCOUNT *")])?.account).toMatchObject(
      loggedOut
    );
  });

  it("reports a User who shares no Channel with Self, and keeps nothing of them", () => {
    expect(
      userOf(
        notified(
          "<< :stranger!u@h ACCOUNT bob",
          "?? activity AccountChanged stranger account=bob in=existing-direct:stranger"
        ),
        "stranger"
      )
    ).toBeUndefined();
  });

  it("reads an ACCOUNT with no account, or from no User, as malformed", () => {
    play(client, {
      configuration: base,
      transcript: notified(
        "<< :peer!u@h ACCOUNT",
        "?? ignored Malformed ACCOUNT",
        "<< ACCOUNT bob",
        "?? ignored Malformed ACCOUNT",
        "<< :irc.test ACCOUNT bob",
        "?? ignored Malformed ACCOUNT"
      ),
    });

    expect.assertions(0);
  });

  it("reports history, and changes nothing from it", () => {
    const transcript = [
      ...inChannels(["batch", ...accounts]),
      lines(
        "<< :irc.test BATCH +h chathistory #iirc",
        "<< @batch=h :peer!u@h ACCOUNT bob",
        "?? activity AccountChanged peer account=bob history in=channel:#iirc in=channel:#two in=existing-direct:peer",
        "<< :irc.test BATCH -h"
      ),
    ];

    expect(userOf(transcript, "peer", withHistory)?.account).toStrictEqual(unknown);
  });

  it("makes others' accounts stale on CAP DEL, and Self's not, until a tag says again", () => {
    const deleted = [
      ...inChannels(["cap-notify", ...accounts]),
      lines(
        "<< :peer!u@h ACCOUNT bob",
        "<< :other!u@h ACCOUNT *",
        "<< :iirc!u@h ACCOUNT carol",
        "+1s",
        "<< :irc.test CAP iirc DEL :account-notify"
      ),
    ];

    expect(userOf(deleted, "peer")?.account).toMatchObject({ _tag: "Stale", was: "bob" });
    expect(userOf(deleted, "other")?.account).toMatchObject({ _tag: "Stale", was: null });
    expect(selfOf(deleted)?.account).toMatchObject({ _tag: "Known", value: "carol" });

    expect(
      userOf([...deleted, lines("<< @account=dan :peer!u@h PRIVMSG #iirc :hi")], "peer")?.account
    ).toMatchObject({ _tag: "Known", value: "dan" });
  });
});

describe("deleting a cap", () => {
  it("makes stale what account-tag or extended-join said, though another cap stays", () => {
    const said = [
      ...inChannels(["cap-notify", ...accounts]),
      lines(
        "<< @account=bob :peer!u@h PRIVMSG #iirc :hi",
        "<< :new!u@h JOIN #iirc carol :Carol Real"
      ),
    ];

    const tagGone = [...said, lines("<< :irc.test CAP iirc DEL :account-tag")];
    const joinGone = [...said, lines("<< :irc.test CAP iirc DEL :extended-join")];

    expect(userOf(tagGone, "peer")?.account).toMatchObject({ _tag: "Stale", was: "bob" });
    expect(userOf(joinGone, "new")?.account).toMatchObject({ _tag: "Stale", was: "carol" });
    expect(userOf(joinGone, "new")?.realname).toMatchObject({ _tag: "Stale", was: "Carol Real" });
  });
});

describe("extended-join", () => {
  it("sets an account and a realname from a JOIN", () => {
    const transcript = joinedBy(
      "<< :new!u@h JOIN #iirc bob :Bob Real",
      "?? activity Joined #iirc new in=channel:#iirc"
    );

    const user = userOf(transcript, "new");

    expect(user?.account).toMatchObject(bob);
    expect(user?.realname).toMatchObject({ _tag: "Known", from: "ircd", value: "Bob Real" });
  });

  it("takes `*` as logged out, and still knows the realname", () => {
    const user = userOf(joinedBy("<< :new!u@h JOIN #iirc * :Bob Real"), "new");

    expect(user?.account).toMatchObject(loggedOut);
    expect(user?.realname).toMatchObject({ _tag: "Known", value: "Bob Real" });
  });

  it("knows nothing more from a JOIN of the plain form", () => {
    const user = userOf(
      [
        registered(base, { offered: ["extended-join"] }),
        joined(base, "#iirc", ["peer"]),
        lines("<< :new!u@h JOIN #iirc"),
      ],
      "new"
    );

    expect(user?.account).toStrictEqual(unknown);
    expect(user?.realname).toStrictEqual(unknown);
  });

  it("changes nothing of Self from Self's own JOIN", () => {
    const self = selfOf(joinedBy("<< :iirc!u@h JOIN #two bob :Self Real"));

    expect(self?.account).toStrictEqual(unknown);
  });
});

describe("without the caps", () => {
  it("leaves every account unknown, from a tag, an ACCOUNT, or an extended JOIN", () => {
    const transcript = without(
      "<< @account=bob :peer!u@h PRIVMSG #iirc :hi",
      "<< :peer!u@h ACCOUNT bob",
      "<< :new!u@h JOIN #iirc bob :Bob Real"
    );

    for (const nick of ["peer", "new"]) {
      expect(userOf(transcript, nick)?.account).toStrictEqual(unknown);
    }

    expect(userOf(transcript, "new")?.realname).toStrictEqual(unknown);
    expect(selfOf(transcript)?.account).toStrictEqual(unknown);
  });

  it("reports an ACCOUNT as nothing", () => {
    const step = play(client, {
      configuration: base,
      transcript: [...without(), lines("<< :peer!u@h ACCOUNT bob")],
    }).steps.at(-1);

    expect(step?.news).toStrictEqual([]);
  });

  it("reads an ACCOUNT, and an extended JOIN, as nothing when only account-tag is on", () => {
    const transcript = [
      registered(base, { offered: ["account-tag"] }),
      joined(base, "#iirc", ["peer"]),
      lines("<< :peer!u@h ACCOUNT bob", "<< :new!u@h JOIN #iirc bob :Bob Real"),
    ];

    expect(userOf(transcript, "peer")?.account).toStrictEqual(unknown);
    expect(userOf(transcript, "new")?.realname).toStrictEqual(unknown);
  });
});

describe("a WHOIS", () => {
  it("says nothing of an account the reply did not name", () => {
    expect(
      userOf(whois([], "311 iirc peer ~u peer.test * :Peer Person"), "peer")?.account
    ).toStrictEqual(unknown);
  });

  it("does not undo what a Line said since, or in between", () => {
    const user = userOf(
      [
        registered(base, { offered: ["account-notify"] }),
        joined(base, "#iirc", ["peer"]),
        lines(
          "!! whois peer",
          ">> WHOIS peer",
          "<< :irc.test 330 iirc peer bob :is logged in as",
          "<< :peer!u@h ACCOUNT *",
          "<< :irc.test 318 iirc peer :End"
        ),
      ],
      "peer"
    );

    expect(user?.account).toMatchObject(loggedOut);
  });
});
