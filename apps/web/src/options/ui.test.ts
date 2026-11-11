// @vitest-environment happy-dom
import { draftOf } from "@iirc/frontend/composer";
import { deviceUiKey } from "@iirc/frontend/ui";
import { describe, expect, it } from "vitest";

import { composerState, edit, send } from "../composer/atoms.ts";
import { readChoice, writeChoice } from "../page/device.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run, until } from "../testing/fake-daemon.ts";
import { sync } from "../timelines/atoms.ts";
import { optionRows, optionsState } from "./atoms.ts";
import { deviceUi } from "./device.ts";
import { uiInEffect, uiSync } from "./ui.ts";

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
    await until(first.registry, uiInEffect, (ui) => ui.time === "HH:mm");
    await first.type("/set ui.time HH:mm:ss");

    const seen = await until(second.registry, uiInEffect, (ui) => ui.time === "HH:mm:ss");

    expect({
      changes: fake.daemon.uiChanges,
      notice: first.notice(),
      seen,
      shared: fake.daemon.ui,
    }).toStrictEqual({
      changes: [{ ifSequence: "0", route: "PUT time" }],
      notice: undefined,
      seen: { activity: "all", theme: "system", time: "HH:mm:ss" },
      shared: { options: { activity: "all", theme: "system", time: "HH:mm:ss" }, sequence: 10 },
    });
  });

  it("reads again and makes the change once more when another device changed them first", async () => {
    const fake = signedIn();
    const { notice, registry, type } = await page(fake);

    await until(registry, optionsState, (state) => state.ui?.sequence === 0);

    // Another device's Change, which this page has not heard of yet.
    fake.daemon.ui = { options: { ...fake.daemon.ui.options, activity: "quiet" }, sequence: 7 };
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
      ui: { activity: "quiet", theme: "dark", time: "HH:mm" },
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
        .get(optionRows)
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
