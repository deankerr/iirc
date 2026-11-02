import { DaemonApi, InvalidRequest, RequestValidation } from "@iirc/api";
import type { LogEntry } from "@iirc/api";
import { parseFrame } from "@iirc/protocol/line";
import type { Entry } from "@iirc/session/entry";
import { Effect, Layer, Predicate, SchemaIssue } from "effect";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api";
import type { HttpApiError } from "effect/http-api";

import { Daemon } from "./daemon.ts";

// A Frontend never has to parse IRC, or even guess at an encoding (API-2), and input
// that cannot be parsed comes with its reason (HOST-1).
const toLogEntry = (entry: Entry): LogEntry => {
  switch (entry._tag) {
    case "Dropped": {
      return { ...entry, text: parseFrame(entry.bytes).text };
    }

    case "Line": {
      const parsed = parseFrame(entry.bytes);

      return {
        ...entry,
        text: parsed.text,
        ...(parsed._tag === "Unparseable" && { reason: parsed.reason }),
      };
    }

    case "Connection":
    case "Daemon":
    case "Deadline": {
      return entry;
    }

    default: {
      return entry satisfies never;
    }
  }
};

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

const issuesOf = ({ cause, kind }: HttpApiError.HttpApiSchemaError) =>
  formatIssues(cause.issue).issues.map(({ message, path = [] }) => ({
    message,
    path: [
      kind.toLowerCase(),
      ...path.map((segment) => {
        // A segment is a key, or a record that holds one, and an index stays a number.
        const key = Predicate.hasProperty(segment, "key") ? segment.key : segment;

        return Predicate.isNumber(key) ? key : String(key);
      }),
    ],
  }));

// Only what a Frontend sent can be a bad request. A response that will not encode is the
// Daemon's fault, and keeps its 500.
const requestValidation = HttpApiMiddleware.layerSchemaErrorTransform(RequestValidation, (error) =>
  error.kind === "Body" || error.kind === "ResponseHeaders"
    ? Effect.fail(error)
    : Effect.fail(new InvalidRequest({ issues: issuesOf(error) }))
);

const health = HttpApiBuilder.group(DaemonApi, "health", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ status: "ok" as const }))
);

const daemon = HttpApiBuilder.group(
  DaemonApi,
  "daemon",
  Effect.fn(function* (handlers) {
    const { entries, gaps, messages, send, status } = yield* Daemon;

    return handlers
      .handle("status", () => status)
      .handle("entries", ({ query }) => Effect.map(entries(query), (page) => page.map(toLogEntry)))
      .handle("messages", ({ query }) => messages(query))
      .handle("gaps", ({ query }) => gaps(query))
      .handle("send", ({ payload }) => send(payload));
  })
);

/** The API, as routes on the enclosing `HttpRouter`. Needs a running {@link Daemon}. */
export const ApiRoutes = HttpApiBuilder.layer(DaemonApi).pipe(
  Layer.provide(Layer.mergeAll(health, daemon)),
  Layer.provide(requestValidation)
);
