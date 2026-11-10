/**
 * A Timeline's identity and how it is described.
 *
 * @packageDocumentation
 */
import { Schema } from "effect";

/**
 * A Timeline's id. It is opaque, and derived from where the Timeline was first opened:
 * the sequence of that step, the News's index in it, and which of its `where` entries
 * opened it. So a rebuild gives every Timeline the id it had, ids sort in the order the
 * Timelines were opened, and no name a Network chose is ever part of one. It is
 * lower-case hex and `-`, safe in a URL path.
 */
export const TimelineId = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[0-9a-f]{14}-[0-9a-f]{8}-[0-9a-f]{8}$/u, {
      expected: "a Timeline's id",
    })
  ),
  Schema.brand("TimelineId")
);

/** The decoded form of {@link TimelineId}. */
export type TimelineId = typeof TimelineId.Type;

const hex = (value: number, digits: number): string => value.toString(16).padStart(digits, "0");

/**
 * The id of a Timeline first opened at a step.
 * @param sequence - The step's sequence.
 * @param n - The News's index in the step.
 * @param slot - 0 for the Network's own Timeline, which opens before any News is placed,
 * else one more than the index of the `where` entry that opened it.
 * @returns The id.
 */
export const timelineIdOf = (sequence: number, n: number, slot: number): TimelineId =>
  TimelineId.make(`${hex(sequence, 14)}-${hex(n, 8)}-${hex(slot, 8)}`);

/** Whose Timeline it is: the Network's own, a Channel's, or a Direct Message partner's. */
export type Kind = "Network" | "Channel" | "Direct";

/**
 * A Timeline, as a store holds it apart from its items.
 *
 * `key` is the name folded by the casemapping the Network last declared, and is what News
 * finds the Timeline by. The Network's own has none. A Channel or Direct Message Timeline
 * with no key is detached: it keeps its id, name, and items, and receives nothing more.
 */
export interface Descriptor {
  readonly id: TimelineId;
  readonly network: string;
  readonly kind: Kind;
  /** The Channel's name, the partner's nick, or the Network's id, to show. */
  readonly name: string;
  readonly key: string | null;
}
