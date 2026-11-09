/**
 * Private Ircds for the end-to-end runs, ported from the transcript spike: an Ergo fetched
 * from its release and checked against a pinned SHA-256, and the machine's ngircd binary.
 * Each runs on loopback ports the kernel just said were free, from a temporary directory,
 * in the foreground, as a child of this process, and is killed and cleaned up by `stop`.
 * Neither is ever the shared ngircd on 127.0.0.1:6667, and neither ever listens on 6667.
 *
 * @packageDocumentation
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import type { Subprocess } from "bun";

const loopback = "127.0.0.1";

/** The Ergo release recorded against, and the SHA-256 its checksums file gave on 2026-11-09. */
const ergoVersion = "2.19.1";
const ergoTarball = `ergo-${ergoVersion}-linux-x86_64.tar.gz`;
const ergoSha256 = "c275f2de8e8eb074c38707136392290172400b5b78616cb9f660351527924b47";
const ergoRelease = `https://github.com/ergochat/ergo/releases/download/v${ergoVersion}`;

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const cacheDir = path.join(repoRoot, ".cache/ergo");

const ngircdBinary = process.env.IIRC_NGIRCD ?? path.join(homedir(), ".local/opt/ngircd/ngircd");

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

/** What a probe does with bytes it is sent. */
const ignore = (): void => {
  // A probe reads nothing.
};

/**
 * Asks the kernel for a loopback port nothing is using, never 6667.
 * @returns The port.
 */
const freePort = (): number => {
  for (;;) {
    const listener = Bun.listen({ hostname: loopback, port: 0, socket: { data: ignore } });
    const { port } = listener;

    listener.stop(true);

    if (port !== 6667) {
      return port;
    }
  }
};

/**
 * Waits until something accepts a TCP Connection on the port, or the child exits.
 * @param child - The Ircd's process.
 * @param port - The port it should listen on.
 * @param what - What it is, for the error.
 * @returns Once it listens.
 */
const waitListening = async (child: Subprocess, port: number, what: string): Promise<void> => {
  const deadline = performance.now() + 20_000;

  while (performance.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${what} exited with ${child.exitCode} before listening`);
    }

    // oxlint-disable-next-line no-await-in-loop -- polling until it listens
    const open = await Bun.connect({
      hostname: loopback,
      port,
      socket: { data: ignore },
    }).then(
      (socket) => {
        socket.end();

        return true;
      },
      () => false
    );

    if (open) {
      return;
    }

    // oxlint-disable-next-line no-await-in-loop -- polling until it listens
    await Bun.sleep(100);
  }

  throw new Error(`${what} did not listen on ${port}`);
};

/**
 * Runs a command to its end, failing unless it exits 0.
 * @param command - The command and its arguments.
 * @param cwd - Where to run it.
 * @returns Once it has exited 0.
 */
const run = async (command: readonly string[], cwd: string): Promise<void> => {
  const child = Bun.spawn([...command], { cwd, stderr: "pipe", stdin: "ignore", stdout: "pipe" });
  const code = await child.exited;

  if (code !== 0) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(`${command[0]} exited with ${code}: ${stderr}`);
  }
};

const sha256 = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/**
 * Downloads a URL with curl, failing on any HTTP error.
 * @param url - The URL.
 * @returns Its bytes.
 */
const download = async (url: string): Promise<Uint8Array> => {
  const child = Bun.spawn(
    [
      "curl",
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--retry",
      "5",
      "--retry-all-errors",
      url,
    ],
    {
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    }
  );

  const [bytes, code] = await Promise.all([new Response(child.stdout).bytes(), child.exited]);

  if (code !== 0) {
    throw new Error(`curl ${url} exited with ${code}: ${await new Response(child.stderr).text()}`);
  }

  return bytes;
};

/**
 * A release file from `.cache/ergo`, downloaded there first if it is missing.
 * @param name - The file's name in the release.
 * @returns Its bytes.
 */
const releaseFile = async (name: string): Promise<Uint8Array> => {
  const file = Bun.file(path.join(cacheDir, name));

  if (await file.exists()) {
    return await file.bytes();
  }

  const bytes = await download(`${ergoRelease}/${name}`);
  await Bun.write(file, bytes);

  return bytes;
};

/**
 * Fetches Ergo once into `.cache/ergo`, and checks the tarball against both its release's
 * checksums file and the hash pinned here before anything in it runs.
 * @returns The path of the binary.
 */
const ensureErgo = async (): Promise<string> => {
  const directory = path.join(cacheDir, `ergo-${ergoVersion}-linux-x86_64`);
  const binary = path.join(directory, "ergo");
  await mkdir(cacheDir, { recursive: true });

  const checksums = new TextDecoder().decode(
    await releaseFile(`ergo-${ergoVersion}-checksums.txt`)
  );

  const published = checksums
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .find(([, name]) => name === ergoTarball)?.[0];

  const tarball = await releaseFile(ergoTarball);
  const actual = sha256(tarball);

  if (published !== actual || actual !== ergoSha256) {
    await rm(path.join(cacheDir, ergoTarball), { force: true });
    throw new Error(
      `${ergoTarball}: SHA-256 ${actual}, published ${published ?? "nothing"}, pinned ${ergoSha256}`
    );
  }

  if (!(await Bun.file(binary).exists())) {
    await run(["tar", "-xzf", path.join(cacheDir, ergoTarball), "-C", cacheDir], cacheDir);
  }

  return binary;
};

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

const supervise = (child: Subprocess, directory: string): (() => Promise<void>) => {
  let stopped = false;

  const stop = async () => {
    if (stopped) {
      return;
    }

    stopped = true;
    child.kill("SIGKILL");
    await child.exited;
    await rm(directory, { force: true, recursive: true });
  };

  // A run that exits, however it ends, still kills its Ircd.
  process.once("exit", () => {
    if (!stopped) {
      child.kill("SIGKILL");
    }
  });

  return stop;
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
  const binary = await ensureErgo();
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
