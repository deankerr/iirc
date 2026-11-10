/**
 * The sidebar: a tree of the Networks, each with how its connection stands, and their
 * Timelines under them. Choosing a Timeline opens it in the main view. React Aria's Tree
 * gives it its keyboard: arrows move and expand, Enter or Space opens, and typing a name
 * finds it.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Timeline } from "@iirc/api";
import { endReason } from "@iirc/frontend/render";
import type { Connection, SidebarNetwork } from "@iirc/frontend/timelines";
import { Atom } from "effect/reactivity";
import { Button, Tree, TreeItem, TreeItemContent } from "react-aria-components";
import type { Key, Selection } from "react-aria-components";

import { open, sidebarNetworks, timelinesState } from "./atoms.ts";

import styles from "./sidebar.module.css";

/** The Networks the Owner collapsed in the sidebar. Every other is expanded. */
const collapsed = Atom.make<readonly string[]>([]).pipe(Atom.keepAlive);

/** The Timeline opened, as the sidebar marks it. */
const selected = Atom.make((get) => get(timelinesState).open);

// A Network's row has an id no Timeline's can have, since a Timeline's is hex and `-`.
const networkKey = (network: string) => `network:${network}`;

/**
 * How a Network's connection stands, in a word, and why when it is offline.
 * @param props - The Network.
 * @returns The status.
 */
const Status = ({ network }: { readonly network: SidebarNetwork }) => {
  if (network.running?._tag === "Stopped") {
    return (
      <span className={styles.offline} title={network.running.reason}>
        stopped
      </span>
    );
  }

  const connection: Connection = network.connection;

  switch (connection._tag) {
    case "Connected": {
      return <span className={styles.connected}>connected</span>;
    }

    case "Connecting": {
      return <span className={styles.connecting}>connecting</span>;
    }

    case "Offline": {
      return (
        <span
          className={styles.offline}
          title={connection.reason === undefined ? undefined : endReason(connection.reason)}
        >
          offline
        </span>
      );
    }

    case "Unknown": {
      return <span className={styles.connecting}>…</span>;
    }

    default: {
      return connection satisfies never;
    }
  }
};

/**
 * A Timeline's row.
 * @param props - The Timeline.
 * @returns The row.
 */
const TimelineItem = ({ timeline }: { readonly timeline: Timeline }) => (
  <TreeItem className={styles.item} id={timeline.id} textValue={timeline.name}>
    <TreeItemContent>
      <bdi className={timeline.kind === "Network" || timeline.detached ? styles.muted : undefined}>
        {timeline.name}
      </bdi>
    </TreeItemContent>
  </TreeItem>
);

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
          selectedKeys={chosen === undefined ? [] : [chosen]}
          selectionMode="single"
        >
          {networks.map((network) => (
            <TreeItem
              className={styles.network}
              id={networkKey(network.network)}
              key={network.network}
              textValue={network.network}
            >
              <TreeItemContent>
                {({ hasChildItems, isExpanded }) => (
                  <>
                    {hasChildItems ? (
                      <Button className={styles.chevron} slot="chevron">
                        <span aria-hidden>{isExpanded ? "\u25BE" : "\u25B8"}</span>
                      </Button>
                    ) : (
                      <span className={styles.chevron} />
                    )}
                    <span className={styles.name}>{network.network}</span>
                    <Status network={network} />
                  </>
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
