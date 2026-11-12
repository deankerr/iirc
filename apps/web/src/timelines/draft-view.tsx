/**
 * A Direct Message not yet begun: its Pane's status bar naming the nick and its Network,
 * with a close button, and a log saying nothing was said yet. Nothing exists of it until something is
 * said: the composer under it says plain text to the nick, and once the Daemon placed that
 * Message, the Pane shows the Timeline it made. Escape in it, or the close button, shows
 * what the Pane showed before.
 *
 * @packageDocumentation
 */
import { RegistryContext, useAtomSet } from "@effect/atom-react";
import type { NetworkId } from "@iirc/api";
import type { KeyboardEvent } from "react";
import { useContext } from "react";

import { composerFocus } from "../composer/atoms.ts";
import { BarText, PaneBar } from "../panes/pane-bar.tsx";
import { IconButton } from "../ui/button.tsx";
import { closeDraft } from "./atoms.ts";

import styles from "./draft-view.module.css";

/**
 * The view of a Direct Message not yet begun.
 * @param props - Its Network, the nick it is to, and its Pane.
 * @returns The view.
 */
export const DraftView = ({
  network,
  nick,
  pane,
}: {
  readonly network: NetworkId;
  readonly nick: string;
  readonly pane: string;
}) => {
  const close = useAtomSet(closeDraft);
  const registry = useContext(RegistryContext);

  // Closing shows what the Pane showed before, and gives the composer the focus.
  const closeNow = () => {
    close();
    registry.set(composerFocus, registry.get(composerFocus) + 1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      closeNow();
    }
  };

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- it only hears Escape from what is inside it, each of which takes its own keys.
    <section
      aria-label={`Direct Message with ${nick}`}
      className={styles.view}
      onKeyDown={onKeyDown}
    >
      <PaneBar
        end={
          <IconButton
            icon="close"
            keys="Esc"
            label={`Close the Direct Message with ${nick}`}
            onPress={closeNow}
            size="small"
          />
        }
        name={nick}
        pane={pane}
      >
        <BarText>
          Direct Message on <bdi>{network}</bdi>
        </BarText>
      </PaneBar>
      <p className={styles.log}>
        No Messages with <bdi>{nick}</bdi> yet. What you say below starts the conversation.
      </p>
    </section>
  );
};
