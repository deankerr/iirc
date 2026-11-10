import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { browserNotifier, Notifier, notifying } from "./notifier.ts";
import type { ChoiceStorage } from "./notifier.ts";

/**
 * Refuses, as a browser refuses storage.
 * @returns Never.
 */
const refused = (): never => {
  throw new DOMException("refused", "SecurityError");
};

/**
 * Storage that keeps what it is given, and refuses whatever a test says it refuses.
 * @param refuses - What it throws on.
 * @param held - What it holds to start with.
 * @returns The storage, and what it holds.
 */
const storage = (
  refuses: { readonly read?: boolean; readonly write?: boolean; readonly remove?: boolean },
  held = new Map<string, string>()
) => {
  const kept: ChoiceStorage = {
    getItem: (key) => (refuses.read === true ? refused() : (held.get(key) ?? null)),
    removeItem: (key) => {
      if (refuses.remove === true) {
        refused();
      }

      held.delete(key);
    },
    setItem: (key, value) => {
      if (refuses.write === true) {
        refused();
      }

      held.set(key, value);
    },
  };

  return { held, kept };
};

/** What of the Notification API turning notifications on reads. */
interface Asking {
  permission: NotificationPermission;
  readonly requestPermission: () => Promise<NotificationPermission>;
}

/** The Notification API, granting when asked. */
const Granting: Asking = {
  permission: "default",
  // oxlint-disable-next-line typescript/require-await -- the API answers with a promise.
  requestPermission: async (): Promise<NotificationPermission> => {
    Granting.permission = "granted";

    return Granting.permission;
  },
};

/**
 * Turns notifications on or off through the browser's adapter over a storage.
 * @param kept - The storage.
 * @param on - On or off.
 * @returns What the composer is told, and whether they are on after.
 */
const turn = async (kept: ChoiceStorage, on: boolean) => {
  const port = browserNotifier(() => kept);

  const outcome = await Effect.runPromise(
    notifying(on).pipe(Effect.provideService(Notifier, port))
  );

  return { chosen: await Effect.runPromise(port.chosen), outcome };
};

describe("the browser's Notifier, over storage that may refuse", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts from what storage holds, and keeps a change there", async () => {
    vi.stubGlobal("Notification", Granting);
    const { held, kept } = storage({}, new Map([["iirc.notify", "on"]]));
    const started = await Effect.runPromise(browserNotifier(() => kept).chosen);
    const off = await turn(kept, false);

    expect({ held: [...held], off, started }).toStrictEqual({
      held: [],
      off: { chosen: false, outcome: { _tag: "Done" } },
      started: true,
    });
  });

  it("starts off when storage cannot be read, and still turns on, kept when it can write", async () => {
    vi.stubGlobal("Notification", Granting);
    const { held, kept } = storage({ read: true });
    const started = await Effect.runPromise(browserNotifier(() => kept).chosen);
    const on = await turn(kept, true);

    expect({ held: [...held], on, started }).toStrictEqual({
      held: [["iirc.notify", "on"]],
      on: { chosen: true, outcome: { _tag: "Done" } },
      started: false,
    });
  });

  it("turns on for this page only, and says so, when storage cannot be written", async () => {
    vi.stubGlobal("Notification", Granting);
    const { held, kept } = storage({ write: true });

    expect({ held: [...held], on: await turn(kept, true) }).toStrictEqual({
      held: [],
      on: {
        chosen: true,
        outcome: {
          _tag: "NotDone",
          message:
            "Notifications are on for this page only: this browser would not keep the choice for the device.",
        },
      },
    });
  });

  it("turns off for this page, and says so, when storage cannot remove the choice", async () => {
    const { held, kept } = storage({ remove: true }, new Map([["iirc.notify", "on"]]));

    expect({ held: [...held], off: await turn(kept, false) }).toStrictEqual({
      held: [["iirc.notify", "on"]],
      off: {
        chosen: false,
        outcome: {
          _tag: "NotDone",
          message:
            "Notifications are off for this page only: this browser would not keep the choice for the device.",
        },
      },
    });
  });

  it("reaches storage anew each time, so one that cannot be reached at all holds in memory", async () => {
    const port = browserNotifier(() => {
      throw new DOMException("refused", "SecurityError");
    });

    const kept = await Effect.runPromise(port.choose(true));
    const chosen = await Effect.runPromise(port.chosen);

    expect({ chosen, kept }).toStrictEqual({ chosen: true, kept: false });
  });
});
