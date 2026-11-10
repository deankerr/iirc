# iirc

One executable whose arguments choose what it runs ([ADR 0007](../../docs/adr/0007-one-binary-shapes-by-argument.md)), built with `effect/cli`.

```sh
iirc key create phone --data-dir ~/.local/share/iirc   # prints the key, once
iirc daemon --data-dir ~/.local/share/iirc              # serves on 127.0.0.1:7667
iirc daemon --data-dir ~/.local/share/iirc --listen 127.0.0.1:7700
iirc daemon --data-dir ~/.local/share/iirc --web apps/web/dist   # and the web frontend
```

| Command | Does |
| --- | --- |
| `iirc daemon --data-dir <dir> [--listen host:port] [--web <dir>]` | Runs the [Daemon](../../packages/daemon/README.md) on the data directory, serving [the API](../../packages/api/README.md) on loopback, `127.0.0.1:7667` unless given. An IPv6 host goes in brackets, such as `[::1]:7667`. With `--web`, it also serves [the web frontend](../web/README.md) built into that directory, on the same origin. |
| `iirc key create <name> --data-dir <dir>` | Makes an API key, stores its hash, and prints the key on stdout. It holds the data directory while it does, so it refuses while a Daemon runs on it. |

Either makes the data directory, mode `0700`, if it is missing.

## The web frontend

`--web <dir>` serves a built web frontend, such as `apps/web/dist` after `bun run build:web`, beside the API ([ADR 0007](../../docs/adr/0007-one-binary-shapes-by-argument.md)). It is a Layer of routes in `src/web.ts`, which the Daemon serves without knowing what it is.

- **A request target is read once, as a path, and that path decides everything.** It is never read as a URL, so no part of it is taken for a host. Its query is dropped, its escapes decoded, the empty segments of repeated slashes dropped, and `.` and `..` resolved, never above the directory. A target that is not a path, cannot be decoded, or holds a backslash or a NUL, escaped or not, names nothing and is 404. Which file answers, whether it is the API's, and how long it may be kept all follow from that one path.
- **`/api` stays the API's.** A path under `/api` that the API does not have is answered as without `--web`, an empty 404, and never a file or `index.html`. So are `/%61pi/…`, `//api/…`, `/./api/…`, `/%2Fapi/…`, and `/assets/../api/…`, which are all `/api` once read as a path.
- **A navigation to a path with no file gets `index.html`,** when it asks for HTML and names no file extension, so a reload anywhere opens the Frontend. Anything else with no file is an empty 404.
- **Nothing outside the directory is served, symbolic links included.** The directory's canonical path is found once at start. On every request, the file's canonical path, with every symbolic link followed, must lie inside it, or the request is 404, so a link added while the Daemon runs is held to the same rule. A link that stays inside the directory is served, since what matters is where the bytes are, not how they are named. A file is opened by its canonical path just after the check. Changing the directory's files between the check and the open is the Owner's own software, which [ADR 0006](../../docs/adr/0006-proportionate-security.md) does not defend against.
- **Caching follows the build.** A file under `assets/`, which Vite names by a hash of its content, is `Cache-Control: public, max-age=31536000, immutable`. Everything else, `index.html` above all, is `no-cache`, so a new build is seen on the next load.
- **Every file carries the security headers.** `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
- **A directory that cannot be served refuses start,** before the data directory is touched: one missing, or without an `index.html` inside it that can be read.

## What it guarantees

- **SIGINT and SIGTERM exit 0.** `BunRuntime.runMain` interrupts the Daemon, which stops the Runtime, then serving, then the rest, and an interrupt is a clean exit rather than the default 130.
- **stdout holds only what was asked for.** The key from `iirc key create` is alone on stdout, so `KEY=$(iirc key create …)` holds nothing else. Logs, as logfmt, and every refusal go to stderr.
- **A refusal is one line in words, and exits 1:** a data directory another Daemon holds, a key name taken, a Journal of another version, a Timeline store that cannot be opened, a port it cannot listen on, a web frontend's directory that cannot be served.

## Tests

`bun run test` runs `src/main.test.ts`, which runs `iirc` as a process. It covers `key create` printing the key once and refusing a name taken, the Daemon serving its keys, holding its data directory, and exiting 0 on SIGTERM and SIGINT, and a listen address it cannot read. For `--web`, it covers `index.html` at `/` and for a navigation to an unknown path, a hashed asset with its type and its cache header, a missing asset and a request for a page that is not a navigation answered 404, five paths under `/api`, escaped included, answered with an empty 404 as without `--web`, the API still answering with and without a key, and the security headers. Over a raw socket, with the target sent as written, it covers five ways of leaving the directory by `..`, each 404 and none leaking the file beside it, nine ways of writing a path under `/api` as a navigation, with repeated slashes, `.`, an escaped `/`, and backslashes plain and escaped, each 404 and none the page, a symbolic link to a file outside and one to a directory outside, each 404 and leaking nothing, and a link to a file inside, served. It also covers a missing directory and one without `index.html`, each refused in one line.

`bun run e2e` builds the web frontend and runs `src/e2e/web.test.ts`: a real `iirc daemon --web` on a port the kernel picks, a fresh data directory, and a key, driven by Chromium through Playwright. It signs in with a wrong key and reads why, then checks that the field is empty, that React DOM's value tracker on it holds `""`, that it is described by the failure's words, and that nothing React keeps in the page, state or props, holds the wrong key. It signs in with the right one and sees the Networks listed, reloads and stays signed in, checks that the cookie is `HttpOnly` and `SameSite=Strict` and holds no key, that the page reads no cookie and stores nothing, and that the console shows no Content Security Policy violation, then signs out, reloads, and stays signed out with no cookie left. It needs Playwright's Chromium, which `bunx playwright install chromium` fetches.

## Not yet

- `iirc web`, the web frontend alone as a proxy to a Daemon.
- The web frontend embedded in a compiled binary. `--web` serves it from a directory.
- `iirc config`, `iirc credential`, and `iirc backup`, which will be Frontends of the API.
- A flag for extra TLS roots to trust, which `DaemonOptions` already takes.
- A compiled single-file binary. It runs with `bun run iirc` from the repository's root.
