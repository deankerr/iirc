import { InvalidMessage, NotInSession } from "@iirc/api";
import { privmsg } from "@iirc/protocol/outbound";
import type { Message as ProtocolMessage, SessionState } from "@iirc/protocol/state";
import { initialState, messageOf, reduce } from "@iirc/protocol/state";
import type { Observation, SessionOptions, SessionPhase } from "@iirc/session/session";
import { makeSession } from "@iirc/session/session";
import { Context, DateTime, Effect, Layer } from "effect";

interface Entry extends Observation {
  readonly at: DateTime.Utc;
  readonly sequence: number;
}

/** A Message with the place of its Line in the Log. */
interface LoggedMessage extends ProtocolMessage {
  readonly at: DateTime.Utc;
  readonly sequence: number;
}

// Derives everything the Daemon knows from the Log, so nothing can drift from it.
const project = (entries: readonly Entry[]) => {
  let state: SessionState = initialState;
  const messages: LoggedMessage[] = [];

  for (const { at, direction, parsed, sequence } of entries) {
    if (parsed._tag === "Line") {
      const inbound = direction === "inbound";
      const message = messageOf(parsed.line, inbound ? undefined : state.self);

      if (message !== undefined) {
        messages.push({ ...message, at, sequence });
      }

      if (inbound) {
        state = reduce(state, parsed.line);
      }
    }
  }

  return { messages, state };
};

/** The Daemon's state and abilities, as the API exposes them. */
export class Daemon extends Context.Service<
  Daemon,
  {
    readonly lines: (after: number) => Effect.Effect<readonly Entry[]>;
    readonly messages: (after: number) => Effect.Effect<readonly LoggedMessage[]>;
    readonly send: (
      target: string,
      text: string
    ) => Effect.Effect<void, InvalidMessage | NotInSession>;
    readonly status: Effect.Effect<{
      readonly channels: readonly string[];
      readonly closeReason: string | null;
      readonly phase: SessionPhase;
      readonly self: string | null;
    }>;
  }
>()("@iirc/daemon/Daemon") {
  static readonly layer = (options: Omit<SessionOptions, "observe">) =>
    Layer.effect(
      Daemon,
      Effect.gen(function* () {
        const log: Entry[] = [];

        const session = yield* makeSession({
          ...options,
          observe: Effect.fn("Daemon.observe")(function* (observation) {
            const at = yield* DateTime.now;
            log.push({ ...observation, at, sequence: log.length + 1 });
          }),
        });

        return Daemon.of({
          // A sequence is its entry's position plus one, so a cursor is an index.
          lines: (after) => Effect.sync(() => log.slice(after)),
          messages: (after) =>
            Effect.sync(() => project(log).messages.filter(({ sequence }) => sequence > after)),
          send: Effect.fn("Daemon.send")(function* (target, text) {
            const built = privmsg(target, text);

            if (built._tag === "Rejected") {
              return yield* new InvalidMessage({ reason: built.reason });
            }

            return yield* session
              .send(built.line)
              .pipe(
                Effect.catchTag("NotInSession", ({ phase }) =>
                  Effect.fail(new NotInSession({ phase }))
                )
              );
          }),
          status: session.status.pipe(
            Effect.map(({ closeReason, phase }) => {
              const { channels, self } = project(log).state;

              return { channels, closeReason: closeReason ?? null, phase, self: self ?? null };
            })
          ),
        });
      })
    );
}
