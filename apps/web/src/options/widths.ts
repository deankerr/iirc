/**
 * The widths the Owner drags, the nick column and the members' panel: each one in effect,
 * or the one a drag holds while it lasts, which is never written, and writing one as a drag
 * ends or a key moves it, as any change of a `ui` option is written, or saying in the Composer
 * why it was not.
 *
 * @packageDocumentation
 */
import { membersWidthBounds, nickWidthBounds } from "@iirc/api";
import { placeIn, reduceComposers } from "@iirc/frontend/composer";
import { writtenOnDevice } from "@iirc/frontend/ui";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { runtime } from "../app/runtime.ts";
import { composerState } from "../composer/composer-state.ts";
import { timelinesState } from "../timelines/atoms.ts";
import { signedOut } from "./atoms.ts";
import type { Outcome } from "./atoms.ts";
import { deviceUi } from "./device.ts";
import { changeUi, uiInEffect } from "./ui.ts";

/** An option a grip resizes. */
export type WidthOption = "conversation.nickWidth" | "members.width";

/** The least and the most each option may be, in the font's own `0`. */
export const widthBounds: Readonly<
  Record<WidthOption, { readonly minimum: number; readonly maximum: number }>
> = {
  "conversation.nickWidth": nickWidthBounds,
  "members.width": membersWidthBounds,
};

/**
 * A width within its option's bounds, to a whole `0`.
 * @param option - The option.
 * @param width - The width asked for.
 * @returns The width drawn.
 */
export const boundedWidth = (option: WidthOption, width: number): number => {
  const { maximum, minimum } = widthBounds[option];

  return Math.min(maximum, Math.max(minimum, Math.round(width)));
};

/** The width a drag holds while it lasts, and which option's, or none between drags. */
export const widthDragged = Atom.make<
  { readonly option: WidthOption; readonly width: number } | undefined
>(undefined).pipe(Atom.keepAlive);

/** Each width drawn on this device: the one a drag holds, else the one in effect. */
export const widthsShown = Atom.make((get): Readonly<Record<WidthOption, number>> => {
  const ui = get(uiInEffect);
  const dragged = get(widthDragged);

  return {
    "conversation.nickWidth":
      dragged?.option === "conversation.nickWidth" ? dragged.width : ui["conversation.nickWidth"],
    "members.width": dragged?.option === "members.width" ? dragged.width : ui["members.width"],
  };
});

/**
 * Lets go of what a drag of an option holds, unwritten, as a drag the browser cancels or
 * whose grip goes.
 * @param registry - The registry.
 * @param option - The option dragged.
 */
export const dropDrag = (registry: AtomRegistry.AtomRegistry, option: WidthOption) => {
  if (registry.get(widthDragged)?.option === option) {
    registry.set(widthDragged, undefined);
  }
};

/**
 * Writes a width of one option, within its bounds, as a drag ends or a key moves it: this
 * device's own where it overrides the option, else the one every device shares, and nothing
 * where it is already in effect. What the drag held is drawn until the write is over, so the
 * width never steps back while the Daemon answers. A write refused leaves the width as it
 * was, and the Composer says why. Each option has its own, so a write of one never ends a
 * write of the other, and a newer write of the same option ends the one before.
 */
export const resizeWidth = Atom.family((option: WidthOption) =>
  runtime
    .fn((asked: number, get) =>
      Effect.gen(function* () {
        const { registry } = get;
        const dragged = registry.get(widthDragged);
        // What a drag of this option held, if this write ends one: a key on the other grip
        // leaves the other's drag alone.
        const held = dragged?.option === option ? dragged : undefined;

        // A drag begun since holds a width of its own, which this leaves to it.
        const letGo = Effect.sync(() => {
          if (held !== undefined && registry.get(widthDragged) === held) {
            registry.set(widthDragged, undefined);
          }
        });

        const width = boundedWidth(option, asked);
        const overrides = registry.get(deviceUi)[option] !== undefined;
        const device = writtenOnDevice(option, width, overrides);
        const unchanged = registry.get(uiInEffect)[option] === width;
        const done: Outcome = { _tag: "Done" };

        const outcome = yield* (
          unchanged ? Effect.succeed(done) : changeUi(registry, { device, option, value: width })
        ).pipe(Effect.ensuring(letGo));

        if (outcome._tag === "SignedOut") {
          signedOut(registry);
        }

        if (outcome._tag === "NotDone") {
          registry.set(
            composerState,
            reduceComposers(registry.get(composerState), {
              _tag: "Noticed",
              message: outcome.message,
              timeline: placeIn(registry.get(timelinesState)),
            })
          );
        }
      })
    )
    .pipe(Atom.keepAlive)
);
