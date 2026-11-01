import { DaemonApi } from "@iirc/api";
import type { LogEntry } from "@iirc/api";
import { parseFrame } from "@iirc/protocol/line";
import type { Entry } from "@iirc/session/entry";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { Daemon } from "./daemon.ts";

// A Frontend never has to parse IRC, or even guess at an encoding (API-2), and input
// that cannot be parsed comes with its reason (HOST-1).
const toLogEntry = (entry: Entry): LogEntry => {
  if (entry._tag !== "Line") {
    return entry;
  }

  const parsed = parseFrame(entry.bytes);

  return {
    ...entry,
    text: parsed.text,
    ...(parsed._tag === "Unparseable" && { reason: parsed.reason }),
  };
};

const health = HttpApiBuilder.group(DaemonApi, "health", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ status: "ok" as const }))
);

const daemon = HttpApiBuilder.group(
  DaemonApi,
  "daemon",
  Effect.fn(function* (handlers) {
    const { entries, messages, send, status } = yield* Daemon;

    return handlers
      .handle("status", () => status)
      .handle("entries", ({ query }) => Effect.map(entries(query), (page) => page.map(toLogEntry)))
      .handle("messages", ({ query }) => messages(query))
      .handle("send", ({ payload }) => send(payload));
  })
);

/** The API, as routes on the enclosing `HttpRouter`. Needs a running {@link Daemon}. */
export const ApiRoutes = HttpApiBuilder.layer(DaemonApi).pipe(
  Layer.provide(Layer.mergeAll(health, daemon))
);
