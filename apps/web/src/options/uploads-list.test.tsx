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
 * @returns The registry and the page.
 */
const page = async (fake: ReturnType<typeof fakeDaemon>) => {
  const registry = registryFor(fake.fetch);

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
  [...container.querySelectorAll<HTMLButtonElement>('ul[aria-label="Uploads"] button')].map(
    (button) => button.getAttribute("aria-label")
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
      options: { "uploads.maxSize": 104_857_600, "uploads.publicUrl": "https://files.example.com" },
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
    await settled(() => moreButton(container) !== undefined);
    await doing(() => {
      moreButton(container)?.click();
    });
    await settled(() => listed(container).length >= 4 && moreButton(container) === undefined);

    expect(names(container)).toStrictEqual([
      "e-safe.png",
      "d-safe.png",
      "c-safe.png",
      "Cat picture.png",
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
