/**
 * The Daemon's API, as a typed client.
 *
 * @packageDocumentation
 */
import { Authorization, DaemonApi } from "@iirc/api";
import { Context, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient, HttpApiMiddleware } from "effect/http-api";

/** The typed client of every route the Daemon serves. */
export class DaemonClient extends Context.Service<
  DaemonClient,
  HttpApiClient.ForApi<typeof DaemonApi>
>()("@iirc/web/DaemonClient") {}

// A browser presents its sign-in in the cookie, which `fetch` sends to the page's own
// origin by itself, and never a key: the client side of the key check adds nothing.
const presentingSignIn = HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
  next(request)
);

/**
 * The client over `fetch`. Without `baseUrl` its URLs are relative, so they reach the
 * origin that served the page, which is the Daemon's in every shape (ADR 0007).
 * @param baseUrl - Where the Daemon is, for a client outside a page, such as a test's.
 * @returns The Layer.
 */
export const layerDaemonClient = (baseUrl?: string) =>
  Layer.effect(DaemonClient, HttpApiClient.make(DaemonApi, { baseUrl })).pipe(
    Layer.provide(Layer.merge(presentingSignIn, FetchHttpClient.layer))
  );
