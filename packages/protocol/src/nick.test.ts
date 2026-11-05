import { describe, expect, it } from "vitest";

import { isNick, nickCandidates, nickLine } from "./nick.ts";

describe(nickCandidates, () => {
  it("CONN-4: tries the nick, then the alternates as configured, then the nick with `_`", () => {
    expect(
      nickCandidates({ alternates: ["claudia", "a-much-longer-alternate"], nick: "claude" })
    ).toStrictEqual([
      "claude",
      "claudia",
      "a-much-longer-alternate",
      "claude_",
      "claude__",
      "claude___",
    ]);
  });

  it("CONN-4: has no repeats, and keeps the first place of a repeated nick", () => {
    expect(
      nickCandidates({ alternates: ["claude_", "claude", "claude_"], nick: "claude" })
    ).toStrictEqual(["claude", "claude_", "claude__", "claude___"]);
  });

  it("CONN-4: drops an empty nick, which no Ircd accepts", () => {
    expect(nickCandidates({ alternates: ["", "cc"], nick: "" })).toStrictEqual(["cc"]);
  });

  it("CONN-4: leaves out a candidate no `NICK` could carry", () => {
    // `NICK ` and this fill the 510 bytes a Line holds, so the nick goes and its `_` would not.
    const longest = `n${"x".repeat(504)}`;

    expect(nickLine(longest)._tag).toBe("Safe");
    expect(nickCandidates({ alternates: ["cc"], nick: longest })).toStrictEqual([longest, "cc"]);
  });
});

describe(isNick, () => {
  it.each(["claude", "c[l]aude", "a_9", "x", "a-b", "_x", "[away]", "{x}", "\\o/", "`x", "^x|y"])(
    "CONN-3: takes %j",
    (nick) => {
      expect(isNick(nick)).toBeTruthy();
    }
  );

  it.each(["", "two words", ":colon", "9lives", "line\r\nbreak", "nul\0"])(
    "CONN-4: refuses %j, which `NICK` cannot carry",
    (nick) => {
      expect(isNick(nick)).toBeFalsy();
    }
  );

  it.each(["#abc", "&abc", "+abc", "!abc", "-dash", "~tilde", "%half", "@op", "$mask"])(
    "CONF-3: refuses %j, which starts with what marks a Channel, a member, or a mask",
    (nick) => {
      expect(isNick(nick)).toBeFalsy();
    }
  );

  it.each(["a,b", "a!b", "a@b", "a*", "a?"])(
    "CONF-3: refuses %j, which holds what splits a prefix, a list, or a mask",
    (nick) => {
      expect(isNick(nick)).toBeFalsy();
    }
  );
});

describe(nickLine, () => {
  it("CONN-4: builds `NICK` for a nick", () => {
    const built = nickLine("claude");

    expect(built._tag === "Safe" && new TextDecoder().decode(built.line.toBytes())).toBe(
      "NICK claude"
    );
  });

  it.each(["#abc", "9lives", `x${"y".repeat(510)}`])("refuses %j", (nick) => {
    expect(nickLine(nick)._tag).toBe("Rejected");
  });
});
