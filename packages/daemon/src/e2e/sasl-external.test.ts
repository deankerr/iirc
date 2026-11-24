/**
 * End-to-end: a Daemon presents a client certificate a Credential holds, and logs in to an
 * account on Ergo with SASL EXTERNAL by it, with no password anywhere. Run on purpose with
 * `bun run e2e`, and never in `bun run test`.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";

import { CredentialPathName, NetworkId } from "@iirc/api";
import { configured } from "@iirc/client/testing";
import { Effect, Redacted } from "effect";
import type { Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { run as runCommand } from "../testing/children.ts";
import { startErgo } from "../testing/ircd.ts";
import type { Ircd } from "../testing/ircd.ts";
import { connectPeer } from "../testing/peer.ts";
import { eventually, startDaemon } from "../testing/running.ts";
import { makeKey, temporaryDirectory } from "../testing/world.ts";

const network = NetworkId.make("private");
const channel = "#iirc-e2e";
const account = "certy";

const run = async <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(test));

/**
 * Makes a self-signed client certificate and its key, and reads its SHA-256 fingerprint,
 * as Ergo names a certificate.
 * @param directory - Where to write them.
 * @returns The certificate and key as one PEM, and the fingerprint in lower-case hex.
 */
const clientCertificate = async (directory: string) => {
  await runCommand(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "2",
      "-subj",
      `/CN=${account}`,
      "-keyout",
      "client.key",
      "-out",
      "client.crt",
    ],
    directory
  );

  const certificate = await Bun.file(path.join(directory, "client.crt")).text();
  const key = await Bun.file(path.join(directory, "client.key")).text();

  const fingerprint = new Bun.CryptoHasher("sha256")
    .update(Buffer.from(certificate.replaceAll(/-----[^-]+-----|\s/gu, ""), "base64"))
    .digest("hex");

  return { fingerprint, pem: `${certificate}${key}` };
};

/**
 * Registers an account on Ergo and adds a certificate's fingerprint to it, from a Peer
 * on the plaintext port.
 * @param ergo - The Ergo.
 * @param fingerprint - The fingerprint to add.
 */
const registerWithCertificate = async (ergo: Ircd, fingerprint: string) => {
  const peer = await connectPeer({
    caps: ["draft/account-registration"],
    host: ergo.host,
    nick: account,
    port: ergo.plainPort,
  });

  peer.send("REGISTER * * a-password-nobody-uses");
  await peer.waitFor(
    (line) => line.command === "REGISTER" && line.params[0] === "SUCCESS",
    "REGISTER's success"
  );
  peer.send(`PRIVMSG NickServ :CERT ADD ${fingerprint}`);
  // NickServ answers CERT ADD with one NOTICE. Whether it took is shown by the login.
  await peer.waitFor(
    (line) => line.command === "NOTICE" && line.source?.startsWith("NickServ!") === true,
    "NickServ's answer to CERT ADD"
  );
  peer.send("QUIT");
  peer.close();
};

/**
 * Everything the Daemon wrote under its data directory, the Vault's file aside, as text.
 * @param dataDir - The data directory.
 * @returns Its files' bytes, joined.
 */
const written = (dataDir: string) =>
  Effect.promise(async () => {
    const names = await readdir(dataDir, { recursive: true });

    const texts = await Promise.all(
      names
        .filter((name) => name !== "credentials.json")
        .map(async (name) => {
          const file = Bun.file(path.join(dataDir, name));

          return (await file.exists()) ? await file.text().catch(() => "") : "";
        })
    );

    return texts.join("\n");
  });

describe("Ergo, over TLS with SASL EXTERNAL", () => {
  let ergo: Ircd;

  beforeAll(async () => {
    ergo = await startErgo();
  }, 120_000);

  afterAll(async () => {
    await ergo.stop();
  });

  it("presents the client certificate a Credential holds, logs in by it, and never writes it down", async () => {
    const result = await run(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory;
        const scratch = yield* temporaryDirectory;

        const { fingerprint, pem } = yield* Effect.promise(
          async () => await clientCertificate(scratch)
        );

        yield* Effect.promise(async () => {
          await registerWithCertificate(ergo, fingerprint);
        });

        const key = yield* makeKey(dataDir);
        const tlsPort = ergo.tlsPort ?? 0;

        const daemon = yield* startDaemon(
          {
            dataDir,
            transport: {
              route: () => Effect.succeed({ host: ergo.host, port: tlsPort }),
              trust: [ergo.ca ?? ""],
            },
          },
          key
        );

        const { api } = daemon;
        const credential = CredentialPathName.make("ergo-certificate");

        yield* api.credentials.set({
          params: { name: credential },
          payload: { value: Redacted.make(pem) },
        });
        yield* api.networks.configure({
          params: { network },
          payload: configured({
            channels: [{ name: channel }],
            login: { _tag: "External", required: true },
            nicks: ["iirc"],
            servers: [{ host: "ergo.test", port: tlsPort, tls: true }],
            tls: { _tag: "Certificate", certificate: credential },
          }),
          query: {},
        });

        const known = yield* eventually(api.networks.known({ params: { network } }), (one) =>
          one.channels.some((each) => each.name === channel && each.standing === "Joined")
        );

        const tail = yield* api.tail.read();

        // A line of the certificate's base64 and one of the key's, which nothing else holds.
        const lines = pem.split("\n");

        const bodies = [
          lines[1] ?? pem,
          lines[lines.indexOf("-----BEGIN PRIVATE KEY-----") + 1] ?? pem,
        ];

        const tailed = JSON.stringify(tail);
        const kept = yield* written(dataDir);

        return {
          account: known.self?.account,
          session: known.session._tag,
          tailed: bodies.some((body) => tailed.includes(body)),
          written: bodies.some((body) => kept.includes(body)),
        };
      })
    );

    expect(result).toMatchObject({
      account: { _tag: "Known", value: account },
      session: "Registered",
      tailed: false,
      written: false,
    });
  }, 120_000);
});
