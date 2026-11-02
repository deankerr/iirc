import {
  Authorization,
  Caller,
  DaemonApi,
  Forbidden,
  InvalidRequest,
  RequestValidation,
  RequiredScope,
  Unauthorized,
} from "@iirc/api";
import type { LogEntry } from "@iirc/api";
import { parseFrame } from "@iirc/protocol/line";
import type { Entry } from "@iirc/session/entry";
import { ByteSize, Context, Effect, Layer, Redacted } from "effect";
import { HttpIncomingMessage, HttpRouter } from "effect/http";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api";

import { Daemon } from "./daemon.ts";
import { issuesOf } from "./issues.ts";
import { reaches } from "./keys.ts";

/**
 * The largest request body the API reads (AUTH-5). Settings for every Network at once fit
 * many times over, and anything larger is answered `413` before it is read.
 */
export const maxBodySize = ByteSize.mebibytes(1);

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

    case "Change":
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

// Only what a Frontend sent can be a bad request. A response that will not encode is the
// Daemon's fault, and keeps its 500.
const requestValidation = HttpApiMiddleware.layerSchemaErrorTransform(RequestValidation, (error) =>
  error.kind === "Body" || error.kind === "ResponseHeaders"
    ? Effect.fail(error)
    : Effect.fail(
        new InvalidRequest({ issues: issuesOf(error.cause.issue, [error.kind.toLowerCase()]) })
      )
);

// Every request is checked against the keys as they are now, so a revoked key stops
// working on its next request (AUTH-2).
const authorization = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const { authorize } = yield* Daemon;

    return {
      bearer: (handler, { credential, endpoint }) =>
        Effect.gen(function* () {
          const caller = yield* authorize(Redacted.value(credential));

          if (caller === undefined) {
            return yield* new Unauthorized();
          }

          const needed = Context.get(endpoint.annotations, RequiredScope);

          if (!reaches(caller.scope, needed)) {
            return yield* new Forbidden({ needed });
          }

          return yield* Effect.provideService(handler, Caller, caller);
        }),
    };
  })
);

const bodyLimit = HttpRouter.middleware(
  (app) => Effect.provideService(app, HttpIncomingMessage.MaxBodySize, maxBodySize),
  { global: true }
);

const health = HttpApiBuilder.group(DaemonApi, "health", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ status: "ok" as const }))
);

const daemon = HttpApiBuilder.group(
  DaemonApi,
  "daemon",
  Effect.fn(function* (handlers) {
    const { backup, entries, gaps, messages, redact, send, status } = yield* Daemon;

    return handlers
      .handle("status", () => status)
      .handle("backup", () => backup)
      .handle("redact", ({ params }) => Caller.use(({ name }) => redact(name, params.sequence)))
      .handle("entries", ({ query: { kind, ...page } }) =>
        Effect.map(entries(kind === undefined ? page : { ...page, kinds: kind }), (found) =>
          found.map(toLogEntry)
        )
      )
      .handle("messages", ({ query }) => messages(query))
      .handle("gaps", ({ query }) => gaps(query))
      .handle("send", ({ payload }) => Caller.use(({ name }) => send(name, payload)));
  })
);

const configuration = HttpApiBuilder.group(
  DaemonApi,
  "configuration",
  Effect.fn(function* (handlers) {
    const { configuration: current, replaceConfiguration } = yield* Daemon;

    return handlers
      .handle("get", () => current)
      .handle("replace", ({ payload }) =>
        Caller.use(({ name }) => replaceConfiguration(name, payload.networks))
      );
  })
);

const networks = HttpApiBuilder.group(
  DaemonApi,
  "networks",
  Effect.fn(function* (handlers) {
    const operations = yield* Daemon;

    return handlers
      .handle("list", () => operations.networks)
      .handle("get", ({ params }) => operations.network(params.id))
      .handle("add", ({ payload }) =>
        Caller.use(({ name }) => operations.addNetwork(name, payload))
      )
      .handle("change", ({ params, payload }) =>
        Caller.use(({ name }) => operations.changeNetwork(name, params.id, payload))
      )
      .handle("remove", ({ params }) =>
        Caller.use(({ name }) => operations.removeNetwork(name, params.id))
      )
      .handle("connect", ({ params }) =>
        Caller.use(({ name }) => operations.connect(name, params.id))
      )
      .handle("disconnect", ({ params }) =>
        Caller.use(({ name }) => operations.disconnect(name, params.id))
      )
      .handle("join", ({ params, payload }) =>
        Caller.use(({ name }) => operations.join(name, params.id, payload))
      )
      .handle("part", ({ params, payload }) =>
        Caller.use(({ name }) => operations.part(name, params.id, payload))
      );
  })
);

const keys = HttpApiBuilder.group(
  DaemonApi,
  "keys",
  Effect.fn(function* (handlers) {
    const { createKey, keys: held, revokeKey } = yield* Daemon;

    return handlers
      .handle("list", () => held)
      .handle("create", ({ payload }) => Caller.use(({ name }) => createKey(name, payload)))
      .handle("revoke", ({ params }) => Caller.use(({ name }) => revokeKey(name, params.name)));
  })
);

// A value arrives `Redacted` and goes straight to the Daemon, and nothing comes back but
// names, times, and sequences (CRED-2, CRED-3).
const credentials = HttpApiBuilder.group(
  DaemonApi,
  "credentials",
  Effect.fn(function* (handlers) {
    const { credentials: held, deleteCredential, setCredential } = yield* Daemon;

    return handlers
      .handle("list", () => held)
      .handle("set", ({ params, payload }) =>
        Caller.use(({ name }) => setCredential(name, params.name, payload.value))
      )
      .handle("delete", ({ params }) =>
        Caller.use(({ name }) => deleteCredential(name, params.name))
      );
  })
);

/** The API, as routes on the enclosing `HttpRouter`. Needs a running {@link Daemon}. */
export const ApiRoutes = HttpApiBuilder.layer(DaemonApi).pipe(
  Layer.provide(Layer.mergeAll(health, daemon, configuration, networks, keys, credentials)),
  Layer.provide(Layer.mergeAll(requestValidation, authorization)),
  Layer.merge(bodyLimit)
);
