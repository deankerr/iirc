/**
 * Whether the Daemon is well, as anything on its machine may ask without a key.
 *
 * @packageDocumentation
 */
import { Schema } from "effect";

/** The Daemon is well: every part it counts is running. */
export const Well = Schema.TaggedStruct("Well", {});

/** The decoded form of {@link Well}. */
export type Well = typeof Well.Type;

/**
 * A part of the Daemon has stopped, and stays stopped until the Daemon restarts: the
 * projector, which keeps the Timelines folded. It names the part and never why, since the
 * reason can hold a path and is a Frontend's to read with a key.
 */
export class Unwell extends Schema.TaggedError<Unwell, { readonly brand: unique symbol }>()(
  "Unwell",
  { part: Schema.Literal("projector") },
  { httpApiStatus: 503 }
) {}
