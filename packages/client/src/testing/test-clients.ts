/**
 * Clients for the kit's own tests: a tiny hand-written Client that registers, negotiates
 * caps, keeps NAMES, and sets a timer, so strict play, timers, and the laws have
 * something real to run against, and Clients that break replay on purpose. None of this
 * is the Client.
 *
 * @packageDocumentation
 */
import {
  cap,
  isRejected,
  join,
  nick,
  parse,
  parseSource,
  pong,
  privmsg,
  rawParams,
  user,
} from "@iirc/protocol/line";
import type { Line, OutboundLine, Rejected } from "@iirc/protocol/line";

import type { Client, Inspection, Step } from "../client.ts";
import type { NetworkConfiguration } from "../configuration.ts";
import { CapName, ConnectionId, Instant, TimerId } from "../ids.ts";
import type { Input } from "../input.ts";
import type { Fact, Knowledge, MemberKnowledge } from "../known.ts";
import type { News } from "../news.ts";
import type { Output } from "../output.ts";
import { scripted } from "./scripted.ts";

/** Ways to make the toy Client break a law, to show that the law catches it. */
export interface Flaws {
  /** Declining a Feature changes what it sends, even while the Feature is off. */
  readonly declineShows?: boolean;
  /** With `multi-prefix`, it forgets prefixes instead of knowing them. */
  readonly forgetsWithCaps?: boolean;
  /** After `CAP DEL multi-prefix`, it keeps prefixes known instead of stale. */
  readonly keepsAfterDel?: boolean;
}

/** The toy Client's State, which is plain data. */
export interface ToyState {
  readonly phase: "Idle" | "Dialling" | "Registering" | "Registered";
  readonly configuration: NetworkConfiguration | undefined;
  readonly connection: number;
  readonly enabled: readonly string[];
  /** Caps that were enabled and then deleted, whose facts are stale. */
  readonly deleted: readonly string[];
  readonly self: string;
  /** Members by Channel, with their prefixes. */
  readonly channels: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly timers: ReadonlyMap<string, number>;
  readonly lastHeard: number;
}

const initial: ToyState = {
  channels: new Map(),
  configuration: undefined,
  connection: 0,
  deleted: [],
  enabled: [],
  lastHeard: 0,
  phase: "Idle",
  self: "*",
  timers: new Map(),
};

// The caps the toy Client asks for, by the Feature that needs each.
const wanted: ReadonlyMap<string, string> = new Map([
  ["multi-prefix", "multi-prefix"],
  ["server-time", "server-time"],
]);

const registrationTimeout = 30_000;
const pingInterval = 60_000;

const ignore = (
  state: ToyState,
  reason: Extract<News, { _tag: "Ignored" }>["reason"]
): Step<ToyState> => ({
  news: [{ _tag: "Ignored", reason }],
  outputs: [],
  state,
});

const send = (state: ToyState, line: OutboundLine | Rejected): readonly Output[] =>
  isRejected(line) ? [] : [{ _tag: "Send", connection: ConnectionId.make(state.connection), line }];

// Timers are derived from state: a `Wake` for each that differs.
const wakes = (before: ToyState, after: ToyState): readonly Output[] => {
  const ids = [...new Set([...before.timers.keys(), ...after.timers.keys()])].toSorted();

  return ids.flatMap((id): readonly Output[] => {
    const now = after.timers.get(id);

    return before.timers.get(id) === now
      ? []
      : [
          {
            _tag: "Wake",
            at: now === undefined ? null : Instant.make(now),
            timer: TimerId.make(id),
          },
        ];
  });
};

const timersFor = (
  phase: ToyState["phase"],
  at: number,
  lastHeard: number
): ReadonlyMap<string, number> => {
  if (phase === "Registering") {
    return new Map([["register", at + registrationTimeout]]);
  }

  return phase === "Registered" ? new Map([["ping", lastHeard + pingInterval]]) : new Map();
};

const finish = (
  before: ToyState,
  after: ToyState,
  at: number,
  outputs: readonly Output[],
  news: readonly News[] = []
): Step<ToyState> => {
  const next = { ...after, timers: timersFor(after.phase, at, after.lastHeard) };

  const kept =
    before.phase === next.phase && before.phase === "Registering"
      ? { ...next, timers: before.timers }
      : next;

  return { news, outputs: [...outputs, ...wakes(before, kept)], state: kept };
};

type Received = Extract<Input, { readonly _tag: "Received" }>;

/** What a handler for one command reads. */
interface Heard {
  readonly state: ToyState;
  /** The state, having heard this Line. */
  readonly heard: ToyState;
  readonly input: Received;
  readonly line: Line;
  readonly flaws: Flaws;
}

const onCap = ({ state, heard, input, line }: Heard): Step<ToyState> => {
  const [, sub] = line.params;
  const caps = (line.params.at(-1) ?? "").split(" ").filter((name) => name !== "");
  const declined = state.configuration?.declined ?? [];

  if (sub === "LS") {
    const asked = caps
      .map((offered) => offered.split("=")[0] ?? offered)
      .filter(
        (name) => wanted.has(name) && !declined.some((feature) => wanted.get(name) === feature)
      );

    return finish(
      state,
      heard,
      input.at,
      send(state, asked.length === 0 ? cap("END") : cap("REQ", asked.join(" ")))
    );
  }

  if (sub === "ACK") {
    return finish(state, { ...heard, enabled: caps }, input.at, send(state, cap("END")));
  }

  return finish(
    state,
    sub === "DEL"
      ? {
          ...heard,
          deleted: [...state.deleted, ...caps.filter((name) => state.enabled.includes(name))],
          enabled: state.enabled.filter((name) => !caps.includes(name)),
        }
      : heard,
    input.at,
    []
  );
};

const onWelcome = ({ state, heard, input, line }: Heard): Step<ToyState> => {
  const self = line.params[0] ?? state.self;

  return finish(
    state,
    { ...heard, phase: "Registered", self },
    input.at,
    [],
    [{ _tag: "SessionBegan", at: input.at, nick: self }]
  );
};

const onPing = ({ state, heard, input }: Heard): Step<ToyState> => {
  const token = rawParams(input.bytes).at(-1);

  return finish(state, heard, input.at, token === undefined ? [] : send(state, pong(token)));
};

const withMembers = (
  state: ToyState,
  channel: string,
  added: readonly (readonly [string, string])[]
): ReadonlyMap<string, ReadonlyMap<string, string>> => {
  const channels = new Map(state.channels);
  channels.set(
    channel,
    new Map([...(channels.get(channel) ?? new Map<string, string>()), ...added])
  );

  return channels;
};

const onJoin = ({ state, heard, input, line }: Heard): Step<ToyState> => {
  const [channel] = line.params;

  return channel === undefined
    ? ignore(state, { _tag: "Malformed", command: "JOIN" })
    : finish(
        state,
        {
          ...heard,
          channels: withMembers(state, channel, [[parseSource(line.source ?? "").nick, ""]]),
        },
        input.at,
        []
      );
};

const onNames = ({ state, heard, input, line, flaws }: Heard): Step<ToyState> => {
  const { 2: channel, 3: names } = line.params;
  const declined = state.configuration?.declined ?? [];

  if (channel === undefined || names === undefined) {
    return ignore(state, { _tag: "Malformed", command: "353" });
  }

  const members = names
    .split(" ")
    .filter((each) => each !== "")
    .map((name): readonly [string, string] => {
      const prefix = /^[@+%~&]*/u.exec(name)?.[0] ?? "";

      return [name.slice(prefix.length), prefix];
    });

  return finish(
    state,
    { ...heard, channels: withMembers(state, channel, members) },
    input.at,
    flaws.declineShows === true && declined.length > 0
      ? send(state, privmsg("#iirc", "declined"))
      : []
  );
};

const commands = new Map<string, (heard: Heard) => Step<ToyState>>([
  ["CAP", onCap],
  ["001", onWelcome],
  ["PING", onPing],
  ["JOIN", onJoin],
  ["353", onNames],
]);

const received = (state: ToyState, input: Received, flaws: Flaws): Step<ToyState> => {
  if (state.phase === "Idle" || state.phase === "Dialling") {
    return ignore(state, { _tag: "NotNow", input: "Received" });
  }

  const parsed = parse(input.bytes, { _tag: "Utf8OrElse", fallback: "latin1" });

  if (parsed._tag === "Unparseable") {
    return ignore(state, { _tag: "Unparseable", reason: parsed.reason });
  }

  const heard = { ...state, lastHeard: input.at };
  const handler = commands.get(parsed.line.command);

  return handler === undefined
    ? finish(state, heard, input.at, [])
    : handler({ flaws, heard, input, line: parsed.line, state });
};

const configured = (
  state: ToyState,
  input: Extract<Input, { readonly _tag: "Configured" }>
): Step<ToyState> => {
  const next = { ...state, configuration: input.configuration };
  const [ircd] = input.configuration.ircds;

  if (state.phase === "Registered") {
    const had = new Set(state.configuration?.channels.map(({ name }) => name));
    const added = input.configuration.channels.filter(({ name }) => !had.has(name));

    return finish(
      state,
      next,
      input.at,
      added.flatMap(({ name }) => send(state, join([name])))
    );
  }

  if (state.phase !== "Idle" || !input.configuration.enabled) {
    return finish(state, next, input.at, []);
  }

  const connection = state.connection + 1;

  return finish(state, { ...next, connection, phase: "Dialling" }, input.at, [
    { _tag: "Dial", connection: ConnectionId.make(connection), ircd },
  ]);
};

const opened = (state: ToyState, at: number): Step<ToyState> => {
  if (state.phase !== "Dialling" || state.configuration === undefined) {
    return ignore(state, { _tag: "NotNow", input: "Opened" });
  }

  const { configuration } = state;

  return finish(state, { ...state, lastHeard: at, phase: "Registering" }, at, [
    ...send(state, cap("LS", "302")),
    ...send(state, nick(configuration.nicks[0])),
    ...send(state, user(configuration.username, configuration.realname)),
  ]);
};

const closed = (
  state: ToyState,
  input: Extract<Input, { readonly _tag: "Closed" }>
): Step<ToyState> =>
  finish(
    state,
    { ...state, channels: new Map(), enabled: [], phase: "Idle" },
    input.at,
    [],
    [{ _tag: "SessionEnded", at: input.at, reason: { _tag: "Closed", reason: input.reason } }]
  );

const fired = (
  state: ToyState,
  input: Extract<Input, { readonly _tag: "Fired" }>
): Step<ToyState> => {
  if (state.timers.get(input.timer) !== input.due) {
    return ignore(state, { _tag: "StaleTimer", timer: input.timer });
  }

  return input.timer === "register"
    ? finish(state, state, input.at, [
        { _tag: "Hangup", connection: ConnectionId.make(state.connection) },
      ])
    : finish(
        state,
        { ...state, lastHeard: input.at },
        input.at,
        send(state, privmsg(state.self, "ping"))
      );
};

const said = (state: ToyState, input: Extract<Input, { readonly _tag: "Say" }>): Step<ToyState> =>
  state.phase === "Registered"
    ? finish(state, state, input.at, send(state, privmsg(input.target, input.text)), [
        {
          _tag: "Message",
          at: { _tag: "Known", at: input.at, from: "ours", value: input.at },
          id: { _tag: "Unknown" },
          kind: input.kind,
          live: true,
          ours: { echo: false, intent: input.intent },
          sender: state.self,
          tags: new Map(),
          target: input.target,
          text: input.text,
        },
      ])
    : {
        news: [{ _tag: "Refused", intent: input.intent, reason: { _tag: "Offline" } }],
        outputs: [],
        state,
      };

const step =
  (flaws: Flaws) =>
  (state: ToyState, input: Input): Step<ToyState> => {
    if (input._tag !== "Configured" && state.configuration === undefined) {
      return ignore(state, { _tag: "NotNow", input: input._tag });
    }

    if (
      (input._tag === "Opened" || input._tag === "Received" || input._tag === "Closed") &&
      input.connection !== state.connection
    ) {
      return ignore(state, { _tag: "StaleConnection", connection: input.connection });
    }

    switch (input._tag) {
      case "Configured": {
        return configured(state, input);
      }

      case "Opened": {
        return opened(state, input.at);
      }

      case "Received": {
        return received(state, input, flaws);
      }

      case "Closed": {
        return closed(state, input);
      }

      case "Fired": {
        return fired(state, input);
      }

      case "Say": {
        return said(state, input);
      }

      case "Retry":
      case "Started":
      case "Unfilled": {
        return ignore(state, { _tag: "NotNow", input: input._tag });
      }

      default: {
        return input satisfies never;
      }
    }
  };

const prefixesOf = (state: ToyState, prefix: string, flaws: Flaws): Fact<ReadonlySet<string>> => {
  const modes = new Set(Array.from(prefix, (char) => (char === "@" ? "o" : "v")));
  const at = Instant.make(state.lastHeard);

  if (state.enabled.includes("multi-prefix")) {
    return flaws.forgetsWithCaps === true
      ? { _tag: "Unknown" }
      : { _tag: "Known", at, from: "ircd", value: modes };
  }

  if (state.deleted.includes("multi-prefix")) {
    return flaws.keepsAfterDel === true
      ? { _tag: "Known", at, from: "ircd", value: modes }
      : { _tag: "Stale", since: at, was: modes };
  }

  return { _tag: "Partial", at, atLeast: modes, from: "ircd" };
};

const known =
  (flaws: Flaws) =>
  (state: ToyState): Knowledge => ({
    casemapping: "rfc1459",
    channels: new Map(
      [...state.channels].map(([name, members]) => [
        name,
        {
          members: new Map(
            [...members].map(([member, prefix]): [string, MemberKnowledge] => [
              member,
              { nick: member, prefixes: prefixesOf(state, prefix, flaws) },
            ])
          ),
          modes: { _tag: "Unknown" },
          name,
          standing: "Joined",
          topic: { _tag: "Unknown" },
        },
      ])
    ),
    self: undefined,
    session: { _tag: "Offline", since: undefined },
    users: new Map(),
  });

const inspect = (state: ToyState): Inspection => ({
  caps: { enabled: new Set(state.enabled.map((name) => CapName.make(name))), offered: new Map() },
  connection: state.connection === 0 ? undefined : ConnectionId.make(state.connection),
  features: [],
  isupport: new Map(),
  policies: new Map(),
  states: { connection: state.phase },
  timers: new Map([...state.timers].map(([id, due]) => [TimerId.make(id), Instant.make(due)])),
});

/**
 * The toy Client: dials on its first Configuration, registers with `CAP LS 302`, asks
 * for `multi-prefix` and `server-time` when offered and not declined, keeps NAMES, sets
 * a registration timer and a keepalive timer derived from its state, and ignores what
 * it cannot use, as the error-mode table says.
 * @param flaws - Laws to break on purpose.
 * @returns The Client.
 */
export const toy = (flaws: Flaws = {}): Client<ToyState> => ({
  initial,
  inspect,
  known: known(flaws),
  step: step(flaws),
});

/** The toy Client with no flaws, for the fresh-process check. */
export const toyClient = toy();

/** A scripted Client, for the fresh-process check. */
export const scriptedClient = scripted([
  {
    outputs: [
      {
        _tag: "Dial",
        connection: ConnectionId.make(1),
        ircd: { host: "irc.test", port: 6697, tls: true },
      },
    ],
    when: "Configured",
  },
  { when: "Opened" },
  { when: "Received" },
]);

// oxlint-disable-next-line no-restricted-properties -- Seeded once per process on purpose, to show the fresh-process check catches it.
const seed = Math.random();

/**
 * A Client that replays exactly within one process but not across two: it numbers its
 * first Connection from a value seeded when its module loads.
 */
export const seededClient: Client<{ readonly dialled: boolean }> = {
  initial: { dialled: false },
  inspect: () => inspect(initial),
  known: () => known({})(initial),
  step: (state, input) =>
    input._tag === "Configured" && !state.dialled
      ? {
          news: [],
          outputs: [
            {
              _tag: "Dial",
              connection: ConnectionId.make(Math.floor(seed * 1e9)),
              ircd: input.configuration.ircds[0],
            },
          ],
          state: { dialled: true },
        }
      : { news: [], outputs: [], state },
};

/**
 * Runs something that should throw, for a test to read what it threw.
 * @param run - What to run.
 * @returns The error's name and message, or `it held` if nothing was thrown.
 */
export const failure = (run: () => void): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  return "it held";
};
