/// <reference lib="dom" />
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { connectPeer, startNgircd } from "@iirc/daemon/testing";
import { Schema } from "effect";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compile } from "../../compile.ts";
import { raw, run, startDaemon, startDaemonIn, watchedPage } from "./daemon.ts";

const app = path.join(import.meta.dirname, "..", "..");
const web = path.join(app, "..", "web", "dist");
const unit = path.join(app, "systemd", "iirc.service");
const analyze = Bun.which("systemd-analyze");

const contentSecurityPolicy =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** What a run reads of one News event: how each Session it tells of ended. */
const decodeHappened = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      news: Schema.Array(
        Schema.Struct({ _tag: Schema.String, reason: Schema.optional(Schema.Unknown) })
      ),
    })
  )
);

/**
 * Reads the News from the start until it tells of a Session's end, for at most 10 s.
 * @param base - The Daemon's base URL.
 * @param key - A key.
 * @returns How the first Session to end ended, or `"none"` if none did in time.
 */
const firstEnding = async (base: string, key: string) => {
  const stopped = new AbortController();

  const following = await fetch(`${base}/api/news?after=0`, {
    headers: { authorization: `Bearer ${key}` },
    signal: stopped.signal,
  });

  const read = async () => {
    const decoder = new TextDecoder();
    let buffered = "";

    for await (const chunk of following.body ?? []) {
      buffered += decoder.decode(chunk, { stream: true });

      const ending = buffered
        .split("\n\n")
        .slice(0, -1)
        .filter((event) => event.split("\n").includes("event: happened"))
        .flatMap((event) => event.split("\n").filter((line) => line.startsWith("data: ")))
        .flatMap((line) => decodeHappened(line.slice("data: ".length)).news)
        .find((one) => one._tag === "SessionEnded");

      if (ending !== undefined) {
        return ending.reason;
      }
    }

    return "none";
  };

  const ended = await Promise.race([read(), Bun.sleep(10_000).then(() => "none")]);

  stopped.abort();

  return ended;
};

/**
 * Whether a Line is ours, decided by its command and source alone.
 * @param command - The command.
 * @returns The test of a Line.
 */
const ours =
  (command: string) => (line: { readonly command: string; readonly source?: string | undefined }) =>
    line.command === command && line.source?.split("!")[0] === "iirc";

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
 * A directory holding everything Bun reads from where a program starts, when it is let:
 * a `.env` setting a variable, a `bunfig.toml` preloading a script that leaves a file behind
 * when it runs, and a `package.json` and `tsconfig.json` of another project.
 * @param directory - Where to make it.
 * @returns The directory, the variable the `.env` sets, and the file the preload would leave.
 */
const hostileStart = (directory: string) => {
  const cwd = path.join(directory, "elsewhere");
  const preloaded = path.join(directory, "preloaded");

  mkdirSync(cwd);
  writeFileSync(path.join(cwd, ".env"), "IIRC_FROM_DOTENV=loaded\n");
  writeFileSync(
    path.join(cwd, "preload.ts"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(preloaded)}, "ran");\n`
  );
  writeFileSync(path.join(cwd, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({ imports: { "#effect": "./nothing.js" }, name: "not-iirc", type: "commonjs" })
  );
  writeFileSync(
    path.join(cwd, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { paths: { "effect/*": ["./nothing/*"] } } })
  );

  return { cwd, preloaded, variable: "IIRC_FROM_DOTENV" };
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
        "This iirc carries no web frontend of its own, so --web needs a directory, such as --web=apps/web/dist.\n",
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
    { timeout: 90_000 },
    async () => {
      const dataDir = path.join(directory, "quitting-data");
      const created = await run([iirc], "key", "create", "quitter", "--data-dir", dataDir);
      const key = created.stdout.trim();
      const channel = "#iirc-quitting";
      const ngircd = await startNgircd();
      const peer = await connectPeer({ host: ngircd.host, nick: "peer", port: ngircd.plainPort });
      const { base, child } = await startDaemon([iirc], dataDir);

      try {
        peer.send(`JOIN ${channel}`);

        const configured = await fetch(`${base}/api/networks/private`, {
          body: JSON.stringify({
            channels: [{ name: channel }],
            declined: [],
            enabled: true,
            fallbackEncoding: "windows-1252",
            ircds: [{ host: ngircd.host, port: ngircd.plainPort, tls: false }],
            login: { _tag: "None" },
            nicks: ["iirc"],
            realname: "iirc",
            username: "iirc",
          }),
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          method: "PUT",
        });

        await peer.waitFor(ours("JOIN"), "the Daemon's JOIN");
        child.kill("SIGTERM");
        const exited = await child.exited;

        // An Ircd says QUIT for a User whose Connection merely ended too, so what proves
        // the stop is the Journal, as a Daemon started after it on the same data reads it:
        // the Session ended because the Client hung up.
        const again = await startDaemon([iirc], dataDir);

        const ended = await firstEnding(again.base, key).finally(() => {
          again.child.kill("SIGTERM");
        });

        await again.child.exited;

        expect({ configured: configured.status, ended, exited }).toStrictEqual({
          configured: 200,
          ended: { _tag: "Closed", reason: "HungUp" },
          exited: 0,
        });
      } finally {
        peer.close();
        child.kill("SIGTERM");
        await child.exited;
        await ngircd.stop();
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

  it(
    "reads no .env, bunfig.toml, package.json, or tsconfig.json from where it starts",
    { timeout: 60_000 },
    async () => {
      const start = hostileStart(directory);

      // The real executable, started among them, serves as it would anywhere, and the
      // `bunfig.toml`'s preload never runs.
      const dataDir = path.join(directory, "elsewhere-data");
      const { base, child } = await startDaemonIn(start.cwd, [iirc], dataDir, "--web");

      const served = await Promise.all([
        fetch(base, { headers: { accept: "text/html" } }),
        fetch(`${base}/api/networks`),
      ])
        .then(([index, api]) => ({ api: api.status, index: index.status }))
        .finally(() => {
          child.kill("SIGTERM");
        });

      const exited = await child.exited;

      // The Daemon reads no variable, and a `.env` Bun loads never reaches the process's
      // environment as the kernel keeps it, so nothing outside can see one loaded. A probe,
      // compiled exactly as `iirc` is, says what it sees instead.
      const probe = path.join(directory, "probe");
      const source = path.join(directory, "probe.ts");

      writeFileSync(
        source,
        `process.stdout.write(JSON.stringify({ seen: process.env.${start.variable} ?? null }));\n`
      );
      const failures = await compile(source, probe, []);
      const probed = Bun.spawn([probe], { cwd: start.cwd, stdout: "pipe" });

      const [seen, probeExited] = await Promise.all([
        new Response(probed.stdout).text(),
        probed.exited,
      ]);

      expect({
        exited,
        failures,
        preloaded: existsSync(start.preloaded),
        probe: { exited: probeExited, seen },
        served,
      }).toStrictEqual({
        exited: 0,
        failures: [],
        preloaded: false,
        probe: { exited: 0, seen: '{"seen":null}' },
        served: { api: 401, index: 200 },
      });
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
