/**
 * An icon: a named glyph in the UI's own font, or a drawing, in a box of a fixed width, so
 * a row of them lines up whichever font draws it, and hidden from assistive technology,
 * which hears the control's name instead. Every icon is named here, so drawing one another
 * way is a change to this file alone.
 *
 * @packageDocumentation
 */
import type { ReactElement, ReactNode } from "react";

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
  /** A Network's Timelines are hidden under it. */
  collapsed: "▸",
  /** Starts a command in the composer, as a `/` begins one. */
  command: "/",
  /** A Network connecting: half filled. */
  connecting: "◐",
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
  /** Picks a row up, to move it with the keys: up and down. */
  move: "↕",
  /** A Timeline muted, which counts nothing: the empty set. */
  muted: "∅",
  /** A Network offline: empty. */
  offline: "○",
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

/**
 * The drawings, by name, each on a 16 by 16 grid in the text's colour. They are the icons
 * drawn over media or in a Preview's controls, where a glyph's size and place in its box
 * would depend on the font that draws it, so each is the same size, centred in its control,
 * in any font.
 */
/**
 * A drawing on the grid, as tall and wide as the text.
 * @param props - What is drawn.
 * @returns The drawing.
 */
const Drawing = ({ children }: { readonly children: ReactElement }) => (
  <svg className={styles.drawing} viewBox="0 0 16 16">
    {children}
  </svg>
);

const drawings = {
  /** Puts away what stands in front, or lets a notice go. */
  close: (
    <Drawing>
      <path
        d="M4 4 12 12M12 4 4 12"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
    </Drawing>
  ),
  /** Opens an image or a video over the whole screen: arrows pointing out. */
  enlarge: (
    <Drawing>
      <path
        d="M9 3h4v4M13 3 3 13M7 13H3V9"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </Drawing>
  ),
  /** Collapses a card shown whole: two chevrons pointing in, toward each other. */
  fold: (
    <Drawing>
      <path
        d="M4.5 2.5 8 6l3.5-3.5M4.5 13.5 8 10l3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </Drawing>
  ),
  /** Plays what it is over, as a play button is drawn: its weight in the middle. */
  play: (
    <Drawing>
      <path d="M5.5 3.5 13 8l-7.5 4.5z" fill="currentColor" />
    </Drawing>
  ),
  /** A link's Preview is hidden: a solid caret pointing at where it would open. */
  previewHidden: (
    <Drawing>
      <path d="M6 3.5 11 8l-5 4.5z" fill="currentColor" />
    </Drawing>
  ),
  /** A link's Preview shows under its Message: a solid caret pointing down at it. */
  previewShown: (
    <Drawing>
      <path d="M3.5 6 8 11l4.5-5z" fill="currentColor" />
    </Drawing>
  ),
  /** Shows a card whole: two chevrons pointing out, away from each other. */
  unfold: (
    <Drawing>
      <path
        d="M4.5 6 8 2.5 11.5 6M4.5 10 8 13.5l3.5-3.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </Drawing>
  ),
} as const satisfies Readonly<Record<string, ReactElement>>;

/** An icon's name. */
export type IconName = keyof typeof glyphs | keyof typeof drawings;

const icons: Readonly<Record<IconName, ReactNode>> = { ...glyphs, ...drawings };

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
    {icons[name]}
  </span>
);
