/**
 * The composer under the Panes, the focused Pane's Timeline's or, with none open, one where
 * commands that need no Timeline are typed: a prompt naming where it is, and a textarea.
 * Enter sends, or begins a new line, as `ui.enter` says, and the other is Enter with a
 * modifier; where Enter begins a new line a button sends too, as a phone's keyboard has no
 * modifier. Up and Down recall what was sent from the first and last lines. What it can
 * complete is listed above it, a listbox it owns while the textarea keeps the focus: as a
 * draft that starts with `/` is typed, or on Tab for anything else, a nick at the start of
 * a line followed by `ui.suffix`. Tab and the arrows move through it while it is open. Spelling is checked as
 * `ui.spellcheck` says. What a draft answers is shown dim above its line, cut to the line,
 * with a button that drops it. Escape lets go of an error or a confirmation, or, with
 * neither, of what the draft answers, or, with none, closes what stands in front of the focused Pane's Timeline, the options, the
 * search, or a Direct Message not yet begun, or with nothing in front, puts its Lookup card
 * away. Over a command started from a key, which set a draft aside, Escape puts the command
 * away and brings the draft back, whatever else is shown. Files pasted, dropped on it, picked, or photographed are uploaded, each link going
 * where the caret was. What it says goes through the command registry in the core, and the
 * runtime carries it out.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { typesCredential } from "@iirc/frontend/commands";
import type { CommandContext } from "@iirc/frontend/commands";
import { completes } from "@iirc/frontend/completion";
import type { Candidate, List } from "@iirc/frontend/completion";
import { linesOf, placeOfDraft } from "@iirc/frontend/composer";
import type { Answering, Offer, Place } from "@iirc/frontend/composer";
import { fontDescription, networkDescription, themeDescription } from "@iirc/frontend/entries";
import {
  colourChoices,
  colouredStyle,
  colourName,
  hasFormatting,
  linesIn,
  pendingWords,
  plainOf,
} from "@iirc/frontend/formatting";
import { chordsFor, enterPressed, sendChord, showChord } from "@iirc/frontend/keymap";
import { formatted, quotedOf } from "@iirc/frontend/render";
import { runColours } from "@iirc/frontend/theme";
import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { keyOf } from "../keys/press.ts";
import { keymapState, platform } from "../keys/state.ts";
import { dismissCard } from "../lookup/atoms.ts";
import { closeOptions, closeUploads, mainView } from "../options/atoms.ts";
import { enterShown, spellcheckShown } from "../options/ui.ts";
import { focusedId, paneNumber } from "../panes/atoms.ts";
import { closeSearch } from "../search/atoms.ts";
import { drawnTheme } from "../theme/atoms.ts";
import { closeDraft, openTimeline, sidebarNetworks } from "../timelines/atoms.ts";
import { Inlines } from "../timelines/inlines.tsx";
import { Nick } from "../timelines/line.tsx";
import { Button, IconButton } from "../ui/button.tsx";
import {
  colourChoiceAt,
  colourChosen,
  colourDismissed,
  colourMoved,
  commandContext,
  composerFocus,
  confirmSend,
  dismiss,
  draft as draftAtom,
  dropReply,
  perform,
  recall,
  restoreDraft,
  send,
  takeUp,
} from "./atoms.ts";
import { completionState } from "./completion-state.ts";
import { completionShown, escapeCompletion, moved, pick, tab, typed } from "./completion.ts";
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
 * The way to start a command from a touch screen, which has no keys to start one with,
 * beside the composer: it does what Mod+Shift+P does, starting `/` with the list open.
 * Elsewhere the keys do, and the button is not drawn.
 * @returns The button.
 */
const CommandButton = () => {
  const start = useAtomSet(perform);
  const keymap = useAtomValue(keymapState);
  const keys = chordsFor(keymap, "composer.focus", "/").map((chord) => showChord(chord, platform));

  return (
    <IconButton
      className={styles.command}
      icon="command"
      keys={keys.length === 0 ? undefined : keys.join(" ")}
      label="Start a command"
      onPress={() => {
        start([{ _tag: "StartCommand", text: "/" }]);
      }}
      size="small"
    />
  );
};

/**
 * What a draft answers, dim, above its line: who said it, as a reply shows it, and its
 * text, cut to the line, with a button that drops it.
 * @param props - What it answers, its id for the textarea to be described by, and what drops it.
 * @returns The line.
 */
const AnsweringLine = ({
  answering,
  id,
  onDrop,
}: {
  readonly answering: Answering;
  readonly id: string;
  readonly onDrop: () => void;
}) => {
  const quoted = quotedOf(answering.message);
  const nick = <Nick colour={quoted.colour} nick={quoted.nick} />;

  return (
    <div
      aria-label={`Replying to ${quoted.nick}`}
      className={styles.answering}
      id={id}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a quotation and the button that drops it, named together, which no element of HTML is.
      role="group"
    >
      <span className={styles.quote}>
        <span aria-hidden>{"\u21B3"}</span> {quoted.kind === "Action" ? <>* {nick}</> : null}
        {quoted.kind === "Notice" ? <>-{nick}-</> : null}
        {quoted.kind === "Privmsg" ? <>{nick}:</> : null} <bdi>{quoted.text}</bdi>
      </span>
      <IconButton icon="close" keys="Esc" label="Stop replying" onPress={onDrop} size="small" />
    </div>
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
 * files, and, where the button that starts a command shows, as on a phone, the camera.
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

/**
 * Whether the browser's selection says where an edit of this kind is: not for an undo or a
 * redo, a drag, or a spelling correction, which edit elsewhere than the selection.
 * @param inputType - The kind of edit, as `beforeinput` names it.
 * @returns Whether it does.
 */
const atSelection = (inputType: string) =>
  !inputType.startsWith("history") &&
  !inputType.endsWith("Drop") &&
  !inputType.endsWith("Drag") &&
  inputType !== "insertReplacementText";

/** Why nothing can be said where the composer is: above it, and in it before anything is typed. */
interface Sayable {
  readonly offline: string | undefined;
  readonly placeholder: string | undefined;
}

/**
 * Why nothing can be said where the composer is, if it cannot: its Network is not
 * connected, said above it once that is known, or was removed, said in it before anything
 * is typed, while commands still run there.
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
      network === undefined || session !== false
        ? undefined
        : `${network} is not connected: nothing can be said there until it is.`,
    placeholder: undefined,
  };
};

/**
 * The id of a candidate in a composer's list.
 * @param list - The list's id.
 * @param index - The candidate's index.
 * @returns Its id.
 */
const optionId = (list: string, index: number) => `${list}-${index}`;

/** What a Timeline is, in a few words. */
const kinds = { Channel: "Channel", Direct: "Direct Message", Network: "Network" } as const;

/**
 * What a candidate says beyond its name, dim: a command's usage,
 * what it does, and the keys bound to it; a Timeline's kind and Network; whether a theme
 * is built in or imported and in effect; whether a font is in effect; and what choosing a
 * Network removes or drops. A word or an emoji says nothing more.
 * @param props - The candidate.
 * @returns Its cells, after its name.
 */
const About = ({ candidate }: { readonly candidate: Candidate }) => {
  switch (candidate._tag) {
    case "Command": {
      return (
        <>
          <span className={styles.usage}>{candidate.takes}</span>
          <span className={styles.description}>{candidate.description}</span>
          {candidate.chords.length === 0 ? null : (
            <kbd className={styles.keys}>
              {candidate.chords.map((chord) => showChord(chord, platform)).join(" ")}
            </kbd>
          )}
        </>
      );
    }

    case "Timeline": {
      return (
        <span className={styles.detail}>
          {kinds[candidate.kind]} on {candidate.network}
        </span>
      );
    }

    case "Theme": {
      return (
        <span className={styles.detail}>
          {candidate.current
            ? `${themeDescription(candidate)}, in effect`
            : themeDescription(candidate)}
        </span>
      );
    }

    case "Font": {
      return (
        <span className={styles.detail}>
          {candidate.current
            ? `${fontDescription(candidate.name)}, in effect`
            : fontDescription(candidate.name)}
        </span>
      );
    }

    case "Network": {
      return <span className={styles.detail}>{networkDescription(candidate)}</span>;
    }

    case "Alias": {
      return <span className={styles.description}>{candidate.line}</span>;
    }

    case "Word":
    case "Emoji": {
      return null;
    }

    default: {
      return candidate satisfies never;
    }
  }
};

/**
 * What the composer can complete, listed above it: each candidate's name, and what it is,
 * a command's usage, description, and keys among it, the one highlighted kept in view. The textarea keeps the focus,
 * so a press writes a candidate in without taking it.
 * @param props - The list, its id, and what picking one does.
 * @returns The listbox.
 */
const Completions = ({
  id,
  list,
  onPick,
}: {
  readonly id: string;
  readonly list: List;
  readonly onPick: (index: number) => void;
}) => {
  const element = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (list.highlighted !== undefined) {
      element.current
        ?.querySelector(`#${CSS.escape(optionId(id, list.highlighted))}`)
        ?.scrollIntoView?.({ block: "nearest" });
    }
  }, [id, list.highlighted]);

  return (
    <div
      aria-label="Completions"
      className={styles.list}
      id={id}
      ref={element}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a listbox the textarea controls and keeps the focus from, which neither a select nor a datalist is.
      role="listbox"
    >
      {list.candidates.map((candidate, index) => (
        // The textarea takes the keys, and keeps the focus through a press.
        // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
        <div
          aria-selected={index === list.highlighted}
          className={styles.option}
          id={optionId(id, index)}
          // A candidate's place in the list is what tells two apart.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          onClick={() => {
            onPick(index);
          }}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an option of that listbox.
          role="option"
          // Pressed, never focused: the textarea keeps the focus.
          tabIndex={-1}
        >
          {candidate._tag === "Emoji" ? (
            <bdi className={`${styles.candidate} ${styles.whole}`}>
              {candidate.emoji} {candidate.name}
            </bdi>
          ) : (
            <bdi className={styles.candidate}>{candidate.name}</bdi>
          )}
          <About candidate={candidate} />
        </div>
      ))}
    </div>
  );
};

/**
 * What the textarea says of the list it controls, while one is open: its id, and the
 * option highlighted, which a screen reader names as it moves.
 * @param shown - The list's id and the option highlighted, while one is open.
 * @returns The attributes.
 */
const controlling = (
  shown: { readonly id: string; readonly highlighted: number | undefined } | undefined
) => ({
  "aria-activedescendant":
    shown?.highlighted === undefined ? undefined : optionId(shown.id, shown.highlighted),
  "aria-autocomplete": "list" as const,
  "aria-controls": shown?.id,
});

/** How the arrows move through the colours offered. */
const colourMoves: ReadonlyMap<string, number> = new Map([
  ["ArrowDown", 1],
  ["ArrowLeft", -1],
  ["ArrowRight", 1],
  ["ArrowUp", -1],
]);

/**
 * Which list the textarea controls while one is open: the colours offered, or else what it
 * can complete.
 * @param choosing - The colours offered, if they are.
 * @param coloursId - Their list's id.
 * @param list - What it can complete, if listed.
 * @param listId - That list's id.
 * @returns The list's id and the option highlighted, or none.
 */
const controlled = (
  choosing: { readonly highlighted: number } | undefined,
  coloursId: string,
  list: List | undefined,
  listId: string
) => {
  if (choosing !== undefined) {
    return { highlighted: choosing.highlighted, id: coloursId };
  }

  return list === undefined ? undefined : { highlighted: list.highlighted, id: listId };
};

/**
 * The textarea's classes: over a backdrop, while the draft holds formatting, it draws only
 * its caret and selection.
 * @param text - The draft's text.
 * @returns The classes.
 */
const inputClass = (text: string) =>
  hasFormatting(text) ? `${styles.input} ${styles.inked}` : styles.input;

/**
 * A style chosen at the caret with nothing selected, said quietly beside the prompt, so a
 * key pressed is seen to have done something before anything is typed.
 * @param props - What it changes, in words, and its id, which describes the textarea.
 * @returns The words, or nothing while nothing is pending.
 */
const PendingMark = ({ id, words }: { readonly id: string; readonly words: readonly string[] }) =>
  words.length === 0 ? null : (
    <span className={styles.pending} data-composer-pending="" id={id}>
      {words.join(" ")}
    </span>
  );

/**
 * The draft as a Timeline draws it, line by line, as each line is sent, behind the
 * textarea, whose own text is not drawn, so the two lie over each other. A space of no
 * width ends it, so a last line with nothing on it is a line here too, as in the textarea.
 * @param props - The draft's text.
 * @returns Its lines.
 */
const DraftDrawn = ({ text }: { readonly text: string }) => (
  <>
    {linesIn(text).map((line, index) => (
      // A line's place is what tells two apart.
      // oxlint-disable-next-line react/no-array-index-key
      <Fragment key={index}>
        {index === 0 ? null : "\n"}
        <Inlines inlines={formatted(line)} links={false} />
      </Fragment>
    ))}
    {"\u200B"}
  </>
);

/**
 * The draft drawn behind the textarea while it holds formatting, and nothing otherwise.
 * @param props - The draft's text, and the element's ref, which scrolls with the textarea.
 * @returns The backdrop.
 */
const Backdrop = ({
  backdrop,
  text,
}: {
  readonly backdrop: RefObject<HTMLDivElement | null>;
  readonly text: string;
}) =>
  hasFormatting(text) ? (
    <div aria-hidden="true" className={styles.backdrop} data-composer-backdrop="" ref={backdrop}>
      <DraftDrawn text={text} />
    </div>
  ) : null;

/**
 * The colours offered for the composer's selection, or for what is typed next: the
 * default and the sixteen, each a swatch drawn as a Timeline draws the colour. The
 * textarea keeps the focus, and the arrows, Enter, and Escape, as the completion list's.
 * @param props - The list's id, which is highlighted, and what picking one does.
 * @returns The listbox.
 */
const Colours = ({
  choosing,
  id,
  onPick,
}: {
  readonly choosing: { readonly highlighted: number } | undefined;
  readonly id: string;
  readonly onPick: (index: number) => void;
}) => {
  const theme = useAtomValue(drawnTheme);

  if (choosing === undefined) {
    return null;
  }

  const { highlighted } = choosing;

  return (
    <div
      aria-label="Colours"
      aria-orientation="horizontal"
      className={styles.colours}
      id={id}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a listbox the textarea controls and keeps the focus from, as the completion list is.
      role="listbox"
    >
      {colourChoices.map((colour, index) => (
        // The textarea takes the keys, and keeps the focus through a press.
        // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
        <div
          aria-label={colourName(colour)}
          aria-selected={index === highlighted}
          className={styles.swatch}
          id={optionId(id, index)}
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          onClick={() => {
            onPick(index);
          }}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an option of that listbox.
          role="option"
          style={{ backgroundColor: runColours(colouredStyle(colour), theme).color }}
          tabIndex={-1}
          title={colourName(colour)}
        >
          {colour === undefined ? "A" : null}
        </div>
      ))}
    </div>
  );
};

/**
 * What describes the textarea: the ids of what is shown above it.
 * @param shown - Each part, whether it is shown, and its id.
 * @returns The ids, or nothing.
 */
const describedByOf = (shown: readonly (readonly [boolean, string])[]) => {
  const ids = shown.flatMap(([present, id]) => (present ? [id] : []));

  return ids.length === 0 ? undefined : ids.join(" ");
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
  const pickNow = useAtomSet(pick);
  const moveNow = useAtomSet(moved);
  const { list, owned, said } = useAtomValue(completionShown(timeline));
  const recallOne = useAtomSet(recall);
  const dismissNow = useAtomSet(dismiss);
  const restoreNow = useAtomSet(restoreDraft);
  const dropNow = useAtomSet(dropReply);
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
  const closeTheUploads = useAtomSet(closeUploads);
  const main = useAtomValue(mainView);
  const pane = useAtomValue(focusedId);
  const focusAsked = useAtomValue(composerFocus);
  const enter = useAtomValue(enterShown);
  const spellcheck = useAtomValue(spellcheckShown);
  const sendKeys = showChord(sendChord(enter), platform);
  const input = useRef<HTMLTextAreaElement>(null);
  // Where the selection began just before the Owner's edit, read as the browser is about to
  // make it, so the files' anchors follow the edit made and not a guess at it.
  const selectedFrom = useRef<number | undefined>(undefined);
  const focusSeen = useRef(focusAsked);
  const appliedSeen = useRef(completion.applied);
  const id = useId();
  const noticeId = `${id}-notice`;
  const hintId = `${id}-hint`;
  const answeringId = `${id}-answering`;
  const listId = `${id}-list`;
  const coloursId = `${id}-colours`;
  const pendingId = `${id}-pending`;
  const { answering, confirming, notice } = draft;
  // What the Owner sees and edits: the draft without its codes, which the backdrop draws.
  const shown = plainOf(draft.text);
  const pending = pendingWords(draft.text, draft.typing);
  const choosing = useAtomValue(colourChoiceAt(timeline));
  const moveColour = useAtomSet(colourMoved);
  const chooseColour = useAtomSet(colourChosen);
  const dismissColours = useAtomSet(colourDismissed);
  const backdrop = useRef<HTMLDivElement>(null);

  // The backdrop scrolls with the textarea, once its text is drawn.
  useLayoutEffect(() => {
    if (backdrop.current !== null && input.current !== null) {
      backdrop.current.scrollTop = input.current.scrollTop;
    }
  });
  // Whether a list is shown and whether completion owns the keys are one: what the core says.

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

  useEffect(() => {
    const element = input.current;

    const before = (event: InputEvent) => {
      selectedFrom.current =
        element !== null && atSelection(event.inputType) ? element.selectionStart : undefined;
    };

    element?.addEventListener("beforeinput", before);

    return () => {
      element?.removeEventListener("beforeinput", before);
    };
  }, []);

  // Each time the caret moves without typing, as an arrow, Home, or a click moves it,
  // completion is told, and lets go of a list it left the caret elsewhere for.
  useEffect(() => {
    const changed = () => {
      const element = input.current;

      // A selection anywhere else, such as a drag across a Timeline, moves no caret here.
      if (element !== null && document.activeElement === element) {
        moveNow({
          end: element.selectionEnd,
          place: timeline,
          start: element.selectionStart,
          text: element.value,
        });
      }
    };

    document.addEventListener("selectionchange", changed);

    return () => {
      document.removeEventListener("selectionchange", changed);
    };
  }, [moveNow, timeline]);

  // Each time a link goes into the draft while the Owner writes in it, the selection goes
  // where the core says, both its ends, once the new text is in the textarea.
  useLayoutEffect(() => {
    if (caretWanted.asked === caretSeen.current) {
      return;
    }

    caretSeen.current = caretWanted.asked;
    const { direction, end, start } = caretWanted.selection;

    input.current?.setSelectionRange(start, end, direction);
  }, [caretWanted]);

  /**
   * Adds files to this composer, their links to go where the caret is now.
   * @param files - The files.
   */
  const add = (files: readonly File[]) => {
    if (files.length > 0) {
      addNow({
        anchor: input.current?.selectionStart ?? shown.length,
        files,
        place: timeline,
        text: shown,
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
   * Tab completes the word at the caret, Shift+Tab backwards, and while the list is shown,
   * Down and Up move through it as they do. Escape gives back what was typed while
   * completion owns the keys. With no word there, and nothing being completed, Tab moves
   * focus on, as it does anywhere.
   * @param event - The key.
   * @returns Whether completion took it.
   */
  const completionKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const { selectionEnd, selectionStart, value } = event.currentTarget;
    const bare = !event.altKey && !event.ctrlKey && !event.metaKey;
    const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";

    // An arrow with a modifier stays the keymap's.
    if (arrow && bare && !event.shiftKey && list !== undefined) {
      event.preventDefault();
      complete({
        backwards: event.key === "ArrowUp",
        caret: selectionStart,
        place: timeline,
        text: value,
      });

      return true;
    }

    if (
      event.key === "Tab" &&
      bare &&
      selectionStart === selectionEnd &&
      (owned || completes(value, selectionStart))
    ) {
      event.preventDefault();
      complete({ backwards: event.shiftKey, caret: selectionStart, place: timeline, text: value });

      return true;
    }

    if (event.key === "Escape" && owned) {
      event.preventDefault();
      restore(timeline);

      return true;
    }

    return false;
  };

  // Escape lets go of a notice or a confirmation first, then of what the draft answers. With
  // none, it closes what stands in front of the focused Pane's Timeline, the options, the
  // Uploads, the search, or a draft, and with nothing in front, puts its Lookup card away.
  const escaped = () => {
    if (notice !== undefined || confirming !== undefined) {
      dismissNow(timeline);

      return;
    }

    if (answering !== undefined) {
      dropNow(timeline);

      return;
    }

    switch (main._tag) {
      case "Options": {
        closeTheOptions();
        break;
      }

      case "Uploads": {
        closeTheUploads();
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
    if (
      element !== null &&
      linesOf(element.value).some((line) => typesCredential(line, context.aliases))
    ) {
      element.value = "";
    }

    if (confirming === undefined) {
      sendNow(timeline);
    } else {
      confirmNow(timeline);
    }
  };

  /**
   * While the colours are offered, the arrows move through them, Enter puts the one
   * highlighted over the selection, and Escape puts them away.
   * @param event - The key.
   * @returns Whether the colours took it.
   */
  const colourKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const by = colourMoves.get(event.key);

    if (choosing === undefined || event.altKey || event.ctrlKey || event.metaKey) {
      return false;
    }

    if (by !== undefined) {
      moveColour(by);
    } else if (event.key === "Enter") {
      chooseColour(choosing.highlighted);
    } else if (event.key === "Escape") {
      dismissColours(undefined);
    } else {
      return false;
    }

    event.preventDefault();

    return true;
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

    if (colourKey(event)) {
      return;
    }

    // A command started over a draft is put away in one press, its list with it, before
    // anything else Escape would do.
    if (event.key === "Escape" && draft.aside !== undefined) {
      event.preventDefault();
      restoreNow(timeline);

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

  const describedBy = describedByOf([
    [pending.length > 0, pendingId],
    [answering !== undefined, answeringId],
    [notice !== undefined || confirming !== undefined, noticeId],
    [offline !== undefined, hintId],
  ]);

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
      {list === undefined ? null : (
        <Completions
          id={listId}
          list={list}
          onPick={(index) => {
            pickNow({ index, place: timeline, text: shown });
          }}
        />
      )}
      <Colours
        choosing={choosing}
        id={coloursId}
        onPick={(index) => {
          chooseColour(index);
        }}
      />
      {answering === undefined ? null : (
        <AnsweringLine
          answering={answering}
          id={answeringId}
          onDrop={() => {
            dropNow(timeline);
            input.current?.focus();
          }}
        />
      )}
      {/* A status, polite, present while the composer is, so what the list holds is announced. */}
      <output aria-live="polite" className={styles.status}>
        {said}
      </output>
      <div className={styles.line}>
        {before}
        <label className={styles.prompt} htmlFor={id}>
          {number === undefined ? null : <span className={styles.pane}>{number}</span>}
          <bdi>{name}</bdi>
          <AwayMark network={network} />
          <span aria-hidden="true">&gt;</span>
        </label>
        <PendingMark id={pendingId} words={pending} />
        <div className={styles.field}>
          <Backdrop backdrop={backdrop} text={draft.text} />
          <textarea
            {...controlling(controlled(choosing, coloursId, list, listId))}
            // Among several Panes, the number shown is said with what it is.
            aria-label={number === undefined ? undefined : `Pane ${number}: ${name}`}
            aria-describedby={describedBy}
            aria-invalid={notice === undefined ? undefined : true}
            autoComplete="off"
            className={inputClass(draft.text)}
            data-composer=""
            id={id}
            onChange={(event) => {
              const { selectionStart, value } = event.currentTarget;
              const from = selectedFrom.current;

              // A selection read for one edit says nothing of the next, and the colours were
              // offered for the text before it.
              selectedFrom.current = undefined;

              if (choosing !== undefined) {
                dismissColours(undefined);
              }

              setText(
                from === undefined
                  ? { caret: selectionStart, text: value, timeline }
                  : {
                      caret: selectionStart,
                      text: value,
                      timeline,
                      typing: { caret: selectionStart, from },
                    }
              );
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onScroll={(event) => {
              if (backdrop.current !== null) {
                backdrop.current.scrollTop = event.currentTarget.scrollTop;
              }
            }}
            placeholder={placeholder}
            ref={input}
            rows={1}
            spellCheck={spellcheck}
            value={shown}
          />
        </div>
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
        <CommandButton />
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
