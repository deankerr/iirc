/**
 * A Notifier for tests: it keeps the device's choice in memory, answers a permission as the
 * test says, and keeps what is shown by tag, as a browser replaces a notification with the
 * same tag, with every one shown in order besides.
 *
 * @packageDocumentation
 */
import type { Notify } from "@iirc/frontend/notifications";
import { Effect } from "effect";

import type { NotifierPort, Permission } from "../notifications/notifier.ts";

/** What a test's Notifier holds, which a test may change. */
interface Held {
  /** What the browser answers when asked, and holds after. */
  answer: Permission;
  /** Whether the Owner turned notifications on for the device. */
  on: boolean;
  /** Whether the device keeps the choice. */
  keeps: boolean;
  /** The browser's permission as it stands. */
  permission: Permission;
  /** How many times the browser was asked. */
  requests: number;
  /** What shows now, by tag, each with what choosing it does. */
  readonly showing: Map<string, { readonly notify: Notify; readonly choose: () => void }>;
  /** Every notification shown, in order. */
  readonly shown: Notify[];
}

/**
 * A test's Notifier.
 * @returns What it holds, and its port.
 */
export const testNotifier = () => {
  const held: Held = {
    answer: "Granted",
    keeps: true,
    on: false,
    permission: "Default",
    requests: 0,
    showing: new Map(),
    shown: [],
  };

  const port: NotifierPort = {
    choose: (on) =>
      Effect.sync(() => {
        held.on = on;

        return held.keeps;
      }),
    chosen: Effect.sync(() => held.on),
    permission: Effect.sync(() => held.permission),
    request: Effect.sync(() => {
      held.requests += 1;
      held.permission = held.answer;

      return held.answer;
    }),
    show: (notify, chosen) =>
      Effect.sync(() => {
        held.shown.push(notify);
        held.showing.set(notify.tag, { choose: chosen, notify });
      }),
  };

  return { held, port };
};
