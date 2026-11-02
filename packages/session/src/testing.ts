import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, Socket as NetSocket } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { defaultTuning } from "@iirc/lifecycle/tuning";
import { Deferred, Effect, Exit, Option, Queue, Schedule, Schema } from "effect";
import type { Duration, Scope } from "effect";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";

import type { Ircd } from "./entry.ts";
import type { Transport } from "./transport.ts";
import { ConnectFailed } from "./transport.ts";

const textEncoder = new TextEncoder();

/** What a hand-written `attempt` Entry runs with: the spec's Tuning and a plain Identity. */
export const attemptInput = {
  loginLines: 0,
  realname: "I IRC",
  services: [],
  tuning: defaultTuning,
  username: "user",
} as const;

const serverName = Schema.decodeUnknownOption(Schema.NonEmptyString);

const commonName = Schema.decodeUnknownOption(Schema.Struct({ CN: Schema.String }));

/** A local stand-in for an Ircd that answers each Line it receives from a script. */
export interface ScriptedIrcd {
  /** How many Connections have been accepted, ever. */
  readonly accepted: Effect.Effect<number>;
  /** When each Connection was accepted, in epoch milliseconds. */
  readonly acceptedAt: Effect.Effect<readonly number[]>;
  /** Every byte received, whatever it turned out to mean. */
  readonly bytes: Effect.Effect<Uint8Array>;
  /** How many Connections have gone. */
  readonly closed: Effect.Effect<number>;
  /** Resets every Connection, losing whatever was not yet delivered. */
  readonly hangUp: Effect.Effect<void>;
  /** Closes every Connection, once everything pushed has reached the kernel. */
  readonly finish: Effect.Effect<void>;
  readonly port: number;
  readonly push: (text: string) => Effect.Effect<void>;
  readonly received: Effect.Effect<readonly string[]>;
  /** What one Connection sent, counting from the first the Ircd accepted. */
  readonly receivedOn: (connection: number) => Effect.Effect<readonly string[]>;
  /** What each finished TLS handshake asked for, with nothing where it sent no SNI. */
  readonly serverNames: Effect.Effect<readonly (string | undefined)[]>;
  /** The CN of the client certificate each TLS handshake that passed presented. */
  readonly clientNames: Effect.Effect<readonly (string | undefined)[]>;
}

/** Where a {@link scriptedIrcd} listens, and whether it speaks TLS. */
export interface ScriptedIrcdOptions {
  // Other software on this machine dials 127.0.0.1, so a test that counts what reaches
  // it listens on any other address in 127/8.
  readonly hostname?: string;
  /** Takes this port, for an Ircd that comes back where another was. */
  readonly port?: number;
  readonly tls?: Certificate;
  /**
   * Requires every Connection to present a client certificate this authority issued, as
   * PEM, and refuses the handshake of any that does not.
   */
  readonly clientAuthority?: string;
}

/**
 * Scripts an Ircd that answers `USER` and `JOIN` the way a welcoming one does, with no
 * MOTD, so that a burst is over as soon as it has begun.
 * @param nick - The nick to welcome.
 * @returns The script.
 */
export const welcoming =
  (nick: string) =>
  (line: string): readonly string[] => {
    if (line.startsWith("USER ")) {
      return [`:ircd 001 ${nick} :Welcome`, `:ircd 422 ${nick} :No MOTD`];
    }

    return line.startsWith("JOIN ") ? [`:${nick}!~u@host ${line}`] : [];
  };

/**
 * Listens on a local port until the enclosing scope closes.
 * @param respond - Maps each received Line, and which Connection it came on, counting
 * from the first accepted, to the Lines to send back on that Connection.
 * @param options - Where to listen, and with what certificate if any.
 * @returns The running Ircd.
 */
export const scriptedIrcd = (
  respond: (line: string, connection: number) => readonly string[],
  options?: ScriptedIrcdOptions
): Effect.Effect<ScriptedIrcd, never, Scope.Scope> =>
  Effect.gen(function* () {
    const received: string[] = [];
    const receivedOn: string[][] = [];
    const bytes: Uint8Array[] = [];
    const serverNames: (string | undefined)[] = [];
    const clientNames: (string | undefined)[] = [];
    // Each Connection's bytes that the kernel would not take yet.
    const connections = new Map<Bun.Socket, Uint8Array>();
    // Each Connection's half a Line, and when it was accepted.
    const buffered = new Map<Bun.Socket, string>();
    const ordinals = new Map<Bun.Socket, number>();
    const acceptedAt: number[] = [];
    let accepted = 0;
    let closed = 0;
    let finishing = false;

    const flush = (connection: Bun.Socket) => {
      const unsent = connections.get(connection) ?? new Uint8Array();
      const rest = unsent.subarray(Math.max(connection.write(unsent), 0));

      connections.set(connection, rest);

      if (finishing && rest.length === 0) {
        connection.end();
      }
    };

    const writeTo = (connection: Bun.Socket, text: string) => {
      const bytes = textEncoder.encode(`${text}\r\n`);
      const unsent = connections.get(connection) ?? new Uint8Array();
      const queued = new Uint8Array(unsent.length + bytes.length);

      queued.set(unsent);
      queued.set(bytes, unsent.length);
      connections.set(connection, queued);
      flush(connection);
    };

    const writeAll = (text: string) => {
      for (const connection of connections.keys()) {
        writeTo(connection, text);
      }
    };

    const listener = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.listen({
          hostname: options?.hostname ?? "127.0.0.1",
          port: options?.port ?? 0,
          ...(options?.tls !== undefined && {
            tls: {
              ...options.tls,
              ...(options.clientAuthority !== undefined && {
                ca: options.clientAuthority,
                rejectUnauthorized: true,
                requestCert: true,
              }),
            },
          }),
          socket: {
            close: (connection) => {
              closed += 1;
              connections.delete(connection);
            },
            data: (connection, data) => {
              bytes.push(new Uint8Array(data));

              const ordinal = ordinals.get(connection) ?? 0;
              const lines = `${buffered.get(connection) ?? ""}${data.toString()}`.split("\r\n");

              buffered.set(connection, lines.pop() ?? "");

              for (const line of lines) {
                received.push(line);
                receivedOn[ordinal]?.push(line);

                for (const reply of respond(line, ordinal)) {
                  writeTo(connection, reply);
                }
              }
            },
            drain: flush,
            error: () => {
              // Closing with a Line unread resets the Connection, which is no news.
            },
            handshake: (connection, authorized) => {
              // Typed as a string, and in fact `false` for a client that sent no SNI.
              serverNames.push(Option.getOrUndefined(serverName(connection.getServername())));

              if (authorized && options?.clientAuthority !== undefined) {
                clientNames.push(
                  Option.getOrUndefined(
                    commonName(connection.getPeerCertificate().subject).pipe(
                      Option.map(({ CN }) => CN)
                    )
                  )
                );
              }
            },
            open: (connection) => {
              ordinals.set(connection, accepted);
              receivedOn.push([]);
              accepted += 1;
              acceptedAt.push(Date.now());
              connections.set(connection, new Uint8Array());
            },
          },
        })
      ),
      (listening) =>
        Effect.sync(() => {
          listening.stop(true);
        })
    );

    return {
      accepted: Effect.sync(() => accepted),
      acceptedAt: Effect.sync(() => [...acceptedAt]),
      bytes: Effect.sync(() => Buffer.concat(bytes)),
      clientNames: Effect.sync(() => [...clientNames]),
      closed: Effect.sync(() => closed),
      finish: Effect.sync(() => {
        finishing = true;

        for (const connection of connections.keys()) {
          flush(connection);
        }
      }),
      hangUp: Effect.sync(() => {
        for (const connection of connections.keys()) {
          connection.terminate();
        }
      }),
      port: listener.port,
      push: (text) =>
        Effect.sync(() => {
          writeAll(text);
        }),
      received: Effect.sync(() => [...received]),
      receivedOn: (connection) => Effect.sync(() => [...(receivedOn[connection] ?? [])]),
      serverNames: Effect.sync(() => [...serverNames]),
    };
  });

/** A certificate and its private key, as PEM, which is what `Bun.listen` takes. */
export interface Certificate {
  readonly cert: string;
  readonly key: string;
}

/** A certificate authority that lasts as long as the enclosing scope. */
export interface TestAuthority {
  /** Its own certificate, as PEM. */
  readonly ca: string;
  /** Where that certificate is, for `NODE_EXTRA_CA_CERTS`. */
  readonly caFile: string;
  /**
   * Issues a certificate for one identity.
   * @param altName - The `subjectAltName`, such as `DNS:localhost` or `IP:127.0.0.1`.
   * @param commonName - Its CN, which nothing should believe. Defaults to a name of no use.
   * @returns The certificate and its key.
   */
  readonly issue: (altName: string, commonName?: string) => Certificate;
  /**
   * Makes a certificate that signed itself, which no authority stands behind.
   * @param altName - The `subjectAltName`, such as `DNS:localhost` or `IP:127.0.0.1`.
   * @param algorithm - The kind of key it holds, which is EC unless asked otherwise.
   * @returns The certificate and its key.
   */
  readonly selfSigned: (altName: string, algorithm?: KeyAlgorithm) => Certificate;
}

/** A kind of key a test certificate can hold. */
export type KeyAlgorithm = "ec" | "rsa";

const newKey: Readonly<Record<KeyAlgorithm, readonly string[]>> = {
  ec: ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
  rsa: ["-newkey", "rsa:2048", "-nodes"],
};

const curve = newKey.ec;
const validity = ["-days", "2"];

const openssl = (...args: readonly string[]) => {
  const { exitCode, stderr } = Bun.spawnSync(["openssl", ...args]);

  if (exitCode !== 0) {
    throw new Error(`openssl ${args[0]} failed: ${stderr.toString()}`);
  }
};

const readCertificate = ({ cert, key }: Certificate) => ({
  cert: readFileSync(cert, "utf-8"),
  key: readFileSync(key, "utf-8"),
});

/**
 * Makes a new authority under a temporary directory, which the scope removes. Nothing
 * here is checked in, and nothing here outlives the test.
 * @param name - Its CN.
 * @returns The authority.
 */
export const testAuthority = (name: string): Effect.Effect<TestAuthority, never, Scope.Scope> =>
  Effect.map(
    Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(path.join(tmpdir(), "iirc-tls-"))),
      (directory) =>
        Effect.sync(() => {
          rmSync(directory, { force: true, recursive: true });
        })
    ),
    (directory) => {
      const inDirectory = (file: string) => path.join(directory, file);
      const caFile = inDirectory("ca.pem");
      const caKey = inDirectory("ca.key");
      let issued = 0;

      openssl(
        "req",
        "-x509",
        ...curve,
        "-keyout",
        caKey,
        "-out",
        caFile,
        ...validity,
        "-subj",
        `/CN=${name}`
      );

      const nextPaths = () => {
        issued += 1;

        return { cert: inDirectory(`${issued}.pem`), key: inDirectory(`${issued}.key`) };
      };

      return {
        ca: readFileSync(caFile, "utf-8"),
        caFile,
        issue: (altName, commonName = "iirc test") => {
          const paths = nextPaths();
          const request = `${paths.cert}.csr`;
          const extensions = `${paths.cert}.ext`;

          writeFileSync(extensions, `subjectAltName=${altName}\n`);
          openssl(
            "req",
            ...curve,
            "-keyout",
            paths.key,
            "-out",
            request,
            "-subj",
            `/CN=${commonName}`
          );
          openssl(
            "x509",
            "-req",
            "-in",
            request,
            "-out",
            paths.cert,
            ...validity,
            "-CA",
            caFile,
            "-CAkey",
            caKey,
            "-CAcreateserial",
            "-extfile",
            extensions
          );

          return readCertificate(paths);
        },
        selfSigned: (altName, algorithm = "ec") => {
          const paths = nextPaths();

          openssl(
            "req",
            "-x509",
            ...newKey[algorithm],
            "-keyout",
            paths.key,
            "-out",
            paths.cert,
            ...validity,
            "-subj",
            "/CN=iirc test",
            "-addext",
            `subjectAltName=${altName}`
          );

          return readCertificate(paths);
        },
      } satisfies TestAuthority;
    }
  );

/**
 * Listens on a port of the kernel's choosing until the enclosing scope closes.
 * @param server - The server to start.
 * @param hostname - Where to listen.
 * @returns The port.
 */
export const listenOn = (
  server: Server,
  hostname: string
): Effect.Effect<number, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { port } = yield* Effect.scoped(scriptedIrcd(() => [], { hostname }));

    return yield* Effect.acquireRelease(
      Effect.callback<number>((resume) => {
        server.listen(port, hostname, () => {
          resume(Effect.succeed(port));
        });
      }),
      () =>
        Effect.sync(() => {
          server.close();
        })
    );
  });

/** A wire between a Connection and an Ircd, with a hand on it below any TLS. */
export interface TestWire {
  /** How many bytes the Connection has sent that this wire has taken. */
  readonly delivered: Effect.Effect<number>;
  /** Writes bytes to the Connection as though the Ircd had sent them. */
  readonly inject: (bytes: Uint8Array) => Effect.Effect<void>;
  readonly port: number;
  /** Starts taking the Connection's bytes again. */
  readonly resume: Effect.Effect<void>;
  /** Stops taking the Connection's bytes, as an Ircd that stopped reading does. */
  readonly stall: Effect.Effect<void>;
  /** Waits until the Connection has gone. */
  readonly untilGone: Effect.Effect<void>;
}

/**
 * Forwards one Connection to a port until the enclosing scope closes.
 * @param port - Where the Ircd is listening.
 * @param hostname - Where both ends of it are.
 * @returns The wire.
 */
export const testWire = (
  port: number,
  hostname: string
): Effect.Effect<TestWire, never, Scope.Scope> =>
  Effect.gen(function* () {
    const sockets = new Set<NetSocket>();
    const gone = Deferred.makeUnsafe<undefined>();
    let accepted: NetSocket | undefined;
    let delivered = 0;

    const markGone = () => {
      Deferred.doneUnsafe(gone, Exit.succeed(undefined));
    };

    const server = createServer((connection) => {
      const ircd = new NetSocket();

      sockets.add(connection).add(ircd);
      accepted = connection;

      connection.on("end", markGone);
      connection.on("close", () => {
        markGone();
        ircd.destroy();
      });
      connection.on("data", (data) => {
        delivered += data.length;
        ircd.write(data);
      });

      ircd.on("close", () => {
        connection.destroy();
      });
      ircd.on("data", (data) => {
        connection.write(data);
      });

      for (const socket of [connection, ircd]) {
        socket.on("error", () => {
          // Either end going is what a test on this wire is about.
        });
      }

      ircd.connect(port, hostname);
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const socket of sockets) {
          socket.destroy();
        }
      })
    );

    return {
      delivered: Effect.sync(() => delivered),
      inject: (bytes) =>
        Effect.sync(() => {
          accepted?.write(bytes);
        }),
      port: yield* listenOn(server, hostname),
      resume: Effect.sync(() => {
        accepted?.resume();
      }),
      stall: Effect.sync(() => {
        accepted?.pause();
      }),
      untilGone: Effect.asVoid(Deferred.await(gone)),
    };
  });

/**
 * Re-runs an effect until its value satisfies a predicate.
 * @param check - The effect to re-run.
 * @param done - Whether a value is the one being waited for.
 * @param limit - How long to keep trying.
 * @returns The satisfying value.
 */
export const eventually = <A, E, R>(
  check: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  limit: Duration.Input = "2 seconds"
) =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced("5 millis"), until: done }),
    Effect.timeout(limit),
    Effect.orDie
  );

/**
 * Runs something that needs its Scope closed, and keeps a `TestClock` moving while that
 * happens if it would otherwise stick. Closing a host's Scope can wait on the clock, and
 * nothing else moves it once a test's body is over.
 * @param scoped - What to run, such as `hostNetwork`.
 * @returns The same thing, with the clock taken care of.
 */
export const movingClockWhileClosing = <A, E, R>(
  scoped: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | Scope.Scope> =>
  Effect.gen(function* () {
    const closed = Deferred.makeUnsafe<undefined>();

    yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));

    const result = yield* scoped;

    const move = Effect.gen(function* () {
      for (let tick = 0; tick < 10 && !Deferred.isDoneUnsafe(closed); tick += 1) {
        yield* Effect.repeat(Effect.yieldNow, { times: 100 });

        if (!Deferred.isDoneUnsafe(closed)) {
          yield* TestClock.adjust("1 second");
        }
      }
    });

    yield* Effect.addFinalizer(() => Effect.asVoid(Effect.forkDetach(move)));

    return result;
  });

/** How a {@link FakeIrcd}'s socket treats the next writes. */
export type FakeWrites = "accept" | "fail" | "hang" | "jitter";

/** How a {@link FakeIrcd} treats the next dials. */
export type FakeDials = "accept" | "hang" | "refuse";

/**
 * An Ircd that exists only in memory, so tests can run on `TestClock`. It takes any number
 * of Connections, and whatever acts on one acts on the newest. Like a real Ircd, it hangs
 * up on `QUIT`.
 */
export interface FakeIrcd {
  /** How many dials were given up on before they connected. */
  readonly cancelled: Effect.Effect<number>;
  /** Every dial so far, in order, whether or not it connected. */
  readonly dials: Effect.Effect<readonly Ircd[]>;
  /** Ends the socket the way a peer closing it does. */
  readonly hangUp: Effect.Effect<void>;
  /** Fails the next pull with a read error. */
  readonly breakRead: Effect.Effect<void>;
  /** Kills the next pull with a defect, as a broken socket implementation would. */
  readonly dieOnRead: Effect.Effect<void>;
  /** Delivers one pull's batch, with each argument its own chunk. */
  readonly read: (
    first: Uint8Array | string,
    ...rest: readonly (Uint8Array | string)[]
  ) => Effect.Effect<void>;
  /** Whether every socket's Scope has closed. */
  readonly released: Effect.Effect<boolean>;
  readonly setDials: (dials: FakeDials) => Effect.Effect<void>;
  readonly setWrites: (writes: FakeWrites) => Effect.Effect<void>;
  /** How many reads no pull has taken yet, which is what a kernel would be holding. */
  readonly unread: Effect.Effect<number>;
  /** Connects to this Ircd, whatever `Ircd` is asked for. */
  readonly transport: Transport["Service"];
  /** What was written, one item per write. */
  readonly written: Effect.Effect<readonly Uint8Array[]>;
  /** What was written on one Connection, counting from the first that connected. */
  readonly writtenOn: (connection: number) => Effect.Effect<readonly Uint8Array[]>;
}

/** What a {@link fakeIrcd} does beyond taking what it is given. */
export interface FakeIrcdOptions {
  /** Takes no notice of `QUIT`, as an Ircd with a stalled peer of its own might. */
  readonly ignoresQuit?: boolean;
  /** Watches each write land. */
  readonly onWrite?: () => void;
  /** Sets the first dials' fate, as `setDials` does. */
  readonly refuses?: boolean;
  /** Answers each Line written, given which Connection it came on. */
  readonly respond?: (line: string, connection: number) => readonly string[];
  /** Fails the reader. */
  readonly unreadable?: boolean;
}

type Pull = Socket.Reader["pull"];

const socketError = (reason: Socket.SocketError["reason"]) => new Socket.SocketError({ reason });

const closedByPeer = () => socketError(new Socket.SocketCloseError({ code: 1000 }));

const textDecoder = new TextDecoder();

const linesIn = (bytes: Uint8Array) =>
  textDecoder
    .decode(bytes)
    .split("\r\n")
    .filter((line) => line !== "");

/**
 * Builds an Ircd that exists only in memory.
 * @param options - How it behaves.
 * @returns The Ircd, with no real socket behind it.
 */
export const fakeIrcd = Effect.fnUntraced(function* (options?: FakeIrcdOptions) {
  const dialled: Ircd[] = [];
  const writtenOn: Uint8Array[][] = [];
  // One per Connection, so that bytes meant for one cannot reach the next.
  const inboxes = [yield* Queue.unbounded<Pull>()];
  let cancelled = 0;
  let dials: FakeDials = options?.refuses === true ? "refuse" : "accept";
  let open = 0;
  let writes: FakeWrites = "accept";
  let jitter = 0;

  const accept = (connection: number, inbox: Queue.Queue<Pull>, chunk: Uint8Array | string) =>
    Effect.sync(() => {
      const bytes = chunk instanceof Uint8Array ? chunk : textEncoder.encode(chunk);

      writtenOn[connection]?.push(bytes);
      options?.onWrite?.();

      for (const line of linesIn(bytes)) {
        for (const reply of options?.respond?.(line, connection) ?? []) {
          Queue.offerUnsafe(inbox, Effect.succeed([`${reply}\r\n`]));
        }

        if (line.startsWith("QUIT") && options?.ignoresQuit !== true) {
          Queue.offerUnsafe(inbox, Effect.fail(closedByPeer()));
        }
      }
    });

  // Each write yields a different number of times, so writes that are not
  // serialised overtake each other.
  const jittered = (land: Effect.Effect<void>) =>
    Effect.suspend(() => {
      jitter += 1;

      return Effect.andThen(
        Effect.forEach(Array.from({ length: (jitter * 7) % 5 }), () => Effect.yieldNow, {
          discard: true,
        }),
        land
      );
    });

  const writeOn = (
    connection: number,
    inbox: Queue.Queue<Pull>,
    chunk: Uint8Array | string | Socket.CloseEvent
  ) => {
    if (Socket.isCloseEvent(chunk)) {
      return Effect.void;
    }

    switch (writes) {
      case "accept": {
        return accept(connection, inbox, chunk);
      }

      case "fail": {
        return Effect.fail(
          socketError(new Socket.SocketWriteError({ cause: new Error("broken pipe") }))
        );
      }

      case "hang": {
        return Effect.never;
      }

      case "jitter": {
        return jittered(accept(connection, inbox, chunk));
      }

      default: {
        return writes satisfies never;
      }
    }
  };

  const newSocket = (connection: number, inbox: Queue.Queue<Pull>) =>
    Socket.make({
      reader:
        options?.unreadable === true
          ? Effect.fail(socketError(new Socket.SocketCloseError({ code: 1006 })))
          : Effect.succeed({
              pull: Effect.flatten(Queue.take(inbox)),
              upgrade: Socket.SocketUpgradeError.unsupported,
            }),
      writer: Effect.succeed({
        write: (chunk) => Effect.suspend(() => writeOn(connection, inbox, chunk)),
        writeAll: (chunks) =>
          Effect.forEach(chunks, (chunk) => writeOn(connection, inbox, chunk), { discard: true }),
      }),
    });

  const accepted = Effect.fnUntraced(function* () {
    const connection = writtenOn.length;
    const inbox = connection === 0 ? inboxes[0] : yield* Queue.unbounded<Pull>();

    if (inbox === undefined) {
      return yield* Effect.die("a fake Ircd lost its first inbox");
    }

    if (connection > 0) {
      inboxes.push(inbox);
    }

    writtenOn.push([]);
    open += 1;

    return newSocket(connection, inbox);
  });

  const connect: Transport["Service"]["connect"] = (ircd) =>
    Effect.suspend(() => {
      dialled.push(ircd);

      if (dials === "refuse") {
        return Effect.fail(new ConnectFailed({ cause: "refused", reason: "refused" }));
      }

      return dials === "hang"
        ? Effect.onInterrupt(Effect.never, () =>
            Effect.sync(() => {
              cancelled += 1;
            })
          )
        : Effect.acquireRelease(
            Effect.map(accepted(), (socket) => ({ socket })),
            () =>
              Effect.sync(() => {
                open -= 1;
              })
          );
    });

  const offer = (pull: Pull) =>
    Effect.suspend(() => {
      const inbox = inboxes.at(-1);

      return inbox === undefined ? Effect.void : Effect.asVoid(Queue.offer(inbox, pull));
    });

  return {
    breakRead: offer(
      Effect.fail(socketError(new Socket.SocketReadError({ cause: new Error("reset") })))
    ),
    cancelled: Effect.sync(() => cancelled),
    dials: Effect.sync(() => [...dialled]),
    dieOnRead: offer(Effect.die("the reader broke")),
    hangUp: offer(Effect.fail(closedByPeer())),
    read: (first, ...rest) => offer(Effect.succeed([first, ...rest])),
    released: Effect.sync(() => writtenOn.length > 0 && open === 0),
    setDials: (next) =>
      Effect.sync(() => {
        dials = next;
      }),
    setWrites: (next) =>
      Effect.sync(() => {
        writes = next;
      }),
    transport: { connect },
    unread: Effect.suspend(() => {
      const inbox = inboxes.at(-1);

      return inbox === undefined ? Effect.succeed(0) : Queue.size(inbox);
    }),
    written: Effect.sync(() => writtenOn.flat()),
    writtenOn: (connection) => Effect.sync(() => [...(writtenOn[connection] ?? [])]),
  } satisfies FakeIrcd;
});
