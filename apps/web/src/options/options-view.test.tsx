// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { NetworkId } from "@iirc/api";
import { deviceUiKey } from "@iirc/frontend/ui";
import { Schema } from "effect";
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
import { change, editing, optionsState, optionsSync } from "./atoms.ts";
import { ownerSync } from "./owner.ts";
import { uiSync } from "./ui.ts";

const libera = Schema.decodeSync(NetworkId)("libera");

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
  [...container.querySelectorAll<HTMLElement>('section[aria-label="Settings"] [data-key]')].map(
    (row) => {
      // A row's one grid cell holds two lines: its name and value, then its description
      // and what it starts as.
      const [first, second] = [...(row.firstElementChild?.children ?? [])];
      const [name, value] = [...(first?.children ?? [])];
      const [description, starts] = [...(second?.children ?? [])];

      return [name, value, starts, description].map((part) => part?.textContent);
    }
  );

/**
 * One option's row, as the text of each of its lines.
 * @param container - The page.
 * @param name - The option.
 * @returns The lines.
 */
const linesOf = (container: HTMLElement, name: string) =>
  [...(container.querySelector(`[data-key="${name}"]`)?.firstElementChild?.children ?? [])].map(
    (line) => line.textContent
  );

/**
 * The headings the options are under, in order.
 * @param container - The page.
 * @returns The headings.
 */
const headingsOf = (container: HTMLElement) =>
  [...container.querySelectorAll('section[aria-label="Settings"] [role="rowheader"]')].map(
    (heading) => heading.textContent
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

describe("the options view, under storage, uploads, and previews", () => {
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
        "not set",
        "default: unset",
        "How many days an upload is kept before it is deleted, from 1 to 36500. When not set, an upload is kept until you delete it.",
      ],
      [
        "uploads.listen",
        "not set",
        "default: unset",
        "The address the upload server listens on, as host:port, such as 127.0.0.1:7668.",
      ],
      [
        "uploads.maxSize",
        "100000000",
        "default: 100000000",
        "The maximum size of an upload, in bytes. The default is 100 MB.",
      ],
      [
        "uploads.maxTotal",
        "not set",
        "default: unset",
        "The maximum total size of uploads that storage may hold, in bytes, counting each distinct file once. An upload that would exceed it is refused, and nothing is deleted to make room. When not set, there is no limit.",
      ],
      [
        "uploads.publicUrl",
        "not set",
        "default: unset",
        "The address every upload link starts with, an http or https URL, such as https://files.example.com.",
      ],
    ]);
  });

  it("sets one with /set, made from the options read, and refuses a bad value before sending anything", async () => {
    const fake = signedIn();
    const { container, registry, type } = await page(fake);

    await type("/set storage");
    await readAt(registry, 0);
    await type("/set storage.s3.bucket My_Bucket");
    const refused = fake.daemon.ownerChanges.length;

    await type("/set storage.s3.bucket my-bucket");
    await settled(() => rowOf(container, "storage.s3.bucket")?.[1] === "my-bucket");
    await type("/unset uploads.maxSize");
    await settled(() => fake.daemon.ownerChanges.length === 2);

    expect({
      changes: fake.daemon.ownerChanges,
      owner: fake.daemon.owner,
      refused,
    }).toStrictEqual({
      changes: [
        { ifSequence: "0", route: "PUT storage.s3.bucket" },
        { ifSequence: "10", route: "DELETE uploads.maxSize" },
      ],
      owner: {
        options: {
          "previews.maxTotal": 1_000_000_000,
          "storage.s3.bucket": "my-bucket",
          "uploads.maxSize": 100_000_000,
        },
        sequence: 11,
      },
      refused: 0,
    });
  });

  it("asks before unsetting one on Delete, and on Enter unsets it, sending it and showing its default", async () => {
    const fake = signedIn();
    const { container, registry, type } = await page(fake);

    await type("/set storage");
    await readAt(registry, 0);
    await type("/set storage.s3.bucket my-bucket");
    await settled(() => rowOf(container, "storage.s3.bucket")?.[1] === "my-bucket");

    const row = container.querySelector<HTMLElement>('[data-key="storage.s3.bucket"]');

    if (row === null) {
      throw new Error("no row");
    }

    await press(row, "Delete");

    const question = container.querySelector('[role="alertdialog"]')?.textContent;

    const button = [...container.querySelectorAll('[role="alertdialog"] button')].find(
      (one) => one.textContent === "unset"
    );

    if (button === undefined) {
      throw new Error("no Unset button");
    }

    // A press by keyboard is its key going down and up.
    await press(button, "Enter");
    await doing(() => {
      button.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
    });
    await settled(() => rowOf(container, "storage.s3.bucket")?.[1] === "not set");

    expect({
      changes: fake.daemon.ownerChanges.map((one) => one.route),
      question,
      row: rowOf(container, "storage.s3.bucket")?.[1],
    }).toStrictEqual({
      changes: ["PUT storage.s3.bucket", "DELETE storage.s3.bucket"],
      question: "Unset storage.s3.bucket?unsetkeep",
      row: "not set",
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
      'section[aria-label="Settings"] [role="alert"]'
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
      options: { "previews.maxTotal": 1_000_000_000, "uploads.maxSize": 2048 },
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
          "previews.maxTotal": 1_000_000_000,
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

    await first.type("/set storage.s3.region");
    await second.type("/set storage.s3.region");
    await eventually(() => fake.daemon.ownerFollowers.length === 2);
    await second.type("/set storage.s3.region us-east-1");
    await settled(() => rowOf(first.container, "storage.s3.region")?.[1] === "us-east-1");

    expect(rowOf(first.container, "storage.s3.region")).toStrictEqual([
      "storage.s3.region",
      "us-east-1",
      "default: unset",
      "The bucket's region, such as us-east-1, or auto.",
    ]);
  });

  it("shows a Credential another device held again under the name an option already gave it as set", async () => {
    const fake = signedIn();

    fake.daemon.owner = {
      options: {
        "previews.maxTotal": 1_000_000_000,
        "storage.s3.accessKeyId": "Owner.storage.s3.accessKeyId",
        "uploads.maxSize": 100_000_000,
      },
      sequence: 1,
    };

    const first = await page(fake);
    const second = await page(fake);

    await first.type("/set storage.s3.access*");
    await second.type("/set storage.s3.access*");
    await eventually(() => fake.daemon.ownerFollowers.length === 2);
    await readAt(first.registry, 1);
    await readAt(second.registry, 1);
    await settled(
      () =>
        rowOf(first.container, "storage.s3.accessKeyId")?.[1] ===
        "Owner.storage.s3.accessKeyId not set"
    );
    await second.type("/set storage.s3.accessKeyId");

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
        rowOf(first.container, "storage.s3.accessKeyId")?.[1] === "Owner.storage.s3.accessKeyId set"
    );

    expect({
      changes: fake.daemon.ownerChanges,
      row: rowOf(first.container, "storage.s3.accessKeyId")?.[1],
    }).toStrictEqual({
      changes: [{ ifSequence: "1", route: "PUT storage.s3.accessKeyId" }],
      row: "Owner.storage.s3.accessKeyId set",
    });
  });

  it("holds a Credential option's value in the Vault, sets the option to its name, and shows only whether it is set", async () => {
    const fake = signedIn();
    const { container, registry, type } = await page(fake);
    const secret = "the-bucket's-secret-access-key";

    await type("/set storage.s3.secret*");
    await readAt(registry, 0);
    await type("/set storage.s3.secretAccessKey");
    const before = rowOf(container, "storage.s3.secretAccessKey");

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
        rowOf(container, "storage.s3.secretAccessKey")?.[1] ===
        "Owner.storage.s3.secretAccessKey set"
    );

    expect({
      atoms: holds(registry, secret),
      before,
      changes: fake.daemon.ownerChanges,
      held: Object.fromEntries(fake.daemon.credentials),
      option: fake.daemon.owner.options["storage.s3.secretAccessKey"],
      page: container.textContent.includes(secret),
      prompt: container.querySelector('input[name="value"]'),
      row: rowOf(container, "storage.s3.secretAccessKey"),
    }).toStrictEqual({
      atoms: false,
      before: [
        "storage.s3.secretAccessKey",
        "not set",
        "default: unset",
        "The secret that holds the bucket's secret access key.",
      ],
      changes: [{ ifSequence: "0", route: "PUT storage.s3.secretAccessKey" }],
      held: { "Owner.storage.s3.secretAccessKey": secret },
      option: "Owner.storage.s3.secretAccessKey",
      page: false,
      prompt: null,
      row: [
        "storage.s3.secretAccessKey",
        "Owner.storage.s3.secretAccessKey set",
        "default: unset",
        "The secret that holds the bucket's secret access key.",
      ],
    });
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
      rowOf(shown.container, "ui.conversation.timeFormat")?.[1] === "HH:mm"
  );
  state.holding = true;

  return { ...shown, fake, state, writes };
};

describe("an option's change, while it is on its way", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("shows a Network's option as asked, while the write is set", async () => {
    const { container, type, writes } = await held();

    await type("/set network.libera.realname Dean");
    await settled(() => writes.length === 1);
    await settled(() => rowOf(container, "network.libera.realname")?.[1] === "Dean");
    const whileHeld = [writes.length, rowOf(container, "network.libera.realname")?.[1]];

    // Let go, so no write is left waiting when the page is taken down.
    for (const release of writes.splice(0)) {
      release();
    }

    expect(whileHeld).toStrictEqual([1, "Dean"]);
  });

  it("unsets a Network's option on the Daemon, showing at once, when unset while its set is set", async () => {
    const { container, fake, registry, state, writes } = await held();
    const realname = ["realname"];

    registry.set(change, { edit: { _tag: "Set", path: realname, text: "Dean" }, network: libera });
    await settled(
      () => writes.length === 1 && rowOf(container, "network.libera.realname")?.[1] === "Dean"
    );
    registry.set(change, { edit: { _tag: "Unset", path: realname }, network: libera });
    await settled(
      () =>
        registry.get(optionsState).onItsWay.length === 2 &&
        rowOf(container, "network.libera.realname")?.[1] === "iirc"
    );
    const whileHeld = writes.length;

    state.holding = false;

    for (const release of writes.splice(0)) {
      release();
    }

    await settled(() => registry.get(optionsState).onItsWay.length === 0);

    // The unset takes realname back to what it starts as, after the set made it Dean.
    expect({
      configuration: fake.daemon.configurations.get("libera")?.configuration,
      puts: fake.daemon.puts.length,
      whileHeld,
    }).toStrictEqual({ configuration: liberaConfiguration, puts: 2, whileHeld: 1 });
  });

  it("shows an option under storage as asked, while the write is set", async () => {
    const { container, type, writes } = await held();

    await type("/set storage.s3.bucket my-bucket");
    await settled(() => writes.length === 1);
    await settled(() => rowOf(container, "storage.s3.bucket")?.[1] === "my-bucket");
    const whileHeld = [writes.length, rowOf(container, "storage.s3.bucket")?.[1]];

    // Let go, so no write is left waiting when the page is taken down.
    for (const release of writes.splice(0)) {
      release();
    }

    expect(whileHeld).toStrictEqual([1, "my-bucket"]);
  });

  it("goes back to what is in force when the Daemon refuses, and says why", async () => {
    const { container, state, type, writes } = await held();

    state.refusing = true;
    await type("/set ui.conversation.timeFormat HH:mm:ss");
    await settled(() => writes.length === 1);
    await settled(() => rowOf(container, "ui.conversation.timeFormat")?.[1] === "HH:mm:ss");
    const whileHeld = rowOf(container, "ui.conversation.timeFormat")?.[1];

    for (const release of writes.splice(0)) {
      release();
    }

    await settled(() => rowOf(container, "ui.conversation.timeFormat")?.[1] === "HH:mm");

    expect({
      notice: container.querySelector('[role="alert"]')?.firstChild?.textContent,
      whileHeld,
    }).toStrictEqual({
      notice: "The daemon could not record this, so nothing was changed.",
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
      "storage.s3.accessKeyId": "Owner.storage.s3.accessKeyId",
      "uploads.publicUrl": "https://files.example.com",
    },
    sequence: 3,
  };
  fake.daemon.configurations.set("libera", {
    configuration: { ...liberaConfiguration, password: "libera.password" },
    sequence: 2,
  });
  fake.daemon.credentials.set("Owner.storage.s3.accessKeyId", "an-access-key-id");
  fake.daemon.credentials.set("libera.password", "a-password");

  return fake;
};

/**
 * Whatever in the view would read as an answer while it is not known: a default, "not
 * set", an empty filter, or a Network with no rows and no wait.
 * @param container - The page.
 * @returns What the view says of each.
 */
const answers = (container: HTMLElement) => {
  const text = container.querySelector('section[aria-label="Settings"]')?.textContent ?? "";

  return {
    accessKeyId: rowOf(container, "storage.s3.accessKeyId")?.[1],
    libera: rows(container).some(([name]) => name?.startsWith("network.libera.") === true),
    maxTotal: rowOf(container, "previews.maxTotal")?.[1],
    nothingMatches: text.includes("No option matches."),
    password: rowOf(container, "network.libera.password")?.[1],
    publicUrl: rowOf(container, "uploads.publicUrl")?.[1],
    waits: [...container.querySelectorAll('[aria-label="Loading"] li')].map(
      (wait) => wait.textContent
    ),
  };
};

/** What the view says once everything is read. */
const allRead = {
  accessKeyId: "Owner.storage.s3.accessKeyId set",
  libera: true,
  maxTotal: "4096",
  nothingMatches: false,
  password: "libera.password set",
  publicUrl: "https://files.example.com",
  waits: [],
};

/**
 * Opens the options with each read of the paths given held, waits until the view says
 * what it should while they are, then lets them go.
 * @param held - The paths whose reads are held.
 * @param holding - What the view should say while they are held.
 * @returns What the view says once they are read.
 */
const opened = async (held: readonly string[], holding: ReturnType<typeof answers>) => {
  const fake = configured();
  const reads = holdingReads(fake);
  const shown = await page(fake, reads.fetch);

  shown.registry.mount(uiSync);
  await settled(() => shown.registry.get(optionsState).ui !== undefined);

  for (const path of held) {
    reads.paths.add(path);
  }

  await shown.type("/set");
  await settled(() => reads.reads.length >= 1);
  await settled(() => JSON.stringify(answers(shown.container)) === JSON.stringify(holding));
  reads.release();
  await settled(() => {
    const now = answers(shown.container);

    return now.waits.length === 0 && !JSON.stringify(now).includes("loading…");
  });

  return answers(shown.container);
};

describe("the options view, opened while what it shows is read", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("draws each option under storage, uploads, and previews as being read, never its default, until they are", async () => {
    const reading = {
      ...allRead,
      accessKeyId: "loading…",
      maxTotal: "loading…",
      publicUrl: "loading…",
    };

    await expect(opened(["/api/options/changes"], reading)).resolves.toStrictEqual(allRead);
  });

  it("draws whether a Credential is held as being read, never as not held, until the names held are", async () => {
    const reading = {
      ...allRead,
      accessKeyId: "Owner.storage.s3.accessKeyId loading…",
      password: "libera.password loading…",
    };

    await expect(opened(["/api/credentials"], reading)).resolves.toStrictEqual(allRead);
  });

  it("draws a Network as being read, never with no rows, until its Configuration is", async () => {
    const reading = {
      ...allRead,
      libera: false,
      password: undefined,
      waits: ["Loading network.libera.*…"],
    };

    await expect(opened(["/api/networks/libera/configuration"], reading)).resolves.toStrictEqual(
      allRead
    );
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
      accessKeyId: rowOf(container, "storage.s3.accessKeyId")?.[1],
      notice: container.querySelector('[role="alert"]')?.textContent,
      waits: answers(container).waits,
    }).toStrictEqual({
      accessKeyId: "Owner.storage.s3.accessKeyId set",
      notice:
        "The daemon did not list its networks, so their settings are not shown. Open settings again to load them.",
      waits: [],
    });
  });

  it("says whether each Credential is held is not known, and never that one is not set", async () => {
    const { container } = await failed(["/api/credentials"]);

    expect({
      accessKeyId: rowOf(container, "storage.s3.accessKeyId")?.[1],
      notice: container.querySelector('[role="alert"]')?.textContent,
      password: rowOf(container, "network.libera.password")?.[1],
    }).toStrictEqual({
      accessKeyId: "Owner.storage.s3.accessKeyId not known",
      notice:
        "The daemon did not say which passwords are saved, so it's unknown whether each is set. Open settings again to load them.",
      password: "libera.password not known",
    });
  });

  it("says both when the Networks and the names held both fail", async () => {
    const { container } = await failed(["/api/networks", "/api/credentials"]);

    await settled(() =>
      (container.querySelector('[role="alert"]')?.textContent ?? "").includes("passwords")
    );

    const notice = container.querySelector('[role="alert"]')?.textContent ?? "";

    expect({
      credentials: notice.includes("did not say which passwords are saved"),
      networks: notice.includes("did not list its networks"),
    }).toStrictEqual({ credentials: true, networks: true });
  });

  it("asks nothing of an option still being read when Delete is pressed on it", async () => {
    const fake = configured();
    const reads = holdingReads(fake);
    const shown = await page(fake, reads.fetch);

    shown.registry.mount(uiSync);
    await settled(() => shown.registry.get(optionsState).ui !== undefined);
    reads.paths.add("/api/options/changes");
    await shown.type("/set");
    await settled(() => rowOf(shown.container, "uploads.publicUrl")?.[1] === "loading…");

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

  await doing(() => {
    field.focus();
  });

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
      "default: empty",
    ]);
  });
});

/**
 * A page showing the options, once it has read those under `ui`.
 * @param fake - The fake Daemon.
 * @returns The page.
 */
const uiShown = async (fake: ReturnType<typeof fakeDaemon>) => {
  const shown = await page(fake);

  shown.registry.mount(uiSync);
  await shown.type("/set ui.");
  await settled(() => rowOf(shown.container, "ui.conversation.timeFormat")?.[1] === "HH:mm");

  return shown;
};

/**
 * An option's row.
 * @param container - The page.
 * @param name - The option.
 * @returns The row.
 */
const rowElement = (container: HTMLElement, name: string) => {
  const row = container.querySelector<HTMLElement>(`[data-key="${name}"]`);

  if (row === null) {
    throw new Error(`no row for ${name}`);
  }

  return row;
};

/**
 * Presses Enter on an element, as a keyboard does: down, then up.
 * @param element - The element.
 */
const enter = async (element: Element) => {
  await press(element, "Enter");
  await doing(() => {
    element.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, code: "Enter", key: "Enter" })
    );
  });
};

/**
 * Opens an option's menu by Enter on its focused row.
 * @param container - The page.
 * @param name - The option.
 * @returns The menu.
 */
const menuFor = async (container: HTMLElement, name: string) => {
  const row = rowElement(container, name);

  await doing(() => {
    row.focus();
  });
  await enter(row);

  const selector = `[role="menu"][aria-label="Value of ${name}"]`;

  await settled(() => document.querySelector(selector) !== null);

  const menu = document.querySelector<HTMLElement>(selector);
  // The entry the menu focuses as it opens, which happy-dom does not move the focus to
  // itself, so it is focused here, as a browser does.
  const first = menu?.querySelector<HTMLElement>('[tabindex="0"]');

  await doing(() => {
    first?.focus();
  });

  return document.querySelector<HTMLElement>(selector);
};

/**
 * A menu's entries, as their text, with the one in force marked.
 * @param menu - The menu.
 * @returns The entries.
 */
const entriesOf = (menu: HTMLElement | null) =>
  [...(menu?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])].map(
    (entry) => `${entry.getAttribute("aria-checked") === "true" ? "* " : ""}${entry.textContent}`
  );

/**
 * Puts Enter down on an element, outside of React's `act`.
 * @param element - The element.
 */
const enterOn = (element: HTMLElement) => {
  element.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: "Enter", key: "Enter" })
  );
};

describe("an option chosen from a menu", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("opens on Enter with the value in force marked and focused, and Enter on another sets what /set sets", async () => {
    const chosen = signedIn();
    const { container } = await uiShown(chosen);
    const menu = await menuFor(container, "ui.conversation.timeFormat");
    const entries = entriesOf(menu);
    const focusedFirst = document.activeElement?.textContent;

    await press(document.activeElement ?? document.body, "ArrowDown");
    const focusedNext = document.activeElement?.textContent;

    await enter(document.activeElement ?? document.body);
    await settled(() => rowOf(container, "ui.conversation.timeFormat")?.[1] === "HH:mm:ss");
    await settled(
      () => document.activeElement === rowElement(container, "ui.conversation.timeFormat")
    );

    const typed = signedIn();
    const other = await uiShown(typed);

    await other.type("/set ui.conversation.timeFormat HH:mm:ss");
    await settled(() => typed.daemon.uiChanges.length === 1);

    expect({
      changes: chosen.daemon.uiChanges,
      entries,
      focusedFirst,
      focusedNext,
      open: document.querySelector('[role="menu"]') !== null,
      ui: chosen.daemon.ui,
    }).toStrictEqual({
      changes: typed.daemon.uiChanges,
      entries: ["* HH:mm", "HH:mm:ss", "h:mm a", "h:mm:ss a", "none"],
      focusedFirst: "HH:mm",
      focusedNext: "HH:mm:ss",
      open: false,
      ui: typed.daemon.ui,
    });
  });

  // Regression: `ui.logs` is not offered, or offers values the contract does not take.
  it("offers ui.logs's levels, info in force, and /set and /unset change it for every device", async () => {
    const fake = signedIn();
    const { container, type } = await uiShown(fake);
    const row = rowOf(container, "ui.logs");
    const entries = entriesOf(await menuFor(container, "ui.logs"));

    await press(document.activeElement ?? document.body, "Escape");
    await type("/set ui.logs debug");
    await settled(() => rowOf(container, "ui.logs")?.[1] === "debug");
    const set = fake.daemon.ui.options.logs;

    await type("/unset ui.logs");
    await settled(() => rowOf(container, "ui.logs")?.[1] === "info");

    expect({
      changes: fake.daemon.uiChanges.map((one) => one.route),
      entries,
      row,
      set,
    }).toStrictEqual({
      changes: ["PUT logs", "DELETE logs"],
      entries: ["debug", "* info", "warning", "error"],
      row: [
        "ui.logs",
        "info",
        "default: info",
        "The minimum level of daemon logs to show, along with every level above it. It changes what is shown, never what the daemon keeps. Every device shares it.",
      ],
      set: "debug",
    });
  });

  it("lets go on Escape, changing nothing, and gives its row the focus with the view still open", async () => {
    const fake = signedIn();
    const { container } = await uiShown(fake);

    await menuFor(container, "ui.conversation.timeFormat");
    await press(document.activeElement ?? document.body, "Escape");
    await settled(() => document.querySelector('[role="menu"]') === null);
    await settled(
      () => document.activeElement === rowElement(container, "ui.conversation.timeFormat")
    );

    // Escape once more, on the row, is the view's own: it closes.
    const before = container.querySelector('section[aria-label="Settings"]') !== null;

    await press(rowElement(container, "ui.conversation.timeFormat"), "Escape");

    expect({
      after: container.querySelector('section[aria-label="Settings"]') !== null,
      before,
      changes: fake.daemon.uiChanges,
    }).toStrictEqual({ after: false, before: true, changes: [] });
  });

  it("ends in Custom… where it also takes text, which opens the field with the value in force", async () => {
    const fake = signedIn();
    const { container } = await uiShown(fake);
    const menu = await menuFor(container, "ui.font");
    const entries = entriesOf(menu);

    const custom = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])].at(
      -1
    );

    if (custom === undefined) {
      throw new Error("no Custom…");
    }

    await doing(() => {
      custom.focus();
    });
    await enter(custom);
    await settled(() => container.querySelector('input[aria-label="Value of ui.font"]') !== null);

    const field = container.querySelector<HTMLInputElement>('input[aria-label="Value of ui.font"]');

    if (field === null) {
      throw new Error("no field");
    }

    const starting = field.value;

    // The field takes the focus, so the Owner can type, and its row never takes it back.
    await settled(() => document.activeElement === field);

    await typeInto(field, "Comic Sans");
    await press(field, "Enter");
    await settled(() => rowOf(container, "ui.font")?.[1]?.startsWith("Comic Sans") === true);

    expect({
      entries,
      menu: document.querySelector('[role="menu"]') !== null,
      starting,
    }).toStrictEqual({
      entries: [
        "* system",
        "jetbrains-mono",
        "ibm-plex-mono",
        "source-code-pro",
        "commit-mono",
        "atkinson-hyperlegible-mono",
        "system-sans",
        "ibm-plex-sans",
        "atkinson-hyperlegible-next",
        "source-sans-3",
        "inter",
        "custom…",
      ],
      menu: false,
      starting: "system",
    });
  });

  it("lets Custom… go when another row is acted on before its editor opens", async () => {
    const fake = signedIn();
    const { container, registry } = await uiShown(fake);
    const menu = await menuFor(container, "ui.font");

    const custom = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])].at(
      -1
    );

    if (custom === undefined) {
      throw new Error("no Custom…");
    }

    await doing(() => {
      custom.focus();
    });

    const other = rowElement(container, "ui.conversation.timeFormat");

    // Custom…, and then, within the same frame, Enter on another row.
    await doing(() => {
      enterOn(custom);
      other.focus();
      enterOn(other);
      other.dispatchEvent(
        new KeyboardEvent("keyup", { bubbles: true, code: "Enter", key: "Enter" })
      );
    });

    // A frame asked for now runs after any Custom… asked for before it.
    let framed = false;

    requestAnimationFrame(() => {
      framed = true;
    });
    await settled(() => framed);

    expect({
      editing: registry.get(optionsState).editing,
      field: container.querySelector('input[aria-label="Value of ui.font"]') !== null,
    }).toStrictEqual({ editing: "ui.conversation.timeFormat", field: false });
  });

  it("opens a value that is none of the choices as Custom…", async () => {
    const fake = signedIn();
    const { container, type } = await uiShown(fake);

    await type("/set ui.conversation.maxWidth 120");
    await settled(() => rowOf(container, "ui.conversation.maxWidth")?.[1] === "120");

    expect(entriesOf(await menuFor(container, "ui.conversation.maxWidth"))).toStrictEqual([
      "none",
      "* custom…",
    ]);
  });
});

/**
 * The option whose row has the focus.
 * @returns Its name, or none.
 */
const focused = () =>
  document.activeElement instanceof HTMLElement ? document.activeElement.dataset.key : undefined;

describe("the options under headings", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("heads ui, each Network, and each of the Daemon's roots in the order of their names, and drops a heading the filter empties", async () => {
    const shown = await uiShown(signedIn());

    await shown.type("/set");
    await settled(() => rowOf(shown.container, "network.libera.nicks") !== undefined);
    const all = headingsOf(shown.container);

    await shown.type("/set *maxTotal");
    await settled(() => rowOf(shown.container, "ui.conversation.timeFormat") === undefined);

    expect({ all, filtered: headingsOf(shown.container) }).toStrictEqual({
      all: ["away", "network.libera", "previews", "storage", "ui", "uploads"],
      filtered: ["previews", "uploads"],
    });
  });

  it("moves by arrows from option to option across a heading, edits on Enter, and asks on Delete", async () => {
    const shown = await uiShown(signedIn());

    await shown.type("/set");
    await settled(() => rowOf(shown.container, "network.libera.nicks") !== undefined);
    await readAt(shown.registry, 0);

    await doing(() => {
      rowElement(shown.container, "ui.unread.quietBots").focus();
    });
    await press(rowElement(shown.container, "ui.unread.quietBots"), "ArrowDown");
    const down = focused();

    await press(document.activeElement ?? document.body, "ArrowUp");
    const up = focused();

    await doing(() => {
      rowElement(shown.container, "network.libera.whoOnJoin").focus();
    });
    await press(rowElement(shown.container, "network.libera.whoOnJoin"), "ArrowDown");
    const intoPreviews = focused();

    await enter(document.activeElement ?? document.body);
    await settled(
      () => shown.container.querySelector('input[aria-label="Value of previews.maxTotal"]') !== null
    );
    await press(document.activeElement ?? document.body, "Escape");
    await settled(() => focused() === "previews.maxTotal");
    await press(rowElement(shown.container, "previews.maxTotal"), "Delete");

    expect({
      asked: shown.container.querySelector('[role="alertdialog"] p')?.textContent,
      down,
      intoPreviews,
      up,
    }).toStrictEqual({
      asked: "Unset previews.maxTotal, back to 1000000000?",
      down: "uploads.expireAfter",
      intoPreviews: "previews.maxTotal",
      up: "ui.unread.quietBots",
    });
  });

  it("gives an option two lines, and says beside a value this device overrides the one every device shares", async () => {
    const shown = await uiShown(signedIn());

    await shown.type("/set -device ui.conversation.timeFormat HH:mm:ss");
    await settled(
      () =>
        rowOf(shown.container, "ui.conversation.timeFormat")?.[1]?.startsWith("HH:mm:ss") === true
    );

    expect(linesOf(shown.container, "ui.conversation.timeFormat")).toStrictEqual([
      "ui.conversation.timeFormatHH:mm:ss on this device, over HH:mm",
      expect.stringMatching(/^How .*default: HH:mm$/u),
    ]);
  });

  it("shows the aliases another device made as ui.aliases, by their names", async () => {
    const fake = signedIn();

    fake.daemon.ui = {
      options: {
        ...fake.daemon.ui.options,
        aliases: [
          { line: "/join #$1", name: "j" },
          { line: "/whois $1", name: "w" },
        ],
      },
      sequence: 4,
    };

    const shown = await page(fake);

    shown.registry.mount(uiSync);
    await shown.type("/set ui.aliases");
    await settled(() => rowOf(shown.container, "ui.aliases")?.[1] === "j, w");

    expect(rowOf(shown.container, "ui.aliases")?.slice(0, 3)).toStrictEqual([
      "ui.aliases",
      "j, w",
      "default: empty",
    ]);
  });
});
