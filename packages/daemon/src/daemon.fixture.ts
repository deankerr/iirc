import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { DaemonApi } from "@iirc/api";
import type { KeyScope, NetworkStatus } from "@iirc/api";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import type { HttpClientResponse } from "effect/http";
import { HttpApiClient } from "effect/http-api";

import { Credentials } from "./credentials.ts";
import type { Keyring } from "./credentials.ts";
import { createLocalKey, Daemon } from "./daemon.ts";
import { ApiRoutes } from "./routes.ts";

/** The name of the key every test harness starts with, which causes carry (LOG-5). */
export const ownerKey = "owner";

/** The Daemon's version under test. */
export const version = "1.2.3";

/**
 * A keyring that is never there, as on fserv, so that a test keeps Credentials in the file
 * on whatever machine it runs, and never touches the Owner's own keyring.
 */
export const noKeyring: Keyring = {
  get: async () => await Promise.reject(new Error("no keyring here")),
  set: async () => {
    await Promise.reject(new Error("no keyring here"));
  },
};

/**
 * Credentials in a data directory's file, for a test that builds the Daemon's Layers
 * itself.
 * @param dataDir - The data directory.
 * @returns The Layer, which needs the Log.
 */
export const credentialsIn = (dataDir: string) =>
  Credentials.layer({ dataDir, keyring: noKeyring });

/**
 * Creates a key straight into a Log no Daemon holds, as `iirc key create` does (AUTH-4).
 * @param dataDir - The Daemon's data directory.
 * @param name - The key's name.
 * @param scope - What it may do.
 * @returns The key.
 */
export const localKey = (dataDir: string, name = ownerKey, scope: KeyScope = "admin") =>
  Effect.orDie(createLocalKey({ dataDir, name, scope }));

/**
 * Builds a typed client that sends a key with every request, the only way it may travel
 * (AUTH-6).
 * @param key - The key.
 * @returns The client.
 */
export const clientWith = (key: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((httpClient) =>
      HttpApiClient.makeWith(DaemonApi, {
        httpClient: HttpClient.mapRequest(httpClient, HttpClientRequest.bearerToken(key)),
      })
    )
  );

/** A typed client of the API. */
export type Client = Effect.Success<ReturnType<typeof clientWith>>;

/**
 * One Network's part of `/status`.
 * @param client - A client with a `read` key.
 * @param id - The Network.
 * @returns Its status, which a test that expects it to be there can rely on.
 */
export const statusOf = (client: Client, id: string) =>
  Effect.flatMap(client.daemon.status(), ({ networks }) => {
    const found = networks.find((network) => network.id === id);

    return found === undefined
      ? Effect.die(new Error(`${id} is not in /status`))
      : Effect.succeed<NetworkStatus>(found);
  });

/**
 * Serves the API over a Daemon in the same order as `apps/iirc`, so this also proves the
 * Log is built once.
 * @param core - The Daemon.
 * @returns The Layer, with a test HTTP client pointed at it.
 */
export const servingWith = <E, R>(core: Layer.Layer<Daemon, E, R>) =>
  Daemon.stopsFirst.pipe(
    Layer.provideMerge(
      HttpRouter.serve(ApiRoutes, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provideMerge(BunHttpServer.layerTest)
      )
    ),
    Layer.provide(core)
  );

/**
 * Runs a test in a data directory of its own, removed afterwards. It is under `/var/tmp`,
 * because `/tmp` is tmpfs here, where fsync means nothing.
 * @param test - The test, given the directory.
 * @returns The test, scoped.
 */
export const inTempDirectory = <A, E, R>(test: (dataDir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return yield* test(
      yield* fileSystem.makeTempDirectoryScoped({ directory: "/var/tmp", prefix: "iirc-daemon-" })
    );
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

/** Requests the typed client would refuse to make, as any other Frontend could. */
export interface RawRequests {
  readonly delete: (path: string) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
  readonly get: (path: string) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
  readonly post: (
    path: string,
    body: Schema.Json
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
  readonly postText: (
    path: string,
    text: string
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
  readonly put: (
    path: string,
    body: Schema.Json
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
}

/**
 * Raw requests, with a key or with none.
 * @param key - What to send in `Authorization: Bearer`, if anything.
 * @returns The requests, which never fail on an HTTP status.
 */
export const rawWith = (key?: string) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;

    const send = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.orDie(
        httpClient.execute(
          key === undefined ? request : HttpClientRequest.bearerToken(request, key)
        )
      );

    return {
      delete: (path) => send(HttpClientRequest.delete(path)),
      get: (path) => send(HttpClientRequest.get(path)),
      post: (path, body) =>
        send(HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(path), body)),
      postText: (path, text) =>
        send(HttpClientRequest.bodyText(HttpClientRequest.post(path), text, "application/json")),
      put: (path, body) =>
        send(HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.put(path), body)),
    } satisfies RawRequests;
  });

const InvalidRequestBody = Schema.TaggedStruct("InvalidRequest", {
  issues: Schema.NonEmptyArray(
    Schema.Struct({
      message: Schema.String,
      path: Schema.Array(Schema.Union([Schema.String, Schema.Int])),
    })
  ),
});

/**
 * Checks that a request was refused as bad, with a tagged body that says where (API-3).
 * @param response - The response.
 * @returns What the body said was wrong.
 */
export const invalidRequest = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    if (response.status !== 400) {
      return yield* Effect.die(
        new Error(`expected 400, got ${response.status}: ${yield* Effect.orDie(response.text)}`)
      );
    }

    return yield* Schema.decodeUnknownEffect(InvalidRequestBody)(
      yield* Effect.orDie(response.json)
    );
  });
