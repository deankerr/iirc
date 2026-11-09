import { describe, expect, it } from "vitest";

import { CapName, FeatureName } from "../ids.ts";
import { deactivates, inert, refines, replays } from "./laws.ts";
import type { Subject } from "./laws.ts";
import { across, configured, joined, registered } from "./preludes.ts";
import { failure, sharingViews, toy } from "./test-clients.ts";
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

describe("the laws check contents, not only ranks", () => {
  it("refines catches a set that loses what the floor knew", () => {
    expect(
      failure(() => {
        refines(subject({ losesWithCaps: true }));
      })
    ).toBe(
      'LawBrokenError: refines: known.channels.get(#iirc).members.get(peer).prefixes lost "o" from no caps to multi-prefix'
    );
  });

  it("refines catches a known value that changes", () => {
    expect(
      failure(() => {
        refines(subject({ changesWithMore: true }));
      })
    ).toBe(
      'LawBrokenError: refines: known.channels.get(#iirc).members.get(iirc).prefixes was known as {}, but as {"v"} from multi-prefix to multi-prefix server-time'
    );
  });

  it("deactivates catches Knowledge that changes outside any fact", () => {
    expect(
      failure(() => {
        deactivates(subject({ remapsAfterDel: true }), { after });
      })
    ).toBe(
      'LawBrokenError: deactivates: after CAP DEL :multi-prefix from multi-prefix, known.casemapping is "ascii", but never having had it gives "rfc1459"'
    );
  });
});

const shared = (flaws: Flaws): Subject<ToyState> => ({
  ...subject(flaws),
  client: sharingViews(toy(flaws)),
});

describe("the laws copy each view as they read it", () => {
  it("holds for a Client that shares its views but keeps every law", () => {
    expect(
      failure(() => {
        refines(shared({}));
      })
    ).toBe("it held");
    expect(
      failure(() => {
        deactivates(shared({}), { after });
      })
    ).toBe("it held");
  });

  it("refines still catches a lost set when Knowledge is one shared object", () => {
    expect(
      failure(() => {
        refines(shared({ losesWithCaps: true }));
      })
    ).toMatch(/^LawBrokenError: refines: .* lost "o"/u);
  });

  it("deactivates still catches a changed casemapping when Knowledge is one shared object", () => {
    expect(
      failure(() => {
        deactivates(shared({ remapsAfterDel: true }), { after });
      })
    ).toMatch(/^LawBrokenError: deactivates: .*known\.casemapping is "ascii"/u);
  });

  it("inert catches a declined Feature that changes the Inspection, when Inspection is one shared object", () => {
    expect(
      failure(() => {
        inert(shared({ inspectsDeclined: true }));
      })
    ).toMatch(
      /^LawBrokenError: inert: multi-prefix is off with no caps, yet declining it changed what the Client did/u
    );
  });
});
