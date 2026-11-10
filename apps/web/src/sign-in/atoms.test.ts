import { Effect, Redacted } from "effect";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vitest";

import { networks } from "../networks/atoms.ts";
import { fakeDaemon, hasValue, registryFor, run, theKey } from "../testing/fake-daemon.ts";
import { check, signInState, signInWithKey, signOut } from "./atoms.ts";

const signedOut = { _tag: "SignedOut", signIn: { _tag: "Idle" } };
const signedIn = { _tag: "SignedIn", signOut: { _tag: "Idle" } };

describe("signing in", () => {
  it("finds a browser with no sign-in signed out", async () => {
    const { fetch } = fakeDaemon();
    const registry = registryFor(fetch);

    await run(registry, check, undefined);

    expect(registry.get(signInState)).toStrictEqual(signedOut);
  });

  it("signs in with the key, reads the Networks, and keeps no key once answered", async () => {
    const { daemon, fetch } = fakeDaemon();
    const registry = registryFor(fetch);
    const key = Redacted.make(theKey);

    await run(registry, check, undefined);
    await run(registry, signInWithKey, key);

    const listed = await Effect.runPromise(AtomRegistry.getResult(registry, networks));

    expect({
      keysSent: daemon.keysSent,
      listed,
      state: registry.get(signInState),
      wiped: !hasValue(key),
    }).toStrictEqual({
      keysSent: [theKey],
      listed: [{ network: "libera", status: { _tag: "Running" } }],
      state: signedIn,
      wiped: true,
    });
  });

  it("says a key that matches none is the wrong key, and wipes it too", async () => {
    const { fetch } = fakeDaemon();
    const registry = registryFor(fetch);
    const key = Redacted.make("iirc_not-the-key");

    await run(registry, check, undefined);
    await run(registry, signInWithKey, key);

    expect({ state: registry.get(signInState), wiped: !hasValue(key) }).toStrictEqual({
      state: { _tag: "SignedOut", signIn: { _tag: "Failed", failure: "WrongKey" } },
      wiped: true,
    });
  });

  it("says when the Daemon could not save the sign-in", async () => {
    const { daemon, fetch } = fakeDaemon();
    const registry = registryFor(fetch);

    await run(registry, check, undefined);
    daemon.signInsFail = true;
    await run(registry, signInWithKey, Redacted.make(theKey));

    expect(registry.get(signInState)).toStrictEqual({
      _tag: "SignedOut",
      signIn: { _tag: "Failed", failure: "NotSaved" },
    });
  });

  it("signs out, and stays signed in when signing out failed", async () => {
    const { daemon, fetch } = fakeDaemon();
    const registry = registryFor(fetch);

    daemon.signedIn = true;
    await run(registry, check, undefined);
    daemon.signInsFail = true;
    await run(registry, signOut, undefined);
    const failed = registry.get(signInState);

    daemon.signInsFail = false;
    await run(registry, signOut, undefined);

    expect({ daemon: daemon.signedIn, failed, out: registry.get(signInState) }).toStrictEqual({
      daemon: false,
      failed: { _tag: "SignedIn", signOut: { _tag: "Failed", failure: "NotSaved" } },
      out: signedOut,
    });
  });

  it("is signed out when the Networks are refused, as after signing out in another tab", async () => {
    const { daemon, fetch } = fakeDaemon();
    const registry = registryFor(fetch);

    daemon.signedIn = true;
    await run(registry, check, undefined);
    daemon.signedIn = false;
    await Effect.runPromise(AtomRegistry.getResult(registry, networks).pipe(Effect.ignore));

    expect(registry.get(signInState)).toStrictEqual(signedOut);
  });

  it("says the Daemon did not answer, directly or through a gateway, and checks again", async () => {
    const { daemon, fetch } = fakeDaemon();
    const registry = registryFor(fetch);

    daemon.down = true;
    await run(registry, check, undefined);
    const down = registry.get(signInState);

    daemon.down = false;
    daemon.gatewayOnly = true;
    await run(registry, check, undefined);
    const gateway = registry.get(signInState);

    daemon.gatewayOnly = false;
    await run(registry, check, undefined);

    expect({ again: registry.get(signInState), down, gateway }).toStrictEqual({
      again: signedOut,
      down: { _tag: "Unknown", check: { _tag: "Failed", failure: "Unreachable" } },
      gateway: { _tag: "Unknown", check: { _tag: "Failed", failure: "Unreachable" } },
    });
  });
});
