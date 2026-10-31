import { DaemonApi } from "@iirc/api";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { Daemon } from "./daemon.ts";

/** Binds the API contract to the running {@link Daemon}. */
export const handlers = HttpApiBuilder.group(
  DaemonApi,
  "daemon",
  Effect.fn(function* (group) {
    const daemon = yield* Daemon;

    return group
      .handle("status", () => daemon.status)
      .handle("lines", ({ query }) =>
        daemon.lines(query.after ?? 0).pipe(
          Effect.map((entries) =>
            entries.map(({ at, direction, parsed, sequence }) => ({
              at,
              direction,
              sequence,
              text: parsed.text,
              unparseable: parsed._tag === "Unparseable" ? parsed.reason : null,
            }))
          )
        )
      )
      .handle("messages", ({ query }) => daemon.messages(query.after ?? 0))
      .handle("send", ({ payload }) => daemon.send(payload.target, payload.text));
  })
);
