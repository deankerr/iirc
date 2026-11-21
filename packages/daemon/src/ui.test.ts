import { uiDefaults } from "@iirc/api";
import { Input, Instant } from "@iirc/client";
import { Journal, NetworkId } from "@iirc/runtime/journal";
import type { Change, JournalRecord } from "@iirc/runtime/journal";
import { makeMemoryJournal } from "@iirc/runtime/testing";
import type { Schema } from "effect";
import { Deferred, Effect, Exit, Fiber, Layer, Logger, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  UiChangedSince,
  UiConfiguration,
  foldChange,
  inForceOf,
  layerUiConfiguration,
  nothingHeld,
  parseUiValue,
} from "./ui.ts";

// No logger, so what the code under test logs is not printed over the test run.
const quiet = Logger.layer([]);

const set = (option: string, value: string) => ({ _tag: "UiSet", option, value }) as const;

const unset = (option: string) => ({ _tag: "UiUnset", option }) as const;

const themes = (value: Schema.Json): Change => ({
  _tag: "UiSet",
  option: "theme.imported",
  value,
});

const fold = (changes: readonly Change[]) => {
  let held = nothingHeld;

  for (const [index, change] of changes.entries()) {
    held = foldChange(held, change, index + 1);
  }

  return inForceOf(held);
};

describe("folding the ui options", () => {
  it("takes the latest Change of each option, and an unset back to its default", () => {
    expect(
      fold([
        set("timeline.timeFormat", "HH:mm:ss"),
        set("theme", "dark"),
        set("timeline.timeFormat", "none"),
        // Journaled under the name the option had before, which is the option's still.
        set("activity", "quiet"),
        unset("theme"),
      ])
    ).toStrictEqual({
      options: {
        aliases: [],
        "composer.enter": "send",
        "composer.nickSuffix": ": ",
        "composer.spellcheck": true,
        font: "system",
        "font.lineHeight": 1.45,
        "font.size": 14,
        previews: "off",
        "previews.animate": true,
        "previews.mediaHeight": "medium",
        "previews.players": [
          "www.youtube-nocookie.com",
          "player.vimeo.com",
          "w.soundcloud.com",
          "bandcamp.com",
          "open.spotify.com",
          "player.twitch.tv",
        ],
        "previews.start": "open",
        "previews.timelines": {},
        "sidebar.networks": [],
        "sidebar.order": [],
        "sidebar.pinned": [],
        tail: "info",
        theme: "system",
        "theme.dark": "dark",
        "theme.imported": [],
        "theme.light": "light",
        "timeline.activity": "quiet",
        "timeline.colours": "theme",
        "timeline.dateFormat": "full",
        "timeline.layout": "columns",
        "timeline.maxWidth": "none",
        "timeline.timeFormat": "none",
        "unread.markRead": "latest",
        "unread.muted": [],
        "unread.quietBots": false,
      },
      sequence: 5,
    });
  });

  it("changes no option for a Change it cannot read, though its sequence is the last", () => {
    expect(
      fold([
        set("timeline.timeFormat", "HH:mm:ss"),
        set("timeline.timeFormat", "noon"),
        set("palette", "dusk"),
        unset("nope"),
      ])
    ).toStrictEqual({
      options: {
        aliases: [],
        "composer.enter": "send",
        "composer.nickSuffix": ": ",
        "composer.spellcheck": true,
        font: "system",
        "font.lineHeight": 1.45,
        "font.size": 14,
        previews: "off",
        "previews.animate": true,
        "previews.mediaHeight": "medium",
        "previews.players": [
          "www.youtube-nocookie.com",
          "player.vimeo.com",
          "w.soundcloud.com",
          "bandcamp.com",
          "open.spotify.com",
          "player.twitch.tv",
        ],
        "previews.start": "open",
        "previews.timelines": {},
        "sidebar.networks": [],
        "sidebar.order": [],
        "sidebar.pinned": [],
        tail: "info",
        theme: "system",
        "theme.dark": "dark",
        "theme.imported": [],
        "theme.light": "light",
        "timeline.activity": "all",
        "timeline.colours": "theme",
        "timeline.dateFormat": "full",
        "timeline.layout": "columns",
        "timeline.maxWidth": "none",
        "timeline.timeFormat": "HH:mm:ss",
        "unread.markRead": "latest",
        "unread.muted": [],
        "unread.quietBots": false,
      },
      sequence: 4,
    });
  });
});

describe("a Change of ui.previews.style, which is gone", () => {
  it("changes no option and fails nothing, set or unset, and every option keeps its own Change", () => {
    const { options, sequence } = fold([
      set("previews.style", "card"),
      set("previews.mediaHeight", "large"),
      unset("previews.style"),
      set("previews.style", "line"),
    ]);

    expect({ options, sequence }).toStrictEqual({
      options: { ...uiDefaults, "previews.mediaHeight": "large" },
      sequence: 4,
    });
  });
});

describe("a Change journaled under ui.previews.folded, which is now ui.previews.start", () => {
  it("is read as start, open as open and summary or chip as closed, and fails nothing", () => {
    const after = (...changes: readonly Change[]) => fold(changes).options["previews.start"];

    expect({
      chip: after(set("previews.folded", "chip")),
      open: after(set("previews.folded", "summary"), set("previews.folded", "open")),
      summary: after(set("previews.folded", "summary")),
      thenStart: after(set("previews.folded", "chip"), set("previews.start", "open")),
      unknown: after(set("previews.folded", "chip"), set("previews.folded", "nope")),
      unset: after(set("previews.folded", "chip"), unset("previews.folded")),
    }).toStrictEqual({
      chip: "closed",
      open: "open",
      summary: "closed",
      thenStart: "open",
      unknown: "closed",
      unset: "open",
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
      ]).options["theme.imported"],
      notAList: fold([themes([{ name: "mine", palette }]), themes("dusk")]).options[
        "theme.imported"
      ],
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

          yield* options.change(set("timeline.timeFormat", "HH:mm:ss"), 0);
          yield* journal.append(retry);
          yield* options.change(set("theme", "light"), undefined);
          const stale = yield* options.change(unset("timeline.timeFormat"), 1).pipe(Effect.flip);

          return { inForce: yield* options.inForce, stale };
        }).pipe(Effect.provide(layer));

        const again = yield* UiConfiguration.use((options) => options.inForce).pipe(
          Effect.provide(layer)
        );

        return { again, first };
      }).pipe(Effect.provide(quiet))
    );

    expect(result).toStrictEqual({
      again: {
        options: {
          aliases: [],
          "composer.enter": "send",
          "composer.nickSuffix": ": ",
          "composer.spellcheck": true,
          font: "system",
          "font.lineHeight": 1.45,
          "font.size": 14,
          previews: "off",
          "previews.animate": true,
          "previews.mediaHeight": "medium",
          "previews.players": [
            "www.youtube-nocookie.com",
            "player.vimeo.com",
            "w.soundcloud.com",
            "bandcamp.com",
            "open.spotify.com",
            "player.twitch.tv",
          ],
          "previews.start": "open",
          "previews.timelines": {},
          "sidebar.networks": [],
          "sidebar.order": [],
          "sidebar.pinned": [],
          tail: "info",
          theme: "light",
          "theme.dark": "dark",
          "theme.imported": [],
          "theme.light": "light",
          "timeline.activity": "all",
          "timeline.colours": "theme",
          "timeline.dateFormat": "full",
          "timeline.layout": "columns",
          "timeline.maxWidth": "none",
          "timeline.timeFormat": "HH:mm:ss",
          "unread.markRead": "latest",
          "unread.muted": [],
          "unread.quietBots": false,
        },
        sequence: 3,
      },
      first: {
        inForce: {
          options: {
            aliases: [],
            "composer.enter": "send",
            "composer.nickSuffix": ": ",
            "composer.spellcheck": true,
            font: "system",
            "font.lineHeight": 1.45,
            "font.size": 14,
            previews: "off",
            "previews.animate": true,
            "previews.mediaHeight": "medium",
            "previews.players": [
              "www.youtube-nocookie.com",
              "player.vimeo.com",
              "w.soundcloud.com",
              "bandcamp.com",
              "open.spotify.com",
              "player.twitch.tv",
            ],
            "previews.start": "open",
            "previews.timelines": {},
            "sidebar.networks": [],
            "sidebar.order": [],
            "sidebar.pinned": [],
            tail: "info",
            theme: "light",
            "theme.dark": "dark",
            "theme.imported": [],
            "theme.light": "light",
            "timeline.activity": "all",
            "timeline.colours": "theme",
            "timeline.dateFormat": "full",
            "timeline.layout": "columns",
            "timeline.maxWidth": "none",
            "timeline.timeFormat": "HH:mm:ss",
            "unread.markRead": "latest",
            "unread.muted": [],
            "unread.quietBots": false,
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

          const first = yield* Effect.forkChild(
            options.change(set("timeline.timeFormat", "HH:mm:ss"), 0)
          );

          yield* Deferred.await(appending);
          const second = yield* Effect.forkChild(options.change(set("theme", "dark"), 0));

          yield* Effect.yieldNow;
          yield* Deferred.succeed(release, undefined);

          const outcomes = { first: yield* Fiber.await(first), second: yield* Fiber.await(second) };

          const changes = (yield* Stream.runCollect(journal.read({}))).flatMap(({ record }) =>
            record._tag === "Change" && "option" in record.change
              ? [`${record.change._tag} ${record.change.option}`]
              : []
          );

          return { changes, ...outcomes };
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(quiet))
    );

    expect(result).toStrictEqual({
      changes: ["UiSet timeline.timeFormat"],
      first: Exit.succeed(1),
      second: Exit.fail(new UiChangedSince({ sequence: 1 })),
    });
  });
});

describe("a ui option's value, parsed as it is set", () => {
  it("refuses a key of ui.previews.timelines that is not a Timeline's id, and drops an extra field of a theme as it always did", () => {
    const palette = {
      ansi: Array.from({ length: 16 }, () => "#808080"),
      background: "#000000",
      foreground: "#ffffff",
    };

    expect({
      themes: parseUiValue("theme.imported", [{ extra: true, name: "mine", palette }]),
      timelines: Option.isNone(parseUiValue("previews.timelines", { "#iirc": "on" })),
    }).toStrictEqual({
      themes: Option.some([{ name: "mine", palette }]),
      timelines: true,
    });
  });
});
