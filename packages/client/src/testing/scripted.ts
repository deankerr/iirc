import type { Client, Inspection } from "../client.ts";
import type { Input } from "../input.ts";
import type { Knowledge } from "../known.ts";
import type { News } from "../news.ts";
import type { Output } from "../output.ts";

/** One step of a script: the kind of input it waits for, and what it answers with. */
export interface Scripted {
  readonly when: Input["_tag"];
  readonly outputs?: readonly Output[];
  readonly news?: readonly News[];
}

/** How far through its script a scripted Client is. */
export interface ScriptedState {
  readonly next: number;
}

const knowsNothing: Knowledge = {
  casemapping: "rfc1459",
  channels: new Map(),
  self: undefined,
  session: { _tag: "Offline", since: undefined },
  users: new Map(),
};

const inspection: Inspection = {
  caps: { enabled: new Set(), offered: new Map() },
  connection: undefined,
  features: [],
  isupport: new Map(),
  states: {},
  timers: new Map(),
};

/**
 * A stand-in Client for testing the Runtime. It answers each input that matches the
 * next step of its script with that step's outputs and news, and ignores anything
 * else, as the real Client ignores an input that makes no sense now.
 * @param script - The steps, in the order they are expected.
 * @returns A Client that follows the script.
 */
export const scripted = (script: readonly Scripted[]): Client<ScriptedState> => ({
  initial: { next: 0 },
  inspect: () => inspection,
  known: () => knowsNothing,
  step: (state, input) => {
    const expected = script[state.next];

    if (expected?.when !== input._tag) {
      return {
        news: [{ _tag: "Ignored", reason: { _tag: "NotNow", input: input._tag } }],
        outputs: [],
        state,
      };
    }

    return {
      news: expected.news ?? [],
      outputs: expected.outputs ?? [],
      state: { next: state.next + 1 },
    };
  },
});
