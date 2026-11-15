import { Input, Instant } from "@iirc/client";
import { Journal, NetworkId } from "@iirc/runtime/journal";
import type { Change, JournalRecord } from "@iirc/runtime/journal";
import { makeMemoryJournal } from "@iirc/runtime/testing";
import type { Schema } from "effect";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  OptionsChangedSince,
  OwnerConfiguration,
  foldOption,
  layerOwnerConfiguration,
  nothingSet,
  ownerInForceOf,
} from "./options.ts";
import { UiConfiguration, layerUiConfiguration } from "./ui.ts";

const set = (option: string, value: Schema.Json) => ({ _tag: "OptionSet", option, value }) as const;

const unset = (option: string) => ({ _tag: "OptionUnset", option }) as const;

const fold = (changes: readonly Change[]) => {
  let held = nothingSet;

  for (const [index, change] of changes.entries()) {
    held = foldOption(held, change, index + 1);
  }

  return ownerInForceOf(held);
};

describe("folding the options under store and uploads", () => {
  it("starts with only uploads.maxSize, at 100 MiB, and sequence 0", () => {
    expect(fold([])).toStrictEqual({ options: { "uploads.maxSize": 104_857_600 }, sequence: 0 });
  });

  it("takes the latest Change of each option, and an unset back to its default or to none", () => {
    expect(
      fold([
        set("store.s3.bucket", "first"),
        set("uploads.maxSize", 1024),
        set("store.s3.bucket", "second"),
        set("store.s3.accessKeyId", "bucket-key"),
        set("uploads.publicUrl", "https://files.example.com"),
        unset("uploads.maxSize"),
        unset("uploads.publicUrl"),
      ])
    ).toStrictEqual({
      options: {
        "store.s3.accessKeyId": "bucket-key",
        "store.s3.bucket": "second",
        "uploads.maxSize": 104_857_600,
      },
      sequence: 7,
    });
  });

  it("changes no option for a Change it cannot read, though its sequence is the last", () => {
    expect(
      fold([
        set("uploads.maxSize", 2048),
        set("uploads.maxSize", 0),
        set("uploads.maxSize", 1.5),
        set("uploads.publicUrl", "ftp://files.example.com"),
        set("store.s3.bucket", "Not A Bucket"),
        set("store.s3.colour", "blue"),
        unset("nope"),
      ])
    ).toStrictEqual({ options: { "uploads.maxSize": 2048 }, sequence: 7 });
  });

  it("passes over a Change of a ui option, and its sequence", () => {
    expect(
      fold([set("uploads.expireAfter", 30), { _tag: "UiSet", option: "time", value: "none" }])
    ).toStrictEqual({
      options: { "uploads.expireAfter": 30, "uploads.maxSize": 104_857_600 },
      sequence: 1,
    });
  });
});

describe("the options under store and uploads, kept", () => {
  it("folds them again from the Journal on a restart, past every Network's Entries and the ui options", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* makeMemoryJournal;

        const both = Layer.merge(layerOwnerConfiguration, layerUiConfiguration).pipe(
          Layer.provide(Layer.succeed(Journal, journal))
        );

        const retry: JournalRecord = {
          _tag: "Input",
          input: Input.cases.Retry.make({ at: Instant.make(1) }),
          network: NetworkId.make("libera"),
        };

        const first = yield* Effect.gen(function* () {
          const options = yield* OwnerConfiguration;
          const ui = yield* UiConfiguration;

          yield* options.change(set("store.s3.bucket", "uploads"), 0);
          yield* journal.append(retry);
          yield* ui.change({ _tag: "UiSet", option: "time", value: "none" }, 0);
          yield* options.change(set("store.s3.secretAccessKey", "bucket-secret"), 1);
          const stale = yield* options.change(unset("store.s3.bucket"), 1).pipe(Effect.flip);

          const uiStale = yield* ui
            .change({ _tag: "UiUnset", option: "time" }, 4)
            .pipe(Effect.flip);

          return {
            credentials: yield* options.credentialsNamed,
            inForce: yield* options.inForce,
            stale,
            uiStale: uiStale._tag,
          };
        }).pipe(Effect.provide(both));

        const again = yield* OwnerConfiguration.use((options) => options.inForce).pipe(
          Effect.provide(both)
        );

        return { again, first };
      })
    );

    const inForce = {
      options: {
        "store.s3.bucket": "uploads",
        "store.s3.secretAccessKey": "bucket-secret",
        "uploads.maxSize": 104_857_600,
      },
      sequence: 4,
    };

    expect(result).toStrictEqual({
      again: inForce,
      first: {
        credentials: new Set(["bucket-secret"]),
        inForce,
        stale: new OptionsChangedSince({ sequence: 4 }),
        uiStale: "UiChangedSince",
      },
    });
  });
});
