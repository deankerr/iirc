# @iirc/frontend

The pure core of the web frontend. It holds what a Frontend shows as plain data and reducers, and a view only renders it. It reads no clock, randomness, locale, or time zone, does no I/O, uses no Effect service, and knows nothing of React or the DOM.

## How every module is shaped

- **State is plain data.** Every state survives `structuredClone`, so it can be compared and kept.
- **A reducer takes events:** what the Owner did, what the runtime asked, and what the API answered. The runtime does all the I/O and decides all the timing.
- **The core says which reads to make.** Functions such as `wanted`, `channelReads`, and `searchWanted` give the requests to make now, and never one already in flight.
- **An answer is taken only by what asked for it.** One that lands after what it was for was replaced changes nothing.
- **Text is parsed, or refused in words.** Nothing here throws on what was typed, kept, or received.
- **A command never does anything.** It gives intents, plain data the runtime carries out.
- **What a Network wrote stays text.** Every string is for a text node, with controls shown as symbols and bidirectional formatting closed.

Each module below is imported as `@iirc/frontend/<module>`.

## Sign-in

A reducer over what the Frontend asked and what the API answered, which says whether the page is signed in. `explain` says a failure in words.

- **It holds no Key.** A Key goes from the Owner's form to the API in one request, and no state here has room for one.
- **Signed in only when the Daemon said so:** by an authorized read that was answered, or a sign-in that succeeded.
- **A read answered `Unauthorized` signs the page out.**
- **An answer that does not fit the state is ignored,** so requests that overlap cannot put it somewhere the Daemon never said.
- **A failure comes from the API's structure, never its text:** a wrong Key, a cross-origin request, a Sign-in the Daemon could not save, a Daemon that did not answer, or an answer that could not be read.

## Timelines

Everything the Frontend holds of the Timelines, as a reducer (`reduceTimelines`) over what it read from the API and what the changes stream said. It never folds News.

For each Network it holds its Timelines, its life, its connection, Self's nick, whether Self is away, and which Direct Message partners are on it, and for each Timeline a Pane has open, a window. `wanted` gives the reads to make, `followFrom` where to follow the stream from, `sidebar` the Networks as the Sidebar lists them, `treeOf` a Network as its own Timeline's row with the rest under it, `chosenOf` and `elsewhereOf` what the focused Pane and the others show, and `rowsOf` a window as rows.

### Reading and following

- **It reads everything, then follows.** The Network list and every Network's Timelines are read first. The stream is then followed after the smallest `through` among them, and the Network list is read once more, so a Network configured meanwhile is not missed.
- **A window is read only once the stream is followed.**
- **An answer is current only if nothing that invalidates it happened after its read began:** a reset, an overflow that touched what it is of, or more than 5000 changes while it was in flight, which the stream no longer remembers. An answer that is not current is asked for again.
- **No change is lost or applied twice.** A Timeline is kept by its id and an item by its position, so a change given again changes nothing. A read that lands after the stream passed it is brought up to date from what the stream gave.
- **What is held of a Network is of one life,** named by the sequence of the `Configured` that began it. Whatever names a life, the Network list, a page of its Timelines, its Session, the changes, or a removal's answer, changes nothing when it names an older life, applies when it names the same, and replaces what is held when it names a newer one, which is then read.
- **A removal applies only to the life it names.** A life over with its Timelines dropped never comes back, and a life once kept stays kept.
- **A Session item of an older life's Timeline says nothing of the connection.**
- **`UnknownNetwork` names no life, so it lets nothing go.** The Network list is read again, and a Network it does not name, whose life began before it was asked, is over.
- **An overflow reads again what it touched, and a reset reads everything again.** A merged Timeline resolves to the one it went to.
- **A Network's connection, Self's away, Self's nick, and which partners are on it are derived, never polled.** They come from `known`, and then from the Session items the changes carry.
- **Self's nick is the latest of `known`'s, a `SessionBegan`'s, or a change of nick in the Network's own Timeline.** It is kept when the Session ends, so history read while offline still says which items are Self's.
- **`known` is read again** when Self's away changes, when a partner comes, goes, quits, or changes nick in their Direct Message Timeline, when one is opened, and after a `SessionBegan`.
- **A partner shows as there or gone only while connected,** as `known` says, and as neither otherwise.
- **`carriesTags` is true only once `known` says the Session carries tags.**
- **A closed Timeline is left out of `sidebar` while no Pane has it open.** The Daemon says whether it is closed, and it comes back by itself once something arrives in it. `sidebar` gives it apart, as `closed`, for `/go`, and with the rest while a Pane has it open.
- **Moving to the next Timeline, the one that calls most, and the page's title count only what the Sidebar lists.**
- **A removed Network is derived.** The Network list names one removed with its Timelines kept as `Kept`, its Timelines are flagged `removed`, and `isRemoved` reads both.
- **A removed Network's Timelines are read and searched as any other,** but its Session is never read, nothing is said or done there, and `sidebar` lists it after the rest.
- **A dropped Timeline is let go of at once,** when the changes name it, or name its Network as removed without keeping its Timelines. Its window and its place among the closed go, a Pane that showed it shows nothing, and the search begins again.
- **`NetworkRemoved`, the Daemon's answer to a removal, applies ahead of the stream,** for the life it ended.

### Windows

- **A window holds at most `windowCap` items, 1000.** `earlier` and `later` are true exactly when something lies beyond, so everything dropped can be read again.
- **Only the windows of Timelines open in a Pane, and of the `keptClosed` closed most recently, 4, are kept.** Any other is read again when opened.
- **A new item lands only where it belongs by position:** in place of the item it updates, between the items held, or past the end when nothing more lies beyond.
- **A Gap that changes history under a window has it read again.**
- **Only the view says what the Owner has seen.** A window's `seen` is the last item the view's `Following` event said is in view, so opening a Timeline never makes the core believe anything in it was read.
- **The "new" divider stays where it was when the Timeline opened,** and does not jump as the Read Marker moves.
- **Failed Connections in a row are one row,** counted, when they are to the same Ircd for the same reason.
- **Joins, parts, quits, and changes of nick in a row are one row,** derived as a window is read. Its `key` is the first item's, so it stays as the run grows. A Message, any other Activity, a Kick, a Gap, a Day, or the "new" divider ends a run, and an item a view hides ends nothing.
- **`churnLine` says a run in words:** how many joined, left, quit, and changed nick, then who, up to five, and how many more.
- **Self's own joins, parts, quits, and changes of nick are never folded,** and split a run in two. `rowsOf` is given Self's nick now, from `selfOf`, and works back through Self's changes of nick in the window. With no nick known, none is folded.
- **A change of Self's nick the window does not hold leaves Self's older nick unknown,** so Self's lines under it may fold or be hidden.
- **A Day stands before each item drawn on a different day from the one drawn before it, and before the first drawn.** A day begins at midnight in the offset from UTC that `rowsOf` is given, an item it cannot place starts no day, and with no offset there are no Days.
- **A Message continues a run** when it is plain speech from the User of the row drawn just before it, by the nick as its colour folds it, no more than five minutes after it by the items' own times, with the same `bot` and `prefix`. Anything drawn between ends a run, an action or a notice is in none, an item a view hides ends nothing, and the first row continues nothing.
- **A Gap before anything is no row.** A Gap that ended, with no item before it, in a window that holds the Timeline's start, is left out of the rows. A Gap still open, or one before the first item of a window with older items beyond it, is a row. Items a view hides still count as before a Gap.

### What a Pane shows

- **A Timeline is open in one Pane at most.** Opening one that another Pane has open focuses that Pane.
- **A Pane shows its Timeline, or something in front of it:** the options, the Uploads, the search, or a Direct Message not yet begun. Closing it shows the one step back it remembers.
- **The options, the Uploads, and the search each show in one Pane at most.**
- **A Pane with nothing open shows the Tail.** `chosenOf` and `elsewhereOf` name it `Tail`, and `paneName` says `iirc`. Any number of Panes may show it, and it has no step back.
- **`TailShown` shows the Tail in the focused Pane** by letting go of what it showed, which joins the Timelines closed most recently.
- **A Direct Message not yet begun is a view, not a Timeline,** since the API makes a Timeline only when something is said. Its draft shows the Timeline as soon as one is listed, matched by the casemapping read when the draft was made.
- **A Message said with `opens`, as `/msg` says one, opens the Timeline the Daemon placed it in,** by its id, only in the Pane it was said from, and only while the Owner has not moved on.
- **A jump from the search opens a window read around a position,** which is not at the latest until the Owner moves there, so under `ui.unread.markRead latest` nothing is marked read until then.
- **`/date` jumps to an instant.** It takes a moment as `since:` does, reads the window around the earliest position at that instant (`firstAt`), and lands on the first item at or after it, or the last when none is.
- **A Day row offers `/date` with its day.**
- **`/export [since] [until]` saves the open Timeline as text.** `since` takes a day from its beginning, `until` takes the whole day it names, and a time with its zone is exact (`boundMoment`). The runtime places a day in the Owner's time zone.
- **An `/export` range of two days or two instants out of order is refused in words** (`startsBefore`). A day against an instant depends on the zone, so the runtime decides it, and exports nothing for a range that holds nothing.
- **The layout is kept per device, as JSON, and taken back once the Timelines are read.** `layoutKeptText` bounds the text before it is parsed, and never throws. A Pane whose Timeline is gone is dropped, and a Pane showing the Uploads comes back showing them.

## Arranging the Sidebar

`@iirc/frontend/arrangement` puts the Owner's order on what `sidebar` gives, from three `ui` options every device shares, `sidebar.networks`, `sidebar.order`, and `sidebar.pinned`, which `arrangementOf` reads.

- **With none set, `arranged` gives exactly the order `sidebar` gives.**
- **One rule places everything.** The items a list names come in its order, and one it does not name goes right after the one before it in the fixed order, or first when none comes before it. It orders the Networks, a Network's Timelines, and the pins alike, and an id that names nothing held is ignored.
- **The Networks not removed come first, then those removed,** each group in the Owner's order. A Network's own Timeline stays first, as its row.
- **A pinned Timeline leaves its Network for the pinned part above them,** in the order pinned. Only a Timeline the Sidebar lists can be pinned, never a Network's own.
- **`shownOrder` is what `/next` and `/previous` step through:** the pinned, then each Network's Timelines. `/next-unread` breaks a tie in the same order.
- **`arranging` says what to write for one edit, from what is shown now:** the option and its whole new value, or nothing when nothing would change.
- **`Move` and `Place` move a Timeline within its part:** a pinned one among the pinned, a Network's own Timeline among the Networks as removed as it is, and any other among its Network's Timelines that are not pinned. None wraps at an edge, and a `Place` onto another part or Network changes nothing.
- **What is written keeps the place of every other Network's Timelines and of those closed,** and, once every Network's Timelines are read, leaves out an id that has gone.
- **A `Pin` pins, unpins, or, saying neither, does whichever the Timeline is not now,** and refuses a Network's own Timeline.
- **`/move up|down` and `/pin` give an `Arrange` intent.** `/pin` says neither, so whether it pins is decided from the options read when it is carried out.

## Panes

`@iirc/frontend/layout`: the Panes as a split tree in a pure reducer, `reduceLayout`. It knows nothing of what a Pane shows, nor of the screen. A view renders the tree and sends back the ratios the Owner dragged.

- **A layout is well formed, whatever is done to it.** Every Split has two or more children, none a Split along its own axis, with positive ratios that sum to 1, and the focus is always on a Pane.
- **Ids come from a counter, never randomness.**
- **A layout is bounded:** at most 64 Panes, and Splits at most 16 deep. A change past a bound changes nothing.
- **No split, drag, grow, or shrink leaves a Pane below 1% of its Split** (`leastShare`). A share that joining a Split into its parent leaves below it stays.
- **A split halves the focused Pane** and focuses the new one.
- **A close gives the place to the sibling, and the last Pane never closes.**
- **The focus moves to the Pane across the focused Pane's edge,** as the screen lies, with no wrapping.
- **A swap moves the focused Pane whole,** its id and view with it, so its content is not drawn afresh.
- **A zoom shows the focused Pane alone and toggles back to the very layout it was.**
- **A compact screen shows the focused Pane alone,** with the layout kept as it was.
- **A layout kept is taken back whole, or not at all.** `layoutFrom` refuses a bad or repeated id, a view it cannot read, and a tree past the bounds. It repairs the rest: a Split with one child is that child, ratios are scaled to sum to 1, and an unknown focus falls back to the first Pane.

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
- **`in:` is found, never guessed.** It looks on the `network:` named, else the focused Pane's Network, else every Network, and a name found several times says so and does not choose.
- **A day is placed by the runtime's `dayStart`,** and a time with no zone is refused.
- **Pages fit together or the search begins again.** A page of another generation is ignored, and a merge, an overflow, or a reset begins it again from the first page.
- **It reads pages of 100 and holds at most 500,** then says to narrow the search.
- **A match is marked in the text shown, never by markup.** `matchRuns` gives plain text as runs, each a match or not, found as the Daemon folds text.

## Commands

The one registry of commands, `commands`, as data, behind the Composer's `/commands` and the keymap. `interpret` reads a line into intents in a `CommandContext`.

| For | Commands |
| --- | --- |
| Saying | `/say`, `/me`, `/msg`, `/notice`, `/query` |
| Acting | `/topic`, `/kick`, `/mode`, `/op`, `/deop`, `/voice`, `/devoice`, `/ban`, `/unban`, `/invite`, `/ctcp`, `/ping`, `/away`, `/back`, `/nick`, `/setname`, `/quote` |
| Lookups | `/whois`, `/whowas`, `/names`, `/who`, `/list`, `/bans`, `/exceptions`, `/invexes` |
| Configuration | `/set`, `/unset`, `/join`, `/part`, `/ignore`, `/unignore`, `/network add`, `/network remove`, `/connect`, `/disconnect` |
| Themes | `/theme`, `/theme -light`, `/theme -dark`, `/theme import`, `/theme remove` |
| Aliases | `/alias`, `/alias add`, `/alias remove` |
| Moving | `/go`, `/next`, `/previous`, `/next-unread`, `/latest`, `/date`, `/search`, `/uploads`, `/tail`, `/focus` |
| Arranging | `/move`, `/pin`, `/mute`, `/unmute` |
| Reading | `/read`, `/read all`, `/close-timeline`, `/export`, `/previews`, `/notify`, `/members`, `/sidebar` |
| Panes | `/split`, `/close`, `/pane`, `/swap`, `/equalize`, `/zoom`, `/grow`, `/shrink` |
| Formatting | `/bold`, `/italic`, `/underline`, `/monospace`, `/reverse`, `/strikethrough`, `/colour` |

Each entry in `src/commands.ts` carries its usage, aliases, and description, which the Composer's list shows.

- **A line is read one way.** Plain text is `/say` to the open Timeline, `//text` says `/text`, and `/name args` runs the command named. An unknown command sends nothing.
- **Arguments are parsed into typed values,** or the command says why not, naming its usage. The text after a Target is kept exactly.
- **Each command says when it can run,** and an unmet condition says why in words: no Timeline open, no Channel open, no Target, no Session or not knowing yet whether there is one, a removed Network, a list the Network keeps none of by its ISUPPORT, or one Pane with nothing to close.
- **What depends on the Network is read from the focused Channel's head,** its `PREFIX`, `CHANMODES`, and `CHANTYPES`, as the Client checks it. Before a head is read, a command that needs them says so and does not guess.
- **Configuration is changed by intents, never in place.** `/join`, `/part`, `/ignore`, `/unignore`, `/set`, and `/unset` name an edit, which the runtime applies to the Configuration in force then.
- **`/ban -a <nick>` bans a User by their account,** one `BanAccount` in the Channel in focus, where its head gives `accountBan`. It takes exactly one nick, and refuses in words where the head is unread, the Network has no ban list, or the list names no account.
- **Which account a nick has is the Client's to say,** and it refuses the act when it is not known or there is none.
- **`/ignore` and `/unignore` take a nick or a mask.** A bare nick means `nick!*@*`, a mask that does not parse is refused saying why, and masks are compared under the Network's casemapping.
- **`/ignore` alone opens the options on the Network's `ignores`.**
- **`/query` opens a Timeline by name and never makes one.** `queried` finds it by the casemapping `known` reports, and with none shows a Direct Message not yet begun.
- **`/close-timeline [#channel|nick]` closes a Timeline by its Target,** the focused one unless named, never a Network's own, and never a Pane. Whether Self is in a Channel is the Daemon's to answer.
- **`/network remove` only asks.** It names the Network, the focused one unless an id is given, and `keep` or `drop` to start on. A lone `keep` or `drop` is the choice about the focused Network, so a Network of that id is named with both words, as `/network remove keep keep`. Nothing is removed until the Owner confirms.
- **A Credential's value never goes through the Composer, nor any intent.** `/set <credential option>` alone opens a password prompt. A value typed after it, a raw `PASS`, `AUTHENTICATE`, or `OPER`, and `/oper` are refused, `/oper` naming the `oper` options to set instead.
- **`/go [network] <name>` opens a Timeline by name, closed ones too.** A name alone finds it on the Composer's Network first, else on the one Network that has it. A name no Timeline has, or one on several Networks with none of them the Composer's, is refused, naming the Networks.
- **Of two Timelines that share a name on one Network, `/go` takes the first.**
- **`/next-unread` goes to the Timeline that calls most:** Highlights, then Direct Messages, then Messages. Activity alone is not enough.
- **An alias is the Owner's own name for one command line.** `/alias add <name> <line>` makes or replaces one, `/alias remove <name>` takes one away, and `/alias` alone starts `/alias ` with them listed. They are `ui.aliases`, shared by every device.
- **An alias's line is one built-in command,** so an alias never stands for another alias, nor for `//`.
- **A built-in command always wins.** A name a built-in command takes, by its name or a fixed alias, is refused, and an alias that got there anyway never runs and is never listed.
- **An alias expands in one pass, exactly.** `$1` to `$9` are the words typed after it, `$*` is all of it with its spacing, `$$` is one `$`, and a `$` before anything else is itself. A line that names none of `$1` to `$9` or `$*` has what is typed appended after a space.
- **An alias refuses too few words for its highest `$n`, or more than it names without a `$*`,** saying how many the line takes. What an argument brings in is never expanded again.
- **An expanded line runs as a built-in command, under its own conditions,** and is judged for a Credential as it expands, so `/p PASS x`, with `p` for `/quote $*`, is refused and cleared as `/quote PASS x` is. So is `/alias add` of a line that would be.
- **A new command is one entry.** The Composer's list and the keymap add no actions of their own.
- **`/focus [text]` focuses the Composer, and with text starts a command in it** (`StartCommand`), with the draft set aside and the list open. `/theme`, `/theme -light`, and `/theme -dark` alone start themselves so, so the themes are listed where they are chosen.

## Keymap

Keybindings as data over the registry. A binding names a chord, a command, its arguments, and a `when`. `resolve` gives a pressed key's intents, or nothing, so a key no binding takes is never swallowed.

| Keys                                   | Does                                             |
| -------------------------------------- | ------------------------------------------------ |
| `mod+shift+p`                          | Start `/` in the Composer                        |
| `mod+k`                                | Start `/go ` in the Composer                     |
| `alt+arrowdown`, `alt+arrowup`         | Next and previous Timeline                       |
| `mod+alt+arrowdown`, `mod+alt+arrowup` | Move the open Timeline down or up in the Sidebar |
| `alt+a`                                | The Timeline that calls most                     |
| `alt+m`                                | Show or hide the members                         |
| `alt+n`                                | Show or hide the Sidebar                         |
| `alt+o`                                | Show the options                                 |
| `mod+shift+f`                          | Show the search                                  |
| `alt+shift+arrows`                     | Move between Panes                               |
| `alt+shift+s`, `alt+shift+d`           | Split side by side, or down                      |
| `alt+shift+w`, `z`, `e`, `g`, `r`      | Close, zoom, equalize, grow, shrink              |
| `mod+b`, `i`, `u`, `e`, `r`            | Bold, italic, underline, fixed pitch, reverse    |
| `mod+shift+x`                          | Strikethrough                                    |
| `mod+shift+k`                          | Choose a colour                                  |

- **A chord is parsed.** `formatChord` writes one so that it parses back the same. A binding that does not parse, or names no command, is dropped, so a keymap holds only bindings that can fire.
- **`mod` is Cmd on a Mac and Ctrl elsewhere.** `showChord` writes a chord as the platform does.
- **A key event is the layout's character,** so an AZERTY `é` binds as `é`. The physical key names it only where the character says less, as with a dead key or Option on a Mac.
- **AltGr in a field is typing,** so German AltGr+Q types `@`.
- **The last binding that applies wins,** so overrides go after the defaults.
- **Most defaults fire while typing in a field.** The formatting keys fire only in the Composer, so Mod+R reloads the page anywhere else. No two defaults share a chord where both can fire.
- **A key that types goes to the Composer, unless it is bound** (`typesInComposer`). A printable character, a dead key, the start of an input method's composition, a character AltGr or Option types, and the platform's paste chord type. Space, Enter, and any other key with Ctrl, Meta, or Alt held do not.
- **A key pressed in a field that takes text, with an overlay holding the focus, or with no Composer to write to, is left alone.**
- **Enter in the Composer is not a binding, but `ui.composer.enter`** (`enterPressed`). Under `send`, Enter sends and Shift+Enter begins a line. Under `newline`, Enter or Shift+Enter begins a line and Mod+Enter sends. `sendChord` and `newLineChord` give the chords to show.
- **A key bound to a command that requires arguments, with none given, starts it** in the Composer, and `chordsFor` lists the key beside the command.
- **`mod+k` and `mod+shift+p` have no `when`,** so they work from anywhere, with the Composer's list open or not, and in a Pane with no Timeline.
- **The `palette` context key means that the Composer's list is open.** No default binding consults it.

## Entries

What the Composer's list ranks (`@iirc/frontend/entries`): a command, a Timeline, a Network to remove or to drop the Timelines of, a theme, a font, and an alias, each an `Entry` with a key it is remembered by. Picking one only writes the draft, and sending it gives what the command would.

- **A query ranks entries in four tiers:** it begins a name, begins a word of a name, begins a word of the description, or its characters appear in a name in order. Matching is ASCII case-insensitive and reads no locale.
- **With no query, the commands run recently come first,** at most 20, newest first (`remember`, with the keys a submit gives as `ran`).
- **A family typed after `font`, such as `font Fira Code`, is listed among the fonts** when it names a family and no bundled font (`familyNamed`).

## Composer

What the Owner is writing in each Timeline, what they sent from it, and why something was not said. `submit` reads the draft through the registry and gives intents. A Composer is at a `Place`: a Timeline, a Direct Message not yet begun, or `Nowhere`, where commands that need no Timeline are typed.

- **Each Timeline has its own draft and its own history,** at most 100 lines, which Up and Down go through.
- **A draft's text is what is sent,** IRC's formatting codes and all, and is what history keeps and recalls. The Owner edits its plain text, and `Edited` merges an edit into the formatting.
- **`Formatted` puts a format over a range,** or, with nothing selected, keeps it pending at the caret until the text changes.
- **Submitting sends every non-empty line, in order, or nothing.** The first line that cannot be sent says why, with the text kept.
- **More than 5 lines wait for the Owner to confirm,** and what is confirmed is exactly what is shown.
- **What was sent says which commands it ran,** as `ran`, so the Composer's list puts them first.
- **A command started over a draft sets the draft aside** (`commandStarted`), blank or not, with its codes and what it answers. It comes back when a submit carries something out, on `Restored`, which is Escape, and when the command is edited down to nothing. A refused submit keeps both.
- **A draft set aside is never sent, never lost, and never enters the history.** Over a command already started, the draft set aside stays the one.
- **A Credential's value typed here is let go of at once.** It sends nothing, clears the draft, and enters no history.
- **A draft can answer one Message,** which `replyOf` offers only for a Message with an id, on a Network whose Session carries tags. The draft holds it through edits and turning away until it is dropped or sent.
- **Only the first Say to its Timeline answers it,** so a reply of several lines is tagged on its first.
- **A refusal is said in words under the Composer it came from,** and nothing after it is sent.
- **A notice about the text as typed,** such as no such command, goes when the text is edited and when the Composer turns to another Timeline.
- **A notice with an offer stays with its Timeline** until it is taken, dismissed, or replaced by another notice.
- **A notice of an outcome that arrived later stays until dismissed or the next submit.**
- **What failed says what is safe to do next, and nothing is sent twice.** A Say or an Act that was not journaled may be sent again under the same intent, one that was is never sent again, and one with no answer can only be checked again.

## Formatting

A draft's formatting, between its text with codes and the plain text the Owner edits. `merged` takes an edit of the plain text back into the codes, `formattedIn` puts a format over a range, `pendingAfter` keeps one at a caret, `linesIn` gives the lines to draw, and `runsIn` each line's runs.

- **Formatting is per line.** A style over a line break is written again at the start of the next line.
- **No code stands where nothing follows it,** however the text is edited.
- **Typed text takes the style around it:** the style pending there, else the style of what it was typed over, else of the character before it, or after it at the start of a line.
- **A paste's codes are read as formatting.**
- **A run of a draft holds its characters as written,** a tab or a control among them, never shown as a symbol as a Network's text is.
- **Where the text alone could place an edit in several ways,** as a letter typed beside the same letter, the caret places it.
- **A flag goes off where the whole range has it, and on otherwise.**
- **A colour is chosen from the sixteen, `colourNames`, or the default** (`colourChoices`).

## Options

Configuration as an option tree. Every option comes from the annotations on the Client's `NetworkConfiguration` Schema, so a new field is a new option.

An option is named `network.<id>.<path>`, such as `network.libera.nicks`, `network.libera.login.account`, or `network.libera.channels.#iirc.key`. Ids and Channel names may hold dots, so a name is an option only when exactly one way of splitting it is valid.

| Kind               | Text                                                          |
| ------------------ | ------------------------------------------------------------- |
| `Toggle`           | `on` or `off`, or `true` or `false`                           |
| `Text`             | The raw text, exactly                                         |
| `Choice`, `Tagged` | One of the Schema's literals or tags                          |
| `ChoiceOrText`     | One of the Schema's literals, else the text, trimmed          |
| `Integer`          | A whole number within the Schema's bounds                     |
| `IntegerOrChoice`  | One of the Schema's literals, else a whole number as above    |
| `Decimal`          | A number within the Schema's bounds, a multiple of its step   |
| `Texts`, `Names`   | A comma-separated list, with `\,`, `\\`, and `\ ` as escapes  |
| `Ircds`            | A list of `host` or `host/port`, TLS unless `plain` follows   |
| `Credential`       | Never text: its Credential's name, and whether it is held     |
| `ChoiceByKey`      | `key=choice`, comma-separated, a choice by its first word too |

- **The syntax reads back what it shows,** for every value the Schema admits.
- **`partsOf` gives a list's text element by element,** so a view wraps a line between elements and never inside one.
- **An option whose kind lists its choices is chosen from a menu** (`menuOf`), which for a `ChoiceOrText` or an `IntegerOrChoice` ends in "Custom…". It marks the choice in force, or "Custom…" for a value that is none of them.
- **An edit is a pure function of the Configuration** (`apply`), parsed again by the Schema, so the runtime applies the same edit again after a conflict.
- **A change asked for shows at once, until it is answered,** however it came out. `uiShown`, `ownerShown`, and `configurationShown` derive what shows from what is in force and what is on its way.
- **Nothing is applied before what is in force is read.**
- **`grouped` heads the options by root:** `ui`, each Network read, and each of the Daemon's own roots, in the order of their names. A heading the filter leaves nothing under is left out, and `listed` gives the options in the same order.
- **What is still being read is a value of its own, never a default.** An option under the Daemon's own roots is `Reading` until they are read, a Credential's `held` is unknown until the names held are read and `NotKnown` when that read fails, and `networksReading` names the Networks not yet read.
- **A new Network starts with the Schema's defaults,** and `unset` returns an option to its default.
- **A field the members of a union share is one option,** such as `login.account`, set in the member in force when it has the field, and otherwise in the first that does, which it puts in force.
- **A Credential option is write-only.** Its value is given in the password prompt, and the option names the Credential by a name derived from its own, so two options never share one.
- **Channels are compared as the Daemon reports the Network folds them,** so `/part` never parts more than one entry for a name.
- **A Channel's prefix is never guessed.** A bare name takes the Network's first `CHANTYPES` character, and is refused while `CHANTYPES` is unknown.

### The options under `ui`

An option under `ui` is named `ui.<option>`, such as `ui.timeline.timeFormat`, and is derived from `UiOptions` in `@iirc/api/ui`.

- **Every device shares them, and one may override any for itself with `-device`,** but those the contract marks shared only, such as `ui.previews`, `ui.unread.muted`, and `ui.sidebar.order`, which `-device` refuses. An override a device kept of one of those is dropped.
- **`effectiveUi` gives the override, else the shared value, else the default.**
- **A change is written for this device when it overrides the option, and for a font's family always** (`writtenOnDevice`), for the options view and `/set` alike.
- **Overrides are parsed option by option,** so one bad override kept on a device never loses the others.
- **`ui.timeline.activity` changes what is drawn, never what is counted.** `showsIn` works out which items a Channel's Timeline draws, and any other Timeline draws every item. Its values hide more one after the other: `all`, `spoke`, `quiet`, `none`.
- **`spoke` hides the joins, parts, and quits of a User who said no Message in the window in the five minutes before,** by the items' own times, following the User across a change of nick. Only the window's Messages count.
- **Self's joins, parts, and quits always show,** as far as `rowsOf` knows Self, and every one shows while Self's nick is unknown.
- **A font's family the device lacks is said to be not found** when it is the one in effect. The device hands the families it lacks to `uiOptionsOf`.

### The options under `away`, `store`, `uploads`, and `previews`

An option under `away`, `store`, `uploads`, or `previews` is named in full, such as `store.s3.bucket` or `uploads.maxSize`, and is derived from `OwnerOptions` in `@iirc/api/options`.

- **They are the Owner's, not a device's,** so `-device` refuses them. A change is made from the options read, and `unset` returns one to its default, or leaves it unset.
- **A Credential option names `Owner.` and the option's name until it names another,** such as `Owner.store.s3.accessKeyId`. No Network's Credential is ever named so.

## Uploads

The Uploads view's list, newest first, live ones only unless the deleted are shown, as a reducer (`reduceUploads`) over the pages read and the Changes streamed. `through` is the sequence of the last Change folded in, which the stream is followed after.

- **A page only extends the list at its end.** It is folded only when read from where the list stands, so one read twice is folded once. The first page sets `through`.
- **The stream gives only what is newer.** A Change after `through` moves it on, and one no later than `through`, or before the first page, is passed over, so an Upload is never held twice.
- **A Change to an Upload held replaces it in place, or drops it once deleted.**
- **A Change to an Upload not held puts it first,** unless it is deleted, or older than the oldest held while more pages follow. Those are kept aside, so a page that lands later takes the Upload as the Change left it, and a delete is never undone by a slow page.
- **Deleted Uploads are held only while `showDeleted` is on** (`DeletedShown`, off to start). Switching starts the list over, to be read again with them or without. `deletedText` says a deletion in a word, `expired` or `deleted`.
- **Which Uploads are missing is the stream's last word** (`Missing`), which replaces the set held whole. Switching the deleted or signing out empties it, and a row's mark is derived from this set alone, never from an Upload's own `missing`.
- **The Daemon's answer to a rename or a delete is folded at once** (`Answered`), into an Upload held only, and moves nothing on.
- **Where an Upload was said is read again when it may have changed.** `saidIn` gives the Uploads held whose `/<id>/` a Message of ours in a Timeline change holds, for the runtime to read again. The answer replaces only where it was said (`Said`), so a late read never undoes a Change.
- **`saidPlace` says where an Upload was said,** as its Network and Target.
- **What the Owner asked of each is beside them** (`reduceUploadEdits`): the Upload a delete is being confirmed for, and each rename or delete waiting on the Daemon or failed. `nameOf` reads a typed name as the contract takes one, and `editFailureText` says a failure in words.
- **What is shown is derived, never held.** `linkOf` makes `<publicUrl>/<id>/<safeName>`, or none without a public URL, `thumbnailed` says whether a type is an image every browser draws, `sizeText` gives a size in binary units, such as `1.2 MiB`, and `shownName` the name given, else the safe name.

## The Tail

The Tail as a Frontend holds it, as a reducer (`reduceTail`): read whole, then each line the stream gave, of one Daemon.

- **A line is taken once.** One numbered at or before the last held changes nothing. `lastNumber` says where to follow from.
- **At most `tailCap` lines are held, 4096,** and one more lets go of the oldest.
- **A stream of another Daemon lets go of the Tail held.** `Opened` with another `started` is a Daemon that restarted, and nothing is held until the Tail is read again.
- **`linesShown` gives the lines at a least level and above,** oldest first, and `atLeast` compares two levels. `leastShown` gives the level each value of `ui.tail` names: `debug` Debug, `info` Info, `warning` Warn, and `error` Error, under which Fatal shows too.

## Uploading

The files added to a Composer, as a reducer (`reduceUploading`) over what the runtime found out, each named by a key the runtime makes.

- **A file's link goes where the caret was when it was added.** It is pending from that moment, before the Daemon is asked whether Uploads are on, so its order and its anchor are fixed then.
- **Its anchor follows the draft as it changes** (`followed`): an edit wholly after it leaves it, one wholly before moves it, one across it puts it at the end of what replaced it, and text typed exactly at it goes after it, so a caption typed after a pasted screenshot follows its link.
- **An edit is placed by the selection just before it and the caret just after** (`editOf`), however the text repeats. The texts alone are compared only without them, as for an undo.
- **A draft carried to its Timeline takes its files with it.**
- **A link is a word of its own.** `insertLink` adds a space on whichever side touches anything but whitespace, and `caretAfter` moves a caret at or after it past it.
- **Files added at one caret land in the order added,** whatever order they finish in.
- **Whether Uploads are on is the Daemon's answer when the files were added, never kept.** Files are checking until it answers. While Uploads are off, those files are let go of, and `offNote` names the options to set.
- **A file over `maxSize` is refused before it is sent.**
- **A link of `null`, with no public URL, puts nothing in,** and is noted as Uploads off are.
- **A draft waits for its links.** While a file added to it is checking or being sent, `heldBack` says to wait for it or cancel it, and nothing is sent. A failed file holds nothing back.
- **The note on a send held back names only the files still pending** (`heldNoteIn`), and goes with the last of them.
- **A draft set aside by a command owns its files** (`filesTextOf`). The command is held back for none of them, and a link that finishes goes into the draft, never the command.
- **An edit that leaves the command empty puts it away,** as Escape does.
- **A file kept stays listed until its draft is sent** (`Sent`), or it is dismissed, holding nothing back.
- **A renamed file's new link replaces the old in the draft** (`renamed`), wherever the old now stands, and every anchor and caret after it moves by the change in length (`relinkedAt`). Where the Owner edited it away, nothing is replaced.
- **Every failure is said in words** by `failureText`, from the API's typed errors. A check with no answer says the file was not sent, and a send with no answer says whether it was kept is unknown.

## Themes

Every colour a Frontend draws, derived from a terminal's palette of a foreground, a background, and 16 ANSI colours. `drawn` gives the colours and `cssVariables` their names.

- **No palette makes text unreadable.** A colour below its floor on what it is drawn on is moved by the least change of lightness that reaches it, its hue kept, or is white or black when none does. One that reads already is kept exactly.
- **The floor is WCAG 2's contrast ratio:** 4.5 for text, and 3 for dim text and the focus ring.
- **Nicks are spread over 16 slots,** drawn from the palette's own hues, or from six fixed hues when it has fewer than three of its own.
- **mIRC's first 16 colours are the theme's ANSI colours, or mIRC's own,** as `ui.timeline.colours` says. Colours 16 to 98 are always mIRC's own.
- **Themes are built in or imported.** The built-in ones are in `src/builtin-themes.ts`, each with its source and licence. A name that names no theme draws as `system`.
- **`system` draws `ui.theme.light` or `ui.theme.dark` as the device prefers.** Each is the built-in one of its name until `/theme -light` or `/theme -dark` sets it to any theme but `system`, and draws the built-in one again when it names no theme.
- **A theme named in `ui.theme` wins over both.**
- **A theme's name is one word,** such as `tokyo-night`. The names no import may take are the contract's.
- **The same palette draws the same colours every time.**

## Importing a theme

`importTheme` reads a terminal's theme file into a palette. Real files of the formats are in `fixtures/themes`.

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
- **Nothing is evaluated or followed.** A Kitty `include` and a Ghostty `config-file` are ignored, and the plist reader refuses a doctype that could declare entities.
- **Text longer than `importLimit`, 256 × 1024 characters, is refused unread.**
- **A Kitty or Ghostty file of more than 4,096 settings, or a plist of more than 4,096 values, is refused** (`entryLimit`).

## Who is here

`@iirc/frontend/channel`: what each Pane's Timeline shows at its head, and its Channel's members, as a reducer over what the runtime read from `GET /api/timelines/{id}/channel` and `/members`.

- **The head is held for each Channel the Sidebar lists or a Pane shows,** so one opens with it already read. `heldChannels` lists them, the shown first.
- **The members are read only while they show,** and let go of once no Pane shows the Channel.
- **A removed Network's Channel is read only once a Pane shows it.**
- **What may have changed a Channel is read again, coalesced, never cancelled:** an Activity in it, its Timeline's `head` moved past the one last seen, a Gap, an overflow, or a reset.
- **`refreshDelay` spaces the reads:** 250 ms after the first change, and no more than once a second while changes keep coming.
- **Members are read again from the start, as many as were held.**
- **The header says what the head said.** A Channel's shows its topic, formatted, with who set it and when, its modes, and its count. Where Self stands otherwise is in words, such as kicked or joining.
- **A Direct Message's header says whether its partner is on the Network,** as `known` says.
- **A member shows their highest rank's symbol, from the Network's `PREFIX`,** and their account: logged in to one, logged out, or not known, as last known when that is all that is.
- **A member is a bot only when their User said so and that is known now,** and a row's label then says `bot`.

## Lookups

What `/whois`, `/whowas`, `/names`, `/who`, `/list`, and a Channel's lists ask, and a card for each Pane showing what came back.

- **A Lookup's nick is read as the Client reads one,** so `/whois #iirc` and `/whois *!*@host` say why in words and send nothing. `fixtures/nicks` holds both readings to the same cases.
- **A list's command is of the Channel named, or the one in focus.**
- **`/bans`, `/exceptions`, and `/invexes` are not offered where the head of the Channel in focus says the Network keeps no such list.** Where it is unread, the Client decides.
- **`/names` is of the Channel named, or the one in focus,** and outside a Channel with none named it says so and sends nothing.
- **`/who` needs a mask,** one word.
- **The cards of `/names` and `/who` list the members with their prefix symbols,** by the `PREFIX` of the head of the Channel in focus or RFC 1459's, and the Users matched with `user@host`, away, and realname.
- **`/list` takes a mask, a least number of members, both in either order, or neither.** A word of digits alone is the least, at least 1, and any other word is the mask, which holds no comma.
- **A `/list` card lists each Channel's name, members, and topic, most members first,** with digits grouped the same in every locale. A Channel opens its Timeline while `known` says Self is in it, and otherwise starts `/join`, even where a Timeline is kept from before.
- **A reply longer than the Client keeps says how many of how many it shows.**
- **The Network's Channels come a page at a time, and only when asked.** `nextPage` gives the next to read, by the card's intent, while the Daemon kept more and none is being read. A page folds in only where it follows on from those held, and one that fails can be asked for again.
- **A mask that bans an account says so.** Where the head of the list's own Channel gives `accountBan`, a mask of it has the `account` it bans (`bannedAccount`), contained. `mask`, and its removal, stay the exact mask.
- **A mask can be removed while Self holds operator, or a rank above it in `PREFIX`,** by the head of the list's own Channel, which is followed while the card lasts (`listedChannels`). A half-operator is not offered it.
- **Removing a mask hides it while its unset is in flight,** under an intent of its own. It shows again when the Client refuses it, when no answer comes within the runtime's bound, which never sends it again, when an `ActionRefused` item of that intent arrives, or on an overflow or a reset of the stream.
- **One card a Pane.** A new Lookup replaces it, and an answer for a card no Pane holds changes nothing.
- **A card shows while its Pane has open the Timeline it was asked from,** and lives as long as its Pane.
- **What a Network wrote is contained and stays text,** in every field of a profile.
- **A Channel in a profile opens its Timeline, or starts `/join`,** once `known` said how the Network names Channels. Until then it is text.
- **Times are the caller's.** The caller formats the sign-on instant and when a mask was set, and one no calendar can hold is said to be unavailable.
- **What found no User, or no mask, is said in words,** naming the reply's numeric, and a list cut short says why.
- **A `WARN` or `NOTE`, or a later `FAIL`, the Network gave with its result is a line under it,** by its kind, command, code, context, and description, each contained.

## The menu on a nick

`@iirc/frontend/nick-menu`: what the menu on a nick offers (`nickEntries`), and whether its User is still in the Channel it was opened in, as a reducer, `reduceNickMenus`, over what the members route answered.

- **Each entry is the command the Composer would run,** and is offered only where that command runs. Mention starts the Composer with the nick and `: `.
- **Operating is offered by one rule, `mayOperate`:** Self holds operator, or a rank above it in `PREFIX`, in the Channel's head.
- **It acts only on its own Pane's Timeline.** With the focus on another, it offers nothing.
- **A User is there only once found there.** `presenceWanted` asks the members route for the nicks that start with theirs. One that folds as theirs, by the casemapping of the Network's Connection, says they are there, none with no more to read says they are gone, and a failure or more to read says nothing.
- **Op, voice, deop, devoice, and kick wait for the User to be found there,** and ban and ban account do not.
- **Ban account runs `/ban -a`,** so it is offered only where the head gives `accountBan`.
- **`coming` counts the operator's entries not offered yet,** while the head, whether Self may operate, whether the Network has a Session, or whether the User is there is still being read, so a view can hold their room. It is none once the Network is known to have no Session.
- **Deop, devoice, and kick are left out of a member who outranks Self** (`outranks`): the highest prefix they hold stands strictly above Self's, or which they hold is not known. Equal rank is allowed.

## Completion

What the Composer can complete, as a reducer, and the list it shows above the Composer, `listOf`. It completes the word that ends at the caret, moves through the candidates, and gives back what was typed on Escape.

- **A draft that starts with `/` opens the list as it is typed,** and each key narrows it. Only the first line opens it, and `//` never does.
- **A `:name` word opens the list on any line,** and a command's own completion wins over it.
- **Anything else opens on Tab, and Tab is taken only when there is a word to complete,** so the Composer is no keyboard trap.
- **What a word is completed from follows from where it is:** a command after `/` at the start of a line, an option after `/set `, a Channel after `/join `, `/part `, or a `CHANTYPES` character, a Timeline after `/go `, a theme after `/theme `, a font after `/set ui.font `, a Network after `/network remove `, an alias after `/alias `, an emoji after `:` and two or more characters of a name, and otherwise a nick.
- **An emoji name matches when it, or a word of it split at `_`, `+`, or `-`, starts with what follows the `:`.** Each emoji is listed once, as `:smile:`, and picking one writes the emoji and a space.
- **A `:` inside a word, as in `12:30` or an address, starts nothing.**
- **The emoji names are the Frontend's to give** (`emoji` in the sources). `emojiWanted` says when they are needed and not held, and until then the list is empty and Tab waits.
- **Entries are ranked as `Entries` says,** and Channels and nicks are matched by their start.
- **The whole argument of `/go`, `/theme`, `/set ui.font`, `/network remove`, and `/alias` is completed as one,** its spaces collapsed, and a candidate replaces all of it. `/theme` completes after any flags.
- **`/network remove` lists a removed Network whose Timelines were kept too,** and writes a Network whose id is `keep` or `drop` with a choice after it, `drop` for a removed one and `keep` otherwise.
- **`/alias` lists each alias with its line, and writes `add <name> <line>` to edit it.** After `/alias remove`, it writes only the name.
- **A bare `/` lists every command once, by name,** those run recently first, and an alias of the Owner's own among them unless a built-in command takes its name. A command's fixed alias still finds its command.
- **`/go` writes a name alone where it finds that Timeline from the Composer's Network,** the Network's id before it where it would not, and leaves out a Timeline it reaches neither way.
- **Picking from the list only writes the draft.** Only sending it asks for anything.
- **A theme or font highlighted is drawn while it is** (`previewOf`), and the one in effect comes back as the highlight moves on, the list closes, or the draft changes or is sent.
- **Nothing is highlighted while the list only follows what is typed.** Tab, Shift+Tab, or a pick highlights a candidate and writes it into the draft, so the draft always says what will be sent, and the list then holds its order.
- **A command is listed with its usage, what it does, and the chords bound to it.** A Timeline is listed with its Network and its kind, a theme with whether it is built in and in effect, a font with whether it is in effect, and a Network with whether it was removed.
- **A Channel is told from a nick by the Network's `CHANTYPES`,** as its Session said them, or RFC 2811's `#&+!` while they are unknown, never by a Timeline's name.
- **A nick in a Channel is asked of the Daemon's members route, only on Tab.** An answer is put in only if the Composer still holds the exact text it was asked for. A Direct Message offers its partner, and a Network's own Timeline no nick.
- **Who spoke latest comes first,** and Self last.
- **A nick at the start of a line is followed by `ui.composer.nickSuffix`,** `: ` to start, and anything else by a space.
- **A list belongs to its place, its draft, and its caret.** Another place, a draft changed other than by completion, or the caret moved without typing shows none.
- **`owns` says whether completion takes Tab, the arrows, Escape, and a press:** exactly while `listOf` shows a list, or while a nick is asked for.
- **A list opened as the draft is typed is announced by its count,** such as `3 completions`, and a Tab that finds nothing says `Nothing completes <word>` (`announced`).

## Rendering

What an item shows, as data for a view to draw. `lineOf` gives a line, `quotedOf` the short quotation of what a reply answers, and `formatted` the runs of a text. Nothing in it is markup.

- **Formatting is data.** mIRC bold, italic, colours, and the rest become styles on runs.
- **A link is one of `http`, `https`, `irc`, or `ircs`.** Anything else, `javascript:` and `data:` included, stays text.
- **Hostile text is contained.** Controls show as symbols, and every bidirectional embedding, override, or isolate a run opens is closed at its end.
- **The work is linear in the text, however hostile.**
- **Plain text is for where nothing is drawn,** such as a notification: stripped, cut to 200 characters, and isolated.
- **A reply's quotation is one plain line:** its sender's colour slot, how it was said, its text, and the position it stands at, for a view to go to.
- **A Direct Message's `context`, the Channel it is about, is contained like any name.**
- **A Message line says its sender is a bot** in `bot`, and the prefix they held when it was said, contained, in `prefix`.
- **A nick's colour is a slot, not a colour:** a hash of the nick as RFC 1459 folds it, one of 16.
- **One of our Messages says its delivery only while it is sending, or if it was not sent or was refused,** with the Ircd's code. Nothing is said once the Ircd confirmed it, nor of `Unconfirmed`.
- **A refused action is a line of its own,** such as `Your topic change for #iirc was refused (482)`.
- **A failed Connection names its Ircd, and hints when TLS looks wrong** (`mismatchedTls`): a plaintext Connection to 6697 that opened and ended before registration, or a TLS handshake that failed on 6667.
- **Activity is marked `-->` for a join or a partner coming online, `<--` for a part, a quit, a kick, or a partner going offline, and `--` otherwise.**
- **A standard reply shows its kind, command, code, context, and description,** and a `FAIL` takes the `Refused` tone.
- **A CTCP request shows who asked for what, and the answer sent or why none was.** An answer that never left takes the `Refused` tone.
- **A CTCP request the Owner sent shows whom they asked for what,** and a reply to their `PING` how long it took, in seconds to the millisecond, as the Daemon journaled the two.
- **An answer to Self's `OPER` says whether Self is an IRC operator now,** and a refusal its numeric in the `Refused` tone.
- **A login says which account a User logged in to, and a logout that they logged out.**
- **A change of host says the User's new `user@host`,** marked `--`, never as a quit and a join, and a change of real name says the new one.
- **A numeric shows its number dim where a nick would be,** and its parameters as one run of text in the `Numeric` tone, with its links and formatting.
- **The message of the day is a `Motd` line:** a `summary` of how many lines it has and whether it was cut short, and its lines formatted and linked, each with RFC 2812's leading `- ` dropped and every other space kept.
- **A netsplit or a netjoin is a `Split` line:** a `marker`, a `summary` naming the two servers and how many of the Channel's members quit or joined, and a `Nick` part for each.
- **`ui.timeline.activity` treats a `Split` as the quits or joins it tells:** `quiet` hides it, and `spoke` shows it when any of its nicks said a Message within the span.
- **An invitation says who invited Self to which Channel,** with a `Join` part that offers to join it.

## Previews

What a Frontend holds of Previews, as a reducer (`reducePreviews`) over what the view saw, what the Daemon answered, and what the stream of Previews said, and what each Message shows below it (`previewsOf`).

- **Nothing is fetched ahead of the screen.** A Message is asked for once, only once the view says it came into view, and only while the stream is followed. `asksWanted` gives the asks to make.
- **What the Daemon holds is read ahead of the screen** (`heldReadOf`), since a held read fetches nothing. A link held nothing of (`NotHeld`) folds in nothing.
- **A change the stream gives while a held read is in flight is held,** so a read that lands late never undoes it.
- **A Timeline's mode is its own in `ui.previews.timelines`, else `ui.previews`** (`modeIn`), from the shared values alone. Under `off`, or before they are read, nothing of it is asked for or shown.
- **The stream is followed while any Timeline's mode asks** (`asksAnywhere`).
- **`choosing` makes or removes one Timeline's choice** in the map, which is sent whole.
- **A link waiting for a press is pressed once the Owner opens it,** by its index (`pressOf`), and is pending meanwhile. A refused press asks its Message again.
- **A Message holding a link that waits for a press is asked again** once its Timeline chooses a mode that asks, while one of its Previews is open.
- **An item is held once, by its id,** so a change the stream gives updates every Message that shows it.
- **An answer is taken only by the ask in flight,** and never replaces an item the stream changed after that ask began.
- **A stream followed again asks again** for each Message still waiting on a Preview.
- **An image that is not animated is always still.** An animated one is as the Owner last pressed it, and until then moves only with `ui.previews.animate` on and no reduced motion (`motionOf`). The view passes in the device's motion setting.
- **A press opens a still image large, plays an animated one that is still, and stops one that moves** (`pressOn`).
- **Before its answer, a Message shows each link `previewableLinksOf` finds as a held read gave it,** or a placeholder.
- **After its answer, each link shows its item's state now:** pending, ready as its card, or failed as one line of why (`reasonWords`), never the link again. A link waiting for a press is drawn pending.
- **A link is an anchor only when it reads as one `http` or `https` link,** and everything a stranger wrote is contained.
- **Every Preview is one card** of its `title`, its `description`, and its media, in that order, each only when it has it.
- **A page is its title and description with its image,** drawn `Whole`. A page that names a video file or a listed player is drawn with its poster, `Poster`.
- **A link that is itself an image, a video, or a sound is its media alone.**
- **A file is its name, and as its description its first lines when it is a text file, else its type and size.** The name is the last part of the link's path, percent-decoded where that decodes, or its host. A file has no media, so it draws the same under `text` as under `on`.
- **A text file's lines are each contained,** a tab is four spaces, and blank lines before the first and after the last are dropped.
- **A file's size is in powers of a thousand, the same in every locale:** `0 bytes` to `999 bytes`, then `kB`, `MB`, `GB`, or `TB`, to one decimal below ten and whole from ten, rounded before the unit is chosen, so 999,999 bytes is `1.0 MB`.
- **Media is given only while the mode is `on`.** An image has its `dimensions` or none, its `src` on the Daemon's own origin, and its `alt` the title, else the link. A video or a sound has its kind, its type, and a `src` on the Daemon's stream route.
- **Under `text` a card is its words alone,** and a card that would hold nothing is not drawn.
- **The site's name is never drawn.**
- **A card read from another host than its Message's link names that host** (`hostNamed`), compared in lower case without a leading `www.`.
- **A card's `name` is its title, or else its link.**
- **`isOpen` says whether a Message's Preview is open:** as the Owner last toggled it (`linkKey`), else as `ui.previews.start` says. One in a Direct Message with no mode of its own, or waiting for a press, starts closed.
- **`asksWanted` asks for a Message only while one of its Previews is open, or while its links wait for a press.**
- **`pressesWanted` presses a waiting link once the Owner opened it, and never twice,** unless the press was let go of unanswered (`PressDropped`).
- **A Message shown again with another count of links is wanted again,** and an answer for its old links settles nothing.
- **`togglesIn` places each toggle after the first run of each link that may be previewed.**
- **A player plays only from a host `ui.previews.players` lists now.** Under `on`, a Ready Preview of kind `player` gives `player`: its host, contained, the words `plays from <host>`, its `size` or none, and a `src` with the host's autoplay parameter set (`autoplay=1` for `www.youtube-nocookie.com` and `player.vimeo.com`, `auto_play=true` for `w.soundcloud.com`).
- **A view loads a player's `src` only once the Owner presses play.**
- **`playsIn` gives one box for the poster, the video, and the player:** the player's `size`, else the poster's `dimensions`, else 16 by 9.
- **A player whose host the list no longer names is drawn as a page at once,** even from an answer held before.

## Activity

What is new, from the counts the Daemon keeps, and when marking a Timeline read is due (`markDue`), by the rule `ui.unread.markRead` gives. It never counts items itself.

- **A level ranks what calls for the Owner:** Highlight, then Direct, then Message, then Activity. A Timeline's level is the highest with anything unread.
- **Activity is a dimmer name, never a number.**
- **The page's title counts only Highlights and Direct Messages.**
- **A mark is due only for what the Owner can see:** a Pane that is shown, with the page visible and focused, and under `latest`, at the latest.
- **A mark is never back, and never past what was shown,** even when the Daemon holds a later item.
- **A muted Timeline counts nothing but a Highlight.** `/mute` and `/unmute` give a `Mute` intent, and the runtime writes `ui.unread.muted` as `muting` gives it, or a refusal past `mutedCap`, 256.
- **`unreadShown` is the one place the mute is decided,** so every count, level, label, and the title follow it, and a muted Timeline's label ends `muted`.
- **`/read all` still marks a muted Timeline, and `/next-unread` passes it over** unless a Highlight is unread there.
- **`ui.unread.quietBots` leaves what bots said out of the counts.** Off, and until the options are read, everything counts. A Timeline where only bots spoke is passed over by `/next-unread`, though `/read all` still marks it.
- **A divider that only bots' Messages opened is dropped while bots are quieted** (`dividerShown`).
- **A removed Network's Timelines are never marked, and call for nothing,** neither in the title nor for `/next-unread`.

## Removing a Network

`@iirc/frontend/removal`: the question asked before a Network is removed, as a reducer, `reduceRemoval`, over what the Owner chose and what the Daemon answered.

- **Nothing is removed until the Owner confirms.** Cancelling sends nothing.
- **A removal in flight is sent once and takes only its own answer.**
- **A removal names the life of the Network it asked about** (`removalOf`), and removes nothing if the Network was removed or added again since.
- **The Timelines are kept unless the Owner chooses to drop them.** A Network removed with them kept is asked about only to drop them, which frees its name.
- **What failed is said in words from the error's tag.**
- **Three outcomes are told in words in place of the question, not shown as failures:** a removal that stands with its Credentials not all forgotten, a Journal that failed so that whether it stands is unknown, and a Network removed or added again since it was asked about.

## Closing a Timeline

`@iirc/frontend/closing`: what closes a Timeline from its row (`closeOf`), and the offer to leave a Channel Self is in instead, as a reducer, `reduceLeaving`.

- **A close shows at once.** `reduceClosing` holds each close asked for until it is answered, or, answered closed, until the Timeline changes after it, and `closingShown` gives the Timelines `sidebar` leaves out meanwhile. A refusal or a failure shows the Timeline again.
- **A close is matched to its Timeline by the name the Daemon gives** (`closedBy`), so a Target typed otherwise shows only once answered.
- **A Channel Self is in is never closed.** The Daemon refuses it as `Joined`, naming the Channel it checked, and that refusal offers to leave it, so `@#iirc` offers and leaves `#iirc`.
- **Leaving is sent once, only once the Owner chooses it** (`leaveOf`): as the edit `/part` sends when the Network's Configuration wants the Channel, and as the `Part` action when it does not. Leaving does not close the Channel.
- **Only a Channel's or a Direct Message's Timeline has a Target to close it by.** A Network's own, a Direct Message that no longer follows its partner, and a removed Network's have none.

## Notifications

`notificationsOf` says which items a change added call for a notification, and what it says.

- **Only what calls for the Owner notifies, and only once:** a Highlight, a Direct Message, or an invitation, said live, not ours, after its Read Marker, in a Timeline the Owner is not looking at. A step given twice notifies once.
- **In a muted Timeline only a Highlight notifies,** which an invitation is.
- **With `quietBots` on, a Message a bot said notifies only as a Highlight.**
- **Until the options are read, only a Highlight notifies anywhere,** and `quietBots` is off. The runtime gives the mutes the Daemon holds, never one on its way.
- **Its words are plain text** (`plainText`): the Timeline and Network, then the sender and text.
- **A newer notification for a Timeline replaces the last.**

## Not yet

- **One Timeline in two Panes,** at two places.
- **A layout shared by every device.** It is kept per device.
- **Overrides of the keymap under `ui`.** `keymapOf` reads them, dropping what does not parse.
- **Chords in sequence,** such as `mod+k mod+o`.
- **A divider for what came while the Owner was away from an open Timeline.** The divider is taken when a Timeline opens, so one left open in a hidden page gains none until it is opened again.
