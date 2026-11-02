import { BunServices } from "@effect/platform-bun";
import { assert, beforeAll, describe, it } from "@effect/vitest";
import { NetworkSettings } from "@iirc/api";
import type { LogEntry } from "@iirc/api";
import {
  eventually,
  scriptedIrcd,
  testAuthority,
  testWire,
  welcoming,
} from "@iirc/session/testing";
import type { Certificate } from "@iirc/session/testing";
import { Effect, Exit, FileSystem, Layer, Schema, Scope } from "effect";
import { FetchHttpClient } from "effect/http";

import {
  appRoot,
  createKey,
  freePort,
  healthyClient,
  networkStatus,
  startBinary,
} from "./binary.ts";
import { buildBinary, buildTimeout } from "./testing.ts";

// CONN-1 against the real thing: the minified binary, on a real socket, with nothing
// faked but the authority it trusts. It trusts what `NODE_EXTRA_CA_CERTS` names, and a
// test that leaves that out shows the variable is what did the trusting.

const binary = `${appRoot}/dist/iirc-tls`;

const testTimeout = 20_000;

const network = "tls";
const channel = "#tls";
const nick = "iirc";

const localhost = "localhost";

// Other software on this machine dials 127.0.0.1, and nothing dials these.
const ircdAddress = "127.77.0.1";
const otherAddress = "127.77.0.2";
const unusedName = "irc.elsewhere.test";

// A Connection refused, or a Session reached, is far quicker than this.
const settleLimit = "10 seconds";

const tlsHandshakeRecord = 0x16;
const applicationDataRecord = 0x17;
const recordVersion = [0x03, 0x03];
const garbageLength = 64;

const isClosed = ({ phase }: { readonly phase: string }) => phase === "closed";
const inSession = ({ phase }: { readonly phase: string }) => phase === "session";

const includesAll =
  (...wanted: readonly string[]) =>
  (received: readonly string[]) =>
    wanted.every((line) => received.includes(line));

// Quick to come back, for the tests that hang up on it.
const reconnecting = { reconnectInitialMillis: 50, reconnectMaxMillis: 50 };

const decodeSettings = Schema.decodeUnknownSync(NetworkSettings);

/** How a test's Network reaches its Ircd, beyond where it is. */
interface Reaching {
  readonly caFile?: string;
  readonly pin?: string;
  readonly tls?: boolean;
  readonly tuning?: Readonly<Record<string, number>>;
}

const startDaemon = Effect.fnUntraced(function* (
  ircd: { readonly host: string; readonly port: number },
  options: Reaching
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const dataDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "iirc-tls-" });
  const httpPort = yield* freePort;
  const key = yield* createKey(binary, dataDir);

  const running = yield* startBinary(binary, ["daemon", "--http-port", String(httpPort)], {
    IIRC_DATA_DIR: dataDir,
    ...(options.caFile !== undefined && { NODE_EXTRA_CA_CERTS: options.caFile }),
  });

  const client = yield* healthyClient(httpPort, key);

  // Decoded from what the Owner would write, so that anything left out takes its default,
  // and TLS above all (CONN-1).
  yield* client.networks.add({
    payload: decodeSettings({
      channels: [{ name: channel }],
      id: network,
      identity: { nick },
      ircds: [
        {
          host: ircd.host,
          port: ircd.port,
          ...(options.tls !== undefined && { tls: options.tls }),
          ...(options.pin !== undefined && { pin: options.pin }),
        },
      ],
      ...(options.tuning !== undefined && { tuning: options.tuning }),
    }),
  });

  return {
    daemon: client.daemon,
    health: client.health,
    running,
    status: networkStatus(client, network),
  };
});

type Started = Effect.Success<ReturnType<typeof startDaemon>>;

type Daemon = Started["daemon"];

const allEntries = (daemon: Daemon) => daemon.entries({ query: { after: 0, limit: 1000 } });

const lineTexts = (entries: readonly LogEntry[], direction: "inbound" | "outbound") =>
  entries.flatMap((entry) =>
    entry._tag === "Line" && entry.direction === direction ? [entry.text] : []
  );

// Lines cross both ways, and the Log holds both, with no `closed` to spoil it.
const assertBothWays = Effect.fnUntraced(function* (
  { daemon, status }: Started,
  ircd: Effect.Success<ReturnType<typeof scriptedIrcd>>
) {
  yield* eventually(status, inSession, settleLimit);
  yield* eventually(ircd.received, includesAll(`JOIN ${channel}`), settleLimit);

  yield* daemon.send({ payload: { network, target: channel, text: "from the Daemon" } });
  yield* eventually(ircd.received, includesAll(`PRIVMSG ${channel} :from the Daemon`));

  yield* ircd.push(`:peer!u@host PRIVMSG ${channel} :from the Ircd`);
  yield* ircd.push("PING :tls-token");
  yield* eventually(ircd.received, includesAll("PONG tls-token"));

  const messages = yield* daemon.messages({ query: { after: 0, limit: 1000 } });
  const entries = yield* allEntries(daemon);

  assert.deepStrictEqual(
    messages.map(({ sender, text }) => [sender, text]),
    [
      [nick, "from the Daemon"],
      ["peer", "from the Ircd"],
    ]
  );
  assert.deepStrictEqual(lineTexts(entries, "outbound").slice(0, 2), [
    `NICK ${nick}`,
    "USER iirc 0 * iirc",
  ]);
  assert.include(lineTexts(entries, "inbound"), `:ircd 001 ${nick} :Welcome`);
  assert.deepStrictEqual((yield* ircd.received).slice(0, 2), [
    `NICK ${nick}`,
    "USER iirc 0 * iirc",
  ]);
});

// A refusal is `attempt` then `closed`, says why, and leaves nothing on the wire.
const refuses = (options: {
  readonly caFile: string | undefined;
  readonly certificate: Certificate;
  readonly host: string;
  readonly listen: string;
  readonly reason: string;
}) =>
  Effect.gen(function* () {
    const { caFile, certificate, host, listen, reason } = options;
    const ircd = yield* scriptedIrcd(welcoming(nick), { hostname: listen, tls: certificate });

    const { daemon, status: current } = yield* startDaemon(
      { host, port: ircd.port },
      caFile === undefined ? {} : { caFile }
    );

    const status = yield* eventually(current, isClosed, settleLimit);
    const entries = yield* allEntries(daemon);

    assert.include(status.closeReason, `could not connect to ${host}:${ircd.port}: `);
    assert.include(status.closeReason, reason);
    assert.deepStrictEqual(
      entries.flatMap((entry) => (entry._tag === "Connection" ? [entry.phase] : [])),
      ["attempt", "closed"]
    );
    assert.lengthOf(
      entries.filter(({ _tag }) => _tag === "Line"),
      0
    );
    assert.deepStrictEqual(yield* ircd.received, []);
    assert.lengthOf(yield* ircd.bytes, 0);
  }).pipe(Effect.scoped);

// The pin as `curl --pinnedpubkey` would want it, worked out by OpenSSL alone, so that it
// owes nothing to how the Daemon reads a certificate.
const opensslPin = (cert: string) => {
  const { exitCode, stdout } = Bun.spawnSync(
    [
      "sh",
      "-c",
      "openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64",
    ],
    { stdin: Buffer.from(cert) }
  );

  assert.strictEqual(exitCode, 0);

  return `sha256/${stdout.toString().trim()}`;
};

const layers = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);

describe("the compiled binary over TLS (CONN-1)", () => {
  beforeAll(async () => {
    await Effect.runPromise(buildBinary(binary));
  }, buildTimeout);

  it.live(
    "reaches a Session on a trusted certificate for its hostname, sending SNI",
    () =>
      Effect.gen(function* () {
        const authority = yield* testAuthority("iirc test CA");

        const ircd = yield* scriptedIrcd(welcoming(nick), {
          tls: authority.issue(`DNS:${localhost}`),
        });

        const started = yield* startDaemon(
          { host: localhost, port: ircd.port },
          { caFile: authority.caFile }
        );

        yield* assertBothWays(started, ircd);

        assert.deepStrictEqual(yield* ircd.serverNames, [localhost]);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "reaches a Session on a trusted certificate for an IP literal, sending no SNI",
    () =>
      Effect.gen(function* () {
        const authority = yield* testAuthority("iirc test CA");

        const ircd = yield* scriptedIrcd(welcoming(nick), {
          hostname: ircdAddress,
          tls: authority.issue(`IP:${ircdAddress}`),
        });

        const started = yield* startDaemon(
          { host: ircdAddress, port: ircd.port },
          { caFile: authority.caFile }
        );

        yield* assertBothWays(started, ircd);

        assert.deepStrictEqual(yield* ircd.serverNames, [undefined]);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "verifies again on a reconnect, and carries on over TLS",
    () =>
      Effect.gen(function* () {
        const authority = yield* testAuthority("iirc test CA");

        const ircd = yield* scriptedIrcd(welcoming(nick), {
          tls: authority.issue(`DNS:${localhost}`),
        });

        const started = yield* startDaemon(
          { host: localhost, port: ircd.port },
          {
            caFile: authority.caFile,
            tuning: reconnecting,
          }
        );

        yield* assertBothWays(started, ircd);
        yield* ircd.hangUp;

        yield* eventually(ircd.accepted, (accepted) => accepted === 2, settleLimit);
        yield* eventually(started.status, inSession, settleLimit);
        yield* eventually(ircd.receivedOn(1), includesAll(`JOIN ${channel}`), settleLimit);

        yield* started.daemon.send({
          payload: { network, target: channel, text: "after the reconnect" },
        });
        yield* eventually(
          ircd.receivedOn(1),
          includesAll(`PRIVMSG ${channel} :after the reconnect`)
        );

        const entries = yield* allEntries(started.daemon);

        assert.deepStrictEqual(yield* ircd.serverNames, [localhost, localhost]);
        assert.deepStrictEqual(
          entries.flatMap((entry) => (entry._tag === "Connection" ? [entry.phase] : [])),
          ["attempt", "opened", "closed", "attempt", "opened"]
        );
        assert.isTrue(
          entries.every((entry) => entry._tag !== "Connection" || entry.ircd.tls),
          "a reconnect must not fall back to plaintext"
        );
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "will not go back to an Ircd whose certificate has stopped being good, on a reconnect",
    () =>
      Effect.gen(function* () {
        const authority = yield* testAuthority("iirc test CA");
        const stranger = yield* testAuthority("iirc stranger CA");
        const port = yield* freePort;

        const listening = yield* Effect.acquireRelease(Scope.make(), (scope) =>
          Scope.close(scope, Exit.void)
        );

        const ircd = yield* scriptedIrcd(welcoming(nick), {
          port,
          tls: authority.issue(`DNS:${localhost}`),
        }).pipe(Scope.provide(listening));

        const { daemon, status } = yield* startDaemon(
          { host: localhost, port },
          { caFile: authority.caFile, tuning: reconnecting }
        );

        yield* eventually(status, inSession, settleLimit);
        yield* eventually(ircd.received, includesAll(`JOIN ${channel}`), settleLimit);
        yield* Scope.close(listening, Exit.void);

        const impostor = yield* scriptedIrcd(welcoming(nick), {
          port,
          tls: stranger.issue(`DNS:${localhost}`),
        });

        const closes = yield* eventually(
          allEntries(daemon),
          (entries) =>
            entries.some(
              (entry) =>
                entry._tag === "Connection" &&
                entry.phase === "closed" &&
                entry.reason?.includes("unable to verify") === true
            ),
          settleLimit
        );

        assert.isNotEmpty(closes);
        assert.deepStrictEqual(yield* impostor.received, []);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "refuses a certificate for another hostname",
    () =>
      Effect.gen(function* () {
        const authority = yield* testAuthority("iirc test CA");

        yield* refuses({
          caFile: authority.caFile,
          certificate: authority.issue(`DNS:${unusedName}`, localhost),
          host: localhost,
          listen: "127.0.0.1",
          reason: "altnames",
        });
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  // With no SNI to compare, these are what rest on the fallback to `host`.
  it.live(
    "refuses an IP literal whose certificate is for another address, or for no address",
    () =>
      Effect.gen(function* () {
        const authority = yield* testAuthority("iirc test CA");

        const check = (certificate: Certificate) =>
          refuses({
            caFile: authority.caFile,
            certificate,
            host: ircdAddress,
            listen: ircdAddress,
            reason: `IP: ${ircdAddress} is not in the cert's list`,
          });

        yield* check(authority.issue(`IP:${otherAddress}`));
        yield* check(authority.issue(`DNS:${unusedName}`));
        // An address spelled as a name, or as a CN, is not a claim to that address.
        yield* check(authority.issue(`DNS:${ircdAddress}`));
        yield* check(authority.issue(`DNS:${unusedName}`, ircdAddress));
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "refuses a certificate from an authority it does not trust",
    () =>
      Effect.gen(function* () {
        const trusted = yield* testAuthority("iirc test CA");
        const stranger = yield* testAuthority("iirc stranger CA");
        const identity = `DNS:${localhost}`;

        yield* refuses({
          caFile: trusted.caFile,
          certificate: stranger.issue(identity),
          host: localhost,
          listen: "127.0.0.1",
          reason: "unable to verify",
        });

        yield* refuses({
          caFile: trusted.caFile,
          certificate: trusted.selfSigned(identity),
          host: localhost,
          listen: "127.0.0.1",
          reason: "self signed",
        });

        // The certificate that passes above, without the authority behind it.
        yield* refuses({
          caFile: undefined,
          certificate: trusted.issue(identity),
          host: localhost,
          listen: "127.0.0.1",
          reason: "unable to verify",
        });
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "speaks plain IRC from the first byte with `tls: false`",
    () =>
      Effect.gen(function* () {
        const ircd = yield* scriptedIrcd(welcoming(nick), { hostname: ircdAddress });

        const started = yield* startDaemon({ host: ircdAddress, port: ircd.port }, { tls: false });

        yield* assertBothWays(started, ircd);

        const bytes = yield* ircd.bytes;
        const start = `NICK ${nick}\r\n`;

        assert.strictEqual(Buffer.from(bytes).toString("latin1", 0, start.length), start);
        assert.notInclude([...bytes], tlsHandshakeRecord);
        assert.deepStrictEqual(yield* ircd.serverNames, []);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "opens with a TLS handshake when told nothing, which plain IRC never sees",
    () =>
      Effect.gen(function* () {
        const ircd = yield* scriptedIrcd(welcoming(nick), { hostname: ircdAddress });
        const { daemon } = yield* startDaemon({ host: ircdAddress, port: ircd.port }, {});

        const bytes = yield* eventually(ircd.bytes, ({ length }) => length > 0, settleLimit);
        const entries = yield* allEntries(daemon);

        assert.strictEqual(bytes[0], tlsHandshakeRecord);
        // Not `received` being empty: a handshake is random, and holds a CRLF now and then.
        assert.notInclude(Buffer.from(bytes).toString("latin1"), `NICK ${nick}`);
        assert.lengthOf(
          entries.filter(({ _tag }) => _tag === "Line"),
          0
        );
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "survives a TLS error after the handshake, says so, and keeps what came first",
    () =>
      Effect.gen(function* () {
        const authority = yield* testAuthority("iirc test CA");

        const ircd = yield* scriptedIrcd(welcoming(nick), {
          hostname: ircdAddress,
          tls: authority.issue(`IP:${ircdAddress}`),
        });

        const wire = yield* testWire(ircd.port, ircdAddress);

        const {
          daemon,
          health,
          running,
          status: current,
        } = yield* startDaemon(
          { host: ircdAddress, port: wire.port },
          { caFile: authority.caFile }
        );

        yield* eventually(current, inSession, settleLimit);
        yield* eventually(ircd.received, includesAll(`JOIN ${channel}`), settleLimit);
        yield* ircd.push("NOTICE * :before the damage");
        yield* eventually(allEntries(daemon), (entries) =>
          lineTexts(entries, "inbound").includes("NOTICE * :before the damage")
        );

        // A record no key opens, so the failure is TLS itself and not a hang-up.
        yield* wire.inject(
          new Uint8Array([
            applicationDataRecord,
            ...recordVersion,
            0,
            garbageLength,
            ...Array.from({ length: garbageLength }, () => 0xab),
          ])
        );

        const status = yield* eventually(current, isClosed, settleLimit);

        assert.include(status.closeReason, "read failed: ");
        assert.isTrue(yield* running.child.isRunning);
        assert.deepStrictEqual(yield* health.health(), { status: "ok" });
        assert.lengthOf(
          (yield* allEntries(daemon)).filter(
            (entry) => entry._tag === "Connection" && entry.phase === "closed"
          ),
          1
        );
        assert.notInclude(running.output(), "ERROR");

        yield* wire.untilGone;
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );
  it.live(
    "takes a self-signed certificate by its pin, under a name it is not for",
    () =>
      Effect.gen(function* () {
        const authority = yield* testAuthority("iirc pinning");
        const certificate = authority.selfSigned(`DNS:${unusedName}`);
        const pin = opensslPin(certificate.cert);

        const ircd = yield* scriptedIrcd(welcoming(nick), {
          hostname: ircdAddress,
          tls: certificate,
        });

        // No authority is trusted here, so only the pin can be what lets it through.
        const started = yield* startDaemon({ host: ircdAddress, port: ircd.port }, { pin });

        yield* assertBothWays(started, ircd);

        const opened = (yield* allEntries(started.daemon)).find(
          (entry) => entry._tag === "Connection" && entry.phase === "opened"
        );

        assert.deepInclude(opened, { phase: "opened" });
        assert.deepInclude(
          opened?._tag === "Connection" && opened.phase === "opened" ? opened.tls : {},
          {
            pin,
            verifiedBy: "pin",
          }
        );
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "refuses a key that is not its pin, and says which key it was shown",
    () =>
      Effect.gen(function* () {
        const authority = yield* testAuthority("iirc pinning");
        const certificate = authority.selfSigned(`DNS:${unusedName}`);
        const presented = opensslPin(certificate.cert);
        const elsewhere = opensslPin(authority.selfSigned(`DNS:${unusedName}`).cert);

        assert.notStrictEqual(elsewhere, presented);

        const ircd = yield* scriptedIrcd(welcoming(nick), {
          hostname: ircdAddress,
          tls: certificate,
        });

        const { daemon, status } = yield* startDaemon(
          { host: ircdAddress, port: ircd.port },
          { pin: elsewhere }
        );

        const closed = yield* eventually(status, isClosed, settleLimit);
        const entries = yield* allEntries(daemon);

        // The pin the Ircd showed, so that the Owner can check it and pin it.
        assert.include(
          closed.closeReason,
          `${ircdAddress}:${ircd.port} presented the key ${presented}, which is not its pin ${elsewhere}`
        );
        assert.isFalse(closed.refused, "a wrong pin backs off like any failure");
        assert.deepStrictEqual(
          entries.flatMap((entry) => (entry._tag === "Connection" ? [entry.phase] : [])),
          ["attempt", "closed"]
        );
        assert.lengthOf(
          entries.filter(({ _tag }) => _tag === "Line"),
          0
        );
        assert.deepStrictEqual(yield* ircd.received, []);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );
});
