/**
 * The contract every Frontend drives the Daemon through. Every route is under `/api`, and
 * every one needs a key.
 *
 * @packageDocumentation
 */
import { NetworkConfiguration } from "@iirc/client";
import { Context, Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  OpenApi,
} from "effect/http-api";

import {
  InvalidRequest,
  JournalFailed,
  NetworkStopped,
  Unauthorized,
  UnknownNetwork,
  VaultFailed,
} from "./errors.ts";
import {
  After,
  CallerIntent,
  CredentialNames,
  CredentialPathName,
  CredentialValue,
  Journaled,
  Knowledge,
  NetworkEntry,
  NetworkId,
  NetworkInspection,
  NewsEvent,
  Said,
  SaidAnswer,
  SayRequest,
} from "./schemas.ts";

/**
 * How the API parses a request: a key nothing reads, such as a misspelt field of a
 * Configuration, is an issue at its path, never a setting silently left out.
 */
export const requestParseOptions = { onExcessProperty: "error" } as const;

/** The name of the key a request came with, which its handler acts for. */
export class Caller extends Context.Service<Caller, { readonly key: string }>()(
  "@iirc/api/Caller"
) {}

/** Checks the key in `Authorization: Bearer`, and nowhere else, and provides {@link Caller}. */
export class Authorization extends HttpApiMiddleware.Service<Authorization, { provides: Caller }>()(
  "@iirc/api/Authorization",
  {
    error: Unauthorized,
    requiredForClient: true,
    security: { bearer: HttpApiSecurity.bearer },
  }
) {}

/** Turns a request that fails to decode into an {@link InvalidRequest}. */
export class RequestValidation extends HttpApiMiddleware.Service<RequestValidation>()(
  "@iirc/api/RequestValidation",
  { error: InvalidRequest }
) {}

const NetworkPath = { network: NetworkId };

/** Networks: their Configuration, what they are told to say, and what they know. */
export class NetworksGroup extends HttpApiGroup.make("networks")
  .add(
    HttpApiEndpoint.get("list", "/networks", { success: Schema.Array(NetworkEntry) }),
    HttpApiEndpoint.put("configure", "/networks/:network", {
      error: NetworkStopped,
      params: NetworkPath,
      payload: NetworkConfiguration,
      success: Journaled,
    }),
    HttpApiEndpoint.post("say", "/networks/:network/say", {
      error: [UnknownNetwork, NetworkStopped],
      params: NetworkPath,
      payload: SayRequest,
      success: Said,
    }),
    HttpApiEndpoint.get("said", "/networks/:network/said/:intent", {
      error: JournalFailed,
      params: { intent: CallerIntent, network: NetworkId },
      success: SaidAnswer,
    }),
    HttpApiEndpoint.post("retry", "/networks/:network/retry", {
      error: [UnknownNetwork, NetworkStopped],
      params: NetworkPath,
      success: Journaled,
    }),
    HttpApiEndpoint.get("known", "/networks/:network/known", {
      error: UnknownNetwork,
      params: NetworkPath,
      success: Knowledge,
    }),
    HttpApiEndpoint.get("inspect", "/networks/:network/inspect", {
      error: UnknownNetwork,
      params: NetworkPath,
      success: NetworkInspection,
    })
  )
  .middleware(Authorization) {}

/**
 * The News of every Network, as Server-Sent Events, from just after `after`, or the
 * `Last-Event-ID` header when a reconnecting `EventSource` sends it, and then live.
 */
export class NewsGroup extends HttpApiGroup.make("news")
  .add(
    HttpApiEndpoint.get("follow", "/news", {
      headers: { "last-event-id": Schema.optionalKey(After) },
      query: { after: Schema.optionalKey(After) },
      success: HttpApiSchema.StreamSse({ error: JournalFailed, events: NewsEvent }),
    })
  )
  .middleware(Authorization) {}

/** Credentials, by name. A value goes in, and only names come out. */
export class CredentialsGroup extends HttpApiGroup.make("credentials")
  .add(
    HttpApiEndpoint.get("list", "/credentials", { error: VaultFailed, success: CredentialNames }),
    HttpApiEndpoint.put("set", "/credentials/:name", {
      error: VaultFailed,
      params: { name: CredentialPathName },
      payload: CredentialValue,
      success: HttpApiSchema.NoContent,
    }),
    HttpApiEndpoint.delete("delete", "/credentials/:name", {
      error: VaultFailed,
      params: { name: CredentialPathName },
      success: HttpApiSchema.NoContent,
    })
  )
  .middleware(Authorization) {}

/** The Daemon's API. */
export class DaemonApi extends HttpApi.make("iirc")
  .add(NetworksGroup)
  .add(NewsGroup)
  .add(CredentialsGroup)
  .middleware(RequestValidation)
  .annotate(HttpApi.PayloadParseOptions, requestParseOptions)
  .prefix("/api")
  .annotateMerge(OpenApi.annotations({ title: "iirc Daemon" })) {}
