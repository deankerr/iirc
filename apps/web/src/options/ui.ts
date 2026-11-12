/**
 * The options under `ui`, as atoms: the ones every device shares, followed from the Daemon
 * while the page is signed in, this device's overrides, kept in `localStorage` and never
 * sent, and the ones in effect here, derived from both. A change for every device is made
 * from the options read, so the Daemon refuses it if another device changed them in
 * between, and is then read again and made once more, since a Change is the whole value
 * of one option.
 *
 * @packageDocumentation
 */
import type { UiInForce, UiOptionName } from "@iirc/api";
import type { Json } from "@iirc/frontend/options";
import { reduceOptions } from "@iirc/frontend/options";
import { deviceUiKey, deviceUiText, effectiveUi, overridden } from "@iirc/frontend/ui";
import { Effect, Schedule, Stream } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { writeChoice } from "../page/device.ts";
import { signedIn } from "../sign-in/atoms.ts";
import { retrying, Waits } from "../timelines/atoms.ts";
import { editing, optionsState, signedOut, told } from "./atoms.ts";
import type { Outcome } from "./atoms.ts";
import { deviceUi } from "./device.ts";

/** The options under `ui` in effect on this device: its override, else the shared one, else the default. */
export const uiInEffect = Atom.make((get) => effectiveUi(get(optionsState).ui, get(deviceUi)));

/** How a line's time shows on this device, alone, so a line draws again only when it changes. */
export const timeShown = Atom.make((get) => get(uiInEffect).time);

/** Which Activity a Channel shows on this device, alone, as `timeShown` is. */
export const activityShown = Atom.make((get) => get(uiInEffect).activity);

/** The text's size on this device, in pixels, alone, as `timeShown` is. */
export const sizeShown = Atom.make((get) => get(uiInEffect).size);

/**
 * Folds the shared options, as read or followed, into the options' state, where an older
 * read never replaces a newer one.
 * @param registry - The registry.
 * @param ui - The options, and the sequence of the last Change.
 */
export const uiRead = (registry: AtomRegistry.AtomRegistry, ui: UiInForce) => {
  registry.set(optionsState, reduceOptions(registry.get(optionsState), { _tag: "UiRead", ui }));
};

/**
 * While the browser is signed in, follows the shared options, each event the options
 * whole, from the ones in force. Whenever the stream ends, or gives nothing for longer than
 * three heartbeats, it is followed again. A refusal signs the page out. Mounted once.
 */
export const uiSync = runtime
  .atom((get) =>
    Effect.gen(function* () {
      const { registry } = get;

      if (!get(signedIn)) {
        return;
      }

      const client = yield* DaemonClient;
      const { idle, reconnect } = yield* Waits;
      const schedule = yield* retrying;

      // From no place each time, so the options in force come first, whatever was missed.
      const follow = Effect.gen(function* () {
        const events = yield* client.ui
          .changes({ headers: {}, query: {} })
          .pipe(Effect.timeout(idle));

        yield* events.pipe(
          Stream.timeout(idle),
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.event === "changed") {
                uiRead(registry, event.data);
              }
            })
          )
        );
      });

      yield* follow.pipe(
        Effect.retry({ schedule, while: (error) => error._tag !== "Unauthorized" }),
        Effect.repeat(Schedule.spaced(reconnect)),
        Effect.catchTag("Unauthorized", () =>
          Effect.sync(() => {
            signedOut(registry);
          })
        )
      );
    })
  )
  .pipe(Atom.keepAlive);

/** A change of an option under `ui`: its value as JSON, or none to unset it. */
export interface UiChange {
  readonly option: UiOptionName;
  readonly value: Json | undefined;
  readonly device: boolean;
}

/**
 * Why a change of the shared options failed, in words, from its error's tag.
 * @param tag - The error's tag.
 * @returns The outcome.
 */
export const uiFailed = (tag: string): Outcome => {
  switch (tag) {
    case "Unauthorized": {
      return { _tag: "SignedOut" };
    }

    case "UiChanged": {
      return {
        _tag: "NotDone",
        message:
          "The ui options changed while this was being made, twice, so nothing was changed. Try again.",
      };
    }

    case "InvalidRequest": {
      return { _tag: "NotDone", message: "The Daemon could not take this as a ui option's value." };
    }

    case "JournalFailed": {
      return {
        _tag: "NotDone",
        message: "The Daemon could not record this, so nothing was changed.",
      };
    }

    default: {
      return {
        _tag: "NotDone",
        message: "The Daemon did not answer, so whether this was changed is unknown.",
      };
    }
  }
};

/** A conflict: the shared options were not the ones the change was made from. */
const conflict = { _tag: "Conflict" } as const;

/**
 * One try at a change of the shared options, made from the sequence read: the one this
 * page holds, or one read now when it holds none, or after a conflict. Once it is
 * journaled, the options are read, so this page shows it before the stream brings it.
 * @param registry - The registry.
 * @param change - The change.
 * @param fresh - Whether to read the options first, whatever this page holds.
 * @returns What it came to, or a conflict to try again.
 */
const tryShared = (registry: AtomRegistry.AtomRegistry, change: UiChange, fresh: boolean) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const held = registry.get(optionsState).ui;
    const from = fresh || held === undefined ? yield* client.ui.read() : held;

    uiRead(registry, from);

    const params = { option: change.option };
    const query = { ifSequence: from.sequence };

    yield* change.value === undefined
      ? client.ui.unset({ params, query })
      : client.ui.set({ params, payload: { value: change.value }, query });

    uiRead(registry, yield* client.ui.read());

    const done: Outcome = { _tag: "Done" };

    return done;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(error._tag === "UiChanged" ? conflict : uiFailed(error._tag))
    )
  );

/**
 * Changes an option under `ui`: on this device alone, kept as best it can and never sent,
 * or for every device, through the Daemon, made from the options read and made once more
 * after a conflict.
 * @param registry - The registry.
 * @param change - The change.
 * @returns What it came to.
 */
export const changeUi = (registry: AtomRegistry.AtomRegistry, change: UiChange) =>
  Effect.gen(function* () {
    if (change.device) {
      const next = overridden(registry.get(deviceUi), change.option, change.value);

      registry.set(deviceUi, next);
      writeChoice(deviceUiKey, deviceUiText(next));

      const done: Outcome = { _tag: "Done" };

      return done;
    }

    const first = yield* tryShared(registry, change, false);

    if (first._tag !== "Conflict") {
      return first;
    }

    const second = yield* tryShared(registry, change, true);

    return second._tag === "Conflict" ? uiFailed("UiChanged") : second;
  });

/** Makes a change of an option under `ui` from the options view, and says there what it came to. */
export const changeUiOption = runtime
  .fn(
    (change: UiChange, get) =>
      Effect.gen(function* () {
        get.registry.set(editing, undefined);
        told(get.registry, yield* changeUi(get.registry, change));
      }),
    { concurrent: true }
  )
  .pipe(Atom.keepAlive);
