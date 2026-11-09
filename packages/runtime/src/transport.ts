/**
 * The Transport port: dial an Ircd, carry Lines both ways, and say how the Connection
 * ended. It never fails. Every way a Connection can go wrong ends as `Closed` with a
 * reason, so the Runtime journals it as an input like any other.
 *
 * @packageDocumentation
 */
import type { CloseReason, IrcdAddress } from "@iirc/client";
import { maxLineBytes } from "@iirc/protocol/line";
import { Context } from "effect";
import type { Effect, Scope, Stream } from "effect";

/** The most tag bytes an Ircd may send, with the leading `@` and the space after. */
const maxReceivedTagBytes = 8191;

/**
 * The most bytes of one received Line the Transport delivers, without its line ending.
 * A longer Line is cut to this length, and the rest of it is dropped.
 */
export const maxReceivedBytes = maxReceivedTagBytes + maxLineBytes;

/** What a Connection reports, in order. */
export type LinkEvent =
  | { readonly _tag: "Opened" }
  /** One Line's bytes, without its line ending. */
  | { readonly _tag: "Received"; readonly bytes: Uint8Array }
  | { readonly _tag: "Closed"; readonly reason: CloseReason };

/** One Connection, as the Transport carries it. */
export interface Link {
  /**
   * What happens to the Connection, read once: at most one `Opened`, then any number of
   * `Received`, then exactly one `Closed`, and then the stream ends. A dial that fails
   * gives a `Closed` with no `Opened`.
   */
  readonly events: Stream.Stream<LinkEvent>;
  /** Writes one Line's bytes, with its line ending. Before `Opened` or after `Closed`, it does nothing. */
  readonly send: (bytes: Uint8Array) => Effect.Effect<void>;
  /** Ends the Connection. Its `Closed` says `HungUp`, unless it had already ended otherwise. */
  readonly hangup: Effect.Effect<void>;
}

/** What a Transport adapter provides. */
export interface TransportService {
  /**
   * Starts a Connection to an Ircd and returns at once. Closing the Scope ends the
   * Connection without a `Closed`, because nothing is left to read it.
   */
  readonly dial: (address: IrcdAddress) => Effect.Effect<Link, never, Scope.Scope>;
}

/** The Transport port. */
export class Transport extends Context.Service<Transport, TransportService>()(
  "@iirc/runtime/Transport"
) {}
