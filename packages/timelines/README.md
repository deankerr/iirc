# @iirc/timelines

Timelines as a pure fold over News. Each step the Runtime's News stream gives goes in, and the changes a Timeline store applies come out. It does no I/O, reads no clock, and holds plain data, so the same steps always give the same Timelines, ids, positions, and changes ([ADR 0011](../../docs/adr/0011-timelines-are-a-projection-the-client-routes.md)).

This README is the module's written interface. The types are in `src/`. The store that keeps what the fold gives, and the laws its adapters keep, are in [`@iirc/timeline-store`](../timeline-store/README.md).

```ts
import { emptyDirectory, projectionVersion, step } from "@iirc/timelines";

step(directory: Directory, happened: Happened): { directory: Directory, changes: readonly Change[] }
Happened = { network, sequence, at, news }        // the Runtime's Happened fits it
emptyDirectory: Directory
projectionVersion: number                         // 3
comparePositions(left, right): number
cursorOf(position): string
cursorsAfter(at): string                          // above every cursor later than `at`, below the rest
parseCursor(text): Position | undefined
TimelineId                                         // a branded Schema
Level = "Highlight" | "Direct" | "Message" | "Activity"
levels: readonly Level[]                           // from the one that calls for the Owner most
unreadCap: number                                  // 999
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

Positions are totally ordered by `at`, then `sequence`, then `n`, which `comparePositions` gives. History that arrives late stands where its time puts it, among what came before. `cursorOf` writes a position as `<at>-<sequence>-<n>` in fixed-width lower-case hex, the time offset by 2^53 so that one before 1970 still sorts first. Two cursors compare as text exactly as their positions compare, and `parseCursor` reads one back, or gives `undefined` for text that is not a cursor `cursorOf` could write. `cursorsAfter(at)` is text, never a cursor, that every cursor of a position later than `at` compares above and every other below, so a store finds what stands after a Read Marker by cursor alone, without making the instant after it, which the largest instant does not have.

## Changes

Every change carries `sequence`, the step that made it, so the store records for each Timeline, item, and Gap the last sequence that changed it.

| News | Changes |
| --- | --- |
| A Network's first step | `Described` for its own Timeline, named by the Network's id, with no key. |
| `Message`, `Activity` | `Described` for each Timeline it opens, renames, or detaches, then one `Added` for each Timeline its `where` touches, once each however often `where` names it. |
| `Confirmed` | `Confirmed` for its intent in the Network, with the Ircd's time, id, and text. |
| `Refused` `Unsent` | `Unsent` for its intent in the Network. |
| `Refused` `Rejected` | `Rejected` for its intent in the Network, with the Ircd's `reply`: its numeric or standard reply's code, never text. `Offline` and `Unsendable` refuse a `Say` in its own step, before any Message is reported, so they place nothing and change nothing. |
| `SessionBegan`, `SessionEnded`, `ConnectionFailed` | `Added` to the Network's Timeline, and a `Gap` as below. |
| `Refolded` | `Described` for each Timeline whose key changes, and `Merged` for each that meets one opened before it, followed by `ReadMarker` for the one kept when the merged one was read further. |
| `ReadMarker` | `ReadMarker` for the Timeline its `where` names, when it moves that Timeline's Read Marker forward. |
| `Ignored` | Nothing. |

An `Added` item carries what a Frontend shows: for a Message its sender, Target, text, kind, client-only tags as `[name, value]` pairs, `live`, and its `at` and `id` facts, and for an Activity the Activity itself. It carries the message id, when its fact is `Known`, and the intent of one of ours, so the store can keep one per id and find ours again, and its **level** in that Timeline, below. One of ours starts `Pending` when `ours.echo` says the Ircd will echo it, and `Unconfirmed` when it will not. `delivered(before, change)` says how it stands after `Confirmed`, `Unsent`, or `Rejected`, the one rule every store applies: a confirmed Message stays confirmed, a change that would leave it as it is changes nothing, and otherwise the latest wins.

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

A Message Self said, one with `ours` or `self`, has no level, and never counts. One News placed in many Timelines can have a different level in each. `unreadCap` is the most a store counts of one level after a Read Marker: a count of `unreadCap + 1` means more than that.

## The projection version

`projectionVersion` is the version of what the fold gives. Bump it whenever News or the fold changes, in any way that would give a store different Timelines, ids, positions, or items. A store built with another version is reset and folded again from the Journal ([ADR 0002](../../docs/adr/0002-the-journal-holds-bytes.md)).

## Tests

`fold.test.ts` takes each rule above in turn, levels and Read Markers included: forward only, opening nothing, following a rename, staying with a detached Timeline, a merge keeping the later, and the largest instant, which a Read Marker reaches and nothing passes. `properties.test.ts` folds random steps, including renames, refolds, and Gaps, and checks that folding them again gives the same directory and changes, that the directory is plain data and a step leaves the one it was given as it was, that every change carries its step's sequence, that ids open in order, that items go only to open Timelines, once per News, that a Read Marker moves only forward and only on an open Timeline, that only a Message Self said has no level, that positions and their cursors order alike, and that a cursor is above `cursorsAfter` of an instant exactly when its position is later, the least and largest instants included. `client.test.ts` folds the News of a transcript played through the real Client.

## Not yet

- **Encodings.** The directory, items, and changes are TypeScript types over plain data. The SQLite store keeps its own Schemas of what it writes, checked against these types, and the wire forms belong to `@iirc/api`.
- **Channel renames.** A Channel keeps the name it opened with. `channel-rename` would rename one in place, keeping its id, as `DirectRenamed` does.
