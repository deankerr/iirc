/**
 * One Pane: its open Timeline with its header, the options, the search, or a Direct Message
 * not yet begun, and its Channel's members
 * beside it while they show, marked while it has the focus. A press or the focus moving
 * anywhere in it gives it the focus, so the composer then writes to its Timeline.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Pane as PaneOf } from "@iirc/frontend/layout";
import type { PaneView } from "@iirc/frontend/timelines";

import { MembersPanel } from "../channel/members-panel.tsx";
import { OptionsView } from "../options/options-view.tsx";
import { SearchView } from "../search/search-view.tsx";
import { DraftView } from "../timelines/draft-view.tsx";
import { TimelineView } from "../timelines/timeline-view.tsx";
import { alone, focusedId, focusPane, paneNumber } from "./atoms.ts";

import styles from "./pane.module.css";

/**
 * What a Pane shows in its main place: the options, the search, a Direct Message not yet
 * begun, or its Timeline.
 * @param pane - The Pane.
 * @returns The view.
 */
const main = (pane: PaneOf<PaneView>) => {
  switch (pane.view.main._tag) {
    case "Options": {
      return <OptionsView />;
    }

    case "Search": {
      return <SearchView />;
    }

    case "Timeline": {
      return <TimelineView pane={pane.id} />;
    }

    case "DirectDraft": {
      return <DraftView network={pane.view.main.network} nick={pane.view.main.nick} />;
    }

    default: {
      return pane.view.main satisfies never;
    }
  }
};

/**
 * One Pane's content.
 * @param props - The Pane.
 * @returns The Pane.
 */
export const Pane = ({ pane }: { readonly pane: PaneOf<PaneView> }) => {
  const focused = useAtomValue(focusedId) === pane.id;
  const one = useAtomValue(alone);
  const number = useAtomValue(paneNumber(pane.id));
  const focus = useAtomSet(focusPane);

  return (
    <div
      aria-current={focused && number !== undefined ? "true" : undefined}
      className={styles.pane}
      data-focused={focused}
      data-marked={focused && number !== undefined && !one}
      data-pane={pane.id}
      onFocusCapture={() => {
        focus(pane.id);
      }}
      onPointerDownCapture={() => {
        focus(pane.id);
      }}
    >
      <div className={styles.main}>{main(pane)}</div>
      <MembersPanel pane={pane.id} />
    </div>
  );
};
