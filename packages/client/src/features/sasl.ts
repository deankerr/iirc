/**
 * `sasl` with `PLAIN`: Self logs in to its account before registration ends. While the
 * exchange runs, this Feature holds registration open, so `CAP END` waits for it.
 *
 * - It begins when the cap turns on during registration and the Configuration names a
 *   login, unless the cap's value lists mechanisms and `PLAIN` is not among them. Then it
 *   does not try, and a required login gives up the Connection.
 * - It sends `AUTHENTICATE PLAIN`, and on `AUTHENTICATE +`, the Credential as a
 *   `SendSecret`. Any other challenge is not `PLAIN`'s, so it aborts with `AUTHENTICATE *`.
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

import type { Context, Effects, Feature, Sendable } from "../feature.ts";
import { CapName, FeatureName } from "../ids.ts";

/** Where the exchange is. */
type Exchange =
  /** Not begun, and it will not begin this Connection. */
  | { readonly _tag: "Idle" }
  /** `AUTHENTICATE PLAIN` is sent, and `+` is awaited. */
  | { readonly _tag: "Asked" }
  /** The Credential is sent, and the result is awaited. */
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

// Whether `PLAIN` is offered: the cap lists it, or lists nothing, as SASL 3.1 does.
const offersPlain = (value: string | undefined): boolean =>
  value === undefined ||
  value === "" ||
  value.split(",").some((mechanism) => upperCaseAscii(mechanism) === "PLAIN");

// No login: go on without one, or give up when the Configuration requires it.
const failed = (context: Context<Exchange>, send: readonly Sendable[] = []): Effects<Exchange> => {
  const { login } = context.configuration;
  const required = login._tag === "Sasl" && login.required;

  return {
    own: notLoggedIn,
    registration: required
      ? { _tag: "Abandon", reason: { _tag: "LoginFailed" } }
      : { _tag: "Continue" },
    send,
  };
};

const running = (exchange: Exchange): boolean =>
  exchange._tag === "Asked" || exchange._tag === "Sent";

const isRequired = (context: Context<Exchange>): boolean => {
  const { login } = context.configuration;

  return login._tag === "Sasl" && login.required;
};

/** The `sasl` Feature, with `PLAIN`. */
export const saslPlain: Feature<Exchange> = {
  // Off while registering, with a login required and none made: give up.
  absent: (context) =>
    context.known.session._tag === "Registering" &&
    isRequired(context) &&
    context.own._tag !== "LoggedIn"
      ? { own: notLoggedIn, registration: { _tag: "Abandon", reason: { _tag: "LoginFailed" } } }
      : {},
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
    const { login } = configuration;

    if (!running(own) || login._tag !== "Sasl") {
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

    // A challenge PLAIN does not make, or PLAIN withdrawn since it was asked for.
    if (params[0] !== "+" || !offersPlain(context.cap(sasl))) {
      return failed(context, line("*"));
    }

    return {
      own: { _tag: "Sent" },
      send: [
        {
          _tag: "Secret",
          line: {
            _tag: "AuthenticatePlain",
            authcid: login.account,
            authzid: login.account,
            credential: login.credential,
          },
        },
      ],
    };
  },
  start: (context) => {
    const { login } = context.configuration;

    if (login._tag !== "Sasl" || context.known.session._tag !== "Registering") {
      return {};
    }

    if (!offersPlain(context.cap(sasl))) {
      return failed(context);
    }

    return { own: { _tag: "Asked" }, registration: { _tag: "Hold" }, send: line("PLAIN") };
  },
  unfilled: (secret, context) =>
    secret._tag === "AuthenticatePlain" && running(context.own) ? failed(context, line("*")) : {},
};
