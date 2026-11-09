import { CredentialName } from "@iirc/protocol/line";
import { HashSet } from "effect";
import { describe, expect, it } from "vitest";

import ergoFeatures from "../../../../fixtures/transcripts/ergo/first-features.irc?raw";
import ergoFloor from "../../../../fixtures/transcripts/ergo/floor.irc?raw";
import ngircdFeatures from "../../../../fixtures/transcripts/ngircd/first-features.irc?raw";
import ngircdFloor from "../../../../fixtures/transcripts/ngircd/floor.irc?raw";
import type { Client } from "../client.ts";
import { ConnectionId } from "../ids.ts";
import type { Input } from "../input.ts";
import type { Output } from "../output.ts";
import { canonical, impurity } from "./plain.ts";
import { play, replay } from "./play.ts";
import { configured, registered } from "./preludes.ts";
import { failure, scriptedClient, toy } from "./test-clients.ts";
import type { ToyState } from "./test-clients.ts";

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
          transcript: registered(base, { offered: ["multi-prefix"] }),
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
      /^ReplayMismatchError: step 1 \(Configured at 0ms\) does not replay exactly: its inspection differ/u
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

describe("exact replay against snapshots", () => {
  it("catches a Client that reuses its outputs array and empties it on replay", () => {
    const shared: Output[] = [];
    let calls = 0;

    const reusing: Client<number> = {
      initial: 0,
      inspect: () => toy().inspect(toy().initial),
      known: () => toy().known(toy().initial),
      step: (state) => {
        calls += 1;
        shared.length = 0;

        if (calls === 1) {
          shared.push({ _tag: "Hangup", connection: ConnectionId.make(1) });
        }

        return { news: [], outputs: shared, state };
      },
    };

    expect(
      failure(() => play(reusing, { configuration: base, transcript: "!! configure\n-> hangup\n" }))
    ).toMatch(
      /^ReplayMismatchError: step 1 \(Configured at 0ms\) does not replay exactly: its outputs differ/u
    );
  });
});

const throwing = (): never => {
  throw new Error("a getter ran");
};

describe("plain data in collections", () => {
  it.each([
    [
      "an array with a function property",
      () => Object.assign([1], { next: () => 1 }),
      'state has a property "next"',
    ],
    [
      "a Map with a property",
      () => Object.assign(new Map(), { when: new Box() }),
      'state is a Map with a property "when"',
    ],
    [
      "a Set with a property",
      () => Object.assign(new Set(), { size2: 1 }),
      'state is a Set with a property "size2"',
    ],
    [
      "an array with an indexed getter",
      () => Object.defineProperty([1], 0, { enumerable: true, get: throwing }),
      "state[0] is a getter",
    ],
    ["an array with a hole", () => Object.assign([], { length: 1 }), "state has a hole at [0]"],
  ] satisfies readonly (readonly [string, () => object, string])[])(
    "finds %s, and runs no getter",
    (_name, make: () => object, found) => {
      expect(impurity(make())).toBe(found);
    }
  );

  it("writes a collection's extra properties, and runs no getter", () => {
    expect(canonical(Object.assign([1], { x: 2 }))).not.toBe(canonical([1]));
    expect(canonical(Object.assign(new Map([["a", 1]]), { x: 2 }))).not.toBe(
      canonical(new Map([["a", 1]]))
    );
    expect(canonical(Object.defineProperty({}, "value", { enumerable: true, get: throwing }))).toBe(
      '{"value":getter}'
    );
  });
});

const changing = (change: (input: Input, call: number) => void): Client<ToyState> => {
  const client = toy();
  let calls = 0;

  return {
    ...client,
    step: (state, input) => {
      calls += 1;
      change(input, calls);

      return client.step(state, input);
    },
  };
};

describe("inputs the Client changes", () => {
  it("fails a Client that overwrites a Line's bytes", () => {
    const filling = changing((input) => {
      if (input._tag === "Received") {
        input.bytes.fill(88);
      }
    });

    expect(
      failure(() => replay(filling, { configuration: base, transcript: registered(base) }))
    ).toMatch(
      /^ReplayMismatchError: step 3 \(<< :irc\.test 421 \* CAP :Unknown command\) changed the input it was given/u
    );
  });

  it("fails a Client that changes the Configuration it was given", () => {
    const renaming = changing((input) => {
      if (input._tag === "Configured") {
        Reflect.set(input.configuration, "realname", "changed");
      }
    });

    expect(
      failure(() => replay(renaming, { configuration: base, transcript: registered(base) }))
    ).toMatch(/^ReplayMismatchError: step 1 \(Configured at 0ms\) changed the input it was given/u);
  });

  it("fails a Client that changes its input only when replayed", () => {
    const late = changing((input, call) => {
      if (call > 1 && input._tag === "Configured") {
        Reflect.set(input.configuration, "enabled", false);
      }
    });

    expect(failure(() => play(late, { configuration: base, transcript: once }))).toMatch(
      /^ReplayMismatchError: step 1 \(Configured at 0ms\) changed the input it was given/u
    );
  });
});

describe("snapshots", () => {
  it("hold a short hash of each part, not its text", () => {
    const played = play(toy(), { configuration: base, transcript: registered(base) });

    const hashes = played.snapshots.flatMap((each) => [
      each.state,
      each.outputs,
      each.news,
      each.inspection,
      each.knowledge,
    ]);

    expect(hashes.every((hash) => hash.length <= 16)).toBeTruthy();
  });

  it("still show a readable diff of the part that differs", () => {
    // oxlint-disable-next-line no-restricted-properties -- A Client that is not deterministic, on purpose.
    const random = keeping(() => ({ roll: Math.random() }));

    expect(failure(() => play(random, { configuration: base, transcript: once }))).toMatch(
      /its state differ\nplayed {3}…\{"roll":0\.\d+\}…\nreplayed …\{"roll":0\.\d+\}…$/u
    );
  });
});
