# @iirc/daemon

The Daemon: the composition root that wires the Runtime, the real Client, and the production adapters behind the API, and the handlers of `@iirc/api`'s contract.

```ts
import { layerDaemon, layerLogger } from "@iirc/daemon";

// Runs until interrupted, which SIGINT and SIGTERM do through BunRuntime.runMain.
Layer.launch(layerDaemon({ dataDir: "/var/lib/iirc" }, { host: "127.0.0.1", port: 7667 })).pipe(
  Effect.provide(layerLogger),
  BunRuntime.runMain
);
```

| Export | Role |
| --- | --- |
| `layerDaemon(options, listen?, beside?)` | The Daemon, serving the API on `listen` for as long as the Layer lives. It also provides its `HttpServer`, so a test can find an ephemeral port. `beside` is a Layer of routes served on the same origin, such as `iirc daemon --web`'s, which the Daemon knows nothing of. |
| `defaultListen`, `Listen` | Where the API listens unless told: `127.0.0.1:7667`. |
| `Beside` | The type of those routes: a Layer that adds to the `HttpRouter`, and may use the server's `FileSystem`, `Path`, and file responses, and read the `ui` options in force through `UiConfiguration`. |
| `DaemonOptions` | `dataDir`, the Transport's options, the `heartbeat` (15 s), the Runtime's `pacing` (a burst of 5, then one Line every 2 s), `hangupDrain` (5 s), and `stopTimeout` (5 s), iirc's `version`, and `linkFetch`, how Previews fetch a link: the guard under the fixed policy unless given. |
| `version` | iirc's version, `0.0.0`, which `iirc --version` prints, the link fetch names in its user agent, and the Daemon logs as it starts. |
| `layerLogger` | logfmt on stderr, `Info` and above whatever the minimum level in force is, so stdout holds only what a command was asked for. |
| `Tail`, `layerTail(version)`, `layerTailLogging(version)`, `tailCapacity` | The Tail, below: the service, the Layer that makes it alone, the Layer that also puts its Logger in force, and how many lines it holds (4096). |
| `ApiHandlers`, `ApiRoutes` | The handler groups with request validation and the Key and Sign-in check, for an in-process client, and those as routes with the body limit and `Cache-Control: no-store` on an unavailable Upload or image. They need `Runtime`, `Vault`, `TimelineStore`, `Projector`, `UiConfiguration`, `OwnerConfiguration`, `Uploads`, `Previews`, `Following`, `Tail`, `ApiKeys`, and `SignIns`. |
| `maxBodySize` | The largest body a route but an upload's reads: 1 MiB. |
| `Heartbeat`, `ChangesPage` | How often every stream a Frontend follows says it is alive (15 s), and how many things one event of the Timeline changes holds at most (500). Each is a reference a test may set. |
| `createKey(dataDir, name)`, `KeyName`, `KeyExists`, `KeysUnreadable`, `KeysUnwritable` | `iirc key create`: makes a Key, stores its hash, and gives the Key once. Call it with the data directory held. |
| `ApiKeys`, `HeldKey` | Checks a presented Key against `keys.json`, read once at start. |
| `SignIns`, `SignInsUnreadable`, `SignInsUnwritable` | Makes, checks, and ends Sign-ins, kept in `sign-ins.json`. |
| `holdDataDirectory(dataDir)`, `DataDirectoryLocked`, `DataDirectoryFailed` | Holds a data directory exclusively for the enclosing Scope. It fails with `DataDirectoryLocked` when another holds it, and `DataDirectoryFailed` when it cannot be opened. |
| `Projector`, `ProjectorStatus`, `Progress` | Whether the Timelines are being folded, `Running` or `Stopped { reason }`, now as `status` and as it changes as `statuses`, and `folded`, the projection version and the last sequence folded, together. |
| `layerProjector` | The projector alone, given a `Runtime` and a `TimelineStore`. |
| `UiConfiguration`, `layerUiConfiguration`, `UiChangedSince` | The options under `ui`, folded from the Journal's Changes, and how a Change is checked and journaled, failing with `UiChangedSince` when made from other options than those in force. The Layer needs the `Journal`. |
| `Uploads`, `layerUploads(dataDir)`, `ByteStoreMaker` | The Uploads, below. The Layer needs the `Journal`, the `Vault`, `OwnerConfiguration`, the file system, `SecureRandom`, `StoreBytes`, and a `ByteStoreMaker`, which makes the byte store from the Store's options and keys: `makeS3ByteStore` in the Daemon. |
| `layerLinkListener` | The Link listener, below, given `Uploads` and `OwnerConfiguration`. |
| `Previews`, `layerPreviews` | A Message's Previews, below, each change of one, and the images they hold. The Layer needs `LinkFetch`, `PreviewCache`, the `TimelineStore`, `UiConfiguration`, `OwnerConfiguration`, the `Vault`, `StoreBytes`, `Uploads`, and a `ByteStoreMaker`. |
| `Following`, `layerAwayWhenClosed` | How many Frontends are open, and Self marked away and back by it, below. The Layer needs the `Runtime`, the `Journal`, and `OwnerConfiguration`. |
| `StoreBytes`, `layerStoreBytes` | The bytes Uploads and Previews share in the Store, below. The Layer needs `PreviewCache`, and the Uploads and the Previews must be given one instance of it. |

## The data directory

| File | What | Written by |
| --- | --- | --- |
| `journal.sqlite` | The Journal | `@iirc/journal-sqlite` |
| `views.sqlite` | The Timelines, derived from the Journal | `@iirc/timeline-store-sqlite`, by the projector |
| `previews.sqlite` | The Previews, kept by link | `@iirc/preview-cache-sqlite`, by Previews |
| `credentials.json` | The Credentials, mode `0600` | `@iirc/vault-file` |
| `keys.json` | The Keys as SHA-256 hashes, mode `0600` | `iirc key create` |
| `sign-ins.json` | The Sign-ins as SHA-256 hashes, mode `0600` | the Daemon |
| `daemon.lock` | The lock below. It holds nothing | the Daemon and `iirc key create` |
| `staging/` | Uploads' bodies as they arrive, a file each, mode `0600`, in a directory of mode `0700` | the Daemon |

Each SQLite database also has its `-wal` and `-shm` files beside it.

- **The Daemon makes the directory, mode `0700`, if it is missing.** Nothing else is read at start: there is no configuration file.
- **`views.sqlite` is derived.** Removing it while the Daemon is stopped rebuilds it on the next start.
- **`previews.sqlite` is a cache.** Removing it while the Daemon is stopped loses nothing but fetches.
- **`staging/` is emptied as the Daemon starts.** A staged body lives only as long as its upload.
- **One Daemon to a directory.** The Daemon holds `daemon.lock` before it opens the Journal or the Vault. A second Daemon, in this process or another, or `iirc key create` while one runs, fails with `DataDirectoryLocked`. A crash never leaves the directory locked.

## Timelines

The projector keeps `views.sqlite` folded up to the Journal, with the fold of `@iirc/timelines`.

- **On start, it resumes or rebuilds.** A store built by the same `projectionVersion` resumes after the last sequence it folded. Any other, a new or emptied one included, is reset to `projectionVersion` and folded from the start of the Journal, which is logged.
- **Each step is applied whole,** with its sequence as `through`, in one transaction. A step at or before the last one folded changes nothing, so resuming never folds a step twice.
- **It never holds up the Runtime or a Network.** It follows the Journal on its own, so a slow or stopped projector holds back only itself.
- **A failure stops it, and nothing else.** A store that cannot be written or read, or a Journal that cannot be followed, stops it: the error is logged with its reason, `Projector`'s status becomes `Stopped` with that reason, and the Daemon and every Network go on. A restart tries again.
- **A store that cannot be opened at start is a refusal,** as a Journal that cannot be opened is.
- **The store may lag the Journal, never lead it.** After a crash, what the store lost of the last steps is folded again on start.
- **Read Markers, unread counts, and whether a Timeline is closed are the projection's.** A `read` and a `close` are journaled and stepped like any input, and the store derives the rest, so a restart, or a store folded again, gives the same answer to every Frontend.
- **`Projector.folded` gives `{ version, through }` together,** from where it resumed, or the version it reset to with no `through`, and again once each step is kept.

## The options

The options under `ui` are a projection of the Journal's `UiSet` and `UiUnset` Changes, in `src/ui.ts`, and those beyond `ui` of its `OptionSet` and `OptionUnset`, in `src/options.ts`, folded and kept the same way.

- **Each has a sequence of its own.** A change of one never makes a write to the other stale.
- **On start, they are folded from the Journal,** the latest of each option winning, so a restart gives the same options. An unset returns an option to its default, or, beyond `ui`, to none.
- **A Change the Daemon cannot read changes no option.** One of an option it does not have, or of a value its Schema does not take, still counts as the last sequence.
- **A value is read as the option is now.** A `ui` value kept under an earlier name or form is read by the contract's `uiValueKept`. `theme.imported` and `aliases` are read entry by entry, so an entry the Schema refuses is dropped alone and the rest kept.
- **A change is checked and journaled in one turn.** Comparing `ifSequence`, appending the `Change`, and holding it are one uninterruptible step, so two changes made from the same options never both pass, and what is held never differs from the Journal.
- **The stream reads nothing from the Journal.** It gives the options in force, then again each time a Change is held.
- **The Runtime spares the Credentials they name.** The options beyond `ui` are folded before the Runtime starts, so a Network's removal never forgets a key the Store's options name, even one cut short and finished as the Runtime starts. A key named while a removal is deciding what to forget waits for it.

## Away while no Frontend is open

Self is marked away on every Network once no Frontend has been open for `away.after` minutes, and is back once one has been open for 30 seconds, in `src/away-when-closed.ts`. It is off until `away.after` is set.

- **Open is following News.** A Frontend is open while it reads the News stream or the Timelines' changes. It says nothing else to be counted.
- **Going away and coming back are the Owner's own acts.** Each is an `Away` act on the Network with `away.message`, `Away` unless set, journaled and stepped as `/away` and `/back` are, so it lasts across Sessions. Its intent starts `away-when-closed-`.
- **It never fights the Owner.** Going away passes over a Network the Owner already marked away. Coming back takes back only an away this marked, as the last `Away` act on the Network says, and that holds across a restart.
- **A Frontend open for a moment changes nothing.** Each wait runs from the latest change, by Effect's `Clock`.
- **Unsetting `away.after` while away comes back at once.**

## Uploads

The Uploads are a projection of the Journal's `Uploaded`, `Renamed`, and `Deleted` Changes, in `src/uploads/`, and their bytes are kept in the Store by their hash (ADR 0016).

- **On start, they are folded from the Journal,** so a restart gives the same Uploads, named and deleted as they were, in the same order. A Change that names no earlier `Uploaded`, or does not parse, changes nothing, nothing changes a deleted Upload, and an `Uploaded` or a `Deleted` applied twice is applied once.
- **A Change is journaled through the projection.** Appending it and holding it are one uninterruptible step and one turn, so what is held never differs from the Journal. Each carries `at`, from Effect's `Clock`.
- **Upload Changes and pages come from what is held, never the Journal.** A page and its `through` come from one read, so they always agree, and a resume after a sequence gives every Change since with no gap and none twice.
- **A rename keeps the link.** It journals `Renamed` with the new name and a safe name made from it, by the same rules. A deleted Upload, like an unknown one, cannot be renamed.
- **A delete is at once, and the record stays.** From its `Deleted`, the link and the API's `content` answer the Upload as an id no Upload has, before the Store is asked. Deleting one already deleted journals nothing, and only tries again to release its bytes.
- **An Upload expires once it is older than `uploads.expireAfter` days.** While the option is set, the Daemon journals `Deleted` with `why` `expired` for each live Upload strictly older, at start and every hour after, then releases its bytes as a delete does. A pass the Journal fails is logged and tried again at the next.
- **Bytes are released once no live Upload and no Preview has them,** in `src/store-bytes.ts`. The Store keeps one copy of each hash, which Uploads and Previews share.
- **Bytes being put are never released.** An upload or a Preview's image claims its hash before it puts, and lets go once it is recorded or has failed. One whose release is in progress waits for it, then puts them again.
- **A release that cannot be decided or done leaves the bytes.** A Preview cache that cannot be read, a Store that cannot release, or Uploads that are off, is logged, and the delete still succeeds.
- **Missing bytes are learnt from the Store, never journaled.** A read for a link or `content` that the Store answers with not found marks every live Upload with that hash missing. A read that finds them, an upload that puts them again, or a change of the Store's options clears the mark. A Store that cannot be reached marks and clears nothing, and a restart forgets every mark.
- **A deleted Upload is never missing,** and stays 404 when its bytes come back.
- **Where an Upload was said is read, never held,** from a search of the Timelines as the projector has folded them, in `src/uploads/said.ts`. Only Messages whose text holds `/<id>/` exactly count, by the text the Ircd confirmed once it did, and one the Ircd refused does not. A fresh upload is answered with none.
- **Whether Uploads are on is derived from the options in force,** never held apart from them.
- **The Store follows the options.** It is made from the options and the two Credentials each time it is used, so a change of either reaches the next upload or link. A Credential the options name that is not held, or a Vault that cannot be read, is an unavailable Store.
- **A body streams to `staging/`,** hashed and counted as it arrives, never bounded by `maxBodySize`.
- **`uploads.maxSize` is read as an upload begins.** The chunk that would pass it is never written: the upload stops reading and answers 413.
- **An upload answered with any error closes its connection,** so a body left unread never holds up the server.
- **Then it is kept, in order.** Its type is read from the first 4 KiB staged, an image or video is stripped, room under `uploads.maxTotal` is reserved, the bytes are put to the Store, the id is drawn, 80 bits from `SecureRandom`, and the name made safe, and the `Uploaded` is journaled with the hash and size of what was kept.
- **A failed upload leaves nothing.** The staged file is removed however the upload ends, so a failure, an interruption, or a client that goes away leaves nothing staged and nothing journaled.
- **Uploads stay within `uploads.maxTotal`, by refusing.** An upload whose bytes would take the distinct bytes of the live Uploads past it is `StoreFull`, with nothing put, journaled, or evicted. Bytes a live Upload already has add nothing. The option is read as the room is reserved.
- **Uploads and Previews count apart.** A Preview's image counts toward `uploads.maxTotal` only once an Upload holds the same bytes, and an Upload's bytes toward `previews.maxTotal` only once a Preview holds them.
- **Two uploads that fit alone but not together never both pass.** Room is reserved by hash before the put and held until the upload ends.
- **An upload in flight when the Daemon begins to stop is cut off** with 503, without waiting for it. One that had begun to journal finishes, so it may or may not have been kept.

### Stripping

An image or video is stripped of its metadata, with no way to skip it, by a walker in `src/uploads/strip/` that keeps by a keep-list and re-encodes nothing, so the image or media data is kept byte for byte. Any other type is kept as it came.

| Type | Keeps |
| --- | --- |
| JPEG | Its tables, frames, and scans, ICC, Adobe's colour transform, JFIF without its thumbnail, and an EXIF of Orientation only. It is cut at the end of its primary image, which drops a motion photo's video and MPF's secondary images |
| PNG, APNG | Its image data, colour, `bKGD`, `pHYs`, animation, and an `eXIf` of Orientation only |
| GIF | Its images, the graphic controls that apply to them, looping, and its ICC profile |
| WebP | Its image data, alpha, ICC, animation, and an `EXIF` of Orientation only, with `VP8X` and the RIFF size rewritten to match |
| HEIC, AVIF | Its image items with their codec, size, colour, orientation, and cropping. Every other item, Exif and XMP among them, is dropped with its data |
| MP4, MOV | Its picture, sound, text, and timecode tracks with their sample tables. Any other track, a phone's timed-metadata track of locations among them, is dropped with its samples, and every other box, `udta`, `meta`, `uuid`, and XMP among them, is retyped `free` and zeroed where it lies |

- **A JPEG, PNG, GIF, or WebP is stripped in memory,** so stripping one takes up to twice `uploads.maxSize`.
- **A HEIC, AVIF, MP4, or MOV is patched in place in the staged file,** at the same length, so no video is held whole.
- **A file that cannot be walked is refused** with 422.
- **An MP4 or MOV is refused when which of its samples to drop is not known:** media with no `moov`, a dropped track whose sample table is missing or ambiguous, or fragments holding samples of a dropped track, since zeroing a fragment's samples is not built.
- **A file cut short keeps what was walked whole, once there is an image to keep.** A JPEG cut within its scans, or a PNG, GIF, or WebP cut after its first image data is whole, is kept to there. One cut short earlier, or a HEIC, AVIF, MP4, or MOV with a box cut short or lying about its size, is refused.

### The Link listener

The Link listener, in `src/link-listener.ts`, is a second HTTP server, never a route of the API, which serves each Upload at its link and nothing else.

- **It follows the options.** It is bound at `uploads.listen` while Uploads are on and that is set, rebound when it changes, and closed when either stops being so. A rebind closes the old binding first, so it finds its port free.
- **A binding that fails is logged,** and the listener stays closed until the options change again.
- **It answers `GET` and `HEAD` of `/<id>/<anything>`, by the id alone.** Everything else is 404. It reads no cookie and no Key, ignores the host a request names, and offers no listing or index.
- **Every answer carries** `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox allow-downloads; default-src 'none'`, `Access-Control-Allow-Origin: *`, `Referrer-Policy: no-referrer`, and `Cross-Origin-Resource-Policy: cross-origin`.
- **An Upload is served as its record says.** Its `Content-Type` is the type read from its bytes, and its `Content-Disposition` names its safe name, as an ASCII `filename` and as `filename*`.
- **Only PNG, JPEG, GIF, WebP, AVIF, MP4, MOV, WebM, MP3, Ogg, FLAC, WAV, M4A, and plain text are `inline`.** Everything else, HEIC, SVG, HTML, XML, and PDF among them, is an `attachment`.
- **Every view is checked again.** It is `Cache-Control: no-cache` with a strong `ETag` of the id, never the hash, so a deleted Upload stops being served at the next view. An `If-None-Match` holding it, weakly compared, or `*`, is `304`.
- **Media can seek.** One byte range is `206` with `Content-Range`, unless an `If-Range` is not the `ETag`, and one beginning past the end is `416`. Several ranges, another unit, and a range that does not parse are answered whole.
- **A `HEAD` is answered with the headers its `GET` would have.**
- **The Store is asked first, whatever a request holds.** An Upload no one has, one deleted, or one whose bytes the Store confirms are gone, is a plain-text 404, and a Store that cannot be reached is 503 with `Cache-Control: no-store`.
- **The API's `content` serves the same bytes the same way,** from one builder in `src/uploads/serving.ts`. Only what neither can serve differs: the API answers with its own errors.

## Previews

A Preview is a cache outside the Journal (ADR 0017), in `src/previews/`. The Daemon fetches a stranger's link only through the link fetch port, `@iirc/link-fetch`, whose production adapter is the guard, `@iirc/link-fetch-bun`.

### Asking

- **A Timeline's mode is read as journaled:** its entry in `ui.previews.timelines`, else `ui.previews`. An entry for a Timeline that does not exist is never read.
- **A link is kept by its address without its fragment,** in `previews.sqlite`, so one link in many Messages, or asked by many Frontends, is fetched once. Its id is the first 128 bits of that address's SHA-256.
- **An ask while a link is fetched joins that fetch.** Only the links being fetched are held in memory, and a restart keeps every Preview.
- **A link is never fetched twice at once.** Checking the cache and claiming a fetch are one turn with keeping an outcome.
- **A ready Preview is fetched again after a day.** One older than that is served as it is meanwhile, and the changes stream carries the new one.
- **A failure is fetched again after an hour.** One older than that is `Pending` meanwhile.
- **Asking moves when the link was last shown.**
- **A cache that cannot be read is a miss,** and one that cannot be written still publishes the outcome, each logged as a warning.
- **A held read changes nothing.** It never fetches, claims a flight, writes the cache, or publishes a change, and it does not count as showing a Preview, so it keeps no image from eviction.
- **A held read answers a link being fetched as its flight's state,** `Pending`, or the old ready Preview while it is fetched again, and a kept one as it is, whatever its age. Otherwise a link is `WaitingForPress` in a Timeline that waits, and `NotHeld` in any other.
- **A held read sees a link settling meanwhile,** in flight or in the cache.
- **A Direct Message with no entry in `ui.previews.timelines` waits for a press.** A kept link is served whatever its age, unless its image was evicted, and one being fetched as its fetch. A press of a kept link is `NotWaiting`. A Direct Message with an entry behaves as a Channel.
- **A press starts its fetch as an ask would,** under the Timeline's mode, and is decided in the same turn as claiming the fetch, so two presses fetch once.
- **Each change of a state is published** to every follower of the changes stream, `Pending` as a fetch starts and its outcome as it ends.
- **A fetch runs in the Daemon's Scope,** so it ends when the Daemon stops.

### Fetching

- **A fetch tells the link fetch where it stands.** A link fetched again is a `refresh` when a ready Preview stands for it and a `first` when a failure does, so a refresh waits behind any link never fetched. A page's oEmbed and image, and a stream, are `begun`, so a Preview already begun is finished before a page asked later starts. Of the rest, the latest ask goes first.
- **An error status is a failure,** `AnsweredError`, whatever its type, and its body is never read.
- **A page's head is read** by the pure reader in `src/previews/read.ts`.
- **A page's oEmbed fills only what its tags left empty.** Only `<link rel="alternate" type="application/json+oembed">` is followed, fetched as `oembed` once the page's own fetch is over. It gives the title, the author as the site, and the thumbnail as the image when the tags name none. Its `html` is never read, and a failure there leaves the page as it was.
- **An answer of an image, video, or audio type is a text Preview of its kind,** with its type, and its host as its site.
- **An answer of `text/plain` is a `file` whose description is its first lines.** Its body is read to the link fetch's bound of 16 KiB, in the character set its byte order mark says, else its `Content-Type`'s, else UTF-8, with line breaks as LF and indentation kept, cut to 500 code points, and none when it is only whitespace.
- **Any other answer that is not a page is a `file`** from its headers alone: no title, its declared `type` and `size` or none, and its body never read.
- **A file has no image,** so it is answered whole under `text` and `on` alike.
- **A failure is its reason,** from the link fetch's error: refused, unreachable, timed out, or too large. A page with no title, no description, no player, and no video file is `NothingToShow`. Anything unforeseen is unreachable, so no Preview stays pending.
- **A ready Preview fetched again that fails is that failure from then on,** and a failure is kept as a Preview is.

### Images

- **Under `on`, with the Store set, a Preview's image is kept in the Store.** A page's image address, or the link itself when it is an image, is fetched as `image` and put to the Store as an Upload's bytes are. The mode is read when a link is asked.
- **An image records its hash, size, and type, and whether it moves,** an animated GIF, WebP, or APNG, read from its bytes in `src/previews/animated.ts`.
- **An image records its `dimensions` where its header states them,** in `src/previews/dimensions.ts`: a PNG, a GIF, a JPEG turned by its EXIF Orientation, a WebP, an AVIF turned by its `irot`, and an SVG whose root has a plain-pixel `width` and `height` within its first 4 KiB. A zero, a size past 32768, a header cut short, or bytes that state no size give `dimensions: null`, never a failed Preview.
- **Under `text`, or with no Store, no image is fetched.**
- **Whatever goes wrong with the image leaves the Preview text only,** with a warning in the log.
- **A Preview kept before the mode became `on` gains its image when it is next fetched,** and one kept before images carried a size gains its `dimensions` the same way.
- **Images stay within `previews.maxTotal`,** which counts the bytes the cache refers to, never an Upload's. Before an image is put, the Previews shown least recently lose their images, one hash at a time, until it fits. Images are put one at a time, so the total is exact.
- **An evicted Preview serves its text,** and its image is fetched again the next time it is asked, in any Timeline, even one that waits for a press, however recently it was fetched. A held read fetches nothing. An Upload of the same bytes keeps its link.
- **An image larger than `previews.maxTotal` is not kept,** and evicts nothing.
- **A cache that cannot be read or written fails the image,** which leaves the Preview text only.
- **An image is served on the API's own origin,** at `/api/previews/images/<hash>`, so no browser fetches the host it came from.
- **Only an image a kept record refers to is served.** Any other hash, bytes the Store no longer holds, or bytes whose leading KiB sniffs as none of the six image types, is `UnknownImage`. No Store, a Store that cannot be reached, or a cache that cannot be read is `StoreUnavailable` with `Cache-Control: no-store`.
- **An image's type is sniffed from its leading bytes,** as the guard sniffs them, never taken from what was recorded, with `X-Content-Type-Options: nosniff`.
- **A browser keeps an image for good.** Its `200` and `304` carry `Cache-Control: private, max-age=31536000, immutable` and the hash as its `ETag`, and an `If-None-Match` that names it is `304`.
- **An image is sandboxed,** with `Content-Security-Policy: default-src 'none'; sandbox`, or for an SVG `default-src 'none'; style-src 'unsafe-inline'; sandbox`.

### Players and streams

- **A player is read only from a host the Owner lists.** Of the addresses a page names as its player, `og:video:secure_url`, `og:video:url`, `og:video`, then `twitter:player`, `src/previews/players.ts` takes the first that is `https`, has no credentials and no port, and whose host is exactly one of `ui.previews.players`, never a suffix, a prefix, or a look-alike.
- **A YouTube player is read as `www.youtube-nocookie.com`,** from `youtube.com`, `www.youtube.com`, or `m.youtube.com`.
- **A page with a listed player is a `player` Preview,** even with no title or description, with the player's address and the size its `width` and `height` tags give when both are positive whole numbers. Its image is its poster.
- **Nothing is fetched from a player's address.**
- **Removing a host takes effect at once.** The list is read when a page is fetched and again whenever a kept Preview is answered or carried on the changes stream, so a host removed, or `text`, answers a kept player as a page.
- **A page whose `og:video:type` is `video/*` is a video,** ranked above a player, its `stream` that file and its image its poster. Nothing is fetched from the file while the page is read.
- **A link answering video or sound is a Preview of its kind** with itself as its `stream`, read from its headers, its body never read.
- **A stream plays only the `stream` the Daemon recorded** for its kept, ready Preview of kind `video` or `audio`, never the query's, the Message's, or the page's own. A Direct Message's waiting for a press does not apply.
- **A single `bytes=N-` or `bytes=N-M` `Range` is passed on,** and any other is ignored.
- **A stream is bounded at 200 MiB.** A start at or past it is `416` with no fetch, no end passes it, and a body that passes it in the guard, or fails there any other way, cuts the response off.
- **The host's `200`, `206` with its `Content-Range`, or `416` is answered.** Any other status, or a type that is not video or sound, is `StreamFailed` with `NothingToShow`.
- **A stream's body is the host's type,** with `nosniff`, `Cache-Control: private, no-store`, and a sandbox.

### The fetch log

- **Each fetch logs one line once its Scope closes,** in `src/previews/fetch-log.ts`: `Fetched a link for a Preview` at `Debug`, so the Tail keeps it and stderr never prints it.
- **The line says what the fetch came to:** the `link` asked, what it was fetched `as`, a stream's range, the link that `answered` after redirects, its `status` and `type`, how many `bytes` were read, and how long it `took`, its wait for a turn included.
- **A page's line says whether it gave** a `title`, a `description`, an `image`, a `player`, a `video` file, and an `oembed` address, as `yes` or `no`, never what they say.
- **A failed fetch's line says so** as `failed`, its reason's tag, with `why`, the reason's words, where it has them.
- **Nothing of a body is logged.**
- **A stranger's words cannot break the line.** Each control, line or paragraph separator, and bidirectional control is written as its code point, such as `\u{a}`, and the words are cut at 2048 characters.

## Keys

`keys.json` is versioned JSON, written as vault-file writes its file: to a temporary file with mode `0600`, synced, renamed into place, and the directory synced. A crash leaves the old file or the new one.

```json
{
  "version": 1,
  "keys": [{ "name": "phone", "sha256": "…64 hex digits…", "created": "2026-11-10T00:00:00.000Z" }]
}
```

- **A Key is 256 random bits,** from Effect's `SecureRandom`, written `iirc_` and base64url. It is shown once, by `iirc key create`, and kept only as its SHA-256.
- **A presented Key is compared against every stored hash in constant time,** so the time taken says nothing of which Key matched, or how much of one.
- **Keys are made only while the Daemon is stopped.** `iirc key create` holds the data directory, and the Daemon reads `keys.json` once at start.
- **A Daemon with no Keys warns,** and refuses every request that needs a Key or a Sign-in.

## Sign-ins

`sign-ins.json` is versioned JSON, written as `keys.json` is.

```json
{
  "version": 1,
  "signIns": [
    {
      "created": "2026-11-10T00:00:00.000Z",
      "key": "phone",
      "keySha256": "…64 hex digits…",
      "sha256": "…64 hex digits…"
    }
  ]
}
```

- **A Sign-in is 256 random bits,** written `iirc_s_` and base64url, kept and compared as a Key is. The Key it was exchanged for is never stored, logged, or sent back.
- **A Sign-in survives a restart,** and lasts until it is signed out or its Key is no longer held.
- **A Key made again under the same name does not bring back the old one's Sign-ins.** A Sign-in names its Key by name and by the Key's SHA-256, and at start the Daemon drops every Sign-in whose Key it does not hold, from the file too.
- **A change is written before it takes effect,** so a sign-in or sign-out that could not be written changes nothing and answers `SignInsFailed`.
- **A request that goes away mid-write leaves the file and memory agreeing.**
- **A sign-out the file already holds is a sign-out.**
- **The cookie is `HttpOnly`, `SameSite=Strict`, `Path=/api`, and `Max-Age` 400 days.** It is `Secure` only when `X-Forwarded-Proto` says the browser's connection was `https`, which the Owner's own reverse proxy says (ADR 0006).
- **Signing out clears the cookie with the same attributes,** whether or not its Sign-in existed.

## The Tail

The Tail is the last 4096 lines the Daemon logged at `Debug` and above, in its memory. Nothing is journaled or projected for it, and a restart empties it.

- **Every fiber the Daemon runs logs into it,** the Runtime's Networks, the handlers, and the projector among them. `layerTailLogging` adds its `Logger` to those already in force and sets `MinimumLogLevel` to `Debug`.
- **Its first line is the Daemon's start,** at `Info` with a `version` annotation.
- **A line is plain text.** `message` is the words, a string as it is and any other part formatted, joined by a space, `annotations` are each as text, and `cause` is `Cause.pretty` when there is a cause.
- **A line at `Trace` is not kept.**
- **A line's `n` counts from 1 for this Daemon,** so a line dropped from the 4096 leaves its number unused.
- **Following reads the lines held, then goes live, with none missed or doubled.**
- **A follower that falls more than 4096 lines behind loses the oldest,** as the Tail itself does.
- **stderr is not the Tail.** `layerLogger` writes `Info` and above whatever the minimum level, so the Tail's `Debug` lines never reach it.
- **An option's change is logged once at `Info`,** as `Changed a ui option` or `Changed an option`, with the option's name and never its value.

## Composition

- **The core is provided outside `HttpRouter.serve`,** so the Journal, the lock, and everything shared are built once.
- **The Runtime stops first, gracefully.** On SIGINT or SIGTERM each Network steps a `Stopping`, the Client says `QUIT` and hangs up, and the Runtime waits for each Connection's `Closed` within `stopTimeout`. Every Owner input still waiting fails with `NetworkStopped`.
- **Then every stream a Frontend is reading ends, and every upload in flight is cut off.**
- **Then the rest closes in order:** serving, then Previews, then the projector before the Timeline store, the Link listener before the Uploads, the `ui` options, and away-when-closed, then the shared bytes and the Preview cache, then the options beyond `ui`, then the Journal, the Vault, and the Transport, then the lock, and last the Tail.
- **The projector folds while the Runtime stops,** since it follows the Journal, and an apply in flight when it is interrupted is kept whole or not at all.
- **Serving waits at most 500 ms for requests in flight,** and cuts a stream whose reader has stopped reading.
- **A stop takes about `stopTimeout` plus 500 ms,** since Networks stop side by side. A service manager's stop timeout must stay above that. A Journal append already in flight is not bounded, so a stalled disk lengthens a stop.
- **A hang-up drains for at most half of `stopTimeout`,** so the `QUIT` fits.
- **Every log goes through `Effect.log*`,** annotated with the Network where there is one.
- **Each Connection's dial, Session, and end is logged at `Info`,** with its Ircd and the reason it ended.
- **A Credential is logged by name only,** when it is held or forgotten.
- **HTTP requests are not logged.**

## The handlers

- **Errors are mapped, never leaked.** The Runtime's `UnknownNetwork`, `NetworkStopped`, `ConfigurationChanged`, `TimelinesKept`, `LifeChanged`, and `JournalFailed`, the Vault's `VaultFailed`, and the Timeline store's `TimelineStoreFailed`, as `TimelinesFailed`, become the contract's own.
- **A change of an option is parsed by its Schema, then checked and journaled.** `UiChangedSince` becomes `UiChanged`, and `OptionsChangedSince` becomes `OptionsChanged`.
- **A `PUT` of Configuration is checked in the Network's own turn,** so the handler holds no lock and two racing `PUT`s cannot both pass.
- **The Daemon names a `say`'s, an `act`'s, or a Lookup's intent** when the caller does not: 128 bits from Effect's `Random`, as hex.
- **The wire forms are total maps** in `src/wire.ts`. A field the Client adds to News, Knowledge, or the inspection, a field the contract has and the Client does not, or a new variant, fails to compile until the contract catches up.
- **A request that does not decode never has its input quoted,** since a body can carry a Credential's value.
- **A body over 1 MiB is refused unread** with 413 and `Connection: close`, on every route but an upload's.
- **The health check reads only `Projector`'s status.** The reason it stopped stays behind the Key check, in the projection stream, since it can hold a path.
- **A Key in `Authorization: Bearer` is tried before the `iirc_sign_in` cookie,** and either gives the handler the Key's name as its `Caller`.
- **Each News reader follows the Journal on its own,** so a reader that reads nothing holds back only its own response.
- **A Timeline read, or a search, is read in one state of the store,** so what it gives, its `version`, and its `through` agree.
- **A Network neither running nor removed with its Timelines kept is `UnknownNetwork`** before the store is read.
- **A window reads at most `limit + 1` runs of Gaps,** since the store collapses them between each two items.
- **An export is streamed 256 items at a time,** each page read only once the one before is sent, so a long Timeline is never held whole. Pages are not read together, so an item folded during an export may or may not be in it. Its lines and file name are written in `src/export.ts`.
- **A Channel's head and members read only that Channel from the Client,** through its Timeline, following a merged id.
- **Members are `NotInChannel` unless Self has joined the Channel.**
- **A page of members is ranked and filtered** in `src/members.ts`.
- **The changes stream reads whole steps,** at most `ChangesPage` things an event, and waits on `Projector.folded` with nothing more to read, so a reset is seen at once, even by a follower whose old sequence the store never reaches again.
- **The changes stream waits and sends heartbeats while the projector is stopped.**

## Tests

`bun run test` uses no network. The handlers run through an in-process client (`HttpApiTest`) on the Runtime's in-memory ports and a `TestClock`, and the routes over a real Bun server on a loopback port the kernel picks. Previews are tested with the link fetch's fake, which answers by link and records what it was asked, and with the byte store in memory.

`bun run e2e`, at the root or in this package, runs `src/e2e/` and is never part of `bun run test`. Each run drives a real Daemon, with the production adapters, through its HTTP API alone, and plays the other User over a raw IRC connection. The Ircds are private, on loopback ports the kernel picks, never port 6667.

- **ngircd** is `~/.local/opt/ngircd/ngircd`, or `IIRC_NGIRCD`, with a configuration of its own in a temporary directory.
- **Ergo** 2.19.1 is fetched into the gitignored `.cache/ergo/` and checked against its checksums file and a pinned SHA-256 before it runs. The Daemon dials it over TLS and trusts its self-signed root through the Transport's `trust`.
- **MinIO** is the maintained pgsty/minio fork, fetched into `.cache/minio/` and checked the same way. It serves its S3 API on loopback with an empty bucket.

`@iirc/daemon/testing` exports what another package's end-to-end run, such as the web frontend's in `apps/iirc`, needs to start them the same way: `startNgircd`, with the operator it grants as `ngircdOperName` and `ngircdOperPassword`, `startErgo`, `startMinio`, `connectPeer`, `freePort`, `loopback`, `layerLoopbackLinkFetch(port)`, the guard admitting a fixture site on `127.0.0.1:<port>`, and `seedUpload`, `holdsBytes`, and `loseBytes`, for an Upload seeded while the Daemon is stopped. Each start returns once that child listens on its ports, and starts it again on fresh ports if another process took one first.

## Not yet

- **Recording transcripts from the Journal.** The end-to-end runs are where fixtures will come from, through a normaliser that follows the fixtures' rules.
- **A bound on shutdown.** Effect's Bun server waits for its graceful stop with no bound once its own timeout passes, so a client in the middle of sending a body under 1 MiB to a route other than an upload, or one that has stopped reading a stream it follows, could still hold up shutdown.
- **Evicting Preview images by age.**
- **Snapshots for News.** Each reader folds the Journal from the start, as the Runtime does, which costs time on a long Journal.
