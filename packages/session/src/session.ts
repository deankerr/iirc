import { takeFrames } from "@iirc/protocol/frame";
import type { Parsed } from "@iirc/protocol/line";
import { parseFrame, parseLine } from "@iirc/protocol/line";
import type { Outbound, OutboundLine } from "@iirc/protocol/outbound";
import { encodeLine, outbound } from "@iirc/protocol/outbound";
import { createEffectActor, join, send, waitFor } from "@xstate/effect";
import { Data, Effect } from "effect";
import type { Reader, Socket } from "effect/socket/Socket";

import { lifecycle } from "./lifecycle.ts";

/** Where a Session is in its life. */
export type SessionPhase = "connecting" | "registering" | "registered" | "closed";

/** A Line that crossed the Connection, in either direction. */
export interface Observation {
  readonly direction: "inbound" | "outbound";
  readonly parsed: Parsed;
}

/** Who to be on a Network, what to connect over, and who is told about each Line. */
export interface SessionOptions {
  readonly channels: readonly string[];
  readonly nick: string;
  readonly observe: (observation: Observation) => Effect.Effect<void>;
  readonly realname: string;
  readonly socket: Socket;
  readonly username: string;
}

/** A Line could not be sent because there is no Session on the Network. */
export class NotInSession extends Data.TaggedError("NotInSession")<{
  readonly phase: SessionPhase;
}> {}

/** A presence on a Network that outlives any single request. */
export interface Session {
  readonly send: (line: OutboundLine) => Effect.Effect<void, NotInSession>;
  readonly status: Effect.Effect<{
    readonly closeReason: string | undefined;
    readonly phase: SessionPhase;
  }>;
}

const textEncoder = new TextEncoder();

/**
 * Starts a Session on the given socket. It runs until its Connection ends or the
 * enclosing scope closes, and it never fails: every ending is visible in `status`.
 */
export const makeSession = Effect.fn("makeSession")(function* (options: SessionOptions) {
  const { channels, nick, observe, realname, socket, username } = options;
  const actor = yield* createEffectActor(lifecycle);
  const writer = yield* socket.writer;

  const close = (reason: string) => send(actor, { reason, type: "CLOSED" });

  const write = (line: OutboundLine) =>
    writer.write(encodeLine(line)).pipe(
      Effect.andThen(observe({ direction: "outbound", parsed: parseLine(line.text) })),
      Effect.catch((error) => close(error.message))
    );

  const writeOrClose = (built: Outbound) =>
    built._tag === "Safe" ? write(built.line) : close(`Could not send a Line: ${built.reason}`);

  const receive = Effect.fn("receive")(function* (parsed: Parsed) {
    yield* observe({ direction: "inbound", parsed });

    if (parsed._tag === "Unparseable") {
      return;
    }

    const { line } = parsed;

    if (line.command === "PING") {
      const pong = outbound("PONG", line.params.slice(0, 1));

      if (pong._tag === "Safe") {
        yield* write(pong.line);
      }
    }

    yield* send(actor, { line, type: "LINE" });
  });

  const readLines = Effect.fn("readLines")(function* (reader: Reader) {
    let pending: Uint8Array = new Uint8Array();

    while (true) {
      const chunks = yield* reader.pull;

      for (const chunk of chunks) {
        const bytes = chunk instanceof Uint8Array ? chunk : textEncoder.encode(chunk);
        const { frames, pending: remainder } = takeFrames(pending, bytes);
        pending = remainder;
        yield* Effect.forEach(frames, (frame) => receive(parseFrame(frame)), { discard: true });
      }
    }
  });

  const connect = Effect.gen(function* () {
    const reader = yield* socket.reader;
    yield* send(actor, { type: "OPENED" });
    yield* writeOrClose(outbound("NICK", [nick]));
    yield* writeOrClose(outbound("USER", [username, "0", "*", realname]));

    return yield* readLines(reader);
  }).pipe(Effect.catch((error) => close(error.message)));

  const joinChannels = waitFor(actor, (snapshot) => snapshot.matches("registered")).pipe(
    Effect.andThen(
      Effect.forEach(channels, (channel) => writeOrClose(outbound("JOIN", [channel])), {
        discard: true,
      })
    ),
    Effect.ignore
  );

  // A machine that reaches `closed` ends the race, which releases the socket.
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- A machine's error type is `unknown`, and the lifecycle has no failing states.
  const closure = join(actor).pipe(Effect.ignore);

  yield* Effect.all([connect, joinChannels], { concurrency: "unbounded", discard: true }).pipe(
    Effect.raceFirst(closure),
    Effect.scoped,
    Effect.forkScoped
  );

  return {
    send: (line) =>
      Effect.suspend(() => {
        const snapshot = actor.getSnapshot();

        return snapshot.matches("registered")
          ? write(line)
          : Effect.fail(new NotInSession({ phase: snapshot.value }));
      }),
    status: Effect.sync(() => {
      const snapshot = actor.getSnapshot();

      return { closeReason: snapshot.context.closeReason, phase: snapshot.value };
    }),
  } satisfies Session;
});
