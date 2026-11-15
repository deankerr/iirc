/**
 * Loopback sites for the guard's tests: HTTP and HTTPS servers on ports the kernel picks,
 * which record every connection and request, a self-signed certificate made for the run, and
 * a resolver a test scripts.
 *
 * @packageDocumentation
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as Http from "node:http";
import * as Https from "node:https";
import * as Net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { LinkUnreachable } from "@iirc/link-fetch";
import { Effect, Schedule, Schema } from "effect";
import type { Scope } from "effect";

import type { Resolver } from "../link-fetch-bun.ts";

/** A key and a self-signed certificate, as PEM. */
export interface Certificate {
  readonly key: string;
  readonly cert: string;
}

/**
 * Makes a self-signed certificate for one name with `openssl`, valid for a day.
 * @param name - The name the certificate is for.
 * @returns Its key and certificate.
 */
export const makeCertificate = (name: string): Certificate => {
  const directory = mkdtempSync(path.join(tmpdir(), "iirc-link-fetch-bun-"));

  try {
    const key = path.join(directory, "key.pem");
    const cert = path.join(directory, "cert.pem");

    const made = Bun.spawnSync([
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${name}`,
      "-addext",
      `subjectAltName=DNS:${name}`,
      "-keyout",
      key,
      "-out",
      cert,
    ]);

    if (made.exitCode !== 0) {
      throw new Error(`openssl failed: ${made.stderr.toString()}`);
    }

    return { cert: readFileSync(cert, "utf-8"), key: readFileSync(key, "utf-8") };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

/** One request a site was sent. */
interface Seen {
  readonly url: string;
  readonly headers: Http.IncomingHttpHeaders;
  /** The SNI the client sent, over TLS. */
  readonly servername: string | undefined;
  /** The address the connection reached, which is the site's own. */
  readonly local: string | undefined;
}

/** A listening site, and what it has seen. */
export interface Site {
  readonly port: number;
  readonly seen: Seen[];
  /** Every connection accepted, and those since closed. */
  readonly connections: { opened: number; closed: number };
}

/** Answers one request. */
export type Handler = (request: Http.IncomingMessage, response: Http.ServerResponse) => void;

// A TLS socket says what SNI the client sent. Bun's is not a `TLSSocket`, so it is read by shape.
const isNamed = Schema.is(Schema.Struct({ servername: Schema.String }));

/** What a listening server's address gives: its port, among other things. */
const Listening = Schema.Struct({ port: Schema.Int });

/**
 * Starts a site on loopback, closed with the Scope along with every connection it accepted.
 * @param handler - Answers each request.
 * @param options - Where it listens, on a port the kernel picks unless given, and a
 * certificate to speak TLS with.
 * @returns The site.
 */
export const serve = (
  handler: Handler,
  options: {
    readonly address?: string;
    readonly port?: number;
    readonly certificate?: Certificate;
  } = {}
): Effect.Effect<Site, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<{ server: Http.Server; site: Site; sockets: Set<Net.Socket> }>((resume) => {
      const seen: Seen[] = [];
      const connections = { closed: 0, opened: 0 };
      const sockets = new Set<Net.Socket>();

      const answer: Handler = (request, response) => {
        const { socket } = request;

        seen.push({
          headers: request.headers,
          local: socket.localAddress,
          servername: isNamed(socket) ? socket.servername : undefined,
          url: request.url ?? "",
        });
        response.on("error", () => null);
        handler(request, response);
      };

      const server =
        options.certificate === undefined
          ? Http.createServer(answer)
          : Https.createServer(
              { cert: options.certificate.cert, key: options.certificate.key },
              answer
            );

      server.on("connection", (socket: Net.Socket) => {
        connections.opened += 1;
        sockets.add(socket);
        socket.on("error", () => null);
        socket.on("close", () => {
          connections.closed += 1;
          sockets.delete(socket);
        });
      });
      server.on("tlsClientError", () => null);
      server.listen(options.port ?? 0, options.address ?? "127.0.0.1", () => {
        const { port } = Schema.decodeUnknownSync(Listening)(server.address());

        resume(Effect.succeed({ server, site: { connections, port, seen }, sockets }));
      });
    }),
    ({ server, sockets }) =>
      Effect.callback<Http.Server>((resume) => {
        for (const socket of sockets) {
          socket.destroy();
        }

        server.close(() => {
          resume(Effect.succeed(server));
        });
      })
  ).pipe(Effect.map(({ site }) => site));

/**
 * How many of a site's connections have closed, read while the site still runs, so a close the
 * site's own cleanup makes is never counted. It waits until at least `count` have closed, for at
 * most two seconds.
 * @param site - The site.
 * @param count - How many closes to wait for.
 * @returns How many have closed.
 */
export const closes = (site: Site, count = 1) =>
  Effect.suspend(() => Effect.succeed(site.connections.closed)).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 millis"),
      until: (closed) => closed >= count,
    }),
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.succeed(site.connections.closed),
    })
  );

/**
 * A listener that hangs up on every connection, counting them, as a proxy that must never be
 * used would. Closed with the Scope.
 * @returns Its port, and how many connections it has had.
 */
export const tripwire = Effect.acquireRelease(
  Effect.callback<{ server: Net.Server; tripped: { count: number } }>((resume) => {
    const tripped = { count: 0 };

    const server = Net.createServer((socket) => {
      tripped.count += 1;
      socket.destroy();
    });

    server.listen(0, "127.0.0.1", () => {
      resume(Effect.succeed({ server, tripped }));
    });
  }),
  ({ server }) =>
    Effect.callback<Net.Server>((resume) => {
      server.close(() => {
        resume(Effect.succeed(server));
      });
    })
).pipe(
  Effect.map(({ server, tripped }) => ({
    port: Schema.decodeUnknownSync(Listening)(server.address()).port,
    tripped,
  }))
);

/**
 * Sets environment variables for the Scope, and puts them back as they were when it closes.
 * @param variables - The variables and their values.
 * @returns An Effect that sets them.
 */
export const environment = (variables: Readonly<Record<string, string>>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const saved = Object.keys(variables).map((name) => [name, process.env[name]] as const);

      Object.assign(process.env, variables);

      return saved;
    }),
    (saved) =>
      Effect.sync(() => {
        for (const [name, value] of saved) {
          if (value === undefined) {
            Reflect.deleteProperty(process.env, name);
          } else {
            process.env[name] = value;
          }
        }
      })
  );

/** A resolver whose names answer as a test scripts them, and how often each was asked. */
export interface Scripted {
  readonly resolver: Resolver;
  readonly lookups: Map<string, number>;
}

/**
 * A resolver that answers each name from its script, one answer per lookup, repeating the last.
 * A name with no script does not resolve.
 * @param script - Each name's answers, in order.
 * @returns The resolver.
 */
export const scripted = (
  script: Readonly<Record<string, readonly (readonly string[])[]>>
): Scripted => {
  const lookups = new Map<string, number>();

  const resolver: Resolver = {
    resolve: (name) =>
      Effect.suspend(() => {
        const count = lookups.get(name) ?? 0;
        const answers = script[name];

        lookups.set(name, count + 1);

        if (answers === undefined || answers.length === 0) {
          return Effect.fail(new LinkUnreachable({ reason: `resolving ${name}: ENOTFOUND` }));
        }

        return Effect.succeed(answers[Math.min(count, answers.length - 1)] ?? []);
      }),
  };

  return { lookups, resolver };
};

/**
 * Answers a request by writing chunks as fast as the client reads them, until it has written
 * them all or the client hangs up.
 * @param response - The response, its head already written.
 * @param chunk - What to write each time.
 * @param count - How many times.
 * @returns How many were written, as it goes.
 */
export const pour = (response: Http.ServerResponse, chunk: Uint8Array, count: number) => {
  const written = { chunks: 0 };

  const write = () => {
    while (written.chunks < count && !response.destroyed) {
      written.chunks += 1;

      if (!response.write(chunk)) {
        response.once("drain", write);

        return;
      }
    }

    response.end();
  };

  write();

  return written;
};
