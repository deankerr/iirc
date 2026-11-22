/**
 * The grip on a width the Owner drags, the nick column's rule or the members' panel's
 * edge, as the Sidebar's edge is dragged: a window splitter that the pointer drags, or that
 * the arrows, Home, and End move once focused. A drag draws the width as it goes, in whole
 * `0`s of the font, and writes the option once, as the pointer lets go. A drag the browser
 * cancels writes nothing.
 *
 * @packageDocumentation
 */
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useContext, useEffect, useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

import {
  boundedWidth,
  dropDrag,
  resizeWidth,
  widthBounds,
  widthDragged,
  widthsShown,
} from "../options/widths.ts";
import type { WidthOption } from "../options/widths.ts";

import styles from "./column-edge.module.css";

/** How far one arrow moves a grip, and one with Shift held, in the font's own `0`. */
const step = 1;
const bigStep = 4;

/**
 * Where a key moves a width to: an arrow a step toward its side, or with Shift a bigger
 * one, and Home and End to the narrowest and widest.
 * @param key - The key, as the browser names it.
 * @param width - The width now.
 * @param shift - Whether Shift is held.
 * @param grows - The side whose arrow widens it.
 * @param option - The option.
 * @returns The width asked for, or none when the key does not move it.
 */
const keyMoved = (
  key: string,
  width: number,
  shift: boolean,
  grows: Side,
  option: WidthOption
): number | undefined => {
  const by = (shift ? bigStep : step) * (grows === "Right" ? 1 : -1);

  switch (key) {
    case "ArrowLeft": {
      return width - by;
    }

    case "ArrowRight": {
      return width + by;
    }

    case "Home": {
      return widthBounds[option].minimum;
    }

    case "End": {
      return widthBounds[option].maximum;
    }

    default: {
      return undefined;
    }
  }
};

/** The side a grip is dragged toward to widen what it resizes. */
type Side = "Left" | "Right";

/** Where a drag began: the pointer's x, the width then, and how wide a `0` is, in pixels. */
interface Drag {
  readonly x: number;
  readonly width: number;
  readonly zero: number;
}

/**
 * A grip on a width.
 * @param props - The option it resizes, the side it widens toward, its label, and a class
 * that places it.
 * @returns The grip, and the unseen measure of a `0` beside it.
 */
export const ColumnEdge = ({
  className,
  grows,
  label,
  onHeld,
  option,
}: {
  readonly className: string;
  readonly grows: Side;
  readonly label: string;
  /** Told as a drag of this grip begins and ends, so what holds it can keep it in place. */
  readonly onHeld?: (held: boolean) => void;
  readonly option: WidthOption;
}) => {
  const width = useAtomValue(widthsShown)[option];
  const resize = useAtomSet(resizeWidth(option));
  const registry = useContext(RegistryContext);
  const zero = useRef<HTMLSpanElement>(null);
  // Where a drag began. A ref, since a drag is no state anything else derives from.
  const dragged = useRef<Drag | undefined>(undefined);
  const { maximum, minimum } = widthBounds[option];

  // A grip that goes mid-drag lets go of what it held, unwritten.
  useEffect(
    () => () => {
      if (dragged.current !== undefined) {
        dragged.current = undefined;
        onHeld?.(false);
        dropDrag(registry, option);
      }
    },
    [onHeld, option, registry]
  );

  const onPointerDown = (event: PointerEvent<HTMLHRElement>) => {
    const measured = (zero.current?.getBoundingClientRect().width ?? 0) / 100;

    if (event.button !== 0 || measured <= 0) {
      return;
    }

    // Nothing under the grip is selected, and nothing scrolls, while it is dragged.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragged.current = { width, x: event.clientX, zero: measured };
    onHeld?.(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLHRElement>) => {
    const from = dragged.current;

    if (from !== undefined) {
      const moved = ((event.clientX - from.x) / from.zero) * (grows === "Right" ? 1 : -1);

      registry.set(widthDragged, { option, width: boundedWidth(option, from.width + moved) });
    }
  };

  // Letting go writes the width drawn, and nothing else ends a drag but drops it unwritten:
  // the browser cancelling it, or the capture lost without a release.
  const onPointerUp = () => {
    if (dragged.current !== undefined) {
      dragged.current = undefined;
      onHeld?.(false);
      resize(registry.get(widthsShown)[option]);
    }
  };

  const onPointerDropped = () => {
    if (dragged.current !== undefined) {
      dragged.current = undefined;
      onHeld?.(false);
      dropDrag(registry, option);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLHRElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    const next = keyMoved(event.key, width, event.shiftKey, grows, option);

    if (next !== undefined) {
      event.preventDefault();
      resize(next);
    }
  };

  // A focusable separator with a value is the WAI-ARIA window splitter, an interactive
  // widget the rules below do not know.
  /* oxlint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions */
  return (
    <>
      <hr
        aria-label={label}
        aria-orientation="vertical"
        aria-valuemax={maximum}
        aria-valuemin={minimum}
        aria-valuenow={width}
        className={`${styles.edge} ${className}`}
        onKeyDown={onKeyDown}
        onLostPointerCapture={onPointerDropped}
        onPointerCancel={onPointerDropped}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        tabIndex={0}
      />
      <span aria-hidden className={styles.zero} ref={zero} />
    </>
  );
  /* oxlint-enable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions */
};
