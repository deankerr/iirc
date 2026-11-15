/**
 * The composer under the Panes, the focused Pane's Timeline's or, with none open, one where
 * commands that need no Timeline are typed: a prompt naming where it is, and a textarea.
 * Enter sends, or begins a new line, as `ui.enter` says, and the other is Enter with a
 * modifier; where Enter begins a new line a button sends too, as a phone's keyboard has no
 * modifier. Up and Down recall what was sent from the first and last lines, and Tab
 * completes, a nick at the start of a line followed by `ui.suffix`. Spelling is checked as
 * `ui.spellcheck` says. Escape lets go of an error or a confirmation, or, with
 * neither, closes what stands in front of the focused Pane's Timeline, the options, the
 * search, or a Direct Message not yet begun, or with nothing in front, puts its Lookup card
 * away. Files pasted, dropped on it, picked, or photographed are uploaded, each link going
 * where the caret was. What it says goes through the command registry in the core, and the
 * runtime carries it out.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { typesCredential } from "@iirc/frontend/commands";
import type { CommandContext } from "@iirc/frontend/commands";
import { active, announced, completes, cycled } from "@iirc/frontend/completion";
import { linesOf, placeOfDraft } from "@iirc/frontend/composer";
import type { Offer, Place } from "@iirc/frontend/composer";
import { enterPressed, sendChord, showChord } from "@iirc/frontend/keymap";
import { allScope } from "@iirc/frontend/palette";
import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { dismissCard } from "../lookup/atoms.ts";
import { closeOptions, mainView } from "../options/atoms.ts";
import { enterShown, spellcheckShown } from "../options/ui.ts";
import { keyOf } from "../palette/press.ts";
import { openPalette, platform } from "../palette/state.ts";
import { focusedId, paneNumber } from "../panes/atoms.ts";
import { closeSearch } from "../search/atoms.ts";
import { closeDraft, openTimeline, sidebarNetworks } from "../timelines/atoms.ts";
import { Button, IconButton } from "../ui/button.tsx";
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
import { PendingUploads } from "./pending-uploads.tsx";
import { caretAsked } from "./uploading-state.ts";
import { addFiles } from "./uploading.ts";

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
 * Whether Self is away on a Network, as the Ircd confirmed it, said quietly beside the
 * prompt, with the message as its title.
 * @param props - The Network, if any.
 * @returns The mark, or nothing while Self is not known to be away.
 */
const AwayMark = ({ network }: { readonly network: string | undefined }) => {
  const networks = useAtomValue(sidebarNetworks);
  const away = networks.find((one) => one.network === network)?.away;

  if (away?._tag !== "Away") {
    return null;
  }

  return (
    <span
      className={styles.away}
      title={away.message === "" ? "You are away" : `You are away: ${away.message}`}
    >
      (away)
    </span>
  );
};

/**
 * The way to the command palette from a touch screen, which has no keys to open it with,
 * beside the composer. Elsewhere Mod+K opens it, and the button is not drawn.
 * @returns The button.
 */
const PaletteButton = () => {
  const openNow = useAtomSet(openPalette);

  return (
    <IconButton
      className={styles.palette}
      command="palette.open"
      icon="palette"
      label="Command palette"
      onPress={() => {
        openNow(allScope);
      }}
      size="small"
    />
  );
};

/**
 * Whether a drag carries files, rather than text or a link.
 * @param event - The drag.
 * @returns Whether it does.
 */
const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

/**
 * The ways to add files to the composer beside the drop and the paste: a picker of several
 * files, and, where the palette's button shows, as on a phone, the camera.
 * @param props - What adding files does.
 * @returns The buttons, and the inputs they open.
 */
const FileButtons = ({ add }: { readonly add: (files: readonly File[]) => void }) => {
  const picker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);

  // A file input holds what was chosen until it is cleared, so choosing the same file
  // again would change nothing.
  const chosen = (input: HTMLInputElement) => {
    const files = [...(input.files ?? [])];

    input.value = "";
    add(files);
  };

  return (
    <>
      <input
        aria-label="Files to upload"
        className={styles.files}
        multiple
        onChange={(event) => {
          chosen(event.currentTarget);
        }}
        ref={picker}
        tabIndex={-1}
        type="file"
      />
      <input
        accept="image/*"
        aria-label="Photo to upload"
        capture="environment"
        className={styles.files}
        onChange={(event) => {
          chosen(event.currentTarget);
        }}
        ref={camera}
        tabIndex={-1}
        type="file"
      />
      <IconButton
        icon="attach"
        label="Upload files"
        onPress={() => {
          picker.current?.click();
        }}
        size="small"
      />
      <IconButton
        className={styles.camera}
        icon="camera"
        label="Take a photo"
        onPress={() => {
          camera.current?.click();
        }}
        size="small"
      />
    </>
  );
};

/** Why nothing can be said where the composer is: above it, and in it before anything is typed. */
interface Sayable {
  readonly offline: string | undefined;
  readonly placeholder: string | undefined;
}

/**
 * Why nothing can be said where the composer is, if it cannot: its Network is not
 * connected, said above it, or was removed, said in it before anything is typed, while
 * commands still run there.
 * @param context - The context commands are judged in.
 * @returns What is said above it, and in it.
 */
const sayable = (context: CommandContext): Sayable => {
  const { draft, focus, session } = context;

  if (focus?.removed === true) {
    return {
      offline: undefined,
      placeholder: `${focus.network} was removed: nothing can be said here`,
    };
  }

  const network = focus?.network ?? draft?.network;

  return {
    offline:
      network === undefined || session
        ? undefined
        : `${network} is not connected: nothing can be said there until it is.`,
    placeholder: undefined,
  };
};

/**
 * The composer of one Timeline, or the one under no Timeline.
 * @param props - Where it is, the name its prompt shows, and what stands before the prompt.
 * @returns The composer.
 */
const Composer = ({
  before,
  name,
  number,
  timeline,
}: {
  readonly timeline: Place;
  readonly name: string;
  readonly number: number | undefined;
  readonly before: ReactNode;
}) => {
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
  const addNow = useAtomSet(addFiles);
  const caretWanted = useAtomValue(caretAsked);
  const caretSeen = useRef(caretWanted.asked);
  const [dropping, setDropping] = useState(false);
  const closeCard = useAtomSet(dismissCard);
  const closeTheDraft = useAtomSet(closeDraft);
  const closeTheOptions = useAtomSet(closeOptions);
  const closeTheSearch = useAtomSet(closeSearch);
  const main = useAtomValue(mainView);
  const pane = useAtomValue(focusedId);
  const focusAsked = useAtomValue(composerFocus);
  const enter = useAtomValue(enterShown);
  const spellcheck = useAtomValue(spellcheckShown);
  const sendKeys = showChord(sendChord(enter), platform);
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

  // Each time a link goes into the draft while the Owner writes in it, the caret goes where
  // the core says, once the new text is in the textarea.
  useLayoutEffect(() => {
    if (caretWanted.asked === caretSeen.current) {
      return;
    }

    caretSeen.current = caretWanted.asked;
    input.current?.setSelectionRange(caretWanted.caret, caretWanted.caret);
  }, [caretWanted]);

  /**
   * Adds files to this composer, their links to go where the caret is now.
   * @param files - The files.
   */
  const add = (files: readonly File[]) => {
    if (files.length > 0) {
      addNow({
        anchor: input.current?.selectionStart ?? draft.text.length,
        files,
        place: timeline,
        text: draft.text,
      });
    }
  };

  // A paste of files uploads them, and one of text alone is the textarea's own.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];

    if (files.length > 0) {
      event.preventDefault();
      add(files);
    }
  };

  const onDragOver = (event: DragEvent) => {
    if (carriesFiles(event)) {
      event.preventDefault();
      setDropping(true);
    }
  };

  const onDrop = (event: DragEvent) => {
    setDropping(false);

    if (carriesFiles(event)) {
      event.preventDefault();
      add([...event.dataTransfer.files]);
    }
  };

  const network = context.focus?.network ?? context.draft?.network;
  const { offline, placeholder } = sayable(context);

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

  // Escape lets go of a notice or a confirmation first. With neither, it closes what stands
  // in front of the focused Pane's Timeline, the options, the search, or a draft, and with
  // nothing in front, puts its Lookup card away.
  const escaped = () => {
    if (notice !== undefined || confirming !== undefined) {
      dismissNow(timeline);

      return;
    }

    switch (main._tag) {
      case "Options": {
        closeTheOptions();
        break;
      }

      case "Search": {
        closeTheSearch();
        break;
      }

      case "DirectDraft": {
        closeTheDraft();
        break;
      }

      case "Timeline": {
        closeCard(pane);
        break;
      }

      default: {
        main satisfies never;
      }
    }
  };

  /**
   * Sends what the composer holds, or the lines waiting to be confirmed. A Credential's
   * value typed here is refused, and let go of at once, the textarea's own value and React
   * DOM's tracker of it included, before anything else reads it.
   * @param element - The textarea.
   */
  const sendFrom = (element: HTMLTextAreaElement | null) => {
    if (element !== null && linesOf(element.value).some((line) => typesCredential(line))) {
      element.value = "";
    }

    if (confirming === undefined) {
      sendNow(timeline);
    } else {
      confirmNow(timeline);
    }
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

    // Enter that begins a new line is the textarea's own, so only one that sends is taken.
    const entered = enterPressed(enter, keyOf(event.nativeEvent), platform);

    if (entered === "Send") {
      event.preventDefault();
      sendFrom(element);
    } else if (event.key === "Escape") {
      event.preventDefault();
      escaped();
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
    <div
      className={dropping ? `${styles.composer} ${styles.dropping}` : styles.composer}
      data-dropping={dropping ? "" : undefined}
      onDragLeave={(event) => {
        // Moving between what the composer holds leaves one part of it, not the composer.
        const to = event.relatedTarget;

        if (!(to instanceof Node && event.currentTarget.contains(to))) {
          setDropping(false);
        }
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <PendingUploads place={timeline} />
      {confirming === undefined ? null : (
        <div className={styles.notice} id={noticeId} role="alert">
          <p>
            Send {confirming.lines} lines to <bdi>{name}</bdi>? {sendKeys} sends them, Escape keeps
            them here.
          </p>
          <Button
            onPress={() => {
              sendFrom(input.current);
            }}
            size="small"
            variant="primary"
          >
            Send {confirming.lines} lines
          </Button>
        </div>
      )}
      {notice === undefined || confirming !== undefined ? null : (
        <div className={`${styles.notice} ${styles.failure}`} id={noticeId} role="alert">
          <p>{notice.message}</p>
          {notice._tag === "Offering" ? (
            <Button
              onPress={() => {
                again(timeline);
              }}
              size="small"
            >
              {offerLabel(notice.offer)}
            </Button>
          ) : null}
          <IconButton
            icon="close"
            keys="Esc"
            label="Dismiss"
            onPress={() => {
              dismissNow(timeline);
            }}
            size="small"
          />
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
        {before}
        <label className={styles.prompt} htmlFor={id}>
          {number === undefined ? null : <span className={styles.pane}>{number}</span>}
          <bdi>{name}</bdi>
          <AwayMark network={network} />
          <span aria-hidden="true">&gt;</span>
        </label>
        <textarea
          // Among several Panes, the number shown is said with what it is.
          aria-label={number === undefined ? undefined : `Pane ${number}: ${name}`}
          aria-describedby={describedBy === "" ? undefined : describedBy}
          aria-invalid={notice === undefined ? undefined : true}
          autoComplete="off"
          className={styles.input}
          data-composer=""
          id={id}
          onChange={(event) => {
            setText({ text: event.currentTarget.value, timeline });
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          ref={input}
          rows={1}
          spellCheck={spellcheck}
          value={draft.text}
        />
        {enter === "newline" ? (
          <IconButton
            icon="send"
            keys={sendKeys}
            label="Send"
            onPress={() => {
              sendFrom(input.current);
              input.current?.focus();
            }}
            size="small"
          />
        ) : null}
        <FileButtons add={add} />
        <PaletteButton />
      </div>
    </div>
  );
};

/**
 * The composer under the Panes: the focused Pane's open Timeline's, or, with none open, the
 * one where commands that need no Timeline, such as `/network add` and `/set`, are typed.
 * Among several Panes, its prompt says the focused Pane's number, as its header does.
 * @param props - What stands before its prompt, such as the button that shows the sidebar.
 * @returns The composer.
 */
export const MainComposer = ({ before }: { readonly before?: ReactNode }) => {
  const shown = useAtomValue(openTimeline);
  const main = useAtomValue(mainView);
  const number = useAtomValue(paneNumber(useAtomValue(focusedId)));

  // A Direct Message not yet begun has a composer of its own, which says plain text to its
  // nick.
  if (main._tag === "DirectDraft") {
    return (
      <Composer
        before={before}
        name={main.nick}
        number={number}
        timeline={placeOfDraft(main.network, main.nick)}
      />
    );
  }

  // Its prompt names what the Pane shows: the options or the search by name, in front of
  // the Timeline it writes to.
  const name = main._tag === "Timeline" ? undefined : main._tag.toLowerCase();

  if (shown._tag === "Shown") {
    return (
      <Composer
        before={before}
        name={name ?? shown.description?.name ?? "Timeline"}
        number={number}
        timeline={shown.timeline}
      />
    );
  }

  // One composer element under every Timeline, so focus stays in it as Timelines open.
  return <Composer before={before} name={name ?? "iirc"} number={number} timeline="Nowhere" />;
};
