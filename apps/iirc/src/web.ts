/**
 * The web frontend's built files, served beside the API on its origin by
 * `iirc daemon --web` (ADR 0007). Only this executable knows both: the Daemon serves these
 * routes without knowing what they are.
 *
 * @packageDocumentation
 */
import type { Beside } from "@iirc/daemon";
import { Data, Effect, FileSystem, Layer, Option, Path } from "effect";
import { HttpPlatform, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

/** The web frontend's directory cannot be served, so the Daemon does not start. */
class WebFrontendUnusable extends Data.TaggedError("WebFrontendUnusable")<{
  readonly directory: string;
  readonly reason: string;
}> {}

/**
 * What the page may load, and from where: its own origin only, never a frame of another
 * page, and no inline script or style.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

/** A file Vite named by a hash of its content, under `assets/`, never changes. */
const forever = "public, max-age=31536000, immutable";

/** Everything else, `index.html` above all, is checked again on every load. */
const revalidate = "no-cache";

const securityHeaders = {
  "content-security-policy": contentSecurityPolicy,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** The types of the files a Vite build holds. Anything else is served as bytes. */
const contentTypes = new Map([
  ["css", "text/css; charset=utf-8"],
  ["html", "text/html; charset=utf-8"],
  ["ico", "image/x-icon"],
  ["js", "text/javascript; charset=utf-8"],
  ["json", "application/json; charset=utf-8"],
  ["map", "application/json; charset=utf-8"],
  ["png", "image/png"],
  ["svg", "image/svg+xml; charset=utf-8"],
  ["txt", "text/plain; charset=utf-8"],
  ["webmanifest", "application/manifest+json"],
  ["woff2", "font/woff2"],
]);

/**
 * A request target as the path it names, as segments: the query dropped, escapes decoded,
 * empty segments from repeated slashes dropped, and `.` and `..` resolved, never above the
 * root. The target is only ever read as a path, so no part of it is taken for a host. A
 * target that is not a path, cannot be decoded, or holds a backslash or a NUL names nothing.
 * @param target - The request target, such as `/assets/app.js?v=1`.
 * @returns The segments, or `undefined` when it names nothing.
 */
const pathOf = (target: string): readonly string[] | undefined => {
  const [raw = ""] = target.split(/[?#]/u, 1);

  if (!raw.startsWith("/")) {
    return undefined;
  }

  let decoded: string;

  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }

  if (decoded.includes("\\") || decoded.includes("\0")) {
    return undefined;
  }

  const segments: string[] = [];

  for (const segment of decoded.split("/")) {
    if (segment === "..") {
      segments.pop();
    } else if (segment !== "" && segment !== ".") {
      segments.push(segment);
    }
  }

  return segments;
};

/**
 * Whether a request is the browser opening a page, rather than loading a file: it asks for
 * HTML, and its last segment names no file extension.
 * @param request - The request.
 * @param segments - Its path.
 * @returns Whether `index.html` answers it when no file does.
 */
const isNavigation = (request: HttpServerRequest.HttpServerRequest, segments: readonly string[]) =>
  (request.headers.accept ?? "").toLowerCase().includes("text/html") &&
  !(segments.at(-1) ?? "").includes(".");

const notFound = HttpServerResponse.empty({ status: 404 });

/**
 * The routes that serve the web frontend from a directory, once the directory is known to
 * hold an `index.html` that can be read.
 *
 * Every request target is read once, as a path, and that one path decides everything:
 * whether it is the API's, which file answers it, and how long that file may be kept.
 * Nothing under `/api` is ever served from here, so a mistyped API path stays the API's own
 * empty 404. A file is served only when its canonical path, every symbolic link followed,
 * lies inside the directory's canonical path, checked on every request, since the files
 * may change while the Daemon runs. A navigation to a path with no file gets `index.html`.
 * @param directory - The built web frontend, such as `apps/web/dist`.
 * @returns The routes, or why the directory cannot be served.
 */
export const layerWeb = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const unusable = (reason: string) => new WebFrontendUnusable({ directory, reason });

  const root = yield* fs
    .realPath(directory)
    .pipe(
      Effect.mapError((error) =>
        unusable(error.reason._tag === "NotFound" ? "it holds no index.html" : error.message)
      )
    );

  /**
   * The canonical path of a file inside the directory, if it is one.
   * @param segments - Its path under the directory.
   * @returns The canonical path, or nothing when it is missing, not a file, or outside.
   */
  const fileAt = (segments: readonly string[]) =>
    fs.realPath(path.join(root, ...segments)).pipe(
      Effect.flatMap((real) =>
        real.startsWith(`${root}${path.sep}`)
          ? fs
              .stat(real)
              .pipe(
                Effect.map((info) => (info.type === "File" ? Option.some(real) : Option.none()))
              )
          : Effect.succeed(Option.none<string>())
      ),
      Effect.orElseSucceed(() => Option.none<string>())
    );

  const index = yield* fileAt(["index.html"]);

  if (Option.isNone(index)) {
    return yield* unusable("it holds no index.html");
  }

  yield* fs
    .access(index.value, { readable: true })
    .pipe(Effect.mapError((error) => unusable(error.message)));

  /**
   * A file as a response, with its type, its cache header, and the security headers.
   * @param file - Its canonical path.
   * @param cacheControl - How long it may be kept.
   * @returns The response, or a 404 when it cannot be read.
   */
  const serve = (file: string, cacheControl: string) =>
    HttpServerResponse.file(file, {
      contentType:
        contentTypes.get(path.extname(file).slice(1).toLowerCase()) ?? "application/octet-stream",
    }).pipe(
      Effect.map((response) =>
        HttpServerResponse.setHeaders(response, {
          ...securityHeaders,
          "cache-control": cacheControl,
        })
      ),
      Effect.orElseSucceed(() => notFound)
    );

  const handler = HttpServerRequest.HttpServerRequest.use((request) => {
    const segments = pathOf(request.url);

    // A target that names nothing, and a path under `/api` the API does not have, are
    // answered as the router answers any route it does not have: an empty 404, exactly as
    // without `--web`.
    if (segments === undefined || segments[0] === "api") {
      return Effect.succeed(notFound);
    }

    const wanted = segments.length === 0 ? ["index.html"] : segments;

    return fileAt(wanted).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            isNavigation(request, segments)
              ? fileAt(["index.html"]).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.succeed(notFound),
                      onSome: (file) => serve(file, revalidate),
                    })
                  )
                )
              : Effect.succeed(notFound),
          onSome: (file) => serve(file, wanted[0] === "assets" ? forever : revalidate),
        })
      )
    );
  });

  const routes: Beside<never> = Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      const platform = yield* HttpPlatform.HttpPlatform;

      yield* router.add(
        "GET",
        "/*",
        handler.pipe(Effect.provideService(HttpPlatform.HttpPlatform, platform))
      );
    })
  );

  return routes;
});
