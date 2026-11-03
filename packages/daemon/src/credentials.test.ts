import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { inspect } from "node:util";

import { assert, describe, it } from "@effect/vitest";
import { CredentialsUnavailable } from "@iirc/api";
import { Log } from "@iirc/log";
import { eventually } from "@iirc/session/testing";
import { Deferred, Effect, Exit, Fiber, Layer, Logger, Redacted, Schema, Stream } from "effect";
import type { Duration } from "effect";
import { TestClock } from "effect/testing";

import { finishes, untilTrue, withinClock } from "./clock.fixture.ts";
import { Credentials, credentialsFile, CredentialsUnreadable } from "./credentials.ts";
import type { Keyring } from "./credentials.ts";
import { inTempDirectory, noKeyring } from "./daemon.fixture.ts";

// CRED-1 and CRED-3 for the service alone: where Credentials are kept, how the file is
// replaced, when a start refuses, and that a value never shows.

const secret = "hunter2-correct-horse";

// Starts the service on a data directory, with the Log holding it as the Daemon's does.
const withCredentials = <A, E, R>(
  dataDir: string,
  keyring: Keyring,
  test: (credentials: Credentials["Service"]) => Effect.Effect<A, E, R>,
  writeTimeout?: Duration.Input
) =>
  Credentials.use(test).pipe(
    Effect.provide(
      Credentials.layer({
        dataDir,
        keyring,
        ...(writeTimeout !== undefined && { writeTimeout }),
      }).pipe(Layer.provide(Log.layer({ dataDir })))
    ),
    Effect.scoped
  );

const starting = (dataDir: string, keyring: Keyring) =>
  Effect.flip(withCredentials(dataDir, keyring, () => Effect.void));

// What a test remembers of every Credential: its name, when it was set, and its value.
const heldBy = (credentials: Credentials["Service"]) =>
  Effect.gen(function* () {
    const all = yield* credentials.all;
    const names = yield* credentials.names;

    return names.map(({ name, set }) => ({
      name,
      set,
      value: Redacted.value(all.get(name) ?? Redacted.make("")),
    }));
  });

// A keyring that keeps what it is given, as a desktop's would.
const memoryKeyring = () => {
  const entries = new Map<string, string>();

  const keyring: Keyring = {
    get: async ({ name, service }) =>
      await Promise.resolve(entries.get(`${service}/${name}`) ?? null),
    set: async ({ name, service, value }) => {
      entries.set(`${service}/${name}`, value);
      await Promise.resolve();
    },
  };

  return { entries, keyring };
};

// A keyring that never answers, as one waiting on an unlock prompt nobody sees. `asked` is
// done once it has been asked anything.
const silentKeyring = () => {
  const asked = Deferred.makeUnsafe<undefined>();

  const keyring: Keyring = {
    get: async () => {
      Deferred.doneUnsafe(asked, Effect.undefined);

      return await Effect.runPromise(Effect.never);
    },
    set: async () => {
      await Effect.runPromise(Effect.never);
    },
  };

  return { asked, keyring };
};

// A write that never answers.
const stalled = async () => {
  await Effect.runPromise(Effect.never);
};

// Waits outside any Effect, as a keyring's own promise does.
const untilDone = async (deferred: Deferred.Deferred<undefined>) => {
  await Effect.runPromise(Deferred.await(deferred));
};

const decodeDocument = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

const modeOf = (path: string) => statSync(path).mode % 0o1000;

// A keyring whose second write waits for `release`, as one that is locked does, and then
// goes as `ending` says. The first write goes through, so there is something to undo to.
const lockedOnSecondWrite = (
  dataDir: string,
  ending: "fails" | "keeps" | "keeps, but cannot be undone"
) => {
  const { entries, keyring: inner } = memoryKeyring();
  const entry = `iirc/credentials ${realpathSync(dataDir)}`;
  const release = Deferred.makeUnsafe<undefined>();
  let writes = 0;

  const keyring: Keyring = {
    get: inner.get,
    set: async (options) => {
      writes += 1;

      if (writes === 2) {
        await untilDone(release);

        if (ending === "fails") {
          throw new Error("the keyring is locked");
        }
      }

      if (writes === 3 && ending === "keeps, but cannot be undone") {
        throw new Error("the keyring is locked");
      }

      await inner.set(options);
    },
  };

  const persisted = Effect.sync(() => {
    const text = entries.get(entry);

    return text === undefined ? [] : Object.keys(decodeDocument(JSON.parse(text))).toSorted();
  });

  return {
    keyring,
    persisted,
    release: Effect.sync(() => {
      Deferred.doneUnsafe(release, Effect.undefined);
    }),
    // Waits for the third write, which is the undoing, to have landed.
    undone: eventually(
      persisted.pipe(Effect.map((names) => ({ names, writes }))),
      (now) => now.writes === 3 && now.names.join(",") === "base"
    ),
    writes: () => writes,
  };
};

describe("Credentials (CRED-1, CRED-3)", () => {
  it.live(
    "CRED-1: with no keyring, keeps them in credentials.json with mode 0600, and reads them back after a restart",
    () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const file = `${dataDir}/${credentialsFile}`;

          const before = yield* withCredentials(dataDir, noKeyring, (credentials) =>
            Effect.gen(function* () {
              assert.strictEqual(credentials.store, "file");

              yield* credentials.set("libera.sasl", Redacted.make(secret));
              yield* credentials.set("oftc.pass", Redacted.make("second"));

              return yield* heldBy(credentials);
            })
          );

          assert.deepStrictEqual(
            before.map(({ name, value }) => ({ name, value })),
            [
              { name: "libera.sasl", value: secret },
              { name: "oftc.pass", value: "second" },
            ]
          );
          assert.isAbove(before[0]?.set ?? 0, 0);
          assert.strictEqual(modeOf(file), 0o600);
          // Nothing half written, and no sign of a keyring.
          assert.sameMembers(
            readdirSync(dataDir).filter((name) => name.startsWith("credentials")),
            [credentialsFile]
          );

          const after = yield* withCredentials(dataDir, noKeyring, heldBy);

          assert.deepStrictEqual(after, before);
        })
      )
  );

  it.live(
    "CRED-1: the file is replaced whole, never written in place, so a crash leaves the old one or the new",
    () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const file = `${dataDir}/${credentialsFile}`;

          yield* withCredentials(dataDir, noKeyring, (credentials) =>
            Effect.gen(function* () {
              yield* credentials.set("a", Redacted.make("old"));

              const first = statSync(file).ino;

              yield* credentials.set("a", Redacted.make("new"));

              assert.notStrictEqual(statSync(file).ino, first, "a new file took the name");
            })
          );

          // A crash part way through the next write leaves its temporary file, which was
          // never the Credentials: the old file stands, and the leftover goes.
          writeFileSync(`${file}.partial`, '{"a": {"set": 1, "value": "never kept"', {
            mode: 0o600,
          });

          const after = yield* withCredentials(dataDir, noKeyring, heldBy);

          assert.deepStrictEqual(
            after.map(({ value }) => value),
            ["new"]
          );
          assert.isFalse(existsSync(`${file}.partial`));
        })
      )
  );

  it.live("CRED-1: refuses to start on a file other users may read, and says how to mend it", () =>
    inTempDirectory((dataDir) =>
      Effect.gen(function* () {
        const file = `${dataDir}/${credentialsFile}`;

        yield* withCredentials(dataDir, noKeyring, (credentials) =>
          credentials.set("a", Redacted.make(secret))
        );

        chmodSync(file, 0o644);

        const refused = yield* starting(dataDir, noKeyring);

        assert.instanceOf(refused, CredentialsUnreadable);
        assert.include(refused.message, "0644");
        assert.include(refused.message, `chmod 600 ${file}`);
        assert.notInclude(refused.message, secret);
        // Refused, and not quietly fixed.
        assert.strictEqual(modeOf(file), 0o644);
      })
    )
  );

  it.live("CRED-1: refuses a file it cannot read without repeating what is in it", () =>
    inTempDirectory((dataDir) =>
      Effect.gen(function* () {
        const file = `${dataDir}/${credentialsFile}`;

        // Bun's JSON parser quotes the text it stopped at, which here is the value.
        writeFileSync(file, `{"a": {"set": 1, "value": ${secret}}}`, { mode: 0o600 });

        const notJson = yield* starting(dataDir, noKeyring);

        writeFileSync(file, JSON.stringify({ "Not A Name": { set: 1, value: secret } }), {
          mode: 0o600,
        });

        const wrongName = yield* starting(dataDir, noKeyring);

        assert.instanceOf(notJson, CredentialsUnreadable);
        assert.include(notJson.message, "not JSON");
        assert.notInclude(notJson.message, secret);
        assert.instanceOf(wrongName, CredentialsUnreadable);
        assert.include(wrongName.message, "Not A Name");
        assert.notInclude(wrongName.message, secret);
      })
    )
  );

  it.live(
    "CRED-1: a keyring that answers the probe keeps them, in one entry, and no file is written",
    () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const { entries, keyring } = memoryKeyring();

          yield* withCredentials(dataDir, keyring, (credentials) =>
            Effect.gen(function* () {
              assert.strictEqual(credentials.store, "keyring");

              yield* credentials.set("libera.sasl", Redacted.make(secret));
              yield* credentials.set("oftc.pass", Redacted.make("second"));
              yield* credentials.delete("oftc.pass");
            })
          );

          assert.deepStrictEqual(
            [...entries.keys()],
            [`iirc/credentials ${realpathSync(dataDir)}`]
          );
          assert.isFalse(existsSync(`${dataDir}/${credentialsFile}`));

          const after = yield* withCredentials(dataDir, keyring, heldBy);

          assert.deepStrictEqual(
            after.map(({ name, value }) => ({ name, value })),
            [{ name: "libera.sasl", value: secret }]
          );
        })
      )
  );

  it.effect(
    "CRED-1: a keyring that refuses the probe, or does not answer it in time, leaves them in the file",
    () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const refusing = yield* withCredentials(dataDir, noKeyring, ({ store }) =>
            Effect.succeed(store)
          );

          const { asked, keyring } = silentKeyring();

          const silent = yield* Effect.forkChild(
            withCredentials(dataDir, keyring, ({ store }) => Effect.succeed(store))
          );

          yield* Deferred.await(asked);

          // It gives up on the keyring, however long the keyring takes.
          assert.strictEqual(refusing, "file");
          assert.strictEqual(
            yield* withinClock("5 seconds", "giving up on the keyring", Fiber.join(silent)),
            "file"
          );
        })
      )
  );

  it.live("CRED-1: the real keyring's probe decides as the platform answers", () =>
    inTempDirectory((dataDir) =>
      Effect.gen(function* () {
        // Asked directly, the way the probe asks, for an entry no one has.
        const answered = yield* Effect.tryPromise(
          async () => await Bun.secrets.get({ name: `probe ${dataDir}`, service: "iirc-test" })
        ).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false)
        );

        const store = yield* withCredentials(dataDir, Bun.secrets, (credentials) =>
          Effect.succeed(credentials.store)
        );

        assert.strictEqual(store, answered ? "keyring" : "file");
      })
    )
  );

  it.live(
    "CRED-1: once they are in a keyring, a start without it refuses rather than begin with none",
    () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const { keyring } = memoryKeyring();

          yield* withCredentials(dataDir, keyring, (credentials) =>
            credentials.set("a", Redacted.make(secret))
          );

          const refused = yield* starting(dataDir, noKeyring);

          assert.instanceOf(refused, CredentialsUnreadable);
          assert.include(refused.message, "keyring");
          assert.isFalse(existsSync(`${dataDir}/${credentialsFile}`));
        })
      )
  );

  it.live(
    "CRED-1: the keyring marker is on disk before the first Credential is reported stored",
    () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const { entries, keyring: inner } = memoryKeyring();
          const marker = `${dataDir}/credentials.keyring`;
          const markerWhenSet: (string | undefined)[] = [];

          // What the marker is at the moment the keyring is first asked to keep anything.
          const keyring: Keyring = {
            get: inner.get,
            set: async (options) => {
              markerWhenSet.push(existsSync(marker) ? readFileSync(marker, "utf-8") : undefined);
              await inner.set(options);
            },
          };

          yield* withCredentials(dataDir, keyring, (credentials) =>
            Effect.gen(function* () {
              assert.isTrue(existsSync(marker), "marked as soon as the keyring is chosen");
              yield* credentials.set("a", Redacted.make(secret));
              assert.strictEqual(entries.size, 1);
            })
          );

          assert.deepStrictEqual(markerWhenSet, [`iirc\ncredentials ${realpathSync(dataDir)}\n`]);
          assert.notInclude(readFileSync(marker, "utf-8"), secret);
        })
      )
  );

  it.live(
    "CRED-1: a set that is cancelled while the keyring writes cannot let a later one be overwritten",
    () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const { entries, keyring: inner } = memoryKeyring();
          const entry = `iirc/credentials ${realpathSync(dataDir)}`;
          const release = Deferred.makeUnsafe<undefined>();
          const asked = Deferred.makeUnsafe<undefined>();
          let writes = 0;

          // The first write is slow, and takes its value when it is asked, as a real one does.
          const keyring: Keyring = {
            get: inner.get,
            set: async (options) => {
              writes += 1;

              if (writes === 1) {
                Deferred.doneUnsafe(asked, Effect.undefined);
                await untilDone(release);
              }

              await inner.set(options);
            },
          };

          const persisted = () => {
            const text = entries.get(entry);

            return text === undefined ? [] : Object.keys(decodeDocument(JSON.parse(text)));
          };

          yield* withCredentials(dataDir, keyring, (credentials) =>
            Effect.gen(function* () {
              const first = yield* Effect.forkChild(credentials.set("a", Redacted.make("one")));

              yield* Deferred.await(asked);

              // Cancelled with its write still on the way, and then another set after it.
              const cancelling = yield* Effect.forkChild(Fiber.interrupt(first));
              const second = yield* Effect.forkChild(credentials.set("b", Redacted.make("two")));

              // Nothing real is awaited before the second set reaches the Change permit
              // behind the first, so a few scheduler turns are all it takes.
              yield* Effect.repeat(Effect.yieldNow, { times: 100 });
              Deferred.doneUnsafe(release, Effect.undefined);
              yield* Fiber.join(cancelling);
              yield* Fiber.join(second);

              const live = (yield* credentials.names).map(({ name }) => name);

              assert.include(live, "b");
              assert.include(persisted(), "b", "the keyring has what was acknowledged");
              assert.deepStrictEqual(persisted().toSorted(), live, "and no more or less than live");
            })
          );

          const after = yield* withCredentials(dataDir, keyring, heldBy);

          assert.include(
            after.map(({ name }) => name),
            "b"
          );
        })
      )
  );

  it.effect(
    "CRED-1: a write that never ends costs its caller the bound, fails later ones at once, and never overlaps them",
    () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const { keyring: inner } = memoryKeyring();
          const entered = Deferred.makeUnsafe<undefined>();
          let asked = 0;

          // Answers the probe, and then never answers a write.
          const keyring: Keyring = {
            get: inner.get,
            set: async () => {
              asked += 1;
              Deferred.doneUnsafe(entered, Effect.undefined);
              await stalled();
            },
          };

          yield* withCredentials(
            dataDir,
            keyring,
            (credentials) =>
              Effect.gen(function* () {
                const writing = yield* Effect.forkChild(
                  Effect.flip(credentials.set("a", Redacted.make("one")))
                );

                yield* Deferred.await(entered);

                // The caller waits the whole bound, and not a moment less.
                yield* TestClock.adjust("199 millis");
                assert.isUndefined(writing.pollUnsafe(), "the caller was told before the bound");
                yield* TestClock.adjust("1 milli");
                assert.instanceOf(
                  yield* finishes(writing, "the first set"),
                  CredentialsUnavailable
                );

                // The clock stands still from here, so a write that was to wait a bound of
                // its own would never finish, and `finishes` calls that hung.
                const second = yield* Effect.forkChild(
                  Effect.flip(credentials.set("b", Redacted.make("two")))
                );

                const third = yield* Effect.forkChild(Effect.flip(credentials.delete("a")));

                assert.instanceOf(yield* finishes(second, "a later set"), CredentialsUnavailable);
                assert.instanceOf(yield* finishes(third, "a later delete"), CredentialsUnavailable);
                assert.strictEqual(asked, 1, "the keyring was never asked for a second write");
                assert.deepStrictEqual(
                  yield* credentials.names,
                  [],
                  "live holds only what was kept"
                );
              }),
            "200 millis"
          );
        })
      )
  );

  it.live(
    "CRED-1: a write that ends after its caller was told it failed is undone, so the store is what live is, now and after a restart",
    () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const locked = lockedOnSecondWrite(dataDir, "keeps");

          yield* withCredentials(
            dataDir,
            locked.keyring,
            (credentials) =>
              Effect.gen(function* () {
                yield* credentials.set("base", Redacted.make("one"));

                const failure = yield* Effect.flip(credentials.set("a", Redacted.make("two")));

                assert.instanceOf(failure, CredentialsUnavailable);

                yield* locked.release;

                // The keyring keeps "a" for a moment, and then has it taken back.
                yield* locked.undone;
                assert.strictEqual(locked.writes(), 3);
                assert.deepStrictEqual(
                  (yield* credentials.names).map(({ name }) => name),
                  ["base"]
                );

                // The permit is free again, once the undoing has ended.
                yield* credentials.set("b", Redacted.make("three"));
                assert.deepStrictEqual(yield* locked.persisted, ["b", "base"]);
              }),
            "200 millis"
          );

          const after = yield* withCredentials(dataDir, locked.keyring, heldBy);

          assert.deepStrictEqual(
            after.map(({ name }) => name),
            ["b", "base"]
          );
        })
      )
  );

  it.live("CRED-1: a store that undoes a write leaves what a restart reads equal to live", () =>
    inTempDirectory((dataDir) =>
      Effect.gen(function* () {
        const locked = lockedOnSecondWrite(dataDir, "keeps");

        const live = yield* withCredentials(
          dataDir,
          locked.keyring,
          (credentials) =>
            Effect.gen(function* () {
              yield* credentials.set("base", Redacted.make("one"));
              yield* Effect.flip(credentials.set("a", Redacted.make("two")));
              yield* locked.release;
              yield* locked.undone;

              return yield* heldBy(credentials);
            }),
          "200 millis"
        );

        assert.deepStrictEqual(yield* withCredentials(dataDir, locked.keyring, heldBy), live);
      })
    )
  );

  it.live("CRED-1: a write that itself fails after the caller was told needs no undoing", () =>
    inTempDirectory((dataDir) =>
      Effect.gen(function* () {
        const locked = lockedOnSecondWrite(dataDir, "fails");

        yield* withCredentials(
          dataDir,
          locked.keyring,
          (credentials) =>
            Effect.gen(function* () {
              yield* credentials.set("base", Redacted.make("one"));
              yield* Effect.flip(credentials.set("a", Redacted.make("two")));
              yield* locked.release;
              yield* Effect.sleep("100 millis");

              assert.strictEqual(locked.writes(), 2, "nothing was written to undo it");
              assert.deepStrictEqual(yield* locked.persisted, ["base"]);

              yield* credentials.set("b", Redacted.make("three"));
              assert.deepStrictEqual(yield* locked.persisted, ["b", "base"]);
            }),
          "200 millis"
        );
      })
    )
  );

  it.live(
    "CRED-1: a store that cannot be put back is unavailable for writes until a restart, and still read",
    () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const locked = lockedOnSecondWrite(dataDir, "keeps, but cannot be undone");

          yield* withCredentials(
            dataDir,
            locked.keyring,
            (credentials) =>
              Effect.gen(function* () {
                yield* credentials.set("base", Redacted.make("one"));
                yield* Effect.flip(credentials.set("a", Redacted.make("two")));
                yield* locked.release;
                yield* eventually(Effect.sync(locked.writes), (writes) => writes === 3);

                // A write now either finds the store given up on, or waits for the permit
                // the failed undoing still holds and then finds it so.
                const set = yield* Effect.flip(credentials.set("b", Redacted.make("three")));
                const deleted = yield* Effect.flip(credentials.delete("base"));

                assert.instanceOf(set, CredentialsUnavailable);
                assert.instanceOf(deleted, CredentialsUnavailable);
                assert.strictEqual(locked.writes(), 3, "nothing else was written");
                assert.deepStrictEqual(
                  (yield* credentials.names).map(({ name }) => name),
                  ["base"]
                );
                assert.strictEqual(
                  Redacted.value((yield* credentials.all).get("base") ?? Redacted.make("")),
                  "one"
                );
              }),
            "200 millis"
          );
        })
      )
  );

  it.effect("CRED-1: a write already queued when an undoing fails is refused, not written", () =>
    inTempDirectory((dataDir) =>
      Effect.gen(function* () {
        const locked = lockedOnSecondWrite(dataDir, "keeps, but cannot be undone");

        yield* withCredentials(
          dataDir,
          locked.keyring,
          (credentials) =>
            Effect.gen(function* () {
              yield* credentials.set("base", Redacted.make("one"));

              const first = yield* Effect.forkChild(
                Effect.flip(credentials.set("a", Redacted.make("two")))
              );

              yield* untilTrue(Effect.sync(locked.writes), (writes) => writes === 2);

              // Queued behind the first before it is overdue, so it waits for the permit
              // and is still waiting when the first's undoing fails.
              yield* TestClock.adjust("150 millis");

              const queued = yield* Effect.forkChild(
                Effect.exit(credentials.set("b", Redacted.make("three")))
              );

              // Nothing real is awaited before it reaches the permit, so a few scheduler
              // turns are all it takes.
              yield* Effect.repeat(Effect.yieldNow, { times: 100 });
              yield* TestClock.adjust("50 millis");

              assert.instanceOf(yield* finishes(first, "the first set"), CredentialsUnavailable);
              yield* locked.release;

              const outcome = yield* finishes(queued, "the queued set");

              assert.isTrue(Exit.isFailure(outcome), "the queued write was refused");
              assert.strictEqual(locked.writes(), 3, "nothing was written after the undoing");
              assert.deepStrictEqual(
                (yield* credentials.names).map(({ name }) => name),
                ["base"]
              );
            }),
          "200 millis"
        );
      })
    )
  );

  it.effect("CRED-1: closing the service does not wait for a write that never ends", () =>
    inTempDirectory((dataDir) =>
      Effect.gen(function* () {
        const entered = Deferred.makeUnsafe<undefined>();

        const keyring: Keyring = {
          get: async () => await Promise.resolve(null),
          set: async () => {
            Deferred.doneUnsafe(entered, Effect.undefined);
            await stalled();
          },
        };

        const running = yield* Effect.forkChild(
          withCredentials(
            dataDir,
            keyring,
            (credentials) =>
              Effect.gen(function* () {
                const writing = yield* Effect.forkChild(
                  Effect.flip(credentials.set("a", Redacted.make("one")))
                );

                yield* Deferred.await(entered);
                yield* TestClock.adjust("100 millis");

                return yield* finishes(writing, "the write's caller");
              }),
            "100 millis"
          )
        );

        // The caller has been told, and the write goes on. Closing moves no clock, so a
        // close that waited for the write would never end.
        assert.instanceOf(yield* finishes(running, "the service, closed"), CredentialsUnavailable);
      })
    )
  );

  it.live("CRED-1: a file already there wins over a keyring that appears later", () =>
    inTempDirectory((dataDir) =>
      Effect.gen(function* () {
        yield* withCredentials(dataDir, noKeyring, (credentials) =>
          credentials.set("a", Redacted.make(secret))
        );

        const { entries, keyring } = memoryKeyring();

        const after = yield* withCredentials(dataDir, keyring, (credentials) =>
          Effect.map(heldBy(credentials), (held) => ({ held, store: credentials.store }))
        );

        assert.strictEqual(after.store, "file");
        assert.deepStrictEqual(
          after.held.map(({ value }) => value),
          [secret]
        );
        assert.strictEqual(entries.size, 0);
      })
    )
  );

  it.live("CRED-1: whatever uses them hears of every change", () =>
    inTempDirectory((dataDir) =>
      withCredentials(dataDir, noKeyring, (credentials) =>
        Effect.gen(function* () {
          const heard = yield* credentials.changes.pipe(
            Stream.map((all) => [...all.keys()]),
            Stream.take(4),
            Stream.runCollect,
            Effect.forkChild
          );

          yield* Effect.yieldNow;
          yield* credentials.set("a", Redacted.make("one"));
          yield* credentials.set("b", Redacted.make("two"));
          yield* credentials.delete("a");

          assert.deepStrictEqual(yield* Fiber.join(heard), [[], ["a"], ["a", "b"], ["b"]]);
        })
      )
    )
  );

  it.live(
    "LOG-6: gives the very same Map until a Credential changes, so scrubbing builds its search once",
    () =>
      inTempDirectory((dataDir) =>
        withCredentials(dataDir, noKeyring, (credentials) =>
          Effect.gen(function* () {
            yield* credentials.set("a", Redacted.make("one"));

            const first = yield* credentials.all;
            const again = yield* credentials.all;

            // Deleting what is not there writes nothing, so nothing changes.
            yield* credentials.delete("missing");

            const unchanged = yield* credentials.all;

            yield* credentials.set("a", Redacted.make("two"));

            const changed = yield* credentials.all;

            assert.strictEqual(again, first);
            assert.strictEqual(unchanged, first);
            assert.notStrictEqual(changed, first);
            assert.strictEqual(Redacted.value(changed.get("a") ?? Redacted.make("")), "two");
          })
        )
      )
  );

  it.live("CRED-3: a value never shows when what the service holds is printed or logged", () =>
    inTempDirectory((dataDir) =>
      Effect.gen(function* () {
        const logged: string[] = [];

        const logger = Logger.layer([
          Logger.make((options) => {
            logged.push(Logger.formatSimple.log(options));
          }),
        ]);

        yield* withCredentials(dataDir, noKeyring, (credentials) =>
          Effect.gen(function* () {
            yield* credentials.set("a", Redacted.make(secret));

            const all = yield* credentials.all;
            const names = yield* credentials.names;

            yield* Effect.logError("holding", all, names, all.get("a"));

            for (const shown of [
              inspect(all.get("a")),
              JSON.stringify(all.get("a")),
              inspect(all, { depth: 10 }),
              JSON.stringify([...all]),
              JSON.stringify(names),
            ]) {
              assert.notInclude(shown, secret);
            }
          })
        ).pipe(Effect.provide(logger));

        assert.isNotEmpty(logged);

        for (const line of logged) {
          assert.notInclude(line, secret);
        }
      })
    )
  );
});
