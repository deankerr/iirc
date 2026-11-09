import { ConnectionId, Instant, IntentId, TimerId } from "@iirc/client";
import type { Client, Input, News, Output } from "@iirc/client";
import { configured, scripted } from "@iirc/client/testing";
import type { Scripted } from "@iirc/client/testing";
import { CredentialName, isRejected, nick, privmsg } from "@iirc/protocol/line";
import type { OutboundLine, Rejected } from "@iirc/protocol/line";
import { Effect, Exit, Fiber, Latch, Option, Redacted, References, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { Entry, JournalFailed, NetworkId } from "./journal.ts";
import type { JournalRecord } from "./journal.ts";
import { DecodersMissing, NetworkStopped } from "./runtime.ts";
import type { Happened, NetworkStatus } from "./runtime.ts";
import {
  awaitRecord,
  entries,
  epoch,
  outline,
  runTest,
  settle,
  startRuntime,
  wrapJournal,
} from "./testing/harness.ts";
import { VaultFailed } from "./vault.ts";

const libera = NetworkId.make("libera");
const oftc = NetworkId.make("oftc");
const configuration = configured();
const ircd = { host: "irc.test", port: 6697, tls: true };
const first = ConnectionId.make(1);
const text = new TextDecoder();

const line = (built: OutboundLine | Rejected): OutboundLine => {
  if (isRejected(built)) {
    throw new Error(`a test Line was rejected: ${built.reason}`);
  }

  return built;
};

const at = (millis: number) => Instant.make(epoch + millis);
const dial: Output = { _tag: "Dial", connection: first, ircd };

const send = (outbound: OutboundLine): Output => ({
  _tag: "Send",
  connection: first,
  line: outbound,
});

const wake = (timer: string, millis: number | null): Output => ({
  _tag: "Wake",
  at: millis === null ? null : at(millis),
  timer: TimerId.make(timer),
});

const inputs = (all: readonly Entry[]): readonly Input[] =>
  all.flatMap(({ record }) => (record._tag === "Input" ? [record.input] : []));

describe("each input", () => {
  it("is journaled, then its Outputs with `of`, then carried out", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const client = scripted([
          { outputs: [dial, wake("register", 60_000)], when: "Configured" },
          { outputs: [send(line(nick("iirc")))], when: "Opened" },
        ]);

        const { runtime } = yield* startRuntime(world, client);

        yield* runtime.configure(libera, configuration);
        const call = yield* world.memory.ircd.accept;

        yield* call.open;
        const heard = yield* call.heard;

        return {
          address: call.address,
          heard: text.decode(heard),
          outline: yield* outline(world.journal),
        };
      })
    );

    expect(result).toStrictEqual({
      address: ircd,
      heard: "NICK iirc\r\n",
      outline: [
        "1 libera Configured",
        "2 libera of 1: Dial Wake",
        "3 libera Opened",
        "4 libera of 3: Send",
      ],
    });
  });

  it("takes its `at` from the Clock", async () => {
    const stamped = await runTest((world) =>
      Effect.gen(function* () {
        const { runtime } = yield* startRuntime(world, scripted([]));

        yield* TestClock.adjust(1500);
        yield* runtime.configure(libera, configuration);

        return inputs(yield* entries(world.journal)).map((input) => input.at);
      })
    );

    expect(stamped).toStrictEqual([at(1500)]);
  });
});

describe("carrying out", () => {
  it("sends Lines byte-exact, and drops one for a Connection it does not hold", async () => {
    const heard = await runTest((world) =>
      Effect.gen(function* () {
        const elsewhere: Output = {
          _tag: "Send",
          connection: ConnectionId.make(9),
          line: line(privmsg("#nowhere", "lost")),
        };

        const client = scripted([
          { outputs: [dial], when: "Configured" },
          {
            outputs: [elsewhere, send(line(privmsg("#iirc", "héllo :) ")))],
            when: "Opened",
          },
        ]);

        const { runtime } = yield* startRuntime(world, client);

        yield* runtime.configure(libera, configuration);
        const call = yield* world.memory.ircd.accept;

        yield* call.open;

        return yield* call.heard;
      })
    );

    expect([...heard]).toStrictEqual([...new TextEncoder().encode("PRIVMSG #iirc :héllo :) \r\n")]);
  });

  it("hangs up, and journals the `Closed HungUp` that follows", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const client = scripted([
          { outputs: [dial], when: "Configured" },
          { outputs: [{ _tag: "Hangup", connection: first }], when: "Opened" },
          { when: "Closed" },
        ]);

        const { runtime } = yield* startRuntime(world, client);

        yield* runtime.configure(libera, configuration);
        yield* (yield* world.memory.ircd.accept).open;

        const closed = yield* awaitRecord(
          world.journal,
          (record) => record._tag === "Input" && record.input._tag === "Closed"
        );

        yield* settle;

        return { closed: closed.record, held: (yield* runtime.inspect(libera)).connections };
      })
    );

    expect(result.closed).toMatchObject({
      input: { _tag: "Closed", connection: first, reason: "HungUp" },
    });
    expect(result.held).toStrictEqual([]);
  });

  it("fires a timer at its time, a reset one once, and a cancelled one never", async () => {
    const fired = await runTest((world) =>
      Effect.gen(function* () {
        const client = scripted([
          {
            outputs: [wake("reset", 1000), wake("cancelled", 1000), wake("kept", 1000)],
            when: "Configured",
          },
          { outputs: [wake("reset", 3000), wake("cancelled", null)], when: "Retry" },
          { when: "Fired" },
          { when: "Fired" },
        ]);

        const { runtime } = yield* startRuntime(world, client);

        yield* runtime.configure(libera, configuration);
        yield* runtime.retry(libera);
        yield* TestClock.adjust(999);
        yield* settle;
        const early = inputs(yield* entries(world.journal)).length;

        yield* TestClock.adjust(1);
        yield* settle;
        yield* TestClock.adjust(2000);
        yield* settle;
        yield* TestClock.adjust(10_000);
        yield* settle;

        return {
          early,
          fired: inputs(yield* entries(world.journal)).filter((input) => input._tag === "Fired"),
          left: (yield* runtime.inspect(libera)).timers,
        };
      })
    );

    expect(fired).toStrictEqual({
      early: 2,
      fired: [
        { _tag: "Fired", at: at(1000), due: at(1000), timer: "kept" },
        { _tag: "Fired", at: at(3000), due: at(3000), timer: "reset" },
      ],
      left: new Map(),
    });
  });

  it("gives a firing that went stale while it waited to the Client unchanged", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const gate = yield* Latch.make(true);
        const journal = wrapJournal(world.journal, { before: () => gate.await });

        const client = scripted([
          { outputs: [wake("ping", 1000)], when: "Configured" },
          { outputs: [wake("ping", 2000)], when: "Retry" },
          { when: "Fired" },
          { when: "Fired" },
        ]);

        const { runtime } = yield* startRuntime({ ...world, journal }, client);

        yield* runtime.configure(libera, configuration);
        // The Retry waits on the Journal while the first setting of `ping` falls due.
        yield* gate.close;
        yield* Effect.forkChild(runtime.retry(libera));
        yield* settle;
        yield* TestClock.adjust(1000);
        yield* settle;
        yield* gate.open;
        yield* settle;
        const pending = (yield* runtime.inspect(libera)).timers;

        yield* TestClock.adjust(1000);
        yield* settle;

        return {
          fired: inputs(yield* entries(world.journal)).filter((input) => input._tag === "Fired"),
          inputs: inputs(yield* entries(world.journal)).map((input) => input._tag),
          pending,
        };
      })
    );

    expect(result).toStrictEqual({
      fired: [
        { _tag: "Fired", at: at(1000), due: at(1000), timer: "ping" },
        { _tag: "Fired", at: at(2000), due: at(2000), timer: "ping" },
      ],
      inputs: ["Configured", "Retry", "Fired", "Fired"],
      // The stale firing consumed nothing, so `ping` stays set for its new time.
      pending: new Map([[TimerId.make("ping"), at(2000)]]),
    });
  });
});

describe("a SendSecret", () => {
  const password = CredentialName.make("libera-password");

  it("is filled from the Vault, sent, and never journaled or logged", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        yield* world.vault.hold(password, Redacted.make("hunter2"));

        const client = scripted([
          { outputs: [dial], when: "Configured" },
          {
            outputs: [
              {
                _tag: "SendSecret",
                connection: first,
                line: { _tag: "Pass", credential: password },
              },
              send(line(nick("iirc"))),
            ],
            when: "Opened",
          },
        ]);

        const { runtime } = yield* startRuntime(world, client);

        yield* runtime.configure(libera, configuration);
        const call = yield* world.memory.ircd.accept;

        yield* call.open;
        const heard = [text.decode(yield* call.heard), text.decode(yield* call.heard)];

        const journaled = (yield* entries(world.journal)).map((entry) =>
          Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(Entry)))(entry)
        );

        return { heard, journaled: journaled.join("\n"), logged: JSON.stringify(world.logged) };
      })
    );

    expect(result.heard).toStrictEqual(["PASS hunter2\r\n", "NICK iirc\r\n"]);
    expect(result.journaled).toContain("libera-password");
    expect(result.journaled).not.toContain("hunter2");
    expect(result.logged).not.toContain("hunter2");
  });

  it("that cannot be filled becomes `Unfilled`, in order, after the rest of the outputs", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const key = CredentialName.make("channel-key");
        const broken = CredentialName.make("in-a-broken-vault");

        const vault = {
          ...world.vault,
          reveal: (name: CredentialName) =>
            name === broken
              ? Effect.fail(new VaultFailed({ reason: "the file is gone" }))
              : world.vault.reveal(name),
        };

        yield* world.vault.hold(key, Redacted.make("two\r\nlines"));

        const client = scripted([
          { outputs: [dial], when: "Configured" },
          {
            outputs: [
              {
                _tag: "SendSecret",
                connection: first,
                line: { _tag: "Pass", credential: password },
              },
              {
                _tag: "SendSecret",
                connection: first,
                line: { _tag: "JoinWithKey", channel: "#secret", credential: key },
              },
              send(line(nick("iirc"))),
              {
                _tag: "SendSecret",
                connection: first,
                line: {
                  _tag: "AuthenticatePlain",
                  authcid: "iirc",
                  authzid: "iirc",
                  credential: broken,
                },
              },
            ],
            when: "Opened",
          },
          { when: "Unfilled" },
          { when: "Unfilled" },
          { when: "Unfilled" },
        ]);

        const { runtime } = yield* startRuntime({ ...world, vault }, client);

        yield* runtime.configure(libera, configuration);
        const call = yield* world.memory.ircd.accept;

        yield* call.open;
        const heard = text.decode(yield* call.heard);

        yield* settle;
        const all = yield* entries(world.journal);

        return {
          heard,
          outline: yield* outline(world.journal),
          unfilled: inputs(all).flatMap((input) =>
            input._tag === "Unfilled" ? [[input.line._tag, input.reason]] : []
          ),
        };
      })
    );

    expect(result).toStrictEqual({
      heard: "NICK iirc\r\n",
      outline: [
        "1 libera Configured",
        "2 libera of 1: Dial",
        "3 libera Opened",
        "4 libera of 3: SendSecret SendSecret Send SendSecret",
        "5 libera Unfilled",
        "6 libera Unfilled",
        "7 libera Unfilled",
      ],
      unfilled: [
        ["Pass", "Missing"],
        ["JoinWithKey", "Unsendable"],
        ["AuthenticatePlain", "Unavailable"],
      ],
    });
  });
});

describe("a Line `encode` rejects", () => {
  it("is logged and not sent", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        // A value typed as an OutboundLine that turns unsafe once it is journaled: the case
        // `encode`, the last guard, exists for.
        const good = line(privmsg("#iirc", "fine"));
        let journaled = false;

        const sneaky = Object.defineProperty({ ...good }, "params", {
          enumerable: true,
          get: () => (journaled ? ["#iirc", "fine\r\nQUIT :injected"] : good.params),
        });

        const journal = wrapJournal(world.journal, {
          after: (record: JournalRecord) =>
            Effect.sync(() => {
              journaled ||= record._tag === "Outputs" && record.outputs.length === 2;
            }),
        });

        const client = scripted([
          { outputs: [dial], when: "Configured" },
          { outputs: [send(sneaky), send(line(nick("iirc")))], when: "Opened" },
        ]);

        const { runtime } = yield* startRuntime({ ...world, journal }, client);

        yield* runtime.configure(libera, configuration);
        const call = yield* world.memory.ircd.accept;

        yield* call.open;
        const heard = text.decode(yield* call.heard);

        return {
          errors: world.logged
            .filter((logged) => logged.level === "Error")
            .map((logged) => logged.message),
          heard,
        };
      })
    );

    expect(result.heard).toBe("NICK iirc\r\n");
    expect(JSON.stringify(result.errors)).toContain("encode rejected");
  });
});

describe("starting", () => {
  it("refuses when this runtime is missing a decoder", async () => {
    const exit = await runTest((world) =>
      Effect.exit(startRuntime(world, scripted([]), () => ["big5"]))
    );

    expect(exit).toStrictEqual(Exit.fail(new DecodersMissing({ missing: ["big5"] })));
  });
});

// Throws for a Line saying `BOOM`, as a Client with a bug might.
const fragile = <S>(client: Client<S>): Client<S> => ({
  ...client,
  step: (state, input) => {
    if (input._tag === "Received" && text.decode(input.bytes) === "BOOM") {
      throw new Error("boom");
    }

    return client.step(state, input);
  },
});

const both: readonly Scripted[] = [
  { outputs: [dial], when: "Configured" },
  { when: "Opened" },
  { when: "Received" },
  { when: "Received" },
];

describe("one Network's failure", () => {
  it("of the Journal stops that Network, and the other carries on", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        let failing = false;

        const journal = wrapJournal(world.journal, {
          before: (record) =>
            failing && record.network === oftc
              ? Effect.fail(new JournalFailed({ reason: "disk full" }))
              : Effect.void,
        });

        const { runtime } = yield* startRuntime({ ...world, journal }, scripted(both));

        yield* runtime.configure(libera, configuration);
        const good = yield* world.memory.ircd.accept;

        yield* runtime.configure(oftc, configuration);
        const bad = yield* world.memory.ircd.accept;

        failing = true;
        yield* bad.open;
        yield* good.open;
        yield* good.say(new TextEncoder().encode("PING :x"));
        yield* settle;

        return {
          held: (yield* runtime.inspect(oftc)).connections,
          networks: yield* runtime.networks,
          outline: yield* outline(world.journal),
          retry: yield* Effect.flip(runtime.retry(oftc)),
        };
      })
    );

    expect(result.networks).toStrictEqual(
      new Map<NetworkId, NetworkStatus>([
        [libera, { _tag: "Running" }],
        [oftc, { _tag: "Stopped", reason: "The Journal failed: disk full" }],
      ])
    );
    expect(result.retry).toBeInstanceOf(NetworkStopped);
    expect(result.held).toStrictEqual([]);
    expect(result.outline).toStrictEqual([
      "1 libera Configured",
      "2 libera of 1: Dial",
      "3 oftc Configured",
      "4 oftc of 3: Dial",
      "5 libera Opened",
      "6 libera Received",
    ]);
  });

  it("from a defect stops that Network, now and on restart, and the other carries on", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const client = fragile(scripted(both));
        const first = yield* startRuntime(world, client);

        yield* first.runtime.configure(libera, configuration);
        const good = yield* world.memory.ircd.accept;

        yield* first.runtime.configure(oftc, configuration);
        const bad = yield* world.memory.ircd.accept;

        yield* bad.open;
        yield* good.open;
        yield* bad.say(new TextEncoder().encode("BOOM"));
        yield* settle;
        yield* good.say(new TextEncoder().encode("PING :x"));
        yield* settle;
        const before = yield* first.runtime.networks;

        yield* first.close;
        const second = yield* startRuntime(world, client);

        return { after: yield* second.runtime.networks, before };
      })
    );

    const stopped: NetworkStatus = { _tag: "Stopped", reason: "The Client threw: Error: boom" };

    expect(result.before).toStrictEqual(
      new Map<NetworkId, NetworkStatus>([
        [libera, { _tag: "Running" }],
        [oftc, stopped],
      ])
    );
    expect(result.after).toStrictEqual(result.before);
  });
});

// A News that names what it is, to follow it through the stream.
const told = (command: string): News => ({
  _tag: "Ignored",
  reason: { _tag: "Malformed", command },
});

const brief = (happened: Happened) =>
  `${happened.sequence} ${happened.network} ${happened.news
    .map((news) =>
      news._tag === "Ignored" && news.reason._tag === "Malformed" ? news.reason.command : news._tag
    )
    .join(" ")}`;

describe("`said`", () => {
  it("finds a Say journaled under an intent, only on its Network, and nothing else", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const { runtime } = yield* startRuntime(world, scripted([]));
        const mine = IntentId.make("mine");

        yield* runtime.configure(libera, configuration);
        yield* runtime.configure(oftc, configuration);

        const { sequence } = yield* runtime.say(libera, {
          intent: mine,
          kind: "Privmsg",
          target: "#iirc",
          text: "hi",
        });

        return {
          absent: yield* runtime.said(libera, IntentId.make("other")),
          elsewhere: yield* runtime.said(oftc, mine),
          present: yield* runtime.said(libera, mine),
          sequence,
          unknown: yield* runtime.said(NetworkId.make("nowhere"), mine),
        };
      })
    );

    expect(result).toStrictEqual({
      absent: Option.none(),
      elsewhere: Option.none(),
      present: Option.some(result.sequence),
      sequence: 3,
      unknown: Option.none(),
    });
  });
});

describe("the News stream", () => {
  it("gives every Network's News from a sequence, in order, then live", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const client = scripted([
          { news: [told("first")], when: "Configured" },
          { news: [told("second"), told("third")], when: "Retry" },
          { when: "Retry" },
        ]);

        const { runtime } = yield* startRuntime(world, client);

        yield* runtime.configure(libera, configuration);
        yield* runtime.configure(oftc, configuration);
        yield* runtime.retry(libera);
        yield* runtime.retry(libera);

        const all = yield* Stream.runCollect(Stream.take(runtime.news(), 3));

        const resumed = yield* Stream.runCollect(
          Stream.take(runtime.news({ after: all[1]?.sequence }), 1)
        );

        const live = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(runtime.news({ after: all[2]?.sequence }), 1))
        );

        yield* settle;
        yield* runtime.retry(oftc);

        return {
          all: all.map(brief),
          live: (yield* Fiber.await(live)).pipe(Exit.map((got) => got.map(brief))),
          resumed: resumed.map(brief),
        };
      })
    );

    expect(result).toStrictEqual({
      // The second Retry to libera made no News, so it is not given.
      all: ["1 libera first", "2 oftc first", "3 libera second third"],
      live: Exit.succeed(["5 oftc second third"]),
      resumed: ["3 libera second third"],
    });
  });
});

const closedFor = (network: NetworkId) =>
  new NetworkStopped({ network, reason: "The Runtime closed" });

describe("closing the Runtime", () => {
  it("fails an Owner input still waiting, marks the Network stopped, and logs no error", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const gate = yield* Latch.make(true);
        const journal = wrapJournal(world.journal, { before: () => gate.await });
        const { close, runtime } = yield* startRuntime({ ...world, journal }, scripted([]));

        yield* runtime.configure(libera, configuration);
        // The next append waits, so this Configured is pending when the Runtime closes.
        yield* gate.close;
        const pending = yield* Effect.forkChild(runtime.configure(libera, configuration));

        yield* settle;
        yield* close;

        return {
          errors: world.logged.filter((logged) => logged.level === "Error"),
          exit: yield* Fiber.await(pending),
          networks: yield* runtime.networks,
        };
      })
    );

    expect(result).toStrictEqual({
      errors: [],
      exit: Exit.fail(closedFor(libera)),
      networks: new Map<NetworkId, NetworkStatus>([
        [libera, { _tag: "Stopped", reason: "The Runtime closed" }],
      ]),
    });
  });

  it("never leaves a Network added as it closes running, or its caller waiting", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const outcomes: string[] = [];

        // Close after each number of scheduler turns, to land in every gap of adding one.
        for (let turns = 0; turns < 40; turns += 1) {
          const { close, runtime } = yield* startRuntime(world, scripted([]));
          const network = NetworkId.make(`net-${turns}`);
          const adding = yield* Effect.forkChild(runtime.configure(network, configuration));

          for (let turn = 0; turn < turns; turn += 1) {
            yield* Effect.yieldNow;
          }

          yield* close;
          yield* settle;
          const exit = adding.pollUnsafe();
          const statuses = [...(yield* runtime.networks).values()];

          if (exit === undefined || statuses.some((status) => status._tag === "Running")) {
            outcomes.push(`after ${turns} turns: ${exit === undefined ? "waiting" : "done"}`);
          }
        }

        return outcomes;
      }).pipe(Effect.provideService(References.MaxOpsBeforeYield, 20))
    );

    expect(result).toStrictEqual([]);
  });

  it("fails an input appended but not yet stepped, which a restart then folds", async () => {
    const intent = IntentId.make("mine");

    const result = await runTest((world) =>
      Effect.gen(function* () {
        const gate = yield* Latch.make(true);

        // Waits just after the Say is durably appended, before it is stepped.
        const journal = wrapJournal(world.journal, {
          after: (record) =>
            record._tag === "Input" && record.input._tag === "Say" ? gate.await : Effect.void,
        });

        const script: readonly Scripted[] = [
          { when: "Configured" },
          { news: [{ _tag: "Refused", intent, reason: { _tag: "Offline" } }], when: "Say" },
          { news: [told("STARTED")], when: "Started" },
        ];

        const first = yield* startRuntime({ ...world, journal }, scripted(script));

        yield* first.runtime.configure(libera, configuration);
        yield* gate.close;

        const saying = yield* Effect.forkChild(
          first.runtime.say(libera, { intent, kind: "Privmsg", target: "#iirc", text: "hi" })
        );

        yield* settle;
        yield* first.close;
        const said = yield* Fiber.await(saying);
        const second = yield* startRuntime(world, scripted(script));

        yield* settle;
        const news = yield* Stream.runCollect(Stream.take(second.runtime.news(), 2));

        return {
          found: yield* second.runtime.said(libera, intent),
          news: news.flatMap((happened) => happened.news),
          outline: yield* outline(world.journal),
          said,
        };
      })
    );

    expect(result).toStrictEqual({
      // `said` finds the Say, which the restart folded before its Started.
      found: Option.some(2),
      news: [{ _tag: "Refused", intent, reason: { _tag: "Offline" } }, told("STARTED")],
      outline: ["1 libera Configured", "2 libera Say", "3 libera Started"],
      said: Exit.fail(closedFor(libera)),
    });
  });

  it("fails an input stopped before its append, which `said` then finds absent", async () => {
    const intent = IntentId.make("mine");

    const result = await runTest((world) =>
      Effect.gen(function* () {
        const gate = yield* Latch.make(true);

        // Waits just before the Say is appended.
        const journal = wrapJournal(world.journal, {
          before: (record) =>
            record._tag === "Input" && record.input._tag === "Say" ? gate.await : Effect.void,
        });

        const first = yield* startRuntime({ ...world, journal }, scripted([]));

        yield* first.runtime.configure(libera, configuration);
        yield* gate.close;

        const saying = yield* Effect.forkChild(
          first.runtime.say(libera, { intent, kind: "Privmsg", target: "#iirc", text: "hi" })
        );

        yield* settle;
        yield* first.close;
        const said = yield* Fiber.await(saying);
        const second = yield* startRuntime(world, scripted([]));

        return { found: yield* second.runtime.said(libera, intent), said };
      })
    );

    expect(result).toStrictEqual({ found: Option.none(), said: Exit.fail(closedFor(libera)) });
  });

  it("fails an Owner input given after it closed at once", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const { close, runtime } = yield* startRuntime(world, scripted([]));

        yield* runtime.configure(libera, configuration);
        yield* close;

        return yield* Effect.all([
          Effect.flip(runtime.configure(libera, configuration)),
          Effect.flip(runtime.retry(libera)),
          Effect.flip(runtime.say(libera, { kind: "Privmsg", target: "#iirc", text: "hi" })),
          Effect.flip(runtime.configure(oftc, configuration)),
        ]);
      })
    );

    expect(result).toStrictEqual([
      closedFor(libera),
      closedFor(libera),
      closedFor(libera),
      closedFor(oftc),
    ]);
  });

  it("hangs up every Connection and stops every timer", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const client = scripted([
          { outputs: [dial, wake("later", 1000)], when: "Configured" },
          { when: "Opened" },
        ]);

        const { close, runtime } = yield* startRuntime(world, client);

        yield* runtime.configure(libera, configuration);
        const call = yield* world.memory.ircd.accept;

        yield* call.open;
        yield* settle;
        yield* close;
        yield* TestClock.adjust(5000);
        yield* settle;

        return {
          // The far end can no longer speak: the Connection is over.
          ended: Exit.isFailure(yield* Effect.exit(call.say(new TextEncoder().encode("hi")))),
          outline: yield* outline(world.journal),
        };
      })
    );

    expect(result).toStrictEqual({
      ended: true,
      outline: ["1 libera Configured", "2 libera of 1: Dial Wake", "3 libera Opened"],
    });
  });
});

describe("restarting", () => {
  it("sets the timers projected from the Journal, then steps a Started", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const script: readonly Scripted[] = [
          { outputs: [wake("fired", 500), wake("pending", 5000)], when: "Configured" },
          { when: "Fired" },
          { when: "Started" },
          { when: "Fired" },
        ];

        const first = yield* startRuntime(world, scripted(script));

        yield* first.runtime.configure(libera, configuration);
        yield* TestClock.adjust(1000);
        yield* settle;
        yield* first.close;

        const second = yield* startRuntime(world, scripted(script));

        yield* settle;
        const pending = (yield* second.runtime.inspect(libera)).timers;

        yield* TestClock.adjust(4000);
        yield* settle;

        return { outline: yield* outline(world.journal), pending };
      })
    );

    expect(result).toStrictEqual({
      outline: [
        "1 libera Configured",
        "2 libera of 1: Wake Wake",
        "3 libera Fired",
        "4 libera Started",
        "5 libera Fired",
      ],
      pending: new Map([[TimerId.make("pending"), at(5000)]]),
    });
  });
});
