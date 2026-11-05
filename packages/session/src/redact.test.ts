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
import { boundReasons } from "./redact.ts";
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

describe("LOG-6: the Log holds what was said, and searches it for no Credential", () => {
  it("records a Line that holds a word some Credential is, as it arrived", () => {
    const entries: Arr.NonEmptyReadonlyArray<NewEntry> = [
      inbound(":op!u@h MODE #iirc +k pizza"),
      inbound(":bob!u@h PRIVMSG #iirc :I like pizza today"),
    ];

    assert.deepStrictEqual(boundReasons(entries), entries);
  });

  it("names nothing for a `<redacted>` that a User sent", () => {
    const entries: Arr.NonEmptyReadonlyArray<NewEntry> = [
      inbound(":bob!u@h PRIVMSG #iirc :violets are <redacted>"),
    ];

    const [entry] = boundReasons(entries);

    assert.strictEqual(entry._tag === "Line" ? entry.redacted : "not a Line", undefined);
  });

  it("bounds the reason a close or a Dropped Entry gives", () => {
    const ircd = { host: "irc.example", port: 6697, tls: true };
    const reason = `the host failed: ${describeDefect(new Error("x ".repeat(3000)))}`;

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
        reason: "y".repeat(5000),
      },
    ];

    assert.deepStrictEqual(
      boundReasons(entries).map((entry) => ("reason" in entry ? entry.reason?.length : 0)),
      [1024, 1024, 1024]
    );
  });

  it("does not split a surrogate pair where it cuts", () => {
    const [entry] = boundReasons([
      {
        _tag: "Dropped",
        bytes: encoder.encode("PRIVMSG #a :hi"),
        cause: "api",
        connection: 1,
        network: "libera",
        reason: `${"y".repeat(1022)}😀${"y".repeat(10)}`,
      },
    ]);

    const reason = "reason" in entry ? entry.reason : "";

    assert.strictEqual(reason, `${"y".repeat(1022)}…`);
  });

  it("passes every other Entry through as it is", () => {
    const entries: Arr.NonEmptyReadonlyArray<NewEntry> = [
      { _tag: "Deadline", name: "hunter2", network: "libera" },
    ];

    assert.deepStrictEqual(boundReasons(entries), entries);
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
