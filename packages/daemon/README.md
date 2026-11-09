# @iirc/daemon

The Daemon: the composition root that wires the Runtime, the real Client, and the production adapters behind the API, and the handlers of [`@iirc/api`](../api/README.md)'s contract. `iirc daemon` in [`apps/iirc`](../../apps/iirc/README.md) runs it.

```ts
import { layerDaemon, layerLogger } from "@iirc/daemon";

// Runs until interrupted, which SIGINT and SIGTERM do through BunRuntime.runMain.
Layer.launch(layerDaemon({ dataDir: "/var/lib/iirc" }, { host: "127.0.0.1", port: 7667 })).pipe(
  Effect.provide(layerLogger),
  BunRuntime.runMain
);
```

| Export | Role |
| --- | --- |
| `layerDaemon(options, listen?)` | The Daemon, serving the API on `listen` (`127.0.0.1:7667` unless given), for as long as the Layer lives. It also provides its `HttpServer`, so a test can find an ephemeral port. |
| `DaemonOptions` | `dataDir`, the Transport's options (such as extra roots to `trust`), and the News `heartbeat` (15 s). |
| `layerLogger` | logfmt on stderr, so stdout holds only what a command was asked for. |
| `ApiRoutes`, `ApiHandlers` | The API's routes with the key check, request validation, and the body limit, and the handler groups alone, for an in-process client. They need `Runtime`, `Vault`, and `ApiKeys`. |
| `createKey(dataDir, name)` | `iirc key create`: makes a key, stores its hash, and gives the key once. Call it with the data directory held. |
| `ApiKeys` | Checks a presented key against `keys.json`, read once at start. |
| `holdDataDirectory(dataDir)` | Holds a data directory exclusively for the enclosing Scope, or fails with `DataDirectoryLocked`. |

## The data directory

| File               | What                             | Written by                       |
| ------------------ | -------------------------------- | -------------------------------- |
| `journal.sqlite`   | The Journal                      | `@iirc/journal-sqlite`           |
| `credentials.json` | The Credentials, mode `0600`     | `@iirc/vault-file`               |
| `keys.json`        | The API keys as SHA-256 hashes   | `iirc key create`                |
| `daemon.lock`      | The lock below. It holds nothing | the Daemon and `iirc key create` |

The Daemon makes the directory, mode `0700`, if it is missing. Nothing else is read at start: there is no configuration file ([ADR 0004](../../docs/adr/0004-configuration-lives-in-the-journal.md)).

**One Daemon to a directory.** Neither the Journal nor the Vault refuses a second owner of its file, so the Daemon holds the directory before it opens either: an open `BEGIN EXCLUSIVE` on `daemon.lock`, a SQLite database of its own. SQLite takes it with a POSIX lock, which the kernel frees however the process dies, so a crash never leaves the directory locked. SQLite tracks it per file within one process too, so a second Daemon in the same process is refused as well. A second Daemon, or `iirc key create` while one runs, fails with `DataDirectoryLocked`.

## API keys

`keys.json` is versioned JSON, written as vault-file writes its file: to `keys.json.tmp` with `wx` and mode `0600`, synced, then renamed into place, and the directory synced. A crash leaves the old file or the new one.

```json
{
  "version": 1,
  "keys": [{ "name": "phone", "sha256": "…64 hex digits…", "created": "2026-11-10T00:00:00.000Z" }]
}
```

- **A key is 256 random bits,** from Effect's `SecureRandom`, written `iirc_` and base64url. It is shown once, by `iirc key create`, and kept only as its SHA-256. A random key needs no password hash ([ADR 0006](../../docs/adr/0006-proportionate-security.md)).
- **A request's key is compared against every stored hash,** each with `timingSafeEqual`, so the time taken says nothing of which key matched, or how much of one.
- **Keys are made only while the Daemon is stopped.** `iirc key create` holds the data directory, so the Daemon reads `keys.json` once at start, and nothing changes it under a running Daemon. A Daemon with no keys warns, and refuses every request.
- **Keys live in a file, not the Journal.** That is deliberate for now. The Journal's records are each a Network's, `Input` or `Outputs`, and this module may not change that substrate. A key is the Daemon's, not a Network's, and is checked rather than replayed. When the Journal can hold Changes that are not a Network's, keys can move there, as m2's did.

## Composition

- **The core is provided outside `HttpRouter.serve`.** `serve` forks the MemoMap, so anything shared built inside it would be built twice, and the Journal and the lock would each be opened again.
- **The Runtime stops first.** It lives in a Scope of its own, which a Layer built after serving closes. Layers close in reverse, so on SIGINT or SIGTERM the Runtime stops, every Owner input still waiting fails with `NetworkStopped`, and only then does serving stop, and then the Journal, the Vault, and the lock.
- **`gracefulShutdownTimeout` is 500 ms.** By then the Runtime has stopped, so it covers only reads and News streams in flight, which are cut.
- **Every log goes through `Effect.log*`,** annotated with the Network where there is one, to the Logger built here. A Credential is logged by name only, when it is held or forgotten. HTTP requests are not logged.

## The handlers

- **Errors are mapped, never leaked.** The Runtime's `UnknownNetwork`, `NetworkStopped`, `JournalFailed`, and the Vault's `VaultFailed` become the contract's own, with the statuses its README gives. `NetworkStopped` names the Network from the request and, for a `say`, the intent.
- **The Daemon names a `say`'s intent** when the caller does not: 128 bits from Effect's `Random`, as hex, as the Runtime would. So the intent is known before the `Say` is stepped, and a `NetworkStopped` can say which to ask `said` about.
- **The wire forms are total maps** in `src/wire.ts`. Each return type is checked by `Fields`, so a field the Client adds to News, Knowledge, or the inspection, or a field the contract has and the Client does not, fails to compile there until the contract catches up, and a new variant fails the `switch` that ends in `satisfies never`.
- **A request that does not decode** is `InvalidRequest` with the path of each issue. Its messages never quote the input, since a body can carry a Credential's value.
- **A body over 1 MiB is refused unread,** with 413 and `Connection: close`. Bun's graceful stop waits for a client still sending a body, so without the close, one oversized upload could hold up shutdown.
- **The News stream** is the Runtime's `news`, from `after` or `Last-Event-ID`, mapped to the wire and merged with a heartbeat every 15 s that stops when it does. Each reader follows the Journal on its own, so a reader that reads nothing holds back only its own response, never the Runtime or another reader.

## Tests

`bun run test` runs, with no network:

- `src/handlers.test.ts`: the handlers through an in-process client (`HttpApiTest`), on the Runtime's in-memory ports and a `TestClock`, with a key made in a temporary data directory. It covers refusing a missing or wrong key, configuring, registering on the floor, joining, saying, hearing a Message as News, `known`, `inspect`, resuming News after a sequence from the query and from `Last-Event-ID`, heartbeats, `UnknownNetwork`, `NetworkStopped` with `said` answering `NotJournaled` when the `Say` failed to append and `Journaled` when only its outputs did, and holding, using as `PASS`, and forgetting a Credential, whose value appears in no response, log, or Journal Entry.
- `src/server.test.ts`: the routes over a real Bun server on an ephemeral loopback port, on the SQLite Journal. It covers SSE as the wire carries it, with the sequence as each event's id, resuming with `after` and `Last-Event-ID`, heartbeats with no id, a reader that reads nothing while 300 Messages and a `say` go through and then misses none of them, 401 before anything else, 400 with the issue's path and no quoting of the body, and 413 with the Connection closed.

### End to end

`bun run e2e` at the root, or in this package, runs `src/e2e/` and is never part of `bun run test`. Each run drives a real Daemon, with the production adapters, through its HTTP API alone, and plays the other User over a raw IRC connection. The Ircds are private, on loopback ports the kernel picks, never the shared ngircd on 6667 and never port 6667.

- **ngircd, on the floor:** configure, register, join, say, and hear the other User's Message as News. ngircd is `~/.local/opt/ngircd/ngircd`, or `IIRC_NGIRCD`, with a configuration of its own in a temporary directory.
- **Restart:** stop the Daemon, start another on the same data directory, and see the Network come back. The second folds the first's News Entry for Entry, News resumed after the last sequence the first showed is exactly what came after, and `said` finds a `say` made just before the stop.
- **Ergo over TLS with SASL PLAIN:** register an account, set the Credential through the API, and log in, with the Daemon dialling `ergo.test`, routed to loopback, and trusting Ergo's self-signed root through the Transport's `trust`, never by turning verification off. A second run without the root fails with a TLS close and never tries plaintext. Ergo 2.19.1 is fetched into the gitignored `.cache/ergo/` and checked against its checksums file and a pinned SHA-256 before it runs.

## Not yet

- **A graceful `QUIT` on shutdown.** Stopping hangs up every Connection without one. It belongs to the Client, as an input it answers.
- **Recording transcripts from the Journal.** The end-to-end runs are where fixtures will come from, through a normaliser, as the [transcript spike](../../docs/notes/2026-11-09-transcript-spike.md) found.
- **A bound on shutdown.** Effect's Bun server waits for its graceful stop with no bound once its own timeout passes, so a client in the middle of sending a body under 1 MiB could still hold up shutdown.
- **Trusting extra roots from the command line.** `DaemonOptions.transport.trust` exists, and `iirc daemon` has no flag for it yet.
- **Key scopes, keys through the API, Views, and removing a Network,** as the API's README lists.
- **Snapshots for News.** Each reader folds the Journal from the start, as the Runtime does, which costs time on a long Journal.
