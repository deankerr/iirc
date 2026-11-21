// @vitest-environment happy-dom
import { uiDefaults } from "@iirc/api";
import { draftOf } from "@iirc/frontend/composer";
import { reduceOptions } from "@iirc/frontend/options";
import { deviceUiKey, deviceUiOf } from "@iirc/frontend/ui";
import { describe, expect, it } from "vitest";

import { edit, send } from "../composer/atoms.ts";
import { composerState } from "../composer/composer-state.ts";
import { readChoice, writeChoice } from "../page/device.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run, until } from "../testing/fake-daemon.ts";
import { sync } from "../timelines/atoms.ts";
import { optionGroups, optionsState } from "./atoms.ts";
import { deviceUi } from "./device.ts";
import { readRule, uiInEffect, uiSync } from "./ui.ts";

/**
 * A page signed in to the fake, following its Timelines and its `ui` options, with a way to
 * type a line into the composer with no Timeline open.
 * @param fake - The fake Daemon.
 * @returns The registry, and a way to type.
 */
const page = async (fake: ReturnType<typeof fakeDaemon>) => {
  const registry = registryFor(fake.fetch);

  await run(registry, check, undefined);
  registry.mount(sync);
  registry.mount(uiSync);

  const type = async (text: string) => {
    registry.set(edit, { text, timeline: "Nowhere" });
    await run(registry, send, "Nowhere");
  };

  const notice = () => draftOf(registry.get(composerState), "Nowhere").notice?.message;

  return { notice, registry, type };
};

const signedIn = () => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  writeChoice(deviceUiKey, undefined);

  return fake;
};

describe("the options under ui", () => {
  it("sets one for every device through the Daemon, made from the options read, and another page shows it", async () => {
    const fake = signedIn();
    const first = await page(fake);
    const second = await page(fake);

    await eventually(() => fake.daemon.uiFollowers.length === 2);
    await until(first.registry, uiInEffect, (ui) => ui["timeline.timeFormat"] === "HH:mm");
    await first.type("/set ui.timeline.timeFormat HH:mm:ss");

    const seen = await until(
      second.registry,
      uiInEffect,
      (ui) => ui["timeline.timeFormat"] === "HH:mm:ss"
    );

    expect({
      changes: fake.daemon.uiChanges,
      notice: first.notice(),
      seen,
      shared: fake.daemon.ui,
    }).toStrictEqual({
      changes: [{ ifSequence: "0", route: "PUT timeline.timeFormat" }],
      notice: undefined,
      seen: { ...uiDefaults, "timeline.timeFormat": "HH:mm:ss" },
      shared: { options: { ...uiDefaults, "timeline.timeFormat": "HH:mm:ss" }, sequence: 10 },
    });
  });

  it("reads again and makes the change once more when another device changed them first", async () => {
    const fake = signedIn();
    const { notice, registry, type } = await page(fake);

    await until(registry, optionsState, (state) => state.ui?.sequence === 0);

    // Another device's Change, which this page has not heard of yet.
    fake.daemon.ui = {
      options: { ...fake.daemon.ui.options, "timeline.activity": "quiet" },
      sequence: 7,
    };
    await type("/set ui.theme dark");

    expect({
      changes: fake.daemon.uiChanges,
      notice: notice(),
      ui: await until(registry, uiInEffect, (ui) => ui.theme === "dark"),
    }).toStrictEqual({
      changes: [
        { ifSequence: "0", route: "PUT theme" },
        { ifSequence: "7", route: "PUT theme" },
      ],
      notice: undefined,
      ui: { ...uiDefaults, theme: "dark", "timeline.activity": "quiet" },
    });
  });

  it("keeps a device's override on the device, never sent, winning over the shared value until unset", async () => {
    const fake = signedIn();
    const { registry, type } = await page(fake);
    const other = await page(fake);

    await type("/set -device ui.theme light");
    await other.type("/set ui.theme dark");
    await until(registry, uiInEffect, (ui) => ui.theme === "light");
    await until(other.registry, uiInEffect, (ui) => ui.theme === "dark");

    const overriding = {
      kept: readChoice(deviceUiKey),
      row: registry
        .get(optionGroups)
        .flatMap((group) => group.options)
        .filter((option) => option.name === "ui.theme")
        .map((option) =>
          option._tag === "Ui" ? [option.value, option.shared, option.device] : []
        ),
      theme: registry.get(uiInEffect).theme,
    };

    await type("/unset -device ui.theme");
    const back = await until(registry, uiInEffect, (ui) => ui.theme === "dark");

    expect({
      back: back.theme,
      changes: fake.daemon.uiChanges.map((change) => change.route),
      device: registry.get(deviceUi),
      kept: readChoice(deviceUiKey),
      overriding,
    }).toStrictEqual({
      back: "dark",
      changes: ["PUT theme"],
      device: {},
      kept: undefined,
      overriding: {
        kept: '{"theme":"light"}',
        row: [
          [
            { _tag: "Shown", text: "light" },
            { _tag: "Shown", text: "dark" },
            { _tag: "Shown", text: "light" },
          ],
        ],
        theme: "light",
      },
    });
  });
});

describe("an override of ui.previews.style a device kept, which is gone", () => {
  it("is dropped, while its other overrides hold, the options are listed, and /set names no such option", async () => {
    const fake = signedIn();

    writeChoice(deviceUiKey, '{"previews.style":"card","previews.mediaHeight":"large"}');

    const { notice, registry, type } = await page(fake);
    const ui = await until(registry, optionsState, (state) => state.ui !== undefined);

    await type("/set ui.previews.style card");
    const refused = notice();

    await type("/set -device ui.previews.mediaHeight small");

    expect({
      changes: fake.daemon.uiChanges,
      inEffect: await until(registry, uiInEffect, (one) => one["previews.mediaHeight"] === "small"),
      kept: readChoice(deviceUiKey),
      listed: registry
        .get(optionGroups)
        .flatMap((group) => group.options)
        .some((option) => option.name === "ui.previews.style"),
      read: ui.ui?.options,
      refused: refused?.startsWith("There is no option ui.previews.style."),
    }).toStrictEqual({
      changes: [],
      inEffect: { ...uiDefaults, "previews.mediaHeight": "small" },
      kept: '{"previews.mediaHeight":"small"}',
      listed: false,
      read: uiDefaults,
      // The rest of the words, how options are named, are the core's.
      refused: true,
    });
  });
});

describe("an override of ui.previews.folded a device kept, which is ui.previews.start now", () => {
  it("is read as start, a chip or a summary as closed, and is kept under the new name once /set -device changes it", async () => {
    const fake = signedIn();
    const kept = '{"previews.folded":"chip","previews.mediaHeight":"large"}';

    const { registry, type } = await page(fake);

    // The page reads what a device kept once, as it starts.
    registry.set(deviceUi, deviceUiOf(kept));
    const read = registry.get(uiInEffect);

    await type("/set -device ui.previews.start open");
    const set = await until(registry, uiInEffect, (ui) => ui["previews.start"] === "open");

    expect({
      changes: fake.daemon.uiChanges,
      kept: readChoice(deviceUiKey),
      read: { height: read["previews.mediaHeight"], start: read["previews.start"] },
      set: set["previews.start"],
    }).toStrictEqual({
      changes: [],
      kept: '{"previews.mediaHeight":"large","previews.start":"open"}',
      read: { height: "large", start: "closed" },
      set: "open",
    });
  });
});

describe("a change of ui.unread.markRead on its way", () => {
  it("marks nothing by it until the Daemon has taken it", () => {
    const fake = signedIn();
    const registry = registryFor(fake.fetch);

    const folded = [
      { _tag: "UiRead", ui: { options: uiDefaults, sequence: 1 } },
      { _tag: "Asked", change: { _tag: "Ui", option: "unread.markRead", value: "asked" } },
    ] as const;

    for (const event of folded) {
      registry.set(optionsState, reduceOptions(registry.get(optionsState), event));
    }

    expect({
      rule: registry.get(readRule),
      shown: registry.get(uiInEffect)["unread.markRead"],
    }).toStrictEqual({
      rule: uiDefaults["unread.markRead"],
      shown: "asked",
    });
  });
});
