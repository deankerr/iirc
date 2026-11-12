# @iirc/web

The web frontend: a React 19 view over `@iirc/frontend`, its pure core, built with Vite. It is a Frontend like any other, and reaches the Daemon only through `@iirc/api`, which the lint fence enforces. It is served on the API's own origin, by `iirc daemon --web`.

```sh
bun run build:web                                        # at the root: apps/web/dist
bun run iirc daemon --data-dir ~/.local/share/iirc --web=apps/web/dist
```

The core decides and this package draws and does the I/O.

## What it does

- **Signs in with a key,** given to `POST /api/sign-in` once, for a sign-in the browser holds in an `HttpOnly` cookie. A failure is said in words, with a way to try again.
- **Lists the Networks and their Timelines in a sidebar,** as a tree. A Network's row is its own Timeline, with how its connection stands as a symbol whose shape and colour both say it, and its Channels and Direct Messages are under it. What the focused Pane shows is chosen, and what another Pane shows has an accent edge and that Pane's number. The options and signing out are at its foot.
- **Lets the sidebar be resized and hidden, on this device.** Its edge drags, or takes the arrows, Home, and End once focused, and keeps its width as the window changes. `/sidebar` or Alt+N hides it, and so does the button at its foot. While it is hidden, the button before the composer brings it back, marked by what is unread.
- **Shows what is new, calmly.** A row's name is coloured by the highest level unread in it, with small counts beside it, and the page's title counts Highlights and Direct Messages. A Highlight's line is tinted, and a "new" divider stands before the first unread item.
- **Shows a Timeline live,** as terminal lines in shared columns: the time, the sender in their colour, and the text with its formatting and links. Activity is dimmer, a Gap is a divider, and our own Messages say only when they are sending, not sent, or refused. Where a Timeline is narrow, as a Pane split a few times is, the columns go and a row reads as one run of text that wraps under itself. It opens on the latest, stays at the bottom as items arrive, and reads older items as the Owner scrolls up.
- **Splits into Panes,** as a tiling window manager does. Each Pane has its own status bar, Timeline, scroll position, and members. Among several, the focused Pane is edged in the accent along its top and bottom, and the others' names are dimmed. One composer under the Panes writes to the focused Pane's Timeline.
- **Says Messages and runs commands from the composer.** Enter sends, Shift+Enter starts a new line, Up and Down recall what was sent, and Tab completes. A paste of more than five lines asks first. Why something was not said is shown under it, with a way to dismiss it, and to send or check again when that is safe, and it goes when it stops being true.
- **Takes what is typed from anywhere.** A character, a dead key, or a paste pressed where nothing takes text, such as a Pane's Timeline, the sidebar's tree, or the members' list, goes to the composer, which takes the focus with that very key. A palette, a dialog, a popover, or a menu keeps its keys, as does a key the keymap binds.
- **Marks read where the Owner has seen it:** a Timeline at its latest, in a Pane they can see, once that has held for a second. The Daemon keeps the Read Marker, so every Frontend sees the counts clear.
- **Searches the Messages of every Timeline,** newest first, in front of a Pane's Timeline. It searches on Enter, not as the Owner types, since a query half typed would search for something else. Choosing a result opens its Timeline read around it, and marks nothing read.
- **Has a command palette,** opened by Mod+K, which lists commands, Timelines, themes, fonts, and options, ranked as the Owner types.
- **Takes keys from anywhere on the page,** by the core's keymap. A key the keymap does not take goes on as it would.
- **Changes Configuration as an option tree**, by `/set` and its kin or in the options view, which edits each option in place. A Credential is given only in a password prompt.
- **Shares the options under `ui` between devices, and lets one override them** with `-device`.
- **Draws in themes made from terminal palettes,** built in or imported from a theme file. A theme highlighted in the palette, or being imported, previews on the whole page.
- **Draws text in the size and font the Owner chooses:** `ui.size`, from 10 to 24 pixels, 14 to start, and `ui.font`, the device's own monospace font, or one of five it serves itself, below. A font highlighted in the palette previews on the whole page, and a change takes effect at once.
- **Shows who is here.** A Pane's status bar is one line: its number, the Timeline's name, a Channel's modes and its topic, cut to the line, and the members' toggle, which says how many there are. A press on the topic discloses it in full under the bar. The toggle, `/members`, or Alt+M shows the members under the bar, by rank, and a press, a tap, or Enter on one opens a menu of `query`, `whois`, and `mention`, Query first, so Enter twice opens their Direct Message.
- **Opens a Direct Message by nick,** with `/query`. When nothing was said yet, the Pane shows a Direct Message not yet begun, and the first Message makes its Timeline.
- **Looks a User up,** with `/whois` and `/whowas`, as a card under the Pane's status bar.
- **Notifies, when the Owner asks,** with `/notify on`: a Highlight or a Direct Message in a Timeline they are not looking at.
- **Fits a phone.** A screen 640px wide or less shows the focused Pane alone, with one slim bar holding the sidebar's button and the Panes' switcher, the sidebar as a drawer, and the members as a sheet. Where the pointer is coarse, every control is at least 44px and every field's text at least 16px, so iOS Safari does not zoom into it. Pinch zoom is never turned off.

## How it is built

| Folder | Holds |
| --- | --- |
| `src/app/` | The shell, the one Effect runtime, the Daemon's client, and how intents are named |
| `src/sign-in/` | The sign-in screen and its commands |
| `src/timelines/` | The Timelines' atoms, the changes stream, the layout kept, the sidebar, and the Timeline view |
| `src/panes/` | The Pane tree, drawn with `react-resizable-panels`, and how wide each Pane is |
| `src/composer/` | The composer, what carries out its intents, and Tab completion |
| `src/options/` | The options view, changing a Configuration, holding a Credential, and the options under `ui` |
| `src/search/`, `src/palette/`, `src/channel/`, `src/lookup/` | Each of those views and its atoms. `src/palette/` also holds the one key listener |
| `src/reading/`, `src/notifications/` | Marking read, the page's title, and the `Notifier` port |
| `src/page/` | Whether the Owner can see the page, what this device keeps, what lies over a compact screen, and the sidebar's width and whether it shows |
| `src/theme/` | The theme and the text's size and font drawn, the fonts, importing and removing themes, and the Worker a theme is read in |
| `src/ui/` | The theme's tokens, a button, a password field that holds no value, and dates |

### The runtime

- **One Effect runtime.** `Atom.runtime` provides `DaemonClient`, which is `HttpApiClient.make(DaemonApi)` over the browser's `fetch` with relative URLs, so every request goes to the origin that served the page and carries its cookie. A test replaces its Layer.
- **State lives in atoms, not components.** Each atom holds one of the core's states, and everything else is derived from it. Components read atoms and run commands. None fetches.
- **The core decides what to do, and the runtime does it.** A few loops are mounted once in `src/main.tsx` and run while the browser is signed in. Each watches what the core asks for, does it, and folds the answer back in as an event:

  | Loop | Does |
  | --- | --- |
  | `sync` | Makes the reads `wanted` gives, follows the changes stream, and keeps the layout |
  | `uiSync` | Follows the options under `ui` |
  | `channelSync` | Reads each shown Channel's head and members |
  | `marking` | Marks read what `markDue` says, after a second |
  | `completer`, `chantypesSync` | Ask for the nicks and the `CHANTYPES` that completion needs |
  | `lookupSync` | Lets go of the Lookup cards of Panes that are gone |
  | `watchPage`, `watchTheme`, called once as the page starts | Keep whether the page is seen and compact, the title, and the theme on the root |

- **A read that fails is asked again,** soon and then up to every 15 s. `Unauthorized` signs the page out. Every failure is decided from the API's structure, never a response's text.
- **One changes stream for the whole page.** It is followed from the place the core holds, and followed again when it ends or gives nothing for 45 s. It is read with `fetch`, not `EventSource`, which would keep a place of its own apart from the core's and could not tell a refused sign-in from a network failure. A reload reads everything again, so the place is never stored.

### Saying and changing

- **Nothing is sent twice.** A Say, an Act, or a Lookup is made under an intent the runtime names, `web-` and a random UUID, since the core makes no randomness. After a failure the runtime asks `said` under that intent, and the composer offers to send again only when the Daemon says it was not journaled. After no answer at all, it offers only to check again.
- **Submissions go one at a time,** in order, and a failure stops the intents after it. What only changes the page, such as opening a Timeline or the palette, is done at once and never waits behind a Say.
- **Our own Message appears once, when the Daemon folds it,** never drawn ahead. What became of it is its item's delivery.
- **A change is made from what was read.** A change of Configuration, of an option under `ui`, or of the themes reads the current value, applies the core's edit, and sends the whole with `ifSequence`. On a conflict it reads again and applies the same edit once more. A second conflict is said in words.
- **`/msg` opens where the Daemon put its Message.** Once the changes say its step was folded, the runtime reads which Timeline it was placed in. The Frontend never matches a name itself.
- **A Credential's value goes straight from the password prompt to the Vault.** The prompt's field is the sign-in's, below. A value typed into the composer is refused and the textarea cleared as Enter is pressed.
- **A Lookup has one deadline,** two minutes from when the Owner asked. Until then a pending one is asked after by its intent.

### Drawing

- **One key listener for the page.** `Keys` listens on the document after every widget's own handlers, asks the core's `resolve`, and prevents a key's default only when a binding took it.
- **A key that types is taken before any widget sees it.** The same `Keys` also listens in the capture phase, ahead of React Aria's typeahead, which listens in React's own and would move the focus to a row. When the core says the key types, the composer's textarea takes the focus synchronously, its caret at the end, and the key is stopped there without preventing its default, so the browser types the character, or pastes, into the composer.
- **The palette is React Aria's Autocomplete over a Menu, in a Modal's Dialog.** What it lists is ranked by the core, so the Autocomplete filters nothing itself.
- **The core owns the Panes, and `react-resizable-panels` only draws them**. The library has no controlled layout, so each Split pushes the core's ratios with `setLayout`, and only a change the Owner made goes back to the core. Each Pane's content is drawn once, through a portal, into a node that lives as long as the Pane, so a split or a swap moves it and never draws it afresh. The Timeline view puts back the scroll position a move loses.
- **A row's layout follows its Timeline's own width,** by a container query on the view, since Panes split and the screen's width says nothing of a Pane's. Nothing in a Timeline scrolls sideways: a row breaks what has no place to break, and the view clips what is left.
- **A Pane narrower than 600px shows its members over its Timeline,** never beside it, since eighteen characters of members would leave too little Timeline. Each Pane is measured with a `ResizeObserver`. There the toggle opens them for that Pane alone, and Escape, a press elsewhere, or choosing an action puts them away, as each does the sheet on a compact screen. The device's choice of a column covers only the Panes wide enough for one.
- **The Timeline view is TanStack Virtual's,** with only the rows near the view in the page. Where the view stands is kept in refs, never in state. A row in view stays still as rows are added above, dropped, or hidden by `ui.activity`.
- **The view tells the core what the Owner has seen.** It says whether it is at the latest and names the last item in view. It tells a scroll the Owner made from one it made itself, so a Timeline opened at a search's result marks nothing read until the Owner goes to the latest.
- **A view that cannot scroll reads older pages on its own,** as when the latest page is all hidden Activity, up to the window's cap. Past that, "Load older" asks on purpose.
- **The theme, and the text's size and font, are custom properties on the root, set through the CSSOM,** which a Content Security Policy allows where it refuses inline styles. `src/ui/theme.css` gives each colour as `light-dark()`, and the defaults' size and font, for the first paint. Rows are measured, so none assumes a size.
- **A font is fetched only once text is drawn in it.** `src/theme/fonts.css` declares each one's faces from its `@fontsource` package: a regular, a bold, and both italic, or a variable font, in WOFF2 alone, split into the ranges the package gives. The browser fetches a file only for a family drawn with and a character of its range on the page, so the device's own font fetches nothing. Vite emits each as a file of the page's own and never inlines one, which `font-src 'self'` would refuse. While a font loads, if it never does, and for any glyph it lacks, such as box drawing, text is in the device's font.
- **A theme file is read in a Worker, never in the page.** Effect's YAML parser is quadratic on some text, so a read that takes longer than a second is ended and refused in words. A browser that cannot start a Worker says so.
- **Styles are CSS Modules over the theme.** No module names a colour of its own, and each module's class names are declared beside it, so a class that does not exist fails to compile.

### What this device keeps

Each is in `localStorage`, read once as the page starts and written as best it can be, since storage can be refused.

| Key | Holds | Why not under `ui` |
| --- | --- | --- |
| `iirc.layout` | The Panes, naming Timelines by id | A phone shows one Pane at a time anyway |
| `iirc.ui` | This device's overrides of options under `ui` | They are the device's own |
| `iirc.notify` | Whether this device notifies | A device's own choice |
| `iirc.members` | Whether the members' column shows beside a Pane wide enough | How wide a screen is is the device's own |
| `iirc.sidebar` | Whether the sidebar is hidden, beside the Panes | The same |
| `iirc.sidebar-width` | How wide the sidebar is, in CSS pixels | The same |

Anything kept that cannot be read leaves the page starting as new.

Whether the screen is compact is `(max-width: 640px)`, past every phone held upright and short of a tablet. What is sized for touch is decided apart from it, by `(pointer: coarse)`, so a tablet gets a finger's targets with the desktop's layout.

## What it guarantees

- **The Frontend never stores a key**. The key field is a plain, uncontrolled `<input type="password">`, so the key is never in React state or props. React Aria's fields keep every keystroke in state, so a secret never goes through one. On submit the value is parsed straight to `Redacted`, the field is set to `""`, which also clears the last value React DOM tracks on every input, and the `Redacted` is wiped once the Daemon answers. No key is written to storage or to a cookie script can read.
- **The key field is accessible, and a password manager may keep it.** It has a label, says its failure with `aria-describedby`, and its `autocomplete` is `current-password`.
- **Text a Network sent is only ever a text node.** There is no `innerHTML`, and no markup is built from strings. Each nick, name, and text sits in a `<bdi>`. A link is one the core found, and opens in a new tab with `rel="noopener noreferrer"`.
- **It runs under a strict Content Security Policy.** It loads nothing but its own files, with no inline script or style. React Aria would inject one inline `<style>` for its pressable elements, so `public/pressable.css` carries the same rule under the id React Aria looks for. On iOS WebKit alone, React Aria's scroll locking adds a `<style>` the policy refuses: the page still works, and only that rule is lost.
- **An instant out of a `Date`'s range never takes the page down.** A Network can give any integer, so every time shown goes through `src/ui/dates.ts`, and one out of range shows as unavailable.
- **The composer is no keyboard trap.** Tab is taken only when there is a word to complete.

### The fonts

Each is under the SIL Open Font License 1.1, which lets the fonts be served with the page so long as their licence goes with them: the build ships each package's licence as `licences/<font>.txt`. The versions are pinned in `package.json`. A size is of every file of the font, as the build and so the binary carry it. A page fetches only the ones its text needs, such as the Latin regular and italic, 80 kB for JetBrains Mono.

| `ui.font`                    | Package                                           | Size   |
| ---------------------------- | ------------------------------------------------- | ------ |
| `jetbrains-mono`             | `@fontsource-variable/jetbrains-mono`             | 179 kB |
| `ibm-plex-mono`              | `@fontsource/ibm-plex-mono`, 400 and 700          | 211 kB |
| `source-code-pro`            | `@fontsource-variable/source-code-pro`            | 173 kB |
| `commit-mono`                | `@fontsource/commit-mono`, 400 and 700            | 197 kB |
| `atkinson-hyperlegible-mono` | `@fontsource-variable/atkinson-hyperlegible-mono` | 59 kB  |

## Development

```sh
bun run dev          # in apps/web: Vite on localhost:5173
```

The dev server proxies `/api` to a Daemon on `127.0.0.1:7667`, so the browser sees one origin. The proxy passes the browser's `Host` and `Origin` through unchanged, so the Daemon sees requests as same-origin, and it streams responses, Server-Sent Events included, without buffering. A Daemon that is not running is answered `502`, which the Frontend reads as no answer.

## Tests

`bun run test` renders the Frontend in happy-dom against the fake Daemon in `src/testing/fake-daemon.ts`. The fake answers at the `fetch` level, so every test goes through the real `DaemonClient` and the API's own decoding. The browser itself runs end to end in `apps/iirc`'s `bun run e2e`, against the built frontend on a real `iirc daemon --web`.

## Not yet

- **A view of News.**
- **Splitting the bundle.** It is one script of about 900 kB, 290 kB gzipped, most of it Effect, React Aria, and the Client's types the Timelines' positions bring with them, and Vite warns past 500 kB.
- **Notifying per Network or per Timeline, or of words of the Owner's own,** which would be options under `ui`. Whether a device notifies is kept in its `localStorage` until then.
- **A sound, or a badge on an installed app's icon,** with the manifest below.
- **An installable web app,** with a manifest and an icon.
- **Keys of the Owner's own,** set as options under `ui`, and kept per device.
- **Moving a Pane by dragging it,** and the Panes' keys from the sidebar's tree, whose own keys Alt+Shift and an arrow are.
- **The palette's first entry focused as it opens,** so Enter alone takes the most recent choice. React Aria's Autocomplete focuses the first entry as the Owner types, and ArrowDown focuses it before then.
