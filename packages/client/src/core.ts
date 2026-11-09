/**
 * The Client: the machines of the statecharts behind `Client<State>`, as plain reducers.
 * `step` routes each input to the Network, the Connection, cap negotiation, Presence, the
 * keepalive, and the Channels, gathers their outputs and News, and derives the `Wake`s
 * from the timers each state waits for.
 *
 * @packageDocumentation
 */
import { defaultCasemapping } from "@iirc/protocol/casemapping";
import { action } from "@iirc/protocol/ctcp";
import {
  encode,
  isRejected,
  notice,
  parse,
  ping,
  privmsg,
  quit,
  rawParams,
} from "@iirc/protocol/line";
import type { Encoding, Line, RawParam, SecretLine } from "@iirc/protocol/line";

import { backoff, lasting } from "./backoff.ts";
import { allWanted, joinWanted, reconcile, rejoin, remap, unfilledKey } from "./channels.ts";
import type { Client, Step } from "./client.ts";
import type { IrcdAddress, NetworkConfiguration } from "./configuration.ts";
import type { Arrival, Refined } from "./feature.ts";
import { ConnectionId, Instant } from "./ids.ts";
import type { TimerId } from "./ids.ts";
import type { Input } from "./input.ts";
import { interpret } from "./lines.ts";
import type { EndReason } from "./news.ts";
import {
  before,
  begin,
  carryOut,
  carryOutRefined,
  expire,
  reconfigured,
  recompute,
  settle,
  unfilled,
} from "./registration.ts";
import type { Registered } from "./registry.ts";
import { registry } from "./registry.ts";
import type { Run } from "./run.ts";
import { folder, hangup, ignore, linkOf, readingOf, send, updateOpen } from "./run.ts";
import { runEffects, runStage } from "./seam.ts";
import type { Link, State } from "./state.ts";
import { initialState } from "./state.ts";
import { addressFor, pruned, rescheduled } from "./sts.ts";
import { lagAfter, silentAfter, tableOf, timersOf, wakes } from "./timers.ts";
import type { Purpose } from "./timers.ts";
import { inspectionOf, knowledgeOf, onNow, openOf, sessionOf } from "./views.ts";

/** The token of the `PING` the Client sends to hear from a quiet Ircd. */
const lagToken = "iirc";

const utf8 = new TextEncoder();

// The Network

// Dials the next Ircd in `ircds`, or, for an upgrade, the same one again, without
// moving on. Either way an STS policy for its host decides the address.
const dial = (run: Run, upgrade?: IrcdAddress): void => {
  const { configuration } = run.state;

  if (configuration === undefined) {
    return;
  }

  const id = run.state.dialled + 1;
  const { ircds } = configuration;
  const next = upgrade ?? ircds[run.state.rotation % ircds.length] ?? ircds[0];
  const ircd = addressFor(run.state, next, run.at);

  run.state = {
    ...run.state,
    dialled: id,
    network: {
      _tag: "Connection",
      link: { closing: undefined, dialled: run.at, id, ircd, phase: { _tag: "Dialing" } },
    },
    rotation: run.state.rotation + (upgrade === undefined ? 1 : 0),
  };
  run.outputs.push({ _tag: "Dial", connection: ConnectionId.make(id), ircd });

  // Each Connection may reach another Ircd, so it starts from the protocol's casemapping
  // until its own ISUPPORT says otherwise.
  if (run.state.casemapping !== defaultCasemapping) {
    remap(run, defaultCasemapping);
  }
};

const disable = (run: Run): void => {
  const { network } = run.state;

  switch (network._tag) {
    case "Unconfigured": {
      run.state = { ...run.state, network: { _tag: "Idle", since: undefined } };
      break;
    }

    case "Waiting": {
      run.state = { ...run.state, network: { _tag: "Idle", since: network.since } };
      break;
    }

    case "Connection": {
      if (network.link.closing === undefined && network.link.phase._tag === "Open") {
        send(run, quit(), "QUIT");
      }

      hangup(run, { _tag: "Disabled" });
      break;
    }

    case "Idle": {
      break;
    }

    default: {
      network satisfies never;
    }
  }
};

const configure = (run: Run, configuration: NetworkConfiguration): void => {
  const was = before(run);
  const { network } = run.state;

  run.state = { ...run.state, configuration };

  // A login it now requires must happen, or the Connection is given up before anything
  // else is sent.
  reconfigured(run);

  // Disabling hangs up first, so nothing this Configuration also asks for is sent after
  // the `QUIT`.
  if (!configuration.enabled) {
    disable(run);
  }

  reconcile(run, configuration.channels);

  if (configuration.enabled && (network._tag === "Unconfigured" || network._tag === "Idle")) {
    dial(run);
  }

  recompute(run, was);
  settle(run);
  joinWanted(run);
};

// A Connection is over: report how, return every Channel to Wanted, and wait to redial.
// A Session that lasted starts the backoff again from its first wait. The expiry of an
// STS policy for its host moves to now plus its last `duration`.
const ended = (run: Run, link: Link, reason: EndReason): void => {
  const { phase } = link;

  run.state = rescheduled(run.state, link, run.at);

  const session =
    phase._tag === "Open" && phase.presence._tag === "Session" ? phase.presence : undefined;

  run.news.push(
    session === undefined
      ? { _tag: "ConnectionFailed", at: run.at, reason }
      : { _tag: "SessionEnded", at: run.at, reason }
  );

  const lasted = session !== undefined && run.at - session.began >= lasting;
  const attempt = lasted ? 0 : run.state.attempt;
  const { configuration } = run.state;

  run.state = allWanted(run.state);

  if (configuration?.enabled !== true) {
    run.state = { ...run.state, attempt, network: { _tag: "Idle", since: run.at } };

    return;
  }

  // Hung up because it was disabled, and enabled again since: dial at once, as a
  // `Configured` would have. After a restart, the same.
  if (reason._tag === "Disabled" || reason._tag === "Restarted") {
    run.state = { ...run.state, attempt };
    dial(run);

    return;
  }

  // An upgrade dials the same host over TLS on the port the Ircd gave, at once.
  if (reason._tag === "Upgrading") {
    run.state = { ...run.state, attempt };
    dial(run, { host: link.ircd.host, port: reason.port, tls: true });

    return;
  }

  run.state = {
    ...run.state,
    attempt: attempt + 1,
    network: { _tag: "Waiting", since: run.at, until: Instant.make(run.at + backoff(attempt)) },
  };
};

const started = (run: Run): void => {
  const link = linkOf(run);

  if (link !== undefined) {
    ended(run, link, { _tag: "Restarted" });
  } else if (run.state.network._tag === "Waiting") {
    dial(run);
  }
};

const closed = (run: Run, link: Link, reason: Input & { readonly _tag: "Closed" }): void => {
  const error = link.phase._tag === "Open" && link.phase.error;

  ended(
    run,
    link,
    link.closing ?? (error ? { _tag: "Error" } : { _tag: "Closed", reason: reason.reason })
  );
};

// Receiving

const encodingOf = (run: Run): Encoding => {
  const own = onNow(run.registry, run.state).find((feature) => feature.encoding !== undefined);

  return (
    own?.encoding ?? {
      _tag: "Utf8OrElse",
      fallback: run.state.configuration?.fallbackEncoding ?? "windows-1252",
    }
  );
};

// Anything heard keeps the Connection alive. It changes only State: the keepalive's one
// timer checks `heard` when it fires, so no `Wake` is written per Line.
const hear = (run: Run): void => {
  updateOpen(run, (open) =>
    open.presence._tag === "Session"
      ? {
          ...open,
          presence: {
            ...open.presence,
            keepalive: { ...open.presence.keepalive, heard: run.at, pinged: false },
          },
        }
      : open
  );
};

const arrivalOf = (run: Run, line: Line): Arrival => ({
  answers: undefined,
  batch: undefined,
  id: { _tag: "Unknown" },
  label: undefined,
  line,
  live: true,
  time: { _tag: "Known", at: run.at, from: "receipt", value: run.at },
});

type Hook<V> = (
  feature: Registered,
  value: V,
  context: Parameters<NonNullable<Registered["start"]>>[0]
) => Refined<V, unknown> | undefined;

// Runs one ingress stage over the Features on now that have its hook. Ingress stages
// refine: what they return and their own state are kept, and nothing else they say.
const stage = <V>(run: Run, value: V, has: (feature: Registered) => boolean, hook: Hook<V>): V => {
  const features = onNow(run.registry, run.state).filter(has);
  const seam = openOf(run.state)?.seam;
  const reading = features.length === 0 ? undefined : readingOf(run);

  if (seam === undefined || reading === undefined) {
    return value;
  }

  const ran = runStage(features, seam, reading, value, hook);

  carryOutRefined(run, ran);

  return ran.value;
};

// `batch` maps each Arrival to none, one, or several, threading the Feature's own state.
const batchAll = (
  batch: NonNullable<Registered["batch"]>,
  arrivals: readonly Arrival[],
  context: Parameters<NonNullable<Registered["batch"]>>[1]
): Refined<readonly Arrival[], unknown> => {
  let { own } = context;
  const value: Arrival[] = [];

  for (const arrival of arrivals) {
    const refined = batch(arrival, { ...context, own });

    value.push(...refined.value);
    own = "own" in refined ? refined.own : own;
  }

  return { own, value };
};

const batching: Hook<readonly Arrival[]> = (feature, arrivals, context) =>
  feature.batch === undefined ? undefined : batchAll(feature.batch, arrivals, context);

// Features act on what arrived, once history is told apart, and only on what is live.
const react = (run: Run, arrival: Arrival): void => {
  const features = onNow(run.registry, run.state).filter((feature) => feature.react !== undefined);
  const seam = openOf(run.state)?.seam;
  const reading = features.length === 0 || !arrival.live ? undefined : readingOf(run);

  if (seam !== undefined && reading !== undefined) {
    carryOut(
      run,
      runEffects(features, seam, reading, (feature, context) => feature.react?.(arrival, context))
    );
  }
};

const ingress = (run: Run, line: Line, raw: readonly RawParam[]): void => {
  const tagged = stage(
    run,
    arrivalOf(run, line),
    (feature) => feature.tags !== undefined,
    (feature, arrival, context) => feature.tags?.(arrival, context)
  );

  const released = stage<readonly Arrival[]>(
    run,
    [tagged],
    (feature) => feature.batch !== undefined,
    batching
  );

  for (const arrival of released) {
    const labelled = stage(
      run,
      arrival,
      (feature) => feature.label !== undefined,
      (feature, value, context) => feature.label?.(value, context)
    );

    react(run, labelled);
    interpret(run, labelled, labelled.line === line ? raw : undefined);
  }
};

const received = (run: Run, link: Link, bytes: Uint8Array): void => {
  if (link.phase._tag !== "Open") {
    ignore(run, { _tag: "NotNow", input: "Received" });

    return;
  }

  hear(run);

  const parsed = parse(bytes, encodingOf(run));

  if (parsed._tag === "Unparseable") {
    ignore(run, { _tag: "Unparseable", reason: parsed.reason });

    return;
  }

  const was = before(run);

  ingress(run, parsed.line, rawParams(bytes));
  recompute(run, was);
  settle(run);
};

// The Owner

// The room an Ircd takes for our source when it relays what we say: `:nick!user@host `,
// guessing a username of 10 bytes and a host of 63 until Self's mask is known.
const relayed = (run: Run): number => {
  const session = sessionOf(run.state);
  const mask = session?.mask._tag === "Known" ? session.mask.value : undefined;
  const nick = utf8.encode(session?.nick ?? "").length;

  return mask === undefined ? nick + 76 : 4 + nick + utf8.encode(`${mask.user}${mask.host}`).length;
};

const say = (run: Run, input: Input & { readonly _tag: "Say" }): void => {
  const session = sessionOf(run.state);

  if (session === undefined || linkOf(run)?.closing !== undefined) {
    run.news.push({ _tag: "Refused", intent: input.intent, reason: { _tag: "Offline" } });

    return;
  }

  const builder = input.kind === "Notice" ? notice : privmsg;

  const line =
    input.kind === "Action" ? action(input.target, input.text) : builder(input.target, input.text);

  const bytes = isRejected(line) ? line : encode(line);

  // A Line that would be cut short when the Ircd relays it is not sent.
  if (isRejected(line) || isRejected(bytes) || bytes.length + relayed(run) > 512) {
    run.news.push({ _tag: "Refused", intent: input.intent, reason: { _tag: "Unsendable" } });

    return;
  }

  const sent = send(run, line, line.command, { _tag: "Said", intent: input.intent });

  // A Feature refused it at egress, and `send` reported it.
  if (sent === undefined) {
    return;
  }

  run.news.push({
    _tag: "Message",
    at: { _tag: "Known", at: run.at, from: "ours", value: run.at },
    id: { _tag: "Unknown" },
    kind: input.kind,
    live: true,
    ours: { echo: sent.echo, intent: input.intent },
    sender: session.nick,
    tags: new Map(),
    target: input.target,
    text: input.text,
  });
};

// Timers

// The keepalive's one timer: after 60 s of silence, a lag `PING`; after 90 s, give up.
const keepalive = (run: Run): void => {
  const session = sessionOf(run.state);

  if (session === undefined) {
    return;
  }

  const { heard, pinged } = session.keepalive;

  if (run.at >= heard + silentAfter) {
    hangup(run, { _tag: "Silent" });

    return;
  }

  const pinging = !pinged && run.at >= heard + lagAfter;

  if (pinging) {
    send(run, ping(lagToken), "PING");
  }

  const nowPinged = pinged || pinging;

  updateOpen(run, (open) =>
    open.presence._tag === "Session"
      ? {
          ...open,
          presence: {
            ...open.presence,
            keepalive: {
              check: Instant.make(heard + (nowPinged ? silentAfter : lagAfter)),
              heard,
              pinged: nowPinged,
            },
          },
        }
      : open
  );
};

const fire = (run: Run, purpose: Purpose): void => {
  switch (purpose._tag) {
    case "Redial": {
      dial(run);
      break;
    }

    case "Register": {
      hangup(run, { _tag: "Silent" });
      break;
    }

    case "Hold": {
      expire(run);
      break;
    }

    case "Keepalive": {
      keepalive(run);
      break;
    }

    case "Rejoin": {
      rejoin(run, purpose.channel);
      break;
    }

    default: {
      purpose satisfies never;
    }
  }
};

// A timer that is due, if it is still set as the State wants it. It is consumed.
const fired = (run: Run, input: Input & { readonly _tag: "Fired" }): void => {
  const timer = timersOf(run.state).get(input.timer);

  if (timer?.due === input.due) {
    const was = before(run);

    fire(run, timer.purpose);
    recompute(run, was);
    settle(run);
  } else {
    ignore(run, { _tag: "StaleTimer", timer: input.timer });
  }
};

// The timer a `Fired` consumes, when it matches the table the State before it wants.
const consumedBy = (state: State, input: Input): TimerId | undefined =>
  input._tag === "Fired" && timersOf(state).get(input.timer)?.due === input.due
    ? input.timer
    : undefined;

// The Transport

// A `SecretLine` a holding Feature sent could not be filled. With none to hear it, it
// changes nothing.
const unfilledHeld = (run: Run, line: SecretLine): void => {
  const was = before(run);

  if (!unfilled(run, line)) {
    ignore(run, { _tag: "NotNow", input: "Unfilled" });

    return;
  }

  recompute(run, was);
  settle(run);
};

// Inputs from the Transport name their Connection: one from another is stale.
const current = (run: Run, connection: ConnectionId): Link | undefined => {
  const link = linkOf(run);

  if (link?.id !== connection) {
    ignore(run, { _tag: "StaleConnection", connection });
  }

  return link?.id === connection ? link : undefined;
};

type FromTransport = Extract<
  Input,
  { readonly _tag: "Opened" | "Received" | "Closed" | "Unfilled" }
>;

const transport = (run: Run, input: FromTransport): void => {
  const link = current(run, input.connection);

  if (link === undefined) {
    return;
  }

  switch (input._tag) {
    case "Opened": {
      if (link.phase._tag === "Dialing" && link.closing === undefined) {
        begin(run);
      } else {
        ignore(run, { _tag: "NotNow", input: "Opened" });
      }

      break;
    }

    case "Received": {
      received(run, link, input.bytes);
      break;
    }

    case "Closed": {
      closed(run, link, input);
      break;
    }

    // A Channel whose key could not be filled is refused for now. Registration goes on
    // without `PASS`, and the Ircd decides. A Feature holding registration hears of a
    // Line it sent, such as SASL's.
    case "Unfilled": {
      if (input.line._tag === "JoinWithKey") {
        unfilledKey(run, input.line.channel);
      } else if (input.line._tag === "AuthenticatePlain") {
        unfilledHeld(run, input.line);
      }

      break;
    }

    default: {
      input satisfies never;
    }
  }
};

const dispatch = (run: Run, input: Input): void => {
  if (input._tag !== "Configured" && run.state.configuration === undefined) {
    ignore(run, { _tag: "NotNow", input: input._tag });

    return;
  }

  switch (input._tag) {
    case "Configured": {
      configure(run, input.configuration);
      break;
    }

    case "Started": {
      started(run);
      break;
    }

    case "Retry": {
      if (run.state.network._tag === "Waiting") {
        dial(run);
      } else {
        ignore(run, { _tag: "NotNow", input: "Retry" });
      }

      break;
    }

    case "Say": {
      say(run, input);
      break;
    }

    case "Fired": {
      fired(run, input);
      break;
    }

    case "Opened":
    case "Received":
    case "Closed":
    case "Unfilled": {
      transport(run, input);
      break;
    }

    default: {
      input satisfies never;
    }
  }
};

/**
 * Builds a Client over a registry of Features. The real Client is {@link client}. A test
 * may build one over Features of its own, to drive the seam through `step`.
 * @param features - The Features, in the order their hooks run.
 * @returns The Client.
 */
export const makeClient = (features: readonly Registered[]): Client<State> => ({
  initial: initialState,
  inspect: (state) => inspectionOf(features, state),
  known: (state) => knowledgeOf(state, folder(state)),
  step: (state, input): Step<State> => {
    const run: Run = {
      at: input.at,
      before: state,
      known: undefined,
      news: [],
      outputs: [],
      registry: features,
      state,
    };

    dispatch(run, input);
    run.state = pruned(run.state, run.at);

    return {
      news: run.news,
      outputs: [
        ...run.outputs,
        ...wakes(tableOf(state), tableOf(run.state), consumedBy(state, input)),
      ],
      state: run.state,
    };
  },
});

/** The Client, over the registry of Features. */
export const client: Client<State> = makeClient(registry);
