import type * as Net from "node:net";
import { TLSSocket } from "node:tls";

import type { IrcdAddress } from "@iirc/client";
import { maxReceivedBytes } from "@iirc/runtime/transport";
import type { LinkEvent } from "@iirc/runtime/transport";
import { Deferred, Effect, Fiber, Stream } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import { listen, makeCertificate, refusingPort } from "./testing/loopback.ts";
import type { Certificate } from "./testing/loopback.ts";
import { makeBunTransport } from "./transport.ts";
import type { BunTransportOptions } from "./transport.ts";

const bytes = new TextEncoder();
const text = new TextDecoder();
const certificate = makeCertificate("irc.test");
const ipCertificate = makeCertificate("127.0.0.1", "IP:127.0.0.1");

const tlsAddress: IrcdAddress = { host: "irc.test", port: 6697, tls: true };
const plainAddress: IrcdAddress = { host: "irc.test", port: 6667, tls: false };

const show = (event: LinkEvent) => {
  if (event._tag === "Received") {
    return `Received ${text.decode(event.bytes)}`;
  }

  return event._tag === "Closed" ? `Closed ${event.reason}` : event._tag;
};

const run = async <A>(effect: Effect.Effect<A, never, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(effect));

/**
 * A loopback Ircd that hands the test the socket it accepts.
 * @param tls - Speaks TLS with this certificate, or plain TCP without one.
 * @returns Its port, and the accepted socket once there is one.
 */
const ircd = (tls: Certificate | undefined) =>
  Effect.gen(function* () {
    const accepted = yield* Deferred.make<Net.Socket>();

    const port = yield* listen(tls, (socket) => {
      Deferred.doneUnsafe(accepted, Effect.succeed(socket));
    });

    return { accepted: Deferred.await(accepted), port };
  });

/**
 * Resolves once the far end has seen its socket close, which proves ours closed too. The
 * far end reads whatever is left first, since a socket that is not read never sees the end.
 * @param socket - The far end's socket.
 * @returns `closed`, or `open` if it is still open after a second.
 */
const farClosed = (socket: Net.Socket) =>
  Effect.callback<string>((resume) => {
    socket.resume();

    if (socket.closed) {
      resume(Effect.succeed("closed"));
    } else {
      socket.once("close", () => {
        resume(Effect.succeed("closed"));
      });
    }
  }).pipe(Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.succeed("open") }));

/**
 * Dials, reads every event, and shows them.
 * @param address - Where to dial.
 * @param options - The Transport's options.
 * @returns The events, shown.
 */
const dialAndRead = (address: IrcdAddress, options: BunTransportOptions) =>
  Effect.gen(function* () {
    const link = yield* makeBunTransport(options).dial(address);
    const events = yield* Stream.runCollect(link.events);

    return events.map(show);
  });

// A TLS server's socket says what SNI the client sent, which `Net.Socket` does not type.
const servername = (socket: Net.Socket) =>
  socket instanceof TLSSocket ? socket.servername : "not TLS";

const to = (port: number) => () => Effect.succeed({ host: "127.0.0.1", port });

describe("a dial that fails", () => {
  it("reports a refused Connection", async () => {
    const events = await run(
      refusingPort.pipe(Effect.flatMap((port) => dialAndRead(plainAddress, { route: to(port) })))
    );

    expect(events).toStrictEqual(["Closed Refused"]);
  });

  it("reports a host that does not resolve as Unreachable", async () => {
    const events = await run(
      dialAndRead({ host: "nowhere.invalid", port: 6697, tls: true }, { trust: [certificate.cert] })
    );

    expect(events).toStrictEqual(["Closed Unreachable"]);
  });

  it("times out connecting", async () => {
    const started = performance.now();

    const events = await run(
      dialAndRead(plainAddress, { connectTimeout: "50 millis", route: () => Effect.never })
    );

    expect(events).toStrictEqual(["Closed TimedOut"]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("TLS", () => {
  it("sends SNI and verifies against an added root, then reports Opened", async () => {
    const result = await run(
      Effect.gen(function* () {
        const far = yield* ircd(certificate);

        const link = yield* makeBunTransport({
          route: to(far.port),
          trust: [certificate.cert],
        }).dial(tlsAddress);

        const socket = yield* far.accepted;

        socket.end(":irc.test NOTICE * :hello\r\n");
        const events = yield* Stream.runCollect(link.events);

        return {
          events: events.map(show),
          sni: servername(socket),
        };
      })
    );

    expect(result).toStrictEqual({
      events: ["Opened", "Received :irc.test NOTICE * :hello", "Closed Ended"],
      sni: "irc.test",
    });
  });

  it("verifies an Ircd dialled by address against the certificate's address", async () => {
    const events = await run(
      Effect.gen(function* () {
        const far = yield* ircd(ipCertificate);

        const link = yield* makeBunTransport({ trust: [ipCertificate.cert] }).dial({
          host: "127.0.0.1",
          port: far.port,
          tls: true,
        });

        const socket = yield* far.accepted;

        socket.end();

        return (yield* Stream.runCollect(link.events)).map(show);
      })
    );

    expect(events).toStrictEqual(["Opened", "Closed Ended"]);
  });

  it("refuses an Ircd dialled by address whose certificate names another", async () => {
    const events = await run(
      Effect.gen(function* () {
        const far = yield* ircd(certificate);

        return yield* dialAndRead(
          { host: "127.0.0.1", port: far.port, tls: true },
          { trust: [certificate.cert] }
        );
      })
    );

    expect(events).toStrictEqual(["Closed Tls"]);
  });

  it("refuses a certificate it does not trust, and never falls back", async () => {
    const result = await run(
      Effect.gen(function* () {
        const raw = yield* Deferred.make<Net.Socket>();

        const port = yield* listen(
          certificate,
          () => {},
          (socket) => {
            Deferred.doneUnsafe(raw, Effect.succeed(socket));
          }
        );

        const events = yield* dialAndRead(tlsAddress, { route: to(port) });

        return { events, far: yield* farClosed(yield* Deferred.await(raw)) };
      })
    );

    expect(result).toStrictEqual({ events: ["Closed Tls"], far: "closed" });
  });

  it("refuses a trusted certificate for another name", async () => {
    const events = await run(
      Effect.gen(function* () {
        const far = yield* ircd(certificate);

        return yield* dialAndRead(
          { host: "elsewhere.test", port: 6697, tls: true },
          { route: to(far.port), trust: [certificate.cert] }
        );
      })
    );

    expect(events).toStrictEqual(["Closed Tls"]);
  });

  it("refuses an Ircd that answers in plaintext", async () => {
    const events = await run(
      Effect.gen(function* () {
        const port = yield* listen(undefined, (socket) => {
          socket.write(":irc.test NOTICE * :*** Looking up your hostname...\r\n");
        });

        return yield* dialAndRead(tlsAddress, { route: to(port), trust: [certificate.cert] });
      })
    );

    expect(events).toStrictEqual(["Closed Tls"]);
  });

  it("times out a handshake the Ircd never answers, and closes the socket", async () => {
    const result = await run(
      Effect.gen(function* () {
        const far = yield* ircd(undefined);

        const events = yield* dialAndRead(tlsAddress, {
          handshakeTimeout: "50 millis",
          route: to(far.port),
          trust: [certificate.cert],
        });

        return { events, far: yield* farClosed(yield* far.accepted) };
      })
    );

    expect(result).toStrictEqual({ events: ["Closed TimedOut"], far: "closed" });
  });
});

describe("an open Connection", () => {
  it.each([
    ["plain TCP", undefined, plainAddress],
    ["TLS", certificate, tlsAddress],
  ] as const)("reports a peer that resets it, over %s", async (_, tls, address) => {
    const events = await run(
      Effect.gen(function* () {
        const far = yield* ircd(tls);

        const link = yield* makeBunTransport({
          route: to(far.port),
          trust: [certificate.cert],
        }).dial(address);

        const socket = yield* far.accepted;

        socket.write("PING :x\r\n", () => {
          setTimeout(() => socket.resetAndDestroy(), 20);
        });

        return (yield* Stream.runCollect(link.events)).map(show);
      })
    );

    expect(events).toStrictEqual(["Opened", "Received PING :x", "Closed Reset"]);
  });

  it("ends a write the peer never reads as TimedOut, and closes the socket", async () => {
    const result = await run(
      Effect.gen(function* () {
        const far = yield* ircd(undefined);

        const link = yield* makeBunTransport({
          route: to(far.port),
          writeTimeout: "100 millis",
        }).dial(plainAddress);

        const socket = yield* far.accepted;

        socket.pause();
        const reading = yield* Effect.forkChild(Stream.runCollect(link.events));
        const chunk = bytes.encode(`PRIVMSG #flood :${"x".repeat(65_000)}\r\n`);

        // Keep writing until the kernel's buffers fill and a send stalls.
        while (!reading.pollUnsafe()) {
          yield* link.send(chunk);
          yield* Effect.yieldNow;
        }

        const events = yield* Fiber.join(reading);

        return { events: events.map(show), far: yield* farClosed(socket) };
      })
    );

    expect(result).toStrictEqual({ events: ["Opened", "Closed TimedOut"], far: "closed" });
  });

  it("frames Lines however the reads split them", async () => {
    const events = await run(
      Effect.gen(function* () {
        const far = yield* ircd(undefined);
        const link = yield* makeBunTransport({ route: to(far.port) }).dial(plainAddress);
        const socket = yield* far.accepted;
        const reads = ["PING :a\r", "\nPING :b\r\nPING :c\r\nPI", "NG :d\r\n", "PING :unfinished"];

        socket.setNoDelay(true);

        for (const read of reads) {
          socket.write(read);
          yield* Effect.sleep("5 millis");
        }

        socket.end();

        return (yield* Stream.runCollect(link.events)).map(show);
      })
    );

    expect(events).toStrictEqual([
      "Opened",
      "Received PING :a",
      "Received PING :b",
      "Received PING :c",
      "Received PING :d",
      "Closed Ended",
    ]);
  });

  it("cuts a Line longer than maxReceivedBytes that arrives over many reads", async () => {
    const lengths = await run(
      Effect.gen(function* () {
        const far = yield* ircd(certificate);

        const link = yield* makeBunTransport({
          route: to(far.port),
          trust: [certificate.cert],
        }).dial(tlsAddress);

        const socket = yield* far.accepted;
        const run = "x".repeat(16_384);

        for (let index = 0; index < 256; index += 1) {
          socket.write(run);
        }

        socket.end("\r\nPING :after\r\n");
        const events = yield* Stream.runCollect(link.events);

        return events.map((event) => (event._tag === "Received" ? event.bytes.length : event._tag));
      })
    );

    expect(lengths).toStrictEqual(["Opened", maxReceivedBytes, 11, "Closed"]);
  });

  it("reads only as fast as the events are read, so a flood waits in the kernel", async () => {
    const waiting = await run(
      Effect.gen(function* () {
        const far = yield* ircd(undefined);
        const link = yield* makeBunTransport({ route: to(far.port) }).dial(plainAddress);
        const socket = yield* far.accepted;
        const flood = bytes.encode(`:irc.test NOTICE * :${"x".repeat(500)}\r\n`.repeat(32_768));

        socket.write(flood);
        yield* Effect.sleep("200 millis");
        // Nothing has read the events, so most of the flood is still the far end's.
        const unsent = socket.writableLength;

        yield* link.hangup;

        return unsent;
      })
    );

    expect(waiting).toBeGreaterThan(1_000_000);
  });

  it("does nothing with a send before Opened", async () => {
    const heard = await run(
      Effect.gen(function* () {
        const far = yield* ircd(undefined);
        const gate = yield* Deferred.make<undefined>();

        const link = yield* makeBunTransport({
          route: () => Effect.as(Deferred.await(gate), { host: "127.0.0.1", port: far.port }),
        }).dial(plainAddress);

        yield* link.send(bytes.encode("NICK early\r\n"));
        yield* Deferred.succeed(gate, undefined);
        const socket = yield* far.accepted;
        const chunks: Buffer[] = [];

        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        // Wait for Opened before sending, as the Runtime does.
        const events = yield* Effect.forkChild(Stream.runCollect(link.events));

        yield* Effect.sleep("20 millis");
        yield* link.send(bytes.encode("NICK late\r\n"));
        yield* Effect.sleep("20 millis");
        yield* link.hangup;
        yield* Fiber.join(events);

        return Buffer.concat(chunks).toString();
      })
    );

    expect(heard).toBe("NICK late\r\n");
  });

  it("ends with HungUp while still connecting, and dials nothing after", async () => {
    const events = await run(
      Effect.gen(function* () {
        const link = yield* makeBunTransport({ route: () => Effect.never }).dial(tlsAddress);

        yield* link.hangup;
        yield* link.send(bytes.encode("QUIT\r\n"));

        return (yield* Stream.runCollect(link.events)).map(show);
      })
    );

    expect(events).toStrictEqual(["Closed HungUp"]);
  });

  it("ends with HungUp and closes the socket", async () => {
    const result = await run(
      Effect.gen(function* () {
        const far = yield* ircd(certificate);

        const link = yield* makeBunTransport({
          route: to(far.port),
          trust: [certificate.cert],
        }).dial(tlsAddress);

        const socket = yield* far.accepted;

        yield* link.hangup;

        return {
          events: (yield* Stream.runCollect(link.events)).map(show),
          far: yield* farClosed(socket),
        };
      })
    );

    expect(result).toStrictEqual({ events: ["Opened", "Closed HungUp"], far: "closed" });
  });

  it("ends without Closed when its Scope closes, and closes the socket", async () => {
    const result = await run(
      Effect.gen(function* () {
        const far = yield* ircd(undefined);

        const { link, socket } = yield* Effect.scoped(
          Effect.gen(function* () {
            const dialled = yield* makeBunTransport({ route: to(far.port) }).dial(plainAddress);

            return { link: dialled, socket: yield* far.accepted };
          })
        );

        return {
          events: (yield* Stream.runCollect(link.events)).map(show),
          far: yield* farClosed(socket),
        };
      })
    );

    expect(result.far).toBe("closed");
    expect(result.events.filter((event) => event.startsWith("Closed"))).toStrictEqual([]);
  });
});
