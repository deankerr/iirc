/// <reference lib="dom" />
/**
 * What the end-to-end runs share: running `iirc`, from source or compiled, starting its
 * Daemon on a port the kernel picks, and a page that keeps what the console says.
 *
 * @packageDocumentation
 */
import { once } from "node:events";
import { connect } from "node:net";

import type { Browser } from "playwright";

/**
 * Runs `iirc` to its end.
 * @param command - How to run it, such as `["bun", "src/main.ts"]` or a compiled executable.
 * @param args - Its arguments.
 * @returns Its exit code, stdout, and stderr.
 */
export const run = async (command: readonly string[], ...args: readonly string[]) => {
  const child = Bun.spawn([...command, ...args], { stderr: "pipe", stdout: "pipe" });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { code, stderr, stdout };
};

/**
 * Sends one request exactly as written, with no client resolving its path first.
 * @param base - The Daemon's base URL.
 * @param target - The request target, such as `/../secret.txt`.
 * @param accept - What it accepts, `text/html` for a navigation.
 * @returns The whole response, as text.
 */
export const raw = async (base: string, target: string, accept: string) => {
  const { hostname, port } = new URL(base);
  const socket = connect(Number(port), hostname);

  await once(socket, "connect");
  socket.setEncoding("utf-8");
  // Written, not ended: a client that half-closes may have its response dropped. The
  // server closes once it has answered, as `Connection: close` asks.
  socket.write(
    `GET ${target} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nAccept: ${accept}\r\nConnection: close\r\n\r\n`
  );

  let response = "";

  for await (const chunk of socket) {
    response += String(chunk);
  }

  return response;
};

/**
 * Starts `iirc daemon` in a working directory, on a port the kernel picks, and waits until it
 * listens.
 * @param cwd - The directory it starts in.
 * @param command - How to run `iirc`.
 * @param dataDir - Its data directory.
 * @param args - More arguments, such as `--web`.
 * @returns Where it listens, and the process.
 */
export const startDaemonIn = async (
  cwd: string,
  command: readonly string[],
  dataDir: string,
  ...args: readonly string[]
) => {
  const child = Bun.spawn(
    [...command, "daemon", "--data-dir", dataDir, "--listen", "127.0.0.1:0", ...args],
    { cwd, stderr: "pipe", stdout: "inherit" }
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

/**
 * Starts `iirc daemon` on a port the kernel picks, and waits until it listens.
 * @param command - How to run `iirc`.
 * @param dataDir - Its data directory.
 * @param args - More arguments, such as `--web`.
 * @returns Where it listens, and the process.
 */
export const startDaemon = async (
  command: readonly string[],
  dataDir: string,
  ...args: readonly string[]
) => await startDaemonIn(process.cwd(), command, dataDir, ...args);

/**
 * A page that keeps every Content Security Policy violation it meets where the test can
 * read it, and every error the console shows.
 * @param browser - The browser.
 * @returns The page, and the errors.
 */
export const watchedPage = async (browser: Browser) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const problems: string[] = [];

  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const root = document.documentElement;

      root.dataset.cspViolations = `${root.dataset.cspViolations ?? ""}${event.violatedDirective} ${event.blockedURI};`;
    });
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push(message.text());
    }
  });
  page.on("pageerror", (error) => problems.push(error.message));

  return { page, problems };
};
