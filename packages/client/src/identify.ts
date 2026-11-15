/**
 * A service login, where there is no SASL: as a Session begins, Self tells the service
 * the account and its Credential, and its Channels wait until the Ircd says Self is
 * logged in, or until the Configuration's bound runs out. The wait is the Session's
 * `identifying`, and its timer is derived from it.
 *
 * Only the protocol's structure ends the wait: a `900`, which says Self's account, or a
 * `MODE` on Self that sets `r`, which Ircds with services use for a registered nick. RFC
 * 2812 gives user mode `r` as "restricted", so only a `+r` that comes once the service was
 * told counts, and the bound covers an Ircd that says neither. A `NOTICE` from the service
 * is text for people, and ends nothing.
 *
 * @packageDocumentation
 */
import { joinWanted } from "./channels.ts";
import { Instant } from "./ids.ts";
import type { ModeChange } from "./news.ts";
import type { Run } from "./run.ts";
import { sendSecret, updateOpen } from "./run.ts";
import { sessionOf } from "./views.ts";

// Sets or ends the wait.
const waitUntil = (run: Run, until: Instant | undefined): void => {
  updateOpen(run, (open) =>
    open.presence._tag === "Session" && open.presence.identifying !== until
      ? { ...open, presence: { ...open.presence, identifying: until } }
      : open
  );
};

/**
 * A Session began: with a service login, tell the service, and hold the Channels for the
 * Configuration's bound. With a bound of 0, they do not wait.
 * @param run - The step, just after the Session began.
 */
export const identify = (run: Run): void => {
  const login = run.state.configuration?.login;

  if (login?._tag !== "Service") {
    return;
  }

  sendSecret(run, {
    _tag: "Identify",
    account: login.account,
    credential: login.credential,
    service: login.service,
  });
  waitUntil(run, login.wait === 0 ? undefined : Instant.make(run.at + login.wait * 1000));
};

/**
 * The Channels need wait no longer: the Ircd said Self is logged in, the bound ran out,
 * or the Credential could not be filled, so there is nothing to wait for. Joins them, if
 * they were waiting.
 * @param run - The step.
 */
export const identified = (run: Run): void => {
  if (sessionOf(run.state)?.identifying === undefined) {
    return;
  }

  waitUntil(run, undefined);
  joinWanted(run);
};

/**
 * A Configuration with no service login: nothing is waited on. The caller joins.
 * @param run - The step.
 */
export const noLongerIdentifying = (run: Run): void => {
  if (run.state.configuration?.login._tag !== "Service") {
    waitUntil(run, undefined);
  }
};

/**
 * Whether a `MODE` on Self sets `r`.
 * @param changes - What it changed.
 * @returns Whether one sets `r`.
 */
export const setsRegistered = (changes: readonly ModeChange[]): boolean =>
  changes.some((change) => change.set && change.mode === "r");
