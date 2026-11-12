/**
 * Learning a Channel's modes. An Ircd need not send them when Self joins, so the Client
 * asks once for each join, with `MODE <channel>`, and folds the `324` that answers.
 *
 * One query waits on a Connection at a time. The next Channel is asked when the last is
 * answered, or when it has waited {@link modesQueryTime}, so a Session that joins a hundred
 * Channels sends a hundred queries one after another, and never queues them all ahead of
 * the Owner's own Lines. An Ircd that never answers costs one Line for each Channel.
 *
 * A reply is tied to the query only by structure, as a floor reply to the Owner's action
 * is, and the oldest of the two takes it: a `324` of its Channel, an error numeric that
 * names its Channel second, or a `421` or `461` that names `MODE`. None of it is News, and
 * an error leaves the modes unknown.
 *
 * @packageDocumentation
 */
import { mode, upperCaseAscii } from "@iirc/protocol/line";
import type { Line } from "@iirc/protocol/line";

import { changeJoined } from "./channels.ts";
import { Instant } from "./ids.ts";
import type { Run } from "./run.ts";
import { folder, linkOf, send, updateOpen } from "./run.ts";
import type { ModesQuery } from "./state.ts";
import { modesQueryTime } from "./timers.ts";
import { openOf, sessionOf } from "./views.ts";

/**
 * Asks the modes of the first Channel Self is in whose modes are unknown and were not yet
 * asked since Self joined it, unless a query already waits.
 * @param run - The step.
 */
export const askModes = (run: Run): void => {
  const open = openOf(run.state);

  if (
    open === undefined ||
    open.modesQuery !== undefined ||
    sessionOf(run.state) === undefined ||
    linkOf(run)?.closing !== undefined
  ) {
    return;
  }

  for (const { name, phase } of run.state.channels.values()) {
    if (phase._tag !== "Joined" || phase.queried || phase.modes._tag !== "Unknown") {
      continue;
    }

    changeJoined(run, name, (joined) => ({ ...joined, queried: true }));

    // One that cannot be sent, or a Feature refused at egress, was reported: the next is asked.
    if (send(run, mode(name), "MODE") === undefined) {
      continue;
    }

    updateOpen(run, (phase) => ({
      ...phase,
      awaited: phase.awaited + 1,
      modesQuery: {
        channel: name,
        deadline: Instant.make(run.at + modesQueryTime),
        order: phase.awaited,
      },
    }));

    return;
  }
};

/**
 * The query a Line answers, by its structure alone: a `324` of its Channel, an error
 * numeric that names its Channel second, as `403`, `442`, and a numeric no document
 * names may, or a `421` or `461` that names `MODE`.
 * @param run - The step.
 * @param line - The Line, live, and tied to nothing by label.
 * @returns The query, or `undefined` if it answers none.
 */
export const queryAnswered = (run: Run, line: Line): ModesQuery | undefined => {
  const query = openOf(run.state)?.modesQuery;
  const [, named] = line.params;
  const { command } = line;

  if (query === undefined || named === undefined) {
    return undefined;
  }

  if (command === "421" || command === "461") {
    return upperCaseAscii(named) === "MODE" ? query : undefined;
  }

  const fold = folder(run.state);

  return (command === "324" || /^[45]\d\d$/u.test(command)) && fold(named) === fold(query.channel)
    ? query
    : undefined;
};

/**
 * The query waiting is over, answered or not: the next Channel is asked.
 * @param run - The step.
 */
export const modesQueryOver = (run: Run): void => {
  updateOpen(run, (open) => ({ ...open, modesQuery: undefined }));
  askModes(run);
};
