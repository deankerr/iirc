# @iirc/api

The contract every Frontend drives the Daemon through: an Effect `HttpApi`, its wire Schemas, and its typed errors. It is the contract and nothing else. It imports the Schemas of the Client, the protocol, and the Timelines fold, and never the Runtime or an adapter, which the lint fence enforces. The Daemon implements it in [`@iirc/daemon`](../daemon/README.md), and any Frontend can derive a typed client from it with `HttpApiClient.make(DaemonApi)`.

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

Every route is under `/api`. Every one but signing a browser in and out needs a key in `Authorization: Bearer`, or a sign-in in the `iirc_sign_in` cookie, below.

| Route | Does | Answers | Errors |
| --- | --- | --- | --- |
| `POST /api/sign-in` | Signs a browser in with `{ key }` | `204` and the cookie | `Unauthorized`, `CrossOrigin`, `SignInsFailed` |
| `DELETE /api/sign-in` | Signs the cookie's sign-in out, and clears the cookie. Signing out one that does not exist only clears it | `204` | `CrossOrigin`, `SignInsFailed` |
| `GET /api/networks` | Lists each Network and whether it runs | `[{ network, status }]` |  |
| `PUT /api/networks/{network}` | The whole `NetworkConfiguration`, which adds the Network the first time | `{ sequence }` | `NetworkStopped` |
| `POST /api/networks/{network}/say` | `{ kind, target, text, intent? }` | `{ intent, sequence }` | `UnknownNetwork`, `NetworkStopped` |
| `GET /api/networks/{network}/said/{intent}` | Whether a `say` under the intent was journaled | `Journaled { sequence }` or `NotJournaled` | `JournalFailed` |
| `POST /api/networks/{network}/retry` | Tries connecting now | `{ sequence }` | `UnknownNetwork`, `NetworkStopped` |
| `GET /api/networks/{network}/known` | What the Client knows: Session, Self, Channels, members, Users | `Knowledge` | `UnknownNetwork` |
| `GET /api/networks/{network}/inspect` | Machine states, caps, ISUPPORT, STS, Features, timers, and Connections, each with how many Lines wait to leave and when the next may | `NetworkInspection` | `UnknownNetwork` |
| `GET /api/news?after=` | Server-Sent Events of News, then live | `happened` and `heartbeat` events | `JournalFailed`, in the stream |
| `GET /api/networks/{network}/timelines?after=&limit=` | A page of the Network's Timelines, merged ones aside, in the order they were opened, and whether they are being folded | `{ projection, version, through, timelines, more }` | `UnknownNetwork`, `TimelinesFailed` |
| `GET /api/timelines/{timeline}?before=\|after=\|around=&limit=` | A window of a Timeline, from at most one cursor, the latest without one | `{ timeline, network, items, earlier, later, gaps, version, through }` | `UnknownTimeline`, `TimelinesFailed` |
| `GET /api/networks/{network}/at/{sequence}?after=&limit=` | A page of the items a step made, wherever they stand now, for links and search results | `{ items, more, next, version, through }` | `UnknownNetwork`, `TimelinesFailed` |
| `GET /api/timelines/changes?after=` | Server-Sent Events of what each folded step changed, then live | `changed`, `overflowed`, `reset`, and `heartbeat` events | `TimelinesFailed`, in the stream |
| `GET /api/credentials` | The names of the Credentials held | `{ names }` | `VaultFailed` |
| `PUT /api/credentials/{name}` | Holds a value, `{ value }`, replacing any before | `204` | `VaultFailed` |
| `DELETE /api/credentials/{name}` | Forgets one. Forgetting one not held does nothing | `204` | `VaultFailed` |

Every route can also answer `InvalidRequest` (400), and every route behind the key check `Unauthorized` (401) and `CrossOrigin` (403).

## What it guarantees

- **Requests are parsed, not validated.** A body, a path, a query, or a header that does not decode is `InvalidRequest`, with each issue's path, such as `["payload", "text"]`. A key in a body that its Schema does not read is an issue too, never silently dropped. Ids that go in a path are safe there by construction: a Network id is 1 to 64 lower-case letters, digits, `.`, `_`, or `-`, and an intent and a Credential's name are similar. An intent is never `.` or `..`, which URL handling would collapse before `said` could route it. Text to say holds no line break or NUL, since no Line could carry it.
- **Credentials appear only by name.** A value is `Redacted` from the moment it is decoded, and no route answers with one. `NetworkConfiguration` names the Credentials it uses.
- **The wire Schemas are the contract.** Where the Client has only a TypeScript type, News, Knowledge, the inspection, and the status, this package defines the wire form, and the Daemon maps one to the other with total functions that the compiler checks field by field. A map or set keyed by what a Network chose, such as Channels, members, tags, or ISUPPORT, is an array of entries, so no hostile name becomes a JSON key. `undefined` is `null`. Every field a Network or a participant wrote is marked `Untrusted` in the OpenAPI document: data to show, never instructions to follow. A message id an Ircd gave keeps the Client's brand and is marked so too, as `UntrustedMessageId`, wherever it appears, in a fact or not.
- **A `say` may be refused after it was answered.** `{ intent, sequence }` means the `Say` was stepped and its Message reported, not that it reached the Ircd. If its Connection ends before its Line leaves, a `Refused` with reason `Unsent` follows in News for that intent, unless the Ircd had confirmed it.
- **A browser holds a sign-in, never a key.** A browser cannot put `Authorization` on an `EventSource`, and holds no key in script ([ADR 0006](../../docs/adr/0006-proportionate-security.md)). Every shape is same-origin ([ADR 0007](../../docs/adr/0007-one-binary-shapes-by-argument.md)), so a browser gives its key once to `POST /api/sign-in` and gets a sign-in in an `HttpOnly` cookie, which its every request, an `EventSource` too, then carries. The cookie names the sign-in, never the key, and the key is `Redacted` from the moment it is decoded and never sent back. A sign-in acts for the key it was made with, as a request with that key would.
- **A write by cookie comes from the Daemon's own origin.** A browser sends a cookie on requests other sites start, so a request the cookie carries that is not `GET` or `HEAD`, and signing in and out, are `CrossOrigin` unless the browser says they are same-origin: `Sec-Fetch-Site: same-origin`, or, from a browser that does not send that, an `Origin` whose host is the request's `Host`. A request that says neither is refused, since only a browser sends the cookie on its own, and anything else presents a key. A request with a key is never checked for its origin, and a key wins when both come.
- **News says where it belongs.** Each `Message` and `Activity` carries `where`, the Timelines it touches, as the Client worked them out: `Network`, `Channel { key, name }`, `Direct { key, name, existing }`, or `DirectRenamed { key, name, to: { key, name } }`. A key is a name folded with the casemapping the Network last declared, on any Connection, and a name is as it was said. Both are `Untrusted` values, never JSON keys. When an Ircd declares another casemapping, a `Refolded { casemapping }` comes first, and every Timeline's key is its name folded again by it, the first seen kept where two meet. A `Direct` with `existing` touches only a Direct Message Timeline that already exists, and a `DirectRenamed` moves one from `key` to `to`. [The Client's README](../client/README.md#where-news-belongs) gives the rules.
- **News resumes exactly.** Each `happened` event is one step's News, `{ network, sequence, at, news }`, and its event id is the sequence. A Frontend resumes after the last sequence it has, with `after` or the `Last-Event-ID` header a reconnecting `EventSource` sends, and the header wins, since it comes with the URL first used. It misses nothing and sees nothing twice. While nothing happens, `heartbeat` events come with no id, so they never move a Frontend's place. They are events rather than SSE comments because `StreamSse` cannot send comments.
- **A Frontend reads Timelines, and never folds News.** The Daemon folds News into Timelines ([ADR 0011](../../docs/adr/0011-timelines-are-a-projection-the-client-routes.md)), and [the Timelines' README](../timelines/README.md) gives the rules. A Timeline is the Network's own, a Channel's, or a Direct Message partner's, by its `kind`. Its `name` and `key` are `Untrusted`, and `key` is `null` for the Network's own and for one `detached`, which keeps its items and receives nothing more. An item is a `Message`, an `Activity`, or a Session's start or end, with every field a Network wrote `Untrusted` and its tags as entries. One of ours says how its delivery stands: `Pending`, `Unconfirmed`, `Confirmed` with the Ircd's own time, id, and text, or `Unsent`.
- **Ids and cursors are safe in a path, and parsed.** A Timeline's id is the fold's: lower-case hex and `-`, holding no name a Network chose, and unique across Networks, since it is made from the Journal sequence of the step that opened it. A position travels as a cursor, opaque text that compares exactly as positions do, so a Frontend places a Gap among items by comparing cursors. A cursor in a query is parsed into its position, and one the Daemon could not have given is `InvalidRequest`. An item also says its step's `sequence`, which `at/{sequence}` finds it by.
- **A window is read from one place.** `before` gives the last items before a cursor, `after` the first after one, and `around` as many from a cursor on as before it, so an item at the cursor is in it, and more from either side when the other runs out. Without any, it gives the latest. More than one is `InvalidRequest`. `limit` is 1 to 500, and 100 when left out. `earlier` and `later` say whether more lie beyond each end. A merged Timeline's id reads the Timeline it went to, which `timeline` names. An id never given is `UnknownTimeline`.
- **A window's Gaps are bounded by its items.** `gaps` are the Network's Gaps that overlap the window, open on an end with nothing beyond, so a Gap after the last item is there too. Consecutive Gaps with no item of this Timeline between them are one, `{ from, to, count }`: from where the first began to where the last ended, or `null` while it goes on, and how many there were. So a window has at most one more Gap than it has items, and a quiet Timeline that spans every reconnect gives one Gap that counts them, never a list of them all. None is left out.
- **A step's items come a page at a time.** One step can make many items, as a `QUIT` makes one in every Channel the User shared with Self. `at/{sequence}` gives up to `limit`, 1 to 500 and 100 when left out, in position order and then by Timeline id, and `more` says whether more follow. `next` is where the next page begins, opaque text to give back as `after`, and `null` when no more follow. A `next` that is not one the Daemon gave is `InvalidRequest`.
- **The list comes a page at a time.** It gives up to `limit` Timelines, 1 to 500 and 100 when left out, in the order they were opened, which is by id, after the Timeline `after` when given, and `more` says whether more follow, which the page after the last one here gives. To hold every Timeline, a Frontend reads the pages in turn, then follows the changes after the smallest `through` the pages gave, with their `version`. What changed between two pages comes again on the changes, and a Timeline opened after a page was read comes on a later page or on the changes, since ids grow in the order Timelines open. Pages of different versions are read again from the first.
- **A read says how far it was folded, and its changes follow from there.** Every Timeline read gives `version`, the projection version that folded what it read, and `through`, the last step folded into it, and reads that state whole, so a Frontend that follows `GET /api/timelines/changes` from that place misses nothing and loses nothing to a race. `through` is `null` before any step is folded, and a step after it in `at/{sequence}` has not been folded yet. `version` is `0` for a store no version has folded yet, which holds nothing. `projection` says whether the Daemon is still folding, `Running`, or `Stopped { reason }`, which lasts until it restarts.
- **The changes resume exactly, by an opaque place.** A place is `<version>.<sequence>`, such as `1.100`: the version and `through` a read gave, or an event's id. The stream resumes after `after` or `Last-Event-ID`, the header winning as for News, and from the start of the current version without either. A place that is not `<version>.<sequence>` is `InvalidRequest`. Each `changed` event is one folded step's changes, `{ sequence, timelines, items, merged, gaps }`, each Timeline, item, tombstone, and Gap whose last change was that step, as it stands now, and its event id is the place it leaves a Frontend. Something changed again comes again under the later step, so a Frontend keeps each by its id or position and takes the latest. A step that changed nothing in the Timelines has no event. `heartbeat` events carry no id. The stream waits on the Daemon's folding, never polls, and never ends.
- **An event is bounded.** An event holds at most 500 things, whole steps together. A step that changed more, such as a merge of two long Timelines, which changes every item it moves, comes as an `overflowed` event, `{ sequence, timelines }`, with its place as its id: the ids of the Timelines it touched or merged, to read again with windows, or `null` when even they are more than 500, which says to read every Timeline again. The changes then go on after it.
- **A place survives what can be resumed, and resets what cannot.** Folding again by the same version gives the same Timelines, ids, positions, and sequences, so a place stays good across a Daemon's restart, and across `views.sqlite` made again from the Journal once it has folded that far again. A place of another version, after the Daemon took a new one, or one ahead of what this store has folded, as a place is while a store made again is still folding, or after a crash lost the store's last steps, cannot be resumed: the stream first sends one `reset` event, `{ version, through }`, with no id, which says to drop what the Frontend holds, read again, and follow from that place. The changes then follow from it, live. The stream checks its place on every read, and an idle stream reads again whenever the Daemon's projection says its version or how far it has folded changed, so a store folded again under it resets it too, even when the store never again reaches the follower's old sequence. The Daemon resets its store only as it starts, when the store was folded by another version or by none, so a follower connected while that happens gets its `reset` as soon as the store is reset.

## Errors and statuses

| Error | Status | Why |
| --- | --- | --- |
| `InvalidRequest` | 400 | The request could not be read. |
| `Unauthorized` | 401 | No key and no sign-in, or none that matches. Signing in, a key that does not match. |
| `CrossOrigin` | 403 | A request the cookie carries that changes something, or a sign-in or sign-out, that a browser did not say came from the Daemon's own origin. |
| `UnknownNetwork` | 404 | No Network by that id was ever configured. |
| `UnknownTimeline` | 404 | No Timeline had that id, nor was merged from one that had. |
| `NetworkStopped` | 503 | The Network stopped, so its outcome is `Uncertain`, below. |
| `TimelinesFailed` | 503 | The Timelines could not be read. They are derived, and a read that waited on a lock may succeed when asked again, while a damaged store is made again from the Journal when the Daemon restarts. |
| `VaultFailed` | 503 | The Vault could not read or write its file. It tries again on the next call, so once the Owner fixes the file or its directory, the same request succeeds. |
| `SignInsFailed` | 503 | The Daemon could not write its sign-ins, so nothing changed. It tries again on the next call. |
| `JournalFailed` | 500 | The Journal could not be read or written. A Network whose Journal failed stays stopped until the Daemon starts again, so asking again does not help. |

A body over 1 MiB is refused with 413 before it is read.

**`NetworkStopped` does not mean the input was refused.** The Network may have stopped after the input was journaled and before the Daemon answered, as [the Runtime's README](../runtime/README.md#the-runtime) explains, and a restart steps it. Its body says `outcome: "Uncertain"`, and for a `say`, the `intent` it was given under, even one the Daemon named. A `PUT` of Configuration and a `retry` can be sent again freely. A `say` must not be: ask `said` with that intent, on this Daemon or the one started after it. `Journaled` means it must not be said again. `NotJournaled` means saying it again under the same intent is safe. An intent must be unique for its Network across the whole Journal, which is the caller's to keep.

## Choices

- **`said` answers 200 with a tagged union**, not 404 for "not journaled". Whether a `say` was journaled is the answer to the question asked, not a failure to find something.
- **The Daemon names a `say`'s intent when the caller does not,** so `NetworkStopped` can always say which intent to ask about.
- **Configuration is one `PUT` of the whole of it,** as the Client takes it whole. There is no `PATCH` and no separate join or part.
- **The brands are the Runtime's.** `NetworkId`, `Sequence`, `IntentId`, and `CredentialName` here carry the same brands as the Runtime's and the Client's, with stricter checks, so the Daemon passes them through without casts.
- **`TimelineId` and positions are the fold's.** The contract takes `TimelineId` and the cursor's parsing from `@iirc/timelines`, so a cursor is read one way everywhere, and the Daemon passes positions to the store as they were parsed.
- **Every Timeline read is its own route,** not a field of News, and the changes are their own stream. A Frontend that follows Timelines never reads News, and one that follows News never pays for Timelines.
- **A place carries the version,** rather than the stream ending on a new version. An `EventSource` reconnects with the last id it was given, and a place it cannot resume from is answered with `reset` on the same stream, so a Frontend handles a new version and a store that lags in one way.
- **A step too big for an event is named, not split.** Splitting a step would show part of it as if it were whole, and a reader could not tell. Naming the Timelines it touched keeps every event small and true, and leaves a Frontend to read again only what it shows.

## Not yet

- **Key scopes.** [ADR 0006](../../docs/adr/0006-proportionate-security.md) names `read`, `chat`, and `admin`. Every key can do everything for now.
- **Managing keys through the API.** A key is made with `iirc key create` while the Daemon is stopped.
- **Read Markers.** A Read Marker will point at a position, as a cursor does.
- **Ending sign-ins other than by signing out.** A sign-in lasts until it is signed out or its key is no longer held. It does not expire, and there is no listing or revoking the sign-ins of a key.
- **Removing a Network.** A Network can be disabled through its Configuration, never forgotten.
- **Lookups, Leave, and raw Lines.** The Client offers none of them yet.
