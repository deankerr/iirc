import { existsSync, rmSync } from "node:fs";

import { BunFileSystem } from "@effect/platform-bun";
import { client } from "@iirc/client";
import { configured } from "@iirc/client/testing";
import { makeSqliteJournal } from "@iirc/journal-sqlite";
import { Runtime, layerRuntime } from "@iirc/runtime";
import { Journal, NetworkId } from "@iirc/runtime/journal";
import { Transport } from "@iirc/runtime/transport";
import { Vault } from "@iirc/runtime/vault";
import { TimelineStore, TimelineStoreFailed } from "@iirc/timeline-store";
import type { Item, TimelineStoreService } from "@iirc/timeline-store";
import { makeSqliteTimelineStore } from "@iirc/timeline-store-sqlite";
import { makeMemoryTimelineStore } from "@iirc/timeline-store/testing";
import { emptyDirectory, projectionVersion, step, timelineIdOf } from "@iirc/timelines";
import { Effect, Layer, Logger, Option, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { Projector, layerProjector } from "./projector.ts";
import { heard, makeWorld, registerOnFloor, say, temporaryDirectory } from "./testing/world.ts";
import type { World } from "./testing/world.ts";

const libera = NetworkId.make("libera");

const floor = configured({
  channels: [{ name: "#iirc" }],
  ircds: [{ host: "irc.test", port: 6667, tls: false }],
});

/** 2026-01-01T00:00:00Z, where every test's clock starts. */
const epoch = 1_767_225_600_000;

/**
 * The Runtime on the world's ports with the real Client, and the projector folding its
 * News into a store, logging into the world.
 * @param world - The ports.
 * @param store - The Timeline store.
 * @returns The Layer.
 */
const layerDaemonish = (world: World, store: TimelineStoreService) =>
  layerProjector.pipe(
    Layer.provideMerge(Layer.succeed(TimelineStore, store)),
    Layer.provideMerge(
      layerRuntime(client).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(Journal, world.journal),
            Layer.succeed(Transport, world.memory.transport),
            Layer.succeed(Vault, world.vault)
          )
        )
      )
    ),
    Layer.provideMerge(
      Logger.layer([
        Logger.make(({ message }) => {
          world.logged.push(JSON.stringify(message));
        }),
      ])
    )
  );

// Runs a test on a TestClock set to the epoch.
const run = async <A, E>(test: Effect.Effect<A, E>): Promise<A> =>
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(epoch);

      return yield* test;
    }).pipe(Effect.provide(TestClock.layer()))
  );

/**
 * Waits, a turn at a time, until a check holds.
 * @param check - What must come to hold.
 * @returns An Effect that ends once it holds, or dies after many turns.
 */
const eventually = <E, R>(check: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    let turns = 0;

    while (!(yield* check)) {
      turns += 1;

      if (turns > 5000) {
        return yield* Effect.die(new Error("it never came to hold"));
      }

      yield* Effect.yieldNow;
    }

    return turns;
  });

// Configures the Network, registers it, and joins `#iirc` with the peer in it.
const joinFloor = (world: World) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime;

    yield* runtime.configure(libera, floor);
    const call = yield* registerOnFloor(world.memory);

    expect(yield* heard(call)).toBe("JOIN #iirc");
    yield* say(call, ":iirc!~iirc@iirc.test JOIN #iirc");
    yield* say(call, ":irc.test 353 iirc = #iirc :iirc @peer");
    yield* say(call, ":irc.test 366 iirc #iirc :End of /NAMES list.");

    return call;
  });

const textOf = (item: Item) =>
  item.content._tag === "Message" ? item.content.text : item.content._tag;

// Every item of the Network's Timeline named `name`.
const itemsIn = (store: TimelineStoreService, name: string) =>
  Effect.gen(function* () {
    const found = (yield* store.timelines(libera)).find((each) => each.name === name);

    if (found === undefined) {
      return [];
    }

    return Option.match(yield* store.window(found.id, { _tag: "After" }, 1000), {
      onNone: () => [],
      onSome: ({ items }) => items,
    });
  });

// Every item of the Network's Timeline named `name`, as text.
const textsIn = (store: TimelineStoreService, name: string) =>
  itemsIn(store, name).pipe(Effect.map((items) => items.map(textOf)));

const holds = (store: TimelineStoreService, name: string, text: string) =>
  textsIn(store, name).pipe(Effect.map((texts) => texts.includes(text)));

// The last sequence the Journal holds.
const lastSequence = (world: World) =>
  world.journal.read({}).pipe(
    Stream.runFold(
      () => 0,
      (last, entry) => Math.max(last, entry.sequence)
    )
  );

// A store that records each sequence it is asked to apply through.
const recording = (store: TimelineStoreService, applied: number[]): TimelineStoreService => ({
  ...store,
  apply: (step) =>
    Effect.sync(() => applied.push(step.through)).pipe(Effect.andThen(store.apply(step))),
});

/**
 * Everything the store holds, as a reader sees it, to compare two stores.
 * @param store - The store.
 * @returns What it holds.
 */
const everything = (store: TimelineStoreService) =>
  Effect.gen(function* () {
    const changed = yield* store.changedAfter(undefined);

    return {
      directory: yield* store.directory,
      folded: yield* store.folded,
      gaps: changed.gaps,
      items: changed.items,
      merged: changed.merged,
      timelines: changed.timelines,
    };
  });

/**
 * A store folded from nothing, over the same News up to the same step, as a projector that
 * never stopped would fold it.
 * @param through - The last step to fold.
 * @returns The store.
 */
const foldedAfresh = (through: number) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime;
    const fresh = yield* makeMemoryTimelineStore;

    yield* fresh.reset(projectionVersion);
    yield* runtime.news().pipe(
      Stream.takeUntil((happened) => happened.sequence >= through),
      Stream.runFoldEffect(
        () => emptyDirectory,
        (before, happened) => {
          const stepped = step(before, happened);

          return fresh
            .apply({ ...stepped, through: happened.sequence })
            .pipe(Effect.as(stepped.directory));
        }
      )
    );

    return fresh;
  });

describe("the projector", () => {
  it("folds a Message into the Channel's Timeline as it arrives", async () => {
    const result = await run(
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const store = yield* makeMemoryTimelineStore;

        return yield* Effect.gen(function* () {
          const call = yield* joinFloor(world);

          yield* say(call, ":peer!u@h PRIVMSG #iirc :hi there");
          yield* eventually(holds(store, "#iirc", "hi there"));

          const timelines = yield* store.timelines(libera);

          return {
            channel: yield* textsIn(store, "#iirc"),
            folded: yield* store.folded,
            last: yield* lastSequence(world),
            status: yield* Projector.use((projector) => projector.status),
            timelines: timelines.map(({ kind, name }) => `${kind} ${name}`),
          };
        }).pipe(Effect.provide(layerDaemonish(world, store)), Effect.scoped);
      })
    );

    expect(result.timelines).toStrictEqual(["Network libera", "Channel #iirc"]);
    expect(result.channel).toStrictEqual(["Activity", "hi there"]);
    expect(result.folded.version).toBe(projectionVersion);
    expect(result.folded.through).toBe(result.last);
    expect(result.status).toStrictEqual({ _tag: "Running" });
  });

  it("resumes after the last step it folded when the Daemon restarts, folding nothing twice", async () => {
    const result = await run(
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const applied: number[] = [];
        const store = recording(yield* makeMemoryTimelineStore, applied);

        const first = yield* Effect.gen(function* () {
          const call = yield* joinFloor(world);

          yield* say(call, ":peer!u@h PRIVMSG #iirc :before");
          yield* eventually(holds(store, "#iirc", "before"));

          return (yield* store.folded).through ?? 0;
        }).pipe(Effect.provide(layerDaemonish(world, store)), Effect.scoped);

        const appliedBefore = applied.length;

        return yield* Effect.gen(function* () {
          const call = yield* registerOnFloor(world.memory);

          yield* heard(call);
          yield* say(call, ":iirc!~iirc@iirc.test JOIN #iirc");
          yield* say(call, ":peer!u@h PRIVMSG #iirc :after");
          yield* eventually(holds(store, "#iirc", "after"));

          const through = (yield* store.folded).through ?? 0;
          const fresh = yield* foldedAfresh(through);

          return {
            again: applied.slice(appliedBefore),
            first,
            items: yield* textsIn(store, "#iirc"),
            same: yield* everything(store),
            through,
            want: yield* everything(fresh),
          };
        }).pipe(Effect.provide(layerDaemonish(world, store)), Effect.scoped);
      })
    );

    // Each step after the restart is past the last one folded before it.
    expect(result.again.length).toBeGreaterThan(0);
    expect(Math.min(...result.again)).toBeGreaterThan(result.first);
    expect(result.items.filter((text) => text === "before")).toHaveLength(1);
    expect(result.items.filter((text) => text === "after")).toHaveLength(1);
    expect(result.same).toStrictEqual(result.want);
  });

  it("folds again from the start a store built by another projection version", async () => {
    const result = await run(
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const store = yield* makeMemoryTimelineStore;

        yield* Effect.gen(function* () {
          const call = yield* joinFloor(world);

          yield* say(call, ":peer!u@h PRIVMSG #iirc :kept");
          yield* eventually(holds(store, "#iirc", "kept"));
        }).pipe(Effect.provide(layerDaemonish(world, store)), Effect.scoped);

        // As another version left it: something no fold of this Journal makes, and
        // further on than the Journal goes.
        yield* store.reset(projectionVersion + 1);
        yield* store.apply({
          changes: [
            {
              _tag: "Described",
              sequence: 999,
              timeline: {
                id: timelineIdOf(999, 0, 1),
                key: "#stale",
                kind: "Channel",
                name: "#stale",
                network: libera,
              },
            },
          ],
          directory: emptyDirectory,
          through: 999,
        });

        return yield* Effect.gen(function* () {
          yield* registerOnFloor(world.memory);
          const last = yield* lastSequence(world);

          yield* eventually(
            store.folded.pipe(
              Effect.map(({ through }) => through !== undefined && through >= last - 1)
            )
          );

          const through = (yield* store.folded).through ?? 0;

          return {
            folded: yield* store.folded,
            items: yield* textsIn(store, "#iirc"),
            same: yield* everything(store),
            stale: yield* textsIn(store, "#stale"),
            want: yield* everything(yield* foldedAfresh(through)),
          };
        }).pipe(Effect.provide(layerDaemonish(world, store)), Effect.scoped);
      })
    );

    expect(result.folded.version).toBe(projectionVersion);
    expect(result.items).toContain("kept");
    expect(result.stale).toStrictEqual([]);
    expect(result.same).toStrictEqual(result.want);
  });

  it("stops folding when the store fails, says so, and leaves the Network running", async () => {
    const result = await run(
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const memory = yield* makeMemoryTimelineStore;
        const broken = yield* Ref.make(false);

        const store: TimelineStoreService = {
          ...memory,
          apply: (step) =>
            Ref.get(broken).pipe(
              Effect.flatMap((isBroken) =>
                isBroken
                  ? Effect.fail(new TimelineStoreFailed({ reason: "the disk is full" }))
                  : memory.apply(step)
              )
            ),
        };

        return yield* Effect.gen(function* () {
          const call = yield* joinFloor(world);
          const projector = yield* Projector;

          yield* say(call, ":peer!u@h PRIVMSG #iirc :kept");
          yield* eventually(holds(memory, "#iirc", "kept"));
          yield* Ref.set(broken, true);
          yield* say(call, ":peer!u@h PRIVMSG #iirc :lost");
          yield* eventually(projector.status.pipe(Effect.map(({ _tag }) => _tag === "Stopped")));

          // The Network goes on: it answers a PING, and hears what is said after.
          yield* say(call, "PING :still-here");
          // Registration and the join spent the burst, so it waits its turn.
          yield* TestClock.adjust(2000);
          const pong = yield* heard(call);
          const networks = yield* Runtime.use((runtime) => runtime.networks);

          return {
            items: yield* textsIn(memory, "#iirc"),
            logged: world.logged.join("\n"),
            network: networks.get(libera),
            pong,
            status: yield* projector.status,
          };
        }).pipe(Effect.provide(layerDaemonish(world, store)), Effect.scoped);
      })
    );

    expect(result).toMatchObject({
      items: ["Activity", "kept"],
      network: { _tag: "Running" },
      pong: "PONG still-here",
      status: { _tag: "Stopped", reason: "TimelineStoreFailed: the disk is full" },
    });
    expect(result.logged).toContain("The Timelines stopped being folded");
  });

  it("keeps the Timelines in views.sqlite beside the SQLite Journal, and rebuilds the file when it is deleted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory;
        const views = `${dataDir}/views.sqlite`;
        const journal = yield* makeSqliteJournal(`${dataDir}/journal.sqlite`);
        const world = yield* makeWorld(journal);

        // Each run of the Daemon opens the store afresh, as a restart does.
        const daemon = <A, E, R>(use: (store: TimelineStoreService) => Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            const store = yield* makeSqliteTimelineStore(views);

            return yield* use(store).pipe(Effect.provide(layerDaemonish(world, store)));
          }).pipe(Effect.provide(BunFileSystem.layer), Effect.scoped);

        const before = yield* daemon((store) =>
          Effect.gen(function* () {
            const call = yield* joinFloor(world);

            yield* say(call, ":peer!u@h PRIVMSG #iirc :kept on disk");
            yield* eventually(holds(store, "#iirc", "kept on disk"));

            return yield* itemsIn(store, "#iirc");
          })
        );

        const afterRestart = () =>
          daemon((store) =>
            Effect.gen(function* () {
              yield* registerOnFloor(world.memory);
              const last = yield* lastSequence(world);

              yield* eventually(
                store.folded.pipe(
                  Effect.map(({ through }) => through !== undefined && through >= last - 1)
                )
              );

              return yield* itemsIn(store, "#iirc");
            })
          );

        const resumed = yield* afterRestart();

        rmSync(views);
        rmSync(`${views}-wal`, { force: true });
        rmSync(`${views}-shm`, { force: true });

        const rebuilt = yield* afterRestart();

        return { before, exists: existsSync(views), rebuilt, resumed };
      }).pipe(Effect.scoped)
    );

    expect(result.before.map(textOf)).toStrictEqual(["Activity", "kept on disk"]);
    expect(result.resumed).toStrictEqual(result.before);
    expect(result.rebuilt).toStrictEqual(result.before);
    expect(result.exists).toBeTruthy();
  });
});
