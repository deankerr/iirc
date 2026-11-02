import { describe, expect, it } from "vitest";

import { buildTemplate, fillReferences, parseTemplate, templateReferences } from "./template.ts";
import type { Template } from "./template.ts";

const decoder = new TextDecoder();

const parsed = (text: string): Template => {
  const result = parseTemplate(text);

  if (result._tag === "Rejected") {
    throw new Error(`${text} was rejected: ${result.reason}`);
  }

  return result.template;
};

const built = (text: string, values: Readonly<Record<string, string>>) => {
  const result = buildTemplate(parsed(text), (name) => values[name] ?? "");

  return result._tag === "Safe" ? decoder.decode(result.line.bytes) : result.reason;
};

describe(templateReferences, () => {
  it("CONN-6: names each reference once, in order", () => {
    expect(templateReferences("A {{x}} {{y}} {{x}} {y} {{}}")).toStrictEqual(["x", "y", ""]);
  });
});

describe(fillReferences, () => {
  it("CONN-6: puts a value in place of every reference", () => {
    expect(fillReferences("{{a}} and {{b}}", (name) => name.toUpperCase())).toBe("A and B");
  });
});

describe(parseTemplate, () => {
  it("CONN-6: refuses what is not a Line, and a Line with tags or a source", () => {
    expect(parseTemplate("")).toStrictEqual({ _tag: "Rejected", reason: "NotALine" });
    expect(parseTemplate(":src PRIVMSG Q :hi")).toStrictEqual({
      _tag: "Rejected",
      reason: "HasPrefix",
    });
    expect(parseTemplate("@a=b PRIVMSG Q :hi")).toStrictEqual({
      _tag: "Rejected",
      reason: "HasPrefix",
    });
  });
});

describe(buildTemplate, () => {
  it("CONN-6: fills each parameter in, after the Line is parsed", () => {
    expect(built("PRIVMSG Q :AUTH me {{q}}", { q: "s3cret" })).toBe("PRIVMSG Q :AUTH me s3cret");
  });

  it("LOG-6: a value cannot add a parameter or a command of its own", () => {
    expect(built("MODE {{nick}} +i", { nick: "me +o" })).toBe("InvalidParameter");
    expect(built("PRIVMSG Q :{{q}}", { q: "x\r\nQUIT" })).toBe("InvalidParameter");
  });
});
