/**
 * The composer under the main view, the open Timeline's or, with none open, one where
 * commands that need no Timeline are typed: a prompt naming where it is, and a textarea.
 * Enter sends and Shift+Enter starts a new line, Up and Down recall what was sent from
 * the first and last lines, and Escape lets go of an error or a confirmation. What it
 * says goes through the command registry in the core, and the runtime carries it out.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { typesCredential } from "@iirc/frontend/commands";
import { linesOf } from "@iirc/frontend/composer";
import type { Offer, Place } from "@iirc/frontend/composer";
import type { KeyboardEvent } from "react";
import { useId } from "react";

import { openTimeline } from "../timelines/atoms.ts";
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
 * The composer of one Timeline, or the one under no Timeline.
 * @param props - Where it is, and the name its prompt shows.
 * @returns The composer.
 */
const Composer = ({ name, timeline }: { readonly timeline: Place; readonly name: string }) => {
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

      // A Credential's value typed here is refused, and let go of at once, the input's own
      // value and React DOM's tracker of it included, before anything else reads it.
      if (linesOf(value).some((line) => typesCredential(line))) {
        element.value = "";
      }

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

/**
 * The composer under the main view: the open Timeline's, or, with none open, the one
 * where commands that need no Timeline, such as `/network add` and `/set`, are typed.
 * @returns The composer.
 */
export const MainComposer = () => {
  const shown = useAtomValue(openTimeline);

  if (shown._tag === "Shown") {
    const name = shown.description?.name ?? "Timeline";

    return <Composer key={shown.timeline} name={name} timeline={shown.timeline} />;
  }

  return <Composer key="Nowhere" name="iirc" timeline="Nowhere" />;
};
