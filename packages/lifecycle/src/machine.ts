import { setup, types } from "xstate";
import type { ExecutableEffectFrom } from "xstate";

import type { Command, NetworkEvent, NetworkInput } from "./lifecycle.ts";

// CONN-2: slow ident and DNS on old Ircds are normal.
const registrationTimeout = 60_000;
const registrationDeadline = "registration";

// Ends the attempt for now. The next step gives the nick numerics a fallback
// (CONN-4) and the rest a refusal (LIVE-5).
const closesRegistration: ReadonlySet<string> = new Set(["432", "433", "436", "464", "465"]);

type Payload<Type extends NetworkEvent["type"]> = Omit<
  Extract<NetworkEvent, { readonly type: Type }>,
  "type"
>;

type Params<Type extends Command["type"]> = Omit<Extract<Command, { readonly type: Type }>, "type">;

interface Deadline {
  readonly at: number;
  readonly name: string;
}

// What belongs to one Connection, and so never outlives it.
interface ConnectionContext {
  readonly closeReason: string | undefined;
  readonly deadlines: readonly Deadline[];
}

const noConnection: ConnectionContext = { closeReason: undefined, deadlines: [] };

// The Ircd's own words are its last parameter. A Line can arrive with none.
const textOf = ({ command, params }: Payload<"LINE">) => params.at(-1) ?? command;

// A Deadline Entry is appended after its deadline passes, so one stamped earlier
// than the live deadline was written for a deadline that has since been replaced.
const isDue = (deadlines: readonly Deadline[], { at, name }: Payload<"DEADLINE">) =>
  deadlines.some((deadline) => deadline.name === name && deadline.at <= at);

/** The Network machine. Package-private: everything else goes through `step` and `fold`. */
export const network = setup({
  // These only name Commands. `enq` drops an action with no body, and an effect's
  // `.type` is its function's `name`, so each must stay an inline function under
  // its own key: only then does the name outlive minification.
  actions: {
    closeConnection: (_params: Params<"closeConnection">) => {
      // Never runs: the host carries out the Command after commit.
    },
    sendLine: (_params: Params<"sendLine">) => {
      // Never runs: the host carries out the Command after commit.
    },
  },
  schemas: {
    context: types<NetworkInput & ConnectionContext>(),
    events: {
      ATTEMPT: types<Payload<"ATTEMPT">>(),
      CLOSED: types<Payload<"CLOSED">>(),
      DEADLINE: types<Payload<"DEADLINE">>(),
      LINE: types<Payload<"LINE">>(),
      OPENED: types<Payload<"OPENED">>(),
    },
    input: types<NetworkInput>(),
  },
}).createMachine({
  context: ({ input }) => ({ ...input, ...noConnection }),
  initial: "idle",
  on: {
    // Works from anywhere: a crash leaves a Connection that never recorded a close.
    ATTEMPT: ({ context }) => ({
      context: { ...context, ...noConnection },
      target: ".connection",
    }),
    CLOSED: ({ context, event }) => ({
      context: { ...context, ...noConnection, closeReason: event.reason },
      target: ".closed",
    }),
  },
  states: {
    closed: {},
    connection: {
      initial: "connecting",
      on: {
        LINE: ({ actions, event }, enq) => {
          if (event.command === "PING") {
            enq(actions.sendLine, {
              cause: "ping-reply",
              command: "PONG",
              params: event.params.slice(0, 1),
            });
          }

          if (event.command === "ERROR") {
            enq(actions.closeConnection, { reason: textOf(event) });
          }
        },
      },
      states: {
        connecting: {
          on: {
            OPENED: ({ actions, context, event }, enq) => {
              enq(actions.sendLine, {
                cause: "registration",
                command: "NICK",
                params: [context.nick],
              });
              enq(actions.sendLine, {
                cause: "registration",
                command: "USER",
                params: [context.username, "0", "*", context.realname],
              });

              return {
                context: {
                  ...context,
                  deadlines: [{ at: event.at + registrationTimeout, name: registrationDeadline }],
                },
                target: "registering",
              };
            },
          },
        },
        registering: {
          on: {
            // The Deadline clears as it fires, or the host would wake for it again
            // while the close is under way.
            DEADLINE: ({ actions, context, event }, enq) => {
              const due = event.name === registrationDeadline && isDue(context.deadlines, event);

              if (due) {
                enq(actions.closeConnection, { reason: "registration timed out" });
              }

              return due
                ? {
                    context: {
                      ...context,
                      deadlines: context.deadlines.filter(({ name }) => name !== event.name),
                    },
                  }
                : undefined;
            },
            LINE: ({ actions, context, event }, enq) => {
              if (closesRegistration.has(event.command)) {
                enq(actions.closeConnection, { reason: textOf(event) });
              }

              return event.command === "001"
                ? { context: { ...context, deadlines: [] }, target: "session" }
                : undefined;
            },
          },
        },
        session: {
          entry: ({ actions, context }, enq) => {
            for (const channel of context.channels) {
              enq(actions.sendLine, { cause: "autojoin", command: "JOIN", params: [channel] });
            }
          },
        },
      },
    },
    idle: {},
  },
});

// `.args` is `unknown[]` whichever action this is, so a Command is parsed back out.
const hasKey = <Params extends object>(value: unknown, key: keyof Params): value is Params =>
  typeof value === "object" && value !== null && key in value;

/**
 * Reads the Commands out of one effect of a transition. `.params` is no use here:
 * for an enqueued action it holds XState's own record, and `.args` holds the params.
 * @param effect - An effect returned by `transition`.
 * @returns The Command it stands for, or nothing for any other effect.
 */
export const commandsOf = (effect: ExecutableEffectFrom<typeof network>): readonly Command[] => {
  if (effect.kind !== "action") {
    return [];
  }

  const [params] = effect.args;

  if (effect.type === "sendLine" && hasKey<Params<"sendLine">>(params, "command")) {
    return [{ ...params, type: "sendLine" }];
  }

  if (effect.type === "closeConnection" && hasKey<Params<"closeConnection">>(params, "reason")) {
    return [{ ...params, type: "closeConnection" }];
  }

  return [];
};
