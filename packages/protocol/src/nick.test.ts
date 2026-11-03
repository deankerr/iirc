import { describe, expect, it } from "vitest";

import { isNick, nickCandidates, nickLine } from "./nick.ts";

const bytes = (nick: string) => new TextEncoder().encode(nick).length;

describe(nickCandidates, () => {
  const list = nickCandidates({ alternates: ["claudia", "cc"], limit: 9, nick: "claude" });

  it("CONN-4: tries the nick, then the alternates, then padding, then numbers", () => {
    expect(list.slice(0, 7)).toStrictEqual([
      "claude",
      "claudia",
      "cc",
      "claude_",
      "claude__",
      "claude___",
      "claude__1",
    ]);
  });

  it("CONN-4: overwrites the tail with every number from 1 to 99", () => {
    expect(list.at(-1)).toBe("claude_99");
    expect(list).toContain("claude__9");
    expect(list).toContain("claude_10");
    expect(list).toHaveLength(6 + 99);
  });

  it("CONN-4: keeps every candidate within the limit", () => {
    expect(list.filter((nick) => bytes(nick) > 9)).toStrictEqual([]);
  });

  it("CONN-4: has no repeats, and keeps the first place of a repeated nick", () => {
    expect(
      nickCandidates({ alternates: ["claude_", "claude", "claude_"], limit: 8, nick: "claude" })
    ).toStrictEqual([
      "claude",
      "claude_",
      "claude__",
      ...Array.from({ length: 9 }, (_unused, index) => `claude_${index + 1}`),
      ...Array.from({ length: 90 }, (_unused, index) => `claude${index + 10}`),
    ]);
  });

  it("CONN-4: adds no padding to a nick already at the limit", () => {
    const candidates = nickCandidates({ alternates: [], limit: 6, nick: "claude" });

    expect(candidates.slice(0, 3)).toStrictEqual(["claude", "claud1", "claud2"]);
    expect(candidates.at(-1)).toBe("clau99");
  });

  it("CONN-4: sends a nick over the limit as configured, then cuts it to fit", () => {
    const candidates = nickCandidates({ alternates: [], limit: 9, nick: "claude-code" });

    expect(candidates.slice(0, 3)).toStrictEqual(["claude-code", "claude-co", "claude-c1"]);
    expect(candidates.slice(1).filter((nick) => bytes(nick) > 9)).toStrictEqual([]);
  });

  it("CONN-4: leaves out an alternate over the limit, as only the nick is exempt", () => {
    expect(
      nickCandidates({ alternates: ["much-too-long", "fine"], limit: 9, nick: "claude" }).slice(
        0,
        3
      )
    ).toStrictEqual(["claude", "fine", "claude_"]);
  });

  it("CONN-4: never overwrites the first character, as no nick starts with a digit", () => {
    expect(nickCandidates({ alternates: [], limit: 1, nick: "claude" })).toStrictEqual([
      "claude",
      "c",
    ]);
    expect(nickCandidates({ alternates: [], limit: 2, nick: "claude" })).toStrictEqual([
      "claude",
      "cl",
      ...Array.from({ length: 9 }, (_unused, index) => `c${index + 1}`),
    ]);
  });

  it("CONN-4: offers only the configured nick when no limit is usable", () => {
    expect(nickCandidates({ alternates: ["cc"], limit: 0, nick: "claude" })).toStrictEqual([
      "claude",
    ]);
  });

  it("CONN-4: measures in bytes and never splits a character", () => {
    const candidates = nickCandidates({ alternates: [], limit: 5, nick: "ééé" });

    expect(candidates.slice(0, 2)).toStrictEqual(["ééé", "éé"]);
    expect(candidates.filter((nick) => bytes(nick) > 5)).toStrictEqual(["ééé"]);
    expect(candidates.join("")).not.toContain("�");
  });

  it("CONN-4: drops an empty nick, which no Ircd accepts", () => {
    expect(nickCandidates({ alternates: ["", "cc"], limit: 9, nick: "" })).toStrictEqual(["cc"]);
  });

  it("stays small when a hostile Network advertises an enormous NICKLEN", () => {
    const candidates = nickCandidates({ alternates: [], limit: 4_294_967_295, nick: "claude" });

    expect(candidates.length).toBeLessThan(200);
    expect(Math.max(...candidates.map(bytes))).toBeLessThanOrEqual(64);
  });

  it("is the same list every time, so it can be recorded and replayed", () => {
    expect(
      nickCandidates({ alternates: ["claudia", "cc"], limit: 9, nick: "claude" })
    ).toStrictEqual(list);
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
    "CONN-4: refuses %j, which `NICK` cannot carry or no candidate list can number",
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
