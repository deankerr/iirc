/**
 * The widths the Owner drags, the nick column and the members' panel: each one in effect,
 * or the one a drag holds while it lasts, which is never written, and writing one as a drag
 * ends or a key moves it, as any change of a `ui` option is written.
 *
 * @packageDocumentation
 */
import { membersWidthBounds, nickWidthBounds } from "@iirc/api";
import { writtenOnDevice } from "@iirc/frontend/ui";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";

import { runtime } from "../app/runtime.ts";
import { signedOut } from "./atoms.ts";
import type { Outcome } from "./atoms.ts";
import { deviceUi } from "./device.ts";
import { changeUi, uiInEffect } from "./ui.ts";

/** An option a grip resizes. */
export type WidthOption = "timeline.nickWidth" | "members.width";

/** The least and the most each option may be, in the font's own `0`. */
export const widthBounds: Readonly<
  Record<WidthOption, { readonly minimum: number; readonly maximum: number }>
> = {
  "members.width": membersWidthBounds,
  "timeline.nickWidth": nickWidthBounds,
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
    "members.width": dragged?.option === "members.width" ? dragged.width : ui["members.width"],
    "timeline.nickWidth":
      dragged?.option === "timeline.nickWidth" ? dragged.width : ui["timeline.nickWidth"],
  };
});

/**
 * Writes a width, within its bounds, as a drag ends or a key moves it: this device's own
 * where it overrides the option, else the one every device shares, and nothing where it
 * is already in effect. What the drag held is drawn until the write is over, so the width
 * never steps back while the Daemon answers, and a write refused leaves it as it was.
 */
export const resizeWidth = runtime
  .fn((asked: { readonly option: WidthOption; readonly width: number }, get) =>
    Effect.gen(function* () {
      const { registry } = get;
      const held = registry.get(widthDragged);

      // A drag begun since holds a width of its own, which this leaves to it.
      const letGo = Effect.sync(() => {
        if (registry.get(widthDragged) === held) {
          registry.set(widthDragged, undefined);
        }
      });

      const width = boundedWidth(asked.option, asked.width);
      const overrides = registry.get(deviceUi)[asked.option] !== undefined;
      const device = writtenOnDevice(asked.option, width, overrides);
      const unchanged = registry.get(uiInEffect)[asked.option] === width;
      const done: Outcome = { _tag: "Done" };

      const outcome = yield* (
        unchanged
          ? Effect.succeed(done)
          : changeUi(registry, { device, option: asked.option, value: width })
      ).pipe(Effect.ensuring(letGo));

      if (outcome._tag === "SignedOut") {
        signedOut(registry);
      }
    })
  )
  .pipe(Atom.keepAlive);
