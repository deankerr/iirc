# @iirc/frontend

The pure core of the web frontend ([ADR 0010](../../docs/adr/0010-the-web-frontend-is-a-pure-core-under-react.md)). It holds what a Frontend shows as plain data and reducers, and React in [`apps/web`](../../apps/web/README.md) only renders it. It is pure, as `@iirc/client` is: it reads no clock, no randomness, no locale, and no time zone, does no I/O, uses no Effect service, and knows nothing of React or the DOM, which the lint fence enforces. It reads mIRC formatting and casemapping from `@iirc/protocol`, positions and how a search folds and counts text from `@iirc/timelines`, the Configuration's Schema from `@iirc/client/configuration`, and the `ui` options' Schema from `@iirc/api/ui`, all pure, parses TOML and YAML with Effect's own pure parsers, and takes the types of what the runtime parsed from `@iirc/api`, never its values.

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
olderUnasked(window, cap): boolean               // whether a view may read the page before without asking
OlderMode = "Auto" | "Asked"                     // how a page before was wanted
reduceTimelines(state: Timelines, event: TimelinesEvent): Timelines
wanted(state): readonly Read[]                    // the reads to make now, none already in flight
followFrom(state): Place | null | undefined       // where to follow the changes from, once it can
sidebar(state): readonly SidebarNetwork[]         // Networks by id, each with its Timelines, connection, and whether Self is away
opened(state, pane?): Opened                      // a Pane's open Timeline, the focused Pane's unless named: Closed, Vanished, Reading, or Shown, with its divider
focusedView(state): PaneView, openOf(state), mainOf(state)   // what the focused Pane shows, its open Timeline, and Timeline or Options
paneOf(state, timeline): string | undefined       // the Pane a Timeline is open in
keptLayout(state): KeptLayout | undefined         // the layout as a device keeps it, plain JSON, none while one kept waits
KeptLayoutSchema, layoutKept(kept): Layout<PaneView> | undefined   // read back at the boundary, then taken back for `Restore`
layoutKeptText(text): Layout<PaneView> | undefined   // both from the text kept, bounded first; never throws
longestKept: 65536
rowsOf(window, divider?): readonly Row[]          // a window's items, its collapsed Gaps among them, and the "new" divider
targetKey(window): string | undefined             // the key of the row of the item jumped to, which a view centres and marks
resolve(state, timeline): TimelineId              // the Timeline an id stands for, following merges

PaneView = { main: Timeline | Options { filter } | Search { back }, open: TimelineId | undefined, divider }   // emptyView: nothing open
BackView = Timeline | Options { filter }         // what a Pane showed before the search, which closing it shows
PaneChange = LayoutChange, but Split { axis, timeline }   // the Timeline the new Pane opens, or none

Read = Networks | List { network, after } | Status { network }
     | Latest { timeline, limit } | Older { timeline, before, limit }
     | Newer { timeline, after, limit } | Around { timeline, around, limit }
     | Search { filters, after, limit }      // each with `attempt`, a window's and a search's with `generation`
Window = { …, anchor, target }                    // read around `anchor` while it has one; `target` the item jumped to
```

| Event | From |
| --- | --- |
| `ReadStarted { read }` | The runtime took on a read `wanted` gave, so it is not asked for twice. It may wait before asking |
| `Requesting { read }` | The runtime is asking the Daemon now, after any wait, and again for each attempt after a failure |
| `NetworksRead`, `ListRead`, `StatusRead`, `WindowRead { read, window }` | What `GET /api/networks`, a page of a Network's Timelines, `known`, and a window answered. A window's answer names the read it answers, cursor and generation included |
| `Vanished`, `NetworkVanished` | A read answered `UnknownTimeline` or `UnknownNetwork` |
| `Changed { place, change }`, `Overflowed { place, overflow }`, `Reset { reset }` | The changes stream, with the place each event left it |
| `Opened { timeline }`, `OlderWanted { timeline, mode }`, `NewerWanted { timeline }` | The Owner opened a Timeline in the focused Pane, or the page before is wanted, `Auto` when the view reads it on its own, as near the top or when it cannot be scrolled, or `Asked` on purpose, which stays asked until read, or near its bottom with more beyond |
| `LatestWanted { timeline }` | The Owner jumped to a Timeline's latest: its window is read again from the latest, which replaces what it holds, and it follows from there |
| `Located { timeline, navigation }` | The Daemon placed a Message the Owner said with `opens`, as `/msg` does, in this Timeline, read from the step that said it, with the `navigation` its Say was submitted at |
| `Following { timeline, following, seen, owned? }` | The view says the Owner is at the latest of an open Timeline, with `seen` the last item in view, or left it. Only the view sends it, once it has laid out. `owned` says the Owner moved the view there themselves, by the wheel, a touch, a press, or a key, which only a window read around a result needs |
| `OptionsShown { filter }`, `OptionsFiltered { filter }` | The Owner showed the options, by `/set` or the sidebar, or typed in their filter |
| `Pane { change }` | The Owner changed the Panes, by a command or by dragging a divider, as `@iirc/frontend/layout` says below |
| `Restore { layout }` | The layout this device kept, read as the page starts |
| `SearchShown { query, parsed }` | The Owner showed the search, by `/search` or Mod+Shift+F, with a query and what `parseQuery` read of it, or neither to show what it last found |
| `SearchClosed` | The Owner closed the search, by Escape: its Pane shows what it showed before |
| `SearchChanged { change }` | The Owner typed in its field, `Typed`, wanted the next page, `More`, or moved to a result, `Selected` |
| `SearchRead { read, page }`, `SearchFailed { read, message }` | A page of the search `GET /api/search` answered, or why the runtime gave it up, in words |
| `Jumped { timeline, position }` | The Owner chose a result: its Timeline opens read around its position |
| `TargetLeft { timeline }` | The Owner scrolled the view away from the item jumped to |

- **It holds, per Network, its Timelines and its connection, and per Timeline opened, a window:** its items in position order, its collapsed Gaps, whether more lie `earlier` and `later`, and the `version` and `through` it was read at.
- **It follows the stream after the smallest `through` it read.** The Network list and every Network's Timelines are read first, a page at a time, and only then does `followFrom` give a place: the smallest `through` of the pages, with their version. Then the Network list is read once more, so a Network configured while the pages were read is not missed. A window is read only once the stream is followed.
- **One rule decides whether an answer is current:** nothing that invalidates what it is of happened after its read began. That is a reset, or the stream forgetting what it gave since then, either of which leaves no record of what changed, or an overflow that touched it, whose changes never came: for the Network list, one that touched everything; for a Network's Timelines or its connection, one that touched that Network; for a window, one that touched its Network or named its Timeline. The Network list and `known` are checked from where the stream was when the Daemon was last asked for them, as `Requesting` marks, so what the stream gave while the runtime waited to ask again never makes an answer stale; a page of Timelines or a window is checked from its own `through`. An answer that is not current leaves what it is of stale, and is asked for again with a higher `attempt`.
- **No change is lost or applied twice.** A Timeline is kept by its id and an item by its position, and the one changed last wins, so a change that comes again changes nothing. A window skips the steps it already reflects. While any read is in flight, what the stream gives is kept, and a read that lands after the stream passed its `through` is brought up to date from it, overflows included. A read older than anything kept, or of another version, is dropped, and asked again with a higher `attempt`, for the runtime to wait longer.
- **A new item lands only where it belongs by position.** In place of the item at its position, when it changed later, as a delivery does. Between the items loaded, as late history does. Past an end with nothing more beyond it, as a live item does at the latest. Anywhere else it is outside what the window holds. Late history inside a collapsed Gap of several may split it, so that window is read again.
- **A Gap lands in the windows of its Network.** One that ends closes the collapsed Gap holding it. One that begins after the last item joins a collapsed Gap already there, with no item between, or begins one. One among the items means history changed under the window, which is read again. Older items read before the window bring their Gaps, and a collapsed Gap held that begins inside one of theirs is the same run, seen whole.
- **Older items are read before the first item held, and newer after the last,** with the run of Gaps up to the cursor, as the API gives it. The cursor splits a run that crosses it into a part on each side, and the window joins two Gaps with no item between them into one run again, so pages fitted together show each run once. A page is brought up to date with what the stream gave on its own before it joins the window, which already reflects it.
- **A window holds at most `windowCap` items, 1000.** While the Owner is at the latest, a live item past the end is kept, and past the cap the oldest go, with the Gaps that ended before the first item kept, and `earlier` says more lie before. Away from the latest, a live item past the end is not kept: `later` says more lie after, the Gaps that began after the last item go too, and they are read after the last item when the Owner scrolls down. A page read before the window carries how it was wanted. One `Asked` drops the newest past the cap instead, and `later` then says more lie after. One `Auto`, merged into a window that holds the latest, never drops its newest: it drops its own oldest past the cap, and `earlier` says more lie before, so a live item that arrived while it was read is kept too. A view asks for one `Auto` only while `olderUnasked` says one more page fits. `earlier` and `later` are true exactly when something lies beyond, so everything dropped can be read again. A trim through a collapsed Gap of several, which may hold Gaps on both sides of the first item kept, reads the window again.
- **An answer is taken only by the window it was read for.** Each window is a generation of its Timeline's, and a window dropped and read again is a new one. A read names the generation it was made for and, before or after the window, its cursor, and its answer names that read. An answer for a window dropped or replaced since is ignored, without touching the window there is now or its read in flight. A page for an edge the window no longer has, as when the oldest were dropped past the cap while it was read, merges nothing, and is asked for again from the edge there is now.
- **Only the windows of the Timelines open in a Pane and those of the four closed most recently are kept.** A Timeline no Pane has open any more, as one another replaced, or whose Pane closed, joins the most recently closed. Any other window is dropped, and read again when opened. A window is read for every Timeline a Pane has open, the focused Pane's first. A Timeline opens in the focused Pane, on its latest: its window follows again, and one left behind the latest is read again.
- **A Timeline is open in one Pane at most.** Opening one another Pane has open focuses that Pane and shows it there again, changing nothing else: it keeps where the Owner scrolled, whether it follows, and its divider. So a Timeline's window, its `following`, its `seen`, and its divider are its Pane's alone, and two Panes never show one at different places, which a dense client gains little from and every rule of reading would have to say which Pane wins. It holds after anything: when a merge, or anything else, would leave two Panes on one Timeline, the focused Pane keeps it, or with neither focused the first in reading order, and the other is emptied, as a split with nothing to show is, its options kept if they show.
- **Only the view says what the Owner has seen.** A window's `seen` is the last item the view said is in view while at the latest, set only by `Following`, cleared when it says the Owner left, and forgotten when its Timeline leaves its Pane, so opening a Timeline never makes the core believe its latest was seen. A window read again keeps it, as the item is still the one shown.
- **No step notifies twice.** `considered` is the highest step the stream gave, for the page's life, through resets and overflows. It is a Journal sequence, which every projection version shares, and apart from the stream's place, which a reset moves back.
- **A merged Timeline follows its tombstone.** It leaves its Network's list, its window goes, and the Timeline the Owner opened resolves to the one it went to, which is read. A window read of a merged id says where it went, which is kept too.
- **An overflow reads again what it touched:** every Network whose Timeline it named, with its Timelines, its connection, and every window of it, since a Gap is the whole Network's. One that names a Timeline not held, or none, touched everything, and the Network list is read again too.
- **A reset drops what is held:** every list and window, read again, the Network list too, since a Network configured while the stream was away may be in the state the reset reaches with its first step never given, and the stream follows from the reset's place. A read of the Network list started before the reset, at a place older than the reset's, is read again rather than taken as current, as every other read is. A Network's connection stays shown until `known` is read again.
- **What each Pane shows is navigation, held here once:** its view's `main` is `Timeline`, its `open` one, `Options { filter }`, or `Search { back }`, each in front of its open Timeline. `Opened` shows the Timeline it opens, and so does a placement that opens one, so a `/msg` said while the options showed shows its Direct Message, with the composer under it. `OptionsShown` shows the options in the Pane they show in already, which takes the focus, or else in the focused Pane, so they show in one Pane at most, and like opening a Timeline, bumps `navigation`, so a placement from before is let go. A change of the Panes bumps it too when the focused Pane then shows something else, as when another takes the focus, or a split or a close moves it, but not when the view moves with the Owner, as a swap does. Nothing else says whether the options show.
- **A split opens what it names.** `Pane { Split { axis, timeline } }` opens that Timeline in the new Pane, with its divider, or leaves it empty when a Pane has it open already, or none is named. `/split` names the Timeline calling for the Owner most that no Pane shows, below, so a split shows something new to read; tmux and WeeChat show the same thing twice, which one Timeline per Pane rules out. The layout's own rules are below.
- **The layout is kept per device and taken back once the Timelines are read.** `keptLayout` gives the tree, each Pane's open Timeline as chosen and its options' filter, and the focus, as plain JSON, never a divider, which is taken afresh. `Restore` sets a layout aside until every Network's Timelines are read, then takes it, dropping each Pane whose Timeline no Network lists any more, its sibling taking its place, and a second Pane with a Timeline open in another, or the options showing in another, is empty. With no Pane left it changes nothing, and once the Owner went anywhere, it is let go. `layoutKeptText` reads the text a device kept: longer than `longestKept`, 64 KB, or nested deeper than a layout of `deepestSplits` could be, by a scan that does not recurse, it is refused before anything parses it, and then whatever is not JSON, not of the Schema, or not a layout `layoutFrom` takes is refused too, so no text makes it throw. While it waits, `keptLayout` gives none, so the layout the page starts with never writes over it.
- **The Timeline a Message said with `opens` was placed in opens by its id, never by its name.** The Daemon's routing chose it, so two Users whose nicks only another casemapping folds together, such as `[bob]` and `{bob}` under `ascii`, are never confused. It opens as soon as its Network lists it, at once when it already does, and only when it is a Direct Message Timeline that still follows its partner: a Message to a Channel opens nothing. Each `Opened` bumps `navigation`, which a placement captures as its Say is submitted, so a `Located` from before the Owner opened another Timeline is ignored, however late it lands, and opening another lets a pending one go.
- **The "new" divider stays where the Timeline opened.** A Timeline opened with something said unread, a Highlight, a Direct Message, or a Message, keeps the Read Marker it had then as its Pane's `divider`, and `rowsOf` puts a `New` row before the first item after it, or before the first item held when it had none. It stays while the Timeline stays open in its Pane, opened again included, and moves with it when Panes swap, so it does not jump as the Daemon's Read Marker moves, and opening another there lets it go. Opened with only Activity unread, or nothing, it has none.
- **The page has one search, shown in one Pane at most.** `SearchShown` shows it in the Pane it shows in already, which takes the focus, or else in the focused Pane, in front of its Timeline, keeping what that Pane showed as `back`, so `SearchClosed` shows the options again, unless they show in another Pane since, or its Timeline. Like the options, it bumps `navigation`. Opening a Timeline there, by the sidebar, a placement, or a jump, shows the Timeline in its place. What the search found is the state's `search`, kept while no Pane shows it, so showing it again with no query shows it as it was, and a page is read only while a Pane shows it. A search is never kept with the layout: a Pane kept comes back as what it showed in front of. How a query is read and pages are taken is `@iirc/frontend/search`'s, below.
- **The search begins again when its pages could repeat.** A step whose changes merge a Timeline moves its items into one with a lower id, so the API's pages read on either side of it may give an item twice, and the search is begun again from its first page, as a new generation, as the API asks. So it is on any overflow, which may have been a merge whose changes never came, and on a reset, whose positions may be another version's.
- **A jump opens a Timeline read around a position, as a window of its own.** `Jumped` opens the result's Timeline, a merge followed, in the Pane that has it open already, or the Pane the search shows in, or the focused Pane, which takes the focus, so a Timeline is still open in one Pane at most, and the search stays where it is when another Pane had it. Its window is replaced by a new generation, read `Around` the position, `anchor`, never following, so an answer for the window it replaced, as the latest read in flight, is never taken, and a live item past its end waits beyond it, `later` saying so. `target` is the item there, which a view brings to the middle and marks. Nothing is marked read by it: while a window is anchored, a `Following` that says it is at the latest is ignored unless `owned`, so a jump to a result near the latest, or to a Timeline that fits the view, which a layout finds at the latest, never sets `seen` or `following`, and nothing is marked until the Owner moves to the latest themselves, jumps to it, or runs `/latest`. A window anchored so is read again around its anchor when it goes stale, until the Owner reaches its latest, an `owned` `Following` with `following`, or asks for it, `LatestWanted`, or opens it again, any of which reads it from the latest after. `TargetLeft`, `LatestWanted`, and opening it again let the target go.
- **Whether Self is away is Knowledge's, read when it changes.** A Network's `away` is `Here`, `Away { message }`, or `Unknown`, as `known`'s Self says the Ircd confirmed it while registered, read with the connection. A `SessionBegan` makes it `Here`, as a Session begins, and a Session's end `Unknown`. An `AwayChanged` in the Network's own Timeline, where the Client places Self's, including the `305` and `306` that answer an `AWAY`, has `known` read again, and a read that began before such a change is read again too, so it is never polled and never guessed from an item, which might name another User whose nick is not one.
- **A Network's connection is derived, not polled.** It comes from `known` once, and then from the Session items the changes carry, `SessionBegan`, `SessionEnded`, and `ConnectionFailed`, each applied only when it is later than what set the connection. `known` says what the Client knows now, connecting and registering included, which no item says, and the latest Session item may lie anywhere in the Network's Timeline, beyond any window. A `known` read is taken only if no Session item later than the stream's place when it started already said more, and is read again if it started before a reset or an overflow of its Network.

## Panes

`@iirc/frontend/layout`: the Panes, as a split tree in a pure reducer ([ADR 0012](../../docs/adr/0012-the-web-frontend-builds-on-react-aria-and-resizable-panels.md)). It knows nothing of what a Pane shows, nor of the screen: the Timelines hold a layout of `PaneView`s, and a view renders the tree and sends back the ratios the Owner dragged.

```ts
single(view): Layout<V>                           // one Pane, p0
reduceLayout(layout, change: LayoutChange<V>): Layout<V>
panesOf(node), splitsOf(node), focusedPane(layout)
shownPanes(layout, compact): readonly Pane<V>[]   // the focused one alone while zoomed or compact
mapViews(layout, change), withView(layout, pane, view)
rectsOf(layout): ReadonlyMap<string, Rect>        // each Pane's place in the unit square
neighbour(layout, direction): string | undefined  // the Pane beside the focused one
keeping(layout, keep): Layout<V> | undefined      // without the Panes `keep` drops
layoutFrom(kept, view): Layout<V> | undefined     // a layout kept, taken back
resizeStep: 0.05, leastShare: 0.01, mostPanes: 64, deepestSplits: 16

Layout<V> = { root: Node<V>, focused, zoomed, next }
Node<V> = Pane { id, view } | Split { id, axis: "Horizontal" | "Vertical", children: readonly { node, ratio }[] }
LayoutChange<V> = Split { axis, view } | Close | Focus { pane } | Move { direction } | Swap { direction }
                | Equalize | Grow | Shrink | Resize { split, ratios } | Zoom
Direction = "Left" | "Right" | "Up" | "Down"
```

- **A layout is well formed, whatever is done to it.** Every Split has two children or more, none a Split along its own axis, whose children join it, each sharing its share, and its ratios are positive and sum to 1. Each id is `p` for a Pane or `s` for a Split and a number from the counter `next`, never from randomness, and is never used twice. The focus is always on a Pane.
- **A layout is bounded:** at most `mostPanes`, 64, Panes, and Splits nested at most `deepestSplits`, 16, deep. A split past either changes nothing, so every layout can be kept and taken back.
- **No Pane is made smaller than `leastShare`, 1%, of its Split.** A split that would halve a Pane below it changes nothing, as a drag that would leave a child below it does. A share joining a Split into its parent left below it, as a close can, stays as it is: growing and shrinking never move it, and the view's least size draws it.
- **A split halves the focused Pane.** The new Pane goes after it, `Horizontal` side by side, as tmux's `-h`, i3's `split h`, and the library's `horizontal` mean it, or `Vertical` one above another, and takes the focus.
- **A close gives the place to the sibling, and the focus to its Pane nearest where the closed one was:** the last of the one before, or the first of the one after. The last Pane never closes.
- **The focus moves as the screen lies, as tmux and i3 move it.** Of the Panes whose edge touches the focused Pane's on that side, it goes to the one across from the focused Pane's middle, or, when the middle falls on an edge between two, the first along it. At the edge of the layout it stays, with no wrapping.
- **A swap moves the focused Pane, and the focus with it.** The focused Pane and its neighbour change places, each whole, its id and view with it, while each place keeps its share, so the focus stays on the same Pane and each Pane's content moves rather than being drawn afresh, where it was scrolled kept.
- **Sizes are shares.** `Equalize` gives every Split's children equal shares. `Grow` and `Shrink` move the focused Pane's share of its Split by up to `resizeStep`, never moving a share past `leastShare`: growing takes from each other child in proportion to what it has above the least share, so one below it gives nothing, and shrinking gives to each in proportion to its share, a focused share at or below the least staying as it is. So growing never shrinks the focused Pane and shrinking never grows it. `Resize` takes a Split's ratios from the view, scaled to sum to 1, and ratios of another length, not finite, or leaving a child below `leastShare`, change nothing.
- **A zoom shows the focused Pane alone, and toggles back to the very layout it was.** It changes nothing in the tree. Moving the focus keeps it, showing the Pane moved to, a split or a close ends it, and a single Pane never zooms. `shownPanes` gives the focused Pane alone on a compact screen too, as a phone's, where the layout is kept as it was.
- **A layout kept is taken back, or not at all.** `layoutFrom` reads a tree whose ids are well formed and each used once, within the bounds, each view read by the caller, and refuses anything else, recursing no deeper than the bounds allow. It settles what it takes, as every change does, the focus falls back to the first Pane, and the counter goes past every id.

## Search

`@iirc/frontend/search`: the Owner's query read into the filters of `GET /api/search`, the search as a reducer over the pages it reads, and what a result shows, its match marked. The Daemon reads no syntax from a query, so the words here are a Frontend's, as [the API's README](../api/README.md) says.

```ts
parseQuery(query, context: QueryContext): Parsed<SearchFilters>
QueryContext = { networks: readonly { network, timelines }[], focused: NetworkId | undefined, dayStart: (day: Day) => number }
SearchFilters = { text: SearchText, network, timeline, from, since, until }   // each but text may be undefined
Day = { year, month, day }

initialSearch, reduceSearch(search, event: SearchEvent): Search
searchWanted(search): SearchRequest | undefined  // the next page, while one is wanted and none in flight
capped(search): boolean                           // stopped at searchCap with more beyond
searchPage: 100, searchCap: 500
resultKey(item), matchRuns(text, sought): readonly MatchRun[], foundOf(item, sought): Found | undefined

Search = { query, searched, error, results, next, more, version, generation, wanted, reading, attempt, selected }
SearchEvent = Typed { query } | Submitted { query, parsed } | Restarted | More | Selected { index }
            | Started { read } | Read { read, page } | Failed { read, message }
MatchRun = { text, match }
Found = { key, item, kind, nick, colour, runs }
```

| Word | Searches |
| --- | --- |
| `text`, `"a phrase: with colons"` | The words that are not filters, joined by one space, as one run of text the API finds anywhere in a Message. A quoted run is kept whole, spaces and colons included |
| `from:<nick>` | Messages by that sender, compared whole as the API folds it |
| `in:<#channel\|nick>` | One Timeline, found by name on the Network `network:` names, or else the Network in focus, or else on any |
| `network:<id>` | One Network the Frontend holds |
| `since:<date>`, `until:<date>` | `YYYY-MM-DD`, a day in the Owner's time zone, `until:` taking the whole day, or an ISO time with its zone, such as `2026-11-10T09:30Z` or `+01:00` |

- **A query is parsed, or refused in words.** A word is a filter when its name is ASCII letters before a `:`, in any case, and its value may be quoted. A name no filter has, such as `http:` in a link, is refused, saying to quote it, so a query never searches something other than what was typed. A filter given twice or with no value, a quote not closed, a nick with a space, a Network the Frontend does not hold, a date that is no day of the calendar, a time that is none, with hours past 23, minutes or seconds past 59, so no `24:00` and no leap second, a time with no zone, an offset past RFC 3339's, hours past 23 or minutes past 59, and `since:` not before `until:` are each refused in words. The text is the API's own `SearchText`, 3 to 510 characters once folded by `foldForSearch`, counted in code points, so `hi` says to search for at least three, and a query of filters alone says what to search for.
- **`in:` is found, never guessed.** A Timeline whose name is exactly the word first, then one the Daemon keyed by it, as written or with its ASCII letters lower-cased, which every casemapping folds alike, so a name only another casemapping folds together, such as `[bob]` and `{bob}`, is never taken for another. A detached Direct Message Timeline is found only when nothing else is. One found on several Networks says which they are and to add `network:`, and several on one Network says so, rather than choose one.
- **The core reads no time zone.** A date names a day in the Owner's time zone, and `dayStart` is the runtime's, the instant that day begins there, so a day that begins at another offset, as one that changes the clocks does, is read right. An ISO time with its zone needs none, and its instant is counted from the calendar with no clock. A time with no zone is refused rather than read in some zone.
- **Pages are taken by the search they were read for.** `Submitted` and `Restarted` begin it again as a new generation, its results dropped, and a page or failure of another generation is ignored. Each page goes after the last, a result already held, by its Timeline and position, left out, and `next` where the next begins. A page after the first read at another projection version does not fit the pages before it, so the search begins again, with a higher `attempt` for the runtime to wait longer. `More` wants the next page only while more lie beyond, none is in flight, nothing failed, and fewer than `searchCap`, 500, are held: past it, `capped` says the newest 500 are shown, and the Owner narrows the search to find older ones. `Selected` stays among the results.
- **A match is marked in the text shown, never by markup.** `matchRuns` takes a Message's text as plain text, by `plainCharacters`, formatting stripped and every control and bidirectional formatting character dropped, finds what was sought as the Daemon does, each character folded by `foldForSearch`, one code point to one, so each run's characters are the text's own, and gives it as runs, each a match or not. A view puts each in a text node, a match in a `<mark>`. `foundOf` gives a result as a view shows it: its sender as plain text with their colour, its kind, and the text the Ircd confirmed for one of ours, as it is found by. Only a Message is ever found.
- **Plain data.** A search survives `structuredClone`.

## Commands

`@iirc/frontend/commands`: the one registry of commands ([ADR 0010](../../docs/adr/0010-the-web-frontend-is-a-pure-core-under-react.md)), as data, behind the composer's `/commands`, the palette, the keymap, and, later, agents. A command never does anything: it gives intents, plain data the runtime carries out.

```ts
commands: readonly Command[]                      // in the order a list shows them
commandNamed(name): Command | undefined           // by name or alias, in any ASCII case
commandWithId(id): Command | undefined            // by id, as a keybinding names it
unmet(when, context): string | undefined          // the first condition that does not hold, in words
runIn(command, args, context): Parsed<readonly Intent[]>   // once its conditions hold
interpret(line, context): Parsed<readonly Intent[]>

typesCredential(line): boolean                    // a line that types a Credential: a value after /set, or a raw PASS, AUTHENTICATE, or OPER
credentialRefusal(line): string | undefined       // why, in words

Command = { id, name, aliases, usage, arguments: "None" | "Optional" | "Required", description, when: readonly Condition[], run(args, context) }
CommandContext = { focus: Focus | undefined, session: boolean, timelines: readonly TimelineId[], open: TimelineId | undefined, shown: readonly TimelineId[], panes: number, unread: readonly Unseen[], head: ChannelHeader | undefined }
// timelines: every one in the sidebar's order; open: the focused Pane's, even while it is read; shown: those open in any Pane
// unread: every one with something unread, in the sidebar's order
// head: the focused Channel's head as last read, with its topic and the Network's PREFIX, CHANMODES, and CHANTYPES
Unseen = { timeline, level: Level, mark: MarkRead | undefined }   // its highest level, and marking it read up to its latest
Focus = { network, timeline, kind: "Network" | "Channel" | "Direct", name, detached, key }   // key: as the Daemon folded it
Condition = Focused | Target | Channel | Session | Panes   // Channel: the focus is a Channel's; Panes: more than one
Parsed<A> = Parsed { value: A } | Invalid { message }
Intent = Say { network, target, kind: "Privmsg" | "Notice" | "Action", text, opens }
       | Act { network, action: ActionRequest }   // the Daemon's `act`: Topic, Kick, Mode, Invite, Nick, Away, or Raw
       | OpenOptions { filter }                   // show the options view, filtered
       | Configure { network, edit: Edit }        // read, apply the edit, send it whole
       | ChangeUi { option, value, device }       // a `ui` option set (value as JSON) or unset (none), on this device alone with `device`
       | UseTheme { name, device }                // draw in a theme there is, for every device or this one
       | EditThemes { edit: ThemesEdit }          // read the themes imported, apply the edit, send them whole
       | ListThemes                               // open the palette on the themes alone
       | ImportTheme                              // open the dialog that reads a theme file
       | AddNetwork { network, configuration }    // configure a Network that must not exist yet
       | PromptCredential { network, path }      // ask for a Credential option's value in a password prompt
       | Open { timeline }                        // open a Timeline in the focused Pane, or focus the Pane it is open in
       | OpenPalette                              // open the command palette
       | FocusComposer { text }                   // focus the composer, starting an empty draft with text
       | MarkRead { network, timeline, target, read }   // the Daemon's `read`: target the name, null for the Network's own
       | Notify { on }                            // turn notifications on or off on this device
       | ShowMembers { shown }                    // show or hide the members on this device, or turn them over when none
       | Query { network, name }                  // open the Timeline a name keys, or start `/msg <name> ` in the composer
       | Pane { change: PaneChange }              // change the Panes
       | Search { query }                         // show the search, searching the query, read by the runtime, or none
       | Look { network, timeline, lookup, ranks }  // the Daemon's `look`, Whois or Whowas, its card over the Pane with `timeline` open
// `opens`: once said, open the Direct Message Timeline the Daemon placed it in
```

| Command | Aliases | When | Gives |
| --- | --- | --- | --- |
| `/say <text>` |  | `Target`, `Session` | `Say Privmsg` to the open Timeline |
| `/me <text>` | `/action` | `Target`, `Session` | `Say Action` to the open Timeline, a CTCP `ACTION` |
| `/msg <target> <text>` | `/privmsg` | `Focused`, `Session` | `Say Privmsg` to the Target, with `opens` |
| `/notice <target> <text>` |  | `Focused`, `Session` | `Say Notice` to the Target |
| `/join <#channel>[,…]` |  | `Focused` | `Configure` with `Join`, on the open Timeline's Network, each name as given: its prefix is settled when it is applied, below. A key is a Credential option, so `/join #a key` is refused, saying how to set one |
| `/part [#channel[,…]]` | `/leave` | `Focused` | `Configure` with `Part` of the Channels named, or, with none, `PartTimeline` of the open Channel, by the key the Daemon routed it under |
| `/topic [text \| -delete]` |  | `Channel`, `Session` | `Act` `Topic` of the open Channel, the text kept exactly. `-delete` clears it, as WeeChat's does. With nothing, `FocusComposer` with `/topic ` and the topic as the head last read it, formatting codes and all, to edit, or `/topic ` alone with none set. `Invalid` while the topic is not known |
| `/kick <nick>[,<nick>…] [reason]` |  | `Channel`, `Session` | `Act` `Kick` from the open Channel, the reason the rest of the line, `null` with none |
| `/mode [target] <changes> [params…]` |  | `Focused`, `Session` | `Act` `Mode`, the target the open Channel when the first word starts with `+` or `-`, unless that word starts with a character of `CHANTYPES`, RFC 2811's `#&+!` until a head says, and the second word reads as changes, so `/mode +local +m` changes `+local`, while `/mode +m` and `/mode +l 5` change the open Channel. Each letter after a sign is a change. On a Channel, by `CHANTYPES`, each takes the next parameter exactly as `PREFIX` and `CHANMODES` say, read from the head, and a letter neither names, a change short of its parameter, or a parameter left over is `Invalid`. On Self, none takes one |
| `/op`, `/deop`, `/voice`, `/devoice` `<nick>…` |  | `Channel`, `Session` | `Act` `Mode` of the open Channel, `+o`, `-o`, `+v`, or `-v` for each nick, once the head's ranks have that mode: a Network whose `PREFIX` has no `v` says so, naming the ranks it has |
| `/ban <nick\|mask>…`, `/unban <nick\|mask>…` |  | `Channel`, `Session` | `Act` `Mode` `+b` or `-b` of each, a bare nick, with no `!` or `@`, as `nick!*@*`, once `CHANMODES` lists `b` |
| `/invite <nick> [channel]` |  | `Focused`, `Session` | `Act` `Invite` to the Channel named, or the open one |
| `/away [message]`, `/back` |  | `Focused` | `Act` `Away` with the message, kept exactly; with none, or `/back`, `null`. It needs no Session, since the Daemon keeps it for every Session after |
| `/nick <nick>` |  | `Focused`, `Session` | `Act` `Nick`: one word |
| `/quote <raw line>` | `/raw` | `Focused`, `Session` | `Act` `Raw`, the rest of the line exactly. One whose command, after any tags and source, in any case, is `PASS`, `AUTHENTICATE`, or `OPER`, which carry a Credential and the Client never sends written as text, is refused and cleared from the composer, as below |
| `/set` |  |  | `OpenOptions`, unfiltered |
| `/set <pattern>` |  |  | `OpenOptions`, filtered by the pattern |
| `/set <credential option>` |  |  | `PromptCredential`: the password prompt asks for its value |
| `/set <option> <value>` |  |  | `Configure` with `Set`, the value being the rest of the line, exactly, checked in its syntax first. Empty text, or an empty list, is a value. A Credential option is refused here |
| `/unset <option>` |  |  | `Configure` with `Unset` |
| `/set ui.<option> <value>` |  |  | `ChangeUi`, the value parsed in its syntax and then by its Schema, for every device |
| `/set -device ui.<option> <value>` |  |  | `ChangeUi` with `device`: this device alone overrides the option. Only an option under `ui` can be, so any other is refused in words, saying how |
| `/unset [-device] ui.<option>` |  |  | `ChangeUi` with no value: back to its default for every device, or with `-device`, this device back to the shared value |
| `/theme` |  |  | `ListThemes`: the palette, on the themes alone |
| `/theme <name>` |  |  | `UseTheme` for every device, the name in any ASCII case. The runtime draws in it only once it names a theme there is, and says so in words otherwise |
| `/theme -device <name>` |  |  | `UseTheme` with `device`: this device alone draws in it |
| `/theme import` |  |  | `ImportTheme`: the import dialog. Nothing may follow it |
| `/theme remove <name>` |  |  | `EditThemes` with `Remove`. `import` and `remove` are words of the command, so no theme is named either |
| `/network add <id> <host>[/port] [plain] <nick>` |  |  | `AddNetwork`, enabled, with that Ircd and nick and every other field as a new Network starts |
| `/next` |  |  | `Open` of the Timeline after the open one in the sidebar's order, wrapping to the first, or the first when none is open. Nothing when it is the only one, and `Invalid` when there are none |
| `/previous` | `/prev` |  | `Open` of the Timeline before, wrapping to the last, or the last when none is open |
| `/latest` |  | `Focused` | `Latest` of the open Timeline: its latest read again, whole, and followed, whatever its window holds |
| `/next-unread` | `/jump` |  | `Open` of the Timeline calling for the Owner most, below. Nothing when none does |
| `/read` |  |  | `MarkRead` of the open Timeline up to its latest item, as the Daemon listed it. Nothing when nothing is unread there |
| `/read all` |  |  | `MarkRead` of every Timeline with something unread, each up to its latest |
| `/notify on`, `/notify off` |  |  | `Notify`: on asks the browser's permission first |
| `/query <nick>` |  | `Focused` | `Query` on the open Timeline's Network: one name, no space or `,`, and no text after it, which `/msg` says |
| `/whois <nick>`, `/whowas <nick>` |  | `Focused`, `Session` | `Look` of `Whois` or `Whowas` on the open Timeline's Network, the nick read as the Client reads one, below, with the ranks of the focused Channel's head, or RFC 1459's `(ov)@+` |
| `/members [on\|off]` |  |  | `ShowMembers`: turned over with nothing after it |
| `/palette` |  |  | `OpenPalette` |
| `/search [query]` |  |  | `Search` with the query, trimmed, which the runtime reads with `parseQuery` and searches, or with none, which shows the search as it was |
| `/focus` |  |  | `FocusComposer`, its draft kept |
| `/split [h\|v]` |  |  | `Pane` `Split`: `h`, the default, side by side, `v` one above another, opening the Timeline calling for the Owner most, as `/next-unread` chooses, of those no Pane shows, or an empty Pane |
| `/close` |  | `Panes` | `Pane` `Close` |
| `/pane left\|right\|up\|down` |  | `Panes` | `Pane` `Move`, in any ASCII case: `/focus` already names the composer |
| `/swap left\|right\|up\|down` |  | `Panes` | `Pane` `Swap` |
| `/equalize`, `/zoom`, `/grow`, `/shrink` |  | `Panes` | `Pane` `Equalize`, `Zoom`, `Grow`, `Shrink` |

- **A line is read one way.** Plain text is `/say` to the open Timeline. `//text` says `/text`. `/name args` runs the command named, once its conditions hold. A bare `/`, or a name no command has, is `Invalid`, and nothing is sent.
- **Arguments are parsed, not validated.** A command's parser gives typed arguments or says why it cannot, in words that name its usage: no text, no Target, or a list of Targets, since a list is never one Timeline and the Client sends no `PRIVMSG` to one. The text after a Target is kept exactly, spaces included.
- **Each unmet condition says why.** Plain text in the Network's own Timeline has no Target to say it to, and the words say to open a Channel or a Direct Message, or use `/msg`. A detached Direct Message no longer follows its partner. A Network with no Session can be told nothing, though a command that needs none would still run. With one Pane, there is nothing to close, move to, swap, size, or zoom, and `/split` makes another, so the palette does not list those, and their keys are let through.
- **`/next-unread` jumps as WeeChat's `jump_smart` does.** It goes to the Timeline whose highest unread level is highest, Highlights, then Direct Messages, then Messages, ties going to the first in the sidebar's order, skipping the open one. Activity alone is not enough, since joins and quits pile up in every Channel and the Network's own Timeline. With nothing calling, it gives no intents, so Alt+A is still taken and types nothing.
- **`/read all` is one mark per Timeline.** A mark that would change nothing, as for a Timeline already read up to its latest, is left out, and a detached Direct Message has none, since its partner's nick may now name another Timeline. Each mark only moves a Read Marker forward, so marking everything is safe to repeat. It is there because clearing every count after time away is otherwise a Timeline at a time.
- **Acting is parsed as the Client checks it.** An action's arguments are read into the `act` route's own action, and what depends on the Network, a mode's parameter, a rank, or the ban list, is read from the head of the Channel in focus: `PREFIX`, `CHANMODES`, and `CHANTYPES` are the Network's, so they hold for any Channel on it. Before a head is read, a command that needs them says so rather than guess. What the Client then refuses, as past `TOPICLEN`, comes back as `act`'s answer, and what the Ircd refuses later as an `ActionRefused` item in the Timeline it belongs to.
- **A new command is one entry.** `/set`, `/join`, `/network add`, and `/next` are entries like the rest, and the palette and the keymap add none of their own: moving between Timelines and opening the palette are commands that `/` reaches too.
- **Each command says whether it takes arguments.** `None`, `Optional`, or `Required`, so the palette runs one that needs none, and starts one that does in the composer.
- **Configuration is changed by intents, never in place.** `/join`, `/part`, `/set`, and `/unset` name an edit, which the runtime applies to the Configuration it reads, so a change made while another Frontend changed the Network applies to what is there then.
- **`/query` opens a Timeline by name, and never makes one.** The runtime reads `known` for the casemapping the Network last declared, and `queried` opens the Timeline its Network lists under the name folded by it, or `rfc1459` until one is declared, as the Daemon keys Timelines, so `/query [BOB]` opens `{bob}`'s under `rfc1459` and not under `ascii`. `rfc1459` stands in only when `known` answered that none was declared: a `known` that cannot be read opens nothing and says so in words under the composer, since a mapping guessed could open another User's Direct Message. Like a `/msg` placement, a `/query` the Owner moved on from, by opening a Timeline or the options while `known` was read, is let go of. A Timeline exists only once something was said in it ([ADR 0011](../../docs/adr/0011-timelines-are-a-projection-the-client-routes.md)), and the API has no route that makes one without saying something, so with none it starts `/msg <name> ` in the composer, as `FocusComposer` does, and the first Message said opens it.
- **A Lookup's nick is read as the Client reads one.** One name, trimmed, with no space, U+0020 alone as the Client counts one, `,`, `*`, `?`, `!`, or `@`, not starting with `$`, `:`, a character of `CHANTYPES`, or a rank's symbol, each as the focused Channel's head says them, or as the Client takes them before an Ircd says, `#&` and `@+`, so `/whois #iirc`, `/whois @peer`, and `/whois *!*@host` say why in words and send nothing. It also refuses NUL, CR, and LF, which the API refuses before the Client reads a nick. No route gives a Frontend `STATUSMSG`, so a name starting with one of its characters is read as a nick, as the Client reads one given none, and the Client refuses it as `Unsendable`, which the card says. [`fixtures/nicks/vectors.ts`](../../fixtures/nicks/vectors.ts) holds both readings to the same cases, the differences listed with why.
- **A Credential's value never goes through the composer, nor any intent.** `/set <credential option>` alone asks for it in a password prompt, which gives it to the Vault itself. A value typed after it is refused, and so is a `/quote` or `/raw` of `PASS`, `AUTHENTICATE`, or `OPER`, by either name and in any ASCII case, and the composer clears at once, below.

## Keymap

`@iirc/frontend/keymap`: keybindings as data over the registry. A binding names a chord, a command by its id, the text it is given as arguments, and a `when`, and a key pressed resolves to that command's intents, or to nothing, so a key no binding takes is never swallowed.

```ts
parseChord(text): Parsed<Chord>, formatChord(chord): string, showChord(chord, platform): string
chordOf(event: KeyEvent, platform): Chord | undefined
parseWhen(text): Parsed<When>, parseBinding(text: BindingText): Parsed<Binding>
keymapOf(texts): Keymap                           // drops each binding that does not parse
defaultBindings, defaultKeymap
resolve(keymap, context: KeyContext, event: KeyEvent): readonly Intent[] | undefined
chordsFor(keymap, command): readonly Chord[]     // to show beside a command

Chord = { mod, ctrl, meta, alt, shift, key: KeyName }
KeyEvent = { key, code, ctrl, meta, alt, shift, altGraph }   // the browser's, as plain data
KeyContext = { command: CommandContext, editing, palette, platform: "Mac" | "Other" }
Binding = { keys: Chord, command, args, when: readonly { key: "editing" | "palette", is }[] }
```

| Keys | Command | When |  |
| --- | --- | --- | --- |
| `mod+k`, `mod+shift+p` | `palette.open` | `!palette` | Open the palette, from the composer too |
| `alt+arrowdown`, `alt+arrowup` | `timeline.next`, `timeline.previous` | `!palette` | Move through the sidebar's order, from the composer too, as an IRC client's keys do |
| `alt+a` | `timeline.unread` | `!palette` | Jump to the Timeline calling most, as WeeChat's Alt+A does, Option+A on a Mac, from the composer too |
| `alt+m` | `members.toggle` | `!palette` | Show or hide the members, Option+M on a Mac, from the composer too. Mod+Shift+M is the browser's own in Chrome and Firefox |
| `mod+,` | `options.set` | `!palette` | Show the options |
| `mod+shift+f` | `search.open` | `!palette` | Show the search, from the composer too, with its field focused. Mod+F stays the browser's own find |
| `i` | `composer.focus` | `!editing && !palette` | Focus the composer, from outside a field |
| `alt+shift+arrowleft`, `…right`, `…up`, `…down` | `pane.focus` with `left`, `right`, `up`, `down` | `!palette` | Move to the Pane in that direction, as Alt and the arrows move between Timelines, from the composer too |
| `alt+shift+s`, `alt+shift+d` | `pane.split` with `h`, `v` | `!palette` | Split side by side, or down |
| `alt+shift+w`, `alt+shift+z`, `alt+shift+e` | `pane.close`, `pane.zoom`, `pane.equalize` | `!palette` | Close, zoom, equalize |
| `alt+shift+g`, `alt+shift+r` | `pane.grow`, `pane.shrink` | `!palette` | Grow and shrink, Reduce, by a step |

- **A chord is parsed, not validated.** Its text is modifiers, each once, then one key, joined by `+`, in any ASCII case: `mod`, `ctrl`, `meta`, `alt`, and `shift`, with `cmd`, `command`, `control`, `opt`, and `option` read as theirs, and a named key, such as `arrowup`, `enter`, `escape`, `space`, `tab`, `f1` to `f12`, or `plus` for `+`, or one printable character. A `KeyName` exists only once parsed. `formatChord` writes a chord so that it parses back to the same one.
- **`mod` is Cmd on a Mac and Ctrl elsewhere,** as the runtime says. `ctrl` and `meta` name those keys on every platform, so `ctrl+k` elsewhere is `mod+k`. `showChord` writes a chord as the platform does: `Ctrl+Shift+P`, or `⇧⌘P` on a Mac.
- **A key event is the layout's character,** ASCII letters lower-cased, with no modifier or Shift alone, so an AZERTY `é` binds as `é`, not as the `2` its physical key is on QWERTY. The physical key, a letter or digit, names it only where that character says less: a dead key or a key with no character; with Alt, as Option and AltGr are, a character other than the physical key's; and with Ctrl or Cmd, a character outside ASCII. A key an input method is processing is no chord.
- **AltGr in a field is typing.** A key event says whether AltGr is held, as the browser's `getModifierState("AltGraph")` does, since some platforms report AltGr as Ctrl and Alt too. While editing, a printable character typed with AltGraph, such as German AltGr+Q for `@`, resolves to nothing and is typed. Ctrl+Alt without AltGraph is a chord, so a US `ctrl+alt+k` binding works in a field. Outside a field AltGr is a chord like any other.
- **A `when` is parsed into clauses,** each `editing` or `palette`, perhaps negated with `!`, joined by `&&`. A binding whose chord or `when` does not parse, or whose command the registry lacks, is dropped by `keymapOf`, so a keymap holds only bindings that can fire.
- **`resolve` takes the last binding that applies:** its chord is the key, its `when` holds, its command's own conditions hold, and its command gives intents for its arguments. Otherwise it looks at the binding before, and with none left the key is not the keymap's. A later binding overrides an earlier one, so overrides go after the defaults.
- **The Panes' keys are Alt+Shift.** The arrows with Alt alone move between Timelines, so with Shift they move between Panes, as they already do in the composer, where on a Mac Option+Shift and an arrow would select by word. The rest are letters, not `\\` and `-` as tmux binds, because Option on a Mac types another character, which a letter's or a digit's physical key names back and punctuation's does not. No browser takes Alt+Shift and these letters. A two-key sequence, as tmux's prefix, waits for chords in sequence, below.
- **A binding fires while typing in a field only when its `when` allows it.** Most of the defaults do, as an IRC client keeps the caret in its input. `i` does not, so it is typed into a field. Ctrl+L and Cmd+L would focus the composer from anywhere, but browsers use them for the address bar, and a letter outside a field has no browser default.

## Palette

`@iirc/frontend/palette`: what the command palette lists for a query, ranked, and what choosing an entry asks for. It adds no action of its own: choosing gives the intents the registry does.

```ts
sections(listing: Listing, query, recent, scope = "All"): readonly Section[]   // none empty
choose(entry, context): readonly Intent[]
initialPalette, reducePalette(state, event), remember(recent, key), recentCap: 20
themeDescription(theme): string                   // `built-in theme` or `imported theme`

Listing = { context: CommandContext, sidebar: readonly SidebarNetwork[], options: readonly Option[], keymap, themes: readonly ListedTheme[], theme }
Section = { title: "Recent" | "Commands" | "Timelines" | "Themes" | "Options", entries: readonly Entry[] }
Entry = Command { key, id, name, usage, description, chords }
      | Timeline { key, timeline, network, kind, name }
      | Theme { key, name, builtIn, current }      // current: the one in effect on this device
      | Option { key, name, description, credential }
Palette = { open, scope: "All" | "Themes", query, recent: readonly string[] }   // recent: entries' keys, newest first
PaletteEvent = Opened { scope } | Closed | Queried { query } | Chosen { key }
```

- **It lists what can be done here:** each command whose conditions hold, with its usage, description, and the chords bound to it, but not `/palette`; every Timeline, in the sidebar's order; every theme, `system` and the built-in ones and then those imported, the one in effect said; and every option read. Opened by `/theme`, it lists the themes alone, with nothing recent. A theme's description, which a query matches, says whether it is built in or imported, so `theme` finds them all.
- **A query ranks entries in four tiers:** the query begins a name, it begins a word of a name, it begins a word of the description, or its characters appear in a name in order. Within a tier, a shorter name, an earlier word, or characters closer together come first, and then the section's own order. A word begins after anything that is not a letter or a digit, so `iirc` finds `#iirc` and `nick` finds `network.libera.nicks`. A command's names are its name and its aliases, the name ranked first, and a Timeline's are its name and its Network and name. A leading `/` is ignored. Sections are ordered by their best entry, and matching nothing lists nothing. Matching is ASCII case-insensitive and reads no locale. It is a small scorer of its own rather than uFuzzy, whose sort uses `Intl.Collator`, and whose own ranking would still need these tiers put over it, for lists of tens to hundreds.
- **With no query, the entries chosen recently come first,** newest first, in a section of their own, and each section follows without them. A choice is remembered once, at most `recentCap`, the oldest going first.
- **Choosing a command that needs no arguments runs it,** as typing its name alone does. One that needs them, or that cannot run with none, such as `/part` outside a Channel, starts in the composer as `/<name> `, with the caret after it. A Timeline opens. An option starts `/set <name> ` in the composer, and a Credential option asks for its value in the password prompt, as `/set <name>` alone does, since its value is never typed into the composer. A theme is drawn in, for every device, as `/theme <name>` does.
- **A choice never replaces a draft with text in it.** What a choice starts the composer with goes in only when its draft is empty or only whitespace. Otherwise the draft is kept as it is, the composer is focused, and its notice says which command was not put in, so the Owner can clear it and choose again. `started` decides it, from the composers' state.
- **Plain data.** The palette's state survives `structuredClone`.

## Composer

`@iirc/frontend/composer`: what the Owner is writing in each Timeline, what they sent from it, and why something was not said. It never reads News: what `say` answered comes back as an event, and how a Message fares after that is its item's delivery, which `@iirc/frontend/render` says in words.

```ts
initialComposers: Composers
historyCap: 100, confirmAbove: 5
reduceComposers(state, event): Composers
submit(state, place, context): { state, intents }   // the draft, read through the registry
confirm(state, timeline): { state, intents }           // the lines waiting to be confirmed
takeOffer(state, timeline): { state, offer }           // what a notice offers: SendAgain or CheckAgain
draftOf(state, timeline): Draft                        // { text, history, recalled, kept, confirming, notice }
contextOf(timelines, channels?): CommandContext       // the focused Pane's Timeline, whether its Network has a Session, every Timeline in order, those the Panes show, and the focused Channel's head
started(state, place, text): Composers                // FocusComposer's text: put in an empty draft, never over one with text
refusal(reason, target, action?), failed(failure, intent, intents)   // in words
```

| Event | From |
| --- | --- |
| `Edited { timeline, text }`, `Recalled { timeline, direction }`, `Dismissed { timeline }` | The Owner typed, pressed Up or Down, or pressed Escape |
| `Failed { timeline, intent, failure, intents }` | A Say or an Act failed, with it and the intents after it, none carried out after it |
| `Noticed { timeline, message }` | Another intent, such as a change of Configuration, did not go as asked, in words. Nothing after it was carried out |

A composer is at a `Place`: a Timeline's id, or `Nowhere`, under a focused Pane with no Timeline open, where commands that need none, such as `/network add`, are typed. A Timeline's id is hex and `-`, so it is never `Nowhere`.

- **Each Timeline has its own draft,** kept when the Owner opens another, and its own history of what was sent from it, newest first, at most `historyCap`, a repeat of the newest kept once. Up goes back through it, Down comes forward, and past the newest the draft as it was comes back. Typing leaves the history where it is.
- **A Credential's value typed here is let go of at once.** A submission with a line that types one after `/set`, or a raw `PASS`, `AUTHENTICATE`, or `OPER` after `/quote` or `/raw`, sends nothing, and clears the draft, what was kept while recalling, and what waited to be confirmed, saying to use `/set <option>` alone, which opens the prompt. None of it enters the history. Until it is submitted, though, the value is held as the draft's text, as anything typed is, and React may keep a past render's copy for a while: the prompt is the way to give one.
- **Submitting sends every non-empty line, in order, or nothing.** Each line with more than whitespace is read by `interpret`, and the first that cannot be sent says why, `Line 2: …` when there are several, with the text kept. Text holding a NUL is refused, since no Line can carry one. More than `confirmAbove` lines wait for the Owner to confirm them, as a state the view shows, and editing the text, recalling another, or Escape lets them go, so what is confirmed is always exactly what is shown.
- **A refusal is said in words under the composer it came from.** `say` answers `Refused` with `Offline` or `Unsendable` when the Client refused it in the step that took it, which is the `Refused` failure, and nothing after it is sent. `Rejected` and `Unsent` come later, as the item's delivery. An `Act` is carried out the same way, under an intent the runtime names, and `act`'s `Refused` is said as what it tried, `Your kick of peer from #iirc was not sent: …`. What the Ircd refuses later is an `ActionRefused` item, since an action has no Message to deliver.
- **What failed says what is safe to do next, and never sends a Message or an action twice.** An Act is recovered by `said` exactly as a Say is. `NotJournaled`, which only a `NetworkStopped` leads to, since then the append has settled, offers `SendAgain` with it and those after it, under the same intent, as the API allows. `Journaled` says it was journaled, that whether it reached the Ircd is unknown, since a restart never carries out a past step's outputs, and that it is not sent again on its own, its item showing its delivery, and offers only those after it, under new intents. `Unknown`, when the request got no answer, so it may still be appending and `said` answering `NotJournaled` proves nothing, offers only `CheckAgain`, which asks `said` again: `Journaled` settles it, and anything else leaves it unknown.
- **Plain data.** A state survives `structuredClone`.

## Options

`@iirc/frontend/options`: Configuration as an option tree ([ADR 0013](../../docs/adr/0013-configuration-is-an-option-tree.md)). Every option comes from the annotations on the Client's `NetworkConfiguration`, walked once from its AST, so nothing lists them by hand and a new field is a new option.

```ts
fields: readonly Field[]                          // { key, kind, description, optional, starts }, from the Schema
optionsOf(network, configuration, held): readonly NetworkOption[]
resolve(name): Parsed<{ network, path, field }>   // from the Schema alone
parseText(kind, text): Parsed<Json>, showText(kind, value): string
apply(network, configuration, edit): Parsed<Configuration>   // set, unset, and the rest are edits
set(network, configuration, path, text), unset(network, configuration, path)
starting(network, given): Parsed<Configuration>   // what a new Network starts with, the rest given
credentialFor(network, configuration, path): Parsed<string>  // the Credential an option names, or the one derived
matches(filter, name): boolean
initialOptions, reduceOptions(state, event), listed(state, filter, device?): readonly Option[]

NetworkOption = { name, network, path, kind, description, value: Shown { text } | Unset | Credential { name, held }, starts, unsettable }
Edit = Set { path, text } | Unset { path } | Point { path, credential } | Join { channels } | Part { channels }
```

An option is named `network.<id>.<path>`: a field, such as `network.libera.nicks`; a field of a tagged union's member, under the union, such as `network.libera.login.account`; or a field of a record in a list keyed by `name`, under that name, such as `network.libera.channels.#iirc.key`. A Network's id and a Channel's name may both hold dots, so a name is resolved by trying each split, and names an option only when exactly one split gives a valid id and a path the Schema has.

| Kind | From the Schema | Text |
| --- | --- | --- |
| `Toggle` | `Boolean` | `on` or `off`, and `true` or `false`, in any case. Shown as `on` or `off` |
| `Text` | `String` | the raw text, exactly: no quoting, and nothing is trimmed |
| `Choice` | a union of string literals | one of them, in any case |
| `Credential` | a `String` with the `CredentialName` identifier | never text: its value is held by the Vault, and it shows its Credential's name and whether it is held |
| `Texts` | an array of strings | a list, below. Never empty when the Schema's is non-empty |
| `Ircds` | an array of `IrcdAddress` | a list, each `host` or `host/port`, TLS unless the word `plain` follows, as in `irc.libera.chat/6697,127.0.0.1/6667 plain`. The port is the digits after the last `/`, so a host may hold anything, and is always shown. Typed without one, it is 6697 with TLS and 6667 with `plain`. The old ` -tls` and ` +tls` at the end are refused, saying to use `plain`, so a habit never silently picks the other |
| `Names` | an array of records with a `name` | a list of their names. Set again, a name kept keeps its record's other fields |

A list is its elements separated by commas, as WeeChat's are. Within an element, `\,` is a comma, `\\` a backslash, and `\ ` a space, and a backslash before anything else is refused. Spaces next to an unescaped comma, or at either end, are dropped, so an element keeps a space at its edge only escaped, and keeps every space inside it. Empty text is the empty list, empty elements are kept, as in `a,,b`, and a list of one empty element is a lone space. Shown, an element is escaped the same way, so what is shown reads back as the same list. | `Tagged` | a union of tagged structs | the tag in lower case, such as `none` or `sasl` |

- **The syntax reads back what it shows, for every value the Schema admits.** For each, `parseText(kind, showText(kind, value))` is that value, quotes, commas, backslashes, spaces at the edges, and any Unicode included, and what a typed text shows reads back to itself.
- **An edit is a pure function of the Configuration,** applied to the one in force and parsed again by the Schema, so what `apply` gives is always a Configuration, or the reason in words. The runtime applies the same edit again after a conflict.
- **What a new Network starts with is the Schema's.** A field with `default` starts with it, one with `startsAs: "FirstNick"` with the first nick, an optional one with nothing, and a Credential option of a member with the name derived for it. `unset` returns an option to it, leaves an optional one out, and refuses one that must be given, `ircds` and `nicks`. Setting a field of a member not in force, such as `login.account` while `login` is `none`, puts that member in force with its other fields as they start.
- **A Credential option is write-only.** Its value is given in the password prompt, never by `Set`, and `Point` names the Credential. A SASL login's `credential` cannot be unset while `login` is `sasl`, since that could only point it at another: `/unset` says that `/set network.<id>.login none` turns SASL off. The Credential it names is the one the Configuration names already, or one derived from the option's name below `network.`, every character a Credential's name cannot hold, `_` included, written as `_` and its hex, so `network.libera.channels.#iirc.key` derives `libera.channels._23iirc.key` and two options never derive one name. A name that would be longer than 64 is refused in words.
- **Channels are compared as the Daemon reports the Network folds them.** `apply` takes a `Naming`, `{ casemapping, chantypes }`, which the runtime reads from `known`'s `declared` and `chantypes`. With a casemapping, `/join` adds a Channel only if none wanted folds to it, and `/part` parts the one named exactly, else the one it folds to, and refuses, naming them, when two or more fold to it, so it never parts more than one entry for a name. With none, as before any Ircd declared one, names are compared exactly. `PartTimeline` parts the entry the Daemon routed the Timeline to: its key, against each wanted name folded the same way, by the declared casemapping or `rfc1459` until one is, as the Daemon folds keys, the exact name winning among several.
- **A Channel's prefix is never guessed.** A name that starts with a character of the Network's `CHANTYPES` is kept exactly. A bare name gets the first `CHANTYPES` character. While `CHANTYPES` is unknown, a name with no prefix RFC 2811 names, `#`, `&`, `+`, or `!`, is refused, saying to give the prefix.
- **A filter matches with `*` as a pattern,** anchored at both ends, such as `network.libera.*` or `*nick*`, and without one as text found anywhere, in any ASCII case.
- **The options view is a reducer:** each Network's Configuration as read with its sequence, `Reading`, `Read`, or `Failed`, a read older than the one held never replacing it, the Credentials held, what the last edit came to, which option is being edited in place or asked to be unset, and which Credential option the password prompt asks for. `listed` is every option of every Network read that the filter matches.

### The options under `ui`

```ts
uiFields: readonly Field[]                        // from the contract's UiOptions
uiOptionsOf(shared, device): readonly UiOption[]
resolveUi(name): Parsed<{ option, field }>, isUiName(name), uiOptionName(option)
parseUiText(option, text): Parsed<Json>           // its syntax, then its Schema

UiOption = { name, option, kind, description, value, shared, device, starts, unsettable }
Option = NetworkOption | UiOption                 // tagged `Network` or `Ui`
```

An option under `ui` is named `ui.<option>`, such as `ui.time`, and derived from `UiOptions` in `@iirc/api/ui` as a Network's are from its Configuration's Schema, so `activity`, `colours`, and `time` are `Choice`s, `theme`, a theme's name, is `Text`, `themes`, the themes imported, is `Names`, shown by their names, and a new field is a new option ([ADR 0015](../../docs/adr/0015-the-journal-holds-changes-that-belong-to-no-network.md)). `/set ui.themes` can only fail, since a name alone is no theme: `/theme import` and `/theme remove` change them.

- **Every device shares them, and one may override any for itself.** `value` is what is in effect on this device: its override, else the shared value, else the default until the shared ones are read. `shared` is the value every device shares, `Unset` until read, and `device` this device's override, or none. The options view's state holds the shared ones as last read or followed, by `UiRead`, an older never replacing a newer, and `listed` takes this device's overrides, listing the options under `ui` after every Network's.
- **A change is whole.** `/set ui.<option>` gives the value as JSON its Schema took, and `/unset` none, so the runtime sends it made from the sequence read and, after a conflict, sends the same again.

`@iirc/frontend/ui`: the options under `ui` as they take effect here.

```ts
effectiveUi(shared, device): UiOptions            // device ?? shared ?? default, for each option
DeviceUi = Partial<UiOptions>, noOverrides
deviceUiKey: "iirc.ui"                            // where a device keeps its overrides
deviceUiOf(text): DeviceUi, deviceUiText(device): string | undefined
overridden(device, option, value?): DeviceUi      // one overridden, or no longer
showsItem(activity, kind, content): boolean
```

- **Overrides are parsed option by option.** `deviceUiOf` reads the text a device kept, at most `deviceUiLimit`, twice the longest a device writes with every option overridden and 32 themes of the longest names, about 40 KB, as an object, and keeps each option `ui` has with a value its Schema takes, dropping the rest, so one bad override never loses the others. Each theme of `themes` is read on its own too, by the contract's `uiValueKept`, so a bad one drops alone. `overridden` parses the whole again, so a value the Schema refuses is never kept, and `deviceUiText` gives nothing for no overrides, so a device keeps nothing.
- **`activity` changes what is drawn, never what is counted.** `showsItem` keeps every item of a Network's or a Direct Message's Timeline, and of a Channel's every item but Activity, which `all` keeps, `quiet` keeps but for `Joined`, `Parted`, and `Quit`, and `none` drops.

## Themes

`@iirc/frontend/theme`: every colour a Frontend draws, derived from a terminal's palette, the themes there are, and which one is in effect. `Palette`, `Theme`, and `Colour` are the contract's, in `@iirc/api/ui`.

```ts
drawn(palette, colours: "theme" | "raw"): Drawn   // every colour, readable
cssVariables(drawn): readonly [name, value][]     // --color-*, --nick-0…15, --irc-0…98
runColours(style, drawn): { color?, backgroundColor? }   // a run's colours as CSS
textFloor: 4.5, dimFloor: 3                       // WCAG 2 contrast ratios
mircColours: readonly Colour[]                    // mIRC's 99
mircOnAnsi: readonly number[]                     // which ANSI colour each of mIRC's 16 takes under `theme`
listedThemes(imported): readonly ListedTheme[]    // system, the built-in ones, then those imported
paletteNamed(name, imported, prefersDark): Palette
parseThemeName(text): Parsed<ThemeName>, usable(name, imported): Parsed<ThemeName>
editThemes(themes, edit: ThemesEdit): Parsed<readonly Theme[]>
systemTheme: "system"

Palette = { foreground, background, cursor?, selection?, ansi: 16 colours }   // sRGB, `#rrggbb`
Drawn = { scheme: "light" | "dark", tokens: Tokens, nicks: 16 colours, irc: 99 colours, ircGrounds: 99 colours }
Tokens = { background, surface, text, muted, border, accent, onAccent, danger, ok, focus, highlight, highlightSurface, selection, scrim, shadow }
ListedTheme = { name, builtIn }
ThemesEdit = Add { theme } | Remove { name }
```

| Token | From the palette | Floor |
| --- | --- | --- |
| `background` | its background, exactly |  |
| `surface`, `highlightSurface` | 5% of the way to its foreground, and 9% to the Highlight's colour, pulled back towards the background while white or black, whichever reads better there, would fall below 4.5 on them |  |
| `border` | 16% of the way to its foreground |  |
| `text` | its foreground | 4.5 on the background and both surfaces |
| `muted` | 55% of the way to its foreground | 3 on the same |
| `accent`, `danger`, `ok`, `highlight` | its cyan, red, green, and yellow | 4.5 on the same |
| `focus` | the accent | 3 on the background |
| `onAccent` | the background or the text, whichever reads better on the accent | 4.5 on the accent |
| `selection` | its selection, or 30% of the way to the accent, pulled back towards the background until the text reads on it | the text 4.5 on it |
| `scrim`, `shadow` | black at 55% and 60% on a dark theme, the text at 35% and 25% on a light one |  |

- **No palette makes text unreadable.** Every colour text is drawn in is moved, when it falls below its floor on what it is drawn on, by the least change of its OKLCH lightness that reaches it, away from the background towards whichever of white and black reads better there, its hue and chroma kept as far as sRGB allows, as CSS Color 4 maps a colour into gamut by lowering chroma. One that reads already is kept exactly. White or black always reaches 4.5 on any background, so the floor always holds. A theme is dark or light by which of the two reads better on its background.
- **The floor is WCAG 2's contrast ratio,** 4.5 for text, its AA for body text, and 3 for dim text and the focus ring, its AA for large text and for what is not text. It is a standard every browser's tools report and anyone can check, free to use, and simple enough to search exactly. APCA judges dark themes better, but it is still a draft, and its licence restricts its use.
- **Nicks are spread over 16 slots drawn from the palette's hues:** its chromatic ANSI colours, normal then bright, each once, in hue order, and each slot at its share of the way round them, blended in OKLCH between the two it falls between, so every hue comes from the palette and every one of them is a slot. A palette with fewer than three hues gives six evenly spaced ones at its text's lightness. Each slot is readable as text is.
- **mIRC's colours are the theme's, or mIRC's own,** as `ui.colours` says. Under `theme`, the default, its first 16 take the ANSI colours terminal IRC clients such as WeeChat and irssi give them: white the bright white, black the black, navy the blue, green the green, red the bright red, brown the red, purple the magenta, orange the yellow, yellow the bright yellow, light green the bright green, teal the cyan, light cyan the bright cyan, light blue the bright blue, pink the bright magenta, grey the bright black, and light grey the white. Under `raw` they are mIRC's own. Colours 16 to 98 are always mIRC's own, as [modern.ircdocs.horse](https://modern.ircdocs.horse/formatting#colors) gives them. Either way, `irc` is each readable on the background, and `ircGrounds` each as it is, for a run's background.
- **A run's colours stay readable.** With no background of its own, a mIRC colour is its variable, `var(--irc-N)`, and a hex colour is made readable as text is. With one, which reverse gives a run too by swapping the colours in force, the defaults included, the background is as asked and the text is made readable on it.
- **Themes are built in or imported.** `system` draws the built-in `dark` or `light` as the device prefers. The built-in ones are iirc's own `dark` and `light`, and Solarized dark and light (MIT), Gruvbox dark (MIT), Nord (MIT), Dracula (MIT), and Tokyo Night (Apache-2.0), each as its authors give it for a terminal, its source beside it in `src/builtin-themes.ts`. A name that names no theme, as one removed since, draws as `system`.
- **A theme's name is one word.** 1 to 32 lower-case letters and digits, in words joined by `-`, such as `tokyo-night`, typed in any ASCII case. The names no import may take are the contract's, `builtInThemeNames` and `themeCommandWords` in `@iirc/api/ui`, so the Daemon refuses them too, and `src/theme.test.ts` checks the built-in palettes are exactly those names. `editThemes` imports a theme, replacing one imported with its name, or removes one, and refuses, in words, a built-in name or `system`, `import` or `remove`, which `/theme` reads as what to do, removing one not imported, and a 33rd. It is a pure function of the themes, so the runtime applies it again after a conflict.
- **Deterministic.** The same palette draws the same colours every time.

## Importing a theme

`@iirc/frontend/theme-import`: a terminal's theme file read into a palette.

```ts
importTheme(text): Parsed<Imported>               // the format told from the text
nameFrom(text): ThemeName | undefined             // `Gruvbox dark, medium` → `gruvbox-dark-medium`
importLimit: 262144                               // 256 KB
entryLimit: 4096                                  // settings a line, or plist values

Imported = { format: ThemeFormat, palette, name: ThemeName | undefined }   // name: the one the file gives, if any
ThemeFormat = "base16" | "base24" | "iTerm2" | "Alacritty" | "Kitty" | "Ghostty" | "Windows Terminal"
```

| Format | Told by | Read |
| --- | --- | --- |
| base16, base24 | YAML with `base00` and the like | `palette: base00…` as the current spec has it, or at the top as the older one did, by Effect's YAML parser; base24 when `base12` to `base17` are all given. The ANSI colours as tinted-theming's styling guides map them: black `base00`, red `base08`, green `base0B`, yellow `base0A`, blue `base0D`, magenta `base0E`, cyan `base0C`, white `base05`, bright black `base03`, bright white `base07`, and the other bright ones base16's normal ones or base24's `base12` to `base17`. Foreground and cursor `base05`, background `base00`, selection `base02`. Its `name`, or the older `scheme` |
| iTerm2 | text that starts with `<` | the plist's `Ansi 0 Color` to `Ansi 15 Color`, `Background Color`, `Foreground Color`, `Cursor Color`, and `Selection Color`, each a dict of real components from 0 to 1, in Display P3 when its `Color Space` says `P3`, and otherwise read as sRGB, which the older `Calibrated` nearly is |
| Alacritty | `[colors…]` tables or `colors.` keys in TOML, or a `colors:` mapping in its older YAML | `colors.primary`, `normal`, `bright`, `cursor.cursor`, and `selection.background`, by Effect's TOML parser |
| Kitty | `key value` lines | `foreground`, `background`, `color0` to `color15`, `cursor`, `selection_background` |
| Ghostty | `key = value` lines | `palette = N=#hex` for 0 to 15, `background`, `foreground`, `cursor-color`, `selection-background` |
| Windows Terminal | a JSON object | `black` to `brightWhite`, `purple` for magenta, `background`, `foreground`, `cursorColor`, `selectionBackground`, and its `name` |

- **The format is the text's own structure,** never a file's name, told in one pass over its lines: XML or a JSON object by what its first non-blank line starts with, and otherwise by each trimmed line's first word or structure, such as a `[colors…]` table, a `base0X:` key, or a `key = value`, the first in the order above that any line says, stopping at once on a `base0X` key. No pattern reads past the one line it is given, so blank and whitespace lines, or one long line, cost what they are long.
- **Parsed, not validated.** A colour is hex text, `#` or `0x` first or neither, short or long, and becomes a `Colour`. Where a format is data, a Schema of it reads it, and what is not there or not a colour is said by its path, such as `colors.normal.red is not a colour as #rrggbb.` or `palette.base0A is missing.`. A cursor or selection that is no colour, as Alacritty's `CellForeground`, is left out.
- **Nothing is evaluated or followed.** A Kitty `include` and a Ghostty `config-file` are never followed. The plist is read by a small reader of the subset an `.itermcolors` file is, linear in its text: tags, text, the five predefined entities and character references, and nothing else, so a doctype with an internal subset, which could declare entities, is refused, and arrays and dicts nest at most 16 deep. Each `<dict>` and `<array>` must be closed by its own tag, and `</plist>` must close the one value and end the text, but for whitespace and comments. A declaration, `<?xml …?>` or `<!DOCTYPE plist …>`, is taken only before `<plist>`.
- **Bounded and linear.** A setting given again is appended to its key's own list, so a file that repeats one is read in linear time, and a Kitty or Ghostty file of more than `entryLimit`, 4,096, settings, or a plist of more values, is refused in words, far beyond the few dozen settings and few hundred values a theme needs. Effect's YAML parser, which base16, base24, and Alacritty's older YAML go through, is quadratic upstream on a long run of backslashes in a quoted scalar or a long flow sequence, taking seconds in JavaScriptCore and Node, so the web frontend reads a theme in a Worker it ends after a second, rather than trusting any parser here to be fast. The browser's `DOMParser` is not in the pure core, and the subset needs none. Text longer than 256 KB is refused unread.

## Who is here

`@iirc/frontend/channel`: what each Pane's Timeline shows at its head, and its Channel's members, as a reducer over what the runtime read from `GET /api/timelines/{id}/channel` and `/members`, and what the changes stream said. The Daemon reads the Channel as the Client knows it now, so this holds the latest read of each Channel a Pane shows only, and says when to read it again.

```ts
initialChannel: Channel, membersPage: 100, refreshTiming: Timing   // { debounce: 250, interval: 1000 }, in ms
reduceChannel(state, event: ChannelEvent): Channel
openChannel(timelines, pane?): OpenChannel | undefined   // { timeline, network }: a Pane's open Timeline, when its Network lists it as a Channel's
openChannels(timelines): readonly OpenChannel[]   // every Channel a Pane shows, the focused Pane's first
initialChannels, reduceChannels(state: Channels, event: ChannelsEvent), channelIn(state, timeline)
channelsReads(state, open, members): readonly ChannelRead[]   // channelReads for each
// Channels = ReadonlyMap<TimelineId, Channel>; ChannelsEvent = ChannelEvent | Kept { timelines }
channelReads(state, open, members: boolean): readonly ChannelRead[]   // the reads to make now, one of each kind at a time
refreshDelay(state, read, now, timing): number    // how long to wait before asking a read, in ms
touches(change, timeline, network): boolean       // whether a change may have changed the Channel
headerOf(timelines, channel, pane?): Header | undefined  // what a Pane's Timeline shows at its head
rosterOf(timelines, channel, pane?): RosterShown // a Pane's Channel's members, as the list shows them
memberRow(member, ranks): MemberRow               // { nick, symbol, away, colour, label }
standingText(standing), connectionText(running, connection): string
queried(timelines, network, name, casemapping): readonly Intent[]   // what `/query` comes to

ChannelRead = Head { timeline, network, wait }
            | Members { timeline, network, after, limit, wait }
Header = Channel { name, topic: TopicShown, modes, members, note } | Direct { name, note } | Network { name, status }
TopicShown = Unknown | None | Set { inlines, by, at, stale }
RosterShown = None | Reading | Out { note } | Failed | Listed { rows, count, more, loading }
```

| Event | From |
| --- | --- |
| `ReadStarted { read, at }` | The runtime took on a read `channelReads` gave, to ask it `at` then. One of another Channel starts afresh with it |
| `HeadRead { read, generation, header }`, `MembersRead { read, generation, page }` | What the head and a page of members answered, with the `generation` the state had as it was asked |
| `NotInChannel { read, generation, standing }` | The members route said Self is not in the Channel |
| `Failed { read, generation }` | `UnknownTimeline` or `NotAChannel`: nothing to read, so it is not asked again until something changes |
| `MoreWanted { timeline }` | The Owner scrolled to the end of the members held |
| `Changed { change }`, `Overflowed { overflow }`, `Reset` | The changes stream, which may have changed the Channel |

- **Each Channel a Pane shows is held apart.** `reduceChannels` gives a read's event, and `MoreWanted`, to the Channel it is of, starting one afresh as a read of it is taken on, and the changes stream to every Channel held. `Kept` lets go of every Channel no Pane shows any more, as the runtime says when the Panes change.
- **The head is read for each Channel a Pane shows, and the members only while they show.** `channelReads` gives the head of the Channel, and its first page of members only while the Owner shows them, each once: a read taken on is not wanted again until something may have changed the Channel. A Direct Message or the Network's own Timeline reads nothing, and its header comes from what its Network lists.
- **What may have changed it is read again, coalesced, never cancelled.** An Activity in the Channel's Timeline, as a join, a part, a kick, a quit, a nick, a mode, a topic, or an away is, a Gap of its Network, which a Session ending or beginning makes, an overflow naming it or everything, and a reset, each bump the Channel's `generation`, which leaves what was asked before it dirty. One read of each kind is in flight at a time, and a change never supersedes it: it finishes, and what it answers is taken unless what is held was asked later, and while it stays dirty, the next read follows. `refreshDelay` spaces the reads again: the first change after quiet is read `debounce` after it, 250 ms, and while changes keep coming, no sooner than `interval`, a second, after the last of its kind was asked, so Activity every 200 ms is read about once a second, and a burst is read once.
- **Members are read again from the start, as many as were held.** A change reads the first page again, with a `limit` of as many members as were held, at least `membersPage` and at most 500, rather than patching the list: the Daemon's order is by rank, which any `MODE` can move, and patching would need what each Activity means for every member. A scrolled list keeps its length. Scrolling to the end asks for the page after `next`, and a page after a place the list no longer ends at merges nothing and is asked again from where it ends.
- **The header says what the head said, as text and data.** A Channel's topic is formatted, as a Message is, with who set it and when, and `stale` when it was known once and may have changed since. Its modes are a mode string, such as `+ntl 50`, a key shown only as set, and its members are counted only while Self is in it. Where Self stands otherwise is in words that say what follows: joined once connected, joining, refused and tried again, kicked and joined again, or, with no Channel held, `/join` to rejoin. A Direct Message no longer following its partner says so, and a Network's own Timeline says how its connection stands.
- **A member shows their highest rank's symbol, from `PREFIX`.** The prefixes a member holds, all of them, at least some, or as they were, are matched against the head's `ranks` in order, the first held giving the symbol, such as `@`. Their label says their nick, their rank by RFC 2811's name for `o` and `v`, `operator` and `voice`, or `mode` and its letter for any other, and `away` when their User is, for a screen reader. Their colour is their nick's slot.

## Lookups

`@iirc/frontend/lookup`: what `/whois` and `/whowas` ask, a card for each Pane showing what came back, and that card as text for a view to draw, as a reducer over what the runtime asked and the Daemon answered.

```ts
nickRulesOf(head): NickRules                      // { chantypes, symbols }: the head's, or `#&` and `@+`
isLookupNick(rules, name): boolean                // as the Client's parseNick given no STATUSMSG, and no NUL, CR, or LF
parseLookupNick(kind, args, rules): Parsed<string>  // the nick, trimmed, or why it is none, in words
lookOf(kind, nick, network, timeline, head): Look
rfcRanks                                          // (ov)@+, until a head says the Network's
initialLookups, reduceLookups(state, event): Lookups
cardWithId(state, id): { pane, card } | undefined
shownCard(state, timelines, pane): Card | undefined
cardShown(timelines, card, time): CardShown       // time: an instant, as the Owner reads a date and time, or none when it cannot be
profileShown(timelines, card, profile, time): ProfileShown
idleText(seconds): string | undefined            // `idle 42s`, `idle 3m`, `idle 2h 5m`, `idle 3d 4h`

Look = { network, timeline, lookup: Whois { nick } | Whowas { nick }, ranks }
Lookups = { cards: ReadonlyMap<pane, Card>, next }
Card = { id, look, phase: Asking | Pending | Done { result } | Lost { failure }, naming: { casemapping, chantypes } | undefined }
LookFailure = "UnknownNetwork" | "Stopped" | "NoAnswer" | "Unexpected"
CardShown = { kind, nick, colour, body: Waiting { words } | Profiles { profiles, note } | Said { words } }
ProfileShown = { nick, colour, mask, realname, server, operator, idle, signon, channels: { name, symbols, label, choose }[], away, account, secure, actual, modes, other: { numeric, text }[] }
```

| Event | From |
| --- | --- |
| `Asked { pane, look }` | The runtime took on a `Look` in a Pane, which replaces the Pane's card |
| `Waited { id }` | The Daemon answered `Pending`, from `look` or asked by intent |
| `Answered { id, result }` | Its result came |
| `Failed { id, failure }` | It came to nothing: `UnknownNetwork`, `Stopped` when the Network stopped before it was journaled, `NoAnswer` when no result came in the time the runtime asks, or `Unexpected` |
| `Named { id, declared, chantypes }` | What `known` said: the casemapping the Network declared, `null` for none, and its `CHANTYPES`, `null` while unsaid |
| `Dismissed { pane }` | The Owner put the Pane's card away |
| `Kept { panes }` | The Panes there are now, shown or not: the card of any other is let go of |
| `Cleared` | The page signed out: every card is let go of, and ids go on counting |

- **One card a Pane.** A Lookup asked in a Pane replaces its card, each card's `id` is new, and an answer for a card no Pane holds any more changes nothing, so a Lookup let go of never lands. A result, once it came, is never replaced by a failure after it.
- **A card shows while its Pane has open the Timeline it was asked from.** Opening another there puts it out of sight, and opening that one again shows it, until it is dismissed or replaced. A card lives as long as its Pane: closing the Pane lets it go, while a zoom or a phone's width that hides the Pane keeps it, and signing out lets every card go.
- **What a Network wrote is contained, and stays text.** Every field of a profile, the numerics kept as they came included, goes through `contained`, as a Message's text does, so a control shows as its symbol and an override is closed, and a view draws each in its own isolate. A field said as nothing but whitespace is unsaid.
- **A Channel is shown with its prefixes, and opens or joins.** The symbols are of the modes the User holds there that `ranks` names, most privileged first, and a mode it does not name shows no symbol and is said for a screen reader, `mode q`. Once `known` said how the Network names Channels, a name that can be a Channel's, starting with its `CHANTYPES` and holding no space, comma, control, or bidirectional formatting, which the composer would show unseen, opens the Channel Timeline its name keys, folded as the Daemon keys Timelines, or else starts `/join <name>` in the composer, for the Owner to send. Until then, or when `known` could not be read, it is text.
- **Where a User connects from, and their modes.** `actual` is the `338` mask and IP the Client read, each contained, joined by a space, as a view says it after "connects from", and `modes` the `379` modes, such as `+Zi`. Either is unsaid when the reply did not give it.
- **Times are the caller's.** Idle is humanised here, from its seconds, to its two largest units, and a negative or fractional count, which no Ircd means, is unsaid. The signon is `signed on` and what the caller's `time` makes of its instant, since the core reads no clock, locale, or time zone, or `sign-on time unavailable` when `time` gives none, as for an instant no calendar can hold, which a hostile Network can give, the rest of the profile shown as ever.
- **What found no User is said in words,** naming the reply's numeric or code, contained: `No one uses the nick peer now (401).`, `The Network remembers no one who used the nick old (406).`, `The Network refused the Lookup (402).`, why it was not sent, `Offline`, `Unsendable`, `Busy`, or `Unsent`, and a `Partial` reply says why it was cut short above what had come.
- **Plain data.** The state survives `structuredClone`.

## Completion

`@iirc/frontend/completion`: Tab completion in the composer, as a reducer. It completes the word that ends at the caret, cycles through what completes it, and gives back what was typed.

```ts
initialCompletion: Completion, nickSuffix: ": ", nicksLimit: 100
reduceCompletion(state, event, sources: Sources): { state, edit: { place, text, caret } | undefined }
spotAt(text, caret): Spot                         // { before, word, after }
completes(text, caret), active(state, place, shown): boolean
nicksWanted(state): { request, timeline, prefix } | undefined   // the members route's request to make now
cycled(state, place, text), announced(state, place, text)       // the candidates shown, and what a screen reader hears
orderNicks(nicks, sources), optionNames(networks, options), sourcesOf(timelines, place, options, chantypes)
cancelled(state): Completion                     // completing nothing, as when the draft was replaced
chantypesWanted(timelines, place, chantypes)     // the connected Network whose CHANTYPES is to be read for its Session, if any
rfc2811Chantypes: "#&+!"                         // what starts a Channel's name while CHANTYPES is unknown

Completion = { phase: Idle | Asking | Cycling | Unmatched, requests, applied, caret }
CompletionEvent = Tabbed { place, text, caret, backwards } | NicksRead { request, nicks, place, text } | NicksFailed { request }
                | Escaped { place } | LetGo
Sources = { commands, options, channels, chantypes, nicks: Members { timeline } | Listed { nicks }, recent, self }
Chantypes = { since, chantypes }                 // a Network's CHANTYPES, as said during the Session begun at `since`
```

- **The word is what runs back from the caret to whitespace,** and what follows the caret is kept. Tab takes it only when there is one, or completion is under way, so Tab with nothing to complete moves focus on, as it does anywhere, and the composer is no keyboard trap.
- **What a word is completed from follows from where it is.** After `/` at the start of a line, and not `//`, every command's name and alias, in code-unit order, ASCII case-insensitively. After `/set ` at the start of a line, every option's name: those of each Configuration read, and each field of each Network as the Schema has them, so options complete before any is read. A word starting with a character of the Network's `CHANTYPES`, as `known` said it during the Session it is in now, or of RFC 2811's `#&+!` while that is unknown, a Channel's name from the Network's Channel Timelines. Only a `CHANTYPES` a Session said is kept: one read before the Ircd's `005` finds none, which is provisional, and `chantypesWanted` names the Network to read it again for as completion needs it. A Timeline's name is never taken for the rule, so after an Ircd declares other `CHANTYPES`, `[bob]` completes as a nick even beside a Channel Timeline of old named `[old`. Anything else, a nick: in a Channel, from the members route, asked with the word as `prefix`, under the Connection's casemapping; in a Direct Message, its partner; in the Network's own Timeline, none.
- **A nick from the Daemon is asked for, not guessed.** Tab in a Channel goes to `Asking`, under a new `request`, and `nicksWanted` gives the runtime what to ask. Another Tab while it waits asks nothing more, and anything that changes or replaces the draft other than completion, typing, recalling, sending, the palette, a refused Credential's clear, or another Timeline opening, lets it go, so an answer for any but the request waited on is dropped. An answer also says the composer under the focused Pane as it is then, and puts nothing in unless that is the place and the exact text it was asked for.
- **Who spoke latest comes first.** Nicks are ordered by who said something in the window of the Timeline the composer is at, the latest first, then in the members route's order, by rank and nick, with Self last, each compared folded by `rfc1459`, since this only orders what the Daemon matched.
- **A candidate goes in place of the word,** with `: ` after a nick at the start of a line, as IRC clients address someone, and a space after anything else, less a space where whitespace already follows the caret. Tab moves to the next candidate, Shift+Tab to the one before, wrapping, and Shift+Tab to start with takes the last. Escape gives back what was typed, the caret where it was. Tab after the Owner moved the caret or changed the text starts afresh.
- **What is shown is announced.** `announced` says the candidate in place and where it stands, `alex, 1 of 3`, or that nothing completes the word, only while the composer still shows what completion left it with. The draft is the one copy of the text: completion's edits become it, and `applied` and `caret` say where a view puts the caret after each.
- **Plain data.** The state survives `structuredClone`.

## Rendering

`@iirc/frontend/render`: what an item shows, as data for a view to draw. Nothing in it is markup: every string is text, for a text node.

```ts
formatted(text): readonly Inline[]                // mIRC formatting into runs, and links in them
lineOf(content, network): Line                    // Message { kind, nick, colour, text, delivery } | Description { tone: Activity | Session | Refused, parts }
requested(action): Attempted, attemptedText(attempted): string   // what an action tried, as the Client says it, and in words
nickColour(nick, slots = nickSlots): number       // a stable colour slot, 0 to 15
contained(text): string                           // controls shown as symbols, bidi closed
plainText(text, limit = plainLimit): string       // for a notification: plain, cut to 200, isolated
plainCharacters(text, limit?): readonly string[] // the characters plain text keeps, each a code point, as a search's result shows them
endReason(reason): string                         // why a Session ended, in words
mismatchedTls({ ircd, opened, reason }): IrcdAddress | undefined   // the Ircd to try with TLS the other way, after a failed Connection

Inline = Text { text, style } | Link { text, href, style }
Part = Words { text } | Nick { nick, colour } | Name { text } | Said { inlines } | Command { text }
```

- **Formatting is data.** `@iirc/protocol/format` reads bold, italic, underline, strikethrough, monospace, reverse, and colours into styles, and a view draws them.
- **A link is one of `http`, `https`, `irc`, or `ircs`,** found within a run of one style, with sentence punctuation and an unopened closing bracket left off its end, each bracket counted once, so any number of them is trimmed in linear time, and its `href` as the URL parser writes it. Anything else, `javascript:` and `data:` included, stays text. A link ends at whitespace, a control character, or a bidirectional formatting character, so none is ever in one.
- **One of ours says its delivery in a few words:** `sending`, `unconfirmed`, `not sent`, or `refused:` with the Ircd's numeric or code, contained, and nothing once confirmed.
- **Hostile text is contained.** C0 controls and DEL show as their Control Pictures, C1 controls and lone surrogates as the replacement character, and the line and paragraph separators as the newline symbol. Every bidirectional embedding, override, or isolate a run opens is closed at its end, so it cannot reorder what follows it, and a view isolates each name and text besides. Everything over a Line's text is linear, however hostile: a pop with no isolate open skips the search, and each search drops what it passes over.
- **Plain text is for where nothing is drawn,** such as a notification. mIRC formatting is stripped, every control, bidirectional formatting character or mark, and lone surrogate is dropped, a line or paragraph separator becomes a space, and the text is cut to `plainLimit`, 200 characters, by code point, the last an ellipsis, and wrapped in a first-strong isolate, so it cannot reorder what the host puts around it. The work stops one past the limit, however long the text.
- **A nick's colour is a slot, not a colour:** an FNV-1a hash of the nick as RFC 1459 folds it, one of 16, so the same User has the same slot in any case, on every load, and a theme gives each slot its colour.
- **A refused action is a calm line of its own,** with the tone `Refused`: what it tried, as the Client summarised it, and why, `Your topic change for #iirc was refused (482)`, the Ircd's numeric or code contained, or `… was not sent: its connection ended first`. It never holds a topic, a reason, or a mode's parameter, since the Client never gives one.
- **A failed Connection names its Ircd, and hints when TLS looks wrong.** It reads `Could not connect to irc.example.net/6697 plain: the Ircd closed the connection`, the Ircd as the options show one. `mismatchedTls` decides from structure alone whether its port and TLS look mismatched: a plaintext Connection to 6697, the port IANA registers for IRC over TLS (`ircs-u`), that was open, by the item's `opened`, and ended before registration, by the Ircd closing or resetting it, a timeout, our hang-up, silence, or an `ERROR`, or a TLS Connection to 6667 whose handshake failed (`Tls`). A Connection never open, refused, unreachable, or timed out or reset while connecting, as at a firewall, and any other port, says nothing of TLS. Then the line goes on `. Port 6697 is usually TLS: try` and a `Command` part, `/set network.<id>.ircds irc.example.net/6697`, or `Port 6667 is usually plaintext` and `… irc.example.net/6667 plain`, which `lineOf` builds from the item's Network. No text is parsed: the item carries the Ircd and the reason as data.
- **Activity and Sessions are a few words,** in which nicks, names, and reasons are parts of their own. One of our Messages says its delivery, and once the Ircd confirmed it, shows the Ircd's own text.

## Activity

`@iirc/frontend/activity`: what is new, from the counts the Daemon keeps ([ADR 0014](../../docs/adr/0014-read-markers-and-highlights-belong-to-the-client.md)), and when marking the open Timeline read is due. It never counts items itself: the Daemon counts what lies after each Read Marker, and the window holds only some of them.

```ts
levels: ["Highlight", "Direct", "Message", "Activity"], rank(level): number
levelOf(unread): Level | undefined                // the highest level with anything unread
activityOf(timeline), networkActivity(network): Activity   // { unread, level }
saidCount(unread), callingCount(unread): number   // Highlights, Direct, and Messages; Highlights and Direct
countText(count): string                          // `999+` past the Daemon's cap
labelOf(name, activity): string                   // `#iirc, 3 unread, 1 highlight`
titleOf(sidebar): string                          // `(3) iirc`, or `iirc`
markOf(timeline, read), markLatest(timeline): MarkRead | undefined
markDue(state, page: Page): MarkRead | undefined  // Page = { visible, focused, compact }
lookingAt(state, page, timeline): boolean
```

- **A level ranks what calls for the Owner,** as WeeChat ranks activity: Highlight, then Direct, then Message, then Activity. A Timeline's level is the highest with anything unread, and a Network's the highest of its Timelines, its counts their sums, kept at `unreadCap + 1` as the Daemon's own are, so `999+` means more.
- **Activity is a dimmer name, never a number.** A label and the counts a view shows say what was said, Highlights, Direct Messages, and Messages. The page's title counts only Highlights and Direct Messages, across every Network.
- **A mark is due for what the Owner can see.** That is the Panes shown, as `shownPanes` says, the focused one alone while zoomed or on a compact screen, while the page is visible and focused. Of several, the focused Pane's Timeline comes first, and the next once that is marked, as the runtime asks again.
- **A mark is never back and never past what was shown.** `markDue` is due only while the page is visible and focused, a Pane the Owner can see shows the Timeline, not the options, its window is current, following, and at the latest, with nothing beyond its last item, and the view said so, naming the last item in view. It marks up to that item's instant, the time its position stands at, as the Daemon compares items with a Read Marker, and only when that is later than the Read Marker and something is unread, so it is never due again once the Daemon's marker comes back, never past an item the view has not shown, even when the window or the Daemon holds a later one, and never for a Timeline just opened until the view has laid it out with its bottom in view. A detached Direct Message is never marked, since no Target names it. When to carry it out, the runtime decides.

## Notifications

`@iirc/frontend/notifications`: which items the changes add call for a notification, and what it says.

```ts
notificationsOf(before, after, change, page): readonly Notify[]
Notify = { network, timeline, title, body, tag }  // tag: `iirc:<timeline>`, one per Timeline
```

- **Only what calls for the Owner, and only once.** An item calls for one when the step the change is of made it, it is a Message said live, it is not ours, its level is `Highlight` or `Direct`, it stands after its Timeline's Read Marker, and the Owner is not looking at its Timeline: shown in any Pane they can see, as `markDue` says, with the page visible and focused. A Pane beside the focused one is in plain sight, so what it shows needs no notification, while one hidden by a zoom or a compact screen is not seen. A change the state did not take, as one given twice is, calls for none, and so does a step at or below `considered` before it, as when a projection folded again resets the stream and gives a step again, and history, a Message Self said, and anything read already.
- **Its words are plain.** The title is the Timeline's name and the Network, and the body the sender and text as an IRC client writes each kind, `<nick> text`, `* nick text`, or `-nick- text`, each by `plainText`, isolated. Of several in one change for a Timeline, only the latest is kept, and the tag makes a newer one replace the last on screen.

## Tests

`bun run test` runs seventeen files. `src/sign-in.test.ts` covers each transition, checking again after a failed check, keeping a failure until the next attempt, signing out failing while staying signed in, `Refused` from signed in and while signing out, ignoring an answer that does not belong, and two properties over any sequence of events: `SignedIn` is entered only after a check or a sign-in said so, and every state survives `structuredClone` unchanged.

`src/timelines.test.ts` plays a model Daemon: random steps folded into Timelines, items, late history, deliveries, Sessions and their Gaps, and a second Network configured later, sometimes never heard from again, read a page at a time and a window at a time as the API reads them, before and after a cursor included, and changes given as it gives them. The reducer and a runtime in miniature read what `wanted` asks, at fold points the Daemon has reached, answered later in any order, while the stream lags the Daemon, some steps come as overflows, naming what they touched or everything, the Daemon may take a new projection version, which the stream resets, every event may come twice, and the Owner opens Timelines, goes back to the one before, opens another while older items are read and comes back, has the Daemon fold steps that come as overflows touching everything while the Network list is read, scrolls up and down, and leaves and returns to the latest at random, with windows of at most 4 items, pages of 2, and no closed window kept, so windows are dropped and read again with answers for them still in flight, which the runtime may answer newest first. After every action, a current window holds every item the Daemon had folded by its `through` between its first and last items, so a page merged into the wrong window, which leaves a hole, is caught as it happens. Once everything settles, the Networks are exactly the Daemon's, and each Network's Timelines and connection are exactly its, a Network that only a reset reaches included, and every current window is exactly what a read now would give between its first and last items, Gaps included, with `earlier` and `later` true exactly when something lies beyond. No window ever holds more than the cap, nor is any window kept but those of Timelines a Pane has open. The Owner also splits, opening a Timeline in the new Pane or none, closes, focuses, moves the focus, and swaps, and after every action no Timeline is open in two Panes, the focus is on a Pane, no window is kept for a Timeline no Pane has open, and `navigation` never goes back. Every state survives `structuredClone`. Examples cover opening the Direct Message Timeline a Message was placed in, by id, at once or once listed, the right one of `[bob]` and `{bob}`, never a Channel's or a detached one, a placement from before the Owner opened another ignored, a placement made while the options showed showing its Timeline in their place, and one from before they were shown let go, following after the smallest `through`, each read asked once, sidebar order, a live item, late history, an update in place, an item outside a window, a merge followed and learnt from a window read, overflows, a reset, a read of another version dropped, a read brought up to date from what the stream gave, reading older items before the first with the Gaps up to it, a page that lands after its window was dropped and read again ignored, the Network list kept stale when an overflow that touched everything came while it was read, and current from where the stream was when it was asked, not when it was taken on, joining a run the cursor split, the Network list read again on a reset and a pre-reset read of it landing late, collapsing Gaps, and a connection from `known` then from Session items. The Panes' examples cover a split opening a Timeline in the new Pane, focused, with its window read, and an empty one when another Pane has it open; opening a Timeline another Pane has open focusing that Pane, its window untouched; opening in the focused Pane, the Timeline replaced kept among the closed; closing a Pane, its window kept among the closed, and the last never; a placement let go once the Owner moves to another Pane, and kept when a swap moves the focused Pane, whole, with them; the options in one Pane, shown again there from another, with its Timeline open behind; and the layout kept as JSON, read back through its Schema, set aside until the Timelines are read, taken without a Pane whose Timeline is gone, with the options in the Pane they showed in and each Pane's window read, let go once the Owner opened a Timeline first, a Timeline kept twice opened once, and a layout with ids used twice or a Timeline's id that is not one refused. A merge that leaves both Panes on one Timeline empties the Pane not focused, either way round, and, as a property over any opening, splitting, closing, focusing, moving, swapping, and merging, no Timeline is ever open in two Panes and the focus is always on a Pane. `layoutKeptText` refuses, without throwing, text 5000 levels deep, of 65 Panes, longer than 64 KB, nested 17 Splits deep, or not JSON, and takes 16.

`src/layout.test.ts` plays any sequence of splits, closes, focuses, moves, swaps, equalizes, grows, shrinks, resizes of any ratios, and zooms, and checks, after each, that the tree is well formed: ids each once and below the counter, every Split of two or more children, none along its parent's axis, ratios positive and summing to 1, and the focus on a Pane, never zoomed with one Pane. As properties, a close never removes the last Pane and removes the focused one's view otherwise, a split adds its view and focuses it, and nothing else changes the views; the focus moves to a Pane whose edge touches and spans the focused Pane's middle, and nowhere exactly at the edge of the layout; a zoom and a zoom back give the very layout; and a layout taken back from what was kept is the same, ratios to a billionth. Examples cover moving in a known layout, ties going to the first along the edge, growing to 55% and shrinking to the least share, equal shares again, a resize taken only when it fits, a split along its parent's axis joining it, closing into the nearest Pane, refusing ids not of a Pane or a Split, used twice, or views not read, and dropping Panes, and, after 99 splits, no more than 64 Panes nor 16 Splits deep, taken back whole, while a kept layout of 65 Panes is refused. As a property, growing never shrinks the focused Pane's share and shrinking never grows it. Five splits side by side leave the focused Pane at 1/32, which a shrink does not raise, and eleven stop at seven Panes, the last at 1/64, a seventh halving being below the least share, where a grow still grows it.

`src/commands.test.ts` covers `/theme` alone, with a name in any case, with `-device`, `import` in any case and refused with words after it, `remove`, and refused with no name, two words, or a name that is none; and each command's name and aliases, unique and in lower case, finding one in any case, `when` for each kind of Timeline and with no Session, plain text, `/me`, `/say`, `//`, `/msg` from the Network's Timeline opening the Direct Message, `/notice`, an unknown command and a bare `/`, missing arguments and a list of Targets, why plain text cannot go to the Network's own Timeline, `/next`, `/prev`, `/palette`, and `/focus`, and whether each command takes arguments. `/next-unread` goes to the highest level, ties by the sidebar's order, skipping the open one, and gives nothing for Activity alone or when only the open one calls. `/read` marks the open Timeline, `/read all` every one, nothing when nothing is unread, and each says why without a Timeline or with other words. `/notify` takes `on` or `off` in any case. `/query` gives a `Query` for one name from any Timeline of the Network, refusing none, a list, and text after it, and `/members` turns the members over, or shows or hides them. `/split` splits side by side by default and with `h`, one above another with `v` in any case, opening what calls most of the Timelines no Pane shows, or nothing, and refuses anything else; `/close`, `/pane`, `/swap`, `/equalize`, `/zoom`, `/grow`, and `/shrink` give their changes, directions in any case, and refuse with one Pane, or with words after those that take none. Acting: `/topic` sets the text exactly, clears it with `-delete`, and alone starts the composer with the topic as known, stale, or none, refusing while it is unknown or the head is unread; `/kick` reads comma-separated nicks and a reason, refusing an empty item; `/mode` gives each change its parameter by `PREFIX` and `CHANMODES`, on the open Channel or one named, refusing a letter neither names, a missing or extra parameter, an unsigned mode, and parameters on Self's modes, and needs the head's rules and, from the Network's own Timeline, a target; `/op`, `/deop`, `/voice`, and `/devoice` give `Mode`, and a Network without `v` says so; `/ban` makes a bare nick `nick!*@*`, and refuses without `b`; `/invite` to the open Channel or one named; `/away`, `/back`, `/nick`, `/quote` and `/raw`; and each where it can run, `/away` with no Session included. `/mode +local +m` changes the `+` Channel where `CHANTYPES` has `+`, beside `/mode +m` and `/mode +l 5`, which change the open Channel, and `/quote` and `/raw` of `PASS`, `AUTHENTICATE`, and `OPER`, in mixed case and after tags and a source, are refused, while a `PRIVMSG` saying `pass` is not.

`src/activity.test.ts` reads a state built as the API answers: a Timeline's level and a Network's summed counts kept at the cap, `999+`, labels and their plurals, the page's title, and marks up to the latest named as the Daemon names Targets, none when read that far, nothing is unread, there is no item, or it is detached. Marking read is due only once the view said it shows the latest, and no further than the item it named, is not due for a Timeline opened again while scrolled back, which changes nothing, and is forgotten when another opens until the view says so again. It is due up to the last item shown when the Owner sees it, not while hidden, unfocused, scrolled back, or showing the options, never past the last item held when the Daemon lists a later one, never back, and not once the Daemon's marker comes back; and, as a property over any items, Read Marker, counts, visibility, and scrolling, it is due exactly when it should be and only up to the last item held. The divider goes before the first item after the marker, stays as the Daemon's marker moves and when the Timeline is opened again while open, is taken afresh after another opens, and is absent with only Activity unread, first when nothing was ever read. A notification comes for a Highlight elsewhere, a Direct Message, and the open Timeline while hidden or unfocused, and never for what the Owner sees, a Message, history, ours, read, or a change given twice, nor for a step given again after a reset to before it and the Timelines read again; it says where and what in isolated plain text, a hostile sender's override dropped, tagged by Timeline, the latest per Timeline only. With two Panes, each seen at its latest, the focused Pane's Timeline is marked first and the other's once that one is read, and neither while zoomed or on a compact screen hides it; a Highlight in either notifies of nothing while both show, and of the hidden one when zoomed or compact.

`src/channel.test.ts` covers the open Channel, which is the open Timeline only when listed as a Channel's and not while the options show; its head read, and its members only while they show, each once; both read again after a wait for an Activity in it, a Gap of its Network, an overflow naming it or everything, and a reset, and not for a Message or another Channel's Activity; a read in flight never superseded, a change meanwhile leaving it dirty for the next read, and an answer asked before what is held not taken over it; the delay before a read again, none for a first, the debounce after quiet, and no sooner than an interval after the last while busy; the page after the members held asked for as the Owner scrolls, joined to them, and a page after a place the list no longer ends at merging nothing; a read again as many as were held, at most 500; another Channel opened starting afresh; the header of a Channel, its topic formatted with who set it and when, its mode string and its count, where Self stands in words for each standing, no topic and one as last known, and the name alone before its head is read; a Direct Message's and a Network's simpler header; a member's symbol, away, and label; the members listed with their count, `Out` when the members route says Self is not in it; `touches`; and `/query` by the declared casemapping, `[BOB]` finding `{bob}` under `rfc1459` and not under `ascii`, and starting `/msg` when nothing was said. With two Panes, each Channel shown is listed, the focused Pane's first, each Pane has its own header, each Channel's head is read and held apart, Activity in one reads that one again only, and `Kept` lets go of one no Pane shows.

`src/completion.test.ts` covers the word at the caret, Tab taken only with one; a command at the start of a line cycled forwards and back, wrapping, and Shift+Tab taking the last; an option after `/set`, in any case; a Channel's name by `#` and by a Channel's first character, keeping what follows the caret with no space added before whitespace; a nick asked of the members route once however often Tab is pressed, ordered by who spoke latest with Self last, with `: ` at the start of a line and a space elsewhere; an answer for a request let go of or superseded ignored, a failure and no nicks said in words; an answer for a draft no longer shown, of other text or at another place, putting nothing in; a Channel's name told from a nick by the Network's `CHANTYPES`, RFC 2811's while unknown, `[bob]` a nick under `#` beside a Channel Timeline named `[old`; Escape giving back the text and caret; the nick after `/whois` asked of the members route, and after `/whowas` in a Direct Message, with a space; starting afresh after the caret moved; and the sources of a Channel, a Direct Message, and no Timeline, with `CHANTYPES` taken only as read during the Session in now, and wanted for that Session until one is kept. As a property, any number of Tabs and Shift+Tabs on any text at any caret, then Escape, gives back exactly what was typed.

`src/lookup.test.ts` runs every one of the shared nick vectors in [`fixtures/nicks`](../../fixtures/nicks/README.md), as `isLookupNick` and, trimmed, as `parseLookupNick`, each read as the Client reads it but where a vector says otherwise and why; says in words why a name is none, empty, a list, spaced, a mask, a source, a server mask, holding NUL, a Channel's name, and starting with a rank's symbol; reads the rules from a head, or as the Client does before an Ircd says; `/whois` and `/whowas` giving a `Look` with the head's ranks, or RFC 1459's without one, needing a Timeline open and a Session; one card a Pane, an answer for a card replaced changing nothing, a result kept over a failure after it, naming read from `known`, `rfc1459` and RFC 2811's while undeclared, a card put away, the cards of the Panes there are kept and none once signed out, the ids counting on, and shown only while its Pane has open the Timeline it was asked from; idle humanised and a negative or fractional count unsaid; a whole profile, with the signon by the format given, where the User connects from and their modes, the Channels' symbols by the ranks, a mode they do not name said for a screen reader, one opened by its key under `rfc1459` and one with no Timeline started as `/join`, and the numerics read for nothing; a signon that cannot be formatted said unavailable, the rest kept; no Channel chosen before the naming is read, nor one holding a control or an override; hostile text in every field contained; and each phase and result that describes no User in words. The state survives `structuredClone`.

`src/keymap.test.ts` checks, as a property, that any chord reads back from the text it formats as the same chord, and that text writes the same way again. It covers parsing in any case and with aliases, refusing text that is no chord, AZERTY's `é` and German's `ö` kept as typed and a binding of `é` resolving outside a field, Shift alone and Ctrl on the same key, German AltGr+Q, with AltGraph, typed in a field and a chord outside one, the same Ctrl+Alt without AltGraph a chord in a field, and a US Ctrl+Alt+K resolving in a field, and Alt+arrows still moving between Timelines on those layouts, showing chords as each platform does, chords from key events with Mod as Cmd or Ctrl, a Mac's Option and dead keys read from the physical key, a layout's own letter kept, and a key an input method holds; every default binding parsed, and one that does not parse dropped; `when`; and `resolve`: the palette from the composer but not while it is open, Cmd on a Mac and not Ctrl there, the next and previous Timeline wrapping and from none, nothing with no Timelines, Alt+A jumping to the Timeline calling most, as Option+A on a Mac in a field too, and taken with nothing calling, Alt+M and Option+M turning the members over, but not while the palette is open, `i` focusing the composer outside a field and typed inside one, `mod+,` opening the options, a bound command's own conditions, and a later binding winning. The Panes' keys split, close, zoom, equalize, grow, shrink, and move with Alt+Shift, in a field too, Option+Shift on a Mac by the physical key, and with one Pane only splitting is taken, the rest let through.

`src/palette.test.ts` covers the themes listed after the Timelines, the one in effect said, alone when scoped to them, found by name and as themes, and chosen to draw in; what is listed in a Channel and from no Timeline, never `/palette`, a command's chords beside it, ranking by prefix, then a word's start, then characters in order, an alias, a leading `/`, nothing for no match, sections ordered by their best entry, recent choices first and only once with no query, and ignored with one, and what choosing gives: a command run, or started in the composer when it needs arguments or cannot run with none, a Timeline opened, an option's `/set` started, and a Credential option's prompt; an empty or blank draft started, and one with text kept with a notice. As properties, no choice ever changes a draft with text in it, and `remember` keeps at most the cap, newest first, each once, for any choices, and the state survives `structuredClone`.

`src/composer.test.ts` covers a raw `PASS`, `AUTHENTICATE`, or `OPER` by `/quote` or `/raw`, in any case, among other lines too, refused in words, cleared, and kept out of the history, a line sent and kept in the history, one Say per non-empty line in order, whitespace sending nothing, a NUL and a bad line refusing everything with the text kept, the confirmation threshold, confirming and dismissing, drafts kept per Timeline, and recall in order back to the draft. A property over any sends, draft, and number of Ups checks the history is bounded and newest first, Up that many times and Down as many returns to the draft, another Timeline's draft is untouched, and the state survives `structuredClone`. A recall while lines wait to be confirmed lets them go, and a property over any typing, recalls, submits, confirms, and dismissals checks that what waits to be confirmed is always exactly what is shown. It also covers a refusal in words, with nothing after it sent, its Target contained, what is offered after `NotJournaled` and `Journaled`, the latter promising no delivery, and only `CheckAgain` after no answer.

`src/options.test.ts` covers the fields derived from the Schema, one for each of the Configuration's, each described, with its kind; every option of a Configuration with a SASL login, a password, and a keyed Channel listed, each resolved by its name; each value and starting value in its syntax; Credential options showing only a name and whether it is held; a member's fields unset while another is in force; names with dotted Network ids and Channel names; Credential names derived, escaped, and kept; patterns and text matched. It checks, as properties, that each kind reads back what it shows, for any value the Schema admits, weighted towards quotes, commas, backslashes, spaces, and Unicode, that an Ircd list typed any way, `plain` in any case, shows what it reads, that the old `-tls` and `+tls` are refused, in an option and in `/network add`, and that any text set on any option gives a Configuration or says why. It covers setting each option to what it shows giving the same Configuration, setting and refusing values, a member put in force by one of its fields, keys kept as Channels are set again, unsetting each kind or refusing one that must be given, refusing to unset a SASL login's Credential, pointing a Credential option, joining and parting as the Network folds names and exactly while it says none, an ascii Network's `#[a]` and `#{a}` never merged or parted together, a name two entries fold to refused with both named, `PartTimeline` by the routed key, `%help` kept under `CHANTYPES=%`, a bare name prefixed with `&` on an `&`-only Network, and refused while `CHANTYPES` is unknown, the list syntax's escapes, edges, and empty elements, text set verbatim, the commands `/set`, `/unset`, `/network add`, `/join`, and `/part`, `/set` on a Credential opening the prompt and a value typed after it refused, the composer clearing such a line at once and keeping it nowhere, and the options view listing what it read, filtered, keeping the newest read.

`src/options.test.ts` also covers the options under `ui`: one for each field of `UiOptions`, each described, with its kind; each listed with the value in effect, the shared one, and this device's override, before and after the shared ones are read; listed after every Network's, filtered, with the newest read kept; and `/set` and `/unset` of one, in any case, with `-device`, refusing `-device` alone or with a Network's option, an empty value, an option `ui` does not have, and a value its Schema does not take. `src/ui.test.ts` covers a device's overrides read back from the text they are kept as, dropping an option `ui` lacks, a value its Schema refuses, text that is not an object or JSON, and text too long, one overridden, replaced, and no longer, and a refused value never kept; 32 themes of the longest names beside an overridden `theme` read back whole through `overridden`, and a reserved or broken theme dropped alone; the override winning over the shared value, which wins over the default; and which items a Channel's Timeline shows under each `activity`, every item of another kind of Timeline shown.

`src/theme.test.ts` checks, as properties over any palette weighted towards greys near the middle, where the least contrast either way is lowest, that every text colour, nick, and mIRC colour reads at 4.5 on the background and both surfaces, dim text and the focus ring at 3, what is on the accent and the selection at 4.5, under `theme` and `raw`; that drawing is the same every time and every colour is CSS; and that a colour moved to be read keeps its hue within 6 degrees, wherever it and the result have chroma to speak of. It covers a readable colour left alone, mIRC's mapping table and its colours 16 to 98 kept, a theme dark or light by its background, the CSS variables' names and count, 16 distinct nick slots for Nord and for a grey palette, a run's colours as the variable, on a background of their own, reversed, and in hex, the themes listed, drawn by name, `system` as the device prefers and a removed name as `system`, names parsed and used, and edits imported, replaced, removed, and refused, and the contract refusing a theme named twice, a 33rd, an upper-case name, and an import named `system`, a built-in name, `import`, or `remove`, its built-in names being exactly the palettes'. `src/theme-import.test.ts` reads a real file of each format from [`fixtures/themes`](../../fixtures/themes/README.md), each with its licence there, to the exact palette, then the older base16 layout, Alacritty's YAML, `0x` and short hex, and a P3 colour; refuses in words a bad hex, a missing colour, a named colour, a number for a colour, a DTD with entities, a plist nested 10 000 deep, unclosed, or with a key misspelt, a Windows Terminal settings file, text of no format, and malformed JSON, TOML, and YAML; refuses 256 KB and one character more, and reads 256 KB; refuses Kitty and Ghostty files of 60,000 settings and a plist of 30,000 values; reads, within two seconds, files that repeat one setting thousands of times, 40,000 blank lines before a Kitty file, whitespace lines, 200,000-character single lines, and plists padded with 100,000 whitespace lines or holding 4,086 values; skips, saying why, the two YAML texts Effect's parser is quadratic on, to be run once it is linear; reads every format after 40,000 blank or whitespace lines, and Kitty after a 200,000-character line; refuses a plist whose dict is closed by `</array>`, with no `</plist>`, closed by another tag, that goes on after it, or with a declaration, a doctype, or a processing instruction after it or inside it, and reads one with a declaration and doctype before it and a comment after; follows no `include` or `config-file`; and makes names from names given.

`src/search.test.ts` covers reading a query: words joined into one run and a quoted run kept whole, colons included; each filter in any case, a value quoted or not; `in:` by exact name, then by key as written or ASCII lower-cased, a detached Timeline only when nothing else is, ambiguity across Networks and on one in words, and only on the Network named or in focus; `since:` and `until:` as days through `dayStart`, `until:` the next day, across a year's end and a leap day, and ISO times with `Z` and offsets, before 1970 too; and each refusal in words: too short, filters alone, too long, an unknown filter, a link unquoted, a filter twice or empty, a nick with a space, a quote not closed, an unknown Network, no such day, no such time, minutes or seconds of 60 included, a time with no zone, offsets of `+99:99`, `+01:60`, and `-24:00` while `-23:59` is read, and `since:` not before `until:`, three astral characters enough and a letter with its combining accent not. The search reads its first page, then the next from where it ended; begins again on a new query, taking no answer of the one before; begins again from the first page when restarted, and when a later page is of another version, waiting longer; holds at most the cap and asks for no more; says a failure and an unreadable query in words; keeps the selection among the results; and survives `structuredClone`. Marking: every match in any case, `İ` folded as the Daemon folds it, none, and repeats; hostile text with an override, markup, a control, and mIRC bold, marked as plain text with the markup kept as text; and a sender with an override shown plain. `src/timelines.test.ts` also covers the search shown in front of a Pane's Timeline, read a page at a time only while shown, and closed back to it or to the options, never kept with the layout; begun again on a merge, an overflow, and a reset but not on a quiet step; and a jump: its Timeline opened in the search's Pane, read around the position as a new generation, never following, a live item waiting beyond it, with the target and nothing seen; a window around the newest result, which holds the latest, taking a `Following` at the latest only when `owned`; the latest read in flight for the window replaced not taken, and around read again after an overflow; the target let go when the Owner scrolls, and the latest read and followed when asked; and a jump into the Pane that has the Timeline open, which takes the focus, the search staying where it is.

`src/render.test.ts` covers formatting, the schemes linked and those not, a link's style and `href`, a link ended at a bidirectional character, controls shown, bidirectional formatting closed, a line of 70 000 characters, linear time over 64 000 closing brackets after a link and 30 000 nested embeddings closed by isolates' pops, and, for any text weighted towards hostile pieces, that it never throws, no run holds a control, every run closes its bidirectional formatting, and every link is of an allowed scheme. Plain text strips formatting, controls, and bidirectional characters, makes separators spaces, cuts at the limit by code point with an ellipsis, never through an emoji, stops early on 70 000 characters, and, for any text weighted towards hostile pieces, holds no control, bidirectional character, or lone surrogate inside its isolate. Nick colours are the same in any case and on every run, in range, and spread over every slot. Lines cover a Message, each delivery in words, a rejection's code contained, and the Ircd's confirmed text, a hostile nick, each Activity, and a Session's start and end.

## Not yet

- **One Timeline in two Panes,** at two places, as WeeChat and tmux allow. A Pane opens what no other Pane shows.
- **A layout kept under `ui`,** shared by every device. It is kept per device, and a phone's screen shows one Pane at a time whatever it holds.
- **More options under `ui`,** such as overrides of the keymap, and options of the Daemon's own. `keymapOf` is ready to read them, dropping what does not parse.
- **Chords in sequence,** such as `mod+k mod+o`. None of the defaults needs one, and `mod+k` alone opens the palette, so a sequence beginning with it would make the palette wait.
- **A divider for what came while the Owner was away from an open Timeline.** The divider is taken when a Timeline opens. One left open in a hidden page gathers unread items, which the counts show, but no divider until it is opened again.
- **Marking a detached Direct Message read.** No Target names it, so its counts stay until the API can mark a Timeline by its id.
- **Removing a Network,** which the API cannot do yet. `/network add` only adds.
