# @iirc/frontend

The pure core of the web frontend ([ADR 0010](../../docs/adr/0010-the-web-frontend-is-a-pure-core-under-react.md)). It holds what a Frontend shows as plain data and reducers, and React in [`apps/web`](../../apps/web/README.md) only renders it. It is pure, as `@iirc/client` is: it reads no clock and no randomness, does no I/O, uses no Effect service, and knows nothing of React or the DOM, which the lint fence enforces. It depends on no other package of ours.

This README is the module's written interface. The types are in `src/`.

## Sign-in

`@iirc/frontend/sign-in`: whether this browser is signed in to the Daemon, as a reducer over what the Frontend asked and what the API answered.

```ts
initial: SignIn                                   // Unknown, with no check started
reduce(state: SignIn, event: SignInEvent): SignIn
explain(failure: Failure): string                 // the failure in words, saying what to do

SignIn =
  | Unknown   { check: Attempt }                  // not yet known
  | SignedOut { signIn: Attempt }
  | SignedIn  { signOut: Attempt }

Attempt = Idle | Waiting | Failed { failure }
Failure = "WrongKey" | "CrossOrigin" | "NotSaved" | "Unreachable" | "Unexpected"
```

| Event                       | From                    | To                        |
| --------------------------- | ----------------------- | ------------------------- |
| `CheckStarted`              | `Unknown`               | `Unknown`, waiting        |
| `Checked { signedIn }`      | `Unknown`               | `SignedIn` or `SignedOut` |
| `CheckFailed { failure }`   | `Unknown`               | `Unknown`, failed         |
| `SignInStarted`             | `SignedOut`             | `SignedOut`, waiting      |
| `SignInSucceeded`           | `SignedOut`             | `SignedIn`                |
| `SignInFailed { failure }`  | `SignedOut`             | `SignedOut`, failed       |
| `SignOutStarted`            | `SignedIn`              | `SignedIn`, waiting       |
| `SignOutSucceeded`          | `SignedIn`              | `SignedOut`               |
| `SignOutFailed { failure }` | `SignedIn`              | `SignedIn`, failed        |
| `Refused`                   | `Unknown` or `SignedIn` | `SignedOut`               |

A check is an authorized read: `Unauthorized` is `Checked { signedIn: false }`, and any answer is `Checked { signedIn: true }`. `Refused` is an authorized read answered `Unauthorized` later, as after signing out in another tab.

Each failure comes from the API's structure, never its text:

| Failure | When |
| --- | --- |
| `WrongKey` | Signing in, `Unauthorized`: the key matches none the Daemon holds |
| `CrossOrigin` | `CrossOrigin`: the Daemon could not tell the request came from its own origin |
| `NotSaved` | `SignInsFailed`: the Daemon could not write its sign-ins, so nothing changed |
| `Unreachable` | No answer came from the Daemon, or a gateway in front of it said it could not reach it |
| `Unexpected` | An answer came that the Frontend could not read |

## What it guarantees

- **It holds no key.** A key goes from the Owner's form to the API in one request. No state here has room for one.
- **Signed in only when the Daemon said so.** Only `Checked { signedIn: true }` and `SignInSucceeded` enter `SignedIn`.
- **An answer that does not belong is ignored.** An event that does not fit the state, such as a late check after a sign-in, leaves the state as it was, so commands that overlap cannot put it somewhere the Daemon never said.
- **One attempt at a time, and why the last one failed.** An attempt is idle, waiting, or failed with a reason, never two of them, and the reason stays until the next attempt starts.
- **Plain data.** A state holds strings, booleans, and plain objects, so it can be compared and kept.

## Tests

`bun run test` runs `src/sign-in.test.ts`: each transition, checking again after a failed check, keeping a failure until the next attempt, signing out failing while staying signed in, `Refused` from signed in and while signing out, ignoring an answer that does not belong, and two properties over any sequence of events: `SignedIn` is entered only after a check or a sign-in said so, and every state survives `structuredClone` unchanged.

## Not yet

- **Timeline windows, the command registry, the keymap, the option tree, and the pane layout,** which [ADR 0010](../../docs/adr/0010-the-web-frontend-is-a-pure-core-under-react.md), [ADR 0012](../../docs/adr/0012-the-web-frontend-builds-on-react-aria-and-resizable-panels.md), and [ADR 0013](../../docs/adr/0013-configuration-is-an-option-tree.md) describe.
