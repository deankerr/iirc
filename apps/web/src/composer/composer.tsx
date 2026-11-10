/**
 * The composer under the open Timeline: a prompt naming the Timeline, and a textarea.
 * Enter sends and Shift+Enter starts a new line, Up and Down recall what was sent from
 * the first and last lines, and Escape lets go of an error or a confirmation. What it
 * says goes through the command registry in the core, and the runtime carries it out.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { TimelineId } from "@iirc/api";
import type { Offer } from "@iirc/frontend/composer";
import type { KeyboardEvent } from "react";
import { useId } from "react";

import { Button } from "../ui/button.tsx";
import {
  commandContext,
  confirmSend,
  dismiss,
  draft as draftAtom,
  edit,
  recall,
  send,
  takeUp,
} from "./atoms.ts";

import styles from "./composer.module.css";

/**
 * What a notice's button says.
 * @param offer - What it offers.
 * @returns Its label.
 */
const offerLabel = (offer: Offer) => {
  if (offer._tag === "CheckAgain") {
    return "Check again";
  }

  return offer.intent === undefined ? "Send the rest" : "Send again";
};

/**
 * The composer of one Timeline.
 * @param props - The Timeline and its name.
 * @returns The composer.
 */
export const Composer = ({
  name,
  timeline,
}: {
  readonly timeline: TimelineId;
  readonly name: string;
}) => {
  const draft = useAtomValue(draftAtom(timeline));
  const context = useAtomValue(commandContext);
  const setText = useAtomSet(edit);
  const recallOne = useAtomSet(recall);
  const dismissNow = useAtomSet(dismiss);
  const sendNow = useAtomSet(send);
  const confirmNow = useAtomSet(confirmSend);
  const again = useAtomSet(takeUp);
  const id = useId();
  const noticeId = `${id}-notice`;
  const hintId = `${id}-hint`;
  const { confirming, notice } = draft;

  const offline =
    context.focus !== undefined && !context.session
      ? `${context.focus.network} is not connected: nothing can be said there until it is.`
      : undefined;

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget;
    const { selectionEnd, selectionStart, value } = element;
    const caret = selectionStart === selectionEnd;

    // Composing text in an input method keeps its own keys.
    if (event.nativeEvent.isComposing) {
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();

      if (confirming === undefined) {
        sendNow(timeline);
      } else {
        confirmNow(timeline);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      dismissNow(timeline);
    } else if (event.key === "ArrowUp" && caret && !value.slice(0, selectionStart).includes("\n")) {
      event.preventDefault();
      recallOne({ direction: "Older", timeline });
    } else if (event.key === "ArrowDown" && caret && !value.slice(selectionEnd).includes("\n")) {
      event.preventDefault();
      recallOne({ direction: "Newer", timeline });
    }
  };

  const describedBy = [
    notice === undefined && confirming === undefined ? undefined : noticeId,
    offline === undefined ? undefined : hintId,
  ]
    .filter((one) => one !== undefined)
    .join(" ");

  return (
    <div className={styles.composer}>
      {confirming === undefined ? null : (
        <div className={styles.notice} id={noticeId} role="alert">
          <p>
            Send {confirming.lines} lines to <bdi>{name}</bdi>? Enter sends them, Escape keeps them
            here.
          </p>
          <Button
            onPress={() => {
              confirmNow(timeline);
            }}
            variant="primary"
          >
            Send {confirming.lines} lines
          </Button>
        </div>
      )}
      {notice === undefined || confirming !== undefined ? null : (
        <div className={`${styles.notice} ${styles.failure}`} id={noticeId} role="alert">
          <p>{notice.message}</p>
          {notice.offer === undefined ? null : (
            <Button
              onPress={() => {
                again(timeline);
              }}
            >
              {offerLabel(notice.offer)}
            </Button>
          )}
        </div>
      )}
      {offline === undefined ? null : (
        <p className={styles.hint} id={hintId}>
          {offline}
        </p>
      )}
      <div className={styles.line}>
        <label className={styles.prompt} htmlFor={id}>
          <bdi>{name}</bdi>
          <span aria-hidden="true">&gt;</span>
        </label>
        <textarea
          aria-describedby={describedBy === "" ? undefined : describedBy}
          aria-invalid={notice === undefined ? undefined : true}
          autoComplete="off"
          className={styles.input}
          id={id}
          onChange={(event) => {
            setText({ text: event.currentTarget.value, timeline });
          }}
          onKeyDown={onKeyDown}
          rows={1}
          spellCheck
          value={draft.text}
        />
      </div>
    </div>
  );
};
