# @iirc/frontend

The pure core of the web frontend ([ADR 0010](../../docs/adr/0010-the-web-frontend-is-a-pure-core-under-react.md)). It holds what a Frontend shows as plain data and reducers, and React in [`apps/web`](../../apps/web/README.md) only renders it. It is pure, as `@iirc/client` is: it reads no clock, no randomness, no locale, and no time zone, does no I/O, uses no Effect service, and knows nothing of React or the DOM, which the lint fence enforces. It reads mIRC formatting and casemapping from `@iirc/protocol`, and positions from `@iirc/timelines`, both pure, and takes the types of what the runtime parsed from `@iirc/api`, never its values.

This README is the module's written interface. The types are in `src/`.

## Sign-in

`@iirc/frontend/sign-in`: whether this browser is signed in to the Daemon, as a reducer over what the Frontend asked and what the API answered.

```ts
initial: SignIn                                   // Unknown, with no check started
reduce(state: SignIn, event: SignInEvent): SignIn
explain(failure: Failure): string                 // the failure in words, saying what to do

SignIn =
  | Unknown   { check: Attempt }                  // not yet known
  | SignedOut { signIn: Attempt }
  | SignedIn  { signOut: Attempt }

Attempt = Idle | Waiting | Failed { failure }
Failure = "WrongKey" | "CrossOrigin" | "NotSaved" | "Unreachable" | "Unexpected"
```

| Event                       | From                    | To                        |
| --------------------------- | ----------------------- | ------------------------- |
| `CheckStarted`              | `Unknown`               | `Unknown`, waiting        |
| `Checked { signedIn }`      | `Unknown`               | `SignedIn` or `SignedOut` |
| `CheckFailed { failure }`   | `Unknown`               | `Unknown`, failed         |
| `SignInStarted`             | `SignedOut`             | `SignedOut`, waiting      |
| `SignInSucceeded`           | `SignedOut`             | `SignedIn`                |
| `SignInFailed { failure }`  | `SignedOut`             | `SignedOut`, failed       |
| `SignOutStarted`            | `SignedIn`              | `SignedIn`, waiting       |
| `SignOutSucceeded`          | `SignedIn`              | `SignedOut`               |
| `SignOutFailed { failure }` | `SignedIn`              | `SignedIn`, failed        |
| `Refused`                   | `Unknown` or `SignedIn` | `SignedOut`               |

A check is an authorized read: `Unauthorized` is `Checked { signedIn: false }`, and any answer is `Checked { signedIn: true }`. `Refused` is an authorized read answered `Unauthorized` later, as after signing out in another tab.

Each failure comes from the API's structure, never its text:

| Failure | When |
| --- | --- |
| `WrongKey` | Signing in, `Unauthorized`: the key matches none the Daemon holds |
| `CrossOrigin` | `CrossOrigin`: the Daemon could not tell the request came from its own origin |
| `NotSaved` | `SignInsFailed`: the Daemon could not write its sign-ins, so nothing changed |
| `Unreachable` | No answer came from the Daemon, or a gateway in front of it said it could not reach it |
| `Unexpected` | An answer came that the Frontend could not read |

### What it guarantees

- **It holds no key.** A key goes from the Owner's form to the API in one request. No state here has room for one.
- **Signed in only when the Daemon said so.** Only `Checked { signedIn: true }` and `SignInSucceeded` enter `SignedIn`.
- **An answer that does not belong is ignored.** An event that does not fit the state, such as a late check after a sign-in, leaves the state as it was, so commands that overlap cannot put it somewhere the Daemon never said.
- **One attempt at a time, and why the last one failed.** An attempt is idle, waiting, or failed with a reason, never two of them, and the reason stays until the next attempt starts.
- **Plain data.** A state holds strings, booleans, and plain objects, so it can be compared and kept.

## Timelines

`@iirc/frontend/timelines`: everything the Frontend holds of the Timelines, as a reducer over what it read from the API and what the changes stream said. It never folds News: the Daemon does that ([ADR 0011](../../docs/adr/0011-timelines-are-a-projection-the-client-routes.md)), and this keeps what was read up to date.

```ts
initialTimelines: Timelines                       // timelinesWith(windowCap)
timelinesWith(cap): Timelines                     // windows of at most `cap` items
windowCap: 1000, keptClosed: 4
reduceTimelines(state: Timelines, event: TimelinesEvent): Timelines
wanted(state): readonly Read[]                    // the reads to make now, none already in flight
followFrom(state): Place | null | undefined       // where to follow the changes from, once it can
sidebar(state): readonly SidebarNetwork[]         // Networks by id, each with its Timelines and connection
opened(state): Opened                             // the open Timeline: Closed, Vanished, Reading, or Shown
rowsOf(window): readonly Row[]                    // a window's items, with its collapsed Gaps among them
resolve(state, timeline): TimelineId              // the Timeline an id stands for, following merges

Read = Networks | List { network, after } | Status { network }
     | Latest { timeline, limit } | Older { timeline, before, limit }
     | Newer { timeline, after, limit }      // each with `attempt`, a window's with `generation`
```

| Event | From |
| --- | --- |
| `ReadStarted { read }` | The runtime took on a read `wanted` gave, so it is not asked for twice. It may wait before asking |
| `Requesting { read }` | The runtime is asking the Daemon now, after any wait, and again for each attempt after a failure |
| `NetworksRead`, `ListRead`, `StatusRead`, `WindowRead { read, window }` | What `GET /api/networks`, a page of a Network's Timelines, `known`, and a window answered. A window's answer names the read it answers, cursor and generation included |
| `Vanished`, `NetworkVanished` | A read answered `UnknownTimeline` or `UnknownNetwork` |
| `Changed { place, change }`, `Overflowed { place, overflow }`, `Reset { reset }` | The changes stream, with the place each event left it |
| `Opened { timeline }`, `OlderWanted { timeline }`, `NewerWanted { timeline }` | The Owner opened a Timeline, or scrolled near its top, or near its bottom with more beyond |
| `Following { timeline, following }` | The Owner is at the latest of the open Timeline, or left it |

- **It holds, per Network, its Timelines and its connection, and per Timeline opened, a window:** its items in position order, its collapsed Gaps, whether more lie `earlier` and `later`, and the `version` and `through` it was read at.
- **It follows the stream after the smallest `through` it read.** The Network list and every Network's Timelines are read first, a page at a time, and only then does `followFrom` give a place: the smallest `through` of the pages, with their version. Then the Network list is read once more, so a Network configured while the pages were read is not missed. A window is read only once the stream is followed.
- **One rule decides whether an answer is current:** nothing that invalidates what it is of happened after its read began. That is a reset, or the stream forgetting what it gave since then, either of which leaves no record of what changed, or an overflow that touched it, whose changes never came: for the Network list, one that touched everything; for a Network's Timelines or its connection, one that touched that Network; for a window, one that touched its Network or named its Timeline. The Network list and `known` are checked from where the stream was when the Daemon was last asked for them, as `Requesting` marks, so what the stream gave while the runtime waited to ask again never makes an answer stale; a page of Timelines or a window is checked from its own `through`. An answer that is not current leaves what it is of stale, and is asked for again with a higher `attempt`.
- **No change is lost or applied twice.** A Timeline is kept by its id and an item by its position, and the one changed last wins, so a change that comes again changes nothing. A window skips the steps it already reflects. While any read is in flight, what the stream gives is kept, and a read that lands after the stream passed its `through` is brought up to date from it, overflows included. A read older than anything kept, or of another version, is dropped, and asked again with a higher `attempt`, for the runtime to wait longer.
- **A new item lands only where it belongs by position.** In place of the item at its position, when it changed later, as a delivery does. Between the items loaded, as late history does. Past an end with nothing more beyond it, as a live item does at the latest. Anywhere else it is outside what the window holds. Late history inside a collapsed Gap of several may split it, so that window is read again.
- **A Gap lands in the windows of its Network.** One that ends closes the collapsed Gap holding it. One that begins after the last item joins a collapsed Gap already there, with no item between, or begins one. One among the items means history changed under the window, which is read again. Older items read before the window bring their Gaps, and a collapsed Gap held that begins inside one of theirs is the same run, seen whole.
- **Older items are read before the first item held, and newer after the last,** with the run of Gaps up to the cursor, as the API gives it. The cursor splits a run that crosses it into a part on each side, and the window joins two Gaps with no item between them into one run again, so pages fitted together show each run once. A page is brought up to date with what the stream gave on its own before it joins the window, which already reflects it.
- **A window holds at most `windowCap` items, 1000.** While the Owner is at the latest, a live item past the end is kept, and past the cap the oldest go, with the Gaps that ended before the first item kept, and `earlier` says more lie before. Away from the latest, a live item past the end is not kept: `later` says more lie after, the Gaps that began after the last item go too, and they are read after the last item when the Owner scrolls down. A page read before the window drops the newest past the cap instead. `earlier` and `later` are true exactly when something lies beyond, so everything dropped can be read again. A trim through a collapsed Gap of several, which may hold Gaps on both sides of the first item kept, reads the window again.
- **An answer is taken only by the window it was read for.** Each window is a generation of its Timeline's, and a window dropped and read again is a new one. A read names the generation it was made for and, before or after the window, its cursor, and its answer names that read. An answer for a window dropped or replaced since is ignored, without touching the window there is now or its read in flight. A page for an edge the window no longer has, as when the oldest were dropped past the cap while it was read, merges nothing, and is asked for again from the edge there is now.
- **Only the open Timeline's window and those of the four closed most recently are kept.** Any other is dropped, and read again when opened. A Timeline opens on its latest: its window follows again, and one left behind the latest is read again.
- **A merged Timeline follows its tombstone.** It leaves its Network's list, its window goes, and the Timeline the Owner opened resolves to the one it went to, which is read. A window read of a merged id says where it went, which is kept too.
- **An overflow reads again what it touched:** every Network whose Timeline it named, with its Timelines, its connection, and every window of it, since a Gap is the whole Network's. One that names a Timeline not held, or none, touched everything, and the Network list is read again too.
- **A reset drops what is held:** every list and window, read again, the Network list too, since a Network configured while the stream was away may be in the state the reset reaches with its first step never given, and the stream follows from the reset's place. A read of the Network list started before the reset, at a place older than the reset's, is read again rather than taken as current, as every other read is. A Network's connection stays shown until `known` is read again.
- **A Network's connection is derived, not polled.** It comes from `known` once, and then from the Session items the changes carry, `SessionBegan`, `SessionEnded`, and `ConnectionFailed`, each applied only when it is later than what set the connection. `known` says what the Client knows now, connecting and registering included, which no item says, and the latest Session item may lie anywhere in the Network's Timeline, beyond any window. A `known` read is taken only if no Session item later than the stream's place when it started already said more, and is read again if it started before a reset or an overflow of its Network.

## Rendering

`@iirc/frontend/render`: what an item shows, as data for a view to draw. Nothing in it is markup: every string is text, for a text node.

```ts
formatted(text): readonly Inline[]                // mIRC formatting into runs, and links in them
lineOf(content): Line                             // Message { kind, nick, colour, text, delivery } | Description { tone, parts }
nickColour(nick, slots = nickSlots): number       // a stable colour slot, 0 to 15
contained(text): string                           // controls shown as symbols, bidi closed
endReason(reason): string                         // why a Session ended, in words

Inline = Text { text, style } | Link { text, href, style }
Part = Words { text } | Nick { nick, colour } | Name { text } | Said { inlines }
```

- **Formatting is data.** `@iirc/protocol/format` reads bold, italic, underline, strikethrough, monospace, reverse, and colours into styles, and a view draws them.
- **A link is one of `http`, `https`, `irc`, or `ircs`,** found within a run of one style, with sentence punctuation and an unopened closing bracket left off its end, each bracket counted once, so any number of them is trimmed in linear time, and its `href` as the URL parser writes it. Anything else, `javascript:` and `data:` included, stays text. A link ends at whitespace, a control character, or a bidirectional formatting character, so none is ever in one.
- **Hostile text is contained.** C0 controls and DEL show as their Control Pictures, C1 controls and lone surrogates as the replacement character, and the line and paragraph separators as the newline symbol. Every bidirectional embedding, override, or isolate a run opens is closed at its end, so it cannot reorder what follows it, and a view isolates each name and text besides. Everything over a Line's text is linear, however hostile: a pop with no isolate open skips the search, and each search drops what it passes over.
- **A nick's colour is a slot, not a colour:** an FNV-1a hash of the nick as RFC 1459 folds it, one of 16, so the same User has the same slot in any case, on every load, and a theme gives each slot its colour.
- **Activity and Sessions are a few words,** in which nicks, names, and reasons are parts of their own. One of our Messages says its delivery, and once the Ircd confirmed it, shows the Ircd's own text.

## Tests

`bun run test` runs three files. `src/sign-in.test.ts` covers each transition, checking again after a failed check, keeping a failure until the next attempt, signing out failing while staying signed in, `Refused` from signed in and while signing out, ignoring an answer that does not belong, and two properties over any sequence of events: `SignedIn` is entered only after a check or a sign-in said so, and every state survives `structuredClone` unchanged.

`src/timelines.test.ts` plays a model Daemon: random steps folded into Timelines, items, late history, deliveries, Sessions and their Gaps, and a second Network configured later, sometimes never heard from again, read a page at a time and a window at a time as the API reads them, before and after a cursor included, and changes given as it gives them. The reducer and a runtime in miniature read what `wanted` asks, at fold points the Daemon has reached, answered later in any order, while the stream lags the Daemon, some steps come as overflows, naming what they touched or everything, the Daemon may take a new projection version, which the stream resets, every event may come twice, and the Owner opens Timelines, goes back to the one before, opens another while older items are read and comes back, has the Daemon fold steps that come as overflows touching everything while the Network list is read, scrolls up and down, and leaves and returns to the latest at random, with windows of at most 4 items, pages of 2, and no closed window kept, so windows are dropped and read again with answers for them still in flight, which the runtime may answer newest first. After every action, a current window holds every item the Daemon had folded by its `through` between its first and last items, so a page merged into the wrong window, which leaves a hole, is caught as it happens. Once everything settles, the Networks are exactly the Daemon's, and each Network's Timelines and connection are exactly its, a Network that only a reset reaches included, and every current window is exactly what a read now would give between its first and last items, Gaps included, with `earlier` and `later` true exactly when something lies beyond. No window ever holds more than the cap, nor is any window kept but the open one's. Every state survives `structuredClone`. Examples cover following after the smallest `through`, each read asked once, sidebar order, a live item, late history, an update in place, an item outside a window, a merge followed and learnt from a window read, overflows, a reset, a read of another version dropped, a read brought up to date from what the stream gave, reading older items before the first with the Gaps up to it, a page that lands after its window was dropped and read again ignored, the Network list kept stale when an overflow that touched everything came while it was read, and current from where the stream was when it was asked, not when it was taken on, joining a run the cursor split, the Network list read again on a reset and a pre-reset read of it landing late, collapsing Gaps, and a connection from `known` then from Session items.

`src/render.test.ts` covers formatting, the schemes linked and those not, a link's style and `href`, a link ended at a bidirectional character, controls shown, bidirectional formatting closed, a line of 70 000 characters, linear time over 64 000 closing brackets after a link and 30 000 nested embeddings closed by isolates' pops, and, for any text weighted towards hostile pieces, that it never throws, no run holds a control, every run closes its bidirectional formatting, and every link is of an allowed scheme. Nick colours are the same in any case and on every run, in range, and spread over every slot. Lines cover a Message, delivery and the Ircd's confirmed text, a hostile nick, each Activity, and a Session's start and end.

## Not yet

- **The command registry, the keymap, the option tree, and the pane layout,** which [ADR 0010](../../docs/adr/0010-the-web-frontend-is-a-pure-core-under-react.md), [ADR 0012](../../docs/adr/0012-the-web-frontend-builds-on-react-aria-and-resizable-panels.md), and [ADR 0013](../../docs/adr/0013-configuration-is-an-option-tree.md) describe.
