import { describe, expect, it } from "vitest";

import { modeTypes, parseModes, withModeTokens } from "./mode.ts";

const defaults = modeTypes({});

describe(modeTypes, () => {
  it("KNOW-2: a Network that sends neither token gets `PREFIX=(ov)@+` and `CHANMODES=beI,k,l`", () => {
    expect(defaults).toStrictEqual({
      always: "k",
      flags: "",
      list: "beI",
      prefix: "ov",
      whenSet: "l",
    });
  });

  it("KNOW-2: `PREFIX=` means no prefixes, which differs from no token", () => {
    expect(modeTypes({ prefix: "" }).prefix).toBe("");
  });

  it("KNOW-2: reads every group of `CHANMODES` and the letters of `PREFIX`", () => {
    expect(
      modeTypes({ chanmodes: "beIq,k,flj,CFLMPQcgimnprstz", prefix: "(qaohv)~&@%+" })
    ).toStrictEqual({
      always: "k",
      flags: "CFLMPQcgimnprstz",
      list: "beIq",
      prefix: "qaohv",
      whenSet: "flj",
    });
  });

  it("KNOW-2: a `CHANMODES` short of groups has none of the missing kinds", () => {
    expect(modeTypes({ chanmodes: "b" })).toMatchObject({ always: "", flags: "", whenSet: "" });
  });
});

describe(withModeTokens, () => {
  it("KNOW-2: takes `PREFIX` and `CHANMODES` from an `RPL_ISUPPORT`, prose and all", () => {
    expect(
      withModeTokens({}, ["CHANMODES=b,k,l,imnt", "PREFIX=(ohv)@%+", "NICKLEN=30", "are supported"])
    ).toStrictEqual({ chanmodes: "b,k,l,imnt", prefix: "(ohv)@%+" });
  });

  it("KNOW-2: a token with no value has an empty one, and `-TOKEN` brings back the default", () => {
    const empty = withModeTokens({ prefix: "(ov)@+" }, ["PREFIX"]);

    expect(empty).toStrictEqual({ chanmodes: undefined, prefix: "" });
    expect(withModeTokens(empty, ["-PREFIX"]).prefix).toBeUndefined();
  });

  it("KNOW-2: leaves what an `RPL_ISUPPORT` does not mention as it was", () => {
    expect(withModeTokens({ chanmodes: "b,k,l," }, ["PREFIXES=x"])).toStrictEqual({
      chanmodes: "b,k,l,",
      prefix: undefined,
    });
  });
});

describe(parseModes, () => {
  it("KNOW-6: `+ok nick key` gives the nick to `o` and the key to `k`", () => {
    expect(parseModes(["+ok", "nick", "key"], defaults)).toStrictEqual({
      _tag: "Parsed",
      changes: [
        { adding: true, letter: "o", param: "nick" },
        { adding: true, letter: "k", param: "key" },
      ],
    });
  });

  it("KNOW-6: a flag in between takes nothing, and `l` takes one only when set", () => {
    expect(parseModes(["+nlk-l", "10", "key"], defaults)).toStrictEqual({
      _tag: "Parsed",
      changes: [
        { adding: true, letter: "n" },
        { adding: true, letter: "l", param: "10" },
        { adding: true, letter: "k", param: "key" },
        { adding: false, letter: "l" },
      ],
    });
  });

  it("KNOW-6: signs can change many times, and a list mode takes a mask both ways", () => {
    expect(parseModes(["-b+v-k+b", "*!*@a", "bob", "old", "*!*@b"], defaults)).toStrictEqual({
      _tag: "Parsed",
      changes: [
        { adding: false, letter: "b", param: "*!*@a" },
        { adding: true, letter: "v", param: "bob" },
        { adding: false, letter: "k", param: "old" },
        { adding: true, letter: "b", param: "*!*@b" },
      ],
    });
  });

  it("KNOW-6: letters with no sign are being set", () => {
    expect(parseModes(["k", "key"], defaults)).toStrictEqual({
      _tag: "Parsed",
      changes: [{ adding: true, letter: "k", param: "key" }],
    });
  });

  it("KNOW-6: a letter the Network never advertised takes no parameter", () => {
    expect(parseModes(["+Xk", "key"], defaults)).toStrictEqual({
      _tag: "Parsed",
      changes: [
        { adding: true, letter: "X" },
        { adding: true, letter: "k", param: "key" },
      ],
    });
  });

  it("KNOW-6: reads prefixes from the Network's own `PREFIX`", () => {
    const types = modeTypes({ prefix: "(qaohv)~&@%+" });

    expect(parseModes(["+qk", "owner", "key"], types).changes).toStrictEqual([
      { adding: true, letter: "q", param: "owner" },
      { adding: true, letter: "k", param: "key" },
    ]);
  });

  it("KNOW-6: with `PREFIX=`, `o` is a letter nobody advertised, so the key moves up", () => {
    expect(parseModes(["+ok", "key"], modeTypes({ prefix: "" })).changes).toStrictEqual([
      { adding: true, letter: "o" },
      { adding: true, letter: "k", param: "key" },
    ]);
  });

  it("KNOW-6: a `k` the Network lists as a flag takes nothing", () => {
    expect(parseModes(["+k"], modeTypes({ chanmodes: "b,,l,k" }))).toStrictEqual({
      _tag: "Parsed",
      changes: [{ adding: true, letter: "k" }],
    });
  });

  it("KNOW-6: a letter short of its parameter does not add up", () => {
    expect(parseModes(["+ok", "nick"], defaults)._tag).toBe("Uneven");
  });

  it("KNOW-6: a parameter left over does not add up", () => {
    expect(parseModes(["+n", "stray"], defaults)._tag).toBe("Uneven");
  });

  it("KNOW-6: an unset `k` with nothing left takes nothing, as some Ircds send it", () => {
    expect(parseModes(["-k"], defaults)).toStrictEqual({
      _tag: "Parsed",
      changes: [{ adding: false, letter: "k" }],
    });
  });

  it("KNOW-6: a `MODE` with no letters at all changes nothing", () => {
    expect(parseModes([], defaults)).toStrictEqual({ _tag: "Parsed", changes: [] });
  });
});
