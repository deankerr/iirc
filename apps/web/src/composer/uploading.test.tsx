// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { TimelineId } from "@iirc/api";
import type { Timeline } from "@iirc/api";
import { Schema } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { mainView } from "../options/atoms.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run } from "../testing/fake-daemon.ts";
import { testUploader } from "../testing/uploader.ts";
import { open, sync } from "../timelines/atoms.ts";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: (() => void)[] = [];

const own = "00000000000001-00000000-00000000";
const iirc = "00000000000002-00000000-00000000";

const publicUrl = "https://f.test";

const listed = (
  id: string,
  name: string,
  kind: "Network" | "Channel"
): typeof Timeline.Encoded => ({
  changed: 1,
  closed: false,
  detached: false,
  head: null,
  id,
  key: kind === "Network" ? null : name,
  kind,
  latest: null,
  life: 1,
  name,
  network: "libera",
  read: null,
  removed: false,
  unread: { activity: 0, direct: 0, highlights: 0, messages: 0 },
});

const settled = async (holds: () => boolean) => {
  await act(async () => {
    await eventually(holds);
  });
};

/**
 * A browser signed in to a Daemon with Uploads on and a public URL set, `#iirc` open, and
 * the page drawn, sending files through a test's Uploader.
 * @returns The fake, its Uploader, the registry, and the page.
 */
const signedIn = async () => {
  const fake = fakeDaemon();
  const uploader = testUploader(fake.fetch);

  fake.daemon.signedIn = true;
  fake.daemon.owner = {
    ...fake.daemon.owner,
    options: { ...fake.daemon.owner.options, "uploads.publicUrl": publicUrl },
  };
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: listed(own, "libera", "Network") },
    { gaps: [], items: [], timeline: listed(iirc, "#iirc", "Channel") },
  ]);

  const registry = registryFor(fake.fetch, {}, undefined, undefined, uploader.port);

  await run(registry, check, undefined);
  registry.mount(sync);

  const container = document.createElement("div");

  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <App />
      </RegistryContext.Provider>
    );
    await Promise.resolve();
  });

  mounted.push(() => {
    root.unmount();
    container.remove();
  });

  await settled(() => fake.daemon.followers.length === 1);

  await act(async () => {
    registry.set(open, Schema.decodeSync(TimelineId)(iirc));
    await Promise.resolve();
  });
  await settled(() => container.querySelector('[role="log"]') !== null);

  return { ...fake, container, registry, uploader: uploader.held };
};

const composerOf = (container: HTMLElement) => {
  const composer = container.querySelector("textarea");

  if (composer === null) {
    throw new Error("no composer");
  }

  return composer;
};

/**
 * Types text into the composer, as the browser does, the caret where given or at its end.
 * @param container - The page.
 * @param text - The text.
 * @param caret - Where the caret is after.
 */
const typeIn = async (container: HTMLElement, text: string, caret = text.length) => {
  const composer = composerOf(container);

  await act(async () => {
    Reflect.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      composer,
      text
    );
    composer.setSelectionRange(caret, caret);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

const image = (name: string, size = 8) =>
  new File([new Uint8Array(size)], name, { type: "image/png" });

/** What a paste or a drag carries, as much of a `DataTransfer` as the composer reads. */
interface Carried {
  readonly files: readonly File[];
  readonly types: readonly string[];
  readonly getData?: () => string;
}

/**
 * An event carrying what the browser gives with it: a paste's `clipboardData`, or a drag's
 * `dataTransfer`.
 * @param type - The event's type.
 * @param field - Where the event carries it.
 * @param carried - What it carries.
 * @returns The event.
 */
const carrying = (type: string, field: "clipboardData" | "dataTransfer", carried: Carried) => {
  const event = new Event(type, { bubbles: true, cancelable: true });

  Object.defineProperty(event, field, { value: carried });

  return event;
};

/**
 * Pastes into the composer, as the browser does, files or text.
 * @param container - The page.
 * @param files - The files pasted.
 * @returns Whether the paste was left to the browser.
 */
const paste = async (container: HTMLElement, ...files: readonly File[]) => {
  let left = true;

  await act(async () => {
    left = composerOf(container).dispatchEvent(
      carrying("paste", "clipboardData", {
        files,
        getData: () => "text",
        types: files.length > 0 ? ["Files"] : ["text/plain"],
      })
    );
    await Promise.resolve();
  });

  return left;
};

const button = (container: HTMLElement, label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

const press = async (found: HTMLElement | null) => {
  if (found === null) {
    throw new Error("no such control");
  }

  await act(async () => {
    found.click();
    await Promise.resolve();
  });
};

const alerts = (container: HTMLElement) =>
  [...container.querySelectorAll('ul[aria-label="Uploads"] [role="alert"]')].map(
    (one) => one.textContent
  );

const linkOf = (id: number, name: string) => `${publicUrl}/${String(id).padStart(16, "0")}/${name}`;

describe("uploading from the Composer", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("puts a pasted image's link into the draft where the caret was", async () => {
    const { container, daemon } = await signedIn();

    await typeIn(container, "look  please", 5);

    const left = await paste(container, image("cat.png"));

    await settled(() => composerOf(container).value !== "look  please");

    expect({
      left,
      sent: daemon.uploadsSent,
      value: composerOf(container).value,
    }).toStrictEqual({
      left: false,
      sent: [{ name: "cat.png", size: 8 }],
      value: `look ${linkOf(10, "cat.png")} please`,
    });
  });

  it("leaves a paste of text alone, to the textarea", async () => {
    const { container, daemon } = await signedIn();

    const left = await paste(container);

    expect({ left, statuses: daemon.statusesRead }).toStrictEqual({ left: true, statuses: 0 });
  });

  it("lands several files in the order added, whatever order they finish in", async () => {
    const { container, uploader } = await signedIn();

    uploader.hold = true;
    await paste(container, image("a.png"), image("b.png"), image("c.png"));
    await settled(() => uploader.sending.length === 3);

    for (const one of uploader.sending.toReversed()) {
      one.release();
      // oxlint-disable-next-line no-await-in-loop -- each finishes before the next is let go
      await settled(() => composerOf(container).value.includes(one.url.slice(-5)));
    }

    // The fake numbers each Upload as it keeps it, so c is kept first.
    expect(composerOf(container).value).toBe(
      `${linkOf(12, "a.png")} ${linkOf(11, "b.png")} ${linkOf(10, "c.png")}`
    );
  });

  it("keeps the link where the caret was while the Owner types during the upload", async () => {
    const { container, uploader } = await signedIn();

    uploader.hold = true;
    await typeIn(container, "hi");
    await paste(container, image("cat.png"));
    await settled(() => uploader.sending.length === 1);
    await typeIn(container, "oh hi", 3);
    await typeIn(container, "oh hi there");
    uploader.sending[0]?.release();
    await settled(() => composerOf(container).value.includes(publicUrl));

    expect(composerOf(container).value).toBe(`oh hi ${linkOf(10, "cat.png")} there`);
  });

  it("leaves the caret where it was in the text around the link, while the Owner writes", async () => {
    const { container, uploader } = await signedIn();

    uploader.hold = true;
    composerOf(container).focus();
    await typeIn(container, "hi there");
    await paste(container, image("cat.png"));
    await settled(() => uploader.sending.length === 1);
    composerOf(container).setSelectionRange(1, 1);
    uploader.sending[0]?.release();
    await settled(() => composerOf(container).value.includes(publicUrl));

    expect(composerOf(container).selectionStart).toBe(1);
  });

  it("shows how much was sent, as the browser's upload events say", async () => {
    const { container, uploader } = await signedIn();

    uploader.hold = true;
    await paste(container, image("cat.png", 100));
    await settled(() => uploader.sending.length === 1);

    await act(async () => {
      uploader.sending[0]?.progress(40);
      await Promise.resolve();
    });

    const bar = container.querySelector<HTMLProgressElement>(
      'progress[aria-label="Sending cat.png"]'
    );

    expect({ max: bar?.max, value: bar?.value }).toStrictEqual({ max: 100, value: 40 });
  });

  it("cancels an upload, aborting its request, and puts nothing in", async () => {
    const { container, daemon, uploader } = await signedIn();

    uploader.hold = true;
    await typeIn(container, "hi");
    await paste(container, image("cat.png"));
    await settled(() => uploader.sending.length === 1);
    await press(button(container, "Cancel upload of cat.png"));
    uploader.sending[0]?.release();

    expect({
      aborted: uploader.sending[0]?.aborted,
      kept: daemon.uploads,
      listed: container.querySelector('ul[aria-label="Uploads"]'),
      sent: daemon.uploadsSent,
      value: composerOf(container).value,
    }).toStrictEqual({ aborted: true, kept: [], listed: null, sent: [], value: "hi" });
  });

  it("refuses a file over maxSize before sending it, saying the limit", async () => {
    const { container, daemon, uploader } = await signedIn();

    daemon.uploadsStatus = { _tag: "On", maxSize: 10 };
    await paste(container, image("big.png", 20));
    await settled(() => alerts(container).length === 1);

    expect({
      alerts: alerts(container),
      sending: uploader.sending.length,
      sent: daemon.uploadsSent,
    }).toStrictEqual({
      alerts: ["big.png is 20 B, over the 10 B limit."],
      sending: 0,
      sent: [],
    });
  });

  it("while Uploads are off, puts nothing in and notes it, with a way to the options", async () => {
    const { container, daemon, registry } = await signedIn();

    daemon.uploadsStatus = {
      _tag: "Off",
      maxSize: 100,
      missing: ["store.s3.bucket", "uploads.publicUrl"],
    };
    await typeIn(container, "hi");
    await paste(container, image("cat.png"));

    const noteOf = () =>
      [...container.querySelectorAll("output")]
        .map((one) => one.textContent)
        .find((text) => text.startsWith("Uploads are off"));

    await settled(() => noteOf() !== undefined);

    const note = noteOf();

    await press(
      [...container.querySelectorAll("button")].find(
        (one) => one.textContent === "Open the options"
      ) ?? null
    );

    expect({
      main: registry.get(mainView)._tag,
      note,
      sent: daemon.uploadsSent,
      value: composerOf(container).value,
    }).toStrictEqual({
      main: "Options",
      note: "Uploads are off until store.s3.bucket and uploads.publicUrl are set.",
      sent: [],
      value: "hi",
    });
  });

  it("says a typed error in words, and lets it be dismissed", async () => {
    const { container, daemon } = await signedIn();

    daemon.uploadRefusals.push({
      body: { _tag: "StoreUnavailable", reason: "the bucket did not answer" },
      status: 503,
    });
    await paste(container, image("cat.png"));
    await settled(() => alerts(container).length === 1);

    const said = alerts(container);

    await press(button(container, "Dismiss upload of cat.png"));

    expect({ after: alerts(container), said, value: composerOf(container).value }).toStrictEqual({
      after: [],
      said: ["The store that keeps Uploads could not be reached, so cat.png was not kept."],
      value: "",
    });
  });

  it("adds files from the picker", async () => {
    const { container, daemon } = await signedIn();
    const picker = container.querySelector<HTMLInputElement>('input[aria-label="Files to upload"]');

    await act(async () => {
      if (picker !== null) {
        Object.defineProperty(picker, "files", {
          configurable: true,
          value: [image("a.png"), image("b.png")],
        });
        picker.dispatchEvent(new Event("change", { bubbles: true }));
      }

      await Promise.resolve();
    });
    await settled(() => daemon.uploadsSent.length === 2);
    await settled(() => composerOf(container).value.includes("b.png"));

    expect({ multiple: picker?.multiple, value: composerOf(container).value }).toStrictEqual({
      multiple: true,
      value: `${linkOf(10, "a.png")} ${linkOf(11, "b.png")}`,
    });
  });

  it("offers the camera, for a photo, beside the picker", async () => {
    const { container } = await signedIn();
    const camera = container.querySelector<HTMLInputElement>('input[aria-label="Photo to upload"]');

    expect({
      accept: camera?.accept,
      button: button(container, "Take a photo") === null,
      capture: camera?.getAttribute("capture"),
    }).toStrictEqual({ accept: "image/*", button: false, capture: "environment" });
  });

  it("adds files dropped on the composer, showing that it takes them while dragged over", async () => {
    const { container, daemon } = await signedIn();
    const dataTransfer = { files: [image("cat.png")], types: ["Files"] };

    await act(async () => {
      composerOf(container).dispatchEvent(carrying("dragover", "dataTransfer", dataTransfer));
      await Promise.resolve();
    });

    const dropping = container.querySelector("[data-dropping]") !== null;

    await act(async () => {
      composerOf(container).dispatchEvent(carrying("drop", "dataTransfer", dataTransfer));
      await Promise.resolve();
    });
    await settled(() => composerOf(container).value.includes("cat.png"));

    expect({
      after: container.querySelector("[data-dropping]") !== null,
      dropping,
      sent: daemon.uploadsSent,
    }).toStrictEqual({
      after: false,
      dropping: true,
      sent: [{ name: "cat.png", size: 8 }],
    });
  });
});
