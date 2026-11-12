/**
 * A Pane's status bar, over its open Timeline: one line across the Pane, with its number
 * among several, the Timeline's name, dim in a Pane without the focus, and what it says
 * beside it. A Channel's says its modes, where Self stands when not in it, and its topic, cut
 * to the line, which a press discloses in full under the bar, wrapped, saying in its place
 * who set it and when, and at the right the members' toggle, which says how many there are. A Direct Message's says
 * so, or why it no longer follows its partner, and a Network's how its connection stands.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Header, TopicShown } from "@iirc/frontend/channel";
import { useState } from "react";
import {
  Button as AriaButton,
  Disclosure,
  DisclosurePanel,
  ToggleButton,
} from "react-aria-components";

import { alone, focusedId, paneNumber } from "../panes/atoms.ts";
import { paneTimeline } from "../timelines/atoms.ts";
import { Inlines } from "../timelines/inlines.tsx";
import { formattedAt } from "../ui/dates.ts";
import { timelineHeader } from "./atoms.ts";
import { membersOpen, toggleMembers } from "./state.ts";

import styles from "./timeline-header.module.css";

// The Owner's own clock and time zone, which only the view reads.
const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The glyph the members' toggle shows: a panel at the right, as the column is. */
const membersGlyph = "◨";

/**
 * Who set a topic, and when, in a few dim words.
 * @param topic - The topic.
 * @returns The words, or none when neither is known.
 */
const setText = (topic: Extract<TopicShown, { readonly _tag: "Set" }>) => {
  const when = topic.at === undefined ? undefined : formattedAt(day, topic.at);

  if (topic.by === undefined) {
    return when === undefined ? undefined : `set ${when}`;
  }

  return when === undefined ? `set by ${topic.by}` : `set by ${topic.by}, ${when}`;
};

/**
 * A topic in full, wrapped, and whether it is as last known, under the bar. The panel is
 * there before any topic is, since React Aria hides only a panel it found as it started.
 * @param props - The topic, if one is set.
 * @returns The panel.
 */
const TopicPanel = ({ topic }: { readonly topic: TopicShown | undefined }) => (
  <DisclosurePanel>
    {topic?._tag === "Set" ? (
      <p className={styles.full}>
        <bdi>
          <Inlines inlines={topic.inlines} />
        </bdi>
        {topic.stale ? <span className={styles.dim}> (as last known)</span> : null}
      </p>
    ) : null}
  </DisclosurePanel>
);

/**
 * What a Channel's bar says of its topic: nothing while it is unknown, that none is set,
 * or the topic on one line, which a press discloses in full under the bar, saying in its
 * place who set it and when.
 * @param props - The topic, and whether it is disclosed.
 * @returns The topic's part of the bar.
 */
const TopicLine = ({ open, topic }: { readonly topic: TopicShown; readonly open: boolean }) => {
  switch (topic._tag) {
    case "Unknown": {
      return null;
    }

    case "None": {
      return <span className={`${styles.dim} ${styles.rest}`}>no topic</span>;
    }

    case "Set": {
      return (
        <AriaButton className={styles.topic} slot="trigger">
          {open ? (
            <bdi className={styles.dim}>{setText(topic) ?? "the topic"}</bdi>
          ) : (
            <bdi>
              <Inlines inlines={topic.inlines} />
            </bdi>
          )}
        </AriaButton>
      );
    }

    default: {
      return topic satisfies never;
    }
  }
};

/**
 * The toggle that shows or hides a Pane's members, saying how many there are: beside the
 * Timeline, over it in a narrow Pane, or as a sheet over it on a compact screen.
 * @param props - The Pane, and how many members its Channel has, if known.
 * @returns The toggle.
 */
const MembersToggle = ({
  count,
  pane,
}: {
  readonly pane: string;
  readonly count: number | undefined;
}) => {
  const shown = useAtomValue(membersOpen(pane));
  const toggle = useAtomSet(toggleMembers);

  return (
    <ToggleButton
      aria-label={count === undefined ? "Members" : `Members, ${count}`}
      className={styles.toggle}
      // Which Pane's toggle this is, so a press on it is not a press outside its members.
      data-members-toggle={pane}
      isSelected={shown}
      onChange={(isSelected) => {
        toggle({ pane, shown: isSelected });
      }}
    >
      <span aria-hidden>{membersGlyph}</span>
      {count === undefined ? null : <span>{count}</span>}
    </ToggleButton>
  );
};

/**
 * What a Header says after its name, on the bar's one line.
 * @param props - The header, the Pane, and whether its topic is disclosed.
 * @returns Its details.
 */
const Details = ({
  header,
  open,
  pane,
}: {
  readonly header: Header;
  readonly pane: string;
  readonly open: boolean;
}) => {
  switch (header._tag) {
    case "Channel": {
      return (
        <>
          {header.modes === undefined ? null : (
            <bdi className={`${styles.dim} ${styles.modes}`}>{header.modes}</bdi>
          )}
          {header.note === undefined ? (
            <TopicLine open={open} topic={header.topic} />
          ) : (
            <span className={`${styles.note} ${styles.rest}`}>{header.note}</span>
          )}
          <MembersToggle count={header.members} pane={pane} />
        </>
      );
    }

    case "Direct": {
      return header.note === undefined ? (
        <span className={`${styles.dim} ${styles.rest}`}>Direct Message</span>
      ) : (
        <span className={`${styles.note} ${styles.rest}`}>{header.note}</span>
      );
    }

    case "Network": {
      return <span className={`${styles.dim} ${styles.rest}`}>{header.status}</span>;
    }

    default: {
      return header satisfies never;
    }
  }
};

/**
 * A Pane's status bar, while it shows a Timeline.
 * @param props - The Pane.
 * @returns The bar, or nothing.
 */
export const TimelineHeader = ({ pane }: { readonly pane: string }) => {
  const shown = useAtomValue(paneTimeline(pane));
  const header = useAtomValue(timelineHeader(pane));
  const number = useAtomValue(paneNumber(pane));
  const focused = useAtomValue(focusedId) === pane;
  const one = useAtomValue(alone);
  // Whether the topic is disclosed, closed again for each Timeline the Pane opens.
  const [disclosed, setDisclosed] = useState<{ readonly timeline: string } | undefined>();

  if (shown._tag !== "Shown") {
    return null;
  }

  const name = header?.name ?? shown.description?.name ?? "Timeline";
  const topic = header?._tag === "Channel" && header.note === undefined ? header.topic : undefined;
  const open = disclosed?.timeline === shown.timeline;

  return (
    <header className={styles.header} data-dim={number !== undefined && !one && !focused}>
      <Disclosure
        className={styles.disclosure}
        isExpanded={open}
        onExpandedChange={(expanded) => {
          setDisclosed(expanded ? { timeline: shown.timeline } : undefined);
        }}
      >
        <div className={styles.line}>
          {number === undefined ? null : (
            <span className={styles.dim} title={`Pane ${number}`}>
              {number}
            </span>
          )}
          <h2 className={styles.name}>
            <bdi>{name}</bdi>
          </h2>
          {header === undefined ? null : <Details header={header} open={open} pane={pane} />}
        </div>
        <TopicPanel topic={topic} />
      </Disclosure>
    </header>
  );
};
