/**
 * Taking a configured nick back: when Self settled for a nick further down the list, it
 * asks for the preferred one once it sees the holder leave it.
 *
 * @packageDocumentation
 */
import { isRejected, nick } from "@iirc/protocol/line";

import { online } from "./acts.ts";
import type { Run } from "./run.ts";
import { folder, send } from "./run.ts";
import { sessionOf } from "./views.ts";

/**
 * A User was seen to leave a nick, by quitting or by renaming. When that nick is the
 * first the Configuration lists, and Self holds another it settled for, Self asks for it.
 * Nothing is kept of the ask: one leave seen is one ask, and a refusal waits for the next.
 * A nick the Owner chose in this Session is theirs, and never changed.
 * @param run - The step.
 * @param left - The nick the User left.
 */
export const reclaim = (run: Run, left: string): void => {
  const session = sessionOf(run.state);
  const [preferred] = run.state.configuration?.nicks ?? [];

  if (session === undefined || preferred === undefined || session.chosen || !online(run)) {
    return;
  }

  const fold = folder(run.state);

  if (fold(left) !== fold(preferred) || fold(session.nick) === fold(preferred)) {
    return;
  }

  const line = nick(preferred);

  if (!isRejected(line)) {
    send(run, line, "NICK");
  }
};
