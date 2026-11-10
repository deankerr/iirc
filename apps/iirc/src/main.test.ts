import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const main = path.join(import.meta.dirname, "main.ts");

const directories: string[] = [];

const temporary = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "iirc-app-"));

  directories.push(directory);

  return directory;
};

const dataDir = () => path.join(temporary(), "data");

const indexHtml = "<!doctype html><title>iirc</title><script src=/assets/app-Ab12Cd34.js></script>";
const appJs = "console.log('iirc');";
const secret = "not for the web";

/**
 * A built web frontend: `index.html` and one hashed asset, with a file beside the
 * directory that must never be served, and symbolic links to it and to the asset.
 * @returns The directory.
 */
const webDir = () => {
  const directory = temporary();
  const web = path.join(directory, "web");

  mkdirSync(path.join(web, "assets"), { recursive: true });
  writeFileSync(path.join(web, "index.html"), indexHtml);
  writeFileSync(path.join(web, "assets", "app-Ab12Cd34.js"), appJs);
  writeFileSync(path.join(directory, "secret.txt"), secret);
  // A file and a directory linked from inside to outside, and a file linked to one inside.
  symlinkSync(path.join("..", "secret.txt"), path.join(web, "leak.txt"));
  symlinkSync("..", path.join(web, "outside"));
  symlinkSync(path.join("assets", "app-Ab12Cd34.js"), path.join(web, "linked.js"));

  return web;
};

/**
 * Sends one request exactly as written, with no client resolving its path first.
 * @param base - The Daemon's base URL.
 * @param target - The request target, such as `/../secret.txt`.
 * @returns The whole response, as text.
 */
const raw = async (base: string, target: string) => {
  const { hostname, port } = new URL(base);
  const socket = connect(Number(port), hostname);

  await once(socket, "connect");
  socket.setEncoding("utf-8");
  // Written, not ended: a client that half-closes may have its response dropped. The
  // server closes once it has answered, as `Connection: close` asks.
  socket.write(
    `GET ${target} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nAccept: text/html\r\nConnection: close\r\n\r\n`
  );

  let response = "";

  for await (const chunk of socket) {
    response += String(chunk);
  }

  return response;
};

const navigate = { headers: { accept: "text/html" } };

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
 * Runs `iirc daemon --web` on a fresh data directory, to its end.
 * @param web - The directory to serve.
 * @returns Its exit code, stdout, and stderr.
 */
const daemonWithWeb = async (web: string) =>
  await iirc("daemon", "--data-dir", dataDir(), "--listen", "127.0.0.1:0", "--web", web);

/**
 * Starts `iirc daemon` on an ephemeral port, and waits until it listens.
 * @param directory - Its data directory.
 * @param args - More arguments, such as `--web`.
 * @returns Where it listens, and the process.
 */
const startDaemon = async (directory: string, ...args: readonly string[]) => {
  const child = Bun.spawn(
    ["bun", main, "daemon", "--data-dir", directory, "--listen", "127.0.0.1:0", ...args],
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

  describe("daemon --web", () => {
    it("serves the web frontend beside the API, which keeps every path under /api", async () => {
      const directory = dataDir();
      const { stdout: key } = await iirc("key", "create", "phone", "--data-dir", directory);
      const { base, child } = await startDaemon(directory, "--web", webDir());

      const get = async (target: string, init: RequestInit = navigate) => {
        const response = await fetch(`${base}${target}`, init);

        return {
          body: await response.text(),
          cache: response.headers.get("cache-control"),
          status: response.status,
          type: response.headers.get("content-type"),
        };
      };

      const root = await fetch(base, navigate);
      const page = await get("/");
      const deep = await get("/some/where");
      const asset = await get("/assets/app-Ab12Cd34.js");
      const missingAsset = await get("/assets/gone-Zz99.js");
      const notNavigating = await get("/some/where", {});

      const api = await Promise.all(
        ["/api/nope", "/api", "/api/", "/api/networks/x/nope", "/%61pi/nope"].map(
          async (target) => await get(target)
        )
      );

      const unauthorized = await get("/api/networks");

      const authorized = await get("/api/networks", {
        headers: { authorization: `Bearer ${key.trim()}` },
      });

      const traversals = await Promise.all(
        [
          "/../secret.txt",
          "/..%2fsecret.txt",
          "/%2e%2e/secret.txt",
          "/assets/..%2f..%2fsecret.txt",
          "/assets/%2e%2e/%2e%2e/secret.txt",
        ].map(async (target) => await raw(base, target))
      );

      // Read as a path, each of these is under `/api`, so none may fall back to the page.
      const apiAsWritten = await Promise.all(
        [
          "/assets/../api/nope",
          "//api/nope",
          "///api/x",
          "/./api/x",
          "/%2Fapi/x",
          "/%2fapi/x",
          String.raw`/\api/x`,
          "/%5Capi/x",
          String.raw`/\api\x`,
        ].map(async (target) => await raw(base, target))
      );

      const linked = {
        directory: await raw(base, "/outside/secret.txt"),
        file: await raw(base, "/leak.txt"),
        inside: await get("/linked.js"),
      };

      child.kill("SIGTERM");
      await child.exited;

      expect({
        api,
        apiAsWritten: apiAsWritten.map((response) => ({
          page: response.includes(indexHtml),
          status: response.split(" ")[1],
        })),
        asset,
        authorized: [authorized.status, authorized.body],
        deep,
        headers: {
          csp: root.headers.get("content-security-policy"),
          nosniff: root.headers.get("x-content-type-options"),
          referrer: root.headers.get("referrer-policy"),
        },
        linked: {
          directory: [linked.directory.split(" ")[1], linked.directory.includes(secret)],
          file: [linked.file.split(" ")[1], linked.file.includes(secret)],
          inside: linked.inside,
        },
        missingAsset: [missingAsset.status, missingAsset.cache],
        notNavigating: notNavigating.status,
        page,
        traversals: traversals.map((response) => ({
          leaked: response.includes(secret),
          status: response.split(" ")[1],
        })),
        unauthorized: [unauthorized.status, unauthorized.body],
      }).toStrictEqual({
        api: Array.from({ length: 5 }, () => ({ body: "", cache: null, status: 404, type: null })),
        apiAsWritten: Array.from({ length: 9 }, () => ({ page: false, status: "404" })),
        asset: {
          body: appJs,
          cache: "public, max-age=31536000, immutable",
          status: 200,
          type: "text/javascript; charset=utf-8",
        },
        authorized: [200, "[]"],
        deep: { body: indexHtml, cache: "no-cache", status: 200, type: "text/html; charset=utf-8" },
        headers: {
          csp: "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          nosniff: "nosniff",
          referrer: "no-referrer",
        },
        // A link out of the directory is refused, whether to a file or through a
        // directory. One that stays inside is served: what matters is where the bytes are.
        linked: {
          directory: ["404", false],
          file: ["404", false],
          inside: {
            body: appJs,
            cache: "no-cache",
            status: 200,
            type: "text/javascript; charset=utf-8",
          },
        },
        missingAsset: [404, null],
        notNavigating: 404,
        page: { body: indexHtml, cache: "no-cache", status: 200, type: "text/html; charset=utf-8" },
        traversals: Array.from({ length: 5 }, () => ({ leaked: false, status: "404" })),
        unauthorized: [401, '{"_tag":"Unauthorized"}'],
      });
    });

    it("answers a path under /api it does not have as a Daemon without --web does", async () => {
      const { base, child } = await startDaemon(dataDir());
      const response = await fetch(`${base}/api/nope`, navigate);
      const body = await response.text();

      child.kill("SIGTERM");
      await child.exited;

      expect([response.status, body, response.headers.get("content-type")]).toStrictEqual([
        404,
        "",
        null,
      ]);
    });

    it("refuses to start without a directory holding index.html, in one line", async () => {
      const missing = path.join(temporary(), "nowhere");
      const empty = temporary();

      const noDirectory = await daemonWithWeb(missing);
      const noIndex = await daemonWithWeb(empty);

      expect({
        noDirectory: [noDirectory.code, noDirectory.stderr],
        noIndex: [noIndex.code, noIndex.stderr],
      }).toStrictEqual({
        noDirectory: [
          1,
          `The web frontend in ${missing} could not be served: it holds no index.html. Build it with bun run build:web.\n`,
        ],
        noIndex: [
          1,
          `The web frontend in ${empty} could not be served: it holds no index.html. Build it with bun run build:web.\n`,
        ],
      });
    });
  });
});
