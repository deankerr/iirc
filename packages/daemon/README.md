# @iirc/daemon

The Daemon, with no HTTP server and no argv: Configuration as a fold over Changes, Credentials, API keys, one host per Network, the operations a Frontend can ask for, and the API's handlers.

- **Depends on:** `@iirc/log`, `@iirc/api`, `@iirc/session`, `@iirc/state`, `@iirc/lifecycle`, `@iirc/protocol`, `effect`, `@effect/platform-bun`.
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
- **Stored Changes have their own Schemas,** in `change.ts`. They hold shapes and the defaults that absent fields meant then, never today's rules, so a tightened rule cannot keep an old Log from starting. A Change from before the encoding, the casemapping, and CTCP replies were Tuning left them out, which reads as no fallback, the Ircd's mapping, and today's CTCP defaults. An encoding label is folded as recorded, and one this runtime cannot decode with gives no fallback.
- **One permit for every Change.** An operation checks itself against Configuration, records its Change, and folds the recorded Entry under one `Semaphore`, so nothing can overtake it.
- **One host per Network,** in a `FiberMap` keyed by Network ID. Each host reads its settings from a `SubscriptionRef` of Configuration plus Credentials, and is woken by its changes. Removing a Network closes its host's Scope, which says `QUIT`.
- **Keys are a second fold over the same Changes:** name, scope, and SHA-256. `findKey` hashes what was presented and compares it in constant time against every stored hash ([ADR 0006](../../docs/adr/0006-proportionate-security.md)).
- **Credentials** are one service over the keyring (`Bun.secrets`) or `credentials.json`, chosen at startup. A write is owned by the service, never cancelled, and waited for at most 10 seconds (CRED-1).
- **Channel keys** the Owner gives are Credentials, kept under `key.` and 16 hex digits of a SHA-256 unless the Channel names one. A key a Network sets with `MODE +k` is never kept (CRED-4).
- **Causes name keys.** A Frontend's Line is recorded with the cause `key:<name>` (LOG-5).

## Reads of what the Network knows

- **A Channel read, and `known` in `GET /networks/{id}`, come from `Standing`, in memory, not from the Log.** The reader Worker has only the Log, and folding a Channel from it would mean replaying the Session. `Standing` already holds it, folded in the same transaction as each append. `Log.standingAt` reads the Network's Standing and the sequence of the commit it reflects with one `Ref.get` of what each commit sets whole once it is durable, so members, topic, modes, Self, the `RPL_ISUPPORT` tokens, and `at` always come from one snapshot. It takes no permit, so it waits for no commit and holds none up (LOG-11). `at` is the Log's head as of that commit, the sequence `/stream` will start from with no gap (API-6).
- **`views.ts` turns what the reader and `Standing` give into the contract's shapes,** as pure functions: Activity without its ordinal and its row's mapping, and the page's `next` cursor (MSG-5), a Channel with a page of members (KNOW-4, KNOW-7), and what a Session knows of Self and its Ircd (KNOW-1, KNOW-2). Spans come formatted from the reader's Worker, and only a Channel's topic, one string, is parsed here.
- **A Target is a Channel when `CHANTYPES` says so,** and is looked up with `channelOf`, which casefolds under the mapping in force (KNOW-3). A User Target is `NotAChannel` until milestone 4, and a Channel the current Session is not in is `TargetNotFound`. Between Sessions, Self is in none.
- **A members page is a range of the `SortedMap`,** `entriesAfter` the last casefolded nick, so a page of a 65,536 member Channel costs what the page holds. Each member's `user@host` and realname are one lookup in the Users seen.
- **An Activity `place` is a name the Worker casefolds under each mapping,** one index range per mapping, matched against the mapping each row recorded, so a place keeps its history across a new `CASEMAPPING` and a reconnect (KNOW-3). `/messages` takes no place filter, so it needs nothing of the kind.
- **A members cursor carries its mapping.** A cursor folded under a mapping no longer in force is refused with `CursorStale`, because the order it is a place in has changed (KNOW-3).
- **Spans are the Worker's to make, and count toward its page bound** (MSG-3, LOG-11). The main thread still decodes and encodes each span, so `spanBytes`, 128, counts toward `pageBytes` for each. Measured on fserv with Bun 1.4.4 by the LOG-11 test in `reads.test.ts`: a page of the densest text a Network can send, one 8.6 KB Line of 4,301 spans, blocked the event loop 8.3 to 8.6 ms median and 14.5 ms at most. Without the span cost the same page held 30 such Lines and blocked it 248 ms.

## Composition

- **Provide `DaemonCore` outside `HttpRouter.serve`.** `serve` forks the MemoMap, so anything shared built inside it is built twice, and the Log locks itself out.
- **`Daemon.stopsFirst` is built last, so it closes first.** Layers close in reverse order, which would stop serving first, and a Send waiting on a stalled socket could then hold up `QUIT`. Stopped first, the Networks answer that Send, then the `stopped` Entry is recorded, then serving stops, and the Log goes last (RUN-3).
- **`gracefulShutdownTimeout` must be low.** The default held a shutdown for 20 seconds. By the time it starts, every Network has stopped and every Change is refused, so it only covers a read in flight: `frontendWaitMillis`, the read budget and its grace plus half a second.
- **A stop waits for the slowest `QUIT`,** so `TuningSettings` caps `quitWaitMillis` at 10 seconds, well inside a service manager's stop timeout.
- **A host's Scope is closed on a fiber of its own.** Its finalizer waits for `QUIT` in an interruptible region, and on the fiber the `FiberMap` interrupts, that region would end at once.

## Field vocabulary

`toLogEntry` in `./routes` turns an `Entry` into the API's `LogEntry`, adding `text` and, for an unparseable Line, `reason`. `text` is decoded with the fallback the Entry's Connection recorded in its `attempt`, which `Daemon.entries` looks up with `LogReader.encodings` for each Connection in the page, so `/entries` reads bytes as `Standing` did (MSG-4). Its return type is checked with `IfFieldsOfEntry`, so a kind or field added to `Entry` fails to compile here until the contract catches up. [`@iirc/session`](../session/README.md#field-vocabulary) has the whole table.

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
