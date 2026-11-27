/**
 * The box a piece of media stands in, as big as it will be drawn, so what is drawn and what
 * stands in its place until it loads share one box and nothing below it moves. Given a
 * shape, it is reserved at once as that shape, at most `--preview-media-height` tall and no
 * wider than the room it has; without one, it is a placeholder until what it holds has
 * loaded.
 *
 * @packageDocumentation
 */
import type { Size } from "@iirc/frontend/previews";
import type { CSSProperties, ReactNode, Ref } from "react";

import styles from "./media-box.module.css";

/**
 * What a box of a shape is given, for the stylesheet to size it: the shape's proportions,
 * and, for a picture, no wider than the picture itself, in CSS pixels.
 * @param size - Its shape.
 * @param atMost - How wide it is at most, in CSS pixels, if there is a limit.
 * @returns Its style.
 */
const sizeStyle = ({ height, width }: Size, atMost: number | undefined): CSSProperties => {
  const style: Record<`--${string}`, string> = {
    "--box-height": `${height}`,
    "--box-width": `${width}`,
  };

  if (atMost !== undefined) {
    style["--box-at-most"] = `${atMost}px`;
  }

  return style;
};

/**
 * A media's box. A still picture with no shape of its own takes the room it has once it
 * has loaded, since it may have no size to be as wide as.
 * @param props - Its shape, if known; whether it is no wider than that shape in pixels, as
 *   a picture is; whether what it holds has loaded; whether it holds a still picture; what
 *   it holds; and a ref to it.
 * @returns The box.
 */
export const MediaBox = ({
  children,
  loaded = true,
  reference,
  size,
  still = false,
  upToSize = false,
}: {
  readonly children?: ReactNode;
  readonly loaded?: boolean;
  readonly reference?: Ref<HTMLSpanElement>;
  readonly size: Size | undefined;
  readonly still?: boolean;
  readonly upToSize?: boolean;
}) => (
  <span
    className={styles.box}
    data-loaded={loaded}
    data-reserved={size !== undefined || undefined}
    data-still={still || undefined}
    ref={reference}
    style={size === undefined ? undefined : sizeStyle(size, upToSize ? size.width : undefined)}
  >
    {children}
  </span>
);
