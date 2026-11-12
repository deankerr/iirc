/**
 * A Pane's Channel's members, under its status bar while they show: a virtualized grid
 * list, most privileged first, each member with their rank's symbol, in their nick's
 * colour, and dimmed while away, read a page at a time as the Owner scrolls. A press, a
 * tap, or Enter on a member opens a menu of what to do with them, anchored to their row:
 * open their Direct Message, as `/query` does, first, so Enter twice opens it, look them
 * up, as `/whois` does, or mention them in the composer.
 *
 * Where the Pane is wide, they are a column beside its Timeline, a region. Where it is
 * narrow, they lie over its Timeline instead, a dialog that leaves the page usable, and on
 * a compact screen they are a sheet over the focused Pane, a modal dialog. Those two are put away by the toggle, Escape, a press elsewhere,
 * `/members`, Alt+M, or choosing what to do with a member, so what it does shows.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { TimelineId } from "@iirc/api";
import type { MemberRow } from "@iirc/frontend/channel";
import { commandNamed, runIn } from "@iirc/frontend/commands";
import type { Intent } from "@iirc/frontend/commands";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import {
  Collection,
  Dialog,
  GridList,
  GridListItem,
  GridListLoadMoreItem,
  ListLayout,
  Menu,
  MenuItem,
  Modal,
  ModalOverlay,
  Popover,
  Virtualizer,
} from "react-aria-components";
import type { Key } from "react-aria-components";

import { commandContext, perform } from "../composer/atoms.ts";
import { compact } from "../page/drawer.ts";
import { Nick } from "../timelines/line.tsx";
import { IconButton } from "../ui/button.tsx";
import { channelOpen, moreMembers, roster } from "./atoms.ts";
import { membersDismissed, membersOpen, paneNarrow, toggleMembers } from "./state.ts";

import styles from "./members-panel.module.css";

/** How tall a member's row is, in pixels, for the virtualizer to estimate them by. */
const rowHeight = 19;

/**
 * One member: their rank's symbol, and their nick in its colour.
 * @param props - The member.
 * @returns The row's content.
 */
const Member = ({ row }: { readonly row: MemberRow }) => (
  <span aria-hidden className={row.away ? styles.away : styles.member}>
    <span className={styles.symbol}>{row.symbol ?? " "}</span>
    <Nick colour={row.colour} nick={row.nick} />
  </span>
);

/**
 * What can be done with a member, as a menu anchored to their row: open their Direct
 * Message, as `/query` does, look them up, as `/whois` does, or mention them, starting the
 * composer with their nick. Choosing one puts away members that lie over something.
 * @param props - The member, their row, and what closes the menu.
 * @returns The menu.
 */
const Actions = ({
  anchor,
  nick,
  onClose,
}: {
  readonly nick: string;
  readonly anchor: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}) => {
  const context = useAtomValue(commandContext);
  const carryOut = useAtomSet(perform);
  const dismiss = useAtomSet(membersDismissed);

  const query = commandNamed("query");
  const whois = commandNamed("whois");
  const queried = query === undefined ? undefined : runIn(query, nick, context);
  const looked = whois === undefined ? undefined : runIn(whois, nick, context);

  const actions = [
    ...(queried?._tag === "Parsed"
      ? [{ id: "query", intents: queried.value, label: `Query ${nick}`, text: "query" }]
      : []),
    ...(looked?._tag === "Parsed"
      ? [{ id: "whois", intents: looked.value, label: `Whois ${nick}`, text: "whois" }]
      : []),
    {
      id: "mention",
      intents: [{ _tag: "FocusComposer", text: `${nick}: ` }] satisfies readonly Intent[],
      label: `Mention ${nick}`,
      text: "mention",
    },
  ];

  return (
    <Popover
      className={styles.popover}
      isOpen
      offset={0}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onClose();
        }
      }}
      placement="bottom start"
      triggerRef={anchor}
    >
      <Menu
        aria-label={`What to do with ${nick}`}
        autoFocus="first"
        className={styles.menu}
        items={actions}
        onAction={(key) => {
          const chosen = actions.find((action) => action.id === String(key));

          onClose();

          if (chosen !== undefined) {
            dismiss(undefined);
            carryOut(chosen.intents);
          }
        }}
      >
        {(action) => (
          <MenuItem
            aria-label={action.label}
            className={styles.action}
            id={action.id}
            textValue={action.text}
          >
            {action.text}
          </MenuItem>
        )}
      </Menu>
    </Popover>
  );
};

/**
 * The members read, in rank order, paged as the Owner scrolls, and the menu of the one
 * pressed.
 * @param props - The members, whether more follow, whether they are being read, and the
 * member whose menu is open, with what changes it.
 * @returns The list.
 */
const Members = ({
  loading,
  menu,
  more,
  rows,
  setMenu,
  timeline,
}: {
  readonly rows: readonly MemberRow[];
  readonly more: boolean;
  readonly loading: boolean;
  readonly timeline: TimelineId;
  readonly menu: string | undefined;
  readonly setMenu: (nick: string | undefined) => void;
}) => {
  const askMore = useAtomSet(moreMembers);
  const drawn = useRef(new Map<string, HTMLElement>());
  const anchor = useRef<HTMLElement | null>(null);

  // A key is read back as the member it names, never cast.
  const nickOf = (key: Key) => rows.find((row) => row.nick === String(key))?.nick;

  return (
    <>
      <Virtualizer
        layout={ListLayout}
        layoutOptions={{ estimatedRowSize: rowHeight, loaderSize: rowHeight }}
      >
        <GridList
          aria-label="Members"
          className={styles.list}
          items={rows}
          onAction={(key) => {
            const nick = nickOf(key);

            anchor.current = nick === undefined ? null : (drawn.current.get(nick) ?? null);
            setMenu(anchor.current === null ? undefined : nick);
          }}
        >
          <Collection items={rows}>
            {(row) => (
              <GridListItem
                className={styles.item}
                id={row.nick}
                ref={(element) => {
                  if (element === null) {
                    drawn.current.delete(row.nick);
                  } else {
                    drawn.current.set(row.nick, element);
                  }
                }}
                textValue={row.label}
              >
                <Member row={row} />
              </GridListItem>
            )}
          </Collection>
          {more ? (
            <GridListLoadMoreItem
              className={styles.loading}
              isLoading={loading}
              onLoadMore={() => {
                askMore(timeline);
              }}
            >
              reading more…
            </GridListLoadMoreItem>
          ) : null}
        </GridList>
      </Virtualizer>
      {menu === undefined ? null : (
        <Actions
          anchor={anchor}
          nick={menu}
          onClose={() => {
            setMenu(undefined);
          }}
        />
      )}
    </>
  );
};

/**
 * Members over a narrow Pane's Timeline, under its bar, for a moment: a dialog that takes
 * the focus but leaves the page usable. Escape puts it away and gives the focus back to
 * where it was, and a press anywhere but on it or the Pane's toggle puts it away, unless a
 * member's menu is open, which a press outside it closes first.
 * @param props - The Pane, whether a member's menu is open, and the members.
 * @returns The members.
 */
const Floating = ({
  children,
  menuOpen,
  pane,
}: {
  readonly pane: string;
  readonly menuOpen: boolean;
  readonly children: ReactNode;
}) => {
  const dismiss = useAtomSet(membersDismissed);
  const panel = useRef<HTMLElement>(null);
  const before = useRef<HTMLElement | undefined>(undefined);

  // Where the focus was before the dialog takes it, as it does once drawn.
  useLayoutEffect(() => {
    const { activeElement } = document;

    before.current = activeElement instanceof HTMLElement ? activeElement : undefined;
  }, []);

  // Escape on the members, or in them, though not in a member's menu, which is elsewhere.
  useEffect(() => {
    const node = panel.current;

    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        dismiss(undefined);
        before.current?.focus();
      }
    };

    node?.addEventListener("keydown", escape);

    return () => {
      node?.removeEventListener("keydown", escape);
    };
  }, [dismiss]);

  useEffect(() => {
    const down = (event: PointerEvent) => {
      const { target } = event;

      if (menuOpen || !(target instanceof Element) || panel.current?.contains(target) === true) {
        return;
      }

      const toggle = target.closest<HTMLElement>("[data-members-toggle]");

      if (toggle?.dataset.membersToggle !== pane) {
        dismiss(undefined);
      }
    };

    document.addEventListener("pointerdown", down, true);

    return () => {
      document.removeEventListener("pointerdown", down, true);
    };
  }, [dismiss, menuOpen, pane]);

  return (
    <Dialog aria-label="Members" className={`${styles.panel} ${styles.floating}`} ref={panel}>
      {children}
    </Dialog>
  );
};

/**
 * A Pane's Channel's members, shown: as a sheet on a compact screen, over the Timeline in
 * a narrow Pane, and beside it elsewhere.
 * @param props - The Pane.
 * @returns The members.
 */
const Shown = ({ pane }: { readonly pane: string }) => {
  const sheet = useAtomValue(compact);
  const narrow = useAtomValue(paneNarrow(pane));
  const members = useAtomValue(roster(pane));
  const toggle = useAtomSet(toggleMembers);
  const headingId = useId();
  const [menu, setMenu] = useState<string | undefined>(undefined);

  let body = <p className={styles.dim}>Reading…</p>;
  let count: string | undefined;

  switch (members._tag) {
    case "None":
    case "Reading": {
      break;
    }

    case "Out": {
      body = <p className={styles.dim}>{members.note}</p>;
      break;
    }

    case "Failed": {
      body = <p className={styles.dim}>The Daemon has no such Channel.</p>;
      break;
    }

    case "Listed": {
      count = members.count === undefined ? undefined : String(members.count);
      body = (
        <Members
          loading={members.loading}
          menu={menu}
          more={members.more}
          rows={members.rows}
          setMenu={setMenu}
          timeline={members.timeline}
        />
      );
      break;
    }

    default: {
      return members satisfies never;
    }
  }

  if (sheet) {
    // A modal dialog needs its label, so the sheet keeps a heading, and a way to close it.
    return (
      <ModalOverlay
        className={styles.scrim}
        isDismissable
        isOpen
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            toggle({ pane, shown: false });
          }
        }}
      >
        <Modal className={styles.sheet}>
          <Dialog aria-labelledby={headingId} className={styles.panel}>
            <div className={styles.head}>
              <h2 className={styles.heading} id={headingId}>
                members
              </h2>
              {count === undefined ? null : <span className={styles.dim}>{count}</span>}
              <IconButton
                className={styles.close}
                command="members.toggle"
                icon="close"
                label="Hide the members"
                onPress={() => {
                  toggle({ pane, shown: false });
                }}
              />
            </div>
            {body}
          </Dialog>
        </Modal>
      </ModalOverlay>
    );
  }

  if (narrow) {
    return (
      <Floating menuOpen={menu !== undefined} pane={pane}>
        {body}
      </Floating>
    );
  }

  return (
    <section aria-label="Members" className={styles.panel}>
      {body}
    </section>
  );
};

/**
 * The members of a Pane's Channel, while they show there.
 * @param props - The Pane.
 * @returns The members, or nothing.
 */
export const MembersPanel = ({ pane }: { readonly pane: string }) => {
  const shown = useAtomValue(membersOpen(pane));
  const open = useAtomValue(channelOpen(pane));

  // Drawn afresh each time they show, so no menu outlives them.
  return shown && open ? <Shown pane={pane} /> : null;
};
