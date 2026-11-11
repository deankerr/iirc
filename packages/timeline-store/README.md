# @iirc/timeline-store

The Timeline store port: where the changes [`@iirc/timelines`](../timelines/README.md) folds from News are kept, and what Timelines are read from. The store is derived. It can be emptied and folded again from the Journal at any time, so nothing in it is the only copy of anything ([ADR 0002](../../docs/adr/0002-the-journal-holds-bytes.md), [ADR 0011](../../docs/adr/0011-timelines-are-a-projection-the-client-routes.md)).

This README is the port's written interface. The types are in `src/store.ts`, and the in-memory adapter and the laws are in `src/testing/`, exported from `@iirc/timeline-store/testing`. The port lives beside the fold, not in the Runtime, because the Runtime never drives it: what drives it is whatever folds the Runtime's News, and the port's types are the fold's.

```ts
import { TimelineStore } from "@iirc/timeline-store";

apply({ changes, through, directory }): Effect<void, TimelineStoreFailed>
folded: Effect<{ version, through }, TimelineStoreFailed>      // each undefined until set
directory: Effect<Directory, TimelineStoreFailed>
timelines(network, { after?, limit? }?): Effect<readonly Summary[], TimelineStoreFailed>
timeline(id): Effect<Option<Summary>, TimelineStoreFailed>
window(timeline, anchor, limit): Effect<Option<Window>, TimelineStoreFailed>
locate(network, sequence, { after?, limit? }?): Effect<readonly Item[], TimelineStoreFailed>
gaps(network, { from?, to? }): Effect<readonly Gap[], TimelineStoreFailed>
collapsedGaps(network, { from?, to?, at, beganAfter?, endedBefore? }): Effect<readonly CollapsedGap[], TimelineStoreFailed>
changedAfter(after, limit?): Effect<Changed, TimelineStoreFailed>
search({ text, network?, timeline?, from?, since?, until?, after?, limit }): Effect<readonly Item[], TimelineStoreFailed>
consistent(reads): Effect<{ value, through, version }, TimelineStoreFailed>
reset(version): Effect<void, TimelineStoreFailed>

Summary = Descriptor & { latest: Position | undefined, read: Instant | undefined, unread: Unread, changed }
                                                   // Descriptor is { id, network, kind, name, key }
Unread = { highlights, direct, messages, activity }
unreadOf: { [L in Level]: keyof Unread }           // which count a level is counted in
noneUnread: Unread                                 // every count 0
Item = { network, timeline, position, content, level: Level | undefined, changed }
Window = { timeline, network, items, earlier, later }
Anchor = Before { position? } | After { position? } | Around { position }
Changed = { timelines, items, merged, gaps, overflowed, through, more }
Overflowed = { sequence, timelines: readonly TimelineId[] | undefined }
CollapsedGap = { from, to: Position | undefined, count }
Tombstone = { network, id, into, changed }
Gap = { network, from, to: Position | undefined, changed }
ItemPlace = { position, timeline }                 // what a page of items resumes after
Search = { text: SearchText, network?, timeline?, from?, since?: Instant, until?: Instant,
  after?: ItemPlace, limit }
```

`TimelineStore` is an Effect service. An adapter provides it as a Layer from its own package: [`@iirc/timeline-store-sqlite`](../timeline-store-sqlite/README.md) in production, which the Daemon keeps in `views.sqlite`.

## Writing

- **One step at a time, whole or absent.** `apply` takes one step's changes, the sequence it folded through, and the directory after it, and keeps all three or none. An interrupted `apply` is either kept whole or not at all.
- **A step at or before the last one folded changes nothing,** so applying a step again after a failure whose outcome was unknown is safe.
- **`folded` says how far the store has folded,** and the projection version it was built with. A freshly made store has neither, and `reset(version)` sets only the version, so a store reset and not yet applied to has a version and no `through`.
- **`directory` gives the fold's state** as of the last step, so the fold resumes after `through` without folding the Journal again.
- **`reset(version)` empties the store,** directory included, and records the version it is about to be folded by. Whatever starts the store compares `version` with `projectionVersion`, and on a difference resets it and folds the Journal again from the start.

## What the changes mean

- **`Described`** holds a Timeline as given, replacing what was there: its name, its key, and whether it is detached, which is a Channel or Direct Message Timeline with no key.
- **`Added`** keeps an item at its position in its Timeline, with **one item per message id per Timeline**. When an item with the same message id, or at the same position, is already in that Timeline, the first is kept and the new one dropped. An item with no message id is always kept. The same message id may stand in many Timelines.
- **`Confirmed`** confirms every item of ours for that intent in that Network, wherever it stands, with the Ircd's time, id, and text. Its **position does not move**. From then on the item is kept under the Ircd's message id too, unless another item in its Timeline already has that id, so the same Message arriving again from history is dropped. An item already confirmed stays as it was.
- **`Unsent`** marks every item of ours for that intent in that Network as `Unsent`, in place, unless it was confirmed.
- **`Rejected`** marks every item of ours for that intent in that Network as `Rejected` with the Ircd's `reply`, in place, unless it was confirmed. Every store applies `Confirmed`, `Unsent`, and `Rejected` by `delivered` from `@iirc/timelines`, and one that leaves an item as it was does not change it.
- **`Merged`** moves every item of `from` into `into`, by the same rule as `Added`, so an item whose message id or position `into` already has is dropped. `from` is gone from `timelines` and leaves a **tombstone** naming `into`. A tombstone always names a Timeline that exists: a tombstone that named `from` is moved on to `into`.
- **`Gap`** keeps a Network's Gap by where it began, so the one that says where it ended replaces the one that did not.
- **`ReadMarker`** sets a Timeline's Read Marker, **only forward**: one at or before the Read Marker it has changes nothing, whatever the fold sent. `Described` keeps the Read Marker a Timeline has.

Each Timeline, item, tombstone, and Gap records `changed`, the last sequence that changed it. A Timeline's counts any change to its items too: one added, confirmed, marked unsent or rejected, or moved in, and any change to its Read Marker or its unread counts.

## Unread counts

Each Timeline's summary says how far it was read, `read`, and `unread`: how many of its items of each level, `Highlight`, `Direct`, `Message`, and `Activity` as the fold gives them, stand after `read`, which is every item while it has no Read Marker. An item stands after it when its position's `at` is strictly later, so a Read Marker at the largest instant has nothing after it. An item with no level, a Message Self said, never counts. Each count is **capped** at `unreadCap` from `@iirc/timelines`: a count of `unreadCap + 1` means more than that, and nothing is counted past it.

- **An item kept** counts one more of its level, when it stands after the Read Marker, wherever it stands among the others, so late history counts only when it is later than the Read Marker. An item dropped as a duplicate of one there, by message id or position, counts nothing.
- **A Read Marker moved forward** counts the Timeline again from it.
- **A merge** counts the Timeline kept again from its own Read Marker, after the items moved in. The fold sends the later of the two Read Markers after it.
- **A delivery change** changes no item's level, so it changes no count.

Every count is **bounded**: counting a level again reads at most `unreadCap + 1` of its items, and keeping one adds one, so no count ever walks a Timeline's whole history.

## Reading

- **`timelines(network, { after, limit })`** gives the Network's Timelines, merged ones aside and detached ones included, in the order they were opened, which is by id, each with the position of its last item, its Read Marker and unread counts, and its `changed`: those after the id `after`, up to `limit`, or every one without a page.
- **`timeline(id)`** gives one Timeline's summary, as `timelines` lists it, so a reader learns its Network, kind, name, and key from its id alone. A merged id gives the Timeline it went to, and an id never given is `None`.
- **`window(timeline, anchor, limit)`** gives up to `limit` items in position order, and whether more lie `earlier` and `later`. `Before` gives the last before a position, or the last of all without one. `After` gives the first after a position, or the first of all without one. `Around` gives as many before a position as from it on, and more from either side when the other runs out, so an item at the position is in the window. A merged id reads the Timeline it went to, which `timeline` names, with the Network it is one of. An id never given is `None`.
- **`locate(network, sequence, { after, limit })`** gives the items a step made, wherever they stand now, in position order and, for items at one position, by Timeline id, which is how a link to a step finds its items: those after the item `after` names by its position and Timeline in that order, up to `limit`, or every one without a page. One step can make an item in every Channel a User shared with Self, so a reader that must stay bounded pages it.
- **`gaps(network, { from, to })`** gives the Network's Gaps that overlap the range of positions, either end of which may be left open, in the order they began, which is by where, since a Network has one Gap from each. A Gap still going on overlaps everything after it began. A Network's Gaps do not overlap, except that one may begin exactly where the one before it ended: a Session that begins closes one Gap at its position, and when a restart then ends it before any more News, the next Gap begins at the last step folded, which is that same position. So of the Gaps that began before `from`, only the last can reach it, and every adapter keeps that one when it does, with every Gap that began at or after `from`, and nothing older.
- **`collapsedGaps(network, { from, to, at })`** gives the same Gaps over a range, split at a Timeline's item positions `at`, in order, with each run between two of them collapsed into one `{ from, to, count }`: where its first began, where its last ended, or `undefined` while it goes on, and how many. A run is the Gaps that began after one position and at or before the next, the first run those that began at or before the first position, and the last those that began after the last. A run with none is left out, so there are at most one more than there are positions, however many Gaps there are. A window asks this for its items, so a quiet Timeline that spans many reconnects gives one Gap that counts them. A page read at a cursor fits against the window that holds the cursor's item, which keeps every Gap that reaches that item, so the runs split at the cursor: `beganAfter` keeps only the Gaps that began after it, for a page read after a cursor, and `endedBefore` only those that ended before it, for a page read before one. A Gap that reaches the cursor is the other side's, so pages fitted together give each Gap once, and a run of Gaps that crosses the cursor comes as two, one on each side, with no item of the Timeline between them.
- **`changedAfter(after, limit)`** gives every Timeline, item, tombstone, and Gap whose `changed` is after `after`, as it stands now, each list ordered by `changed` and then by a tie-break, so every adapter gives the same lists: among what changed in one sequence, Timelines and tombstones come **by Timeline id** (a tombstone's is the merged one's), items **by their Timeline's id, then by position**, and Gaps **by Network id, then by where they began**. Timeline ids are unique across Networks, and Network ids are compared as text by code point, so a database comparing UTF-8 bytes agrees, which is not the order of UTF-16 code units that JavaScript compares in. The store takes any text as a Network's id, and its laws tie Gaps on ids that the API's own pattern would refuse, such as `""` and `"\u{10000}"`, because the order is the store's to keep. With a limit, it gives whole sequences while they come to at most `limit` things together, so no sequence is split and no page holds more. A first sequence that alone changed more, such as a merge of two long Timelines, which changes every item it moves, is given as `overflowed` instead, with every list empty: its sequence, and the ids of the Timelines it touched or merged, in id order, or `undefined` when they too are more than `limit`. A page is found without reading more than it gives: each sequence takes a seek and a count that stops at the limit, and an overflowed step's Timelines are found by seeking from one to the next. Without a limit, it gives everything, which is for tests and tools, not a reader that must stay bounded. `through` is the last sequence given, and a reader resumes after it, with `more` saying whether anything changed later. When nothing more is left, `through` is the last step folded. Something changed again after a reader saw it is given again, as it stands then.
- **`search({ text, network, timeline, from, since, until, after, limit })`** gives the Messages whose text holds `text`, both folded by `foldForSearch` from `@iirc/timelines`, as `searchableOf` says what each is found by: a Message of ours by the text the Ircd confirmed, once it did. They come **newest first**, by position latest first and, at one position, by Timeline id last first, up to `limit`, after the item `after` names in that order, so pages fitted together give each once, with none lost, unless a merge happened between them: an item moved into a Timeline whose id is lower than its own stands after the place a page ended on it, so it is given again. A reader restarts a search when a merge comes on the changes. `network` keeps one Network's. `timeline` keeps one Timeline's, a merged id reading the Timeline it went to, and an id never given finding nothing. `from` keeps those whose sender, folded the same way, is exactly it. `since` keeps those whose position's time is at or after it, and `until` those before it. A detached Timeline's Messages are found as any other's. `SearchText` holds at least three code points once folded, so every search can be served by an index of runs of three. There is no count of everything found, which would read it all: a reader asks for one more than its page to learn whether more follow, as it does of `locate`.
- **`consistent(reads)`** runs reads of this store against one state of it, which no `apply` or `reset` changes while they run, and gives what they read with `through`, the last step folded into that state, or `undefined` before any, and `version`, the projection version it was folded by, or `undefined` for a store never reset. So a reader that reads a window, its Gaps, or a step's items together, and then follows `changedAfter(through)`, misses nothing they did not show and loses nothing to a race with the projector. It is for the store's own reads: a write inside it would wait on itself.

## Failure

`TimelineStoreFailed` means the store could not be written or read. A store is derived, so the remedy for one that cannot be read is to reset it and fold again.

## The laws

`@iirc/timeline-store/testing` holds `timelineStoreLaws`, the laws every adapter keeps, as data, and `makeMemoryTimelineStore`, the in-memory adapter that keeps them. The laws cover each rule above: a fresh store, `reset`, a reset that leaves no history behind, so the same steps are accepted again, a step applied twice, one item per message id and position, order by position with late history in the middle, confirming and marking unsent in place, a refused action kept as told, with no level, never unread, and no delivery for a change to its intent to touch, merging with tombstones, windows on every anchor and their ends, `locate` a page at a time, Gaps over ranges, found from the last that began before the range, including two that meet where the range begins, as a failed Connection, a Session, and a restart folded in turn leave them, read in full and collapsed, `changedAfter` page by page, a merge bigger than the page given as overflowed with the Timelines it touched, or with none when they too are more than the page, and the step after it given whole, Timelines paged by id, a search found by the text folded, beyond ASCII and composed alike, with diacritics kept and nothing but Messages found, newest first, by each filter alone and all together, a page at a time with each Message once, and the page after one that ended on an item given again once a merge moved it, and not without one, an item at one position in two Timelines and late history among them, through a merged id with a duplicate the merge dropped found once, in a detached Timeline, ours by the text the Ircd confirmed, text that is a full-text query's syntax, quotes, `*`, `NEAR`, `OR`, `NOT`, `^`, and a column filter, found as text, and nothing found after a reset, Gaps collapsed between a quiet Timeline's items, open or closed at each end, runs split at a cursor, before and after it, so pages fitted together give each Gap once, a Gap that reaches the cursor in the window holding it, reads made together with the last step folded and its version, and a window's Network, a step held back while reads made together run, so two reads inside see the same state, describing and detaching, one Timeline read by its id as it is listed, through a merged id to the one kept, and `None` for an id never given, a step at or before the last one folded that changes nothing, directory included, even one carrying a delivery update for a Message of ours, the order among what changed in one sequence, applied in an order that differs from the order of ids, an `apply` interrupted at every point between two operations, a Read Marker that moves only forward with what lies after it counted by level, through late history, duplicates, delivery changes, and a Timeline described again, each count capped one past `unreadCap`, a Read Marker at the least instant, after which all but an item at it count, and at the largest, after which nothing counts, an item at it included, applied cleanly, a merge counted again by the kept Timeline's own Read Marker, and the counts after any of a dozen fixed runs of random steps, of items of every level at any time, Messages Self said elsewhere, with no level and not ours, among them, as the law checks, some duplicates, Read Markers moved either way, delivery changes, and merges, equal to counting each Timeline's items one by one, with every summary whose Read Marker or counts changed marked `changed` by the step. A law is checked with `holds` from `@iirc/runtime/testing`, as the Runtime's ports' laws are.

```ts
it.each(timelineStoreLaws)("$name", async (law) => {
  await expect(Effect.runPromise(holds(law, makeMemoryTimelineStore))).resolves.toBeUndefined();
});
```

A law compares what a read returns structurally, so an adapter's objects may hold their properties in any order. Arrays are compared in order, and a `Map` or a `Set` by what it holds, whatever order it holds it in, because no read promises an order from one: the directory's Maps are the only ones that cross the port, and the fold reads them by key. An interrupted `apply` is checked with each of these steps: one that carries items, Timelines described anew, and a directory of its own; one that confirms one intent of ours and marks another `Unsent`, each with items in two Timelines; one that closes a Gap and opens another; one that merges a Timeline into another, with items in both, so a merge half done, items moved with no tombstone or the reverse, is seen; and one that moves a Read Marker past items of every level, moves another or leaves it where it is, and adds an item, so a count half done is seen. Afterwards everything a read returns is together exactly what it was before, or exactly what the step leaves, and never part of each. That is the directory, how far the store has folded, every Timeline's summary with its `latest`, Read Marker, unread counts, and `changed`, every item in full, the windows, the Gaps, the tombstones, and what a search for each Message's text finds, each as `changedAfter`, `timelines`, `window`, `gaps`, and `search` give them. A step the store drops as obsolete is checked the same way, with changes of every kind, `Confirmed` and `Unsent` for Messages of ours included.

The memory adapter applies each step to a copy and swaps it in at once, and a write and reads made together take turns on one permit. It counts unread by walking every item of a Timeline on each read, as the laws count, and searches by walking every item, which no adapter that must stay bounded may. Production code may not import `@iirc/timeline-store/testing`.

## Not yet

- **A search of more than one run of characters.** A search looks for one, as a phrase. Several terms that must all appear, or any, belong in a Frontend's query syntax first, and then here.
- **Searching Activity.** A topic, a kick's or a quit's reason, and a part message are found by nothing yet.
