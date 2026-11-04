// Effect has nothing that parses a certificate, so its key is read with Node's.
import { X509Certificate } from "node:crypto";
import { connect as connectNet, isIP } from "node:net";
import type { Socket as NetSocket } from "node:net";
import { Readable } from "node:stream";
import { connect as connectTls } from "node:tls";
import type { TLSSocket } from "node:tls";

import type { Tuning } from "@iirc/lifecycle/tuning";
import { Array as Arr, Context, Data, Duration, Effect, Layer, Option, Redacted } from "effect";
import type { Scope } from "effect";
import { Digest } from "effect/crypto";
import { Base64 } from "effect/encoding";
import { constVoid } from "effect/Function";
import { Socket } from "effect/socket";

import type { Ircd, TlsDetails } from "./entry.ts";

// What a WebSocket calls a close with no close frame, and Effect's sockets borrow.
const abnormalClose = 1006;

/** A Connection could not be opened. `reason` is fit for a `closed` Entry. */
export class ConnectFailed extends Data.TaggedError("ConnectFailed")<{
  readonly cause: unknown;
  readonly reason: string;
}> {}

/**
 * Words for a socket failure. Its own message says only that an error occurred, and
 * the cause is what says which one.
 * @param error - The failure.
 * @returns Text fit for a `closed` Entry.
 */
export const describeSocketError = ({ message, reason }: Socket.SocketError): string =>
  "cause" in reason && reason.cause instanceof Error ? reason.cause.message : message;

const connectFailed = ({ host, port }: Ircd, cause: Socket.SocketError) =>
  new ConnectFailed({
    cause,
    reason: `could not connect to ${host}:${port}: ${describeSocketError(cause)}`,
  });

const openFailed = (kind: Socket.SocketOpenError["kind"], cause: unknown) =>
  new Socket.SocketError({ reason: new Socket.SocketOpenError({ cause, kind }) });

/** A Connection just opened, and how it was secured, if it was. */
export interface Opened {
  readonly socket: Socket.Socket;
  /** Absent for plaintext. */
  readonly tls?: TlsDetails;
  /**
   * Ends reading, and gives what was read from the kernel that no pull has taken, so that
   * a close can record it (LOG-4). Absent where a pull is all there is.
   */
  readonly unread?: Effect.Effect<readonly Uint8Array[]>;
}

interface Dialed {
  readonly stream: NetSocket;
  readonly tls?: TlsDetails;
}

/** What a dial needs to know beyond the Ircd. */
export interface DialOptions extends Pick<Tuning, "connectTimeoutMillis"> {
  /**
   * A TLS client certificate and its private key, as one PEM, which is how a Credential
   * holds them. Any further certificates in it are sent as its chain.
   */
  readonly clientCertificate?: Redacted.Redacted;
}

/** A client certificate and its key, each as PEM, as `node:tls` takes them. */
interface ClientIdentity {
  readonly cert: string;
  readonly key: string;
}

const pemBlock = /-----BEGIN (?<label>[A-Z0-9 ]+)-----[^-]*-----END \k<label>-----/gu;

// A Credential holds the certificate and key together, and each goes its own way here.
const clientIdentity = (pem: string): ClientIdentity | undefined => {
  const blocks = Array.from(pem.matchAll(pemBlock), (match) => ({
    label: match.groups?.label ?? "",
    text: match[0],
  }));

  const certs = blocks.filter(({ label }) => label === "CERTIFICATE").map(({ text }) => text);
  const key = blocks.find(({ label }) => label.endsWith("PRIVATE KEY"))?.text;

  return certs.length > 0 && key !== undefined ? { cert: certs.join("\n"), key } : undefined;
};

const noIdentity = ({ host, port }: Ircd) =>
  new ConnectFailed({
    cause: "client certificate",
    reason: `the client certificate for ${host}:${port} holds no certificate and private key`,
  });

/**
 * The SubjectPublicKeyInfo of the certificate an Ircd presented. The peer certificate's
 * own `pubkey` is SubjectPublicKeyInfo for RSA but only the bare point for EC, so the key
 * is read from the certificate itself. An Ircd that sent no certificate, or one whose key
 * cannot be read, has none. This runs in a stream's listener, where a throw would reach
 * nothing.
 */
const presentedKey = Option.liftThrowable((stream: TLSSocket): Uint8Array =>
  new X509Certificate(stream.getPeerCertificate().raw).publicKey.export({
    format: "der",
    type: "spki",
  })
);

/**
 * The pin of a key, as `curl --pinnedpubkey` reads it. WebCrypto rejecting the hash is a
 * defect in `Digest`, and here it fails only this Connection.
 * @param digest - What hashes it.
 * @param ircd - Who presented the key.
 * @param spki - The key, as DER SubjectPublicKeyInfo.
 * @returns `sha256/` and the base64 SHA-256 of the key.
 */
const pinOf = (digest: Digest.Digest["Service"], { host, port }: Ircd, spki: Uint8Array) =>
  digest.digest(Digest.sha256, spki).pipe(
    Effect.map((hash) => `sha256/${Base64.encode(hash)}`),
    Effect.catchDefect((cause) =>
      Effect.fail(
        new ConnectFailed({
          cause,
          reason: `the key ${host}:${port} presented could not be hashed`,
        })
      )
    )
  );

// Gives the presented pin, so the Owner can check it and pin it (CONN-1).
const unpinned = ({ host, port, pin }: Ircd, presented: string | undefined) =>
  new ConnectFailed({
    cause: { pinned: pin, presented },
    reason:
      presented === undefined
        ? `${host}:${port} presented no key that could be read`
        : `${host}:${port} presented the key ${presented}, which is not its pin ${pin ?? ""}`,
  });

// By here the handshake is done, and a pinned Ircd has had no other check: with
// `rejectUnauthorized: false`, `checkServerIdentity` never runs. Nothing has been written,
// because nothing else holds the stream yet. An authority only verifies a certificate
// there is, so only a pinned Ircd should get here with none. Nothing reads the stream
// until the dial has resumed, so it waits, unread, while the key is hashed. What the
// handshake settled is read before then, because a stream the Ircd closes meanwhile
// forgets it.
const secured = (
  digest: Digest.Digest["Service"],
  ircd: Ircd,
  stream: TLSSocket
): Effect.Effect<Dialed, ConnectFailed> =>
  Effect.gen(function* (): Effect.fn.Return<Dialed, ConnectFailed> {
    const cipher = stream.getCipher().name;
    const protocol = stream.getProtocol() ?? "unknown";

    const presented = yield* Effect.transposeOption(
      Option.map(presentedKey(stream), (spki) => pinOf(digest, ircd, spki))
    );

    if (Option.isNone(presented) || (ircd.pin !== undefined && presented.value !== ircd.pin)) {
      return yield* unpinned(ircd, Option.getOrUndefined(presented));
    }

    if (stream.destroyed) {
      return yield* new ConnectFailed({
        cause: "closed",
        reason: `${ircd.host}:${ircd.port} closed the Connection as it opened`,
      });
    }

    return {
      stream,
      tls: {
        cipher,
        pin: presented.value,
        protocol,
        verifiedBy: ircd.pin === undefined ? "authority" : "pin",
      },
    };
  }).pipe(Effect.tapError(() => Effect.sync(() => stream.destroy())));

// SNI carries names only, and Node refuses an IP address there. Omitting it still
// verifies, because the identity check falls back to `host`. A pinned Ircd is verified by
// its pin alone, so the certificate and its name go unchecked (CONN-1).
const dial = (
  ircd: Ircd,
  {
    connectTimeoutMillis,
    digest,
    identity,
  }: {
    connectTimeoutMillis: number;
    digest: Digest.Digest["Service"];
    identity?: ClientIdentity;
  },
  onStream: (stream: NetSocket) => void
) =>
  Effect.callback<Dialed, ConnectFailed | Socket.SocketError>((resume) => {
    const { host, pin, port } = ircd;
    let stream: NetSocket;

    if (ircd.tls) {
      const secure = connectTls({
        host,
        port,
        rejectUnauthorized: pin === undefined,
        ...(isIP(host) === 0 && { servername: host }),
        ...identity,
      });

      secure.once("secureConnect", () => {
        resume(secured(digest, ircd, secure));
      });

      stream = secure;
    } else {
      stream = connectNet({ host, port });

      stream.once("connect", () => {
        resume(Effect.succeed({ stream }));
      });
    }

    onStream(stream);

    // Stays for the life of the stream, which throws an `error` nothing listens for.
    stream.on("error", (cause) => {
      resume(Effect.fail(openFailed("Unknown", cause)));
    });

    return Effect.sync(() => {
      stream.destroy();
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(connectTimeoutMillis),
      orElse: () => Effect.fail(openFailed("Timeout", new Error("Connection timed out"))),
    })
  );

const writeFailed = (cause: unknown) =>
  new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) });

const socketGone = () =>
  new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: abnormalClose }) });

// `destroySoon` waits for `finish`, which a stream still holding bytes for an Ircd that
// has stopped reading never reaches, and it would stay open with them for good.
const release = (stream: NetSocket) =>
  Effect.sync(() => {
    if (stream.writableLength > 0) {
      stream.destroy();
    } else {
      stream.destroySoon();
    }
  });

// LOG-4: the most one read takes, so a host can bound what it has read and not recorded.
const readAtMost = 16 * 1024;

// `Readable`'s own `read`, which asks the socket for more only once its buffer is below
// `highWaterMark`. Bun's `Socket.prototype.read` resumes the socket on every call, so a
// stream read through it drains the kernel into itself without limit (LOG-4, HOST-1).
const readHeld = (stream: NetSocket, size?: number): Uint8Array | undefined => {
  const chunk: unknown = Readable.prototype.read.call(stream, size);

  return chunk instanceof Uint8Array ? chunk : undefined;
};

// A Socket over the stream, reading and writing it directly. A read takes what is there,
// up to `readAtMost`, and waits for more only when nothing is. The stream reads ahead of
// that by at most its `highWaterMark` and one read of the kernel: 64 KB and 512 KB. The
// rest of a flood waits in the kernel.
//
// Whatever the stream still holds when it ends or resets is read first, because those are
// Lines the Ircd really did deliver, and `unread` hands it over when a close cannot wait
// for reads (LOG-4). A write is done once the kernel has the bytes, and races the close,
// because a write that starts as the stream closes would otherwise wait for good.
const streamSocket = (stream: NetSocket) => {
  // Why the stream can give nothing more, once it has said so.
  let ending: Socket.SocketError | undefined;

  stream.once("end", () => {
    ending ??= new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1000 }) });
  });
  stream.on("error", (cause) => {
    ending ??= new Socket.SocketError({ reason: new Socket.SocketReadError({ cause }) });
  });
  stream.once("close", () => {
    ending ??= socketGone();
  });

  const pull = Effect.callback<Arr.NonEmptyReadonlyArray<Uint8Array>, Socket.SocketError>(
    (resume) => {
      const events = ["readable", "end", "error", "close"];
      // The listener and its removal each need the other, so it is held here.
      const watching = { onEvent: constVoid };

      const stop = () => {
        for (const event of events) {
          stream.off(event, watching.onEvent);
        }
      };

      watching.onEvent = () => {
        const held = stream.readableLength;
        const chunk = held > 0 ? readHeld(stream, Math.min(held, readAtMost)) : undefined;

        if (chunk !== undefined) {
          stop();
          resume(Effect.succeed(Arr.of(chunk)));
        } else if (ending !== undefined || stream.destroyed) {
          stop();
          resume(Effect.fail(ending ?? socketGone()));
        }
      };

      for (const event of events) {
        stream.on(event, watching.onEvent);
      }

      watching.onEvent();

      return Effect.sync(stop);
    }
  );

  // Ends reading, and gives everything read that no read has taken.
  const unread = Effect.sync(() => {
    const rest: Uint8Array[] = [];

    stream.pause();

    for (let chunk = readHeld(stream); chunk !== undefined; chunk = readHeld(stream)) {
      rest.push(chunk);
    }

    return rest;
  });

  const closes = Effect.callback<never, Socket.SocketError>((resume) => {
    const onClose = () => {
      resume(Effect.fail(socketGone()));
    };

    if (stream.destroyed) {
      onClose();
    }

    stream.once("close", onClose);

    return Effect.sync(() => {
      stream.off("close", onClose);
    });
  });

  // Not writing at all to a stream that has ended, which would turn it into an error.
  const whileOpen = (write: Effect.Effect<void, Socket.SocketError>) =>
    Effect.suspend(() =>
      stream.writable ? Effect.raceFirst(write, closes) : Effect.fail(socketGone())
    );

  // The stream calls back once the bytes have left its own buffer for the kernel. `write`
  // returning, or `drain`, only says that buffer had room, and a close throws it away
  // (LOG-2).
  const handedOver = (chunk: Uint8Array | string | Socket.CloseEvent) =>
    Socket.isCloseEvent(chunk)
      ? Effect.sync(() => {
          stream.end();
        })
      : Effect.asVoid(
          Effect.callback<number, Socket.SocketError>((resume) => {
            stream.write(chunk, (error) => {
              resume(
                error === null || error === undefined
                  ? Effect.succeed(chunk.length)
                  : Effect.fail(writeFailed(error))
              );
            });
          })
        );

  const socket = Socket.make({
    reader: Effect.succeed({ pull, upgrade: Socket.SocketUpgradeError.unsupported }),
    writer: Effect.succeed({
      write: (chunk) => whileOpen(handedOver(chunk)),
      writeAll: (chunks) => whileOpen(Effect.forEach(chunks, handedOver, { discard: true })),
    }),
  });

  return { socket, unread };
};

/** An opened Connection's two ends, ready to read and write. */
export interface Attached {
  readonly pull: Effect.Effect<readonly Uint8Array[], Socket.SocketError>;
  readonly writer: Socket.Writer;
}

/**
 * Takes hold of an opened Connection's reader and writer. A socket that connected and
 * cannot be read or written is a Connection that could not be opened, which is an
 * expected failure and not a defect.
 * @param opened - What `connect` opened.
 * @returns Its reader and writer, for as long as the Scope lasts.
 */
export const attach = ({ socket }: Opened): Effect.Effect<Attached, ConnectFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const pull = yield* Socket.readerBytes(socket);
    const writer = yield* socket.writer;

    return { pull, writer };
  }).pipe(
    Effect.catchTag("SocketError", (cause) =>
      Effect.fail(
        new ConnectFailed({ cause, reason: `could not read: ${describeSocketError(cause)}` })
      )
    )
  );

/**
 * Opens Connections to Ircds. It dials here, where a failure can be a `ConnectFailed`,
 * and keeps hold of the stream, because a Socket says nothing about whether its stream
 * is still there. A write to one that has gone fails at once, with a close.
 */
export class Transport extends Context.Service<
  Transport,
  {
    readonly connect: (
      ircd: Ircd,
      options: DialOptions
    ) => Effect.Effect<Opened, ConnectFailed, Scope.Scope>;
  }
>()("@iirc/session/Transport") {
  /**
   * TCP or TLS through Node's streams, sending SNI, and verifying certificates, or for a
   * pinned Ircd, its key alone (CONN-1). Over TLS it presents a client certificate if it
   * is given one. Plaintext has nowhere to present one. It hashes pins with the `Digest`
   * it is given, which a test can replace.
   */
  static readonly layerWithoutDigest: Layer.Layer<Transport, never, Digest.Digest> = Layer.effect(
    this,
    Effect.gen(function* () {
      const digest = yield* Digest.Digest;

      return {
        connect: Effect.fn("Transport.connect")(function* (
          ircd: Ircd,
          { clientCertificate, connectTimeoutMillis }: DialOptions
        ) {
          const failedOn = (cause: Socket.SocketError) => connectFailed(ircd, cause);

          const identity =
            clientCertificate === undefined
              ? undefined
              : clientIdentity(Redacted.value(clientCertificate));

          let dialing: NetSocket | undefined;

          if (clientCertificate !== undefined && identity === undefined) {
            return yield* noIdentity(ircd);
          }

          // In place before the dial, because a close can cancel one at any moment, and a
          // stream that connected just as that happened would otherwise have no owner.
          yield* Effect.addFinalizer(() =>
            dialing === undefined ? Effect.void : release(dialing)
          );

          const { stream, tls } = yield* dial(
            ircd,
            { connectTimeoutMillis, digest, ...(identity !== undefined && { identity }) },
            (opening) => {
              dialing = opening;
            }
          ).pipe(Effect.catchTag("SocketError", (cause) => Effect.fail(failedOn(cause))));

          const { socket, unread } = streamSocket(stream);

          return tls === undefined ? { socket, unread } : { socket, tls, unread };
        }),
      };
    })
  );

  /** `layerWithoutDigest`, hashing pins with WebCrypto. */
  static readonly layer: Layer.Layer<Transport> = this.layerWithoutDigest.pipe(
    Layer.provide(Digest.layerWebCrypto)
  );
}
