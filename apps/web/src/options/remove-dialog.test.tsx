// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { TimelineId } from "@iirc/api";
import type { Timeline } from "@iirc/api";
import { Schema } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run } from "../testing/fake-daemon.ts";
import { open, sync, timelinesState } from "../timelines/atoms.ts";
import { optionsSync } from "./atoms.ts";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: (() => void)[] = [];

const idOf = (sequence: number) => `${sequence.toString(16).padStart(14, "0")}-00000000-00000000`;

const own = idOf(1);
const channel = idOf(2);

const describeTimeline = (
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
  unread: { activity: 0, botDirect: 0, botMessages: 0, direct: 0, highlights: 0, messages: 0 },
});

/**
 * Waits until something holds, letting React render what changed meanwhile.
 * @param holds - What must hold.
 */
const settled = async (holds: () => boolean) => {
  await act(async () => {
    await eventually(holds);
  });
};

/**
 * Does something to the page, letting React render it.
 * @param doing - What to do.
 */
const doing = async (doing: () => void) => {
  await act(async () => {
    doing();
    await Promise.resolve();
  });
};

/**
 * The Frontend signed in to a Daemon with one Network, its own Timeline and `#iirc`, both
 * read, with `#iirc` open.
 * @returns The fake Daemon, the registry, and the page.
 */
const signedIn = async () => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  fake.daemon.through = 1;
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: describeTimeline(own, "libera", "Network") },
    { gaps: [], items: [], timeline: describeTimeline(channel, "#iirc", "Channel") },
  ]);

  const registry = registryFor(fake.fetch);

  await run(registry, check, undefined);
  registry.mount(sync);
  registry.mount(optionsSync);

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
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  await settled(
    () =>
      [...registry.get(timelinesState).networks.values()].some(
        (network) => network.timelines.size === 2
      ) && fake.daemon.followers.length === 1
  );

  await doing(() => {
    registry.set(open, Schema.decodeSync(TimelineId)(channel));
  });

  return { container, daemon: fake.daemon, registry };
};

/**
 * The composer under the Panes.
 * @param container - The page.
 * @returns The composer.
 */
const composerOf = (container: HTMLElement) => {
  const found = container.querySelector("textarea");

  if (found === null) {
    throw new Error("no composer");
  }

  return found;
};

/**
 * Types a line into the composer and presses Enter.
 * @param container - The page.
 * @param line - The line.
 */
const submit = async (container: HTMLElement, line: string) => {
  const composer = composerOf(container);

  await doing(() => {
    Reflect.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      composer,
      line
    );
    composer.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await doing(() => {
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: "Enter", key: "Enter" })
    );
  });
};

/**
 * The question, while it is asked.
 * @returns Its dialog, or none.
 */
const question = () => document.querySelector<HTMLElement>('[role="alertdialog"]');

/**
 * A button of the question, by what it says.
 * @param text - What it says.
 * @returns The button.
 */
const button = (text: string) => {
  const found = [...(question()?.querySelectorAll("button") ?? [])].find(
    (one) => one.textContent === text
  );

  if (found === undefined) {
    throw new Error(`no button ${text}`);
  }

  return found;
};

/**
 * The sidebar's headings and the rows under each, by their labels.
 * @returns The headings, and each row's label.
 */
const sidebarText = () =>
  [...document.querySelectorAll("nav h2, nav [role='row']")].map(
    (one) => one.getAttribute("aria-label") ?? one.textContent
  );

describe("removing a Network", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      unmount();
    }
  });

  it("asks first, and sends nothing when cancelled", async () => {
    const { container, daemon } = await signedIn();

    await submit(container, "/network remove libera");
    await settled(() => question() !== null);

    const asked = {
      choices: [...(question()?.querySelectorAll("input[type='radio']") ?? [])].map((one) =>
        one instanceof HTMLInputElement ? [one.value, one.checked] : []
      ),
      title: question()?.querySelector("h2")?.textContent,
    };

    await doing(() => {
      button("cancel").click();
    });
    await settled(() => question() === null);

    expect({ asked, removals: daemon.removals }).toStrictEqual({
      asked: {
        choices: [
          ["keep", true],
          ["drop", false],
        ],
        title: "Remove libera?",
      },
      removals: [],
    });
  });

  it("removes nothing when the Network was removed or added again since it was asked about, and says so", async () => {
    const { container, daemon } = await signedIn();

    await submit(container, "/network remove libera");
    await settled(() => question() !== null);

    // Another Frontend dropped it and added the name again meanwhile.
    daemon.lives.set("libera", 99);

    await doing(() => {
      button("remove").click();
    });
    await settled(() => question()?.textContent?.includes("since you were asked") === true);

    expect({
      removals: daemon.removals,
      said: question()?.textContent?.includes(
        "libera was removed or added again since you were asked, so nothing was removed."
      ),
    }).toStrictEqual({ removals: [], said: true });
  });

  it("keeps its Timelines to read, apart and with no Composer to say in, then drops them", async () => {
    const { container, daemon, registry } = await signedIn();

    await submit(container, "/network remove");
    await settled(() => question() !== null);
    await doing(() => {
      button("remove").click();
    });
    await settled(() => question() === null && document.querySelector('[role="note"]') !== null);

    const kept = {
      composer: composerOf(container).placeholder,
      note: document.querySelector('[role="note"] span')?.textContent,
      removals: [...daemon.removals],
      sidebar: sidebarText(),
    };

    // Plain text is refused under the composer, and nothing is said.
    await submit(container, "hello");
    await settled(() => container.querySelector('[role="alert"] p') !== null);
    const refused = container.querySelector('[role="alert"] p')?.textContent;

    // The Pane's own button asks again, which only drops them.
    await doing(() => {
      [...container.querySelectorAll<HTMLButtonElement>('[role="note"] button')][0]?.click();
    });
    await settled(() => question() !== null);
    const drop = question()?.querySelector("h2")?.textContent;
    const choosing = question()?.querySelectorAll("input[type='radio']").length;

    await doing(() => {
      button("drop them").click();
    });
    await settled(() => question() === null && registry.get(timelinesState).networks.size === 0);

    expect({
      choosing,
      drop,
      kept,
      left: sidebarText(),
      refused,
      removals: daemon.removals,
      says: daemon.says,
    }).toStrictEqual({
      choosing: 0,
      drop: "Drop libera's conversations?",
      kept: {
        composer: "libera was removed, so you can't send messages here.",
        note: "libera was removed. Its conversations are kept to read and search, and you can't send messages here.",
        removals: [{ keep: true, network: "libera" }],
        sidebar: ["removed", "libera, removed", "#iirc"],
      },
      left: [],
      refused:
        "libera was removed, so its conversations are read-only. /network remove libera drops them.",
      removals: [
        { keep: true, network: "libera" },
        { keep: false, network: "libera" },
      ],
      says: [],
    });
  });

  it("drops them at once when the Owner chooses, freeing the name", async () => {
    const { container, daemon, registry } = await signedIn();

    await submit(container, "/network remove libera");
    await settled(() => question() !== null);
    await doing(() => {
      question()?.querySelector<HTMLInputElement>("input[value='drop']")?.click();
    });
    await doing(() => {
      button("remove").click();
    });
    await settled(() => question() === null && registry.get(timelinesState).networks.size === 0);

    await submit(container, "/network add libera irc.libera.chat bot");
    await settled(() => daemon.puts.length === 1);

    expect({
      kept: [...daemon.kept],
      puts: daemon.puts.map((one) => one.network),
      removals: daemon.removals,
    }).toStrictEqual({
      kept: [],
      puts: ["libera"],
      removals: [{ keep: false, network: "libera" }],
    });
  });

  it("says why a name is taken while a removed Network's Timelines are kept", async () => {
    const { container, daemon } = await signedIn();

    await submit(container, "/network remove libera keep");
    await settled(() => question() !== null);
    await doing(() => {
      button("remove").click();
    });
    await settled(() => question() === null && daemon.kept.has("libera"));

    await submit(container, "/network add libera irc.libera.chat bot");
    await settled(() => container.querySelector('[role="alert"] p') !== null);

    expect(container.querySelector('[role="alert"] p')?.textContent).toBe(
      "libera was removed but its conversations were kept, so no network can take its name until you drop them. /network remove libera drops them."
    );
  });

  // A lone `keep` or `drop` after `/network remove` is the choice about the focused Network,
  // so the command the hint names must say the choice after a Network with that id.
  it.each([
    ["keep", "/network remove keep drop drops them."],
    ["drop", "/network remove drop drop drops them."],
  ])(
    "names the command that drops the kept Timelines of a Network whose id is %s",
    async (network, ending) => {
      const { container, daemon } = await signedIn();

      daemon.kept.add(network);

      await submit(container, `/network add ${network} irc.example.org bot`);
      await settled(() => container.querySelector('[role="alert"] p') !== null);

      expect(container.querySelector('[role="alert"] p')?.textContent).toBe(
        `${network} was removed but its conversations were kept, so no network can take its name until you drop them. ${ending}`
      );
    }
  );
});
