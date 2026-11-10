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
import { active, announced, completes, cycled } from "@iirc/frontend/completion";
import { linesOf } from "@iirc/frontend/composer";
import type { Offer, Place } from "@iirc/frontend/composer";
import type { KeyboardEvent } from "react";
import { useEffect, useId, useLayoutEffect, useRef } from "react";

import { openTimeline } from "../timelines/atoms.ts";
import { Button } from "../ui/button.tsx";
import {
  commandContext,
  composerFocus,
  confirmSend,
  dismiss,
  draft as draftAtom,
  recall,
  send,
  takeUp,
} from "./atoms.ts";
import { completionState } from "./completion-state.ts";
import { escapeCompletion, tab, typed } from "./completion.ts";

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
  const completion = useAtomValue(completionState);
  const setText = useAtomSet(typed);
  const complete = useAtomSet(tab);
  const restore = useAtomSet(escapeCompletion);
  const recallOne = useAtomSet(recall);
  const dismissNow = useAtomSet(dismiss);
  const sendNow = useAtomSet(send);
  const confirmNow = useAtomSet(confirmSend);
  const again = useAtomSet(takeUp);
  const focusAsked = useAtomValue(composerFocus);
  const input = useRef<HTMLTextAreaElement>(null);
  const focusSeen = useRef(focusAsked);
  const appliedSeen = useRef(completion.applied);
  const id = useId();
  const noticeId = `${id}-notice`;
  const hintId = `${id}-hint`;
  const { confirming, notice } = draft;
  const candidates = cycled(completion, timeline, draft.text);

  // Each time the composer is asked to take focus, after it mounted, the caret goes to the
  // end of its draft, which may have just been replaced.
  useEffect(() => {
    if (focusAsked === focusSeen.current) {
      return;
    }

    focusSeen.current = focusAsked;
    const element = input.current;

    element?.focus();
    element?.setSelectionRange(element.value.length, element.value.length);
  }, [focusAsked]);

  // Each time completion changes the text, the caret goes where it says, once the new text
  // is in the textarea: after the candidate, or back where it was on Escape.
  useLayoutEffect(() => {
    const { applied, caret } = completion;

    if (applied === appliedSeen.current) {
      return;
    }

    appliedSeen.current = applied;
    input.current?.setSelectionRange(caret, caret);
  }, [completion]);

  const offline =
    context.focus !== undefined && !context.session
      ? `${context.focus.network} is not connected: nothing can be said there until it is.`
      : undefined;

  /**
   * Tab completes the word at the caret, Shift+Tab backwards, and Escape gives back what
   * was typed while completing. With no word there, and nothing being completed, Tab moves
   * focus on, as it does anywhere.
   * @param event - The key.
   * @returns Whether completion took it.
   */
  const completionKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const { selectionEnd, selectionStart, value } = event.currentTarget;
    const completing = active(completion, timeline, { caret: selectionStart, text: value });
    const bare = !event.altKey && !event.ctrlKey && !event.metaKey;

    if (
      event.key === "Tab" &&
      bare &&
      selectionStart === selectionEnd &&
      (completing || completes(value, selectionStart))
    ) {
      event.preventDefault();
      complete({ backwards: event.shiftKey, caret: selectionStart, place: timeline, text: value });

      return true;
    }

    if (event.key === "Escape" && completing) {
      event.preventDefault();
      restore(timeline);

      return true;
    }

    return false;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget;
    const { selectionEnd, selectionStart, value } = element;
    const caret = selectionStart === selectionEnd;
    // An arrow with a modifier is the keymap's, such as Alt+ArrowUp to the previous Timeline.
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;

    // Composing text in an input method keeps its own keys.
    if (event.nativeEvent.isComposing) {
      return;
    }

    if (completionKey(event)) {
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
    } else if (
      event.key === "ArrowUp" &&
      plain &&
      caret &&
      !value.slice(0, selectionStart).includes("\n")
    ) {
      event.preventDefault();
      recallOne({ direction: "Older", timeline });
    } else if (
      event.key === "ArrowDown" &&
      plain &&
      caret &&
      !value.slice(selectionEnd).includes("\n")
    ) {
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
      {candidates === undefined ? null : (
        <p aria-hidden className={styles.candidates}>
          {candidates.candidates.map((candidate, index) => (
            <bdi
              className={index === candidates.index ? styles.chosen : styles.candidate}
              // A candidate's place in the list is what tells two apart, and it never moves.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
            >
              {candidate}
            </bdi>
          ))}
        </p>
      )}
      {/* A status, polite, present while the composer is, so each candidate is announced. */}
      <output aria-live="polite" className={styles.status}>
        {announced(completion, timeline, draft.text)}
      </output>
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
          ref={input}
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

    return <Composer name={name} timeline={shown.timeline} />;
  }

  // One composer element under every Timeline, so focus stays in it as Timelines open.
  return <Composer name="iirc" timeline="Nowhere" />;
};
