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
import { Duration, Effect, Exit, Layer, Option, Ref, Scope, Sink, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import { OwnerConfiguration } from "./options.ts";
import { isUploadId } from "./uploads/id.ts";
import { knownKinds } from "./uploads/kind.ts";
import { Uploads, switchOf } from "./uploads/uploads.ts";

/**
 * What every answer carries, whatever it is: no sniffing, a sandbox with nothing allowed
 * but downloads, no referrer, and readable from any origin, since Chromium plays top-level
 * media under a sandbox only so, and the listener reads no cookie to give away.
 */
const safety = {
  "access-control-allow-origin": "*",
  "content-security-policy": "sandbox allow-downloads; default-src 'none'",
  "cross-origin-resource-policy": "cross-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

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

/**
 * A `Content-Disposition` naming a file, as RFC 6266 says: an ASCII `filename` for old
 * readers, every other character `_`, and the name itself in `filename*`, as RFC 5987
 * encodes it.
 * @param inline - Whether it is shown in place, rather than downloaded.
 * @param name - The name.
 * @returns The header's value.
 */
const contentDisposition = (inline: boolean, name: string) => {
  const ascii = name.replaceAll(/[^\u0020-\u007E]|["\\]/gu, "_");

  const encoded = encodeURIComponent(name).replaceAll(
    /['()*]/gu,
    (character) => `%${character.codePointAt(0)?.toString(16).toUpperCase()}`
  );

  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
};

/**
 * Whether a type is shown in place: raster images, common audio and video, and plain
 * text. Anything else, and any type no kind has, downloads.
 * @param type - The type the record holds.
 * @returns Whether it is.
 */
const shownInPlace = (type: string) =>
  knownKinds.find((kind) => kind.type === type)?.inline ?? false;

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

  return yield* Effect.gen(function* () {
    const { bytes, record } = yield* uploads.open(UploadId.make(id));

    // The first chunk is read here, inside the error boundary, so a store that is found to
    // be unreachable before any byte arrives answers 503 rather than resetting the
    // Connection. A failure after the first byte can only end the body early, as the
    // status and headers are already sent.
    const [first, rest] = yield* Stream.peel(bytes, Sink.take<Uint8Array>(1));

    return HttpServerResponse.stream(Stream.concat(Stream.fromIterable(first), rest), {
      contentLength: record.size,
      contentType: record.type,
      headers: {
        ...safety,
        "cache-control": "no-cache",
        "content-disposition": contentDisposition(shownInPlace(record.type), record.safeName),
      },
    });
  }).pipe(
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
