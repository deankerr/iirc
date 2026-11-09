import { CredentialName } from "@iirc/protocol/line";
import { HashSet } from "effect";
import { describe, expect, it } from "vitest";

import ergoFeatures from "../../../../fixtures/transcripts/ergo/first-features.irc?raw";
import ergoFloor from "../../../../fixtures/transcripts/ergo/floor.irc?raw";
import ngircdFeatures from "../../../../fixtures/transcripts/ngircd/first-features.irc?raw";
import ngircdFloor from "../../../../fixtures/transcripts/ngircd/floor.irc?raw";
import type { Client } from "../client.ts";
import { ConnectionId } from "../ids.ts";
import { impurity } from "./plain.ts";
import { play, replay } from "./play.ts";
import { configured, registered } from "./preludes.ts";
import { failure, scriptedClient, toy } from "./test-clients.ts";

const base = configured();

// A Client that keeps whatever `make` gives it as its State, and dials once.
const keeping = <State>(
  make: (previous: State | undefined) => State
): Client<State | undefined> => ({
  initial: undefined,
  inspect: () => toy().inspect(toy().initial),
  known: () => toy().known(toy().initial),
  step: (state, input) => ({
    news: [],
    outputs:
      input._tag === "Configured" && state === undefined
        ? [{ _tag: "Dial", connection: ConnectionId.make(1), ircd: input.configuration.ircds[0] }]
        : [],
    state: make(state),
  }),
});

const once = "!! configure\n-> dial irc.test:6697 tls\n";

class Box {
  readonly value = 1;
}

describe("exact replay, after every play", () => {
  it("passes a Client that is a pure fold of plain data", () => {
    expect(
      failure(() =>
        play(toy(), {
          configuration: base,
          transcript: registered(base, { caps: ["multi-prefix"] }),
        })
      )
    ).toBe("it held");
  });

  it("catches a Client that reads Math.random", () => {
    // oxlint-disable-next-line no-restricted-properties -- A Client that is not deterministic, on purpose.
    const random = keeping(() => ({ roll: Math.random() }));

    expect(failure(() => play(random, { configuration: base, transcript: once }))).toMatch(
      /^ReplayMismatchError: step 1 \(Configured at 0ms\) does not replay exactly: its state differ/u
    );
  });

  it("catches a Client whose outputs depend on how often it was called", () => {
    let calls = 0;

    const counting: Client<number> = {
      initial: 0,
      inspect: () => toy().inspect(toy().initial),
      known: () => toy().known(toy().initial),
      step: (state) => {
        calls += 1;

        return {
          news: [],
          outputs: calls > 1 ? [] : [{ _tag: "Hangup", connection: ConnectionId.make(1) }],
          state,
        };
      },
    };

    expect(
      failure(() =>
        play(counting, { configuration: base, transcript: "!! configure\n-> hangup\n" })
      )
    ).toMatch(/its outputs differ/u);
  });

  it("catches an Inspection that does not replay", () => {
    let calls = 0;
    const client = scriptedClient;

    const drifting = {
      ...client,
      inspect: (state: Parameters<typeof client.inspect>[0]) => {
        calls += 1;

        return { ...client.inspect(state), states: { calls: String(calls) } };
      },
    };

    expect(failure(() => play(drifting, { configuration: base, transcript: once }))).toMatch(
      /^ReplayMismatchError: the last inspection does not replay exactly/u
    );
  });

  it.each([
    ["a class instance", () => ({ box: new Box() }), "state.box is an instance of Box"],
    ["a function", () => ({ next: () => 1 }), "state.next is a function"],
    ["a HashSet", () => ({ seen: HashSet.make("a") }), "state.seen is an instance of"],
    [
      "a Uint8Array",
      () => ({ bytes: new Uint8Array(1) }),
      "state.bytes is an instance of Uint8Array",
    ],
    ["a bigint", () => ({ count: 1n }), "state.count is a bigint"],
    [
      "a Map holding a class instance",
      () => ({ seen: new Map([["a", new Box()]]) }),
      'state.seen.get("a") is an instance of Box',
    ],
  ] satisfies readonly (readonly [string, () => object, string])[])(
    "catches a State holding %s",
    (_name, make: () => object, found) => {
      expect(
        failure(() => play(keeping(make), { configuration: base, transcript: once }))
      ).toContain(
        `ReplayMismatchError: State must be plain data, but after step 1 (Configured at 0ms) ${found}`
      );
    }
  );

  it("catches a Client that changes the state it was given", () => {
    const mutating = keeping<{ seen: string[] }>((previous) => {
      const state = previous ?? { seen: [] };
      state.seen.push("again");

      return state;
    });

    expect(
      failure(() => play(mutating, { configuration: base, transcript: `${once}!! retry\n` }))
    ).toBe(
      "ReplayMismatchError: step 2 changed the state it was given, which a reducer must never do"
    );
  });
});

describe(impurity, () => {
  it("passes plain data, and names a cycle, a getter, and a symbol key", () => {
    const cycle = new Map<string, unknown>();
    cycle.set("self", cycle);

    expect(
      impurity({
        a: [1, "b", true, null, undefined],
        m: new Map([[1, new Set(["x"])]]),
        o: Object.fromEntries([]),
      })
    ).toBeUndefined();
    expect(impurity(cycle)).toBe('state.get("self") is a cycle');
    expect(
      impurity({
        get value() {
          return 1;
        },
      })
    ).toBe("state.value is a getter");
    expect(impurity({ [Symbol("s")]: 1 })).toBe("state has a symbol key");
  });
});

const fixtures = [
  [
    "ergo/first-features",
    ergoFeatures,
    configured({
      ircds: [{ host: "ergo.test", port: 6697, tls: true }],
      login: {
        _tag: "Sasl",
        account: "iirc",
        credential: CredentialName.make("iirc"),
        required: true,
      },
      realname: "iirc transcript spike",
    }),
  ],
  [
    "ergo/floor",
    ergoFloor,
    configured({
      ircds: [{ host: "ergo.test", port: 6667, tls: false }],
      realname: "iirc transcript spike",
    }),
  ],
  [
    "ngircd/first-features",
    ngircdFeatures,
    configured({
      ircds: [{ host: "ngircd.test", port: 6667, tls: false }],
      realname: "iirc transcript spike",
    }),
  ],
  [
    "ngircd/floor",
    ngircdFloor,
    configured({
      ircds: [{ host: "ngircd.test", port: 6667, tls: false }],
      realname: "iirc transcript spike",
    }),
  ],
] as const;

describe("the recorded fixtures, replayed", () => {
  it.each(fixtures)(
    "%s replays through the scripted Client, which ignores most of it",
    (_name, transcript, configuration) => {
      const played = replay(scriptedClient, { configuration, transcript });

      expect(played.inputs.length).toBeGreaterThan(30);
      expect(played.ignored.length).toBeGreaterThan(25);
      expect(played.transcript).toContain("?? ignored NotNow Received");
    }
  );

  it.each(fixtures)(
    "%s replays through the toy Client, which registers",
    (_name, transcript, configuration) => {
      const played = replay(toy(), { configuration, transcript });

      expect(toy().inspect(played.state).states).toStrictEqual({ connection: "Idle" });
      expect(played.transcript).toContain("?? session-began iirc_");
      expect(played.transcript).toContain("?? session-ended Closed Ended");
    }
  );
});
