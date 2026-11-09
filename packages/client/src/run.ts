/**
 * One step in progress: the State as it moves, and the outputs and News gathered on the
 * way. It lives only inside `step`, which returns its State, outputs, and News as plain
 * data at the end.
 *
 * @packageDocumentation
 */
import { casefold } from "@iirc/protocol/casemapping";
import { isRejected } from "@iirc/protocol/line";
import type { OutboundLine, Rejected, SecretLine } from "@iirc/protocol/line";

import type { Departure, Sendable } from "./feature.ts";
import type { Instant } from "./ids.ts";
import { ConnectionId } from "./ids.ts";
import type { Knowledge } from "./known.ts";
import type { EndReason, IgnoredReason, News } from "./news.ts";
import type { Output } from "./output.ts";
import type { Registered } from "./registry.ts";
import type { Reading } from "./seam.ts";
import { runStage } from "./seam.ts";
import type { Link, Open, State } from "./state.ts";
import { knowledgeOf, negotiated, onNow, openOf } from "./views.ts";

/** A step in progress. */
export interface Run {
  state: State;
  readonly before: State;
  readonly at: Instant;
  readonly registry: readonly Registered[];
  readonly outputs: Output[];
  readonly news: News[];
  /** What was known before the step, worked out only if a Feature reads it. */
  known: Knowledge | undefined;
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
export const setLink = (run: Run, link: Link): void => {
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

  run.known ??= knowledgeOf(run.before, folder(run.before));

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

const connection = (run: Run): ConnectionId | undefined => {
  const link = linkOf(run);

  return link === undefined ? undefined : ConnectionId.make(link.id);
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
 * built is not sent, and is recorded as `Malformed` with its command.
 * @param run - The step.
 * @param line - The Line, or why it cannot be built.
 * @param command - Its command, to report if it cannot be built.
 * @param purpose - What it is for, if it is the Owner's, else a protocol Line.
 * @returns Whether it was sent.
 */
export const send = (
  run: Run,
  line: OutboundLine | Rejected,
  command: string,
  purpose?: Departure["for"]
): boolean => {
  const id = connection(run);

  if (isRejected(line)) {
    ignore(run, { _tag: "Malformed", command });

    return false;
  }

  if (id === undefined) {
    return false;
  }

  const features = onNow(run.registry, run.state).filter((feature) => feature.egress !== undefined);
  const reading = features.length === 0 ? undefined : readingOf(run);
  const open = openOf(run.state);

  if (reading === undefined || open === undefined) {
    run.outputs.push({ _tag: "Send", connection: id, line });

    return true;
  }

  const ran = runStage(
    features,
    open.seam,
    reading,
    { for: purpose ?? protocol, line },
    (feature, departure, context) => feature.egress?.(departure, context)
  );

  updateOpen(run, (phase) => ({ ...phase, seam: ran.seam }));
  reportFailed(run, ran.failed);
  run.outputs.push({ _tag: "Send", connection: id, line: ran.value.line });
  sendAll(run, ran.send);

  return true;
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
