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
| `Status`, `NetworkStatus`, `LogEntry`, `LoggedMessage`, `Place`, `Gap` | What the Daemon reports. A Message has its place (MSG-2), its `STATUSMSG` prefix, `kind` `PRIVMSG`, `NOTICE`, or `ACTION` (MSG-1, PROT-2), and its `spans` (MSG-3) |
| `LoggedActivity`, `ActivityDetails`, `ActivityCursor` | Activity by kind, with the sequence of its Line (MSG-5, API-2), and the one opaque cursor `/activity` pages by |
| `ChannelDetails`, `MembersCursor`, `maxMembersPage` | A Channel Self is in, with a page of its members and `at`, and the cursor bound to the mapping it was folded under (KNOW-4, API-6) |
| `NetworkKnowledge` | What `GET /networks/{id}` adds as `known`: Self's `user@host`, modes, and away state, and every `RPL_ISUPPORT` token held, with `at` (KNOW-1, KNOW-2) |
| `UntrustedText`, `untrustedKey`, `openApiOptions`, `openApiDocument` | Text a Network or a participant wrote, marked in the contract (HOST-4), and the OpenAPI document that keeps the mark |
| `Span`, `Formatted` | Text with its formatting codes parsed into spans, beside the raw text (MSG-3) |
| Errors | `NotInSession`, `LaneFull`, `LineDropped`, `WriteFailed`, `LogUnavailable`, `InvalidMessage`, `InvalidRequest`, `NetworkNotFound`, `TargetNotFound`, `NotAChannel`, `CursorStale`, `CredentialsUnavailable`, `Unauthorized`, `Forbidden`, and the rest, each tagged (API-3) |
| `apiVersion` | The contract's version, which `/status` reports (API-5) |

## Endpoints

| Group | Endpoints | Scope |
| --- | --- | --- |
| `health` | `GET /health` | None |
| `daemon` | `GET /status`, `GET /entries`, `GET /messages`, `GET /gaps`, `GET /activity` | `read` |
| `daemon` | `POST /messages`, the thin Send | `chat` |
| `daemon` | `POST /entries/{sequence}/redact`, `POST /backup` | `admin` |
| `configuration` | `GET /configuration` | `read` |
| `configuration` | `PUT /configuration` | `admin` |
| `networks` | `GET /networks`, `GET /networks/{id}`, `GET /networks/{id}/targets/{target}` | `read` |
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

- **2, since then:** additions only, which a version 2 decoder ignores, so the version stays 2. `/messages` gives each Message its `spans` beside its `text` (MSG-3). `/activity` and `GET /networks/{id}/targets/{target}` are new, and `GET /networks/{id}` adds `known` (KNOW-1, KNOW-2). Fields that hold participant text are `UntrustedText`, which is a plain string on the wire, so no shape moved (HOST-4).
- **2:** `/messages` names a Message's `kind` as `PRIVMSG`, `NOTICE`, or `ACTION`, and an `ACTION`'s `text` is the action itself, not the CTCP that carried it. Any other CTCP is no Message: it is Activity. Each Message has its `place` (MSG-2), and a `STATUSMSG` Target its `statusmsg`. A decoder for version 1 refuses `ACTION`.
- **1:** the first contract.

## Key ideas

- **Participant text is marked untrusted (HOST-4).** Every field whose text a Network or anyone on it chose is `UntrustedText`: what was said, its spans, topics, reasons, CTCP and DCC arguments, standard replies, nicks, Channel names, `user@host`, realnames, modes and their parameters, `RPL_ISUPPORT` values, an Ircd's words in `/status`, a Gap's and a Dropped Entry's reason and `LineDropped`'s, which can hold the `ERROR` that ended a Connection, and the decoded text of a Line or a Dropped Entry in `/entries`. In the OpenAPI document each is a `$ref` to one component, `UntrustedText`, whose description says it is data and never instructions, so any document keeps that. Built with `openApiOptions`, as `openApiDocument()` does, the component also carries `x-iirc-untrusted: true`, which a tool can test for. What is ours is not marked: Network IDs, kinds, sequences, times, and our own words. At runtime it is `Schema.String`, so it costs nothing, and a test walks the document to check a list of known participant fields, and that every other string in Activity, a Channel, and a Message is one of ours.
- **An agent reading the API should treat every `UntrustedText` as quoted data.** Anyone on a Network can write text an agent will read, so text that reads like an instruction is still only what someone said.
- **Formatting is data (MSG-3).** A Message's `text` keeps its codes and `spans` gives the same text parsed by `parseFormatting`, each span with only the styles that are on, and colours as `Palette` indexes or `Hex` digits. Activity's participant text, a topic, a `PART`, `QUIT`, or `KICK` reason, a CTCP's or a DCC offer's arguments, and a `FAIL`, `WARN`, or `NOTE`'s description, is `Formatted`: `{ text, spans }`. Nothing is ever markup: a span's `text` is shown as text. The Log's reader parses them on its Worker, and counts each span toward its page bound, so a page of hostile formatting is still a small page.
- **Activity pages by one opaque cursor (MSG-5).** `after` is `123` or `123.4`, which `ActivityCursor` parses at the boundary, and each page gives `next`, the cursor after its last row, or the one it was asked from when it is empty. One Entry can be many rows, such as a `QUIT` in many Channels, so a page can end inside one. `place` is `network`, `channel:<name>`, or `user:<nick>`, and needs `network`. A row is in the place when the name, casefolded under the mapping in force when the row was written, is its key, so a place keeps its history across a new `CASEMAPPING`, a reconnect, and a time with no Session, and a row's own `key` finds it (KNOW-3).
- **A Channel read is a snapshot with its `at` (KNOW-4, API-6).** `ChannelDetails` has the name and key, the topic with who set it and when, the creation time, the modes, whether members or modes are uncertain (KNOW-6), and a page of members, each with prefix letters ranked by `PREFIX` and their symbols, and the `user@host` and realname the Session has seen (KNOW-7). The Channel key, `k`, is shown as set and never with its value, because it can be the Owner's own key, a Credential (CRED-4). `GET /activity` agrees: a `mode` row's `changes` have `k` with no `param`, and its `params` and a `324` or `MODE` `line` row's leave the key out, so that the two reads say the same. A `mode` that did not add up cannot say which parameter was the key, so it has its letters in `params` alone and no `changes`. Only `/entries` keeps the Line as the Network said it (API-4). A Target the current Session is not in is `TargetNotFound`, and one that `CHANTYPES` says is no Channel is `NotAChannel`, because a partner's details wait for milestone 4.
- **Members come in pages of at most 1000.** A Channel can hold 65,536 (KNOW-4), and a member with every field at its 255-character bound is about 3 KB, so one response could reach 200 MB, built and encoded on the event loop. A page of 1000 is about 120 KB for ordinary nicks and at most about 3 MB. Members are in the order of their casefolded nicks, which the `SortedMap` holds them in, so a page costs the path to where it starts and the members it holds.
- **A members cursor names its mapping.** `next` is a `MembersCursor`, one opaque value such as `rfc1459:nick`: the last member's casefolded nick and the mapping it was folded under. Under another mapping the same nick sorts elsewhere, so resuming would skip or repeat members, and a read refuses a cursor of a mapping no longer in force with `CursorStale` (409), which says to start again from the first page.
- **Each page of members is live as of its own `at`.** Pages are not one snapshot: a member who joins, leaves, or is renamed between two pages can be left out or given twice. A Frontend that needs one list asks again from the start if `at` moved. `/bootstrap` and `/stream`, in milestone 4, give the consistent view.
- **`GET /networks/{id}` says what its Session knows (KNOW-1, KNOW-2).** `known` is Self's `user`, `host`, modes, and away state, `null` before the welcome, and every `RPL_ISUPPORT` token held, by name, where a token sent with no value is `""` and one never sent or taken back is absent, with `tokensDropped` past 256. It comes from the same `Standing` snapshot as its `at`. Self's nick and the mapping in force, whether forced, and the token that fell back are in `status.self` and `status.casemapping`, and only there.
- **A path's `#` is `%23`.** A raw `#` starts the URL's fragment and never reaches the Daemon. The Target is parsed as one word and casefolded where it is looked up, so any spelling the mapping in force allows finds the Channel (KNOW-3).

- **The Schemas hold every rule.** A request they pass needs no other check by the Daemon, so a Frontend can check one before sending it (CONF-1).
- **These Schemas judge requests, not history.** They hold a request to today's rules. A recorded Change is read by `@iirc/daemon`'s own Schemas, which hold only shapes and the defaults that absent fields meant then, so tightening a rule here cannot stop the Daemon starting on an old Log (CONF-1).
- **Tuning is derived, not repeated.** `TuningSettings` is built from `Tuning` and `defaultTuning` in `@iirc/lifecycle`, with bounds that relate numbers to each other. Only what the Owner changed is stored. Each number and switch publishes its `default`. `encoding` must be a label this runtime's `TextDecoder` reads, checked with `parseFallbackEncoding`, so one it cannot use is refused at `tuning.encoding` rather than ignored later (MSG-4, API-3). `casemapping` is one of `@iirc/state`'s four (KNOW-3). `ctcpNetworkLimit` is at most 100, which is how many reply times `Standing` holds (PROT-4).
- **Status says how names compare.** `NetworkStatus.casemapping` is the mapping in force for the current Session, whether the Owner forced it, and the `CASEMAPPING` or `UTF8MAPPING` token the Ircd sent that fell back to `ascii`, or `null` with no Session (KNOW-3). It is additive, so the API's version stays 2.
- **Bytes survive JSON.** A `LogEntry` carries a Line's bytes as base64 beside its decoded `text`, and an unparseable Line's `reason` (API-4, HOST-1).
- **Keys only in headers.** `Authorization` reads `Authorization: Bearer` and nothing else (AUTH-6).

## Traps

- This package cannot depend on `@iirc/session`, so `LogEntry` is checked against `Entry` in the Daemon's adapter, `toLogEntry` in `@iirc/daemon`. `Ircd` and `TlsDetails` here are not checked for the same reason.
- RPC stays internal, for the Log's reader Worker. It has no OpenAPI output, and would make a script a lesser Frontend than an Effect client.
- `DaemonApi` carries OpenAPI annotations, but no route serves the document yet. `OpenApi.fromApi(DaemonApi)` without `openApiOptions` drops `x-iirc-untrusted`, though it keeps each field's description, so use `openApiDocument()`.
- `ActivityCursor`, `MembersCursor`, and the `place` filter decode to structures, so a typed client passes back the `next` it was given, and a script passes back its text. Neither should build one.

## Requirements

[API](../../docs/requirements.md#api), [Access](../../docs/requirements.md#access) (AUTH-1 to AUTH-3, AUTH-6), and the request rules of [Configuration](../../docs/requirements.md#configuration) and [Credentials](../../docs/requirements.md#credentials) (CRED-2).
