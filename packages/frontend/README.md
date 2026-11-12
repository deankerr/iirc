# @iirc/frontend

The pure core of the web frontend. It holds what a Frontend shows as plain data and reducers, and a view only renders it. It reads no clock, randomness, locale, or time zone, does no I/O, uses no Effect service, and knows nothing of React or the DOM.

## How every module is shaped

- **State is plain data.** Every state survives `structuredClone`, so it can be compared and kept.
- **A reducer takes events:** what the Owner did, what the runtime asked, and what the API answered. The runtime does all the I/O and decides all the timing.
- **The core says which reads to make.** Functions such as `wanted`, `channelReads`, `searchWanted`, and `nicksWanted` give the requests to make now, and never one already in flight.
- **An answer is taken only by what asked for it.** A read names the generation or request it was made for, so an answer that lands after what it was for was replaced changes nothing.
- **Text is parsed, or refused in words.** `Parsed<A>` is a value or `Invalid { message }`. Nothing here throws on what was typed, kept, or received.
- **A command never does anything.** It gives intents, plain data the runtime carries out.
- **What a Network wrote stays text.** Every string is for a text node, with controls shown as symbols and bidirectional formatting closed.

Each module below is imported as `@iirc/frontend/<module>`.

## Sign-in

A reducer over what the Frontend asked and what the API answered. The state is `Unknown`, `SignedOut`, or `SignedIn`, each with one attempt that is idle, waiting, or failed with a reason. `explain` says a failure in words.

- **It holds no key.** A key goes from the Owner's form to the API in one request. No state here has room for one.
- **Signed in only when the Daemon said so:** by an authorized read that was answered, or a sign-in that succeeded. A read answered `Unauthorized` later signs the page out.
- **An answer that does not fit the state is ignored,** so requests that overlap cannot put it somewhere the Daemon never said.
- **A failure comes from the API's structure, never its text:** a wrong key, a cross-origin request, a sign-in the Daemon could not save, a Daemon that did not answer, or an answer that could not be read.

## Timelines

Everything the Frontend holds of the Timelines, as a reducer (`reduceTimelines`) over what it read from the API and what the changes stream said. It never folds News: the Daemon does that, and this keeps what was read up to date.

For each Network it holds its Timelines, its connection, and whether Self is away. For each Timeline a Pane has open it holds a window: its items in position order, its collapsed Gaps, and whether more lie earlier and later. `wanted` gives the reads to make, `followFrom` where to follow the stream from, `sidebar` the Networks as a sidebar lists them, and `rowsOf` a window as rows.

### Reading and following

- **It reads everything, then follows.** The Network list and every Network's Timelines are read first. The stream is then followed after the smallest `through` among them, and the Network list is read once more, so a Network configured meanwhile is not missed. A window is read only once the stream is followed.
- **One rule decides whether an answer is current:** nothing that invalidates it happened after its read began. That is a reset, or an overflow that touched what it is of. An answer that is not current is asked for again.
- **No change is lost or applied twice.** A Timeline is kept by its id and an item by its position, so a change given again changes nothing. A read that lands after the stream passed it is brought up to date from what the stream gave.
- **An overflow reads again what it touched, and a reset reads everything again.** A merged Timeline resolves to the one it went to.
- **A Network's connection and Self's away are derived, never polled.** They come from `known`, and then from the Session items and `AwayChanged` the changes carry.

### Windows

- **A window holds at most `windowCap` items, 1000.** `earlier` and `later` are true exactly when something lies beyond, so everything dropped can be read again.
- **Only the windows of Timelines open in a Pane, and of the four closed most recently, are kept.** Any other is dropped and read again when opened.
- **A new item lands only where it belongs by position:** in place of the item it updates, between the items held, or past the end when nothing more lies beyond. A Gap that changes history under a window has it read again.
- **Only the view says what the Owner has seen.** A window's `seen` is set by the view's `Following` event alone, so opening a Timeline never makes the core believe its latest was read.
- **The "new" divider stays where it was when the Timeline opened,** and does not jump as the Daemon's Read Marker moves.
- **Failed Connections in a row are one row,** counted, when they are to the same Ircd for the same reason.
- **A Gap before anything is no row.** A Gap that ended, with no item before it, in a window that holds the Timeline's start, says nothing was missed, so `rowsOf` leaves it out and the window keeps it. A Gap still open, or one before the first item of a window with older items beyond it, is a row. Items a view hides still count as before a Gap.

### What a Pane shows

- **A Timeline is open in one Pane at most.** Opening one that another Pane has open focuses that Pane. Two Panes at different places in one Timeline would need every rule of reading to say which Pane wins, for little gain.
- **A Pane shows its Timeline, or something in front of it:** the options, the search, or a Direct Message not yet begun. It remembers one step back, which closing shows again. The options and the search each show in one Pane at most.
- **A Direct Message not yet begun is a view, not a Timeline.** The API makes a Timeline only when something is said. The draft shows its Timeline as soon as one is listed, matched by the casemapping read when the draft was made, never one held from another time, which could match another User's Timeline.
- **A Message said with `opens`, as `/msg` says one, opens the Timeline the Daemon placed it in,** by its id, never its name. It opens only in the Pane it was said from, and only while the Owner has not moved on.
- **A jump from the search opens a window read around a position.** Nothing is marked read by it until the Owner moves to the latest themselves.
- **The layout is kept per device, as JSON, and taken back once the Timelines are read.** `layoutKeptText` bounds the text before anything parses it, then reads it through its Schema, and never throws. A Pane whose Timeline is gone is dropped.

## Panes

`@iirc/frontend/layout`: the Panes as a split tree in a pure reducer, `reduceLayout`. It knows nothing of what a Pane shows, nor of the screen. A view renders the tree and sends back the ratios the Owner dragged.

- **A layout is well formed, whatever is done to it.** Every Split has two or more children, none a Split along its own axis, with positive ratios that sum to 1. Ids come from a counter, never randomness. The focus is always on a Pane.
- **A layout is bounded:** at most 64 Panes, Splits at most 16 deep, and no Pane below 1% of its Split. A change past a bound changes nothing, so every layout can be kept and taken back.
- **A split halves the focused Pane** and focuses the new one. A close gives the place to the sibling, and the last Pane never closes.
- **The focus moves as the screen lies,** as tmux and i3 move it, to the Pane across the focused Pane's edge, with no wrapping.
- **A swap moves the focused Pane whole,** its id and view with it, so its content moves and is not drawn afresh.
- **A zoom shows the focused Pane alone and toggles back to the very layout it was.** A compact screen, as a phone's, shows the focused Pane alone too, with the layout kept as it was.
- **A layout kept is taken back, or not at all.** `layoutFrom` refuses a tree that is not well formed or within the bounds.

## Search

The Owner's query read into the filters of `GET /api/search` by `parseQuery`, the search as a reducer over the pages it reads, and each result with its match marked. The Daemon reads no syntax from a query, so the words here are a Frontend's.

| Word | Searches |
| --- | --- |
| `text`, `"a phrase: with colons"` | The words that are not filters, as one run of text found anywhere in a Message |
| `from:<nick>` | Messages by that sender |
| `in:<#channel\|nick>` | One Timeline, by name |
| `network:<id>` | One Network |
| `since:<date>`, `until:<date>` | `YYYY-MM-DD`, a day in the Owner's time zone, or an ISO time with its zone |

- **A query never searches something other than what was typed.** A filter no word names, such as `http:` in a link, is refused, saying to quote it, as is anything else that cannot be read.
- **`in:` is found, never guessed.** A name found on several Networks, or several times on one, says so and does not choose.
- **The core reads no time zone.** The runtime's `dayStart` gives the instant a day begins, and a time with no zone is refused.
- **Pages fit together or the search begins again.** A page of another generation is ignored, and a merge, an overflow, or a reset begins it again from the first page. It reads pages of 100 and holds at most 500, then says to narrow the search.
- **A match is marked in the text shown, never by markup.** `matchRuns` gives plain text as runs, each a match or not, found as the Daemon folds text.

## Commands

The one registry of commands, `commands`, as data, behind the composer's `/commands`, the palette, the keymap, and, later, agents. `interpret` reads a line into intents in a `CommandContext`: what the focused Pane shows, whether its Network has a Session, and what is unread.

| For | Commands |
| --- | --- |
| Saying | `/say`, `/me`, `/msg`, `/notice`, `/query` |
| Acting | `/topic`, `/kick`, `/mode`, `/op`, `/deop`, `/voice`, `/devoice`, `/ban`, `/unban`, `/invite`, `/away`, `/back`, `/nick`, `/quote` |
| Lookups | `/whois`, `/whowas` |
| Configuration | `/set`, `/unset`, `/join`, `/part`, `/network add`, `/connect`, `/disconnect` |
| Themes | `/theme`, `/theme import`, `/theme remove` |
| Moving | `/next`, `/previous`, `/next-unread`, `/latest`, `/search`, `/palette`, `/focus` |
| Reading | `/read`, `/read all`, `/notify`, `/members` |
| Panes | `/split`, `/close`, `/pane`, `/swap`, `/equalize`, `/zoom`, `/grow`, `/shrink` |

Each entry in `src/commands.ts` carries its usage, aliases, and description, which the palette shows.

- **A line is read one way.** Plain text is `/say` to the open Timeline, `//text` says `/text`, and `/name args` runs the command named. An unknown command sends nothing.
- **Arguments are parsed into typed values,** or the command says why not, naming its usage. The text after a Target is kept exactly.
- **Each command says when it can run,** and an unmet condition says why in words: no Target in the Network's own Timeline, no Session, or one Pane with nothing to close.
- **Acting is parsed as the Client checks it.** What depends on the Network, such as which modes take a parameter, is read from `PREFIX`, `CHANMODES`, and `CHANTYPES` in the focused Channel's head. Before a head is read, a command that needs them says so and does not guess.
- **Configuration is changed by intents, never in place.** `/join`, `/part`, `/set`, and `/unset` name an edit, which the runtime applies to the Configuration in force then.
- **`/query` opens a Timeline by name and never makes one.** It folds the name by the casemapping `known` reports. When `known` cannot be read it opens nothing, since a guessed mapping could open another User's Direct Message.
- **A Credential's value never goes through the composer, nor any intent.** `/set <credential option>` alone opens a password prompt. A value typed after it, or a raw `PASS`, `AUTHENTICATE`, or `OPER`, is refused.
- **`/next-unread` goes to the Timeline that calls most,** as WeeChat's smart jump does: Highlights, then Direct Messages, then Messages. Activity alone is not enough.
- **A new command is one entry.** The palette and the keymap add no actions of their own.

## Keymap

Keybindings as data over the registry. A binding names a chord, a command, its arguments, and a `when`. `resolve` gives a pressed key's intents, or nothing, so a key no binding takes is never swallowed.

| Keys                              | Does                                     |
| --------------------------------- | ---------------------------------------- |
| `mod+k`, `mod+shift+p`            | Open the palette                         |
| `alt+arrowdown`, `alt+arrowup`    | Next and previous Timeline               |
| `alt+a`                           | The Timeline that calls most             |
| `alt+m`                           | Show or hide the members                 |
| `mod+,`                           | Show the options                         |
| `mod+shift+f`                     | Show the search                          |
| `i`                               | Focus the composer, from outside a field |
| `alt+shift+arrows`                | Move between Panes                       |
| `alt+shift+s`, `alt+shift+d`      | Split side by side, or down              |
| `alt+shift+w`, `z`, `e`, `g`, `r` | Close, zoom, equalize, grow, shrink      |

- **A chord is parsed.** `formatChord` writes one so that it parses back the same. A binding that does not parse, or names no command, is dropped, so a keymap holds only bindings that can fire.
- **`mod` is Cmd on a Mac and Ctrl elsewhere.** `showChord` writes a chord as the platform does.
- **A key event is the layout's character,** so an AZERTY `é` binds as `é`. The physical key names it only where the character says less, as with a dead key or Option on a Mac.
- **AltGr in a field is typing,** so German AltGr+Q types `@`.
- **The last binding that applies wins,** so overrides go after the defaults.
- **Most defaults fire while typing in a field,** as an IRC client keeps the caret in its input. None takes a key a browser uses.
- **The Panes' keys are Alt+Shift and a letter.** Option on a Mac types another character, which a letter's physical key names back and punctuation's does not.

## Palette

What the command palette lists for a query (`sections`), and what choosing an entry asks for (`choose`). It lists the commands that can run here, every Timeline, every theme, and every option read.

- **A query ranks entries in four tiers:** it begins a name, begins a word of a name, begins a word of the description, or its characters appear in a name in order. Matching is ASCII case-insensitive and reads no locale. It is a small scorer of its own because uFuzzy sorts with `Intl.Collator`.
- **With no query, recent choices come first,** at most 20.
- **Choosing a command that needs no arguments runs it.** One that needs them starts in the composer. A Timeline opens, an option starts `/set <name> `, and a Credential option opens the password prompt.
- **A choice never replaces a draft with text in it.** The draft is kept, and a notice says what was not put in.

## Composer

What the Owner is writing in each Timeline, what they sent from it, and why something was not said. `submit` reads the draft through the registry and gives intents. A composer is at a `Place`: a Timeline, a Direct Message not yet begun, or `Nowhere`, where commands that need no Timeline are typed.

- **Each Timeline has its own draft and its own history,** at most 100 lines, which Up and Down go through.
- **Submitting sends every non-empty line, in order, or nothing.** The first line that cannot be sent says why, with the text kept. More than 5 lines wait for the Owner to confirm, and what is confirmed is always exactly what is shown.
- **A Credential's value typed here is let go of at once.** It sends nothing, clears the draft, and enters no history.
- **A refusal is said in words under the composer it came from,** and nothing after it is sent.
- **What failed says what is safe to do next, and nothing is sent twice.** A Say or an Act that was not journaled may be sent again under the same intent. One that was journaled is never sent again. One with no answer can only be checked again.

## Options

Configuration as an option tree. Every option comes from the annotations on the Client's `NetworkConfiguration` Schema, walked once, so nothing lists them by hand and a new field is a new option.

An option is named `network.<id>.<path>`, such as `network.libera.nicks`, `network.libera.login.account`, or `network.libera.channels.#iirc.key`. Ids and Channel names may hold dots, so a name is an option only when exactly one way of splitting it is valid.

| Kind               | Text                                                         |
| ------------------ | ------------------------------------------------------------ |
| `Toggle`           | `on` or `off`                                                |
| `Text`             | The raw text, exactly                                        |
| `Choice`, `Tagged` | One of the Schema's literals or tags                         |
| `Texts`, `Names`   | A comma-separated list, with `\,`, `\\`, and `\ ` as escapes |
| `Ircds`            | A list of `host` or `host/port`, TLS unless `plain` follows  |
| `Credential`       | Never text: its Credential's name, and whether it is held    |

- **The syntax reads back what it shows,** for every value the Schema admits.
- **An edit is a pure function of the Configuration** (`apply`), parsed again by the Schema, so the runtime applies the same edit again after a conflict.
- **What a new Network starts with is the Schema's,** and `unset` returns an option to it.
- **A Credential option is write-only.** Its value is given in the password prompt, and the option only names the Credential, by a name derived from the option's own so that two options never share one.
- **Channels are compared as the Daemon reports the Network folds them,** so `/part` never parts more than one entry for a name.
- **A Channel's prefix is never guessed.** A bare name takes the Network's first `CHANTYPES` character, and is refused while `CHANTYPES` is unknown.

### The options under `ui`

An option under `ui` is named `ui.<option>`, such as `ui.time`, and is derived from `UiOptions` in `@iirc/api/ui` the same way.

- **Every device shares them, and one may override any for itself** with `-device`. `effectiveUi`, in `@iirc/frontend/ui`, gives the override, else the shared value, else the default.
- **Overrides are parsed option by option,** so one bad override kept on a device never loses the others.
- **`ui.activity` changes what is drawn, never what is counted.**

## Themes

Every colour a Frontend draws, derived from a terminal's palette of a foreground, a background, and 16 ANSI colours. `drawn` gives the colours and `cssVariables` their names.

- **No palette makes text unreadable.** A colour that falls below its floor on what it is drawn on is moved by the least change of lightness that reaches it, its hue kept. One that reads already is kept exactly.
- **The floor is WCAG 2's contrast ratio:** 4.5 for text, and 3 for dim text and the focus ring. APCA judges dark themes better, but it is still a draft and its licence restricts its use.
- **Nicks are spread over 16 slots drawn from the palette's own hues.**
- **mIRC's first 16 colours are the theme's ANSI colours, or mIRC's own,** as `ui.colours` says. Colours 16 to 98 are always mIRC's own.
- **Themes are built in or imported.** `system` draws `dark` or `light` as the device prefers. The built-in ones are in `src/builtin-themes.ts`, each with its source and licence. A name that names no theme draws as `system`.
- **A theme's name is one word,** such as `tokyo-night`. The names no import may take are the contract's, so the Daemon refuses them too.
- **Deterministic.** The same palette draws the same colours every time.

## Importing a theme

`importTheme` reads a terminal's theme file into a palette. Real files of each format are in `fixtures/themes`.

| Format           | Told by                                    |
| ---------------- | ------------------------------------------ |
| base16, base24   | YAML with `base00` and the like            |
| iTerm2           | Text that starts with `<`                  |
| Alacritty        | `colors` tables in TOML, or its older YAML |
| Kitty            | `key value` lines                          |
| Ghostty          | `key = value` lines                        |
| Windows Terminal | A JSON object                              |

- **The format is told from the text's own structure,** never a file's name.
- **What is missing or no colour is said by its path,** such as `palette.base0A is missing.`
- **Nothing is evaluated or followed.** A Kitty `include` and a Ghostty `config-file` are ignored. The plist is read by a small reader of the subset an `.itermcolors` file uses, which refuses a doctype that could declare entities.
- **Bounded.** Text longer than 256 KB is refused unread, as is a file of more than 4,096 settings. Our own readers are linear, but Effect's YAML parser is quadratic on some text, so the web frontend reads a theme in a Worker it ends after a second.

## Who is here

`@iirc/frontend/channel`: what each Pane's Timeline shows at its head, and its Channel's members, as a reducer over what the runtime read from `GET /api/timelines/{id}/channel` and `/members`. The Daemon answers with the Channel as the Client knows it now, so this holds the latest read and says when to read again.

- **The head is read for each Channel a Pane shows, and the members only while they show.**
- **What may have changed a Channel is read again, coalesced, never cancelled.** An Activity in it, a Gap, an overflow, or a reset leaves it dirty. `refreshDelay` spaces the reads: 250 ms after the first change, and no more than once a second while changes keep coming.
- **Members are read again from the start, as many as were held.** The Daemon orders them by rank, which any `MODE` can move, so patching the list would need to know what each Activity means for every member.
- **The header says what the head said.** A Channel's shows its topic, formatted, with who set it and when, its modes, and its count. Where Self stands otherwise is in words, such as kicked or joining.
- **A member shows their highest rank's symbol, from the Network's `PREFIX`.**

## Lookups

What `/whois` and `/whowas` ask, and a card for each Pane showing what came back.

- **A Lookup's nick is read as the Client reads one,** so `/whois #iirc` and `/whois *!*@host` say why in words and send nothing. `fixtures/nicks` holds both readings to the same cases.
- **One card a Pane.** A new Lookup replaces it, and an answer for a card no Pane holds changes nothing.
- **A card shows while its Pane has open the Timeline it was asked from,** and lives as long as its Pane.
- **What a Network wrote is contained and stays text,** in every field of a profile.
- **A Channel in a profile opens its Timeline, or starts `/join`,** once `known` said how the Network names Channels. Until then it is text.
- **Times are the caller's.** The core reads no clock or time zone, so the caller formats the sign-on instant, and one no calendar can hold is said to be unavailable.
- **What found no User is said in words,** naming the reply's numeric.

## Completion

Tab completion in the composer, as a reducer. It completes the word that ends at the caret, cycles through candidates, and gives back what was typed on Escape.

- **Tab is taken only when there is a word to complete,** so the composer is no keyboard trap.
- **What a word is completed from follows from where it is:** a command after `/` at the start of a line, an option after `/set `, a Channel's name after a `CHANTYPES` character, and otherwise a nick.
- **A Channel is told from a nick by the Network's `CHANTYPES`,** as its Session said them, never by a Timeline's name.
- **A nick is asked of the Daemon's members route, not guessed.** An answer is put in only if the composer still holds the exact text it was asked for.
- **Who spoke latest comes first,** and Self last.
- **A nick at the start of a line is followed by `: `,** and anything else by a space.
- **What is shown is announced** for a screen reader, such as `alex, 1 of 3`.

## Rendering

What an item shows, as data for a view to draw. `lineOf` gives a line and `formatted` the runs of a text. Nothing in it is markup.

- **Formatting is data.** mIRC bold, italic, colours, and the rest become styles on runs.
- **A link is one of `http`, `https`, `irc`, or `ircs`.** Anything else, `javascript:` and `data:` included, stays text.
- **Hostile text is contained.** Controls show as symbols, and every bidirectional embedding, override, or isolate a run opens is closed at its end. The work is linear in the text, however hostile.
- **Plain text is for where nothing is drawn,** such as a notification: stripped, cut to 200 characters, and isolated.
- **A nick's colour is a slot, not a colour:** a hash of the nick as RFC 1459 folds it, one of 16, which a theme gives its colour.
- **One of our Messages says its delivery only while it is sending, or if it was not sent or was refused,** with the Ircd's code. Nothing is said once the Ircd confirmed it, nor of `Unconfirmed`, which is all a Message ever becomes where the Ircd does not echo ours. A refused action is a calm line of its own, such as `Your topic change for #iirc was refused (482)`.
- **A failed Connection names its Ircd, and hints when TLS looks wrong.** `mismatchedTls` decides from the item's structure: a plaintext Connection to 6697 that opened and ended before registration, or a TLS handshake that failed on 6667. No text is parsed.
- **Activity is a few words, marked** `-->` for a join, `<--` for a part, a quit, or a kick, and `--` otherwise, as WeeChat marks it.

## Activity

What is new, from the counts the Daemon keeps, and when marking a Timeline read is due (`markDue`). It never counts items itself, since a window holds only some of them.

- **A level ranks what calls for the Owner:** Highlight, then Direct, then Message, then Activity. A Timeline's level is the highest with anything unread.
- **Activity is a dimmer name, never a number.** Counts and labels say what was said. The page's title counts only Highlights and Direct Messages.
- **A mark is due only for what the Owner can see:** a Pane that is shown, with the page visible and focused, at the latest, as the view said.
- **A mark is never back, and never past what was shown.** It goes up to the last item the view named, even when the Daemon holds a later one.

## Notifications

`notificationsOf` says which items a change added call for a notification, and what it says.

- **Only what calls for the Owner, and only once:** a Highlight or a Direct Message said live, not ours, after its Read Marker, in a Timeline the Owner is not looking at. A step given twice notifies once.
- **Its words are plain text,** by `plainText`: the Timeline and Network, then the sender and text. A newer one for a Timeline replaces the last.

## Not yet

- **One Timeline in two Panes,** at two places, as WeeChat and tmux allow. A Pane opens what no other Pane shows.
- **A layout kept under `ui`,** shared by every device. It is kept per device, and a phone's screen shows one Pane at a time whatever it holds.
- **More options under `ui`,** such as overrides of the keymap, and options of the Daemon's own. `keymapOf` is ready to read them, dropping what does not parse.
- **Chords in sequence,** such as `mod+k mod+o`. None of the defaults needs one, and `mod+k` alone opens the palette, so a sequence beginning with it would make the palette wait.
- **A divider for what came while the Owner was away from an open Timeline.** The divider is taken when a Timeline opens. One left open in a hidden page gathers unread items, which the counts show, but no divider until it is opened again.
- **Marking a detached Direct Message read.** No Target names it, so its counts stay until the API can mark a Timeline by its id.
- **Removing a Network,** which the API cannot do yet. `/network add` only adds.
