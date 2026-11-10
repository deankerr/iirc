# @iirc/api

The contract every Frontend drives the Daemon through: an Effect `HttpApi`, its wire Schemas, and its typed errors. It is the contract and nothing else. It imports the Client's and the protocol's Schemas, and never the Runtime or an adapter, which the lint fence enforces. The Daemon implements it in [`@iirc/daemon`](../daemon/README.md), and any Frontend can derive a typed client from it with `HttpApiClient.make(DaemonApi)`.

```ts
import { DaemonApi } from "@iirc/api";

const api = yield * HttpApiClient.make(DaemonApi, { baseUrl: "http://127.0.0.1:7667" });
yield *
  api.networks.say({
    params: { network },
    payload: { kind: "Privmsg", target: "#iirc", text: "hi" },
  });
```

## Routes

Every route is under `/api`, and every one needs a key in `Authorization: Bearer`.

| Route | Does | Answers | Errors |
| --- | --- | --- | --- |
| `GET /api/networks` | Lists each Network and whether it runs | `[{ network, status }]` |  |
| `PUT /api/networks/{network}` | The whole `NetworkConfiguration`, which adds the Network the first time | `{ sequence }` | `NetworkStopped` |
| `POST /api/networks/{network}/say` | `{ kind, target, text, intent? }` | `{ intent, sequence }` | `UnknownNetwork`, `NetworkStopped` |
| `GET /api/networks/{network}/said/{intent}` | Whether a `say` under the intent was journaled | `Journaled { sequence }` or `NotJournaled` | `JournalFailed` |
| `POST /api/networks/{network}/retry` | Tries connecting now | `{ sequence }` | `UnknownNetwork`, `NetworkStopped` |
| `GET /api/networks/{network}/known` | What the Client knows: Session, Self, Channels, members, Users | `Knowledge` | `UnknownNetwork` |
| `GET /api/networks/{network}/inspect` | Machine states, caps, ISUPPORT, STS, Features, timers, and Connections, each with how many Lines wait to leave and when the next may | `NetworkInspection` | `UnknownNetwork` |
| `GET /api/news?after=` | Server-Sent Events of News, then live | `happened` and `heartbeat` events | `JournalFailed`, in the stream |
| `GET /api/credentials` | The names of the Credentials held | `{ names }` | `VaultFailed` |
| `PUT /api/credentials/{name}` | Holds a value, `{ value }`, replacing any before | `204` | `VaultFailed` |
| `DELETE /api/credentials/{name}` | Forgets one. Forgetting one not held does nothing | `204` | `VaultFailed` |

Every route can also answer `Unauthorized` (401) and `InvalidRequest` (400).

## What it guarantees

- **Requests are parsed, not validated.** A body, a path, a query, or a header that does not decode is `InvalidRequest`, with each issue's path, such as `["payload", "text"]`. A key in a body that its Schema does not read is an issue too, never silently dropped. Ids that go in a path are safe there by construction: a Network id is 1 to 64 lower-case letters, digits, `.`, `_`, or `-`, and an intent and a Credential's name are similar. An intent is never `.` or `..`, which URL handling would collapse before `said` could route it. Text to say holds no line break or NUL, since no Line could carry it.
- **Credentials appear only by name.** A value is `Redacted` from the moment it is decoded, and no route answers with one. `NetworkConfiguration` names the Credentials it uses.
- **The wire Schemas are the contract.** Where the Client has only a TypeScript type, News, Knowledge, the inspection, and the status, this package defines the wire form, and the Daemon maps one to the other with total functions that the compiler checks field by field. A map or set keyed by what a Network chose, such as Channels, members, tags, or ISUPPORT, is an array of entries, so no hostile name becomes a JSON key. `undefined` is `null`. Every field a Network or a participant wrote is marked `Untrusted` in the OpenAPI document: data to show, never instructions to follow.
- **A `say` may be refused after it was answered.** `{ intent, sequence }` means the `Say` was stepped and its Message reported, not that it reached the Ircd. If its Connection ends before its Line leaves, a `Refused` with reason `Unsent` follows in News for that intent, unless the Ircd had confirmed it.
- **News resumes exactly.** Each `happened` event is one step's News, `{ network, sequence, at, news }`, and its event id is the sequence. A Frontend resumes after the last sequence it has, with `after` or the `Last-Event-ID` header a reconnecting `EventSource` sends, and the header wins, since it comes with the URL first used. It misses nothing and sees nothing twice. While nothing happens, `heartbeat` events come with no id, so they never move a Frontend's place. They are events rather than SSE comments because `StreamSse` cannot send comments.

## Errors and statuses

| Error | Status | Why |
| --- | --- | --- |
| `InvalidRequest` | 400 | The request could not be read. |
| `Unauthorized` | 401 | No key, or none that matches. |
| `UnknownNetwork` | 404 | No Network by that id was ever configured. |
| `NetworkStopped` | 503 | The Network stopped, so its outcome is `Uncertain`, below. |
| `VaultFailed` | 503 | The Vault could not read or write its file. It tries again on the next call, so once the Owner fixes the file or its directory, the same request succeeds. |
| `JournalFailed` | 500 | The Journal could not be read or written. A Network whose Journal failed stays stopped until the Daemon starts again, so asking again does not help. |

A body over 1 MiB is refused with 413 before it is read.

**`NetworkStopped` does not mean the input was refused.** The Network may have stopped after the input was journaled and before the Daemon answered, as [the Runtime's README](../runtime/README.md#the-runtime) explains, and a restart steps it. Its body says `outcome: "Uncertain"`, and for a `say`, the `intent` it was given under, even one the Daemon named. A `PUT` of Configuration and a `retry` can be sent again freely. A `say` must not be: ask `said` with that intent, on this Daemon or the one started after it. `Journaled` means it must not be said again. `NotJournaled` means saying it again under the same intent is safe. An intent must be unique for its Network across the whole Journal, which is the caller's to keep.

## Choices

- **`said` answers 200 with a tagged union**, not 404 for "not journaled". Whether a `say` was journaled is the answer to the question asked, not a failure to find something.
- **The Daemon names a `say`'s intent when the caller does not,** so `NetworkStopped` can always say which intent to ask about.
- **Configuration is one `PUT` of the whole of it,** as the Client takes it whole. There is no `PATCH` and no separate join or part.
- **The brands are the Runtime's.** `NetworkId`, `Sequence`, `IntentId`, and `CredentialName` here carry the same brands as the Runtime's and the Client's, with stricter checks, so the Daemon passes them through without casts.

## Not yet

- **Key scopes.** [ADR 0006](../../docs/adr/0006-proportionate-security.md) names `read`, `chat`, and `admin`. Every key can do everything for now.
- **Managing keys through the API.** A key is made with `iirc key create` while the Daemon is stopped.
- **Timelines, history, and Read Markers.** Views come later. The News stream is the only history a Frontend can read, and it replays from the start.
- **A browser's key as a cookie** (ADR 0007), so an `EventSource`, which cannot set `Authorization`, can follow News.
- **Removing a Network.** A Network can be disabled through its Configuration, never forgotten.
- **Lookups, Leave, and raw Lines.** The Client offers none of them yet.
