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

Every route is under `/api`. Every one but signing a browser in and out, and asking whether the Daemon is well, needs a Key in `Authorization: Bearer`, or a Sign-in in the `iirc_sign_in` cookie.

| Route | Does | Answers | Errors |
| --- | --- | --- | --- |
| `GET /api/health` | Whether the Daemon is well, with no Key or Sign-in, for a health check on its machine. It is unwell while the projector is stopped, and names that part, never why | `200` and `Well` | `Unwell { part }`, `503`, where `part` is `projector` |
| `POST /api/sign-in` | Signs a browser in with `{ key }` | `204` and the cookie | `Unauthorized`, `CrossOrigin`, `SignInsFailed` |
| `DELETE /api/sign-in` | Signs the cookie's Sign-in out, and clears the cookie. Signing out one that does not exist only clears it | `204` | `CrossOrigin`, `SignInsFailed` |
| `GET /api/networks` | Lists every Network the Daemon holds, read together, each with its life: `Live`, with whether it runs, or `Kept`, removed with its Timelines kept | `[Live { network, life, status } \| Kept { network, life }]` |  |
| `PUT /api/networks/{network}?ifSequence=` | The whole `NetworkConfiguration`, which adds the Network the first time. With `ifSequence`, only if it was made from the Configuration in force | `{ sequence }` | `NetworkStopped`, `ConfigurationChanged`, `TimelinesKept` |
| `DELETE /api/networks/{network}?keep=true\|false&life=` | Removes the Network: its Session ends with a `QUIT`, and its Configuration and Credentials go. `keep` is whether its Timelines stay readable, and `life` the life of it the removal was made from | `{ sequence, life }`, the life it ended | `UnknownNetwork`, `LifeChanged`, `NetworkStopped`, `JournalFailed`, `VaultFailed` |
| `GET /api/networks/{network}/configuration` | The Configuration in force, and the sequence of the `Configured` that set it | `{ configuration, sequence }` | `UnknownNetwork` |
| `POST /api/networks/{network}/say` | `{ kind, target, text, intent?, answers? }`, where `answers` is the id of the Message it answers, 1 to 256 characters with no space or control character | `Said { intent, sequence }` or `Refused { intent, sequence, reason }` | `UnknownNetwork`, `NetworkStopped` |
| `POST /api/networks/{network}/act` | `{ action, intent? }`: one of `Topic`, `Kick`, `Part`, `Mode`, `BanAccount`, `Invite`, `Nick`, `Setname`, `Away`, `Ctcp`, `Ping`, and `Raw` | `Acted { intent, sequence }` or `Refused { intent, sequence, reason }` | `UnknownNetwork`, `NetworkStopped` |
| `GET /api/networks/{network}/said/{intent}` | Whether a `say` or an `act` under the intent was journaled | `Journaled { sequence }` or `NotJournaled` | `JournalFailed` |
| `POST /api/networks/{network}/lookups` | Looks something up, `{ lookup, intent? }`: `Whois { nick }`, `Whowas { nick }`, `Names { channel }`, `Who { mask }`, `Channels { mask?, least? }`, or a Channel's `Bans { channel }`, `Exceptions { channel }`, or `Invitations { channel }`, and waits for the result. Query: `offset` (default 0) and `limit` (1 to 500, default 100), which page a `Channels` result only | `LookedUp { intent, sequence, result }` or `Pending { intent, sequence }` | `UnknownNetwork`, `NetworkStopped` |
| `GET /api/networks/{network}/lookups/{intent}` | A Lookup by its intent, from the Journal, paged by the same `offset` and `limit` | `LookedUp { intent, sequence, result }`, `Pending { intent, sequence }`, or `NotJournaled` | `JournalFailed` |
| `POST /api/networks/{network}/read` | Marks a Timeline read up to `{ read, target }`: an instant, and a Target, or `null` for the Network's own | `{ sequence }` | `UnknownNetwork`, `NetworkStopped` |
| `POST /api/networks/{network}/close` | Closes the Timeline of `{ target }`: a Channel Self is not in, or a Direct Message partner | `Closed`, or `Refused` with `Joined` or `NoTimeline`, each with `sequence` | `UnknownNetwork`, `NetworkStopped` |
| `POST /api/networks/{network}/retry` | Tries connecting now | `{ sequence }` | `UnknownNetwork`, `NetworkStopped` |
| `GET /api/networks/{network}/known` | What the Client knows: the Session, Self, Channels, members, Users, each open Direct Message partner, and the casemapping, with the life it is of | `Knowledge` | `UnknownNetwork` |
| `GET /api/networks/{network}/inspect` | Machine states, caps, ISUPPORT, STS, Features, timers, and Connections, each with how many Lines wait to leave and when the next may | `NetworkInspection` | `UnknownNetwork` |
| `GET /api/news?after=` | Server-Sent Events of News, then live | `happened` and `heartbeat` events | `JournalFailed`, in the stream |
| `GET /api/networks/{network}/timelines?after=&limit=` | A page of the Network's Timelines, merged ones aside, in the order they were opened, and whether they are being folded | `{ projection, version, through, timelines, more }` | `UnknownNetwork`, `TimelinesFailed` |
| `GET /api/timelines/{timeline}?before=\|after=\|around=&limit=` | A window of a Timeline, from at most one cursor, the latest without one | `{ timeline, network, items, earlier, later, gaps, version, through }` | `UnknownTimeline`, `TimelinesFailed` |
| `POST /api/timelines/{timeline}/read` | Marks the Timeline read up to `{ read }`, an instant, whatever its Network or whether it is detached | `{ sequence }` | `UnknownTimeline`, `NetworkStopped`, `TimelinesFailed`, `JournalFailed` |
| `POST /api/timelines/{timeline}/close` | Closes the Timeline, whatever its Network or whether it is detached | `Closed`, or `Refused` with `Joined` or `NoTimeline`, each with `sequence` | `UnknownTimeline`, `NetworkStopped`, `TimelinesFailed`, `JournalFailed` |
| `GET /api/timelines/{timeline}/channel` | A Channel's head, as the Client knows it now: its name, topic, modes, and count of members, where Self stands with it, and what the Network says of its modes | `{ timeline, network, name, topic, modes, standing, held, members, ranks, chanmodes, chantypes, lists, accountBan }` | `UnknownTimeline`, `NotAChannel`, `TimelinesFailed` |
| `GET /api/timelines/{timeline}/members?after=&limit=&prefix=` | A page of a Channel's members, the most privileged first, then by nick, and with `prefix`, only those whose nick starts with it | `{ timeline, network, members, more, next }` | `UnknownTimeline`, `NotAChannel`, `NotInChannel`, `TimelinesFailed` |
| `GET /api/networks/{network}/at/{sequence}?after=&limit=` | A page of the items a step made, wherever they stand now, for links and search results | `{ items, more, next, version, through }` | `UnknownNetwork`, `TimelinesFailed` |
| `GET /api/timelines/{timeline}/export?since=&until=` | A Timeline as plain text, one line an item, from `since` on and before `until` when given, as a file to save | `text/plain; charset=utf-8`, with `Content-Disposition: attachment` | `UnknownTimeline`, `TimelinesFailed` |
| `GET /api/search?text=&network=&timeline=&from=&since=&until=&after=&limit=` | A page of the Messages whose text holds `text`, newest first, kept to a Network, a Timeline, a sender, and a range of time when given | `{ items, more, next, version, through }` | `UnknownNetwork`, `UnknownTimeline`, `TimelinesFailed` |
| `GET /api/timelines/projection` | Server-Sent Events of whether the Timelines are being folded, as the stream opens and again when a failure stops the folding until the Daemon restarts | `projection` events of `Running` or `Stopped { reason }`, and `heartbeat` events |  |
| `GET /api/timelines/changes?after=` | Server-Sent Events of what each folded step changed, then live | `changed`, `overflowed`, `reset`, and `heartbeat` events | `TimelinesFailed`, in the stream |
| `GET /api/ui` | The options under `ui` in force, every one with a value, and the sequence of the last Change, `0` before any | `{ options, sequence }` |  |
| `PUT /api/ui/{option}?ifSequence=` | Sets one option under `ui` to `{ value }`, for every device. With `ifSequence`, only if it was made from the options in force | `{ sequence }` | `UiChanged`, `JournalFailed` |
| `DELETE /api/ui/{option}?ifSequence=` | Unsets one, back to its default, likewise | `{ sequence }` | `UiChanged`, `JournalFailed` |
| `GET /api/ui/changes?after=` | Server-Sent Events of the options under `ui`, whole, each time they change, then live | `changed` and `heartbeat` events |  |
| `GET /api/options` | The options beyond `ui` in force, by full name, such as `store.s3.bucket`: each one set, or with a default, and none other. The sequence is of the last Change of one, `0` before any | `{ options, sequence }` |  |
| `PUT /api/options/{option}?ifSequence=` | Sets one to `{ value }`, as for `ui` | `{ sequence }` | `OptionsChanged`, `JournalFailed` |
| `DELETE /api/options/{option}?ifSequence=` | Unsets one, back to its default or to none, likewise | `{ sequence }` | `OptionsChanged`, `JournalFailed` |
| `GET /api/options/changes?after=` | Server-Sent Events of them, whole, as for `ui` | `changed` and `heartbeat` events |  |
| `POST /api/uploads?name=` | Keeps a file: its bytes as the raw body, with no multipart and any `Content-Type`, and the name it was given, if any | `Upload` | `UploadsOff`, `UploadTooLarge`, `UploadUnreadable`, `StoreFull`, `StoreUnavailable`, `JournalFailed` |
| `GET /api/uploads?after=&limit=&deleted=` | A page of the Uploads, newest first, with deleted ones only when `deleted` is `true`, and how far it was read | `{ uploads, more, next, through }` | `TimelinesFailed` |
| `GET /api/uploads/status` | Whether Uploads are on, and the largest one may be | `On { maxSize }` or `Off { maxSize, missing }` |  |
| `GET /api/uploads/changes?after=` | Server-Sent Events of each Upload a Change makes, whole, then live, and which are missing | `changed`, `missing`, and `heartbeat` events | `JournalFailed`, `TimelinesFailed`, in the stream |
| `GET /api/uploads/{id}` | One Upload | `Upload` | `UnknownUpload`, `TimelinesFailed` |
| `GET /api/uploads/{id}/content` | An Upload's bytes, with its link's headers | the bytes | `UnknownUpload`, `StoreUnavailable` |
| `PATCH /api/uploads/{id}` | Renames one to `{ name }`, keeping its link's id | `Upload` | `UnknownUpload`, `JournalFailed`, `TimelinesFailed` |
| `DELETE /api/uploads/{id}` | Deletes one, so its link answers 404 at once | `Upload` | `UnknownUpload`, `JournalFailed`, `TimelinesFailed` |
| `POST /api/timelines/{timeline}/previews` | A Message's Previews, by `{ position }`, the cursor a window gave its item, which starts fetching any of its links not yet fetched | `{ previews: [{ id, link, state }] }` | `UnknownTimeline`, `UnknownMessage`, `PreviewsOff`, `TimelinesFailed` |
| `POST /api/timelines/{timeline}/previews/held` | What the Daemon already holds of many Messages' Previews, by `{ positions }`, from 1 to `heldLimit` cursors a window gave, which starts no fetch | `{ messages: [{ position, previews: [{ id, link, state }] }] }` | `UnknownTimeline`, `PreviewsOff`, `TimelinesFailed` |
| `POST /api/timelines/{timeline}/previews/press` | Fetches one link of a Message that waits for a press, by `{ position, link }`, the link's index among the Message's previewable links from `0` | the link's item, `Pending` | `UnknownTimeline`, `UnknownMessage`, `PreviewsOff`, `NotWaiting`, `TimelinesFailed` |
| `GET /api/previews/changes` | Server-Sent Events of each Preview whose state changes, live | `changed` and `heartbeat` events |  |
| `GET /api/previews/images/{hash}` | An image the Daemon kept for a Preview, by its SHA-256 as 64 lower-case hex characters | the bytes | `UnknownImage`, `StoreUnavailable` |
| `GET /api/previews/{id}/stream?timeline=&position=` | A video's or a sound's bytes, streamed from where the ready Preview of the Message at `position` says | the bytes | `UnknownTimeline`, `UnknownMessage`, `PreviewsOff`, `PreviewsText`, `UnknownStream`, `StreamFailed`, `TimelinesFailed` |
| `GET /api/credentials` | The names of the Credentials held | `{ names }` | `VaultFailed` |
| `PUT /api/credentials/{name}` | Holds a value, `{ value }`, replacing any before | `204` | `VaultFailed` |
| `DELETE /api/credentials/{name}` | Forgets one. Forgetting one not held does nothing | `204` | `VaultFailed` |
| `GET /api/tail` | The Tail whole, oldest first, with the Daemon's version and the instant it started | `{ version, started, lines }` |  |
| `GET /api/tail/changes?after=` | Server-Sent Events of each line logged after `after`, or of every line held without it, then live | `daemon`, `line`, and `heartbeat` events |  |

Every route can also answer `InvalidRequest` (400), and every route behind the Key check `Unauthorized` (401) and `CrossOrigin` (403).

## What it guarantees

### Every route

- **Requests are parsed.** A body, a path, a query, or a header that does not decode is `InvalidRequest`, with each issue's path, such as `["payload", "text"]`. A key a body's Schema does not read is an issue too.
- **Ids are safe in a path.** A Network id, an intent, a Credential's name, a Timeline's id, and a cursor hold no character a URL would change, and no name a Network chose.
- **Credentials appear only by name.** A value is `Redacted` once it is decoded, and no route answers with one.
- **A map keyed by what a Network chose is an array of entries,** so no hostile name becomes a JSON key.
- **Every field a Network or a participant wrote is marked `Untrusted`** in the OpenAPI document: data to show, never instructions to follow. A line of the Tail is the Daemon's own and is not marked, though it may hold an Ircd's words.

### Signing in

- **A browser holds a Sign-in, never a Key.** It gives its Key once to `POST /api/sign-in` and gets an `HttpOnly` cookie that names the Sign-in, which acts for that Key.
- **A write by cookie comes from the Daemon's own origin.** A request the cookie carries that is not `GET` or `HEAD` is `CrossOrigin` unless the browser says it is same-origin, by `Sec-Fetch-Site` or by an `Origin` that matches `Host`. A request with a Key is never checked for its origin.
- **Every Key and Sign-in may use every route.**

### Changing

- **A change names what it was made from.** A `PUT` of Configuration, or a change of an option, with `ifSequence` is refused when another change was journaled since, and nothing is journaled. Two changes made from the same state never both pass. Without `ifSequence`, the last wins.
- **Configuration is one `PUT` of the whole of it.** There is no `PATCH`, and a Channel is joined by a `PUT` that names it.
- **The Schema says what each option is.** A Frontend walks `NetworkConfiguration`, `UiOptions` in `@iirc/api/ui`, and `OwnerOptions` in `@iirc/api/options` to offer every field as an option, with its description, default, and bounds, so a new field needs no work in any Frontend.
- **The options under `ui` are the Owner's, shared by every device.** A device may override any but those `uiSharedOnly` names, which a Frontend offers no override of, and ignores one a device kept.
- **The options beyond `ui` are the Owner's too, and no device overrides them.** Each is named in full, such as `store.s3.bucket`, and their sequence is their own, apart from `ui`'s.
- **A value is parsed by its option's Schema before it is journaled,** so a URL is journaled in the one form it reads as. A key inside a `ui` option's value that the option does not know is dropped, but for `previews.timelines`, which refuses the value.
- **An option that needs a secret names a Credential,** never holds its value.
- **A name or a value an option under `ui` had before is still read where it was kept.** `uiNameKept` and `uiValueKept` read a journaled Change, or an override a device kept, as the option is now. A request names an option only by the name it has now.
- **The options are streamed whole.** Each `changed` event is every option in force under its roots, so a Frontend that follows needs no read first, and one that reconnects misses nothing.

### Uploads

- **Uploads are on exactly when the Store and `uploads.publicUrl` are set:** `store.s3.endpoint`, `bucket`, `region`, and both keys. Otherwise the status is `Off`, naming each that is not set, and an upload is `UploadsOff`.
- **An upload's body is the file.** It is never multipart, its `Content-Type` is never read, and its type is read from its bytes. It has at least one byte.
- **An upload past `uploads.maxSize` is cut off unread,** as `UploadTooLarge`, and one that would take the distinct bytes live Uploads hold past `uploads.maxTotal` is `StoreFull`. Nothing is kept, and nothing is evicted to make room.
- **A JPEG, PNG, GIF, WebP, HEIC, AVIF, MP4, or MOV is kept without its metadata,** so `size` and `hash` are of the bytes kept. Every other type is kept as it was sent.
- **An upload answered with an error closes the request's connection,** since its body may be unread.
- **An Upload's `id` is random, never its hash.** Its `link` is `<uploads.publicUrl>/<id>/<safeName>`, built from the public URL in force when it is read, or `null` while none is set or once it is deleted.
- **`said` is each Message of ours whose text holds `/<id>/`,** on any Network, newest first, read when the Upload is given, so a link pasted by hand counts. No Change is sent when a Message is said, so a Frontend reads the Upload again to learn of one.
- **A rename keeps the link working.** The link is found by its id alone, and its download takes the new name. A deleted Upload cannot be renamed.
- **A delete is at once, and the record stays.** Its link and its bytes are 404 from then on, while `GET /api/uploads/{id}` still reads it, marked deleted, and deleting it again answers the same record. Its bytes leave the Store unless a live Upload has the same.
- **The Uploads are listed newest first, a deleted one only with `deleted=true`.** `through` is where to follow from: `GET /api/uploads/changes` with it as `after` misses nothing since, and repeats nothing the page gave.
- **An Upload's bytes are served on the API's own origin too,** with exactly the headers its link has.
- **Upload Changes resume exactly.** Each `changed` event is one Upload, whole, as it is now, and its id is the Change's sequence. With `after` or `Last-Event-ID`, which wins, the stream gives every Upload changed since, then live. With neither, it gives only what changes from now.
- **An Upload is `missing` once a read found its bytes gone,** never while the Store cannot be reached. Uploading the same bytes again, or a read that finds them, clears it, and nothing is marked after a restart until a read finds bytes gone again. The `missing` event carries every missing id, whole, with no event id.

### The Tail

- **The Tail is the Daemon's memory, never the Journal's.** It holds the last 4096 lines the Daemon logged at `Debug` and above, a Network's included. A restart empties it.
- **A line is text, to draw as text.** Any part of it may hold an Ircd's words.
- **The first line is the Daemon's start,** at `Info`, with its `version` as an annotation.
- **The stream resumes by number, within one Daemon.** Each `line` event's id is its `n`. With `after` or `Last-Event-ID`, which wins, the stream gives every line held after it, then live. With neither, it gives every line held.
- **The `daemon` event comes first,** with `version` and `started`, so a Frontend whose `started` differs knows the Daemon restarted, and reads the Tail again.

### Previews

- **A Preview is fetched by the Daemon, never the browser,** and only once a Frontend asks for a Message's Previews.
- **A Message's Previews are its first three distinct `http` or `https` links,** in its order, one item each. A Message with none answers an empty list.
- **An ask fetches a link the Daemon does not hold, or holds too old.** An ask while it is being fetched answers `Pending` and starts nothing.
- **A Direct Message waits for a press.** With no entry in `ui.previews.timelines`, a link of its not yet fetched answers `WaitingForPress` until `press` fetches it. A press of any other link is `NotWaiting`.
- **An item is its link's, wherever it is posted.** Its `id` is the same for one link in any Message and for any Frontend, and opaque.
- **A Preview's `image` is `null` or an image the Daemon kept,** served at `GET /api/previews/images/{hash}`, with its `dimensions` where its bytes state them, so a Frontend can reserve its box.
- **A video or a sound is streamed through the Daemon, and kept nowhere.** `GET /api/previews/{id}/stream` plays only the `stream` the Daemon recorded for a ready Preview of kind `video` or `audio`, and passes on a single `Range`. A Timeline whose mode is `text` is `PreviewsText`.
- **A held read fetches nothing.** It answers each place asked, in order, from what the Daemon holds, with `NotHeld` for a link nothing is held of, and no items where no Message stands.
- **The changes are an item each time a Preview's state changes,** for every Frontend, whoever asked. An event has no id and nothing resumes, so a Frontend that follows again asks again for the Previews it shows.

### Removing

- **One list names every Network.** `GET /api/networks` gives each as `Live` or `Kept`, and one it does not name is not held.
- **Every answer about a Network names its life,** the sequence of the `Configured` that began it. It only increases for an id, so an answer from a Network removed and added again is told apart from the new one's.
- **A removed Network is gone from every route that acts on it or reads what its Client knows.** Each answers `UnknownNetwork`, as for a Network never configured, while `said` and a Lookup by its intent still answer from the Journal.
- **News tells of a removal with `NetworkRemoved`.** No News of the Network follows but another removal, when Timelines that were kept are dropped.
- **The Owner chooses whether its Timelines stay.** Kept, they are read and searched as before, each says `removed`, and the id stays taken: a `PUT` of it is `TimelinesKept`. Removing it again with `keep=false` drops them, the changes stream gives each as `dropped`, and the id is free at once.
- **A kept Channel has no Client behind it.** Its head answers with `standing: null`, and its members are `NotInChannel`.
- **A removal names the life it was made from,** so one made about a Network that was removed or added again since is `LifeChanged`, and removes nothing.
- **Its Credentials go once its removal is journaled,** but those another Network's Configuration or an option under `store` names. A `VaultFailed` leaves the removal standing, and a `JournalFailed` may: read the Network list to learn where it stands.

### Saying, acting, and looking up

- **A `say` or an `act` answers with what its step knew.** `Said` or `Acted` means it was sent, not that it reached the Ircd. `Refused` means the Client refused it in that step. Either way it was journaled, at `sequence`, under `intent`.
- **The Daemon names an intent when the caller gives none,** so `NetworkStopped` always says which to ask about.
- **A reply carries a `+reply` tag where the Session carries tags,** and is still said, without it, where it does not.
- **What happens after comes through the Timelines.** A Message's item says how its delivery stands, and an action the Ircd refuses later becomes an `ActionRefused` item.
- **The wire refuses a line break, a NUL, and an empty name.** The Client checks the rest against the Network, and never cuts a Line short.
- **A CTCP request goes to one nick, never a Channel,** and nothing waits for its reply.
- **A Lookup waits for its result, up to 35 s.** Past that it is `Pending`: ask again by its intent. A Lookup changes nothing on the Network, so it can be asked again freely.
- **A Lookup says how it ended.** A list the Network does not keep, by its ISUPPORT, is `Refused` as `NotOffered`, a refusal from the Network is `Failed`, `cut` says why a list stopped short, and `notes` holds any `WARN` or `NOTE` its reply held.
- **A directory of Channels is paged.** The Daemon keeps the 1000 with the most members, and a result is one page of them, most members first, with `total` how many were kept and `seen` how many matched.
- **A Read Marker only moves forward, and every Frontend shares it,** whether it is marked by a Target or by a Timeline's id.
- **A Timeline is marked read, or closed, by its id as well as by a Target.** One a Network's Client can name, of a Network not removed, is given to that Client as the Timeline is, so it answers as its Target would, and needs no Session: a Channel only `CHANTYPES` makes one is reached while its Network is offline. A detached Direct Message Timeline, or one a removed Network kept, is marked by a Change no Client takes, and never answers `UnknownNetwork`. A merged id acts on the Timeline it went to, and an id never given, or a dropped Timeline's, is `UnknownTimeline`.
- **A closed Timeline comes back by itself,** with its counts, when something arrives in it. A `close` is journaled, and deletes nothing. A detached Timeline, which nothing arrives in, stays closed, and is still found by search and read by its id.
- **A Channel Self is in is never closed, and neither is the Network's own.** A `close` of the first answers `Refused` with `Joined`, decided in the step that took it, and of the second, or of a Target that names no one Timeline, `NoTimeline`.

### News

- **News resumes exactly.** Each `happened` event is one step's News, and its event id is the sequence. A Frontend resumes with `after` or `Last-Event-ID`, misses nothing, and sees nothing twice. A `heartbeat` carries no id.
- **News is a closed set.** A Frontend that reads News is as new as the Daemon: one built before a kind of News was added refuses the event that holds one.
- **News says where it belongs.** Each Message and Activity carries `where` and `ignored`, and a Message whether it is a `highlight`, whether Self said it, what it `answers`, and its `context`. A Frontend reads these and never works them out.
- **A `CtcpReply` to the Owner's `PING` carries `roundTrip`,** the milliseconds between the Daemon journaling the request and the reply, and otherwise `null`.

### Timelines

A Frontend reads Timelines and never folds News. The Daemon folds them.

- **A read says how far it was folded, and the changes follow from there.** Every Timeline read gives `version` and `through`, and a Frontend that follows `GET /api/timelines/changes` from that place misses nothing.
- **To hold every Timeline,** a Frontend reads the pages of the list in turn, then follows the changes after the smallest `through` the pages gave.
- **A window is read from one place:** `before`, `after`, or `around` a cursor, or the latest with none. `earlier` and `later` say whether more lie beyond each end. A merged Timeline's id reads the Timeline it went to.
- **A position travels as a cursor,** opaque text that compares exactly as positions do, so a Frontend places a Gap among items by comparing cursors.
- **A window's Gaps are bounded by its items.** Consecutive Gaps with no item between them come as one, counted, and pages fitted together give every Gap once.
- **A Timeline says whether it is `removed` and whether it is `closed`.** A Frontend leaves a closed one out of the Sidebar, and never works out whether it should be.
- **The Daemon counts what is unread.** Each Timeline carries `read`, its Read Marker, and `unread`, a count for each level of what stands after it, each exact up to `unreadCap`. A bot's Messages are counted apart, as `botDirect` and `botMessages`. A Frontend shows the counts and never counts the items it holds.
- **A Message in a Channel says its sender's prefix.** News and an item's Message carry `prefix`, the symbol of the highest prefix its sender held there when it was said, by `PREFIX`, or `null` for none, as for a Direct Message or a sender the Client did not know as a member. It is fixed when said and never read from the members known now.
- **A Message and a confirmed delivery carry `nicks`,** the spans of their text that name a User who counts, as UTF-16 offsets into the text with formatting stripped, `start` inclusive and `end` exclusive. The Client works them out when the Message is said, and they are fixed after.
- **A reply says what it answers.** An item's `answered` is the Message its `answers` names in the same Timeline, as of the read, or `null` when the Timeline holds none.
- **A live reply to a Message Self said is an item of level `Highlight`,** which only the store can tell, so its News `highlight` stays `false`.
- **One of our Messages says how its delivery stands:** `Pending`, `Unconfirmed`, `Confirmed`, `Unsent`, or `Rejected` with the Ircd's numeric or code, never its text.
- **Every list comes a page at a time,** up to `limit`, 1 to 500 and 100 when left out, with `more`. Most give an opaque `next` to hand back as `after`, while the list of Timelines takes the id of the last one given, and a directory of Channels an `offset`. An `after` the Daemon could not have given is `InvalidRequest`.

### The changes stream

- **It resumes exactly, by an opaque place,** `<version>.<sequence>`: what a read gave, or an event's id. A place stays good across a restart.
- **Each `changed` event is what one folded step changed, as it stands now,** with `removals`, each Network removed, and `dropped`, the Timelines a removal took with it. Something changed again comes again, so a Frontend keeps each thing by its id or position and takes the latest.
- **An event is bounded,** at 500 things. A step that changed more comes as `overflowed`, naming the Timelines to read again, or none, which says to read every one.
- **A place that cannot be resumed is reset.** One of another projection version, or ahead of what the store has folded, gets one `reset` event, which says to drop what is held, read again, and follow from its place.
- **It waits on the Daemon's folding, never polls, and ends only as the Daemon stops.**

### Channels and search

- **A Channel is read as the Client knows it now,** by its Timeline's id, never its name, so these reads carry no `version`. A Frontend follows the changes to learn when to read again: an Activity in its Timeline or a Gap of its Network may change it, and what no item says, such as its modes becoming known, moves its Timeline's `head`, to compare with the one last seen.
- **A Channel's head always answers,** with where Self stands and the Network's `PREFIX`, `CHANMODES`, `CHANTYPES`, and `lists`, so a Frontend parses a mode change, and offers a list, as the Client will check it. Its modes never hold a key: `k` is set with a `null` parameter.
- **Members come in rank order, then by nick,** compared by code unit, never by a locale. `prefix` keeps the nicks that start with it under the Connection's casemapping. A member who changed rank between pages may be given again or missed.
- **A search finds Messages by what they say, newest first.** `text` is one run of 3 to 510 code points, found anywhere in a Message, whatever its case, and never by a locale's rules.
- **The Daemon reads no syntax from a query.** Terms such as `from:nick` are a Frontend's to parse into the filters.
- **A search is restarted after a merge.** Pages repeat no Message unless a merge moved items between them, which the changes report.
- **An export is text to read, not to parse.** Each line is an item's time in UTC, then what it shows, with formatting stripped and every control character a space, so an item is always one line. Hidden items are left out.

## Errors and statuses

| Error | Status | Why |
| --- | --- | --- |
| `InvalidRequest` | 400 | The request could not be read. |
| `Unauthorized` | 401 | No Key and no Sign-in, or none that matches. Signing in, a Key that does not match. |
| `CrossOrigin` | 403 | A request the cookie carries that changes something, or a signing in or out, that a browser did not say came from the Daemon's own origin. |
| `UnknownNetwork` | 404 | No Network by that id was ever configured, or it was removed. |
| `UnknownTimeline` | 404 | No Timeline had that id, nor was merged from one that had. |
| `NotAChannel` | 404 | The Timeline is the Network's own or a Direct Message partner's, which it names as `kind`, so it has no Channel. A Timeline's kind never changes. |
| `NotInChannel` | 409 | Self is not in the Channel now, so it has no members to list. It says where Self stands with it, or `null` when the Client holds no such Channel. |
| `ConfigurationChanged` | 409 | A `PUT` of Configuration was made from another than the one now in force, which it names. Nothing was journaled. |
| `LifeChanged` | 409 | A removal named a life of the Network the Daemon no longer holds: it was removed, or added again, since. It names the life held, or `null`. Nothing was journaled. |
| `TimelinesKept` | 409 | A `PUT` of Configuration named a Network removed with its Timelines kept. Its id is free once they are dropped. Nothing was journaled. |
| `UiChanged` | 409 | A change of an option under `ui` was made from other options than those in force: another Change was journaled since, at `sequence`, the last. Nothing was journaled. |
| `OptionsChanged` | 409 | The same, for an option beyond `ui`. |
| `UnknownMessage` | 404 | No Message stands at that position in the Timeline: nothing does, or an Activity does. |
| `PreviewsOff` | 409 | The Timeline's mode is `off`, its own in `ui.previews.timelines` or else `ui.previews`, so nothing was fetched. |
| `NotWaiting` | 409 | The link pressed is past the Message's previewable links, or is kept, being fetched, or in a Timeline that does not wait, so nothing was fetched. |
| `PreviewsText` | 409 | The Timeline's mode is `text`, so no video or sound is streamed. |
| `UnknownStream` | 404 | No link of the Message has a ready Preview of a video or a sound with that id. |
| `StreamFailed` | 502 | The stream's address gave nothing to stream, for the `reason` it names. |
| `UnknownImage` | 404 | No Preview holds an image with that hash. |
| `UnknownUpload` | 404 | No Upload has that id, or, asked for its bytes or to be renamed, it is deleted, or, asked for its bytes, the store confirms they are gone. |
| `UploadsOff` | 409 | Uploads are off, and `missing` names the options that are not set. Nothing was read or kept. |
| `UploadTooLarge` | 413 | The body passed `maxSize`, so it was cut off there, and nothing was kept. |
| `UploadUnreadable` | 422 | The body is a JPEG, PNG, GIF, WebP, HEIC, AVIF, MP4, or MOV, its `type`, whose structure could not be walked, as `reason` says, so its metadata could not be stripped, and nothing was kept. |
| `StoreFull` | 507 | Keeping the body would take the distinct bytes live Uploads hold past `maxTotal`, `uploads.maxTotal`, so nothing was kept, and nothing was evicted. Bytes a live Upload already holds add nothing, and deleting one makes room. |
| `StoreUnavailable` | 503 | The Store could not be reached, refused what was asked, or a key the options name is not held, so nothing was kept or read. Bytes asked for while Uploads are off are this too. It is also the answer when the Daemon began to stop, and then the Upload may or may not have been kept, if the Daemon was already journaling it. |
| `NetworkStopped` | 503 | The Network stopped, so its outcome is `Uncertain`, below. |
| `Unwell` | 503 | The Daemon is not well, and `part` names what is not. |
| `TimelinesFailed` | 503 | The Timelines could not be read. They are derived, and a read that waited on a lock may succeed when asked again, while a damaged store is made again from the Journal when the Daemon restarts. |
| `VaultFailed` | 503 | The Vault could not read or write its file. It tries again on the next call, so once the Owner fixes the file or its directory, the same request succeeds. |
| `SignInsFailed` | 503 | The Daemon could not write its Sign-ins, so nothing changed. It tries again on the next call. |
| `JournalFailed` | 500 | The Journal could not be read or written. A Network whose Journal failed stays stopped until the Daemon starts again, so asking again does not help. A change of an option that could not be journaled changed nothing, and stops nothing. |

A body over 1 MiB is refused with 413 before it is read, on every route but an upload's.

**`NetworkStopped` does not mean the input was refused.** The Network may have stopped after the input was journaled and before the Daemon answered, and a restart steps it. Its body says `outcome: "Uncertain"`, and for a `say`, an `act`, or a Lookup, the `intent` it was given under, even one the Daemon named. A `PUT` of Configuration, a `read`, a `close`, and a `retry` can be sent again freely. A `say` or an `act` must not be: ask `said` with that intent, on this Daemon or the one started after it. `Journaled` means it must not be said again. `NotJournaled` means saying it again under the same intent is safe. An intent must be unique for its Network across the whole Journal, which is the caller's to keep.

## Not yet

- **Managing Keys through the API.** A Key is made with `iirc key create` while the Daemon is stopped.
- **Ending Sign-ins other than by signing out.** A Sign-in lasts until it is signed out or its Key is no longer held. It does not expire, and there is no listing or revoking the Sign-ins of a Key.
- **Other Lookups, and Leave.** `WHOIS`, `WHOWAS`, `NAMES`, `WHO`, `LIST`, and a Channel's bans, exceptions, and invitation masks are the Lookups the Client offers. Others are new tags of `lookup` once the Client collects them, and until then their replies can be asked for as a raw Line, and read only as their Lines arrive.
