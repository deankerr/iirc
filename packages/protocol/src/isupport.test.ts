import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { casefold, casemappingOf, sameName } from "./casemapping.ts";
import {
  channelModesOf,
  chantypesOf,
  defaultChannelModes,
  defaultPrefix,
  isupportTokens,
  limitOf,
  limitsOf,
  modesOf,
  prefixOf,
  statusmsgOf,
  targetLimitsOf,
  unescapeValue,
} from "./isupport.ts";
import { parse } from "./line.ts";

const utf8 = new TextEncoder();

const paramsOf = (text: string) => {
  const parsed = parse(utf8.encode(text), { _tag: "Utf8Only" });

  return parsed._tag === "Line" ? parsed.line.params : [];
};

// Tokens as a map, as a Session would hold them after these Lines.
const tokensOf = (...lines: readonly string[]) => {
  const tokens = new Map<string, string>();

  for (const token of lines.flatMap((line) => isupportTokens(paramsOf(line)))) {
    if (token._tag === "Set") {
      tokens.set(token.name, token.value);
    } else {
      tokens.delete(token.name);
    }
  }

  return tokens;
};

const ergo = tokensOf(
  ":ergo.test 005 iirc_ AWAYLEN=390 BOT=B CASEMAPPING=ascii CHANLIMIT=#:100 CHANMODES=Ibe,k,fl,CEMRUimnstu CHANNELLEN=64 CHANTYPES=# CHATHISTORY=1000 ELIST=U EXCEPTS EXTBAN=,m FORWARD=f INVEX :are supported by this server",
  ":ergo.test 005 iirc_ KICKLEN=390 MAXLIST=beI:100 MAXTARGETS=4 MODES MONITOR=100 MSGREFTYPES=msgid,timestamp NETWORK=iirc-spike NICKLEN=32 PREFIX=(qaohv)~&@%+ SAFELIST SAFERATE STATUSMSG=~&@%+ TARGMAX=NAMES:1,LIST:1,KICK:,WHOIS:1,USERHOST:10,PRIVMSG:4,TAGMSG:4,NOTICE:4,MONITOR:100 :are supported by this server",
  ":ergo.test 005 iirc_ TOPICLEN=390 UTF8ONLY WHOX draft/CHATHISTORY=1000 :are supported by this server"
);

const ngircd = tokensOf(
  ":ngircd.test 005 iirc_ RFC2812 IRCD=ngIRCd CHARSET=UTF-8 CASEMAPPING=ascii PREFIX=(qaohv)~&@%+ CHANTYPES=#&+ CHANMODES=beI,k,l,imMnOPQRstVz CHANLIMIT=#&+:10 :are supported on this server",
  ":ngircd.test 005 iirc_ CHANNELLEN=50 NICKLEN=9 TOPICLEN=399 AWAYLEN=127 KICKLEN=399 MODES=5 MAXLIST=beI:50 EXCEPTS=e INVEX=I PENALTY FNC :are supported on this server"
);

const qaohv = prefixOf("(qaohv)~&@%+");

describe("ISUPPORT from the recorded Ircds", () => {
  it("reads Ergo's", () => {
    expect({
      casemapping: casemappingOf(ergo.get("CASEMAPPING"), ergo.get("UTF8MAPPING")),
      chanlimit: limitsOf(ergo.get("CHANLIMIT")),
      chanmodes: channelModesOf(ergo.get("CHANMODES")),
      chantypes: chantypesOf(ergo.get("CHANTYPES")),
      chathistory: ergo.get("draft/CHATHISTORY"),
      kick: targetLimitsOf(ergo.get("TARGMAX")).get("KICK"),
      modes: modesOf(ergo.get("MODES")),
      nicklen: limitOf(ergo.get("NICKLEN")),
      prefix: prefixOf(ergo.get("PREFIX")),
      privmsg: targetLimitsOf(ergo.get("TARGMAX")).get("PRIVMSG"),
      tokens: ergo.size,
      utf8only: ergo.get("UTF8ONLY"),
    }).toStrictEqual({
      casemapping: "ascii",
      chanlimit: [{ limit: 100, of: "#" }],
      chanmodes: { always: "k", flags: "CEMRUimnstu", list: "Ibe", whenSet: "fl" },
      chantypes: "#",
      chathistory: "1000",
      kick: undefined,
      modes: undefined,
      nicklen: 32,
      prefix: qaohv,
      privmsg: 4,
      tokens: 30,
      utf8only: "",
    });
  });

  it("reads ngircd's", () => {
    expect({
      chanlimit: limitsOf(ngircd.get("CHANLIMIT")),
      chantypes: chantypesOf(ngircd.get("CHANTYPES")),
      maxlist: limitsOf(ngircd.get("MAXLIST")),
      modes: modesOf(ngircd.get("MODES")),
      nicklen: limitOf(ngircd.get("NICKLEN")),
      rfc2812: ngircd.get("RFC2812"),
    }).toStrictEqual({
      chanlimit: [{ limit: 10, of: "#&+" }],
      chantypes: "#&+",
      maxlist: [{ limit: 50, of: "beI" }],
      modes: 5,
      nicklen: 9,
      rfc2812: "",
    });
  });
});

describe(isupportTokens, () => {
  it("never reads the text at the end, nor Self at the start", () => {
    expect(isupportTokens(["NICKLEN=5", "MODES=4", "SAFELIST"])).toStrictEqual([
      { _tag: "Set", name: "MODES", value: "4" },
    ]);
    expect(isupportTokens(["iirc", "are supported"])).toStrictEqual([]);
  });

  it("takes a token back, and refuses a taken-back token with a value", () => {
    expect(isupportTokens(["iirc", "-EXCEPTS", "-MODES=3", "x"])).toStrictEqual([
      { _tag: "Removed", name: "EXCEPTS" },
    ]);
  });

  it("undoes escapes in values, as bytes", () => {
    expect(isupportTokens(["iirc", "NETWORK=Some\\x20Net\\x3D\\x5C", "x"])).toStrictEqual([
      { _tag: "Set", name: "NETWORK", value: "Some Net=\\" },
    ]);
    expect(unescapeValue("caf\\xC3\\xA9")).toBe("café");
    expect(unescapeValue("\\xFF")).toBe("\uFFFD");
  });

  it("reads a name longer than the grammar's twenty, and skips one that is no name", () => {
    expect(
      isupportTokens(["iirc", "VENDOR.EXAMPLE/LONG_TOKEN_NAME=1", "=x", "-", "x"])
    ).toStrictEqual([{ _tag: "Set", name: "VENDOR.EXAMPLE/LONG_TOKEN_NAME", value: "1" }]);
  });

  it("reads a name that starts with punctuation, as the grammar allows", () => {
    expect(
      isupportTokens(["me", ".VENDOR/FEATURE=1", "/SLASH", "_UNDER=x", "-.GONE", "text"])
    ).toStrictEqual([
      { _tag: "Set", name: ".VENDOR/FEATURE", value: "1" },
      { _tag: "Set", name: "/SLASH", value: "" },
      { _tag: "Set", name: "_UNDER", value: "x" },
      { _tag: "Removed", name: ".GONE" },
    ]);
  });

  it("undoes escapes in a value of a million bytes without running out of stack", () => {
    const long = "x".repeat(1_000_000);

    expect(unescapeValue(`${long}\\x20`)).toBe(`${long} `);
    expect(isupportTokens(["me", `NETWORK=${long}\\x41`, "text"])).toStrictEqual([
      { _tag: "Set", name: "NETWORK", value: `${long}A` },
    ]);
  });

  it("never throws on any parameters", () => {
    expect(() => {
      fc.assert(
        fc.property(fc.array(fc.string({ unit: "binary" })), (params) => {
          isupportTokens(params);

          return true;
        })
      );
    }).not.toThrow();
  });
});

describe("token values", () => {
  it("assumes the defaults for tokens not sent", () => {
    expect(prefixOf(undefined)).toBe(defaultPrefix);
    expect(channelModesOf(undefined)).toBe(defaultChannelModes);
    expect(chantypesOf(undefined)).toBe("#&");
    expect(modesOf(undefined)).toBe(3);
    expect(casemappingOf(undefined, undefined)).toBe("rfc1459");
  });

  it("reads STATUSMSG as the prefixes it lists, and none when not sent", () => {
    expect(statusmsgOf(undefined)).toBe("");
    expect(statusmsgOf("@+")).toBe("@+");
  });

  it("reads an empty PREFIX as none, and one that does not pair up as unusable", () => {
    expect(prefixOf("")).toStrictEqual([]);
    expect(prefixOf("(ov)@")).toBeUndefined();
    expect(prefixOf("ov@+")).toBeUndefined();
    expect(prefixOf("(ov)@+")).toStrictEqual(defaultPrefix);
  });

  it("reads CHANMODES short of groups, or with more than four", () => {
    expect(channelModesOf("b,k")).toStrictEqual({ always: "k", flags: "", list: "b", whenSet: "" });
    expect(channelModesOf("b,k,l,imnt,XYZ")).toStrictEqual({
      always: "k",
      flags: "imnt",
      list: "b",
      whenSet: "l",
    });
  });

  it("reads a MODES that holds no count as if it were not sent", () => {
    expect(modesOf("lots")).toBe(3);
    expect(modesOf("0")).toBe(3);
  });

  it("reads limits, leaving out pairs that do not parse", () => {
    expect(limitsOf("#:70,&:")).toStrictEqual([
      { limit: 70, of: "#" },
      { limit: undefined, of: "&" },
    ]);
    expect(limitsOf("#:x,nolimit,:5,&:5")).toStrictEqual([{ limit: 5, of: "&" }]);
    expect(targetLimitsOf("privmsg:3,JOIN:")).toStrictEqual(
      new Map([
        ["PRIVMSG", 3],
        ["JOIN", undefined],
      ])
    );
  });
});

describe(casemappingOf, () => {
  it.each([
    ["ascii", undefined, "ascii"],
    ["rfc1459", undefined, "rfc1459"],
    ["rfc1459-strict", undefined, "rfc1459-strict"],
    ["strict-rfc1459", undefined, "rfc1459-strict"],
    ["rfc8265", undefined, "rfc8265"],
    ["ascii", "rfc8265", "rfc8265"],
    ["precis", undefined, undefined],
    ["ascii", "something-new", undefined],
  ] as const)("reads CASEMAPPING=%s with UTF8MAPPING=%s as %s", (value, utf8mapping, mapping) => {
    expect(casemappingOf(value, utf8mapping)).toBe(mapping);
  });
});

const beyondAscii = (text: string) => text.replaceAll(/[\0-\u007F]/gu, "");

describe(casefold, () => {
  it("lower-cases ASCII letters under every mapping", () => {
    for (const mapping of ["ascii", "rfc1459", "rfc1459-strict", "rfc8265"] as const) {
      expect(casefold(mapping, "IiRC")).toBe("iirc");
    }
  });

  it("takes []\\~ to {}|^ under rfc1459, and all but ~ under rfc1459-strict", () => {
    expect(casefold("rfc1459", "[A]\\~")).toBe("{a}|^");
    expect(casefold("rfc1459-strict", "[A]\\~")).toBe("{a}|~");
    expect(casefold("ascii", "[A]\\~")).toBe("[a]\\~");
  });

  it("touches nothing past ASCII, so names are split and never merged", () => {
    expect(casefold("rfc8265", "ÉCOLE")).toBe("École");
    expect(casefold("ascii", "İSTANBUL")).toBe("İstanbul");
    expect(sameName("rfc8265", "Ω", "ω")).toBeFalsy();
  });

  it("compares names under a mapping", () => {
    expect(sameName("rfc1459", "Nick[a]", "nick{A}")).toBeTruthy();
    expect(sameName("ascii", "Nick[a]", "nick{A}")).toBeFalsy();
  });

  it("is idempotent, keeps length, and changes only ASCII, for any text", () => {
    const mappings = fc.constantFrom("ascii", "rfc1459", "rfc1459-strict", "rfc8265" as const);

    expect(() => {
      fc.assert(
        fc.property(mappings, fc.string({ unit: "binary" }), (mapping, name) => {
          const folded = casefold(mapping, name);

          return (
            casefold(mapping, folded) === folded &&
            folded.length === name.length &&
            beyondAscii(folded) === beyondAscii(name)
          );
        }),
        { numRuns: 3000 }
      );
    }).not.toThrow();
  });
});
