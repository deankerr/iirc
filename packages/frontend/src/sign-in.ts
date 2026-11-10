/**
 * Whether this browser is signed in to the Daemon, as a reducer over what the Frontend
 * asked and what the API answered. It holds no key: a key goes from the Owner to the API
 * and is never part of this state.
 *
 * @packageDocumentation
 */

/**
 * Why the Daemon did not do what was asked, from the API's typed errors and from whether
 * an answer came at all.
 *
 * - `WrongKey`: signing in, the key matched none the Daemon holds (`Unauthorized`).
 * - `CrossOrigin`: the Daemon refused a request it could not tell came from its own origin.
 * - `NotSaved`: the Daemon could not write its sign-ins, so nothing changed (`SignInsFailed`).
 * - `Unreachable`: no answer came from the Daemon.
 * - `Unexpected`: an answer came that the Frontend could not read.
 */
export type Failure = "WrongKey" | "CrossOrigin" | "NotSaved" | "Unreachable" | "Unexpected";

/** One request the Owner can repeat: not asked yet or done, waiting on the Daemon, or failed. */
export type Attempt =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Waiting" }
  | { readonly _tag: "Failed"; readonly failure: Failure };

/**
 * Whether this browser is signed in, and the request that would change it.
 *
 * - `Unknown`: not yet known, with the `check` that finds out.
 * - `SignedOut`: no sign-in, with the attempt to sign in.
 * - `SignedIn`: a sign-in the Daemon accepts, with the attempt to sign out.
 */
export type SignIn =
  | { readonly _tag: "Unknown"; readonly check: Attempt }
  | { readonly _tag: "SignedOut"; readonly signIn: Attempt }
  | { readonly _tag: "SignedIn"; readonly signOut: Attempt };

/**
 * What happened, in the order it happened.
 *
 * - `CheckStarted`, `Checked`, `CheckFailed`: an authorized read, to find out whether the
 *   browser is signed in. Its answer, `Unauthorized` or not, is `signedIn`.
 * - `SignInStarted`, `SignInSucceeded`, `SignInFailed`: `POST /api/sign-in`.
 * - `SignOutStarted`, `SignOutSucceeded`, `SignOutFailed`: `DELETE /api/sign-in`.
 * - `Refused`: an authorized read answered `Unauthorized`, so the sign-in is gone, as one
 *   signed out in another tab is.
 */
export type SignInEvent =
  | { readonly _tag: "CheckStarted" }
  | { readonly _tag: "Checked"; readonly signedIn: boolean }
  | { readonly _tag: "CheckFailed"; readonly failure: Failure }
  | { readonly _tag: "SignInStarted" }
  | { readonly _tag: "SignInSucceeded" }
  | { readonly _tag: "SignInFailed"; readonly failure: Failure }
  | { readonly _tag: "SignOutStarted" }
  | { readonly _tag: "SignOutSucceeded" }
  | { readonly _tag: "SignOutFailed"; readonly failure: Failure }
  | { readonly _tag: "Refused" };

const idle: Attempt = { _tag: "Idle" };
const waiting: Attempt = { _tag: "Waiting" };
const failed = (failure: Failure): Attempt => ({ _tag: "Failed", failure });

/** Before anything is asked: not known, and no check started. */
export const initial: SignIn = { _tag: "Unknown", check: idle };

const signedOut: SignIn = { _tag: "SignedOut", signIn: idle };
const signedIn: SignIn = { _tag: "SignedIn", signOut: idle };

/**
 * The state after an event, if the state is still the one it answers.
 * @param tag - The state the event belongs to.
 * @param state - The state before.
 * @param after - The state after, if it belongs.
 * @returns `after`, or `state` unchanged.
 */
const only = (tag: SignIn["_tag"], state: SignIn, after: SignIn): SignIn =>
  state._tag === tag ? after : state;

/**
 * The state after an event. An event that does not belong to the state, such as a
 * sign-in answered after the browser was already signed in, leaves it as it was.
 * @param state - The state before.
 * @param event - What happened.
 * @returns The state after.
 */
export const reduce = (state: SignIn, event: SignInEvent): SignIn => {
  switch (event._tag) {
    case "CheckStarted": {
      return only("Unknown", state, { _tag: "Unknown", check: waiting });
    }

    case "Checked": {
      return only("Unknown", state, event.signedIn ? signedIn : signedOut);
    }

    case "CheckFailed": {
      return only("Unknown", state, { _tag: "Unknown", check: failed(event.failure) });
    }

    case "SignInStarted": {
      return only("SignedOut", state, { _tag: "SignedOut", signIn: waiting });
    }

    case "SignInSucceeded": {
      return only("SignedOut", state, signedIn);
    }

    case "SignInFailed": {
      return only("SignedOut", state, { _tag: "SignedOut", signIn: failed(event.failure) });
    }

    case "SignOutStarted": {
      return only("SignedIn", state, { _tag: "SignedIn", signOut: waiting });
    }

    case "SignOutSucceeded": {
      return only("SignedIn", state, signedOut);
    }

    case "SignOutFailed": {
      return only("SignedIn", state, { _tag: "SignedIn", signOut: failed(event.failure) });
    }

    case "Refused": {
      return state._tag === "SignedOut" ? state : signedOut;
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * A failure in words for the Owner, saying what to do about it.
 * @param failure - The failure.
 * @returns One or two sentences.
 */
export const explain = (failure: Failure): string => {
  switch (failure) {
    case "WrongKey": {
      return "That key matches none the Daemon holds. Check it, or make one with iirc key create.";
    }

    case "CrossOrigin": {
      return "The Daemon refused a request it could not tell came from its own address. Open this page from the Daemon's own address.";
    }

    case "NotSaved": {
      return "The Daemon could not save its sign-ins, so nothing changed. Try again.";
    }

    case "Unreachable": {
      return "The Daemon did not answer. Check that it is running, then try again.";
    }

    case "Unexpected": {
      return "The Daemon gave an answer this page could not read. It may be a different version.";
    }

    default: {
      return failure satisfies never;
    }
  }
};
