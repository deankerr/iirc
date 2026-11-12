import { Input, Instant } from "@iirc/client";
import { Journal, NetworkId } from "@iirc/runtime/journal";
import type { Change, JournalRecord } from "@iirc/runtime/journal";
import { makeMemoryJournal } from "@iirc/runtime/testing";
import type { Schema } from "effect";
import { Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  UiChangedSince,
  UiConfiguration,
  foldChange,
  inForceOf,
  layerUiConfiguration,
  nothingHeld,
} from "./ui.ts";

const set = (option: string, value: string): Change => ({ _tag: "UiSet", option, value });

const unset = (option: string): Change => ({ _tag: "UiUnset", option });

const themes = (value: Schema.Json): Change => ({ _tag: "UiSet", option: "themes", value });

const fold = (changes: readonly Change[]) => {
  let held = nothingHeld;

  for (const [index, change] of changes.entries()) {
    held = foldChange(held, change, index + 1);
  }

  return inForceOf(held);
};

describe("folding the ui options", () => {
  it("starts every option at its default, with sequence 0", () => {
    expect(fold([])).toStrictEqual({
      options: {
        activity: "all",
        colours: "theme",
        font: "system",
        size: 14,
        theme: "system",
        themes: [],
        time: "HH:mm",
      },
      sequence: 0,
    });
  });

  it("takes the latest Change of each option, and an unset back to its default", () => {
    expect(
      fold([
        set("time", "HH:mm:ss"),
        set("theme", "dark"),
        set("time", "none"),
        set("activity", "quiet"),
        unset("theme"),
      ])
    ).toStrictEqual({
      options: {
        activity: "quiet",
        colours: "theme",
        font: "system",
        size: 14,
        theme: "system",
        themes: [],
        time: "none",
      },
      sequence: 5,
    });
  });

  it("changes no option for a Change it cannot read, though its sequence is the last", () => {
    expect(
      fold([set("time", "HH:mm:ss"), set("time", "noon"), set("palette", "dusk"), unset("nope")])
    ).toStrictEqual({
      options: {
        activity: "all",
        colours: "theme",
        font: "system",
        size: 14,
        theme: "system",
        themes: [],
        time: "HH:mm:ss",
      },
      sequence: 4,
    });
  });
});

describe("folding the themes imported", () => {
  it("drops alone a theme it cannot take, as one journaled under a name since reserved", () => {
    const palette = {
      ansi: Array.from({ length: 16 }, () => "#808080"),
      background: "#000000",
      foreground: "#ffffff",
    };

    expect({
      kept: fold([
        themes([
          { name: "nord", palette },
          { name: "mine", palette },
          { name: "mine", palette: { ...palette, background: "#111111" } },
          { name: "bad", palette: { ...palette, ansi: [] } },
        ]),
      ]).options.themes,
      notAList: fold([themes([{ name: "mine", palette }]), themes("dusk")]).options.themes,
    }).toStrictEqual({
      kept: [{ name: "mine", palette }],
      notAList: [{ name: "mine", palette }],
    });
  });
});

describe("the ui options, kept", () => {
  it("folds them again from the Journal on a restart, past every Network's Entries", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* makeMemoryJournal;
        const layer = layerUiConfiguration.pipe(Layer.provide(Layer.succeed(Journal, journal)));

        const retry: JournalRecord = {
          _tag: "Input",
          input: Input.cases.Retry.make({ at: Instant.make(1) }),
          network: NetworkId.make("libera"),
        };

        const first = yield* Effect.gen(function* () {
          const options = yield* UiConfiguration;

          yield* options.change(set("time", "HH:mm:ss"), 0);
          yield* journal.append(retry);
          yield* options.change(set("theme", "light"), undefined);
          const stale = yield* options.change(unset("time"), 1).pipe(Effect.flip);

          return { inForce: yield* options.inForce, stale };
        }).pipe(Effect.provide(layer));

        const again = yield* UiConfiguration.use((options) => options.inForce).pipe(
          Effect.provide(layer)
        );

        return { again, first };
      })
    );

    expect(result).toStrictEqual({
      again: {
        options: {
          activity: "all",
          colours: "theme",
          font: "system",
          size: 14,
          theme: "light",
          themes: [],
          time: "HH:mm:ss",
        },
        sequence: 3,
      },
      first: {
        inForce: {
          options: {
            activity: "all",
            colours: "theme",
            font: "system",
            size: 14,
            theme: "light",
            themes: [],
            time: "HH:mm:ss",
          },
          sequence: 3,
        },
        stale: new UiChangedSince({ sequence: 3 }),
      },
    });
  });

  it("lets exactly one of two changes made from the same options through, however long the first append takes", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* makeMemoryJournal;
        const appending = yield* Deferred.make<undefined>();
        const release = yield* Deferred.make<undefined>();

        // The first append waits until released, so the second change is made meanwhile.
        const held = {
          ...journal,
          append: (record: JournalRecord) =>
            Deferred.isDone(appending).pipe(
              Effect.flatMap((started) =>
                started
                  ? journal.append(record)
                  : Deferred.succeed(appending, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(journal.append(record))
                    )
              )
            ),
        };

        const layer = layerUiConfiguration.pipe(Layer.provide(Layer.succeed(Journal, held)));

        return yield* Effect.gen(function* () {
          const options = yield* UiConfiguration;
          const first = yield* Effect.forkChild(options.change(set("time", "HH:mm:ss"), 0));

          yield* Deferred.await(appending);
          const second = yield* Effect.forkChild(options.change(set("theme", "dark"), 0));

          yield* Effect.yieldNow;
          yield* Deferred.succeed(release, undefined);

          const outcomes = { first: yield* Fiber.await(first), second: yield* Fiber.await(second) };

          const changes = (yield* Stream.runCollect(journal.read({}))).flatMap(({ record }) =>
            record._tag === "Change" ? [`${record.change._tag} ${record.change.option}`] : []
          );

          return { changes, ...outcomes };
        }).pipe(Effect.provide(layer));
      })
    );

    expect(result).toStrictEqual({
      changes: ["UiSet time"],
      first: Exit.succeed(1),
      second: Exit.fail(new UiChangedSince({ sequence: 1 })),
    });
  });
});
