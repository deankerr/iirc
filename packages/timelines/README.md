# @iirc/timelines

Timelines as a pure fold over News, and over the Changes that mark a Timeline by its id. Each step the Runtime's News stream gives goes in, and each such Change in its place among them, and the changes a Timeline store applies come out. It does no I/O, reads no clock, and holds plain data, so the same steps always give the same Timelines, ids, positions, and changes.

```ts
import { emptyDirectory, projectionVersion, step, stepMarking } from "@iirc/timelines";

step(directory: Directory, happened: Happened): { directory: Directory, changes: readonly Change[] }
Happened = { network, life, sequence, at, news }  // the Runtime's Happened fits it
stepMarking(directory: Directory, marking: Marking): { directory: Directory, changes: readonly Change[] }
Marking = TimelineRead { network, sequence, timeline, read } | TimelineClosed { network, sequence, timeline }
emptyDirectory: Directory
projectionVersion: number
comparePositions(left, right): number
cursorOf(position): string
cursorsAfter(at): string                          // above every cursor later than `at`, below the rest
cursorsFrom(at): string                           // at or below every cursor at or after `at`, above the rest
parseCursor(text): Position | undefined
TimelineId                                         // a branded Schema
IgnoreMask                                         // a branded Schema: what `Added` and `Unignored` carry
Level = "Highlight" | "Direct" | "Message" | "Activity"
levels: readonly Level[]                           // from the one that calls for the Owner most
unreadCap: number                                  // 999
foldForSearch(text): string                       // lower case, then base letters, by Unicode 17.0's tables
foldSenderForSearch(nick): string                 // foldForSearch, then rfc1459's mapping
searchFolding: string                             // "lower-base/17.0", which a store keeps
SearchText                                         // a branded Schema: 3 to 510 code points folded
searchableOf(content): { text, sender } | undefined
answering(added, answered): Level | undefined      // the level a store gives an added reply
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

Each Timeline names the **life** of its Network it belongs to, as each step's `life` gives it when the Timeline opens, which a removal of the Network names too. A Network given its id again after a removal opens its Timelines in its later life.

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
| `Confirmed` | `Confirmed` for its intent in the Network, with the Ircd's time, id, and text, and the `nicks` that text names. |
| `Refused` `Unsent` | `Unsent` for its intent in the Network. |
| `Refused` `Rejected` | `Rejected` for its intent in the Network, with the Ircd's `reply`: its numeric or standard reply's code, never text. `Offline` and `Unsendable` refuse a `Say` in its own step, before any Message is reported, so they place nothing and change nothing. |
| `Refused` with `action`, `Rejected` or `Unsent` | An action of ours refused after it left. `Described` if it opens the Channel its `action.where` names, as a `where` entry does, then one `Added` there, an `ActionRefused` item standing at the step's own time, with what the action tried, its intent, and the reason. It changes no Message's delivery. `Offline` and `Unsendable` refuse an action in its own step, which the `act` answer already said to whoever acted, so they place nothing, as for a `Say`. |
| `SessionBegan`, `SessionEnded`, `ConnectionFailed` | `Added` to the Network's Timeline, and a `Gap` as below. A `ConnectionFailed` item keeps the Ircd it was dialled to and whether it was open. |
| `Refolded` | `Described` for each Timeline whose key changes, and `Merged` for each that meets one opened before it, followed by `ReadMarker` for the one kept when the merged one was read further. |
| `ReadMarker` | `ReadMarker` for the Timeline its `where` names, when it moves that Timeline's Read Marker forward. |
| `TimelineClosed` | `Closed` for the Timeline its `where` names, when one has that key. Closing opens nothing. Whether it stays closed is the store's to derive, from what is added to it after. |
| A `TimelineRead` marking | `ReadMarker` for the Timeline it names, as below. |
| A `TimelineClosed` marking | `Closed` for the Timeline it names, unless it is a Network's own. |
| `ChannelLearned` | `HeadChanged` for the Channel's Timeline, when one exists, so a Frontend reads the Channel's head again. It opens no Timeline and adds no item. |
| `PartnerLearned` | `HeadChanged` for the partner's Direct Message Timeline, when one exists, so a Frontend reads whether they are there again. It opens no Timeline and adds no item. |
| `Unignored` | `Unignored` for the Network, with the masks the Owner no longer ignores. It places nothing. |
| `NetworkRemoved` | `Removed` for the Network, with `keep`. The Network leaves the directory, so an id given to a Network again opens its Timelines anew, and a removal of a Network the directory no longer holds, to drop what it kept, opens nothing. |
| `LookedUp` | Nothing. A Lookup's result is the answer to whoever looked, read through the API, not something said or done on the Network. |
| `Ignored` | Nothing. |

An `Added` item carries what a Frontend shows: for a Message its sender, Target, text, kind, client-only tags as `[name, value]` pairs, the id it `answers` by `+reply`, the Channel a Direct Message names as its `context` by `+channel-context`, whether its sender said it as a `bot`, the `prefix` its sender held in the Channel as it was said, the `nicks` its text names as spans of UTF-16 offsets into the text with formatting stripped, `live`, and its `at` and `id` facts, for an Activity the Activity itself, and for an `ActionRefused` what the action tried, never its text or a mode's parameter, its intent, and the reason, `Rejected` with the `reply` or `Unsent`. It carries the message id, when its fact is `Known`, and the intent of one of ours, so the store can keep one per id and find ours again, its **level** in that Timeline, below, and `ignored`, the canonical ignore masks the News's sender matched, empty when none did. An ignored item is placed, opening Timelines and taking its position, as any other is, and the store hides it until an `Unignored` takes its last mask off. One of ours starts `Pending` when `ours.echo` says the Ircd will echo it, and `Unconfirmed` when it will not. `delivered(before, change)` says how it stands after `Confirmed`, `Unsent`, or `Rejected`, the one rule every store applies: a confirmed Message stays confirmed, a change that would leave it as it is changes nothing, and otherwise the latest wins.

A **Gap** begins at a `SessionEnded`, or the first of a run of `ConnectionFailed`, while the Network is not already in one, and ends at the next `SessionBegan`. Each is reported as `Gap { from, to }`, once with `to` left out when it begins, and again with `to` when it ends. A Session that a restart ended began its Gap at the last step folded for the Network before it, since the Daemon may have been gone since then and the fold cannot tell.

## Read Markers and levels

The fold keeps each Timeline's **Read Marker**, how far the Owner has read it, as an instant, from the Client's `ReadMarker` News and from a `TimelineRead` marking, a Change that names a Timeline no Client can name by its id.

- **It moves only forward, per Timeline.** A `ReadMarker` sets the Read Marker of the Timeline its `where` names, `Network`, `Channel`, or `Direct`, only when it is later than the one the Timeline has, whatever the News says. So after a casemapping change, when the Client's marker for a key follows another spelling than the Timeline's, no Timeline's Read Marker moves back.
- **Marking read opens nothing.** A `ReadMarker` for a key no Timeline has changes nothing.
- **It goes with its Timeline.** A Direct Message Timeline renamed by `DirectRenamed` keeps its Read Marker, and one detached keeps it too, and receives no more. Of two Timelines merged, the kept one has been read as far as the later of their two Read Markers.
- **A marking moves it as News does.** A `TimelineRead` for a Timeline the directory holds, the Network's own or a keyed one, moves its Read Marker only forward there, so a Client's `ReadMarker` behind it moves nothing after. One for a Timeline the directory no longer holds, a detached one or a removed Network's, is told to the store by its id, as a `ReadMarker` change, which the store moves only forward. Marking opens nothing, and moves no Network's last step.

Each `Added` item has a **level**, how much it calls for the Owner in its Timeline, as WeeChat ranks activity, which a store counts what lies after a Read Marker by:

| Level | Items |
| --- | --- |
| `Highlight` | A Message whose `highlight` is set, wherever it stands, a live Message that answers one Self said, and an invitation happening now, since each is addressed to Self. |
| `Direct` | Any other Message in a Direct Message Timeline. |
| `Message` | Any other Message in a Channel's Timeline. |
| `Activity` | An Activity, a Session's start or end, a failed Connection, and a Message in the Network's own Timeline. |

A Message Self said, one with `ours` or `self`, has no level, and never counts, and neither does an `ActionRefused`, which is ours too, nor a `Numeric` Activity, a numeric the Ircd sent that nothing else reports, nor a `Motd`, the Ircd's message of the day. Only a store holds what a reply answers, so `answering(added, answered)` is the rule every store applies as it adds an item, before counting it: given the item in the same Timeline whose message id it answers, as the store holds it then, a live Message with a level becomes a `Highlight` when that item is a Message Self said, and otherwise keeps the level the fold gave it. One News placed in many Timelines can have a different level in each. `unreadCap` is the most a store counts of one level after a Read Marker: a count of `unreadCap + 1` means more than that.

## Closing

The Owner closes a Channel's or a Direct Message partner's Timeline, and the fold tells the store which, by its id, from the Client's `TimelineClosed` News. It keeps nothing of it in the directory: a Timeline is closed until something is added to it at a later step, which only a store, holding the items, can tell.

- **Closing opens nothing.** A `TimelineClosed` for a key no Timeline has changes nothing.
- **It goes with its Timeline.** A close is kept by the Timeline's id, which a rename, a refold, and a detach keep. A partner's rename is an Activity added to their Timeline, so it opens it, as anything arriving does, and a detached Timeline, which receives nothing more, stays as it was. Of two Timelines merged, the store keeps the one kept closed only when both were.
- **A marking closes by id.** A `TimelineClosed` marking tells the store to close the Timeline it names, whether the directory holds it or not, so a detached Timeline or a removed Network's is closed too, and stays closed, since nothing arrives in it. A Network's own is never closed: its id is the only one whose last part is `00000000`, so even a removed Network's is told apart.

## What a search finds

A store searches the Messages in its Timelines by their text, and every store finds the same ones, because they fold text one way, here.

A search finds a little more rather than miss a word for want of an accent: `résumé` and `resume` find the same Messages, and no search tells them apart. Latin text is what the fold is made for. Any other script folds by the same rules, and nothing is added to make it fold as Latin does.

- **`foldForSearch` lower-cases, then takes each letter to its base.** Each code point is lower-cased by Unicode's simple mapping, never by a locale's, so `É` finds `é`, `Σ` finds `σ`, and `İ` folds to `i`. Then it is decomposed by its canonical decomposition, followed to its end, and every mark of the Combining Diacritical Marks block, U+0300 to U+036F, folds to nothing. So `café` written whole, `cafe` with a combining accent, `CAFÉ`, and `cafe` all fold to `cafe`, with nothing composed.
- **Some letters have a base of our own.** A letter with a stroke folds to its letter, `ø`, `ł`, `đ`, and `ħ` to `o`, `l`, `d`, and `h`, and `ı` to `i`, and a ligature to its letters, `æ`, `œ`, and `ß` to `ae`, `oe`, and `ss`, with their capitals. No other letter is mapped.
- **Nothing else is taken off.** A mark of any other block is kept, such as a Devanagari vowel sign or a Japanese voicing mark. A compatibility decomposition is not followed, so `ﬁ` and a fullwidth `Ａ` stay as they are but for case, and a Hangul syllable, which Unicode decomposes by arithmetic rather than by its table, stays whole.
- **A fold is not one code point to one.** A mark folds to none and a ligature to two, so a text's count of code points changes. It folds a code point at a time, so the fold of a text is the folds of its code points, joined, and a Frontend marks a match by folding each character.
- **The fold reads pinned tables, never the runtime's.** The lower case is `src/lower-case.ts` and the bases `src/decompositions.ts`, both pinned to Unicode 17.0, the version the Client's word characters follow, so every runtime folds alike, and a store's index never depends on which one built it. `scripts/lower-case.ts` and `scripts/decompositions.ts` generate them, with `bun run generate:lower-case` and `bun run generate:decompositions` on a runtime of the version to pin. The first reads each code point's lower case from the runtime and takes the one the runtime expands, U+0130, from UnicodeData's simple mapping, refusing any other that expands. The second reads each lower-case code point's canonical decomposition from the runtime, but a Hangul syllable's, and drops the marks.
- **`foldSenderForSearch` compares nicks the `rfc1459` way.** A sender and the nick a search is kept to are both folded by `foldForSearch` and then by `rfc1459`'s mapping, which takes `[]\~` to `{}|^`, in every Network, whatever its casemapping, so `[a` finds `{a`. Under `ascii` that finds a little more, by choice, and no casemapping reaches a store.
- **`searchFolding`** names how text folds, `lower-base/` and the tables' Unicode version, so tables generated for another version change it. A store that keeps folded text keeps this beside it, and folds it again when it differs. Whoever changes how text folds otherwise changes the scheme's name too.
- **`SearchText`** is what a search looks for: one run of characters, found anywhere in a Message's text, of `searchTextMinimum`, 3, to `searchTextMaximum`, 510, the most a Line could carry, both counted in code points once folded, so three astral characters are enough, `ßa` is three, and a letter and its combining accent count one, with no line break or NUL, which no Message holds, and no lone surrogate, which is no character. A store finds text by its runs of three characters, so a shorter one could only be found by reading every Message, and so it cannot be made.
- **`searchableOf`** says what an item is found by: a Message's text, folded by `foldForSearch`, and its sender, folded by `foldSenderForSearch`, for a search kept to one sender. One of ours is found by the text the Ircd confirmed once it did, since that is what was said, and by our own text before. An Activity, a Session's start or end, and a refused action are found by nothing.

The fold does not change by any of this, so it changes no projection version.

## The projection version

`projectionVersion` is the version of what the fold gives. Bump it whenever News or the fold changes, in any way that would give a store different Timelines, ids, positions, or items. A store built with another version is reset and folded again from the Journal.

## Not yet

- **Encodings.** The directory, items, and changes are TypeScript types over plain data. The SQLite store keeps its own Schemas of what it writes, checked against these types, and the wire forms belong to `@iirc/api`.
- **Channel renames.** A Channel keeps the name it opened with. `channel-rename` would rename one in place, keeping its id, as `DirectRenamed` does.
