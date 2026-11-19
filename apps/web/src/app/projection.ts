/**
 * Whether the Daemon is still folding the Timelines, as its stream says, which a failure
 * stops until the Daemon restarts, so what the page shows falls behind.
 *
 * @packageDocumentation
 */
import type { Projection } from "@iirc/api";
import { Effect, Schedule, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { signedIn } from "../sign-in/atoms.ts";
import { retrying, Waits } from "../timelines/atoms.ts";
import { DaemonClient } from "./daemon-client.ts";
import { runtime } from "./runtime.ts";

/**
 * The Daemon's word on the projection, followed while the page is signed in. Whenever the
 * stream ends, as when the Daemon restarts, or gives nothing for longer than three
 * heartbeats, it is followed again, and the Daemon says it afresh as the stream opens. A
 * failure is tried again, a refusal too, until what follows the other streams signs the
 * page out, which ends it.
 */
const followed = runtime.atom((get) =>
  get(signedIn)
    ? Stream.unwrap(
        Effect.gen(function* () {
          const client = yield* DaemonClient;
          const { idle, reconnect } = yield* Waits;
          const schedule = yield* retrying;

          return Stream.unwrap(client.timelines.projection().pipe(Effect.timeout(idle))).pipe(
            Stream.timeout(idle),
            Stream.retry(schedule),
            Stream.repeat(Schedule.spaced(reconnect)),
            Stream.filter((event) => event.event === "projection"),
            Stream.map((event): Projection => event.data)
          );
        })
      )
    : Stream.empty
);

/**
 * Why the Daemon stopped folding the Timelines, or `undefined` while it folds them or has
 * not yet said. Its last word holds while the stream is followed again.
 */
export const projectionStopped = Atom.make((get) => {
  const said = AsyncResult.value(get(followed));

  return said._tag === "Some" && said.value._tag === "Stopped" ? said.value.reason : undefined;
});
