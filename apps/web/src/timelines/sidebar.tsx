/**
 * The sidebar: `iirc`, its first row, which shows the Tail, then a tree of the Networks, each its own Timeline's row with how its connection
 * stands, and their Channels and Direct Messages under them, each coloured by what is
 * unread in it with small counts of what calls for the Owner, and a footer with a row for
 * each view of iirc's own, the search, the Uploads, and the options, and signing out.
 * Choosing a row opens its Timeline or its view in the focused Pane, each closing the
 * sidebar's drawer on a compact screen. What
 * the focused Pane shows is chosen, in the accent, and what another Pane shows is marked
 * dimly, with its number, as the Panes' status bars accent the focused one and dim the rest. React Aria's Tree gives it its keyboard: arrows move and expand, and
 * Enter or Space opens. Every Timeline's row has a menu, and every Network's, opened by its
 * button, which ArrowRight reaches and which shows while the row is hovered or focused, and
 * always on a touch screen, or by the context menu, as a right-click, the menu key, or
 * Shift+F10 opens it. It chooses the Timeline's own Previews over `ui.previews`, for every
 * device, marking the choice in force, and closes a Channel's or Direct Message's Timeline,
 * which the Daemon keeps out of the sidebar until something arrives in it. It pins a
 * Channel's or Direct Message's Timeline, or unpins it. On a Network's row it asks to
 * remove the Network, or, removed with its Timelines kept, to drop them, as
 * `/network remove` does.
 *
 * The Networks and their Timelines are in the Owner's order, which every device shares,
 * and the Timelines pinned are in a part of their own above the Networks, each saying which
 * Network it is of. A row is dragged before or after another of its part: a pinned one among
 * the pinned, a Network's own among the Networks as removed as it is, and any other among
 * its Network's. Each part is a Tree of its own, as the removed Networks' is, so its keys
 * stay within it. A drop is taken only where the core's arranging says something changes,
 * which keeps it within one part and one Network, and anywhere else is cancelled, so it
 * draws no line. The keys pick a
 * row up by its drag button, which ArrowRight reaches past its menu's.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Level, PreviewsShown, Timeline, TimelineId } from "@iirc/api";
import {
  activityOf,
  callingCount,
  countText,
  labelOf,
  networkActivity,
} from "@iirc/frontend/activity";
import type { Activity } from "@iirc/frontend/activity";
import { arranging } from "@iirc/frontend/arrangement";
import type { ArrangeEdit, Pin } from "@iirc/frontend/arrangement";
import { closeOf } from "@iirc/frontend/closing";
import { chosenIn } from "@iirc/frontend/previews";
import { endReason } from "@iirc/frontend/render";
import { explain } from "@iirc/frontend/sign-in";
import type { Attempt } from "@iirc/frontend/sign-in";
import { chosenOf, elsewhereOf, treeOf } from "@iirc/frontend/timelines";
import type { Connection, OwnView, SidebarNetwork } from "@iirc/frontend/timelines";
import { Atom } from "effect/reactivity";
import { useRef, useState } from "react";
import type { MouseEvent, ReactNode, RefObject } from "react";
import {
  Button as AriaButton,
  DropIndicator,
  Header,
  ListBox,
  ListBoxItem,
  Menu,
  MenuItem,
  MenuSection,
  Popover,
  Tree,
  TreeItem,
  TreeItemContent,
  useDragAndDrop,
} from "react-aria-components";
import type { DropTarget, Key, Selection } from "react-aria-components";

import { perform } from "../composer/atoms.ts";
import { openOptions, openUploads } from "../options/atoms.ts";
import { askToRemove } from "../options/removal.ts";
import { arrangedSidebar, arrangement } from "../options/ui.ts";
import { compact, drawerState } from "../page/drawer.ts";
import { previewsModes } from "../previews/atoms.ts";
import { showSearch } from "../search/atoms.ts";
import { SignOutButton } from "../sign-in/sign-out-button.tsx";
import { IconButton, useKeysOf } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import type { IconName } from "../ui/icon.tsx";
import {
  listedNetworks,
  mutedShown,
  open,
  openTail,
  sidebarNetworks,
  timelinesState,
} from "./atoms.ts";

import styles from "./sidebar.module.css";

/** The Networks the Owner collapsed in the sidebar. Every other is expanded. */
const collapsed = Atom.make<readonly string[]>([]).pipe(Atom.keepAlive);

/**
 * What the focused Pane shows, as the sidebar marks it: a view of iirc's own, or its
 * Timeline, but not a Timeline open behind a view or a Direct Message not yet begun, so
 * choosing that Timeline shows it.
 */
const selected = Atom.make((get) => chosenOf(get(timelinesState)));

/** What the other Panes show, each Timeline or view with its Pane's number. */
const elsewhere = Atom.make((get) => elsewhereOf(get(timelinesState)));

// A Network with no Timeline of its own yet has a row with an id no Timeline's can have,
// since a Timeline's is hex and `-`.
const networkKey = (network: string) => `network:${network}`;

// The wait under a Network whose Timelines are not known yet, which no Timeline's id can be.
const readingKey = (network: string) => `reading:${network}`;

/**
 * How a Network's connection stands: a symbol whose shape differs by standing as well as
 * its colour, none while connected, as a mark at a row's end reads as something to clear,
 * the word a screen reader hears, and why, when it is offline or stopped.
 */
interface Standing {
  readonly mark: { readonly icon: IconName; readonly className: string } | undefined;
  readonly word: string;
  readonly why: string | undefined;
}

/**
 * How a Network's connection stands.
 * @param network - The Network.
 * @returns Its standing.
 */
const standingOf = (network: SidebarNetwork): Standing => {
  if (network.removed) {
    return {
      mark: { className: styles.offline, icon: "removed" },
      why: undefined,
      word: "removed",
    };
  }

  if (network.running?._tag === "Stopped") {
    return {
      mark: { className: styles.offline, icon: "stopped" },
      why: network.running.reason,
      word: "stopped",
    };
  }

  const connection: Connection = network.connection;

  switch (connection._tag) {
    case "Connected": {
      return { mark: undefined, why: undefined, word: "connected" };
    }

    case "Connecting": {
      return {
        mark: { className: styles.connecting, icon: "connecting" },
        why: undefined,
        word: "connecting",
      };
    }

    case "Offline": {
      return {
        mark: { className: styles.offline, icon: "offline" },
        why: connection.reason === undefined ? undefined : endReason(connection.reason),
        word: "offline",
      };
    }

    case "Unknown": {
      return {
        mark: { className: styles.connecting, icon: "unknown" },
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
 * A row's label for a screen reader: its name and what is unread, whether it is muted, and
 * the Pane that shows it, when that is not the focused one.
 * @param name - The row's name.
 * @param activity - What is unread in it, as shown.
 * @param muted - Whether it is muted.
 * @param pane - The number of the other Pane that shows it, if one does.
 * @returns The label.
 */
const rowLabel = (
  name: string,
  activity: Activity,
  muted: boolean,
  pane: number | undefined
): string =>
  pane === undefined
    ? labelOf(name, activity, muted)
    : `${labelOf(name, activity, muted)}, in Pane ${pane}`;

/**
 * The class that dims a name further when its Timeline is muted and has no Highlight to
 * show, which would colour it.
 * @param activity - What is unread in it, as shown.
 * @param muted - Whether it is muted.
 * @returns The class, or none.
 */
const quietClass = (activity: Activity, muted: boolean): string =>
  muted && activity.level === undefined ? styles.silenced : "";

/**
 * The quiet marker of a muted Timeline, after its name, or nothing. Hidden from a screen
 * reader, which hears `muted` in the row's label.
 * @param props - Whether it is muted.
 * @returns The marker, or nothing.
 */
const MutedMark = ({ muted }: { readonly muted: boolean }) =>
  muted ? <Icon className={styles.silence} name="muted" /> : null;

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
 * The attribute a row with a menu carries its key in, which its context menu is found by: a
 * Timeline's id, or the key of a Network with no Timeline of its own yet.
 */
const menuAttribute = "data-row";

/**
 * The button that opens a row's menu, placed by its row.
 * @param props - The row's name, and what opens its menu.
 * @returns The button.
 */
const MoreButton = ({
  name,
  onMenu,
}: {
  readonly name: string;
  readonly onMenu: (row: HTMLElement) => void;
}) => (
  <AriaButton
    aria-label={`More for ${name}`}
    className={styles.more}
    onPress={(event) => {
      const row = event.target.closest<HTMLElement>('[role="row"]');

      if (row !== null) {
        onMenu(row);
      }
    }}
  >
    <Icon name="more" />
  </AriaButton>
);

/**
 * The button that picks a row up, to move it with the keys, as React Aria's Tree wants of a
 * row that drags. It shows only once the keys reach it, as a pointer drags the row itself.
 * @returns The button.
 */
const DragButton = () => (
  <AriaButton className={styles.drag} slot="drag">
    <Icon name="move" />
  </AriaButton>
);

/**
 * A Timeline's row, under its Network or pinned, with the button that opens its menu.
 * @param props - The Timeline, whether it is muted, whether bots are quieted, the Network it is of when it is pinned,
 * the number of the other Pane that shows it, if one does, whether its menu is open, and
 * what opens it.
 * @returns The row.
 */
const TimelineItem = ({
  menu,
  muted,
  of,
  onMenu,
  pane,
  quietBots,
  timeline,
}: {
  readonly pane: number | undefined;
  readonly timeline: Timeline;
  readonly muted: boolean;
  readonly quietBots: boolean;
  readonly of?: string | undefined;
  readonly menu: boolean;
  readonly onMenu: (row: HTMLElement) => void;
}) => {
  const activity = activityOf(timeline, muted, quietBots);
  const name = of === undefined ? timeline.name : `${timeline.name} of ${of}`;

  return (
    <TreeItem
      aria-label={rowLabel(name, activity, muted, pane)}
      className={`${styles.item} ${pane === undefined ? "" : styles.elsewhere}`}
      data-menu={menu || undefined}
      id={timeline.id}
      textValue={timeline.name}
      {...{ [menuAttribute]: timeline.id }}
    >
      <TreeItemContent>
        <span aria-hidden className={`${styles.gutter} ${styles.pane}`}>
          {pane}
        </span>
        <bdi
          className={`${styles.name} ${
            timeline.detached ? styles.levelNone : levelClass[activity.level ?? "None"]
          } ${quietClass(activity, muted)}`}
        >
          {timeline.name}
        </bdi>
        <MutedMark muted={muted} />
        {of === undefined ? null : (
          <span aria-hidden className={styles.of}>
            · <bdi>{of}</bdi>
          </span>
        )}
        <Counts activity={activity} calling={false} />
        <MoreButton name={timeline.name} onMenu={onMenu} />
        <DragButton />
      </TreeItemContent>
    </TreeItem>
  );
};

/** A Timeline's own Previews as its menu offers them: `default` follows `ui.previews`. */
const previewsChoices: readonly {
  readonly id: string;
  readonly mode: PreviewsShown | undefined;
}[] = [
  { id: "default", mode: undefined },
  { id: "off", mode: "off" },
  { id: "links only", mode: "links only" },
  { id: "on", mode: "on" },
];

/**
 * What a menu is open on: a row's Timeline, the Network whose row it is, or both, as a
 * Network's row is its own Timeline's once it has one.
 */
interface MenuRow {
  readonly timeline: Timeline | undefined;
  readonly network: SidebarNetwork | undefined;
}

/**
 * What a row's menu does with its Timeline: choosing its own Previews, the choice in force
 * marked, exporting it as text, muting it or unmuting it, pinning it or unpinning it, unless
 * it is a Network's own, and closing it, when it can be closed.
 * @param props - The Timeline, whether it is muted and whether it is pinned, and what
 * closes the menu.
 * @returns The menu's parts for it.
 */
const TimelineActions = ({
  muted,
  onClose,
  pinned,
  timeline,
}: {
  readonly timeline: Timeline;
  readonly muted: boolean;
  readonly pinned: boolean;
  readonly onClose: () => void;
}) => {
  const carryOut = useAtomSet(perform);
  const modes = useAtomValue(previewsModes);
  const close = closeOf(timeline);
  const chosen = modes === undefined ? undefined : (chosenIn(modes, timeline.id) ?? "default");

  return (
    <>
      <MenuSection
        className={styles.section}
        disallowEmptySelection
        onSelectionChange={(keys) => {
          const [key] = keys === "all" ? [] : keys;
          const choice = previewsChoices.find((one) => one.id === key);

          onClose();

          if (choice !== undefined && choice.id !== chosen) {
            carryOut([{ _tag: "ChoosePreviews", mode: choice.mode, timeline: timeline.id }]);
          }
        }}
        selectedKeys={chosen === undefined ? [] : [chosen]}
        selectionMode="single"
      >
        <Header className={styles.header}>Previews</Header>
        {previewsChoices.map((choice) => (
          <MenuItem
            className={styles.action}
            id={choice.id}
            key={choice.id}
            // The choice in force, chosen again, changes nothing, and closes the menu.
            onAction={onClose}
            textValue={`Previews ${choice.id}`}
          >
            {({ isSelected }) => (
              <>
                <span className={styles.mark}>{isSelected ? <Icon name="chosen" /> : null}</span>
                {choice.id}
              </>
            )}
          </MenuItem>
        ))}
      </MenuSection>
      <MenuSection className={styles.section}>
        <MenuItem
          className={styles.action}
          id="export"
          onAction={() => {
            onClose();
            carryOut([
              { _tag: "Export", since: undefined, timeline: timeline.id, until: undefined },
            ]);
          }}
          textValue="Export as text"
        >
          Export as text
        </MenuItem>
      </MenuSection>
      <MenuSection className={styles.section}>
        <MenuItem
          className={styles.action}
          id="mute"
          onAction={() => {
            onClose();
            carryOut([{ _tag: "Mute", muted: !muted, timeline: timeline.id }]);
          }}
          textValue={muted ? "Unmute" : "Mute"}
        >
          {muted ? "Unmute" : "Mute"}
        </MenuItem>
        {/* A Network's own Timeline is its row, never pinned, and is never closed. */}
        {timeline.kind === "Network" ? null : (
          <MenuItem
            className={styles.action}
            id="pin"
            onAction={() => {
              onClose();
              carryOut([
                {
                  _tag: "Arrange",
                  edit: { _tag: "Pin", pinned: !pinned, timeline: timeline.id },
                },
              ]);
            }}
            textValue={pinned ? "Unpin" : "Pin"}
          >
            {pinned ? "Unpin" : "Pin"}
          </MenuItem>
        )}
        {close === undefined ? null : (
          <MenuItem
            className={styles.action}
            id="close"
            onAction={() => {
              onClose();
              carryOut([close]);
            }}
            textValue="Close"
          >
            Close
          </MenuItem>
        )}
      </MenuSection>
    </>
  );
};

/**
 * What a row's menu does with its Network, on a Network's row: asking to remove it, or,
 * removed with its Timelines kept, to drop them, as `/network remove` does. Nothing is
 * removed until the Owner answers.
 * @param props - The Network, and what closes the menu.
 * @returns The menu's part for it.
 */
const NetworkActions = ({
  network,
  onClose,
}: {
  readonly network: SidebarNetwork;
  readonly onClose: () => void;
}) => {
  const ask = useAtomSet(askToRemove);

  return (
    <MenuSection className={styles.section}>
      <MenuItem
        className={styles.action}
        id="remove"
        onAction={() => {
          onClose();
          ask(network.network);
        }}
        textValue={network.removed ? "Drop Timelines" : "Remove Network"}
      >
        {network.removed ? "Drop Timelines…" : "Remove Network…"}
      </MenuItem>
    </MenuSection>
  );
};

/**
 * What can be done from a row: with its Timeline, and, on a Network's row, with its
 * Network.
 * @param props - The row's Timeline and Network, whether the Timeline is muted and whether
 * it is pinned, the row, and what closes the menu.
 * @returns The menu, placed under its row.
 */
const RowMenu = ({
  anchor,
  muted,
  network,
  onClose,
  pinned,
  timeline,
}: MenuRow & {
  readonly muted: boolean;
  readonly pinned: boolean;
  readonly anchor: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}) => (
  <Popover
    className={styles.popover}
    isOpen
    offset={0}
    onOpenChange={(isOpen) => {
      if (!isOpen) {
        onClose();
      }
    }}
    placement="bottom end"
    triggerRef={anchor}
  >
    <Menu
      aria-label={`What to do with ${timeline?.name ?? network?.network ?? ""}`}
      autoFocus="first"
      className={styles.menu}
    >
      {timeline === undefined ? null : (
        <TimelineActions muted={muted} onClose={onClose} pinned={pinned} timeline={timeline} />
      )}
      {network === undefined ? null : <NetworkActions network={network} onClose={onClose} />}
    </Menu>
  </Popover>
);

/**
 * What a Network's row says is unread: its own Timeline's, while what is under it shows
 * what is theirs, and otherwise every Timeline's, counting only what calls for the Owner.
 * A muted Timeline counts only its Highlights, as `activityOf` says.
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
    ? { activity: activityOf(own, network.muted.has(own.id), network.quietBots), calling: false }
    : { activity: networkActivity(network), calling: true };

/**
 * A Network's row: its chevron, which expands and collapses it without choosing, its id,
 * coloured by what is unread, marked when its own Timeline is muted, how its connection
 * stands, as a symbol unless connected, and the button that opens its menu.
 * @param props - The Network, its own Timeline, whether that is muted, whether its
 * Timelines are shown, and what opens the menu.
 * @returns The row's content.
 */
const NetworkRow = ({
  expandable,
  expanded,
  muted,
  network,
  onMenu,
  own,
  pane,
}: {
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly muted: boolean;
  readonly network: SidebarNetwork;
  readonly own: Timeline | undefined;
  readonly pane: number | undefined;
  readonly onMenu: (row: HTMLElement) => void;
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
      <bdi
        className={`${styles.name} ${levelClass[activity.level ?? "None"]} ${quietClass(activity, muted)}`}
      >
        {network.network}
      </bdi>
      <MutedMark muted={muted} />
      <Counts activity={activity} calling={calling} />
      <PaneMark pane={pane} />
      {standing.mark === undefined ? null : (
        <span className={styles.standing} title={standingWords(standing)}>
          <Icon className={standing.mark.className} name={standing.mark.icon} />
        </span>
      )}
      <MoreButton name={own?.name ?? network.network} onMenu={onMenu} />
      <DragButton />
    </>
  );
};

/** The views of iirc's own, in the order their rows stack, each with its command. */
// The Tail has its row at the top of the sidebar, not in the foot.
type FootView = Exclude<OwnView, "Tail">;

const ownViews: readonly { readonly view: FootView; readonly command: string }[] = [
  { command: "search.open", view: "Search" },
  { command: "uploads.open", view: "Uploads" },
  { command: "options.set", view: "Options" },
];

/**
 * A view's row: its name, and its keys, dim, where the keymap binds any.
 * @param props - The view, its name, its command, and the number of the other Pane that
 * shows it, if one does.
 * @returns The row.
 */
const ViewItem = ({
  command,
  view,
  name = view,
  pane,
}: {
  readonly view: OwnView;
  readonly name?: string;
  readonly command: string;
  readonly pane: number | undefined;
}) => {
  const keys = useKeysOf(command);

  return (
    <ListBoxItem
      aria-label={pane === undefined ? name : `${name}, in Pane ${pane}`}
      className={`${styles.item} ${pane === undefined ? "" : styles.elsewhere}`}
      id={view}
      textValue={name}
    >
      <span aria-hidden className={`${styles.gutter} ${styles.pane}`}>
        {pane}
      </span>
      <span className={styles.name}>{name}</span>
      {keys === undefined ? null : (
        <kbd className={styles.keys} title={keys}>
          {keys}
        </kbd>
      )}
    </ListBoxItem>
  );
};

/**
 * The sidebar's first row, `iirc`, which shows the Tail in the focused Pane, marked as a
 * view's row is, and never with anything unread.
 * @returns The row.
 */
const TailRow = () => {
  const chosen = useAtomValue(selected);
  const others = useAtomValue(elsewhere);
  const showTail = useAtomSet(openTail);
  const setDrawer = useAtomSet(drawerState);

  // Choosing it again while it shows, an empty selection, shows it again, which changes
  // nothing. Escape leaves the selection alone, so only a press or Enter or Space does.
  const onSelectionChange = () => {
    showTail(undefined);
    setDrawer("None");
  };

  return (
    <ListBox
      aria-label="iirc"
      className={styles.views}
      escapeKeyBehavior="none"
      onSelectionChange={onSelectionChange}
      selectedKeys={chosen._tag === "Tail" ? ["Tail"] : []}
      selectionMode="single"
    >
      <ViewItem command="tail.open" name="iirc" pane={others.get("Tail")} view="Tail" />
    </ListBox>
  );
};

/**
 * The foot of the sidebar: a row for each view of iirc's own, which opens it in the focused
 * Pane as a Timeline's row does, and is marked as one is, then signing out and, beside the
 * Panes, hiding the sidebar. A failed sign-out is said in words above them.
 * @param props - The attempt to sign out.
 * @returns The footer.
 */
const Footer = ({ attempt }: { readonly attempt: Attempt }) => {
  const chosen = useAtomValue(selected);
  const others = useAtomValue(elsewhere);
  const showSearchNow = useAtomSet(showSearch);
  const showUploads = useAtomSet(openUploads);
  const showOptions = useAtomSet(openOptions);
  const setDrawer = useAtomSet(drawerState);
  const carryOut = useAtomSet(perform);
  const drawer = useAtomValue(compact);
  const shown = ownViews.find(({ view }) => view === chosen._tag)?.view;

  const opening: Readonly<Record<FootView, () => void>> = {
    Options: () => {
      showOptions("");
    },
    Search: () => {
      showSearchNow(undefined);
    },
    Uploads: () => {
      showUploads();
    },
  };

  // Choosing a row opens its view and closes the drawer on a compact screen. Choosing the
  // view already shown, which React Aria gives as an empty selection, opens it again, as
  // the options then read again and clear their filter. Escape leaves the selection alone,
  // so only a press or Enter or Space does either.
  const onSelectionChange = (selection: Selection) => {
    const [key] = selection === "all" ? [] : selection;
    const view = ownViews.find((one) => one.view === key)?.view ?? shown;

    if (view !== undefined) {
      opening[view]();
    }

    setDrawer("None");
  };

  return (
    <footer className={styles.footer}>
      <ListBox
        aria-label="Views"
        className={styles.views}
        escapeKeyBehavior="none"
        onSelectionChange={onSelectionChange}
        selectedKeys={shown === undefined ? [] : [shown]}
        selectionMode="single"
      >
        {ownViews.map(({ command, view }) => (
          <ViewItem command={command} key={view} pane={others.get(view)} view={view} />
        ))}
      </ListBox>
      {attempt._tag === "Failed" ? (
        <p className={styles.failure} role="alert">
          {explain(attempt.failure)}
        </p>
      ) : null}
      <div className={styles.controls}>
        <SignOutButton attempt={attempt} size="small" />
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

/** The type a dragged row carries its Timeline's name in, which only the sidebar takes. */
const dragType = "application/x-iirc-timeline";

/** No Network's own row, for a part that draws none. */
const noNetworks: ReadonlyMap<Key, SidebarNetwork> = new Map();

/**
 * What every part of the sidebar does with its rows: choosing one opens its Timeline, a
 * row's menu opens by its button or the context menu, and a row dragged before or after
 * another of the part moves it there, for every device.
 * @param timelines - The part's Timelines, which a row's key is read back as.
 * @param pinned - The Timelines pinned, for the menu.
 * @param own - The Networks whose own rows the part draws, each by its row's key.
 * @returns The Tree's handlers, its drag and drop, the key of the row whose menu is open,
 * what opens a menu, and the menu itself.
 */
const usePart = (
  timelines: readonly Timeline[],
  pinned: ReadonlySet<TimelineId>,
  own: ReadonlyMap<Key, SidebarNetwork> = noNetworks
) => {
  const choose = useAtomSet(open);
  const setDrawer = useAtomSet(drawerState);
  const carryOut = useAtomSet(perform);
  const networks = useAtomValue(sidebarNetworks);
  const muted = useAtomValue(mutedShown);
  const order = useAtomValue(arrangement);
  // The key of the row whose menu is open, placed by its row.
  const [menu, setMenu] = useState<Key | undefined>(undefined);
  const anchor = useRef<HTMLElement | null>(null);
  // The keys of the rows dragged, which a place to drop them is judged by.
  const dragged = useRef<ReadonlySet<Key>>(new Set());

  // A key is read back as the Timeline it names, never cast: a key that names none, such
  // as the row of a Network with no Timeline of its own, opens nothing.
  const timelineOf = (key: Key) => timelines.find((timeline) => timeline.id === key);

  // What a row's key names: its Timeline, the Network whose row it is, or both, read back
  // from the key, never cast.
  const rowOf = (key: Key): MenuRow => ({ network: own.get(key), timeline: timelineOf(key) });

  // A menu is opened on a row, by its key, which it is placed by.
  const openMenu = (key: Key, row: HTMLElement) => {
    anchor.current = row;
    setMenu(key);
  };

  // The context menu, from a pointer or the keyboard, on a row that has a menu opens it in
  // place of the browser's.
  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    const row =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(`[${menuAttribute}]`)
        : null;

    const key = row?.getAttribute(menuAttribute) ?? "";
    const named = rowOf(key);

    if (row !== null && (named.timeline !== undefined || named.network !== undefined)) {
      event.preventDefault();
      openMenu(key, row);
    }
  };

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

  // One row dropped before or after another, as an edit of the order, or none.
  const placing = (keys: ReadonlySet<Key>, target: DropTarget): ArrangeEdit | undefined => {
    const [key] = keys;
    const timeline = keys.size === 1 && key !== undefined ? timelineOf(key) : undefined;
    const beside = target.type === "item" ? timelineOf(target.key) : undefined;

    if (timeline === undefined || beside === undefined || target.type !== "item") {
      return undefined;
    }

    return target.dropPosition === "on"
      ? undefined
      : {
          _tag: "Place",
          side: target.dropPosition === "before" ? "Before" : "After",
          target: beside.id,
          timeline: timeline.id,
        };
  };

  const { dragAndDropHooks } = useDragAndDrop({
    acceptedDragTypes: [dragType],
    // A place takes a drop only where the order would change, as the core says from what
    // is shown, so no line is drawn where a drop would do nothing. React Aria has kept it
    // within this part and the dragged row's Network already.
    getDropOperation: (target) => {
      const edit = placing(dragged.current, target);

      return edit !== undefined && arranging(networks, order, edit) !== undefined
        ? "move"
        : "cancel";
    },
    getItems: (keys) =>
      [...keys].flatMap((key) => {
        const timeline = timelineOf(key);

        return timeline === undefined ? [] : [{ [dragType]: timeline.name }];
      }),
    onDragEnd: () => {
      dragged.current = new Set();
    },
    onDragStart: ({ keys }) => {
      dragged.current = keys;
    },
    onReorder: ({ keys, target }) => {
      const edit = placing(keys, target);

      if (edit !== undefined) {
        carryOut([{ _tag: "Arrange", edit }]);
      }
    },
    renderDragPreview: (items) => (
      <div className={styles.preview}>{items.map((item) => item[dragType]).join(", ")}</div>
    ),
    renderDropIndicator: (target) => <DropIndicator className={styles.drop} target={target} />,
  });

  // The menu's row, as it is now, while it is still listed.
  const menuRow = menu === undefined ? undefined : rowOf(menu);

  return {
    dragAndDropHooks,
    handleContextMenu: onContextMenu,
    handleSelectionChange: onSelectionChange,
    menu,
    menuElement:
      menuRow === undefined ||
      (menuRow.timeline === undefined && menuRow.network === undefined) ? null : (
        <RowMenu
          anchor={anchor}
          onClose={() => {
            setMenu(undefined);
          }}
          muted={menuRow.timeline !== undefined && muted.has(menuRow.timeline.id)}
          network={menuRow.network}
          pinned={menuRow.timeline !== undefined && pinned.has(menuRow.timeline.id)}
          timeline={menuRow.timeline}
        />
      ),
    openMenu,
  };
};

/**
 * A part of the sidebar: its Tree, which listens for the context menu on its rows, and the
 * menu open on one of them.
 * @param props - The Tree, and the menu.
 * @returns The part.
 */
const Part = ({
  children,
  menu,
  onContextMenu,
}: {
  readonly children: ReactNode;
  readonly menu: ReactNode;
  readonly onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}) => (
  // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the context menu is a row's, which the Tree's own keys reach, and this only listens for it.
  <div onContextMenu={onContextMenu}>
    {children}
    {menu}
  </div>
);

/**
 * The Timelines pinned above the Networks, in the Owner's order, each saying which Network
 * it is of.
 * @param props - The pinned Timelines.
 * @returns The tree.
 */
const PinnedTree = ({ pins }: { readonly pins: readonly Pin[] }) => {
  const chosen = useAtomValue(selected);
  const others = useAtomValue(elsewhere);
  const timelines = pins.map((pin) => pin.timeline);
  const part = usePart(timelines, new Set(timelines.map((timeline) => timeline.id)));

  return (
    <Part menu={part.menuElement} onContextMenu={part.handleContextMenu}>
      <Tree
        aria-label="Pinned Timelines"
        className={styles.tree}
        dragAndDropHooks={part.dragAndDropHooks}
        onSelectionChange={part.handleSelectionChange}
        selectedKeys={chosen._tag === "Timeline" ? [chosen.timeline] : []}
        selectionMode="single"
      >
        {pins.map(({ network, timeline }) => (
          <TimelineItem
            key={timeline.id}
            menu={part.menu === timeline.id}
            muted={network.muted.has(timeline.id)}
            of={network.network}
            quietBots={network.quietBots}
            onMenu={(row) => {
              part.openMenu(timeline.id, row);
            }}
            pane={others.get(timeline.id)}
            timeline={timeline}
          />
        ))}
      </Tree>
    </Part>
  );
};

/** None pinned, for a part that has none. */
const nonePinned: ReadonlySet<TimelineId> = new Set();

/**
 * A tree of Networks and their Timelines, each Network its own Timeline's row.
 * @param props - The Networks, and what the tree is called.
 * @returns The tree.
 */
const NetworkTrees = ({
  label,
  networks,
}: {
  readonly label: string;
  readonly networks: readonly SidebarNetwork[];
}) => {
  const hidden = useAtomValue(collapsed);
  const chosen = useAtomValue(selected);
  const others = useAtomValue(elsewhere);
  const setCollapsed = useAtomSet(collapsed);

  const trees = networks.map((network) => ({ network, tree: treeOf(network) }));

  // A Network's row is its own Timeline's, keyed by its id, once it has one.
  const rowKey = ({ network, tree }: (typeof trees)[number]) =>
    tree.own?.id ?? networkKey(network.network);

  // A Timeline under a Network is not pinned, as a pinned one is in the part above.
  const part = usePart(
    networks.flatMap((network) => network.timelines),
    nonePinned,
    new Map(trees.map((one) => [rowKey(one), one.network]))
  );

  // Only this tree's Networks are expanded or collapsed by it.
  const onExpandedChange = (keys: Set<Key>) => {
    const mine = new Set<string>(trees.map((one) => one.network.network));

    setCollapsed([
      ...hidden.filter((network) => !mine.has(network)),
      ...trees.filter((one) => !keys.has(rowKey(one))).map((one) => one.network.network),
    ]);
  };

  return (
    <Part menu={part.menuElement} onContextMenu={part.handleContextMenu}>
      <Tree
        aria-label={label}
        className={styles.tree}
        disabledBehavior="selection"
        disabledKeys={[
          ...trees.filter((one) => one.tree.own === undefined).map(rowKey),
          ...trees
            .filter((one) => !one.network.listed)
            .map((one) => readingKey(one.network.network)),
        ]}
        dragAndDropHooks={part.dragAndDropHooks}
        expandedKeys={trees.filter((one) => !hidden.includes(one.network.network)).map(rowKey)}
        onExpandedChange={onExpandedChange}
        onSelectionChange={part.handleSelectionChange}
        selectedKeys={chosen._tag === "Timeline" ? [chosen.timeline] : []}
        selectionMode="single"
      >
        {trees.map((one) => {
          const { network, tree } = one;
          const pane = tree.own === undefined ? undefined : others.get(tree.own.id);
          const expanded = !hidden.includes(network.network) && tree.children.length > 0;
          const { activity } = networkUnread(network, tree.own, expanded);
          const muted = tree.own !== undefined && network.muted.has(tree.own.id);

          return (
            <TreeItem
              aria-label={`${rowLabel(network.network, activity, muted, pane)}, ${standingWords(standingOf(network))}`}
              className={`${styles.network} ${pane === undefined ? "" : styles.elsewhere}`}
              data-menu={part.menu === rowKey(one) || undefined}
              id={rowKey(one)}
              // React Aria never changes an item's id, so a row that gains its own Timeline is drawn anew.
              key={rowKey(one)}
              textValue={network.network}
              {...{ [menuAttribute]: rowKey(one) }}
            >
              <TreeItemContent>
                {({ hasChildItems, isExpanded }) => (
                  <NetworkRow
                    expandable={hasChildItems}
                    expanded={isExpanded}
                    muted={muted}
                    network={network}
                    onMenu={(row) => {
                      part.openMenu(rowKey(one), row);
                    }}
                    own={tree.own}
                    pane={pane}
                  />
                )}
              </TreeItemContent>
              {/* Until its Timelines are read, having none says nothing, so a wait is drawn. */}
              {network.listed ? null : (
                <TreeItem
                  className={styles.item}
                  id={readingKey(network.network)}
                  textValue="Reading…"
                >
                  <TreeItemContent>
                    <span aria-hidden className={styles.gutter} />
                    <span className={styles.reading}>Reading…</span>
                  </TreeItemContent>
                </TreeItem>
              )}
              {tree.children.map((timeline) => (
                <TimelineItem
                  key={timeline.id}
                  menu={part.menu === timeline.id}
                  muted={network.muted.has(timeline.id)}
                  quietBots={network.quietBots}
                  onMenu={(row) => {
                    part.openMenu(timeline.id, row);
                  }}
                  pane={others.get(timeline.id)}
                  timeline={timeline}
                />
              ))}
            </TreeItem>
          );
        })}
      </Tree>
    </Part>
  );
};

/**
 * The `iirc` row, the Timelines pinned, when any are, the tree of Networks and their Timelines, those
 * removed with their Timelines kept apart under their own heading, each in the Owner's
 * order, and the footer.
 * @param props - The attempt to sign out.
 * @returns The sidebar.
 */
export const Sidebar = ({ signOut: attempt }: { readonly signOut: Attempt }) => {
  const { networks, pinned } = useAtomValue(arrangedSidebar);
  const listed = useAtomValue(listedNetworks);
  const live = networks.filter((network) => !network.removed);
  const removed = networks.filter((network) => network.removed);

  return (
    <nav aria-label="Networks" className={styles.sidebar}>
      <div className={styles.scroll}>
        <TailRow />
        {pinned.length === 0 ? null : (
          <>
            <h2 className={styles.heading}>Pinned</h2>
            <PinnedTree pins={pinned} />
          </>
        )}
        {live.length > 0 ? (
          <NetworkTrees label="Networks and their Timelines" networks={live} />
        ) : (
          // Until the list is read, having none says nothing, so a wait is drawn.
          <p className={styles.muted}>{listed ? "No Networks are configured yet." : "Reading…"}</p>
        )}
        {removed.length === 0 ? null : (
          <>
            <h2 className={styles.heading}>Removed</h2>
            <NetworkTrees
              label="Removed Networks and their Timelines, kept to read"
              networks={removed}
            />
          </>
        )}
      </div>
      <Footer attempt={attempt} />
    </nav>
  );
};
