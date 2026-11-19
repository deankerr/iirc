import { CredentialName } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import { ConnectionId, Instant } from "../ids.ts";
import { play, replay } from "./play.ts";
import { configured, registered } from "./preludes.ts";
import { scripted } from "./scripted.ts";
import { failure, toy } from "./test-clients.ts";

const base = configured();
const client = toy();

const floor = registered(base);

describe("a mismatch", () => {
  it("shows a different Line as a transcript diff", () => {
    expect(
      failure(() =>
        play(client, {
          configuration: base,
          transcript: floor.replace(">> NICK iirc", ">> NICK other"),
        })
      )
    )
      .toBe(`TranscriptMismatchError: The transcript did not play as written. - is the scenario, + is what the Client did.
@@ line 2 @@
  -> dial irc.test:6697 tls
  == opened
  >> CAP LS 302
- >> NICK other
+ >> NICK iirc
  >> USER iirc 0 * iirc
  << :irc.test 421 * CAP :Unknown command
  << :irc.test 001 iirc :Welcome to the iirc-test Network iirc`);
  });

  it("shows an output that was not written", () => {
    expect(
      failure(() =>
        play(client, { configuration: base, transcript: floor.replace(">> CAP LS 302\n", "") })
      )
    ).toContain("  == opened\n+ >> CAP LS 302\n  >> NICK iirc");
  });

  it("shows an output that was written but not sent", () => {
    expect(
      failure(() =>
        play(client, {
          configuration: base,
          transcript: floor.replace("== opened\n", "== opened\n>> PASS :nothing\n"),
        })
      )
    ).toContain("  == opened\n- >> PASS :nothing\n  >> CAP LS 302");
  });

  it("shows outputs in the wrong order", () => {
    expect(
      failure(() =>
        play(client, {
          configuration: base,
          transcript: floor.replace(
            ">> NICK iirc\n>> USER iirc 0 * iirc\n",
            ">> USER iirc 0 * iirc\n>> NICK iirc\n"
          ),
        })
      )
    ).toContain(
      "  >> CAP LS 302\n- >> USER iirc 0 * iirc\n  >> NICK iirc\n+ >> USER iirc 0 * iirc"
    );
  });

  it("shows an expected News that did not come, beside the one that did", () => {
    const transcript = floor.replace(
      /(?<welcome><< :irc\.test 001 [^\n]*\n)/u,
      "$<welcome>?? session-began bob\n"
    );

    expect(failure(() => play(client, { configuration: base, transcript }))).toContain(
      "- ?? session-began bob\n+ ?? session-began iirc"
    );
  });

  it("shows a placeholder whose fields differ", () => {
    const secret = scripted([
      {
        outputs: [
          {
            _tag: "SendSecret",
            connection: ConnectionId.make(1),
            line: {
              _tag: "AuthenticatePlain",
              authcid: "iirc",
              authzid: "",
              credential: CredentialName.make("libera"),
            },
          },
        ],
        when: "Configured",
      },
    ]);

    expect(
      failure(() =>
        play(secret, {
          configuration: base,
          transcript:
            "!! configure\n>> {AuthenticatePlain credential=libera authcid=iirc authzid=iirc}\n",
        })
      )
    ).toContain(
      "- >> {AuthenticatePlain credential=libera authcid=iirc authzid=iirc}\n+ >> {AuthenticatePlain credential=libera authcid=iirc authzid=}"
    );
  });

  it("shows a dial out of order, and a Line on the wrong Connection", () => {
    const ircd = { host: "irc.test", port: 6697, tls: true };

    const wrong = scripted([
      { outputs: [{ _tag: "Dial", connection: ConnectionId.make(5), ircd }], when: "Configured" },
      { outputs: [{ _tag: "Hangup", connection: ConnectionId.make(5) }], when: "Opened" },
    ]);

    const message = failure(() =>
      play(wrong, {
        configuration: base,
        transcript: "!! configure\n-> dial irc.test:6697 tls\n== opened\n-> hangup\n",
      })
    );

    expect(message).toContain(
      "- -> dial irc.test:6697 tls\n+ -> dial irc.test:6697 tls (as connection 5, not 1)"
    );
    expect(message).toContain("- -> hangup\n+ -> hangup (on connection 5, not 1)");
  });

  it("fails a transcript that does not parse, naming the line", () => {
    expect(
      failure(() =>
        play(client, { configuration: base, transcript: "!! configure\n== exploded\n" })
      )
    ).toMatch(/^ScenarioError: line 2 of the transcript is not `== opened`/u);
  });
});

describe("the Ignored rule", () => {
  const early = "<< :irc.test NOTICE * :too soon\n";

  it("fails an Ignored that is not written", () => {
    expect(
      failure(() =>
        play(client, {
          configuration: base,
          transcript: `!! configure\n-> dial irc.test:6697 tls\n${early}`,
        })
      )
    ).toContain(`  ${early}+ ?? ignored NotNow Received`);
  });

  it("does not let an Ignored be skipped to reach a later News", () => {
    const twice = scripted([
      {
        news: [
          { _tag: "Ignored", reason: { _tag: "Malformed", command: "MODE" } },
          { _tag: "SessionBegan", at: Instant.make(1_767_225_600_000), nick: "iirc" },
        ],
        when: "Configured",
      },
    ]);

    expect(
      failure(() =>
        play(twice, { configuration: base, transcript: "!! configure\n?? session-began iirc\n" })
      )
    ).toContain("+ ?? ignored Malformed MODE");
    expect(
      play(twice, {
        configuration: base,
        transcript: "!! configure\n?? ignored Malformed MODE\n?? session-began iirc\n",
      }).ignored
    ).toHaveLength(1);
  });
});

describe("...", () => {
  it("ends at the next expectation", () => {
    const transcript = `!! configure\n...\n-> dial irc.test:6697 tls\n== opened\n>> CAP LS 302\n`;

    expect(failure(() => play(client, { configuration: base, transcript }))).toContain(
      "  >> CAP LS 302\n+ >> NICK iirc\n+ >> USER iirc 0 * iirc"
    );
  });
});

describe("the fake clock", () => {
  const registering =
    "!! configure\n-> dial irc.test:6697 tls\n== opened\n>> CAP LS 302\n>> NICK iirc\n>> USER iirc 0 * iirc\n";

  it("fires due timers in order, each at its own instant", () => {
    const played = play(client, {
      configuration: base,
      transcript: `${floor}+150s\n>> PRIVMSG iirc ping\n>> PRIVMSG iirc ping\n`,
    });

    expect(
      played.inputs
        .filter((input) => input._tag === "Fired")
        .map(({ at }) => at - 1_767_225_600_000)
    ).toStrictEqual([60_000, 120_000]);
  });

  it("fails a timer's output that is not written", () => {
    expect(
      failure(() => play(client, { configuration: base, transcript: `${registering}+30s\n` }))
    ).toContain("  +30s\n+ -> hangup");
  });
});

describe(replay, () => {
  it("steps a Configured first, feeds inputs only, and reports what the Client did", () => {
    const played = replay(client, {
      configuration: base,
      transcript:
        "-> dial irc.test:6697 tls\n== opened\n>> NOT WHAT IT SENT\n<< :irc.test 001 iirc :hi\n<< bad\n",
    });

    expect(played.transcript).toBe(
      [
        "!! configure",
        "-> dial irc.test:6697 tls",
        "== opened",
        ">> CAP LS 302",
        ">> NICK iirc",
        ">> USER iirc 0 * iirc",
        "<< :irc.test 001 iirc :hi",
        "?? session-began iirc",
        "<< bad",
        "",
      ].join("\n")
    );
  });

  it("reports every Ignored, with its input", () => {
    expect(
      replay(client, { configuration: base, transcript: "<< :irc.test NOTICE * :early\n" }).ignored
    ).toStrictEqual(["<< :irc.test NOTICE * :early\n?? ignored NotNow Received"]);
  });

  it("does not step a second Configured when the transcript starts with one", () => {
    const played = replay(client, {
      configuration: base,
      transcript: "# hi\n!! configure +#iirc\n",
    });

    expect(played.inputs.map((input) => input._tag)).toStrictEqual(["Configured"]);
  });
});

describe("registration", () => {
  it("refuses to request a cap the Ircd does not offer", () => {
    expect(
      failure(() => registered(base, { offered: ["multi-prefix"], requested: ["sasl"] }))
    ).toBe("TypeError: a prelude requests caps the Ircd does not offer: sasl");
  });
});

describe("the timer table", () => {
  it("agrees with the Client for a timer that fired and was set again", () => {
    const played = play(client, {
      configuration: base,
      transcript: `${floor}+60s\n>> PRIVMSG iirc ping\n`,
    });

    expect(played.timers).toStrictEqual(client.inspect(played.state).timers);
  });
});
