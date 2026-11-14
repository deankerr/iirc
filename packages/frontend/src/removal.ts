/**
 * Removing a Network, as a question the Owner answers before anything is sent: whether its
 * Timelines stay readable, then what the Daemon answered. A Network removed with its
 * Timelines kept is asked about again only to drop them, which frees its name.
 *
 * @packageDocumentation
 */
import type { NetworkId } from "@iirc/api";

/**
 * The question, as it stands.
 *
 * - `Closed`: nothing is asked.
 * - `Asking`: whether to remove `network`, keeping its Timelines or not, while the
 *   removal is `sending`, and why the last one failed, if it did.
 * - `Told`: `network` was removed, with something the Owner should know of it.
 */
export type Removal =
  | { readonly _tag: "Closed" }
  | {
      readonly _tag: "Asking";
      readonly network: NetworkId;
      readonly keep: boolean;
      readonly sending: boolean;
      readonly failure: string | undefined;
    }
  | { readonly _tag: "Told"; readonly network: NetworkId; readonly message: string };

/**
 * What the Daemon answered a removal: done, or the tag of the error it gave, or none when
 * it did not answer.
 */
export type RemovalAnswer =
  | { readonly _tag: "Removed" }
  | { readonly _tag: "Failed"; readonly error: string | undefined };

/**
 * What happened.
 *
 * - `Asked`: something asked to remove a Network, `keep` chosen to start with when given,
 *   and otherwise keeping its Timelines, which can be undone by dropping them later.
 * - `Chose`: the Owner chose whether its Timelines stay readable.
 * - `Sent`: the Owner confirmed, and the removal was sent.
 * - `Answered`: what the Daemon answered the removal of a Network.
 * - `Closed`: the Owner let the question go, or read what they were told.
 */
export type RemovalEvent =
  | { readonly _tag: "Asked"; readonly network: NetworkId; readonly keep: boolean | undefined }
  | { readonly _tag: "Chose"; readonly keep: boolean }
  | { readonly _tag: "Sent" }
  | { readonly _tag: "Answered"; readonly network: NetworkId; readonly answer: RemovalAnswer }
  | { readonly _tag: "Closed" };

/** Nothing asked. */
export const initialRemoval: Removal = { _tag: "Closed" };

/**
 * How a Network stands, for the question: `Live`, configured, `Kept`, removed with its
 * Timelines kept, or `Unknown`, not held, which the Daemon is asked about all the same.
 */
export type Standing = "Live" | "Kept" | "Unknown";

/**
 * Why a removal failed, in words, from its error's tag, never its text.
 * @param network - The Network.
 * @param error - The error's tag, or none when the Daemon did not answer.
 * @returns The words.
 */
const failureOf = (network: NetworkId, error: string | undefined): string => {
  const failures: ReadonlyMap<string | undefined, string> = new Map([
    ["UnknownNetwork", `The Daemon has no Network ${network}, so nothing was removed.`],
    [
      "NetworkStopped",
      `${network} has stopped, so it cannot be removed until the Daemon starts again.`,
    ],
    ["JournalFailed", `The Daemon could not write its Journal, so ${network} was not removed.`],
  ]);

  return (
    failures.get(error) ??
    `The Daemon did not answer, so whether ${network} was removed is unknown. Removing it again is safe.`
  );
};

/**
 * The question after an event.
 * @param state - The question before.
 * @param event - What happened.
 * @returns The question after.
 */
export const reduceRemoval = (state: Removal, event: RemovalEvent): Removal => {
  switch (event._tag) {
    case "Asked": {
      // A removal in flight is answered before another is asked.
      return state._tag === "Asking" && state.sending
        ? state
        : {
            _tag: "Asking",
            failure: undefined,
            keep: event.keep ?? true,
            network: event.network,
            sending: false,
          };
    }

    case "Chose": {
      return state._tag === "Asking" && !state.sending ? { ...state, keep: event.keep } : state;
    }

    case "Sent": {
      return state._tag === "Asking" && !state.sending
        ? { ...state, failure: undefined, sending: true }
        : state;
    }

    case "Answered": {
      if (state._tag !== "Asking" || !state.sending || state.network !== event.network) {
        return state;
      }

      const { answer } = event;

      if (answer._tag === "Removed") {
        return initialRemoval;
      }

      // The removal stands, but a Credential its Configuration named may still be held.
      if (answer.error === "VaultFailed") {
        return {
          _tag: "Told",
          message: `${state.network} was removed, but the Daemon could not forget every Credential its Configuration named.`,
          network: state.network,
        };
      }

      return { ...state, failure: failureOf(state.network, answer.error), sending: false };
    }

    case "Closed": {
      return state._tag === "Asking" && state.sending ? state : initialRemoval;
    }

    default: {
      return event satisfies never;
    }
  }
};

/** What the Owner is asked, in words, and whether they choose to keep the Timelines. */
export interface Question {
  readonly title: string;
  readonly body: string;
  /** Whether the Owner chooses between keeping the Timelines and dropping them. */
  readonly choosing: boolean;
  /** What the button that confirms says. */
  readonly confirm: string;
}

/**
 * What the Owner is asked about a Network, as it stands: removing it, with the choice of
 * keeping its Timelines, or, removed with them kept, dropping them.
 * @param network - The Network.
 * @param standing - How it stands.
 * @returns The question.
 */
export const questionOf = (network: NetworkId, standing: Standing): Question =>
  standing === "Kept"
    ? {
        body: `${network} was removed, and its Timelines were kept to read. Dropping them deletes them for every Frontend, and lets a new Network take the name ${network}.`,
        choosing: false,
        confirm: "Drop them",
        title: `Drop ${network}'s Timelines?`,
      }
    : {
        body: `Its Session ends, and its Configuration and Credentials go. Kept, its Timelines can still be read and searched, and the name ${network} stays taken until they are dropped.`,
        choosing: true,
        confirm: "Remove",
        title: `Remove ${network}?`,
      };

/**
 * The removal to send once the Owner confirms: the Network, and whether its Timelines are
 * kept, never when they were kept already, since removing it again is how they are dropped.
 * @param state - The question.
 * @param standing - How its Network stands.
 * @returns The removal, or none when nothing is asked or one is in flight.
 */
export const removalOf = (
  state: Removal,
  standing: Standing
): { readonly network: NetworkId; readonly keep: boolean } | undefined =>
  state._tag === "Asking" && !state.sending
    ? { keep: standing !== "Kept" && state.keep, network: state.network }
    : undefined;
