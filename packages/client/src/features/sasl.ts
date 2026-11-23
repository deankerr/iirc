/**
 * `sasl`: Self logs in to its account before registration ends, with the mechanism the
 * Configuration's login names: `PLAIN` for a `Sasl` login, or `EXTERNAL` for an `External`
 * one, by the client certificate the Transport presented. While the exchange runs, this
 * Feature holds registration open, so `CAP END` waits for it.
 *
 * - It begins when the cap turns on during registration and the Configuration names a
 *   login, unless the cap's value lists mechanisms and the login's is not among them. Then
 *   it does not try, and a required login gives up the Connection.
 * - It sends `AUTHENTICATE` with the mechanism. On `AUTHENTICATE +`, `PLAIN` sends the
 *   Credential as a `SendSecret`, and `EXTERNAL` sends `AUTHENTICATE +` as an ordinary
 *   Line, since it carries no authorization identity and the Ircd uses the certificate's
 *   account. Any other challenge is not the mechanism's, so it aborts with `AUTHENTICATE *`,
 *   as it does when the login names another mechanism than the one it asked for.
 * - `903` lets registration go. `902` and `904` to `908` are a failed login, and so are
 *   an unfilled Credential and the core's deadline passing, after `AUTHENTICATE *`.
 * - A failed login lets registration go when the login is optional, and gives up the
 *   Connection with `LoginFailed` when it is required.
 * - A required login never goes unmet. While registering, if the cap is not offered,
 *   not acknowledged, deleted before `903`, or the Ircd has no cap negotiation at all,
 *   the Feature is off, and `absent` gives up the Connection. So does `001` before `903`.
 * - `900` and `901`, which say Self's account, are the core's, whoever logged in.
 *
 * A `CAP NEW` for `sasl` after registration does not log in again, and a `CAP DEL` after
 * `903` changes nothing: Self is logged in, and the account stays known.
 *
 * @packageDocumentation
 */
import { authenticate, upperCaseAscii } from "@iirc/protocol/line";

import type { Login } from "../configuration.ts";
import { saslRequired } from "../configuration.ts";
import type { Context, Effects, Feature, Sendable } from "../feature.ts";
import { CapName, FeatureName } from "../ids.ts";

/** Where the exchange is. */
type Exchange =
  /** Not begun, and it will not begin this Connection. */
  | { readonly _tag: "Idle" }
  /** `AUTHENTICATE` with the mechanism is sent, and `+` is awaited. */
  | { readonly _tag: "Asked"; readonly mechanism: Mechanism }
  /** The answer to `+` is sent, and the result is awaited. */
  | { readonly _tag: "Sent" }
  /** Over, logged in. */
  | { readonly _tag: "LoggedIn" }
  /** Over, without a login. */
  | { readonly _tag: "Failed" };

const idle: Exchange = { _tag: "Idle" };
const loggedIn: Exchange = { _tag: "LoggedIn" };
const notLoggedIn: Exchange = { _tag: "Failed" };

const sasl = CapName.make("sasl");

/** The numerics that end the exchange without a login. */
const failures: ReadonlySet<string> = new Set(["902", "904", "905", "906", "907", "908"]);

const line = (argument: string): readonly Sendable[] => {
  const built = authenticate(argument);

  return "_tag" in built ? [] : [{ _tag: "Line", line: built }];
};

/** What a SASL login is, by the mechanism its kind names. */
type Attempt = Extract<Login, { readonly _tag: "External" | "Sasl" }>;

/** The mechanisms a login can name. */
type Mechanism = "EXTERNAL" | "PLAIN";

const attemptOf = (login: Login): Attempt | undefined =>
  login._tag === "Sasl" || login._tag === "External" ? login : undefined;

const mechanismOf = (attempt: Attempt): Mechanism =>
  attempt._tag === "External" ? "EXTERNAL" : "PLAIN";

// Whether the mechanism is offered: the cap lists it, or lists nothing, as SASL 3.1 does.
const offers = (attempt: Attempt, value: string | undefined): boolean =>
  value === undefined ||
  value === "" ||
  value.split(",").some((mechanism) => upperCaseAscii(mechanism) === mechanismOf(attempt));

// No login: go on without one, or give up when the Configuration requires it.
const failed = (context: Context<Exchange>, send: readonly Sendable[] = []): Effects<Exchange> => ({
  own: notLoggedIn,
  registration: saslRequired(context.configuration.login)
    ? { _tag: "Abandon", reason: { _tag: "LoginFailed" } }
    : { _tag: "Continue" },
  send,
});

const running = (exchange: Exchange): boolean =>
  exchange._tag === "Asked" || exchange._tag === "Sent";

// Begins a login, while registering, if the Configuration names one and its mechanism is offered.
const begin = (context: Context<Exchange>): Effects<Exchange> => {
  const attempt = attemptOf(context.configuration.login);

  if (attempt === undefined || context.known.session._tag !== "Registering") {
    return {};
  }

  if (!offers(attempt, context.cap(sasl))) {
    return failed(context);
  }

  return {
    own: { _tag: "Asked", mechanism: mechanismOf(attempt) },
    registration: { _tag: "Hold" },
    send: line(mechanismOf(attempt)),
  };
};

/** The `sasl` Feature, with `PLAIN` or `EXTERNAL`. */
export const saslLogin: Feature<Exchange> = {
  // Off while registering, with a login required and none made: give up.
  absent: (context) =>
    context.known.session._tag === "Registering" &&
    saslRequired(context.configuration.login) &&
    context.own._tag !== "LoggedIn"
      ? { own: notLoggedIn, registration: { _tag: "Abandon", reason: { _tag: "LoginFailed" } } }
      : {},
  // A login the Configuration now names, before `CAP END`, begins if it is not under way.
  configured: (context) =>
    context.own._tag === "Idle" || context.own._tag === "Failed" ? begin(context) : {},
  // The deadline passed, `001` came, or the cap was deleted: abort, if it can be heard.
  expired: (context) =>
    running(context.own)
      ? failed(context, context.enabled(sasl) ? line("*") : [])
      : { registration: { _tag: "Continue" } },
  name: FeatureName.make("sasl"),
  needs: { caps: [sasl] },
  own: idle,
  // SASL acts on its replies only as they arrive live, never from history.
  react: (arrival, context) => {
    const { own, configuration } = context;
    const { command, params } = arrival.line;
    const attempt = attemptOf(configuration.login);

    if (!running(own) || attempt === undefined) {
      return {};
    }

    if (command === "903") {
      return { own: loggedIn, registration: { _tag: "Continue" } };
    }

    if (failures.has(command)) {
      return failed(context);
    }

    if (command !== "AUTHENTICATE" || own._tag !== "Asked") {
      return {};
    }

    // A challenge the mechanism does not make, the mechanism withdrawn since it was asked
    // for, or a login that now names another: the answer would be to the wrong question.
    if (
      params[0] !== "+" ||
      !offers(attempt, context.cap(sasl)) ||
      mechanismOf(attempt) !== own.mechanism
    ) {
      return failed(context, line("*"));
    }

    // `EXTERNAL` has nothing to prove: the certificate has, and an empty authzid asks for its account.
    if (attempt._tag === "External") {
      return { own: { _tag: "Sent" }, send: line("+") };
    }

    return {
      own: { _tag: "Sent" },
      send: [
        {
          _tag: "Secret",
          line: {
            _tag: "AuthenticatePlain",
            authcid: attempt.account,
            authzid: attempt.account,
            credential: attempt.credential,
          },
        },
      ],
    };
  },
  start: (context) => begin(context),
  unfilled: (secret, context) =>
    secret._tag === "AuthenticatePlain" && running(context.own) ? failed(context, line("*")) : {},
};
