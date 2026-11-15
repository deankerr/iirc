/// <reference lib="dom" />
/**
 * What the end-to-end runs share: running `iirc`, from source or compiled, starting its
 * Daemon on a port the kernel picks, a page that keeps what the console says, and what a run
 * needs to drive the Composer.
 *
 * @packageDocumentation
 */
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";

import type { Browser, Page } from "playwright";

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

/** How a Network's row ends its label, once its connection is known: the word for it. */
const standingWord = /, (?:connected|offline|stopped)(?:: .*)?$/u;

/**
 * The first Network's row in the sidebar, once its connection is known.
 * @param page - The page.
 * @returns The row's text: its chevron, its id, what is unread, and its connection's symbol.
 */
export const networkRow = async (page: Page) => {
  await page.getByRole("row", { name: standingWord }).first().waitFor();

  return (await page.getByRole("row").first().textContent()) ?? "";
};

/**
 * One chunk of a PNG: its length, type, data, and checksum.
 * @param type - The four letters of its type.
 * @param data - Its data.
 * @returns The chunk's bytes.
 */
const pngChunk = (type: string, data: Uint8Array) => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);

  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, checksum]);
};

/**
 * A PNG of one colour, made here so the run holds real image bytes with no metadata.
 * @param side - Its width and height, in pixels.
 * @param rgb - Its colour.
 * @returns The file's bytes.
 */
export const solidPng = (side: number, rgb: readonly [number, number, number]) => {
  const header = Buffer.alloc(13);

  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header.set([8, 2, 0, 0, 0], 8);

  // Each row is a filter byte, 0, then the pixels.
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: side }, () => rgb).flat()),
  ]);

  const pixels = Buffer.concat(Array.from({ length: side }, () => row));

  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(pixels)),
      pngChunk("IEND", new Uint8Array()),
    ])
  );
};

/**
 * Writes a screenshot where `IIRC_E2E_SCREENSHOTS` says, if it says.
 * @param page - The page.
 * @param name - The file's name.
 */
export const screenshot = async (page: Page, name: string) => {
  const directory = process.env.IIRC_E2E_SCREENSHOTS;

  if (directory !== undefined && directory !== "") {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, name), await page.screenshot());
  }
};
