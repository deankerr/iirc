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
  --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
  apps/iirc/src/main.ts packages/log/src/reader-worker.ts --outfile iirc
```

- The Worker must be listed as a second entrypoint.
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
          ┌────┴─────┐
  @iirc/session  @iirc/state                           Effect runtime for one Network, IRC state fold
     ┌────┴────┐     │
     │         └──┬──┘
@iirc/lifecycle  @iirc/protocol                        pure: Network machine, bytes to Lines and back
```

Dependencies point down only, and each package stands alone for whoever wants it. The library is the bottom four. The jesopo lineage maps onto it directly: `protocol` is irctokens, `state` is ircstates, and `session` is ircrobots.

| Package | Job | Runtime dependencies |
| --- | --- | --- |
| `@iirc/protocol` | Frames, Lines, safe outbound construction, `RPL_ISUPPORT`, casefolding, mode parsing, formatting, CTCP, splitting, nick candidates, token bucket, Lookup tables, refusal classifier | None |
| `@iirc/state` | Folds Lines into Channels, members, modes, and Self. Moves out of `protocol` | `protocol` |
| `@iirc/lifecycle` | The Network machine, `step`, `fold`, and its command type | `xstate` |
| `@iirc/session` | Hosts one Network: Transport, lanes, watchdog, Lookup queue, reconnect | `lifecycle`, `protocol`, `effect`, `@effect/platform-bun` |
| `@iirc/log` | SQLite, the writer, the Worker reader, migrations, derived tables, Entry schemas | `session`, `state`, `protocol`, `effect`, `@effect/sql-sqlite-bun`, `@effect/platform-bun` |
| `@iirc/api` | `DaemonApi`, Schemas, typed errors | `effect` |
| `@iirc/client` | `HttpApiClient` plus cursor tracking, reconnect, and `resync` handling | `api`, `effect` |
| `@iirc/daemon` | Network supervision, operations, Configuration, Credentials, Keys, handlers. Exports `DaemonCore` and `ApiRoutes` | `log`, `api`, `session`, `lifecycle`, `protocol`, `effect` |
| `@iirc/web` | The web frontend | `client` |
| `apps/iirc` | The only place that reads argv or touches `bun:bundle` | everything above |

- **Seams worth keeping:**
  - **`Transport`:** `(ircd) => Effect<Socket>`, so tests run Sessions on `TestClock` with no real port.
  - **`Recorder`:** what `session` calls to record before acting. In memory for library users, and durable in `log`. This keeps `session` ignorant of SQLite and is what makes it usable alone.
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
  serve(Layer.mergeAll(ApiRoutes, StreamSocket, webRoutes(config)), config.listen).pipe(
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
- SIGINT and SIGTERM interrupt main through `BunRuntime.runMain`, so LIVE-9's `QUIT` is a finalizer. `gracefulShutdownTimeout` must be set low and `QUIT` ordered first, because the default held a shutdown for 20 seconds.

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

// @iirc/session: one fiber per Network, about 40 lines, replacing createEffectActor
const item = yield * Queue.take(inbox).pipe(Effect.timeoutOption(Duration.millis(wait)));
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
| LIVE-2 liveness | Effect watchdog. It appends a close, and the machine sees only that |
| LIVE-4 reconnect | Pure fold over Connection Entries gives the delay, with jitter seeded by sequence. XState holds the waiting state |
| LIVE-5 refusal | Pure classifier, XState holds the reason |
| Rejoining Channels | Pure fold plus an Effect reconciler: Configuration minus derived state gives `JOIN` batches |
| Lookups | Pure correlator table, `Semaphore` and `Deferred` |
| FILL Gap filling | Effect paging loop over a pure Gap fold |
| Frontend stream | Effect on the Daemon, a plain fold in the Frontend |

### Effect pieces

| Need | Use | Instead of |
| --- | --- | --- |
| Per-Network supervision | `FiberMap`, each Session in `Effect.scoped` | `RcMap`, `LayerMap`, which suit borrowed resources |
| SEND-1 lanes | One `TxQueue` per lane and one pump fiber | `TxPriorityQueue`, which has one bound where SEND-3 needs one per lane |
| SEND-4 dropping | `TxQueue.clear` returns the items |  |
| SEND-2 flood control | Pure token bucket driven by `Clock` | `RateLimiter`, whose delay would break strict priority |
| `/stream` fan-out | `PubSub.sliding({ capacity: 1, replay: 1 })` of the head sequence, published from `sql.afterCommit`. Each subscriber pages from its own cursor | A payload `PubSub`, which stalls the writer or loses data |
| LOOK-4, LOOK-5 | `Semaphore.withPermit` per Network, `Deferred` for the result. A caller leaving cancels its queued Lookup |  |
| LIVE-3, CONN-5 timing | `Schedule.spaced`, `Schedule.exponential` |  |
| CRED-3 | `Redacted`, `Schema.Redacted`, `Config.Redacted` |  |
| LOG-11 reads | `RpcClient` to `BunWorker` |  |
| Tests | `@effect/vitest`, `TestClock`, `it.prop`, `HttpApiTest.groups` | `bun test`, because `@effect/vitest` needs vitest |
| OBS | `Metric`, `Logger`, built-in `Otlp.layerJson`, `PrometheusMetrics.format` | `@effect/opentelemetry` |

## Storage

- **Writer:** `SqlClient` on the main thread, one statement batch per socket read.
  - With `synchronous=FULL`, one Line plus FTS and a derived row took 0.97 ms at p50, 2.5 ms at p99, and 26 ms at p99.9. That answers LOG-11's deferred question for now: it stays on the main thread until real traffic says otherwise.
  - `SqlClient` costs 62 µs per transaction against 2.7 µs for raw `bun:sqlite`, which an fsync dwarfs.
- **Reader:** a Worker with a readonly connection, reached over Effect RPC.
- **Time budgets:** `bun:sqlite` cannot interrupt a query, and `worker.terminate()` does not stop one. A 13 second query ended only when it finished.
  - Reads are paged, with a deadline checked between pages.
  - Search orders by recency by default, which took about 0 ms over 2 million rows, against 1.9 seconds for `ORDER BY rank`.
  - A `db.function()` deadline works for scans, using a raw `Database` in the Worker, because `SqlClient` does not expose it.
- **Backup:** `VACUUM INTO` from the Worker took 2.4 seconds for 250 MB and passed `quick_check`.
- **Lock:** a held `BEGIN EXCLUSIVE` on a sidecar SQLite file. A second process got `SQLITE_BUSY`, and `SIGKILL` released it.
- **Credentials:** `Bun.secrets` where a keyring exists, and Effect has no equivalent. It is experimental, and fserv has no keyring, so the plain file comes first in practice.
- **Migrations:** `Migrator.fromRecord`, since a compiled binary has no migration files to read. Refusing a newer Log is our own check.

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
- `BunSocket.makeTls` cannot do CONN-1: with `rejectUnauthorized: false`, `checkServerIdentity` never ran, so pinning failed. A small adapter over `BunSocket.fromDuplex` passes both ways. It belongs behind `Transport`.
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
- Lanes on `TxQueue` have not been run.
- Effect's overhead on the append path has been measured only in memory, and commit latency only on synthetic data.
- `@xstate/test` needs a check against vitest 5. Its graph paths passed under Bun.
- arm64, musl, macOS, and Windows builds compile but have not run. FTS5 on macOS is unverified.

The first code should prove these on a vertical slice: one Network, the durable Log, the machine as a fold, and a kill test.
