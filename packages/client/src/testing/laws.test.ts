import { describe, expect, it } from "vitest";

import { CapName, FeatureName } from "../ids.ts";
import { deactivates, inert, refines, replays } from "./laws.ts";
import type { Subject } from "./laws.ts";
import { across, configured, joined, registered } from "./preludes.ts";
import { failure, toy } from "./test-clients.ts";
import type { Flaws, ToyState } from "./test-clients.ts";

const base = configured();

const features = [
  { name: FeatureName.make("multi-prefix"), needs: { caps: [CapName.make("multi-prefix")] } },
  { name: FeatureName.make("server-time"), needs: { caps: [CapName.make("server-time")] } },
];

const subject = (flaws: Flaws = {}): Subject<ToyState> => ({
  client: toy(flaws),
  configuration: base,
  features,
  transcript: (caps) =>
    `${registered(base, { offered: caps })}${joined(base, "#iirc", ["@peer", "+voiced"])}`,
});

const after = () => "+1s\n<< :other!u@irc.test JOIN #iirc\n";

describe(across, () => {
  it("gives none, each cap alone, and every pair", () => {
    expect(across(["a", "b", "c"])).toStrictEqual([
      [],
      ["a"],
      ["b"],
      ["c"],
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ]);
    expect(across([])).toStrictEqual([[]]);
  });
});

describe("the four laws, kept", () => {
  it.each([
    [
      "inert",
      () => {
        inert(subject());
      },
    ],
    [
      "refines",
      () => {
        refines(subject());
      },
    ],
    [
      "replays",
      () => {
        replays(subject());
      },
    ],
    [
      "deactivates",
      () => {
        deactivates(subject(), { after });
      },
    ],
  ])("%s holds for the toy Client", (_law, run) => {
    expect(failure(run)).toBe("it held");
  });
});

describe("the four laws, broken", () => {
  it("inert catches a Feature that is off yet changes what the Client does", () => {
    expect(
      failure(() => {
        inert(subject({ declineShows: true }));
      })
    ).toMatch(
      /^LawBrokenError: inert: multi-prefix is off with no caps, yet declining it changed what the Client did/u
    );
  });

  it("refines catches a fact that more caps know less well", () => {
    expect(
      failure(() => {
        refines(subject({ forgetsWithCaps: true }));
      })
    ).toBe(
      "LawBrokenError: refines: known.channels.get(#iirc).members.get(iirc).prefixes was Partial with no caps, but Unknown with multi-prefix"
    );
  });

  it("replays catches a Client that does not replay", () => {
    let calls = 0;
    const client = toy();

    const drifting: Subject<ToyState> = {
      ...subject(),
      client: {
        ...client,
        step: (state: typeof client.initial, input: Parameters<typeof client.step>[1]) => {
          calls += 1;

          return calls === 2
            ? { ...client.step(state, input), outputs: [] }
            : client.step(state, input);
        },
      },
    };

    expect(
      failure(() => {
        replays(drifting);
      })
    ).toMatch(
      /^ReplayMismatchError: step 2 \(Opened at 0ms\) does not replay exactly: its outputs differ/u
    );
  });

  it("deactivates catches a fact still known after its cap is deleted", () => {
    expect(
      failure(() => {
        deactivates(subject({ keepsAfterDel: true }), { after });
      })
    ).toMatch(
      /^LawBrokenError: deactivates: after CAP DEL :multi-prefix from multi-prefix, known\.channels\.get\(#iirc\)\.members\.get\(iirc\)\.prefixes is \{"_tag":"Known"/u
    );
  });
});
