import type { Line } from "@iirc/protocol/line";
import { parseLine } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import { casefold, channelOf, initialState, messageOf, stepState } from "./state.ts";
import type { IrcState, StateChange } from "./state.ts";

const lineOf = (text: string): Line => {
  const parsed = parseLine(text);

  if (parsed._tag === "Unparseable") {
    throw new Error(`Expected a Line from ${text}`);
  }

  return parsed.line;
};

// The state after every Line, and every change on the way.
const run = (...lines: readonly string[]) => {
  let state = initialState;
  const changes: StateChange[] = [];

  for (const text of lines) {
    const stepped = stepState(state, lineOf(text));

    state = stepped.next;
    changes.push(...stepped.changes);
  }

  return { changes, state };
};

const replay = (...lines: readonly string[]) => run(...lines).state;

const changesOf = (...lines: readonly string[]) => run(...lines).changes;

const namesOf = ({ channels }: IrcState) => [...channels.values()].map(({ name }) => name);

const session = ":ircd 001 claude :Hi";

describe(stepState, () => {
  it("learns Self from the welcome", () => {
    expect(replay(":ircd 001 claude :Welcome").self).toBe("claude");
    expect(changesOf(":ircd 001 claude :Welcome")).toStrictEqual([
      { _tag: "Welcomed", self: "claude" },
    ]);
  });

  it("takes Self from the first welcome of a Session, and no other", () => {
    expect(replay(":ircd 001 claude :Hi", ":x 001 mallory :Hi").self).toBe("claude");
  });

  it("learns nothing from a welcome that names nobody", () => {
    expect(replay(":ircd 001", ":ircd 001 claude :Hi").self).toBe("claude");
  });

  it("LIVE-6: carries nothing from before the welcome into the Session", () => {
    expect(replay(":ircd 005 * NICKLEN=5 :ok", session)).toStrictEqual({
      ...initialState,
      self: "claude",
    });
  });

  it("follows Self through a nick change", () => {
    expect(changesOf(session, ":claude!u@h NICK :claudia")).toContainEqual({
      _tag: "NickChanged",
      from: "claude",
      to: "claudia",
    });
  });

  it("ignores another User's nick change", () => {
    expect(replay(session, ":master!u@h NICK :boss").self).toBe("claude");
  });

  it("tracks the Channels Self is in", () => {
    const state = replay(
      session,
      ":claude!u@h JOIN #a",
      ":claude!u@h JOIN #b",
      ":master!u@h JOIN #c",
      ":claude!u@h PART #a",
      ":master!u@h KICK #b claude :bye"
    );

    expect(namesOf(state)).toStrictEqual([]);
  });

  it("counts a Channel joined again as the newest, spelled as the Ircd spells it now", () => {
    expect(
      namesOf(replay(session, ":claude!u@h JOIN #a", ":claude!u@h JOIN #b", ":claude!u@h JOIN #A"))
    ).toStrictEqual(["#b", "#A"]);
  });

  it("survives Lines missing their parameters", () => {
    expect(
      replay("001", "NICK", "JOIN", "PART", "KICK", "MODE", "005", "471", "437")
    ).toStrictEqual(initialState);
  });

  it("gives back the very same state for a Line that changes nothing", () => {
    const state = replay(session, ":claude!u@h JOIN #a");

    for (const text of [":bob!u@h PRIVMSG #a :hi", ":claude!u@h PART #b", ":x KICK #b claude"]) {
      expect(stepState(state, lineOf(text))).toStrictEqual({ changes: [], next: state });
      expect(stepState(state, lineOf(text)).next).toBe(state);
    }
  });

  it("CONN-3: the nick in 001 is the truth, even when it was not the one asked for", () => {
    expect(replay(":ircd 001 renamed :Welcome").self).toBe("renamed");
  });

  it("CONN-3: a later NICK from the Ircd is the truth too", () => {
    expect(replay(session, ":claude!u@h NICK Guest123").self).toBe("Guest123");
  });
});

describe("JOIN, PART, and KICK naming several Channels", () => {
  it("joins each Channel a JOIN names", () => {
    expect(changesOf(session, ":claude!u@h JOIN #a,#b").slice(1)).toStrictEqual([
      { _tag: "Joined", channel: "#a" },
      { _tag: "Joined", channel: "#b" },
    ]);
  });

  it("leaves each Channel a PART names, and only those Self is in", () => {
    const { changes, state } = run(
      session,
      ":claude!u@h JOIN #a,#b,#c",
      ":claude!u@h PART #a,#c,#d :bye"
    );

    expect(namesOf(state)).toStrictEqual(["#b"]);
    expect(changes.filter(({ _tag }) => _tag === "Parted")).toStrictEqual([
      { _tag: "Parted", channel: "#a" },
      { _tag: "Parted", channel: "#c" },
    ]);
  });

  it("finds no Channel in an empty name", () => {
    expect(namesOf(replay(session, ":claude!u@h JOIN #a,,#b", ":claude!u@h JOIN :"))).toStrictEqual(
      ["#a", "#b"]
    );
  });

  it("pairs a KICK's Channels and Users in order", () => {
    const state = replay(
      session,
      ":claude!u@h JOIN #a,#b,#c",
      ":op!u@h KICK #a,#b,#c bob,claude,claude :out"
    );

    expect(namesOf(state)).toStrictEqual(["#a"]);
  });

  it("kicks every User a KICK names from its one Channel", () => {
    expect(
      changesOf(session, ":claude!u@h JOIN #a", ":op!u@h KICK #a bob,claude :out").at(-1)
    ).toStrictEqual({ _tag: "Kicked", by: "op", channel: "#a", reason: "out" });
  });

  it("finds no kick in a User with no Channel to pair with", () => {
    expect(
      namesOf(replay(session, ":claude!u@h JOIN #a", ":op!u@h KICK #b,#c bob,carol,claude"))
    ).toStrictEqual(["#a"]);
  });
});

describe("LIVE-8: a kick of Self", () => {
  it("is visible as well as leaving the Channel", () => {
    const { changes, state } = run(session, ":claude!u@h JOIN #a", ":op!u@h KICK #a claude :out");

    expect(namesOf(state)).toStrictEqual([]);
    expect(changes.at(-1)).toStrictEqual({
      _tag: "Kicked",
      by: "op",
      channel: "#a",
      reason: "out",
    });
  });

  it("is not seen for a kick of someone else", () => {
    expect(changesOf(session, ":claude!u@h JOIN #a", ":op!u@h KICK #a master :out")).toHaveLength(
      2
    );
  });

  it("is not seen from a Channel Self is not in", () => {
    expect(changesOf(session, ":op!u@h KICK #a claude :out")).toHaveLength(1);
  });

  it("follows Self through a nick change", () => {
    expect(
      changesOf(
        session,
        ":claude!u@h JOIN #a",
        ":claude!u@h NICK claudia",
        ":op KICK #a claudia"
      ).at(-1)?._tag
    ).toBe("Kicked");
  });

  it("is not a part", () => {
    expect(changesOf(session, ":claude!u@h JOIN #a", ":claude!u@h PART #a").at(-1)).toStrictEqual({
      _tag: "Parted",
      channel: "#a",
    });
  });
});

describe("KNOW-3: names compared under the mapping in force", () => {
  it("is rfc1459 until the Ircd says otherwise", () => {
    const state = replay(session, ":claude!u@h JOIN #Dev[1]", ":op!u@h KICK #dev{1} CLAUDE");

    expect(namesOf(state)).toStrictEqual([]);
  });

  it("names a Channel left as Self held it", () => {
    expect(
      changesOf(session, ":claude!u@h JOIN #Dev[1]", ":claude!u@h PART #dev{1}").at(-1)
    ).toStrictEqual({ _tag: "Parted", channel: "#Dev[1]" });
  });

  it.each([
    ["ascii", "#a[~]", "#A[~]", "#a{~}"],
    ["rfc1459", "#a[~]", "#a{^}", "#A{~|"],
    ["rfc1459-strict", "#a[~]", "#a{~}", "#a{^}"],
    ["strict-rfc1459", "#a[~]", "#a{~}", "#a{^}"],
    ["precis", "#a[~]", "#A[~]", "#a{~}"],
  ])("CASEMAPPING=%s takes %s to %s, and not to %s", (mapping, name, same, other) => {
    const state = replay(
      session,
      `:x 005 claude CASEMAPPING=${mapping} :ok`,
      `:claude JOIN ${name}`
    );

    expect(channelOf(state, same)?.name).toBe(name);
    expect(channelOf(state, other)).toBeUndefined();
  });

  it("finds the Channels Self is in under a mapping that arrives later", () => {
    const state = replay(session, ":claude JOIN #a[1]", ":x 005 claude CASEMAPPING=ascii :ok");

    expect(channelOf(state, "#A[1]")?.name).toBe("#a[1]");
    expect(channelOf(state, "#a{1}")).toBeUndefined();
  });

  it("folds as the mapping says", () => {
    expect(casefold("rfc1459", "#IIRC[\\]~")).toBe("#iirc{|}^");
    expect(casefold("ascii", "#IIRC[\\]~")).toBe("#iirc[\\]~");
  });
});

const isupportOf = (...lines: readonly string[]) => replay(session, ...lines).isupport;

const nickLengthOf = (...lines: readonly string[]) => isupportOf(...lines).nickLength;

describe("KNOW-2: RPL_ISUPPORT", () => {
  it("gives a Network that sends no token `CASEMAPPING=rfc1459`, `PREFIX=(ov)@+` and `CHANMODES=beI,k,l`", () => {
    expect(isupportOf()).toStrictEqual({
      casemapping: "rfc1459",
      modes: { always: "k", flags: "", list: "beI", prefix: "ov", whenSet: "l" },
      nickLength: undefined,
    });
  });

  it("reads every group of `CHANMODES` and the letters of `PREFIX`, prose and all", () => {
    expect(
      isupportOf(":x 005 claude CHANMODES=beIq,k,flj,CFLMPQcgimnprstz PREFIX=(qaohv)~&@%+ :ok")
        .modes
    ).toStrictEqual({
      always: "k",
      flags: "CFLMPQcgimnprstz",
      list: "beIq",
      prefix: "qaohv",
      whenSet: "flj",
    });
  });

  it("`PREFIX=` means no prefixes, which differs from no token", () => {
    expect(isupportOf(":x 005 claude PREFIX= :ok").modes.prefix).toBe("");
    expect(isupportOf(":x 005 claude PREFIX :ok").modes.prefix).toBe("");
  });

  it("a `CHANMODES` short of groups has none of the missing kinds", () => {
    expect(isupportOf(":x 005 claude CHANMODES=b :ok").modes).toMatchObject({
      always: "",
      flags: "",
      whenSet: "",
    });
  });

  it("`-TOKEN` brings back the default", () => {
    expect(
      isupportOf(
        ":x 005 claude PREFIX=(qo)~@ CHANMODES=b,,,k CASEMAPPING=ascii :ok",
        ":x 005 claude -PREFIX -CHANMODES -CASEMAPPING :ok"
      )
    ).toStrictEqual(isupportOf());
  });

  it("leaves what an `RPL_ISUPPORT` does not mention as it was", () => {
    expect(
      isupportOf(":x 005 claude CHANMODES=b,k,l, :ok", ":x 005 claude PREFIXES=x :ok").modes
    ).toMatchObject({ list: "b", prefix: "ov" });
  });

  it("says what changed, and nothing when nothing did", () => {
    const { changes } = run(
      session,
      ":x 005 claude NICKLEN=30 :ok",
      ":x 005 claude NICKLEN=30 :ok"
    );

    expect(changes.slice(1)).toStrictEqual([
      { _tag: "IsupportChanged", isupport: { ...initialState.isupport, nickLength: 30 } },
    ]);
  });
});

describe("CONN-4: NICKLEN", () => {
  it("is unknown until the Ircd says", () => {
    expect(nickLengthOf()).toBeUndefined();
  });

  it("is read from RPL_ISUPPORT", () => {
    expect(nickLengthOf(":ircd 005 claude CHANTYPES=# NICKLEN=30 :are supported")).toBe(30);
  });

  it("finds a token in the last parameter, for an Ircd that sends no text", () => {
    expect(nickLengthOf(":ircd 005 claude NICKLEN=16")).toBe(16);
  });

  it("keeps what an earlier 005 said", () => {
    expect(nickLengthOf(":ircd 005 claude NICKLEN=30 :ok", ":ircd 005 claude MODES=3 :ok")).toBe(
      30
    );
  });

  it("lets a later 005 change it, or remove it", () => {
    expect(nickLengthOf(":ircd 005 claude NICKLEN=30 :ok", ":ircd 005 claude NICKLEN=9 :ok")).toBe(
      9
    );
    expect(
      nickLengthOf(":ircd 005 claude NICKLEN=30 :ok", ":ircd 005 claude -NICKLEN :ok")
    ).toBeUndefined();
  });

  it.each(["NICKLEN=", "NICKLEN", "NICKLEN=0", "NICKLEN=-1", "NICKLEN=ten", "NICKLEN=1e9"])(
    "ignores %s, which gives no usable limit",
    (token) => {
      expect(nickLengthOf(`:ircd 005 claude ${token} :ok`)).toBeUndefined();
    }
  );
});

describe("LIVE-7: JOIN failures", () => {
  it.each([
    "403",
    "405",
    "407",
    "437",
    "471",
    "473",
    "474",
    "475",
    "476",
    "477",
    "479",
    "489",
    "520",
  ])("says %s refused its Channel", (numeric) => {
    expect(changesOf(session, `:ircd ${numeric} claude #a :No`).at(-1)).toStrictEqual({
      _tag: "JoinRefused",
      channel: "#a",
      numeric,
      text: "No",
    });
  });

  it("finds the Channel of a `476` sent without `<client>`, as RFC 2812 has it", () => {
    expect(changesOf(":ircd 476 #a :Bad Channel Mask")).toStrictEqual([
      { _tag: "JoinRefused", channel: "#a", numeric: "476", text: "Bad Channel Mask" },
    ]);
  });

  it("holds nothing, so a flood of them costs nothing", () => {
    const state = replay(session);

    expect(stepState(state, lineOf(":ircd 474 claude #a :Banned")).next).toBe(state);
  });
});

describe("KNOW-6: Channel keys", () => {
  const joined = [session, ":claude!u@h JOIN #a"];

  it("follows the last `k` of a `MODE` on a Channel Self is in", () => {
    const { changes, state } = run(...joined, ":op MODE #A +ok bob sesame");

    expect(changes.at(-1)).toStrictEqual({
      _tag: "KeySet",
      channel: "#A",
      key: "sesame",
      param: 3,
    });
    expect(channelOf(state, "#a")?.key).toBe("sesame");
  });

  it("clears it with `-k`, whether or not the key comes with it", () => {
    for (const mode of ["-k", "-k sesame"]) {
      const { changes, state } = run(...joined, ":op MODE #a +k sesame", `:op MODE #a ${mode}`);

      expect(changes.at(-1)).toStrictEqual({ _tag: "KeyCleared", channel: "#a" });
      expect(channelOf(state, "#a")?.key).toBeUndefined();
    }
  });

  it("stores no key shown as `*`, which is hidden", () => {
    expect(changesOf(...joined, ":op MODE #a +k *")).toHaveLength(2);
  });

  it("reads a `MODE` by the Network's own `PREFIX`", () => {
    expect(
      changesOf(...joined, ":x 005 claude PREFIX=(qo)~@ :ok", ":op MODE #a +qk bob other").at(-1)
    ).toStrictEqual({ _tag: "KeySet", channel: "#a", key: "other", param: 3 });
  });

  it("says nothing for a `MODE` that does not add up, or on a Channel Self is not in", () => {
    expect(changesOf(...joined, ":op MODE #a +ok sesame", ":op MODE #b +k sesame")).toHaveLength(2);
  });
});

describe("HOST-1: nothing a Network sends grows a Session's state without bound", () => {
  it("holds at most 1024 Channels, dropping the oldest", () => {
    let state = replay(session);

    for (let index = 0; index < 3000; index += 1) {
      state = stepState(state, lineOf(`:claude!u@h JOIN #made-up-${index}`)).next;
    }

    expect(state.channels.size).toBe(1024);
    expect(namesOf(state).at(-1)).toBe("#made-up-2999");
    expect(namesOf(state)[0]).toBe("#made-up-1976");
  });
});

describe(messageOf, () => {
  it("reads a Message from a Channel", () => {
    expect(messageOf(lineOf(":master!~u@host PRIVMSG #iirc :hi there"))).toStrictEqual({
      kind: "PRIVMSG",
      sender: "master",
      target: "#iirc",
      text: "hi there",
    });
  });

  it("attributes a Line with no source to the given sender", () => {
    expect(messageOf(lineOf("PRIVMSG master :hi"), "claude")).toMatchObject({ sender: "claude" });
  });

  it.each(["PING :abc", ":a PRIVMSG #a", "PRIVMSG #a :no sender"])(
    "finds no Message in %j",
    (text) => {
      expect(messageOf(lineOf(text))).toBeUndefined();
    }
  );
});
