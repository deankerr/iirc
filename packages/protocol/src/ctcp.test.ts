import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ctcpReply, ctcpText, parseCtcp } from "./ctcp.ts";
import type { Ctcp, CtcpText } from "./ctcp.ts";
import { encodeLine } from "./outbound.ts";
import { randomText, seededRandom } from "./random.fixture.ts";

const Vectors = Schema.Struct({
  tests: Schema.Array(
    Schema.Struct({
      input: Schema.String,
      name: Schema.String,
      result: Schema.Struct({
        args: Schema.optional(Schema.String),
        command: Schema.optional(Schema.String),
        subcommand: Schema.optional(Schema.String),
        text: Schema.optional(Schema.String),
        type: Schema.Literals(["none", "action", "dcc", "other"]),
      }),
    })
  ),
});

const vectorsFile = new URL("testdata/ctcp.yaml", import.meta.url);

const { tests: vectors } = Schema.decodeUnknownSync(Vectors)(
  Bun.YAML.parse(await Bun.file(vectorsFile).text())
);

type Result = (typeof vectors)[number]["result"];

const expected = (result: Result): Ctcp => {
  if (result.type === "none") {
    return { _tag: "NotCtcp" };
  }

  if (result.type === "action") {
    return { _tag: "Action", text: result.text ?? "" };
  }

  if (result.type === "dcc") {
    return { _tag: "Dcc", args: result.args ?? "", subcommand: result.subcommand ?? "" };
  }

  return { _tag: "Other", args: result.args ?? "", command: result.command ?? "" };
};

describe("PROT-2 and PROT-5 CTCP vectors", () => {
  it.each(vectors)("parses $name", ({ input, result }) => {
    expect(parseCtcp(input)).toStrictEqual(expected(result));
  });
});

const safeText = (command: string, args: string): CtcpText => {
  const built = ctcpText(command, args);

  if (built._tag === "Rejected") {
    throw new Error(built.reason);
  }

  return built.text;
};

describe(ctcpText, () => {
  it("PROT-3 wraps a command and its arguments in delimiters", () => {
    expect(safeText("VERSION", "iirc").toString()).toBe("\u0001VERSION iirc\u0001");
  });

  it("leaves out the space when there are no arguments", () => {
    expect(safeText("VERSION", "").toString()).toBe("\u0001VERSION\u0001");
  });

  it.each(["", "A B", "A\u0001", "A\r", "A\n", "A\0"])("rejects %j as a command", (command) => {
    expect(ctcpText(command, "x")).toStrictEqual({ _tag: "Rejected", reason: "InvalidCommand" });
  });

  it.each(["a\u0001b", "a\rb", "a\nb", "a\0b", "\u0001"])(
    "HOST-3 rejects %j as arguments",
    (args) => {
      expect(ctcpText("PING", args)).toStrictEqual({
        _tag: "Rejected",
        reason: "InvalidArguments",
      });
    }
  );

  it("keeps spaces, colons, and formatting codes in arguments", () => {
    expect(safeText("PING", " :a  \u0002b").toString()).toBe("\u0001PING  :a  \u0002b\u0001");
  });
});

describe(ctcpReply, () => {
  it("PROT-4 goes out as a NOTICE, on one Line", () => {
    const built = ctcpReply("alice", safeText("VERSION", "iirc"));

    expect(built._tag).toBe("Safe");
    expect(built._tag === "Safe" && new TextDecoder().decode(encodeLine(built.line))).toBe(
      "NOTICE alice :\u0001VERSION iirc\u0001\r\n"
    );
  });

  it.each(["", "a,b", "a b", ":a"])("rejects %j as a Target", (target) => {
    expect(ctcpReply(target, safeText("PING", "1"))).toStrictEqual({
      _tag: "Rejected",
      reason: "InvalidTarget",
    });
  });

  it("rejects a reply too long to fit a Line", () => {
    expect(ctcpReply("alice", safeText("PING", "x".repeat(600)))).toStrictEqual({
      _tag: "Rejected",
      reason: "TooLong",
    });
  });
});

const upperAscii = (text: string) => text.replaceAll(/[a-z]/gu, (letter) => letter.toUpperCase());

// What is wrong with the text built from this command and these arguments, if anything.
const problemWith = (command: string, args: string) => {
  const built = ctcpText(command, args);

  if (built._tag === "Rejected") {
    return args.includes("\u0001") ? undefined : `rejected ${built.reason}`;
  }

  const text = built.text.toString();
  const inside = text.slice(1, -1);
  const parsed = parseCtcp(text);

  if (!text.startsWith("\u0001") || !text.endsWith("\u0001") || inside.includes("\u0001")) {
    return "not delimited";
  }

  return parsed._tag === "Other" && parsed.args === args && parsed.command === upperAscii(command)
    ? undefined
    : "did not parse back";
};

describe("PROT-2 CTCP, on random text", () => {
  const random = seededRandom(1990);

  const alphabet = [
    "\u0001",
    "\u0001",
    " ",
    " ",
    "ACTION",
    "DCC",
    "dcc",
    "SEND",
    "ping",
    "a",
    "é",
    "\r",
    "\n",
    "\0",
    "\u0002",
  ];

  const samples = Array.from({ length: 3000 }, () => randomText(random, alphabet, random(12)));

  it("never throws", () => {
    const failures = samples.filter((sample) => {
      try {
        parseCtcp(sample);

        return false;
      } catch {
        return true;
      }
    });

    expect(failures).toStrictEqual([]);
  });

  it("finds CTCP only in text that starts with a delimiter", () => {
    const failures = samples.filter(
      (sample) => parseCtcp(sample)._tag !== "NotCtcp" && !sample.startsWith("\u0001")
    );

    expect(failures).toStrictEqual([]);
  });

  it("builds text that parses back to the command and arguments it was built from", () => {
    const commandAlphabet = ["A", "b", "Z", "1", ":", "é", "*"];
    const argsAlphabet = [" ", "x", ":", "é", "\u0002", "\u{1F600}", "\u0001"];

    const problems = Array.from({ length: 2000 }, () =>
      problemWith(
        randomText(random, commandAlphabet, 1 + random(6)),
        randomText(random, argsAlphabet, random(8))
      )
    ).filter((problem) => problem !== undefined);

    expect(problems).toStrictEqual([]);
  });
});
