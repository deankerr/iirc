/**
 * Closing a Timeline: what closes one from its row, and the offer to leave a Channel Self is
 * in, which the Daemon refuses to close, as a reducer over what the Owner chose and what the
 * Daemon answered. Whether a Timeline is closed is the Daemon's to derive, and the sidebar
 * reads it from the Timeline.
 *
 * @packageDocumentation
 */
import type { ActionRequest, NetworkId, Timeline, TimelineId } from "@iirc/api";

import type { CloseTimeline } from "./commands.ts";
import { wantsChannel } from "./options.ts";
import type { Configuration, Edit, Naming } from "./options.ts";

/**
 * What closes a Timeline from its row: its id, whatever names it, so a Direct Message that no
 * longer follows its partner, which no Target names, and a Timeline a removed Network kept,
 * which no Client holds, close as any other.
 * @param timeline - The Timeline.
 * @returns The intent, or none for a Network's own, which is never closed.
 */
export const closeOf = (timeline: Timeline): CloseTimeline | undefined =>
  timeline.kind === "Network"
    ? undefined
    : { _tag: "CloseTimeline", network: timeline.network, timeline: timeline.id };

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
 * How the Channel offered is left: by the edit `/part` sends, for a Channel the Network's
 * Configuration wants, since the Client would join it again if only parted, or, for one it
 * does not, which the Ircd put Self in or Self joined by hand, by the action that parts it
 * and leaves the Configuration alone.
 */
export type Leave =
  | { readonly _tag: "Configure"; readonly network: NetworkId; readonly edit: Edit }
  | { readonly _tag: "Act"; readonly network: NetworkId; readonly action: ActionRequest };

/**
 * What leaves the Channel offered.
 * @param state - The offer.
 * @param configuration - The offer's Network's Configuration in force.
 * @param naming - What the Daemon reports of the Network, which Channels' names are
 * compared by.
 * @returns How to leave it, or none when nothing is offered or one is in flight.
 */
export const leaveOf = (
  state: Leaving,
  configuration: Configuration,
  naming: Naming
): Leave | undefined => {
  if (state._tag !== "Offered" || state.sending) {
    return undefined;
  }

  const { channel, network } = state;

  return wantsChannel(configuration, channel, naming)
    ? { _tag: "Configure", edit: { _tag: "Part", channels: [channel] }, network }
    : { _tag: "Act", action: { _tag: "Part", channel, reason: null }, network };
};

/**
 * What the Owner is offered, in words.
 * @param channel - The Channel.
 * @param network - Its Network.
 * @returns The title and the body.
 */
export const offerOf = (channel: string, network: NetworkId) => ({
  body: `A channel you are in stays in the sidebar. Leaving removes it from ${network}'s channels, and you can close it afterward.`,
  title: `You are in ${channel}. Leave it?`,
});

/**
 * A close the Owner asked for, of the Timeline it names: `ask` tells it apart, and `closedAt`
 * is the step the Daemon answered it `Closed` in, while the changes stream has yet to say
 * so, or none while it is not answered.
 */
export interface AskedClose {
  readonly ask: number;
  readonly network: NetworkId;
  readonly timeline: TimelineId;
  readonly closedAt: number | undefined;
}

/** The Timelines held of each Network, as the Timelines' state holds them. */
export type Held = ReadonlyMap<
  NetworkId,
  { readonly timelines: ReadonlyMap<TimelineId, Timeline> }
>;

/** The closes on their way, and the number the next one asked gets. */
export interface Closing {
  readonly asked: readonly AskedClose[];
  readonly next: number;
}

/**
 * What happened to a close.
 *
 * - `Asked`: the Owner asked to close a Timeline, with the number `ask` it is told apart by.
 * - `Answered`: the Daemon closed it in step `closedAt`, which the stream has yet to say,
 *   or the close is over, refused, failed, or already said, as none.
 */
export type ClosingEvent =
  | { readonly _tag: "Asked"; readonly network: NetworkId; readonly timeline: TimelineId }
  | { readonly _tag: "Answered"; readonly ask: number; readonly closedAt: number | undefined };

/** No close on its way. */
export const initialClosing: Closing = { asked: [], next: 0 };

/**
 * The closes after an event.
 * @param state - The closes before.
 * @param event - What happened.
 * @returns The closes after.
 */
export const reduceClosing = (state: Closing, event: ClosingEvent): Closing => {
  switch (event._tag) {
    case "Asked": {
      return {
        asked: [
          ...state.asked,
          {
            ask: state.next,
            closedAt: undefined,
            network: event.network,
            timeline: event.timeline,
          },
        ],
        next: state.next + 1,
      };
    }

    case "Answered": {
      return {
        ...state,
        asked: state.asked.flatMap((one) => {
          if (one.ask !== event.ask) {
            return [one];
          }

          return event.closedAt === undefined ? [] : [{ ...one, closedAt: event.closedAt }];
        }),
      };
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * The Timelines that show as closed before the Daemon says so: each asked to be and not yet
 * answered, and each it answered closed whose Timeline has not changed since, until the
 * stream says it is.
 * @param state - The closes.
 * @param held - The Timelines held.
 * @returns Their ids.
 */
export const closingShown = (state: Closing, held: Held): ReadonlySet<TimelineId> =>
  new Set(
    state.asked
      .filter((one) => {
        if (one.closedAt === undefined) {
          return true;
        }

        const changed = held.get(one.network)?.timelines.get(one.timeline)?.changed;

        return changed !== undefined && changed < one.closedAt;
      })
      .map((one) => one.timeline)
  );
