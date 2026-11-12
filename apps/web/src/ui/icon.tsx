/**
 * An icon: a named glyph in the UI's own font, drawn in a box of a fixed width, so a row
 * of them lines up whichever font draws it, and hidden from assistive technology, which
 * hears the control's name instead. Every glyph used as an icon is named here, so drawing
 * them another way, as SVG say, is a change to this file alone.
 *
 * @packageDocumentation
 */
import styles from "./icon.module.css";

/**
 * The glyphs, by name. Each is in Latin-1 or a block most monospace fonts draw, and one a
 * font lacks falls back to the system's own, in the same box.
 */
const glyphs = {
  /** Puts away what stands in front, or lets a notice go. */
  close: "×",
  /** A Network's Timelines are hidden under it. */
  collapsed: "▸",
  /** A Network connected: filled. */
  connected: "●",
  /** A Network connecting: half filled. */
  connecting: "◐",
  /** A Network's Timelines show under it. */
  expanded: "▾",
  /** Hides the sidebar, toward the side it is on. */
  hideSidebar: "«",
  /** The members, a panel at the right, as their column is. */
  members: "◨",
  /** The sidebar, as a drawer on a compact screen. */
  menu: "≡",
  /** A Network offline: empty. */
  offline: "○",
  /** The command palette, where a command starts as it does in the composer. */
  palette: "/",
  /** Shows the sidebar again, from the side it comes from. */
  showSidebar: "»",
  /** A Network stopped on purpose: a square, as a stop is drawn. */
  stopped: "■",
  /** A Network whose connection is not known yet: dotted. */
  unknown: "◌",
} as const;

/** An icon's name. */
export type IconName = keyof typeof glyphs;

/**
 * An icon.
 * @param props - Its name, and a class for its colour or place, never its size.
 * @returns The icon.
 */
export const Icon = ({
  className,
  name,
}: {
  readonly name: IconName;
  readonly className?: string | undefined;
}) => (
  <span
    aria-hidden="true"
    className={className === undefined ? styles.icon : `${styles.icon} ${className}`}
    data-icon={name}
  >
    {glyphs[name]}
  </span>
);
