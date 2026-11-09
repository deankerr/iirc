import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const main = path.join(import.meta.dirname, "main.ts");

const directories: string[] = [];

const dataDir = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "iirc-app-"));

  directories.push(directory);

  return path.join(directory, "data");
};

/**
 * Runs `iirc` to its end.
 * @param args - Its arguments.
 * @returns Its exit code, stdout, and stderr.
 */
const iirc = async (...args: readonly string[]) => {
  const child = Bun.spawn(["bun", main, ...args], { stderr: "pipe", stdout: "pipe" });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { code, stderr, stdout };
};

/**
 * Starts `iirc daemon` on an ephemeral port, and waits until it listens.
 * @param directory - Its data directory.
 * @returns Where it listens, and the process.
 */
const startDaemon = async (directory: string) => {
  const child = Bun.spawn(
    ["bun", main, "daemon", "--data-dir", directory, "--listen", "127.0.0.1:0"],
    {
      stderr: "pipe",
      stdout: "pipe",
    }
  );

  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  let logged = "";

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- reading the log in order
    const chunk = await reader.read();

    if (chunk.done) {
      throw new Error(`the Daemon ended before listening: ${logged}`);
    }

    logged += decoder.decode(chunk.value);
    const port = /Listening on http:\/\/127\.0\.0\.1:(?<port>\d+)/u.exec(logged)?.groups?.port;

    if (port !== undefined) {
      reader.releaseLock();

      return { base: `http://127.0.0.1:${port}`, child };
    }
  }
};

describe("iirc", () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  describe("key create", () => {
    it("prints the key once on stdout, and refuses a name taken", async () => {
      const directory = dataDir();
      const first = await iirc("key", "create", "phone", "--data-dir", directory);
      const again = await iirc("key", "create", "phone", "--data-dir", directory);

      expect({
        again: [again.code, again.stdout, again.stderr.trim()],
        first: [first.code, /^iirc_[\w-]{43}\n$/u.test(first.stdout), first.stderr],
      }).toStrictEqual({
        again: [1, "", "A key named phone already exists. Choose another name."],
        first: [0, true, ""],
      });
    });
  });

  describe("daemon", () => {
    it("serves the API to its keys, holds its data directory, and exits 0 on SIGTERM", async () => {
      const directory = dataDir();
      const { stdout: key } = await iirc("key", "create", "phone", "--data-dir", directory);
      const { base, child } = await startDaemon(directory);

      const withKey = await fetch(`${base}/api/networks`, {
        headers: { authorization: `Bearer ${key.trim()}` },
      });

      const withoutKey = await fetch(`${base}/api/networks`);
      const second = await iirc("daemon", "--data-dir", directory, "--listen", "127.0.0.1:0");
      const keyWhileRunning = await iirc("key", "create", "agent", "--data-dir", directory);

      child.kill("SIGTERM");

      expect({
        exited: await child.exited,
        keyWhileRunning: keyWhileRunning.code,
        second: [second.code, second.stderr.includes("held by another process")],
        statuses: [withKey.status, await withKey.text(), withoutKey.status],
      }).toStrictEqual({
        exited: 0,
        keyWhileRunning: 1,
        second: [1, true],
        statuses: [200, "[]", 401],
      });
    });

    it("exits 0 on SIGINT", async () => {
      const { child } = await startDaemon(dataDir());

      child.kill("SIGINT");

      await expect(child.exited).resolves.toBe(0);
    });

    it("refuses a listen address it cannot read", async () => {
      const result = await iirc("daemon", "--data-dir", dataDir(), "--listen", "localhost");

      expect(result.code).not.toBe(0);
    });
  });
});
