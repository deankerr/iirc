import { BunServices } from "@effect/platform-bun";
import { assert, beforeAll, describe, it } from "@effect/vitest";
import type { LogEntry } from "@iirc/api";
import {
  eventually,
  scriptedIrcd,
  testAuthority,
  testWire,
  welcoming,
} from "@iirc/session/testing";
import type { Certificate } from "@iirc/session/testing";
import { Effect, FileSystem, Layer } from "effect";
import { FetchHttpClient } from "effect/http";

import {
  appRoot,
  buildBinary,
  buildTimeout,
  freePort,
  healthyClient,
  startBinary,
} from "./testing.ts";

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

const startDaemon = Effect.fnUntraced(function* (
  ircd: { readonly host: string; readonly port: number },
  options: { readonly caFile?: string; readonly flags?: readonly string[] }
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const dataDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "iirc-tls-" });
  const httpPort = yield* freePort;

  const running = yield* startBinary(
    binary,
    [
      "daemon",
      "--network",
      network,
      "--host",
      ircd.host,
      "--port",
      String(ircd.port),
      "--nick",
      nick,
      "--channel",
      channel,
      "--http-port",
      String(httpPort),
      ...(options.flags ?? []),
    ],
    {
      IIRC_DATA_DIR: dataDir,
      ...(options.caFile !== undefined && { NODE_EXTRA_CA_CERTS: options.caFile }),
    }
  );

  const { daemon, health } = yield* healthyClient(httpPort);

  return { daemon, health, running };
});

type Daemon = Effect.Success<ReturnType<typeof startDaemon>>["daemon"];

const allEntries = (daemon: Daemon) => daemon.entries({ query: { after: 0, limit: 1000 } });

const lineTexts = (entries: readonly LogEntry[], direction: "inbound" | "outbound") =>
  entries.flatMap((entry) =>
    entry._tag === "Line" && entry.direction === direction ? [entry.text] : []
  );

// Lines cross both ways, and the Log holds both, with no `closed` to spoil it.
const assertBothWays = Effect.fnUntraced(function* (
  daemon: Daemon,
  ircd: Effect.Success<ReturnType<typeof scriptedIrcd>>
) {
  yield* eventually(daemon.status(), inSession, settleLimit);
  yield* eventually(ircd.received, includesAll(`JOIN ${channel}`), settleLimit);

  yield* daemon.send({ payload: { target: channel, text: "from the Daemon" } });
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

    const { daemon } = yield* startDaemon(
      { host, port: ircd.port },
      caFile === undefined ? {} : { caFile }
    );

    const status = yield* eventually(daemon.status(), isClosed, settleLimit);
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

        const { daemon } = yield* startDaemon(
          { host: localhost, port: ircd.port },
          { caFile: authority.caFile }
        );

        yield* assertBothWays(daemon, ircd);

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

        const { daemon } = yield* startDaemon(
          { host: ircdAddress, port: ircd.port },
          { caFile: authority.caFile }
        );

        yield* assertBothWays(daemon, ircd);

        assert.deepStrictEqual(yield* ircd.serverNames, [undefined]);
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
    "speaks plain IRC from the first byte with `--no-tls`",
    () =>
      Effect.gen(function* () {
        const ircd = yield* scriptedIrcd(welcoming(nick), { hostname: ircdAddress });

        const { daemon } = yield* startDaemon(
          { host: ircdAddress, port: ircd.port },
          { flags: ["--no-tls"] }
        );

        yield* assertBothWays(daemon, ircd);

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
        assert.deepStrictEqual(yield* ircd.received, []);
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

        const { daemon, health, running } = yield* startDaemon(
          { host: ircdAddress, port: wire.port },
          { caFile: authority.caFile }
        );

        yield* eventually(daemon.status(), inSession, settleLimit);
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

        const status = yield* eventually(daemon.status(), isClosed, settleLimit);

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
});
