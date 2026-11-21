/**
 * The guard: the link fetch port on Bun's `fetch`, pinned to the addresses it checked.
 *
 * @packageDocumentation
 */
import { getCACertificates } from "node:tls";

import {
  LinkFetch,
  LinkRefused,
  LinkTimedOut,
  LinkTooLarge,
  LinkUnreachable,
  LinkWrongType,
  admit,
  fixedPolicy,
  limits,
  makePacer,
  parseLink,
  writeAddress,
} from "@iirc/link-fetch";
import type {
  Address,
  BodyFailure,
  Fetched,
  LinkFetchFailure,
  LinkFetchService,
  LinkPolicy,
  Pacer,
  Precedence,
  Purpose,
  Target,
} from "@iirc/link-fetch";
import {
  Array as Arr,
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect";
import type { Pull } from "effect";

import { accept, capOf, declared, essence, headEnd, sniff, sniffed } from "./content.ts";

/** Resolves a name to every A and AAAA record it has. */
export interface Resolver {
  readonly resolve: (name: string) => Effect.Effect<readonly string[], LinkUnreachable>;
}

/** How the guard is built. Production gives only `version`. */
export interface BunLinkFetchOptions {
  /** iirc's version, for the user agent. */
  readonly version: string;
  /** What may be fetched. Defaults to the fixed policy, which production never changes. */
  readonly policy?: LinkPolicy;
  /** How names are resolved. Defaults to {@link systemResolver}. */
  readonly resolver?: Resolver;
  /**
   * Certificate authorities to trust, as PEM, on top of the system roots. Defaults to none.
   * A test trusts its own self-signed certificate this way.
   */
  readonly trust?: readonly string[];
}

/** A system error names its cause by a code, such as `ECONNREFUSED`. */
const Coded = Schema.Struct({ code: Schema.String });
const isCoded = Schema.is(Coded);

/**
 * Names a failure by its code, never its wording.
 * @param cause - What failed.
 * @returns Its code, or its name.
 */
const describe = (cause: unknown) => {
  if (isCoded(cause)) {
    return cause.code;
  }

  return cause instanceof Error ? cause.name : "unknown";
};

/** The system's resolver, through `Bun.dns.lookup`, which answers every A and AAAA record. */
export const systemResolver: Resolver = {
  resolve: (name) =>
    Effect.tryPromise({
      catch: (cause) => new LinkUnreachable({ reason: `resolving ${name}: ${describe(cause)}` }),
      try: async () => await Bun.dns.lookup(name, { family: 0 }),
    }).pipe(Effect.map((records) => records.map((record) => record.address))),
};

const redirects = new Set([301, 302, 303, 307, 308]);

const acceptLanguage = "en, *;q=0.5";

/**
 * The system's trust store, or Bun's bundled Mozilla roots where the system has none.
 * @returns The roots, as PEM.
 */
const systemRoots = () => {
  const system = getCACertificates("system");

  return system.length > 0 ? system : getCACertificates("default");
};

/**
 * The URL that names the checked address, so the connection goes there and nowhere else.
 * @param target - The link.
 * @param address - The address it was checked to resolve to.
 * @returns The pinned URL.
 */
const pinned = (target: Target, address: Address) =>
  `${target.scheme}//${writeAddress(address)}:${target.port}${target.path}`;

/**
 * What a stream asks beyond any fetch: its bytes as the host keeps them, so a range is never
 * of compressed bytes, and the range, if any.
 * @param purpose - What the link is fetched for.
 * @returns The headers.
 */
const streamHeaders = (purpose: Purpose) => {
  if (purpose.kind !== "stream") {
    return {};
  }

  const { range } = purpose;
  const end = range?.end === undefined ? "" : String(range.end - 1);

  return {
    "Accept-Encoding": "identity",
    ...(range !== undefined && { Range: `bytes=${range.start}-${end}` }),
  };
};

/**
 * The length a response declares, when it is of the bytes the body gives, which it is not
 * when they are compressed.
 * @param response - The response.
 * @returns The length, or nothing.
 */
const declaredLength = (response: Response) => {
  const encoding = essence(response.headers.get("content-encoding"));
  const length = Number(response.headers.get("content-length") ?? Number.NaN);

  return (encoding === "" || encoding === "identity") && Number.isSafeInteger(length)
    ? length
    : undefined;
};

/** A body's reader, as far as the guard reads it. */
interface Reader {
  readonly read: () => Promise<{ readonly done: boolean; readonly value?: unknown }>;
}

/** One fetch's connection, and what a failure on it means. */
interface Connection {
  /** Ends the connection, at once. */
  readonly close: Effect.Effect<void>;
  /** What a failure means: the time being up, once it is, or the connection failing. */
  readonly failed: (cause: unknown) => BodyFailure;
}

/**
 * Reads the next chunk of a body.
 * @param reader - The body.
 * @param connection - Its connection.
 * @returns The chunk, or nothing at the end.
 */
const read = (reader: Reader, connection: Connection) =>
  Effect.tryPromise({ catch: connection.failed, try: async () => await reader.read() }).pipe(
    Effect.flatMap(({ done, value }) => {
      if (done) {
        return Effect.succeedNone;
      }

      return value instanceof Uint8Array
        ? Effect.succeedSome(value)
        : Effect.fail(new LinkUnreachable({ reason: "a body that is not bytes" }));
    })
  );

/**
 * Reads the first bytes of a body: enough to tell an image's type, or else the first chunk.
 * @param reader - The body.
 * @param purpose - What it is for.
 * @param connection - Its connection.
 * @returns The bytes read.
 */
const lead = (reader: Reader, purpose: Purpose, connection: Connection) =>
  Effect.gen(function* () {
    const wanted = purpose.kind === "image" ? sniffed : 1;
    const chunks: Uint8Array[] = [];
    let size = 0;

    while (size < wanted) {
      const chunk = yield* read(reader, connection);

      if (Option.isNone(chunk)) {
        break;
      }

      chunks.push(chunk.value);
      size += chunk.value.length;
    }

    const first = new Uint8Array(size);
    let at = 0;

    for (const chunk of chunks) {
      first.set(chunk, at);
      at += chunk.length;
    }

    return first;
  });

/**
 * The body, bounded for its purpose. Reading stops at the bound, and the connection closes.
 * @param reader - The body, after its first bytes.
 * @param first - Its first bytes, already read.
 * @param cap - The most it may give.
 * @param length - The length it declared, when that is of the bytes it gives.
 * @param page - Whether it is a page, which ends cleanly at the end of its head or its cap.
 * @param connection - Its connection.
 * @returns The body, which runs once.
 */
const bounded = (
  reader: Reader | undefined,
  first: Uint8Array,
  cap: number,
  length: number | undefined,
  page: boolean,
  connection: Connection
): Stream.Stream<Uint8Array, BodyFailure> => {
  const ends = page ? headEnd() : undefined;
  let pending = Option.some(first);
  let total = 0;
  let finished = reader === undefined;

  const stop = Effect.suspend(() => {
    finished = true;

    return connection.close;
  });

  const next: Effect.Effect<Option.Option<Uint8Array>, BodyFailure> = Effect.suspend(() => {
    const chunk = pending;

    pending = Option.none();

    if (Option.isSome(chunk) || finished || reader === undefined) {
      return Effect.succeed(chunk);
    }

    return read(reader, connection).pipe(
      Effect.tap((read) =>
        Effect.sync(() => {
          finished = Option.isNone(read);
        })
      )
    );
  });

  // Each step takes one chunk, and gives what of it is within the bound, if anything.
  const step = (chunk: Uint8Array): Effect.Effect<Uint8Array, BodyFailure> => {
    if (ends === undefined) {
      total += chunk.length;

      // A body that reaches its cap without ending may have more to come, and reading on to
      // find out could wait for ever, since a stream's time limit ends at its first byte. So
      // reaching the cap is too large, unless the declared length says the body is whole.
      if (total > cap || (total === cap && length !== cap)) {
        return Effect.andThen(stop, Effect.fail(new LinkTooLarge({ limit: cap })));
      }

      return total === cap ? Effect.as(stop, chunk) : Effect.succeed(chunk);
    }

    // A page ends cleanly at the end of its head, or at its cap.
    const { done, give } = ends.feed(chunk);
    const end = Math.min(give.length, cap - total);

    total += end;

    return Effect.as(done || total >= cap ? stop : Effect.void, give.subarray(0, end));
  };

  // What a page held back to decide is given once its body ends, within the cap.
  const held = () => {
    const rest = ends?.flush() ?? new Uint8Array();
    const end = Math.min(rest.length, cap - total);

    total += end;

    return rest.subarray(0, end);
  };

  const pull: Pull.Pull<Arr.NonEmptyReadonlyArray<Uint8Array>, BodyFailure> = Effect.gen(
    function* () {
      for (;;) {
        const chunk = yield* next;

        if (Option.isNone(chunk)) {
          const rest = held();

          return rest.length > 0 ? Arr.of(rest) : yield* Cause.done();
        }

        const kept = yield* step(chunk.value);

        if (kept.length > 0) {
          return Arr.of(kept);
        }
      }
    }
  );

  // However the body ends, read to its end or stopped early, the connection closes, which
  // also gives up its place with the pacer.
  return Stream.fromPull(Effect.succeed(pull)).pipe(Stream.ensuring(stop));
};

/**
 * The guard, paced.
 * @param options - Its version, and in tests a policy, a resolver, and roots to trust.
 * @param pacer - What each fetch waits its turn on, and each hop.
 * @returns The link fetch.
 */
const guard = (options: BunLinkFetchOptions, pacer: Pacer): LinkFetchService => {
  const policy = options.policy ?? fixedPolicy;
  const resolver = options.resolver ?? systemResolver;
  const userAgent = `iirc/${options.version} (+https://github.com/deankerr/iirc) bot`;
  const trust = options.trust ?? [];
  const roots = trust.length === 0 ? {} : { ca: [...systemRoots(), ...trust] };

  const request = (target: Target, address: Address, purpose: Purpose, signal: AbortSignal) => ({
    headers: {
      Accept: accept[purpose.kind],
      "Accept-Language": acceptLanguage,
      Host: target.host,
      "User-Agent": userAgent,
      ...streamHeaders(purpose),
    },
    keepalive: false,
    proxy: false as const,
    redirect: "manual" as const,
    signal,
    // SNI and the certificate name the link's own name, while the connection goes to the
    // address. An IP literal is checked against itself.
    ...(target.scheme === "https:" && {
      tls: {
        ...roots,
        ...(target.literal === undefined && { serverName: target.hostname.replace(/\.$/u, "") }),
      },
    }),
    url: pinned(target, address),
  });

  const fetchLink = (link: string, purpose: Purpose, precedence: Precedence = "first") =>
    Effect.gen(function* () {
      // Its place in line, asked now, which it keeps through every hop.
      const turn = yield* pacer.ask(precedence);
      // The connection lives in a Scope of its own, which the caller's closes, so it can end
      // at a bound, at the time limit, or when the caller is done, whichever is first.
      const outer = yield* Scope.Scope;
      const scope = yield* Scope.fork(outer);
      const signal = yield* Scope.provide(Effect.abortSignal, scope);
      let late = false;

      const connection: Connection = {
        close: Scope.close(scope, Exit.void),
        failed: (cause) =>
          late ? new LinkTimedOut() : new LinkUnreachable({ reason: describe(cause) }),
      };

      // The time limit runs only while the fetch is not waiting its turn, so waiting never
      // makes it time out. It starts once the first hop's turn comes.
      const expired = yield* Deferred.make<undefined>();
      let left: number = limits.milliseconds;
      let since = 0;
      let timer: Fiber.Fiber<void> | undefined;

      const run = Effect.gen(function* () {
        since = yield* Clock.currentTimeMillis;
        timer = yield* Effect.forkIn(
          Effect.sleep(left).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                late = true;

                return connection.close;
              })
            ),
            Effect.andThen(Deferred.succeed(expired, undefined)),
            Effect.asVoid
          ),
          outer
        );
      });

      const pause = Effect.suspend(() => {
        const running = timer;

        timer = undefined;

        return running === undefined
          ? Effect.void
          : Effect.gen(function* () {
              yield* Fiber.interrupt(running);
              left -= (yield* Clock.currentTimeMillis) - since;
            });
      });

      const waiting = (turn: Effect.Effect<void>) =>
        pause.pipe(Effect.andThen(turn), Effect.andThen(run));

      // Each hop is parsed, resolved once, checked, and pinned to what was checked.
      const follow = Effect.gen(function* () {
        let next = link;
        let base: string | undefined;

        for (let hop = 0; ; hop += 1) {
          const target = yield* Effect.fromResult(parseLink(policy, next, base));

          // The first hop waits to start. Each then waits its turn by the name it is made
          // to, and holds its place until it is done: a redirect once it is read, and the last
          // hop until its connection closes. Nothing holds a name's place while it waits to
          // start, so a fetch that waits long for the minute never keeps a name from another.
          const held = yield* Scope.fork(scope);

          yield* waiting(
            Effect.andThen(
              hop === 0 ? turn.start : Effect.void,
              Scope.provide(turn.hop(target.hostname), held)
            )
          );

          const addresses =
            target.literal === undefined
              ? yield* resolver.resolve(target.hostname)
              : [target.hostname];

          if (addresses.length === 0) {
            return yield* new LinkUnreachable({ reason: `${target.hostname} has no address` });
          }

          const address = yield* Effect.fromResult(admit(policy, target.port, addresses));
          const { url, ...init } = request(target, address, purpose, signal);

          const response = yield* Effect.tryPromise({
            catch: connection.failed,
            try: async () => await fetch(url, init),
          });

          const location = response.headers.get("location");

          if (!redirects.has(response.status) || location === null) {
            return { response, target };
          }

          // The redirect's own body is never read.
          yield* Effect.promise(async () => {
            await response.body?.cancel().catch(() => null);
          });
          yield* Scope.close(held, Exit.void);

          if (hop === limits.redirects) {
            return yield* new LinkRefused({ reason: `more than ${limits.redirects} redirects` });
          }

          next = location;
          base = target.href;
        }
      });

      const answer = Effect.gen(function* () {
        const { response, target } = yield* follow;
        const header = essence(response.headers.get("content-type"));
        // A stream's 416 says only that its range is past the end, so its type is never media,
        // and only its status and `Content-Range` are of use.
        const unsatisfied = purpose.kind === "stream" && response.status === 416;
        const type = unsatisfied ? header : declared(purpose, header);

        if (type === undefined) {
          return yield* new LinkWrongType({ link: target.href, type: header });
        }

        const cap = capOf(purpose, type);
        const length = declaredLength(response);

        // A stream that declares more than its cap is cut off at it as it streams, as a page is
        // cut, rather than refused, so its first bytes still play.
        if (
          purpose.kind !== "page" &&
          purpose.kind !== "stream" &&
          length !== undefined &&
          length > cap
        ) {
          return yield* new LinkTooLarge({ limit: cap });
        }

        const reader: Reader | undefined = response.body?.getReader();

        const first =
          reader === undefined ? new Uint8Array() : yield* lead(reader, purpose, connection);

        // Only the first bytes are looked at, however many the first chunks held, so the type
        // never depends on how the body was split.
        if (purpose.kind === "image" && sniff(first.subarray(0, sniffed)) !== type) {
          return yield* new LinkWrongType({ link: target.href, type: header });
        }

        return {
          body: bounded(reader, first, cap, length, purpose.kind === "page", connection),
          headers: Object.fromEntries(response.headers),
          link: target.href,
          status: response.status,
          type,
        } satisfies Fetched;
      });

      // An answer that is refused closes its connection at once, rather than with the Scope.
      const fetched = yield* Effect.raceFirst(
        answer,
        Effect.andThen(Deferred.await(expired), Effect.fail(new LinkTimedOut()))
      ).pipe(Effect.onError(() => Effect.andThen(pause, connection.close)));

      // A stream is held to the time to its first byte, which has come.
      if (purpose.kind === "stream") {
        yield* pause;
      }

      return fetched;
    });

  return {
    fetch: (link, purpose, precedence): Effect.Effect<Fetched, LinkFetchFailure, Scope.Scope> =>
      fetchLink(link, purpose, precedence),
  };
};

/**
 * Makes the guard, with a pacer of its own, which every fetch it makes waits on.
 * @param options - Its version, and in tests a policy, a resolver, and roots to trust.
 * @returns The link fetch.
 */
export const makeBunLinkFetch = (options: BunLinkFetchOptions): Effect.Effect<LinkFetchService> =>
  makePacer.pipe(Effect.map((pacer) => guard(options, pacer)));

/**
 * The guard as a Layer.
 * @param options - Its version. Tests also give a policy, a resolver, and roots to trust.
 * @returns The Layer.
 */
export const layerBunLinkFetch = (options: BunLinkFetchOptions): Layer.Layer<LinkFetch> =>
  Layer.effect(LinkFetch)(makeBunLinkFetch(options));
