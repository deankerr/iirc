import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { explain, initial, reduce } from "./sign-in.ts";
import type { Failure, SignIn, SignInEvent } from "./sign-in.ts";

const failures: readonly Failure[] = [
  "WrongKey",
  "CrossOrigin",
  "NotSaved",
  "Unreachable",
  "Unexpected",
];

const failure = fc.constantFrom(...failures);

const anyEvent: fc.Arbitrary<SignInEvent> = fc.oneof(
  fc.constant({ _tag: "CheckStarted" } as const),
  fc.boolean().map((signedIn) => ({ _tag: "Checked", signedIn }) as const),
  failure.map((reason) => ({ _tag: "CheckFailed", failure: reason }) as const),
  fc.constant({ _tag: "SignInStarted" } as const),
  fc.constant({ _tag: "SignInSucceeded" } as const),
  failure.map((reason) => ({ _tag: "SignInFailed", failure: reason }) as const),
  fc.constant({ _tag: "SignOutStarted" } as const),
  fc.constant({ _tag: "SignOutSucceeded" } as const),
  failure.map((reason) => ({ _tag: "SignOutFailed", failure: reason }) as const),
  fc.constant({ _tag: "Refused" } as const)
);

const fold = (events: readonly SignInEvent[], from: SignIn = initial): SignIn => {
  let state = from;

  for (const event of events) {
    state = reduce(state, event);
  }

  return state;
};

describe("sign-in", () => {
  it("starts unknown, with no check started", () => {
    expect(initial).toStrictEqual({ _tag: "Unknown", check: { _tag: "Idle" } });
  });

  it("finds out from a check whether the browser is signed in", () => {
    const checking = fold([{ _tag: "CheckStarted" }]);

    expect({
      checking,
      failed: fold([{ _tag: "CheckStarted" }, { _tag: "CheckFailed", failure: "Unreachable" }]),
      no: reduce(checking, { _tag: "Checked", signedIn: false }),
      yes: reduce(checking, { _tag: "Checked", signedIn: true }),
    }).toStrictEqual({
      checking: { _tag: "Unknown", check: { _tag: "Waiting" } },
      failed: { _tag: "Unknown", check: { _tag: "Failed", failure: "Unreachable" } },
      no: { _tag: "SignedOut", signIn: { _tag: "Idle" } },
      yes: { _tag: "SignedIn", signOut: { _tag: "Idle" } },
    });
  });

  it("checks again after a check failed", () => {
    expect(
      fold([
        { _tag: "CheckStarted" },
        { _tag: "CheckFailed", failure: "Unreachable" },
        { _tag: "CheckStarted" },
        { _tag: "Checked", signedIn: true },
      ])
    ).toStrictEqual({ _tag: "SignedIn", signOut: { _tag: "Idle" } });
  });

  it("signs in, and keeps why a sign-in failed until the next attempt", () => {
    const signedOut = fold([{ _tag: "Checked", signedIn: false }]);

    const wrong = fold(
      [{ _tag: "SignInStarted" }, { _tag: "SignInFailed", failure: "WrongKey" }],
      signedOut
    );

    expect({
      again: reduce(wrong, { _tag: "SignInStarted" }),
      in: fold([{ _tag: "SignInStarted" }, { _tag: "SignInSucceeded" }], wrong),
      wrong,
    }).toStrictEqual({
      again: { _tag: "SignedOut", signIn: { _tag: "Waiting" } },
      in: { _tag: "SignedIn", signOut: { _tag: "Idle" } },
      wrong: { _tag: "SignedOut", signIn: { _tag: "Failed", failure: "WrongKey" } },
    });
  });

  it("signs out, and stays signed in when signing out failed", () => {
    const signedIn = fold([{ _tag: "Checked", signedIn: true }]);

    expect({
      failed: fold(
        [{ _tag: "SignOutStarted" }, { _tag: "SignOutFailed", failure: "NotSaved" }],
        signedIn
      ),
      out: fold([{ _tag: "SignOutStarted" }, { _tag: "SignOutSucceeded" }], signedIn),
      waiting: reduce(signedIn, { _tag: "SignOutStarted" }),
    }).toStrictEqual({
      failed: { _tag: "SignedIn", signOut: { _tag: "Failed", failure: "NotSaved" } },
      out: { _tag: "SignedOut", signIn: { _tag: "Idle" } },
      waiting: { _tag: "SignedIn", signOut: { _tag: "Waiting" } },
    });
  });

  it("is signed out when a read is refused, as after signing out in another tab", () => {
    expect({
      signedIn: fold([{ _tag: "Checked", signedIn: true }, { _tag: "Refused" }]),
      signingOut: fold([
        { _tag: "Checked", signedIn: true },
        { _tag: "SignOutStarted" },
        { _tag: "Refused" },
      ]),
    }).toStrictEqual({
      signedIn: { _tag: "SignedOut", signIn: { _tag: "Idle" } },
      signingOut: { _tag: "SignedOut", signIn: { _tag: "Idle" } },
    });
  });

  it("ignores an answer that does not belong to the state, such as a late check", () => {
    const signedIn = fold([{ _tag: "Checked", signedIn: true }]);
    const signedOut = fold([{ _tag: "Checked", signedIn: false }]);

    expect({
      lateCheck: reduce(signedIn, { _tag: "Checked", signedIn: false }),
      signInWhileIn: reduce(signedIn, { _tag: "SignInFailed", failure: "WrongKey" }),
      signOutWhileOut: reduce(signedOut, { _tag: "SignOutSucceeded" }),
    }).toStrictEqual({
      lateCheck: signedIn,
      signInWhileIn: signedIn,
      signOutWhileOut: signedOut,
    });
  });

  it("is signed in only after a check or a sign-in said so", () => {
    fc.assert(
      fc.property(fc.array(anyEvent, { maxLength: 30 }), (events) => {
        const entries: SignInEvent[] = [];
        let state = initial;

        for (const next of events) {
          const after = reduce(state, next);

          if (state._tag !== "SignedIn" && after._tag === "SignedIn") {
            entries.push(next);
          }

          state = after;
        }

        expect(
          entries.filter(
            (entry) =>
              entry._tag !== "SignInSucceeded" && !(entry._tag === "Checked" && entry.signedIn)
          )
        ).toStrictEqual([]);
      })
    );
  });

  it("is plain data, so a state can be compared and kept", () => {
    fc.assert(
      fc.property(fc.array(anyEvent, { maxLength: 30 }), (events) => {
        const state = fold(events);

        expect(structuredClone(state)).toStrictEqual(state);
      })
    );
  });

  it("explains every failure in words", () => {
    expect(failures.map((each) => explain(each).length > 0)).toStrictEqual(
      failures.map(() => true)
    );
  });
});
