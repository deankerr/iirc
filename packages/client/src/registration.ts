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
import { capsWanted, freshSeam, runEffects, turnedOff } from "./seam.ts";
import type { Caps, Negotiated, Open } from "./state.ts";
import { holdTime, registrationTime } from "./timers.ts";
import { onNow, openOf } from "./views.ts";

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
  applyRegistration(run, ran.registration);
};

/**
 * Works out again which Features are on, after caps, ISUPPORT, or the Owner's choices
 * changed. A Feature that turns on starts with its own state and runs `start`. One that
 * turns off lets go of registration, and the facts it kept go stale.
 * @param run - The step.
 * @param was - The Features on before the change.
 */
export const recompute = (run: Run, was: readonly Registered[]): void => {
  const now = onNow(run.registry, run.state);
  const started = now.filter((feature) => !was.includes(feature));
  const stopped = was.filter((feature) => !now.includes(feature));

  if (started.length === 0 && stopped.length === 0) {
    return;
  }

  updateOpen(run, (open) => {
    const own = new Map(open.seam.own);
    const holding = new Set(open.seam.holding);

    for (const feature of started) {
      own.delete(feature.name);
    }

    for (const feature of stopped) {
      holding.delete(feature.name);
    }

    return { ...open, seam: { ...turnedOff(open.seam, was, now, run.at), holding, own } };
  });

  const reading = readingOf(run);
  const open = openOf(run.state);

  if (reading !== undefined && open !== undefined) {
    carryOut(
      run,
      runEffects(started, open.seam, reading, (feature, context) => feature.start?.(context))
    );
  }
};

/**
 * Ends negotiation once nothing more is awaited: `CAP END` while registering, unless a
 * Feature holds registration open, in which case the hold's deadline is set.
 * @param run - The step.
 */
export const settle = (run: Run): void => {
  const open = openOf(run.state);

  if (open === undefined || linkOf(run)?.closing !== undefined) {
    return;
  }

  const { caps, presence, seam } = open;
  const done = (caps._tag === "Requesting" && caps.asked <= 0) || caps._tag === "Holding";

  if (!done) {
    return;
  }

  const held: Negotiated = { enabled: caps.enabled, offered: caps.offered };

  if (presence._tag !== "Registering") {
    setCaps(run, { ...held, _tag: "Steady" });

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

  setCaps(run, { ...held, _tag: "Steady" });
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
  const open = openOf(run.state);
  const reading = readingOf(run);

  if (open === undefined || reading === undefined) {
    return;
  }

  const holding = onNow(run.registry, run.state).filter((feature) =>
    open.seam.holding.has(feature.name)
  );

  const ran = runEffects(
    holding,
    open.seam,
    reading,
    (feature, context) => feature.expired?.(context) ?? { registration: { _tag: "Continue" } }
  );

  updateOpen(run, (phase) =>
    phase.presence._tag === "Registering"
      ? { ...phase, presence: { ...phase.presence, hold: undefined } }
      : phase
  );
  carryOut(run, {
    ...ran,
    // A Feature whose `expired` threw holds nothing.
    seam: {
      ...ran.seam,
      holding: new Set([...ran.seam.holding].filter((name) => !ran.failed.includes(name))),
    },
  });
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
      : run.registry.filter((feature) => (feature.needs.caps ?? []).some((name) => only.has(name))),
    { ...held, isupport: openOf(run.state)?.isupport ?? new Map() },
    run.state.configuration?.declined ?? []
  );

// Caps share `CAP REQ` Lines, as many to a Line as fit. Gives how many were sent.
const requestLines = (run: Run, wanted: readonly CapName[]): number => {
  const lines: string[][] = [];

  for (const name of wanted) {
    const last = lines.at(-1);

    if (last !== undefined && !isRejected(cap("REQ", [...last, name].join(" ")))) {
      last.push(name);
    } else {
      lines.push([name]);
    }
  }

  return lines.filter((names) => send(run, cap("REQ", names.join(" ")), "CAP") !== undefined)
    .length;
};

const request = (
  run: Run,
  held: Negotiated,
  after: "Requesting" | "Changing",
  only?: ReadonlySet<CapName>
): void => {
  const sent = requestLines(run, wantedNow(run, held, only));

  if (sent === 0 && after === "Changing") {
    setCaps(run, { ...held, _tag: "Steady" });

    return;
  }

  // With nothing to ask for, `Requesting` is already answered, and `settle` ends it.
  setCaps(run, { ...held, _tag: after, asked: sent });
};

const answered = (
  run: Run,
  caps: Extract<Caps, { readonly asked: number }>,
  list: readonly (readonly [CapName, string])[],
  ack: boolean,
  more: boolean
): void => {
  const enabled = new Set(caps.enabled);

  if (ack) {
    for (const [name] of list) {
      if (name.startsWith("-")) {
        enabled.delete(CapNameSchema.make(name.slice(1)));
      } else if (caps.offered.has(name) || enabled.size < maxCaps) {
        enabled.add(name);
      }
    }
  }

  // An answer spread over several Lines counts once, at its last.
  const asked = more ? caps.asked : caps.asked - 1;

  if (caps._tag === "Changing") {
    setCaps(run, asked <= 0 ? { ...caps, _tag: "Steady", enabled } : { ...caps, asked, enabled });

    return;
  }

  setCaps(run, { ...caps, asked, enabled });
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
    setCaps(run, { ...caps, ...held, asked: caps.asked + sent });
  } else if (sent === 0) {
    setCaps(run, { ...caps, ...held });
  } else {
    // While Features hold registration, nothing is awaited: now the new request is.
    setCaps(run, { ...held, _tag: "Requesting", asked: sent });
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
  }
};

/**
 * `001` ended negotiation, whether or not it was over: what was listed and never
 * answered is no cap negotiation, and an outstanding `REQ` is answered later.
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
      setCaps(run, caps.asked <= 0 ? { ...caps, _tag: "Steady" } : { ...caps, _tag: "Changing" });
      break;
    }

    case "Holding": {
      setCaps(run, { ...caps, _tag: "Steady" });
      updateOpen(run, (open) => ({ ...open, seam: { ...open.seam, holding: new Set() } }));
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
};
