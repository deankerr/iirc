# Architecture sketch

This is how the packages fit together and roughly how they are built. [`daemon.md`](daemon.md) says what the Daemon must do, and this document says where that work lives. It is a sketch: the boundaries are decisions, and the code is shape only and has not been type-checked.

Versions studied: Bun 1.4.4, Effect 4.1.1, XState 6.0.0-alpha.71. Most claims here came from experiments on fserv. [Unproven](#unproven) lists what did not.

## The idea

One program, composed of Effect services, with a thin outer layer that chooses what to run.

- **Who owns what:**
  - **Pure code** owns anything that can be computed: parsing, folds, tables, policies.
  - **XState** owns phases that gate behaviour, as a pure fold.
  - **Effect** owns anything that waits, fails, or holds a resource, and is the standard library wherever it overlaps Bun.
  - **Bun** owns what only a runtime can do: the executable, embedding, bundling, SQLite, and the HTTP engine beneath Effect.
- **The Daemon never knows a web frontend exists.** A web frontend is a Layer that adds routes, and only the composition root knows both.

## Deployment shapes

Arguments choose the shape, and a build flag only decides whether web assets are included. The Bun runtime alone is 104 MB and a web frontend adds about 2 MB, so separate executables per shape would save nothing.

| Shape | Command | Runs |
| --- | --- | --- |
| Stand-alone Daemon | `iirc daemon` | The Daemon and its API |
| Daemon with web frontend | `iirc daemon --web` | The same, plus static routes on one origin |
| Stand-alone web frontend | `iirc web --daemon-url <url>` | Static routes, and a proxy to a Daemon's `/api` |
| Static files | `dist/` behind any reverse proxy | Nothing of ours at run time |

- **Every shape is same-origin.** A reverse proxy serving `dist/` also forwards `/api`. This is what settles how a browser holds its key (AUTH-7).
- `iirc key create` makes the first key (AUTH-4).
- A build without web assets refuses `--web` and `iirc web` with a clear error.

```sh
bun build web/index.html --outdir=dist --minify --splitting
bun build --compile --minify --sourcemap --feature WEB --asset ./dist \
  --compile-exec-argv="--disallow-code-generation-from-strings=strict" \
  --no-compile-autoload-dotenv --no-compile-autoload-bunfig --root packages/log/src \
  apps/iirc/src/main.ts packages/log/src/reader-worker.ts --outfile iirc
```

- The Worker must be listed as a second entrypoint, under `--root packages/log/src`. In a compiled binary every module's `import.meta.url` is the binary's own `/$bunfs/root/iirc`, and an extra entrypoint is stored at its path below `--root`. With the root at the Worker's own directory, `new URL("reader-worker.ts", import.meta.url)` names the same file from source and from the binary.
- Only a guarded `import()` removes assets. A static import stays in the binary even with the feature off.
- `feature()` is a build error anywhere except directly in an `if` or ternary, and `bun:bundle` does not resolve under vitest. So it appears only in `apps/iirc`, which no test imports.
- A test proves a build without `WEB` contains no web assets.

## Packages

```text
                            apps/iirc                  composition root: argv, shapes, build
                     ┌──────────┴──────────┐
                  @iirc/daemon          @iirc/web      Frontend source, built to dist/
                     │      │                │
               ┌─────┘      └─────┐      @iirc/client  typed client, holds the cursor
           @iirc/log          @iirc/api ─────┘         contract: HttpApi and Schemas
               │
     @iirc/session                                     Effect runtime for one Network
     ┌────┴─────┐
     │     @iirc/state                                 IRC state fold
     │          │
@iirc/lifecycle  @iirc/protocol                        pure: Network machine, bytes to Lines and back
```

Dependencies point down only, and each package stands alone for whoever wants it. The library is the bottom four. The jesopo lineage maps onto it directly: `protocol` is irctokens, `state` is ircstates, and `session` is ircrobots.

| Package | Job | Runtime dependencies |
| --- | --- | --- |
| `@iirc/protocol` | Frames, Lines, safe outbound construction, formatting, CTCP, splitting, nick candidates, token bucket, Lookup tables, refusal classifier, and `channelKey`, the ASCII fold Configuration compares names by | None |
| `@iirc/state` | What an Ircd's Lines mean: `RPL_ISUPPORT`, casemapping, mode parsing, Self, the Channels Self is in, and their keys, as one fold, `stepState` | `protocol` |
| `@iirc/lifecycle` | The Network machine, `step`, `fold`, `Tuning`, and its command type | `xstate`, `protocol` |
| `@iirc/session` | Hosts one Network: Transport, lanes, `Standing`, Lookup queue, reconnect, and `Entry` and `Committed`, which every Recorder offers | `lifecycle`, `state`, `protocol`, `effect`, `@effect/platform-bun` |
| `@iirc/log` | SQLite, the writer, the Worker reader, migrations, derived tables, Entry schemas | `session`, `state`, `effect`, `@effect/sql-sqlite-bun`, `@effect/platform-bun` |
| `@iirc/api` | `DaemonApi`, Schemas, typed errors | `effect` |
| `@iirc/client` | `HttpApiClient` plus cursor tracking, reconnect, and `resync` handling | `api`, `effect` |
| `@iirc/daemon` | Network supervision, operations, Configuration, Credentials, Keys, handlers. Exports `DaemonCore` and `ApiRoutes` | `log`, `api`, `session`, `lifecycle`, `protocol`, `effect` |
| `@iirc/web` | The web frontend | `client` |
| `apps/iirc` | The only place that reads argv or touches `bun:bundle` | everything above |
| `apps/soak` | `iirc-soak`, the soak test's Frontend (PROOF-5): `send` and `check` over the API | `api` |

- **Seams worth keeping:**
  - **`Transport`:** `(ircd) => Effect<Socket>`, so tests run Sessions on `TestClock` with no real port.
  - **`Recorder`:** what `session` calls to record before acting. In memory for library users, and durable in `log`. This keeps `session` ignorant of SQLite and is what makes it usable alone.
  - **`Committed`:** how anyone in the process watches Entries as they commit, without crossing into a Recorder. Both Recorders offer it, so a bot needs only `hostNetwork`, `Recorder.memory`, and a watch.
  - **`Log` and `LogReader`:** moving the writer to a Worker later becomes a Layer swap.
  - **`Credentials`:** one interface over `Bun.secrets` and a plain file (CRED-1), chosen at startup.
  - **`Keys`:** API keys, which both `HttpApi` middleware and the WebSocket route call.
- **`lifecycle` knows nothing of Entries.** It takes events. Mapping an Entry to an event lives above it, so another project can drive the machine from its own loop, with no Effect required.

## Composition

Each surface is a Layer that adds routes to one `HttpRouter`. One router has already served the API, auth, docs, SSE, a WebSocket route, and static files together.

```ts
// @iirc/daemon: no argv, no Bun.serve. Each line is a seam.
export const DaemonCore = (config: DaemonConfig, transport = Transport.layer) =>
  Networks.layer.pipe(
    Layer.provideMerge(Daemon.layer),
    Layer.provideMerge(Log.layer),
    Layer.provideMerge(LogReader.layerWorker(config)),
    Layer.provideMerge(Layer.mergeAll(transport, Credentials.layer(config), Keys.layer)),
    Layer.provideMerge(Storage.layer(config)) // lock, backup, migrate, SqlClient
  );

// apps/iirc: the whole runtime layer
const serve = (routes, listen) =>
  HttpRouter.serve(routes, { disableLogger: true }).pipe(
    Layer.provide(BunHttpServer.layer(listen))
  );

const daemon = (config) =>
  Daemon.stopsFirst.pipe(
    Layer.provide(serve(Layer.mergeAll(ApiRoutes, StreamSocket, webRoutes(config)), config.listen)),
    Layer.provide(DaemonCore(config)), // outside serve, which forks the MemoMap
    Layer.provide(Telemetry.layer)
  );

const webRoutes = (config) =>
  config.web
    ? Layer.unwrap(Effect.promise(() => import("./web.ts")).pipe(Effect.map((web) => web.routes)))
    : Layer.empty;
```

- The `import()` above sits behind `feature("WEB")` in the real code.
- Anything shared must be provided outside `HttpRouter.serve`, or it is built twice.
- SIGINT and SIGTERM interrupt main through `BunRuntime.runMain`, so LIVE-9's `QUIT` is a finalizer, and the teardown calls that interrupt exit 0 where its default says 130.
- Layers close in reverse, which would stop `serve` first, so a Send waiting on a stalled socket could hold up `QUIT`. `Daemon.stopsFirst` is built last for that reason: the Network goes first and answers that Send, then the `stopped` Entry, then `serve`, and the Log last.
- `gracefulShutdownTimeout` must be set low, because the default held a shutdown for 20 seconds. Every Network has stopped by the time it starts, which answers every Send, and a stopped Daemon refuses every Change, so it only has to cover a read in flight: `frontendWaitMillis`, the read budget and its grace plus half a second. No Network's Tuning moves it. After it runs out, the serve scope interrupts whatever handlers are left.
- A stop waits for the slowest Network's `QUIT`, so the Tuning rules cap `quitWaitMillis` at 10 seconds, well inside a service manager's stop timeout.

## The Network host

This is the core of the design. A machine is a projection of the Log, like everything else.

```text
socket read ──> frames ──> one transaction: append Entries, update derived tables, step machine
                                                     │ after commit
                       head wake to /stream <────────┤
                       commands to the lanes  <──────┘
```

- **The only way into a machine is Entries.** A reader, a Change, a watchdog, and an expired deadline all append first, then step. `/state?at=` and status are therefore the same fold (OBS-4, VIEW-7).
- **`transition` is synchronous**, so it runs inside the append transaction. `createEffectActor` cannot, because its `send` only queues.
- **Machines hold no timers.** They store absolute deadlines in context, computed from the Entry's own time. The host's loop waits on its inbox with a timeout, and a deadline that passes becomes a Deadline Entry (LOG-2).
- **Commands are data.** Registered actions come back from `transition`, and the host runs them after commit. Replay discards them, because their outcomes are already Entries.

```ts
// @iirc/lifecycle
export const step = (snapshot, event) => {
  const [next, effects] = transition(network, snapshot, event);
  return { commands: effects.filter((effect) => effect.kind === "action"), next };
};

export const fold = (events, input) => {
  let [snapshot] = initialTransition(network, input);
  for (const event of events) snapshot = step(snapshot, event).next;
  return snapshot;
};

// @iirc/session: one fiber per Connection, replacing createEffectActor. It waits with
// `Queue.peek` under a timeout, because a timed `take` can lose its item to the timer.
const waited = yield * Queue.peek(inbox).pipe(Effect.timeoutOption(Duration.millis(wait)));
```

### Who owns each behaviour

| Behaviour | Owner |
| --- | --- |
| Connection and registration phases | XState |
| Network enabled, disabled, closing | XState, fed by Change Entries |
| CONN-4 nick fallback | XState holds an index, pure list |
| CONN-5 nick regain | XState parallel region of the Session |
| CONN-6 login wait, CONN-7 burst | XState, pure classifier |
| CAP negotiation | XState substates of registering, pure capability fold |
| LIVE-2 liveness, LIVE-3 lag checks, CONN-7 burst | Deadlines in the machine's context, recorded as Deadline Entries when they expire |
| LIVE-4 reconnect | Pure fold over Entries gives the time of the next attempt, with jitter seeded by sequence. The host waits for it |
| LIVE-5 refusal | Pure classifier in the machine, recorded on the `closed` Entry |
| LIVE-9 stopping | A `closing` Entry moves the machine, which asks for `QUIT` and a close |
| Rejoining Channels | Pure plan over `Standing`, which an Effect reconciler carries out: wanted Channels minus derived state gives `JOIN` batches |
| Lookups | Pure correlator table, `Semaphore` and `Deferred` |
| FILL Gap filling | Effect paging loop over a pure Gap fold |
| Frontend stream | Effect on the Daemon, a plain fold in the Frontend |

### Staying on a Network

A machine lives for one Connection: every `attempt` resets it. What outlasts a Connection is `Standing`, a pure fold over Entries.

- **`@iirc/state` is the one interpretation of what an Ircd says.** `stepState(state, line)` gives `{ next, changes }`: the Session's state after the Line, and each observable transition it made, such as joined, parted, kicked, nick changed, key set or cleared, a `JOIN` refused, or `RPL_ISUPPORT` changed.
  - The state is Self's nick, `RPL_ISUPPORT` already read (`CASEMAPPING`, `PREFIX` and `CHANMODES` as mode types, `NICKLEN`), and the Channels Self is in, keyed by name casefolded under the mapping in force, spelled as the Ircd last spelled them, with their keys. It holds at most 1024 Channels and drops the oldest, and nothing else it holds grows with what a Network sends.
  - A `JOIN`, `PART`, or `KICK` naming several Channels is several changes. A `JOIN` failure is a change and is not held, because only someone who asked knows whether it names a Channel.
  - It is pure and knows nothing of Entries, Changes, or Effect, so a library user folding Lines gets what the Daemon gets.
- **`Standing` is everything a host needs from a Network's past.** That is the recent Connections and how many failed in a row, any refusal, the `NICKLEN` of the last Session, lag, the current Session's `@iirc/state`, Channels kicked from, and each Channel's last `JOIN` failure.
  - It lives in `session`, and `@iirc/session` gains a dependency on `@iirc/state`. Both Recorders keep one per Network and update it in the same transaction as the Entries, and `Recorder.standing(network)` reads it.
  - It replaces the Log's own `Sessions`, so there is one fold. It rebuilds in the existing pass at startup, which is why a crash loop cannot outrun its own backoff.
  - The host holds no copy, and reads `standing` when it needs to decide something.
- **The machine is the only owner of a Connection's progress.** Registration, nick fallback, giving up, and the login wait are decided in `lifecycle` and nowhere else.
  - `Standing` folds the current Connection's own machine over its Entries with `stepEntry`, the same step the host takes as it records, and reads it only through `inspect(snapshot)`, a `ConnectionView` of how far registration got, when the welcome came, the nick offered, how the login stands, and whether joining may go on. Nothing outside `lifecycle` reads the machine's context.
  - It steps the Session's `@iirc/state` with every inbound Line, but for a welcome the machine refused, and reads Self, Channels, and keys from there. Only the changes become anything of its own, with the Entry's time and sequence: a kick, a `JOIN` failure for a Channel it asked for, and the last `NICKLEN`. `channelKeyChanges` is the key changes of the same fold, for `onChannelKey` (CRED-4).
  - Beside the machine and the state, `Standing` keeps only what outlives a Connection or concerns the Log's provenance: who decided to close it and where it last was, the recent Connections, the refusal, `JOIN`s asked for, kicks, `JOIN` failures, and Gaps. Those it keys by `channelKey`, the comparison Configuration has with no Session to give it a mapping.
- **The next attempt is a pure function of `Standing`:** `nextAttempt(standing, { ircds, tuning })` gives a time and the Ircd.
  - The delay doubles from 5 seconds up to 5 minutes for each failure in a row, and `jitter` moves it within the upper half of that delay, seeded by the sequence of the last `attempt`, so a restart computes the same time.
  - `Standing` keeps the last 64 Connection outcomes and `Tuning` decides at read time what counts as stable, so that a tuned value applies to the past too.
  - A Session that lasted 5 minutes resets the count, and an unexpected close still waits the first delay. A close that followed `closing` is not a failure and retries at once.
  - A Connection with no `closed` Entry, because the process was killed, ended at its last Entry and counts as a failure unless it had already lasted 5 minutes.
  - A refusal waits at least 30 minutes from its close.
  - Ircds rotate after the one the last `attempt` used.
- **The `attempt` Entry records the candidate nicks,** worked out from Configuration and `Standing`. The machine takes them from its event, so replaying an old Connection gives the choices it really made.
- **Each Connection has its own lanes and pump.** The machine's `sendLine` Command names a lane, the loop offers it to that lane, and one pump fiber records and writes.
  - The control lane is bounded too, and the loop waits to offer to it, so that a `PING` flood backs up into the kernel rather than into memory.
  - When the Connection ends, its queues become Dropped Entries in the same commit as `closed`.
  - The loop never waits on a write, because a stalled socket must not stop it reading.
- **The reconciler runs from burst complete until the Connection ends.** The pure `joinPlan(standing, wanted, now, tuning)` returns what to `JOIN` now and when to look again, and the reconciler offers that to the background lane. It reads the wanted Channels from the host's settings each time it plans, so a Join or Part through the API reaches a running Session.
- **A host cannot stay dead.** A defect during a Connection becomes a `closed` Entry and a normal backoff, so `/health` needs no second opinion. A failed `record` backs off in the same way with no dial, which is LOG-9's recovery, and status shows the fault until a `record` succeeds.
- **Tuning is one value.** Every timing and limit in LIVE, CONN, and SEND that an Owner might change lives in a `Tuning` record with the spec's defaults, on the machine's input and on the host's options. A Network's settings store only the numbers the Owner overrides, so tests of the real binary set them through the API and need not wait minutes.

### Watching what commits

`Committed.watch` gives a Stream of `Entry | Overflowed`. It is the library's way to act on traffic, and the store offers the same, which a Daemon in-process reader or a future `/stream` may build on.

- **Ordering:** Entries come in sequence order, each only once its commit has landed. A Recorder publishes each commit as it lands, one at a time: the memory Recorder in the same synchronous step, and the store under its writer permit, after `COMMIT` and after its Standings are set. A rolled-back `record` publishes nothing.
- **Timing:** a watch gives everything committed after `watch` returns, and nothing from before. It subscribes then, in the caller's Scope, not when the Stream first runs, so a caller can subscribe before it starts a host and miss nothing. Its Stream ends once that Scope closes, after what it holds.
- **No replay:** a watch never looks back. The memory Recorder could replay cheaply, but the store would have to read SQLite on the writer's connection, and replay from a cursor is `/stream`'s durable contract (API-6), with its own `resync`. A caller who needs the past subscribes first and then reads by cursor, from `MemoryEntries` or the Log. That leaves no gap, and a sequence it already has is a duplicate to skip.
- **Overflow:** no watcher can hold up a commit. Each watcher has its own queue of at most `capacity` Entries, 4096 by default, and a `capacity` that is not a whole number from 1 to 1,000,000 fails the watch with `InvalidWatchCapacity`, because it would bound nothing. Once that is full it misses Entries until it has taken all it holds. Then it gets one `Overflowed { missedFrom, missedTo }`, inclusive, where they would have stood, and Entries again after that. It is never told less than what it missed, and other watchers are not affected.
  - This is not a `PubSub`. A bounded one would stall the writer, and a dropping or sliding one would lose Entries silently, and for every subscriber at once.
  - The miss stands in the queue as one element that grows until it is taken, so a watcher holds at most `capacity` Entries and one miss.

### Configuration

Configuration is a fold over Change Entries, like `Standing` is over Connection Entries ([ADR 0004](../adr/0004-configuration-lives-in-the-log.md)).

- **The fold lives in `@iirc/daemon`.** `session` stores a Change's payload as JSON it never reads, so the library knows nothing of the Daemon's Configuration. The Daemon decodes each payload with a Schema at startup and fails to start on one it cannot read.
  - The payload Schema for a Network's settings is the one `@iirc/api` publishes, so the Log format and the API move together until the soak test freezes the format.
  - Only the Daemon appends Changes, one at a time, so an operation checks itself against the current Configuration, records its Change, and folds the recorded Entry, all under one permit.
- **A host reads its settings; nothing pushes them.** `hostNetwork` takes `settings`, an effect it reads whenever it decides something, and `changes`, which wakes it. A library user passes a constant.
  - The settings carry what the fold derived from sequences: the Change that last asked for a retry (LIVE-4), and for each Channel the Join that last wanted it, which outranks an older kick (LIVE-8). The host compares them with `Standing`, so a restart decides the same.
  - Disabled is a setting, not a missing host. A disabled host makes no `attempt`, and leaves a live Connection by choice. Removing a Network closes its host's Scope.
- **Each configured Network has one host in a `FiberMap`,** keyed by its ID. Status, Send, Join, and Part find the host there.
  - A host's Scope is closed on a fiber of its own. Its finalizer waits for `QUIT` in an interruptible region, and on the fiber the `FiberMap` interrupts, that region ends at once, so nothing would wait for the `QUIT`.
- **Keys are a second fold over the same Changes:** name, scope, and SHA-256. Checking a key hashes it and compares in constant time against every stored hash.

### Effect pieces

| Need | Use | Instead of |
| --- | --- | --- |
| Per-Network supervision | `FiberMap`, each Session in `Effect.scoped` | `RcMap`, `LayerMap`, which suit borrowed resources |
| SEND-1 lanes | One `TxQueue` per lane and one pump fiber | `TxPriorityQueue`, which has one bound where SEND-3 needs one per lane |
| SEND-4 dropping | `TxQueue.clear` returns the items |  |
| SEND-2 flood control | Pure token bucket driven by `Clock` | `RateLimiter`, whose delay would break strict priority |
| `/stream` fan-out | `PubSub.sliding({ capacity: 1, replay: 1 })` of the head sequence, published from `sql.afterCommit`. Each subscriber pages from its own cursor | A payload `PubSub`, which stalls the writer or loses data |
| `Committed` watchers | One unbounded `Queue` per watcher, kept to `capacity` Entries by the publisher, with a single `Overflowed` element for a miss | `PubSub`, whose strategies stall the writer or drop silently for everyone |
| LOOK-4, LOOK-5 | `Semaphore.withPermit` per Network, `Deferred` for the result. A caller leaving cancels its queued Lookup |  |
| CONN-5 timing | `Schedule.exponential` |  |
| CRED-3 | `Redacted`, `Schema.Redacted`, `Config.Redacted` |  |
| LOG-11 reads | `RpcClient.makeProtocolWorker` on our own `Worker.makePlatform` | `BunWorker.layerPlatform`, which hears only `error`, so a Worker that exits leaves its reads waiting for ever |
| Tests | `@effect/vitest`, `TestClock`, `it.prop`, `HttpApiTest.groups` | `bun test`, because `@effect/vitest` needs vitest |
| OBS | `Metric`, `Logger`, built-in `Otlp.layerJson`, `PrometheusMetrics.format` | `@effect/opentelemetry` |

## Storage

- **Writer:** `SqlClient` on the main thread, one statement batch per socket read.
  - With `synchronous=FULL`, one Line plus FTS and a derived row took 0.97 ms at p50, 2.5 ms at p99, and 26 ms at p99.9. That answers LOG-11's deferred question for now: it stays on the main thread until real traffic says otherwise.
  - `SqlClient` costs 62 µs per transaction against 2.7 µs for raw `bun:sqlite`, which an fsync dwarfs.
- **Reader:** a Worker with a readonly connection, reached over Effect RPC. Each filter is a range over an index, and a read of several kinds is one range per kind, merged, inside one transaction so that it sees one snapshot.
- **Time budgets:** `bun:sqlite` cannot interrupt a query, and `worker.terminate()` does not stop one. A 13 second query ended only when it finished.
  - Reads are paged, with a deadline checked between pages.
  - Search orders by recency by default, which took about 0 ms over 2 million rows, against 1.9 seconds for `ORDER BY rank`.
  - A `db.function()` deadline works for scans, using a raw `Database` in the Worker, because `SqlClient` does not expose it.
- **Backup:** `VACUUM INTO` from the Worker took 2.4 seconds for 250 MB and passed `quick_check`.
- **Lock:** a held `BEGIN EXCLUSIVE` on a sidecar SQLite file. A second process got `SQLITE_BUSY`, and `SIGKILL` released it.
- **Credentials:** `Bun.secrets` where a keyring exists, and Effect has no equivalent. It is experimental, and fserv has no keyring, so the plain file comes first in practice.
- **Migrations:** `Migrator.fromRecord`, since a compiled binary has no migration files to read. Refusing a newer Log is our own check.

## Field vocabulary

Each list of fields has one owner, and every other list is derived from it or checked against it at compile time. Adding a field or a kind then fails to compile wherever it must be handled.

| Vocabulary | Owner | Derived | Checked |
| --- | --- | --- | --- |
| Tuning numbers | `Tuning` and `defaultTuning` in `lifecycle` | `TuningSettings` and the `LogEntry` Tuning Schema in `api` | `tuningBounds` in `api`, and the row codec in `log`, against the `attempt` Entry's `tuning` |
| Entry kinds and their fields | `Entry` in `session` | The `kind` filters in `api` and the reader protocol, and `EntryNotRedactable`'s kinds | `EntryRow` in `log`, and `LogEntry` in `toLogEntry` in `daemon`, with `IfFieldsOfEntry` |
| `Ircd` and `TlsDetails` | `session` |  | The row codec in `log` |

- **`IfFieldsOfEntry<Codec, Checked, Added>`** compares each kind's field names: a kind is its `_tag`, or `Connection.<phase>`. It is `Checked` when they match. Otherwise it is a type naming what is missing and what is unknown, by kind, so whatever is annotated with it fails to compile with a message that says why. `Added` is what an adapter adds of its own: `text` and `reason` in `LogEntry`.
- **Adapter differences stay in the adapters.** NULL columns, the defaults that old rows take, base64, and the decoded `text` live in `rows.ts` and `toLogEntry`. Field types are checked by the codecs themselves: the store writes an Entry and reads one back, and `toLogEntry` returns one as a `LogEntry`.
- `api` cannot depend on `session`, so `LogEntry` is checked where both are known, in the Daemon's adapter. `api`'s `Ircd` and `TlsDetails` are not checked for the same reason.
- The row codec keeps its own list of Tuning numbers, because `loginWaitMillis` carries a default for rows written before it existed, and `log` does not depend on `lifecycle` directly.

## API and Frontend

- **`HttpApi` is the public contract.** RPC stays internal, for the Worker, because it has no OpenAPI output and would make a script a lesser Frontend than an Effect client.
- **SSE lives in the contract** through `HttpApiSchema.StreamSse`. **WebSocket does not fit `HttpApi`**, so it is a plain route. They stay one contract by sharing one `tail(cursor)` Stream and one event Schema.
- **Everything sits under `/api`.** Otherwise a mistyped path would fall through to the web frontend's fallback and return HTML.
- **Web frontend, production:** `--asset` plus `HttpStaticServer`, which gave compression, `Cache-Control`, and a CSP header. Bun's native HTML routes bypass all three, and hostile text reaches this page, so CSP matters.
- **Web frontend, development:** `Bun.serve` HTML routes with `development: { hmr: true }` under `bun --hot`, which works through `BunHttpServer`.
- **State in the web frontend:** a plain fold over `/stream`. `Atom` is the candidate if a framework wants one, and the framework stays an open experiment.
- ❓ Should the Daemon's API, web frontend, and an MCP adapter be projected from one capability definition, as rat-stack does? It would be useful once MCP is real, and it is not needed before then.

## Traps found

These cost nothing to avoid now and would each cost a debugging session later.

- `sql.unsafe` with several statements runs only the first and reports success. Use one statement per call in every migration.
- `sql.stream` is not implemented on Bun. Page by cursor.
- `busyTimeout` blocks the event loop for up to 5 seconds by default. Lower it.
- `PRAGMA synchronous=FULL` is stated explicitly, because the client has no option for it.
- `BunSocket.makeTls` cannot do CONN-1: with `rejectUnauthorized: false`, `checkServerIdentity` never ran, so pinning failed. `Transport` therefore dials with `node:net` and `node:tls` itself, and reads the stream directly in pieces of at most 16 KB, so that the host can stop reading while what it has read is unrecorded (LOG-4).
  - Bun's `Socket.prototype.read` resumes the socket on every call, whatever `highWaterMark` says, so a stream read through it drained a flood into the process at 120 MB a second. `Transport` reads through `Readable.prototype.read`, which asks for more only below `highWaterMark`, so the stream holds at most 64 KB and one 512 KB read of the kernel, and the rest of a flood waits there. A close takes what the stream holds and records it.
  - A plaintext write counts once its callback fires, because before that the bytes are in a buffer that a close discards.
  - Over TLS, Bun fires the callback once a record is sealed, with the end of it possibly still in the process when the kernel is full, and nothing in its JavaScript API shows that. It takes no later write until that has left. So a TLS write counts once the next write is taken, or once the pump has nothing to write at once. If a later write stalls, the one before it is Dropped as one that may not have reached the Ircd, even if it was already reported written.
- WebSockets silently lose data unless `closeOnBackpressureLimit: true` is set, and that setting also gives HOST-5's disconnect.
- Offer the `iirc.v1` subprotocol first. Bun echoes the first one offered, so offering the key first reflects it back.
- `Stream.timeout` fires only when the server pulls, so a stalled reader trips nothing. Use `idleTimeout`, and send typed heartbeats, because `StreamSse` cannot send comment lines.
- `/stream` is excluded from compression, with `Cache-Control: no-transform`, because flushing is not guaranteed.
- Middleware passed to `serve({ middleware })` silently does nothing. Use `HttpRouter.middleware(..., { global: true })`.
- `PrometheusMetrics.layerHttp` adds an unauthenticated route, breaking AUTH-1. Call `format()` from a typed endpoint.
- OTLP exports error messages, so errors must never carry Message text (OBS-2). `/search?q=` needs `UrlParams.CurrentRedactedNames`.
- `HttpStaticServer` over `/$bunfs` sees mtime 0, so ETags are size-only. `index.html` is never cached.
- A compiled binary loads `.env` from its working directory unless told not to, and `BUN_BE_BUN=1` turns it into the full Bun CLI.
- A transition that throws must be caught by the host (HOST-1).
- A Bun Worker that exits, or is terminated, fires `close` and no `error`, and `dispatchEvent` on it after that reaches no listener.
- Per-Line code uses `Effect.fnUntraced`.

## Not adopting

| Thing | Why |
| --- | --- |
| `@xstate/effect` | It cannot record a timer before it applies, which LOG-4 needs. The host loop replaces it |
| XState `after`, `enq.emit` | Cost per step grew from about 150 µs to over 1 ms within thousands of steps on the pure path |
| Persisted machine snapshots as truth | A second source of truth |
| Spawned actors per Channel or Lookup | Replay state for what is a small table |
| `@xstate/store` | Another alpha for no lifecycle benefit |
| `EventLog`, `Workflow`, `Cluster`, `Persistence` | Built for other problems, and `EventLog` cannot give LOG-1 or LOG-3 |
| `Bun.password` for API keys | 117 ms per verify. Random 256-bit keys only need SHA-256 |
| `db.serialize()` | Blocked the main thread for 265 ms at 250 MB |
| `ws.publish` | Effect's `Socket` cannot reach it, and `/stream` filters per Frontend anyway |
| `Bun.file`, `Bun.write`, `Bun.Glob`, `Bun.spawn`, `Bun.cron`, `Bun.CryptoHasher` | Effect covers each, and Effect wins an overlap |
| `bun:ffi`, macros, HTTP/3 | Nothing needs them |

## Risks

- **Stability:** only Effect's core is stable. `http`, `http-api`, `rpc`, `sql`, `socket`, `cli`, `observability`, `crypto`, and every package outside `effect`, including `platform-bun` and `vitest`, can break in a minor release.
  - The catalog pins exact versions, and these APIs stay behind deep services.
- **XState alpha:** 66 alphas in about 4 months, with renames and no aliases. Its use stays behind `step` and `fold`.
  - Conformance tests stay independent of XState, so a hand-written reducer could replace it.
  - A 700,000 step soak gates every alpha bump.
  - `lifecycle` cannot be published until v6 is stable. The other library packages can.
- **Reference repos lag:** `~/code/ref/xstate` is v5, `effect-solutions` is a v4 beta, and rat-stack uses Node. Installed source is the authority.

## Unproven

- The stand-alone `iirc web` proxy has not been built.
- Effect's overhead on the append path has been measured only in memory, and commit latency only on synthetic data.
- `@xstate/test` needs a check against vitest 5. Its graph paths passed under Bun.
- arm64, musl, macOS, and Windows builds compile but have not run. FTS5 on macOS is unverified.
- Ergo has not been run. Its behaviour here, such as replaying always-on `JOIN`s after `376`, comes from reading its source.
