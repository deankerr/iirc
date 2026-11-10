# @iirc/timelines

Timelines as a pure fold over News. Each step the Runtime's News stream gives goes in, and the changes a Timeline store applies come out. It does no I/O, reads no clock, and holds plain data, so the same steps always give the same Timelines, ids, positions, and changes ([ADR 0011](../../docs/adr/0011-timelines-are-a-projection-the-client-routes.md)).

This README is the module's written interface. The types are in `src/`. The store that keeps what the fold gives, and the laws its adapters keep, are in [`@iirc/timeline-store`](../timeline-store/README.md).

```ts
import { emptyDirectory, projectionVersion, step } from "@iirc/timelines";

step(directory: Directory, happened: Happened): { directory: Directory, changes: readonly Change[] }
Happened = { network, sequence, at, news }        // the Runtime's Happened fits it
emptyDirectory: Directory
projectionVersion: number                         // 1
comparePositions(left, right): number
cursorOf(position): string
parseCursor(text): Position | undefined
TimelineId                                         // a branded Schema
```

## The fold holds the directory, and the store the rest

The fold's state is the **directory**: for each Network, its own Timeline, and each Channel and Direct Message Timeline that News can still find, by its key, with its id, kind, and name. It also holds where an open Gap began, and the position of the last step folded. Everything that grows with history, the items and what they are found by, belongs to the store, and the fold tells it what to do with keyed changes. So the fold's state grows with the Timelines a Network has, not with what was said in them. A store keeps the directory with each step it applies, so the fold resumes from it without folding the Journal again.

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

Positions are totally ordered by `at`, then `sequence`, then `n`, which `comparePositions` gives. History that arrives late stands where its time puts it, among what came before. `cursorOf` writes a position as `<at>-<sequence>-<n>` in fixed-width lower-case hex, the time offset by 2^53 so that one before 1970 still sorts first. Two cursors compare as text exactly as their positions compare, and `parseCursor` reads one back, or gives `undefined` for text that is not a cursor `cursorOf` could write.

## Changes

Every change carries `sequence`, the step that made it, so the store records for each Timeline, item, and Gap the last sequence that changed it.

| News | Changes |
| --- | --- |
| A Network's first step | `Described` for its own Timeline, named by the Network's id, with no key. |
| `Message`, `Activity` | `Described` for each Timeline it opens, renames, or detaches, then one `Added` for each Timeline its `where` touches, once each however often `where` names it. |
| `Confirmed` | `Confirmed` for its intent in the Network, with the Ircd's time, id, and text. |
| `Refused` `Unsent` | `Unsent` for its intent in the Network. Other reasons place nothing, so they change nothing. |
| `SessionBegan`, `SessionEnded`, `ConnectionFailed` | `Added` to the Network's Timeline, and a `Gap` as below. |
| `Refolded` | `Described` for each Timeline whose key changes, and `Merged` for each that meets one opened before it. |
| `Ignored` | Nothing. |

An `Added` item carries what a Frontend shows: for a Message its sender, Target, text, kind, client-only tags as `[name, value]` pairs, `live`, and its `at` and `id` facts, and for an Activity the Activity itself. It carries the message id, when its fact is `Known`, and the intent of one of ours, so the store can keep one per id and find ours again. One of ours starts `Pending` when `ours.echo` says the Ircd will echo it, and `Unconfirmed` when it will not.

A **Gap** begins at a `SessionEnded`, or the first of a run of `ConnectionFailed`, while the Network is not already in one, and ends at the next `SessionBegan`. Each is reported as `Gap { from, to }`, once with `to` left out when it begins, and again with `to` when it ends. A Session that a restart ended began its Gap at the last step folded for the Network before it, since the Daemon may have been gone since then and the fold cannot tell.

## The projection version

`projectionVersion` is the version of what the fold gives. Bump it whenever News or the fold changes, in any way that would give a store different Timelines, ids, positions, or items. A store built with another version is reset and folded again from the Journal ([ADR 0002](../../docs/adr/0002-the-journal-holds-bytes.md)).

## Tests

`fold.test.ts` takes each rule above in turn. `properties.test.ts` folds random steps, including renames, refolds, and Gaps, and checks that folding them again gives the same directory and changes, that the directory is plain data and a step leaves the one it was given as it was, that every change carries its step's sequence, that ids open in order, that items go only to open Timelines, once per News, and that positions and their cursors order alike. `client.test.ts` folds the News of a transcript played through the real Client.

## Not yet

- **Encodings.** The directory, items, and changes are TypeScript types over plain data. A durable store will need Schemas for the parts it writes, and the wire forms belong to `@iirc/api`.
- **Channel renames.** A Channel keeps the name it opened with. `channel-rename` would rename one in place, keeping its id, as `DirectRenamed` does.
- **Highlights and unread counts.** Both are read from items and Read Markers, and neither is folded yet.
