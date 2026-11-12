# @iirc/api

The contract every Frontend drives the Daemon through: an Effect `HttpApi`, its wire Schemas, and its typed errors. It is the contract and nothing else. Any Frontend can derive a typed client from it with `HttpApiClient.make(DaemonApi)`.

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
| `PUT /api/networks/{network}?ifSequence=` | The whole `NetworkConfiguration`, which adds the Network the first time. With `ifSequence`, only if it was made from the Configuration in force | `{ sequence }` | `NetworkStopped`, `ConfigurationChanged` |
| `GET /api/networks/{network}/configuration` | The Configuration in force, and the sequence of the `Configured` that set it | `{ configuration, sequence }` | `UnknownNetwork` |
| `POST /api/networks/{network}/say` | `{ kind, target, text, intent? }` | `Said { intent, sequence }` or `Refused { intent, sequence, reason }` | `UnknownNetwork`, `NetworkStopped` |
| `POST /api/networks/{network}/act` | `{ action, intent? }`: one of `Topic`, `Kick`, `Mode`, `Invite`, `Nick`, `Away`, and `Raw`, below | `Acted { intent, sequence }` or `Refused { intent, sequence, reason }` | `UnknownNetwork`, `NetworkStopped` |
| `GET /api/networks/{network}/said/{intent}` | Whether a `say` or an `act` under the intent was journaled | `Journaled { sequence }` or `NotJournaled` | `JournalFailed` |
| `POST /api/networks/{network}/lookups` | Looks something up, `{ lookup, intent? }`: `Whois { nick }` or `Whowas { nick }`, and waits for the result | `LookedUp { intent, sequence, result }` or `Pending { intent, sequence }` | `UnknownNetwork`, `NetworkStopped` |
| `GET /api/networks/{network}/lookups/{intent}` | A Lookup by its intent, from the Journal | `LookedUp { intent, sequence, result }`, `Pending { intent, sequence }`, or `NotJournaled` | `JournalFailed` |
| `POST /api/networks/{network}/read` | Marks a Timeline read up to `{ read, target }`: an instant, and a Target, or `null` for the Network's own | `{ sequence }` | `UnknownNetwork`, `NetworkStopped` |
| `POST /api/networks/{network}/retry` | Tries connecting now | `{ sequence }` | `UnknownNetwork`, `NetworkStopped` |
| `GET /api/networks/{network}/known` | What the Client knows: Session, Self, Channels, members, Users, the Connection's casemapping, the one an Ircd last declared (`declared`, `null` until one has), and `CHANTYPES` while a Session has said it (`chantypes`, `null` otherwise) | `Knowledge` | `UnknownNetwork` |
| `GET /api/networks/{network}/inspect` | Machine states, caps, ISUPPORT, STS, Features, timers, and Connections, each with how many Lines wait to leave and when the next may | `NetworkInspection` | `UnknownNetwork` |
| `GET /api/news?after=` | Server-Sent Events of News, then live | `happened` and `heartbeat` events | `JournalFailed`, in the stream |
| `GET /api/networks/{network}/timelines?after=&limit=` | A page of the Network's Timelines, merged ones aside, in the order they were opened, and whether they are being folded | `{ projection, version, through, timelines, more }` | `UnknownNetwork`, `TimelinesFailed` |
| `GET /api/timelines/{timeline}?before=\|after=\|around=&limit=` | A window of a Timeline, from at most one cursor, the latest without one | `{ timeline, network, items, earlier, later, gaps, version, through }` | `UnknownTimeline`, `TimelinesFailed` |
| `GET /api/timelines/{timeline}/channel` | A Channel's head, as the Client knows it now: its name, topic, and modes, where Self stands with it, how many members it has, `PREFIX`, `CHANMODES`, and `CHANTYPES` | `{ timeline, network, name, topic, modes, standing, members, ranks, chanmodes, chantypes }` | `UnknownTimeline`, `NotAChannel`, `TimelinesFailed` |
| `GET /api/timelines/{timeline}/members?after=&limit=&prefix=` | A page of a Channel's members, the most privileged first, then by nick, and with `prefix`, only those whose nick starts with it | `{ timeline, network, members, more, next }` | `UnknownTimeline`, `NotAChannel`, `NotInChannel`, `TimelinesFailed` |
| `GET /api/networks/{network}/at/{sequence}?after=&limit=` | A page of the items a step made, wherever they stand now, for links and search results | `{ items, more, next, version, through }` | `UnknownNetwork`, `TimelinesFailed` |
| `GET /api/search?text=&network=&timeline=&from=&since=&until=&after=&limit=` | A page of the Messages whose text holds `text`, newest first, kept to a Network, a Timeline, a sender, and a range of time when given | `{ items, more, next, version, through }` | `UnknownNetwork`, `UnknownTimeline`, `TimelinesFailed` |
| `GET /api/timelines/changes?after=` | Server-Sent Events of what each folded step changed, then live | `changed`, `overflowed`, `reset`, and `heartbeat` events | `TimelinesFailed`, in the stream |
| `GET /api/ui` | The options under `ui` in force, every one with a value, and the sequence of the last Change, `0` before any | `{ options, sequence }` |  |
| `PUT /api/ui/{option}?ifSequence=` | Sets one option under `ui` to `{ value }`, for every device. With `ifSequence`, only if it was made from the options in force | `{ sequence }` | `UiChanged`, `JournalFailed` |
| `DELETE /api/ui/{option}?ifSequence=` | Unsets one, back to its default, likewise | `{ sequence }` | `UiChanged`, `JournalFailed` |
| `GET /api/ui/changes?after=` | Server-Sent Events of the options under `ui`, whole, each time they change, then live | `changed` and `heartbeat` events |  |
| `GET /api/credentials` | The names of the Credentials held | `{ names }` | `VaultFailed` |
| `PUT /api/credentials/{name}` | Holds a value, `{ value }`, replacing any before | `204` | `VaultFailed` |
| `DELETE /api/credentials/{name}` | Forgets one. Forgetting one not held does nothing | `204` | `VaultFailed` |

Every route can also answer `InvalidRequest` (400), and every route behind the key check `Unauthorized` (401) and `CrossOrigin` (403).

## What it guarantees

### Every route

- **Requests are parsed.** A body, a path, a query, or a header that does not decode is `InvalidRequest`, with each issue's path, such as `["payload", "text"]`. A key in a body that its Schema does not read is an issue too, never silently dropped.
- **Ids are safe in a path by construction.** A Network id, an intent, a Credential's name, a Timeline's id, and a cursor hold no character a URL would change, and no name a Network chose.
- **Credentials appear only by name.** A value is `Redacted` from the moment it is decoded, and no route answers with one.
- **The wire Schemas are the contract.** Where the Client has only a TypeScript type, this package defines the wire form, and the Daemon maps one to the other with total functions the compiler checks. A map keyed by what a Network chose is an array of entries, so no hostile name becomes a JSON key.
- **Every field a Network or a participant wrote is marked `Untrusted`** in the OpenAPI document: data to show, never instructions to follow.

### Signing in

- **A browser holds a sign-in, never a key**. It gives its key once to `POST /api/sign-in` and gets an `HttpOnly` cookie that names the sign-in. A sign-in acts for the key it was made with.
- **A write by cookie comes from the Daemon's own origin.** A request the cookie carries that is not `GET` or `HEAD` is `CrossOrigin` unless the browser says it is same-origin, by `Sec-Fetch-Site` or by an `Origin` that matches `Host`. A request with a key is never checked for its origin.

### Changing

- **A change names what it was made from.** A `PUT` of Configuration, or of an option under `ui`, with `ifSequence` is refused when another change was journaled since, and nothing is journaled: read again and send it again. The check and the append are one step, so two changes made from the same state never both pass. Without `ifSequence`, the last wins.
- **Configuration is an option tree, and the Schema says what each option is**. A Frontend walks `NetworkConfiguration` to offer every field as an option, so a new field needs no work in any Frontend.
- **The options under `ui` are the Owner's, shared by every device**. `UiOptions`, in `@iirc/api/ui`, describes each with its default: `theme`, `themes`, `colours`, `font`, `size`, `time`, and `activity`. A value is parsed by its option's Schema before it is journaled. At most 32 themes are held, and an import may not take `system`, a built-in theme's name, or a word `/theme` reads.
- **The options under `ui` are streamed whole.** Each `changed` event is every option in force, so a Frontend that follows needs no read first, and one that reconnects misses nothing.

### Saying, acting, and looking up

- **A `say` or an `act` answers with what its step knew.** `Said` or `Acted` means it was sent, not that it reached the Ircd. `Refused` means the Client refused it in that step, as `Offline` or `Unsendable`. Either way it was journaled, at `sequence`, under `intent`.
- **What happens after comes through the Timelines.** A Message's item says how its delivery stands, and an action the Ircd refuses later becomes an `ActionRefused` item, so a Frontend learns every outcome without reading News.
- **The wire refuses little, and the Client checks the rest.** The wire refuses a line break or NUL, and an empty name. The Client checks an action against the Network, and never cuts a Line short.
- **A Lookup answers with what it found,** waiting up to 35 s. `Pending` means no result came in that time: ask again by its intent. A Lookup changes nothing on the Network, so one whose outcome is uncertain can be asked again freely.
- **A Read Marker only moves forward, and every Frontend shares it**. Marking read is a Frontend's decision, and the Daemon only records it.

### News

- **News resumes exactly.** Each `happened` event is one step's News, and its event id is the sequence. A Frontend resumes with `after` or `Last-Event-ID`, misses nothing, and sees nothing twice. `heartbeat` events carry no id, so they never move its place.
- **News says where it belongs.** Each Message and Activity carries `where`, and says whether it is a `highlight` and whether Self said it. A Frontend reads these and never works them out.

### Timelines

A Frontend reads Timelines and never folds News. The Daemon folds them.

- **A read says how far it was folded, and the changes follow from there.** Every Timeline read gives `version` and `through`, and reads that state whole. A Frontend that follows `GET /api/timelines/changes` from that place misses nothing and loses nothing to a race.
- **To hold every Timeline,** a Frontend reads the pages of the list in turn, then follows the changes after the smallest `through` the pages gave.
- **A window is read from one place:** `before`, `after`, or `around` a cursor, or the latest with none. `earlier` and `later` say whether more lie beyond each end. A merged Timeline's id reads the Timeline it went to.
- **A position travels as a cursor,** opaque text that compares exactly as positions do, so a Frontend places a Gap among items by comparing cursors.
- **A window's Gaps are bounded by its items.** Consecutive Gaps with no item between them come as one, counted, so a quiet Timeline that spans every reconnect gives one Gap, never a list of them all. Pages read at a cursor split a run at the cursor, so pages fitted together give every Gap once.
- **The Daemon counts what is unread.** Each Timeline carries `read`, its Read Marker, and `unread`, a count for each level of what stands after it, exact up to `unreadCap`, 999. Each item says its `level`. A Frontend shows the counts and never counts the items it holds, which are never all of them.
- **One of our Messages says how its delivery stands:** `Pending`, `Unconfirmed`, `Confirmed`, `Unsent`, or `Rejected` with the Ircd's numeric or code, never its text.
- **Every list comes a page at a time,** up to `limit`, 1 to 500 and 100 when left out, with `more` and an opaque `next` to give back as `after`. A `next` the Daemon did not give is `InvalidRequest`.

### The changes stream

- **It resumes exactly, by an opaque place,** `<version>.<sequence>`: what a read gave, or an event's id. Each `changed` event is what one folded step changed, as it stands now. Something changed again comes again, so a Frontend keeps each thing by its id or position and takes the latest.
- **An event is bounded,** at 500 things. A step that changed more comes as `overflowed`, naming the Timelines to read again, or none, which says to read every one.
- **A place that cannot be resumed is reset.** A place stays good across a restart. One of another projection version, or ahead of what the store has folded, gets one `reset` event, which says to drop what is held, read again, and follow from its place.
- **It waits on the Daemon's folding, never polls, and never ends.**

### Channels and search

- **A Channel is read as the Client knows it now,** by its Timeline's id, never its name. These reads are of the Client, not the folded Timelines, so they carry no `version`: follow the changes to learn when to read again.
- **A Channel's head always answers,** with `standing`, where Self stands with it, and the Network's `PREFIX`, `CHANMODES`, and `CHANTYPES`, so a Frontend parses a mode change as the Client will check it.
- **Members come in rank order, then by nick,** compared by code unit, never by a locale. `prefix` keeps the nicks that start with it under the Connection's casemapping, for completing a nick. A member who changed rank between pages may be given again or missed, so read from the start to be sure of every one.
- **A search finds Messages by what they say, newest first.** `text` is one run of 3 to 510 code points, found anywhere in a Message, whatever its case, by Unicode 17.0's simple lower-casing and never a locale's. A shorter one has no index to serve it, so it is refused.
- **The Daemon reads no syntax from a query.** `text` is text and nothing else, whatever it holds. Terms such as `from:nick` are a Frontend's to parse into the filters.
- **A search is restarted after a merge.** Pages repeat no Message unless a merge moved items between them, which the changes report.

## Errors and statuses

| Error | Status | Why |
| --- | --- | --- |
| `InvalidRequest` | 400 | The request could not be read. |
| `Unauthorized` | 401 | No key and no sign-in, or none that matches. Signing in, a key that does not match. |
| `CrossOrigin` | 403 | A request the cookie carries that changes something, or a sign-in or sign-out, that a browser did not say came from the Daemon's own origin. |
| `UnknownNetwork` | 404 | No Network by that id was ever configured. |
| `UnknownTimeline` | 404 | No Timeline had that id, nor was merged from one that had. |
| `NotAChannel` | 404 | The Timeline is the Network's own or a Direct Message partner's, which it names as `kind`, so it has no Channel. A Timeline's kind never changes. |
| `NotInChannel` | 409 | Self is not in the Channel now, so it has no members to list. It says where Self stands with it, or `null` when the Client holds no such Channel. |
| `ConfigurationChanged` | 409 | A `PUT` of Configuration was made from another than the one now in force, which it names. Nothing was journaled. |
| `UiChanged` | 409 | A change of an option under `ui` was made from other options than those in force: another Change was journaled since, at `sequence`, the last. Nothing was journaled. |
| `NetworkStopped` | 503 | The Network stopped, so its outcome is `Uncertain`, below. |
| `TimelinesFailed` | 503 | The Timelines could not be read. They are derived, and a read that waited on a lock may succeed when asked again, while a damaged store is made again from the Journal when the Daemon restarts. |
| `VaultFailed` | 503 | The Vault could not read or write its file. It tries again on the next call, so once the Owner fixes the file or its directory, the same request succeeds. |
| `SignInsFailed` | 503 | The Daemon could not write its sign-ins, so nothing changed. It tries again on the next call. |
| `JournalFailed` | 500 | The Journal could not be read or written. A Network whose Journal failed stays stopped until the Daemon starts again, so asking again does not help. A change under `ui` that could not be journaled changed nothing, and stops nothing. |

A body over 1 MiB is refused with 413 before it is read.

**`NetworkStopped` does not mean the input was refused.** The Network may have stopped after the input was journaled and before the Daemon answered, and a restart steps it. Its body says `outcome: "Uncertain"`, and for a `say`, the `intent` it was given under, even one the Daemon named. A `PUT` of Configuration, a `read`, and a `retry` can be sent again freely. A `say` or an `act` must not be: ask `said` with that intent, on this Daemon or the one started after it. `Journaled` means it must not be said again. `NotJournaled` means saying it again under the same intent is safe. An intent must be unique for its Network across the whole Journal, which is the caller's to keep.

## Choices

- **`said` answers 200 with a tagged union**, not 404 for "not journaled". Whether a `say` was journaled is the answer to the question asked, not a failure to find something.
- **A Channel's head answers whether or not Self is in it, and its members do not.** Where Self stands is part of what a head shows, as `said` answers whether a `say` was journaled, so the head carries `standing` rather than failing. A member list of a Channel Self is not in does not exist, and a Frontend paging one should stop, so it is `NotInChannel`. A Timeline that is not a Channel's is `NotAChannel`, a 404, since no Channel lies behind it, then or ever.
- **A page of members sorts the one Channel on each request.** The Client keeps members by folded nick, not in rank order, so each page reads that Channel's members, ranks them, and sorts those after `after`. For 10,000 members that is about 1 to 4 ms, and a page through the API about 10 ms, which is cheaper than keeping an order up to date on every `JOIN`, `PART`, `NICK`, and `MODE`.
- **The Daemon names a `say`'s or an `act`'s intent when the caller does not,** so `NetworkStopped` can always say which intent to ask about.
- **A Lookup answers with its result, within a bound.** A Frontend asking `WHOIS` wants the answer, not a sequence to follow News for, so `POST` waits for it, and `Pending` past the bound keeps a request from hanging on an Ircd that never ends its reply. `GET` by intent answers 200 with a tagged union, as `said` does, since whether a Lookup was journaled is the answer to the question asked.
- **The Owner's actions are one route with a tagged action,** not a route each. Each is journaled, stepped, answered, and recovered alike, so one route says that once, and a new action is a new tag.
- **Configuration is one `PUT` of the whole of it,** as the Client takes it whole. There is no `PATCH` and no separate join or part.
- **An option under `ui` is a route of its own,** `PUT` to set it and `DELETE` to unset it, since a Change is the whole value of one option. Its value travels as JSON and is parsed by the option's Schema in the Daemon, so the contract need not list a body for each option, and a new option needs no new route.
- **The options under `ui` are their own stream, sent whole,** not News, which is each Network's, nor the Timelines' changes, whose places are the projection's. A Frontend that follows them needs no read, and one that reconnects misses nothing, at the cost of the options on each change: a few dozen bytes, and some 20 KB with 32 themes imported.
- **The brands are the Runtime's.** `NetworkId`, `Sequence`, `IntentId`, and `CredentialName` here carry the same brands as the Runtime's and the Client's, with stricter checks, so the Daemon passes them through without casts.
- **`TimelineId` and positions are the fold's.** The contract takes `TimelineId` and the cursor's parsing from `@iirc/timelines`, so a cursor is read one way everywhere, and the Daemon passes positions to the store as they were parsed.
- **Every Timeline read is its own route,** not a field of News, and the changes are their own stream. A Frontend that follows Timelines never reads News, and one that follows News never pays for Timelines.
- **A place carries the version,** rather than the stream ending on a new version. An `EventSource` reconnects with the last id it was given, and a place it cannot resume from is answered with `reset` on the same stream, so a Frontend handles a new version and a store that lags in one way.
- **A step too big for an event is named, not split.** Splitting a step would show part of it as if it were whole, and a reader could not tell. Naming the Timelines it touched keeps every event small and true, and leaves a Frontend to read again only what it shows.

## Not yet

- **Key scopes,** such as `read`, `chat`, and `admin`. Every key can do everything for now.
- **Managing keys through the API.** A key is made with `iirc key create` while the Daemon is stopped.
- **Ending sign-ins other than by signing out.** A sign-in lasts until it is signed out or its key is no longer held. It does not expire, and there is no listing or revoking the sign-ins of a key.
- **Removing a Network.** A Network can be disabled through its Configuration, never forgotten.
- **A search of several terms.** `text` is one run of characters, as a phrase. Terms that must all appear belong in a Frontend's query syntax, and then here.
- **Other Lookups, and Leave.** `WHOIS` and `WHOWAS` are the Lookups the Client offers. Others, such as `LIST`, are new tags of `lookup` once the Client collects them, and until then their replies can be asked for as a raw Line, and read only as their Lines arrive.
