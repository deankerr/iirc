/**
 * Formatted text as React elements: each run a text node in a span whose classes say its
 * style, and each link an anchor that opens in a new tab, with whatever its caller puts after
 * it, such as a Preview's toggle. Nothing a Network sent is ever
 * markup: it is only ever a text node's text, or a link's `href` the core parsed.
 *
 * @packageDocumentation
 */
import { useAtomValue } from "@effect/atom-react";
import type { Inline, Style } from "@iirc/frontend/render";
import { runColours } from "@iirc/frontend/theme";
import type { Drawn } from "@iirc/frontend/theme";
import { Fragment } from "react";
import type { CSSProperties, ReactNode } from "react";

import { drawnTheme } from "../theme/atoms.ts";

import styles from "./inlines.module.css";

/**
 * The classes and colours of a style. Colours are set as properties on the element, which
 * a strict Content Security Policy allows, never as a style sheet or attribute text, and
 * are the core's, kept readable in the theme drawn.
 * @param style - The style.
 * @param theme - The theme drawn.
 * @returns The class names and the colours.
 */
const styled = (style: Style, theme: Drawn) => {
  const flags: readonly (readonly [boolean, string])[] = [
    [style.bold, styles.bold],
    [style.italic, styles.italic],
    [style.underline, styles.underline],
    [style.strikethrough, styles.strikethrough],
    [style.monospace, styles.monospace],
    [style.reverse, styles.reverse],
  ];

  const classes = flags.flatMap(([on, name]) => (on ? [name] : []));
  const colours: CSSProperties = runColours(style, theme);

  return { className: classes.join(" "), colours };
};

/**
 * Formatted text.
 * @param props - The inlines; whether a link is drawn as one: not inside something that
 * is itself pressed, such as a button, where a link's text is drawn as any other run; and
 * what is drawn after a link, by its run's index, if anything.
 * @returns Each run, in order.
 */
export const Inlines = ({
  after,
  inlines,
  links = true,
}: {
  readonly after?: ReadonlyMap<number, ReactNode>;
  readonly inlines: readonly Inline[];
  readonly links?: boolean;
}) => {
  const theme = useAtomValue(drawnTheme);

  return inlines.map((inline, index) => {
    const { className, colours } = styled(inline.style, theme);

    return inline._tag === "Link" && links ? (
      // The runs of one text never move, so their order is their identity.
      // oxlint-disable-next-line react/no-array-index-key
      <Fragment key={index}>
        <a
          className={`${styles.link} ${className}`}
          href={inline.href}
          rel="noopener noreferrer"
          style={colours}
          target="_blank"
        >
          {inline.text}
        </a>
        {after?.has(index) === true ? (
          // A word joiner, so what follows a link never wraps away from it.
          <>
            {"\u2060"}
            {after.get(index)}
          </>
        ) : null}
      </Fragment>
    ) : (
      // oxlint-disable-next-line react/no-array-index-key
      <span className={className} key={index} style={colours}>
        {inline.text}
      </span>
    );
  });
};
