import { assert, describe, it } from "@effect/vitest";
import { CredentialsUnavailable } from "@iirc/api";
import { fakeIrcd, movingClockWhileClosing } from "@iirc/session/testing";
import type { FakeIrcd } from "@iirc/session/testing";
import { Transport } from "@iirc/session/transport";
import { Deferred, Effect, Layer, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";

import { finishes, untilTrue, withinClock } from "./clock.fixture.ts";
import type { Keyring } from "./credentials.ts";
import { coreFor, inTempDirectory, version } from "./daemon.fixture.ts";
import { Daemon } from "./daemon.ts";

// CRED-1 when the keyring answered the probe and then stopped answering, as a locked one
// does. A write that never ends must cost its callers a bounded wait and no more, and must
// hold up neither another Change nor the Daemon's stop.
//
// The bound is policy, so these run on `TestClock`: a test moves the clock by the bound,
// and what it calls "at once" is whatever finishes with the clock not moved at all, which
// no busy machine can make late. The work around the clock (SQLite, the HTTP-less Daemon)
// is real, so waiting for it uses the live clock, with a limit that only a hang reaches.

const owner = "owner";
const bound = 300;

const settings = {
  channels: [{ autojoin: true, name: "#c", rejoinOnKick: false }],
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

const decodeDocument = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

// Answers the probe, and then keeps what it is given only once `release` says so.
// `entered` is done when the first write reaches it, which is when the write holds the
// Change permit and is stuck, and `writes` counts the writes that ever did.
const lockedKeyring = (release: Deferred.Deferred<undefined>) => {
  const entries = new Map<string, string>();
  const entered = Deferred.makeUnsafe<undefined>();
  let writes = 0;

  const keyring: Keyring = {
    get: async ({ name, service }) =>
      await Promise.resolve(entries.get(`${service}/${name}`) ?? null),
    set: async ({ name, service, value }) => {
      writes += 1;
      Deferred.doneUnsafe(entered, Effect.undefined);
      await Effect.runPromise(Deferred.await(release));
      entries.set(`${service}/${name}`, value);
    },
  };

  // The names in what the keyring holds now, or nothing if it has never been written.
  const persisted = Effect.sync(() => {
    const [text] = entries.values();

    return text === undefined
      ? undefined
      : Object.keys(decodeDocument(JSON.parse(text))).toSorted();
  });

  return { entered, keyring, persisted, writes: Effect.sync(() => writes) };
};

const secret = Redacted.make("hunter2-correct-horse");

interface Harness {
  readonly daemon: Daemon["Service"];
  /** Done once a write is stuck in the keyring, holding the Change permit. */
  readonly entered: Effect.Effect<void>;
  readonly ircd: FakeIrcd;
  readonly persisted: Effect.Effect<string[] | undefined>;
  readonly release: Deferred.Deferred<undefined>;
  /** How many writes ever reached the keyring. */
  readonly writes: Effect.Effect<number>;
}

// A Daemon hosting one Network, on a keyring that is locked until `release`, with the
// clock moving as the Daemon stops.
const withLockedKeyring = <A, E, R>(test: (harness: Harness) => Effect.Effect<A, E, R>) =>
  inTempDirectory((dataDir) =>
    movingClockWhileClosing(
      Effect.gen(function* () {
        const ircd = yield* fakeIrcd();
        const release = yield* Deferred.make<undefined>();
        const { entered, keyring, persisted, writes } = lockedKeyring(release);

        const context = yield* Layer.build(
          coreFor(
            { dataDir, version },
            {
              keyring,
              transport: Layer.succeed(Transport, ircd.transport),
              writeTimeout: `${bound} millis`,
            }
          )
        );

        return yield* Effect.gen(function* () {
          const daemon = yield* Daemon;

          yield* daemon.addNetwork(owner, settings);
          yield* untilTrue(ircd.dials, (dialled) => dialled.length > 0);
          yield* ircd.read(":ircd 001 iirc :Welcome\r\n");
          yield* untilTrue(daemon.network("libera"), ({ status }) => status.phase === "session");

          return yield* test({
            daemon,
            entered: Deferred.await(entered),
            ircd,
            persisted,
            release,
            writes,
          });
        }).pipe(Effect.provideContext(context));
      })
    ).pipe(Effect.scoped)
  );

const names = (daemon: Daemon["Service"]) =>
  daemon.credentials.pipe(Effect.map(({ credentials }) => credentials.map(({ name }) => name)));

// The Changes in the Log, each as its tag and the name it concerns.
const credentialChanges = (daemon: Daemon["Service"]) =>
  daemon
    .entries({ after: 0, kinds: ["Change"], limit: 1000 })
    .pipe(
      Effect.map(({ entries }) =>
        entries.flatMap((entry) =>
          entry._tag === "Change" && /Credential|ChannelKey/u.test(JSON.stringify(entry.change))
            ? [JSON.stringify(entry.change)]
            : []
        )
      )
    );

describe("a keyring that stops answering", () => {
  it.effect(
    "CRED-1: tells the caller after the bound, and fails later writes at once without running them",
    () =>
      withLockedKeyring(({ daemon, entered, writes }) =>
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(
            Effect.flip(daemon.setCredential(owner, "a", secret))
          );

          yield* entered;

          // Not a moment before the bound.
          yield* TestClock.adjust(bound - 1);
          assert.isUndefined(first.pollUnsafe(), "the caller was told before the bound");

          yield* TestClock.adjust(1);
          assert.instanceOf(yield* finishes(first, "the first write"), CredentialsUnavailable);

          // The clock stands still from here, so a write that is to wait for a bound of
          // its own never finishes, and `finishes` calls that hung.
          const second = yield* Effect.forkChild(
            Effect.flip(daemon.setCredential(owner, "b", secret))
          );

          const third = yield* Effect.forkChild(Effect.flip(daemon.deleteCredential(owner, "a")));

          assert.instanceOf(yield* finishes(second, "a later set"), CredentialsUnavailable);
          assert.instanceOf(yield* finishes(third, "a later delete"), CredentialsUnavailable);
          assert.strictEqual(yield* writes, 1, "only the first write ever reached the keyring");

          // Nothing is claimed that was not kept, and Changes of other kinds go on.
          assert.deepStrictEqual(yield* names(daemon), []);
          yield* daemon.createKey(owner, { name: "phone", scope: "read" });
        })
      )
  );

  it.effect(
    "CRED-1: stops within the bound, and closes the Network, with a write still stuck",
    () =>
      withLockedKeyring(({ daemon, entered, ircd }) =>
        Effect.gen(function* () {
          const writing = yield* Effect.forkChild(
            Effect.flip(daemon.setCredential(owner, "a", secret))
          );

          // Holding the Change permit, on a keyring that has not answered.
          yield* entered;

          yield* withinClock(bound, "the stop", daemon.stop);

          assert.instanceOf(yield* finishes(writing, "the stuck write"), CredentialsUnavailable);
          assert.isTrue(
            (yield* ircd.written).some((bytes) =>
              Buffer.from(bytes).toString().includes("QUIT going")
            ),
            "the Network was told to leave"
          );
        })
      )
  );

  it.effect(
    "CRED-1: a write that ends late is undone, with a delete queued behind it failing, and the Log and the store agree",
    () =>
      withLockedKeyring(({ daemon, entered, persisted, release }) =>
        Effect.gen(function* () {
          // The set holds the Change permit while the keyring is locked, and the delete queues.
          const setting = yield* Effect.forkChild(
            Effect.flip(daemon.setCredential(owner, "a", secret))
          );

          yield* entered;

          const deleting = yield* Effect.forkChild(
            Effect.flip(daemon.deleteCredential(owner, "a"))
          );

          yield* TestClock.adjust(bound);
          assert.instanceOf(yield* finishes(setting, "the set"), CredentialsUnavailable);
          yield* finishes(deleting, "the delete");

          yield* Deferred.succeed(release, undefined);

          // The keyring takes the value, and then the service puts back what it held.
          yield* untilTrue(persisted, (held) => held !== undefined && held.length === 0);
          yield* TestClock.withLive(Effect.sleep("100 millis"));

          assert.deepStrictEqual(yield* persisted, [], "the store is what live is");
          assert.deepStrictEqual(yield* names(daemon), []);
          assert.deepStrictEqual(
            yield* credentialChanges(daemon),
            [],
            "the Log says nothing of a write that failed"
          );

          // And the next write goes through.
          yield* daemon.setCredential(owner, "b", secret);
          assert.deepStrictEqual(yield* persisted, ["b"]);
          assert.deepStrictEqual(yield* names(daemon), ["b"]);
          assert.lengthOf(yield* credentialChanges(daemon), 1);
        })
      )
  );
});
