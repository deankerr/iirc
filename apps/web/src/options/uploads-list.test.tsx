// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import type { Upload } from "@iirc/api";
import { deviceUiKey } from "@iirc/frontend/ui";
import { initialUploads } from "@iirc/frontend/uploads";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { writeChoice } from "../page/device.ts";
import { check, signOut } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run } from "../testing/fake-daemon.ts";
import { optionsState, optionsSync } from "./atoms.ts";
import { ownerSync } from "./owner.ts";
import { publicUrl, uploadsState, uploadsSync } from "./uploads.ts";

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
 * An Upload as the wire carries it, by a letter that makes its id.
 * @param letter - The letter.
 * @param type - Its type.
 * @param name - The name it was given, if any.
 * @returns The Upload.
 */
const uploadOf = (letter: string, type: string, name?: string): typeof Upload.Encoded => {
  const given = {
    at: 1_700_000_000_000,
    hash: "0".repeat(64),
    id: letter.repeat(16),
    // Never what is copied: a link is made from the public URL in force.
    link: "https://stale.example.com/never-used",
    safeName: `${letter}-safe.${type === "image/png" ? "png" : "bin"}`,
    size: 1_258_291,
    type,
  };

  return name === undefined ? given : { ...given, name };
};

/**
 * A page signed in to the fake, showing the options, following them and the Uploads, and
 * rendered.
 * @param fake - The fake Daemon.
 * @param waits - Waits other than the tests' defaults.
 * @returns The registry and the page.
 */
const page = async (
  fake: ReturnType<typeof fakeDaemon>,
  waits: Parameters<typeof registryFor>[1] = {}
) => {
  const registry = registryFor(fake.fetch, waits);

  await run(registry, check, undefined);
  registry.mount(optionsSync);
  registry.mount(ownerSync);
  registry.mount(uploadsSync);

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

  const composer = container.querySelector("textarea");

  if (composer === null) {
    throw new Error("no composer");
  }

  // `/set uploads` shows the options.
  await doing(() => {
    Reflect.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      composer,
      "/set uploads"
    );
    composer.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await doing(() => {
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: "Enter", key: "Enter" })
    );
  });

  return { container, registry };
};

/**
 * A fake Daemon that the browser is signed in to, holding Uploads, newest first.
 * @param uploads - The Uploads.
 * @returns The fake.
 */
const signedIn = (...uploads: readonly (typeof Upload.Encoded)[]) => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  fake.daemon.uploads.push(...uploads);
  writeChoice(deviceUiKey, undefined);

  return fake;
};

/**
 * The Uploads listed, each as its thumbnail's source or icon, name, and details.
 * @param container - The page.
 * @returns The rows.
 */
const listed = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('ul[aria-label="Uploads"] > li')].map((row) => {
    const [thumbnail, about] = row.children;

    return {
      details: about?.lastElementChild?.textContent,
      name: about?.firstElementChild?.textContent,
      thumbnail: thumbnail?.querySelector("img")?.getAttribute("src") ?? "icon",
    };
  });

/**
 * The names of the Uploads listed, in order.
 * @param container - The page.
 * @returns The names.
 */
const names = (container: HTMLElement) => listed(container).map((row) => row.name);

/**
 * The copy buttons, by their names.
 * @param container - The page.
 * @returns The buttons.
 */
const copyButtons = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>('ul[aria-label="Uploads"] button')].flatMap(
    (button) => {
      const label = button.getAttribute("aria-label");

      return label?.startsWith("Copy the link") === true ? [label] : [];
    }
  );

/**
 * What the list says of the link last copied.
 * @param container - The page.
 * @returns What it says.
 */
const status = (container: HTMLElement) =>
  container.querySelector('ul[aria-label="Uploads"] output')?.textContent;

/**
 * Presses an Upload's copy button and reads what the clipboard then holds.
 * @param container - The page.
 * @param name - The Upload's name.
 * @returns What the clipboard holds.
 */
const copy = async (container: HTMLElement, name: string) => {
  await doing(() => {
    container
      .querySelector<HTMLButtonElement>(`button[aria-label="Copy the link to ${name}"]`)
      ?.click();
  });
  await settled(() => status(container) === "copied");

  return await navigator.clipboard.readText();
};

/**
 * The button that reads the next page, while there is one.
 * @param container - The page.
 * @returns It, or none.
 */
const moreButton = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>('section[aria-label="Uploads"] button')].find(
    (button) => button.textContent === "More"
  );

/**
 * Presses a button in the page by its accessible name.
 * @param container - The page, or the document for a dialog.
 * @param label - The name.
 */
const press = async (container: ParentNode, label: string) => {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  if (found === null) {
    throw new Error(`no button ${label}`);
  }

  await doing(() => {
    found.click();
  });
};

/**
 * The dialog asking before a delete, while it is open, with its heading, body, and buttons.
 * @returns It, or none.
 */
const deleteDialog = () => {
  const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');

  return dialog === null
    ? undefined
    : {
        body: dialog.querySelector("p")?.textContent,
        button: (text: string) =>
          [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
            (one) => one.textContent === text
          ),
        heading: dialog.querySelector("h2, h3, [slot='title']")?.textContent,
      };
};

/**
 * Renames an Upload from its row: opens the field, types the name, and presses a key in it.
 * @param container - The page.
 * @param name - The Upload's name.
 * @param to - The name typed.
 * @param key - The key pressed: Enter saves, Escape cancels.
 */
const renameIn = async (
  container: HTMLElement,
  name: string,
  to: string,
  key: "Enter" | "Escape"
) => {
  await press(container, `Rename ${name}`);

  const field = container.querySelector<HTMLInputElement>(
    `input[aria-label="New name for ${name}"]`
  );

  if (field === null) {
    throw new Error("no field");
  }

  await doing(() => {
    Reflect.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, to);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await doing(() => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key });

    if (field.dispatchEvent(event) && key === "Enter") {
      field.form?.requestSubmit();
    }
  });
};

/**
 * What a row says of a rename or a delete that failed.
 * @param container - The page.
 * @returns Each, in words.
 */
const rowAlerts = (container: HTMLElement) =>
  [...container.querySelectorAll('ul[aria-label="Uploads"] [role="alert"]')].map(
    (one) => one.textContent
  );

/**
 * The switch that shows the deleted Uploads too.
 * @param container - The page.
 * @returns It, or none.
 */
const deletedSwitch = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>('section[aria-label="Uploads"] button')].find(
    (button) => button.textContent === "Show deleted"
  );

/**
 * Presses the switch that shows the deleted Uploads too.
 * @param container - The page.
 */
const toggleDeleted = async (container: HTMLElement) => {
  await doing(() => {
    deletedSwitch(container)?.click();
  });
};

/**
 * What each row offers: the labels of its buttons.
 * @param container - The page.
 * @returns The labels, by row.
 */
const offered = (container: HTMLElement) =>
  [...container.querySelectorAll('ul[aria-label="Uploads"] > li')].map((row) =>
    [...row.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))
  );

/**
 * Sets a public URL, so every live row offers its link.
 * @param fake - The fake Daemon.
 */
const withPublicUrl = (fake: ReturnType<typeof fakeDaemon>) => {
  fake.daemon.owner = {
    options: {
      "previews.maxTotal": 1_073_741_824,
      "uploads.maxSize": 104_857_600,
      "uploads.publicUrl": "https://files.example.com",
    },
    sequence: 1,
  };
};

const cat = uploadOf("a", "image/png", "Cat picture.png");
const notes = uploadOf("b", "application/pdf");

describe("the Uploads beside the options", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("lists each newest first, an image as a thumbnail of its bytes and any other type as an icon", async () => {
    const fake = signedIn(notes, cat);
    const { container } = await page(fake);

    await settled(() => listed(container).length === 2);

    expect(
      listed(container).map((row) => ({ ...row, details: row.details?.split(" · ").slice(0, 2) }))
    ).toStrictEqual([
      { details: ["application/pdf", "1.2 MiB"], name: "b-safe.bin", thumbnail: "icon" },
      {
        details: ["image/png", "1.2 MiB"],
        name: "Cat picture.png",
        thumbnail: "/api/uploads/aaaaaaaaaaaaaaaa/content",
      },
    ]);
  });

  it("shows another device's Upload first, without reloading", async () => {
    const fake = signedIn(cat);
    const { container } = await page(fake);

    await settled(() => listed(container).length === 1);
    await eventually(() => fake.daemon.uploadFollowers.length === 1);
    await doing(() => {
      fake.upload(notes);
    });
    await settled(() => listed(container).length === 2);

    expect(names(container)).toStrictEqual(["b-safe.bin", "Cat picture.png"]);
  });

  it("copies a link made from the public URL in force, and follows a change of it", async () => {
    const fake = signedIn(cat);

    fake.daemon.owner = {
      options: {
        "previews.maxTotal": 1_073_741_824,
        "uploads.maxSize": 104_857_600,
        "uploads.publicUrl": "https://files.example.com",
      },
      sequence: 1,
    };

    const { container, registry } = await page(fake);

    await settled(() => copyButtons(container).length === 1);

    const first = await copy(container, "Cat picture.png");
    const confirmed = status(container);

    // Another device sets a new public URL, which the options follow.
    await eventually(() => fake.daemon.ownerFollowers.length === 1);
    await act(async () => {
      await fake.fetch(new URL("http://daemon.test/api/options/uploads.publicUrl"), {
        body: JSON.stringify({ value: "https://cdn.example.org/u" }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
    });
    await settled(() => registry.get(publicUrl) === "https://cdn.example.org/u");

    const stale = status(container);
    const second = await copy(container, "Cat picture.png");

    expect({ confirmed, first, second, stale }).toStrictEqual({
      confirmed: "copied",
      first: "https://files.example.com/aaaaaaaaaaaaaaaa/a-safe.png",
      second: "https://cdn.example.org/u/aaaaaaaaaaaaaaaa/a-safe.png",
      // What was copied before is no longer this Upload's link.
      stale: "",
    });
  });

  it("offers no link to copy while no public URL is set, and says so", async () => {
    const fake = signedIn(cat);
    const { container, registry } = await page(fake);

    // The options under uploads are read, with no public URL among them.
    await settled(
      () => listed(container).length === 1 && registry.get(optionsState).owner !== undefined
    );

    expect({
      buttons: copyButtons(container),
      said: container.querySelector('section[aria-label="Uploads"] p')?.textContent,
    }).toStrictEqual({
      buttons: [],
      said: "No link to copy until uploads.publicUrl is set.",
    });
  });

  it("reads the next page on More, holding nothing twice", async () => {
    const fake = signedIn(
      uploadOf("e", "image/png"),
      uploadOf("d", "image/png"),
      uploadOf("c", "image/png"),
      notes,
      cat
    );

    fake.daemon.uploadsPage = 2;

    const { container } = await page(fake);

    await settled(() => listed(container).length === 2);
    await eventually(() => fake.daemon.uploadFollowers.length === 1);
    // Another device's Upload lands in the stream, and so on the first page too.
    await doing(() => {
      fake.upload(uploadOf("f", "image/png"));
    });
    await settled(() => listed(container).length === 3);

    const more = () => moreButton(container);

    await doing(() => {
      more()?.click();
    });
    await settled(() => listed(container).length === 5);
    await doing(() => {
      more()?.click();
    });
    await settled(() => listed(container).length === 6);

    expect({
      more: more(),
      names: names(container),
      read: fake.daemon.uploadPagesRead,
    }).toStrictEqual({
      more: undefined,
      names: [
        "f-safe.png",
        "e-safe.png",
        "d-safe.png",
        "c-safe.png",
        "b-safe.bin",
        "Cat picture.png",
      ],
      read: [undefined, "d".repeat(16), "b".repeat(16)],
    });
  });

  it("keeps every Upload, newest first and none twice, when more than a page were made while the stream was down", async () => {
    const fake = signedIn(cat);

    fake.daemon.uploadsPage = 2;

    const { container } = await page(fake);

    // The list is whole: one Upload, and no page after it.
    await settled(() => listed(container).length === 1);
    await eventually(() => fake.daemon.uploadFollowers.length === 1);

    // The stream drops, and three Uploads are made before it is followed again.
    await doing(() => {
      for (const follower of fake.daemon.uploadFollowers.splice(0)) {
        follower.controller.close();
      }

      fake.upload(uploadOf("c", "image/png"));
      fake.upload(uploadOf("d", "image/png"));
      fake.upload(uploadOf("e", "image/png"));
    });
    await settled(() => listed(container).length >= 4);

    expect({
      more: moreButton(container),
      names: names(container),
      read: fake.daemon.uploadPagesRead,
    }).toStrictEqual({
      more: undefined,
      names: ["e-safe.png", "d-safe.png", "c-safe.png", "Cat picture.png"],
      read: [undefined],
    });
  });

  it("lists the Uploads made while the first page was being read in order, none twice", async () => {
    const fake = signedIn(cat);

    fake.daemon.uploadsPage = 2;
    fake.daemon.holdUploadPages = true;

    const { container } = await page(fake);

    await eventually(() => fake.daemon.uploadPagesHeld.length === 1);
    await doing(() => {
      fake.upload(uploadOf("c", "image/png"));
      fake.upload(uploadOf("d", "image/png"));
      fake.upload(uploadOf("e", "image/png"));
      fake.daemon.holdUploadPages = false;

      for (const release of fake.daemon.uploadPagesHeld.splice(0)) {
        release();
      }
    });
    await settled(() => listed(container).length >= 4);

    // The page was taken before they were made, so only the stream, followed from how far
    // that page was read, can have brought them.
    expect(names(container)).toStrictEqual([
      "e-safe.png",
      "d-safe.png",
      "c-safe.png",
      "Cat picture.png",
    ]);
    expect(moreButton(container)).toBeUndefined();
    expect(fake.daemon.uploadPagesRead).toStrictEqual([undefined]);
  });

  it("gives up a first page that stalls, and reads it again", async () => {
    const fake = signedIn(cat);

    fake.daemon.holdUploadPages = true;

    const { container } = await page(fake, { idle: "100 millis" });

    await eventually(() => fake.daemon.uploadPagesRead.length >= 2);
    await doing(() => {
      fake.daemon.holdUploadPages = false;

      for (const release of fake.daemon.uploadPagesHeld.splice(0)) {
        release();
      }
    });
    await settled(() => listed(container).length === 1);

    expect(names(container)).toStrictEqual(["Cat picture.png"]);
  });

  it("renames an Upload from its row, Enter saving and Escape keeping the name", async () => {
    const fake = signedIn(notes, cat);
    const { container } = await page(fake);

    await settled(() => listed(container).length === 2);
    await renameIn(container, "Cat picture.png", "Not this.png", "Escape");

    const kept = { edits: [...fake.daemon.uploadEdits], names: names(container) };

    await renameIn(container, "Cat picture.png", "Tabby.png", "Enter");
    await settled(() => names(container).includes("Tabby.png"));

    expect({
      edits: fake.daemon.uploadEdits,
      field: container.querySelector('ul[aria-label="Uploads"] input'),
      kept,
      names: names(container),
    }).toStrictEqual({
      edits: [{ id: "a".repeat(16), method: "PATCH", name: "Tabby.png" }],
      field: null,
      kept: { edits: [], names: ["b-safe.bin", "Cat picture.png"] },
      names: ["b-safe.bin", "Tabby.png"],
    });
  });

  it("says in the row why a rename failed, calmly", async () => {
    const fake = signedIn(cat);

    fake.daemon.uploadEditRefusals.push({
      body: { _tag: "JournalFailed", reason: "the disk is full" },
      status: 500,
    });

    const { container } = await page(fake);

    await settled(() => listed(container).length === 1);
    await renameIn(container, "Cat picture.png", "Tabby.png", "Enter");
    await settled(() => rowAlerts(container).length === 1);

    expect({ alerts: rowAlerts(container), names: names(container) }).toStrictEqual({
      alerts: ["The Daemon could not write its Journal, so Cat picture.png was not renamed."],
      names: ["Cat picture.png"],
    });
  });

  it("asks before deleting, saying what it promises, and deletes nothing on Cancel", async () => {
    const fake = signedIn(notes, cat);
    const { container } = await page(fake);

    await settled(() => listed(container).length === 2);
    await press(container, "Delete Cat picture.png");

    const asked = deleteDialog();

    await doing(() => {
      asked?.button("Cancel")?.click();
    });

    expect({
      asked: { body: asked?.body, heading: asked?.heading },
      closed: deleteDialog(),
      edits: fake.daemon.uploadEdits,
      names: names(container),
    }).toStrictEqual({
      asked: {
        body: "Its link stops working at once, wherever it was said. A copy someone already opened or saved cannot be called back.",
        heading: "Delete Cat picture.png?",
      },
      closed: undefined,
      edits: [],
      names: ["b-safe.bin", "Cat picture.png"],
    });
  });

  it("deletes once confirmed, and the Upload leaves the list", async () => {
    const fake = signedIn(notes, cat);
    const { container } = await page(fake);

    await settled(() => listed(container).length === 2);
    await press(container, "Delete Cat picture.png");
    await doing(() => {
      deleteDialog()?.button("Delete")?.click();
    });
    await settled(() => listed(container).length === 1);

    expect({
      dialog: deleteDialog(),
      edits: fake.daemon.uploadEdits,
      names: names(container),
    }).toStrictEqual({
      dialog: undefined,
      edits: [{ id: "a".repeat(16), method: "DELETE" }],
      names: ["b-safe.bin"],
    });
  });

  it("drops an Upload another device deleted", async () => {
    const fake = signedIn(notes, cat);
    const { container } = await page(fake);

    await settled(() => listed(container).length === 2);
    await eventually(() => fake.daemon.uploadFollowers.length === 1);
    await act(async () => {
      await fake.fetch(new URL(`http://daemon.test/api/uploads/${"b".repeat(16)}`), {
        method: "DELETE",
      });
    });
    await settled(() => listed(container).length === 1);

    expect(names(container)).toStrictEqual(["Cat picture.png"]);
  });

  it("says in the row that an Upload the Daemon no longer has was not deleted", async () => {
    const fake = signedIn(cat);

    fake.daemon.uploadEditRefusals.push({
      body: { _tag: "UnknownUpload", id: "a".repeat(16) },
      status: 404,
    });

    const { container } = await page(fake);

    await settled(() => listed(container).length === 1);
    await press(container, "Delete Cat picture.png");
    await doing(() => {
      deleteDialog()?.button("Delete")?.click();
    });
    await settled(() => rowAlerts(container).length === 1);

    expect(rowAlerts(container)).toStrictEqual([
      "The Daemon no longer has Cat picture.png, so it was not deleted.",
    ]);
  });

  it("hides an expired Upload, and shows it marked expired, with nothing to do to it, once the deleted are asked for", async () => {
    const fake = signedIn(notes, {
      ...uploadOf("c", "image/png", "Old picture.png"),
      deleted: { at: 1_700_000_002_000, why: "expired" },
      link: null,
    });

    withPublicUrl(fake);

    const { container } = await page(fake);

    await settled(() => listed(container).length === 1);

    const hidden = names(container);

    await toggleDeleted(container);
    await settled(() => listed(container).length === 2);

    expect({
      hidden,
      offered: offered(container),
      pressed: deletedSwitch(container)?.getAttribute("aria-pressed"),
      rows: listed(container).map((row) => ({
        expired: row.details?.includes(" · expired ") === true,
        name: row.name,
        thumbnail: row.thumbnail,
      })),
    }).toStrictEqual({
      hidden: ["b-safe.bin"],
      offered: [["Copy the link to b-safe.bin", "Rename b-safe.bin", "Delete b-safe.bin"], []],
      pressed: "true",
      rows: [
        { expired: false, name: "b-safe.bin", thumbnail: "icon" },
        // Its bytes are gone, so the thumbnail does not ask for them.
        { expired: true, name: "Old picture.png", thumbnail: "icon" },
      ],
    });
  });

  it("says deleted, not expired, of an Upload the Owner deleted, and reads again without them when switched off", async () => {
    const fake = signedIn(notes, {
      ...cat,
      deleted: { at: 1_700_000_001_000, why: "owner" },
      link: null,
    });

    const { container } = await page(fake);

    await settled(() => listed(container).length === 1);
    await toggleDeleted(container);
    await settled(() => listed(container).length === 2);

    const shown = listed(container).at(1)?.details?.includes(" · deleted ");

    await toggleDeleted(container);
    await settled(() => listed(container).length === 1);

    expect({ names: names(container), read: fake.daemon.uploadPagesRead, shown }).toStrictEqual({
      names: ["b-safe.bin"],
      read: [undefined, undefined, undefined],
      shown: true,
    });
  });

  it("turns an Upload that expires while the deleted are shown into an expired row in place", async () => {
    const fake = signedIn(notes, cat);
    const { container } = await page(fake);

    await settled(() => listed(container).length === 2);
    await toggleDeleted(container);
    await eventually(() => fake.daemon.uploadPagesRead.length === 2);
    await eventually(() => fake.daemon.uploadFollowers.length >= 1);
    await doing(() => {
      fake.expire("a".repeat(16));
    });
    await settled(() => listed(container).at(1)?.details?.includes(" · expired ") === true);

    expect({
      names: names(container),
      offered: offered(container),
      thumbnails: listed(container).map((row) => row.thumbnail),
    }).toStrictEqual({
      names: ["b-safe.bin", "Cat picture.png"],
      offered: [["Rename b-safe.bin", "Delete b-safe.bin"], []],
      thumbnails: ["icon", "icon"],
    });
  });

  it("closes a rename field and a delete question on an Upload that expires while the deleted are shown", async () => {
    const fake = signedIn(notes, cat);
    const { container } = await page(fake);
    const cats = "a".repeat(16);
    const field = () => container.querySelector('input[aria-label="New name for b-safe.bin"]');

    await settled(() => listed(container).length === 2);
    await toggleDeleted(container);
    await eventually(() => fake.daemon.uploadPagesRead.length === 2);
    await eventually(() => fake.daemon.uploadFollowers.length >= 1);
    await press(container, "Rename b-safe.bin");
    const renaming = field() !== null;

    await press(container, "Delete Cat picture.png");
    const asking = deleteDialog() !== undefined;

    await doing(() => {
      fake.expire(cats);
      fake.expire("b".repeat(16));
    });
    await settled(() =>
      listed(container).every((row) => row.details?.includes(" · expired ") === true)
    );

    expect({ asked: deleteDialog(), asking, field: field(), renaming }).toStrictEqual({
      asked: undefined,
      asking: true,
      field: null,
      renaming: true,
    });
  });

  it("marks an Upload whose bytes are missing, with no thumbnail fetched and no link to copy, and clears it when a later event leaves it out", async () => {
    const fake = signedIn(cat, notes);

    withPublicUrl(fake);
    fake.daemon.uploadsMissing.push(cat.id);
    const { container } = await page(fake);

    await settled(() => listed(container).length === 2);
    await settled(() => listed(container).at(0)?.details?.endsWith("missing") === true);

    const marked = {
      copy: copyButtons(container),
      details: listed(container).map((row) => row.details?.endsWith("missing")),
      offered: offered(container),
      thumbnails: listed(container).map((row) => row.thumbnail),
    };

    await eventually(() => fake.daemon.uploadFollowers.length >= 1);
    await doing(() => {
      fake.lose();
    });
    await settled(() => listed(container).at(0)?.details?.endsWith("missing") === false);

    expect({
      copyAfter: copyButtons(container),
      marked,
      thumbnails: listed(container).map((row) => row.thumbnail),
    }).toStrictEqual({
      copyAfter: ["Copy the link to Cat picture.png", "Copy the link to b-safe.bin"],
      marked: {
        copy: ["Copy the link to b-safe.bin"],
        details: [true, false],
        offered: [
          ["Rename Cat picture.png", "Delete Cat picture.png"],
          ["Copy the link to b-safe.bin", "Rename b-safe.bin", "Delete b-safe.bin"],
        ],
        thumbnails: ["icon", "icon"],
      },
      thumbnails: [`/api/uploads/${cat.id}/content`, "icon"],
    });
  });

  it("marks an Upload the stream says is missing after the list was read", async () => {
    const fake = signedIn(cat, notes);
    const { container } = await page(fake);

    await settled(() => listed(container).length === 2);
    await eventually(() => fake.daemon.uploadFollowers.length >= 1);
    await doing(() => {
      fake.lose(notes.id);
    });
    await settled(() => listed(container).at(1)?.details?.includes("missing") === true);

    expect(listed(container).map((row) => row.details?.includes("missing"))).toStrictEqual([
      false,
      true,
    ]);
  });

  it("does not show a deleted Upload as missing", async () => {
    const fake = signedIn(cat, notes);
    const { container } = await page(fake);

    await settled(() => listed(container).length === 2);
    await toggleDeleted(container);
    await eventually(() => fake.daemon.uploadPagesRead.length === 2);
    await eventually(() => fake.daemon.uploadFollowers.length >= 1);
    await doing(() => {
      fake.lose(cat.id);
    });
    await settled(() => listed(container).at(0)?.details?.includes("missing") === true);
    await doing(() => {
      fake.expire(cat.id);
    });
    await settled(() => listed(container).at(0)?.details?.includes("expired") === true);

    expect(listed(container).map((row) => row.details?.includes("missing"))).toStrictEqual([
      false,
      false,
    ]);
  });

  it("forgets the Uploads on signing out", async () => {
    const fake = signedIn(cat, notes);
    const { container, registry } = await page(fake);

    await settled(() => listed(container).length === 2);
    await act(async () => {
      await run(registry, signOut, undefined);
    });

    expect({ held: registry.get(uploadsState), listed: listed(container) }).toStrictEqual({
      held: initialUploads,
      listed: [],
    });
  });
});
