# iirc

One executable whose arguments choose what it runs, built with `effect/cli`.

```sh
iirc key create phone --data-dir ~/.local/share/iirc   # prints the key, once
iirc daemon --data-dir ~/.local/share/iirc              # serves on 127.0.0.1:7667
iirc daemon --data-dir ~/.local/share/iirc --listen 127.0.0.1:7700
iirc daemon --data-dir ~/.local/share/iirc --web                 # and the web frontend built in
iirc daemon --data-dir ~/.local/share/iirc --web=apps/web/dist   # or one built into a directory
```

| Command | Does |
| --- | --- |
| `iirc daemon --data-dir <dir> [--listen host:port] [--web[=<dir>]]` | Runs the Daemon on the data directory, serving the API on loopback, `127.0.0.1:7667` unless given. An IPv6 host goes in brackets, such as `[::1]:7667`. With `--web`, it also serves the web frontend on the same origin: the one compiled into the executable, or with `--web=<dir>`, the one built into that directory. The directory is joined by `=`, so `--web` never takes the next argument for one. |
| `iirc key create <name> --data-dir <dir>` | Makes an API key, stores its hash, and prints the key on stdout. It holds the data directory while it does, so it refuses while a Daemon runs on it. |

Either makes the data directory, mode `0700`, if it is missing.

## The web frontend

`--web` serves a built web frontend beside the API: the one compiled into the executable by `bun run build:iirc`, or with `--web=<dir>`, one built into a directory, such as `apps/web/dist` after `bun run build:web`, which is how it is developed. It is a Layer of routes in `src/web.ts`, which the Daemon serves without knowing what it is. Both sources follow the same rules, but for where a file may come from.

- **A request target is read once, as a path, and that path decides everything.** It is never read as a URL, so no part of it is taken for a host. Its query is dropped, its escapes decoded, the empty segments of repeated slashes dropped, and `.` and `..` resolved, never above the directory. A target that is not a path, cannot be decoded, or holds a backslash or a NUL, escaped or not, names nothing and is 404. Which file answers, whether it is the API's, and how long it may be kept all follow from that one path.
- **`/api` stays the API's.** A path under `/api` that the API does not have is answered as without `--web`, an empty 404, and never a file or `index.html`. So are `/%61pi/…`, `//api/…`, `/./api/…`, `/%2Fapi/…`, and `/assets/../api/…`, which are all `/api` once read as a path.
- **A navigation to a path with no file gets `index.html`,** when it asks for HTML and names no file extension, so a reload anywhere opens the Frontend. Anything else with no file is an empty 404.
- **Nothing outside a directory is served, symbolic links included.** The directory's canonical path is found once at start. On every request, the file's canonical path, with every symbolic link followed, must lie inside it, or the request is 404, so a link added while the Daemon runs is held to the same rule. A link that stays inside the directory is served, since what matters is where the bytes are, not how they are named. A file is opened by its canonical path just after the check. Changing the directory's files between the check and the open is the Owner's own software, which ADR 0006 does not defend against.
- **Nothing but the embedded files is served from the executable, by construction.** Bun embeds the build's regular files, never a symbolic link, under `/$bunfs/`, where nothing can change them. At start they are listed once, by Effect's `FileSystem`, which reads `/$bunfs/` but cannot find a canonical path there, and a request is served only when its path, read as above, is exactly one of their names. The file served is named from that list, never from the request, so no request reaches anything else in the executable, the program itself included.
- **An embedded file carries no `ETag` or `Last-Modified`.** Bun gives every embedded file the epoch as its modification time, so either would say that two builds' files of the same size are the same.
- **Caching follows the build.** A file under `assets/`, which Vite names by a hash of its content, is `Cache-Control: public, max-age=31536000, immutable`. Everything else, `index.html` above all, is `no-cache`, so a new build is seen on the next load.
- **Every file carries the security headers.** `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
- **A web frontend that cannot be served refuses start,** before the data directory is touched: a directory missing, or without an `index.html` inside it that can be read, and a bare `--web` on an executable without one built in, which is any built with `--no-web`, and `iirc` run from source.

## Building

`bun run build:iirc` builds the web frontend, then compiles `src/main.ts` with `build.ts`, through `compile.ts`, into one executable, `dist/iirc`, with `apps/web/dist` embedded. From a clean checkout, `bun install` and that one script are all it needs. `bun run build:iirc:no-web` makes `dist/iirc-no-web`, without the web frontend, which refuses a bare `--web` (ADR 0007: a build flag only decides whether web assets are included). `bun apps/iirc/build.ts --outfile <path>` puts either anywhere.

- **It carries its own runtime and source map.** It needs no Bun to run, and a stack trace in the log names the source.
- **Nothing in the directory it starts in changes it.** It reads no `.env`, `bunfig.toml`, `package.json`, or `tsconfig.json` at start, so its behaviour comes from its arguments and its data directory alone.

## Install

As a systemd user service, from the repository's root. `iirc key create` holds the data directory, so it refuses while the Daemon runs: create a key before the first start, or stop the service, create one, and start it again. The first key also makes the data directory, which the service needs before it starts.

```sh
bun install
bun run build:iirc
install -D -m 0755 dist/iirc ~/.local/bin/iirc
install -D -m 0644 apps/iirc/systemd/iirc.service ~/.config/systemd/user/iirc.service
~/.local/bin/iirc key create browser --data-dir ~/.local/share/iirc   # prints the key, once
systemctl --user daemon-reload
systemctl --user enable --now iirc
```

Then open `http://127.0.0.1:7667`, sign in with the key, and add a Network from the composer, such as `/network add libera irc.libera.chat my-nick`, over TLS on 6697, or `/network add home irc.example.net/6667 plain my-nick` for plaintext. `journalctl --user -u iirc` shows the log. A user service runs only while its user has a session, so for one that starts at boot and stays on after logging out, run `loginctl enable-linger` once. To upgrade, build again, copy the executable over the old one, and `systemctl --user restart iirc`.

`systemd/iirc.service` runs `~/.local/bin/iirc daemon --data-dir ~/.local/share/iirc --web` on the default `127.0.0.1:7667`, and holds no secret.

- **It restarts on failure,** after 5 s, and is given 30 s to stop on SIGTERM, well above the Daemon's usual 5.5 s.
- **It logs to the journal,** as `iirc`, in logfmt.
- **It sees little of the machine.** The file system is read-only to it, its `/tmp` is its own, and the home directory is an empty one but for the executable, read-only, and the data directory, which is all it can write. It cannot gain privileges, change its personality, take realtime scheduling, make set-user-ID files, or make system calls of another architecture. Each of these was tried in a user service on systemd 259, with the Daemon serving, writing its Journal, dialling a Network by name, and keeping its Configuration across a restart. `MemoryDenyWriteExecute` is left off, since the JIT writes code it then runs.
- **A missing data directory fails the start,** with status `226/NAMESPACE`, rather than the Daemon writing to a home directory that vanishes when it stops.

## What it guarantees

- **SIGINT and SIGTERM exit 0.** `BunRuntime.runMain` interrupts the Daemon, which stops the Runtime, then serving, then the rest, and an interrupt is a clean exit rather than the default 130.
- **stdout holds only what was asked for.** The key from `iirc key create` is alone on stdout, so `KEY=$(iirc key create …)` holds nothing else. Logs, as logfmt, and every refusal go to stderr.
- **A refusal is one line in words, and exits 1:** a data directory another Daemon holds, a key name taken, a Journal of another version, a Timeline store that cannot be opened, a port it cannot listen on, a web frontend that cannot be served.

## Tests

`bun run test` runs `iirc` from source, as a process. `bun run e2e` builds the web frontend, compiles `iirc` with and without it, and drives a real `iirc daemon --web` with Chromium through Playwright, on private Ircds that `@iirc/daemon/testing` starts. It needs Playwright's Chromium, which `bunx playwright install chromium` fetches. Where `systemd-analyze` is installed, it also verifies `systemd/iirc.service`, and installs nothing.

## Not yet

- `iirc web`, the web frontend alone as a proxy to a Daemon.
- `iirc config`, `iirc credential`, and `iirc backup`, which will be Frontends of the API.
- A flag for extra TLS roots to trust, which `DaemonOptions` already takes.
- An executable for another platform. `build.ts` compiles for the machine it runs on.
