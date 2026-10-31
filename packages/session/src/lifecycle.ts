import type { Line } from "@iirc/protocol/line";
import { setupEffect } from "@xstate/effect";
import { types } from "xstate";

const registrationTimeoutMillis = 30_000;

interface LifecycleContext {
  readonly closeReason: string | undefined;
}

const closed = (closeReason: string) => ({ context: { closeReason }, target: "closed" as const });

const nickFailures = new Map([
  ["432", "was rejected as invalid"],
  ["433", "is already in use"],
]);

const closesRegistration = (line: Line) => {
  const failure = nickFailures.get(line.command);

  return failure === undefined ? undefined : `Nick ${line.params[1]} ${failure}`;
};

const closesSession = (line: Line) =>
  line.command === "ERROR" ? `The Ircd closed the Connection: ${line.params[0]}` : undefined;

/** The life of one Connection: from opening it, through registration, to its end. */
export const lifecycle = setupEffect({
  schemas: {
    context: types<LifecycleContext>(),
    events: {
      CLOSED: types<{ readonly reason: string }>(),
      LINE: types<{ readonly line: Line }>(),
      OPENED: types<object>(),
    },
  },
}).createMachine({
  context: { closeReason: undefined },
  initial: "connecting",
  states: {
    closed: { type: "final" },
    connecting: {
      on: {
        CLOSED: ({ event }) => closed(event.reason),
        OPENED: { target: "registering" },
      },
    },
    registered: {
      on: {
        CLOSED: ({ event }) => closed(event.reason),
        LINE: ({ event }) => {
          const reason = closesSession(event.line);

          return reason === undefined ? undefined : closed(reason);
        },
      },
    },
    registering: {
      after: {
        [registrationTimeoutMillis]: () => closed("Registration timed out"),
      },
      on: {
        CLOSED: ({ event }) => closed(event.reason),
        LINE: ({ event }) => {
          if (event.line.command === "001") {
            return { target: "registered" };
          }

          const reason = closesRegistration(event.line) ?? closesSession(event.line);

          return reason === undefined ? undefined : closed(reason);
        },
      },
    },
  },
});
