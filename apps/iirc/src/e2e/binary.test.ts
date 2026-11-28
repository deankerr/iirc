/// <reference lib="dom" />
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { raw, run, startDaemon, watchedPage } from "./daemon.ts";

const app = path.join(import.meta.dirname, "..", "..");
const web = path.join(app, "..", "web", "dist");
const unit = path.join(app, "systemd", "iirc.service");
const analyze = Bun.which("systemd-analyze");

const contentSecurityPolicy =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://w.soundcloud.com https://bandcamp.com https://open.spotify.com https://player.twitch.tv; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/**
 * A loopback port that takes one Connection and keeps every Line it is sent, and answers
 * nothing, which is as far as an Ircd need go for a Daemon to begin registering.
 * @returns Its port, a wait for the first `NICK`, the Lines once the far end hangs up, and a
 * way to stop listening.
 */
const listenAsIrcd = () => {
  const lines: string[] = [];
  const decoder = new TextDecoder();
  const named = Promise.withResolvers<undefined>();
  const closed = Promise.withResolvers<readonly string[]>();
  let buffered = "";

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      close: () => {
        closed.resolve(lines);
      },
      data: (_, chunk) => {
        buffered += decoder.decode(chunk, { stream: true });
        const parts = buffered.split("\r\n");
        buffered = parts.pop() ?? "";
        lines.push(...parts);

        if (lines.some((line) => line.split(" ", 1)[0] === "NICK")) {
          named.resolve(undefined);
        }
      },
    },
  });

  return {
    closed: closed.promise,
    named: named.promise,
    port: server.port,
    stop: () => {
      server.stop(true);
    },
  };
};

/**
 * Compiles `iirc` with `build.ts`, as `bun run build:iirc` does.
 * @param outfile - Where the executable goes.
 * @param args - More arguments, such as `--no-web`.
 */
const build = async (outfile: string, ...args: readonly string[]) => {
  const built = await run(["bun", path.join(app, "build.ts")], "--outfile", outfile, ...args);

  if (built.code !== 0) {
    throw new Error(`iirc did not compile: ${built.stderr}`);
  }
};

/**
 * A response's status line and headers, without its body.
 * @param response - The whole response, as text.
 * @returns The status, and whether a body follows.
 */
const statusOf = (response: string) => ({
  empty: /\r\ncontent-length: 0\r\n/iu.test(response),
  status: response.split(" ", 2)[1],
});

/**
 * The headers a served file is judged by.
 * @param response - The response.
 * @returns Its type, cache header, CSP, and validators.
 */
const headersOf = (response: Response) => ({
  cacheControl: response.headers.get("cache-control"),
  csp: response.headers.get("content-security-policy"),
  etag: response.headers.get("etag"),
  lastModified: response.headers.get("last-modified"),
  type: response.headers.get("content-type"),
});

describe("the compiled iirc", () => {
  let browser: Browser;
  let directory: string;
  let iirc: string;
  let bare: string;

  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "iirc-binary-e2e-"));
    iirc = path.join(directory, "iirc");
    bare = path.join(directory, "iirc-no-web");
    [browser] = await Promise.all([chromium.launch(), build(iirc), build(bare, "--no-web")]);
  }, 120_000);

  afterAll(async () => {
    await browser.close();
    rmSync(directory, { force: true, recursive: true });
  });

  it("refuses --web in one line when built without the web frontend", async () => {
    const refused = await run(
      [bare],
      "daemon",
      "--data-dir",
      path.join(directory, "bare"),
      "--web"
    );

    expect(refused).toStrictEqual({
      code: 1,
      stderr:
        "This build of iirc has no built-in web app, so --web needs a directory, such as --web=apps/web/dist.\n",
      stdout: "",
    });
  });

  it(
    "serves the web frontend built into it beside the API, and a browser signs in",
    { timeout: 60_000 },
    async () => {
      const dataDir = path.join(directory, "data");
      const created = await run([iirc], "key", "create", "browser", "--data-dir", dataDir);
      const key = created.stdout.trim();
      const { base, child } = await startDaemon([iirc], dataDir, "--web");

      try {
        const indexHtml = readFileSync(path.join(web, "index.html"), "utf-8");

        const script = /<script[^>]+src="\/(?<asset>assets\/[^"]+\.js)"/u.exec(indexHtml)?.groups
          ?.asset;

        if (script === undefined) {
          throw new Error("the built index.html names no script under assets/");
        }

        // A font, which the page fetches only once it is chosen.
        const fontFile = readdirSync(path.join(web, "assets")).find((file) =>
          file.endsWith(".woff2")
        );

        if (fontFile === undefined) {
          throw new Error("the built web frontend holds no font under assets/");
        }

        const index = await fetch(base, { headers: { accept: "text/html" } });
        const asset = await fetch(`${base}/${script}`);
        const font = await fetch(`${base}/assets/${fontFile}`);

        const served = {
          asset: {
            ...headersOf(asset),
            same: (await asset.text()) === readFileSync(path.join(web, script), "utf-8"),
          },
          font: {
            ...headersOf(font),
            same: Buffer.from(await font.arrayBuffer()).equals(
              readFileSync(path.join(web, "assets", fontFile))
            ),
          },
          index: { ...headersOf(index), same: (await index.text()) === indexHtml },
        };

        const authorized = await fetch(`${base}/api/networks`, {
          headers: { authorization: `Bearer ${key}` },
        });

        const unauthorized = await fetch(`${base}/api/networks`);

        const api = {
          authorized: await authorized.text(),
          missing: statusOf(await raw(base, "/api/nope", "text/html")),
          unauthorized: unauthorized.status,
        };

        // Out of the embedded tree, by `..` plain and escaped, towards the system's files and
        // towards the program itself, which Bun keeps beside the tree as `iirc`.
        const traversals = await Promise.all(
          [
            "/../../../../etc/ld.so.conf",
            "/..%2f..%2f..%2f..%2fetc/ld.so.conf",
            "/assets/%2e%2e/%2e%2e/%2e%2e/etc/ld.so.conf",
            "/../iirc",
            "/%2e%2e/iirc",
            "/assets/../../iirc",
          ].map(async (target) => statusOf(await raw(base, target, "*/*")))
        );

        const { page, problems } = await watchedPage(browser);

        await page.goto(base);
        await page.getByLabel("Key").fill(key);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.getByRole("button", { name: "Sign out" }).waitFor();
        const cookies = await page.context().cookies();

        const violations = await page.evaluate(
          () => document.documentElement.dataset.cspViolations ?? ""
        );

        // Before signing in, the page asks whether it is, and the answer is a 401.
        const seen = problems.filter((problem) => !problem.includes("401"));

        child.kill("SIGTERM");

        expect({
          api,
          exited: await child.exited,
          problems: seen,
          served,
          signedIn: cookies.map(({ httpOnly, name }) => ({ httpOnly, name })),
          traversals,
          violations,
        }).toStrictEqual({
          api: { authorized: "[]", missing: { empty: true, status: "404" }, unauthorized: 401 },
          exited: 0,
          problems: [],
          served: {
            asset: {
              cacheControl: "public, max-age=31536000, immutable",
              csp: contentSecurityPolicy,
              etag: null,
              lastModified: null,
              same: true,
              type: "text/javascript; charset=utf-8",
            },
            font: {
              cacheControl: "public, max-age=31536000, immutable",
              csp: contentSecurityPolicy,
              etag: null,
              lastModified: null,
              same: true,
              type: "font/woff2",
            },
            index: {
              cacheControl: "no-cache",
              csp: contentSecurityPolicy,
              etag: null,
              lastModified: null,
              same: true,
              type: "text/html; charset=utf-8",
            },
          },
          signedIn: [{ httpOnly: true, name: "iirc_sign_in" }],
          traversals: Array.from({ length: 6 }, () => ({ empty: true, status: "404" })),
          violations: "",
        });
      } finally {
        child.kill("SIGTERM");
        await child.exited;
      }
    }
  );

  it(
    "says QUIT and hangs up on its Networks when SIGTERM stops it",
    { timeout: 60_000 },
    async () => {
      const dataDir = path.join(directory, "quitting-data");
      const created = await run([iirc], "key", "create", "quitter", "--data-dir", dataDir);
      const key = created.stdout.trim();
      const ircd = listenAsIrcd();
      const { base, child } = await startDaemon([iirc], dataDir);

      try {
        const configured = await fetch(`${base}/api/networks/private`, {
          body: JSON.stringify({
            channels: [],
            declined: [],
            enabled: true,
            fallbackEncoding: "windows-1252",
            login: { _tag: "None" },
            nicks: ["iirc"],
            realname: "iirc",
            servers: [{ host: "127.0.0.1", port: ircd.port, tls: false }],
            username: "iirc",
          }),
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          method: "PUT",
        });

        // Registering has begun once the Daemon has said who it is.
        await ircd.named;
        child.kill("SIGTERM");

        const [exited, lines] = await Promise.all([child.exited, ircd.closed]);

        expect({
          configured: configured.status,
          exited,
          quit: lines.some((line) => line.split(" ", 1)[0] === "QUIT"),
        }).toStrictEqual({ configured: 200, exited: 0, quit: true });
      } finally {
        child.kill("SIGTERM");
        await child.exited;
        ircd.stop();
      }
    }
  );

  it(
    "stops while a Frontend follows a stream, ending the stream and logging no error",
    { timeout: 60_000 },
    async () => {
      const dataDir = path.join(directory, "followed-data");
      const created = await run([iirc], "key", "create", "follower", "--data-dir", dataDir);
      const key = created.stdout.trim();
      const { base, child } = await startDaemon([iirc], dataDir);

      try {
        const following = await fetch(`${base}/api/ui/changes`, {
          headers: { authorization: `Bearer ${key}` },
        });

        const reader = following.body?.getReader();

        // The options in force come first, so one read says the stream is open.
        await reader?.read();
        child.kill("SIGTERM");

        const ended = (async () => {
          try {
            for (;;) {
              // oxlint-disable-next-line no-await-in-loop -- reading a stream in order
              const chunk = await reader?.read();

              if (chunk === undefined || chunk.done) {
                return chunk !== undefined;
              }
            }
          } catch {
            return false;
          }
        })();

        // What it logs from here to its end. Starting it read part of the log already, so
        // the rest is read as that was, by a reader.
        const rest = (async () => {
          const log = child.stderr.getReader();
          const decoder = new TextDecoder();
          let text = "";

          for (;;) {
            // oxlint-disable-next-line no-await-in-loop -- reading the log in order
            const chunk = await log.read();

            if (chunk.done) {
              return text;
            }

            text += decoder.decode(chunk.value, { stream: true });
          }
        })();

        const [exited, logged] = await Promise.all([child.exited, rest]);

        // Every line it logs is a log line: an error a stream was cut with is not one.
        const unlogged = logged
          .split("\n")
          .filter((line) => line !== "" && !line.startsWith("timestamp="));

        expect({ ended: await ended, exited, unlogged }).toStrictEqual({
          ended: true,
          exited: 0,
          unlogged: [],
        });
      } finally {
        child.kill("SIGTERM");
        await child.exited;
      }
    }
  );

  it.skipIf(analyze === null)("has a user unit that systemd reads without complaint", async () => {
    // The unit runs `~/.local/bin/iirc`, which this run does not install, so a copy names the
    // executable just built, and is checked as it stands otherwise.
    const copy = path.join(directory, "iirc.service");

    writeFileSync(copy, readFileSync(unit, "utf-8").replaceAll("%h/.local/bin/iirc", iirc));

    await expect(
      run([analyze ?? "systemd-analyze"], "verify", "--user", copy)
    ).resolves.toStrictEqual({
      code: 0,
      stderr: "",
      stdout: "",
    });
  });
});
