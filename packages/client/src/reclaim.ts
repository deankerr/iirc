/**
 * Taking a configured nick back: when Self settled for a nick further down the list, it
 * asks for the preferred one once it sees the holder leave it.
 *
 * The ask is a Line of the Client's own, and the Ircd answers it as it answers any
 * `NICK`: with a `NICK` from Self, an error numeric, or a `FAIL`. It takes an `order` as
 * the Owner's Lines do, so an answer goes to whichever of the ask and the Owner's `NICK`
 * for the same nick was sent first, and the ask never settles an intent. Nothing times an
 * ask out: one that nothing answers lingers only until the Connection ends.
 *
 * @packageDocumentation
 */
import { isRejected, nick } from "@iirc/protocol/line";
import type { Line } from "@iirc/protocol/line";

import { online } from "./acts.ts";
import type { Run } from "./run.ts";
import { folder, send, updateOpen } from "./run.ts";
import type { Reclaiming, State } from "./state.ts";
import { maxReclaims } from "./state.ts";
import { openOf, sessionOf } from "./views.ts";

/**
 * The nick Self wants back: the first the Configuration lists, while Self holds another
 * it settled for in a Session, and the Owner has not chosen a nick in it.
 * @param state - The State.
 * @returns The nick, or `undefined` when Self wants none back.
 */
export const wantedBack = (state: State): string | undefined => {
  const session = sessionOf(state);
  const [preferred] = state.configuration?.nicks ?? [];

  if (session === undefined || preferred === undefined || session.chosen) {
    return undefined;
  }

  const fold = folder(state);

  return fold(session.nick) === fold(preferred) ? undefined : preferred;
};

/**
 * A User was seen to leave a nick, by quitting or by renaming, or `MONITOR` said its
 * holder went offline. When that nick is the one Self wants back, Self asks for it. One
 * leave seen is one ask, and a refusal waits for the next. A nick the Owner chose in this
 * Session is theirs, and never changed.
 * @param run - The step.
 * @param left - The nick the User left.
 */
export const reclaim = (run: Run, left: string): void => {
  const preferred = wantedBack(run.state);

  if (
    preferred === undefined ||
    !online(run) ||
    folder(run.state)(left) !== folder(run.state)(preferred)
  ) {
    return;
  }

  const line = nick(preferred);

  // A Feature refused it at egress, and `send` reported it.
  if (isRejected(line) || send(run, line, "NICK") === undefined) {
    return;
  }

  updateOpen(run, (open) => ({
    ...open,
    awaited: open.awaited + 1,
    reclaims: [...open.reclaims, { nick: preferred, order: open.awaited }].slice(-maxReclaims),
  }));
};

// The numerics that refuse a `NICK`, by the nick they name second: RFC 2812's, and `438`,
// a change refused for coming too fast, as many Ircds send it.
const refusals: ReadonlySet<string> = new Set(["432", "433", "436", "437", "438"]);

/**
 * The ask a Line refuses, by its structure alone: an error numeric that refuses a `NICK`
 * and names the nick asked for. It is the oldest ask, as the Ircd answers in order.
 * @param run - The step.
 * @param line - The Line, live, and tied to nothing by label.
 * @returns The ask, or `undefined` if the Line refuses none.
 */
export const reclaimRefused = (run: Run, line: Line): Reclaiming | undefined => {
  const [asked] = openOf(run.state)?.reclaims ?? [];
  const [, named] = line.params;

  if (asked === undefined || named === undefined || !refusals.has(line.command)) {
    return undefined;
  }

  const fold = folder(run.state);

  return fold(named) === fold(asked.nick) ? asked : undefined;
};

/**
 * The oldest ask, when a standard reply names `NICK`. It is what the reply is about when
 * it is the first of what awaits an answer, which the caller decides.
 * @param run - The step.
 * @returns The ask, or `undefined` for none.
 */
export const reclaimAsked = (run: Run): Reclaiming | undefined => openOf(run.state)?.reclaims[0];

/**
 * The oldest ask is answered, and forgotten.
 * @param run - The step.
 */
export const reclaimOver = (run: Run): void => {
  updateOpen(run, (open) => ({ ...open, reclaims: open.reclaims.slice(1) }));
};

/**
 * Self's nick changed to `to`, which answers the oldest ask when it is for that nick and
 * was sent before any `NICK` of the Owner's for it. The ask is then forgotten, and the
 * change answers no intent.
 * @param run - The step.
 * @param to - Self's new nick.
 * @returns Whether the ask took it.
 */
export const reclaimTaken = (run: Run, to: string): boolean => {
  const open = openOf(run.state);
  const [asked] = open?.reclaims ?? [];

  if (open === undefined || asked === undefined) {
    return false;
  }

  const fold = folder(run.state);

  if (fold(to) !== fold(asked.nick)) {
    return false;
  }

  const owners = open.acting
    .filter((each) => each.command === "NICK" && each.names.some((name) => fold(name) === fold(to)))
    .map((each) => each.order);

  if (asked.order > Math.min(...owners)) {
    return false;
  }

  reclaimOver(run);

  return true;
};
