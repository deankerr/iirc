/**
 * A service login, where there is no SASL: as a Session begins, Self tells the service
 * the account and its Credential, and its Channels wait until the Ircd says Self is
 * logged in, or until the Configuration's bound runs out. The wait is the Session's
 * `identifying`, and its timer is derived from it.
 *
 * Only the protocol's structure ends the wait early: a `900`, which says Self's account.
 * No user mode counts, since none means "logged in" across the protocol: RFC 2812 gives
 * `r` as "restricted", which an Ircd may set as a Session begins, and a release cannot be
 * taken back. A `NOTICE` from the service is text for people, and ends nothing. The
 * bound covers an Ircd that says nothing.
 *
 * The Credential is never told while `echo-message` is on or asked for on the Connection,
 * since the Ircd would echo it back, and every Line received is journaled. A service login
 * declines `echo-message` from the next Connection, but one configured while registering
 * finds it already on: that Session joins at once without telling the service.
 *
 * @packageDocumentation
 */
import { joinWanted } from "./channels.ts";
import { CapName, Instant } from "./ids.ts";
import type { Run } from "./run.ts";
import { sendSecret, updateOpen } from "./run.ts";
import { negotiated, openOf, sessionOf } from "./views.ts";

const echoMessage = "echo-message";

// Whether the Ircd may echo what is said now: `echo-message` is on, or a change to it
// is still to be answered, which the Ircd may yet refuse.
const mayEcho = (run: Run): boolean => {
  const caps = openOf(run.state)?.caps;
  const pending = caps !== undefined && "requested" in caps ? caps.requested : new Set<string>();

  return (
    negotiated(caps).enabled.has(CapName.make(echoMessage)) ||
    pending.has(echoMessage) ||
    pending.has(`-${echoMessage}`)
  );
};

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
 * Configuration's bound. With a bound of 0, they do not wait. While the Ircd may echo,
 * nothing is told and nothing waits.
 * @param run - The step, just after the Session began.
 */
export const identify = (run: Run): void => {
  const login = run.state.configuration?.login;

  if (login?._tag !== "Service" || mayEcho(run)) {
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
