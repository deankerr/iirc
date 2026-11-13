# Known issues

What is built but not yet right, or right only within limits worth knowing before relying on it. Each entry says what happens, how much it matters, and what to do.

Remove an entry in the change that fixes it. A defect someone means to fix is an issue as well. What has only not been tried, such as another browser or a real phone, is not listed here.

## Behaviour to know

- **Back does not close the drawer or the sheet.** There is no router, so Android's back gesture leaves the page. Escape, a press outside, or a choice closes them.
- **A theme file can take too long in Safari or Node.** Effect's YAML parser has quadratic regexes (`endsWithEscape`, `foldFlowLines`) in JavaScriptCore and Node, though V8 reads the same text at once. Import runs in a Worker with a one-second limit, so the page never freezes, but a hostile or very odd base16 or Alacritty YAML file is refused as too slow to read. Reporting it upstream is still to do.
- **Scrolling up through a long Timeline pauses once at a thousand lines** with "Load older", so an automatic read never pushes the latest out of the window. One click goes on.
- **A scroll still coasting a second after its last input is not taken as the Owner's if the Timeline's size changes then,** as when a Pane is resized mid-glide. The view stays where it stood rather than where the glide would have ended, never nearer the latest. Scrolling again goes on.
- **A detached Direct Message Timeline cannot be marked read,** since no Target names it. Its counts stay until the API can mark a Timeline by its id.
- **The Panes' keys do nothing while the sidebar's tree has focus,** because the tree takes Alt+Shift and an arrow itself. They work from the composer or a Pane.
- **Search keeps diacritics and does not join composed and decomposed forms,** so `cafe` finds neither `café` nor `cafe` written with a combining accent. `from:` compares the sender folded for search, not by the Network's casemapping, so under `rfc1459` `[a` does not find `{a`.
- **A merge between two pages of search results can repeat a result.** The web frontend starts the search again when one happens.
- **Completion of Channel names falls back to `#&+!`** if `CHANTYPES` was read before the Ircd's `005`, until the next Tab reads it again.
- **The pane layout and notification choice are kept per device,** not shared.
- **A Session that joins many Channels learns their modes one after another,** since one `MODE` query waits at a time. On an Ircd that answers at once, the last of a hundred Channels shows its modes about as long after joining as pacing takes to send a hundred Lines, a few minutes. One that never answers holds each query 30 s.

## Edges in what the Client works out

- **Activity from history is placed by the Network's state now,** not then. Nothing sends history yet; a `chathistory` Feature must route by its batch's target.
- **After a casemapping change, a Read Marker can sit under a different spelling's key than its Timeline,** so a later read of the Timeline may not be reported. The projection moves each Timeline's marker only forward, so none ever moves back. Networks almost never change their casemapping.
- **An error that names a Channel while the Client's own `MODE` query of it waits goes to whichever was sent first,** the query or an action of the Owner's on that Channel, as every floor reply does. So an action sent after the query, refused within the query's 30 s by an Ircd that never answers the query, is not reported refused, and an action sent before it is reported refused by an error that was the query's. An error that answers only a change, `467`, is always the action's.
- **The `MODE` query's 30 s runs from when it is queued, not sent,** so behind many Lines waiting on pacing the next Channel can be asked before the first query has left, and a late answer still folds.
- **What a Lookup learns of a member does not have their Channels read again.** A `WHOIS` that finds a member away changes what the Client knows of them, but no Activity or `head` says so, so a members' list already shown says it at its next read.
- **A `+k` change waits until an error or the 64-Line bound,** since no Ircd echoes a key, so an error about that Channel can be tied to it rather than a later action in rare orders.

## Operation

- **A Frontend that reads News must be as new as the Daemon.** News is a closed set, so a reader built before a kind of News was added, such as `ChannelLearned`, refuses an event that holds one. The Timelines and their changes only gain fields, which an older reader passes over.
- **A SQLite Journal from before Changes could not store `ui` options,** and a change to one answers 500. No Daemon has written a Journal in earnest yet; a new data directory has the current layout.
- **The web script is one file of about 1.1 MB,** 350 kB gzipped, not split.
- **Rebuilding `views.sqlite`** after a new projection version folds the whole Journal again on start, which grows with history.

## Tests

- **A few tests bound time** (the Client's scale test, the theme importers, search timing). They pass with wide margins here, but a much slower machine could fail them.
- **No test covers a Lookup's recovery when one `GET` times out and the next succeeds,** though a review exercised it by hand.
