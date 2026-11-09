/**
 * Registration and cap negotiation: `CAP LS 302`, `PASS`, `NICK`, and `USER`; nicks
 * offered until one is taken; caps requested for the Features in the registry; Features
 * turning on and off, and holding registration open before `CAP END`.
 *
 * @packageDocumentation
 */
import { limitOf } from "@iirc/protocol/isupport";
import { cap, isRejected, nick, quit, upperCaseAscii, user } from "@iirc/protocol/line";
import type { Line, SecretLine } from "@iirc/protocol/line";

import type { Registration } from "./feature.ts";
import type { CapName, FeatureName } from "./ids.ts";
import { CapName as CapNameSchema, Instant } from "./ids.ts";
import type { EndReason } from "./news.ts";
import type { Registered } from "./registry.ts";
import type { Run } from "./run.ts";
import {
  hangup,
  ignore,
  linkOf,
  readingOf,
  reportFailed,
  send,
  sendAll,
  sendSecret,
  updateOpen,
} from "./run.ts";
import type { Ran } from "./seam.ts";
import { capsOf, capsWanted, freshSeam, goneStale, runEffects } from "./seam.ts";
import { markStale } from "./stale.ts";
import type { Asking, Caps, Negotiated, Open } from "./state.ts";
import { holdTime, registrationTime } from "./timers.ts";
import { negotiated, onNow, openOf } from "./views.ts";

/** The most caps kept from what an Ircd offers. */
const maxCaps = 256;

/** How many offers past the configured nicks are tried before giving up on one name. */
const maxTries = 16;

const characters = (text: string): readonly string[] => {
  const all: string[] = [];

  for (const character of text) {
    all.push(character);
  }

  return all;
};

/** RFC 2812's longest nick, assumed until the Ircd announces `NICKLEN`. */
const rfcNickLength = 9;

/**
 * The longest nick the Ircd takes: `NICKLEN` once announced, else RFC 2812's 9.
 * @param run - The step.
 * @returns The length, in characters.
 */
const nickLength = (run: Run): number =>
  limitOf(openOf(run.state)?.isupport.get("NICKLEN")) ?? rfcNickLength;

// A nick cannot start with a digit, `-`, or other ASCII punctuation but `[]\\`^_{|}`.
const badNickStart = /^[\u0021-\u0040~]/u;

/**
 * The nick offered at an index: the configured nicks in order, as the Owner wrote them,
 * then fallbacks made from the first: `_` added, then `2`, `3`, and so on, each cut to
 * leave room for its suffix within the longest nick the Ircd takes. A fallback that
 * cannot keep at least one character of the first nick, or would not start as a nick
 * may, is not made, and since suffixes only grow, neither is any after it.
 * @param nicks - The configured nicks.
 * @param index - Which offer, from 0.
 * @param length - The longest nick the Ircd takes.
 * @returns The nick, or `undefined` when there are no more to offer.
 */
const offerAt = (
  nicks: readonly [string, ...string[]],
  index: number,
  length: number
): string | undefined => {
  if (index < nicks.length) {
    return nicks[index] ?? nicks[0];
  }

  const fallback = index - nicks.length + 1;
  const suffix = fallback === 1 ? "_" : String(fallback);
  const room = length - suffix.length;
  const base = characters(nicks[0]).slice(0, room).join("");

  return room < 1 || base === "" || badNickStart.test(base) ? undefined : `${base}${suffix}`;
};

/**
 * Offers the first nick at or after an index that can be sent, and records it.
 * @param run - The step.
 * @param from - The index to start from.
 */
const offerNick = (run: Run, from: number): void => {
  const nicks = run.state.configuration?.nicks;

  if (nicks === undefined) {
    return;
  }

  for (let index = from; index < from + nicks.length + maxTries; index += 1) {
    const offer = offerAt(nicks, index, nickLength(run));

    // No nick left that fits: offer none, and the registration deadline ends the
    // Connection.
    if (offer === undefined) {
      return;
    }

    const line = nick(offer);

    if (!isRejected(line)) {
      send(run, line, "NICK");
      updateOpen(run, (open) =>
        open.presence._tag === "Registering"
          ? { ...open, presence: { ...open.presence, offer: index } }
          : open
      );

      return;
    }
  }
};

/**
 * A Connection opened: begin registration. The Client asks for caps first, and sends
 * `PASS`, `NICK`, and `USER` at once, so an Ircd with no cap negotiation registers us
 * all the same.
 * @param run - The step.
 */
export const begin = (run: Run): void => {
  const link = linkOf(run);
  const { configuration } = run.state;

  if (link === undefined || configuration === undefined) {
    return;
  }

  const open: Open = {
    _tag: "Open",
    caps: { _tag: "Listing", offered: new Map() },
    error: false,
    isupport: new Map(),
    opened: run.at,
    presence: {
      _tag: "Registering",
      account: { _tag: "Unknown" },
      deadline: Instant.make(run.at + registrationTime),
      hold: undefined,
      offer: 0,
    },
    seam: freshSeam,
    users: new Map(),
  };

  run.state = { ...run.state, network: { _tag: "Connection", link: { ...link, phase: open } } };
  send(run, cap("LS", "302"), "CAP");

  if (configuration.password !== undefined) {
    sendSecret(run, { _tag: "Pass", credential: configuration.password });
  }

  offerNick(run, 0);
  send(run, user(configuration.username, configuration.realname), "USER");
};

/**
 * The Ircd refused the nick on offer before `001`: offer the next.
 * @param run - The step.
 */
export const nickRefused = (run: Run): void => {
  const presence = openOf(run.state)?.presence;

  if (presence?._tag === "Registering") {
    offerNick(run, presence.offer + 1);
  }
};

/**
 * The nick on offer now.
 * @param run - The step.
 * @returns It, while registering.
 */
export const offered = (run: Run): string | undefined => {
  const presence = openOf(run.state)?.presence;
  const nicks = run.state.configuration?.nicks;

  return presence?._tag === "Registering" && nicks !== undefined
    ? offerAt(nicks, presence.offer, nickLength(run))
    : undefined;
};

/**
 * Gives up the Connection, as a Feature asked: `QUIT`, then `Hangup`.
 * @param run - The step.
 * @param reason - Why, as `Closed` will report it.
 */
const abandon = (run: Run, reason: EndReason): void => {
  if (linkOf(run)?.closing === undefined) {
    send(run, quit(), "QUIT");
  }

  hangup(run, reason);
};

const setCaps = (run: Run, caps: Caps): void => {
  updateOpen(run, (open) => ({ ...open, caps }));
};

const applyRegistration = (
  run: Run,
  decisions: readonly (readonly [FeatureName, Registration])[]
): void => {
  for (const [feature, decision] of decisions) {
    if (decision._tag === "Abandon") {
      abandon(run, decision.reason);

      return;
    }

    updateOpen(run, (open) => {
      const holding = new Set(open.seam.holding);

      if (decision._tag === "Hold") {
        holding.add(feature);
      } else {
        holding.delete(feature);
      }

      return { ...open, seam: { ...open.seam, holding } };
    });
  }
};

/** What some `CAP REQ` Lines asked for. */
interface Asked {
  readonly lines: number;
  readonly names: readonly string[];
}

/** The most Lines one answer may spread over before the Client stops reading it. */
const maxContinued = 16;

/**
 * Requests awaiting answers, with more asked.
 * @param before - What was awaited, if anything.
 * @param asked - What was just asked.
 * @returns What is awaited now.
 */
const askingWith = (before: Asking | undefined, asked: Asked): Asking => ({
  acked: before?.acked ?? new Set(),
  asked: (before?.asked ?? 0) + asked.lines,
  continued: before?.continued ?? 0,
  requested: new Set([...(before?.requested ?? []), ...asked.names]),
});

// Caps share `CAP REQ` Lines, as many to a Line as fit. Gives what was sent.
const requestLines = (run: Run, wanted: readonly string[]): Asked => {
  const lines: string[][] = [];

  for (const name of wanted) {
    const last = lines.at(-1);

    if (last !== undefined && !isRejected(cap("REQ", [...last, name].join(" ")))) {
      last.push(name);
    } else {
      lines.push([name]);
    }
  }

  const sent = lines.filter((names) => send(run, cap("REQ", names.join(" ")), "CAP") !== undefined);

  return { lines: sent.length, names: sent.flat() };
};

/**
 * Gives up caps with `CAP REQ :-cap`, for each still enabled, and awaits the answers as
 * for any request.
 * @param run - The step.
 * @param names - The caps.
 */
const dropCaps = (run: Run, names: readonly CapName[]): void => {
  const caps = openOf(run.state)?.caps;

  if (caps === undefined || caps._tag === "Listing" || caps._tag === "None") {
    return;
  }

  const enabled = [...new Set(names)].filter((name) => caps.enabled.has(name));

  const sent =
    enabled.length === 0
      ? { lines: 0, names: [] }
      : requestLines(
          run,
          enabled.map((name) => `-${name}`)
        );

  if (sent.lines === 0) {
    return;
  }

  const held: Negotiated = { enabled: caps.enabled, offered: caps.offered };

  switch (caps._tag) {
    case "Requesting":
    case "Changing": {
      setCaps(run, { ...caps, ...askingWith(caps, sent) });
      break;
    }

    case "Holding": {
      setCaps(run, { ...held, ...askingWith(undefined, sent), _tag: "Requesting" });
      break;
    }

    case "Steady": {
      setCaps(run, { ...held, ...askingWith(undefined, sent), _tag: "Changing" });
      break;
    }

    default: {
      caps satisfies never;
    }
  }
};

/**
 * Carries out what Feature hooks said: their Lines, their say over registration, and
 * any that threw.
 * @param run - The step.
 * @param ran - What the hooks returned.
 */
export const carryOut = <V>(run: Run, ran: Ran<V>): void => {
  updateOpen(run, (open) => ({ ...open, seam: ran.seam }));
  reportFailed(run, ran.failed);
  sendAll(run, ran.send);
  dropCaps(run, ran.drop);
  applyRegistration(run, ran.registration);
};

/**
 * Carries out what refining hooks said: their own state, and any that threw. Lines they
 * asked to send, their say over registration, and caps they asked to drop are discarded:
 * only `react` and the hooks that are not about an Arrival act.
 * @param run - The step.
 * @param ran - What the hooks returned.
 */
export const carryOutRefined = <V>(run: Run, ran: Ran<V>): void => {
  carryOut(run, { ...ran, drop: [], registration: [], send: [] });
};

/** What decides a recompute: the Features on, and the caps enabled. */
export interface Before {
  readonly on: readonly Registered[];
  readonly enabled: ReadonlySet<CapName>;
}

/**
 * The Features on and the caps enabled now, to recompute against after a change.
 * @param run - The step.
 * @returns Them.
 */
export const before = (run: Run): Before => ({
  enabled: negotiated(openOf(run.state)?.caps).enabled,
  on: onNow(run.registry, run.state),
});

// Runs one hook over some Features, and carries out what they said.
const runHook = (
  run: Run,
  features: readonly Registered[],
  hook: Parameters<typeof runEffects>[3]
): void => {
  const reading = readingOf(run);
  const open = openOf(run.state);

  if (features.length > 0 && reading !== undefined && open !== undefined) {
    carryOut(run, runEffects(features, open.seam, reading, hook));
  }
};

const letGo: Registration = { _tag: "Continue" };

// Features holding registration decide, with `expired`, whether to go on or give up.
// Those that are off, or whose `expired` threw, hold nothing after.
const expireHolding = (run: Run, features: readonly Registered[]): void => {
  const holding = openOf(run.state)?.seam.holding;
  const held = features.filter((feature) => holding?.has(feature.name) === true);
  const on = onNow(run.registry, run.state);

  runHook(run, held, (feature, context) => feature.expired?.(context) ?? { registration: letGo });

  updateOpen(run, (open) => ({
    ...open,
    seam: {
      ...open.seam,
      holding: new Set(
        [...open.seam.holding].filter(
          (name) => !open.seam.failed.has(name) && on.some((each) => each.name === name)
        )
      ),
    },
  }));
};

/**
 * Each Feature that is off hears, through `absent`, that negotiation settled without it.
 * @param run - The step.
 */
const absentOff = (run: Run): void => {
  const on = onNow(run.registry, run.state);

  runHook(
    run,
    run.registry.filter((feature) => !on.includes(feature)),
    (feature, context) => feature.absent?.(context)
  );
};

/**
 * Works out again which Features are on, after caps, ISUPPORT, or the Owner's choices
 * changed. A Feature that turns off and was holding registration decides with `expired`
 * whether to go on, the facts only it kept go stale, and it hears `absent`. One that
 * turns on, or is on while a cap it uses comes or goes, runs `start`. Each keeps its own
 * state for the rest of the Connection, whether on or off.
 * @param run - The step.
 * @param was - What was on and enabled before the change.
 */
export const recompute = (run: Run, was: Before): void => {
  const now = onNow(run.registry, run.state);
  const { enabled } = negotiated(openOf(run.state)?.caps);
  const stopped = was.on.filter((feature) => !now.includes(feature));

  const started = now.filter(
    (feature) =>
      !was.on.includes(feature) ||
      (feature.uses ?? []).some((name) => was.enabled.has(name) !== enabled.has(name))
  );

  if (started.length === 0 && stopped.length === 0) {
    return;
  }

  expireHolding(run, stopped);
  markStale(run, goneStale(was.on, now));
  runHook(run, stopped, (feature, context) => feature.absent?.(context));
  runHook(run, started, (feature, context) => feature.start?.(context));
};

// Whether negotiation is waiting for nothing more.
const isDone = (caps: Caps): caps is Extract<Caps, { readonly enabled: ReadonlySet<CapName> }> =>
  ((caps._tag === "Requesting" || caps._tag === "Changing") && caps.asked <= 0) ||
  caps._tag === "Holding";

/**
 * Ends negotiation once nothing more is awaited: `CAP END` while registering, unless a
 * Feature holds registration open, in which case the hold's deadline is set. Features
 * that are off hear `absent` first, and may give up the Connection, or give up caps,
 * which is more to await.
 * @param run - The step.
 */
export const settle = (run: Run): void => {
  const open = openOf(run.state);

  if (open === undefined || linkOf(run)?.closing !== undefined || !isDone(open.caps)) {
    return;
  }

  const { caps, presence, seam } = open;
  const held: Negotiated = { enabled: caps.enabled, offered: caps.offered };

  if (presence._tag !== "Registering") {
    setCaps(run, { ...held, _tag: "Steady" });
    absentOff(run);

    return;
  }

  if (seam.holding.size > 0) {
    setCaps(run, { ...held, _tag: "Holding" });
    updateOpen(run, (phase) =>
      phase.presence._tag === "Registering" && phase.presence.hold === undefined
        ? {
            ...phase,
            presence: { ...phase.presence, hold: Instant.make(run.at + holdTime) },
          }
        : phase
    );

    return;
  }

  absentOff(run);

  const after = openOf(run.state);

  if (after === undefined || linkOf(run)?.closing !== undefined || !isDone(after.caps)) {
    return;
  }

  setCaps(run, { _tag: "Steady", enabled: after.caps.enabled, offered: after.caps.offered });
  updateOpen(run, (phase) =>
    phase.presence._tag === "Registering"
      ? { ...phase, presence: { ...phase.presence, hold: undefined } }
      : phase
  );
  send(run, cap("END"), "CAP");
};

/**
 * The hold's deadline passed: each holding Feature's `expired` says whether to go on or
 * give up. One with no `expired` lets registration go.
 * @param run - The step.
 */
export const expire = (run: Run): void => {
  updateOpen(run, (phase) =>
    phase.presence._tag === "Registering"
      ? { ...phase, presence: { ...phase.presence, hold: undefined } }
      : phase
  );
  expireHolding(run, onNow(run.registry, run.state));
};

/**
 * A `SecretLine` could not be filled: each Feature holding registration that has an
 * `unfilled` hook decides what follows.
 * @param run - The step.
 * @param line - The Line that was not sent.
 * @returns Whether any Feature heard it.
 */
export const unfilled = (run: Run, line: SecretLine): boolean => {
  const open = openOf(run.state);
  const reading = readingOf(run);

  if (open === undefined || reading === undefined) {
    return false;
  }

  const hearing = onNow(run.registry, run.state).filter(
    (feature) => feature.unfilled !== undefined && open.seam.holding.has(feature.name)
  );

  if (hearing.length === 0) {
    return false;
  }

  carryOut(
    run,
    runEffects(hearing, open.seam, reading, (feature, context) => feature.unfilled?.(line, context))
  );

  return true;
};

const capList = (text: string): readonly (readonly [CapName, string])[] =>
  text
    .split(" ")
    .filter((word) => word !== "")
    .map((word) => {
      const at = word.indexOf("=");

      return at === -1
        ? [CapNameSchema.make(word), ""]
        : [CapNameSchema.make(word.slice(0, at)), word.slice(at + 1)];
    });

// The caps worth asking for now. Given caps just offered, only those of the Features
// that need one of them, so nothing refused before is asked for again.
const wantedNow = (run: Run, held: Negotiated, only?: ReadonlySet<CapName>): readonly CapName[] =>
  capsWanted(
    only === undefined
      ? run.registry
      : run.registry.filter((feature) => capsOf(feature).some((name) => only.has(name))),
    { ...held, isupport: openOf(run.state)?.isupport ?? new Map() },
    run.state.configuration?.declined ?? []
  );

const request = (
  run: Run,
  held: Negotiated,
  after: "Requesting" | "Changing",
  only?: ReadonlySet<CapName>
): void => {
  const sent = requestLines(run, wantedNow(run, held, only));

  if (sent.lines === 0 && after === "Changing") {
    setCaps(run, { ...held, _tag: "Steady" });

    return;
  }

  // With nothing to ask for, `Requesting` is already answered, and `settle` ends it.
  setCaps(run, { ...held, ...askingWith(undefined, sent), _tag: after });
};

// An `ACK` or `NAK` for one `REQ`. Only what was asked counts: a cap not asked for, or
// one said again, is ignored. An `ACK` spread over several Lines, all but the last
// marked with `*`, changes nothing until its last, and counts as one answer. One spread
// over more than `maxContinued` Lines is taken as a refusal, and reported.
const answered = (
  run: Run,
  caps: Extract<Caps, { readonly asked: number }>,
  list: readonly (readonly [CapName, string])[],
  ack: boolean,
  more: boolean
): void => {
  const names = list.flatMap(([name]) => (caps.requested.has(name) ? [name] : []));
  const continued = more ? caps.continued + 1 : 0;
  const endless = continued > maxContinued;

  if (more && !endless) {
    setCaps(run, {
      ...caps,
      acked: ack ? new Set([...caps.acked, ...names]) : caps.acked,
      continued,
    });

    return;
  }

  if (endless) {
    ignore(run, { _tag: "Endless", command: "CAP" });
  }

  const enabled = new Set(caps.enabled);

  if (ack && !endless) {
    for (const name of new Set([...caps.acked, ...names])) {
      if (name.startsWith("-")) {
        enabled.delete(CapNameSchema.make(name.slice(1)));
      } else {
        enabled.add(CapNameSchema.make(name));
      }
    }
  }

  const asked = caps.asked - 1;

  setCaps(run, {
    ...caps,
    acked: new Set(),
    asked,
    continued: 0,
    enabled,
    requested: asked <= 0 ? new Set() : caps.requested,
  });
};

const withOffered = (
  offered: ReadonlyMap<CapName, string>,
  list: readonly (readonly [CapName, string])[]
): ReadonlyMap<CapName, string> => {
  const next = new Map(offered);

  for (const [name, value] of list) {
    if (next.has(name) || next.size < maxCaps) {
      next.set(name, value);
    }
  }

  return next;
};

type CapList = readonly (readonly [CapName, string])[];

/** One `CAP` subcommand's step, which says whether it made sense in this state. */
type CapStep = (run: Run, caps: Caps, list: CapList, more: boolean) => boolean;

// `LS`, over as many Lines as the Ircd needs: then ask for what the Features want.
const listing: CapStep = (run, caps, list, more) => {
  if (caps._tag !== "Listing") {
    return false;
  }

  const listed = withOffered(caps.offered, list);

  if (more) {
    setCaps(run, { _tag: "Listing", offered: listed });
  } else {
    request(run, { enabled: new Set(), offered: listed }, "Requesting");
  }

  return true;
};

const answering =
  (ack: boolean): CapStep =>
  (run, caps, list, more) => {
    if (caps._tag !== "Requesting" && caps._tag !== "Changing") {
      return false;
    }

    answered(run, caps, list, ack, more);

    return true;
  };

// `NEW`: more is offered, and the Client asks for what it wants of it at once, whether
// negotiation is over or not. What it asked for before is not asked for again.
const added: CapStep = (run, caps, list) => {
  if (caps._tag === "Listing" || caps._tag === "None") {
    return false;
  }

  const held = { enabled: caps.enabled, offered: withOffered(caps.offered, list) };
  const listed = new Set(list.map(([name]) => name));

  if (caps._tag === "Steady") {
    request(run, held, "Changing", listed);

    return true;
  }

  const sent = requestLines(run, wantedNow(run, held, listed));

  if (caps._tag !== "Holding") {
    setCaps(run, { ...caps, ...held, ...askingWith(caps, sent) });
  } else if (sent.lines === 0) {
    setCaps(run, { ...caps, ...held });
  } else {
    // While Features hold registration, nothing is awaited: now the new request is.
    setCaps(run, { ...held, ...askingWith(undefined, sent), _tag: "Requesting" });
  }

  return true;
};

// `DEL`: no longer offered, and no longer enabled.
const deleted: CapStep = (run, caps, list) => {
  if (caps._tag === "Listing" || caps._tag === "None") {
    return false;
  }

  const gone = new Set(list.map(([name]) => name));

  setCaps(run, {
    ...caps,
    enabled: new Set([...caps.enabled].filter((name) => !gone.has(name))),
    offered: new Map([...caps.offered].filter(([name]) => !gone.has(name))),
  });

  return true;
};

const capSteps: ReadonlyMap<string, CapStep> = new Map([
  ["LS", listing],
  ["ACK", answering(true)],
  ["NAK", answering(false)],
  ["NEW", added],
  ["DEL", deleted],
]);

/**
 * Reads a `CAP` Line by its structure: `CAP <nick> <subcommand> [*] :<caps>`, and moves
 * cap negotiation on.
 * @param run - The step.
 * @param line - The Line.
 */
export const capLine = (run: Run, line: Line): void => {
  const open = openOf(run.state);
  const [, subcommand, third, fourth] = line.params;

  if (open === undefined) {
    return;
  }

  if (subcommand === undefined || third === undefined) {
    ignore(run, { _tag: "Malformed", command: "CAP" });

    return;
  }

  const more = third === "*" && fourth !== undefined;
  const list = capList(more ? fourth : (line.params.at(-1) ?? ""));
  const step = capSteps.get(upperCaseAscii(subcommand));

  if (step?.(run, open.caps, list, more) !== true) {
    ignore(run, { _tag: "NotNow", input: "Received" });
  }
};

/**
 * The Ircd answered `CAP` with `421`: it has no cap negotiation, and registration goes on
 * with `NICK` and `USER`.
 * @param run - The step.
 * @param line - The `421`.
 */
export const unknownCommand = (run: Run, line: Line): void => {
  const open = openOf(run.state);

  if (open?.caps._tag === "Listing" && upperCaseAscii(line.params[1] ?? "") === "CAP") {
    setCaps(run, { _tag: "None" });
    absentOff(run);
  }
};

/**
 * `001` ended negotiation, whether or not it was over: what was listed and never
 * answered is no cap negotiation, and an outstanding `REQ` is answered later. It ends any
 * hold, so each holding Feature decides with `expired` whether to go on, and each Feature
 * that is off hears `absent`. Either may give up the Connection.
 * @param run - The step.
 */
export const welcomed = (run: Run): void => {
  const caps = openOf(run.state)?.caps;

  switch (caps?._tag) {
    case "Listing": {
      setCaps(run, { _tag: "None" });
      break;
    }

    case "Requesting": {
      setCaps(
        run,
        caps.asked <= 0
          ? { _tag: "Steady", enabled: caps.enabled, offered: caps.offered }
          : { ...caps, _tag: "Changing" }
      );
      break;
    }

    case "Holding": {
      setCaps(run, { _tag: "Steady", enabled: caps.enabled, offered: caps.offered });
      break;
    }

    case "Steady":
    case "Changing":
    case "None":
    case undefined: {
      break;
    }

    default: {
      caps satisfies never;
    }
  }

  expireHolding(run, onNow(run.registry, run.state));
  updateOpen(run, (open) => ({ ...open, seam: { ...open.seam, holding: new Set() } }));
  absentOff(run);
};
