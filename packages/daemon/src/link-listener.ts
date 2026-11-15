/**
 * The link listener: a second HTTP server of the Daemon's, never a route of the API, which
 * serves each Upload at its link and does nothing else. It is bound at `uploads.listen`
 * while Uploads are on and that is set, rebound when it changes, and closed when either
 * stops being so, all derived from the options in force as they change.
 *
 * It answers `GET` and `HEAD` of `/<id>/<anything>`, by the id alone, and everything else
 * with 404. It reads no cookie and no key, ignores the host a request names, and offers no
 * listing or index. Every answer carries headers that stop what it serves from acting in a
 * reader's browser.
 *
 * @packageDocumentation
 */
import { BunHttpServer } from "@effect/platform-bun";
import { UploadId } from "@iirc/api";
import type { ListenAddress } from "@iirc/api";
import { Duration, Effect, Exit, Layer, Option, Ref, Scope, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import { OwnerConfiguration } from "./options.ts";
import { isUploadId } from "./uploads/id.ts";
import { safety, servedUpload } from "./uploads/serving.ts";
import { Uploads, switchOf } from "./uploads/uploads.ts";

/**
 * A plain answer with no Upload in it.
 * @param status - Its status.
 * @param text - Its body.
 * @param cache - Its `Cache-Control`.
 * @returns The response.
 */
const plain = (status: number, text: string, cache: string) =>
  HttpServerResponse.text(text, {
    contentType: "text/plain; charset=utf-8",
    headers: { ...safety, "cache-control": cache, "content-disposition": "inline" },
    status,
  });

const notFound = plain(404, "Not found\n", "no-cache");

const unavailable = plain(503, "The store is unavailable\n", "no-store");

// `/<id>/<anything>`, with the id the first segment and something after it.
const linkPath = /^\/(?<id>[^/]+)\/.+$/u;

/** Answers one request to the link listener. */
const answer = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const uploads = yield* Uploads;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return notFound;
  }

  const id = linkPath.exec(request.url.split("?")[0] ?? "")?.groups?.id;

  if (id === undefined || !isUploadId(id)) {
    return notFound;
  }

  return yield* uploads.open(UploadId.make(id)).pipe(
    Effect.flatMap(servedUpload),
    Effect.catchTags({
      ByteStoreUnavailable: () => Effect.succeed(unavailable),
      NoSuchUpload: () => Effect.succeed(notFound),
    })
  );
});

/**
 * The host and port of a listen address, the brackets of an IPv6 host removed.
 * @param address - The address.
 * @returns Where to bind.
 */
const hostAndPort = (address: ListenAddress) => {
  const colon = address.lastIndexOf(":");
  const host = address.slice(0, colon);

  return {
    hostname: host.startsWith("[") ? host.slice(1, -1) : host,
    port: Number(address.slice(colon + 1)),
  };
};

/** How long closing a binding waits for answers in flight before it cuts them. */
const gracefulShutdownTimeout = Duration.millis(500);

/**
 * Serves the link listener at an address for as long as the Scope lives.
 * @param address - Where.
 * @returns An Effect that binds it.
 */
const serveAt = (address: ListenAddress) =>
  Effect.gen(function* () {
    const uploads = yield* Uploads;
    const server = yield* BunHttpServer.make({ ...hostAndPort(address), gracefulShutdownTimeout });

    yield* server.serve(Effect.provideService(answer, Uploads, uploads));
    yield* Effect.logInfo("Serving Uploads' links", { listen: address });
  });

/**
 * The link listener, following the options in force for as long as the Layer lives. A
 * binding that fails, such as an address already in use, is logged, and the listener stays
 * closed until the options change again.
 */
export const layerLinkListener = Layer.effectDiscard(
  Effect.gen(function* () {
    const owner = yield* OwnerConfiguration;
    const uploads = yield* Uploads;

    // Where it should be bound, from each options in force, once for each change of it.
    const addresses = owner.changes.pipe(
      Stream.map(({ options }) => {
        const now = switchOf(options);

        return now._tag === "On" ? now.listen : undefined;
      }),
      Stream.changes
    );

    // The binding's Scope, while it is bound.
    const bound = yield* Ref.make(Option.none<Scope.Closeable>());

    const unbind = Ref.getAndSet(bound, Option.none()).pipe(
      Effect.flatMap((closing) =>
        Option.isSome(closing) ? Scope.close(closing.value, Exit.void) : Effect.void
      )
    );

    // Each change closes the binding before it, so a rebind to the same port finds it free.
    const follow = (address: ListenAddress | undefined) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* unbind;

          if (address === undefined) {
            return;
          }

          const scope = yield* Scope.make();

          const exit = yield* Effect.exit(
            serveAt(address).pipe(Scope.provide(scope), Effect.provideService(Uploads, uploads))
          );

          if (Exit.isSuccess(exit)) {
            yield* Ref.set(bound, Option.some(scope));
          } else {
            yield* Scope.close(scope, exit);
            yield* Effect.logError("Could not serve Uploads' links", { listen: address });
          }
        })
      );

    yield* Effect.addFinalizer(() => unbind);
    yield* addresses.pipe(Stream.runForEach(follow), Effect.forkScoped);
  })
);
