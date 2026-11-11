/**
 * One step in progress: the State as it moves, and the outputs and News gathered on the
 * way. It lives only inside `step`, which returns its State, outputs, and News as plain
 * data at the end.
 *
 * @packageDocumentation
 */
import { casefold, defaultCasemapping } from "@iirc/protocol/casemapping";
import { isRejected } from "@iirc/protocol/line";
import type { OutboundLine, Rejected, SecretLine } from "@iirc/protocol/line";

import type { Departure, KnownBefore, Refusal, Sendable } from "./feature.ts";
import type { Instant, IntentId } from "./ids.ts";
import { ConnectionId } from "./ids.ts";
import type { EndReason, IgnoredReason, News, RefusedReason } from "./news.ts";
import type { Output } from "./output.ts";
import type { Registered } from "./registry.ts";
import type { Reading } from "./seam.ts";
import { runStage } from "./seam.ts";
import type { Link, Open, State } from "./state.ts";
import { knownBeforeOf, negotiated, onNow, openOf } from "./views.ts";

/** A step in progress. */
export interface Run {
  state: State;
  readonly before: State;
  readonly at: Instant;
  readonly registry: readonly Registered[];
  readonly outputs: Output[];
  readonly news: News[];
  /** What was known of the Session and Self before the step, worked out once a Feature runs. */
  known: KnownBefore | undefined;
}

/**
 * Folds a name by the casemapping in force.
 * @param state - The State.
 * @returns The fold.
 */
export const folder =
  (state: State) =>
  (name: string): string =>
    casefold(state.casemapping, name);

/**
 * Records an input that changed nothing.
 * @param run - The step.
 * @param reason - Why.
 */
export const ignore = (run: Run, reason: IgnoredReason): void => {
  run.news.push({ _tag: "Ignored", reason });
};

/**
 * Reports an Owner intent not carried out. One of the actions the Client remembers says
 * what it tried and where it belongs, so its refusal can be shown there. Its Channel's
 * name is folded as the refusal is reported, by the casemapping the Network last declared
 * then, so a mapping declared since the action began keys it as the projection keys that
 * Channel's Timeline now, and it never opens a second one.
 * @param run - The step.
 * @param intent - The intent.
 * @param reason - Why.
 */
export const refuseIntent = (run: Run, intent: IntentId, reason: RefusedReason): void => {
  const remembered = run.state.actions.get(intent);

  const action =
    remembered?.where._tag === "Channel"
      ? {
          ...remembered,
          where: {
            ...remembered.where,
            key: casefold(run.state.declared ?? defaultCasemapping, remembered.where.name),
          },
        }
      : remembered;

  run.news.push({ _tag: "Refused", action, intent, reason });
};

/**
 * The Connection, if there is one.
 * @param run - The step.
 * @returns It.
 */
export const linkOf = (run: Run): Link | undefined =>
  run.state.network._tag === "Connection" ? run.state.network.link : undefined;

/**
 * Replaces the Connection.
 * @param run - The step.
 * @param link - The Connection after.
 */
const setLink = (run: Run, link: Link): void => {
  run.state = { ...run.state, network: { _tag: "Connection", link } };
};

/**
 * Replaces the open Connection's phase, if it is open.
 * @param run - The step.
 * @param change - What to change.
 */
export const updateOpen = (run: Run, change: (open: Open) => Open): void => {
  const link = linkOf(run);

  if (link?.phase._tag === "Open") {
    setLink(run, { ...link, phase: change(link.phase) });
  }
};

/**
 * What every Feature hook may read now.
 * @param run - The step.
 * @returns The reading.
 */
export const readingOf = (run: Run): Reading | undefined => {
  const open = openOf(run.state);
  const { configuration } = run.state;

  if (open === undefined || configuration === undefined) {
    return undefined;
  }

  run.known ??= knownBeforeOf(run.before);

  return {
    at: run.at,
    configuration,
    known: run.known,
    offer: { ...negotiated(open.caps), isupport: open.isupport },
  };
};

/**
 * Records Features whose hooks threw.
 * @param run - The step.
 * @param failed - Their names.
 */
export const reportFailed = (run: Run, failed: readonly string[]): void => {
  for (const feature of failed) {
    ignore(run, { _tag: "FeatureFailed", feature });
  }
};

// The Connection a Line may be sent on: one that is open, and that the Client has not
// begun to hang up. Every Line goes through here, so nothing follows a `QUIT` or a
// `Hangup`.
const connection = (run: Run): ConnectionId | undefined => {
  const link = linkOf(run);

  return link?.phase._tag === "Open" && link.closing === undefined
    ? ConnectionId.make(link.id)
    : undefined;
};

/**
 * Sends a Line that carries a Credential, by name.
 * @param run - The step.
 * @param line - The Line.
 */
export const sendSecret = (run: Run, line: SecretLine): void => {
  const id = connection(run);

  if (id !== undefined) {
    run.outputs.push({ _tag: "SendSecret", connection: id, line });
  }
};

const protocol: Departure["for"] = { _tag: "Protocol" };

const isRefusal = (value: Departure | Refusal): value is Refusal => !("line" in value);

/**
 * Sends what Feature hooks asked to send, as they built it: their Lines do not go
 * through `egress` again.
 * @param run - The step.
 * @param lines - The Lines.
 */
export const sendAll = (run: Run, lines: readonly Sendable[]): void => {
  const id = connection(run);

  for (const each of lines) {
    if (each._tag === "Secret") {
      sendSecret(run, each.line);
    } else if (id !== undefined) {
      run.outputs.push({ _tag: "Send", connection: id, line: each.line });
    }
  }
};

/**
 * Sends a Line on the Connection, through each Feature's `egress`. A Line that cannot be
 * built is not sent, and is recorded as `Malformed` with its command. One a Feature
 * refuses is not sent either: a `Said` or `Acted` one is `Refused` as `Unsendable`, and
 * any other is `Ignored` as `Unsendable`, with its command.
 * @param run - The step.
 * @param line - The Line, or why it cannot be built.
 * @param command - Its command, to report if it cannot be built.
 * @param purpose - What it is for, if it is the Owner's, else a protocol Line.
 * @returns The Line as it was sent, with whether the Ircd will echo it, or `undefined`
 * if it was not sent.
 */
export const send = (
  run: Run,
  line: OutboundLine | Rejected,
  command: string,
  purpose?: Departure["for"]
): Departure | undefined => {
  const id = connection(run);

  if (isRejected(line)) {
    ignore(run, { _tag: "Malformed", command });

    return undefined;
  }

  if (id === undefined) {
    return undefined;
  }

  const departure: Departure = { echo: false, for: purpose ?? protocol, line };
  const features = onNow(run.registry, run.state).filter((feature) => feature.egress !== undefined);
  const reading = features.length === 0 ? undefined : readingOf(run);
  const open = openOf(run.state);

  // Every Line of a `Say` or an action names its intent, so an `Unsent` can be tied back
  // to it.
  const intent = departure.for._tag === "Protocol" ? {} : { intent: departure.for.intent };

  if (reading === undefined || open === undefined) {
    run.outputs.push({ _tag: "Send", connection: id, line, ...intent });

    return departure;
  }

  const ran = runStage<Departure | Refusal>(
    features,
    open.seam,
    reading,
    departure,
    (feature, value, context) => (isRefusal(value) ? undefined : feature.egress?.(value, context))
  );

  updateOpen(run, (phase) => ({ ...phase, seam: ran.seam }));
  reportFailed(run, ran.failed);

  if (isRefusal(ran.value)) {
    if (departure.for._tag === "Protocol") {
      ignore(run, { _tag: "Unsendable", command: line.command });
    } else {
      refuseIntent(run, departure.for.intent, { _tag: "Unsendable" });
    }

    return undefined;
  }

  run.outputs.push({ _tag: "Send", connection: id, line: ran.value.line, ...intent });
  sendAll(run, ran.send);

  return ran.value;
};

/**
 * Ends the Connection: the Client asks for a `Hangup` and waits for `Closed`.
 * @param run - The step.
 * @param reason - Why, as `Closed` will report it.
 */
export const hangup = (run: Run, reason: EndReason): void => {
  const link = linkOf(run);

  if (link === undefined || link.closing !== undefined) {
    return;
  }

  run.outputs.push({ _tag: "Hangup", connection: ConnectionId.make(link.id) });
  setLink(run, { ...link, closing: reason });
};
