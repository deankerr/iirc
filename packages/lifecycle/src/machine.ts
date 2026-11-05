import { loginSign } from "@iirc/protocol/login";
import type { LoginSign } from "@iirc/protocol/login";
import { isRefusal } from "@iirc/protocol/refusal";

import type { Command, NetworkEvent, NetworkInput, Phase } from "./lifecycle.ts";

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

/** A Network's machine at one point in its fold: which Phase it is in, and what it holds. */
export interface Machine {
  readonly context: Context;
  readonly phase: Phase;
}

/** One step of the machine: where it went, and what it asks the host to do after commit. */
export interface Stepped {
  readonly commands: readonly Command[];
  readonly next: Machine;
}

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

// What a step returns when an event means nothing where the machine is: the same machine,
// so a host can tell that nothing moved.
const stay = (machine: Machine): Stepped => ({ commands: [], next: machine });

const moved = (context: Context, phase: Phase, commands: readonly Command[] = []): Stepped => ({
  commands,
  next: { context, phase },
});

// The way out of a Connection the machine has given up on. Nothing is pending once it
// has asked for a close, or the host would wake for it while the close is under way.
const leaving = (context: Context, commands: readonly Command[]): Stepped =>
  moved({ ...context, deadlines: [] }, "closing", commands);

const close = (reason: string, refused?: true): Command =>
  refused === undefined
    ? { reason, type: "closeConnection" }
    : { reason, refused, type: "closeConnection" };

const send = (cause: string, command: string, params: readonly string[]): Command => ({
  cause,
  command,
  lane: control,
  params,
  type: "sendLine",
});

const pong = (token: Uint8Array | undefined): Command => ({
  cause: "ping-reply",
  lane: control,
  token,
  type: "sendPong",
});

const burstComplete: Command = { type: "burstComplete" };
const loginSettled: Command = { type: "loginSettled" };

// Nothing is connected yet, so there is nobody to send `QUIT` to.
const fromConnecting = (machine: Machine, event: NetworkEvent): Stepped | undefined => {
  const { context } = machine;

  if (event.type === "CLOSING") {
    return leaving(context, [close(event.reason)]);
  }

  if (event.type !== "OPENED") {
    return undefined;
  }

  const [nick] = context.nicks;

  if (nick === undefined) {
    return leaving(context, [close("no nicks to try")]);
  }

  return moved(
    {
      ...context,
      deadlines: [
        { at: event.at + context.tuning.registrationTimeoutMillis, name: registrationDeadline },
      ],
    },
    "registering",
    [
      send("registration", "NICK", [nick]),
      send("registration", "USER", [context.username, "0", "*", context.realname]),
    ]
  );
};

const lineWhileRegistering = (machine: Machine, event: Payload<"LINE">): Stepped => {
  const { context } = machine;

  if (isNickRejection(event, context.nicks[context.nickIndex])) {
    const nickIndex = context.nickIndex + 1;
    const nick = context.nicks[nickIndex];

    return nick === undefined
      ? leaving(context, [
          close(`ran out of nicks after ${context.nicks.length}: ${textOf(event)}`),
        ])
      : moved({ ...context, nickIndex }, "registering", [send("nick-fallback", "NICK", [nick])]);
  }

  if (isRefusal(event.command, event.params)) {
    return leaving(context, [close(textOf(event), true)]);
  }

  // Only a known transient `ERROR` gets here, and the Ircd is still leaving.
  if (event.command === "ERROR") {
    return leaving(context, [close(textOf(event))]);
  }

  // A welcome that names nobody leaves no Self for a Session to be, so it agrees with
  // `@iirc/state` and the deadline keeps running. Nor does one that arrives once the host
  // is leaving.
  return event.command === "001" && event.params.length > 0 && !context.leaving
    ? moved(
        {
          ...context,
          deadlines: [
            { at: event.at + context.tuning.burstMillis, name: burstDeadline },
            { at: event.at + context.tuning.lagCheckMillis, name: lagCheckDeadline },
            { at: event.at + context.tuning.silenceMillis, name: silenceDeadline },
          ],
          welcomedAt: event.at,
        },
        "session"
      )
    : stay(machine);
};

const fromRegistering = (machine: Machine, event: NetworkEvent): Stepped | undefined => {
  if (event.type === "LINE") {
    return lineWhileRegistering(machine, event);
  }

  if (event.type !== "DEADLINE") {
    return undefined;
  }

  return event.name === registrationDeadline && isDue(machine.context.deadlines, event)
    ? leaving(machine.context, [close("registration timed out")])
    : stay(machine);
};

const deadlineInSession = (machine: Machine, event: Payload<"DEADLINE">): Stepped => {
  const { context } = machine;

  if (!isDue(context.deadlines, event)) {
    return stay(machine);
  }

  switch (event.name) {
    case burstDeadline: {
      return moved(
        { ...context, deadlines: without(context.deadlines, burstDeadline) },
        "session",
        [burstComplete]
      );
    }

    // No sign came in time, which is all a bare Network may ever say (CONN-6).
    case loginDeadline: {
      return moved(
        {
          ...context,
          deadlines: without(context.deadlines, loginDeadline),
          login: { ...context.login, answer: { _tag: "TimedOut" } },
        },
        "session",
        [loginSettled]
      );
    }

    // From the Entry's own time, so a replay gives the same token, and two checks can only
    // share one if they share a millisecond.
    case lagCheckDeadline: {
      return moved(
        {
          ...context,
          deadlines: movedTo(
            context.deadlines,
            lagCheckDeadline,
            event.at + context.tuning.lagCheckMillis
          ),
        },
        "session",
        [send("lag-check", "PING", [`lag-${event.at}`])]
      );
    }

    case silenceDeadline: {
      return leaving(context, [
        close(`heard nothing for ${context.tuning.silenceMillis / 1000} seconds`),
      ]);
    }

    default: {
      return stay(machine);
    }
  }
};

const lineInSession = ({ context }: Machine, event: Payload<"LINE">): Stepped => {
  if (event.command === "ERROR") {
    return leaving(context, [close(textOf(event))]);
  }

  const alive = heard(context, event.at);
  const signed = afterLoginSign(alive, event);

  const ended =
    endsBurst.has(event.command) && alive.deadlines.some(({ name }) => name === burstDeadline);

  const settles = !isLoginOpen(alive, alive.login) && isLoginOpen(signed, signed.login);

  return moved(
    ended ? { ...signed, deadlines: without(signed.deadlines, burstDeadline) } : signed,
    "session",
    [...(ended ? [burstComplete] : []), ...(settles ? [loginSettled] : [])]
  );
};

const fromSession = (machine: Machine, event: NetworkEvent): Stepped | undefined => {
  const { context } = machine;

  switch (event.type) {
    case "DEADLINE": {
      return deadlineInSession(machine, event);
    }

    case "HEARD": {
      return moved(heard(context, event.at), "session");
    }

    case "LINE": {
      return lineInSession(machine, event);
    }

    case "LOGIN_SENT": {
      const next = afterLoginSent(context, event);
      const settles = !isLoginOpen(context, context.login) && isLoginOpen(next, next.login);

      return moved(next, "session", settles ? [loginSettled] : []);
    }

    case "PING": {
      return moved(heard(context, event.at), "session", [pong(event.token)]);
    }

    case "ATTEMPT":
    case "CLOSED":
    case "CLOSING":
    case "LEAVING":
    case "OPENED": {
      return undefined;
    }

    // An event of a kind it has never heard of, from a Log a later Daemon wrote.
    default: {
      return undefined;
    }
  }
};

// What holds for any Phase of a Connection under way, unless that Phase says otherwise.
const fromConnection = (machine: Machine, event: NetworkEvent): Stepped => {
  const { context } = machine;

  switch (event.type) {
    case "CLOSING": {
      return leaving(context, [send("quit", "QUIT", [event.reason]), close(event.reason)]);
    }

    case "LEAVING": {
      return moved({ ...context, leaving: true }, machine.phase);
    }

    case "PING": {
      return { commands: [pong(event.token)], next: machine };
    }

    case "ATTEMPT":
    case "CLOSED":
    case "DEADLINE":
    case "HEARD":
    case "LINE":
    case "LOGIN_SENT":
    case "OPENED": {
      return stay(machine);
    }

    // An event of a kind it has never heard of, from a Log a later Daemon wrote.
    default: {
      return stay(machine);
    }
  }
};

// Whoever started the close, the machine has finished with this Connection. A `PING` goes
// unanswered here, because a `PONG` could only leave behind the `QUIT` or the close already
// asked for, and neither leaves the Ircd waiting on one.
//
// How its login went is still worth knowing until it has closed, so a sign that comes now
// is taken, and so is a Line of the sequence that was on its way out. Nothing is asked of
// the host and no wait starts, because nothing here waits any more (CONN-6).
const fromClosing = (machine: Machine, event: NetworkEvent): Stepped => {
  const { context } = machine;

  if (event.type === "LINE") {
    return moved(afterLoginSign(context, event), "closing");
  }

  return event.type === "LOGIN_SENT"
    ? moved({ ...context, login: countedLoginLine(context, event) }, "closing")
    : stay(machine);
};

const fromPhase = (machine: Machine, event: NetworkEvent): Stepped => {
  switch (machine.phase) {
    case "connecting": {
      return fromConnecting(machine, event) ?? fromConnection(machine, event);
    }

    case "registering": {
      return fromRegistering(machine, event) ?? fromConnection(machine, event);
    }

    case "session": {
      return fromSession(machine, event) ?? fromConnection(machine, event);
    }

    case "closing": {
      return fromClosing(machine, event);
    }

    case "idle":
    case "closed": {
      return stay(machine);
    }

    default: {
      return machine.phase satisfies never;
    }
  }
};

/**
 * The machine's first state, holding `input` until the first `ATTEMPT` brings its own.
 * @param input - What it holds until then.
 * @returns The machine, idle.
 */
export const initial = (input: NetworkInput): Machine => ({
  context: { ...input, ...noConnection },
  phase: "idle",
});

/**
 * The Network machine as a pure step: one event in, the next machine and its Commands out.
 * An event that means nothing where the machine is gives back the same machine.
 * @param machine - The machine so far.
 * @param event - What happened.
 * @returns Where it went, and what the host is to do after commit.
 */
export const transition = (machine: Machine, event: NetworkEvent): Stepped => {
  // Works from anywhere: a crash leaves a Connection that never recorded a close. The
  // input is the Connection's own, so nothing of the last one's carries over.
  if (event.type === "ATTEMPT") {
    const { loginLines, nicks, realname, services, tuning, username } = event;

    return moved(
      { ...noConnection, loginLines, nicks, realname, services, tuning, username },
      "connecting"
    );
  }

  if (event.type === "CLOSED") {
    return moved({ ...machine.context, ...noConnection, closeReason: event.reason }, "closed");
  }

  return fromPhase(machine, event);
};
