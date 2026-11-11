# @iirc/timelines

Timelines as a pure fold over News. Each step the Runtime's News stream gives goes in, and the changes a Timeline store applies come out. It does no I/O, reads no clock, and holds plain data, so the same steps always give the same Timelines, ids, positions, and changes ([ADR 0011](../../docs/adr/0011-timelines-are-a-projection-the-client-routes.md)).

This README is the module's written interface. The types are in `src/`. The store that keeps what the fold gives, and the laws its adapters keep, are in [`@iirc/timeline-store`](../timeline-store/README.md).

```ts
import { emptyDirectory, projectionVersion, step } from "@iirc/timelines";

step(directory: Directory, happened: Happened): { directory: Directory, changes: readonly Change[] }
Happened = { network, sequence, at, news }        // the Runtime's Happened fits it
emptyDirectory: Directory
projectionVersion: number                         // 4
comparePositions(left, right): number
cursorOf(position): string
cursorsAfter(at): string                          // above every cursor later than `at`, below the rest
cursorsFrom(at): string                           // at or below every cursor at or after `at`, above the rest
parseCursor(text): Position | undefined
TimelineId                                         // a branded Schema
Level = "Highlight" | "Direct" | "Message" | "Activity"
levels: readonly Level[]                           // from the one that calls for the Owner most
unreadCap: number                                  // 999
foldForSearch(text): string                       // simple lower case, by Unicode 17.0's table
searchFolding: string                             // "simple-lower/17.0", which a store keeps
SearchText                                         // a branded Schema: 3 to 510 code points folded
searchableOf(content): { text, sender } | undefined
```

## The fold holds the directory, and the store the rest

The fold's state is the **directory**: for each Network, its own Timeline, and each Channel and Direct Message Timeline that News can still find, by its key, with its id, kind, name, and Read Marker. It also holds where an open Gap began, and the position of the last step folded. Everything that grows with history, the items and what they are found by, belongs to the store, and the fold tells it what to do with keyed changes. So the fold's state grows with the Timelines a Network has, not with what was said in them. A store keeps the directory with each step it applies, so the fold resumes from it without folding the Journal again.

`step` is total. It never throws, and a step it cannot place anything from changes only the directory's last position.

## Timelines

There are three kinds: the **Network**'s own, a **Channel**'s, and a **Direct** Message partner's.

- **The Network's own** opens on the Network's first step, whatever that step holds.
- **A Channel's or a Direct Message partner's** opens on the first Message or Activity whose `where` names it, unless the entry is a `Direct` with `existing`, which only touches one that already exists. Its key and name are as `where` gave them. A Channel keeps the name it opened with.
- **`DirectRenamed`** finds the Direct Message Timeline keyed by the old nick, which takes the item, and is keyed and named by the new nick from then on. When none has the old nick, it touches nothing. When another Direct Message Timeline already has the new nick's key, that one is **detached**: it keeps its id, name, and items, but no key, so it receives nothing more, since nothing says it is the same person. A Message to the old nick after that opens a new Timeline.
- **`Refolded`** folds the name of each of the Network's keyed Timelines again, with `casefold` from `@iirc/protocol/casemapping` under the mapping it carries. Of Timelines of one kind whose keys now meet, the one opened first is kept, and each other is **merged** into it.

A **TimelineId** is opaque, and derived from where the Timeline was first opened: the step's sequence, the News's index in it, and which of its `where` entries opened it, or none for the Network's own. Each part is fixed-width lower-case hex, as `0000000000002a-00000003-00000001`, so an id is safe in a URL path, holds no name a Network chose, sorts in the order the Timelines were opened, and is the same on every rebuild. A rename, a refold, or a detach keeps the id.

## Positions

An item stands at a **position**, `(at, sequence, n)`: the time of its News, the step's sequence, and the News's index in the step. The time of a Message or an Activity is its `at` fact's instant, `Known` or `Stale`, and the step's `at` when it is `Unknown`. A Session's start or end, or a failed Connection, has its own instant. A position never changes once given, so a Read Marker or a link can point at one.

Positions are totally ordered by `at`, then `sequence`, then `n`, which `comparePositions` gives. History that arrives late stands where its time puts it, among what came before. `cursorOf` writes a position as `<at>-<sequence>-<n>` in fixed-width lower-case hex, the time offset by 2^53 so that one before 1970 still sorts first. Two cursors compare as text exactly as their positions compare, and `parseCursor` reads one back, or gives `undefined` for text that is not a cursor `cursorOf` could write. `cursorsAfter(at)` is text, never a cursor, that every cursor of a position later than `at` compares above and every other below, so a store finds what stands after a Read Marker by cursor alone, without making the instant after it, which the largest instant does not have. `cursorsFrom(at)` is text that every cursor of a position at or after `at` compares at or above and every other below, so a store bounds a range of time by cursor alone.

## Changes

Every change carries `sequence`, the step that made it, so the store records for each Timeline, item, and Gap the last sequence that changed it.

| News | Changes |
| --- | --- |
| A Network's first step | `Described` for its own Timeline, named by the Network's id, with no key. |
| `Message`, `Activity` | `Described` for each Timeline it opens, renames, or detaches, then one `Added` for each Timeline its `where` touches, once each however often `where` names it. |
| `Confirmed` | `Confirmed` for its intent in the Network, with the Ircd's time, id, and text. |
| `Refused` `Unsent` | `Unsent` for its intent in the Network. |
| `Refused` `Rejected` | `Rejected` for its intent in the Network, with the Ircd's `reply`: its numeric or standard reply's code, never text. `Offline` and `Unsendable` refuse a `Say` in its own step, before any Message is reported, so they place nothing and change nothing. |
| `Refused` with `action`, `Rejected` or `Unsent` | An action of ours refused after it left. `Described` if it opens the Channel its `action.where` names, as a `where` entry does, then one `Added` there, an `ActionRefused` item standing at the step's own time, with what the action tried, its intent, and the reason. It changes no Message's delivery. `Offline` and `Unsendable` refuse an action in its own step, which the `act` answer already said to whoever acted, so they place nothing, as for a `Say`. |
| `SessionBegan`, `SessionEnded`, `ConnectionFailed` | `Added` to the Network's Timeline, and a `Gap` as below. |
| `Refolded` | `Described` for each Timeline whose key changes, and `Merged` for each that meets one opened before it, followed by `ReadMarker` for the one kept when the merged one was read further. |
| `ReadMarker` | `ReadMarker` for the Timeline its `where` names, when it moves that Timeline's Read Marker forward. |
| `LookedUp` | Nothing. A Lookup's result is the answer to whoever looked, read through the API, not something said or done on the Network. |
| `Ignored` | Nothing. |

An `Added` item carries what a Frontend shows: for a Message its sender, Target, text, kind, client-only tags as `[name, value]` pairs, `live`, and its `at` and `id` facts, for an Activity the Activity itself, and for an `ActionRefused` what the action tried, as [the Client's README](../client/README.md#where-news-belongs) gives it, never its text or a mode's parameter, its intent, and the reason, `Rejected` with the `reply` or `Unsent`. It carries the message id, when its fact is `Known`, and the intent of one of ours, so the store can keep one per id and find ours again, and its **level** in that Timeline, below. One of ours starts `Pending` when `ours.echo` says the Ircd will echo it, and `Unconfirmed` when it will not. `delivered(before, change)` says how it stands after `Confirmed`, `Unsent`, or `Rejected`, the one rule every store applies: a confirmed Message stays confirmed, a change that would leave it as it is changes nothing, and otherwise the latest wins.

A **Gap** begins at a `SessionEnded`, or the first of a run of `ConnectionFailed`, while the Network is not already in one, and ends at the next `SessionBegan`. Each is reported as `Gap { from, to }`, once with `to` left out when it begins, and again with `to` when it ends. A Session that a restart ended began its Gap at the last step folded for the Network before it, since the Daemon may have been gone since then and the fold cannot tell.

## Read Markers and levels

The fold keeps each Timeline's **Read Marker**, how far the Owner has read it, as an instant, from the Client's `ReadMarker` News ([ADR 0014](../../docs/adr/0014-read-markers-and-highlights-belong-to-the-client.md)).

- **It moves only forward, per Timeline.** A `ReadMarker` sets the Read Marker of the Timeline its `where` names, `Network`, `Channel`, or `Direct`, only when it is later than the one the Timeline has, whatever the News says. So after a casemapping change, when the Client's marker for a key follows another spelling than the Timeline's, as [the Client's README](../client/README.md#read-markers) explains, no Timeline's Read Marker moves back.
- **Marking read opens nothing.** A `ReadMarker` for a key no Timeline has changes nothing.
- **It goes with its Timeline.** A Direct Message Timeline renamed by `DirectRenamed` keeps its Read Marker, and one detached keeps it too, and receives no more. Of two Timelines merged, the kept one has been read as far as the later of their two Read Markers.

Each `Added` item has a **level**, how much it calls for the Owner in its Timeline, as WeeChat ranks activity, which a store counts what lies after a Read Marker by:

| Level | Items |
| --- | --- |
| `Highlight` | A Message whose `highlight` is set, wherever it stands. |
| `Direct` | Any other Message in a Direct Message Timeline. |
| `Message` | Any other Message in a Channel's Timeline. |
| `Activity` | An Activity, a Session's start or end, a failed Connection, and a Message in the Network's own Timeline. |

A Message Self said, one with `ours` or `self`, has no level, and never counts, and neither does an `ActionRefused`, which is ours too. One News placed in many Timelines can have a different level in each. `unreadCap` is the most a store counts of one level after a Read Marker: a count of `unreadCap + 1` means more than that.

## What a search finds

A store searches the Messages in its Timelines by their text, and every store finds the same ones, because they fold text one way, here.

- **`foldForSearch`** lower-cases each code point by Unicode's simple mapping, one code point to one, never by a locale's, so `É` finds `é`, `Σ` finds `σ`, and `İ` folds to `i`, and a text keeps its count of code points. The mapping is `src/lower-case.ts`, a table pinned to Unicode 17.0, the version the Client's word characters follow, and never the runtime's own tables, so every runtime folds alike, and a store's index never depends on which one built it. `scripts/lower-case.ts` generates it, with `bun run generate:lower-case` on a runtime of the version to pin. It reads each code point's lower case from the runtime and takes the one the runtime expands, U+0130, from UnicodeData's simple mapping, refusing any other that expands.
- **Nothing is composed or decomposed.** `é` written whole and `e` with a combining accent are different text, so one does not find the other. Composing (NFC) would match them, but needs the runtime's normalization tables, or pinned decomposition, combining-class, and composition tables of its own, while IRC clients send composed text all but always. So the smaller correct choice is to compose nothing and say so. Diacritics are kept: `cafe` does not find `café`, since no fold takes them off alike in every language, and one that guessed would find what was not said.
- **`searchFolding`** names how text folds, `simple-lower/` and the table's Unicode version, so a table generated for another version changes it. A store that keeps folded text keeps this beside it, and folds it again when it differs. Whoever changes how text folds otherwise changes the scheme's name too.
- **`SearchText`** is what a search looks for: one run of characters, found anywhere in a Message's text, of `searchTextMinimum`, 3, to `searchTextMaximum`, 510, the most a Line could carry, both counted in code points once folded, so three astral characters are enough and a composed letter counts one where a letter and its combining accent count two, with no line break or NUL, which no Message holds, and no lone surrogate, which is no character. A store finds text by its runs of three characters, so a shorter one could only be found by reading every Message, and so it cannot be made.
- **`searchableOf`** says what an item is found by: a Message's text, folded, and its sender, folded, for a search kept to one sender. One of ours is found by the text the Ircd confirmed once it did, since that is what was said, and by our own text before. An Activity, a Session's start or end, and a refused action are found by nothing.

The fold does not change by any of this, so it changes no projection version.

## The projection version

`projectionVersion` is the version of what the fold gives. Bump it whenever News or the fold changes, in any way that would give a store different Timelines, ids, positions, or items. A store built with another version is reset and folded again from the Journal ([ADR 0002](../../docs/adr/0002-the-journal-holds-bytes.md)).

## Tests

`fold.test.ts` takes each rule above in turn, levels, Read Markers, and refused actions included, placed in their Channel or the Network's own at the step's time with no level, opening a Channel, and nothing for one refused in its own step: forward only, opening nothing, following a rename, staying with a detached Timeline, a merge keeping the later, and the largest instant, which a Read Marker reaches and nothing passes. `properties.test.ts` folds random steps, including renames, refolds, and Gaps, and checks that folding them again gives the same directory and changes, that the directory is plain data and a step leaves the one it was given as it was, that every change carries its step's sequence, that ids open in order, that items go only to open Timelines, once per News, that a Read Marker moves only forward and only on an open Timeline, that only a Message Self said and a refused action have no level, that positions and their cursors order alike, and that a cursor is above `cursorsAfter` of an instant exactly when its position is later, the least and largest instants included. `search.test.ts` checks what a search may look for, at both limits, with astral, composed, decomposed, and dotted capital I text, the fold, composing nothing, what an item is found by, ours by the text confirmed, and `cursorsFrom` against cursors either side of its instant. `lower-case.test.ts` checks that regenerating the table on a runtime of Unicode 17.0 gives the one committed, and that it folds every code point as that runtime lower-cases it alone, U+0130 aside, and skips both on a runtime of another version, since the table is what decides, and that the runs are well formed. `client.test.ts` folds the News of a transcript played through the real Client, including an action on `#Foo[` under `ascii` refused after the Ircd declared `rfc1459`, which lands in the Channel's re-keyed Timeline rather than opening another.

## Not yet

- **Encodings.** The directory, items, and changes are TypeScript types over plain data. The SQLite store keeps its own Schemas of what it writes, checked against these types, and the wire forms belong to `@iirc/api`.
- **Channel renames.** A Channel keeps the name it opened with. `channel-rename` would rename one in place, keeping its id, as `DirectRenamed` does.
