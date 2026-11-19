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
  /** Adds files to the composer, to upload. */
  attach: "+",
  /** Takes a photo with the device's camera, as a lens is drawn. */
  camera: "◉",
  /** The choice in force among a few, as a menu marks it. */
  chosen: "✓",
  /** Puts away what stands in front, or lets a notice go. */
  close: "×",
  /** A Network's Timelines are hidden under it. */
  collapsed: "▸",
  /** Starts a command in the composer, as a `/` begins one. */
  command: "/",
  /** A Network connected: filled. */
  connected: "●",
  /** A Network connecting: half filled. */
  connecting: "◐",
  /** Opens an image over the whole screen: arrows pointing out. */
  enlarge: "⤢",
  /** A Network's Timelines show under it. */
  expanded: "▾",
  /** An Upload of a type no thumbnail is drawn for: a page of lines. */
  file: "▤",
  /** Hides the sidebar, toward the side it is on. */
  hideSidebar: "«",
  /** The members, a panel at the right, as their column is. */
  members: "◨",
  /** The sidebar, as a drawer on a compact screen. */
  menu: "≡",
  /** Opens a row's menu of what can be done with it. */
  more: "…",
  /** A Network offline: empty. */
  offline: "○",
  /** Plays an animated image, as a play button is drawn. */
  play: "▶",
  /** A Network removed, whose Timelines are kept to read: a circle struck through. */
  removed: "⊘",
  /** Sends what the Composer holds, as a return key is drawn. */
  send: "↵",
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
