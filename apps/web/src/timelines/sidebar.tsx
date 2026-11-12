/**
 * The sidebar: a tree of the Networks, each its own Timeline's row with how its connection
 * stands, and their Channels and Direct Messages under them, each coloured by what is
 * unread in it with small counts of what calls for the Owner, and a footer with the options
 * and signing out. Choosing a row opens its Timeline in the focused Pane, and Options
 * opens the options view there, each closing the sidebar's drawer on a compact screen. What
 * the focused Pane shows is chosen, in the accent, and what another Pane shows is marked
 * dimly, with its number, as the Panes' status bars accent the focused one and dim the rest. React Aria's Tree gives it its keyboard: arrows move and expand, and
 * Enter or Space opens.
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
import { explain } from "@iirc/frontend/sign-in";
import type { Attempt } from "@iirc/frontend/sign-in";
import { chosenOf, elsewhereOf, treeOf } from "@iirc/frontend/timelines";
import type { Connection, SidebarNetwork } from "@iirc/frontend/timelines";
import { Atom } from "effect/reactivity";
import { Button as AriaButton, Tree, TreeItem, TreeItemContent } from "react-aria-components";
import type { Key, Selection } from "react-aria-components";

import { perform } from "../composer/atoms.ts";
import { openOptions } from "../options/atoms.ts";
import { compact, drawerState } from "../page/drawer.ts";
import { signOut } from "../sign-in/atoms.ts";
import { Button, IconButton } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import type { IconName } from "../ui/icon.tsx";
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

/** What the other Panes show, each Timeline with its Pane's number. */
const elsewhere = Atom.make((get) => elsewhereOf(get(timelinesState)));

// A Network with no Timeline of its own yet has a row with an id no Timeline's can have,
// since a Timeline's is hex and `-`.
const networkKey = (network: string) => `network:${network}`;

/**
 * How a Network's connection stands: a symbol whose shape differs by standing as well as
 * its colour, the word a screen reader hears, and why, when it is offline or stopped.
 */
interface Standing {
  readonly icon: IconName;
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
    return {
      className: styles.offline,
      icon: "stopped",
      why: network.running.reason,
      word: "stopped",
    };
  }

  const connection: Connection = network.connection;

  switch (connection._tag) {
    case "Connected": {
      return { className: styles.connected, icon: "connected", why: undefined, word: "connected" };
    }

    case "Connecting": {
      return {
        className: styles.connecting,
        icon: "connecting",
        why: undefined,
        word: "connecting",
      };
    }

    case "Offline": {
      return {
        className: styles.offline,
        icon: "offline",
        why: connection.reason === undefined ? undefined : endReason(connection.reason),
        word: "offline",
      };
    }

    case "Unknown": {
      return {
        className: styles.connecting,
        icon: "unknown",
        why: undefined,
        word: "not known yet",
      };
    }

    default: {
      return connection satisfies never;
    }
  }
};

/**
 * How a Network's connection stands, in words, with why when there is a reason.
 * @param standing - Its standing.
 * @returns The words.
 */
const standingWords = (standing: Standing): string =>
  standing.why === undefined ? standing.word : `${standing.word}: ${standing.why}`;

/**
 * A row's label for a screen reader: its name and what is unread, and the Pane that shows
 * it, when that is not the focused one.
 * @param name - The row's name.
 * @param activity - What is unread in it.
 * @param pane - The number of the other Pane that shows it, if one does.
 * @returns The label.
 */
const rowLabel = (name: string, activity: Activity, pane: number | undefined): string =>
  pane === undefined ? labelOf(name, activity) : `${labelOf(name, activity)}, in Pane ${pane}`;

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
 * The number of the other Pane that shows a Network's own Timeline, dim, or nothing.
 * @param props - The number, if any.
 * @returns The number, hidden from a screen reader, which hears it in the row's label.
 */
const PaneMark = ({ pane }: { readonly pane: number | undefined }) =>
  pane === undefined ? null : (
    <span aria-hidden className={styles.pane}>
      {pane}
    </span>
  );

/**
 * A Timeline's row, under its Network.
 * @param props - The Timeline, and the number of the other Pane that shows it, if one does.
 * @returns The row.
 */
const TimelineItem = ({
  pane,
  timeline,
}: {
  readonly pane: number | undefined;
  readonly timeline: Timeline;
}) => {
  const activity = activityOf(timeline);

  return (
    <TreeItem
      aria-label={rowLabel(timeline.name, activity, pane)}
      className={`${styles.item} ${pane === undefined ? "" : styles.elsewhere}`}
      id={timeline.id}
      textValue={timeline.name}
    >
      <TreeItemContent>
        <span aria-hidden className={`${styles.gutter} ${styles.pane}`}>
          {pane}
        </span>
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
 * What a Network's row says is unread: its own Timeline's, while what is under it shows
 * what is theirs, and otherwise every Timeline's, counting only what calls for the Owner.
 * @param network - The Network.
 * @param own - Its own Timeline, if it has one.
 * @param expanded - Whether what is under it shows.
 * @returns What it says, and whether it counts only what calls.
 */
const networkUnread = (
  network: SidebarNetwork,
  own: Timeline | undefined,
  expanded: boolean
): { readonly activity: Activity; readonly calling: boolean } =>
  expanded && own !== undefined
    ? { activity: activityOf(own), calling: false }
    : { activity: networkActivity(network), calling: true };

/**
 * A Network's row: its chevron, which expands and collapses it without choosing, its id,
 * coloured by what is unread, and how its connection stands, as a symbol.
 * @param props - The Network, its own Timeline, and whether its Timelines are shown.
 * @returns The row's content.
 */
const NetworkRow = ({
  expandable,
  expanded,
  network,
  own,
  pane,
}: {
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly network: SidebarNetwork;
  readonly own: Timeline | undefined;
  readonly pane: number | undefined;
}) => {
  const { activity, calling } = networkUnread(network, own, expanded && expandable);
  const standing = standingOf(network);

  return (
    <>
      {/* The Tree's own chevron, outside the tab order, as its row takes the keys: a part of
          the row, not one of the buttons. */}
      {expandable ? (
        <AriaButton className={styles.chevron} slot="chevron">
          <Icon name={expanded ? "expanded" : "collapsed"} />
        </AriaButton>
      ) : (
        <span className={styles.chevron} />
      )}
      <bdi className={`${styles.name} ${levelClass[activity.level ?? "None"]}`}>
        {network.network}
      </bdi>
      <Counts activity={activity} calling={calling} />
      <PaneMark pane={pane} />
      <span className={styles.standing} title={standingWords(standing)}>
        <Icon className={standing.className} name={standing.icon} />
      </span>
    </>
  );
};

/**
 * The foot of the sidebar: the options, signing out, and, beside the Panes, hiding the
 * sidebar. A failed sign-out is said in words above it.
 * @param props - The attempt to sign out, and whether the options show in the focused Pane.
 * @returns The footer.
 */
const Footer = ({
  attempt,
  optionsShown,
}: {
  readonly attempt: Attempt;
  readonly optionsShown: boolean;
}) => {
  const showOptions = useAtomSet(openOptions);
  const setDrawer = useAtomSet(drawerState);
  const signOutNow = useAtomSet(signOut);
  const carryOut = useAtomSet(perform);
  const drawer = useAtomValue(compact);

  return (
    <footer className={styles.footer}>
      {attempt._tag === "Failed" ? (
        <p className={styles.failure} role="alert">
          {explain(attempt.failure)}
        </p>
      ) : null}
      <div className={styles.controls}>
        <Button
          aria-current={optionsShown ? "page" : false}
          onPress={() => {
            showOptions("");
            setDrawer("None");
          }}
          size="small"
          variant="quiet"
        >
          Options
        </Button>
        <Button
          isPending={attempt._tag === "Waiting"}
          onPress={() => {
            signOutNow();
          }}
          size="small"
          variant="quiet"
        >
          Sign out
        </Button>
        {drawer ? null : (
          <IconButton
            className={styles.hide}
            command="sidebar.toggle"
            icon="hideSidebar"
            label="Hide the sidebar"
            onPress={() => {
              carryOut([{ _tag: "ShowSidebar", shown: false }]);
            }}
            size="small"
          />
        )}
      </div>
    </footer>
  );
};

/**
 * The tree of Networks and their Timelines, and the footer.
 * @param props - The attempt to sign out.
 * @returns The sidebar.
 */
export const Sidebar = ({ signOut: attempt }: { readonly signOut: Attempt }) => {
  const networks = useAtomValue(sidebarNetworks);
  const hidden = useAtomValue(collapsed);
  const chosen = useAtomValue(selected);
  const others = useAtomValue(elsewhere);
  const setCollapsed = useAtomSet(collapsed);
  const choose = useAtomSet(open);
  const setDrawer = useAtomSet(drawerState);

  const trees = networks.map((network) => ({ network, tree: treeOf(network) }));

  // A Network's row is its own Timeline's, keyed by its id, once it has one.
  const rowKey = ({ network, tree }: (typeof trees)[number]) =>
    tree.own?.id ?? networkKey(network.network);

  // A key is read back as the Timeline it names, never cast: a key that names none, such
  // as the row of a Network with no Timeline of its own, opens nothing.
  const timelineOf = (key: Key) =>
    networks.flatMap((network) => network.timelines).find((timeline) => timeline.id === key);

  // Choosing closes the drawer on a compact screen, and so does choosing the Timeline
  // already shown, which React Aria gives as an empty selection.
  const onSelectionChange = (selection: Selection) => {
    const [key] = selection === "all" ? [] : selection;
    const timeline = key === undefined ? undefined : timelineOf(key);

    if (timeline !== undefined) {
      choose(timeline.id);
    }

    setDrawer("None");
  };

  const onExpandedChange = (keys: Set<Key>) => {
    setCollapsed(trees.filter((one) => !keys.has(rowKey(one))).map((one) => one.network.network));
  };

  return (
    <nav aria-label="Networks" className={styles.sidebar}>
      <div className={styles.scroll}>
        <h2 className={styles.heading}>Networks</h2>
        {networks.length === 0 ? (
          <p className={styles.muted}>No Networks are configured yet.</p>
        ) : (
          <Tree
            aria-label="Networks and their Timelines"
            className={styles.tree}
            disabledBehavior="selection"
            disabledKeys={trees.filter((one) => one.tree.own === undefined).map(rowKey)}
            expandedKeys={trees.filter((one) => !hidden.includes(one.network.network)).map(rowKey)}
            onExpandedChange={onExpandedChange}
            onSelectionChange={onSelectionChange}
            selectedKeys={chosen._tag === "Timeline" ? [chosen.timeline] : []}
            selectionMode="single"
          >
            {trees.map((one) => {
              const { network, tree } = one;
              const pane = tree.own === undefined ? undefined : others.get(tree.own.id);
              const expanded = !hidden.includes(network.network) && tree.children.length > 0;
              const { activity } = networkUnread(network, tree.own, expanded);

              return (
                <TreeItem
                  aria-label={`${rowLabel(network.network, activity, pane)}, ${standingWords(standingOf(network))}`}
                  className={`${styles.network} ${pane === undefined ? "" : styles.elsewhere}`}
                  id={rowKey(one)}
                  // React Aria never changes an item's id, so a row that gains its own Timeline is drawn anew.
                  key={rowKey(one)}
                  textValue={network.network}
                >
                  <TreeItemContent>
                    {({ hasChildItems, isExpanded }) => (
                      <NetworkRow
                        expandable={hasChildItems}
                        expanded={isExpanded}
                        network={network}
                        own={tree.own}
                        pane={pane}
                      />
                    )}
                  </TreeItemContent>
                  {tree.children.map((timeline) => (
                    <TimelineItem
                      key={timeline.id}
                      pane={others.get(timeline.id)}
                      timeline={timeline}
                    />
                  ))}
                </TreeItem>
              );
            })}
          </Tree>
        )}
      </div>
      <Footer attempt={attempt} optionsShown={chosen._tag === "Options"} />
    </nav>
  );
};
