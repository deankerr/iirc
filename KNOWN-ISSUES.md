# Known issues

What is built but not yet right, or right only within limits worth knowing before relying on it. Each entry says what happens, how much it matters, and what to do.

Report what daily use turns up here, and remove an entry in the change that fixes it.

## Untested

- **Only Chromium has run the web frontend.** Safari, Firefox, touch, and screen readers have not. The places most likely to differ: Safari and the sign-in cookie over plain `http://127.0.0.1` (the cookie is not `Secure` on loopback, which should suit WebKit), React Aria's scroll lock injecting an inline style on iOS, which the CSP blocks (only overscroll is lost), and the theme importer's speed in JavaScriptCore (below).
- **The phone layout has run only in Chromium's mobile emulation,** never on a real iPhone or Android phone. The end-to-end run checks fields of 16px, targets of 44px, the drawer, the sheet, and the palette's button at a phone's size, touched, but not iOS Safari's own zoom, its safe areas, or its keyboard.
- **Touch on the Panes' dividers, and window resizing during a drag,** were never tried on a device. A divider takes a touch 44px across, but a phone shows one Pane, so only a tablet meets them.

## On a phone

- **The composer may not stay above iOS Safari's keyboard by resizing.** The page asks for `interactive-widget=resizes-content` and is `100dvh` tall, which Chromium on Android honours, but Safari ignores the former and keeps the page's height, scrolling it instead so the focused composer shows, which can push the bar out of view while typing.
- **Back does not close the drawer or the sheet.** There is no router, so Android's back gesture leaves the page. Escape, a press outside, or a choice closes them.
- **A tap on a member opens their Direct Message,** as React Aria acts on a tap in a list that has an action. Their `whois` and `mention` are reached by a long press, which selects them.

## Behaviour to know

- **A theme file can take too long in Safari or Node.** Effect's YAML parser has quadratic regexes (`endsWithEscape`, `foldFlowLines`) in JavaScriptCore and Node, though V8 reads the same text at once. Import runs in a Worker with a one-second limit, so the page never freezes, but a hostile or very odd base16 or Alacritty YAML file is refused as too slow to read. Reporting it upstream is still to do.
- **Scrolling up through a long Timeline pauses once at a thousand lines** with "Load older", so an automatic read never pushes the latest out of the window. One click goes on.
- **A detached Direct Message Timeline cannot be marked read,** since no Target names it. Its counts stay until the API can mark a Timeline by its id.
- **The Panes' keys do nothing while the sidebar's tree has focus,** because the tree takes Alt+Shift and an arrow itself. They work from the composer or a Pane.
- **Search keeps diacritics and does not join composed and decomposed forms,** so `cafe` finds neither `café` nor `cafe` written with a combining accent. `from:` compares the sender folded for search, not by the Network's casemapping, so under `rfc1459` `[a` does not find `{a`.
- **A merge between two pages of search results can repeat a result.** The web frontend starts the search again when one happens.
- **Completion of Channel names falls back to `#&+!`** if `CHANTYPES` was read before the Ircd's `005`, until the next Tab reads it again.
- **The pane layout and notification choice are kept per device,** not shared.

## Edges in what the Client works out

- **Activity from history is placed by the Network's state now,** not then. Nothing sends history yet; a `chathistory` Feature must route by its batch's target.
- **After a casemapping change, a Read Marker can sit under a different spelling's key than its Timeline,** so a later read of the Timeline may not be reported. The projection moves each Timeline's marker only forward, so none ever moves back. Networks almost never change their casemapping.
- **A `+k` change waits until an error or the 64-Line bound,** since no Ircd echoes a key, so an error about that Channel can be tied to it rather than a later action in rare orders.

## Operation

- **A SQLite Journal from before Changes could not store `ui` options,** and a change to one answers 500. No Daemon has written a Journal in earnest yet; a new data directory has the current layout.
- **The web script is one file of about 900 kB,** 290 kB gzipped, not split.
- **Rebuilding `views.sqlite`** after a new projection version folds the whole Journal again on start, which grows with history.

## Tests

- **The daemon's tests print "All fibers interrupted without error"** to stderr while passing.
- **A few tests bound time** (the Client's scale test, the theme importers, search timing). They pass with wide margins here, but a much slower machine could fail them.
- **No test covers a Lookup's recovery when one `GET` times out and the next succeeds,** though a review exercised it by hand.
- **The end-to-end runs use one Chromium,** and stand in a never-ending Worker to prove the theme importer's time limit, since Chromium reads the slow YAML at once.
