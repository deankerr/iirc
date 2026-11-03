import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import type { NewEntry } from "@iirc/session/entry";
import { Committed, Recorder } from "@iirc/session/recorder";
import type { Watched } from "@iirc/session/recorder";
import { Effect, Exit, FileSystem, Stream } from "effect";
import type { Array as Arr } from "effect";

import { Log } from "./log.ts";

const deadline = (name: string): NewEntry => ({ _tag: "Deadline", name, network: "libera" });

const inbound: NewEntry = {
  _tag: "Line",
  bytes: new TextEncoder().encode("PRIVMSG #a :hi"),
  connection: 1,
  direction: "inbound",
  network: "libera",
};

const record = (entries: Arr.NonEmptyReadonlyArray<NewEntry>) =>
  Recorder.use(({ record }) => Effect.asVoid(record(entries, (recorded) => recorded)));

const watch = (capacity?: number) =>
  Committed.use(({ watch }) => watch(capacity === undefined ? undefined : { capacity }));

const brief = (watched: readonly Watched[]) =>
  watched.map((item) =>
    item._tag === "Overflowed"
      ? `missed ${item.missedFrom}-${item.missedTo}`
      : `${item.sequence} ${item._tag}`
  );

const withLog = <A, E>(test: Effect.Effect<A, E, Committed | Log | Recorder>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    // Not `/tmp`, because that is tmpfs on fserv, where fsync means nothing.
    const dataDir = yield* fileSystem.makeTempDirectoryScoped({
      directory: "/var/tmp",
      prefix: "iirc-committed-",
    });

    return yield* test.pipe(Effect.provide(Log.layer({ dataDir })));
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

describe("Committed, over the Log", () => {
  it.effect("gives what commits after `watch`, in sequence order, a redaction's Change too", () =>
    withLog(
      Effect.gen(function* () {
        yield* record([deadline("before")]);

        const stream = yield* Effect.scoped(
          Effect.gen(function* () {
            const watched = yield* watch();

            yield* record([inbound, deadline("a")]);
            yield* Log.use(({ redact }) =>
              redact(
                2,
                { _tag: "Change", by: "owner", change: { sequence: 2 } },
                (change) => change
              )
            );
            yield* record([deadline("b")]);

            return watched;
          })
        );

        assert.deepStrictEqual(brief(yield* Stream.runCollect(stream)), [
          "2 Line",
          "3 Deadline",
          "4 Change",
          "5 Deadline",
        ]);
      })
    )
  );

  it.effect("gives nothing from a transaction that rolled back", () =>
    withLog(
      Effect.gen(function* () {
        const stream = yield* Effect.scoped(
          Effect.gen(function* () {
            const watched = yield* watch();

            const rolledBack = yield* Effect.exit(
              Recorder.use(({ record }) =>
                record([deadline("lost")], () => {
                  throw new Error("rolled back");
                })
              )
            );

            assert.isTrue(Exit.isFailure(rolledBack));
            yield* record([deadline("kept")]);

            return watched;
          })
        );

        assert.deepStrictEqual(brief(yield* Stream.runCollect(stream)), ["1 Deadline"]);
      })
    )
  );

  it.effect("tells a slow watcher what it missed, and records on regardless", () =>
    withLog(
      Effect.gen(function* () {
        const stream = yield* Effect.scoped(
          Effect.gen(function* () {
            const watched = yield* watch(2);

            for (let index = 0; index < 5; index += 1) {
              yield* record([deadline(String(index))]);
            }

            return watched;
          })
        );

        assert.deepStrictEqual(brief(yield* Stream.runCollect(stream)), [
          "1 Deadline",
          "2 Deadline",
          "missed 3-5",
        ]);
        assert.strictEqual(yield* Log.use(({ head }) => head), 5);
      })
    )
  );
});
