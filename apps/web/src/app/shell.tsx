/**
 * What a signed-in browser sees: the sidebar of Networks and their Timelines, with the
 * options and signing out at its foot, the Panes, each showing a Timeline or the options,
 * with its Channel's members beside it when shown, the composer under them, writing to the
 * focused Pane's Timeline, and the command palette and the keys. The sidebar's edge drags
 * or takes arrows to resize it, and it can be hidden, leaving a button before the composer's
 * prompt that marks what is unread, and the focus goes to the composer if it was in the
 * sidebar. On a compact screen the sidebar is a drawer instead, opened from a button in one
 * slim bar, beside the Panes' switcher.
 *
 * @packageDocumentation
 */
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { Level } from "@iirc/api";
import { saidLevel } from "@iirc/frontend/activity";
import type { Attempt } from "@iirc/frontend/sign-in";
import { Atom } from "effect/reactivity";
import { useContext, useLayoutEffect, useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";

import { composerFocus } from "../composer/atoms.ts";
import { MainComposer } from "../composer/composer.tsx";
import { CredentialPrompt } from "../options/credential-prompt.tsx";
import { compact, drawerShown } from "../page/drawer.ts";
import {
  defaultWidth,
  narrowest,
  resizeSidebar,
  showSidebar,
  sidebarBeside,
  sidebarWidth,
  widest,
} from "../page/sidebar.ts";
import { Keys } from "../palette/keys.tsx";
import { Palette } from "../palette/palette.tsx";
import { PaneSwitcher } from "../panes/pane-switcher.tsx";
import { PaneTree } from "../panes/pane-tree.tsx";
import { Pane } from "../panes/pane.tsx";
import { ImportDialog } from "../theme/import-dialog.tsx";
import { sidebarNetworks } from "../timelines/atoms.ts";
import { Sidebar } from "../timelines/sidebar.tsx";
import { IconButton } from "../ui/button.tsx";

import styles from "./shell.module.css";

/** The highest level said and unread across every Network, which the sidebar's button marks. */
const unread = Atom.make((get) => saidLevel(get(sidebarNetworks)));

/** What the sidebar's button says is unread, for a screen reader, by the highest level. */
const unreadWords: Readonly<Record<Level, string>> = {
  Activity: "",
  Direct: ", a Direct Message unread",
  Highlight: ", a Highlight unread",
  Message: ", Messages unread",
};

/** The class that colours the sidebar button's mark by the highest level unread. */
const markClass: Readonly<Record<Level, string>> = {
  Activity: "",
  Direct: styles.markDirect,
  Highlight: styles.markHighlight,
  Message: styles.markMessage,
};

/**
 * The button that shows the sidebar: its drawer on a compact screen, or its column when it
 * was hidden. It is marked while anything said is unread anywhere, by the highest level.
 * @returns The button.
 */
const SidebarButton = () => {
  const level = useAtomValue(unread);
  const shown = useAtomValue(drawerShown);
  const drawer = useAtomValue(compact);
  const registry = useContext(RegistryContext);

  return (
    <IconButton
      aria-expanded={drawer ? shown === "Sidebar" : false}
      className={drawer ? undefined : styles.show}
      command={drawer ? undefined : "sidebar.toggle"}
      icon={drawer ? "menu" : "showSidebar"}
      label={`${drawer ? "Networks" : "Show the sidebar"}${level === undefined ? "" : unreadWords[level]}`}
      onPress={() => {
        showSidebar(registry, true);
      }}
      size={drawer ? "regular" : "small"}
    >
      {level === undefined ? null : (
        <span aria-hidden="true" className={`${styles.mark} ${markClass[level]}`} />
      )}
    </IconButton>
  );
};

/** How far one arrow moves the sidebar's edge, and one with Shift held, in CSS pixels. */
const step = 16;
const bigStep = 64;

/**
 * Where a key moves the sidebar's edge to: an arrow a step, or with Shift a bigger one,
 * and Home and End to the narrowest and widest.
 * @param key - The key, as the browser names it.
 * @param width - The width now.
 * @param shift - Whether Shift is held.
 * @returns The width asked for, or none when the key does not move it.
 */
const edgeMoved = (key: string, width: number, shift: boolean): number | undefined => {
  const by = shift ? bigStep : step;

  switch (key) {
    case "ArrowLeft": {
      return width - by;
    }

    case "ArrowRight": {
      return width + by;
    }

    case "Home": {
      return narrowest;
    }

    case "End": {
      return widest;
    }

    default: {
      return undefined;
    }
  }
};

/**
 * The sidebar's edge, a window splitter: dragged, or focused and moved with the arrows,
 * Home and End, it resizes the sidebar, and a double click puts it back as it began. The
 * width is kept as a drag ends, and as each key moves it.
 * @returns The separator.
 */
const SidebarEdge = () => {
  const width = useAtomValue(sidebarWidth);
  const registry = useContext(RegistryContext);
  // Where a drag began: the pointer's x and the width then. A ref, since a drag is no state
  // anything else derives from.
  const dragged = useRef<{ readonly x: number; readonly width: number } | undefined>(undefined);

  const onPointerDown = (event: PointerEvent<HTMLHRElement>) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragged.current = { width, x: event.clientX };
  };

  const onPointerMove = (event: PointerEvent<HTMLHRElement>) => {
    const from = dragged.current;

    if (from !== undefined) {
      resizeSidebar(registry, from.width + event.clientX - from.x, false);
    }
  };

  const onPointerEnd = (event: PointerEvent<HTMLHRElement>) => {
    if (dragged.current !== undefined) {
      dragged.current = undefined;
      event.currentTarget.releasePointerCapture(event.pointerId);
      resizeSidebar(registry, registry.get(sidebarWidth), true);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLHRElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    const next = edgeMoved(event.key, width, event.shiftKey);

    if (next !== undefined) {
      event.preventDefault();
      resizeSidebar(registry, next, true);
    }
  };

  // A focusable separator with a value is the WAI-ARIA window splitter, an interactive
  // widget the rules below do not know.
  /* oxlint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions */
  return (
    <hr
      aria-label="Resize the sidebar"
      aria-orientation="vertical"
      aria-valuemax={widest}
      aria-valuemin={narrowest}
      aria-valuenow={width}
      className={styles.edge}
      onDoubleClick={() => {
        resizeSidebar(registry, defaultWidth, true);
      }}
      onKeyDown={onKeyDown}
      onLostPointerCapture={() => {
        dragged.current = undefined;
      }}
      onPointerCancel={onPointerEnd}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      tabIndex={0}
    />
  );
  /* oxlint-enable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions */
};

/**
 * The sidebar beside the Panes, and its edge. Hidden while the focus is in it, as its own
 * button or Alt+N does, it gives the focus to the composer, so the focus is never left on
 * the page's body.
 * @param props - The attempt to sign out, for the sidebar's foot.
 * @returns The sidebar and its edge.
 */
const SidebarColumn = ({ signOut: attempt }: { readonly signOut: Attempt }) => {
  const registry = useContext(RegistryContext);
  const column = useRef<HTMLDivElement>(null);

  // A layout effect, whose cleanup runs as the sidebar goes but before its nodes leave the
  // page, so it still sees where the focus is.
  useLayoutEffect(() => {
    const node = column.current;

    return () => {
      if (node?.contains(document.activeElement) === true) {
        registry.set(composerFocus, registry.get(composerFocus) + 1);
      }
    };
  }, [registry]);

  return (
    <div className={styles.column} ref={column}>
      <Sidebar signOut={attempt} />
      <SidebarEdge />
    </div>
  );
};

/**
 * The sidebar as a drawer from the side, on a compact screen: a modal dialog, which a
 * press on the page beside it or Escape closes, and so does choosing what to show.
 * @param props - The attempt to sign out, for the sidebar's foot.
 * @returns The drawer.
 */
const SidebarDrawer = ({ signOut: attempt }: { readonly signOut: Attempt }) => {
  const shown = useAtomValue(drawerShown);
  const registry = useContext(RegistryContext);

  return (
    <ModalOverlay
      className={styles.scrim}
      isDismissable
      isOpen={shown === "Sidebar"}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          showSidebar(registry, false);
        }
      }}
    >
      <Modal className={styles.drawer}>
        <Dialog aria-label="Networks" className={styles.drawerDialog}>
          <Sidebar signOut={attempt} />
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
};

/**
 * The shell, with the attempt to sign out.
 * @param props - The attempt to sign out.
 * @returns The shell.
 */
export const Shell = ({ signOut: attempt }: { readonly signOut: Attempt }) => {
  const drawn = useAtomValue(compact);
  const beside = useAtomValue(sidebarBeside);
  const width = useAtomValue(sidebarWidth);
  const shell = useRef<HTMLDivElement>(null);

  // The sidebar's width is the device's own, set through the CSSOM, which the Content
  // Security Policy allows where it refuses an inline style.
  useLayoutEffect(() => {
    shell.current?.style.setProperty("--sidebar-width", `${width}px`);
  }, [width]);

  return (
    <div className={styles.shell} ref={shell}>
      <h1 className={styles.title}>iirc</h1>
      {drawn ? (
        <header className={styles.bar}>
          <SidebarButton />
          <PaneSwitcher placement="Bar" />
        </header>
      ) : null}
      <div className={`${styles.body} ${beside ? styles.withSidebar : ""}`}>
        {beside ? <SidebarColumn signOut={attempt} /> : null}
        <main className={styles.main}>
          {drawn ? null : <PaneSwitcher placement="Row" />}
          <div className={styles.view}>
            <PaneTree render={(pane) => <Pane pane={pane} />} />
          </div>
          <CredentialPrompt />
          <MainComposer before={beside || drawn ? undefined : <SidebarButton />} />
        </main>
      </div>
      {drawn ? <SidebarDrawer signOut={attempt} /> : null}
      <Palette />
      <ImportDialog />
      <Keys />
    </div>
  );
};
