# @iirc/timeline-store

The Timeline store port: where the changes [`@iirc/timelines`](../timelines/README.md) folds from News are kept, and what Timelines are read from. The store is derived. It can be emptied and folded again from the Journal at any time, so nothing in it is the only copy of anything ([ADR 0002](../../docs/adr/0002-the-journal-holds-bytes.md), [ADR 0011](../../docs/adr/0011-timelines-are-a-projection-the-client-routes.md)).

This README is the port's written interface. The types are in `src/store.ts`, and the in-memory adapter and the laws are in `src/testing/`, exported from `@iirc/timeline-store/testing`. The port lives beside the fold, not in the Runtime, because the Runtime never drives it: what drives it is whatever folds the Runtime's News, and the port's types are the fold's.

```ts
import { TimelineStore } from "@iirc/timeline-store";

apply({ changes, through, directory }): Effect<void, TimelineStoreFailed>
folded: Effect<{ version, through }, TimelineStoreFailed>      // each undefined until set
directory: Effect<Directory, TimelineStoreFailed>
timelines(network): Effect<readonly Summary[], TimelineStoreFailed>
window(timeline, anchor, limit): Effect<Option<Window>, TimelineStoreFailed>
locate(network, sequence): Effect<readonly Item[], TimelineStoreFailed>
gaps(network, { from?, to? }): Effect<readonly Gap[], TimelineStoreFailed>
changedAfter(after, limit?): Effect<Changed, TimelineStoreFailed>
reset(version): Effect<void, TimelineStoreFailed>

Summary = Descriptor & { latest: Position | undefined, changed }   // { id, network, kind, name, key }
Item = { network, timeline, position, content, changed }
Window = { timeline, items, earlier, later }
Anchor = Before { position? } | After { position? } | Around { position }
Changed = { timelines, items, merged, gaps, through, more }
Tombstone = { network, id, into, changed }
Gap = { network, from, to: Position | undefined, changed }
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
- **`Merged`** moves every item of `from` into `into`, by the same rule as `Added`, so an item whose message id or position `into` already has is dropped. `from` is gone from `timelines` and leaves a **tombstone** naming `into`. A tombstone always names a Timeline that exists: a tombstone that named `from` is moved on to `into`.
- **`Gap`** keeps a Network's Gap by where it began, so the one that says where it ended replaces the one that did not.

Each Timeline, item, tombstone, and Gap records `changed`, the last sequence that changed it. A Timeline's counts any change to its items too: one added, confirmed, marked unsent, or moved in.

## Reading

- **`timelines(network)`** gives the Network's Timelines, merged ones aside and detached ones included, in the order they were opened, which is by id, each with the position of its last item and its `changed`.
- **`window(timeline, anchor, limit)`** gives up to `limit` items in position order, and whether more lie `earlier` and `later`. `Before` gives the last before a position, or the last of all without one. `After` gives the first after a position, or the first of all without one. `Around` gives as many before a position as from it on, and more from either side when the other runs out, so an item at the position is in the window. A merged id reads the Timeline it went to, which `timeline` names. An id never given is `None`.
- **`locate(network, sequence)`** gives the items a step made, wherever they stand now, in position order and, for items at one position, by Timeline id, which is how a link to a step finds its items.
- **`gaps(network, { from, to })`** gives the Network's Gaps that overlap the range of positions, either end of which may be left open, in the order they began, which is by where, since a Network has one Gap from each. A Gap still going on overlaps everything after it began. A window's range asks this for any Timeline of the Network.
- **`changedAfter(after, limit)`** gives every Timeline, item, tombstone, and Gap whose `changed` is after `after`, as it stands now, each list ordered by `changed` and then by a tie-break, so every adapter gives the same lists: among what changed in one sequence, Timelines and tombstones come **by Timeline id** (a tombstone's is the merged one's), items **by their Timeline's id, then by position**, and Gaps **by Network id, then by where they began**. Timeline ids are unique across Networks, and Network ids are compared as text by code point, so a database comparing UTF-8 bytes agrees, which is not the order of UTF-16 code units that JavaScript compares in. The store takes any text as a Network's id, and its laws tie Gaps on ids that the API's own pattern would refuse, such as `""` and `"\u{10000}"`, because the order is the store's to keep. With a limit, it gives whole sequences until it has given at least `limit` things, so no sequence is split. `through` is the last sequence given, and a reader resumes after it, with `more` saying whether anything changed later. When nothing more is left, `through` is the last step folded. Something changed again after a reader saw it is given again, as it stands then.

## Failure

`TimelineStoreFailed` means the store could not be written or read. A store is derived, so the remedy for one that cannot be read is to reset it and fold again.

## The laws

`@iirc/timeline-store/testing` holds `timelineStoreLaws`, the laws every adapter keeps, as data, and `makeMemoryTimelineStore`, the in-memory adapter that keeps them. The laws cover each rule above: a fresh store, `reset`, a reset that leaves no history behind, so the same steps are accepted again, a step applied twice, one item per message id and position, order by position with late history in the middle, confirming and marking unsent in place, merging with tombstones, windows on every anchor and their ends, `locate`, Gaps over ranges, `changedAfter` page by page, describing and detaching, a step at or before the last one folded that changes nothing, directory included, even one carrying a delivery update for a Message of ours, the order among what changed in one sequence, applied in an order that differs from the order of ids, and an `apply` interrupted at every point between two operations. A law is checked with `holds` from `@iirc/runtime/testing`, as the Runtime's ports' laws are.

```ts
it.each(timelineStoreLaws)("$name", async (law) => {
  await expect(Effect.runPromise(holds(law, makeMemoryTimelineStore))).resolves.toBeUndefined();
});
```

A law compares what a read returns structurally, so an adapter's objects may hold their properties in any order. Arrays are compared in order, and a `Map` or a `Set` by what it holds, whatever order it holds it in, because no read promises an order from one: the directory's Maps are the only ones that cross the port, and the fold reads them by key. An interrupted `apply` is checked with each of these steps: one that carries items, Timelines described anew, and a directory of its own; one that confirms one intent of ours and marks another `Unsent`, each with items in two Timelines; one that closes a Gap and opens another; and one that merges a Timeline into another, with items in both, so a merge half done, items moved with no tombstone or the reverse, is seen. Afterwards everything a read returns is together exactly what it was before, or exactly what the step leaves, and never part of each. That is the directory, how far the store has folded, every Timeline's summary with its `latest` and `changed`, every item in full, the windows, the Gaps, and the tombstones, each as `changedAfter`, `timelines`, `window`, and `gaps` give them. A step the store drops as obsolete is checked the same way, with changes of every kind, `Confirmed` and `Unsent` for Messages of ours included.

The memory adapter applies each step to a copy and swaps it in at once. Production code may not import `@iirc/timeline-store/testing`.

## Not yet

- **Search.** Items are read by position and by step, not by what they say.
