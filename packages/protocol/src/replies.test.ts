import { describe, expect, it } from "vitest";

import { parseLine } from "./line.ts";
import { randomText, seededRandom } from "./random.fixture.ts";
import { parseStandardReply } from "./replies.ts";

const replyOf = (text: string) => {
  const parsed = parseLine(text);

  return parsed._tag === "Line" ? parseStandardReply(parsed.line) : undefined;
};

describe(parseStandardReply, () => {
  it("PROT-6 reads a FAIL with its command, code, and description", () => {
    expect(replyOf("FAIL REHASH CONFIG_BAD :Could not reload config from disk")).toStrictEqual({
      code: "CONFIG_BAD",
      command: "REHASH",
      context: [],
      description: "Could not reload config from disk",
      kind: "FAIL",
    });
  });

  it("PROT-6 reads a WARN with context", () => {
    expect(
      replyOf(":irc.example WARN BOX BOXES_INVALID STACK CLOCKWISE :Given boxes are not supported")
    ).toStrictEqual({
      code: "BOXES_INVALID",
      command: "BOX",
      context: ["STACK", "CLOCKWISE"],
      description: "Given boxes are not supported",
      kind: "WARN",
    });
  });

  it("PROT-6 reads a NOTE that answers no command", () => {
    expect(replyOf("NOTE * OPER_MESSAGE :Thanks for flying ExampleNet!")).toMatchObject({
      code: "OPER_MESSAGE",
      command: "*",
      kind: "NOTE",
    });
  });

  it("makes the command and the code upper-case, and not the description", () => {
    expect(replyOf("fail nick bad_Nick :Nope")).toMatchObject({
      code: "BAD_NICK",
      command: "NICK",
      description: "Nope",
    });
  });

  it("takes the last parameter as the description, plain or trailing", () => {
    expect(replyOf("FAIL * CODE ctx desc")).toMatchObject({
      context: ["ctx"],
      description: "desc",
    });
  });

  it("allows an empty description", () => {
    expect(replyOf("FAIL * CODE :")).toMatchObject({ description: "" });
  });

  it.each(["FAIL", "FAIL :x", "FAIL * :x", "WARN a", "NOTE"])("returns nothing for %j", (text) => {
    expect(replyOf(text)).toBeUndefined();
  });

  it.each(["PRIVMSG #a :hi", "NOTICE a b c", "FAILURE a b :c", "432 a b :c"])(
    "returns nothing for %j, which is another command",
    (text) => {
      expect(replyOf(text)).toBeUndefined();
    }
  );

  it("returns nothing for a Line built with an empty command or code", () => {
    const line = { command: "FAIL", params: ["", "CODE", "d"], source: undefined, tags: new Map() };

    expect(parseStandardReply(line)).toBeUndefined();
    expect(parseStandardReply({ ...line, params: ["*", "", "d"] })).toBeUndefined();
  });

  it("PROT-6 reads them with no capability negotiated, as a Line is all it is given", () => {
    expect(replyOf("@label=1 :ergo FAIL * ACCOUNT_REQUIRED :Log in")).toMatchObject({
      code: "ACCOUNT_REQUIRED",
    });
  });
});

describe("PROT-6 standard replies, on random Lines", () => {
  it("never throws, and reads exactly the Lines with a kind and three parameters", () => {
    const random = seededRandom(2019);

    const alphabet = [
      "FAIL",
      "WARN",
      "NOTE",
      "fail",
      "PRIVMSG",
      " ",
      " ",
      ":",
      "CODE",
      "*",
      "é",
      "x",
    ];

    const kinds = new Set(["FAIL", "WARN", "NOTE"]);

    const wrong = Array.from({ length: 3000 }, () =>
      parseLine(randomText(random, alphabet, random(14)))
    )
      .flatMap((parsed) => (parsed._tag === "Line" ? [parsed.line] : []))
      .filter(
        (line) =>
          (parseStandardReply(line) !== undefined) !==
          (kinds.has(line.command) && line.params.length >= 3)
      );

    expect(wrong).toStrictEqual([]);
  });
});
