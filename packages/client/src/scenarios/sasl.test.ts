/**
 * `sasl` with `PLAIN`: logging in before registration ends, and what a failed login
 * means, as the Configuration says.
 */
import { CredentialName } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { FeatureName } from "../ids.ts";
import { configured, play, registered } from "../testing/index.ts";

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const login = (required: boolean) =>
  configured({
    login: { _tag: "Sasl", account: "iirc", credential: CredentialName.make("pw"), required },
  });

const optional = login(false);
const required = login(true);

const opened = lines(
  "!! configure",
  "-> dial irc.test:6697 tls",
  "== opened",
  ">> CAP LS 302",
  ">> NICK iirc",
  ">> USER iirc 0 * iirc"
);

// Up to `AUTHENTICATE PLAIN`, with the Ircd offering `sasl` with this value.
const asked = (value = "=PLAIN,EXTERNAL") =>
  opened +
  lines(
    `<< :irc.test CAP * LS :sasl${value}`,
    ">> CAP REQ sasl",
    "<< :irc.test CAP * ACK :sasl",
    ">> AUTHENTICATE PLAIN"
  );

const sent =
  asked() +
  lines("<< AUTHENTICATE +", ">> {AuthenticatePlain credential=pw authcid=iirc authzid=iirc}");

const welcome = lines("<< :irc.test 001 iirc :Welcome", "?? session-began iirc");

// A failed login: go on when it is optional, give up when it is required.
const goesOn = lines(">> CAP END") + welcome;

const givesUp = lines(
  ">> QUIT",
  "-> hangup",
  "== closed HungUp",
  "?? connection-failed LoginFailed"
);

describe("logging in", () => {
  it("logs in with PLAIN before CAP END, and knows Self's account", () => {
    const played = play(client, {
      configuration: optional,
      transcript: registered(optional, { offered: ["sasl=PLAIN,EXTERNAL"] }),
    });

    expect(client.known(played.state).self?.account).toMatchObject({
      _tag: "Known",
      value: "iirc",
    });
  });

  it("tries PLAIN when the cap lists no mechanisms, as SASL 3.1 does", () => {
    play(client, {
      configuration: optional,
      transcript: [
        asked(""),
        lines(
          "<< :irc.test AUTHENTICATE +",
          ">> {AuthenticatePlain credential=pw authcid=iirc authzid=iirc}"
        ),
        lines("<< :irc.test 903 iirc :SASL authentication successful"),
        goesOn,
      ],
    });

    expect.assertions(0);
  });

  it("reads the mechanisms in any case and order", () => {
    play(client, { configuration: optional, transcript: asked("=EXTERNAL,plain,SCRAM-SHA-256") });

    expect.assertions(0);
  });

  it("holds registration while the exchange runs, whatever else the Ircd says", () => {
    const played = play(client, {
      configuration: optional,
      transcript: [
        asked(),
        lines(
          "<< NOTICE * :*** Checking Ident",
          "?? message Notice irc.test * :*** Checking Ident",
          "+5s",
          "<< AUTHENTICATE +",
          ">> {AuthenticatePlain credential=pw authcid=iirc authzid=iirc}",
          "+5s"
        ),
      ],
    });

    expect(client.inspect(played.state).states.caps).toBe("Holding");
  });

  it("asks for sasl with no login, and logs in to nothing", () => {
    play(client, {
      configuration: configured(),
      transcript: lines(
        opened.trimEnd(),
        "<< :irc.test CAP * LS :sasl=PLAIN",
        ">> CAP REQ sasl",
        "<< :irc.test CAP * ACK :sasl",
        ">> CAP END"
      ),
    });

    expect.assertions(0);
  });

  it("reads 900 and 901 for Self's account, with no sasl at all", () => {
    const played = play(client, {
      configuration: optional,
      transcript: [
        registered(optional),
        lines("<< :irc.test 900 iirc iirc!u@h acct :You are now logged in as acct"),
      ],
    });

    expect(client.known(played.state).self?.account).toMatchObject({ value: "acct" });

    const out = play(client, {
      configuration: optional,
      transcript: [
        registered(optional),
        lines("<< :irc.test 901 iirc iirc!u@h :You are now logged out"),
      ],
    });

    expect(client.known(out.state).self?.account).toMatchObject({ _tag: "Known", value: null });
  });

  it("knows no account without sasl", () => {
    const played = play(client, { configuration: optional, transcript: registered(optional) });

    expect(client.known(played.state).self?.account).toStrictEqual({ _tag: "Unknown" });
  });
});

describe("a login that cannot happen", () => {
  it("does not try when the Ircd lists mechanisms without PLAIN", () => {
    play(client, {
      configuration: optional,
      transcript: lines(
        opened.trimEnd(),
        "<< :irc.test CAP * LS :sasl=EXTERNAL,SCRAM-SHA-256",
        ">> CAP REQ sasl",
        "<< :irc.test CAP * ACK :sasl",
        ">> CAP END"
      ),
    });
    play(client, {
      configuration: required,
      transcript: [
        lines(
          opened.trimEnd(),
          "<< :irc.test CAP * LS :sasl=EXTERNAL",
          ">> CAP REQ sasl",
          "<< :irc.test CAP * ACK :sasl"
        ),
        givesUp,
      ],
    });

    expect.assertions(0);
  });

  it.each(["902", "904", "905", "906", "907", "908"])(
    "goes on after %s when the login is optional, and gives up when it is required",
    (numeric) => {
      const failure = `<< :irc.test ${numeric} * :failed\n`;

      play(client, { configuration: optional, transcript: [sent, failure, goesOn] });
      play(client, { configuration: required, transcript: [sent, failure, givesUp] });
      // Before the Credential was even asked for.
      play(client, { configuration: optional, transcript: [asked(), failure, goesOn] });
      play(client, { configuration: required, transcript: [asked(), failure, givesUp] });

      expect.assertions(0);
    }
  );

  it("reads 908 and the 904 after it as one failure", () => {
    play(client, {
      configuration: optional,
      transcript: [
        sent,
        lines("<< :irc.test 908 iirc EXTERNAL :are available SASL mechanisms", ">> CAP END"),
        lines("<< :irc.test 904 iirc :SASL authentication failed"),
        welcome,
      ],
    });

    expect.assertions(0);
  });

  it("aborts with AUTHENTICATE * on a challenge PLAIN does not make", () => {
    play(client, {
      configuration: optional,
      transcript: [asked(), lines("<< AUTHENTICATE Zm9vYmFy", ">> AUTHENTICATE *"), goesOn],
    });
    play(client, {
      configuration: required,
      transcript: [asked(), lines("<< AUTHENTICATE Zm9vYmFy", ">> AUTHENTICATE *"), givesUp],
    });

    expect.assertions(0);
  });

  it("aborts when the Credential cannot be filled, and counts it a failed login", () => {
    for (const reason of ["Missing", "Unavailable", "Unsendable"]) {
      play(client, {
        configuration: optional,
        transcript: [
          sent,
          lines(`== unfilled ${reason}`, ">> AUTHENTICATE *"),
          goesOn,
          // The Ircd's 906 for the abort comes late, and changes nothing.
        ],
      });
      play(client, {
        configuration: required,
        transcript: [sent, lines(`== unfilled ${reason}`, ">> AUTHENTICATE *"), givesUp],
      });
    }

    const late = play(client, {
      configuration: optional,
      transcript: [
        sent,
        lines(
          "== unfilled Missing",
          ">> AUTHENTICATE *",
          ">> CAP END",
          "<< :irc.test 906 * :aborted"
        ),
      ],
    });

    expect(late.steps.at(-1)).toMatchObject({ news: [], outputs: [] });
  });

  it("aborts when the hold's deadline passes", () => {
    play(client, {
      configuration: optional,
      transcript: [sent, lines("+30s", ">> AUTHENTICATE *"), goesOn],
    });
    play(client, {
      configuration: required,
      transcript: [asked(), lines("+30s", ">> AUTHENTICATE *"), givesUp],
    });

    expect.assertions(0);
  });
});

describe("an Ircd that does not keep to the exchange", () => {
  it("goes on at 903 without our +, and sends no Credential after it", () => {
    const played = play(client, {
      configuration: required,
      transcript: [
        asked(),
        lines("<< :irc.test 903 iirc :SASL authentication successful", ">> CAP END"),
        lines("<< AUTHENTICATE +"),
        welcome,
      ],
    });

    expect(
      played.steps.flatMap((step) => step.outputs).filter((each) => each._tag === "SendSecret")
    ).toStrictEqual([]);
  });

  it("sends no Credential for a + it did not ask for", () => {
    const played = play(client, {
      configuration: optional,
      transcript: [registered(optional, { offered: ["sasl=PLAIN"] }), lines("<< AUTHENTICATE +")],
    });

    expect(played.steps.at(-1)).toMatchObject({ news: [], outputs: [] });
  });

  it("does not log in again when sasl is new after registration", () => {
    const played = play(client, {
      configuration: optional,
      transcript: [
        registered(optional, { offered: ["cap-notify"] }),
        lines(
          "<< :irc.test CAP iirc NEW :sasl=PLAIN",
          ">> CAP REQ sasl",
          "<< :irc.test CAP iirc ACK :sasl"
        ),
      ],
    });

    expect(client.inspect(played.state).features).toContain("sasl");
    expect(played.steps.at(-1)?.outputs.filter((each) => each._tag === "Send")).toStrictEqual([]);
  });

  it("lets registration go when sasl is deleted mid-exchange and the login is optional", () => {
    play(client, {
      configuration: optional,
      transcript: [sent, lines("<< :irc.test CAP * DEL :sasl"), goesOn],
    });

    expect.assertions(0);
  });

  it("takes a new cap offered mid-exchange, and ends negotiation once both are done", () => {
    const played = play(client, {
      configuration: optional,
      transcript: [
        sent,
        lines(
          "<< :irc.test CAP * NEW :multi-prefix",
          ">> CAP REQ multi-prefix",
          "<< :irc.test 903 iirc :SASL authentication successful",
          "<< :irc.test CAP * ACK :multi-prefix",
          ">> CAP END"
        ),
        welcome,
      ],
    });

    expect(client.inspect(played.state).features).toStrictEqual(["sasl", "multi-prefix"]);
  });
});

describe("a required login never goes unmet", () => {
  const welcomeOnly = lines("<< :irc.test 001 iirc :Welcome");

  it("gives up when the Ircd answers CAP with 421", () => {
    play(client, {
      configuration: required,
      transcript: [opened, lines("<< :irc.test 421 * CAP :Unknown command"), givesUp],
    });

    expect.assertions(0);
  });

  it("gives up, and takes up no Session, when the Ircd goes straight to 001", () => {
    const played = play(client, {
      configuration: required,
      transcript: [opened, welcomeOnly, givesUp],
    });

    expect(played.transcript).not.toContain("session-began");
  });

  it("gives up when sasl is not offered, before CAP END", () => {
    play(client, {
      configuration: required,
      transcript: [
        opened,
        lines(
          "<< :irc.test CAP * LS :multi-prefix",
          ">> CAP REQ multi-prefix",
          "<< :irc.test CAP * ACK :multi-prefix"
        ),
        givesUp,
      ],
    });
    play(client, {
      configuration: required,
      transcript: [opened, lines("<< :irc.test CAP * LS :chghost"), givesUp],
    });

    expect.assertions(0);
  });

  it("gives up when sasl is refused", () => {
    play(client, {
      configuration: required,
      transcript: [
        opened,
        lines(
          "<< :irc.test CAP * LS :sasl=PLAIN",
          ">> CAP REQ sasl",
          "<< :irc.test CAP * NAK :sasl"
        ),
        givesUp,
      ],
    });

    expect.assertions(0);
  });

  it("gives up when the Owner declined sasl", () => {
    const declined = configured({
      declined: [FeatureName.make("sasl")],
      login: {
        _tag: "Sasl",
        account: "iirc",
        credential: CredentialName.make("pw"),
        required: true,
      },
    });

    play(client, {
      configuration: declined,
      transcript: [opened, lines("<< :irc.test CAP * LS :sasl=PLAIN"), givesUp],
    });

    expect.assertions(0);
  });

  it("gives up when sasl is deleted before 903", () => {
    play(client, {
      configuration: required,
      transcript: [sent, lines("<< :irc.test CAP * DEL :sasl"), givesUp],
    });
    play(client, {
      configuration: required,
      transcript: [asked(), lines("<< :irc.test CAP * DEL :sasl"), givesUp],
    });

    expect.assertions(0);
  });

  it("gives up when 001 comes before 903, and takes up no Session", () => {
    const played = play(client, {
      configuration: required,
      transcript: [sent, welcomeOnly, lines(">> AUTHENTICATE *"), givesUp],
    });

    expect(played.transcript).not.toContain("session-began");
  });

  it("goes on with an optional login in each of those cases", () => {
    play(client, {
      configuration: optional,
      transcript: [opened, lines("<< :irc.test 421 * CAP :Unknown command"), welcome],
    });
    play(client, {
      configuration: optional,
      transcript: [opened, lines("<< :irc.test CAP * LS :chghost", ">> CAP END")],
    });
    play(client, {
      configuration: optional,
      transcript: [sent, lines("<< :irc.test CAP * DEL :sasl"), goesOn],
    });

    expect.assertions(0);
  });

  it("changes nothing when sasl is deleted after 903: the account stays known", () => {
    for (const configuration of [optional, required]) {
      const played = play(client, {
        configuration,
        transcript: [
          registered(configuration, { offered: ["cap-notify", "sasl=PLAIN"] }),
          lines("+1s", "<< :irc.test CAP iirc DEL :sasl"),
        ],
      });

      expect(played.steps.at(-1)).toMatchObject({ news: [], outputs: [] });
      expect(client.known(played.state).self?.account).toMatchObject({
        _tag: "Known",
        value: "iirc",
      });
    }
  });
});
