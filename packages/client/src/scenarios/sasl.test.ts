/**
 * `sasl` with `PLAIN` and `EXTERNAL`: logging in before registration ends, and what a failed login
 * means, as the Configuration says.
 */
import { CredentialName } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import type { IrcdAddress } from "../configuration.ts";
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

// Every Session the Client said began.
const began = (played: ReturnType<typeof play>) =>
  played.steps.flatMap((step) => step.news.filter((news) => news._tag === "SessionBegan"));

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
          "?? message Notice irc.test * in=network :*** Checking Ident",
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

  it("knows no account without sasl", () => {
    const played = play(client, { configuration: optional, transcript: registered(optional) });

    expect(client.known(played.state).self?.account).toStrictEqual({ _tag: "Unknown" });
  });
});

// The Credential each Dial names, in order, or none for a Dial that names none.
const certificates = (played: ReturnType<typeof play>) =>
  played.steps.flatMap((step) =>
    step.outputs.flatMap((output) => (output._tag === "Dial" ? [output.certificate] : []))
  );

describe("presenting a client certificate", () => {
  const cert = CredentialName.make("cert");

  const certified = (...ircds: readonly [IrcdAddress, ...IrcdAddress[]]) =>
    configured({ ircds, tls: { _tag: "Certificate", certificate: cert } });

  it("names it on a Dial over TLS, and on none in plaintext", () => {
    const tls = { host: "irc.test", port: 6697, tls: true };
    const plain = { host: "irc.test", port: 6667, tls: false };

    const played = play(client, {
      configuration: certified(plain, tls),
      transcript: [
        lines("!! configure", "-> dial irc.test:6667", "== opened"),
        lines(">> CAP LS 302", ">> NICK iirc", ">> USER iirc 0 * iirc"),
        lines("== closed Reset", "?? connection-failed Closed Reset", "+2s"),
        lines("-> dial irc.test:6697 tls"),
      ],
    });

    expect(certificates(played)).toStrictEqual([undefined, cert]);
  });

  it("names it on the TLS Dial an STS policy upgrades a plaintext Ircd to", () => {
    const played = play(client, {
      configuration: certified({ host: "irc.test", port: 6667, tls: false }),
      transcript: [
        lines("!! configure", "-> dial irc.test:6667", "== opened"),
        lines(">> CAP LS 302", ">> NICK iirc", ">> USER iirc 0 * iirc"),
        lines("<< :irc.test CAP * LS :sts=port=6697", "-> hangup", "== closed HungUp"),
        lines("-> dial irc.test:6697 tls"),
      ],
    });

    expect(certificates(played)).toStrictEqual([undefined, cert]);
  });

  it("names none without a certificate in the Configuration", () => {
    const played = play(client, {
      configuration: optional,
      transcript: lines("!! configure", "-> dial irc.test:6697 tls"),
    });

    expect(certificates(played)).toStrictEqual([undefined]);
  });
});

const external = (required: boolean) =>
  configured({
    login: { _tag: "External", required },
    tls: { _tag: "Certificate", certificate: CredentialName.make("cert") },
  });

describe("logging in with EXTERNAL", () => {
  // Up to `AUTHENTICATE EXTERNAL`, with the Ircd offering `sasl` with this value.
  const askedExternal = (value: string) =>
    opened +
    lines(
      `<< :irc.test CAP * LS :sasl${value}`,
      ">> CAP REQ sasl",
      "<< :irc.test CAP * ACK :sasl",
      ">> AUTHENTICATE EXTERNAL"
    );

  const answered =
    askedExternal("=PLAIN,EXTERNAL") + lines("<< AUTHENTICATE +", ">> AUTHENTICATE +");

  // The mechanism is offered when the cap lists it in any case, or lists nothing.
  it.each(["=EXTERNAL", "=PLAIN,external", ""])(
    "logs in before CAP END, with the Ircd listing %j",
    (value) => {
      play(client, {
        configuration: external(true),
        transcript: [
          askedExternal(value),
          lines(
            "<< AUTHENTICATE +",
            ">> AUTHENTICATE +",
            "<< :irc.test 903 iirc :SASL authentication successful"
          ),
          goesOn,
        ],
      });

      expect.assertions(0);
    }
  );

  it("does not try when the Ircd lists mechanisms without EXTERNAL, and a required login gives up", () => {
    const listing = lines(
      opened.trimEnd(),
      "<< :irc.test CAP * LS :sasl=PLAIN,SCRAM-SHA-256",
      ">> CAP REQ sasl",
      "<< :irc.test CAP * ACK :sasl"
    );

    play(client, { configuration: external(false), transcript: [listing, goesOn] });
    play(client, { configuration: external(true), transcript: [listing, givesUp] });

    expect.assertions(0);
  });

  // Each row is a failure the Ircd answers the exchange with, as PLAIN's are.
  it.each(["902", "904", "905", "906", "907"])("fails the login on %s", (numeric) => {
    play(client, {
      configuration: external(false),
      transcript: [answered, lines(`<< :irc.test ${numeric} * :failed`), goesOn],
    });
    play(client, {
      configuration: external(true),
      transcript: [answered, lines(`<< :irc.test ${numeric} * :failed`), givesUp],
    });

    expect.assertions(0);
  });

  it("gives up when 001 comes before 903, and takes up no Session", () => {
    const played = play(client, {
      configuration: external(true),
      transcript: [answered, lines("<< :irc.test 001 iirc :Welcome", ">> AUTHENTICATE *"), givesUp],
    });

    expect(began(played)).toStrictEqual([]);
  });

  it("aborts, rather than answer with a password, when the login turns to PLAIN after EXTERNAL was asked for", () => {
    play(client, {
      configuration: external(true),
      transcript: [
        askedExternal("=PLAIN,EXTERNAL"),
        lines("!! configure login=required,iirc,pw", "<< AUTHENTICATE +", ">> AUTHENTICATE *"),
        givesUp,
      ],
    });

    expect.assertions(0);
  });

  it("aborts with AUTHENTICATE * on a challenge that is not +", () => {
    play(client, {
      configuration: external(true),
      transcript: [
        askedExternal("=EXTERNAL"),
        lines("<< AUTHENTICATE Zm9vYmFy", ">> AUTHENTICATE *"),
        givesUp,
      ],
    });

    expect.assertions(0);
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

  // Before the Credential is asked for. Each ends the login as 908 does after it is sent.
  it.each(["902", "904", "905", "906", "907"])("fails the login on %s", (numeric) => {
    play(client, {
      configuration: optional,
      transcript: [asked(), `<< :irc.test ${numeric} * :failed\n`, goesOn],
    });

    expect.assertions(0);
  });

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
    play(client, {
      configuration: required,
      transcript: [sent, lines("== unfilled Missing", ">> AUTHENTICATE *"), givesUp],
    });

    // The Ircd's 906 for the abort comes late, and changes nothing.
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

    // Its numeric is shown as it came, and nothing else comes of it.
    expect(late.steps.at(-1)).toMatchObject({
      news: [{ _tag: "Activity", activity: { _tag: "Numeric", numeric: "906" } }],
    });
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
    play(client, {
      configuration: required,
      transcript: [
        asked(),
        lines("<< :irc.test 903 iirc :SASL authentication successful", ">> CAP END"),
        lines("<< AUTHENTICATE +"),
        welcome,
      ],
    });

    expect.assertions(0);
  });

  it("sends no Credential for a + it did not ask for", () => {
    const played = play(client, {
      configuration: optional,
      transcript: [registered(optional, { offered: ["sasl=PLAIN"] }), lines("<< AUTHENTICATE +")],
    });

    expect(played.steps.at(-1)).toMatchObject({ news: [] });
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

    expect(began(played)).toStrictEqual([]);
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
      transcript: [opened, lines("<< :irc.test CAP * LS :no-implicit-names"), givesUp],
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

    expect(began(played)).toStrictEqual([]);
  });

  it("goes on with an optional login in each of those cases", () => {
    play(client, {
      configuration: optional,
      transcript: [opened, lines("<< :irc.test 421 * CAP :Unknown command"), welcome],
    });
    play(client, {
      configuration: optional,
      transcript: [opened, lines("<< :irc.test CAP * LS :no-implicit-names", ">> CAP END")],
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

      expect(played.steps.at(-1)).toMatchObject({ news: [] });
      expect(client.known(played.state).self?.account).toMatchObject({
        _tag: "Known",
        value: "iirc",
      });
    }
  });
});

describe("PLAIN withdrawn mid-exchange", () => {
  const withdrawn = lines(
    "<< :irc.test CAP * NEW :sasl=EXTERNAL",
    "<< AUTHENTICATE +",
    ">> AUTHENTICATE *"
  );

  it("sends no Credential once the sasl value no longer lists PLAIN, and fails the login", () => {
    play(client, { configuration: optional, transcript: [asked(), withdrawn, goesOn] });
    play(client, { configuration: required, transcript: [asked(), withdrawn, givesUp] });

    expect.assertions(0);
  });

  it("sends the Credential when the value still lists PLAIN", () => {
    play(client, {
      configuration: optional,
      transcript: [
        asked(),
        lines(
          "<< :irc.test CAP * NEW :sasl=EXTERNAL,PLAIN",
          "<< AUTHENTICATE +",
          ">> {AuthenticatePlain credential=pw authcid=iirc authzid=iirc}"
        ),
      ],
    });

    expect.assertions(0);
  });
});
