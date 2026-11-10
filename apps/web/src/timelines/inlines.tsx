/**
 * Formatted text as React elements: each run a text node in a span whose classes say its
 * style, and each link an anchor that opens in a new tab. Nothing a Network sent is ever
 * markup: it is only ever a text node's text, or a link's `href` the core parsed.
 *
 * @packageDocumentation
 */
import type { Colour, Inline, Style } from "@iirc/frontend/render";
import type { CSSProperties } from "react";

import styles from "./inlines.module.css";

// mIRC's colours 16 to 98, as https://modern.ircdocs.horse/formatting#colors gives them.
// Colours 0 to 15 are the theme's, as `--irc-0` to `--irc-15`.
const extended: readonly string[] = [
  "470000",
  "472100",
  "474700",
  "324700",
  "004700",
  "00472c",
  "004747",
  "002747",
  "000047",
  "2e0047",
  "470047",
  "47002a",
  "740000",
  "743a00",
  "747400",
  "517400",
  "007400",
  "007449",
  "007474",
  "004074",
  "000074",
  "4b0074",
  "740074",
  "740045",
  "b50000",
  "b56300",
  "b5b500",
  "7db500",
  "00b500",
  "00b571",
  "00b5b5",
  "0063b5",
  "0000b5",
  "7500b5",
  "b500b5",
  "b5006b",
  "ff0000",
  "ff8c00",
  "ffff00",
  "b2ff00",
  "00ff00",
  "00ffa0",
  "00ffff",
  "008cff",
  "0000ff",
  "a500ff",
  "ff00ff",
  "ff0098",
  "ff5959",
  "ffb459",
  "ffff71",
  "cfff60",
  "6fff6f",
  "65ffc9",
  "6dffff",
  "59b4ff",
  "5959ff",
  "c459ff",
  "ff66ff",
  "ff59bc",
  "ff9c9c",
  "ffd39c",
  "ffff9c",
  "e2ff9c",
  "9cff9c",
  "9cffdb",
  "9cffff",
  "9cd3ff",
  "9c9cff",
  "dc9cff",
  "ff9cff",
  "ff94d3",
  "000000",
  "131313",
  "282828",
  "363636",
  "4d4d4d",
  "656565",
  "818181",
  "9f9f9f",
  "bcbcbc",
  "e2e2e2",
  "ffffff",
];

const themed = 16;

/**
 * A colour as a CSS value: one of the theme's sixteen, mIRC's extended palette, or hex.
 * @param colour - The colour a Network asked for.
 * @returns The CSS value, or `undefined` for the default.
 */
const cssColour = (colour: Colour | undefined): string | undefined => {
  if (colour === undefined) {
    return undefined;
  }

  if (colour._tag === "Hex") {
    return `#${colour.hex}`;
  }

  if (colour.index < themed) {
    return `var(--irc-${colour.index})`;
  }

  const hex = extended[colour.index - themed];

  return hex === undefined ? undefined : `#${hex}`;
};

/**
 * The classes and colours of a style. Colours are set as properties on the element, which
 * a strict Content Security Policy allows, never as a style sheet or attribute text.
 * @param style - The style.
 * @returns The class names and the colours.
 */
const styled = (style: Style) => {
  const flags: readonly (readonly [boolean, string])[] = [
    [style.bold, styles.bold],
    [style.italic, styles.italic],
    [style.underline, styles.underline],
    [style.strikethrough, styles.strikethrough],
    [style.monospace, styles.monospace],
    [style.reverse, styles.reverse],
  ];

  const classes = flags.flatMap(([on, name]) => (on ? [name] : []));
  const foreground = cssColour(style.foreground);
  const background = cssColour(style.background);

  // Reverse swaps the colours in force, the default ones included.
  const colours: CSSProperties = style.reverse
    ? {
        ...(background !== undefined && { color: background }),
        ...(foreground !== undefined && { backgroundColor: foreground }),
      }
    : {
        ...(foreground !== undefined && { color: foreground }),
        ...(background !== undefined && { backgroundColor: background }),
      };

  return { className: classes.join(" "), colours };
};

/**
 * Formatted text.
 * @param props - The inlines.
 * @returns Each run, in order.
 */
export const Inlines = ({ inlines }: { readonly inlines: readonly Inline[] }) =>
  inlines.map((inline, index) => {
    const { className, colours } = styled(inline.style);

    return inline._tag === "Link" ? (
      <a
        className={`${styles.link} ${className}`}
        // The runs of one text never move, so their order is their identity.
        // oxlint-disable-next-line react/no-array-index-key
        key={index}
        href={inline.href}
        rel="noopener noreferrer"
        style={colours}
        target="_blank"
      >
        {inline.text}
      </a>
    ) : (
      // oxlint-disable-next-line react/no-array-index-key
      <span className={className} key={index} style={colours}>
        {inline.text}
      </span>
    );
  });
