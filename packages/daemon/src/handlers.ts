/**
 * The handlers of {@link DaemonApi}: each operation, over the Runtime and the Vault, with
 * its errors mapped to the contract's, plus the key check, request validation, and the
 * body limit.
 *
 * @packageDocumentation
 */
import {
  Authorization,
  Caller,
  DaemonApi,
  InvalidRequest,
  JournalFailed,
  NetworkStopped,
  RequestValidation,
  Unauthorized,
  UnknownNetwork,
  VaultFailed,
} from "@iirc/api";
import type { NetworkId as WireNetworkId, NewsEvent } from "@iirc/api";
import { IntentId } from "@iirc/client";
import { Runtime } from "@iirc/runtime";
import type { NetworkStopped as RuntimeNetworkStopped } from "@iirc/runtime";
import { NetworkId, Sequence } from "@iirc/runtime/journal";
import type { JournalFailed as RuntimeJournalFailed } from "@iirc/runtime/journal";
import { Vault } from "@iirc/runtime/vault";
import type { VaultFailed as RuntimeVaultFailed } from "@iirc/runtime/vault";
import {
  ByteSize,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Random,
  Schedule,
  SchemaIssue,
  Stream,
} from "effect";
import { HttpIncomingMessage, HttpRouter, HttpServerError, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api";

import { ApiKeys } from "./keys.ts";
import { happened, knowledge, networkInspection, networkStatus } from "./wire.ts";

/** The largest request body the API reads. Anything larger is refused before it is read. */
export const maxBodySize = ByteSize.mebibytes(1);

/** How often the News stream says it is alive while nothing happens. */
export class Heartbeat extends Context.Reference<Duration.Duration>("@iirc/daemon/Heartbeat", {
  defaultValue: () => Duration.seconds(15),
}) {}

const networkStopped = (network: WireNetworkId, error: RuntimeNetworkStopped, intent?: IntentId) =>
  new NetworkStopped({
    network,
    outcome: "Uncertain",
    reason: error.reason,
    ...(intent !== undefined && { intent }),
  });

const journalFailed = (error: RuntimeJournalFailed) => new JournalFailed({ reason: error.reason });

const vaultFailed = (error: RuntimeVaultFailed) => new VaultFailed({ reason: error.reason });

const unknownNetwork = (error: { readonly network: NetworkId }) =>
  new UnknownNetwork({ network: error.network });

// 128 bits from Effect's Random, as hex. An intent id is unique, not secret. The Daemon
// names it rather than the Runtime, so a `NetworkStopped` can say which to ask `said` about.
const intentId = Effect.map(
  Effect.all(Array.from({ length: 8 }, () => Random.nextIntBetween(0, 0xff_ff))),
  (parts) => IntentId.make(parts.map((part) => part.toString(16).padStart(4, "0")).join(""))
);

// Messages that never quote what was sent, since a request can carry a Credential's value.
const leafHook: SchemaIssue.LeafHook = (issue) =>
  Predicate.hasProperty(issue, "input")
    ? {
        Forbidden: "Forbidden operation",
        InvalidType: "Has the wrong type",
        InvalidValue: "Is not a valid value",
        MissingKey: "Missing key",
        OneOf: "Expected exactly one member to match",
        UnexpectedKey: "Expected no excess property",
      }[issue._tag]
    : SchemaIssue.defaultLeafHook(issue);

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1({ leafHook });

const segment = (part: PropertyKey | { readonly key: PropertyKey }): string | number => {
  const key = Predicate.hasProperty(part, "key") ? part.key : part;

  return Predicate.isNumber(key) ? key : String(key);
};

// Only what a Frontend sent can be a bad request. A response that will not encode is the
// Daemon's fault, and keeps its 500.
const requestValidation = HttpApiMiddleware.layerSchemaErrorTransform(RequestValidation, (error) =>
  error.kind === "Body" || error.kind === "ResponseHeaders"
    ? Effect.fail(error)
    : Effect.fail(
        new InvalidRequest({
          issues: formatIssues(error.cause.issue).issues.map((issue) => ({
            message: issue.message,
            path: [error.kind.toLowerCase(), ...(issue.path ?? []).map(segment)],
          })),
        })
      )
);

const authorization = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const keys = yield* ApiKeys;

    return {
      bearer: (handler, { credential }) =>
        Effect.gen(function* () {
          const found = yield* keys.verify(credential);

          if (Option.isNone(found)) {
            return yield* new Unauthorized();
          }

          return yield* Effect.provideService(handler, Caller, { key: found.value });
        }),
    };
  })
);

const networks = HttpApiBuilder.group(
  DaemonApi,
  "networks",
  Effect.fn(function* (handlers) {
    const runtime = yield* Runtime;

    return handlers
      .handle("list", () =>
        runtime.networks.pipe(
          Effect.map((all) =>
            Array.from(all, ([network, status]) => ({ network, status: networkStatus(status) }))
          )
        )
      )
      .handle("configure", ({ params, payload }) =>
        runtime.configure(NetworkId.make(params.network), payload).pipe(
          Effect.map((sequence) => ({ sequence })),
          Effect.mapError((error) => networkStopped(params.network, error))
        )
      )
      .handle("say", ({ params, payload }) =>
        Effect.gen(function* () {
          const intent = payload.intent ?? (yield* intentId);

          return yield* runtime
            .say(NetworkId.make(params.network), {
              intent,
              kind: payload.kind,
              target: payload.target,
              text: payload.text,
            })
            .pipe(
              Effect.catchTags({
                NetworkStopped: (error) =>
                  Effect.fail(networkStopped(params.network, error, intent)),
                UnknownNetwork: (error) => Effect.fail(unknownNetwork(error)),
              })
            );
        })
      )
      .handle("said", ({ params }) =>
        runtime.said(NetworkId.make(params.network), params.intent).pipe(
          Effect.map(
            Option.match({
              onNone: () => ({ _tag: "NotJournaled" }) as const,
              onSome: (sequence) => ({ _tag: "Journaled", sequence }) as const,
            })
          ),
          Effect.mapError(journalFailed)
        )
      )
      .handle("retry", ({ params }) =>
        runtime.retry(NetworkId.make(params.network)).pipe(
          Effect.map((sequence) => ({ sequence })),
          Effect.catchTags({
            NetworkStopped: (error) => Effect.fail(networkStopped(params.network, error)),
            UnknownNetwork: (error) => Effect.fail(unknownNetwork(error)),
          })
        )
      )
      .handle("known", ({ params }) =>
        runtime
          .known(NetworkId.make(params.network))
          .pipe(Effect.map(knowledge), Effect.mapError(unknownNetwork))
      )
      .handle("inspect", ({ params }) =>
        runtime
          .inspect(NetworkId.make(params.network))
          .pipe(Effect.map(networkInspection), Effect.mapError(unknownNetwork))
      );
  })
);

const news = HttpApiBuilder.group(
  DaemonApi,
  "news",
  Effect.fn(function* (handlers) {
    const runtime = yield* Runtime;

    return handlers.handle("follow", ({ headers, query }) =>
      Effect.gen(function* () {
        const every = yield* Heartbeat;
        // A reconnecting `EventSource` sends `Last-Event-ID` with the URL it first used,
        // so the header is the later place and wins.
        const after = headers["last-event-id"] ?? query.after ?? 0;

        const happenings = runtime.news(after === 0 ? {} : { after: Sequence.make(after) }).pipe(
          Stream.map((one): NewsEvent => ({
            data: happened(one),
            event: "happened",
            id: one.sequence,
          })),
          Stream.mapError(journalFailed)
        );

        const heartbeats = Stream.fromSchedule(Schedule.spaced(every)).pipe(
          Stream.map((): NewsEvent => ({ data: {}, event: "heartbeat" }))
        );

        return Stream.merge(happenings, heartbeats, { haltStrategy: "left" });
      })
    );
  })
);

// A value arrives `Redacted` and goes straight to the Vault, and nothing comes back but
// names.
const credentials = HttpApiBuilder.group(
  DaemonApi,
  "credentials",
  Effect.fn(function* (handlers) {
    const vault = yield* Vault;

    return handlers
      .handle("list", () =>
        vault.names.pipe(
          Effect.map((names) => ({ names: [...names].toSorted() })),
          Effect.mapError(vaultFailed)
        )
      )
      .handle("set", ({ params, payload }) =>
        vault.hold(params.name, payload.value).pipe(
          Effect.tap(() => Effect.logInfo("Held a Credential", { credential: params.name })),
          Effect.mapError(vaultFailed)
        )
      )
      .handle("delete", ({ params }) =>
        vault.forget(params.name).pipe(
          Effect.tap(() => Effect.logInfo("Forgot a Credential", { credential: params.name })),
          Effect.mapError(vaultFailed)
        )
      );
  })
);

// A body over the limit is refused unread, and Bun's graceful stop waits for a client
// still sending one, so the 413 closes its Connection rather than hold up the Daemon's
// shutdown. The limit's error reaches here as a defect.
const bodyLimit = HttpRouter.middleware(
  (app) =>
    app.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, maxBodySize),
      Effect.catchDefect((defect) =>
        defect instanceof HttpServerError.HttpServerError &&
        defect.reason._tag === "RequestParseError" &&
        defect.reason.reason === "BodyTooLarge"
          ? Effect.succeed(
              HttpServerResponse.empty({ headers: { connection: "close" }, status: 413 })
            )
          : Effect.die(defect)
      )
    ),
  { global: true }
);

/** The handler groups, with the key check and request validation, needing the Runtime, the Vault, and the keys. */
export const ApiHandlers = Layer.mergeAll(networks, news, credentials).pipe(
  Layer.provideMerge(Layer.mergeAll(requestValidation, authorization))
);

/** The API, as routes on the enclosing `HttpRouter`, with the body limit. */
export const ApiRoutes = HttpApiBuilder.layer(DaemonApi).pipe(
  Layer.provide(ApiHandlers),
  Layer.merge(bodyLimit)
);
