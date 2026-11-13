# @iirc/daemon

The Daemon: the composition root that wires the Runtime, the real Client, and the production adapters behind the API, and the handlers of `@iirc/api`'s contract.

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
| `layerDaemon(options, listen?, beside?)` | The Daemon, serving the API on `listen` (`127.0.0.1:7667` unless given), for as long as the Layer lives. It also provides its `HttpServer`, so a test can find an ephemeral port. `beside` is a Layer of routes served on the same origin, such as `iirc daemon --web`'s, which the Daemon knows nothing of. |
| `Beside` | The type of those routes: a Layer that adds to the `HttpRouter`, and may use the server's `FileSystem`, `Path`, and file responses. |
| `DaemonOptions` | `dataDir`, the Transport's options (such as extra roots to `trust`), the News `heartbeat` (15 s), and the Runtime's `pacing` (a burst of 5, then one Line every 2 s), `hangupDrain` (5 s), and `stopTimeout` (5 s). |
| `layerLogger` | logfmt on stderr, so stdout holds only what a command was asked for. |
| `ApiRoutes`, `ApiHandlers` | The API's routes with the key and sign-in check, request validation, and the body limit, and the handler groups alone, for an in-process client. They need `Runtime`, `Vault`, `TimelineStore`, `Projector`, `UiConfiguration`, `ApiKeys`, and `SignIns`. |
| `Heartbeat`, `ChangesPage` | How often the News and Timeline changes streams say they are alive (15 s), and how many things one event of the Timeline changes holds at most (500). Each is a reference a test may set. |
| `createKey(dataDir, name)` | `iirc key create`: makes a key, stores its hash, and gives the key once. Call it with the data directory held. |
| `ApiKeys` | Checks a presented key against `keys.json`, read once at start. |
| `SignIns` | Makes, checks, and ends sign-ins, kept in `sign-ins.json`. |
| `holdDataDirectory(dataDir)` | Holds a data directory exclusively for the enclosing Scope, or fails with `DataDirectoryLocked`. |
| `Projector`, `ProjectorStatus` | Whether the Timelines are being folded: `Running`, or `Stopped { reason }` once a failure stopped it. And `folded`, the projection version and the last sequence folded, together, now and each time either changes. |
| `layerProjector` | The projector alone, given a `Runtime` and a `TimelineStore`. |
| `UiConfiguration`, `layerUiConfiguration`, `UiChangedSince` | The options under `ui`, folded from the Journal's Changes, and how a Change is checked and journaled, failing with `UiChangedSince` when made from other options than those in force. The Layer needs the `Journal`. |

## The data directory

| File | What | Written by |
| --- | --- | --- |
| `journal.sqlite` | The Journal | `@iirc/journal-sqlite` |
| `views.sqlite` | The Timelines, derived from the Journal | `@iirc/timeline-store-sqlite`, by the projector |
| `credentials.json` | The Credentials, mode `0600` | `@iirc/vault-file` |
| `keys.json` | The API keys as SHA-256 hashes | `iirc key create` |
| `sign-ins.json` | The sign-ins as SHA-256 hashes | the Daemon |
| `daemon.lock` | The lock below. It holds nothing | the Daemon and `iirc key create` |

The Daemon makes the directory, mode `0700`, if it is missing. Nothing else is read at start: there is no configuration file. `views.sqlite` is derived: removing it while the Daemon is stopped rebuilds it on the next start.

**One Daemon to a directory.** Neither the Journal nor the Vault refuses a second owner of its file, so the Daemon holds the directory before it opens either: an open `BEGIN EXCLUSIVE` on `daemon.lock`, a SQLite database of its own. SQLite takes it with a POSIX lock, which the kernel frees however the process dies, so a crash never leaves the directory locked. SQLite tracks it per file within one process too, so a second Daemon in the same process is refused as well. A second Daemon, or `iirc key create` while one runs, fails with `DataDirectoryLocked`.

## Timelines

The projector keeps `views.sqlite` folded up to the Journal, with the fold of `@iirc/timelines` and the store of `@iirc/timeline-store-sqlite`.

- **On start, it resumes or rebuilds.** It reads how far the store has folded. When the store was built by the same projection version as `projectionVersion`, it takes the directory the store kept and follows the Runtime's `news` after the last sequence folded. Otherwise, a new or emptied store included, it resets the store to `projectionVersion`, logs that it is folding again, and folds from the start of the Journal.
- **Each step is applied whole.** For each `Happened`, it steps the fold and applies the changes, with the step's sequence as `through` and the directory after it, in one transaction. A step at or before the last one folded changes nothing, so resuming never folds a step twice.
- **It never holds up the Runtime or a Network.** It reads News as any reader does, following the Journal on its own, so a slow or stopped projector holds back only itself.
- **A failure stops it, and nothing else.** A store that cannot be written or read, or a Journal that cannot be followed, stops the projector. It is logged as an error with its reason, `Projector`'s status becomes `Stopped` with that reason, and the Daemon and every Network go on. A restart tries again. A store that cannot be opened at start is a refusal, as a Journal that cannot be opened is.
- **The store may lag the Journal, never lead it.** After a crash, what the store lost of the last steps is folded again on start.
- **Read Markers and unread counts are the projection's.** A `read` is journaled and stepped like any input, and the fold moves the Timeline's Read Marker from the `ReadMarker` News it gives. The store counts what lies after it by level, and a Timeline read gives the counts as the store keeps them, so every Frontend reads the same numbers and none works them out.
- **It says how far it has folded, to whoever waits.** `Projector.folded` gives `{ version, through }` from one `SubscriptionRef`, so the two always go together: from where it resumed, or the version it reset the store to with no `through`, and again once each step is kept. It knows nothing of HTTP: the changes route waits on it rather than polling the store.

## The options under `ui`

The options under `ui` are a projection of the Journal's `Change`s, in `src/ui.ts`.

- **On start, they are folded from the Journal.** Every `Change` is read once, in order, and the latest of each option wins, an unset returning it to its default, so a restart gives the same options. A Change of an option this Daemon does not have, or of a value its Schema does not take, changes no option, though its sequence is still the last. `themes` is read theme by theme, by the contract's `uiValueKept`, so a theme its Schema now refuses, as one named for a built-in theme, is dropped alone and the rest kept.
- **A change is checked and journaled in one turn.** One turn at a time compares `ifSequence` with the sequence of the last Change, appends the `Change`, and holds what it appended, uninterruptibly, so what is held never differs from the Journal and two changes made from the same options never both pass. It is the only way a `Change` is journaled. A `Change` holds the value as its option's Schema encodes it, after the handler parsed it.
- **The stream is the options, whole, from what is held.** `changes` gives the options in force, then again each time a Change is held, from a `SubscriptionRef`, so the stream reads nothing from the Journal. The handler leaves out those at or before `after`, and merges in the heartbeat.

## API keys

`keys.json` is versioned JSON, written as vault-file writes its file: to `keys.json.tmp` with `wx` and mode `0600`, synced, then renamed into place, and the directory synced. A crash leaves the old file or the new one.

```json
{
  "version": 1,
  "keys": [{ "name": "phone", "sha256": "…64 hex digits…", "created": "2026-11-10T00:00:00.000Z" }]
}
```

- **A key is 256 random bits,** from Effect's `SecureRandom`, written `iirc_` and base64url. It is shown once, by `iirc key create`, and kept only as its SHA-256. A random key needs no password hash.
- **A request's key is compared against every stored hash,** each with `timingSafeEqual`, so the time taken says nothing of which key matched, or how much of one.
- **Keys are made only while the Daemon is stopped.** `iirc key create` holds the data directory, so the Daemon reads `keys.json` once at start, and nothing changes it under a running Daemon. A Daemon with no keys warns, and refuses every request.
- **Keys live in a file, not the Journal.** That is deliberate for now. A key is the Daemon's, not a Network's, and is checked rather than replayed. The Journal now holds Changes that belong to no Network, so keys may move there later.

## Sign-ins

`sign-ins.json` is versioned JSON, written as `keys.json` is. The running Daemon writes it, which is safe because it holds the data directory, and it writes the file before a change takes effect, so a sign-in or sign-out that could not be written changes nothing and answers `SignInsFailed`. A change is uninterruptible from taking its turn to keeping what it wrote, so a request that goes away mid-write, as Bun interrupts a disconnected one, never leaves the file holding a change that memory did not make, nor a later write undoing it. A sign-out the file already holds is a sign-out.

```json
{
  "version": 1,
  "signIns": [
    {
      "created": "2026-11-10T00:00:00.000Z",
      "key": "phone",
      "keySha256": "…64 hex digits…",
      "sha256": "…64 hex digits…"
    }
  ]
}
```

- **A sign-in is 256 random bits,** from Effect's `SecureRandom`, written `iirc_s_` and base64url, and kept only as its SHA-256, compared with `timingSafeEqual` against every stored hash, as a key is. The browser holds it in the cookie. The key it was exchanged for is never stored, logged, or sent back.
- **A sign-in survives a restart,** and lasts until it is signed out or its key is no longer held. It names its key by name and by the key's SHA-256, so a key removed from `keys.json` and made again under the same name does not bring back the sign-ins of the old one. At start, the Daemon drops every sign-in whose key it does not hold, from the file too.
- **Sign-ins live in a file, not the Journal,** for the same reason keys do.

## Composition

- **The core is provided outside `HttpRouter.serve`.** `serve` forks the MemoMap, so anything shared built inside it would be built twice, and the Journal and the lock would each be opened again.
- **The Runtime stops first, gracefully.** It lives in a Scope of its own, which a Layer built after serving closes. Layers close in reverse, so on SIGINT or SIGTERM the Runtime stops: each Network steps a `Stopping`, the Client says `QUIT` and hangs up, and the Runtime waits for each Connection's `Closed` within `stopTimeout`. Every Owner input still waiting fails with `NetworkStopped`. Then every stream a Frontend is still reading ends. Only then does serving stop, then the projector, then the Timeline store, and then the Journal, the Vault, and the lock.
- **The projector stops before what it reads and writes.** It is built after the Runtime, the Journal, and the store, so it is interrupted before any of them closes. It goes on folding while the Runtime stops, since it follows the Journal rather than the Runtime, and an apply in flight when it is interrupted is kept whole or not at all.
- **`gracefulShutdownTimeout` is 500 ms.** By then the Runtime has stopped and the streams being read have ended, so it covers only reads in flight and a stream whose reader has stopped reading, which are cut.
- **A stop is bounded, well inside a service manager's.** The Runtime waits on Ircds for at most `stopTimeout`, 5 s by default, however many Networks there are, since they stop side by side. It then lets a Journal append already in flight settle, which on a healthy disk is a few milliseconds but which the Journal port does not bound, and closes the Connections still open at once, without waiting on the Ircd. Serving then takes at most `gracefulShutdownTimeout`, 500 ms, for requests in flight. So with storage that answers promptly, a stop takes about 5.5 s, far inside systemd's default of 90 s. That is the usual time, not a guarantee: the total also includes settling an append already in flight, which nothing bounds, so a slow or stalled disk lengthens it, and so does the case "Not yet" names, where Effect's Bun server waits on a client still sending a body. Within the Runtime's bound, a hang-up drains for at most half of it, 2.5 s, and the Transport's own close takes at most its `hangupTimeout`, 2 s, so the `QUIT` fits. Raising `stopTimeout` raises the stop with it, and the service's stop timeout must stay above it plus 500 ms.
- **Every log goes through `Effect.log*`,** annotated with the Network where there is one, to the Logger built here. Each Connection's dial, Session, and end is logged at INFO, with its Ircd and the reason it ended. A Credential is logged by name only, when it is held or forgotten. HTTP requests are not logged.

## The handlers

- **Errors are mapped, never leaked.** The Runtime's `UnknownNetwork`, `NetworkStopped`, `ConfigurationChanged`, `JournalFailed`, the Vault's `VaultFailed`, and the Timeline store's `TimelineStoreFailed`, as `TimelinesFailed`, become the contract's own. `NetworkStopped` names the Network from the request and, for a `say`, an `act`, or a Lookup, the intent.
- **A change under `ui` is parsed, then checked and journaled.** The handler parses `value` by the option's Schema, refusing one it does not take with `InvalidRequest` at `["payload", "value"]`, and hands the `Change` and `ifSequence` to `UiConfiguration`, whose `UiChangedSince` becomes `UiChanged`.
- **A `PUT` of Configuration hands its `ifSequence` to the Runtime,** which checks it in the Network's own turn, so the handler holds no lock and two racing `PUT`s cannot both pass. `GET …/configuration` is the Runtime's `configuration`.
- **The Daemon names a `say`'s, an `act`'s, or a Lookup's intent** when the caller does not: 128 bits from Effect's `Random`, as hex, as the Runtime would. So the intent is known before the `Say` is stepped, and a `NetworkStopped` can say which to ask `said` about.
- **The wire forms are total maps** in `src/wire.ts`. Each return type is checked by `Fields`, so a field the Client adds to News, Knowledge, or the inspection, or a field the contract has and the Client does not, fails to compile there until the contract catches up, and a new variant fails the `switch` that ends in `satisfies never`.
- **A request that does not decode** is `InvalidRequest` with the path of each issue. Its messages never quote the input, since a body can carry a Credential's value.
- **A body over 1 MiB is refused unread,** with 413 and `Connection: close`. Bun's graceful stop waits for a client still sending a body, so without the close, one oversized upload could hold up shutdown.
- **A request may present a key or a sign-in.** The key in `Authorization: Bearer` is tried first, then the `iirc_sign_in` cookie, and either gives the handler the key's name as its `Caller`. A request the cookie carries that is not `GET` or `HEAD` must say it is same-origin, and so must signing in and out.
- **The cookie is `HttpOnly`, `SameSite=Strict`, `Path=/api`, and `Max-Age` 400 days,** the most a browser keeps a cookie. It is `Secure` only when `X-Forwarded-Proto` says the browser's connection was `https`. The API listens on loopback only, so the header comes from the Owner's own reverse proxy, which ADR 0006 trusts. On plain `http` to loopback the cookie is not `Secure`, because WebKit refuses a `Secure` cookie over `http://localhost`. Signing out clears the cookie with the same attributes, whether or not its sign-in existed.
- **The News stream** is the Runtime's `news`, from `after` or `Last-Event-ID`, mapped to the wire and merged with a heartbeat every 15 s that stops when it does. Each reader follows the Journal on its own, so a reader that reads nothing holds back only its own response, never the Runtime or another reader.
- **Timeline reads are read together, and bounded.** Each Timeline route reads the store with `consistent`, so what it gives, its `version`, and its `through` are of one state, which no step changes while they are read. A window and its Gaps are read in that one state, the Gaps over the span of the window, open on an end with nothing beyond, and collapsed by the store between each two items, so a window reads at most `limit + 1` runs of them. The list, and the items a step made, each read one more than their page, to say whether more follow, and a step's items give `next`, the last item's position and Timeline, for the page after. A Network that was never configured is `UnknownNetwork`, as the Runtime says, before the store is read. A store that cannot be read is `TimelinesFailed`.
- **A search is read together, and bounded.** It reads the store's `search` with `consistent`, after finding a named Timeline in the same state, `UnknownTimeline` when no Timeline ever had its id, and reads one more than its page, to say whether more follow and give `next`, the last item's position and Timeline, as a step's items do. A Network named that was never configured is `UnknownNetwork`, before the store is read.
- **A Channel's head and members read the Client, through the Timeline.** Each finds the Timeline by its id with the store's `timeline`, following a merged id, which is `UnknownTimeline` when no Timeline ever had it, and `NotAChannel` when it is not a Channel's. It then asks the Runtime's `channel` for the Timeline's name, so it reads that one Channel, never all the Network knows. A page of members, in `src/members.ts`, keeps the members whose folded nick starts with `prefix` folded alike, and of those after `after`, ranks each by the highest prefix it holds in `PREFIX` and sorts by rank and then folded nick, by code unit, and gives the first `limit`. Measured on 10,000 members, that is 1 to 4 ms a page, and about 10 ms through the in-process API, encoding included.
- **The changes stream** reads `changedAfter` a page of at most `ChangesPage` things at a time, in whole steps, in one `consistent` read, and gives each step's changes as one event, `<version>.<sequence>` its id, or a step too big for the page as one `overflowed` event naming the Timelines it touched. With nothing more to read, it waits until `Projector.folded` says anything other than what it last woke on, a step folded or a reset, then reads again. So a reset is seen at once, even by a follower whose old sequence the store never reaches again. A step at or before where it read is never given again, and one after it is never skipped. Each read checks the place against the version and `through` it was read at: a place of another version, or ahead of `through`, is answered with one `reset` event, and the stream goes on from where the store is. It is merged with the heartbeat, as News is. While the projector is stopped, it waits and sends heartbeats.

## Tests

`bun run test` uses no network. The handlers run through an in-process client (`HttpApiTest`) on the Runtime's in-memory ports and a `TestClock`, and the routes over a real Bun server on a loopback port the kernel picks.

`bun run e2e`, at the root or in this package, runs `src/e2e/` and is never part of `bun run test`. Each run drives a real Daemon, with the production adapters, through its HTTP API alone, and plays the other User over a raw IRC connection. The Ircds are private, on loopback ports the kernel picks, never the shared ngircd on 6667 and never port 6667.

- **ngircd** is `~/.local/opt/ngircd/ngircd`, or `IIRC_NGIRCD`, with a configuration of its own in a temporary directory.
- **Ergo** 2.19.1 is fetched into the gitignored `.cache/ergo/` and checked against its checksums file and a pinned SHA-256 before it runs. The Daemon dials it over TLS and trusts its self-signed root through the Transport's `trust`, never by turning verification off.

`@iirc/daemon/testing` exports the private Ircds and the raw peer, `startNgircd`, `startErgo`, and `connectPeer`, so another package's end-to-end run, such as the web frontend's in `apps/iirc`, starts them the same way.

## Not yet

- **Recording transcripts from the Journal.** The end-to-end runs are where fixtures will come from, through a normaliser that follows the fixtures' rules.
- **A bound on shutdown.** Effect's Bun server waits for its graceful stop with no bound once its own timeout passes, so a client in the middle of sending a body under 1 MiB, or one that has stopped reading a stream it follows, could still hold up shutdown.
- **Trusting extra roots from the command line.** `DaemonOptions.transport.trust` exists, and `iirc daemon` has no flag for it yet.
- **Key scopes, keys through the API, ending sign-ins other than by signing out, and removing a Network.**
- **Snapshots for News.** Each reader folds the Journal from the start, as the Runtime does, which costs time on a long Journal.
