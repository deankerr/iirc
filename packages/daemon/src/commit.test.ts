import { assert, describe, it } from "@effect/vitest";
import { Log } from "@iirc/log";
import { inProcessReader } from "@iirc/log/testing";
import { Recorder } from "@iirc/session/recorder";
import { eventually, fakeIrcd } from "@iirc/session/testing";
import type { FakeIrcd } from "@iirc/session/testing";
import { Transport } from "@iirc/session/transport";
import { Deferred, Effect, Fiber, Layer, Ref } from "effect";

import { credentialsIn, inTempDirectory, version } from "./daemon.fixture.ts";
import { Daemon } from "./daemon.ts";
import { keyCrypto } from "./keys.ts";

// A Change is recorded, folded into Configuration, and has its hosts started or stopped as
// one unit. A caller cancelled once the Log holds the Change must not leave Configuration
// or the hosts behind it, or the next operation would decide from what the Log has passed.

const owner = "owner";

const settings = {
  channels: [],
  connectCommands: [],
  credentials: {},
  enabled: true,
  id: "libera",
  identity: { alternates: [], nick: "iirc", realname: "I IRC", username: "user" },
  ircds: [{ host: "irc.test", port: 6697, tls: false }] as const,
  name: "Libera",
  quitReason: "going",
  services: [],
  tuning: {},
};

// A Daemon whose Recorder, once armed, takes a moment to answer after it has committed,
// which is the moment a cancelled caller could be lost in. `committed` hears of each.
const withSlowRecorder = <A, E, R>(
  ircd: FakeIrcd,
  test: (
    daemon: Daemon["Service"],
    arm: Effect.Effect<Deferred.Deferred<undefined>>
  ) => Effect.Effect<A, E, R>
) =>
  inTempDirectory((dataDir) =>
    Effect.gen(function* () {
      const armed = yield* Ref.make<Deferred.Deferred<undefined> | undefined>(undefined);

      const slow = Layer.effect(
        Recorder,
        Effect.gen(function* () {
          const real = yield* Recorder;

          return {
            record: (entries, within) =>
              Effect.flatMap(Ref.get(armed), (committed) =>
                committed === undefined
                  ? real.record(entries, within)
                  : Effect.uninterruptible(real.record(entries, within)).pipe(
                      Effect.tap(() => Deferred.succeed(committed, undefined)),
                      Effect.tap(() => Effect.sleep("200 millis"))
                    )
              ),
            standing: real.standing,
          } satisfies Recorder["Service"];
        })
      );

      const core = Daemon.layer({ dataDir, version }).pipe(
        Layer.provide(slow),
        Layer.provide(Layer.merge(inProcessReader({ dataDir }), credentialsIn(dataDir))),
        Layer.provideMerge(Log.layer({ dataDir })),
        Layer.provide(Layer.succeed(Transport, ircd.transport)),
        Layer.provide(keyCrypto)
      );

      return yield* Effect.gen(function* () {
        return yield* test(
          yield* Daemon,
          Effect.gen(function* () {
            const committed = yield* Deferred.make<undefined>();

            yield* Ref.set(armed, committed);

            return committed;
          })
        );
      }).pipe(Effect.provide(core));
    }).pipe(Effect.scoped)
  );

// Cancels `operation` as soon as the Log holds what it recorded, and waits for it to end.
const cancelledOnceRecorded = <A, E>(
  arm: Effect.Effect<Deferred.Deferred<undefined>>,
  operation: Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const committed = yield* arm;
    const fiber = yield* Effect.forkChild(operation);

    yield* Deferred.await(committed);
    yield* Fiber.interrupt(fiber);
  });

describe("Daemon Changes", () => {
  it.live("CONF-1: a key created is in Configuration though its caller is cancelled", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* withSlowRecorder(ircd, (daemon, arm) =>
        Effect.gen(function* () {
          yield* cancelledOnceRecorded(
            arm,
            daemon.createKey(owner, { name: "phone", scope: "read" })
          );

          assert.deepStrictEqual(
            (yield* daemon.keys).map(({ name }) => name),
            ["phone"]
          );
        })
      );
    }).pipe(Effect.scoped)
  );

  it.live(
    "CONF-1: a Network added is in Configuration and hosted though its caller is cancelled",
    () =>
      Effect.gen(function* () {
        const ircd = yield* fakeIrcd();

        yield* withSlowRecorder(ircd, (daemon, arm) =>
          Effect.gen(function* () {
            yield* cancelledOnceRecorded(arm, daemon.addNetwork(owner, settings));

            assert.deepStrictEqual(
              (yield* daemon.networks).map(({ settings: { id } }) => id),
              ["libera"]
            );
            // Hosted, which only a host that was started can be.
            yield* eventually(ircd.dials, (dialled) => dialled.length > 0);
          })
        );
      }).pipe(Effect.scoped)
  );
});
