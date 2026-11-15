/**
 * What the private servers of the end-to-end runs share: loopback ports the kernel picks,
 * release binaries fetched once into `.cache/` and checked against a pinned SHA-256, and
 * children that are killed however the run ends.
 *
 * @packageDocumentation
 */
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type { Subprocess } from "bun";

export const loopback = "127.0.0.1";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

/** What a probe does with bytes it is sent. */
const ignore = (): void => {
  // A probe reads nothing.
};

/**
 * Asks the kernel for a loopback port nothing is using, never 6667.
 * @returns The port.
 */
export const freePort = (): number => {
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
 * @param child - The server's process.
 * @param port - The port it should listen on.
 * @param what - What it is, for the error.
 * @returns Once it listens.
 */
export const waitListening = async (
  child: Subprocess,
  port: number,
  what: string
): Promise<void> => {
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
export const run = async (command: readonly string[], cwd: string): Promise<void> => {
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

/** A release tarball, the checksums file published beside it, and the SHA-256 pinned here. */
export interface Release {
  /** The directory of `.cache/` it is kept in. */
  readonly name: string;
  /** Where the release's files are downloaded from. */
  readonly url: string;
  readonly tarball: string;
  readonly checksums: string;
  readonly sha256: string;
  /** The binary's path in the tarball. */
  readonly binary: string;
}

/**
 * Fetches a release once into `.cache/<name>`, and checks the tarball against both its
 * release's checksums file and the hash pinned here before anything in it runs.
 * @param release - The release.
 * @returns The path of its binary.
 */
export const fetchRelease = async (release: Release): Promise<string> => {
  const cacheDir = path.join(repoRoot, ".cache", release.name);
  const binary = path.join(cacheDir, release.binary);
  await mkdir(cacheDir, { recursive: true });

  const releaseFile = async (name: string): Promise<Uint8Array> => {
    const file = Bun.file(path.join(cacheDir, name));

    if (await file.exists()) {
      return await file.bytes();
    }

    const bytes = await download(`${release.url}/${name}`);
    await Bun.write(file, bytes);

    return bytes;
  };

  const checksums = new TextDecoder().decode(await releaseFile(release.checksums));

  const published = checksums
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .find(([, name]) => name === release.tarball)?.[0];

  const tarball = await releaseFile(release.tarball);
  const actual = sha256(tarball);

  if (published !== actual || actual !== release.sha256) {
    await rm(path.join(cacheDir, release.tarball), { force: true });
    throw new Error(
      `${release.tarball}: SHA-256 ${actual}, published ${published ?? "nothing"}, pinned ${release.sha256}`
    );
  }

  if (!(await Bun.file(binary).exists())) {
    await run(["tar", "-xzf", path.join(cacheDir, release.tarball), "-C", cacheDir], cacheDir);
  }

  return binary;
};

/**
 * Kills a child and removes its directory once stopped, or when this process exits.
 * @param child - The server's process.
 * @param directory - Its temporary directory.
 * @returns What stops it. Safe to call more than once.
 */
export const supervise = (child: Subprocess, directory: string): (() => Promise<void>) => {
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

  // A run that exits, however it ends, still kills its server.
  process.once("exit", () => {
    if (!stopped) {
      child.kill("SIGKILL");
    }
  });

  return stop;
};
