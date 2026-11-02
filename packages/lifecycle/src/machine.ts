import { isRefusal } from "@iirc/protocol/refusal";
import { setup, types } from "xstate";
import type { ExecutableEffectFrom } from "xstate";

import type { Command, NetworkEvent, NetworkInput } from "./lifecycle.ts";

const registrationDeadline = "registration";
const burstDeadline = "burst";
const silenceDeadline = "silence";
const lagCheckDeadline = "lag-check";

const control = "control";

// `437` also applies to Channels, so it needs a look at its parameter (CONN-4).
const rejectsNick: ReadonlySet<string> = new Set(["432", "433", "436"]);

// How an MOTD ends, or how an Ircd says there isn't one (CONN-7).
const endsBurst: ReadonlySet<string> = new Set(["376", "422"]);

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
  /** The host is ending this Connection, so no welcome can start a Session (LEAVING). */
  readonly leaving: boolean;
  readonly nickIndex: number;
  readonly nicks: readonly string[];
}

const noConnection: ConnectionContext = {
  closeReason: undefined,
  deadlines: [],
  leaving: false,
  nickIndex: 0,
  nicks: [],
};

type Context = NetworkInput & ConnectionContext;

// The Ircd's own words are its last parameter. A Line can arrive with none.
const textOf = ({ command, params }: Payload<"LINE">) => params.at(-1) ?? command;

const isNickRejection = ({ command, params }: Payload<"LINE">, tried: string | undefined) =>
  rejectsNick.has(command) || (command === "437" && params[1] === tried);

// A Deadline Entry is stamped after its deadline passes, and a Line moves the deadline
// to its own stamp plus the limit. So an Entry stamped before the live deadline was
// written for one that has since been replaced, whether by a Line or by another
// Connection, and it must do nothing, or a flood racing the deadline would be killed.
const isDue = (deadlines: readonly Deadline[], { at, name }: Payload<"DEADLINE">) =>
  deadlines.some((deadline) => deadline.name === name && deadline.at <= at);

const without = (deadlines: readonly Deadline[], name: string) =>
  deadlines.filter((deadline) => deadline.name !== name);

const movedTo = (deadlines: readonly Deadline[], name: string, at: number) =>
  deadlines.map((deadline) => (deadline.name === name ? { at, name } : deadline));

// Any inbound Line proves the Connection is alive (LIVE-2).
const heard = (context: Context, at: number): Context => ({
  ...context,
  deadlines: movedTo(context.deadlines, silenceDeadline, at + context.tuning.silenceMillis),
});

// The way out of a Connection the machine has given up on. Nothing is pending once it
// has asked for a close, or the host would wake for it while the close is under way.
const leaving = (context: Context) => ({
  context: { ...context, deadlines: [] },
  target: "#network.closing",
});

/** The Network machine. Package-private: everything else goes through `step` and `fold`. */
export const network = setup({
  // These only name Commands. `enq` drops an action with no body, and an effect's
  // `.type` is its function's `name`, so each must stay an inline function under
  // its own key: only then does the name outlive minification.
  actions: {
    burstComplete: () => {
      // Never runs: the host carries out the Command after commit.
    },
    closeConnection: (_params: Params<"closeConnection">) => {
      // Never runs: the host carries out the Command after commit.
    },
    sendLine: (_params: Params<"sendLine">) => {
      // Never runs: the host carries out the Command after commit.
    },
    sendPong: (_params: Params<"sendPong">) => {
      // Never runs: the host carries out the Command after commit.
    },
  },
  schemas: {
    context: types<Context>(),
    events: {
      ATTEMPT: types<Payload<"ATTEMPT">>(),
      CLOSED: types<Payload<"CLOSED">>(),
      CLOSING: types<Payload<"CLOSING">>(),
      DEADLINE: types<Payload<"DEADLINE">>(),
      HEARD: types<Payload<"HEARD">>(),
      LEAVING: types<Payload<"LEAVING">>(),
      LINE: types<Payload<"LINE">>(),
      OPENED: types<Payload<"OPENED">>(),
      PING: types<Payload<"PING">>(),
    },
    input: types<NetworkInput>(),
  },
}).createMachine({
  context: ({ input }) => ({ ...input, ...noConnection }),
  id: "network",
  initial: "idle",
  on: {
    // Works from anywhere: a crash leaves a Connection that never recorded a close.
    ATTEMPT: ({ context, event }) => ({
      context: { ...context, ...noConnection, nicks: event.nicks },
      target: ".connection",
    }),
    CLOSED: ({ context, event }) => ({
      context: { ...context, ...noConnection, closeReason: event.reason },
      target: ".closed",
    }),
  },
  states: {
    closed: {},
    // Whoever started the close, the machine has finished with this Connection. A
    // `PING` goes unanswered here, because a `PONG` could only leave behind the `QUIT`
    // or the close already asked for, and neither leaves the Ircd waiting on one.
    closing: {},
    connection: {
      initial: "connecting",
      on: {
        CLOSING: ({ actions, context, event }, enq) => {
          enq(actions.sendLine, {
            cause: "quit",
            command: "QUIT",
            lane: control,
            params: [event.reason],
          });
          enq(actions.closeConnection, { reason: event.reason });

          return leaving(context);
        },
        LEAVING: ({ context }) => ({ context: { ...context, leaving: true } }),
        PING: ({ actions, event }, enq) => {
          enq(actions.sendPong, { cause: "ping-reply", lane: control, token: event.token });
        },
      },
      states: {
        connecting: {
          on: {
            // Nothing is connected yet, so there is nobody to send `QUIT` to.
            CLOSING: ({ actions, context, event }, enq) => {
              enq(actions.closeConnection, { reason: event.reason });

              return leaving(context);
            },
            OPENED: ({ actions, context, event }, enq) => {
              const [nick] = context.nicks;

              if (nick === undefined) {
                enq(actions.closeConnection, { reason: "no nicks to try" });

                return leaving(context);
              }

              enq(actions.sendLine, {
                cause: "registration",
                command: "NICK",
                lane: control,
                params: [nick],
              });
              enq(actions.sendLine, {
                cause: "registration",
                command: "USER",
                lane: control,
                params: [context.username, "0", "*", context.realname],
              });

              return {
                context: {
                  ...context,
                  deadlines: [
                    {
                      at: event.at + context.tuning.registrationTimeoutMillis,
                      name: registrationDeadline,
                    },
                  ],
                },
                target: "registering",
              };
            },
          },
        },
        registering: {
          on: {
            DEADLINE: ({ actions, context, event }, enq) => {
              const due = event.name === registrationDeadline && isDue(context.deadlines, event);

              if (due) {
                enq(actions.closeConnection, { reason: "registration timed out" });
              }

              return due ? leaving(context) : undefined;
            },
            LINE: ({ actions, context, event }, enq) => {
              if (isNickRejection(event, context.nicks[context.nickIndex])) {
                const nickIndex = context.nickIndex + 1;
                const nick = context.nicks[nickIndex];

                if (nick === undefined) {
                  enq(actions.closeConnection, {
                    reason: `ran out of nicks after ${context.nicks.length}: ${textOf(event)}`,
                  });

                  return leaving(context);
                }

                enq(actions.sendLine, {
                  cause: "nick-fallback",
                  command: "NICK",
                  lane: control,
                  params: [nick],
                });

                return { context: { ...context, nickIndex } };
              }

              if (isRefusal(event.command, event.params)) {
                enq(actions.closeConnection, { reason: textOf(event), refused: true });

                return leaving(context);
              }

              // Only a known transient `ERROR` gets here, and the Ircd is still leaving.
              if (event.command === "ERROR") {
                enq(actions.closeConnection, { reason: textOf(event) });

                return leaving(context);
              }

              // A welcome that names nobody leaves no Self for a Session to be, so
              // it agrees with `@iirc/state` and the deadline keeps running. Nor does one
              // that arrives once the host is leaving.
              return event.command === "001" && event.params.length > 0 && !context.leaving
                ? {
                    context: {
                      ...context,
                      deadlines: [
                        { at: event.at + context.tuning.burstMillis, name: burstDeadline },
                        { at: event.at + context.tuning.lagCheckMillis, name: lagCheckDeadline },
                        { at: event.at + context.tuning.silenceMillis, name: silenceDeadline },
                      ],
                    },
                    target: "session",
                  }
                : undefined;
            },
          },
        },
        session: {
          on: {
            DEADLINE: ({ actions, context, event }, enq) => {
              const name = isDue(context.deadlines, event) ? event.name : undefined;

              if (name === burstDeadline) {
                enq(actions.burstComplete);

                return {
                  context: { ...context, deadlines: without(context.deadlines, burstDeadline) },
                };
              }

              if (name === lagCheckDeadline) {
                // From the Entry's own time, so a replay gives the same token, and two
                // checks can only share one if they share a millisecond.
                enq(actions.sendLine, {
                  cause: "lag-check",
                  command: "PING",
                  lane: control,
                  params: [`lag-${event.at}`],
                });

                return {
                  context: {
                    ...context,
                    deadlines: movedTo(
                      context.deadlines,
                      lagCheckDeadline,
                      event.at + context.tuning.lagCheckMillis
                    ),
                  },
                };
              }

              if (name === silenceDeadline) {
                enq(actions.closeConnection, {
                  reason: `heard nothing for ${context.tuning.silenceMillis / 1000} seconds`,
                });
              }

              return name === silenceDeadline ? leaving(context) : undefined;
            },
            HEARD: ({ context, event }) => ({ context: heard(context, event.at) }),
            LINE: ({ actions, context, event }, enq) => {
              if (event.command === "ERROR") {
                enq(actions.closeConnection, { reason: textOf(event) });

                return leaving(context);
              }

              const alive = heard(context, event.at);

              if (
                endsBurst.has(event.command) &&
                alive.deadlines.some(({ name }) => name === burstDeadline)
              ) {
                enq(actions.burstComplete);

                return {
                  context: { ...alive, deadlines: without(alive.deadlines, burstDeadline) },
                };
              }

              return { context: alive };
            },
            PING: ({ actions, context, event }, enq) => {
              enq(actions.sendPong, { cause: "ping-reply", lane: control, token: event.token });

              return { context: heard(context, event.at) };
            },
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
 * Every action is a Command, so one that cannot be read throws rather than vanishing,
 * which is what a name lost to minification would otherwise do.
 * @param effect - An effect returned by `transition`.
 * @returns The Command it stands for, or nothing for any other kind of effect.
 */
export const commandsOf = (effect: ExecutableEffectFrom<typeof network>): readonly Command[] => {
  if (effect.kind !== "action") {
    return [];
  }

  const [params] = effect.args;

  if (effect.type === "burstComplete") {
    return [{ type: "burstComplete" }];
  }

  if (effect.type === "sendLine" && hasKey<Params<"sendLine">>(params, "command")) {
    return [{ ...params, type: "sendLine" }];
  }

  if (effect.type === "sendPong" && hasKey<Params<"sendPong">>(params, "token")) {
    return [{ ...params, type: "sendPong" }];
  }

  if (effect.type === "closeConnection" && hasKey<Params<"closeConnection">>(params, "reason")) {
    return [{ ...params, type: "closeConnection" }];
  }

  throw new Error(`The machine asked for an unknown Command: ${effect.type}`);
};
