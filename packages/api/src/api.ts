/**
 * The contract every Frontend drives the Daemon through. Every route is under `/api`, and
 * every one but signing a browser in and out needs a key or a sign-in.
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
  CrossOrigin,
  InvalidRequest,
  JournalFailed,
  NetworkStopped,
  SignInsFailed,
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
  SignInRequest,
} from "./schemas.ts";

/**
 * How the API parses a request: a key nothing reads, such as a misspelt field of a
 * Configuration, is an issue at its path, never a setting silently left out.
 */
export const requestParseOptions = { onExcessProperty: "error" } as const;

/**
 * The name of the key a request came with, or that its sign-in was made with,
 * which its handler acts for.
 */
export class Caller extends Context.Service<Caller, { readonly key: string }>()(
  "@iirc/api/Caller"
) {}

/** The cookie a sign-in travels in. It names the sign-in, never a key. */
export const signInCookie = "iirc_sign_in";

/**
 * Checks the key in `Authorization: Bearer`, or else the sign-in in the
 * {@link signInCookie} cookie, and provides {@link Caller} either way. A request the
 * cookie carries that changes something must come from the Daemon's own origin, or it is
 * {@link CrossOrigin}.
 */
// oxlint-disable-next-line effecttsgo/leaking-requirements -- A security middleware runs inside the request, which it may read, as Effect's own `HttpApiMiddlewareSecurity` type says.
export class Authorization extends HttpApiMiddleware.Service<Authorization, { provides: Caller }>()(
  "@iirc/api/Authorization",
  {
    error: [Unauthorized, CrossOrigin],
    requiredForClient: true,
    security: {
      bearer: HttpApiSecurity.bearer,
      signIn: HttpApiSecurity.apiKey({ in: "cookie", key: signInCookie }),
    },
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

/**
 * A browser signs in: it gives a key once, for a sign-in in an `HttpOnly`
 * cookie, since a browser never holds a key in script and an `EventSource` cannot send
 * `Authorization`. Neither route needs the key check, since this is where a browser gets
 * what it presents.
 */
export class SignInGroup extends HttpApiGroup.make("signIn").add(
  HttpApiEndpoint.post("signIn", "/sign-in", {
    error: [Unauthorized, CrossOrigin, SignInsFailed],
    payload: SignInRequest,
    success: HttpApiSchema.NoContent,
  }),
  HttpApiEndpoint.delete("signOut", "/sign-in", {
    error: [CrossOrigin, SignInsFailed],
    success: HttpApiSchema.NoContent,
  })
) {}

/** The Daemon's API. */
export class DaemonApi extends HttpApi.make("iirc")
  .add(SignInGroup)
  .add(NetworksGroup)
  .add(NewsGroup)
  .add(CredentialsGroup)
  .middleware(RequestValidation)
  .annotate(HttpApi.PayloadParseOptions, requestParseOptions)
  .prefix("/api")
  .annotateMerge(OpenApi.annotations({ title: "iirc Daemon" })) {}
