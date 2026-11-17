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

For each Network it holds its Timelines, its connection, whether Self is away, and which Direct Message partners are on it. For each Timeline a Pane has open it holds a window: its items in position order, its collapsed Gaps, and whether more lie earlier and later. `wanted` gives the reads to make, `followFrom` where to follow the stream from, `sidebar` the Networks as a sidebar lists them, `treeOf` a Network as its own Timeline's row with the rest under it, `chosenOf` and `elsewhereOf` what the focused Pane and the others show, and `rowsOf` a window as rows: its items, its Gaps, the "new" divider, and, given a time zone, a Day where the day changes.

### Reading and following

- **It reads everything, then follows.** The Network list and every Network's Timelines are read first. The stream is then followed after the smallest `through` among them, and the Network list is read once more, so a Network configured meanwhile is not missed. A window is read only once the stream is followed.
- **One rule decides whether an answer is current:** nothing that invalidates it happened after its read began. That is a reset, or an overflow that touched what it is of. An answer that is not current is asked for again.
- **No change is lost or applied twice.** A Timeline is kept by its id and an item by its position, so a change given again changes nothing. A read that lands after the stream passed it is brought up to date from what the stream gave.
- **What is held of a Network is of one life,** the one the API names by the sequence of the `Configured` that began it. Whatever names a life, the Network list, a page of its Timelines, its Session, the changes, or the Daemon's answer to removing it, changes nothing of the life held when it names an older one, applies when it names the same, and replaces what is held when it names a newer one, which is then read. A removal applies only to the life it names, a life over with its Timelines dropped never comes back, and a life once kept stays kept. A newer life is taken from any of these, a Network not held included, and a Session item of an older life's Timeline says nothing of the connection.
- **`UnknownNetwork` names no life, so it lets nothing go.** The Network list is read again, and a Network it does not name, whose life began before it was asked, is over.
- **An overflow reads again what it touched, and a reset reads everything again.** A merged Timeline resolves to the one it went to.
- **A Network's connection, Self's away, and which partners are on it are derived, never polled.** They come from `known`, and then from the Session items the changes carry. `known` is read again when Self's away changes, when a partner comes, goes, quits, or changes nick in their Direct Message Timeline, and when one is opened. A partner shows as there or gone only while connected and as `known` says, and as neither otherwise. Whether a Session carries tags is `known`'s alone to say, so a `SessionBegan` leaves it unknown and has `known` read again, and `carriesTags` is true only once it says so.
- **A closed Timeline is left out of `sidebar` while no Pane has it open.** The Daemon says whether it is closed, and it comes back by itself once something arrives in it. `sidebar` gives it apart, as `closed`, for the palette, and gives it with the rest while a Pane has it open, so one opened from the palette or the search shows there. Nothing here keeps a flag of its own. Moving to the next Timeline, the one that calls most, and the page's title count only what the sidebar lists.
- **A removed Network is derived too.** One removed with its Timelines kept is named `Kept` by the Network list, which names every Network, live or kept, in one read, or known by its Timelines flagged `removed`, and `isRemoved` reads both. Its Timelines are read and searched as any other, but its Session is never read, nothing is said or done there, and `sidebar` lists it after the rest.
- **A dropped Timeline is let go of at once.** The changes name it, or name its Network as removed without keeping its Timelines, which reaches a Network that never had one too. Its Network, window, and place among the closed go, a Pane that showed it shows nothing, and the search begins again. A Network the changes name as removed with its Timelines kept is only read from then on. The Daemon's own answer to a removal, `NetworkRemoved`, does the same ahead of the stream, for the life it ended.

### Windows

- **A window holds at most `windowCap` items, 1000.** `earlier` and `later` are true exactly when something lies beyond, so everything dropped can be read again.
- **Only the windows of Timelines open in a Pane, and of the four closed most recently, are kept.** Any other is dropped and read again when opened.
- **A new item lands only where it belongs by position:** in place of the item it updates, between the items held, or past the end when nothing more lies beyond. A Gap that changes history under a window has it read again.
- **Only the view says what the Owner has seen.** A window's `seen` is the last item the view's `Following` event said is in view, at the latest or not, so opening a Timeline never makes the core believe anything in it was read.
- **The "new" divider stays where it was when the Timeline opened,** and does not jump as the Daemon's Read Marker moves.
- **Failed Connections in a row are one row,** counted, when they are to the same Ircd for the same reason.
- **A Day is derived as a window is read,** from the items either side of it, and never stored. It stands before each item drawn on a different day from the one drawn before it, and before the first drawn, so a window that begins mid-day says which day it is. A day begins at midnight in the zone `rowsOf` is given, which is the offset from UTC at an instant, since the core reads no zone itself, and an item the zone cannot place starts no day. With no zone there are no Days.
- **A Gap before anything is no row.** A Gap that ended, with no item before it, in a window that holds the Timeline's start, says nothing was missed, so `rowsOf` leaves it out and the window keeps it. A Gap still open, or one before the first item of a window with older items beyond it, is a row. Items a view hides still count as before a Gap.

### What a Pane shows

- **A Timeline is open in one Pane at most.** Opening one that another Pane has open focuses that Pane. Two Panes at different places in one Timeline would need every rule of reading to say which Pane wins, for little gain.
- **A Pane shows its Timeline, or something in front of it:** the options, the Uploads, the search, or a Direct Message not yet begun. It remembers one step back, which closing shows again. The options, the Uploads, and the search each show in one Pane at most.
- **A Direct Message not yet begun is a view, not a Timeline.** The API makes a Timeline only when something is said. The draft shows its Timeline as soon as one is listed, matched by the casemapping read when the draft was made, never one held from another time, which could match another User's Timeline.
- **A Message said with `opens`, as `/msg` says one, opens the Timeline the Daemon placed it in,** by its id, never its name. It opens only in the Pane it was said from, and only while the Owner has not moved on.
- **A jump from the search opens a window read around a position.** It is not at the latest until the Owner moves there themselves, so under `ui.read latest` nothing is marked read by it until then.
- **The layout is kept per device, as JSON, and taken back once the Timelines are read.** `layoutKeptText` bounds the text before anything parses it, then reads it through its Schema, and never throws. A Pane whose Timeline is gone is dropped. A Pane showing the Uploads comes back showing them, and a layout kept before they had a view comes back as it was.

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
| Acting | `/topic`, `/kick`, `/mode`, `/op`, `/deop`, `/voice`, `/devoice`, `/ban`, `/unban`, `/invite`, `/ctcp`, `/ping`, `/away`, `/back`, `/nick`, `/quote` |
| Lookups | `/whois`, `/whowas`, `/bans`, `/exceptions`, `/invexes` |
| Configuration | `/set`, `/unset`, `/join`, `/part`, `/ignore`, `/unignore`, `/network add`, `/network remove`, `/connect`, `/disconnect` |
| Themes | `/theme`, `/theme -light`, `/theme -dark`, `/theme import`, `/theme remove` |
| Moving | `/next`, `/previous`, `/next-unread`, `/latest`, `/search`, `/uploads`, `/palette`, `/focus` |
| Reading | `/read`, `/read all`, `/close-timeline`, `/previews`, `/notify`, `/members`, `/sidebar` |
| Panes | `/split`, `/close`, `/pane`, `/swap`, `/equalize`, `/zoom`, `/grow`, `/shrink` |

Each entry in `src/commands.ts` carries its usage, aliases, and description, which the palette shows.

- **A line is read one way.** Plain text is `/say` to the open Timeline, `//text` says `/text`, and `/name args` runs the command named. An unknown command sends nothing.
- **Arguments are parsed into typed values,** or the command says why not, naming its usage. The text after a Target is kept exactly.
- **Each command says when it can run,** and an unmet condition says why in words: no Target in the Network's own Timeline, no Session, a removed Network, whose Timelines are only read, or one Pane with nothing to close.
- **Acting is parsed as the Client checks it.** What depends on the Network, such as which modes take a parameter, is read from `PREFIX`, `CHANMODES`, and `CHANTYPES` in the focused Channel's head. Before a head is read, a command that needs them says so and does not guess.
- **Configuration is changed by intents, never in place.** `/join`, `/part`, `/ignore`, `/unignore`, `/set`, and `/unset` name an edit, which the runtime applies to the Configuration in force then.
- **`/ignore` and `/unignore` take a nick or a mask.** A bare nick means `nick!*@*`, and a mask that does not parse is refused saying why. Masks are compared under the Network's casemapping, and `/ignore` alone opens the options on the Network's `ignores`.
- **`/query` opens a Timeline by name and never makes one.** It folds the name by the casemapping `known` reports. When `known` cannot be read it opens nothing, since a guessed mapping could open another User's Direct Message.
- **`/close-timeline [#channel|nick]` closes a Timeline by its Target,** the focused one unless named, never a Network's own, and never a Pane, which `/close` closes. Whether Self is in a Channel is the Daemon's to answer.
- **`/network remove [id] [keep|drop]` only asks.** It names the Network, the focused one unless given, and whether to start on keeping its Timelines or dropping them, and nothing is removed until the Owner confirms.
- **A Credential's value never goes through the composer, nor any intent.** `/set <credential option>` alone opens a password prompt. A value typed after it, or a raw `PASS`, `AUTHENTICATE`, or `OPER`, is refused, and so is `/oper`, whose refusal names the `oper` options to set instead.
- **`/next-unread` goes to the Timeline that calls most,** as WeeChat's smart jump does: Highlights, then Direct Messages, then Messages. Activity alone is not enough.
- **A new command is one entry.** The palette and the keymap add no actions of their own.

## Keymap

Keybindings as data over the registry. A binding names a chord, a command, its arguments, and a `when`. `resolve` gives a pressed key's intents, or nothing, so a key no binding takes is never swallowed.

| Keys                              | Does                                |
| --------------------------------- | ----------------------------------- |
| `mod+k`, `mod+shift+p`            | Open the palette                    |
| `alt+arrowdown`, `alt+arrowup`    | Next and previous Timeline          |
| `alt+a`                           | The Timeline that calls most        |
| `alt+m`                           | Show or hide the members            |
| `alt+n`                           | Show or hide the sidebar            |
| `mod+,`                           | Show the options                    |
| `mod+shift+f`                     | Show the search                     |
| `alt+shift+arrows`                | Move between Panes                  |
| `alt+shift+s`, `alt+shift+d`      | Split side by side, or down         |
| `alt+shift+w`, `z`, `e`, `g`, `r` | Close, zoom, equalize, grow, shrink |

- **A chord is parsed.** `formatChord` writes one so that it parses back the same. A binding that does not parse, or names no command, is dropped, so a keymap holds only bindings that can fire.
- **`mod` is Cmd on a Mac and Ctrl elsewhere.** `showChord` writes a chord as the platform does.
- **A key event is the layout's character,** so an AZERTY `é` binds as `é`. The physical key names it only where the character says less, as with a dead key or Option on a Mac.
- **AltGr in a field is typing,** so German AltGr+Q types `@`.
- **The last binding that applies wins,** so overrides go after the defaults.
- **Most defaults fire while typing in a field,** as an IRC client keeps the caret in its input. None takes a key a browser uses.
- **A key that types goes to the composer, unless it is bound.** `typesInComposer` says so from the key, where it was pressed, and the keymap. A printable character, a dead key, the start of an input method's composition, a character AltGr types, a character Option types on a Mac, and the platform's paste chord type. Space, Enter, and any other key with Ctrl, Meta, or Alt held do not. A field that takes text, the palette, an overlay holding the focus, or no composer to write to, leaves the key alone.
- **Enter in the Composer is not a binding, but `ui.enter`.** `enterPressed` says whether a press sends or begins a new line: under `send`, Enter sends and Shift+Enter begins a line, and under `newline`, Enter or Shift+Enter begins a line and Mod+Enter sends. `sendChord` and `newLineChord` give the chords to show.
- **The Panes' keys are Alt+Shift and a letter.** Option on a Mac types another character, which a letter's physical key names back and punctuation's does not.

## Palette

What the command palette lists for a query (`sections`), and what choosing an entry asks for (`choose`). It lists the commands that can run here, every Timeline, those closed after the rest, every Network, to remove it or drop what it kept, every theme, every font, and every option read, or the themes alone, as `/theme` opens it. A query of `font` and a family's name, such as `font Fira Code`, lists that family among the fonts.

- **A query ranks entries in four tiers:** it begins a name, begins a word of a name, begins a word of the description, or its characters appear in a name in order. Matching is ASCII case-insensitive and reads no locale. It is a small scorer of its own because uFuzzy sorts with `Intl.Collator`.
- **With no query, recent choices come first,** at most 20.
- **Choosing a command that needs no arguments runs it.** One that needs them starts in the composer. A Network asks to remove it, as `/network remove` does. A Timeline opens, an option starts `/set <name> `, a Credential option opens the password prompt, and a theme is drawn in on every device, or, listed by `/theme -light` or `-dark`, set as `ui.light` or `ui.dark`, and a bundled font is drawn in on every device too, unless this device overrides `ui.font`, but a family typed in is always this device's own, since each device has its own.
- **A choice never replaces a draft with text in it.** The draft is kept, and a notice says what was not put in.

## Composer

What the Owner is writing in each Timeline, what they sent from it, and why something was not said. `submit` reads the draft through the registry and gives intents. A composer is at a `Place`: a Timeline, a Direct Message not yet begun, or `Nowhere`, where commands that need no Timeline are typed.

- **Each Timeline has its own draft and its own history,** at most 100 lines, which Up and Down go through.
- **Submitting sends every non-empty line, in order, or nothing.** The first line that cannot be sent says why, with the text kept. More than 5 lines wait for the Owner to confirm, and what is confirmed is always exactly what is shown.
- **A Credential's value typed here is let go of at once.** It sends nothing, clears the draft, and enters no history.
- **A draft can answer one Message,** which `replyOf` offers only for a Message with an id a `+reply` tag can carry, on a Network whose Session carries tags. The draft holds it, with the Message as it was, through edits and turning away, until it is dropped or sent, and only the first Say to its Timeline answers it, so a reply of several lines is tagged on its first.
- **A refusal is said in words under the composer it came from,** and nothing after it is sent.
- **A notice lasts as long as it is true.** One about the text as typed, such as no such command, goes when the text is edited and when the composer turns to another Timeline. One with an offer stays with its Timeline until taken or dismissed. One of an outcome that arrived later stays until dismissed or the next submit, since an edit must not hide what the Owner may not have read.
- **What failed says what is safe to do next, and nothing is sent twice.** A Say or an Act that was not journaled may be sent again under the same intent. One that was journaled is never sent again. One with no answer can only be checked again.

## Options

Configuration as an option tree. Every option comes from the annotations on the Client's `NetworkConfiguration` Schema, walked once, so nothing lists them by hand and a new field is a new option.

An option is named `network.<id>.<path>`, such as `network.libera.nicks`, `network.libera.login.account`, or `network.libera.channels.#iirc.key`. Ids and Channel names may hold dots, so a name is an option only when exactly one way of splitting it is valid.

| Kind               | Text                                                          |
| ------------------ | ------------------------------------------------------------- |
| `Toggle`           | `on` or `off`                                                 |
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
- **An edit is a pure function of the Configuration** (`apply`), parsed again by the Schema, so the runtime applies the same edit again after a conflict.
- **A change asked for shows at once, until it is answered.** `Asked` holds it, never a copy of the options, and `Answered` lets it go, however it came out. `uiShown`, `ownerShown`, and `configurationShown` derive what shows from what is in force and what is on its way, and `listed` lists that. Nothing is applied before what is in force is read.
- **What a new Network starts with is the Schema's,** and `unset` returns an option to it.
- **A field members of a union share is one option,** such as `login.account`, set in the member in force when it has the field, and otherwise in the first that does, which it puts in force.
- **A Credential option is write-only.** Its value is given in the password prompt, and the option only names the Credential, by a name derived from the option's own so that two options never share one.
- **Channels are compared as the Daemon reports the Network folds them,** so `/part` never parts more than one entry for a name.
- **A Channel's prefix is never guessed.** A bare name takes the Network's first `CHANTYPES` character, and is refused while `CHANTYPES` is unknown.

### The options under `ui`

An option under `ui` is named `ui.<option>`, such as `ui.time`, and is derived from `UiOptions` in `@iirc/api/ui` the same way.

- **Every device shares them, and one may override any for itself** with `-device`, but those annotated shared only, such as `ui.previews`, which the Daemon acts on: `-device` refuses them, and an override of one a device kept is dropped. `effectiveUi`, in `@iirc/frontend/ui`, gives the override, else the shared value, else the default.
- **A change is written for this device when it overrides the option, and for a font's family always,** since each device has its own fonts. `writtenOnDevice`, in `@iirc/frontend/ui`, decides it, for the options view and the palette alike.
- **Overrides are parsed option by option,** so one bad override kept on a device never loses the others.
- **`ui.activity` changes what is drawn, never what is counted.**
- **A font's family the device lacks is said to be not found,** when it is the one in effect. Only the device can find that out, so it hands the families it lacks to `uiOptionsOf`.

### The options under `store`, `uploads`, and `previews`

An option under `store`, `uploads`, or `previews` is named in full, such as `store.s3.bucket` or `uploads.maxSize`, and is derived from `OwnerOptions` in `@iirc/api/options` the same way. They are listed first, ahead of every Network's.

- **They are the Owner's, not a device's,** so no device overrides one, and `-device` refuses them. A change is made from the options read, and `unset` returns one to its default, or leaves it unset.
- **A Credential option names a Credential, `Owner.` and the option's name** until it names another, such as `Owner.store.s3.accessKeyId`. A Network's id starts with a lower-case letter or a digit, so no Network's Credential is ever named so.

## Uploads

The Uploads view lists the Uploads, newest first, live ones only unless the deleted are shown, as a reducer (`reduceUploads`) over the pages read and the Changes streamed, with where the next page begins and `through`, the sequence of the last Change folded in, which the stream is followed after.

- **A page only extends the list at its end.** It is folded only when read from where the list stands, the first page into an empty list and each later one from `next`, so one read twice is folded once. The first page sets `through`.
- **The stream only gives what is newer.** A Change after `through` moves it on. One held is replaced in place, or dropped once deleted. One not held goes first, unless it is deleted, or uploaded before the oldest held while more pages follow, as a rename of an old Upload is. Those are kept aside, and a later page read before the Change but folded after it takes the Upload as the Change left it, so a delete is never undone by a slow page. A Change before the first page, or no later than `through`, is passed over, so an Upload is never held twice.
- **Deleted Uploads are held only while `showDeleted` is on** (`DeletedShown`, off to start). Then a page keeps them, a Change or an answer that deletes one replaces it in place, and a deleted one not held is treated as a live one would be. Switching starts the list over, nothing held and no page read, so it is read again with or without them. `deletedText` says a deletion in a word, `expired` or `deleted`.
- **Which Uploads are missing is the stream's last word** (`Missing`), the ids of every live Upload whose bytes the Daemon found gone, which replaces the set held whole. Pages, Changes, and answers leave it alone, and switching the deleted or signing out empties it, since a restarted stream sends it again. A row's mark is derived from this set alone, never from an Upload's own `missing`.
- **The Daemon's answer to a rename, a delete, or a read is folded at once** (`Answered`), into an Upload held only, and moves nothing on, since the stream still gives any Change.
- **Where an Upload was said is the Daemon's, read again when it may have changed.** Saying a Message makes no Upload Change, so `saidIn` gives the Uploads held whose `/<id>/` a Message of ours among a Timeline change's items holds, by its text or the text the Ircd confirmed, for the runtime to read again and fold in as `Answered`. `saidPlace` says where one was said as its Network and Target.
- **What the Owner asked of each is beside them** (`reduceUploadEdits`): the Upload a delete is being confirmed for, and each rename or delete waiting on the Daemon or failed, until it is sent again. `nameOf` reads a typed name as the contract takes one, and `editFailureText` says a failure in words.
- **What is shown is derived, never held.** `linkOf` makes a link from the public URL given, as `<publicUrl>/<id>/<safeName>`, or none without one. `thumbnailed` says whether a type is an image every browser draws, `sizeText` a size in binary units, such as `1.2 MiB`, and `shownName` the name given, else the safe name.

## Uploading

The files added to a composer, as a reducer (`reduceUploading`) over what the runtime found out, each named by a key the runtime makes, since the core makes no randomness.

- **A file's link goes where the caret was when it was added.** It is pending from that moment, before the Daemon is asked whether Uploads are on, so its order among files added at one caret and its anchor are fixed then. Its anchor follows the draft as it changes however it changes (`followed`): an edit wholly after it leaves it, one wholly before moves it, one across it puts it at the end of what replaced it, and text typed exactly at it goes after it, so a caption typed after a pasted screenshot follows its link. Where the Owner typed the edit, the selection just before it and the caret just after say exactly what changed (`editOf`), however the text repeats, and the texts alone are compared only when they do not, as for an undo. A draft carried to its Timeline takes its files with it.
- **A link is a word of its own.** `insertLink` adds a space on whichever side touches anything but whitespace, and `caretAfter` moves a caret at or after it past it. Files added at one caret land in the order added, whatever order they finish in.
- **Whether Uploads are on is the Daemon's answer when the files were added, never kept.** Files are checking until it answers. While they are off, those files are let go of, and `offNote` names the options to set. A file over `maxSize` is refused before it is sent. A link of `null`, with no public URL, puts nothing in and notes it the same way.
- **A draft waits for its links.** While a file added to it is checking or being sent, `heldBack` says to wait for it or cancel it, and nothing is sent. A failed file holds nothing back. What is kept of a send held back is only that it was, per composer (`HeldBack`), and `heldNoteIn` derives the words from the files still pending, so they name only those and go with the last of them, kept, failed, or cancelled, and never come back.
- **A file kept stays listed until its draft is sent** (`Sent`), or it is dismissed, holding nothing back. Renamed, its new link goes into the draft in place of the old (`renamed`), wherever the old now stands, however the Owner edited around it, and every anchor and caret after it moves by the change in length (`relinkedAt`). Where the Owner edited it away, nothing is replaced.
- **Every failure is said in words** by `failureText`, from the API's typed errors, and a request with no answer says only that whether the file was kept is unknown.

## Themes

Every colour a Frontend draws, derived from a terminal's palette of a foreground, a background, and 16 ANSI colours. `drawn` gives the colours and `cssVariables` their names.

- **No palette makes text unreadable.** A colour that falls below its floor on what it is drawn on is moved by the least change of lightness that reaches it, its hue kept. One that reads already is kept exactly.
- **The floor is WCAG 2's contrast ratio:** 4.5 for text, and 3 for dim text and the focus ring. APCA judges dark themes better, but it is still a draft and its licence restricts its use.
- **Nicks are spread over 16 slots drawn from the palette's own hues.**
- **mIRC's first 16 colours are the theme's ANSI colours, or mIRC's own,** as `ui.colours` says. Colours 16 to 98 are always mIRC's own.
- **Themes are built in or imported.** The built-in ones are in `src/builtin-themes.ts`, each with its source and licence. A name that names no theme draws as `system`.
- **`system` draws `ui.light` or `ui.dark` as the device prefers,** each the built-in one of its name until set, by `/theme -light` or `/theme -dark`, to any theme but `system`. One that names no theme, as one imported and removed since, draws the built-in one again. A theme named in `ui.theme` wins over both.
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

- **The head is held for each Channel the Sidebar lists or a Pane shows, so one opens with it already read, and the members are read only while they show.** `heldChannels` lists them, the shown first. A removed Network's Channel is read only once a Pane shows it, and a Channel's members are let go of once no Pane shows it. Each join, part or quit in one reads its head again, at most once a second.
- **What may have changed a Channel is read again, coalesced, never cancelled.** An Activity in it, its Timeline's `head` moved past the one last seen, a Gap, an overflow, or a reset leaves it dirty. `refreshDelay` spaces the reads: 250 ms after the first change, and no more than once a second while changes keep coming.
- **Members are read again from the start, as many as were held.** The Daemon orders them by rank, which any `MODE` can move, so patching the list would need to know what each Activity means for every member.
- **The header says what the head said.** A Channel's shows its topic, formatted, with who set it and when, its modes, and its count, and a Direct Message's whether its partner is on the Network. Where Self stands otherwise is in words, such as kicked or joining.
- **A member shows their highest rank's symbol, from the Network's `PREFIX`, and their account, the one they are logged in to, logged out, or not known, as it was if that is all that is known.**

## Lookups

What `/whois`, `/whowas`, and a Channel's lists ask, and a card for each Pane showing what came back.

- **A Lookup's nick is read as the Client reads one,** so `/whois #iirc` and `/whois *!*@host` say why in words and send nothing. `fixtures/nicks` holds both readings to the same cases.
- **A list's command is of the Channel named, or the one in focus.** `/bans`, `/exceptions`, and `/invexes` are not offered where the head of the Channel in focus says the Network keeps no such list. Where it is unread, the Client decides.
- **A mask can be removed while Self may,** by the head of the list's own Channel, which is followed as a Pane's Channel's is while the card lasts (`listedChannels`), wherever the card shows: an operator, or a rank above it in `PREFIX`, holds it. A half-operator is not offered it, since whether one may differs by Ircd and ISUPPORT does not say. Removing sends the unset under an intent of its own, and the card hides that mask while it is in flight. The Client refusing it, no answer within the runtime's bound, which never sends it again, or the Ircd refusing it later, an `ActionRefused` item of that intent in the changes stream, shows it again, and so does an overflow or a reset of the stream, which could have hidden that refusal.
- **One card a Pane.** A new Lookup replaces it, and an answer for a card no Pane holds changes nothing.
- **A card shows while its Pane has open the Timeline it was asked from,** and lives as long as its Pane.
- **What a Network wrote is contained and stays text,** in every field of a profile.
- **A Channel in a profile opens its Timeline, or starts `/join`,** once `known` said how the Network names Channels. Until then it is text.
- **Times are the caller's.** The core reads no clock or time zone, so the caller formats the sign-on instant and when a mask was set, and one no calendar can hold is said to be unavailable.
- **What found no User, or no mask, is said in words,** naming the reply's numeric, and a list cut short says so.
- **A `WARN` or `NOTE`, or a later `FAIL`, the Network gave with its result is a line under it,** by its kind, command, code, context, and description, each contained.

## The menu on a nick

`@iirc/frontend/nick-menu`: what the menu on a nick offers (`nickEntries`), and whether its User is still in the Channel it was opened in, as a reducer, `reduceNickMenus`, over what the members route answered.

- **Each entry is the command the Composer would run,** by the registry, and is offered only where that command runs. Mention starts the composer with the nick and `: `.
- **Operating is offered by one rule, `mayOperate`:** Self holds operator, or a rank above it in `PREFIX`, in the Channel's head, as removing a mask from a Lookup card is.
- **It acts only on its own Pane's Timeline.** With the focus on another, it offers nothing.
- **What needs the User there needs them found there.** `presenceWanted` asks the members route for the nicks that start with theirs, and only one that folds as theirs does, by the casemapping the Network's Connection folds names by, says they are there. None, with no more to read, says they are gone, and a failure, or more to read, says nothing. Op, voice, deop, devoice, and kick wait for them to be found, and ban does not.
- **Nothing is offered that the Network would refuse for want of status.** Deop, devoice, and kick are left out of a member who outranks Self, by `outranks`: the highest prefix they hold stands strictly above Self's in `PREFIX`, or which they hold is not known. Equal rank is allowed, since Ircds differ.

## Completion

Tab completion in the composer, as a reducer. It completes the word that ends at the caret, cycles through candidates, and gives back what was typed on Escape.

- **Tab is taken only when there is a word to complete,** so the composer is no keyboard trap.
- **What a word is completed from follows from where it is:** a command after `/` at the start of a line, an option after `/set `, a Channel's name after a `CHANTYPES` character, and otherwise a nick.
- **A Channel is told from a nick by the Network's `CHANTYPES`,** as its Session said them, never by a Timeline's name.
- **A nick is asked of the Daemon's members route, not guessed.** An answer is put in only if the composer still holds the exact text it was asked for.
- **Who spoke latest comes first,** and Self last.
- **A nick at the start of a line is followed by `ui.suffix`,** `: ` to start, and anything else by a space.
- **What is shown is announced** for a screen reader, such as `alex, 1 of 3`.

## Rendering

What an item shows, as data for a view to draw. `lineOf` gives a line, `quotedOf` the short quotation of what a reply answers, and `formatted` the runs of a text. Nothing in it is markup.

- **Formatting is data.** mIRC bold, italic, colours, and the rest become styles on runs.
- **A link is one of `http`, `https`, `irc`, or `ircs`.** Anything else, `javascript:` and `data:` included, stays text.
- **Hostile text is contained.** Controls show as symbols, and every bidirectional embedding, override, or isolate a run opens is closed at its end. The work is linear in the text, however hostile.
- **Plain text is for where nothing is drawn,** such as a notification: stripped, cut to 200 characters, and isolated.
- **A reply's quotation is one plain line:** its sender in their colour slot, how it was said, its text as plain text, and the position it stands at, for a view to go to. A Direct Message's `context`, the Channel it is about, is contained like any name.
- **A nick's colour is a slot, not a colour:** a hash of the nick as RFC 1459 folds it, one of 16, which a theme gives its colour.
- **One of our Messages says its delivery only while it is sending, or if it was not sent or was refused,** with the Ircd's code. Nothing is said once the Ircd confirmed it, nor of `Unconfirmed`, which is all a Message ever becomes where the Ircd does not echo ours. A refused action is a calm line of its own, such as `Your topic change for #iirc was refused (482)`.
- **A failed Connection names its Ircd, and hints when TLS looks wrong.** `mismatchedTls` decides from the item's structure: a plaintext Connection to 6697 that opened and ended before registration, or a TLS handshake that failed on 6667. No text is parsed.
- **Activity is a few words, marked** `-->` for a join, `<--` for a part, a quit, or a kick, and `--` otherwise, as WeeChat marks it. A standard reply shows its kind, command, code, context, and description as the Network gave them, and a `FAIL` takes the `Refused` tone. A CTCP request shows who asked for what, and the answer sent or why none was, and an answer that never left takes the `Refused` tone. One the Owner sent shows whom they asked for what, and a reply to their `PING` shows how long it took, in seconds to the millisecond, as the Daemon journaled the two, never by a clock the page reads. An answer to Self's `OPER` says whether Self is an IRC operator now, a refusal by its numeric in the `Refused` tone. A login says which account a User logged in to, and a logout that they logged out. A numeric shows its number dim in the senders' column, where a nick would be, and its parameters as one run of text in the `Numeric` tone, as plain as a Message's, with its links and formatting. An invitation says who invited Self to which Channel, then a `Join` part, an offer to join that Channel on its Network, which a view draws as a button that does what `/join` does when pressed.

## Previews

What a Frontend holds of Previews, as a reducer (`reducePreviews`) over what the view saw, what the Daemon answered, and what the stream of Previews said, and what each Message shows below it (`previewsOf`). It is `@iirc/frontend/previews`.

- **Nothing is asked for ahead of the screen.** A Message is asked for only once the view says it came into view, only once, and only while the stream is followed, so no change an ask starts is missed. `asksWanted` gives the asks to make.
- **A Timeline's mode is its own choice in `ui.previews.timelines`, else `ui.previews`** (`modeIn`), the shared values alone (`previewsModesOf`), since the Daemon acts on them. Under `off`, or before they are read, nothing of that Timeline's is asked for or shown, and the stream is followed while any Timeline's mode asks (`asksAnywhere`). `choosing` makes or removes one Timeline's choice in the map, which is sent whole.
- **A link the Daemon holds for a press is drawn as waiting,** the plain link and a press of its index (`pressOf`). The press's answer is folded in as an ask's is, and a refused press asks its Message again. A Message holding one is asked again once its Timeline chooses a mode that asks, which the Daemon fetches unpressed.
- **An item is held once, by its id,** so a change the stream gives updates every Message that shows it. An answer is taken only by the ask in flight, and never replaces an item the stream changed after that ask began.
- **A stream followed again asks again** for each Message still waiting on a Preview, since a Preview is not in the Journal and its stream resumes nothing.
- **Whether an image moves, and what a press of it does, are rules of the core.** An image that is not animated is always still. An animated one is as the Owner last pressed it, even where the device reduces motion, and until then moves only with `ui.previews.animate` on and no reduced motion (`motionOf`). A press opens a still image large, plays an animated one that is still, and stops one that moves (`pressOn`), so a moving one opens large only from its own control. The view reads the device's motion setting and passes it in.
- **What a Message shows is derived.** Before its answer, a placeholder for each link `previewableLinksOf` finds, so its height does not change once answered, and after it, each of those links with the state of its item as it is now, shared by every link with the same id: pending, ready as its summary line (`summaryOf`), description, and image, drawn whole for a link that is itself an image, or as a poster for a player's or a video's, and a page's as `ui.previews.style` says: none, and no description, on a `line`, a `thumbnail` with its description behind a press, or a `card` with its description shown below, with its `src` on the Daemon's own origin and its `alt` the title or else the link, and, only while the mode is `on`, its `media` for a video or a sound, a link that is itself one or a page that names a video file: its kind, its type, and a `src` on the Daemon's stream route, by the Message's Timeline and place, failed as the plain link with its reason in words (`reasonWords`), or waiting for a press. A link is an anchor only when it reads as one `http` or `https` link, and everything a stranger wrote is contained.
- **Folding is derived too.** `foldedOf` draws a Message's Previews as `ui.previews.folded` says: under `open`, each open; under `summary`, a ready one with more than its summary line folded to that line until it is pressed open, with its description then shown, and any other as it is; under `chip`, one `[+n]` until pressed, which opens them all. `opening` adds what a press opened to the set a view holds, which stays open.
- **A player is where it plays from, and what its frame needs.** Under `on`, a Ready Preview of kind `player` whose host `ui.previews.players` lists now gives `player`: the host of its address, contained, the words `plays from <host>`, its `size`, 16 by 9 when its page gave none, and `src`, its address with its host's autoplay query parameter set (`autoplay=1` for `www.youtube-nocookie.com` and `player.vimeo.com`, `auto_play=true` for `w.soundcloud.com`), and any other host's as it is. A view loads `src` only once the Owner presses play. Its image is the poster. Under `links only` it is its text alone, with no image and no player, and its summary is a page's. One whose host the list no longer names is drawn as a page at once, even from an answer held before.

## Activity

What is new, from the counts the Daemon keeps, and when marking a Timeline read is due (`markDue`), by the rule `ui.read` gives. It never counts items itself, since a window holds only some of them.

- **A level ranks what calls for the Owner:** Highlight, then Direct, then Message, then Activity. A Timeline's level is the highest with anything unread.
- **Activity is a dimmer name, never a number.** Counts and labels say what was said. The page's title counts only Highlights and Direct Messages.
- **A mark is due only for what the Owner can see:** a Pane that is shown, with the page visible and focused, and under `latest`, at the latest, as the view said.
- **A mark is never back, and never past what was shown.** It goes up to the last item the view named, even when the Daemon holds a later one.
- **A removed Network's Timelines are never marked, and call for nothing.** No Client moves their Read Markers, so what is unread there counts toward neither the title nor `/next-unread`.

## Removing a Network

`@iirc/frontend/removal`: the question asked before a Network is removed, as a reducer, `reduceRemoval`, over what the Owner chose and what the Daemon answered.

- **Nothing is removed until the Owner confirms.** Cancelling sends nothing, and a removal in flight is sent once and takes only its own answer.
- **The Timelines are kept unless the Owner chooses to drop them,** since kept ones can still be dropped later. A Network removed with them kept is asked about only to drop them, which frees its name.
- **What failed is said in words from the error's tag.** A removal that stands with its Credentials not all forgotten says so, and closes.

## Closing a Timeline

`@iirc/frontend/closing`: what closes a Timeline from its row (`closeOf`), and the offer to leave a Channel Self is in instead, as a reducer, `reduceLeaving`.

- **A Channel Self is in is never closed.** The Daemon decides as it steps the close, and its answer, refused as `Joined`, is what offers to leave it, and names the Channel it checked, so `@#iirc` offers and leaves `#iirc`, so a join just before the close is never missed.
- **Leaving is sent once, only once the Owner chooses it,** as the edit `/part` sends when the Network's Configuration wants the Channel (`leaveOf`), or it would be joined again, and as the `Part` action when it does not, which the Ircd put Self in or Self joined by hand, and which an edit would refuse. It does not close the Channel, since the part arrives in it.
- **Only a Channel's or a Direct Message's Timeline has a Target to close it by.** A Network's own, a Direct Message that no longer follows its partner, and a removed Network's have none.

## Notifications

`notificationsOf` says which items a change added call for a notification, and what it says.

- **Only what calls for the Owner, and only once:** a Highlight, a Direct Message, or an invitation said live, not ours, after its Read Marker, in a Timeline the Owner is not looking at. A step given twice notifies once.
- **Its words are plain text,** by `plainText`: the Timeline and Network, then the sender and text. A newer one for a Timeline replaces the last.

## Not yet

- **One Timeline in two Panes,** at two places, as WeeChat and tmux allow. A Pane opens what no other Pane shows.
- **A layout kept under `ui`,** shared by every device. It is kept per device, and a phone's screen shows one Pane at a time whatever it holds.
- **More options under `ui`,** such as overrides of the keymap. `keymapOf` is ready to read them, dropping what does not parse.
- **Chords in sequence,** such as `mod+k mod+o`. None of the defaults needs one, and `mod+k` alone opens the palette, so a sequence beginning with it would make the palette wait.
- **A divider for what came while the Owner was away from an open Timeline.** The divider is taken when a Timeline opens. One left open in a hidden page gathers unread items, which the counts show, but no divider until it is opened again.
- **Marking a detached Direct Message read.** No Target names it, so its counts stay until the API can mark a Timeline by its id.
