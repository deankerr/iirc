/**
 * The menu on a nick, built once and opened wherever a nick is shown: from a Timeline's
 * line, a Lookup card's profile, or the members' list. A nick is a control that looks as
 * the nick does, opened by a press, by Enter or Space once focused, by the context menu,
 * as a right-click, the menu key, or Shift+F10 opens it, and by a long press on a touch
 * screen, which shows no callout of the browser's. The menu offers what the core's
 * `nickEntries` gives, each the command the Composer would run, and choosing one closes it
 * and puts away members that lie over something. While more may come, a wait is drawn
 * where it will go, as an entry that cannot be chosen, as tall as what may come, so a menu
 * placed above its nick, which grows upward, moves nothing when it arrives either.
 *
 * @packageDocumentation
 */
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { TimelineId } from "@iirc/api";
import { nickEntries } from "@iirc/frontend/nick-menu";
import type { NickEntry, Presence } from "@iirc/frontend/nick-menu";
import { useContext, useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, PointerEvent, ReactNode, RefObject } from "react";
import { Menu, MenuItem, Popover, Pressable } from "react-aria-components";

import { membersDismissed } from "../channel/state.ts";
import { commandContext, perform } from "../composer/atoms.ts";
import { closeNickMenu, nickMenusState, openNickMenu } from "./atoms.ts";

import styles from "./nick-menu.module.css";

/** How long a touch is held before it opens the menu, as a phone's own long press does. */
const longPressMs = 500;

/** How far a held touch may move, in CSS pixels, before it is a scroll and opens nothing. */
const longPressSlop = 10;

/** The id of the wait drawn where more entries will go. */
const waitId = "reading";

/**
 * The wait drawn where more entries will go, which cannot be chosen.
 * @param nick - The nick.
 * @returns It, as an entry with nothing to do.
 */
const waitFor = (nick: string): NickEntry => ({
  id: waitId,
  intents: [],
  label: `Reading what else can be done with ${nick}`,
  text: "reading…",
});

/**
 * The style that makes the wait as tall as the entries that may come.
 * @param coming - How many may.
 * @returns The style.
 */
const waitStyle = (coming: number): CSSProperties => {
  const style: Record<`--${string}`, string> = { "--coming": String(coming) };

  return style;
};

/**
 * What can be done with a User, as a menu anchored to where their nick was pressed, with
 * anything to say of them above it.
 * @param props - The nick, the Timeline it was opened in, whether the User is in its
 * Channel, what it is anchored to, what closes it, and what stands above it.
 * @returns The menu.
 */
export const NickMenu = ({
  anchor,
  children,
  nick,
  onClose,
  presence,
  timeline,
}: {
  readonly nick: string;
  readonly timeline: TimelineId;
  readonly presence: Presence;
  readonly anchor: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly children?: ReactNode;
}) => {
  const context = useAtomValue(commandContext);
  const carryOut = useAtomSet(perform);
  const dismiss = useAtomSet(membersDismissed);
  const { coming, entries } = nickEntries(nick, timeline, presence, context);
  const rows = coming > 0 ? [...entries, waitFor(nick)] : entries;

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
      {children}
      <Menu
        aria-label={`What to do with ${nick}`}
        autoFocus="first"
        className={styles.menu}
        disabledKeys={[waitId]}
        items={rows}
        onAction={(key) => {
          const chosen = entries.find((entry) => entry.id === String(key));

          onClose();

          if (chosen !== undefined) {
            dismiss(undefined);
            carryOut(chosen.intents);
          }
        }}
      >
        {(entry) => (
          <MenuItem
            aria-label={entry.label}
            className={styles.entry}
            id={entry.id}
            {...(entry.id === waitId ? { style: waitStyle(coming) } : {})}
            textValue={entry.text}
          >
            {entry.id === waitId ? (
              <span className={styles.waiting}>{entry.text}</span>
            ) : (
              entry.text
            )}
          </MenuItem>
        )}
      </Menu>
    </Popover>
  );
};

/**
 * A nick, drawn as given, that opens the menu on it, in the Timeline it is shown in, whose
 * Channel's members are read to say whether the User is still there.
 * @param props - The nick, the Timeline, and the nick as drawn.
 * @returns The nick, and its menu while open.
 */
export const NickButton = ({
  children,
  nick,
  timeline,
}: {
  readonly nick: string;
  readonly timeline: TimelineId;
  readonly children: ReactNode;
}) => {
  const registry = useContext(RegistryContext);
  const menus = useAtomValue(nickMenusState);
  const close = useAtomSet(closeNickMenu);
  const anchor = useRef<HTMLSpanElement>(null);
  const [request, setRequest] = useState<number | undefined>(undefined);

  const held = useRef<{ readonly timer: number; readonly x: number; readonly y: number }>(
    undefined
  );

  const open = request !== undefined && menus.open?.request === request ? menus.open : undefined;

  // A touch still held when the nick goes lets go of its timer.
  useEffect(
    () => () => {
      window.clearTimeout(held.current?.timer);
    },
    []
  );

  // Opened once: the release after a long press, which is also a press, opens nothing more.
  const opening = () => {
    if (request !== undefined && registry.get(nickMenusState).open?.request === request) {
      return;
    }

    // The context is the focused Pane's, which a press in this one has just made it.
    const { focus } = registry.get(commandContext);
    const channel = focus?.timeline === timeline && focus.kind === "Channel";

    setRequest(openNickMenu(registry, { channel, nick, timeline }));
  };

  const letGo = () => {
    window.clearTimeout(held.current?.timer);
    held.current = undefined;
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== "touch") {
      return;
    }

    letGo();
    held.current = {
      timer: window.setTimeout(() => {
        held.current = undefined;
        opening();
      }, longPressMs),
      x: event.clientX,
      y: event.clientY,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const start = held.current;

    if (
      start !== undefined &&
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > longPressSlop
    ) {
      letGo();
    }
  };

  // The context menu, from a pointer, a held touch, or the keyboard, opens this menu in
  // place of the browser's, and of the menu of the row the nick is in.
  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    letGo();
    opening();
  };

  return (
    <>
      <Pressable onPress={opening}>
        <span
          aria-expanded={open !== undefined}
          aria-haspopup="menu"
          className={styles.nick}
          data-open={open === undefined ? undefined : true}
          onContextMenu={onContextMenu}
          onPointerCancel={letGo}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={letGo}
          ref={anchor}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a button is never inline, so a nick could not wrap or be cut with its line.
          role="button"
          tabIndex={0}
        >
          {children}
        </span>
      </Pressable>
      {open === undefined ? null : (
        <NickMenu
          anchor={anchor}
          nick={open.nick}
          onClose={() => {
            close(open.request);
            setRequest(undefined);
          }}
          presence={open.presence}
          timeline={open.timeline}
        />
      )}
    </>
  );
};
