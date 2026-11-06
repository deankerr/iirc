# @iirc/daemon

The Daemon, with no HTTP server and no argv: Configuration as a fold over Changes, Credentials, API keys, one host per Network, the operations a Frontend can ask for, and the API's handlers.

- **Depends on:** `@iirc/log`, `@iirc/api`, `@iirc/session`, `@iirc/lifecycle`, `@iirc/protocol`, `effect`, `@effect/platform-bun`.
- **Used by:** `apps/iirc`. Tests of `apps/soak` run a real one.

## Public surface

| Path | Export | Role |
| --- | --- | --- |
| `.` | `DaemonCore(config, { transport?, keyring?, writeTimeout?, reader? })` | The Daemon and everything under it as one Layer: the Log, the reader, Credentials, and the hosts. Only a test gives the parts |
| `.` | `Daemon` | The service: every operation, each on behalf of a key, and `status` |
| `.` | `Daemon.stopsFirst` | A Layer that makes the Networks the first thing to stop |
| `.` | `createLocalKey` | `iirc key create`: appends a key's Change with the Daemon stopped (AUTH-4) |
| `.` | `frontendWaitMillis`, `UndecodableChange` | How long serving waits for reads in flight at a stop, and the refusal to start on an unreadable Change |
| `./routes` | `ApiRoutes`, `maxBodySize` | The handlers for `DaemonApi`, with auth, request validation, and a 1 MiB body limit |
| `./tuning` | `tuningOf` | A whole `Tuning` from the Owner's overrides |

## Usage

This is `iirc daemon`, less its error messages.

```ts
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Daemon, DaemonCore, frontendWaitMillis } from "@iirc/daemon";
import { ApiRoutes } from "@iirc/daemon/routes";
import { Duration, Layer } from "effect";
import { HttpRouter } from "effect/http";

const server = HttpRouter.serve(ApiRoutes, { disableLogger: true }).pipe(
  Layer.provide(
    BunHttpServer.layer({
      gracefulShutdownTimeout: Duration.millis(frontendWaitMillis),
      hostname: "127.0.0.1",
      port: 7667,
    })
  )
);

const app = Daemon.stopsFirst.pipe(
  Layer.provide(server),
  Layer.provide(DaemonCore({ dataDir: "/var/lib/iirc", version: "0.0.0" })) // outside serve
);

BunRuntime.runMain(Layer.launch(app)); // SIGINT and SIGTERM stop it cleanly (RUN-3)
```

## Key ideas

- **Configuration is a fold over Change Entries** ([ADR 0004](../../docs/adr/0004-configuration-lives-in-the-log.md)). `reduceConfiguration` folds one Change. The Daemon decodes every Change at startup and refuses to start on one it cannot read (CONF-1).
- **Stored Changes have their own Schemas,** in `change.ts`. They hold shapes and the defaults that absent fields meant then, never today's rules, so a tightened rule cannot keep an old Log from starting.
- **One permit for every Change.** An operation checks itself against Configuration, records its Change, and folds the recorded Entry under one `Semaphore`, so nothing can overtake it.
- **One host per Network,** in a `FiberMap` keyed by Network ID. Each host reads its settings from a `SubscriptionRef` of Configuration plus Credentials, and is woken by its changes. Removing a Network closes its host's Scope, which says `QUIT`.
- **Keys are a second fold over the same Changes:** name, scope, and SHA-256. `findKey` hashes what was presented and compares it in constant time against every stored hash ([ADR 0006](../../docs/adr/0006-proportionate-security.md)).
- **Credentials** are one service over the keyring (`Bun.secrets`) or `credentials.json`, chosen at startup. A write is owned by the service, never cancelled, and waited for at most 10 seconds (CRED-1).
- **Channel keys** the Owner gives are Credentials, kept under `key.` and 16 hex digits of a SHA-256 unless the Channel names one. A key a Network sets with `MODE +k` is never kept (CRED-4).
- **Causes name keys.** A Frontend's Line is recorded with the cause `key:<name>` (LOG-5).

## Composition

- **Provide `DaemonCore` outside `HttpRouter.serve`.** `serve` forks the MemoMap, so anything shared built inside it is built twice, and the Log locks itself out.
- **`Daemon.stopsFirst` is built last, so it closes first.** Layers close in reverse order, which would stop serving first, and a Send waiting on a stalled socket could then hold up `QUIT`. Stopped first, the Networks answer that Send, then the `stopped` Entry is recorded, then serving stops, and the Log goes last (RUN-3).
- **`gracefulShutdownTimeout` must be low.** The default held a shutdown for 20 seconds. By the time it starts, every Network has stopped and every Change is refused, so it only covers a read in flight: `frontendWaitMillis`, the read budget and its grace plus half a second.
- **A stop waits for the slowest `QUIT`,** so `TuningSettings` caps `quitWaitMillis` at 10 seconds, well inside a service manager's stop timeout.
- **A host's Scope is closed on a fiber of its own.** Its finalizer waits for `QUIT` in an interruptible region, and on the fiber the `FiberMap` interrupts, that region would end at once.

## Field vocabulary

`toLogEntry` in `./routes` turns an `Entry` into the API's `LogEntry`, adding `text` and, for an unparseable Line, `reason`. Its return type is checked with `IfFieldsOfEntry`, so a kind or field added to `Entry` fails to compile here until the contract catches up. [`@iirc/session`](../session/README.md#field-vocabulary) has the whole table.

## Traps

- Middleware passed to `serve({ middleware })` silently does nothing. Use `HttpRouter.middleware(..., { global: true })`, as the body limit does.
- `SIGINT` and `SIGTERM` interrupt main through `BunRuntime.runMain`, so `QUIT` is a finalizer. `apps/iirc`'s teardown turns that interrupt into exit 0, where the default says 130.

### Known before milestone 4

Found while building probes for `/stream`, the WebSocket route, metrics, and the web frontend. None of these surfaces exists yet.

- SSE lives in the contract through `HttpApiSchema.StreamSse`. WebSocket does not fit `HttpApi`, so it is a plain route. They stay one contract by sharing one `tail(cursor)` Stream and one event Schema.
- `/stream` fans out through `PubSub.sliding({ capacity: 1, replay: 1 })` of the head sequence, published from `sql.afterCommit`, and each subscriber pages from its own cursor. A payload `PubSub` stalls the writer or loses data.
- WebSockets silently lose data unless `closeOnBackpressureLimit: true` is set, which also gives HOST-5's disconnect. `ws.publish` is out of reach of Effect's `Socket`, and `/stream` filters per Frontend anyway.
- Offer the `iirc.v1` subprotocol first. Bun echoes the first one offered, so offering the key first reflects it back (AUTH-6).
- `Stream.timeout` fires only when the server pulls, so a stalled reader trips nothing. Use `idleTimeout`, and send typed heartbeats, because `StreamSse` cannot send comment lines.
- Exclude `/stream` from compression, with `Cache-Control: no-transform`, because flushing is not guaranteed.
- `PrometheusMetrics.layerHttp` adds an unauthenticated route, breaking AUTH-1. Call `format()` from a typed endpoint. Use Effect's `Metric`, `Logger`, and `Otlp.layerJson`, not `@effect/opentelemetry`.
- OTLP exports error messages, so errors must never carry Message text (OBS-2). `/search?q=` needs `UrlParams.CurrentRedactedNames`.

## Requirements

[Configuration](../../docs/requirements.md#configuration), [Credentials](../../docs/requirements.md#credentials), [API](../../docs/requirements.md#api), [Access](../../docs/requirements.md#access), LOG-5 and LOG-7 in [The Log](../../docs/requirements.md#the-log), LIVE-9 in [Staying connected](../../docs/requirements.md#staying-connected), RUN-2 and RUN-3 in [Running it](../../docs/requirements.md#running-it), and OBS-4 in [Observability](../../docs/requirements.md#observability).
