# @iirc/api

The contract every Frontend drives the Daemon through: `DaemonApi`, an Effect `HttpApi`, with its Schemas, typed errors, and scopes. It holds no handlers. A Frontend can import it alone and build a typed client.

- **Depends on:** `@iirc/protocol` (to check names and Lines a request carries), `@iirc/lifecycle` (`Tuning` defaults), `effect`.
- **Used by:** `@iirc/daemon` (the handlers), `apps/iirc` (the CLI Frontends), `apps/soak`.

## Public surface

| Export | Role |
| --- | --- |
| `DaemonApi` | The API, under `/api`, in groups `health`, `daemon`, `configuration`, `networks`, `keys`, and `credentials` |
| `Authorization`, `Caller`, `RequiredScope` | Bearer-key middleware, the caller it provides, and the scope each endpoint needs (`admin` unless it says) |
| `RequestValidation`, `requestParseOptions` | Bad requests are refused with each issue at its path. An unknown key is an issue, never silently dropped |
| `NetworkSettings`, `Configuration`, `TuningSettings` | What the Owner wants, which the Log also stores in Change Entries |
| `NetworkId`, `ChannelName`, `CredentialName`, `KeyName`, `KeyScope`, `CredentialValue` | Names, parsed at the boundary |
| `Status`, `NetworkStatus`, `LogEntry`, `LoggedMessage`, `Place`, `Gap` | What the Daemon reports. A Message has its place (MSG-2), its `STATUSMSG` prefix, and `kind` `PRIVMSG`, `NOTICE`, or `ACTION` (MSG-1, PROT-2) |
| Errors | `NotInSession`, `LaneFull`, `LineDropped`, `WriteFailed`, `LogUnavailable`, `InvalidMessage`, `InvalidRequest`, `NetworkNotFound`, `CredentialsUnavailable`, `Unauthorized`, `Forbidden`, and the rest, each tagged (API-3) |
| `apiVersion` | The contract's version, which `/status` reports (API-5) |

## Endpoints

| Group | Endpoints | Scope |
| --- | --- | --- |
| `health` | `GET /health` | None |
| `daemon` | `GET /status`, `GET /entries`, `GET /messages`, `GET /gaps` | `read` |
| `daemon` | `POST /messages`, the thin Send | `chat` |
| `daemon` | `POST /entries/{sequence}/redact`, `POST /backup` | `admin` |
| `configuration` | `GET /configuration` | `read` |
| `configuration` | `PUT /configuration` | `admin` |
| `networks` | `GET /networks`, `GET /networks/{id}` | `read` |
| `networks` | `POST /networks/{id}/join`, `POST /networks/{id}/part` | `chat` |
| `networks` | `POST /networks`, `PUT`, `DELETE /networks/{id}`, `POST .../connect`, `POST .../disconnect` | `admin` |
| `keys`, `credentials` | List, create or set, revoke or delete | `admin` |

## Usage

```ts
import { BunRuntime } from "@effect/platform-bun";
import { DaemonApi } from "@iirc/api";
import { Effect, Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";

const program = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(DaemonApi, {
    baseUrl: "http://127.0.0.1:7667",
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.bearerToken(Redacted.make(process.env.IIRC_KEY ?? ""))
    ),
  });

  const status = yield* client.daemon.status();
  const entries = yield* client.daemon.entries({ query: { after: 0, limit: 100 } });
  yield* Effect.log(status, entries);
}).pipe(Effect.provide(FetchHttpClient.layer));

BunRuntime.runMain(program);
```

## Versions

`apiVersion`, which `/status` reports (API-5), changes whenever what a response means changes, and every Frontend in this repository moves with it.

- **2:** `/messages` names a Message's `kind` as `PRIVMSG`, `NOTICE`, or `ACTION`, and an `ACTION`'s `text` is the action itself, not the CTCP that carried it. Any other CTCP is no Message: it is Activity. Each Message has its `place` (MSG-2), and a `STATUSMSG` Target its `statusmsg`. A decoder for version 1 refuses `ACTION`.
- **1:** the first contract.

## Key ideas

- **The Schemas hold every rule.** A request they pass needs no other check by the Daemon, so a Frontend can check one before sending it (CONF-1).
- **These Schemas judge requests, not history.** They hold a request to today's rules. A recorded Change is read by `@iirc/daemon`'s own Schemas, which hold only shapes and the defaults that absent fields meant then, so tightening a rule here cannot stop the Daemon starting on an old Log (CONF-1).
- **Tuning is derived, not repeated.** `TuningSettings` is built from `Tuning` and `defaultTuning` in `@iirc/lifecycle`, with bounds that relate numbers to each other. Only what the Owner changed is stored.
- **Bytes survive JSON.** A `LogEntry` carries a Line's bytes as base64 beside its decoded `text`, and an unparseable Line's `reason` (API-4, HOST-1).
- **Keys only in headers.** `Authorization` reads `Authorization: Bearer` and nothing else (AUTH-6).

## Traps

- This package cannot depend on `@iirc/session`, so `LogEntry` is checked against `Entry` in the Daemon's adapter, `toLogEntry` in `@iirc/daemon`. `Ircd` and `TlsDetails` here are not checked for the same reason.
- RPC stays internal, for the Log's reader Worker. It has no OpenAPI output, and would make a script a lesser Frontend than an Effect client.
- `DaemonApi` carries OpenAPI annotations, but no route serves the document yet.

## Requirements

[API](../../docs/requirements.md#api), [Access](../../docs/requirements.md#access) (AUTH-1 to AUTH-3, AUTH-6), and the request rules of [Configuration](../../docs/requirements.md#configuration) and [Credentials](../../docs/requirements.md#credentials) (CRED-2).
