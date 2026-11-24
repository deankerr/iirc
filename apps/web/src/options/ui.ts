/**
 * The options under `ui`, as atoms: the ones every device shares, followed from the Daemon
 * while the page is signed in, this device's overrides, kept in `localStorage` and never
 * sent, and the ones in effect here, derived from both. A change for every device is made
 * from the options read, so the Daemon refuses it if another device changed them in
 * between, and is then read again and made once more, since a Change is the whole value
 * of one option. The Sidebar's order is among them, so the Sidebar as arranged is here too.
 *
 * @packageDocumentation
 */
import { Aliases as AliasesSchema } from "@iirc/api";
import type { Aliases, PreviewsMediaHeight, TimelineId, UiInForce, UiOptionName } from "@iirc/api";
import { muting } from "@iirc/frontend/activity";
import { editAliases } from "@iirc/frontend/aliases";
import type { AliasesEdit } from "@iirc/frontend/aliases";
import { arranged, arrangementOf, arranging, unarranged } from "@iirc/frontend/arrangement";
import type { ArrangeChange, ArrangeEdit } from "@iirc/frontend/arrangement";
import type { Parsed } from "@iirc/frontend/commands";
import type { Json } from "@iirc/frontend/options";
import { reduceOptions, uiShown } from "@iirc/frontend/options";
import { leastShown } from "@iirc/frontend/tail";
import { deviceUiKey, deviceUiText, effectiveUi, overridden, readRuleOf } from "@iirc/frontend/ui";
import { Effect, Schedule, Schema, Stream } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { writeChoice } from "../page/device.ts";
import { signedIn } from "../sign-in/atoms.ts";
import { retrying, sidebarNetworks, Waits } from "../timelines/atoms.ts";
import { editing, onItsWay, optionsState, signedOut, told } from "./atoms.ts";
import type { Outcome } from "./atoms.ts";
import { deviceUi } from "./device.ts";

/**
 * The options under `ui` in effect on this device: its override, else the shared one as it
 * shows with the changes on its way, else the default.
 */
export const uiInEffect = Atom.make((get) =>
  effectiveUi(uiShown(get(optionsState)), get(deviceUi))
);

/** How a line's time shows on this device, alone, so a line draws again only when it changes. */
export const timeShown = Atom.make((get) => get(uiInEffect)["timeline.timeFormat"]);

/** How a day is written where the day changes on this device, alone, as `timeShown` is. */
export const dayShown = Atom.make((get) => get(uiInEffect)["timeline.dateFormat"]);

/** Which Activity a Channel shows on this device, alone, as `timeShown` is. */
export const activityShown = Atom.make((get) => get(uiInEffect)["timeline.activity"]);

/** The least level of the Tail's lines the `iirc` view shows, alone, as `timeShown` is. */
export const tailLeast = Atom.make((get) => leastShown(get(uiInEffect).tail));

/** The text's size on this device, in pixels, alone, as `timeShown` is. */
export const sizeShown = Atom.make((get) => get(uiInEffect)["font.size"]);

/** The line height on this device, as a multiple of the text's size, alone, as `timeShown` is. */
export const leadingShown = Atom.make((get) => get(uiInEffect)["font.lineHeight"]);

/**
 * The room between a Timeline's rows on this device, as a multiple of the text's size, alone,
 * as `timeShown` is.
 */
export const spacingShown = Atom.make((get) => get(uiInEffect)["timeline.spacing"]);

/** Whether a sender's nick stands in `<` and `>` on this device, alone, as `timeShown` is. */
export const bracketsShown = Atom.make((get) => get(uiInEffect)["timeline.nickBrackets"]);

/** Whether a sender's nick has their prefix before it on this device, alone, as `timeShown` is. */
export const prefixShown = Atom.make((get) => get(uiInEffect)["timeline.nickPrefix"]);

/** How a line is laid out on this device, alone, as `timeShown` is. */
export const lineShown = Atom.make((get) => get(uiInEffect)["timeline.layout"]);

/** What Enter does in the Composer on this device, alone, as `timeShown` is. */
export const enterShown = Atom.make((get) => get(uiInEffect)["composer.enter"]);

/** Whether the Composer checks spelling on this device, alone, as `timeShown` is. */
export const spellcheckShown = Atom.make((get) => get(uiInEffect)["composer.spellcheck"]);

/** Whether animated images play on their own on this device, alone, as `timeShown` is. */
export const animateShown = Atom.make((get) => get(uiInEffect)["previews.animate"]);

/** Whether Previews start open or closed on this device, alone, as `timeShown` is. */
export const previewsStartShown = Atom.make((get) => get(uiInEffect)["previews.start"]);

/** How tall each `ui.previews.mediaHeight` draws a Preview's media at most, in pixels. */
const mediaPixels: Readonly<Record<PreviewsMediaHeight, number>> = {
  large: 400,
  medium: 260,
  small: 160,
};

/** How tall a Preview's media is drawn at most on this device, in pixels, as `timeShown` is. */
export const mediaHeightShown = Atom.make(
  (get) => mediaPixels[get(uiInEffect)["previews.mediaHeight"]]
);

/**
 * When a Timeline is marked read on this device, as `timeShown` is, but none until it is
 * known: this device's override, or the shared options in force once read. A change on its
 * way marks nothing until the Daemon has taken it, since a Read Marker moved cannot be undone.
 */
export const readRule = Atom.make((get) => readRuleOf(get(optionsState).ui, get(deviceUi)));

/**
 * Folds the shared options, as read or followed, into the options' state, where an older
 * read never replaces a newer one. A read that lands once the page is signed out, as one
 * begun before it was, is dropped, so what signing out forgot stays forgotten.
 * @param registry - The registry.
 * @param ui - The options, and the sequence of the last Change.
 */
export const uiRead = (registry: AtomRegistry.AtomRegistry, ui: UiInForce) => {
  if (registry.get(signedIn)) {
    registry.set(optionsState, reduceOptions(registry.get(optionsState), { _tag: "UiRead", ui }));
  }
};

/**
 * Reads the shared options now, and folds them in only when the page stayed signed in the
 * whole time the read took: one that lands after it signed out, or after it signed in
 * again, may be of options since changed, and the stream brings the ones in force anyway.
 * @param registry - The registry.
 * @returns The options read.
 */
export const readShared = (registry: AtomRegistry.AtomRegistry) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    let stayed = registry.get(signedIn);

    const read = yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        registry.subscribe(signedIn, (now) => {
          stayed &&= now;
        })
      ),
      () => client.ui.read(),
      (unsubscribe) => Effect.sync(unsubscribe)
    );

    if (stayed) {
      uiRead(registry, read);
    }

    return read;
  });

/**
 * While the browser is signed in, follows the shared options, each event the options
 * whole, from the ones in force. Whenever the stream ends, or gives nothing for longer than
 * three heartbeats, it is followed again. A refusal signs the page out, and signed out, the
 * shared options are forgotten until they are read again. Mounted once.
 */
export const uiSync = runtime
  .atom((get) =>
    Effect.gen(function* () {
      const { registry } = get;

      // Signed out, the shared options held may be changed before the next sign-in, so they
      // are forgotten, and a rule they set waits for them to be read again.
      if (!get(signedIn)) {
        registry.set(
          optionsState,
          reduceOptions(registry.get(optionsState), { _tag: "UiForgotten" })
        );

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

/**
 * Whether the shared options are read, so the shell can draw in them. Whatever reads this
 * follows them, so a page that waits on them never waits on nothing.
 */
export const uiKnown = Atom.make((get) => {
  get.mount(uiSync);

  return get(optionsState).ui !== undefined;
});

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
          "The ui settings changed while this was being saved, so nothing was changed. Try again.",
      };
    }

    case "InvalidRequest": {
      return {
        _tag: "NotDone",
        message: "The daemon could not accept this as a ui setting's value.",
      };
    }

    case "JournalFailed": {
      return {
        _tag: "NotDone",
        message: "The daemon could not record this, so nothing was changed.",
      };
    }

    default: {
      return {
        _tag: "NotDone",
        message: "The daemon did not answer, so it's unknown whether this was changed.",
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
    const from = fresh || held === undefined ? yield* readShared(registry) : held;

    const params = { option: change.option };
    const query = { ifSequence: from.sequence };

    yield* change.value === undefined
      ? client.ui.unset({ params, query })
      : client.ui.set({ params, payload: { value: change.value }, query });

    yield* readShared(registry);

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
 * after a conflict, and shown at once until the Daemon has answered.
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

    return yield* onItsWay(
      registry,
      { _tag: "Ui", option: change.option, value: change.value },
      Effect.gen(function* () {
        const first = yield* tryShared(registry, change, false);

        if (first._tag !== "Conflict") {
          return first;
        }

        const second = yield* tryShared(registry, change, true);

        return second._tag === "Conflict" ? uiFailed("UiChanged") : second;
      })
    );
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

/**
 * The Owner's order of the Sidebar, as the shared options show it with the changes on their
 * way, since every device shares it and none overrides it, or no order until they are read.
 */
export const arrangement = Atom.make((get) => {
  const shown = uiShown(get(optionsState));

  return shown === undefined ? unarranged : arrangementOf(shown.options);
});

/**
 * The aliases the Owner made, as the shared options show them with the changes on their
 * way, since every device shares them and none overrides them, or none until they are read.
 */
export const aliasesShown = Atom.make(
  (get): Aliases => uiShown(get(optionsState))?.options.aliases ?? []
);

/**
 * The Sidebar as shown: the pinned Timelines, then the Networks, each in the Owner's order.
 * It is here rather than beside `sidebarNetworks`, since the options' atoms read the
 * Timelines' and not the other way around.
 */
export const arrangedSidebar = Atom.make((get) => arranged(get(sidebarNetworks), get(arrangement)));

/**
 * An arrangement's change as the Daemon takes it.
 * @param change - The change.
 * @returns The option, and its whole value as JSON.
 */
const arrangeJson = (change: ArrangeChange) => ({
  option: change.option,
  value: [...change.value],
});

/**
 * One try at an edit of the Sidebar's order: the options read, what to write worked out
 * from them and what the Sidebar shows, and the option sent whole, made from the sequence
 * read. An edit that changes nothing sends nothing.
 * @param registry - The registry.
 * @param edit - What the Owner did.
 * @returns What it came to, or a conflict to try again.
 */
const tryArrange = (registry: AtomRegistry.AtomRegistry, edit: ArrangeEdit) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const read = yield* readShared(registry);
    const done: Outcome = { _tag: "Done" };
    const change = arranging(registry.get(sidebarNetworks), arrangementOf(read.options), edit);

    if (change === undefined) {
      return done;
    }

    const { option, value } = arrangeJson(change);

    yield* client.ui.set({
      params: { option },
      payload: { value },
      query: { ifSequence: read.sequence },
    });

    yield* readShared(registry);

    return done;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(error._tag === "UiChanged" ? conflict : uiFailed(error._tag))
    )
  );

/**
 * Carries out an edit of the Sidebar's order, for every device: worked out from the options
 * read, and once more from those read again after a conflict, so another device's change
 * made in between is kept. What it would write from the options held shows at once, so a
 * row dropped stays where it was dropped while the Daemon answers.
 * @param registry - The registry.
 * @param edit - What the Owner did.
 * @returns What it came to.
 */
export const arrange = (registry: AtomRegistry.AtomRegistry, edit: ArrangeEdit) => {
  const work = Effect.gen(function* () {
    const first = yield* tryArrange(registry, edit);

    if (first._tag !== "Conflict") {
      return first;
    }

    const second = yield* tryArrange(registry, edit);

    return second._tag === "Conflict" ? uiFailed("UiChanged") : second;
  });

  const held = uiShown(registry.get(optionsState));

  const shown =
    held === undefined
      ? undefined
      : arranging(registry.get(sidebarNetworks), arrangementOf(held.options), edit);

  return shown === undefined
    ? work
    : onItsWay(registry, { _tag: "Ui", ...arrangeJson(shown) }, work);
};

/**
 * One try at a change of one shared option made whole from the options read: what to write
 * worked out from them, and sent made from the sequence read. A value of none sends
 * nothing, as the option is already as wanted.
 * @param registry - The registry.
 * @param option - The option.
 * @param make - Works out its new value from the options read, or why there is none, or
 * that none is needed.
 * @returns What it came to, or a conflict to try again.
 */
const tryWhole = (
  registry: AtomRegistry.AtomRegistry,
  option: UiOptionName,
  make: (read: UiInForce) => Parsed<Json | undefined>
) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const read = yield* readShared(registry);
    const made = make(read);

    if (made._tag === "Invalid") {
      const refused: Outcome = { _tag: "NotDone", message: made.message };

      return refused;
    }

    const done: Outcome = { _tag: "Done" };

    if (made.value === undefined) {
      return done;
    }

    yield* client.ui.set({
      params: { option },
      payload: { value: made.value },
      query: { ifSequence: read.sequence },
    });

    yield* readShared(registry);

    return done;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(error._tag === "UiChanged" ? conflict : uiFailed(error._tag))
    )
  );

/**
 * Changes one shared option whole, for every device, from the options read, and once more
 * from those read again after a conflict, since the edit is a pure function of the value,
 * so another device's change in between is kept.
 * @param registry - The registry.
 * @param option - The option.
 * @param make - Works out its new value from the options read, or why there is none, or
 * that none is needed, which sends nothing.
 * @returns What it came to.
 */
export const changeWhole = (
  registry: AtomRegistry.AtomRegistry,
  option: UiOptionName,
  make: (read: UiInForce) => Parsed<Json | undefined>
) =>
  Effect.gen(function* () {
    const first = yield* tryWhole(registry, option, make);

    if (first._tag !== "Conflict") {
      return first;
    }

    const second = yield* tryWhole(registry, option, make);

    return second._tag === "Conflict" ? uiFailed("UiChanged") : second;
  });

const aliasesJson = Schema.encodeSync(Schema.toCodecJson(AliasesSchema));

/**
 * Adds or removes an alias for every device, made from the options read, as `changeWhole`
 * makes it.
 * @param registry - The registry.
 * @param edit - The edit.
 * @returns What it came to.
 */
export const changeAliases = (registry: AtomRegistry.AtomRegistry, edit: AliasesEdit) =>
  changeWhole(registry, "aliases", (read) => {
    const aliases = editAliases(read.options.aliases, edit);

    return aliases._tag === "Invalid"
      ? aliases
      : { _tag: "Parsed", value: aliasesJson(aliases.value) };
  });

/**
 * Mutes a Timeline for every device, or unmutes it: the whole list worked out from the
 * options read, and once more from those read again after a conflict, so another device's
 * change in between is kept. What it would write from the options held shows at once. A
 * Timeline already as wanted sends nothing, and one more than the list holds is refused,
 * in words.
 * @param registry - The registry.
 * @param intent - The Timeline, and whether it is muted.
 * @returns What it came to.
 */
export const mute = (
  registry: AtomRegistry.AtomRegistry,
  intent: { readonly timeline: TimelineId; readonly muted: boolean }
) => {
  const work = changeWhole(registry, "unread.muted", (read) => {
    const made = muting(read.options["unread.muted"], intent.timeline, intent.muted);

    return made._tag === "Invalid"
      ? made
      : { _tag: "Parsed", value: made.value === undefined ? undefined : [...made.value] };
  });

  const held = uiShown(registry.get(optionsState));

  const shown =
    held === undefined
      ? undefined
      : muting(held.options["unread.muted"], intent.timeline, intent.muted);

  return shown?._tag === "Parsed" && shown.value !== undefined
    ? onItsWay(registry, { _tag: "Ui", option: "unread.muted", value: [...shown.value] }, work)
    : work;
};
