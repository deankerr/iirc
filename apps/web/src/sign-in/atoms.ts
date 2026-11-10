/**
 * Signing in, as atoms: the state the pure core folds, and the commands that ask the
 * Daemon and fold its answers in. A command holds a key only while its request is in
 * flight, and wipes it once the Daemon has answered.
 *
 * @packageDocumentation
 */
import type { CrossOrigin, InvalidRequest, SignInsFailed, Unauthorized } from "@iirc/api";
import { initial, reduce } from "@iirc/frontend/sign-in";
import type { Failure, SignIn, SignInEvent } from "@iirc/frontend/sign-in";
import { Effect, Redacted } from "effect";
import type { Schema } from "effect";
import type { HttpClientError } from "effect/http";
import { Atom } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";

/** Whether this browser is signed in, as the core folds it. */
export const signInState = Atom.make<SignIn>(initial).pipe(Atom.keepAlive);

/** Whether this browser is signed in, without the attempts in flight. */
export const signedIn = Atom.make((get) => get(signInState)._tag === "SignedIn");

/**
 * Folds one event into the sign-in state.
 * @param get - The context of the command it happened in.
 * @param event - What happened.
 */
const happened = (get: Atom.FnContext, event: SignInEvent) => {
  get.set(signInState, reduce(get(signInState), event));
};

// A gateway in front of the Daemon, such as the dev server's proxy, answers these when
// it could not reach the Daemon. The Daemon's own 503s are typed errors, matched first.
const gatewayStatuses: ReadonlySet<number> = new Set([502, 504]);

/** How a request to the API can fail, as its client gives it. */
type RequestError =
  | Unauthorized
  | CrossOrigin
  | SignInsFailed
  | InvalidRequest
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

/**
 * Why a request failed, from the API's typed errors and from whether the Daemon
 * answered at all.
 * @param error - The request's error.
 * @returns The failure the core keeps.
 */
const failureOf = (error: RequestError): Failure => {
  switch (error._tag) {
    case "Unauthorized": {
      return "WrongKey";
    }

    case "CrossOrigin": {
      return "CrossOrigin";
    }

    case "SignInsFailed": {
      return "NotSaved";
    }

    case "HttpClientError": {
      const { reason, response } = error;

      return reason._tag === "TransportError" ||
        (response !== undefined && gatewayStatuses.has(response.status))
        ? "Unreachable"
        : "Unexpected";
    }

    case "InvalidRequest":
    case "SchemaError": {
      return "Unexpected";
    }

    default: {
      return error satisfies never;
    }
  }
};

/**
 * Finds out whether the browser is signed in, with the cheapest authorized read: listing
 * the Networks. `Unauthorized` means signed out, and any other answer means signed in.
 */
export const check = runtime
  .fn((_, get) =>
    Effect.gen(function* () {
      happened(get, { _tag: "CheckStarted" });
      const client = yield* DaemonClient;

      yield* client.networks.list().pipe(
        Effect.match({
          onFailure: (error) => {
            happened(
              get,
              error._tag === "Unauthorized"
                ? { _tag: "Checked", signedIn: false }
                : { _tag: "CheckFailed", failure: failureOf(error) }
            );
          },
          onSuccess: () => {
            happened(get, { _tag: "Checked", signedIn: true });
          },
        })
      );
    })
  )
  .pipe(Atom.keepAlive);

/**
 * Signs in with a key. The key is wiped once the Daemon has answered, so neither this
 * command nor anything it ran keeps it.
 */
export const signInWithKey = runtime
  .fn((key: Redacted.Redacted, get) =>
    Effect.gen(function* () {
      happened(get, { _tag: "SignInStarted" });
      const client = yield* DaemonClient;

      yield* client.signIn.signIn({ payload: { key } }).pipe(
        Effect.match({
          onFailure: (error) => {
            happened(get, { _tag: "SignInFailed", failure: failureOf(error) });
          },
          onSuccess: () => {
            happened(get, { _tag: "SignInSucceeded" });
          },
        }),
        Effect.ensuring(Effect.sync(() => Redacted.wipeUnsafe(key)))
      );
    })
  )
  .pipe(Atom.keepAlive);

/** Signs out: the Daemon forgets the sign-in, and clears its cookie. */
export const signOut = runtime
  .fn((_, get) =>
    Effect.gen(function* () {
      happened(get, { _tag: "SignOutStarted" });
      const client = yield* DaemonClient;

      yield* client.signIn.signOut().pipe(
        Effect.match({
          onFailure: (error) => {
            happened(get, { _tag: "SignOutFailed", failure: failureOf(error) });
          },
          onSuccess: () => {
            happened(get, { _tag: "SignOutSucceeded" });
          },
        })
      );
    })
  )
  .pipe(Atom.keepAlive);
