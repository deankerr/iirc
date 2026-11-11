/**
 * What a Pane's open Timeline shows at its head: a Channel's name, its topic, formatted, with
 * who set it and when, dim, how many members it has, its modes, and where Self stands when
 * not in it; a Direct Message's partner; or a Network's id and how its connection stands.
 * A Channel's header has the members' toggle beside it.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Header, TopicShown } from "@iirc/frontend/channel";
import { ToggleButton } from "react-aria-components";

import { perform } from "../composer/atoms.ts";
import { Inlines } from "../timelines/inlines.tsx";
import { formattedAt } from "../ui/dates.ts";
import { timelineHeader } from "./atoms.ts";
import { membersVisible } from "./state.ts";

import styles from "./timeline-header.module.css";

// The Owner's own clock and time zone, which only the view reads.
const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

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
 * A Channel's topic.
 * @param props - The topic.
 * @returns The topic, or nothing while unknown.
 */
const Topic = ({ topic }: { readonly topic: TopicShown }) => {
  switch (topic._tag) {
    case "Unknown": {
      return null;
    }

    case "None": {
      return <p className={styles.dim}>No topic is set.</p>;
    }

    case "Set": {
      const set = setText(topic);

      return (
        <p className={styles.topic}>
          <bdi>
            <Inlines inlines={topic.inlines} />
          </bdi>
          {set === undefined ? null : (
            <span className={styles.dim}>
              {" "}
              — <bdi>{set}</bdi>
            </span>
          )}
          {topic.stale ? <span className={styles.dim}> (as last known)</span> : null}
        </p>
      );
    }

    default: {
      return topic satisfies never;
    }
  }
};

/**
 * The toggle that shows or hides the members, as `/members` does: the column beside the
 * Channel, or the sheet over it on a compact screen.
 * @returns The toggle.
 */
const MembersToggle = () => {
  const shown = useAtomValue(membersVisible);
  const run = useAtomSet(perform);

  return (
    <ToggleButton
      className={styles.toggle}
      isSelected={shown}
      onChange={(isSelected) => {
        run([{ _tag: "ShowMembers", shown: isSelected }]);
      }}
    >
      members
    </ToggleButton>
  );
};

/**
 * What a Header says beside its name.
 * @param props - The header.
 * @returns Its details.
 */
const Details = ({ header }: { readonly header: Header }) => {
  switch (header._tag) {
    case "Channel": {
      return (
        <>
          {header.members === undefined ? null : (
            <span className={styles.dim}>
              {header.members === 1 ? "1 member" : `${header.members} members`}
            </span>
          )}
          {header.modes === undefined ? null : <bdi className={styles.dim}>{header.modes}</bdi>}
          {header.note === undefined ? null : <span className={styles.note}>{header.note}</span>}
        </>
      );
    }

    case "Direct": {
      return header.note === undefined ? (
        <span className={styles.dim}>Direct Message</span>
      ) : (
        <span className={styles.note}>{header.note}</span>
      );
    }

    case "Network": {
      return <span className={styles.dim}>{header.status}</span>;
    }

    default: {
      return header satisfies never;
    }
  }
};

/**
 * A Pane's open Timeline's header.
 * @param props - The Pane, the name to show until the header is known, and its number
 * among several Panes, if there are several.
 * @returns The header.
 */
export const TimelineHeader = ({
  name,
  number,
  pane,
}: {
  readonly name: string;
  readonly number: number | undefined;
  readonly pane: string;
}) => {
  const header = useAtomValue(timelineHeader(pane));

  return (
    <header className={styles.header}>
      <div className={styles.line}>
        {number === undefined ? null : (
          <span className={styles.dim} title={`Pane ${number}`}>
            {number}
          </span>
        )}
        <h2 className={styles.name}>
          <bdi>{header?.name ?? name}</bdi>
        </h2>
        {header === undefined ? null : <Details header={header} />}
        {header?._tag === "Channel" ? <MembersToggle /> : null}
      </div>
      {header?._tag === "Channel" ? <Topic topic={header.topic} /> : null}
    </header>
  );
};
