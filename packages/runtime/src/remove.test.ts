/**
 * Removing a Network: its Session ends with a `QUIT`, it is unknown from then on, on this
 * Runtime and the next, its Credentials are forgotten, and its id is free again unless its
 * Timelines are kept.
 */
import { client } from "@iirc/client";
import type { Client, NetworkConfiguration } from "@iirc/client";
import { configured, parse, registered } from "@iirc/client/testing";
import { CredentialName } from "@iirc/protocol/line";
import { Effect, Fiber, Latch, Redacted, Result, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { NetworkId } from "./journal.ts";
import { TimelinesKept, UnknownNetwork } from "./runtime.ts";
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

    return yield* Fiber.join(fiber);
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
          kept: yield* runtime.kept,
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
        const kept = yield* second.runtime.kept;
        const again = yield* Effect.flip(second.runtime.configure(libera, base));

        yield* second.runtime.remove(libera, { keep: false });
        const dropped = yield* second.runtime.kept;

        yield* second.close;
        const third = yield* startRuntime(world, client);

        return {
          again,
          dropped,
          kept,
          networks,
          refused,
          restarted: [...(yield* third.runtime.networks).keys()],
          stillKept: yield* third.runtime.kept,
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
          declared: known.declared,
          networks: [...(yield* restarted.runtime.networks).keys()],
          restarted: (yield* restarted.runtime.known(libera)).declared,
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
        const sequence = yield* second.runtime.remove(oftc, { keep: true });

        yield* second.close;
        const third = yield* startRuntime(world, fragile(client));

        const news = yield* Stream.runCollect(
          Stream.takeUntil(third.runtime.news(), (one) => one.sequence >= sequence)
        );

        return {
          before,
          kept: yield* third.runtime.kept,
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
