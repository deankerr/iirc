# iirc

One executable whose arguments choose what it runs ([ADR 0007](../../docs/adr/0007-one-binary-shapes-by-argument.md)), built with `effect/cli`.

```sh
iirc key create phone --data-dir ~/.local/share/iirc   # prints the key, once
iirc daemon --data-dir ~/.local/share/iirc              # serves on 127.0.0.1:7667
iirc daemon --data-dir ~/.local/share/iirc --listen 127.0.0.1:7700
```

| Command | Does |
| --- | --- |
| `iirc daemon --data-dir <dir> [--listen host:port]` | Runs the [Daemon](../../packages/daemon/README.md) on the data directory, serving [the API](../../packages/api/README.md) on loopback, `127.0.0.1:7667` unless given. An IPv6 host goes in brackets, such as `[::1]:7667`. |
| `iirc key create <name> --data-dir <dir>` | Makes an API key, stores its hash, and prints the key on stdout. It holds the data directory while it does, so it refuses while a Daemon runs on it. |

Either makes the data directory, mode `0700`, if it is missing.

## What it guarantees

- **SIGINT and SIGTERM exit 0.** `BunRuntime.runMain` interrupts the Daemon, which stops the Runtime, then serving, then the rest, and an interrupt is a clean exit rather than the default 130.
- **stdout holds only what was asked for.** The key from `iirc key create` is alone on stdout, so `KEY=$(iirc key create …)` holds nothing else. Logs, as logfmt, and every refusal go to stderr.
- **A refusal is one line in words, and exits 1:** a data directory another Daemon holds, a key name taken, a Journal of another version, a Timeline store that cannot be opened, a port it cannot listen on.

## Not yet

- `iirc daemon --web` and `iirc web`, the shapes with the web frontend.
- `iirc config`, `iirc credential`, and `iirc backup`, which will be Frontends of the API.
- A flag for extra TLS roots to trust, which `DaemonOptions` already takes.
- A compiled single-file binary. It runs with `bun run iirc` from the repository's root.
