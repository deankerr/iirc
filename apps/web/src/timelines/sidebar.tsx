/**
 * The sidebar: a tree of the Networks, each with how its connection stands, and their
 * Timelines under them, each coloured by what is unread in it with small counts of what
 * calls for the Owner, and the options. Choosing a Timeline opens it in the main view, and
 * Options opens the options view there. React Aria's Tree
 * gives it its keyboard: arrows move and expand, Enter or Space opens, and typing a name
 * finds it.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Level, Timeline } from "@iirc/api";
import {
  activityOf,
  callingCount,
  countText,
  labelOf,
  networkActivity,
} from "@iirc/frontend/activity";
import type { Activity } from "@iirc/frontend/activity";
import { endReason } from "@iirc/frontend/render";
import { chosenOf } from "@iirc/frontend/timelines";
import type { Connection, SidebarNetwork } from "@iirc/frontend/timelines";
import { Atom } from "effect/reactivity";
import { Button, Tree, TreeItem, TreeItemContent } from "react-aria-components";
import type { Key, Selection } from "react-aria-components";

import { openOptions } from "../options/atoms.ts";
import { open, sidebarNetworks, timelinesState } from "./atoms.ts";

import styles from "./sidebar.module.css";

/** The Networks the Owner collapsed in the sidebar. Every other is expanded. */
const collapsed = Atom.make<readonly string[]>([]).pipe(Atom.keepAlive);

/**
 * What the focused Pane shows, as the sidebar marks it: the options, or its Timeline, but
 * not a Timeline open behind the options, the search, or a Direct Message not yet begun,
 * so choosing that Timeline shows it.
 */
const selected = Atom.make((get) => chosenOf(get(timelinesState)));

// A Network's row has an id no Timeline's can have, since a Timeline's is hex and `-`.
const networkKey = (network: string) => `network:${network}`;

/** How a Network's connection stands, in a word, styled, and why when it is offline. */
interface Standing {
  readonly word: string;
  readonly className: string;
  readonly why: string | undefined;
}

/**
 * How a Network's connection stands.
 * @param network - The Network.
 * @returns Its standing.
 */
const standingOf = (network: SidebarNetwork): Standing => {
  if (network.running?._tag === "Stopped") {
    return { className: styles.offline, why: network.running.reason, word: "stopped" };
  }

  const connection: Connection = network.connection;

  switch (connection._tag) {
    case "Connected": {
      return { className: styles.connected, why: undefined, word: "connected" };
    }

    case "Connecting": {
      return { className: styles.connecting, why: undefined, word: "connecting" };
    }

    case "Offline": {
      return {
        className: styles.offline,
        why: connection.reason === undefined ? undefined : endReason(connection.reason),
        word: "offline",
      };
    }

    case "Unknown": {
      return { className: styles.connecting, why: undefined, word: "\u2026" };
    }

    default: {
      return connection satisfies never;
    }
  }
};

/** The class that colours a name by the highest level unread in it. */
const levelClass: Readonly<Record<Level | "None", string>> = {
  Activity: styles.levelActivity,
  Direct: styles.levelDirect,
  Highlight: styles.levelHighlight,
  Message: styles.levelMessage,
  None: styles.levelNone,
};

/**
 * What is unread, as small counts: Highlights and Direct Messages accented, and other
 * Messages dim, unless `calling` alone. Hidden from a screen reader, which hears the row's
 * label instead.
 * @param props - The counts, and whether to show only what calls for the Owner.
 * @returns The counts, or nothing.
 */
const Counts = ({
  activity,
  calling,
}: {
  readonly activity: Activity;
  readonly calling: boolean;
}) => {
  const calls = callingCount(activity.unread);
  const { messages } = activity.unread;

  return (
    <span aria-hidden className={styles.counts}>
      {calls > 0 ? (
        <span className={activity.unread.highlights > 0 ? styles.calling : styles.direct}>
          {countText(calls)}
        </span>
      ) : null}
      {!calling && messages > 0 ? (
        <span className={styles.messages}>{countText(messages)}</span>
      ) : null}
    </span>
  );
};

/**
 * A Timeline's row.
 * @param props - The Timeline.
 * @returns The row.
 */
const TimelineItem = ({ timeline }: { readonly timeline: Timeline }) => {
  const activity = activityOf(timeline);

  return (
    <TreeItem
      aria-label={labelOf(timeline.name, activity)}
      className={styles.item}
      id={timeline.id}
      textValue={timeline.name}
    >
      <TreeItemContent>
        <bdi
          className={`${styles.name} ${
            timeline.detached ? styles.levelNone : levelClass[activity.level ?? "None"]
          }`}
        >
          {timeline.name}
        </bdi>
        <Counts activity={activity} calling={false} />
      </TreeItemContent>
    </TreeItem>
  );
};

/**
 * A Network's row: its id, coloured by the highest level unread in any of its Timelines,
 * what calls for the Owner in them, and how its connection stands.
 * @param props - The Network, and whether its Timelines are shown.
 * @returns The row's content.
 */
const NetworkRow = ({
  expandable,
  expanded,
  network,
}: {
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly network: SidebarNetwork;
}) => {
  const activity = networkActivity(network);
  const standing = standingOf(network);

  return (
    <>
      {expandable ? (
        <Button className={styles.chevron} slot="chevron">
          <span aria-hidden>{expanded ? "\u25BE" : "\u25B8"}</span>
        </Button>
      ) : (
        <span className={styles.chevron} />
      )}
      <span className={`${styles.name} ${levelClass[activity.level ?? "None"]}`}>
        {network.network}
      </span>
      <Counts activity={activity} calling />
      <span className={standing.className} title={standing.why}>
        {standing.word}
      </span>
    </>
  );
};

/**
 * The tree of Networks and their Timelines.
 * @returns The sidebar.
 */
export const Sidebar = () => {
  const networks = useAtomValue(sidebarNetworks);
  const hidden = useAtomValue(collapsed);
  const chosen = useAtomValue(selected);
  const setCollapsed = useAtomSet(collapsed);
  const choose = useAtomSet(open);
  const showOptions = useAtomSet(openOptions);
  const optionsShown = chosen._tag === "Options";

  // A key is read back as the Timeline it names, never cast: a key that names none, such
  // as a Network's row, opens nothing.
  const timelineOf = (key: Key) =>
    networks.flatMap((network) => network.timelines).find((timeline) => timeline.id === key);

  const onSelectionChange = (selection: Selection) => {
    const [key] = selection === "all" ? [] : selection;
    const timeline = key === undefined ? undefined : timelineOf(key);

    if (timeline !== undefined) {
      choose(timeline.id);
    }
  };

  const onExpandedChange = (keys: Set<Key>) => {
    setCollapsed(
      networks.map((network) => network.network).filter((network) => !keys.has(networkKey(network)))
    );
  };

  return (
    <nav aria-label="Networks" className={styles.sidebar}>
      <Button
        aria-current={optionsShown ? "page" : false}
        className={styles.options}
        onPress={() => {
          showOptions("");
        }}
      >
        Options
      </Button>
      <h2 className={styles.heading}>Networks</h2>
      {networks.length === 0 ? (
        <p className={styles.muted}>No Networks are configured yet.</p>
      ) : (
        <Tree
          aria-label="Networks and their Timelines"
          className={styles.tree}
          disabledBehavior="selection"
          disabledKeys={networks.map((network) => networkKey(network.network))}
          expandedKeys={networks
            .filter((network) => !hidden.includes(network.network))
            .map((network) => networkKey(network.network))}
          onExpandedChange={onExpandedChange}
          onSelectionChange={onSelectionChange}
          selectedKeys={chosen._tag === "Timeline" ? [chosen.timeline] : []}
          selectionMode="single"
        >
          {networks.map((network) => (
            <TreeItem
              aria-label={`${labelOf(network.network, networkActivity(network))}, ${standingOf(network).word}`}
              className={styles.network}
              id={networkKey(network.network)}
              key={network.network}
              textValue={network.network}
            >
              <TreeItemContent>
                {({ hasChildItems, isExpanded }) => (
                  <NetworkRow expandable={hasChildItems} expanded={isExpanded} network={network} />
                )}
              </TreeItemContent>
              {network.timelines.map((timeline) => (
                <TimelineItem key={timeline.id} timeline={timeline} />
              ))}
            </TreeItem>
          ))}
        </Tree>
      )}
    </nav>
  );
};
