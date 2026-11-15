// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { deviceUiKey } from "@iirc/frontend/ui";
import type { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { writeChoice } from "../page/device.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, holds, registryFor, run } from "../testing/fake-daemon.ts";
import { editing, optionsState, optionsSync } from "./atoms.ts";
import { deviceUi } from "./device.ts";
import { ownerSync } from "./owner.ts";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: (() => void)[] = [];

/**
 * Waits until something holds, letting React render what changed meanwhile.
 * @param holding - What must hold.
 */
const settled = async (holding: () => boolean) => {
  await act(async () => {
    await eventually(holding);
  });
};

/**
 * Does something to the page, letting React render it.
 * @param what - What to do.
 */
const doing = async (what: () => void) => {
  await act(async () => {
    what();
    await Promise.resolve();
  });
};

/**
 * Sets a field's value as a keystroke does, beneath React's own tracking, then says so.
 * @param field - The field.
 * @param value - The value.
 */
const typeInto = async (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await doing(() => {
    const prototype =
      field instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;

    Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

/**
 * Presses a key on an element.
 * @param element - The element.
 * @param key - The key.
 */
const press = async (element: Element, key: string) => {
  await doing(() => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: key, key })
    );
  });
};

/**
 * A page signed in to the fake, showing the options, following them, and rendered.
 * @param fake - The fake Daemon.
 * @returns The registry, the page, and a way to type a line into its composer.
 */
const page = async (fake: ReturnType<typeof fakeDaemon>) => {
  const registry = registryFor(fake.fetch);

  await run(registry, check, undefined);
  registry.mount(optionsSync);
  registry.mount(ownerSync);

  const container = document.createElement("div");

  document.body.append(container);
  const root = createRoot(container);

  await doing(() => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <App />
      </RegistryContext.Provider>
    );
  });

  mounted.push(() => {
    root.unmount();
    container.remove();
  });

  const type = async (line: string) => {
    const composer = container.querySelector("textarea");

    if (composer === null) {
      throw new Error("no composer");
    }

    await typeInto(composer, line);
    await press(composer, "Enter");
  };

  return { container, registry, type };
};

/**
 * A fake Daemon that the browser is signed in to, with no device override kept.
 * @returns The fake.
 */
const signedIn = () => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  writeChoice(deviceUiKey, undefined);

  return fake;
};

/**
 * Each option's row the view shows, as its cells' text.
 * @param container - The page.
 * @returns The rows.
 */
const rows = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('section[aria-label="Options"] [data-key]')].map(
    // A row's one grid cell holds its name, value, starting value, and description.
    (row) => [...(row.firstElementChild?.children ?? [])].map((cell) => cell.textContent)
  );

/**
 * One option's row, as its cells' text.
 * @param container - The page.
 * @param name - The option.
 * @returns The row, or none.
 */
const rowOf = (container: HTMLElement, name: string) =>
  rows(container).find(([shown]) => shown === name);

/**
 * Waits for the options under `store` and `uploads` to be read, as the view shows them.
 * @param registry - The registry.
 * @param sequence - The sequence they must be read at.
 */
const readAt = async (registry: AtomRegistry.AtomRegistry, sequence: number) => {
  await settled(() => registry.get(optionsState).owner?.sequence === sequence);
};

describe("the options view, under store and uploads", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("lists each from the Schema, described, with its default or unset, and no device override", async () => {
    const fake = signedIn();
    const { container, registry, type } = await page(fake);

    await type("/set uploads");
    await readAt(registry, 0);

    expect(rows(container)).toStrictEqual([
      [
        "uploads.expireAfter",
        "unset",
        "unset",
        "How many days an Upload is kept before it is deleted, from 1 to 36500. Unset, Uploads are kept until deleted.",
      ],
      [
        "uploads.listen",
        "unset",
        "unset",
        "Where the listener that serves Uploads' links listens, as host:port, such as 127.0.0.1:7668.",
      ],
      [
        "uploads.maxSize",
        "104857600",
        "104857600",
        "The largest an Upload may be, in bytes. 104857600, 100 MiB, unless set.",
      ],
      [
        "uploads.maxTotal",
        "unset",
        "unset",
        "The most bytes the store may hold for Uploads, in bytes. Unset, there is no limit.",
      ],
      [
        "uploads.publicUrl",
        "unset",
        "unset",
        "The base of every Upload's link, an http or https URL, such as https://files.example.com, kept without a trailing /.",
      ],
    ]);
  });

  it("sets one with /set, made from the options read, and refuses a bad value before sending anything", async () => {
    const fake = signedIn();
    const { container, registry, type } = await page(fake);

    await type("/set store");
    await readAt(registry, 0);
    await type("/set store.s3.bucket My_Bucket");
    const refused = fake.daemon.ownerChanges.length;

    await type("/set store.s3.bucket my-bucket");
    await settled(() => rowOf(container, "store.s3.bucket")?.[1] === "my-bucket");
    await type("/unset uploads.maxSize");
    await settled(() => fake.daemon.ownerChanges.length === 2);

    expect({
      changes: fake.daemon.ownerChanges,
      owner: fake.daemon.owner,
      refused,
    }).toStrictEqual({
      changes: [
        { ifSequence: "0", route: "PUT store.s3.bucket" },
        { ifSequence: "10", route: "DELETE uploads.maxSize" },
      ],
      owner: {
        options: { "store.s3.bucket": "my-bucket", "uploads.maxSize": 104_857_600 },
        sequence: 11,
      },
      refused: 0,
    });
  });

  it("edits one in place, and says why a value its Schema refuses was not sent", async () => {
    const fake = signedIn();
    const { container, registry, type } = await page(fake);

    await type("/set uploads.maxSize");
    await readAt(registry, 0);

    const edit = async (text: string) => {
      await doing(() => {
        registry.set(editing, "uploads.maxSize");
      });
      await settled(
        () => container.querySelector('input[aria-label="Value of uploads.maxSize"]') !== null
      );

      const field = container.querySelector<HTMLInputElement>(
        'input[aria-label="Value of uploads.maxSize"]'
      );

      if (field === null) {
        throw new Error("no editor");
      }

      await typeInto(field, text);
      await press(field, "Enter");
    };

    await edit("0");

    const notice = container.querySelector(
      'section[aria-label="Options"] [role="alert"]'
    )?.textContent;

    await edit("1048576");
    await settled(() => rowOf(container, "uploads.maxSize")?.[1] === "1048576");

    expect({ changes: fake.daemon.ownerChanges, notice }).toStrictEqual({
      changes: [{ ifSequence: "0", route: "PUT uploads.maxSize" }],
      notice: `uploads.maxSize: Give a whole number from 1 to ${Number.MAX_SAFE_INTEGER}, not "0".`,
    });
  });

  it("makes a change once more, read again, when another device changed them first", async () => {
    const fake = signedIn();
    const { registry, type } = await page(fake);

    await type("/set uploads");
    await readAt(registry, 0);

    // Another device's Change, which this page has not heard of yet.
    fake.daemon.owner = { options: { "uploads.maxSize": 2048 }, sequence: 7 };
    await type("/set uploads.expireAfter 30");
    await settled(() => fake.daemon.owner.sequence === 10);

    expect({ changes: fake.daemon.ownerChanges, owner: fake.daemon.owner }).toStrictEqual({
      changes: [
        { ifSequence: "0", route: "PUT uploads.expireAfter" },
        { ifSequence: "7", route: "PUT uploads.expireAfter" },
      ],
      owner: { options: { "uploads.expireAfter": 30, "uploads.maxSize": 2048 }, sequence: 10 },
    });
  });

  it("shows another device's change, followed from the Daemon", async () => {
    const fake = signedIn();
    const first = await page(fake);
    const second = await page(fake);

    await first.type("/set store.s3.region");
    await second.type("/set store.s3.region");
    await eventually(() => fake.daemon.ownerFollowers.length === 2);
    await second.type("/set store.s3.region us-east-1");
    await settled(() => rowOf(first.container, "store.s3.region")?.[1] === "us-east-1");

    expect(rowOf(first.container, "store.s3.region")).toStrictEqual([
      "store.s3.region",
      "us-east-1",
      "unset",
      "The bucket's region, such as us-east-1, or auto.",
    ]);
  });

  it("shows a Credential another device held and named as held, followed from the Daemon", async () => {
    const fake = signedIn();
    const first = await page(fake);
    const second = await page(fake);

    await first.type("/set store.s3.access*");
    await second.type("/set store.s3.access*");
    await eventually(() => fake.daemon.ownerFollowers.length === 2);
    await readAt(first.registry, 0);
    await readAt(second.registry, 0);
    await second.type("/set store.s3.accessKeyId");

    const field = second.container.querySelector<HTMLInputElement>('input[name="value"]');

    if (field === null) {
      throw new Error("no prompt");
    }

    await typeInto(field, "the-bucket's-access-key-id");
    await doing(() => {
      field.form?.requestSubmit();
    });
    await settled(
      () =>
        rowOf(first.container, "store.s3.accessKeyId")?.[1] === "Owner.store.s3.accessKeyId held"
    );

    expect(rowOf(first.container, "store.s3.accessKeyId")?.[1]).toBe(
      "Owner.store.s3.accessKeyId held"
    );
  });

  it("holds a Credential option's value in the Vault, sets the option to its name, and shows only whether it is held", async () => {
    const fake = signedIn();
    const { container, registry, type } = await page(fake);
    const secret = "the-bucket's-secret-access-key";

    await type("/set store.s3.secret*");
    await readAt(registry, 0);
    await type("/set store.s3.secretAccessKey");
    const before = rowOf(container, "store.s3.secretAccessKey");

    const field = container.querySelector<HTMLInputElement>('input[name="value"]');

    if (field === null) {
      throw new Error("no prompt");
    }

    await typeInto(field, secret);
    await doing(() => {
      field.form?.requestSubmit();
    });
    await settled(
      () =>
        rowOf(container, "store.s3.secretAccessKey")?.[1] === "Owner.store.s3.secretAccessKey held"
    );

    expect({
      atoms: holds(registry, secret),
      before,
      changes: fake.daemon.ownerChanges,
      held: Object.fromEntries(fake.daemon.credentials),
      option: fake.daemon.owner.options["store.s3.secretAccessKey"],
      page: container.textContent.includes(secret),
      prompt: container.querySelector('input[name="value"]'),
      row: rowOf(container, "store.s3.secretAccessKey"),
    }).toStrictEqual({
      atoms: false,
      before: [
        "store.s3.secretAccessKey",
        "unset",
        "unset",
        "The Credential holding the secret access key of the bucket that keeps Uploads.",
      ],
      changes: [{ ifSequence: "0", route: "PUT store.s3.secretAccessKey" }],
      held: { "Owner.store.s3.secretAccessKey": secret },
      option: "Owner.store.s3.secretAccessKey",
      page: false,
      prompt: null,
      row: [
        "store.s3.secretAccessKey",
        "Owner.store.s3.secretAccessKey held",
        "unset",
        "The Credential holding the secret access key of the bucket that keeps Uploads.",
      ],
    });
  });

  it("offers no device override of one, and never keeps one on the device", async () => {
    const fake = signedIn();
    const { container, registry, type } = await page(fake);

    await type("/set uploads.maxSize");
    await readAt(registry, 0);
    await type("/set -device uploads.maxSize 1024");

    expect({
      changes: fake.daemon.ownerChanges,
      device: registry.get(deviceUi),
      row: rowOf(container, "uploads.maxSize")?.[1],
    }).toStrictEqual({ changes: [], device: {}, row: "104857600" });
  });
});
