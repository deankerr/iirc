/**
 * Removing a Network: its Session ends with a `QUIT`, it is unknown from then on, on this
 * Runtime and the next, its Credentials are forgotten, and its id is free again unless its
 * Timelines are kept.
 */
import { client, Instant, IntentId } from "@iirc/client";
import type { Client, ClientState, NetworkConfiguration } from "@iirc/client";
import { configured, parse, registered } from "@iirc/client/testing";
import { CredentialName } from "@iirc/protocol/line";
import {
  Effect,
  Exit,
  Fiber,
  Latch,
  Option,
  Redacted,
  Ref,
  Result,
  Scheduler,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { JournalFailed, NetworkId, Sequence, networkOf } from "./journal.ts";
import type { Entry, JournalRecord } from "./journal.ts";
import { foldEntry } from "./replay.ts";
import type { Folded } from "./replay.ts";
import { LifeChanged, TimelinesKept, UnknownNetwork } from "./runtime.ts";
import type { RuntimeService } from "./runtime.ts";
import { outline, runTest, settle, startRuntime, wrapJournal } from "./testing/harness.ts";
import type { World } from "./testing/harness.ts";
import type { TestCall } from "./testing/memory-transport.ts";
import { VaultFailed } from "./vault.ts";

const libera = NetworkId.make("libera");
const oftc = NetworkId.make("oftc");
const text = new TextDecoder();

const heardText = (call: TestCall) => call.heard.pipe(Effect.map((bytes) => text.decode(bytes)));

// Plays the Ircd's side of registration.
const register = (call: TestCall, configuration: NetworkConfiguration) =>
  Effect.gen(function* () {
    yield* call.open;

    for (const item of Result.getOrThrow(parse(registered(configuration, { offered: [] })))) {
      if (item._tag === "Received") {
        yield* call.say(item.bytes);
      }

      if (item._tag === "Sent") {
        yield* call.heard;
      }
    }

    yield* settle;
  });

// Removes, letting the clock run past any pacing the `QUIT` waits on.
const removing = (runtime: RuntimeService, network: NetworkId, keep: boolean) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(runtime.remove(network, { keep }));

    yield* settle;
    yield* TestClock.adjust(5000);

    return (yield* Fiber.join(fiber)).sequence;
  });

// Adds a Network and plays its Ircd until its Session has begun.
const online = (world: World, runtime: RuntimeService, configuration: NetworkConfiguration) =>
  Effect.gen(function* () {
    yield* runtime.configure(libera, configuration);
    const call = yield* world.memory.ircd.accept;

    yield* register(call, configuration);

    return call;
  });

const base = configured();

const name = (each: string) => CredentialName.make(each);

describe("removing a Network", () => {
  it("says QUIT before its Connection ends, and is unknown after", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const { runtime } = yield* startRuntime(world, client);
        const call = yield* online(world, runtime, base);
        const sequence = yield* removing(runtime, libera, false);

        return {
          configuration: yield* Effect.flip(runtime.configuration(libera)),
          heard: yield* heardText(call),
          kept: new Set((yield* runtime.kept).keys()),
          networks: [...(yield* runtime.networks).keys()],
          outline: (yield* outline(world.journal)).slice(-4),
          say: yield* Effect.flip(
            runtime.say(libera, { kind: "Privmsg", target: "#iirc", text: "hi" })
          ),
          sequence,
        };
      })
    );

    expect(result.heard).toMatch(/^QUIT\b/u);
    expect({ ...result, heard: undefined, outline: undefined }).toStrictEqual({
      configuration: new UnknownNetwork({ network: libera }),
      heard: undefined,
      kept: new Set(),
      networks: [],
      outline: undefined,
      say: new UnknownNetwork({ network: libera }),
      sequence: result.sequence,
    });
    expect(result.outline).toStrictEqual([
      `${result.sequence} libera Removed`,
      `${result.sequence + 1} libera of ${result.sequence}: Send Hangup Wake`,
      `${result.sequence + 2} libera Closed`,
      `${result.sequence + 3} libera Forgotten `,
    ]);
  });

  it("is unknown to a Runtime started after, which keeps the id while its Timelines are kept", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const first = yield* startRuntime(world, client);

        yield* online(world, first.runtime, base);
        yield* removing(first.runtime, libera, true);
        const refused = yield* Effect.flip(first.runtime.configure(libera, base));

        yield* first.close;
        const second = yield* startRuntime(world, client);
        const networks = [...(yield* second.runtime.networks).keys()];
        const kept = new Set((yield* second.runtime.kept).keys());
        const again = yield* Effect.flip(second.runtime.configure(libera, base));

        yield* second.runtime.remove(libera, { keep: false });
        const dropped = new Set((yield* second.runtime.kept).keys());

        yield* second.close;
        const third = yield* startRuntime(world, client);

        return {
          again,
          dropped,
          kept,
          networks,
          refused,
          restarted: [...(yield* third.runtime.networks).keys()],
          stillKept: new Set((yield* third.runtime.kept).keys()),
        };
      })
    );

    expect(result).toStrictEqual({
      again: new TimelinesKept({ network: libera }),
      dropped: new Set(),
      kept: new Set([libera]),
      networks: [],
      refused: new TimelinesKept({ network: libera }),
      restarted: [],
      stillKept: new Set(),
    });
  });

  it("frees the id at once when its Timelines are not kept, and a Network added again starts fresh", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const { close, runtime } = yield* startRuntime(world, client);

        yield* online(world, runtime, base);
        yield* removing(runtime, libera, false);

        const plain = configured();

        yield* runtime.configure(libera, plain);
        yield* world.memory.ircd.accept;
        const known = yield* runtime.known(libera);

        yield* close;
        const restarted = yield* startRuntime(world, client);

        return {
          configuration: (yield* restarted.runtime.configuration(libera)).configuration,
          declared: known.knowledge.declared,
          networks: [...(yield* restarted.runtime.networks).keys()],
          restarted: (yield* restarted.runtime.known(libera)).knowledge.declared,
        };
      })
    );

    // The removed Network's Ircd declared a casemapping, and the new one has heard none.
    expect(result).toStrictEqual({
      configuration: configured(),
      declared: undefined,
      networks: [libera],
      restarted: undefined,
    });
  });

  it("gives its removal as News, and nothing of it after", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const { runtime } = yield* startRuntime(world, client);

        yield* online(world, runtime, base);
        const sequence = yield* removing(runtime, libera, true);
        const last = (yield* outline(world.journal)).length;

        const news = yield* Stream.runCollect(
          Stream.takeUntil(runtime.news(), (one) => one.sequence >= sequence)
        );

        const after = yield* Stream.runCollect(
          runtime.news({ after: sequence }).pipe(Stream.interruptWhen(settle))
        );

        const removal = news.at(-1);

        return {
          after,
          last,
          news: [removal?.network, removal?.sequence, removal?.news],
          sequence,
        };
      })
    );

    expect(result.news).toStrictEqual([
      libera,
      result.sequence,
      [{ _tag: "NetworkRemoved", keep: true }],
    ]);
    // Its Outputs and its Connection's `Closed` follow it in the Journal, and give nothing.
    expect(result.last).toBeGreaterThan(result.sequence);
    expect(result.after).toStrictEqual([]);
  });

  it("forgets the Credentials its Configuration names, but one another Network names", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        for (const each of ["pass", "shared", "unrelated"]) {
          yield* world.vault.hold(name(each), Redacted.make("secret"));
        }

        const { runtime } = yield* startRuntime(world, client);

        yield* runtime.configure(
          libera,
          configured({
            channels: [{ key: name("shared"), name: "#a" }],
            enabled: false,
            password: name("pass"),
          })
        );
        yield* runtime.configure(
          oftc,
          configured({ channels: [{ key: name("shared"), name: "#b" }], enabled: false })
        );
        yield* runtime.remove(libera, { keep: false });

        return yield* world.vault.names;
      })
    );

    expect(result).toStrictEqual(new Set(["shared", "unrelated"]));
  });

  it("spares a Credential named outside the Networks, as it stands when the removal decides", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        for (const each of ["pass", "bucket-key"]) {
          yield* world.vault.hold(name(each), Redacted.make("secret"));
        }

        const outside = yield* Ref.make<ReadonlySet<CredentialName>>(new Set());

        const { runtime } = yield* startRuntime(world, client, {
          spared: (decide) => Effect.flatMap(Ref.get(outside), decide),
        });

        yield* runtime.configure(
          libera,
          configured({
            channels: [{ key: name("bucket-key"), name: "#a" }],
            enabled: false,
            password: name("pass"),
          })
        );
        yield* Ref.set(outside, new Set([name("bucket-key")]));
        yield* runtime.remove(libera, { keep: false });

        return {
          outline: (yield* outline(world.journal)).at(-1),
          vault: yield* world.vault.names,
        };
      })
    );

    expect(result).toStrictEqual({
      outline: "3 libera Forgotten pass",
      vault: new Set(["bucket-key"]),
    });
  });

  it("of a Network never configured is UnknownNetwork, and journals nothing", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const { runtime } = yield* startRuntime(world, client);
        const refused = yield* Effect.flip(runtime.remove(libera, { keep: true }));

        return { outline: yield* outline(world.journal), refused };
      })
    );

    expect(result).toStrictEqual({
      outline: [],
      refused: new UnknownNetwork({ network: libera }),
    });
  });
});

// The Client, but one that throws on a Line saying `BOOM`, as a Client with a bug would.
const fragile = <S>(inner: Client<S>): Client<S> => ({
  ...inner,
  step: (state, input) => {
    if (input._tag === "Received" && text.decode(input.bytes) === "BOOM") {
      throw new Error("boom");
    }

    return inner.step(state, input);
  },
});

const held = (world: World) =>
  Effect.gen(function* () {
    for (const each of ["a", "b", "pass"]) {
      yield* world.vault.hold(name(each), Redacted.make("secret"));
    }
  });

describe("a Network's life", () => {
  it("is the Configured that began it, the same after a restart, and larger when the id is given again", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const quiet = configured({ enabled: false });
        const first = yield* startRuntime(world, client);
        const began = yield* first.runtime.configure(libera, quiet);

        yield* first.runtime.configure(libera, configured({ enabled: false, nicks: ["other"] }));
        const living = (yield* first.runtime.lives).get(libera)?.life;
        const removal = yield* first.runtime.remove(libera, { keep: true });

        yield* first.close;
        const second = yield* startRuntime(world, client);
        const kept = (yield* second.runtime.kept).get(libera);
        const dropping = yield* second.runtime.remove(libera, { keep: false });
        const again = yield* second.runtime.configure(libera, quiet);

        yield* second.close;
        const third = yield* startRuntime(world, client);

        const removals = yield* Stream.runCollect(
          Stream.takeUntil(third.runtime.news(), (one) => one.sequence >= dropping.sequence)
        );

        return {
          again,
          began,
          dropped: dropping.life,
          kept,
          known: (yield* third.runtime.known(libera)).life,
          living,
          removals: removals.map((one) => one.life),
          removed: removal.life,
          restarted: (yield* third.runtime.lives).get(libera)?.life,
        };
      })
    );

    expect(result).toStrictEqual({
      again: result.again,
      began: result.began,
      dropped: result.began,
      kept: result.began,
      known: result.again,
      living: result.began,
      removals: [result.began, result.began],
      removed: result.began,
      restarted: result.again,
    });
    expect(result.again).toBeGreaterThan(result.began);
  });
});

// The Client, but one that throws on every Configuration, as a Client with a bug would.
const throwing = <S>(inner: Client<S>): Client<S> => ({
  ...inner,
  step: (state, input) => {
    if (input._tag === "Configured") {
      throw new Error("boom");
    }

    return inner.step(state, input);
  },
});

describe("a Network whose Client throws on its first Configuration", () => {
  it("has the life that Configured began, and keeps its id after a restart once removed", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const first = yield* startRuntime(world, throwing(client));

        const refused = yield* Effect.flip(
          first.runtime.configure(libera, configured({ enabled: false }))
        );

        const removal = yield* first.runtime.remove(libera, { keep: true });

        yield* first.close;
        const second = yield* startRuntime(world, throwing(client));

        return {
          configured: refused._tag,
          kept: yield* second.runtime.kept,
          outline: yield* outline(world.journal),
          removal,
          retaken: (yield* Effect.flip(second.runtime.configure(libera, configured())))._tag,
        };
      })
    );

    expect(result).toStrictEqual({
      configured: "NetworkStopped",
      kept: new Map([[libera, 1]]),
      outline: ["1 libera Configured", "2 libera Removed"],
      removal: { life: 1, sequence: 2 },
      retaken: "TimelinesKept",
    });
  });
});

describe("every fold of the Journal", () => {
  it("lets go of a removed Configuration once its Credentials were forgotten, the News fold too", async () => {
    const result = await runTest(() =>
      Effect.gen(function* () {
        const networks = new Map<NetworkId, Folded<ClientState>>();
        const at = Instant.make(0);

        const records: readonly JournalRecord[] = [
          {
            _tag: "Input",
            input: { _tag: "Configured", at, configuration: configured({ password: name("a") }) },
            network: libera,
          },
          { _tag: "Input", input: { _tag: "Removed", at, keep: false }, network: libera },
          { _tag: "Forgotten", credentials: [name("a")], network: libera },
          {
            _tag: "Input",
            input: { _tag: "Configured", at, configuration: configured({ password: name("b") }) },
            network: libera,
          },
          { _tag: "Input", input: { _tag: "Removed", at, keep: false }, network: libera },
        ];

        const entries: readonly Entry[] = records.map((record, index) => ({
          record,
          sequence: Sequence.make(index + 1),
        }));

        for (const entry of entries) {
          yield* foldEntry(client, networks, entry);
        }

        return networks.get(libera)?.unforgotten.map((each) => each.password);
      })
    );

    // Only the life whose Credentials were never forgotten is left.
    expect(result).toStrictEqual(["b"]);
  });
});

describe("a Lookup waiting when its Network is removed", () => {
  it("reads back as ended, not Pending, before and after a restart", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const first = yield* startRuntime(world, client);
        const call = yield* online(world, first.runtime, base);
        const intent = IntentId.make("who");

        const looking = yield* Effect.forkChild(
          first.runtime.look(libera, { intent, lookup: { _tag: "Whois", nick: "peer" } })
        );

        yield* settle;
        yield* TestClock.adjust(5000);
        // The `WHOIS` left, and no reply comes before the removal.
        yield* call.heard;
        yield* removing(first.runtime, libera, true);
        yield* Fiber.join(looking);

        const before = yield* first.runtime.looked(libera, intent);

        yield* first.close;
        const second = yield* startRuntime(world, client);
        const after = yield* second.runtime.looked(libera, intent);

        const tag = (found: typeof before) =>
          Option.match(found, {
            onNone: () => "None",
            onSome: (outcome) =>
              outcome._tag === "LookedUp" ? `LookedUp ${outcome.result._tag}` : outcome._tag,
          });

        return [tag(before), tag(after)];
      })
    );

    // It reports what it had, which was nothing, as the end of a Connection does.
    expect(result).toStrictEqual(["LookedUp Partial", "LookedUp Partial"]);
  });
});

describe("a removal made from a life", () => {
  it("is refused once the Network holds another, live or kept, and removes the one it names", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const { runtime } = yield* startRuntime(world, client);
        const quiet = configured({ enabled: false });
        const first = yield* runtime.configure(libera, quiet);
        const { life } = yield* runtime.remove(libera, { keep: true, life: first });

        // Another Frontend drops the kept Timelines and adds the name again.
        yield* runtime.remove(libera, { keep: false, life });
        const second = yield* runtime.configure(libera, quiet);
        const stale = yield* Effect.flip(runtime.remove(libera, { keep: false, life: first }));
        const listed = (yield* runtime.lives).get(libera);
        const removed = (yield* runtime.remove(libera, { keep: true, life: second })).life;
        const keptStale = yield* Effect.flip(runtime.remove(libera, { keep: false, life: first }));

        return { keptStale, listed, removed, second, stale };
      })
    );

    expect(result).toStrictEqual({
      keptStale: new LifeChanged({ life: result.second, network: libera }),
      listed: { _tag: "Live", life: result.second, status: { _tag: "Running" } },
      removed: result.second,
      second: result.second,
      stale: new LifeChanged({ life: result.second, network: libera }),
    });
  });
});

describe("a removal whose Forgotten cannot be journaled", () => {
  it("stands, and the next start forgets and journals what it could not", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        yield* world.vault.hold(name("pass"), Redacted.make("secret"));

        const journal = wrapJournal(world.journal, {
          before: (record) =>
            record._tag === "Forgotten"
              ? Effect.fail(new JournalFailed({ reason: "the disk is full" }))
              : Effect.void,
        });

        const first = yield* startRuntime({ ...world, journal }, client);

        yield* first.runtime.configure(
          libera,
          configured({ enabled: false, password: name("pass") })
        );
        const failed = yield* Effect.flip(first.runtime.remove(libera, { keep: true }));
        const listed = (yield* first.runtime.lives).get(libera)?._tag;

        yield* first.close;
        const second = yield* startRuntime(world, client);

        return {
          failed: failed._tag,
          kept: [...(yield* second.runtime.kept).keys()],
          listed,
          outline: (yield* outline(world.journal)).at(-1),
          vault: yield* world.vault.names,
        };
      })
    );

    expect(result).toStrictEqual({
      failed: "JournalFailed",
      kept: [libera],
      listed: "Kept",
      outline: "3 libera Forgotten pass",
      vault: new Set(),
    });
  });
});

describe("the Networks held", () => {
  it("name a Network removed with its Timelines kept as live or kept at every point, never neither", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const { runtime } = yield* startRuntime(world, client);

        yield* runtime.configure(libera, configured({ enabled: false }));

        // The removal yields to the reads every few operations, so they fall between any
        // two of its steps.
        const removing = yield* Effect.forkChild(
          runtime
            .remove(libera, { keep: true })
            .pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 3))
        );

        const seen = new Set<string>();

        while (removing.pollUnsafe() === undefined) {
          const found = (yield* runtime.lives).get(libera);

          seen.add(found?._tag ?? "neither");
          yield* Effect.yieldNow;
        }

        return [...seen].toSorted();
      })
    );

    expect(result).toStrictEqual(["Kept", "Live"]);
  });
});

describe("a removal carried through", () => {
  it("goes on to its end when its caller goes away", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        yield* held(world);
        const { runtime } = yield* startRuntime(world, client);

        yield* online(world, runtime, configured({ password: name("pass") }));
        const removing = yield* Effect.forkChild(runtime.remove(libera, { keep: false }));

        yield* settle;
        yield* Fiber.interrupt(removing);
        yield* TestClock.adjust(5000);
        yield* settle;

        return {
          networks: [...(yield* runtime.networks).keys()],
          outline: (yield* outline(world.journal))
            .filter((each) => !each.includes(" of "))
            .slice(-3),
          vault: yield* world.vault.names,
        };
      })
    );

    expect(result.networks).toStrictEqual([]);
    expect(result.vault).toStrictEqual(new Set(["a", "b"]));
    expect(result.outline.map((each) => each.replace(/^\d+ /u, ""))).toStrictEqual([
      "libera Removed",
      "libera Closed",
      "libera Forgotten pass",
    ]);
  });

  it("forgets on the next start the Credentials a failed Vault kept, and only once", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        yield* held(world);

        const failing = {
          ...world,
          vault: {
            ...world.vault,
            forget: () => Effect.fail(new VaultFailed({ reason: "the test failed it" })),
          },
        };

        const first = yield* startRuntime(failing, client);

        yield* first.runtime.configure(
          libera,
          configured({ enabled: false, password: name("pass") })
        );
        const failed = yield* Effect.flip(first.runtime.remove(libera, { keep: false }));

        yield* first.close;
        const second = yield* startRuntime(world, client);
        const afterStart = yield* world.vault.names;

        // Held again under the same name, for whatever comes next, it is left alone.
        yield* world.vault.hold(name("pass"), Redacted.make("again"));
        yield* second.close;
        yield* startRuntime(world, client);

        return { afterStart, failed: failed._tag, later: yield* world.vault.names };
      })
    );

    expect(result).toStrictEqual({
      afterStart: new Set(["a", "b"]),
      failed: "VaultFailed",
      later: new Set(["a", "b", "pass"]),
    });
  });

  it("spares on the next start a Credential named outside the Networks by then", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        yield* held(world);

        const failing = {
          ...world,
          vault: {
            ...world.vault,
            forget: () => Effect.fail(new VaultFailed({ reason: "the test failed it" })),
          },
        };

        const first = yield* startRuntime(failing, client);

        yield* first.runtime.configure(
          libera,
          configured({
            channels: [{ key: name("a"), name: "#a" }],
            enabled: false,
            password: name("pass"),
          })
        );
        yield* Effect.flip(first.runtime.remove(libera, { keep: false }));
        yield* first.close;
        yield* startRuntime(world, client, { spared: (decide) => decide(new Set([name("a")])) });

        return {
          outline: (yield* outline(world.journal)).at(-1),
          vault: yield* world.vault.names,
        };
      })
    );

    expect(result).toStrictEqual({
      outline: "3 libera Forgotten pass",
      vault: new Set(["a", "b"]),
    });
  });

  it("forgets by the Configuration in force when it is stepped, not when it was asked", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        yield* held(world);

        const gate = yield* Latch.make(true);
        const journal = wrapJournal(world.journal, { before: () => gate.await });
        const { runtime } = yield* startRuntime({ ...world, journal }, client);

        yield* runtime.configure(libera, configured({ enabled: false, password: name("a") }));
        // The next append waits, so this Configured is still to be stepped when the removal
        // is asked for, and is stepped before it.
        yield* gate.close;

        const changing = yield* Effect.forkChild(
          runtime.configure(libera, configured({ enabled: false, password: name("b") }))
        );

        yield* settle;
        const removing = yield* Effect.forkChild(runtime.remove(libera, { keep: false }));

        yield* settle;
        yield* gate.open;
        yield* Fiber.join(changing);
        yield* Fiber.join(removing);

        return yield* world.vault.names;
      })
    );

    expect(result).toStrictEqual(new Set(["a", "pass"]));
  });

  it("waits for a Configuration still to be stepped whose caller went away", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        yield* held(world);
        yield* world.vault.hold(name("shared"), Redacted.make("secret"));

        // Only `oftc`'s appends wait, so its Configured is still to be stepped while
        // `libera` is removed.
        const gate = yield* Latch.make(true);

        const journal = wrapJournal(world.journal, {
          before: (record) => (networkOf(record) === oftc ? gate.await : Effect.void),
        });

        const { runtime } = yield* startRuntime({ ...world, journal }, client);

        yield* runtime.configure(libera, configured({ enabled: false, password: name("shared") }));
        yield* runtime.configure(oftc, configured({ enabled: false }));
        yield* gate.close;

        const changing = yield* Effect.forkChild(
          runtime.configure(oftc, configured({ enabled: false, password: name("shared") }))
        );

        yield* settle;
        yield* Fiber.interrupt(changing);

        const removing = yield* Effect.forkChild(runtime.remove(libera, { keep: false }));

        yield* settle;
        yield* gate.open;
        yield* Fiber.join(removing);

        return {
          configured: (yield* runtime.configuration(oftc)).configuration.password,
          vault: yield* world.vault.names,
        };
      })
    );

    expect(result).toStrictEqual({
      configured: "shared",
      vault: new Set(["a", "b", "pass", "shared"]),
    });
  });

  it("lets the Runtime close while a removal waits on a Configuration whose append stalls", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        yield* world.vault.hold(name("shared"), Redacted.make("secret"));

        // `oftc`'s appends wait for good, so only stopping its driver ends its `configure`.
        const gate = yield* Latch.make(true);

        const journal = wrapJournal(world.journal, {
          before: (record) => (networkOf(record) === oftc ? gate.await : Effect.void),
        });

        const { close, runtime } = yield* startRuntime({ ...world, journal }, client);

        yield* runtime.configure(libera, configured({ enabled: false, password: name("shared") }));
        yield* runtime.configure(oftc, configured({ enabled: false }));
        yield* gate.close;

        const changing = yield* Effect.forkChild(
          runtime.configure(oftc, configured({ enabled: false, password: name("shared") }))
        );

        yield* settle;
        yield* Fiber.interrupt(changing);
        const removing = yield* Effect.forkChild(runtime.remove(libera, { keep: false }));

        yield* settle;
        yield* close;

        return {
          networks: [...(yield* runtime.networks).values()].map((each) => each._tag),
          removed: Exit.isSuccess(yield* Effect.exit(Fiber.join(removing))),
        };
      })
    );

    expect(result).toStrictEqual({ networks: ["Stopped"], removed: true });
  });

  it("removes a Network its Client's bug stopped, now and after a restart", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        yield* held(world);

        const breaking = (runtime: RuntimeService, network: NetworkId) =>
          Effect.gen(function* () {
            yield* runtime.configure(network, configured({ password: name("pass") }));
            const call = yield* world.memory.ircd.accept;

            yield* call.open;
            yield* call.say(new TextEncoder().encode("BOOM"));
            yield* settle;
          });

        const first = yield* startRuntime(world, fragile(client));

        yield* breaking(first.runtime, libera);
        yield* breaking(first.runtime, oftc);
        const stopped = [...(yield* first.runtime.networks).values()].map((each) => each._tag);

        // Stopped as it runs.
        yield* first.runtime.remove(libera, { keep: false });
        yield* first.close;

        // Stopped by its refold, which stops at the same Line.
        const second = yield* startRuntime(world, fragile(client));
        const before = [...(yield* second.runtime.networks).keys()];
        const { sequence } = yield* second.runtime.remove(oftc, { keep: true });

        yield* second.close;
        const third = yield* startRuntime(world, fragile(client));

        const news = yield* Stream.runCollect(
          Stream.takeUntil(third.runtime.news(), (one) => one.sequence >= sequence)
        );

        return {
          before,
          kept: new Set((yield* third.runtime.kept).keys()),
          networks: [...(yield* third.runtime.networks).keys()],
          removals: news.flatMap((one) =>
            one.news.flatMap((each) =>
              each._tag === "NetworkRemoved" ? [`${one.network} ${each.keep}`] : []
            )
          ),
          stopped,
          vault: yield* world.vault.names,
        };
      })
    );

    expect(result).toStrictEqual({
      before: [oftc],
      kept: new Set([oftc]),
      networks: [],
      removals: ["libera false", "oftc true"],
      stopped: ["Stopped", "Stopped"],
      vault: new Set(["a", "b"]),
    });
  });
});
