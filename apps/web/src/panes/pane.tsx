/**
 * One Pane: its status bar, and under it its open Timeline, the options, the search, or a
 * Direct Message not yet begun, each of which draws the bar it needs, and its Channel's
 * members under the bar while they show. Among
 * several shown, the one with the focus is marked along its top and its bottom. A press or
 * the focus moving anywhere in it gives it the focus, so the composer then writes to its
 * Timeline. It is measured as it is drawn, since a narrow Pane shows its members over its
 * Timeline rather than beside it.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Pane as PaneOf } from "@iirc/frontend/layout";
import type { PaneView } from "@iirc/frontend/timelines";
import { useRef } from "react";

import { MembersPanel } from "../channel/members-panel.tsx";
import { TimelineHeader } from "../channel/timeline-header.tsx";
import { OptionsView } from "../options/options-view.tsx";
import { SearchView } from "../search/search-view.tsx";
import { DraftView } from "../timelines/draft-view.tsx";
import { TimelineView } from "../timelines/timeline-view.tsx";
import { alone, focusedId, focusPane, paneNumber } from "./atoms.ts";
import { useMeasured } from "./measure.ts";

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
      return <OptionsView pane={pane.id} />;
    }

    case "Search": {
      return <SearchView pane={pane.id} />;
    }

    case "Timeline": {
      return <TimelineView pane={pane.id} />;
    }

    case "DirectDraft": {
      return (
        <DraftView network={pane.view.main.network} nick={pane.view.main.nick} pane={pane.id} />
      );
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
  const element = useRef<HTMLDivElement>(null);

  useMeasured(pane.id, element);

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
      ref={element}
    >
      {pane.view.main._tag === "Timeline" ? <TimelineHeader pane={pane.id} /> : null}
      <div className={styles.body}>
        <div className={styles.main}>{main(pane)}</div>
        <MembersPanel pane={pane.id} />
      </div>
    </div>
  );
};
