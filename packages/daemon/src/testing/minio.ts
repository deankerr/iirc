/**
 * A private MinIO for the end-to-end runs: an S3-compatible bucket server fetched from its
 * release and checked against a pinned SHA-256, run on loopback ports the kernel just said
 * were free, from a temporary directory, in the foreground, as a child of this process.
 *
 * @packageDocumentation
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { fetchRelease, freePort, loopback, supervise, waitListening } from "./children.ts";

// MinIO itself no longer publishes binaries: its download site answers 410, and its
// repository is archived with none attached. pgsty/minio, which calls its build "silo", is a
// maintained fork that does, so the runs use its release, pinned like any other.
const minioRelease = "RELEASE.2026-10-26T00-00-00Z";
const minioVersion = "20261026000000.0.0";

/** The SHA-256 its checksums file gave on 2026-11-15. */
const minioSha256 = "4119e6da79be4f1b9ec9c619f72752f2e26e7447191dba969c02e4795fed8f92";

const accessKeyId = "iirc-e2e";
const secretAccessKey = "a-secret-only-the-e2e-run-holds";

/** A running private MinIO, and one empty bucket in it. */
export interface Minio {
  /** Its S3 API, as `http://127.0.0.1:<port>`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Makes another empty bucket, and gives its name. */
  readonly freshBucket: () => Promise<string>;
  /** Kills it and removes its directory. Safe to call more than once. */
  readonly stop: () => Promise<void>;
}

/**
 * Waits until MinIO says it is ready, since it listens before its drive is.
 * @param endpoint - Its S3 API.
 * @returns Once it is ready.
 */
const waitReady = async (endpoint: string): Promise<void> => {
  const deadline = performance.now() + 20_000;

  while (performance.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling until it is ready
    const ready = await fetch(`${endpoint}/minio/health/ready`).then(
      (response) => response.status === 200,
      () => false
    );

    if (ready) {
      return;
    }

    // oxlint-disable-next-line no-await-in-loop -- polling until it is ready
    await Bun.sleep(100);
  }

  throw new Error(`minio at ${endpoint} was not ready`);
};

/**
 * Starts a private MinIO with one empty bucket, on loopback.
 * @returns The running MinIO.
 */
export const startMinio = async (): Promise<Minio> => {
  const binary = await fetchRelease({
    binary: "silo",
    checksums: `silo_${minioVersion}_checksums.txt`,
    name: "minio",
    sha256: minioSha256,
    tarball: `silo_${minioVersion}_linux_amd64.tar.gz`,
    url: `https://github.com/pgsty/minio/releases/download/${minioRelease}`,
  });

  const directory = await mkdtemp(path.join(tmpdir(), "iirc-e2e-minio-"));
  const data = path.join(directory, "data");
  await mkdir(data);
  const port = freePort();
  const consolePort = freePort();

  const child = Bun.spawn(
    [
      binary,
      "server",
      data,
      "--address",
      `${loopback}:${port}`,
      "--console-address",
      `${loopback}:${consolePort}`,
      "--certs-dir",
      path.join(directory, "certs"),
      "--quiet",
    ],
    {
      cwd: directory,
      env: {
        MINIO_ROOT_PASSWORD: secretAccessKey,
        MINIO_ROOT_USER: accessKeyId,
        PATH: process.env.PATH,
      },
      stderr: "inherit",
      stdin: "ignore",
      stdout: "ignore",
    }
  );

  const stop = supervise(child, directory);
  const endpoint = `http://${loopback}:${port}`;

  try {
    await waitListening(child, port, "minio");
    await waitReady(endpoint);
  } catch (error) {
    await stop();
    throw error;
  }

  let buckets = 0;

  // On one drive, each directory at the drive's top is a bucket, even one made while it
  // runs. Bun's S3 client cannot make a bucket, and this needs no signed request.
  const freshBucket = async () => {
    buckets += 1;
    const bucket = `bucket-${buckets}`;
    await mkdir(path.join(data, bucket));

    return bucket;
  };

  return {
    accessKeyId,
    bucket: await freshBucket(),
    endpoint,
    freshBucket,
    region: "us-east-1",
    secretAccessKey,
    stop,
  };
};
