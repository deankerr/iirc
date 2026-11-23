/**
 * `sasl`: Self logs in to its account before registration ends, or during a Session when
 * the cap is offered anew, with the mechanism the Configuration's login names: for a `Sasl`
 * login, `SCRAM-SHA-256` where the cap lists it and `PLAIN` otherwise, unless the login
 * pins one, or `EXTERNAL` for an `External` one, by the client certificate the Transport
 * presented. While the exchange runs during registration, this Feature holds registration
 * open, so `CAP END` waits for it.
 *
 * - It begins when the cap turns on during registration and the Configuration names a
 *   login, unless the cap's value lists mechanisms and the login's is not among them. Then
 *   it does not try, and a required login gives up the Connection.
 * - It sends `AUTHENTICATE` with the mechanism. On `AUTHENTICATE +`, `PLAIN` sends the
 *   Credential as a `SendSecret`, and `EXTERNAL` sends `AUTHENTICATE +` as an ordinary
 *   Line, since it carries no authorization identity and the Ircd uses the certificate's
 *   account. Any other challenge is not the mechanism's, so it aborts with `AUTHENTICATE *`,
 *   as it does when the login names another mechanism than the one it asked for.
 * - `SCRAM-SHA-256` (RFC 5802 and RFC 7677, with no channel binding) answers `+` with its
 *   client-first message as a `SendSecret`, the Ircd's server-first message with its
 *   client-final message as another, which name the Credential and carry what the Ircd
 *   sent, and the server-final message with a `CheckScram`. The Runtime makes the nonce
 *   and derives each answer in an exchange it holds for the Connection, so this Feature
 *   holds only which round it is in. A message the Ircd splits over several `AUTHENTICATE`
 *   Lines is read whole first. Once the Runtime says the server-final message is
 *   verified, it sends `AUTHENTICATE +`, and only then is `903` a login.
 * - `903` lets registration go. `902` and `904` to `908` are a failed login, and so are
 *   an unfilled Credential or challenge, a server-final message that is not verified, a
 *   `903` before one is, and the core's deadline passing, after `AUTHENTICATE *` while the
 *   exchange can still be aborted. A failed `SCRAM-SHA-256` login never tries `PLAIN`,
 *   which would send the password to an Ircd that failed it.
 * - A failed login lets registration go when the login is optional, and gives up the
 *   Connection with `LoginFailed` when it is required.
 * - A required login never goes unmet. While registering, if the cap is not offered,
 *   not acknowledged, deleted before `903`, or the Ircd has no cap negotiation at all,
 *   the Feature is off, and `absent` gives up the Connection. So does `001` before `903`.
 * - `900` and `901`, which say Self's account, are the core's, whoever logged in.
 *
 * During a Session, the cap turning on again, as a `CAP NEW` that offers it is
 * acknowledged, begins the same exchange when no account is known for Self, and does
 * nothing when one is. It holds nothing open, and a failed login ends nothing, required or
 * not: the Session has begun. Its numeric is the Network's to show. A `CAP DEL` mid-exchange
 * ends it without a login, so a late challenge goes unanswered, and the next `CAP NEW`
 * begins anew. An unfilled Credential or a check is heard only by the round that sent it.
 *
 * A `CAP DEL` after `903` changes nothing: Self is logged in, and the account stays known.
 *
 * @packageDocumentation
 */
import { authenticate, maxAuthenticateBytes, upperCaseAscii } from "@iirc/protocol/line";

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
  /** The `PLAIN` or `EXTERNAL` answer to `+` is sent, and the result is awaited. */
  | { readonly _tag: "Sent" }
  /**
   * The `SCRAM-SHA-256` client-first message is sent, and the server-first message is
   * awaited, with the base64 of any full `AUTHENTICATE` Lines of it read so far.
   */
  | { readonly _tag: "ScramFirst"; readonly read: string }
  /** The client-final message is sent, and the server-final message is awaited, as above. */
  | { readonly _tag: "ScramFinal"; readonly read: string }
  /** The server-final message is with the Runtime, to check. */
  | { readonly _tag: "ScramChecking" }
  /** The server-final message is verified, `+` is sent, and the result is awaited. */
  | { readonly _tag: "ScramVerified" }
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

/**
 * The most base64 of one SCRAM message from the Ircd: ten full `AUTHENTICATE` Lines, far
 * past any honest server-first or server-final message, so an Ircd cannot grow it forever.
 */
const maxRead = 10 * maxAuthenticateBytes;

const line = (argument: string): readonly Sendable[] => {
  const built = authenticate(argument);

  return "_tag" in built ? [] : [{ _tag: "Line", line: built }];
};

/** What a SASL login is, by the mechanism its kind names. */
type Attempt = Extract<Login, { readonly _tag: "External" | "Sasl" }>;

/** The mechanisms a login can use. */
type Mechanism = "EXTERNAL" | "PLAIN" | "SCRAM-SHA-256";

const attemptOf = (login: Login): Attempt | undefined =>
  login._tag === "Sasl" || login._tag === "External" ? login : undefined;

// Whether the cap's value names the mechanism.
const lists = (value: string | undefined, mechanism: Mechanism): boolean =>
  value?.split(",").some((one) => upperCaseAscii(one) === mechanism) ?? false;

// The mechanism a login uses where the cap has this value: a password login's pinned one,
// or `SCRAM-SHA-256` where it is listed and `PLAIN` otherwise.
const mechanismOf = (attempt: Attempt, value: string | undefined): Mechanism => {
  if (attempt._tag === "External") {
    return "EXTERNAL";
  }

  switch (attempt.mechanism) {
    case "plain": {
      return "PLAIN";
    }

    case "scram-sha-256": {
      return "SCRAM-SHA-256";
    }

    case "auto": {
      return lists(value, "SCRAM-SHA-256") ? "SCRAM-SHA-256" : "PLAIN";
    }

    default: {
      return attempt.mechanism satisfies never;
    }
  }
};

// Whether the mechanism is offered: the cap lists it, or lists nothing, as SASL 3.1 does.
const offers = (mechanism: Mechanism, value: string | undefined): boolean =>
  value === undefined || value === "" || lists(value, mechanism);

// No login. While registering, go on without one, or give up when the Configuration
// requires it. During a Session, nothing more: the Session has already begun.
const failed = (context: Context<Exchange>, send: readonly Sendable[] = []): Effects<Exchange> => {
  if (context.known.session._tag !== "Registering") {
    return { own: notLoggedIn, send };
  }

  return {
    own: notLoggedIn,
    registration: saslRequired(context.configuration.login)
      ? { _tag: "Abandon", reason: { _tag: "LoginFailed" } }
      : { _tag: "Continue" },
    send,
  };
};

const running = (exchange: Exchange): boolean =>
  exchange._tag !== "Idle" && exchange._tag !== "LoggedIn" && exchange._tag !== "Failed";

// Whether Self's account is known this Session, by whatever said it.
const hasAccount = (context: Context<Exchange>): boolean => {
  const account = context.known.self?.account;

  return account?._tag === "Known" && account.value !== null;
};

// Begins a login the Configuration names, if its mechanism is offered: while registering,
// holding registration open, or during a Session with no account known, holding nothing.
const begin = (context: Context<Exchange>): Effects<Exchange> => {
  const attempt = attemptOf(context.configuration.login);
  const session = context.known.session._tag;

  if (
    attempt === undefined ||
    (session !== "Registering" && session !== "Registered") ||
    (session === "Registered" && hasAccount(context))
  ) {
    return {};
  }

  const value = context.cap(sasl);
  const mechanism = mechanismOf(attempt, value);

  if (!offers(mechanism, value)) {
    return failed(context);
  }

  const asked: Effects<Exchange> = { own: { _tag: "Asked", mechanism }, send: line(mechanism) };

  return session === "Registering" ? { ...asked, registration: { _tag: "Hold" } } : asked;
};

// The answer to `+`, for the mechanism asked for, which the login uses.
const answer = (attempt: Attempt, mechanism: Mechanism): Effects<Exchange> => {
  // `EXTERNAL` has nothing to prove: the certificate has, and an empty authzid asks for its account.
  if (attempt._tag === "External") {
    return { own: { _tag: "Sent" }, send: line("+") };
  }

  const { account, credential } = attempt;

  if (mechanism === "PLAIN") {
    return {
      own: { _tag: "Sent" },
      send: [
        {
          _tag: "Secret",
          line: { _tag: "AuthenticatePlain", authcid: account, authzid: account, credential },
        },
      ],
    };
  }

  return {
    own: { _tag: "ScramFirst", read: "" },
    send: [{ _tag: "Secret", line: { _tag: "ScramFirst", authcid: account, credential } }],
  };
};

// One `AUTHENTICATE` Line of a SCRAM message from the Ircd. A full Line says more follows,
// and a short one or `+` ends it, as SASL 3.1 splits a response.
const readScram = (
  own: Extract<Exchange, { readonly _tag: "ScramFirst" | "ScramFinal" }>,
  chunk: string,
  attempt: Extract<Attempt, { readonly _tag: "Sasl" }>,
  context: Context<Exchange>
): Effects<Exchange> => {
  const read = own.read + (chunk === "+" ? "" : chunk);

  if (read.length > maxRead) {
    return failed(context, line("*"));
  }

  if (chunk.length === maxAuthenticateBytes) {
    return { own: { ...own, read } };
  }

  return own._tag === "ScramFirst"
    ? {
        own: { _tag: "ScramFinal", read: "" },
        send: [
          {
            _tag: "Secret",
            line: { _tag: "ScramFinal", credential: attempt.credential, serverFirst: read },
          },
        ],
      }
    : { own: { _tag: "ScramChecking" }, send: [{ _tag: "CheckScram", serverFinal: read }] };
};

// An `AUTHENTICATE` from the Ircd, mid-exchange.
const challenged = (
  chunk: string | undefined,
  attempt: Attempt,
  context: Context<Exchange>
): Effects<Exchange> => {
  const { own } = context;

  if (own._tag === "Asked") {
    // A challenge the mechanism does not make, the mechanism withdrawn since it was asked
    // for, or a login that now uses another: the answer would be to the wrong question.
    const value = context.cap(sasl);

    return chunk === "+" &&
      offers(own.mechanism, value) &&
      mechanismOf(attempt, value) === own.mechanism
      ? answer(attempt, own.mechanism)
      : failed(context, line("*"));
  }

  if (
    (own._tag === "ScramFirst" || own._tag === "ScramFinal") &&
    attempt._tag === "Sasl" &&
    chunk !== undefined &&
    chunk !== ""
  ) {
    return readScram(own, chunk, attempt, context);
  }

  // Nothing else is asked of us mid-exchange.
  return failed(context, line("*"));
};

/** The `sasl` Feature, with `SCRAM-SHA-256`, `PLAIN`, or `EXTERNAL`. */
export const saslLogin: Feature<Exchange> = {
  // Off while registering, with a login required and none made: give up. Off during a
  // Session, mid-exchange: it is over, so nothing answers a challenge that comes late.
  absent: (context) => {
    if (context.known.session._tag !== "Registering") {
      return running(context.own) ? { own: notLoggedIn } : {};
    }

    return saslRequired(context.configuration.login) && context.own._tag !== "LoggedIn"
      ? { own: notLoggedIn, registration: { _tag: "Abandon", reason: { _tag: "LoginFailed" } } }
      : {};
  },
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

    // A SCRAM login is one only once the Ircd proved it held the Credential's keys.
    if (command === "903") {
      return own._tag.startsWith("Scram") && own._tag !== "ScramVerified"
        ? failed(context)
        : { own: loggedIn, registration: { _tag: "Continue" } };
    }

    if (failures.has(command)) {
      return failed(context);
    }

    return command === "AUTHENTICATE" && own._tag !== "Sent"
      ? challenged(params[0], attempt, context)
      : {};
  },
  // Only the round that asked for the check hears it.
  scramChecked: (verified, context) => {
    if (context.own._tag !== "ScramChecking") {
      return {};
    }

    return verified
      ? { own: { _tag: "ScramVerified" }, send: line("+") }
      : failed(context, line("*"));
  },
  start: (context) => begin(context),
  // Only the round that sent the Line awaits it: one begun since has not.
  unfilled: (secret, context) =>
    (secret._tag === "AuthenticatePlain" && context.own._tag === "Sent") ||
    secret._tag === context.own._tag
      ? failed(context, line("*"))
      : {},
};
