/**
 * iirc's own view, labelled `iirc`, which a Pane with nothing open shows: a banner, `iirc`
 * drawn in blocks with the Daemon's version under it, then the Tail's lines at the level
 * `ui.tail` names and above, oldest first, each its time, its words, its annotations,
 * dimmer, and its cause. A line at Warn and above is drawn in the theme's colour for
 * danger. Everything a line holds is text, never markup. The banner stands above the oldest line and scrolls with
 * the lines, and the view stays at the latest line while the Owner is there, as a Timeline
 * does, by the scroller's reversed column. While no Network is configured, how to start
 * follows the banner.
 *
 * @packageDocumentation
 */
import { useAtomValue } from "@effect/atom-react";
import type { TailLine } from "@iirc/api";
import { contained } from "@iirc/frontend/render";
import { atLeast } from "@iirc/frontend/tail";
import { Atom } from "effect/reactivity";

import { listedNetworks, sidebarNetworks } from "../timelines/atoms.ts";
import { Time } from "../timelines/line.tsx";
import { tailShown, tailVersion } from "./atoms.ts";

import styles from "./tail-view.module.css";

/** `iirc`, in blocks, as the banner draws it. */
const art = [
  "██╗██╗██████╗  ██████╗",
  "██║██║██╔══██╗██╔════╝",
  "██║██║██████╔╝██║     ",
  "██║██║██╔══██╗██║     ",
  "██║██║██║  ██║╚██████╗",
  "╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝",
].join("\n");

/** How to start, while no Network is configured. */
const hint =
  "Choose a Timeline, or add a Network with /network add <id> <host>[/port] [plain] <nick>. /set opens the options.";

/**
 * Whether no Network is configured, as the Network list read says: none until it is read,
 * and a Network removed with its Timelines kept is not one.
 */
const noNetworks = Atom.make(
  (get) => get(listedNetworks) && get(sidebarNetworks).every((network) => network.removed)
);

/**
 * One line of the Tail.
 * @param props - The line.
 * @returns The line.
 */
const Line = ({ line }: { readonly line: TailLine }) => (
  <li
    className={styles.line}
    data-level={line.level}
    data-warning={atLeast(line.level, "Warn") ? "" : undefined}
  >
    <Time at={line.at} className={styles.time} />
    <span className={styles.text}>
      <bdi className={styles.message}>{contained(line.message)}</bdi>
      {Object.entries(line.annotations).map(([name, value]) => (
        <bdi className={styles.annotation} key={name}>
          {contained(`${name}=${value}`)}
        </bdi>
      ))}
      {line.cause === undefined ? null : (
        <span className={styles.cause}>
          {/* A cause may run to several lines, as a trace does, each kept as a line. */}
          {line.cause.split("\n").map((part, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- a cause's lines have no other name, and never move.
            <bdi className={styles.causeLine} key={index}>
              {contained(part)}
            </bdi>
          ))}
        </span>
      )}
    </span>
  </li>
);

/**
 * The view: the banner, how to start while no Network is configured, and the Tail.
 * @returns The view.
 */
export const TailView = () => {
  const version = useAtomValue(tailVersion);
  const lines = useAtomValue(tailShown);
  const none = useAtomValue(noNetworks);

  return (
    <section aria-label="iirc" className={styles.view}>
      <div
        aria-label="What the Daemon logged"
        className={styles.scroller}
        role="log"
        // The log scrolls by keyboard, as any page does.
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
      >
        <div className={styles.content}>
          <header className={styles.banner}>
            <h2 aria-label="iirc" className={styles.heading}>
              <pre aria-hidden className={styles.art}>
                {art}
              </pre>
            </h2>
            <p className={styles.version}>{version ?? "…"}</p>
          </header>
          {none ? <p className={styles.hint}>{hint}</p> : null}
          <ol className={styles.lines}>
            {lines.map((line) => (
              <Line key={line.n} line={line} />
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
};
