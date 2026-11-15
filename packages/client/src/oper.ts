/**
 * An operator login: as each Session begins, Self sends `OPER` with the Configuration's
 * name and Credential, and the Session awaits the answer. The answer is read from its
 * numeric alone, never its text: `381` grants it, and `464`, `491`, or a `461` that names
 * `OPER` refuse it. Each is reported once, as Activity in the Network's own Timeline. A
 * numeric that arrives when nothing awaits it is no answer to Self's `OPER`.
 *
 * `echo-message` echoes only `PRIVMSG`, `NOTICE`, and `TAGMSG`, so the Ircd never sends
 * `OPER` back to be journaled.
 *
 * @packageDocumentation
 */
import { upperCaseAscii } from "@iirc/protocol/line";
import type { Line } from "@iirc/protocol/line";

import type { OperRefusal } from "./news.ts";
import type { Run } from "./run.ts";
import { sendSecret, updateOpen } from "./run.ts";
import { sessionOf } from "./views.ts";
import { routeActivity } from "./where.ts";

// Sets or ends the wait for an answer.
const awaiting = (run: Run, opering: boolean): void => {
  updateOpen(run, (open) =>
    open.presence._tag === "Session" && open.presence.opering !== opering
      ? { ...open, presence: { ...open.presence, opering } }
      : open
  );
};

/**
 * A Session began: with an operator login, send `OPER`, and await its answer.
 * @param run - The step, just after the Session began.
 */
export const oper = (run: Run): void => {
  const login = run.state.configuration?.oper;

  if (login?._tag !== "Login") {
    return;
  }

  sendSecret(run, { _tag: "Oper", credential: login.credential, name: login.name });
  awaiting(run, true);
};

/**
 * The Credential could not be filled, so no `OPER` left, and nothing answers it.
 * @param run - The step.
 */
export const operUnsent = (run: Run): void => {
  awaiting(run, false);
};

const refusals: ReadonlySet<string> = new Set<OperRefusal>(["464", "491"]);

const isRefusal = (command: string): command is OperRefusal => refusals.has(command);

// What a numeric says of an `OPER`: granted, refused with it, or nothing.
const answerOf = (line: Line): "Granted" | OperRefusal | undefined => {
  if (line.command === "381") {
    return "Granted";
  }

  if (isRefusal(line.command)) {
    return line.command;
  }

  return line.command === "461" && upperCaseAscii(line.params[1] ?? "") === "OPER"
    ? "461"
    : undefined;
};

/**
 * A numeric that may answer the `OPER` the Session awaits. One that does is reported in
 * the Network's own Timeline, and ends the wait.
 * @param run - The step.
 * @param line - The numeric, live.
 */
export const operAnswered = (run: Run, line: Line): void => {
  const session = sessionOf(run.state);
  const answer = answerOf(line);

  if (session?.opering !== true || answer === undefined) {
    return;
  }

  run.news.push(
    routeActivity(run, {
      _tag: "Activity",
      activity:
        answer === "Granted"
          ? { _tag: "OperGranted", nick: session.nick }
          : { _tag: "OperRefused", nick: session.nick, reply: answer },
      at: { _tag: "Known", at: run.at, from: "receipt", value: run.at },
      id: { _tag: "Unknown" },
      live: true,
    })
  );
  awaiting(run, false);
};
