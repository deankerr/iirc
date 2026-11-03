import { loginSign } from "@iirc/protocol/login";
import type { LoginSign } from "@iirc/protocol/login";
import { isRefusal } from "@iirc/protocol/refusal";
import { setup, types } from "xstate";
import type { ExecutableEffectFrom } from "xstate";

import type { Command, NetworkEvent, NetworkInput } from "./lifecycle.ts";

const registrationDeadline = "registration";
const burstDeadline = "burst";
const silenceDeadline = "silence";
const lagCheckDeadline = "lag-check";
const loginDeadline = "login";

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

/**
 * What came of an `IDENTIFY` (CONN-6). Only one that was written is `Waiting`, and the wait
 * ends `Answered` by a sign, or `TimedOut`. A sign after the wait ran out still says how the
 * login went, so `TimedOut` can become `Answered`, though nothing waits on it by then.
 */
export type LoginAnswer =
  | { readonly _tag: "Unasked" }
  | { readonly _tag: "Waiting" }
  | { readonly _tag: "TimedOut" }
  | { readonly _tag: "Answered"; readonly sign: LoginSign };

/** How far the login sequence has got (CONN-6). */
export interface LoginProgress {
  readonly answer: LoginAnswer;
  /** How many of its Lines were written or Dropped, which stops at the last. */
  readonly seen: number;
}

// What belongs to one Connection, and so never outlives it.
interface ConnectionContext {
  readonly closeReason: string | undefined;
  readonly deadlines: readonly Deadline[];
  /** The host is ending this Connection, so no welcome can start a Session (LEAVING). */
  readonly leaving: boolean;
  readonly login: LoginProgress;
  readonly nickIndex: number;
  readonly nicks: readonly string[];
  /** When the `001` that started this Connection's Session arrived. It outlives the Session's close. */
  readonly welcomedAt: number | undefined;
}

const noConnection: ConnectionContext = {
  closeReason: undefined,
  deadlines: [],
  leaving: false,
  login: { answer: { _tag: "Unasked" }, seen: 0 },
  nickIndex: 0,
  nicks: [],
  welcomedAt: undefined,
};

/** What the machine holds. Package-private: everything else reads it through `inspect`. */
export type Context = NetworkInput & ConnectionContext;

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

/**
 * Joining waits until every Line of the login sequence is out, and then for any login that
 * an `IDENTIFY` started to show a sign or run out of time (CONN-6).
 * @param context - What the machine holds.
 * @param login - The login progress to judge, which may be one not yet in `context`.
 * @returns Whether the login no longer holds joining up.
 */
export const isLoginOpen = ({ loginLines }: Context, login: LoginProgress): boolean =>
  login.seen >= loginLines && login.answer._tag !== "Waiting";

// Only an `IDENTIFY` that was written asks for a login. Past the last Line of the sequence,
// nothing counts: a Line whose write was in doubt is Dropped after it was recorded, and
// comes twice.
const countedLoginLine = (
  { login, loginLines }: Context,
  event: Payload<"LOGIN_SENT">
): LoginProgress => {
  if (login.seen >= loginLines) {
    return login;
  }

  const asked = login.answer._tag === "Unasked" && event.identify && event.written;

  return { answer: asked ? { _tag: "Waiting" } : login.answer, seen: login.seen + 1 };
};

// The wait starts from the last Line of the sequence, whether that Line was written or
// Dropped (CONN-6).
const afterLoginSent = (context: Context, event: Payload<"LOGIN_SENT">): Context => {
  const login = countedLoginLine(context, event);
  const waits = login !== context.login && login.seen === context.loginLines;

  return {
    ...context,
    deadlines:
      waits && login.answer._tag === "Waiting"
        ? [
            ...context.deadlines,
            { at: event.at + context.tuning.loginWaitMillis, name: loginDeadline },
          ]
        : context.deadlines,
    login,
  };
};

// A sign counts only once an `IDENTIFY` is out, so a login some other way is no answer to
// a wait that has not begun. The first sign is the answer, and one that comes after the wait
// ran out is still taken, because how the login went is what the Owner wants to see. It
// settles nothing then, because the wait running out already did (CONN-6).
const afterLoginSign = (context: Context, event: Payload<"LINE">): Context => {
  const { answer } = context.login;
  const open = answer._tag === "Waiting" || answer._tag === "TimedOut";
  const sign = open ? loginSign(event, context.services) : undefined;

  return sign === undefined
    ? context
    : {
        ...context,
        deadlines: without(context.deadlines, loginDeadline),
        login: { ...context.login, answer: { _tag: "Answered", sign } },
      };
};

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
    loginSettled: () => {
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
      LOGIN_SENT: types<Payload<"LOGIN_SENT">>(),
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
    // Works from anywhere: a crash leaves a Connection that never recorded a close. The
    // input is the Connection's own, so nothing of the last one's carries over.
    ATTEMPT: ({ event: { loginLines, nicks, realname, services, tuning, username } }) => ({
      context: { ...noConnection, loginLines, nicks, realname, services, tuning, username },
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
    //
    // How its login went is still worth knowing until it has closed, so a sign that comes
    // now is taken, and so is a Line of the sequence that was on its way out. Nothing is
    // asked of the host and no wait starts, because nothing here waits any more (CONN-6).
    closing: {
      on: {
        LINE: ({ context, event }) => ({ context: afterLoginSign(context, event) }),
        LOGIN_SENT: ({ context, event }) => ({
          context: { ...context, login: countedLoginLine(context, event) },
        }),
      },
    },
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
                      welcomedAt: event.at,
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

              // No sign came in time, which is all a bare Network may ever say (CONN-6).
              if (name === loginDeadline) {
                enq(actions.loginSettled);

                return {
                  context: {
                    ...context,
                    deadlines: without(context.deadlines, loginDeadline),
                    login: { ...context.login, answer: { _tag: "TimedOut" } },
                  },
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
              const signed = afterLoginSign(alive, event);

              const ended =
                endsBurst.has(event.command) &&
                alive.deadlines.some(({ name }) => name === burstDeadline);

              if (ended) {
                enq(actions.burstComplete);
              }

              if (!isLoginOpen(alive, alive.login) && isLoginOpen(signed, signed.login)) {
                enq(actions.loginSettled);
              }

              return {
                context: ended
                  ? { ...signed, deadlines: without(signed.deadlines, burstDeadline) }
                  : signed,
              };
            },
            LOGIN_SENT: ({ actions, context, event }, enq) => {
              const next = afterLoginSent(context, event);

              if (!isLoginOpen(context, context.login) && isLoginOpen(next, next.login)) {
                enq(actions.loginSettled);
              }

              return { context: next };
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

  if (effect.type === "loginSettled") {
    return [{ type: "loginSettled" }];
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
