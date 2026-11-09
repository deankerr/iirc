/**
 * Strict Transport Security: policies learnt over TLS, upgrades from plaintext, and
 * every dial to a host under a policy made over TLS on its port.
 */
import { CredentialName } from "@iirc/protocol/line";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { StsPolicy } from "../client.ts";
import type { IrcdAddress } from "../configuration.ts";
import { client } from "../core.ts";
import { CapName, ConnectionId, Instant } from "../ids.ts";
import type { Input } from "../input.ts";
import { timers as timersFold } from "../output.ts";
import type { Output, TimerTable } from "../output.ts";
import type { State } from "../state.ts";
import { longestDuration, maxPolicies } from "../sts.ts";
import { configured, epoch, play, registered, replayFresh } from "../testing/index.ts";

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const tls = (host: string, port = 6697): IrcdAddress => ({ host, port, tls: true });
const plain = (host: string, port = 6667): IrcdAddress => ({ host, port, tls: false });

// What the Client sends when a Connection opens.
const opening = lines("== opened", ">> CAP LS 302", ">> NICK iirc", ">> USER iirc 0 * iirc");

const dial = (ircd: IrcdAddress): string =>
  `-> dial ${ircd.host}:${ircd.port}${ircd.tls ? " tls" : ""}\n`;

// A Connection that opens, lists these caps, none of which the Client asks for, and
// registers.
const session = (ircd: IrcdAddress, caps: string): string =>
  dial(ircd) +
  opening +
  lines(`<< :irc.test CAP * LS :${caps}`, ">> CAP END", "<< :irc.test 001 iirc :Welcome");

// Keeps a Session alive for `times` × 50 s, with the Ircd's `PING`s answered.
const chatter = (times: number): string =>
  Array.from({ length: times }, () => lines("+50s", "<< PING :keep", ">> PONG keep")).join("");

const at = (offset: number): Instant => Instant.make(epoch + offset);

const policy = (port: number, duration: number, until: number): StsPolicy => ({
  duration,
  port,
  until: at(until),
});

type Dial = Extract<Output, { readonly _tag: "Dial" }>;

// Where the last `Dial` of a scenario went.
const lastDial = (played: ReturnType<typeof play>): IrcdAddress | undefined =>
  played.steps
    .flatMap((step) => step.outputs)
    .findLast((output): output is Dial => output._tag === "Dial")?.ircd;

const policiesOf = (state: State): ReadonlyMap<string, StsPolicy> => client.inspect(state).policies;

describe("learning a policy over TLS", () => {
  it("learns one from CAP LS, on the port of the Connection, and never asks for the cap", () => {
    const base = configured();

    const played = play(client, {
      configuration: base,
      transcript: registered(base, {
        offered: ["sts=duration=600", "multi-prefix"],
        requested: ["multi-prefix"],
      }),
    });

    expect(policiesOf(played.state)).toStrictEqual(
      new Map([["irc.test", policy(6697, 600, 600_000)]])
    );
  });

  it("learns one from CAP NEW in a Session, and the Session goes on", () => {
    const base = configured();

    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["foo"], requested: [] }),
        "+10s\n<< :irc.test CAP iirc NEW :sts=duration=300\n",
      ],
    });

    expect(policiesOf(played.state)).toStrictEqual(
      new Map([["irc.test", policy(6697, 300, 310_000)]])
    );
    expect(client.known(played.state).session._tag).toBe("Registered");
  });

  it("resets the expiry each time a valid duration comes", () => {
    const base = configured();

    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["sts=duration=600"], requested: [] }),
        "+50s\n<< :irc.test CAP iirc NEW :sts=duration=30\n",
      ],
    });

    expect(policiesOf(played.state)).toStrictEqual(
      new Map([["irc.test", policy(6697, 30, 80_000)]])
    );
  });

  it("removes one with duration=0, so Configuration applies again", () => {
    const base = configured({ ircds: [tls("irc.test"), plain("irc.test")] });

    const played = play(client, {
      configuration: base,
      transcript: [
        "!! configure\n",
        session(tls("irc.test"), "sts=duration=600"),
        "<< :irc.test CAP iirc NEW :sts=duration=0\n",
        lines("== closed Ended", "?? session-ended Closed Ended", "+2s"),
        dial(plain("irc.test")),
      ],
    });

    expect(policiesOf(played.state).size).toBe(0);
  });

  it("ignores a port key over TLS", () => {
    const base = configured({ ircds: [tls("irc.test"), plain("irc.test")] });

    const played = play(client, {
      configuration: base,
      transcript: [
        "!! configure\n",
        session(tls("irc.test"), "sts=port=7000,duration=600"),
        lines("== closed Ended", "+2s"),
        dial(tls("irc.test", 6697)),
      ],
    });

    expect(policiesOf(played.state).get("irc.test")?.port).toBe(6697);
  });

  it("ignores CAP DEL sts", () => {
    const base = configured();

    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["sts=duration=600"], requested: [] }),
        "+1s\n<< :irc.test CAP iirc DEL :sts\n",
      ],
    });

    expect(policiesOf(played.state)).toStrictEqual(
      new Map([["irc.test", policy(6697, 600, 600_000)]])
    );
    expect(client.inspect(played.state).caps.offered.has(CapName.make("sts"))).toBeFalsy();
  });

  it("learns nothing for an IP literal, which is no hostname", () => {
    const base = configured({ ircds: [tls("127.0.0.1"), plain("127.0.0.1")] });

    const played = play(client, {
      configuration: base,
      transcript: [
        "!! configure\n",
        session(tls("127.0.0.1"), "sts=duration=600"),
        lines("== closed Ended", "+2s"),
        dial(plain("127.0.0.1")),
      ],
    });

    expect(policiesOf(played.state).size).toBe(0);
  });

  it("leaves SASL as it was", () => {
    const base = configured({
      login: {
        _tag: "Sasl",
        account: "iirc",
        credential: CredentialName.make("pw"),
        required: true,
      },
    });

    const played = play(client, {
      configuration: base,
      transcript: registered(base, {
        offered: ["sasl=PLAIN", "sts=duration=600"],
        requested: ["sasl"],
      }),
    });

    expect(client.known(played.state).session._tag).toBe("Registered");
    expect(policiesOf(played.state).has("irc.test")).toBeTruthy();
  });
});

// The policies a TLS Connection learns when `CAP LS` offers this.
const learnt = (value: string): ReadonlyMap<string, StsPolicy> => {
  const base = configured();

  return policiesOf(
    play(client, {
      configuration: base,
      transcript: registered(base, { offered: [value], requested: [] }),
    }).state
  );
};

describe("malformed values", () => {
  it.each([
    "sts=duration=abc",
    "sts=duration=-5",
    "sts=duration=+5",
    "sts=duration=1.5",
    "sts=duration=",
    "sts=duration",
    "sts",
    "sts=",
    "sts=port=6697",
    "sts=duration=10,duration=20",
    "sts=duration=10,duration=10",
    "sts=Duration=600",
  ])("learns nothing from %s over TLS", (value) => {
    expect(learnt(value).size).toBe(0);
  });

  it("reads keys in any order, with unknown keys and tokens around them", () => {
    expect(learnt("sts=foo=bar,unknown,,preload,port=7000,duration=600")).toStrictEqual(
      new Map([["irc.test", policy(6697, 600, 600_000)]])
    );
  });

  it("keeps a huge duration as the longest it holds", () => {
    expect(learnt("sts=duration=99999999999999999999999")).toStrictEqual(
      new Map([["irc.test", policy(6697, longestDuration, longestDuration * 1000)]])
    );
  });

  it("keeps a policy when a later value is malformed", () => {
    const base = configured();

    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["sts=duration=600"], requested: [] }),
        "<< :irc.test CAP iirc NEW :sts=duration=abc\n",
        "<< :irc.test CAP iirc NEW :sts=duration=1,duration=0\n",
      ],
    });

    expect(policiesOf(played.state)).toStrictEqual(
      new Map([["irc.test", policy(6697, 600, 600_000)]])
    );
  });

  it.each([
    "sts=port=abc",
    "sts=port=0",
    "sts=port=65536",
    "sts=port=",
    "sts=port",
    "sts=port=6697,port=6698",
    "sts=duration=600",
  ])("does not upgrade on %s over plaintext, and registers", (value) => {
    const base = configured({ ircds: [plain("irc.test")] });

    const played = play(client, {
      configuration: base,
      transcript: ["!! configure\n", session(plain("irc.test"), value)],
    });

    expect(policiesOf(played.state).size).toBe(0);
    expect(client.known(played.state).session._tag).toBe("Registered");
  });
});

describe("upgrading from plaintext", () => {
  it("hangs up at once, sends nothing more, and dials TLS on the port given", () => {
    const base = configured({ ircds: [plain("irc.test"), tls("other.test")] });

    const played = play(client, {
      configuration: base,
      transcript: [
        "!! configure\n",
        dial(plain("irc.test")),
        opening,
        lines(
          "<< :irc.test CAP * LS :multi-prefix sts=port=6697,duration=600",
          "-> hangup",
          "== closed HungUp",
          "?? connection-failed Upgrading 6697"
        ),
        dial(tls("irc.test", 6697)),
      ],
    });

    // A duration over plaintext is ignored.
    expect(policiesOf(played.state).size).toBe(0);
  });

  it("upgrades from the first Line of a CAP LS spread over several", () => {
    const base = configured({ ircds: [plain("irc.test")] });

    const played = play(client, {
      configuration: base,
      transcript: [
        "!! configure\n",
        dial(plain("irc.test")),
        opening,
        lines("<< :irc.test CAP * LS * :sts=port=6697", "-> hangup", "== closed Ended"),
        dial(tls("irc.test")),
      ],
    });

    expect(lastDial(played)).toStrictEqual(tls("irc.test"));
  });

  it("upgrades a Session when CAP NEW gives a port", () => {
    const base = configured({ ircds: [plain("irc.test")] });

    const played = play(client, {
      configuration: base,
      transcript: [
        "!! configure\n",
        session(plain("irc.test"), "foo"),
        lines(
          "+1s",
          "<< :irc.test CAP iirc NEW :sts=port=7000",
          "-> hangup",
          "== closed HungUp",
          "?? session-ended Upgrading 7000"
        ),
        dial(tls("irc.test", 7000)),
      ],
    });

    expect(lastDial(played)).toStrictEqual(tls("irc.test", 7000));
  });

  it("then learns the policy over TLS, and keeps to it", () => {
    const base = configured({ ircds: [plain("irc.test")] });

    const played = play(client, {
      configuration: base,
      transcript: [
        "!! configure\n",
        dial(plain("irc.test")),
        opening,
        lines("<< :irc.test CAP * LS :sts=port=6697", "-> hangup", "== closed HungUp"),
        session(tls("irc.test"), "sts=duration=600"),
        lines("== closed Ended", "+2s"),
        dial(tls("irc.test")),
      ],
    });

    expect(policiesOf(played.state).get("irc.test")?.port).toBe(6697);
  });

  it("upgrades an IP literal too, and keeps no policy for it", () => {
    const base = configured({ ircds: [plain("127.0.0.1")] });

    const played = play(client, {
      configuration: base,
      transcript: [
        "!! configure\n",
        dial(plain("127.0.0.1")),
        opening,
        lines("<< :irc.test CAP * LS :sts=port=6697", "-> hangup", "== closed HungUp"),
        session(tls("127.0.0.1"), "sts=duration=600"),
      ],
    });

    expect(policiesOf(played.state).size).toBe(0);
  });

  it("backs off after the upgrade's TLS fails, never retrying it in plaintext at once", () => {
    const base = configured({ ircds: [plain("irc.test")] });

    const played = play(client, {
      configuration: base,
      transcript: [
        "!! configure\n",
        dial(plain("irc.test")),
        opening,
        lines("<< :irc.test CAP * LS :sts=port=6697", "-> hangup", "== closed HungUp"),
        dial(tls("irc.test")),
        lines("== closed Tls", "?? connection-failed Closed Tls", "+1999ms", "+1ms"),
        // No policy was confirmed over TLS, so Configuration applies, and the Ircd may
        // ask for the upgrade again.
        dial(plain("irc.test")),
      ],
    });

    expect(lastDial(played)).toStrictEqual(plain("irc.test"));
  });
});

describe("dialling under a policy", () => {
  it("dials TLS on the policy's port, whatever Configuration says, matching case and a trailing dot", () => {
    const base = configured({ ircds: [tls("irc.test"), plain("Irc.TEST.", 6668)] });

    const played = play(client, {
      configuration: base,
      transcript: [
        "!! configure\n",
        session(tls("irc.test"), "sts=duration=600"),
        lines("== closed Ended", "+2s"),
        dial(tls("Irc.TEST.", 6697)),
      ],
    });

    expect(lastDial(played)).toStrictEqual(tls("Irc.TEST.", 6697));
  });

  it("retries TLS after a TLS failure, and never dials plaintext", () => {
    const base = configured({ ircds: [tls("irc.test"), plain("irc.test")] });

    const played = play(client, {
      configuration: base,
      transcript: [
        "!! configure\n",
        session(tls("irc.test"), "sts=duration=600"),
        lines("== closed Ended", "+2s"),
        dial(tls("irc.test")),
        lines("== closed Tls", "?? connection-failed Closed Tls", "+4s"),
        dial(tls("irc.test")),
        lines("== closed Tls", "+8s"),
        dial(tls("irc.test")),
        lines("== closed Tls", "+16s"),
        dial(tls("irc.test")),
      ],
    });

    expect(lastDial(played)).toStrictEqual(tls("irc.test"));
  });

  it("applies to Retry, to Configured, and after Started", () => {
    const base = configured({ ircds: [tls("irc.test"), plain("irc.test")] });

    const played = play(client, {
      configuration: base,
      transcript: [
        "!! configure\n",
        session(tls("irc.test"), "sts=duration=600"),
        lines("== closed Ended", "!! retry"),
        dial(tls("irc.test")),
        opening,
        lines("!! configure disable", ">> QUIT", "-> hangup", "== closed HungUp"),
        lines("!! configure enable"),
        dial(tls("irc.test")),
        lines("== started"),
        dial(tls("irc.test")),
      ],
    });

    expect(lastDial(played)).toStrictEqual(tls("irc.test"));
  });

  it("lets Configuration apply again once it expires", () => {
    const base = configured({ ircds: [tls("irc.test"), plain("irc.test")] });

    const played = play(client, {
      configuration: base,
      transcript: [
        "!! configure\n",
        session(tls("irc.test"), "sts=duration=10"),
        lines("== closed Ended", "+2s"),
        dial(tls("irc.test")),
        lines("== closed Refused", "+4s"),
        dial(tls("irc.test")),
        // The policy holds until t+10s, and this dial is at t+14s.
        lines("== closed Refused", "+8s"),
        dial(plain("irc.test")),
      ],
    });

    expect(policiesOf(played.state).size).toBe(0);
  });

  it("keeps each host under its own policy as it rotates", () => {
    const base = configured({
      ircds: [tls("a.test"), tls("b.test", 7000), plain("a.test"), plain("B.test")],
    });

    const played = play(client, {
      configuration: base,
      transcript: [
        "!! configure\n",
        session(tls("a.test"), "sts=duration=600"),
        lines("== closed Ended", "+2s"),
        session(tls("b.test", 7000), "sts=duration=300"),
        lines("== closed Ended", "+4s"),
        dial(tls("a.test")),
        lines("== closed Refused", "+8s"),
        dial(tls("B.test", 7000)),
      ],
    });

    expect([...policiesOf(played.state).keys()]).toStrictEqual(["a.test", "b.test"]);
  });
});

describe("the bound", () => {
  it("keeps at most so many policies, forgetting the one that expires first", () => {
    const hosts = Array.from({ length: maxPolicies + 1 }, (_, index) => tls(`h${index}.test`));
    const base = configured({ ircds: [hosts[0] ?? tls("h0.test"), ...hosts.slice(1)] });

    const played = play(client, {
      configuration: base,
      transcript: [
        "!! configure\n",
        ...hosts.map(
          (ircd, index) =>
            (index === 0 ? "" : "+5m\n") +
            session(ircd, "sts=duration=86400") +
            lines("== closed Ended")
        ),
      ],
    });

    const policies = policiesOf(played.state);

    expect(policies.size).toBe(maxPolicies);
    expect(policies.has("h0.test")).toBeFalsy();
    expect(policies.has(`h${maxPolicies}.test`)).toBeTruthy();
  });
});

describe("rescheduling", () => {
  it("moves the expiry to the close plus the last duration", () => {
    const base = configured();

    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["sts=duration=600"], requested: [] }),
        chatter(6),
        lines("== closed Ended"),
      ],
    });

    expect(policiesOf(played.state)).toStrictEqual(
      new Map([["irc.test", policy(6697, 600, 300_000 + 600_000)]])
    );
  });

  it("keeps a policy that expires during its Connection, and moves it at the close", () => {
    const base = configured({ ircds: [tls("irc.test"), plain("irc.test")] });

    const played = play(client, {
      configuration: base,
      transcript: [
        "!! configure\n",
        session(tls("irc.test"), "sts=duration=60"),
        chatter(3),
        lines("== closed Ended", "+2s"),
        dial(tls("irc.test")),
      ],
    });

    expect(policiesOf(played.state)).toStrictEqual(
      new Map([["irc.test", policy(6697, 60, 150_000 + 60_000)]])
    );
  });

  it("does not move it for a Connection that never opened", () => {
    const base = configured({ ircds: [tls("irc.test"), plain("irc.test")] });

    const played = play(client, {
      configuration: base,
      transcript: [
        "!! configure\n",
        session(tls("irc.test"), "sts=duration=600"),
        lines("== closed Ended", "+2s"),
        dial(tls("irc.test")),
        lines("== closed Tls"),
      ],
    });

    expect(policiesOf(played.state)).toStrictEqual(
      new Map([["irc.test", policy(6697, 600, 600_000)]])
    );
  });

  it("does not revive an expired policy for a Connection dialled after it", () => {
    const base = configured({ ircds: [tls("irc.test")] });

    const played = play(client, {
      configuration: base,
      transcript: [
        "!! configure\n",
        session(tls("irc.test"), "sts=duration=1"),
        lines("== closed Ended", "+2s"),
        session(tls("irc.test"), "foo"),
        lines("== closed Ended"),
      ],
    });

    expect(policiesOf(played.state).size).toBe(0);
  });
});

describe("persistence", () => {
  const base = configured({ ircds: [tls("irc.test"), plain("irc.test")] });

  const heard = (): ReturnType<typeof play> =>
    play(client, {
      configuration: base,
      transcript: ["!! configure\n", session(tls("irc.test"), "sts=duration=600"), "+30s\n"],
    });

  it("survives a restart: the Journal folded again, then Started, dials under the policy", () => {
    const played = heard();

    let folded = client.initial;

    for (const input of played.inputs) {
      ({ state: folded } = client.step(folded, input));
    }

    const restarted: Input = { _tag: "Started", at: at(120_000) };
    const { outputs } = client.step(folded, restarted);

    const dials = outputs.filter((output): output is Dial => output._tag === "Dial");

    expect(dials.map((output) => output.ircd)).toStrictEqual([tls("irc.test")]);
  });

  it("folds the same in a fresh process", async () => {
    const played = play(client, {
      configuration: configured({ ircds: [plain("irc.test"), plain("irc.test")] }),
      transcript: [
        "!! configure\n",
        dial(plain("irc.test")),
        opening,
        lines("<< :irc.test CAP * LS :sts=port=6697", "-> hangup", "== closed HungUp"),
        session(tls("irc.test"), "sts=duration=600"),
        chatter(2),
        lines("== closed Ended", "+2s"),
        dial(tls("irc.test")),
        lines("== started"),
        dial(tls("irc.test")),
      ],
    });

    await expect(
      replayFresh(client, played.inputs, {
        module: new URL("../core.ts", import.meta.url),
        name: "client",
      })
    ).resolves.toBeUndefined();
  });
});

// The property's world.

// Hosts as policies are keyed, worked out here on their own.
const keyOf = (host: string): string => host.toLowerCase().replace(/\.$/u, "");

const worlds = [
  configured({
    ircds: [tls("a.test"), plain("A.test."), tls("b.test", 7000), plain("B.TEST", 6668)],
  }),
  configured({ enabled: false, ircds: [plain("a.test"), tls("b.test", 7000)] }),
  configured({ ircds: [plain("a.test")] }),
];

// Each Line, and what it means for a policy when it arrives over TLS and is read: a
// duration to set, 0 to remove, or nothing.
const pool: readonly (readonly [string, number | undefined])[] = [
  [":irc.test CAP * LS :sts=duration=600", 600],
  [":irc.test CAP * LS * :foo sts=duration=900", 900],
  [":irc.test CAP * LS :sts=port=7000,duration=60", 60],
  [":irc.test CAP * LS :sts=port=6697", undefined],
  [":irc.test CAP * LS :foo", undefined],
  [":irc.test CAP iirc NEW :sts=duration=300", 300],
  [":irc.test CAP iirc NEW :sts=duration=0", 0],
  [":irc.test CAP iirc NEW :sts=duration=abc", undefined],
  [":irc.test CAP iirc NEW :sts=port=6697", undefined],
  [":irc.test CAP iirc DEL :sts", undefined],
  [":irc.test CAP iirc ACK :foo", undefined],
  [":irc.test 421 iirc CAP :Unknown command", undefined],
  [":irc.test 001 iirc :Welcome", undefined],
  ["PING :x", undefined],
  ["ERROR :bye", undefined],
];

type Move =
  | { readonly _tag: "Configure"; readonly which: number }
  | { readonly _tag: "Started" | "Retry" | "Opened" | "Closed" }
  | { readonly _tag: "Received"; readonly line: number; readonly stale: boolean }
  | { readonly _tag: "Wait"; readonly millis: number };

const moves: fc.Arbitrary<readonly Move[]> = fc.array(
  fc.oneof(
    {
      arbitrary: fc.nat(worlds.length - 1).map((which) => ({ _tag: "Configure", which }) as const),
      weight: 1,
    },
    {
      arbitrary: fc.constantFrom({ _tag: "Started" } as const, { _tag: "Retry" } as const),
      weight: 1,
    },
    { arbitrary: fc.constant({ _tag: "Opened" } as const), weight: 3 },
    { arbitrary: fc.constant({ _tag: "Closed" } as const), weight: 2 },
    {
      arbitrary: fc
        .tuple(fc.nat(pool.length - 1), fc.boolean(), fc.boolean())
        .map(
          ([line, stale, other]) => ({ _tag: "Received", line, stale: stale && other }) as const
        ),
      weight: 6,
    },
    {
      arbitrary: fc
        .integer({ max: 900_000, min: 1 })
        .map((millis) => ({ _tag: "Wait", millis }) as const),
      weight: 2,
    }
  ),
  { maxLength: 120, minLength: 20 }
);

/** What one run of the property saw. */
interface Seen {
  /** Dials made to a host under a policy, and whether each kept to it. */
  readonly dials: boolean[];
  /** How many policies were learnt. */
  learnt: number;
}

const utf8 = new TextEncoder();

// Folds the moves through the Client, keeping beside it what the spec says each policy
// is: a lower bound, since it leaves out rescheduling, which only moves expiry later.
const fold = (sequence: readonly Move[], seen: Seen): void => {
  let state = client.initial;
  let table: TimerTable = new Map();
  let now = 0;
  let connection = 0;
  const dialled = new Map<number, IrcdAddress>();
  const policies = new Map<string, { readonly port: number; readonly until: number }>();

  const step = (input: Input, meaning?: number): void => {
    const result = client.step(state, input);

    for (const output of result.outputs) {
      if (output._tag === "Dial") {
        const held = policies.get(keyOf(output.ircd.host));

        if (held !== undefined && input.at < held.until) {
          seen.dials.push(output.ircd.tls && output.ircd.port === held.port);
        }

        ({ connection } = output);
        dialled.set(output.connection, output.ircd);
      }
    }

    const ircd = input._tag === "Received" ? dialled.get(input.connection) : undefined;
    const read = !result.news.some((news) => news._tag === "Ignored");

    if (ircd?.tls === true && read && meaning === 0) {
      policies.delete(keyOf(ircd.host));
    } else if (ircd?.tls === true && read && meaning !== undefined) {
      seen.learnt += 1;
      policies.set(keyOf(ircd.host), { port: ircd.port, until: input.at + meaning * 1000 });
    }

    ({ state } = result);
    table = timersFold(table, input, result.outputs);
  };

  for (const each of sequence) {
    const instant = at(now);
    const current = ConnectionId.make(connection);

    switch (each._tag) {
      case "Configure": {
        const configuration = worlds[each.which] ?? configured();

        step({ _tag: "Configured", at: instant, configuration });
        break;
      }

      case "Started":
      case "Retry": {
        step({ _tag: each._tag, at: instant });
        break;
      }

      case "Opened": {
        step({ _tag: "Opened", at: instant, connection: current });
        break;
      }

      case "Closed": {
        step({ _tag: "Closed", at: instant, connection: current, reason: "Tls" });
        break;
      }

      case "Received": {
        const [text, meaning] = pool[each.line] ?? ["", undefined];
        const from = each.stale ? ConnectionId.make(connection - 1) : current;

        step(
          { _tag: "Received", at: instant, bytes: utf8.encode(text), connection: from },
          meaning
        );
        break;
      }

      case "Wait": {
        const until = epoch + now + each.millis;

        for (;;) {
          const [due] = [...table].toSorted(([, left], [, right]) => left - right);

          if (due === undefined || due[1] > until) {
            break;
          }

          now = due[1] - epoch;
          step({ _tag: "Fired", at: due[1], due: due[1], timer: due[0] });
        }

        now = until - epoch;
        break;
      }

      default: {
        each satisfies never;
      }
    }
  }
};

describe("the property", () => {
  it("never dials a host plaintext, or on another port, while a policy learnt over TLS holds", () => {
    const seen: Seen = { dials: [], learnt: 0 };

    fc.assert(
      fc.property(moves, (sequence) => {
        const before = seen.dials.length;

        fold(sequence, seen);

        return seen.dials.slice(before).every(Boolean);
      }),
      { numRuns: 300 }
    );

    // It means something: policies were learnt, and dials made under them.
    expect(seen.learnt).toBeGreaterThan(0);
    expect(seen.dials.length).toBeGreaterThan(0);
  });
});
