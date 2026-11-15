/**
 * Private Ircds for the end-to-end runs: an Ergo fetched
 * from its release and checked against a pinned SHA-256, and the machine's ngircd binary.
 * Each runs on loopback ports the kernel just said were free, from a temporary directory,
 * in the foreground, as a child of this process, and is killed and cleaned up by `stop`.
 * Neither is ever the shared ngircd on 127.0.0.1:6667, and neither ever listens on 6667.
 *
 * @packageDocumentation
 */
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { fetchRelease, freePort, loopback, run, supervise, waitListening } from "./children.ts";

/** The Ergo release recorded against, and the SHA-256 its checksums file gave on 2026-11-09. */
const ergoVersion = "2.19.1";
const ergoTarball = `ergo-${ergoVersion}-linux-x86_64.tar.gz`;
const ergoSha256 = "c275f2de8e8eb074c38707136392290172400b5b78616cb9f660351527924b47";
const ergoRelease = `https://github.com/ergochat/ergo/releases/download/v${ergoVersion}`;

const ngircdBinary = process.env.IIRC_NGIRCD ?? path.join(homedir(), ".local/opt/ngircd/ngircd");

/** The operator name a private ngircd grants, from any host. */
export const ngircdOperName = "e2eoper";

/** The password of {@link ngircdOperName}. */
export const ngircdOperPassword = "an-oper-password-only-the-vault-holds";

/** A running private Ircd. */
export interface Ircd {
  readonly kind: "ergo" | "ngircd";
  /** The name the transcripts give it, and the name its certificate carries. */
  readonly name: string;
  readonly host: string;
  readonly plainPort: number;
  readonly tlsPort: number | undefined;
  /** The self-signed certificate, as PEM, for a TLS Connection to trust. */
  readonly ca: string | undefined;
  /** Kills it and removes its directory. Safe to call more than once. */
  readonly stop: () => Promise<void>;
}

/**
 * Makes a self-signed certificate for `name` and 127.0.0.1.
 * @param directory - Where to write it and its key.
 * @param name - The DNS name it is for.
 * @returns The certificate, as PEM.
 */
const selfSigned = async (directory: string, name: string): Promise<string> => {
  await run(
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
      `/CN=${name}`,
      "-addext",
      `subjectAltName=DNS:${name},IP:${loopback}`,
      "-keyout",
      "privkey.pem",
      "-out",
      "fullchain.pem",
    ],
    directory
  );

  return await Bun.file(path.join(directory, "fullchain.pem")).text();
};

const ergoConfig = (name: string, plainPort: number, tlsPort: number): string => `
network:
  name: iirc-e2e
server:
  name: ${name}
  listeners:
    "${loopback}:${plainPort}": {}
    "${loopback}:${tlsPort}":
      tls:
        cert: fullchain.pem
        key: privkey.pem
      min-tls-version: 1.2
  sts:
    enabled: false
  casemapping: ascii
  enforce-utf8: true
  lookup-hostnames: false
  check-ident: false
  coerce-ident: "~u"
  motd: ergo.motd
  motd-formatting: false
  idle-timeouts:
    registration: 60s
    ping: 10s
    disconnect: 2m30s
  relaymsg:
    enabled: false
  max-sendq: 96k
  compatibility:
    force-trailing: true
    send-unprefixed-sasl: true
    allow-truncation: false
  ip-limits:
    count: false
    throttle: false
  ip-cloaking:
    enabled: false
accounts:
  authentication-enabled: true
  registration:
    enabled: true
    allow-before-connect: true
    throttling:
      enabled: false
    bcrypt-cost: 4
    email-verification:
      enabled: false
  login-throttling:
    enabled: false
  advertise-scram: true
  require-sasl:
    enabled: false
  nick-reservation:
    enabled: false
  multiclient:
    enabled: false
  vhosts:
    enabled: false
  default-user-modes: +i
channels:
  default-modes: +nt
  max-channels-per-client: 100
  registration:
    enabled: false
limits:
  nicklen: 32
  identlen: 20
  realnamelen: 150
  channellen: 64
  awaylen: 390
  kicklen: 390
  topiclen: 390
  monitor-entries: 100
  whowas-entries: 100
  chan-list-modes: 100
  registration-messages: 1024
  multiline:
    max-bytes: 4096
    max-lines: 100
fakelag:
  enabled: false
history:
  enabled: true
  channel-length: 2048
  client-length: 256
  autoresize-window: 3d
  autoreplay-on-join: 0
  chathistory-maxmessages: 1000
  znc-maxmessages: 2048
  restrictions:
    expire-time: 1w
    query-cutoff: none
    grace-period: 1h
  persistent:
    enabled: false
logging:
  - method: stderr
    type: "* -userinput -useroutput"
    level: warn
lock-file: ircd.lock
datastore:
  path: ircd.db
  autoupgrade: true
languages:
  enabled: false
`;

/**
 * Starts a private Ergo with a plaintext and a TLS listener on loopback.
 * @returns The running Ergo.
 */
export const startErgo = async (): Promise<Ircd> => {
  const binary = await fetchRelease({
    binary: `ergo-${ergoVersion}-linux-x86_64/ergo`,
    checksums: `ergo-${ergoVersion}-checksums.txt`,
    name: "ergo",
    sha256: ergoSha256,
    tarball: ergoTarball,
    url: ergoRelease,
  });

  const directory = await mkdtemp(path.join(tmpdir(), "iirc-e2e-ergo-"));
  const name = "ergo.test";
  const plainPort = freePort();
  const tlsPort = freePort();
  const ca = await selfSigned(directory, name);
  await Bun.write(path.join(directory, "ergo.motd"), "iirc end-to-end\n");
  await Bun.write(path.join(directory, "ircd.yaml"), ergoConfig(name, plainPort, tlsPort));
  await run([binary, "initdb", "--conf", "ircd.yaml", "--quiet"], directory);

  const child = Bun.spawn([binary, "run", "--conf", "ircd.yaml"], {
    cwd: directory,
    stderr: "inherit",
    stdin: "ignore",
    stdout: "inherit",
  });

  const stop = supervise(child, directory);

  try {
    await waitListening(child, plainPort, "ergo");
    await waitListening(child, tlsPort, "ergo");
  } catch (error) {
    await stop();
    throw error;
  }

  return { ca, host: loopback, kind: "ergo", name, plainPort, stop, tlsPort };
};

/**
 * Starts a private ngircd with a plaintext listener on loopback.
 * @returns The running ngircd.
 */
export const startNgircd = async (): Promise<Ircd> => {
  const directory = await mkdtemp(path.join(tmpdir(), "iirc-e2e-ngircd-"));
  const name = "ngircd.test";
  const plainPort = freePort();

  const config = path.join(directory, "ngircd.conf");
  await Bun.write(
    config,
    [
      "[Global]",
      `Name = ${name}`,
      "Info = iirc end-to-end",
      `Listen = ${loopback}`,
      `Ports = ${plainPort}`,
      "AdminInfo1 = iirc end-to-end",
      "AdminInfo2 = loopback only",
      "AdminEMail = nobody@ngircd.test",
      `MotdFile = ${path.join(directory, "ngircd.motd")}`,
      `PidFile = ${path.join(directory, "ngircd.pid")}`,
      "[Limits]",
      "MaxConnectionsIP = 0",
      "PingTimeout = 10",
      "PongTimeout = 20",
      "[Options]",
      "DNS = no",
      "Ident = no",
      "PAM = no",
      "[Operator]",
      `Name = ${ngircdOperName}`,
      `Password = ${ngircdOperPassword}`,
      "",
    ].join("\n")
  );
  await Bun.write(path.join(directory, "ngircd.motd"), "iirc end-to-end\n");
  await run([ngircdBinary, "--configtest", "--config", config], directory);

  const child = Bun.spawn([ngircdBinary, "--nodaemon", "--config", config], {
    cwd: directory,
    stderr: "ignore",
    stdin: "ignore",
    stdout: "ignore",
  });

  const stop = supervise(child, directory);

  try {
    await waitListening(child, plainPort, "ngircd");
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    ca: undefined,
    host: loopback,
    kind: "ngircd",
    name,
    plainPort,
    stop,
    tlsPort: undefined,
  };
};
