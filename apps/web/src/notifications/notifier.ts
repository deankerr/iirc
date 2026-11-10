/**
 * Notifications, through a port: the host shows them, and keeps whether the Owner turned
 * them on for this device. The browser's adapter is the Notification API and
 * `localStorage`; a test gives its own. The core decides which items call for one and
 * what it says, and this only shows them, when the Owner turned them on.
 *
 * @packageDocumentation
 */
import type { Notify } from "@iirc/frontend/notifications";
import { Context, Effect } from "effect";

import type { Outcome } from "../options/atoms.ts";

/**
 * Whether the browser lets the page notify: `Granted`, `Denied`, `Default`, not asked or
 * dismissed, or `Unsupported`, as where there is no Notification API.
 */
export type Permission = "Granted" | "Denied" | "Default" | "Unsupported";

/** The host's side of notifications. */
export interface NotifierPort {
  /** Whether the Owner turned notifications on for this device. */
  readonly chosen: Effect.Effect<boolean>;
  /**
   * Turns them on or off, and keeps that for this device if it can: whether it was kept,
   * or holds for this page only.
   */
  readonly choose: (on: boolean) => Effect.Effect<boolean>;
  /** Whether the browser lets the page notify, as it stands. */
  readonly permission: Effect.Effect<Permission>;
  /** Asks the browser to let the page notify, which it may ask the Owner. */
  readonly request: Effect.Effect<Permission>;
  /**
   * Shows a notification, replacing the one with its tag. Choosing it focuses the window
   * and calls `chosen`.
   */
  readonly show: (notify: Notify, chosen: () => void) => Effect.Effect<void>;
}

/** Where the per-device choice is kept, until options under `ui` can hold it. */
const storageKey = "iirc.notify";

/**
 * The browser's permission, as the port says it.
 * @param permission - The Notification API's.
 * @returns The port's.
 */
const permissionOf = (permission: NotificationPermission): Permission => {
  if (permission === "granted") {
    return "Granted";
  }

  return permission === "denied" ? "Denied" : "Default";
};

const supported = () => typeof Notification !== "undefined";

/** What the browser's adapter keeps the choice in: `localStorage`, or a test's. */
export type ChoiceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * The browser's adapter: the Notification API, and the choice, held in memory for the
 * page, read from storage once when it can be, and written back to it as best it can,
 * since storage may be refused, as in a private window, and the page works without it.
 * @param storage - Where the choice is kept, reached anew each time, since reaching
 * `localStorage` can itself throw.
 * @returns The adapter.
 */
export const browserNotifier = (storage: () => ChoiceStorage): NotifierPort => {
  let on = false;

  try {
    on = storage().getItem(storageKey) === "on";
  } catch {
    // Not read: off, until the Owner says otherwise.
  }

  return {
    choose: (wanted) =>
      Effect.sync(() => {
        on = wanted;

        try {
          if (wanted) {
            storage().setItem(storageKey, "on");
          } else {
            storage().removeItem(storageKey);
          }

          return true;
        } catch {
          return false;
        }
      }),
    chosen: Effect.sync(() => on),
    permission: Effect.sync(() =>
      supported() ? permissionOf(Notification.permission) : "Unsupported"
    ),
    // A browser that cannot ask, or refuses to, cannot notify.
    request: Effect.tryPromise(async () =>
      supported() ? permissionOf(await Notification.requestPermission()) : "Unsupported"
    ).pipe(Effect.orElseSucceed((): Permission => "Unsupported")),
    // A browser that shows notifications only from a service worker, as Chrome on Android
    // does, refuses the constructor: nothing shows, and the changes stream goes on.
    show: (notify, chosen) =>
      Effect.try(() => {
        if (!supported() || Notification.permission !== "granted") {
          return;
        }

        const shown = new Notification(notify.title, { body: notify.body, tag: notify.tag });

        shown.addEventListener("click", () => {
          window.focus();
          chosen();
          shown.close();
        });
      }).pipe(Effect.ignore),
  };
};

/** The host's notifications: the browser's, unless a test gives its own. */
export class Notifier extends Context.Reference<NotifierPort>("@iirc/web/Notifier", {
  defaultValue: () => browserNotifier(() => localStorage),
}) {}

/**
 * Shows each notification, when the Owner turned them on for this device and the browser
 * lets the page.
 * @param notifies - The notifications the core decided on.
 * @param chosen - What choosing one does: open its Timeline.
 * @returns Once shown.
 */
export const notifyAll = (
  notifies: readonly Notify[],
  chosen: (notify: Notify) => void
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (notifies.length === 0) {
      return;
    }

    const notifier = yield* Notifier;

    if (!(yield* notifier.chosen) || (yield* notifier.permission) !== "Granted") {
      return;
    }

    for (const notify of notifies) {
      yield* notifier.show(notify, () => {
        chosen(notify);
      });
    }
  });

/**
 * What turning notifications on or off came to: done, or done for this page only, since
 * the browser would not keep the choice.
 * @param kept - Whether the choice was kept for the device.
 * @param now - Whether they are now on or off.
 * @returns The outcome.
 */
const keptOrNot = (kept: boolean, now: "on" | "off"): Outcome =>
  kept
    ? { _tag: "Done" }
    : {
        _tag: "NotDone",
        message: `Notifications are ${now} for this page only: this browser would not keep the choice for the device.`,
      };

/**
 * Turns notifications on or off for this device. On asks the browser to let the page
 * notify first, and stays off when it does not, saying why.
 * @param on - Whether to turn them on.
 * @returns What it came to.
 */
export const notifying = (on: boolean): Effect.Effect<Outcome> =>
  Effect.gen(function* () {
    const notifier = yield* Notifier;

    if (!on) {
      return keptOrNot(yield* notifier.choose(false), "off");
    }

    const permission = yield* notifier.request;

    switch (permission) {
      case "Granted": {
        return keptOrNot(yield* notifier.choose(true), "on");
      }

      case "Denied": {
        return {
          _tag: "NotDone",
          message:
            "This browser blocks notifications from iirc. Allow them in its settings for this site, then /notify on again.",
        } as const;
      }

      case "Default": {
        return {
          _tag: "NotDone",
          message: "Notifications were not allowed, so they stay off. /notify on asks again.",
        } as const;
      }

      case "Unsupported": {
        return { _tag: "NotDone", message: "This browser cannot show notifications." } as const;
      }

      default: {
        return permission satisfies never;
      }
    }
  });
