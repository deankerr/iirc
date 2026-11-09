import { Schema } from "effect";
import { Yaml } from "effect/encoding";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { action, CtcpText, ctcpReply, ctcpText, parseCtcp, parseReplyTarget } from "./ctcp.ts";
import type { Ctcp, ReplyTarget } from "./ctcp.ts";
import { encode, isRejected, upperCaseAscii } from "./line.ts";
import type { OutboundLine, Rejected } from "./line.ts";
import ctcp from "./testdata/ctcp.yaml?raw";

// The bytes `encode` writes for a Line our own builders made, which it never rejects.
const encodedBytes = (line: OutboundLine): Uint8Array => {
  const bytes = encode(line);

  if (isRejected(bytes)) {
    throw new Error(`Expected bytes, not ${bytes.reason}`);
  }

  return bytes;
};

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

const { tests: vectors } = Schema.decodeUnknownSync(Vectors)(Yaml.parse(ctcp));

type Expected = (typeof vectors)[number]["result"];

const expected = (result: Expected): Ctcp => {
  switch (result.type) {
    case "none": {
      return { _tag: "NotCtcp" };
    }

    case "action": {
      return { _tag: "Action", text: result.text ?? "" };
    }

    case "dcc": {
      return { _tag: "Dcc", args: result.args ?? "", subcommand: result.subcommand ?? "" };
    }

    case "other": {
      return { _tag: "Other", args: result.args ?? "", command: result.command ?? "" };
    }

    default: {
      return result.type satisfies never;
    }
  }
};

describe("the CTCP vectors", () => {
  it.each(vectors)("parse $name", ({ input, result }) => {
    expect(parseCtcp(input)).toStrictEqual(expected(result));
  });
});

const isText = Schema.is(CtcpText);

const safeText = (command: string, args: string): CtcpText => {
  const built = ctcpText(command, args);

  if (!isText(built)) {
    throw new Error(built.reason);
  }

  return built;
};

const wire = (built: OutboundLine | Rejected) => {
  if (isRejected(built)) {
    throw new Error(built.reason);
  }

  return new TextDecoder().decode(encodedBytes(built));
};

describe(ctcpText, () => {
  it("wraps a command and its arguments in delimiters", () => {
    expect(safeText("VERSION", "iirc")).toBe("\u0001VERSION iirc\u0001");
  });

  it("leaves out the space when there are no arguments", () => {
    expect(safeText("VERSION", "")).toBe("\u0001VERSION\u0001");
  });

  it.each(["", "A B", "A\u0001", "A\r", "A\n", "A\0"])("refuses %j as a command", (command) => {
    expect(ctcpText(command, "x")).toStrictEqual({ _tag: "Rejected", reason: "InvalidCommand" });
  });

  it.each(["a\u0001b", "a\rb", "a\nb", "a\0b", "\u0001"])("refuses %j as arguments", (args) => {
    expect(ctcpText("PING", args)).toStrictEqual({ _tag: "Rejected", reason: "InvalidArguments" });
  });

  it("keeps spaces, colons, and formatting codes in arguments", () => {
    expect(safeText("PING", " :a  \u0002b")).toBe("\u0001PING  :a  \u0002b\u0001");
  });

  it("cannot be made from text that is not CTCP", () => {
    expect(isText("\u0001PING\u0001x\u0001")).toBeFalsy();
    expect(isText("PING")).toBeFalsy();
    expect(isText("\u0001\u0001")).toBeFalsy();
  });
});

describe(action, () => {
  it("is a PRIVMSG holding an ACTION", () => {
    expect(wire(action("#iirc", "waves"))).toBe("PRIVMSG #iirc :\u0001ACTION waves\u0001\r\n");
  });

  it("refuses what would end the ACTION early", () => {
    expect(action("#iirc", "a\u0001b")).toStrictEqual({
      _tag: "Rejected",
      reason: "InvalidParameter",
    });
  });
});

const prefixes = { chantypes: "#&", statusmsg: "@+" };

const userNamed = (nick: string): ReplyTarget => {
  const target = parseReplyTarget(nick, prefixes);

  if (target === undefined) {
    throw new Error(`Expected ${nick} to be a nick`);
  }

  return target;
};

describe(parseReplyTarget, () => {
  it.each(["alice", "a[b]", "x{1}^", "_under", "Bob|away", "=odd"])("takes %j, a nick", (nick) => {
    expect(parseReplyTarget(nick, prefixes)).toBe(nick);
  });

  it.each([
    "#victims",
    "&local",
    "$*.test",
    "@#chan",
    "+#chan",
    "a,b",
    "a b",
    "a*",
    "a?",
    "a!b",
    "a@b",
    ":a",
    "",
    "1abc",
    "-dash",
  ])("refuses %j, which could name a Channel or a mask", (nick) => {
    expect(parseReplyTarget(nick, prefixes)).toBeUndefined();
  });

  it("refuses a nick starting with a prefix the Network has in force", () => {
    expect(parseReplyTarget("=odd", { chantypes: "#=", statusmsg: "" })).toBeUndefined();
    expect(parseReplyTarget("^odd", { chantypes: "#", statusmsg: "^" })).toBeUndefined();
  });
});

describe(ctcpReply, () => {
  it("goes out as a NOTICE, on one Line", () => {
    expect(wire(ctcpReply(userNamed("alice"), safeText("VERSION", "iirc")))).toBe(
      "NOTICE alice :\u0001VERSION iirc\u0001\r\n"
    );
  });

  it("refuses a reply too long to fit a Line", () => {
    expect(ctcpReply(userNamed("alice"), safeText("PING", "x".repeat(600)))).toStrictEqual({
      _tag: "Rejected",
      reason: "TooLong",
    });
  });
});

describe("CTCP, on random text", () => {
  const pieces = fc.constantFrom(
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
    "\u0002"
  );

  const samples = fc.array(pieces, { maxLength: 12 }).map((all) => all.join(""));

  it("never throws, and finds CTCP only in text that starts with a delimiter", () => {
    expect(() => {
      fc.assert(
        fc.property(
          samples,
          (sample) => parseCtcp(sample)._tag === "NotCtcp" || sample.startsWith("\u0001")
        ),
        { numRuns: 3000 }
      );
    }).not.toThrow();
  });

  it("builds text that parses back to the command and arguments it was built from", () => {
    const commands = fc
      .array(fc.constantFrom("A", "b", "Z", "1", ":", "é", "*"), { maxLength: 6, minLength: 1 })
      .map((all) => all.join(""));

    const args = fc
      .array(fc.constantFrom(" ", "x", ":", "é", "\u0002", "\u{1F600}", "\u0001"), {
        maxLength: 8,
      })
      .map((all) => all.join(""));

    expect(() => {
      fc.assert(
        fc.property(commands, args, (command, rest) => {
          const built = ctcpText(command, rest);

          if (!isText(built)) {
            return rest.includes("\u0001");
          }

          const parsed = parseCtcp(built);
          const upper = upperCaseAscii(command);

          if (upper === "ACTION") {
            return parsed._tag === "Action" && parsed.text === rest;
          }

          return parsed._tag === "Other" && parsed.args === rest && parsed.command === upper;
        }),
        { numRuns: 3000 }
      );
    }).not.toThrow();
  });
});
