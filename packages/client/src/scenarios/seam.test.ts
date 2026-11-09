/**
 * The Feature seam, driven through `step` with Features made for these tests. The real
 * registry is empty on the floor, so these show the seam works before stage 2 fills it.
 */
import { CredentialName, isRejected, withTags } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import { makeClient } from "../core.ts";
import type { Feature, Meant } from "../feature.ts";
import { CapName, FeatureName, IntentId, TimerId } from "../ids.ts";
import type { MemberKnowledge } from "../known.ts";
import { register, registry } from "../registry.ts";
import { configured, joined, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const complete = (member: MemberKnowledge): MemberKnowledge =>
  member.prefixes._tag === "Partial"
    ? {
        ...member,
        prefixes: {
          _tag: "Known",
          at: member.prefixes.at,
          from: member.prefixes.from,
          value: member.prefixes.atLeast,
        },
      }
    : member;

// As `multi-prefix` will: a listing shows every prefix, so a member's prefixes are known.
const listing: Feature = {
  meaning: (meant) => ({
    value: meant.map((each): Meant =>
      each._tag === "Listed" ? { ...each, members: each.members.map(complete) } : each
    ),
  }),
  name: FeatureName.make("multi-prefix"),
  needs: { caps: [CapName.make("multi-prefix")] },
  own: undefined,
};

describe("turning Features on and off", () => {
  const client = makeClient([register(listing)]);

  it("requests the caps a Feature needs, and refines what the core derived once it is on", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["multi-prefix", "other"], requested: ["multi-prefix"] }),
        joined(base, "#iirc", ["@+peer"]),
      ],
    });

    expect(client.inspect(played.state)).toMatchObject({
      caps: { enabled: new Set(["multi-prefix"]) },
      features: ["multi-prefix"],
      states: { caps: "Ready.Steady" },
    });
    expect(
      client.known(played.state).channels.get("#iirc")?.members.get("peer")?.prefixes
    ).toMatchObject({
      _tag: "Known",
      value: new Set(["o", "v"]),
    });
  });

  it("asks for nothing the Owner declined, and leaves the Feature off", () => {
    const declined = configured({ declined: [FeatureName.make("multi-prefix")] });

    const played = play(client, {
      configuration: declined,
      transcript: registered(declined, { offered: ["multi-prefix"], requested: [] }),
    });

    expect(client.inspect(played.state).features).toStrictEqual([]);
  });

  it("turns a Feature off when its cap is deleted, and on again when it is new", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["multi-prefix"] }),
        lines(
          "<< :irc.test CAP iirc DEL :multi-prefix",
          "<< :irc.test CAP iirc NEW :multi-prefix",
          ">> CAP REQ multi-prefix"
        ),
      ],
    });

    expect(client.inspect(played.state)).toMatchObject({
      features: [],
      states: { caps: "Ready.Changing" },
    });

    const acked = play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["multi-prefix"] }),
        lines(
          "<< :irc.test CAP iirc DEL :multi-prefix",
          "<< :irc.test CAP iirc NEW :multi-prefix",
          ">> CAP REQ multi-prefix",
          "<< :irc.test CAP iirc ACK :multi-prefix"
        ),
      ],
    });

    expect(client.inspect(acked.state).features).toStrictEqual(["multi-prefix"]);
  });

  it("ends negotiation when the Ircd refuses what it asked for", () => {
    play(client, {
      configuration: base,
      transcript: lines(
        "!! configure",
        "-> dial irc.test:6697 tls",
        "== opened",
        ">> CAP LS 302",
        ">> NICK iirc",
        ">> USER iirc 0 * iirc",
        "<< :irc.test CAP * LS :multi-prefix",
        ">> CAP REQ multi-prefix",
        "<< :irc.test CAP * NAK :multi-prefix",
        ">> CAP END"
      ),
    });

    expect.assertions(0);
  });
});

describe("a Feature that throws", () => {
  const boom: Feature = {
    name: FeatureName.make("boom"),
    needs: { caps: [CapName.make("boom")] },
    own: undefined,
    tags: () => {
      throw new Error("a bug");
    },
  };

  const client = makeClient([register(boom)]);

  it("is off for the rest of the Connection, and the Line is read without it", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["boom"] }).replace(
          /(?<welcome><< :irc\.test 001 [^\n]*\n)/u,
          "$<welcome>?? ignored FeatureFailed boom\n"
        ),
      ],
    });

    expect(played.ignored).toStrictEqual(["?? ignored FeatureFailed boom"]);
    expect(client.inspect(played.state).features).toStrictEqual([]);
  });
});

// As SASL will: hold registration open until a numeric says to go on.
const holding: Feature = {
  name: FeatureName.make("hold"),
  needs: { caps: [CapName.make("hold")] },
  own: undefined,
  react: (arrival) =>
    arrival.line.command === "903" ? { registration: { _tag: "Continue" } } : {},
  start: () => ({ registration: { _tag: "Hold" } }),
};

describe("holding registration", () => {
  const asked = lines(
    "!! configure",
    "-> dial irc.test:6697 tls",
    "== opened",
    ">> CAP LS 302",
    ">> NICK iirc",
    ">> USER iirc 0 * iirc",
    "<< :irc.test CAP * LS :hold",
    ">> CAP REQ hold",
    "<< :irc.test CAP * ACK :hold"
  );

  it("sends CAP END only once the Feature lets registration go", () => {
    const client = makeClient([register(holding)]);

    const played = play(client, {
      configuration: base,
      transcript: [asked, lines("+5s", "<< :irc.test 903 * :done", ">> CAP END")],
    });

    expect(client.inspect(played.state).timers.has(TimerId.make("hold"))).toBeFalsy();
  });

  it("lets registration go when the hold runs out and the Feature has no say", () => {
    const client = makeClient([register(holding)]);

    play(client, { configuration: base, transcript: [asked, lines("+30s", ">> CAP END")] });

    expect.assertions(0);
  });

  it("gives up the Connection when the Feature abandons it", () => {
    const client = makeClient([
      register({
        ...holding,
        expired: () => ({ registration: { _tag: "Abandon", reason: { _tag: "LoginFailed" } } }),
      }),
    ]);

    play(client, {
      configuration: base,
      transcript: [
        asked,
        lines(
          "+30s",
          ">> QUIT",
          "-> hangup",
          "== closed HungUp",
          "?? connection-failed LoginFailed"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("the other stages", () => {
  it("lets egress change a Line on its way out", () => {
    const tagging: Feature = {
      egress: (departure) => {
        const tagged = withTags(departure.line, { "+test": "1" });

        return {
          value:
            departure.for._tag === "Said" && !isRejected(tagged)
              ? { ...departure, line: tagged }
              : departure,
        };
      },
      name: FeatureName.make("tagging"),
      needs: { caps: [CapName.make("message-tags")] },
      own: undefined,
    };

    const client = makeClient([register(tagging)]);

    play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["message-tags"] }),
        lines("!! say #iirc :hi", ">> @+test=1 PRIVMSG #iirc hi"),
      ],
    });

    expect.assertions(0);
  });

  it("lets a Feature on an ISUPPORT token choose how bytes become text", () => {
    const utf8: Feature = {
      encoding: { _tag: "Utf8Only" },
      name: FeatureName.make("utf8only"),
      needs: { tokens: ["UTF8ONLY"] },
      own: undefined,
    };

    const client = makeClient([register(utf8)]);

    play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: ["UTF8ONLY"] }),
        lines("<<\\ :peer!u@h PRIVMSG iirc :caf\\xe9", "?? message Privmsg peer iirc :caf�"),
      ],
    });
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("<<\\ :peer!u@h PRIVMSG iirc :caf\\xe9", "?? message Privmsg peer iirc :café"),
      ],
    });

    expect.assertions(0);
  });

  it("lets batch hold Lines back, and label tie a reply to the intent it answers", () => {
    const answering: Feature = {
      batch: (arrival) => ({ value: arrival.line.command === "NOTICE" ? [] : [arrival] }),
      label: (arrival) => {
        const label = arrival.line.tags.get("label");

        return {
          value: label === undefined ? arrival : { ...arrival, answers: IntentId.make(label) },
        };
      },
      name: FeatureName.make("answering"),
      needs: { caps: [CapName.make("labeled-response")] },
      own: undefined,
    };

    const client = makeClient([register(answering)]);

    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["labeled-response"] }),
        lines(
          "<< :peer!u@h NOTICE iirc :held back",
          "!! say #iirc :hello",
          ">> PRIVMSG #iirc hello",
          "<< @label=i1 :iirc!~iirc@h PRIVMSG #iirc :hello",
          "?? confirmed i1 :hello",
          "!! say #nowhere :hello",
          ">> PRIVMSG #nowhere hello",
          "<< @label=i2 :irc.test 404 iirc #nowhere :Cannot send to channel",
          "?? refused i2 Rejected 404"
        ),
      ],
    });

    expect(
      played.steps.find((step) =>
        step.news.some((news) => news._tag === "Message" && news.text === "held back")
      )
    ).toBeUndefined();
  });

  it("marks the facts a Feature kept stale when it turns off", () => {
    const masks: Feature = {
      keeps: ["user.mask"],
      name: FeatureName.make("chghost"),
      needs: { caps: [CapName.make("chghost")] },
      own: undefined,
    };

    const client = makeClient([register(masks)]);

    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["chghost"] }),
        joined(base, "#iirc", ["peer"]),
        lines("<< :peer!~p@p.host JOIN #other", "+1s", "<< :irc.test CAP iirc DEL :chghost"),
      ],
    });

    expect(client.known(played.state).self?.mask).toMatchObject({
      _tag: "Stale",
      was: { host: "iirc.test", user: "~iirc" },
    });
  });
});

describe("egress refusing a Line", () => {
  // Refuses every Line to `#nowhere`, the Owner's and the protocol's alike.
  const refusing: Feature = {
    egress: (departure) => ({
      value: departure.line.params[0] === "#nowhere" ? { _tag: "Refusal" } : departure,
    }),
    name: FeatureName.make("refusing"),
    needs: { caps: [CapName.make("refusing")] },
    own: undefined,
  };

  const client = makeClient([register(refusing)]);

  it("refuses a Say as Unsendable, sends nothing, and reports no Message", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["refusing"] }),
        lines("!! say #nowhere :hi", "?? refused i1 Unsendable"),
      ],
    });

    expect(played.steps.at(-1)?.news.map((news) => news._tag)).toStrictEqual(["Refused"]);
  });

  it("drops any other Line, and says so by its command", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["refusing"] }),
        lines("!! configure +#nowhere", "?? ignored Unsendable JOIN"),
      ],
    });

    expect.assertions(0);
  });
});

// A Feature that only keeps away status, on its own cap.
const keeper = (cap: string): Feature => ({
  keeps: ["user.away"],
  name: FeatureName.make(cap),
  needs: { caps: [CapName.make(cap)] },
  own: undefined,
});

describe("facts more than one Feature keeps", () => {
  const client = makeClient([register(keeper("one")), register(keeper("two"))]);

  const away = [
    registered(base, { offered: ["one", "two"] }),
    joined(base, "#iirc", ["peer"]),
    lines("<< :peer!u@h AWAY :out", "+1s"),
  ];

  it("stay known while a Feature that keeps them is still on", () => {
    const played = play(client, {
      configuration: base,
      transcript: [...away, lines("<< :irc.test CAP iirc DEL :one")],
    });

    expect(client.known(played.state).users.get("peer")?.away).toMatchObject({ _tag: "Known" });
  });

  it("go stale once none that keeps them is on", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        ...away,
        lines("<< :irc.test CAP iirc DEL :one", "<< :irc.test CAP iirc DEL :two"),
      ],
    });

    expect(client.known(played.state).users.get("peer")?.away).toMatchObject({ _tag: "Stale" });
  });
});

describe("a Feature's own state", () => {
  // Counts the Lines it hears while on.
  const counting: Feature<number> = {
    name: FeatureName.make("counting"),
    needs: { caps: [CapName.make("counting")] },
    own: 0,
    tags: (arrival, context) => ({ own: context.own + 1, value: arrival }),
  };

  const client = makeClient([register(counting)]);

  it("is kept while it is off, and goes on when it is on again in the same Connection", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["counting"] }),
        lines(
          "<< :irc.test CAP iirc DEL :counting",
          "<< :irc.test CAP iirc NEW :counting",
          ">> CAP REQ counting",
          "<< :irc.test CAP iirc ACK :counting"
        ),
      ],
    });

    const open =
      played.state.network._tag === "Connection" ? played.state.network.link.phase : undefined;

    const own = open?._tag === "Open" ? open.seam.own.get(FeatureName.make("counting")) : undefined;

    // Heard while on: 001 to 005, and the DEL. Started again, it would be 0.
    expect(own).toBe(6);
  });
});

describe("history, and hooks that act", () => {
  // Every Line the batch Feature says is in a batch is history, as `chathistory` will be.
  const history: Feature = {
    label: (arrival) => ({
      value: arrival.batch === undefined ? arrival : { ...arrival, live: false },
    }),
    name: FeatureName.make("history"),
    needs: {},
    own: undefined,
  };

  const client = makeClient([...registry, register(history)]);

  const login = configured({
    login: { _tag: "Sasl", account: "iirc", credential: CredentialName.make("pw"), required: true },
  });

  const asked = lines(
    "!! configure",
    "-> dial irc.test:6697 tls",
    "== opened",
    ">> CAP LS 302",
    ">> NICK iirc",
    ">> USER iirc 0 * iirc",
    "<< :irc.test CAP * LS :sasl=PLAIN batch",
    ">> CAP REQ :sasl batch",
    "<< :irc.test CAP * ACK :sasl batch",
    ">> AUTHENTICATE PLAIN"
  );

  it("never sends the Credential for an AUTHENTICATE + from history", () => {
    const played = play(client, {
      configuration: login,
      transcript: [
        asked,
        lines(
          "<< :irc.test BATCH +h chathistory",
          "<< @batch=h AUTHENTICATE +",
          "<< :irc.test BATCH -h"
        ),
      ],
    });

    expect(played.steps.flatMap((step) => step.outputs).map((output) => output._tag)).not.toContain(
      "SendSecret"
    );
  });

  it("never logs in, or lets registration go, on a 903 or a 904 from history", () => {
    const played = play(client, {
      configuration: login,
      transcript: [
        asked,
        lines(
          "<< AUTHENTICATE +",
          ">> {AuthenticatePlain credential=pw authcid=iirc authzid=iirc}",
          "<< :irc.test BATCH +h chathistory",
          "<< @batch=h :irc.test 903 iirc :SASL authentication successful",
          "<< @batch=h :irc.test 904 iirc :SASL authentication failed",
          "<< :irc.test BATCH -h"
        ),
      ],
    });

    expect(client.inspect(played.state).states.caps).toBe("Holding");
  });

  it("discards what a refining hook asks to send or decide", () => {
    const pushy: Feature = {
      label: (arrival) => ({
        registration: { _tag: "Abandon", reason: { _tag: "LoginFailed" } },
        send: [{ _tag: "Secret", line: { _tag: "Pass", credential: CredentialName.make("pw") } }],
        value: arrival,
      }),
      name: FeatureName.make("pushy"),
      needs: { caps: [CapName.make("pushy")] },
      own: undefined,
    };

    const played = play(makeClient([register(pushy)]), {
      configuration: base,
      transcript: [
        registered(base, { offered: ["pushy"] }),
        lines("<< :peer!u@h PRIVMSG iirc :hi"),
      ],
    });

    expect(played.steps.at(-1)?.outputs).toStrictEqual([]);
  });
});
