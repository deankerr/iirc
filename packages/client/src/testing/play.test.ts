import { CredentialName } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import { ConnectionId, FeatureName, Instant } from "../ids.ts";
import { timers } from "../output.ts";
import type { TimerTable } from "../output.ts";
import { play, replay } from "./play.ts";
import { configured, joined, registered } from "./preludes.ts";
import { scripted } from "./scripted.ts";
import { failure, toy } from "./test-clients.ts";

const base = configured();
const client = toy();

const floor = registered(base);

describe("strict play", () => {
  it("plays the floor prelude, and returns what happened", () => {
    const played = play(client, { configuration: base, transcript: floor });

    expect(played.transcript).toBe(floor);
    expect(played.ignored).toStrictEqual([]);
    expect(played.inputs[0]).toMatchObject({ _tag: "Configured", at: 1_767_225_600_000 });
    expect(client.inspect(played.state).states).toStrictEqual({ connection: "Registered" });
  });

  it("plays the prelude with caps, and a join", () => {
    const transcript = [
      registered(base, { offered: ["multi-prefix", "server-time"] }),
      joined(base, "#iirc", ["@peer", "+voiced"]),
    ];

    const played = play(client, { configuration: base, transcript });
    const members = client.known(played.state).channels.get("#iirc")?.members;

    expect([...(members?.keys() ?? [])]).toStrictEqual(["iirc", "peer", "voiced"]);
    expect(members?.get("peer")?.prefixes).toMatchObject({ _tag: "Known", value: new Set(["o"]) });
    expect(played.inputs.at(-1)).toMatchObject({ _tag: "Received" });
    expect(
      played.inputs.find(
        (input) => input._tag === "Configured" && input.configuration.channels.length > 0
      )
    ).toMatchObject({
      configuration: { channels: [{ name: "#iirc" }] },
    });
  });

  it("matches News written with ??, and lets other News go unwritten", () => {
    const transcript = floor.replace(
      /(?<welcome><< :irc\.test 001 [^\n]*\n)/u,
      "$<welcome>?? session-began iirc\n"
    );

    expect(play(client, { configuration: base, transcript }).transcript).toBe(transcript);
  });

  it("feeds Owner inputs with intent ids in order", () => {
    const played = play(client, {
      configuration: base,
      transcript: `${floor}!! say #iirc :one\n>> PRIVMSG #iirc one\n!! notice peer :two words\n>> PRIVMSG peer :two words\n?? message Notice iirc peer at=ours:t+0s in=network ours=i2 :two words\n`,
    });

    expect(
      played.inputs.flatMap((input) => (input._tag === "Say" ? [input.intent] : []))
    ).toStrictEqual(["i1", "i2"]);
  });

  it("refuses an Owner intent the Client cannot carry out, as News", () => {
    expect(
      play(client, {
        configuration: base,
        transcript:
          "!! configure\n-> dial irc.test:6697 tls\n!! say #iirc :hi\n?? refused i1 Offline\n",
      }).ignored
    ).toStrictEqual([]);
  });
});

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

  it("passes it once it is written", () => {
    const transcript = `!! configure\n-> dial irc.test:6697 tls\n${early}?? ignored NotNow Received\n`;

    expect(play(client, { configuration: base, transcript }).ignored).toStrictEqual([
      "?? ignored NotNow Received",
    ]);
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

  it("finds an Ignored from an old Connection", () => {
    const transcript = `${floor}== closed Reset\n!! configure disable\n!! configure enable\n-> dial irc.test:6697 tls\n== connection 1\n<< :irc.test PING :late\n?? ignored StaleConnection 1\n`;

    expect(failure(() => play(client, { configuration: base, transcript }))).toBe("it held");
  });
});

describe("...", () => {
  it("allows any outputs and News up to the next expectation", () => {
    const transcript = `!! configure\n-> dial irc.test:6697 tls\n== opened\n...\n<< :irc.test NOTICE * :hello\n<< :irc.test 001 iirc :Welcome\n?? session-began iirc\n<< :irc.test PING :x\n>> PONG x\n`;

    expect(play(client, { configuration: base, transcript }).transcript).toBe(transcript);
  });

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

  it("fires a timer when the clock passes it, and expects its outputs next", () => {
    const played = play(client, {
      configuration: base,
      transcript: `${registering}+29s\n+1s\n-> hangup\n`,
    });

    expect(played.inputs.at(-1)).toStrictEqual({
      _tag: "Fired",
      at: 1_767_225_630_000,
      due: 1_767_225_630_000,
      timer: "register",
    });
  });

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

  it("gives a stale firing to the Client to ignore", () => {
    const played = play(client, {
      configuration: base,
      transcript: `${registering}== fired register t+5s\n?? ignored StaleTimer register\n+30s\n-> hangup\n`,
    });

    expect(played.ignored).toStrictEqual(["?? ignored StaleTimer register"]);
  });

  it("does not fire a timer the Client cancelled", () => {
    expect(failure(() => play(client, { configuration: base, transcript: `${floor}+59s\n` }))).toBe(
      "it held"
    );
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
  it("offers more caps than the Client requests", () => {
    const transcript = registered(base, {
      offered: ["sasl=PLAIN", "multi-prefix", "away-notify"],
      requested: ["multi-prefix"],
    });

    expect(transcript).toContain(
      "<< :irc.test CAP * LS :sasl=PLAIN multi-prefix away-notify\n>> CAP REQ multi-prefix\n<< :irc.test CAP * ACK :multi-prefix\n>> CAP END\n"
    );
    expect(failure(() => play(client, { configuration: base, transcript }))).toBe("it held");
  });

  it("ends negotiation at once when the Client requests nothing", () => {
    const declined = configured({ declined: [FeatureName.make("multi-prefix")] });
    const transcript = registered(declined, { offered: ["multi-prefix"], requested: [] });

    expect(transcript).toContain("<< :irc.test CAP * LS :multi-prefix\n>> CAP END\n");
    expect(failure(() => play(client, { configuration: declined, transcript }))).toBe("it held");
  });

  it("refuses to request a cap the Ircd does not offer", () => {
    expect(
      failure(() => registered(base, { offered: ["multi-prefix"], requested: ["sasl"] }))
    ).toBe("TypeError: a prelude requests caps the Ircd does not offer: sasl");
  });
});

describe("dialling", () => {
  it("dials at once on Started, as the next Connection", () => {
    const transcript =
      "!! configure\n-> dial irc.test:6697 tls\n== started\n-> dial irc.test:6697 tls\n";

    expect(
      play(client, { configuration: base, transcript }).inputs.map(({ _tag }) => _tag)
    ).toStrictEqual(["Configured", "Started"]);
  });

  it("hangs up when a Configured disables the Network", () => {
    expect(
      failure(() =>
        play(client, {
          configuration: base,
          transcript: `${floor}!! configure disable\n-> hangup\n`,
        })
      )
    ).toBe("it held");
  });

  it("does not dial while disabled", () => {
    const off = configured({ enabled: false });

    expect(
      failure(() => play(client, { configuration: off, transcript: "!! configure\n== started\n" }))
    ).toBe("it held");
  });
});

// The table the Runtime would rebuild on restart: `timers` folded over every step.
const project = (played: ReturnType<typeof play>): TimerTable => {
  let table: TimerTable = new Map();

  for (const [index, input] of played.inputs.entries()) {
    table = timers(table, input, played.steps[index]?.outputs ?? []);
  }

  return table;
};

describe("the timer table", () => {
  it.each([
    [
      "a timer that fired and was not set again",
      "!! configure\n-> dial irc.test:6697 tls\n== opened\n>> CAP LS 302\n>> NICK iirc\n>> USER iirc 0 * iirc\n+30s\n-> hangup\n",
    ],
    ["a timer that fired and was set again", `${floor}+60s\n>> PRIVMSG iirc ping\n`],
    ["a stale firing", `${floor}== fired ping t+5s\n?? ignored StaleTimer ping\n`],
  ])("agrees with the projection and the Client for %s", (_name, transcript) => {
    const played = play(client, { configuration: base, transcript });

    expect(played.timers).toStrictEqual(project(played));
    expect(played.timers).toStrictEqual(client.inspect(played.state).timers);
  });
});
