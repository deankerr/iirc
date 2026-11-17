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
| `GET /api/networks` | Lists every Network the Daemon holds, read together, each with its life: `Live`, with whether it runs, or `Kept`, removed with its Timelines kept | `[Live { network, life, status } \| Kept { network, life }]` |  |
| `PUT /api/networks/{network}?ifSequence=` | The whole `NetworkConfiguration`, which adds the Network the first time. With `ifSequence`, only if it was made from the Configuration in force | `{ sequence }` | `NetworkStopped`, `ConfigurationChanged`, `TimelinesKept` |
| `DELETE /api/networks/{network}?keep=true\|false&life=` | Removes the Network: its Session ends with a `QUIT`, and its Configuration and Credentials go. `keep` is whether its Timelines stay readable. `life` is the life of it the removal was made from, and it removes nothing unless the Daemon holds that life, live or kept. A Network removed with its Timelines kept is removed again with `keep=false` to drop them | `{ sequence, life }`, the life it ended | `UnknownNetwork`, `LifeChanged`, `NetworkStopped`, `JournalFailed`, `VaultFailed` |
| `GET /api/networks/{network}/configuration` | The Configuration in force, and the sequence of the `Configured` that set it | `{ configuration, sequence }` | `UnknownNetwork` |
| `POST /api/networks/{network}/say` | `{ kind, target, text, intent?, answers? }`, where `answers` is the id of the Message it answers, 1 to 256 characters with no space or control character | `Said { intent, sequence }` or `Refused { intent, sequence, reason }` | `UnknownNetwork`, `NetworkStopped` |
| `POST /api/networks/{network}/act` | `{ action, intent? }`: one of `Topic`, `Kick`, `Part`, `Mode`, `Invite`, `Nick`, `Away`, `Ctcp`, `Ping`, and `Raw`, below | `Acted { intent, sequence }` or `Refused { intent, sequence, reason }` | `UnknownNetwork`, `NetworkStopped` |
| `GET /api/networks/{network}/said/{intent}` | Whether a `say` or an `act` under the intent was journaled | `Journaled { sequence }` or `NotJournaled` | `JournalFailed` |
| `POST /api/networks/{network}/lookups` | Looks something up, `{ lookup, intent? }`: `Whois { nick }`, `Whowas { nick }`, or a Channel's `Bans { channel }`, `Exceptions { channel }`, or `Invitations { channel }`, and waits for the result | `LookedUp { intent, sequence, result }` or `Pending { intent, sequence }` | `UnknownNetwork`, `NetworkStopped` |
| `GET /api/networks/{network}/lookups/{intent}` | A Lookup by its intent, from the Journal | `LookedUp { intent, sequence, result }`, `Pending { intent, sequence }`, or `NotJournaled` | `JournalFailed` |
| `POST /api/networks/{network}/read` | Marks a Timeline read up to `{ read, target }`: an instant, and a Target, or `null` for the Network's own | `{ sequence }` | `UnknownNetwork`, `NetworkStopped` |
| `POST /api/networks/{network}/close` | Closes the Timeline of `{ target }`: a Channel Self is not in, or a Direct Message partner | `Closed`, or `Refused` with `Joined` or `NoTimeline`, each with `sequence` | `UnknownNetwork`, `NetworkStopped` |
| `POST /api/networks/{network}/retry` | Tries connecting now | `{ sequence }` | `UnknownNetwork`, `NetworkStopped` |
| `GET /api/networks/{network}/known` | What the Client knows: Session, Self, Channels, members, Users, each open Direct Message partner with whether they are on the Network (`partners`), the Connection's casemapping, the one an Ircd last declared (`declared`, `null` until one has), and `CHANTYPES` while a Session has said it (`chantypes`, `null` otherwise), and the life it is of | `Knowledge` | `UnknownNetwork` |
| `GET /api/networks/{network}/inspect` | Machine states, caps, ISUPPORT, STS, Features, timers, and Connections, each with how many Lines wait to leave and when the next may | `NetworkInspection` | `UnknownNetwork` |
| `GET /api/news?after=` | Server-Sent Events of News, then live | `happened` and `heartbeat` events | `JournalFailed`, in the stream |
| `GET /api/networks/{network}/timelines?after=&limit=` | A page of the Network's Timelines, merged ones aside, in the order they were opened, and whether they are being folded | `{ projection, version, through, timelines, more }` | `UnknownNetwork`, `TimelinesFailed` |
| `GET /api/timelines/{timeline}?before=\|after=\|around=&limit=` | A window of a Timeline, from at most one cursor, the latest without one | `{ timeline, network, items, earlier, later, gaps, version, through }` | `UnknownTimeline`, `TimelinesFailed` |
| `GET /api/timelines/{timeline}/channel` | A Channel's head, as the Client knows it now: its name, topic, and modes, where Self stands with it and the prefix modes Self holds, how many members it has, `PREFIX`, `CHANMODES`, `CHANTYPES`, and the mode of each list of masks the Network keeps | `{ timeline, network, name, topic, modes, standing, held, members, ranks, chanmodes, chantypes, lists }` | `UnknownTimeline`, `NotAChannel`, `TimelinesFailed` |
| `GET /api/timelines/{timeline}/members?after=&limit=&prefix=` | A page of a Channel's members, the most privileged first, then by nick, and with `prefix`, only those whose nick starts with it, each with their prefix modes, and their User's account and whether they are away, as known | `{ timeline, network, members, more, next }` | `UnknownTimeline`, `NotAChannel`, `NotInChannel`, `TimelinesFailed` |
| `GET /api/networks/{network}/at/{sequence}?after=&limit=` | A page of the items a step made, wherever they stand now, for links and search results | `{ items, more, next, version, through }` | `UnknownNetwork`, `TimelinesFailed` |
| `GET /api/search?text=&network=&timeline=&from=&since=&until=&after=&limit=` | A page of the Messages whose text holds `text`, newest first, kept to a Network, a Timeline, a sender, and a range of time when given | `{ items, more, next, version, through }` | `UnknownNetwork`, `UnknownTimeline`, `TimelinesFailed` |
| `GET /api/timelines/changes?after=` | Server-Sent Events of what each folded step changed, then live | `changed`, `overflowed`, `reset`, and `heartbeat` events | `TimelinesFailed`, in the stream |
| `GET /api/ui` | The options under `ui` in force, every one with a value, and the sequence of the last Change, `0` before any | `{ options, sequence }` |  |
| `PUT /api/ui/{option}?ifSequence=` | Sets one option under `ui` to `{ value }`, for every device. With `ifSequence`, only if it was made from the options in force | `{ sequence }` | `UiChanged`, `JournalFailed` |
| `DELETE /api/ui/{option}?ifSequence=` | Unsets one, back to its default, likewise | `{ sequence }` | `UiChanged`, `JournalFailed` |
| `GET /api/ui/changes?after=` | Server-Sent Events of the options under `ui`, whole, each time they change, then live | `changed` and `heartbeat` events |  |
| `GET /api/options` | The options under `store`, `uploads`, and `previews` in force, by full name, such as `store.s3.bucket`: each one set, or with a default, and none other. The sequence is of the last Change of one, `0` before any | `{ options, sequence }` |  |
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
| `POST /api/timelines/{timeline}/previews/press` | Fetches one link of a Message that waits for a press, by `{ position, link }`, the link's index among the Message's previewable links from `0` | the link's item, `Pending` | `UnknownTimeline`, `UnknownMessage`, `PreviewsOff`, `NotWaiting`, `TimelinesFailed` |
| `GET /api/previews/changes` | Server-Sent Events of each Preview whose state changes, live | `changed` and `heartbeat` events |  |
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

- **A change names what it was made from.** A `PUT` of Configuration, or of an option, with `ifSequence` is refused when another change was journaled since, and nothing is journaled: read again and send it again. The check and the append are one step, so two changes made from the same state never both pass. Without `ifSequence`, the last wins.
- **Configuration is an option tree, and the Schema says what each option is**. A Frontend walks `NetworkConfiguration` to offer every field as an option, so a new field needs no work in any Frontend.
- **The options under `ui` are the Owner's, shared by every device**. `UiOptions`, in `@iirc/api/ui`, describes each with its default: `theme`, `light`, `dark`, `themes`, `colours`, `font`, `size`, `leading`, `time`, `day`, `activity`, `width`, `read`, which says when a Timeline is marked read, and the Composer's habits, `enter`, `spellcheck`, and `suffix`, `previews`, which says whether the Daemon previews links, and `previews.timelines`, each Timeline's own choice over it, by its id, and, each of which a device may override, `previews.animate`, whether an animated image plays on its own, and how rich a Preview looks: `previews.style`, `line`, `thumbnail`, or `card`, `previews.folded`, `open`, `summary`, or `chip`, and `previews.mediaHeight`, `small`, `medium`, or `large`. A value is parsed by its option's Schema before it is journaled. `light` and `dark` name the themes `system` draws, and are never `system`. At most 32 themes are held, and an import may not take `system`, a built-in theme's name, or a word `/theme` reads. `font` is a font's name or a family's, which holds no `"`, `\`, or control character, so it is always one quoted CSS family. `suffix` is at most 8 characters, empty allowed, with no control character, so it never puts a line break or IRC formatting into the Composer.
- **An option under `ui` the Daemon acts on is shared only.** Its Schema is annotated `sharedOnly`, and `uiSharedOnly` names them: `previews` and `previews.timelines`, since the Daemon fetches and no device may turn fetching on for itself. A Frontend offers no override of one, and ignores one a device kept.
- **The options under `store`, `uploads`, and `previews` are the Owner's too, and no device overrides them**. `OwnerOptions`, in `@iirc/api/options`, is one flat Struct keyed by each option's full name: the bucket, `store.s3.endpoint`, `bucket`, `region`, and its keys, `accessKeyId` and `secretAccessKey`, which name Credentials by the `CredentialName` Schema, how Uploads are served, `uploads.listen`, `publicUrl`, `maxSize`, `maxTotal`, and `expireAfter`, in days, and how much of the store Previews' images may take, `previews.maxTotal`. Only `uploads.maxSize` has a default, 100 MiB, and `previews.maxTotal`, 1 GiB. Each is parsed by its Schema before it is journaled, so a URL is journaled as the one form it reads as, such as `https://files.example.com/uploads` for any spelling of it with the default port, an upper-case host, or a trailing `/`, and an address is `host:port` with a name, an IPv4 address, or a bracketed IPv6 one, and the sequence they are changed from is their own, apart from `ui`'s.
- **The options are streamed whole.** Each `changed` event is every option in force under its roots, so a Frontend that follows needs no read first, and one that reconnects misses nothing.

### Uploads

- **Uploads are on exactly when the bucket, its two keys, and `uploads.publicUrl` are set.** Otherwise the status is `Off`, naming each of those options that is not, and an upload is `UploadsOff`. The status always says `maxSize`, `uploads.maxSize` in force.
- **An upload's body is the file, whatever it is.** It is never multipart, and its `Content-Type` is never read: the type is read from the bytes. It must have at least one byte, and it may be as large as `uploads.maxSize` when the upload began, past which it is cut off unread with `UploadTooLarge` and nothing is kept. While `uploads.maxTotal` is set, an upload whose bytes would take the distinct bytes live Uploads hold past it is `StoreFull`, and nothing is evicted to make room. A JPEG, PNG, GIF, WebP, HEIC, AVIF, MP4, or MOV is kept without its metadata, so `size` and `hash` are of the bytes kept, which may be fewer than were sent for an image that is cut or rewritten, and are as many for HEIC, AVIF, MP4, and MOV, whose metadata is zeroed where it lies. Every other type is kept as it was sent, metadata and all. An upload answered with any error closes its Connection, since its body may be unread.
- **An `Upload` is its record and its link.** `id` is 16 lower-case Crockford base32 characters, `UploadId`, 80 random bits, never the hash. `name` is the name given or last renamed to, when there is one, `safeName` the name its link and download use, made from it and from the type, `type` the `Content-Type` it is served with, `size` and `hash` the bytes' count and SHA-256, `at` when it was kept, `renamedAt` when it was last renamed, if it was, and `deleted` when and why it was deleted, if it was: by the `owner`, or once it `expired`. `missing` is `true` while a read of the store has confirmed a live Upload's bytes are gone. `link` is `<uploads.publicUrl>/<id>/<safeName>`, built from the public URL in force when it is read, or `null` while none is set or once it is deleted. `said` is where it was said: each Message of ours, on any Network, whose text holds `/<id>/`, newest first, as `TimelineItem`s, read from the Timelines when the Upload is given, so a link pasted by hand later counts. A Message of someone else's never does, nor one of ours the Ircd refused. The Upload Changes are not sent when a Message is said, so a Frontend reads the Upload again to learn of one.
- **A rename keeps the link working.** The safe name is made again from the new name, but the link is found by its id alone, so one already said still opens the Upload, and its download takes the new name. A deleted Upload cannot be renamed.
- **A delete is at once, and the record stays.** From then on its link and its bytes on the API are 404, exactly as for an id no Upload has, while `GET /api/uploads/{id}` still reads it, marked deleted. Deleting it again answers the same record. Its bytes leave the store unless another Upload not deleted has the same.
- **The Uploads are listed newest first,** in the order they were kept, as every list is paged, and a deleted one only with `deleted=true`. `next` is an Upload's id, and the page after it holds those older than it, even if it has since been deleted. `through` is the sequence of the latest Upload Change the page was read from, or `0` before any, so a Frontend that follows `GET /api/uploads/changes` with it as `after` misses nothing since, and is sent nothing the page gave.
- **An Upload's bytes are served on the API's own origin too,** under a key or a sign-in, for a Frontend whose page allows only its own origin. They carry exactly the headers its link does, so they act no more in a browser here than there, and `StoreUnavailable` for them carries `Cache-Control: no-store`.
- **Upload Changes resume exactly.** Each `changed` event is one Upload, whole, as it is now, with its link from the public URL in force as it is sent, and its id is the sequence of the Change. A Frontend keeps each Upload by its id and takes the latest. It resumes with `after` or `Last-Event-ID`, which wins, and is sent every Upload changed since, then live, with nothing missed and nothing twice. Without either, it is sent only what changes from now.
- **Missing is a fact about the store, learnt by reading it.** A live Upload is `missing` once a read of its link or its bytes found them gone, and answered 404, never while the store cannot be reached, which is 503. Its record can still be deleted. Uploading the same bytes again, or a read that finds them, takes the mark away, so its link works again. A deleted Upload's link stays 404 whatever the store holds. Nothing marks one after a restart until a read finds its bytes gone again. The `missing` event carries the ids of every missing Upload, whole, as the stream opens and each time they change, with no id, so it moves no `Last-Event-ID`.
- **Uploading, renaming, and deleting need what saying needs, and reading needs a read.** Key scopes do not exist yet, so every key and sign-in may do all of them, and each write by cookie must come from the Daemon's own origin, as every write must.

### Previews

- **A Preview is fetched by the Daemon, never the browser,** and only once a Frontend asks for a Message's Previews, by its Timeline and its item's `position`. A cookie request to ask must come from the Daemon's own origin, as every write must, so another site cannot make the Daemon fetch.
- **A Message's Previews are its first three distinct `http` or `https` links,** in its order, as `previewableLinksOf` in `@iirc/protocol/links` finds them, one item each. A Message with none answers an empty list.
- **A link is fetched once, however often it is asked for.** An ask while it is being fetched answers `Pending` and starts nothing, and one after answers what it came to. In a Direct Message with no entry in `ui.previews.timelines`, a link not yet fetched answers `WaitingForPress` and is not fetched until a press. A press of any other link is `NotWaiting`, and a cookie one must come from the Daemon's own origin, as an ask must.
- **An item is its link's, wherever it is posted.** `id` is the same for one link in any Message and for any Frontend, and opaque. `link` is the link as the URL parser wrote it. `state` is `Pending`, `Ready` with the `Preview`, `WaitingForPress`, or `Failed` with its `reason`: `Refused`, `Unreachable`, `TimedOut`, `TooLarge`, or `NothingToShow`.
- **A `Preview` says what a link is,** as `kind`, `page`, `image`, `video`, `audio`, or `player`, with the `link` it was read from after any redirects, its `title` and `description` or `null`, its `site`, the name a page gives its site or else the link's host, and `type`, the media type of a link to media itself, or `null`. Every field but `kind` is `Untrusted`.
- **The changes are an item each time a Preview's state changes,** for every Frontend, whoever asked. A Preview is not journaled, so an event has no id and nothing resumes: a Frontend that follows again asks again for the Previews it shows.

### Removing

- **One list names every Network.** `GET /api/networks` reads the live and the kept as one state of the Daemon, so a Network removed with its Timelines kept is in it as `Live` or `Kept` however the removal falls, and one it does not name is not held.
- **Every answer about a Network names its life.** A `life` is the sequence of the `Configured` that began that life of the Network, the first after it was added or removed. It only increases for an id, and a restart or a rebuild gives the same, so an answer from a Network removed and added again under its id is told apart from the new one's. The Network list, `known`, each News event, each Timeline, each dropped Timeline and removal in the changes, and a removal's answer carry it.
- **A removed Network is gone from every route that acts on it.** It leaves `GET /api/networks`, and every route that acts on it or reads what its Client knows answers `UnknownNetwork`, as for a Network never configured. `said` and a Lookup by its intent still answer from the Journal. A Frontend following News learns of it from one `NetworkRemoved`, after which no News of it comes.
- **The Owner chooses whether its Timelines stay.** Kept, they are read and searched as before, listed by `GET /api/networks` as `Kept` and read by `GET /api/networks/{network}/timelines`, and each says `removed`, so a Frontend shows them apart and never says to them. Its id stays taken while they are kept: a `PUT` of it is `TimelinesKept`. Not kept, no route reads or finds them, the changes stream gives each as `dropped`, and the id is free at once.
- **A removal names the life it was made from,** so one asked about a Network that another Frontend removed or added again since is `LifeChanged`, and removes nothing.
- **Its Credentials go once its removal is journaled,** but those another Network's Configuration or an option under `store` names. A `VaultFailed` leaves the removal standing, and the Daemon forgets them when it next starts. A `JournalFailed` may too, since the removal may be journaled before what follows it fails: read the Network list to learn where it stands.

### Saying, acting, and looking up

- **A `say` or an `act` answers with what its step knew.** `Said` or `Acted` means it was sent, not that it reached the Ircd. `Refused` means the Client refused it in that step, as `Offline` or `Unsendable`. Either way it was journaled, at `sequence`, under `intent`. A `say` that `answers` a Message is sent with a `+reply` tag where the Session carries tags, which `known` says as `tags` of a registered Session, and without it where it does not, still said. Self's reply shows its `answers` as any reply does, whether or not the Ircd echoes it.
- **What happens after comes through the Timelines.** A Message's item says how its delivery stands, and an action the Ircd refuses later becomes an `ActionRefused` item, so a Frontend learns every outcome without reading News.
- **The wire refuses little, and the Client checks the rest.** The wire refuses a line break or NUL, and an empty name. The Client checks an action against the Network, and never cuts a Line short.
- **A CTCP request goes to one nick, never a Channel,** and `Ping` sends a `PING` whose reply tells the round trip. Nothing waits for a reply, so one that never comes holds nothing open.
- **A Lookup answers with what it found:** the Users a `WHOIS` or `WHOWAS` described, or a Channel's masks, `Listed`, with who set each and when where the Ircd said, and `cut` saying why a list stopped short. A list the Network does not keep, by its ISUPPORT, is `Refused` as `NotOffered`, and a refusal from the Network, such as `482`, is `Failed`. Each comes with any `WARN` or `NOTE` its reply held, and any `FAIL` after the first, in `notes`, waiting up to 35 s. `Pending` means no result came in that time: ask again by its intent. A Lookup changes nothing on the Network, so one whose outcome is uncertain can be asked again freely.
- **A Read Marker only moves forward, and every Frontend shares it**. Marking read is a Frontend's decision, and the Daemon only records it.
- **A closed Timeline comes back by itself.** A `close` is journaled, so every Frontend agrees and a restart keeps it. A Channel Self is in is never closed: its `close` answers `Refused` with `Joined`, naming the Channel as the Daemon resolved the Target, so `@#iirc` names `#iirc`, decided in the step that took it, so a Channel joined after the caller last looked is refused too, and a Target that names no one Timeline, such as a list, answers `NoTimeline`. Either is also News `Ignored`. A Timeline stays closed until a Message or an Activity arrives in it, which shows it again with its counts. Closing deletes nothing.

### News

- **News resumes exactly.** Each `happened` event is one step's News, and its event id is the sequence. A Frontend resumes with `after` or `Last-Event-ID`, misses nothing, and sees nothing twice. `heartbeat` events carry no id, so they never move its place.
- **News says where it belongs.** Each Message and Activity carries `where`, says which of the Owner's ignore masks its sender matched as `ignored`, folded, or none, and whether it is a `highlight` and whether Self said it, and a Message what it `answers` and its `context`, as an item does. A Frontend reads these and never works them out. A `StandardReply` Activity is where what it answers belongs, or the Network's own Timeline. A `CtcpRequest` carries what became of it: the answer sent, or why none was, and a `CtcpUnsent` follows where it was if that answer never left. A `CtcpSent` is a request the Owner sent, where that User's replies are, and a `CtcpReply` to the Owner's `PING` carries `roundTrip`, the milliseconds between when the Daemon journaled the request and the reply, and otherwise `null`. `OperGranted` and `OperRefused` answer the `OPER` Self sent as its Session began, in the Network's own Timeline. An `Invited` is an `INVITE` that names Self, by who invited and to which Channel, in the Network's own Timeline. An `AccountChanged` is a User logging in to an account, or out of theirs with `null`. An `Unignored` gives the masks the Owner took out of the Configuration, folded.

### Timelines

A Frontend reads Timelines and never folds News. The Daemon folds them.

- **A read says how far it was folded, and the changes follow from there.** Every Timeline read gives `version` and `through`, and reads that state whole. A Frontend that follows `GET /api/timelines/changes` from that place misses nothing and loses nothing to a race.
- **To hold every Timeline,** a Frontend reads the pages of the list in turn, then follows the changes after the smallest `through` the pages gave.
- **A window is read from one place:** `before`, `after`, or `around` a cursor, or the latest with none. `earlier` and `later` say whether more lie beyond each end. A merged Timeline's id reads the Timeline it went to.
- **A position travels as a cursor,** opaque text that compares exactly as positions do, so a Frontend places a Gap among items by comparing cursors.
- **A window's Gaps are bounded by its items.** Consecutive Gaps with no item between them come as one, counted, so a quiet Timeline that spans every reconnect gives one Gap, never a list of them all. Pages read at a cursor split a run at the cursor, so pages fitted together give every Gap once.
- **A removed Network's Timelines say so.** Each Timeline carries `removed`, set once its Network was removed with its Timelines kept.
- **A closed Timeline says so.** Each Timeline carries `closed`, set from its `close` until something arrives in it. A Frontend leaves it out of the Sidebar while it is set, and never works out whether it should be.
- **The Daemon counts what is unread.** Each Timeline carries `read`, its Read Marker, and `unread`, a count for each level of what stands after it, exact up to `unreadCap`, 999. Each item says its `level`. A Frontend shows the counts and never counts the items it holds, which are never all of them.
- **A reply says what it answers.** A Message's `answers` is the id a `+reply` tag names, and an item's `answered` is the Message with that id in the same Timeline, its position, sender, kind, and text, resolved as of the read, or `null` when the Timeline holds none. A live reply to a Message Self said is an item of level `Highlight`, which only the store can tell, so its News `highlight` stays `false`. A Direct Message's `context` is the Channel a `+channel-context` tag names, or `null`.
- **One of our Messages says how its delivery stands:** `Pending`, `Unconfirmed`, `Confirmed`, `Unsent`, or `Rejected` with the Ircd's numeric or code, never its text.
- **Every list comes a page at a time,** up to `limit`, 1 to 500 and 100 when left out, with `more` and an opaque `next` to give back as `after`. A `next` the Daemon did not give is `InvalidRequest`.

### The changes stream

- **It resumes exactly, by an opaque place,** `<version>.<sequence>`: what a read gave, or an event's id. Each `changed` event is what one folded step changed, as it stands now, `removals` each Network removed, with `keep`, whether or not it had Timelines, and `dropped` the Timelines a removal took with it, which a Frontend lets go. Something changed again comes again, so a Frontend keeps each thing by its id or position and takes the latest.
- **An event is bounded,** at 500 things. A step that changed more comes as `overflowed`, naming the Timelines to read again, or none, which says to read every one.
- **A place that cannot be resumed is reset.** A place stays good across a restart. One of another projection version, or ahead of what the store has folded, gets one `reset` event, which says to drop what is held, read again, and follow from its place.
- **It waits on the Daemon's folding, never polls, and never ends.**

### Channels and search

- **A Channel is read as the Client knows it now,** by its Timeline's id, never its name. These reads are of the Client, not the folded Timelines, so they carry no `version`: follow the changes to learn when to read again. An Activity in its Timeline or a Gap of its Network may change it, and so may what no item says, such as its modes becoming known, which moves its Timeline's `head` to that step's sequence. A change may be gathered from several steps, so a Frontend compares `head` with the one it last saw, never with the change's own sequence.
- **A Channel's head always answers,** with `standing`, where Self stands with it, `held`, the prefix modes Self holds there, and the Network's `PREFIX`, `CHANMODES`, `CHANTYPES`, and `lists`, the mode of each list of masks it keeps, so a Frontend parses a mode change, and offers a list, as the Client will check it. Its modes never hold a key: `k` is set with a `null` parameter.
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
| `UnknownNetwork` | 404 | No Network by that id was ever configured, or it was removed. |
| `UnknownTimeline` | 404 | No Timeline had that id, nor was merged from one that had. |
| `NotAChannel` | 404 | The Timeline is the Network's own or a Direct Message partner's, which it names as `kind`, so it has no Channel. A Timeline's kind never changes. |
| `NotInChannel` | 409 | Self is not in the Channel now, so it has no members to list. It says where Self stands with it, or `null` when the Client holds no such Channel. |
| `ConfigurationChanged` | 409 | A `PUT` of Configuration was made from another than the one now in force, which it names. Nothing was journaled. |
| `LifeChanged` | 409 | A removal named a life of the Network the Daemon no longer holds: it was removed, or added again, since. It names the life held, or `null`. Nothing was journaled. |
| `TimelinesKept` | 409 | A `PUT` of Configuration named a Network removed with its Timelines kept. Its id is free once they are dropped. Nothing was journaled. |
| `UiChanged` | 409 | A change of an option under `ui` was made from other options than those in force: another Change was journaled since, at `sequence`, the last. Nothing was journaled. |
| `OptionsChanged` | 409 | The same, for an option under `store`, `uploads`, or `previews`. |
| `UnknownMessage` | 404 | No Message stands at that position in the Timeline: nothing does, or an Activity does. |
| `PreviewsOff` | 409 | The Timeline's mode is `off`, its own in `ui.previews.timelines` or else `ui.previews`, so nothing was fetched. |
| `NotWaiting` | 409 | The link pressed is past the Message's previewable links, or is kept, being fetched, or in a Timeline that does not wait, so nothing was fetched. |
| `UnknownUpload` | 404 | No Upload has that id, or, asked for its bytes or to be renamed, it is deleted, or, asked for its bytes, the store confirms they are gone. |
| `UploadsOff` | 409 | Uploads are off, and `missing` names the options that are not set. Nothing was read or kept. |
| `UploadTooLarge` | 413 | The body passed `maxSize`, so it was cut off there, and nothing was kept. |
| `UploadUnreadable` | 422 | The body is a JPEG, PNG, GIF, WebP, HEIC, AVIF, MP4, or MOV, its `type`, whose structure could not be walked, as `reason` says, so its metadata could not be stripped, and nothing was kept. |
| `StoreFull` | 507 | Keeping the body would take the distinct bytes live Uploads hold past `maxTotal`, `uploads.maxTotal`, so nothing was kept, and nothing was evicted. Bytes a live Upload already holds add nothing, and deleting one makes room. |
| `StoreUnavailable` | 503 | The bucket could not be reached, refused what was asked, or a key the options name is not held, so nothing was kept or read. Bytes asked for while Uploads are off are this too. It is also the answer when the Daemon began to stop, and then the Upload may or may not have been kept, if the Daemon was already journaling it. |
| `NetworkStopped` | 503 | The Network stopped, so its outcome is `Uncertain`, below. |
| `TimelinesFailed` | 503 | The Timelines could not be read. They are derived, and a read that waited on a lock may succeed when asked again, while a damaged store is made again from the Journal when the Daemon restarts. |
| `VaultFailed` | 503 | The Vault could not read or write its file. It tries again on the next call, so once the Owner fixes the file or its directory, the same request succeeds. |
| `SignInsFailed` | 503 | The Daemon could not write its sign-ins, so nothing changed. It tries again on the next call. |
| `JournalFailed` | 500 | The Journal could not be read or written. A Network whose Journal failed stays stopped until the Daemon starts again, so asking again does not help. A change of an option that could not be journaled changed nothing, and stops nothing. |

A body over 1 MiB is refused with 413 before it is read, on every route but an upload's.

**`NetworkStopped` does not mean the input was refused.** The Network may have stopped after the input was journaled and before the Daemon answered, and a restart steps it. Its body says `outcome: "Uncertain"`, and for a `say`, the `intent` it was given under, even one the Daemon named. A `PUT` of Configuration, a `read`, a `close`, and a `retry` can be sent again freely. A `say` or an `act` must not be: ask `said` with that intent, on this Daemon or the one started after it. `Journaled` means it must not be said again. `NotJournaled` means saying it again under the same intent is safe. An intent must be unique for its Network across the whole Journal, which is the caller's to keep.

## Choices

- **`said` answers 200 with a tagged union**, not 404 for "not journaled". Whether a `say` was journaled is the answer to the question asked, not a failure to find something.
- **A Channel's head answers whether or not Self is in it, and its members do not.** Where Self stands is part of what a head shows, as `said` answers whether a `say` was journaled, so the head carries `standing` rather than failing. A member list of a Channel Self is not in does not exist, and a Frontend paging one should stop, so it is `NotInChannel`. A Timeline that is not a Channel's is `NotAChannel`, a 404, since no Channel lies behind it, then or ever.
- **A page of members sorts the one Channel on each request.** The Client keeps members by folded nick, not in rank order, so each page reads that Channel's members, ranks them, and sorts those after `after`. For 10,000 members that is about 1 to 4 ms, and a page through the API about 10 ms, which is cheaper than keeping an order up to date on every `JOIN`, `PART`, `NICK`, and `MODE`.
- **The Daemon names a `say`'s or an `act`'s intent when the caller does not,** so `NetworkStopped` can always say which intent to ask about.
- **A Lookup answers with its result, within a bound.** A Frontend asking `WHOIS` wants the answer, not a sequence to follow News for, so `POST` waits for it, and `Pending` past the bound keeps a request from hanging on an Ircd that never ends its reply. `GET` by intent answers 200 with a tagged union, as `said` does, since whether a Lookup was journaled is the answer to the question asked.
- **The Owner's actions are one route with a tagged action,** not a route each. Each is journaled, stepped, answered, and recovered alike, so one route says that once, and a new action is a new tag.
- **Configuration is one `PUT` of the whole of it,** as the Client takes it whole. There is no `PATCH` and no separate join or part.
- **An option is a route of its own,** `PUT` to set it and `DELETE` to unset it, since a Change is the whole value of one option. Its value travels as JSON and is parsed by the option's Schema in the Daemon, so the contract need not list a body for each option, and a new option needs no new route.
- **The options under `store`, `uploads`, and `previews` are one flat Struct, their own route and stream,** apart from `ui`'s. A Frontend lists them by the Struct's fields with no tree to walk, and finds the Credential options by their Schema's identifier. A name in a path is the full one, so a new root needs no new route. They get their own sequence, and `OptionsChanged`, since `UiChanged` would misname them and a write under one root should not go stale for a change under another.
- **A Message's Previews are asked for by the cursor a window gave its item,** rather than its sequence and index as two fields. The cursor holds both, and it is what a Frontend holds, so a script that reads JSON never takes a cursor apart.
- **The Previews' changes are their own stream, beside News,** not in it. News is what Clients derive from the Journal, and a Preview never enters it.
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
- **A search of several terms.** `text` is one run of characters, as a phrase. Terms that must all appear belong in a Frontend's query syntax, and then here.
- **Other Lookups, and Leave.** `WHOIS`, `WHOWAS`, and a Channel's bans, exceptions, and invitation masks are the Lookups the Client offers. Others, such as `LIST`, are new tags of `lookup` once the Client collects them, and until then their replies can be asked for as a raw Line, and read only as their Lines arrive.
