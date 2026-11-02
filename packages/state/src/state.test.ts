import type { Line } from "@iirc/protocol/line";
import { parseLine } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import { initialState, messageOf, reduce } from "./state.ts";

const lineOf = (text: string): Line => {
  const parsed = parseLine(text);

  if (parsed._tag === "Unparseable") {
    throw new Error(`Expected a Line from ${text}`);
  }

  return parsed.line;
};

const replay = (...lines: readonly string[]) => {
  let state = initialState;

  for (const text of lines) {
    state = reduce(state, lineOf(text));
  }

  return state;
};

describe(reduce, () => {
  it("learns Self from the welcome", () => {
    expect(replay(":ircd 001 claude :Welcome").self).toBe("claude");
  });

  it("takes Self from the first welcome of a Session, and no other", () => {
    expect(replay(":ircd 001 claude :Hi", ":x 001 mallory :Hi").self).toBe("claude");
  });

  it("learns nothing from a welcome that names nobody", () => {
    expect(replay(":ircd 001", ":ircd 001 claude :Hi").self).toBe("claude");
  });

  it("follows Self through a nick change", () => {
    expect(replay(":ircd 001 claude :Hi", ":claude!u@h NICK :claudia").self).toBe("claudia");
  });

  it("ignores another User's nick change", () => {
    expect(replay(":ircd 001 claude :Hi", ":master!u@h NICK :boss").self).toBe("claude");
  });

  it("tracks the Channels Self is in", () => {
    const state = replay(
      ":ircd 001 claude :Hi",
      ":claude!u@h JOIN #a",
      ":claude!u@h JOIN #b",
      ":master!u@h JOIN #c",
      ":claude!u@h PART #a",
      ":master!u@h KICK #b claude :bye"
    );

    expect(state.channels).toStrictEqual([]);
  });

  it("survives Lines missing their parameters", () => {
    expect(replay("001", "NICK", "JOIN", "PART", "KICK", "005", "471", "437")).toStrictEqual(
      initialState
    );
  });

  it("CONN-3: the nick in 001 is the truth, even when it was not the one asked for", () => {
    expect(replay(":ircd 001 renamed :Welcome").self).toBe("renamed");
  });

  it("CONN-3: a later NICK from the Ircd is the truth too", () => {
    expect(replay(":ircd 001 claude :Hi", ":claude!u@h NICK Guest123").self).toBe("Guest123");
  });
});

describe("LIVE-8: a kick of Self", () => {
  const session = ":ircd 001 claude :Hi";

  it("is visible as well as leaving the Channel", () => {
    const state = replay(session, ":claude!u@h JOIN #a", ":op!u@h KICK #a claude :out");

    expect(state.channels).toStrictEqual([]);
    expect(state.kicked).toStrictEqual(["#a"]);
  });

  it("is not recorded for a kick of someone else", () => {
    expect(replay(session, ":op!u@h KICK #a master :out").kicked).toStrictEqual([]);
  });

  it("is listed once, however often it happens", () => {
    expect(
      replay(session, ":op!u@h KICK #a claude :one", ":op!u@h KICK #a claude :two").kicked
    ).toStrictEqual(["#a"]);
  });

  it("ends when Self is back in the Channel", () => {
    expect(
      replay(session, ":op!u@h KICK #a claude :out", ":claude!u@h JOIN #a").kicked
    ).toStrictEqual([]);
  });

  it("does not end when someone else joins", () => {
    expect(
      replay(session, ":op!u@h KICK #a claude :out", ":master!u@h JOIN #a").kicked
    ).toStrictEqual(["#a"]);
  });

  it("follows Self through a nick change", () => {
    expect(
      replay(session, ":claude!u@h NICK claudia", ":op!u@h KICK #a claudia :out").kicked
    ).toStrictEqual(["#a"]);
  });

  it("is not a parted Channel", () => {
    expect(replay(session, ":claude!u@h JOIN #a", ":claude!u@h PART #a").kicked).toStrictEqual([]);
  });
});

describe("CONN-4: NICKLEN", () => {
  const session = ":ircd 001 claude :Hi";

  it("is unknown until the Ircd says", () => {
    expect(replay(session).nickLength).toBeUndefined();
  });

  it("is read from RPL_ISUPPORT", () => {
    expect(
      replay(session, ":ircd 005 claude CHANTYPES=# NICKLEN=30 :are supported").nickLength
    ).toBe(30);
  });

  it("finds a token in the last parameter, for an Ircd that sends no text", () => {
    expect(replay(session, ":ircd 005 claude NICKLEN=16").nickLength).toBe(16);
  });

  it("keeps what an earlier 005 said", () => {
    expect(
      replay(session, ":ircd 005 claude NICKLEN=30 :ok", ":ircd 005 claude MODES=3 :ok").nickLength
    ).toBe(30);
  });

  it("lets a later 005 change it, or remove it", () => {
    expect(
      replay(session, ":ircd 005 claude NICKLEN=30 :ok", ":ircd 005 claude NICKLEN=9 :ok")
        .nickLength
    ).toBe(9);
    expect(
      replay(session, ":ircd 005 claude NICKLEN=30 :ok", ":ircd 005 claude -NICKLEN :ok").nickLength
    ).toBeUndefined();
  });

  it.each(["NICKLEN=", "NICKLEN", "NICKLEN=0", "NICKLEN=-1", "NICKLEN=ten", "NICKLEN=1e9"])(
    "ignores %s, which gives no usable limit",
    (token) => {
      expect(replay(session, `:ircd 005 claude ${token} :ok`).nickLength).toBeUndefined();
    }
  );

  it("takes the limit from no token but NICKLEN", () => {
    expect(
      replay(session, ":ircd 005 claude CHANNELLEN=50 TOPICLEN=390 :ok").nickLength
    ).toBeUndefined();
  });
});

describe("LIVE-7: JOIN failures", () => {
  const session = ":ircd 001 claude :Hi";

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
  ])("records %s against its Channel", (numeric) => {
    expect(replay(session, `:ircd ${numeric} claude #a :No`).joinFailures.get("#a")).toStrictEqual({
      numeric,
      text: "No",
    });
  });

  it("finds the Channel of a `476` sent without `<client>`, as RFC 2812 has it", () => {
    expect(replay(session, ":ircd 476 #a :Bad Channel Mask").joinFailures.get("#a")).toStrictEqual({
      numeric: "476",
      text: "Bad Channel Mask",
    });
  });

  it("keeps only the latest for a Channel", () => {
    expect(
      replay(
        session,
        ":ircd 474 claude #a :Banned",
        ":ircd 473 claude #a :Invite only"
      ).joinFailures.get("#a")
    ).toStrictEqual({ numeric: "473", text: "Invite only" });
  });

  it("forgets it once Self gets in", () => {
    expect(
      replay(session, ":ircd 473 claude #a :No", ":claude!u@h JOIN #a").joinFailures.size
    ).toBe(0);
  });

  it("keeps it when someone else gets in", () => {
    expect(
      replay(session, ":ircd 473 claude #a :No", ":master!u@h JOIN #a").joinFailures.size
    ).toBe(1);
  });

  it("does not disturb Channels Self is in", () => {
    expect(
      replay(session, ":claude!u@h JOIN #a", ":ircd 473 claude #b :No").channels
    ).toStrictEqual(["#a"]);
  });

  it("does not change the state it was given", () => {
    const before = replay(session);

    reduce(before, lineOf(":ircd 473 claude #a :No"));

    expect(before.joinFailures.size).toBe(0);
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
