/**
 * The Networks the Daemon runs, as the API lists them.
 *
 * @packageDocumentation
 */
import { reduce } from "@iirc/frontend/sign-in";
import { Effect } from "effect";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { signedIn, signInState } from "../sign-in/atoms.ts";

/**
 * Each Network and whether it runs, read again each time the browser signs in. A read
 * refused as `Unauthorized` means the sign-in is gone, so the browser is signed out.
 */
export const networks = runtime.atom((get) =>
  Effect.gen(function* () {
    // Read for its changes alone: a new sign-in reads the list again.
    get(signedIn);
    const client = yield* DaemonClient;

    return yield* client.networks.list().pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error._tag === "Unauthorized") {
            get.set(signInState, reduce(get.once(signInState), { _tag: "Refused" }));
          }
        })
      )
    );
  })
);
