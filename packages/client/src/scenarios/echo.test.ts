/**
 * `labeled-response` with `echo-message`: our Message is sent with a label, reported at
 * once with `echo`, and the Ircd's answer for the label confirms or rejects it.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { maxPending } from "../features/echo.ts";
import { FeatureName } from "../ids.ts";
import { configured, joined, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const both = ["batch", "echo-message", "labeled-response"];

const inChannel = (...offered: readonly string[]) => [
  registered(base, { offered }),
  joined(base, "#iirc", ["peer"]),
];

const echoing = inChannel(...both);

// Says something, and the Client sends it with the next label.
const say = (intent: number, text = "hello", target = "#iirc") =>
  lines(
    `!! say ${target} :${text}`,
    `>> @label=l${intent} PRIVMSG ${target} ${text.includes(" ") ? ":" : ""}${text}`,
    `?? message Privmsg iirc ${target} at=ours:t+0s ours=i${intent} echo :${text}`
  );

describe("our Message, echoed", () => {
  it("is sent with a label, reported at once, and confirmed by its echo", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...echoing,
        say(1),
        lines("<< @label=l1 :iirc!u@h PRIVMSG #iirc :hello", "?? confirmed i1 :hello"),
      ],
    });

    expect.assertions(0);
  });

  it("is confirmed with the Ircd's time, id, and final text", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["message-tags", "server-time", ...both] }),
        joined(base, "#iirc"),
        say(1, "\u0002bold\u0002"),
        lines(
          "<< @label=l1;msgid=m9;time=2026-01-01T00:00:00.500Z :iirc!u@h PRIVMSG #iirc :bold",
          "?? confirmed i1 at=ircd:t+500ms@t+500ms id=ircd:m9 :bold"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("confirms an ACTION and a NOTICE", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...echoing,
        lines(
          "!! action #iirc :waves",
          ">>\\ @label=l1 PRIVMSG #iirc :\\x01ACTION waves\\x01",
          "?? message Action iirc #iirc at=ours:t+0s ours=i1 echo :waves",
          "<<\\ @label=l1 :iirc!u@h PRIVMSG #iirc :\\x01ACTION waves\\x01",
          "?? confirmed i1 :waves",
          "!! notice #iirc :heads up",
          ">> @label=l2 NOTICE #iirc :heads up",
          "?? message Notice iirc #iirc at=ours:t+0s ours=i2 echo :heads up",
          "<< @label=l2 :iirc!u@h NOTICE #iirc :heads up",
          "?? confirmed i2 :heads up"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is confirmed by a labeled-response batch that holds the echo", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...echoing,
        say(1),
        lines(
          "<< @label=l1 :irc.test BATCH +r labeled-response",
          "<< @batch=r :irc.test NOTE PRIVMSG SLOW :this took a while",
          "<< @batch=r :iirc!u@h PRIVMSG #iirc :hello",
          "?? confirmed i1 :hello",
          "<< @batch=r :iirc!u@h PRIVMSG #iirc :hello",
          "?? message Privmsg iirc #iirc :hello",
          "<< :irc.test BATCH -r"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is confirmed by an echo in a batch nested inside the labelled one", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...echoing,
        say(1),
        lines(
          "<< @label=l1 :irc.test BATCH +outer labeled-response",
          "<< @batch=outer :irc.test BATCH +inner example.com/split",
          "<< @batch=inner :iirc!u@h PRIVMSG #iirc :hel",
          "?? confirmed i1 :hel",
          "<< @batch=outer :irc.test BATCH -inner",
          "<< :irc.test BATCH -outer"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("matches echoes that arrive out of order by their labels", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...echoing,
        say(1, "one"),
        say(2, "two"),
        say(3, "three"),
        lines(
          "<< @label=l3 :iirc!u@h PRIVMSG #iirc :three",
          "?? confirmed i3 :three",
          "<< @label=l1 :iirc!u@h PRIVMSG #iirc :one",
          "?? confirmed i1 :one",
          "<< @label=l2 :iirc!u@h PRIVMSG #iirc :two",
          "?? confirmed i2 :two"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("stays unconfirmed when no echo comes, and a label answered once is not answered again", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        ...echoing,
        say(1),
        say(2),
        lines(
          "<< @label=l2 :iirc!u@h PRIVMSG #iirc :hello",
          "?? confirmed i2 :hello",
          "<< @label=l2 :iirc!u@h PRIVMSG #iirc :hello",
          "?? message Privmsg iirc #iirc :hello"
        ),
      ],
    });

    expect(
      played.steps.flatMap((step) => step.news).filter((news) => news._tag === "Confirmed")
    ).toHaveLength(1);
  });

  it("awaits a bounded number of labels, forgetting the oldest", () => {
    const sayings = Array.from({ length: maxPending + 1 }, (_unused, index) => say(index + 1));

    play(client, {
      configuration: base,
      transcript: [
        ...echoing,
        ...sayings,
        lines(
          "<< @label=l1 :iirc!u@h PRIVMSG #iirc :hello",
          "?? message Privmsg iirc #iirc :hello",
          "<< @label=l2 :iirc!u@h PRIVMSG #iirc :hello",
          "?? confirmed i2 :hello"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("tells the echo of a Message to Self from the copy delivered to Self", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...echoing,
        say(1, "note to self", "iirc"),
        lines(
          "<< :iirc!u@h PRIVMSG iirc :note to self",
          "?? message Privmsg iirc iirc :note to self",
          "<< @label=l1 :iirc!u@h PRIVMSG iirc :note to self",
          "?? confirmed i1 :note to self"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("our Message, refused", () => {
  it.each([
    ["an error numeric", "<< @label=l1 :irc.test 404 iirc #iirc :Cannot send to channel", "404"],
    [
      "a FAIL, by its code",
      "<< @label=l1 :irc.test FAIL PRIVMSG INVALID_UTF8 :Message rejected",
      "INVALID_UTF8",
    ],
    ["a FAIL with no code", "<< @label=l1 :irc.test FAIL PRIVMSG", "FAIL"],
    ["an ACK", "<< @label=l1 :irc.test ACK", "ACK"],
  ])("is rejected by %s", (_name, answer, reply) => {
    play(client, {
      configuration: base,
      transcript: [...echoing, say(1), lines(answer, `?? refused i1 Rejected ${reply}`)],
    });

    expect.assertions(0);
  });

  it("is rejected by an error numeric in its batch, and nothing after it answers", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...echoing,
        say(1),
        lines(
          "<< @label=l1 :irc.test BATCH +r labeled-response",
          "<< @batch=r :irc.test 401 iirc nobody :No such nick",
          "?? refused i1 Rejected 401",
          "<< @batch=r :iirc!u@h PRIVMSG #iirc :hello",
          "?? message Privmsg iirc #iirc :hello",
          "<< :irc.test BATCH -r"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is neither confirmed nor refused by a WARN, which answers the label all the same", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        ...echoing,
        say(1),
        lines(
          "<< @label=l1 :irc.test WARN PRIVMSG INVALID_UTF8 :Modified",
          "<< @label=l1 :iirc!u@h PRIVMSG #iirc :hello",
          "?? message Privmsg iirc #iirc :hello"
        ),
      ],
    });

    expect(played.steps.flatMap((step) => step.news).map((news) => news._tag)).not.toContain(
      "Confirmed"
    );
  });

  it("decides from the reply's structure, never its text", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...echoing,
        say(1),
        lines(
          "<< @label=l1 :irc.test NOTICE iirc :Your message was rejected",
          "?? message Notice irc.test iirc :Your message was rejected"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("without both caps", () => {
  it.each([[["echo-message"]], [["labeled-response"]], [[]]])(
    "asks for neither, labels nothing, and awaits no echo, offered %j",
    (offered) => {
      play(client, {
        configuration: base,
        transcript: [
          registered(base, { offered: ["batch", ...offered], requested: ["batch"] }),
          joined(base, "#iirc"),
          lines(
            "!! say #iirc :hello",
            ">> PRIVMSG #iirc hello",
            "?? message Privmsg iirc #iirc at=ours:t+0s ours=i1 :hello",
            "<< @label=l1 :iirc!u@h PRIVMSG #iirc :hello",
            "?? message Privmsg iirc #iirc :hello"
          ),
        ],
      });

      expect.assertions(0);
    }
  );

  it("is declined by the Owner as one Feature", () => {
    const declined = configured({ declined: [FeatureName.make("echo-message")] });

    play(client, {
      configuration: declined,
      transcript: [
        registered(declined, { offered: both, requested: ["batch"] }),
        lines("!! say #iirc :hello", ">> PRIVMSG #iirc hello"),
      ],
    });

    expect.assertions(0);
  });
});

describe("the caps changing mid-Session", () => {
  it("gives up labeled-response when echo-message is deleted, and labels nothing after", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel("cap-notify", ...both),
        say(1),
        lines(
          "<< :irc.test CAP iirc DEL :echo-message",
          ">> CAP REQ -labeled-response",
          "<< :irc.test CAP iirc ACK :-labeled-response",
          "!! say #iirc :again",
          ">> PRIVMSG #iirc again",
          "?? message Privmsg iirc #iirc at=ours:t+0s ours=i2 :again"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("gives up echo-message when labeled-response is deleted, and ignores echoes until it is gone", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        ...inChannel("cap-notify", ...both),
        say(1),
        lines(
          "<< :irc.test CAP iirc DEL :labeled-response",
          ">> CAP REQ -echo-message",
          "<< :iirc!u@h PRIVMSG #iirc :hello",
          "?? ignored UnmatchedEcho",
          "!! say #iirc :again",
          ">> PRIVMSG #iirc again",
          "?? message Privmsg iirc #iirc at=ours:t+0s ours=i2 :again",
          "<< :iirc!u@h PRIVMSG #iirc :again",
          "?? ignored UnmatchedEcho",
          "<< :peer!u@h PRIVMSG #iirc :from someone else",
          "?? message Privmsg peer #iirc :from someone else",
          "<< :irc.test CAP iirc ACK :-echo-message",
          "<< :iirc!u@elsewhere PRIVMSG #iirc :said elsewhere",
          "?? message Privmsg iirc #iirc :said elsewhere"
        ),
      ],
    });

    expect(client.inspect(played.state).features).not.toContain("echo-message");
  });

  it("goes on from the labels it gave when both are back, so a late echo is still matched", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel("cap-notify", ...both),
        say(1),
        lines(
          "<< :irc.test CAP iirc DEL :echo-message",
          ">> CAP REQ -labeled-response",
          "<< :irc.test CAP iirc ACK :-labeled-response",
          "<< :irc.test CAP iirc NEW :echo-message labeled-response",
          ">> CAP REQ :echo-message labeled-response",
          "<< :irc.test CAP iirc ACK :echo-message labeled-response"
        ),
        say(2, "again"),
        lines(
          "<< @label=l1 :iirc!u@h PRIVMSG #iirc :hello",
          "?? confirmed i1 :hello",
          "<< @label=l2 :iirc!u@h PRIVMSG #iirc :again",
          "?? confirmed i2 :again"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("begins labelling once both are new", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel("cap-notify"),
        lines(
          "<< :irc.test CAP iirc NEW :echo-message labeled-response batch",
          ">> CAP REQ :batch echo-message labeled-response",
          "<< :irc.test CAP iirc ACK :batch echo-message labeled-response"
        ),
        say(1),
        lines("<< @label=l1 :iirc!u@h PRIVMSG #iirc :hello", "?? confirmed i1 :hello"),
      ],
    });

    expect.assertions(0);
  });
});

describe("part of the three acknowledged", () => {
  const asked = lines(
    "!! configure",
    "-> dial irc.test:6697 tls",
    "== opened",
    ">> CAP LS 302",
    ">> NICK iirc",
    ">> USER iirc 0 * iirc",
    "<< :irc.test CAP * LS :echo-message labeled-response batch",
    ">> CAP REQ :batch echo-message labeled-response"
  );

  it("gives up echo-message alone before CAP END", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        asked,
        lines(
          "<< :irc.test CAP * ACK :batch echo-message",
          ">> CAP REQ -echo-message",
          "<< :irc.test CAP * ACK :-echo-message",
          ">> CAP END"
        ),
      ],
    });

    expect(client.inspect(played.state).caps.enabled).toStrictEqual(new Set(["batch"]));
  });

  it("gives up labeled-response alone before CAP END", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        asked,
        lines(
          "<< :irc.test CAP * ACK :batch labeled-response",
          ">> CAP REQ -labeled-response",
          "<< :irc.test CAP * ACK :-labeled-response",
          ">> CAP END"
        ),
      ],
    });

    expect(client.inspect(played.state).caps.enabled).toStrictEqual(new Set(["batch"]));
  });

  it("gives up the pair, one after the other, when batch is not acknowledged", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        asked,
        lines(
          "<< :irc.test CAP * ACK :echo-message labeled-response",
          ">> CAP REQ -echo-message",
          "<< :irc.test CAP * ACK :-echo-message",
          ">> CAP REQ -labeled-response",
          "<< :irc.test CAP * ACK :-labeled-response",
          ">> CAP END"
        ),
      ],
    });

    expect(client.inspect(played.state).caps.enabled).toStrictEqual(new Set());
  });

  it("gives one up the same way when CAP NEW offered both and one was acknowledged", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel("cap-notify", "batch"),
        lines(
          "<< :irc.test CAP iirc NEW :echo-message labeled-response",
          ">> CAP REQ :echo-message labeled-response",
          "<< :irc.test CAP iirc ACK :labeled-response",
          ">> CAP REQ -labeled-response"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("labels need batch", () => {
  it("asks for neither of the pair when batch is not offered", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["echo-message", "labeled-response"], requested: [] }),
        lines("!! say #iirc :hello", ">> PRIVMSG #iirc hello"),
      ],
    });

    expect.assertions(0);
  });

  it("asks for neither of the pair when the Owner declined batch", () => {
    const declined = configured({ declined: [FeatureName.make("batch")] });

    play(client, {
      configuration: declined,
      transcript: [
        registered(declined, { offered: both, requested: [] }),
        lines("!! say #iirc :hello", ">> PRIVMSG #iirc hello"),
      ],
    });

    expect.assertions(0);
  });

  it("gives up the pair when batch is deleted, and ignores echoes until echo-message is gone", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        ...inChannel("cap-notify", ...both),
        say(1),
        lines(
          "<< :irc.test CAP iirc DEL :batch",
          ">> CAP REQ -echo-message",
          "<< :iirc!u@h PRIVMSG #iirc :hello",
          "?? ignored UnmatchedEcho",
          "!! say #iirc :again",
          ">> PRIVMSG #iirc again",
          "?? message Privmsg iirc #iirc at=ours:t+0s ours=i2 :again",
          "<< :irc.test CAP iirc ACK :-echo-message",
          ">> CAP REQ -labeled-response",
          "<< :irc.test CAP iirc ACK :-labeled-response"
        ),
      ],
    });

    expect(client.inspect(played.state).caps.enabled).toStrictEqual(new Set(["cap-notify"]));
  });
});
