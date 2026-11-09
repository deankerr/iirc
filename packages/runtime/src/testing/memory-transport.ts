import type { CloseReason, IrcdAddress } from "@iirc/client";
import { Effect, Queue, Ref, Stream } from "effect";
import type { Cause } from "effect";

import { maxReceivedBytes } from "../transport.ts";
import type { LinkEvent, TransportService } from "../transport.ts";

/** The far end of one dialled Connection, played by a test. */
export interface TestCall {
  readonly address: IrcdAddress;
  /** Accepts the Connection, so the Link reports `Opened`. */
  readonly open: Effect.Effect<void>;
  /**
   * Sends one Line's bytes, without its line ending, framed by the Transport as an Ircd's
   * would be. Only while open.
   */
  readonly say: (bytes: Uint8Array) => Effect.Effect<void>;
  /** The next Line the Link sent, with its line ending, waiting until one comes. */
  readonly heard: Effect.Effect<Uint8Array>;
  /** Ends the Connection, or refuses it if it was never opened. */
  readonly close: (reason: CloseReason) => Effect.Effect<void>;
}

/** The Ircds a test Transport reaches. */
export interface TestIrcd {
  /** The next Connection dialled, waiting until one comes. */
  readonly accept: Effect.Effect<TestCall>;
}

/** A Transport, and the Ircd side of it for a test to play. */
export interface MemoryTransport {
  readonly transport: TransportService;
  readonly ircd: TestIrcd;
}

type Phase = "Dialling" | "Open" | "Closed";

const misuse = (what: string) => Effect.die(new Error(`TestCall: ${what}`));

/**
 * A Transport in memory, as an in-memory pair: each dial becomes a {@link TestCall}
 * that the test answers.
 * @returns A fresh Transport with no Connections.
 */
export const makeMemoryTransport: Effect.Effect<MemoryTransport> = Effect.gen(function* () {
  const calls = yield* Queue.unbounded<TestCall>();

  const dial = (address: IrcdAddress) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<LinkEvent, Cause.Done>();
      const heard = yield* Queue.unbounded<Uint8Array>();
      const phase = yield* Ref.make<Phase>("Dialling");

      const close = (event: LinkEvent | undefined) =>
        Effect.flatMap(Ref.getAndSet(phase, "Closed"), (was) =>
          was === "Closed"
            ? Effect.void
            : Effect.andThen(
                event === undefined ? Effect.void : Queue.offer(events, event),
                Queue.end(events)
              )
        );

      yield* Effect.addFinalizer(() => close(undefined));

      yield* Queue.offer(calls, {
        address,
        close: (reason) => close({ _tag: "Closed", reason }),
        heard: Queue.take(heard),
        open: Effect.flatMap(Ref.get(phase), (now) =>
          now === "Dialling"
            ? Effect.andThen(Ref.set(phase, "Open"), Queue.offer(events, { _tag: "Opened" }))
            : misuse(`open while ${now}`)
        ),
        // Framed as a real Transport frames: an empty Line is skipped, and a long one is cut.
        say: (bytes) =>
          Effect.flatMap(Ref.get(phase), (now) => {
            if (now !== "Open") {
              return misuse(`say while ${now}`);
            }

            return bytes.length === 0
              ? Effect.void
              : Queue.offer(events, { _tag: "Received", bytes: bytes.slice(0, maxReceivedBytes) });
          }),
      });

      return {
        events: Stream.fromQueue(events),
        hangup: close({ _tag: "Closed", reason: "HungUp" }),
        send: (bytes: Uint8Array) =>
          Effect.flatMap(Ref.get(phase), (now) =>
            now === "Open" ? Queue.offer(heard, bytes) : Effect.void
          ),
      };
    });

  return { ircd: { accept: Queue.take(calls) }, transport: { dial } };
});
