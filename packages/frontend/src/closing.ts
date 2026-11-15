/**
 * Closing a Timeline: what closes one from its row, and the offer to leave a Channel Self is
 * in, which the Daemon refuses to close, as a reducer over what the Owner chose and what the
 * Daemon answered. Whether a Timeline is closed is the Daemon's to derive, and the sidebar
 * reads it from the Timeline.
 *
 * @packageDocumentation
 */
import type { NetworkId, Timeline } from "@iirc/api";

import type { CloseTimeline } from "./commands.ts";
import type { Edit } from "./options.ts";

/**
 * What closes a Timeline from its row: its Target, a Channel's name or a Direct Message
 * partner's nick, on its Network.
 * @param timeline - The Timeline.
 * @returns The intent, or none for a Network's own, a Direct Message that no longer
 * follows its partner, which has no Target, or one of a Network removed, which is only read.
 */
export const closeOf = (timeline: Timeline): CloseTimeline | undefined =>
  timeline.kind === "Network" || timeline.key === null || timeline.removed
    ? undefined
    : { _tag: "CloseTimeline", network: timeline.network, target: timeline.name };

/**
 * The offer to leave a Channel the Owner asked to close, as it stands.
 *
 * - `Idle`: nothing is offered.
 * - `Offered`: leaving `channel` on `network`, while the edit is `sending`, and why the
 *   last one failed, if it did.
 */
export type Leaving =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Offered";
      readonly network: NetworkId;
      readonly channel: string;
      readonly sending: boolean;
      readonly failure: string | undefined;
    };

/**
 * What happened.
 *
 * - `Offered`: the Daemon refused to close a Channel because Self is in it.
 * - `Sent`: the Owner chose to leave it, and the edit was sent.
 * - `Answered`: the edit was made, or why it was not, in words.
 * - `Dismissed`: the Owner let the offer go.
 */
export type LeavingEvent =
  | { readonly _tag: "Offered"; readonly network: NetworkId; readonly channel: string }
  | { readonly _tag: "Sent" }
  | { readonly _tag: "Answered"; readonly failure: string | undefined }
  | { readonly _tag: "Dismissed" };

/** Nothing offered. */
export const initialLeaving: Leaving = { _tag: "Idle" };

/**
 * The offer after an event. An edit in flight is answered before anything else is offered
 * or the offer is let go.
 * @param state - The offer before.
 * @param event - What happened.
 * @returns The offer after.
 */
export const reduceLeaving = (state: Leaving, event: LeavingEvent): Leaving => {
  const sending = state._tag === "Offered" && state.sending;

  switch (event._tag) {
    case "Offered": {
      return sending
        ? state
        : {
            _tag: "Offered",
            channel: event.channel,
            failure: undefined,
            network: event.network,
            sending: false,
          };
    }

    case "Sent": {
      return state._tag === "Offered" && !sending
        ? { ...state, failure: undefined, sending: true }
        : state;
    }

    case "Answered": {
      if (!sending) {
        return state;
      }

      return event.failure === undefined
        ? initialLeaving
        : { ...state, failure: event.failure, sending: false };
    }

    case "Dismissed": {
      return sending ? state : initialLeaving;
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * The edit that leaves the Channel offered, as `/part` with its name does: it taken from
 * the Channels wanted in its Network's Configuration.
 * @param state - The offer.
 * @returns The Network and the edit, or none when nothing is offered or one is in flight.
 */
export const leaveOf = (
  state: Leaving
): { readonly network: NetworkId; readonly edit: Edit } | undefined =>
  state._tag === "Offered" && !state.sending
    ? { edit: { _tag: "Part", channels: [state.channel] }, network: state.network }
    : undefined;

/**
 * What the Owner is offered, in words.
 * @param channel - The Channel.
 * @param network - Its Network.
 * @returns The title and the body.
 */
export const offerOf = (channel: string, network: NetworkId) => ({
  body: `A Channel you are in stays in the sidebar. Leaving parts it and takes it from ${network}'s Channels. Once you have left, it can be closed.`,
  title: `You are in ${channel}. Leave it?`,
});
