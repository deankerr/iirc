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
 * - `900` and `901`, which say Self's account, are the core's, whoever logged in.
 *
 * A `CAP NEW` for `sasl` after registration does not log in again. Self's account is
 * what a login made known, so when the cap is deleted, it goes stale until a `900` or
 * `901` says it again.
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
  /** Over, whether it logged in or not. */
  | { readonly _tag: "Over" };

const idle: Exchange = { _tag: "Idle" };
const over: Exchange = { _tag: "Over" };

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
    own: over,
    registration: required
      ? { _tag: "Abandon", reason: { _tag: "LoginFailed" } }
      : { _tag: "Continue" },
    send,
  };
};

const running = (exchange: Exchange): boolean =>
  exchange._tag === "Asked" || exchange._tag === "Sent";

/** The `sasl` Feature, with `PLAIN`. */
export const saslPlain: Feature<Exchange> = {
  expired: (context) =>
    running(context.own) ? failed(context, line("*")) : { registration: { _tag: "Continue" } },
  keeps: ["user.account"],
  name: FeatureName.make("sasl"),
  needs: { caps: [sasl] },
  own: idle,
  start: (context) => {
    const { login } = context.configuration;

    if (login._tag !== "Sasl" || context.known.session._tag !== "Registering") {
      return { own: over };
    }

    if (!offersPlain(context.cap(sasl))) {
      return failed(context);
    }

    return { own: { _tag: "Asked" }, registration: { _tag: "Hold" }, send: line("PLAIN") };
  },
  tags: (arrival, context) => {
    const { own, configuration } = context;
    const { command, params } = arrival.line;
    const { login } = configuration;

    if (!running(own) || login._tag !== "Sasl") {
      return { value: arrival };
    }

    if (command === "903") {
      return { own: over, registration: { _tag: "Continue" }, value: arrival };
    }

    if (failures.has(command)) {
      return { ...failed(context), value: arrival };
    }

    if (command !== "AUTHENTICATE" || own._tag !== "Asked") {
      return { value: arrival };
    }

    if (params[0] !== "+") {
      return { ...failed(context, line("*")), value: arrival };
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
      value: arrival,
    };
  },
  unfilled: (secret, context) =>
    secret._tag === "AuthenticatePlain" && running(context.own) ? failed(context, line("*")) : {},
};
