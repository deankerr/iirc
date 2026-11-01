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
    expect(replay("001", "NICK", "JOIN", "PART", "KICK")).toStrictEqual(initialState);
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
