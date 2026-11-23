/**
 * The composer, as atoms: the state the pure core folds, and the commands that carry out
 * the intents it gives. A Say is made under an intent the runtime names, so that when the
 * Network stops, or the Daemon does not answer, `said` can say whether it was journaled,
 * and it is sent again only when the Network stopped and it was not: after a request that
 * got no answer, it may still be appended, so the Owner can only check again. A Say the
 * Client refused as it took it is said so by `say`'s answer, and how a Message fares after
 * that is its Timeline item's delivery, so the Frontend never reads News. `/msg` opens the
 * Direct Message the Daemon placed its Message in, read from the step that said it.
 *
 * @packageDocumentation
 */
import type { Sequence } from "@iirc/api";
import type { Act, Intent, Say } from "@iirc/frontend/commands";
import {
  commandStarted,
  confirm,
  contextOf,
  draftOf,
  placeIn,
  placeOfDraft,
  reduceComposers,
  started,
  submit,
  takeOffer,
} from "@iirc/frontend/composer";
import type {
  Answering,
  ComposerEvent,
  Composers,
  IntentId,
  Place,
  SayFailure,
} from "@iirc/frontend/composer";
import { remember } from "@iirc/frontend/entries";
import { firstHighlight } from "@iirc/frontend/format-list";
import type { Highlight } from "@iirc/frontend/format-list";
import type { Format } from "@iirc/frontend/formatting";
import { plainOf } from "@iirc/frontend/formatting";
import { draftsMetBetween, followFrom, originOf, reduceTimelines } from "@iirc/frontend/timelines";
import type { Origin, Timelines } from "@iirc/frontend/timelines";
import { writtenOnDevice } from "@iirc/frontend/ui";
import { heldBack, reduceUploading } from "@iirc/frontend/uploading";
import type { Typing } from "@iirc/frontend/uploading";
import { Effect, Option, Schedule, Semaphore, Stream } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { decodeIntent, IntentNames } from "../app/intent-names.ts";
import { runtime } from "../app/runtime.ts";
import { query } from "../channel/atoms.ts";
import { channelState, showMembers } from "../channel/state.ts";
import { look } from "../lookup/atoms.ts";
import { notifying } from "../notifications/notifier.ts";
import {
  addNetwork,
  configure,
  openOptions,
  openUploads,
  promptCredential,
  readOptions,
  signedOut,
} from "../options/atoms.ts";
import type { Outcome as Changed } from "../options/atoms.ts";
import { deviceUi } from "../options/device.ts";
import { changeOwner } from "../options/owner.ts";
import { askRemoval } from "../options/removal.ts";
import {
  aliasesShown,
  arrange,
  arrangement,
  changeAliases,
  changeUi,
  mute,
} from "../options/ui.ts";
import { showSidebar } from "../page/sidebar.ts";
import { choosePreviews } from "../previews/atoms.ts";
import { markRead } from "../reading/atoms.ts";
import { jumpToMoment, showSearch } from "../search/atoms.ts";
import { signedIn } from "../sign-in/atoms.ts";
import { changeThemes, chooseTheme, showImport } from "../theme/atoms.ts";
import {
  latest,
  mutedShown,
  quietBotsShown,
  open,
  openTail,
  paned,
  showDraft,
  timelinesState,
  Waits,
} from "../timelines/atoms.ts";
import { closeTimeline } from "../timelines/closing.ts";
import { exportTimeline } from "../timelines/export.ts";
import { cancelCompletion } from "./completion-state.ts";
import { composerState, ranState } from "./composer-state.ts";
import { composerInput } from "./input.ts";
import { followed } from "./sources.ts";
import { anchorsFollow, uploadingState } from "./uploading-state.ts";

/** The context commands are judged in, derived from the Timelines and the Sidebar's order. */
export const commandContext = Atom.make((get) =>
  contextOf(
    get(timelinesState),
    get(channelState),
    get(arrangement),
    get(aliasesShown),
    get(mutedShown),
    get(quietBotsShown)
  )
);

/** One Timeline's composer, or the one under no Timeline. */
export const draft = Atom.family((timeline: Place) =>
  Atom.make((get) => draftOf(get(composerState), timeline))
);

/**
 * How many times the composer was asked to take focus. The composer focuses its textarea
 * each time this changes, never as it mounts.
 */
export const composerFocus = Atom.make(0).pipe(Atom.keepAlive);

/**
 * Where the composer is: the focused Pane's open Timeline's, or the one under none.
 * @param registry - The registry.
 * @returns Its place.
 */
export const placeOf = (registry: AtomRegistry.AtomRegistry): Place =>
  placeIn(registry.get(timelinesState));

/**
 * Sets the composers, and carries the anchors of the files pending in them along.
 * @param registry - The registry.
 * @param state - The composers after.
 * @param typing - Where the Owner's selection was in the draft they typed in, if they did.
 */
export const setComposers = (
  registry: AtomRegistry.AtomRegistry,
  state: Composers,
  typing?: Typing & { readonly place: Place }
) => {
  const before = registry.get(composerState);

  registry.set(composerState, state);
  anchorsFollow(registry, before, state, typing);
};

/**
 * Folds one event into the composers.
 * @param registry - The registry.
 * @param event - What happened.
 * @param typing - Where the Owner's selection was, if they typed the edit.
 */
const happened = (registry: AtomRegistry.AtomRegistry, event: ComposerEvent, typing?: Typing) => {
  if (event._tag === "Edited" || event._tag === "Recalled" || event._tag === "Restored") {
    cancelCompletion(registry);
  }

  setComposers(
    registry,
    reduceComposers(registry.get(composerState), event),
    event._tag === "Edited" && typing !== undefined
      ? { ...typing, place: event.timeline }
      : undefined
  );
};

/**
 * Replaces the composers' state, as sending, confirming, taking an offer, or a command
 * starting over a draft does, which lets go of what was being completed.
 * @param registry - The registry.
 * @param state - The state.
 */
const replaced = (registry: AtomRegistry.AtomRegistry, state: Composers) => {
  cancelCompletion(registry);
  setComposers(registry, state);
};

// A gateway in front of the Daemon answers these when it could not reach it.
const gatewayStatuses: ReadonlySet<number> = new Set([502, 504]);

/** What became of one Say, as the runtime found out. */
type Outcome =
  | { readonly _tag: "Said"; readonly sequence: Sequence }
  | { readonly _tag: "SignedOut" }
  | { readonly _tag: "Failed"; readonly failure: SayFailure };

/**
 * Why the Daemon refused a Say, from its error's tag.
 * @param tag - The error's tag.
 * @param network - The Say's Network.
 * @returns The failure.
 */
const failureOf = (tag: string, network: Say["network"]): SayFailure => {
  if (tag === "UnknownNetwork") {
    return { _tag: "UnknownNetwork", network };
  }

  return tag === "InvalidRequest" ? { _tag: "Malformed" } : { _tag: "Unexpected" };
};

// Says go one at a time, in the order the Owner sent them, across every Timeline.
const oneAtATime = Semaphore.makeUnsafe(1);

/**
 * Asks whether a Say under an intent was journaled.
 * @param network - Its Network.
 * @param intent - Its intent.
 * @returns What became of it.
 */
const askSaid = (network: Say["network"], intent: IntentId) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const answer = yield* client.networks.said({ params: { intent, network } });

    return answer;
  });

/**
 * Asks `said` about a Say whose request got no answer: `Journaled` settles it, and anything
 * else leaves it unknown.
 * @param network - Its Network.
 * @param intent - Its intent.
 * @returns What became of it.
 */
const checked = (network: Say["network"], intent: IntentId) =>
  askSaid(network, intent).pipe(
    Effect.map((answer): Outcome =>
      answer._tag === "Journaled"
        ? { _tag: "Failed", failure: { _tag: "Journaled" } }
        : { _tag: "Failed", failure: { _tag: "Unknown", network } }
    ),
    Effect.orElseSucceed((): Outcome => ({ _tag: "Failed", failure: { _tag: "Unknown", network } }))
  );

/** A Say said with `opens`, whose Direct Message is to be opened once it is placed. */
interface Placed {
  readonly network: Say["network"];
  readonly sequence: Sequence;
  readonly intent: IntentId;
  /** The core's navigation when its Say was submitted: opening another lets it go. */
  readonly navigation: number;
  /** The Pane it was said from, and what that showed: it opens only there, while it still does. */
  readonly from: Origin;
}

/**
 * Asks the Daemon to say a Message or act, under an intent id, and reads its answer:
 * `Said` or `Acted` with the sequence it was stepped at, or the Client's refusal in that
 * step.
 * @param intent - The Say or the Act.
 * @param id - Its intent id.
 * @returns The request, answered.
 */
const ask = (intent: Say | Act, id: IntentId) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;

    if (intent._tag === "Act") {
      return yield* client.networks
        .act({
          params: { network: intent.network },
          payload: { action: intent.action, intent: id },
        })
        .pipe(
          Effect.map((answer): Outcome =>
            answer._tag === "Acted"
              ? { _tag: "Said", sequence: answer.sequence }
              : {
                  _tag: "Failed",
                  failure: {
                    _tag: "Refused",
                    action: intent.action,
                    reason: answer.reason,
                    target: "",
                  },
                }
          )
        );
    }

    const said = { intent: id, kind: intent.kind, target: intent.target, text: intent.text };

    return yield* client.networks
      .say({
        params: { network: intent.network },
        payload: intent.answers === undefined ? said : { ...said, answers: intent.answers },
      })
      .pipe(
        Effect.map((answer): Outcome =>
          answer._tag === "Said"
            ? { _tag: "Said", sequence: answer.sequence }
            : {
                _tag: "Failed",
                failure: {
                  _tag: "Refused",
                  action: undefined,
                  reason: answer.reason,
                  target: intent.target,
                },
              }
        )
      );
  });

/**
 * Says one Message, or acts, under an intent id, and finds out what became of it, as one
 * for the other: an action is journaled and recovered by its intent as a Message is.
 * @param intent - The Say or the Act.
 * @param id - Its intent id.
 * @returns What became of it.
 */
const sayOne = (intent: Say | Act, id: IntentId) =>
  ask(intent, id).pipe(
    Effect.catch((error): Effect.Effect<Outcome, never, DaemonClient> => {
      if (error._tag === "Unauthorized") {
        return Effect.succeed<Outcome>({ _tag: "SignedOut" });
      }

      // The Network stopped, so its append has settled: `said` answers for good.
      if (error._tag === "NetworkStopped") {
        return askSaid(intent.network, id).pipe(
          Effect.map((answer): Outcome => ({
            _tag: "Failed",
            failure: { _tag: answer._tag === "Journaled" ? "Journaled" : "NotJournaled" },
          })),
          Effect.orElseSucceed((): Outcome => ({
            _tag: "Failed",
            failure: { _tag: "Unknown", network: intent.network },
          }))
        );
      }

      // No answer came, so the request may still be queued or appending: `said` can
      // settle it only by answering `Journaled`, and it is never sent again from here.
      const lost =
        error._tag === "HttpClientError" &&
        (error.reason._tag === "TransportError" ||
          (error.response !== undefined && gatewayStatuses.has(error.response.status)));

      if (lost) {
        return checked(intent.network, id);
      }

      return Effect.succeed<Outcome>({
        _tag: "Failed",
        failure: failureOf(error._tag, intent.network),
      });
    })
  );

/** Where the composer's selection is in its plain text, from `start` to `end`. */
interface Range {
  readonly start: number;
  readonly end: number;
}

/**
 * Where the selection is in a composer's plain text: the textarea's, which keeps it while
 * the focus is elsewhere, or the end of the draft with none drawn.
 * @param registry - The registry.
 * @param place - The composer's place.
 * @returns The selection.
 */
const selectionIn = (registry: AtomRegistry.AtomRegistry, place: Place): Range => {
  const input = composerInput(document);

  if (input === undefined) {
    const end = plainOf(draftOf(registry.get(composerState), place).text).length;

    return { end, start: end };
  }

  return { end: input.selectionEnd, start: input.selectionStart };
};

/**
 * Puts a format over a range of a composer's draft, or with nothing selected, has it
 * pending at the caret, and gives the composer the focus back, its selection where it was,
 * since the plain text it is a place in did not change.
 * @param registry - The registry.
 * @param place - The composer's place.
 * @param format - What is put over it.
 * @param range - The range, or the selection now.
 */
const formatHere = (
  registry: AtomRegistry.AtomRegistry,
  place: Place,
  format: Format,
  range: Range = selectionIn(registry, place)
) => {
  happened(registry, { _tag: "Formatted", ...range, format, timeline: place });
  composerInput(document)?.focus();
};

/**
 * The formatting list as it was opened over a composer: its place, the range a choice goes
 * over, its selection as it was when the list opened, the draft's text then, and what is
 * highlighted.
 */
const formatChoice = Atom.make<
  | (Range & { readonly place: Place; readonly text: string; readonly highlighted: Highlight })
  | undefined
>(undefined).pipe(Atom.keepAlive);

/**
 * The formatting list open over one composer: only while its draft's text is as it was
 * when the list opened, so one replaced, as by a command started on Mod+K, puts it away.
 */
export const formatChoiceAt = Atom.family((place: Place) =>
  Atom.make((get) => {
    const choice = get(formatChoice);

    return choice?.place === place && get(draft(place)).text === choice.text ? choice : undefined;
  })
);

/** Highlights another item of the formatting list, as the core moved it. */
export const formatMoved = Atom.fnSync((highlighted: Highlight, get) => {
  const choice = get.registry.get(formatChoice);

  if (choice !== undefined) {
    get.registry.set(formatChoice, { ...choice, highlighted });
  }
}).pipe(Atom.keepAlive);

/** Puts a format over the range the formatting list opened for, and puts the list away. */
export const formatChosen = Atom.fnSync((format: Format, get) => {
  const { registry } = get;
  const opened = registry.get(formatChoice);
  const choice = opened === undefined ? undefined : registry.get(formatChoiceAt(opened.place));

  registry.set(formatChoice, undefined);

  if (choice !== undefined) {
    formatHere(registry, choice.place, format, choice);
  }
}).pipe(Atom.keepAlive);

/** Puts the formatting list away, choosing nothing. */
export const formatDismissed = Atom.fnSync((_: undefined, get) => {
  get.registry.set(formatChoice, undefined);
  composerInput(document)?.focus();
}).pipe(Atom.keepAlive);

/** An intent carried out in the page at once, which waits on nothing the Daemon says. */
type Local = Extract<
  Intent,
  {
    readonly _tag:
      | "OpenOptions"
      | "OpenUploads"
      | "OpenTail"
      | "PromptCredential"
      | "Open"
      | "Latest"
      | "GoToDate"
      | "StartCommand"
      | "FocusComposer"
      | "ShowMembers"
      | "ShowSidebar"
      | "Pane"
      | "ImportTheme"
      | "AskRemoval"
      | "Search"
      | "Look"
      | "Draft"
      | "Format"
      | "ChooseFormat";
  }
>;

const localTags: ReadonlySet<string> = new Set<Local["_tag"]>([
  "AskRemoval",
  "ChooseFormat",
  "Draft",
  "FocusComposer",
  "Format",
  "GoToDate",
  "ImportTheme",
  "Latest",
  "Look",
  "Open",
  "OpenOptions",
  "OpenTail",
  "OpenUploads",
  "Pane",
  "PromptCredential",
  "Search",
  "ShowMembers",
  "ShowSidebar",
  "StartCommand",
]);

/**
 * Whether an intent is carried out in the page.
 * @param intent - The intent.
 * @returns Whether it is.
 */
const isLocal = (intent: Intent): intent is Local => localTags.has(intent._tag);

/** An intent that shows a view of iirc's own. */
type ShowsView = Extract<
  Local,
  { readonly _tag: "OpenOptions" | "OpenUploads" | "OpenTail" | "Search" }
>;

const viewTags: ReadonlySet<string> = new Set<ShowsView["_tag"]>([
  "OpenOptions",
  "OpenTail",
  "OpenUploads",
  "Search",
]);

/**
 * Whether an intent shows a view of iirc's own.
 * @param intent - The intent.
 * @returns Whether it does.
 */
const isView = (intent: Local): intent is ShowsView => viewTags.has(intent._tag);

/**
 * Shows a view of iirc's own: the options, filtered, the Uploads, the Tail, or the search,
 * searching a query when there is one.
 * @param registry - The registry.
 * @param intent - The intent.
 */
const showView = (registry: AtomRegistry.AtomRegistry, intent: ShowsView): void => {
  switch (intent._tag) {
    case "OpenOptions": {
      registry.set(openOptions, intent.filter);
      break;
    }

    case "OpenUploads": {
      registry.set(openUploads, undefined);
      break;
    }

    case "OpenTail": {
      registry.set(openTail, undefined);
      break;
    }

    case "Search": {
      registry.set(showSearch, intent.query);
      break;
    }

    default: {
      intent satisfies never;
    }
  }
};

/**
 * Carries out an intent in the page: shows the options, the Uploads, the Tail, the search, or a Timeline, jumps
 * to a Timeline's latest or to a date in it, opens the password prompt, focuses the composer, starting an
 * empty draft with text, or starting a command over any draft, with its list open, shows or
 * hides the members or the sidebar, changes the Panes, or starts a Lookup, which goes on
 * beside the composer's turn.
 * @param registry - The registry.
 * @param place - Where the composer under the main view is.
 * @param intent - The intent.
 */
const carryOutHere = (registry: AtomRegistry.AtomRegistry, place: Place, intent: Local): void => {
  if (isView(intent)) {
    showView(registry, intent);

    return;
  }

  switch (intent._tag) {
    case "PromptCredential": {
      const { _tag, ...asked } = intent;

      registry.set(promptCredential, asked);
      break;
    }

    case "Open": {
      registry.set(open, intent.timeline);
      break;
    }

    // The draft is set aside, and the command's list opens over the options as configured
    // now, which `/set` lists.
    case "StartCommand": {
      replaced(registry, commandStarted(registry.get(composerState), place, intent.text));
      followed(registry, place, intent.text);
      registry.set(readOptions, undefined);
      registry.set(composerFocus, registry.get(composerFocus) + 1);
      break;
    }

    case "ImportTheme": {
      showImport(registry, true);
      break;
    }

    // Removing a Network is asked first, in a dialog, which sends it once confirmed.
    case "AskRemoval": {
      askRemoval(registry, intent.network, intent.keep);
      break;
    }

    case "Latest": {
      registry.set(latest, intent.timeline);
      break;
    }

    case "GoToDate": {
      registry.set(jumpToMoment, { moment: intent.moment, timeline: intent.timeline });
      break;
    }

    case "FocusComposer": {
      replaced(registry, started(registry.get(composerState), place, intent.text));

      registry.set(composerFocus, registry.get(composerFocus) + 1);
      break;
    }

    case "ShowMembers": {
      showMembers(registry, intent.shown);
      break;
    }

    case "ShowSidebar": {
      showSidebar(registry, intent.shown);
      break;
    }

    case "Pane": {
      registry.set(paned, intent.change);
      break;
    }

    // A Lookup is asked beside the composer's turn, so a Say never waits behind it.
    case "Look": {
      look(registry, intent);
      break;
    }

    case "Format": {
      formatHere(registry, place, { _tag: "Toggle", flag: intent.format });
      break;
    }

    case "ChooseFormat": {
      registry.set(formatChoice, {
        ...selectionIn(registry, place),
        highlighted: firstHighlight,
        place,
        text: registry.get(draft(place)).text,
      });
      composerInput(document)?.focus();
      break;
    }

    case "Draft": {
      registry.set(showDraft, {
        declared: intent.declared,
        network: intent.network,
        nick: intent.nick,
      });
      registry.set(composerFocus, registry.get(composerFocus) + 1);
      break;
    }

    default: {
      intent satisfies never;
    }
  }
};

/**
 * Carries out an intent other than a Say: in the page, by changing Configuration, by
 * marking a Timeline read, by closing one, by turning notifications on or off, or by opening a Timeline by
 * name, which reads how the Network folds names first.
 * @param registry - The registry.
 * @param place - Where the intents came from.
 * @param intent - The intent.
 * @param navigation - The core's navigation when the intents were submitted.
 * @returns What it came to.
 */
const changeOne = (
  registry: AtomRegistry.AtomRegistry,
  place: Place,
  intent: Exclude<Intent, Say | Act>,
  navigation: number
): Effect.Effect<Changed, never, DaemonClient> => {
  if (isLocal(intent)) {
    carryOutHere(registry, place, intent);

    return Effect.succeed({ _tag: "Done" });
  }

  switch (intent._tag) {
    case "Configure": {
      return configure(registry, intent.network, intent.edit);
    }

    case "AddNetwork": {
      return addNetwork(registry, intent.network, intent.configuration);
    }

    // A value is written where it takes effect, as the options view writes it: this device's
    // own for a family, and for any option this device overrides already, whose override
    // would win over a shared one. Unsetting is the Owner's to say with `-device`.
    case "ChangeUi": {
      const own =
        intent.value !== undefined &&
        writtenOnDevice(
          intent.option,
          intent.value,
          registry.get(deviceUi)[intent.option] !== undefined
        );

      return changeUi(registry, { ...intent, device: intent.device || own });
    }

    case "ChangeOwner": {
      return changeOwner(registry, intent);
    }

    case "UseTheme": {
      return chooseTheme(registry, intent);
    }

    case "EditThemes": {
      return changeThemes(registry, intent.edit);
    }

    case "EditAliases": {
      return changeAliases(registry, intent.edit);
    }

    case "ChoosePreviews": {
      return choosePreviews(registry, intent);
    }

    case "Arrange": {
      return arrange(registry, intent.edit);
    }

    case "MarkRead": {
      return markRead(intent);
    }

    case "CloseTimeline": {
      return closeTimeline(registry, intent);
    }

    case "Mute": {
      return mute(registry, intent);
    }

    case "Notify": {
      return notifying(intent.on);
    }

    // Saving starts a download in the browser and waits on nothing, or says why it cannot.
    case "Export": {
      return Effect.sync((): Changed => {
        const refused = exportTimeline(intent);

        return refused === undefined ? { _tag: "Done" } : { _tag: "NotDone", message: refused };
      });
    }

    case "Query": {
      return query(registry, intent.network, intent.name, navigation).pipe(
        Effect.map((queried): Changed => {
          if (queried._tag === "NotDone" || queried._tag === "SignedOut") {
            return queried;
          }

          const intents = queried._tag === "Intents" ? queried.intents : [];

          for (const one of intents) {
            if (isLocal(one)) {
              carryOutHere(registry, place, one);
            }
          }

          return { _tag: "Done" };
        })
      );
    }

    default: {
      return intent satisfies never;
    }
  }
};

/**
 * Carries out intents in order. One that fails stops those after it, and the composer it
 * came from says why, offering what is safe to do next after a Say.
 * @param registry - The registry.
 * @param timeline - Where they were sent from.
 * @param intents - The intents.
 * @param first - The intent id the first Say keeps, when it is sent again.
 * @param navigation - The core's navigation when they were submitted.
 * @param from - The Pane they were submitted from, and what it showed.
 * @returns The Says said that open their Direct Message once placed.
 */
const carryOut = (
  registry: AtomRegistry.AtomRegistry,
  timeline: Place,
  intents: readonly Intent[],
  first: IntentId | undefined,
  navigation: number,
  from: Origin
) =>
  Effect.gen(function* () {
    const name = yield* IntentNames;
    const placed: Placed[] = [];

    for (const [index, intent] of intents.entries()) {
      if (intent._tag !== "Say" && intent._tag !== "Act") {
        const changed = yield* changeOne(registry, timeline, intent, navigation);

        if (changed._tag === "SignedOut") {
          signedOut(registry);

          return placed;
        }

        if (changed._tag === "NotDone") {
          happened(registry, { _tag: "Noticed", message: changed.message, timeline });

          return placed;
        }

        continue;
      }

      const id = index === 0 && first !== undefined ? first : decodeIntent(name());
      const outcome = yield* sayOne(intent, id);

      if (outcome._tag === "SignedOut") {
        signedOut(registry);

        return placed;
      }

      if (outcome._tag === "Said") {
        if (intent._tag === "Say" && intent.opens) {
          placed.push({
            from,
            intent: id,
            navigation,
            network: intent.network,
            sequence: outcome.sequence,
          });
        }

        continue;
      }

      happened(registry, {
        _tag: "Failed",
        failure: outcome.failure,
        intent: id,
        intents: intents.slice(index),
        timeline,
      });

      return placed;
    }

    return placed;
  }).pipe((effect) => oneAtATime.withPermits(1)(effect));

/**
 * Whether a placement is let go: the Owner opened another Timeline since its Say was
 * submitted, or the browser signed out, which reads the Timelines again from nothing.
 * @param registry - The registry.
 * @param state - The Timelines.
 * @param placed - The placement.
 * @returns Whether it is let go.
 */
const letGo = (registry: AtomRegistry.AtomRegistry, state: Timelines, placed: Placed) =>
  state.navigation !== placed.navigation || !registry.get(signedIn);

/**
 * Waits until the Daemon's projection has folded a Say's step, as the changes stream says,
 * or the placement is let go. After a reset, the place is the new projection's, so it waits
 * for that one to pass the step.
 * @param registry - The registry.
 * @param placed - The placement.
 * @returns Whether the step was folded, rather than the placement let go.
 */
const foldedOrLetGo = (registry: AtomRegistry.AtomRegistry, placed: Placed) =>
  AtomRegistry.toStream(registry, timelinesState).pipe(
    Stream.filter(
      (state) =>
        letGo(registry, state, placed) || (followFrom(state)?.sequence ?? 0) >= placed.sequence
    ),
    Stream.take(1),
    Stream.runHead,
    Effect.map((state) => Option.isSome(state) && !letGo(registry, state.value, placed))
  );

/**
 * Waits until a placement is let go.
 * @param registry - The registry.
 * @param placed - The placement.
 * @returns Once it is.
 */
const lettingGo = (registry: AtomRegistry.AtomRegistry, placed: Placed) =>
  AtomRegistry.toStream(registry, timelinesState).pipe(
    Stream.filter((state) => letGo(registry, state, placed)),
    Stream.take(1),
    Stream.runDrain
  );

/**
 * Opens the Direct Message Timeline a Say was placed in: the item of its intent in the step
 * that said it, which the Daemon routed. It waits until the projection has folded that step,
 * then reads it once, which is then the whole answer: with the item, its Timeline opens,
 * and without it, as for a Channel's or a refused Say, nothing does. A read that fails is
 * asked again, soon and then less often. Opening another Timeline, or signing out, lets it
 * go at any point. It only reads, so it can never say anything.
 * @param registry - The registry.
 * @param placed - The placement.
 * @returns Once it is opened, known never to be, or let go.
 */
const openPlaced = (registry: AtomRegistry.AtomRegistry, placed: Placed) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const { longest, retry: soon } = yield* Waits;

    const lookup = Effect.gen(function* () {
      if (!(yield* foldedOrLetGo(registry, placed))) {
        return;
      }

      const page = yield* client.timelines
        .locate({
          params: { network: placed.network, sequence: placed.sequence },
          query: { limit: 500 },
        })
        .pipe(
          Effect.retry({
            schedule: Schedule.min([Schedule.exponential(soon), Schedule.spaced(longest)]),
            while: (error) => error._tag !== "Unauthorized",
          })
        );

      const item = page.items.find(
        (one) => one.content._tag === "Message" && one.content.ours?.intent === placed.intent
      );

      if (item !== undefined) {
        registry.set(
          timelinesState,
          reduceTimelines(registry.get(timelinesState), {
            _tag: "Located",
            from: placed.from,
            navigation: placed.navigation,
            timeline: item.timeline,
          })
        );
      }
    });

    yield* Effect.raceFirst(Effect.ignore(lookup), lettingGo(registry, placed));
  });

/**
 * Carries out intents, then opens the Direct Messages they said to, once placed, outside
 * the turn so later Says need not wait for the projection.
 * @param registry - The registry.
 * @param timeline - The Timeline they were sent from.
 * @param intents - The intents.
 * @param first - The intent id the first Say keeps.
 * @returns Once done.
 */
const sendAll = (
  registry: AtomRegistry.AtomRegistry,
  timeline: Place,
  intents: readonly Intent[],
  first: IntentId | undefined
) =>
  Effect.gen(function* () {
    const state = registry.get(timelinesState);

    const placed = yield* carryOut(
      registry,
      timeline,
      intents,
      first,
      state.navigation,
      originOf(state)
    );

    for (const one of placed) {
      yield* openPlaced(registry, one);
    }
  });

/**
 * Carries what was typed under a draft, unsent, to its Timeline's composer when the draft
 * comes to show that Timeline, as when the partner spoke first or another Frontend said
 * something to them, so nothing typed is lost. It also says when the composer turns to
 * another Timeline, which lets go of a complaint about the text it leaves. Mounted once for
 * the page.
 */
export const draftsCarried = runtime
  .atom((get) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const { registry } = get;
        let before = registry.get(timelinesState);

        return registry.subscribe(timelinesState, (after) => {
          const met = draftsMetBetween(before, after);
          const left = placeIn(before);

          before = after;

          for (const one of met) {
            happened(registry, {
              _tag: "Carried",
              from: placeOfDraft(one.network, one.nick),
              to: one.timeline,
            });
          }

          if (left !== placeIn(after)) {
            happened(registry, { _tag: "Left", timeline: left });
          }
        });
      }),
      (stop) => Effect.sync(stop)
    ).pipe(Effect.andThen(Effect.never), Effect.scoped)
  )
  .pipe(Atom.keepAlive);

/**
 * An edit of a Timeline's draft: its plain text after, where the caret is after it if
 * known, and where the Owner's selection was if they typed it.
 */
interface Edit {
  readonly timeline: Place;
  readonly text: string;
  readonly caret?: number;
  readonly typing?: Typing;
}

/**
 * Edits a Timeline's draft at once, which lets go of what was being completed, for what
 * follows the edit to fold in after it.
 * @param registry - The registry.
 * @param change - The edit.
 */
export const edited = (
  registry: AtomRegistry.AtomRegistry,
  { caret, text, timeline, typing }: Edit
) => {
  happened(
    registry,
    caret === undefined
      ? { _tag: "Edited", text, timeline }
      : { _tag: "Edited", caret, text, timeline },
    typing
  );
};

/** Edits a Timeline's draft, where the Owner's selection was if they typed it. */
export const edit = Atom.fnSync((change: Edit, get) => {
  edited(get.registry, change);
}).pipe(Atom.keepAlive);

/** Recalls what was sent from a Timeline, older or newer. */
export const recall = Atom.fnSync(
  (
    { direction, timeline }: { readonly timeline: Place; readonly direction: "Older" | "Newer" },
    get
  ) => {
    happened(get.registry, { _tag: "Recalled", direction, timeline });
  }
).pipe(Atom.keepAlive);

/**
 * Answers a Message from its Timeline's draft, and focuses the composer, which shows what
 * it answers.
 */
export const chooseReply = Atom.fnSync(
  ({ answering, timeline }: { readonly timeline: Place; readonly answering: Answering }, get) => {
    happened(get.registry, { _tag: "ReplyChosen", answering, timeline });
    get.registry.set(composerFocus, get.registry.get(composerFocus) + 1);
  }
).pipe(Atom.keepAlive);

/** Lets go of what a Timeline's draft answers, keeping its text. */
export const dropReply = Atom.fnSync((timeline: Place, get) => {
  happened(get.registry, { _tag: "ReplyDropped", timeline });
}).pipe(Atom.keepAlive);

/**
 * Puts away a command started over a draft, which comes back with what it answered, and
 * the list of the command goes.
 */
export const restoreDraft = Atom.fnSync((timeline: Place, get) => {
  const { registry } = get;

  happened(registry, { _tag: "Restored", timeline });
  // `edit` keeps the text it was last given as its argument, which was the command's, a
  // Credential's value among it, so it is given the draft's own, which changes nothing.
  registry.set(edit, {
    text: plainOf(draftOf(registry.get(composerState), timeline).text),
    timeline,
  });
}).pipe(Atom.keepAlive);

/** Lets go of a Timeline's notice and confirmation. */
export const dismiss = Atom.fnSync((timeline: Place, get) => {
  happened(get.registry, { _tag: "Dismissed", timeline });
}).pipe(Atom.keepAlive);

/**
 * Once a draft was sent and cleared, `edit` lets go of the text it was last given, which
 * it would otherwise keep as its argument, a Credential's value among it.
 * @param registry - The registry.
 * @param timeline - Where the draft was sent from.
 */
const letGoOfTyped = (registry: AtomRegistry.AtomRegistry, timeline: Place) => {
  if (draftOf(registry.get(composerState), timeline).text === "") {
    registry.set(edit, { text: "", timeline });
  }
};

/**
 * Remembers that a draft was not sent while a file added to it is still uploading, as the
 * core decides, if it was not. The composer says why while any file still waits, which the
 * core derives from the files pending, so the words are never kept.
 * @param registry - The registry.
 * @param timeline - Where the draft is.
 * @returns Whether it was held back.
 */
const heldBackNow = (registry: AtomRegistry.AtomRegistry, timeline: Place) => {
  const held = heldBack(
    registry.get(uploadingState),
    registry.get(composerState),
    timeline,
    registry.get(aliasesShown)
  );

  if (held !== undefined) {
    registry.set(
      uploadingState,
      reduceUploading(registry.get(uploadingState), { _tag: "HeldBack", place: timeline })
    );
  }

  return held !== undefined;
};

/**
 * Once a draft was sent and cleared, the files kept for it are let go of: their links went
 * with it, so there is nothing left to rename them in.
 * @param registry - The registry.
 * @param timeline - Where the draft was sent from.
 * @param intents - What the submit asked to carry out.
 */
const letGoOfKept = (
  registry: AtomRegistry.AtomRegistry,
  timeline: Place,
  intents: readonly unknown[]
) => {
  if (intents.length > 0 && draftOf(registry.get(composerState), timeline).text === "") {
    registry.set(
      uploadingState,
      reduceUploading(registry.get(uploadingState), { _tag: "Sent", place: timeline })
    );
  }
};

/**
 * Remembers the commands a draft ran, so the Composer's list puts them first.
 * @param registry - The registry.
 * @param keys - The keys of the commands, in order, the last the newest.
 */
const ran = (registry: AtomRegistry.AtomRegistry, keys: readonly string[]) => {
  if (keys.length > 0) {
    let recent = registry.get(ranState);

    for (const key of keys) {
      recent = remember(recent, key);
    }

    registry.set(ranState, recent);
  }
};

/**
 * Submits a Timeline's draft, and carries out what it asks, unless a file added to it is
 * still uploading.
 */
export const send = runtime
  .fn(
    (timeline: Place, get) =>
      Effect.gen(function* () {
        const { registry } = get;

        if (heldBackNow(registry, timeline)) {
          return;
        }

        const step = submit(registry.get(composerState), timeline, registry.get(commandContext));

        replaced(registry, step.state);
        letGoOfKept(registry, timeline, step.intents);
        ran(registry, step.ran);
        yield* sendAll(registry, timeline, step.intents, undefined);

        // After the intents, which may start a command over the draft, so what is let go of
        // is the draft as it is by then, and never a command's text over it.
        letGoOfTyped(registry, timeline);
      }),
    { concurrent: true }
  )
  .pipe(Atom.keepAlive);

/**
 * Sends the lines a Timeline's composer is waiting to have confirmed, unless a file added to
 * it is still uploading.
 */
export const confirmSend = runtime
  .fn(
    (timeline: Place, get) =>
      Effect.gen(function* () {
        const { registry } = get;

        if (heldBackNow(registry, timeline)) {
          return;
        }

        const step = confirm(registry.get(composerState), timeline, registry.get(aliasesShown));

        replaced(registry, step.state);
        letGoOfKept(registry, timeline, step.intents);
        ran(registry, step.ran);
        yield* sendAll(registry, timeline, step.intents, undefined);
      }),
    { concurrent: true }
  )
  .pipe(Atom.keepAlive);

/**
 * Takes what a Timeline's notice offers: sends again under the intent it keeps, or asks
 * `said` again about a Say whose request got no answer, which only `Journaled` settles.
 */
export const takeUp = runtime
  .fn(
    (timeline: Place, get) =>
      Effect.gen(function* () {
        const { registry } = get;
        const taken = takeOffer(registry.get(composerState), timeline);

        replaced(registry, taken.state);

        const { offer } = taken;

        if (offer === undefined) {
          return;
        }

        if (offer._tag === "SendAgain") {
          yield* sendAll(registry, timeline, offer.intents, offer.intent);

          return;
        }

        const outcome = yield* checked(offer.network, offer.intent);

        if (outcome._tag === "Failed") {
          happened(registry, {
            _tag: "Failed",
            failure: outcome.failure,
            intent: offer.intent,
            intents: offer.intents,
            timeline,
          });
        }
      }),
    { concurrent: true }
  )
  .pipe(Atom.keepAlive);

/** Carries out intents from a key, as the composer under the main view's. */
const performQueued = runtime
  .fn(
    (intents: readonly Intent[], get) =>
      Effect.gen(function* () {
        const { registry } = get;

        yield* sendAll(registry, placeOf(registry), intents, undefined);
      }),
    { concurrent: true }
  )
  .pipe(Atom.keepAlive);

/**
 * Carries out intents that came from a key, not the composer. When every one
 * is carried out in the page, as opening a Timeline is, it is done at once, so a key that
 * moves between Timelines never waits behind a Say in flight. Otherwise they wait their
 * turn with every other submission, and a failure is said under the composer.
 */
export const perform = Atom.fnSync((intents: readonly Intent[], get) => {
  const { registry } = get;

  if (intents.every((intent) => isLocal(intent))) {
    const place = placeOf(registry);

    for (const intent of intents) {
      if (isLocal(intent)) {
        carryOutHere(registry, place, intent);
      }
    }

    return;
  }

  registry.set(performQueued, intents);
}).pipe(Atom.keepAlive);
