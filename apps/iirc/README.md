# iirc

The executable. It is the only place that reads argv, and it composes `@iirc/daemon` with Bun's HTTP server. It also holds the command-line Frontends of the API, and the floor proof.

- **Depends on:** `@iirc/daemon`, `@iirc/api`, `effect`, `@effect/platform-bun`.
- **Used by:** the Owner, systemd ([`packaging/systemd`](../../packaging/systemd)), and the soak test.
- [The running guide](../../docs/guides/running.md) installs and runs it.

## Commands

| Command | Does | Needs |
| --- | --- | --- |
| `iirc daemon` | Runs a Daemon and its API on loopback (CONF-4, AUTH-5) | `--data-dir` or `IIRC_DATA_DIR`, and `--http-port` or `IIRC_HTTP_PORT`, default 7667 |
| `iirc key create --name <n> [--scope read\|chat\|admin]` | Appends a key straight into the Log and prints it once (AUTH-4) | The data directory, with the Daemon stopped |
| `iirc config export`, `iirc config import <file>` | Configuration as TOML, through the API (CONF-6) | `IIRC_KEY`, and `--api-url` or `IIRC_API_URL` |
| `iirc credential set <name>`, `delete <name>`, `list` | Credentials through the API. `set` reads the value from stdin, or unseen from a terminal (CRED-2) | The same |
| `iirc backup` | Asks the running Daemon to back up its Log (RUN-2) | The same |

Every command but `daemon` and `key create` is a Frontend of the API, like any other.

## Build and test

```sh
bun run build            # from the root: apps/iirc/dist/iirc and apps/soak/dist/iirc-soak
bun run proof:floor      # builds, then runs the floor proof against private ngircds (PROOF-3)
bun run --filter @iirc/app test
```

- `src/floor-proof.ts` drives the built binary only through its API, signals, `iirc config`, and raw IRC clients. [`requirements.md`](../../docs/requirements.md#proof) lists what it checks.
- `src/floor.ts` is what the floor proof's checks share: private ngircds, linked or not, raw IRC clients, and the Daemon. `src/netsplit.ts` is the netsplit and reconnect check, on two linked ngircds.
- `src/kill.test.ts` sends `SIGKILL` to the minified binary during traffic and checks that nothing recorded is lost or duplicated (PROOF-4).
- `src/run.test.ts` and `src/tls.test.ts` test stopping, starting, keys, and TLS against the compiled binary.

## Key ideas

- **One executable, one shape so far.** Arguments will choose the shape. Only `iirc daemon` exists ([ADR 0007](../../docs/adr/0007-one-binary-shapes-by-argument.md)).
- **A refusal to start is one line on stderr** and a failing exit, never a stack trace.
- **Configuration files are only input.** `configuration-file.ts` parses TOML with Effect's `Toml` and writes it with `Bun.TOML.stringify`, because Effect's only parses ([ADR 0004](../../docs/adr/0004-configuration-lives-in-the-log.md)).

## Traps

- **The reader Worker is a second entrypoint,** under `--root ../../packages/log/src`, so that `new URL("reader-worker.ts", import.meta.url)` names it from source and from the binary. [`@iirc/log`](../../packages/log/README.md#traps) says why.
- **A compiled binary loads `.env` and `bunfig.toml`** from its working directory unless told not to, so the build passes `--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig`. `BUN_BE_BUN=1` turns any compiled binary into the full Bun CLI.
- **The build forbids code generation from strings,** through `--compile-exec-argv`.
- **An interrupt is a clean stop.** `runMain` interrupts main on `SIGINT` and `SIGTERM`, and the teardown here exits 0 where the default says 130 (RUN-3).
- **For the web build, when it comes:** `feature()` from `bun:bundle` is a build error anywhere but directly in an `if` or a ternary, and does not resolve under vitest, so it belongs only here, which no test imports. Only a guarded `import()` removes assets. A test must prove a build without `WEB` holds no web assets.
- **`HttpStaticServer` over `/$bunfs`** sees mtime 0, so ETags are size-only, and `index.html` must never be cached. It gives compression, `Cache-Control`, and a CSP header, which Bun's native HTML routes bypass.

## Requirements

[Running it](../../docs/requirements.md#running-it) (RUN-1, RUN-3), CONF-4 and CONF-6 in [Configuration](../../docs/requirements.md#configuration), AUTH-4 and AUTH-5 in [Access](../../docs/requirements.md#access), and PROOF-3 and PROOF-4 in [Proof](../../docs/requirements.md#proof).
