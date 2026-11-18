// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { deviceUiKey } from "@iirc/frontend/ui";
import { Effect } from "effect";
import type { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { writeChoice } from "../page/device.ts";
import { check } from "../sign-in/atoms.ts";
import {
  eventually,
  fakeDaemon,
  holds,
  liberaConfiguration,
  registryFor,
  run,
} from "../testing/fake-daemon.ts";
import { editing, optionsState, optionsSync } from "./atoms.ts";
import { deviceUi } from "./device.ts";
import { ownerSync } from "./owner.ts";
import { uiSync } from "./ui.ts";

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
 * @param fetch - How the page reaches it, the fake's own unless a test stands between.
 * @returns The registry, the page, and a way to type a line into its composer.
 */
const page = async (
  fake: ReturnType<typeof fakeDaemon>,
  fetch: typeof globalThis.fetch = fake.fetch
) => {
  const registry = registryFor(fetch);

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
 * Waits for the options under `store`, `uploads`, and `previews` to be read, as the view shows them.
 * @param registry - The registry.
 * @param sequence - The sequence they must be read at.
 */
const readAt = async (registry: AtomRegistry.AtomRegistry, sequence: number) => {
  await settled(() => registry.get(optionsState).owner?.sequence === sequence);
};

describe("the options view, under store, uploads, and previews", () => {
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
        "The most bytes the store may hold for live Uploads, each distinct file counted once; an upload that would pass it is refused, and nothing is evicted. Unset, there is no limit.",
      ],
      [
        "uploads.publicUrl",
        "unset",
        "unset",
        "The base of every Upload's link, an http or https URL, such as https://files.example.com, kept without a trailing /.",
      ],
    ]);
  });

  it("has the Pane's whole width, with no Uploads listed beside it", async () => {
    const fake = signedIn();
    const { container, registry, type } = await page(fake);

    await type("/set uploads");
    await readAt(registry, 0);

    expect({
      options: container.querySelector('section[aria-label="Options"]') !== null,
      uploads: container.querySelector('section[aria-label="Uploads"]'),
    }).toStrictEqual({ options: true, uploads: null });
  });

  it("lists the Previews' option from the Schema, at its default", async () => {
    const fake = signedIn();
    const { container, registry, type } = await page(fake);

    await type("/set previews.max");
    await readAt(registry, 0);

    expect(rows(container)).toStrictEqual([
      [
        "previews.maxTotal",
        "1073741824",
        "1073741824",
        "The most bytes the store may hold for Previews' images. 1073741824, 1 GiB, unless set; the least recently shown lose their images first.",
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
        options: {
          "previews.maxTotal": 1_073_741_824,
          "store.s3.bucket": "my-bucket",
          "uploads.maxSize": 104_857_600,
        },
        sequence: 11,
      },
      refused: 0,
    });
  });

  it("asks before unsetting one on Delete, and on Enter unsets it, sending it and showing its default", async () => {
    const fake = signedIn();
    const { container, registry, type } = await page(fake);

    await type("/set store");
    await readAt(registry, 0);
    await type("/set store.s3.bucket my-bucket");
    await settled(() => rowOf(container, "store.s3.bucket")?.[1] === "my-bucket");

    const row = container.querySelector<HTMLElement>('[data-key="store.s3.bucket"]');

    if (row === null) {
      throw new Error("no row");
    }

    await press(row, "Delete");

    const question = container.querySelector('[role="alertdialog"]')?.textContent;

    const button = [...container.querySelectorAll('[role="alertdialog"] button')].find(
      (one) => one.textContent === "Unset"
    );

    if (button === undefined) {
      throw new Error("no Unset button");
    }

    // A press by keyboard is its key going down and up.
    await press(button, "Enter");
    await doing(() => {
      button.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
    });
    await settled(() => rowOf(container, "store.s3.bucket")?.[1] === "unset");

    expect({
      changes: fake.daemon.ownerChanges.map((one) => one.route),
      question,
      row: rowOf(container, "store.s3.bucket")?.[1],
    }).toStrictEqual({
      changes: ["PUT store.s3.bucket", "DELETE store.s3.bucket"],
      question: "Unset store.s3.bucket?UnsetKeep",
      row: "unset",
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
    fake.daemon.owner = {
      options: { "previews.maxTotal": 1_073_741_824, "uploads.maxSize": 2048 },
      sequence: 7,
    };
    await type("/set uploads.expireAfter 30");
    await settled(() => fake.daemon.owner.sequence === 10);

    expect({ changes: fake.daemon.ownerChanges, owner: fake.daemon.owner }).toStrictEqual({
      changes: [
        { ifSequence: "0", route: "PUT uploads.expireAfter" },
        { ifSequence: "7", route: "PUT uploads.expireAfter" },
      ],
      owner: {
        options: {
          "previews.maxTotal": 1_073_741_824,
          "uploads.expireAfter": 30,
          "uploads.maxSize": 2048,
        },
        sequence: 10,
      },
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

  it("shows a Credential another device held again under the name an option already gave it as held", async () => {
    const fake = signedIn();

    fake.daemon.owner = {
      options: {
        "previews.maxTotal": 1_073_741_824,
        "store.s3.accessKeyId": "Owner.store.s3.accessKeyId",
        "uploads.maxSize": 104_857_600,
      },
      sequence: 1,
    };

    const first = await page(fake);
    const second = await page(fake);

    await first.type("/set store.s3.access*");
    await second.type("/set store.s3.access*");
    await eventually(() => fake.daemon.ownerFollowers.length === 2);
    await readAt(first.registry, 1);
    await readAt(second.registry, 1);
    await settled(
      () =>
        rowOf(first.container, "store.s3.accessKeyId")?.[1] ===
        "Owner.store.s3.accessKeyId not held"
    );
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

    expect({
      changes: fake.daemon.ownerChanges,
      row: rowOf(first.container, "store.s3.accessKeyId")?.[1],
    }).toStrictEqual({
      changes: [{ ifSequence: "1", route: "PUT store.s3.accessKeyId" }],
      row: "Owner.store.s3.accessKeyId held",
    });
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

/**
 * The fake Daemon with each write of an option held until the test lets it go, and either
 * taken as the fake takes it, or refused as the Daemon refuses a Change it cannot journal.
 * @param fake - The fake Daemon.
 * @returns The fetch to hand the page, and the writes held.
 */
const holdingWrites = (fake: ReturnType<typeof fakeDaemon>) => {
  const writes: (() => void)[] = [];
  const state = { holding: false, refusing: false };

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const writing = (init?.method ?? "GET") !== "GET";
    const option = /^\/api\/(?:ui|options)\/|^\/api\/networks\/libera$/u.test(url.pathname);

    if (!state.holding || !writing || !option) {
      return await fake.fetch(input, init);
    }

    const { promise, resolve } = Promise.withResolvers<undefined>();

    writes.push(() => {
      resolve(undefined);
    });
    await promise;

    return state.refusing
      ? Response.json({ _tag: "JournalFailed", reason: "disk" }, { status: 500 })
      : await fake.fetch(input, init);
  };

  return { fetch, state, writes };
};

/**
 * A page showing the options, signed in to a fake Daemon whose writes can be held, once it
 * has read the options under `ui`, `store`, `uploads`, and `previews`, and a Network's.
 * @returns The page, the fake, and the writes held.
 */
const held = async () => {
  const fake = signedIn();
  const { fetch, state, writes } = holdingWrites(fake);
  const shown = await page(fake, fetch);

  shown.registry.mount(uiSync);
  await shown.type("/set");
  await settled(
    () =>
      shown.registry.get(optionsState).ui !== undefined &&
      shown.registry.get(optionsState).owner !== undefined &&
      rowOf(shown.container, "ui.time")?.[1] === "HH:mm"
  );
  state.holding = true;

  return { ...shown, fake, state, writes };
};

/** Lets several frames pass, so a write still held is seen to be. */
const later = async () => {
  await act(async () => {
    await Effect.runPromise(Effect.sleep("100 millis"));
  });
};

describe("an option's change, while it is on its way", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("shows ui.time as asked, while the write is held and once it is answered", async () => {
    const { container, type, writes } = await held();

    await type("/set ui.time HH:mm:ss");
    await settled(() => writes.length === 1);
    await later();
    const whileHeld = rowOf(container, "ui.time")?.[1];

    for (const release of writes.splice(0)) {
      release();
    }

    await later();

    expect([whileHeld, rowOf(container, "ui.time")?.[1]]).toStrictEqual(["HH:mm:ss", "HH:mm:ss"]);
  });

  it("shows a Network's option as asked, while the write is held", async () => {
    const { container, type, writes } = await held();

    await type("/set network.libera.realname Dean");
    await settled(() => writes.length === 1);
    await later();
    const whileHeld = rowOf(container, "network.libera.realname")?.[1];

    for (const release of writes.splice(0)) {
      release();
    }

    await later();

    expect([whileHeld, rowOf(container, "network.libera.realname")?.[1]]).toStrictEqual([
      "Dean",
      "Dean",
    ]);
  });

  it("shows an option under store as asked, while the write is held", async () => {
    const { container, type, writes } = await held();

    await type("/set store.s3.bucket my-bucket");
    await settled(() => writes.length === 1);
    await later();
    const whileHeld = rowOf(container, "store.s3.bucket")?.[1];

    for (const release of writes.splice(0)) {
      release();
    }

    await later();

    expect([whileHeld, rowOf(container, "store.s3.bucket")?.[1]]).toStrictEqual([
      "my-bucket",
      "my-bucket",
    ]);
  });

  it("goes back to what is in force when the Daemon refuses, and says why", async () => {
    const { container, state, type, writes } = await held();

    state.refusing = true;
    await type("/set ui.time HH:mm:ss");
    await settled(() => writes.length === 1);
    await later();
    const whileHeld = rowOf(container, "ui.time")?.[1];

    for (const release of writes.splice(0)) {
      release();
    }

    await settled(() => rowOf(container, "ui.time")?.[1] === "HH:mm");

    expect({
      notice: container.querySelector('[role="alert"]')?.firstChild?.textContent,
      whileHeld,
    }).toStrictEqual({
      notice: "The Daemon could not record this, so nothing was changed.",
      whileHeld: "HH:mm:ss",
    });
  });
});

/**
 * The fake Daemon with each read of the paths a test names held until it lets them go.
 * @param fake - The fake Daemon.
 * @returns The fetch to hand the page, the paths held, and the reads held.
 */
const holdingReads = (fake: ReturnType<typeof fakeDaemon>) => {
  const reads: (() => void)[] = [];
  const paths = new Set<string>();

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);

    if ((init?.method ?? "GET") === "GET" && paths.has(url.pathname)) {
      const { promise, resolve } = Promise.withResolvers<undefined>();

      reads.push(() => {
        resolve(undefined);
      });
      await promise;
    }

    return await fake.fetch(input, init);
  };

  const release = () => {
    paths.clear();

    for (const read of reads.splice(0)) {
      read();
    }
  };

  return { fetch, paths, reads, release };
};

/**
 * A fake Daemon whose options name a Credential under `store` and one of libera's, both
 * held, and set `uploads.publicUrl`, so no value is its default or "not held".
 * @returns The fake.
 */
const configured = () => {
  const fake = signedIn();

  fake.daemon.owner = {
    options: {
      ...fake.daemon.owner.options,
      "previews.maxTotal": 4096,
      "store.s3.accessKeyId": "Owner.store.s3.accessKeyId",
      "uploads.publicUrl": "https://files.example.com",
    },
    sequence: 3,
  };
  fake.daemon.configurations.set("libera", {
    configuration: { ...liberaConfiguration, password: "libera.password" },
    sequence: 2,
  });
  fake.daemon.credentials.set("Owner.store.s3.accessKeyId", "an-access-key-id");
  fake.daemon.credentials.set("libera.password", "a-password");

  return fake;
};

/**
 * Whatever in the view would read as an answer while it is not known: a default, "not
 * held", an empty filter, or a Network with no rows and no wait.
 * @param container - The page.
 * @returns What the view says of each.
 */
const answers = (container: HTMLElement) => {
  const text = container.querySelector('section[aria-label="Options"]')?.textContent ?? "";

  return {
    accessKeyId: rowOf(container, "store.s3.accessKeyId")?.[1],
    libera: rows(container).some(([name]) => name?.startsWith("network.libera.") === true),
    maxTotal: rowOf(container, "previews.maxTotal")?.[1],
    nothingMatches: text.includes("No option matches."),
    password: rowOf(container, "network.libera.password")?.[1],
    publicUrl: rowOf(container, "uploads.publicUrl")?.[1],
    waits: [...container.querySelectorAll('[aria-label="Being read"] li')].map(
      (wait) => wait.textContent
    ),
  };
};

/** What the view says once everything is read. */
const allRead = {
  accessKeyId: "Owner.store.s3.accessKeyId held",
  libera: true,
  maxTotal: "4096",
  nothingMatches: false,
  password: "libera.password held",
  publicUrl: "https://files.example.com",
  waits: [],
};

/**
 * Opens the options with each read of the paths given held, then lets them go.
 * @param held - The paths whose reads are held.
 * @param filter - What to filter the options by.
 * @returns What the view says while they are held, and once they are read.
 */
const opened = async (held: readonly string[], filter = "") => {
  const fake = configured();
  const reads = holdingReads(fake);
  const shown = await page(fake, reads.fetch);

  shown.registry.mount(uiSync);
  await settled(() => shown.registry.get(optionsState).ui !== undefined);

  for (const path of held) {
    reads.paths.add(path);
  }

  await shown.type(`/set ${filter}`.trimEnd());
  await settled(() => reads.reads.length >= 1);
  await later();

  const holding = answers(shown.container);

  reads.release();
  await settled(() => {
    const now = answers(shown.container);

    return now.waits.length === 0 && !JSON.stringify(now).includes("reading…");
  });

  return { holding, read: answers(shown.container) };
};

describe("the options view, opened while what it shows is read", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("draws each option under store, uploads, and previews as being read, never its default, until they are", async () => {
    const { holding, read } = await opened(["/api/options/changes"]);

    expect({ holding, read }).toStrictEqual({
      holding: {
        ...allRead,
        accessKeyId: "reading…",
        maxTotal: "reading…",
        publicUrl: "reading…",
      },
      read: allRead,
    });
  });

  it("draws whether a Credential is held as being read, never as not held, until the names held are", async () => {
    const { holding, read } = await opened(["/api/credentials"]);

    expect({ holding, read }).toStrictEqual({
      holding: {
        ...allRead,
        accessKeyId: "Owner.store.s3.accessKeyId reading…",
        password: "libera.password reading…",
      },
      read: allRead,
    });
  });

  it("draws the Networks as being read, never as none, until they are listed", async () => {
    const { holding, read } = await opened(["/api/networks"], "network.libera.*");

    expect({ holding, read }).toStrictEqual({
      holding: {
        ...allRead,
        accessKeyId: undefined,
        libera: false,
        maxTotal: undefined,
        password: undefined,
        publicUrl: undefined,
        waits: ["Reading network.*…"],
      },
      read: { ...allRead, accessKeyId: undefined, maxTotal: undefined, publicUrl: undefined },
    });
  });

  it("draws a Network as being read, never with no rows, until its Configuration is", async () => {
    const { holding, read } = await opened(["/api/networks/libera/configuration"]);

    expect({ holding, read }).toStrictEqual({
      holding: {
        ...allRead,
        libera: false,
        password: undefined,
        waits: ["Reading network.libera.*…"],
      },
      read: allRead,
    });
  });
});

/**
 * The fake Daemon with each read of the paths a test names refused as an Ircd's gateway
 * would, with no answer the API knows.
 * @param fake - The fake Daemon.
 * @param paths - The paths refused.
 * @returns The fetch to hand the page.
 */
const failingReads =
  (fake: ReturnType<typeof fakeDaemon>, paths: ReadonlySet<string>) =>
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);

    return (init?.method ?? "GET") === "GET" && paths.has(url.pathname)
      ? new Response(null, { status: 502 })
      : await fake.fetch(input, init);
  };

/**
 * Opens the options with each read of the paths given refused.
 * @param paths - The paths refused.
 * @returns The page once the options are read.
 */
const failed = async (paths: readonly string[]) => {
  const fake = configured();
  const refused = new Set<string>();
  const shown = await page(fake, failingReads(fake, refused));

  shown.registry.mount(uiSync);
  await settled(() => shown.registry.get(optionsState).ui !== undefined);

  for (const path of paths) {
    refused.add(path);
  }

  await shown.type("/set");
  await settled(() => shown.registry.get(optionsState).notice !== undefined);

  return shown;
};

describe("the options view, opened when a read fails", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("says the Networks were not listed, and draws no wait for them", async () => {
    const { container } = await failed(["/api/networks"]);

    expect({
      accessKeyId: rowOf(container, "store.s3.accessKeyId")?.[1],
      notice: container.querySelector('[role="alert"]')?.textContent,
      waits: answers(container).waits,
    }).toStrictEqual({
      accessKeyId: "Owner.store.s3.accessKeyId held",
      notice:
        "The Daemon did not list its Networks, so their options are not shown. Open the options again to read them.",
      waits: [],
    });
  });

  it("says whether each Credential is held is not known, and never that one is not held", async () => {
    const { container } = await failed(["/api/credentials"]);

    expect({
      accessKeyId: rowOf(container, "store.s3.accessKeyId")?.[1],
      notice: container.querySelector('[role="alert"]')?.textContent,
      password: rowOf(container, "network.libera.password")?.[1],
    }).toStrictEqual({
      accessKeyId: "Owner.store.s3.accessKeyId not known",
      notice:
        "The Daemon did not say which Credentials it holds, so whether each is held is not known. Open the options again to read them.",
      password: "libera.password not known",
    });
  });

  it("says both when the Networks and the names held both fail, one never hiding the other", async () => {
    const { container } = await failed(["/api/networks", "/api/credentials"]);

    await settled(() =>
      (container.querySelector('[role="alert"]')?.textContent ?? "").includes("Credentials")
    );
    await later();

    const notice = container.querySelector('[role="alert"]')?.textContent ?? "";

    expect({
      credentials: notice.includes("did not say which Credentials it holds"),
      networks: notice.includes("did not list its Networks"),
    }).toStrictEqual({ credentials: true, networks: true });
  });

  it("shows a Credential as not known, never by the names last read, when a later read of them fails", async () => {
    const fake = configured();
    const refused = new Set<string>();
    const shown = await page(fake, failingReads(fake, refused));

    shown.registry.mount(uiSync);
    await shown.type("/set");
    await settled(
      () =>
        rowOf(shown.container, "store.s3.accessKeyId")?.[1] === "Owner.store.s3.accessKeyId held"
    );
    refused.add("/api/credentials");
    // A Change followed reads the names held again, as another device may have held one.
    await shown.type("/set uploads.maxSize 2048");
    await settled(() => rowOf(shown.container, "uploads.maxSize")?.[1] === "2048");
    await later();

    expect(rowOf(shown.container, "store.s3.accessKeyId")?.[1]).toBe(
      "Owner.store.s3.accessKeyId not known"
    );
  });

  it("asks nothing of an option still being read when Delete is pressed on it", async () => {
    const fake = configured();
    const reads = holdingReads(fake);
    const shown = await page(fake, reads.fetch);

    shown.registry.mount(uiSync);
    await settled(() => shown.registry.get(optionsState).ui !== undefined);
    reads.paths.add("/api/options/changes");
    await shown.type("/set");
    await settled(() => rowOf(shown.container, "uploads.publicUrl")?.[1] === "reading…");

    const row = shown.container.querySelector<HTMLElement>('[data-key="uploads.publicUrl"]');

    if (row === null) {
      throw new Error("no row");
    }

    await press(row, "Delete");
    const asked = shown.registry.get(optionsState).confirming;

    reads.release();

    expect(asked).toBeUndefined();
  });
});

/**
 * Opens an option's value to edit, as Enter on its row does.
 * @param shown - The page.
 * @param name - The option.
 * @returns Its editor.
 */
const editorOf = async (shown: Awaited<ReturnType<typeof page>>, name: string) => {
  await doing(() => {
    shown.registry.set(editing, name);
  });
  await settled(
    () => shown.container.querySelector(`input[aria-label="Value of ${name}"]`) !== null
  );

  const field = shown.container.querySelector<HTMLInputElement>(
    `input[aria-label="Value of ${name}"]`
  );

  if (field === null) {
    throw new Error("no editor");
  }

  field.focus();

  return field;
};

/**
 * Presses a key on an element, held with Shift or not, as a browser does.
 * @param element - The element.
 * @param key - The key.
 * @param shiftKey - Whether Shift is held.
 * @returns Whether anything stopped the browser carrying it out.
 */
const pressed = async (element: Element, key: string, shiftKey = false) => {
  let prevented = false;

  await doing(() => {
    prevented = !element.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: key, key, shiftKey })
    );
  });

  return prevented;
};

describe("an option edited in place", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("leaves Left, Right, Home, End and their selecting forms to the caret, and Up and Down to a number", async () => {
    const shown = await page(signedIn());

    await shown.type("/set");
    await readAt(shown.registry, 0);

    const field = await editorOf(shown, "uploads.maxSize");

    // Each key is pressed in turn, as the Owner would, alone and then with Shift.
    const caret = [
      ["ArrowLeft", await pressed(field, "ArrowLeft"), await pressed(field, "ArrowLeft", true)],
      ["ArrowRight", await pressed(field, "ArrowRight"), await pressed(field, "ArrowRight", true)],
      ["Home", await pressed(field, "Home"), await pressed(field, "Home", true)],
      ["End", await pressed(field, "End"), await pressed(field, "End", true)],
      ["ArrowUp", await pressed(field, "ArrowUp")],
      ["ArrowDown", await pressed(field, "ArrowDown")],
    ];

    expect({ caret, focused: document.activeElement === field }).toStrictEqual({
      caret: [
        ["ArrowLeft", false, false],
        ["ArrowRight", false, false],
        ["Home", false, false],
        ["End", false, false],
        ["ArrowUp", false],
        ["ArrowDown", false],
      ],
      focused: true,
    });
  });

  it("keeps the value in its place, hidden under its editor, so opening it moves nothing", async () => {
    const shown = await page(signedIn());

    await shown.type("/set network.libera.");
    await settled(() => rowOf(shown.container, "network.libera.realname") !== undefined);

    const value = () =>
      shown.container.querySelector<HTMLElement>(
        '[data-key="network.libera.realname"] [data-value]'
      );

    const before = value();
    const text = before?.textContent;
    const field = await editorOf(shown, "network.libera.realname");
    const during = value();

    // The value's own element, in the flow of its row, decides the row's height either way,
    // and the editor takes no room of its own.
    expect({
      editor: getComputedStyle(field).position,
      same: during !== null && during === before,
      text: during?.textContent,
      visibility: during === null ? undefined : getComputedStyle(during).visibility,
    }).toStrictEqual({ editor: "absolute", same: true, text, visibility: "hidden" });
  });

  it("says in a word that a value, and what it starts as, is empty", async () => {
    const shown = await page(signedIn());

    await shown.type("/set network.libera.highlights");
    await settled(() => rowOf(shown.container, "network.libera.highlights") !== undefined);

    expect(rowOf(shown.container, "network.libera.highlights")?.slice(0, 3)).toStrictEqual([
      "network.libera.highlights",
      "empty",
      "empty",
    ]);
  });
});
