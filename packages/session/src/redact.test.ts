import { assert, describe, it } from "@effect/vitest";
import { Redacted } from "effect";
import type { Array as Arr } from "effect";

import {
  connectCommandLine,
  credentialReferences,
  identifyLine,
  joinSensitive,
  keyedJoins,
  missingCredentials,
  passLine,
} from "./credentials.ts";
import type { Built } from "./credentials.ts";
import { describeDefect } from "./diagnostic.ts";
import type { NewEntry } from "./entry.ts";
import { scrub } from "./redact.ts";
import type { Secrets } from "./redact.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const secrets: Secrets = new Map([
  ["pass", Redacted.make("hunter2")],
  ["key.pizza", Redacted.make("pizza")],
  ["long", Redacted.make("hunter2 extra")],
  ["empty", Redacted.make("")],
]);

const inbound = (text: string): Extract<NewEntry, { readonly _tag: "Line" }> => ({
  _tag: "Line",
  bytes: encoder.encode(text),
  connection: 1,
  direction: "inbound",
  network: "libera",
});

const scrubbedText = (text: string) => {
  const [entry] = scrub(secrets, [inbound(text)]);

  return entry._tag === "Line"
    ? { redacted: entry.redacted, text: decoder.decode(entry.bytes) }
    : undefined;
};

describe("LOG-6: value scrubbing", () => {
  it("replaces a value found as a whole word, and names its Credential", () => {
    assert.deepStrictEqual(scrubbedText(":bob!u@h PRIVMSG #iirc :my password is hunter2"), {
      redacted: ["pass"],
      text: ":bob!u@h PRIVMSG #iirc :my password is <redacted>",
    });
  });

  it("takes `:` and `,` as the edge of a word, as well as a space and either end", () => {
    assert.deepStrictEqual(scrubbedText("hunter2:pizza,hunter2"), {
      redacted: ["pass", "key.pizza", "pass"],
      text: "<redacted>:<redacted>,<redacted>",
    });
  });

  it("leaves a value alone inside another word, so a Channel key cannot mangle chat", () => {
    const text = ":bob!u@h PRIVMSG #iirc :pizzas and xpizza and pizza. hunter2s";

    assert.deepStrictEqual(scrubbedText(text), { redacted: undefined, text });
  });

  it("takes the longer of two values that overlap, whole", () => {
    assert.deepStrictEqual(scrubbedText("PRIVMSG x :hunter2 extra"), {
      redacted: ["long"],
      text: "PRIVMSG x :<redacted>",
    });
  });

  it("never matches an empty value", () => {
    assert.deepStrictEqual(scrubbedText("a b"), { redacted: undefined, text: "a b" });
  });

  it("scrubs a Dropped Entry, and adds to the names a Line built from Credentials gave", () => {
    const [entry] = scrub(secrets, [
      {
        _tag: "Dropped",
        bytes: encoder.encode("PRIVMSG #iirc :pizza <redacted>"),
        cause: "key:phone",
        connection: 1,
        network: "libera",
        reason: "the Connection closed",
        redacted: ["pass"],
      },
    ]);

    assert.deepInclude(entry, { redacted: ["key.pizza", "pass"] });
    assert.strictEqual(
      entry._tag === "Dropped" ? decoder.decode(entry.bytes) : "",
      "PRIVMSG #iirc :<redacted> <redacted>"
    );
  });

  it("names Credentials in the order their placeholders stand, so the nth is the nth name", () => {
    assert.deepStrictEqual(scrubbedText(":op!u@h MODE #one +ok pizza hunter2"), {
      redacted: ["key.pizza", "pass"],
      text: ":op!u@h MODE #one +ok <redacted> <redacted>",
    });
    assert.deepStrictEqual(scrubbedText(":op!u@h MODE #one +ok hunter2 pizza"), {
      redacted: ["pass", "key.pizza"],
      text: ":op!u@h MODE #one +ok <redacted> <redacted>",
    });
  });

  it("works on bytes, so a value inside text that is not UTF-8 is still found", () => {
    const bytes = Uint8Array.of(0xff, 0x20, ...encoder.encode("hunter2"), 0x20, 0xfe);
    const [entry] = scrub(secrets, [{ ...inbound(""), bytes }]);

    assert.deepStrictEqual(entry._tag === "Line" ? [...entry.bytes] : [], [
      0xff,
      0x20,
      ...encoder.encode("<redacted>"),
      0x20,
      0xfe,
    ]);
  });

  it("passes every other Entry through as it is, with or without secrets", () => {
    const entries: Arr.NonEmptyReadonlyArray<NewEntry> = [
      { _tag: "Deadline", name: "hunter2", network: "libera" },
    ];

    assert.deepStrictEqual(scrub(secrets, entries), entries);
    assert.deepStrictEqual(scrub(new Map(), entries), entries);
  });

  it("scrubs the reason a close or a Dropped Entry gives, which can quote a defect", () => {
    const ircd = { host: "irc.example", port: 6697, tls: true };
    const reason = "the host failed: Error: bad password hunter2";

    const entries: Arr.NonEmptyReadonlyArray<NewEntry> = [
      {
        _tag: "Connection",
        chosen: false,
        connection: 1,
        ircd,
        network: "libera",
        phase: "closing",
        reason,
      },
      { _tag: "Connection", connection: 1, ircd, network: "libera", phase: "closed", reason },
      {
        _tag: "Dropped",
        bytes: encoder.encode("PRIVMSG #a :hi"),
        cause: "api",
        connection: 1,
        network: "libera",
        reason,
      },
    ];

    assert.deepStrictEqual(
      scrub(secrets, entries).map((entry) => ("reason" in entry ? entry.reason : undefined)),
      Array.from({ length: 3 }, () => "the host failed: Error: bad password <redacted>")
    );
  });

  it("bounds a reason only after scrubbing it, so no cut leaves part of a value", () => {
    const ircd = { host: "irc.example", port: 6697, tls: true };
    const value = "s".repeat(400);
    const held: Secrets = new Map([["long", Redacted.make(value)]]);
    const reason = `the host failed: ${describeDefect(new Error(`bad ${value} and ${"x ".repeat(600)}`))}`;

    const [entry] = scrub(held, [
      {
        _tag: "Connection",
        chosen: false,
        connection: 1,
        ircd,
        network: "libera",
        phase: "closing",
        reason,
      },
    ]);

    const recordedReason = "reason" in entry ? entry.reason : "";

    assert.isAtMost(recordedReason.length, 1024);
    assert.notInclude(recordedReason, "s".repeat(8));
  });

  it("bounds reasons when there are no Credentials too", () => {
    const [entry] = scrub(new Map(), [
      {
        _tag: "Dropped",
        bytes: encoder.encode("PRIVMSG #a :hi"),
        cause: "api",
        connection: 1,
        network: "libera",
        reason: "y".repeat(5000),
      },
    ]);

    assert.strictEqual("reason" in entry ? entry.reason.length : 0, 1024);
  });
});

const recorded = (built: Built) =>
  built._tag === "Safe"
    ? {
        names: built.sensitive?.names,
        recorded: decoder.decode(built.sensitive?.bytes ?? built.line.toBytes()),
        sent: decoder.decode(built.line.toBytes()),
      }
    : {
        names: built.recorded.names,
        reason: built.reason,
        recorded: decoder.decode(built.recorded.bytes),
      };

describe("LOG-6: Lines built from Credentials are sensitive where they are built", () => {
  it("CONN-2: `PASS` is recorded with its password `<redacted>`", () => {
    assert.deepStrictEqual(recorded(passLine("pass", secrets)), {
      names: ["pass"],
      recorded: "PASS <redacted>",
      sent: "PASS hunter2",
    });
  });

  it("CONN-6: `IDENTIFY` names the account if there is one", () => {
    assert.deepStrictEqual(
      recorded(identifyLine({ account: "iirc", nick: "NickServ", password: "pass" }, secrets)),
      {
        names: ["pass"],
        recorded: "PRIVMSG NickServ :IDENTIFY iirc <redacted>",
        sent: "PRIVMSG NickServ :IDENTIFY iirc hunter2",
      }
    );
  });

  it("CONN-6: a connect command puts each Credential in where it is named", () => {
    assert.deepStrictEqual(recorded(connectCommandLine("OPER iirc {{pass}}", secrets)), {
      names: ["pass"],
      recorded: "OPER iirc <redacted>",
      sent: "OPER iirc hunter2",
    });
  });

  it("CONN-6: a connect command names a Credential once for each place it is put in", () => {
    assert.deepStrictEqual(
      recorded(connectCommandLine("OPER {{pass}} {{pass}} {{key.pizza}}", secrets)),
      {
        names: ["pass", "pass", "key.pizza"],
        recorded: "OPER <redacted> <redacted> <redacted>",
        sent: "OPER hunter2 hunter2 pizza",
      }
    );
  });

  it("CONN-6: a connect command with no Credential in it is not sensitive", () => {
    assert.deepStrictEqual(recorded(connectCommandLine("mode iirc +x", secrets)), {
      names: undefined,
      recorded: "MODE iirc +x",
      sent: "MODE iirc +x",
    });
  });

  it("CONN-6: a value that would add a parameter is refused, and recorded `<redacted>`", () => {
    assert.deepStrictEqual(recorded(connectCommandLine("OPER {{long}} x", secrets)), {
      names: ["long"],
      reason: "InvalidParameter",
      recorded: "OPER <redacted> x",
    });
  });

  it("CONN-6: a missing Credential is refused by name, and nothing of the Line is lost", () => {
    assert.deepStrictEqual(recorded(connectCommandLine("PRIVMSG x :{{gone}}", secrets)), {
      names: ["gone"],
      reason: "the Credential gone is not set",
      recorded: "PRIVMSG x <redacted>",
    });
  });

  it("CRED-4: a `JOIN` with keys records each key `<redacted>`, keyed Channels first", () => {
    const [batch] = keyedJoins(
      [{ name: "#plain" }, { key: "key.pizza", name: "#food" }, { key: "gone", name: "#lost" }],
      secrets
    ).batches;

    assert.isDefined(batch);
    assert.strictEqual(decoder.decode(batch.line.toBytes()), "JOIN #food,#plain,#lost pizza");

    const sensitive = joinSensitive(batch);

    assert.deepStrictEqual(sensitive?.names, ["key.pizza"]);
    assert.strictEqual(decoder.decode(sensitive?.bytes), "JOIN #food,#plain,#lost <redacted>");
  });

  it("CRED-4: a `JOIN` of Channels that share a key names it once for each `<redacted>`", () => {
    const [batch] = keyedJoins(
      [
        { key: "key.pizza", name: "#food" },
        { key: "key.pizza", name: "#pies" },
      ],
      secrets
    ).batches;

    assert.isDefined(batch);
    assert.strictEqual(decoder.decode(batch.line.toBytes()), "JOIN #food,#pies pizza,pizza");

    const sensitive = joinSensitive(batch);

    assert.deepStrictEqual(sensitive?.names, ["key.pizza", "key.pizza"]);
    assert.strictEqual(decoder.decode(sensitive?.bytes), "JOIN #food,#pies <redacted>,<redacted>");
  });

  it("CRED-4: a `JOIN` with no key is not sensitive", () => {
    const [batch] = keyedJoins([{ name: "#plain" }], secrets).batches;

    assert.isUndefined(batch === undefined ? "none" : joinSensitive(batch));
  });
});

describe("CRED-1: Credentials that settings refer to", () => {
  it("finds each name a connect command refers to, once", () => {
    assert.deepStrictEqual(credentialReferences("A {{x}} {{y}} {{x}} {y}"), ["x", "y"]);
  });

  it("lists what is not set, in the order named, but never a Channel key", () => {
    assert.deepStrictEqual(
      missingCredentials({
        connectCommands: ["OPER me {{oper}}", "PRIVMSG x :{{pass}}"],
        credentials: {
          clientCertificate: "cert",
          password: "pass",
          service: { nick: "NickServ", password: "nickserv" },
        },
        secrets,
      }),
      ["nickserv", "cert", "oper"]
    );
  });
});
