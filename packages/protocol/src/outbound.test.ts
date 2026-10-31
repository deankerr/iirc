import { describe, expect, it } from "vitest";

import { encodeLine, maxLineBytes, outbound, privmsg } from "./outbound.ts";

describe(outbound, () => {
  it("formats a last parameter that needs a colon", () => {
    expect(outbound("USER", ["claude", "0", "*", "Claude Code"])).toMatchObject({
      line: { text: "USER claude 0 * :Claude Code" },
    });
  });

  it.each([
    ["line break in the last parameter", ["#a", "hi\r\nQUIT :pwned"]],
    ["null in the last parameter", ["#a", "hi\0there"]],
    ["line break in a middle parameter", ["#a\r\nQUIT", "k"]],
    ["space in a middle parameter", ["#a b", "k"]],
    ["empty middle parameter", ["", "k"]],
    ["colon in a middle parameter", [":a", "k"]],
  ])("rejects a %s", (_name, params) => {
    expect(outbound("PRIVMSG", params)).toStrictEqual({
      _tag: "Rejected",
      reason: "InvalidParameter",
    });
  });

  it.each(["", "PRIV MSG", "PING\r\nQUIT", "12"])("rejects %j as a command", (command) => {
    expect(outbound(command, [])).toStrictEqual({ _tag: "Rejected", reason: "InvalidCommand" });
  });

  it("rejects a Line over the byte limit", () => {
    expect(outbound("PRIVMSG", ["#a", "é".repeat(maxLineBytes / 2)])).toStrictEqual({
      _tag: "Rejected",
      reason: "TooLong",
    });
  });
});

describe(privmsg, () => {
  it("builds a Line ending in CRLF", () => {
    const built = privmsg("#iirc", "hello there");

    if (built._tag === "Rejected") {
      throw new Error(built.reason);
    }

    expect(new TextDecoder().decode(encodeLine(built.line))).toBe("PRIVMSG #iirc :hello there\r\n");
  });

  it.each(["#a,#b", "", "a b"])("rejects %j as a Target", (target) => {
    expect(privmsg(target, "hi")).toStrictEqual({ _tag: "Rejected", reason: "InvalidTarget" });
  });

  it("rejects empty text", () => {
    expect(privmsg("#a", "")).toStrictEqual({ _tag: "Rejected", reason: "EmptyText" });
  });
});
