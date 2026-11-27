# @iirc/web

The web frontend: a React 19 view over `@iirc/frontend`, its pure core, built with Vite. It is a Frontend like any other, and reaches the Daemon only through `@iirc/api`, which the lint fence enforces. It is served on the API's own origin, by `iirc daemon --web`.

```sh
bun run build:web                                        # at the root: apps/web/dist
bun run iirc daemon --data-dir ~/.local/share/iirc --web=apps/web/dist
```

The core decides and this package draws and does the I/O.

## What it does

### Signing in

- **Signs in with a Key,** given once to `POST /api/sign-in` for a Sign-in the browser holds in an `HttpOnly` cookie. A failure is said in words, with a way to try again.
- **Sign out asks first,** in a dialog.

### The Sidebar

- **Lists the Networks and their Timelines as a tree.** A Network's row is its own Timeline, with its Channels and Direct Messages under it.
- **The first row, `iirc`, shows the Tail in the focused Pane,** and never shows anything unread.
- **A Network's row says how its Connection stands unless connected,** by a symbol whose shape and colour both say it. A screen reader hears it in words, connected too.
- **The focused Pane's Timeline is chosen in the accent.** One another Pane shows has a dim edge and that Pane's number.
- **A Network removed with its Timelines kept is listed apart, under Removed.**
- **Its foot has a row each for the search, the Uploads, and the options,** which open their view in the focused Pane, then Sign out. Where the pointer is fine, a row whose command the keymap binds shows its keys dim at its end.
- **The Sidebar is in the Owner's order on every device,** as `ui.sidebar.networks`, `ui.sidebar.order`, and `ui.sidebar.pinned` say.
- **Pinned Timelines are in a part of their own above the Networks,** under Pinned, each with its Network's name dim after its own.
- **A row dragged before or after another of its part moves it there.** A pinned row moves among the pinned, a Network's own among the Networks as removed as it is, and any other among its Network's. A line in the accent says where it goes, and a place where nothing would change takes no drop.
- **The keys move a row too.** ArrowRight reaches a drag button past the row's menu button, and `/move up|down`, or Mod+Alt and an arrow, moves the focused Timeline. Each part is a tree of its own, so the tree's keys stay within it.
- **Alt and an arrow go to the next and previous Timeline** in the order shown.
- **Every Timeline's and Network's row has a menu,** opened by a button that shows while the row is hovered or focused, always where the pointer is coarse, or by the context menu: a right-click, the menu key, or Shift+F10.
- **A Timeline's menu sets its own Previews,** `default`, `off`, `text`, or `on`, marking the one in force, as `/previews off|text|on|default` does.
- **A Timeline's menu also mutes it, pins a Channel's or a Direct Message's, saves it as text, and closes it,** each as its command does.
- **A Network's menu removes it,** with "Remove Network…", or, removed with its Timelines kept, drops them with "Drop Timelines…". A Network with no Timeline of its own yet has the menu too.
- **The Sidebar resizes, on this device.** Its edge drags, or takes the arrows, Home, and End once focused, and a double click puts it back as it began. It keeps its width as the window changes, and is never drawn wider than half the window.
- **`/sidebar`, Alt+N, or the button at its foot hides it,** and the focus goes to the Composer if it was in the Sidebar. While it is hidden, a button before the Composer's prompt brings it back, marked by what is unread.

### What is unread

- **A row's name is coloured by the highest level unread in it,** with small counts beside it.
- **The page's title counts Highlights and Direct Messages.**
- **A Highlight's line is tinted, and a "new" divider stands before the first unread item.**
- **Marks read as `ui.unread.markRead` says on this device,** once what the Owner has seen has held for a second in a Pane they can see. Under `latest`, the default, a Timeline is marked at its latest. Under `shown`, it is marked up to the last item on screen, scrolled up or not.
- **Under `asked`, only `/read` marks a Timeline read.** Nothing is marked until this device or the shared options say which rule holds.
- **Names the Timeline by its id to mark it read,** so a detached Direct Message and a removed Network's kept Timeline clear their counts too.
- **The Daemon keeps the Read Marker,** so every Frontend sees the counts clear.
- **Mutes a Timeline,** from its row's menu, or with `/mute` and `/unmute` for the focused one, a Network's own too, as `ui.unread.muted` says on every device. More than 256 is refused in words.
- **A muted row counts only its Highlights.** It is dim and in italics, with a quiet `∅` after its name and `muted` in its label.
- **What a muted Timeline holds leaves its Network's row, the page's title, and `/next-unread`,** but for its Highlights, which still mark and notify.
- **Quiets bots under `ui.unread.quietBots`,** shared by every device. What a bot said leaves the counts, the page's title, `/next-unread`, and the "new" divider, while a bot's Highlight still counts, marks, and notifies. It is off until the options are read.
- **Notifies after `/notify on`,** of a Highlight, a Direct Message, or an invitation in a Timeline the Owner is not looking at. Under `ui.unread.quietBots` a bot's Message notifies only as a Highlight.

### A Timeline

- **Shows a Timeline live, as terminal lines:** the time, the sender in their colour, and the text with its formatting and links.
- **A name in a Message's text that the Client found to be a User is drawn in that nick's colour,** as a search result's text is, unless the sender's own mIRC colour covers it.
- **Lays its rows out as `ui.conversation.layout` says.** `columns`, the default, puts the time and the sender in columns every row shares. `inline` makes each row one run of text that wraps under itself.
- **`stacked` puts a run of one User's Messages under one head,** the nick in their colour and the time, each Message's text on a line of its own. Everything else is drawn as `inline` draws it.
- **A later Message of a stacked run shows its own time while its row is hovered or focused,** and a screen reader reads it.
- **Rows stand `ui.conversation.spacing` apart,** a multiple of the text's size, 0.3 to start, apart from the line height. At 0 they touch. A Highlight's tint and the rule after the nick column cover the room, and a stacked run's head keeps a little more above it. The last row stands as far from the Composer, and never nearer than half the text's size.
- **A Message's sender stands in `<` and `>` while `ui.conversation.nickBrackets` is on,** as it is to start, in columns and inline. Off, only those go: a `NOTICE` keeps `-nick-` and an action `* nick`. A stacked run's head has none either way.
- **A Message's sender has the prefix it held before their nick while `ui.conversation.nickPrefix` is on,** as it is to start, dim as a member's symbol is, inside any brackets, for a `PRIVMSG`, a `NOTICE`, and an action, in each layout, a stacked run's head included. It is no part of the nick, whose colour, menu, and focus are as without it, and it counts toward the nick column's width. A sender who held none has nothing drawn.
- **The nick column is `ui.conversation.nickWidth` characters wide,** each as wide as the font's `0`, in any font. A longer nick is cut with an ellipsis. A thin rule stands after it, unbroken down the rows.
- **The rule after the nick column drags, or takes the arrows, Home, and End once focused,** as the Sidebar's edge does, and resizes every row's nick column as it moves. Letting go, or each key, writes `ui.conversation.nickWidth` in whole characters, this device's own where it overrides the option, else the shared one, and the Composer says why if it is refused. A drag the browser cancels writes nothing. While the rule is dragged the rows stay in columns, and a drag across the log selects and scrolls nothing. A Timeline drawn inline or stacked has no grip.
- **A Timeline reads as `inline` where `columns` would leave its text fewer than about thirty characters,** from its first frame, as a Pane split a few times, or a phone, does, and again at once as the font, the text's size, the time's format, or the nick column changes.
- **Activity is dimmer than what was said.** An Ircd's numeric replies are not.
- **A run of joins, parts, quits, and changes of nick is one dim line** that says how many and who. A press opens it to each one's own line, and closes it again. A netsplit or a netjoin is likewise one dim line that opens to its nicks.
- **Connections that fail again and again are one row,** with how many and when the first and the latest were.
- **An Ircd's message of the day is one dim line** that says how many lines it has, and that it was cut short if it was. A press, Enter, or Space opens it to a block in the monospace font with every space kept and no line wrapped, which scrolls sideways within itself.
- **A `FAIL` is set apart as a refusal is.**
- **A Gap is a divider, and so is a change of day.** The day is written as `ui.conversation.dateFormat` says in the device's time zone, even under `ui.conversation.timeFormat` `none`, and a press on it starts `/date` for that day in the Composer.
- **Our own Messages say only when they are sending, not sent, or refused.**
- **A reply says what it answers in one dim line above it,** `↳ alice: the first of their text`, cut to the line's width. Pressing or activating it goes to that Message, as a jump from the search does.
- **A reply that answers nothing the Timeline holds is an ordinary Message.**
- **A Direct Message that names a Channel it is about says `in #chan`, dim, after its text.**
- **Opens at the latest, stays at the bottom as items arrive, and reads older items as the Owner scrolls up.**
- **A view that cannot scroll reads older pages on its own,** as when the latest page is all hidden Activity, up to the window's cap. Past that, "Load older" asks on purpose.
- **Read back to its start, it draws nothing above its first line,** and tells only a screen reader that nothing is before it.
- **Bounds how wide a Timeline's text runs by `ui.conversation.maxWidth`,** from 40 to 400 characters, each as wide as the font's `0`, so the bound grows with the size. At `none`, the default, text runs the width of its Pane.
- **A Pane narrower than the bound is drawn as without one.** The Composer and the Sidebar are never bounded.

### Previews

- **Previews a Message's links while its Timeline's mode is `text` or `on`,** its own in `ui.previews.conversations` or else `ui.previews`. Each is a card under the text, with room above and below, and each is updated in place from the stream of Previews.
- **Each of a Message's first three previewable links has a toggle right after it,** in every layout: a drawn caret, the same size in any font and centred in its focus ring, which stands clear of the link's last letter, and a button the keyboard reaches, which says whether its Preview is open. Only the text's own space follows it, and its press reaches over that, away from the link. A closed Preview draws nothing and takes no room.
- **A Preview starts open or closed as `ui.previews.start` says,** `open` unless set. What the Owner opened or closed is kept while a row scrolls away and back, and forgotten when the page is loaded again.
- **A row whose Previews the Daemon already holds is drawn whole the first time.** What the Daemon holds is read with each window, before its rows are drawn, and fetches nothing.
- **A Message is asked for only once it is within a screen's height of the view, and only while one of its Previews is open.** So opening one is the ask, with a placeholder until it is answered, and a Message whose Previews are all closed fetches nothing.
- **Opening one of a Message's Previews fetches its other links too,** which stay closed until opened.
- **In a Direct Message with no mode of its own, Previews start closed.** A link the Daemon holds opens at once, and opening one it does not hold presses it, so the Daemon fetches that link alone. A Direct Message set to `text` or `on` follows `ui.previews.start`.
- **Under `off` nothing is asked for or drawn,** and no toggle is drawn before the modes are read.
- **A card is never wider than 34em, nor than its Pane,** and nothing in it overflows a narrow Pane or a phone.
- **A Preview pulses in its card's place while it is fetched,** in a collapsed card's shape.
- **A card with a title or a description is a link card, collapsed or expanded,** and starts collapsed. Collapsed it is one row on a quiet surface. With a thumbnail it is three lines of its text tall whatever it holds, so every one is the same height under any font, size, or line height; with none, it is as tall as its words, three lines at most. Its title takes one line and its description two, or either alone all three. Neither the site's name nor the host it was read from is drawn.
- **A collapsed card's thumbnail is a square as tall as the card, flush at its start,** while `on`: its picture cropped to fill it, keeping the top, an animated one still at its first frame; or the poster of what plays under a play glyph; or the glyph alone for what plays with no poster. A card with no media has no thumbnail, and its words take the whole row.
- **Expanded, a card is its words whole, then its media under them, inset alike,** a picture at its own shape and the rest in the box it plays in. Collapsing it again stops whatever played.
- **A picture its page calls a thumbnail is never drawn larger,** as the Preview's `thumbnail` says, which a profile picture beside a post's text usually is. It stays the card's thumbnail once expanded, beside the words, and alone gives the card nothing to expand.
- **A card has one switch, a button in its top trailing corner on its title's line,** its chevrons as far from the card's top edge as from its trailing one, in the same place collapsed and expanded, which says whether the card is expanded. A click anywhere on a collapsed card expands it too, and on an expanded one collapses it, except on its media or a control, or a click that ends a selection of its text. A card with words that fit and no media to draw under them has neither.
- **Expanding a card plays nothing,** except from a thumbnail that plays, whose press expands the card with the video, the sound, or the player already playing. Media the Daemon answers anew waits for a press of its own.
- **What the Owner expanded is kept while a row scrolls away and back,** and forgotten when the page is loaded again. What was playing is not kept.
- **A picture that fails to load, as a thumbnail or expanded, leaves the card its words,** and a video or a sound that fails to play does too. A poster that fails leaves the play glyph, which still plays.
- **A description's line breaks are drawn as breaks,** so a text file's first lines are drawn as lines, and every word is text, never markup.
- **Under `text` a card is its words alone.**
- **A link that is itself an image, a video, or a sound is a media card, its media alone,** flush with the text, on no surface, with nothing to expand. Its media rests until pressed.
- **A link to a file is its file name,** with its first lines when it is a text file, or else its type and size, under `text` as under `on`.
- **Media is at most as tall as `ui.previews.mediaHeight`,** 160, 260, or 400 pixels.
- **A sound, and a video with no poster, is the browser's own player,** which fetches nothing from the Daemon until play is pressed. A video has a control in its corner that opens it large.
- **A page that names a video file streams it only once play is pressed,** on its thumbnail or on its poster in the expanded card. The control in its corner opens it large, playing there and pausing here.
- **Play pressed from the keyboard takes the focus to what it starts,** the video or the player's frame. A pointer's press leaves the focus where it was, so a key typed next still reaches the Composer.
- **A player from a host `ui.previews.players` lists plays from its thumbnail,** which is named for where it plays from, or from the play button over its poster in the expanded card, or alone with none, whose name and hover say the same.
- **Nothing loads from a player's host until it is pressed to play,** which draws the player, already playing, in a sandboxed frame in its card. The frame can run scripts and open a window of its own, and nothing else of the page.
- **A poster, the video it plays, and the player it plays share one box,** at most as tall as `ui.previews.mediaHeight`. It is shaped as the player's page gave its size, else as the poster's own dimensions, else 16 by 9, so pressing play moves nothing below it, and a poster that fails leaves its video a box of the same size.
- **An image is the Daemon's own copy,** loaded only once it is within a screen's height of the view.
- **Where the Daemon read an image's dimensions, its box is reserved before a byte loads,** within `ui.previews.mediaHeight` and the room it has and never larger than the image, and stays the same once it has loaded. Where it did not, a placeholder stands until the image has loaded, which is then drawn at its own size within the same limits, or, with no size of its own, as an SVG with only a `viewBox`, as large as they allow at its own proportions.
- **A link that is itself media that fails leaves nothing,** and its row takes no room.
- **A press of a still image in an expanded card or a media card opens it large over the whole screen,** as the pointer over it says, with a link to its page. Escape or a press anywhere but the link closes it, returning focus to the image.
- **A video's larger view leaves a press on the video to its player,** and closes from a control in its corner, a press on the dimmed screen around it, or Escape.
- **The control that opens media large and the one that closes a video's larger view are the same square,** a finger's size on a touch screen, with their icon in the middle in any font.
- **An animated image is its first frame under a play badge,** which a press plays in place and stops, with a control to open it large while it plays.
- **An animated image plays on its own under `ui.previews.animate`,** on unless set, unless the device reduces motion.
- **A Preview that failed is one quiet line,** "No preview:" and why, and never the link again. In a Direct Message with no mode of its own, the line is a button that says to try again, and a press of it presses the link, so the Daemon fetches it again.

### Panes

- **Splits into Panes, as a tiling window manager does.** Each has its own status bar, Timeline, scroll position, and members.
- **One Composer under the Panes writes to the focused Pane's Timeline.**
- **Among several Panes, the focused one is edged in the accent along its top and bottom,** and the others' names are dimmed.
- **A Pane with nothing open shows the Tail, and takes commands only.**
- **The options, the Uploads, and the search stand in front of a Pane's Timeline** until something else opens in that Pane, or Escape shows what it showed before. They have no close button. A Direct Message not yet begun has one at its bar's right.

### Who is here

- **A Pane's status bar is one line:** its number among several, the Timeline's name, and for a Channel its modes and its topic cut to the line, and the members' toggle, which says how many there are.
- **A Direct Message's bar says whether its partner is online or offline,** and nothing while it is not known.
- **A press on the topic discloses it in full under the bar.**
- **The toggle, `/members`, or Alt+M shows the members under the bar, by rank.** A press, a tap, or Enter on one opens the menu on their nick, Query first, so Enter twice opens their Direct Message.
- **The members beside a Timeline are `ui.members.width` characters wide,** each as wide as the font's `0`. Over a narrow Pane they are as wide, up to four fifths of the Pane, and on a compact screen they are a sheet the screen's width. A longer nick is cut with an ellipsis.
- **The edge of the members beside a Timeline drags, or takes the arrows, Home, and End once focused,** as the Sidebar's does, and writes `ui.members.width` as the nick column's rule writes its option. Over a narrow Pane and as a sheet they have no edge to drag.
- **A member's menu says, dimly, `account` and the account they are logged in to, or `logged out`,** and nothing while it is not known.
- **A Pane narrower than 600px shows its members over its Timeline, never beside it.** There the toggle opens them for that Pane alone, and Escape, a press elsewhere, or choosing an action puts them away. The device's choice of a column covers only the Panes wide enough for one.
- **A User known to be a bot has a dim, small `bot` after their nick,** as a member and beside the sender of a Message they said, and the row's label says it too. A fact gone stale or never learned marks nothing.

### Menus on Messages and nicks

- **A Message has a menu where its Network's Session carries tags and the Message has an id,** and nowhere else. A button at the row's end opens it, shown while the row is hovered or focused and always where the pointer is coarse, as does the context menu anywhere on the row but its nick.
- **Reply, from a Message's menu, focuses the Composer,** which shows `↳ alice: their text` dim above its line, cut to its width, with a button that drops it. Escape drops it too when there is no notice to dismiss.
- **Only the first Line of what is sent answers the Message replied to.**
- **A nick has a menu as a Message's sender, in an Activity's words, as a member, and on a Lookup card.** A press, Enter, the context menu, or a long press on a touch screen opens it, and a long press shows no callout of the browser's.
- **A nick's menu offers Query, Whois, Mention, and Ignore.** Mention starts the Composer's line with their nick, and the others run their command.
- **In a Channel where Self holds operator or a rank above it, a nick's menu also offers ban, kick, op, deop, voice, and devoice,** and ban account where the Network's bans name an account, each only where the Composer would run it.
- **A nick's menu acts on the Channel of the Pane it was opened in,** which opening it focuses.
- **It offers none of op, deop, voice, devoice, or kick until the User is found in that Channel,** read as the menu opens, and never deop, devoice, or kick of a member who outranks Self. Until it is read, a dim `reading…` that cannot be chosen stands where they will go.

### Saving and closing a Timeline

- **Saves a Timeline as text,** from its row's menu or `/export [since] [until]`, as a file the browser downloads. A day given is placed in the Owner's time zone.
- **Closes a Timeline by its id,** from its row's menu or `/close-conversation`, a detached Direct Message and a removed Network's kept Timeline too. It leaves the Sidebar as the close is asked, and comes back, with why, if the Daemon refuses it or the request fails.
- **A closed Timeline is out of the Sidebar until something arrives in it.** `/go` and the search still find it, and it shows in the Sidebar while a Pane has it open.
- **A Channel Self is in is never closed.** A dialog offers to leave it instead, by the edit of its Network's Configuration that `/part` sends where the Configuration names it, and otherwise by parting it. Signing out lets the offer go.
- **Leaving a Channel does not close its Timeline,** since the part arrives in it as Activity.

### The Composer

- **Enter sends and Shift+Enter starts a new line.** Under `ui.input.enter` `newline`, Enter starts a new line and Mod+Enter sends, with a send button beside the Composer.
- **Up and Down recall what was sent.**
- **A draft of more than five lines asks before it is sent.** A blank line does not count.
- **Spelling is checked unless `ui.input.spellcheck` is off.**
- **Why something was not said is shown under it,** with a way to dismiss it, and to send or check again when that is safe. It goes when it stops being true.
- **Mod+Shift+K, or `/format`, opens the formatting list above the line:** a row of the formats, each its letter, B, I, U, M for fixed pitch, R for reverse, and S for strikethrough, marked while the selection has it, a row of the default and the sixteen colours for the text, and a row of the same for its background, each row of colours named before it. A format's letter turns it over, the arrows and Enter choose any item, as a press does, and Escape puts the list away. One choice is made each time it opens, on the selection, or with nothing selected, on what is typed next, which is named beside the prompt until then. No format has a key of its own, so Mod+R reloads the page wherever the focus is.
- **The draft is drawn with its formatting,** and what is sent is IRC's formatting codes. In a font named as monospace it is drawn as a Timeline draws it. In any other font, a family the device has among them, bold is a stroke of the text's own colour, italic a dotted line under the run, and fixed pitch only its tint, so every letter stays where the caret expects it.
- **Takes what is typed from anywhere.** A character, a dead key, or a paste where nothing takes text, such as a Timeline, the Sidebar, or the members, goes to the Composer, which takes the focus with that very key. A dialog, a popover, a menu, and a key the keymap binds keep their keys.
- **Takes keys from anywhere on the page by the core's keymap.** A key the keymap does not take goes on as it would.

### Completing

- **What the Composer can complete is listed just above its line,** ranked as the Owner types, the Panes giving it room. On a phone the list is bounded so the Composer stays in view, and scrolls.
- **A draft that starts with `/` lists the commands and the Owner's aliases,** each with what it takes, what it does, and its keys, those run recently from the Composer first.
- **An alias is shared by every device,** made with `/alias add` and taken away with `/alias remove`.
- **After a command, the list offers what it takes:** an option after `/set`, a Channel after `/join` or `/part`, an alias after `/alias` or `/alias remove`, a Timeline of any Network after `/go`, a theme after `/theme`, a font or a family typed by name after `/set ui.font`, and a Network, a removed one too, after `/network remove`. Each says what it is and what is in effect.
- **An emoji is offered once a word is `:` and two letters of its name,** drawn and named as `:smile:`. The names load the first time one is typed, never with the page.
- **Tab completes a nick or a Channel,** a nick at the start of a line followed by `ui.input.nickSuffix`, `: ` unless set.
- **Tab, Shift+Tab, and, while the list is open, Up and Down move through it,** writing the one highlighted into the draft. A press on one writes it in, and Escape closes the list and gives back what was typed. Enter sends what the draft says.
- **Mod+Shift+P starts `/` and Mod+K starts `/go `,** with the list open, in the focused Pane's Composer. Either works from anywhere on the page, a Pane with no Timeline included, and from inside an option's editor, which it commits nothing of. `/go` lists every Timeline, closed ones too.
- **Where the pointer is coarse, a button beside the Composer starts `/` too.**
- **A draft already there when a command is started is set aside,** never sent and never recalled by Up. It comes back when the command runs, or when Escape puts the command away, one press and the list with it.
- **`/theme` alone leaves `/theme ` with the themes listed,** and `/set` lists the options as configured when it was started.
- **A `/set` of a `ui` option writes to this device** when this device overrides it, or when the value is a font family only this device has, as the options view does.

### Uploading

- **Uploads files from the Composer,** several at once: pasted, dropped on it, chosen with its picker, or, where the button that starts a command shows, taken with the camera.
- **Each file shows above the line as it is added,** with its name, its size, how much was sent, a preview of its own bytes for an image every browser draws, and a button that cancels it.
- **While Uploads are off, nothing goes in,** and a note names the options to set, with a way to the options.
- **A file over `maxSize` is refused before it is sent,** with the limit.
- **A kept file's link goes into the draft where the caret was when it was added,** whatever was typed meanwhile.
- **A draft is sent only once its files are uploaded.** It waits, saying so, and names the files still uploading.
- **A kept file stays listed with its link until the draft is sent or it is dismissed.** It renames in place, Enter saving and Escape cancelling, which puts its new link in the draft wherever the old one stands.
- **A failure is said in words until dismissed.**
- **Signing out lets go of every upload.**

### Searching

- **Searches the Messages of every Timeline on Enter,** newest first, in front of a Pane's Timeline.
- **Choosing a result opens its Timeline read around it,** which under `ui.unread.markRead` `latest` marks nothing read.

### Users, Channels, and Lookups

- **`/query` opens a Direct Message by nick.** While nothing has been said, the Pane shows a Direct Message not yet begun, and the first Message makes its Timeline.
- **`/whois` and `/whowas` look a User up,** and `/bans`, `/exceptions`, and `/invexes` look up a Channel's lists, each as a card under the Pane's status bar.
- **While Self is an operator in the Channel, each mask on a card has a button that removes it.**
- **A ban by account shows as a dim `account`, the account, and its mask, dimly.**
- **`/ctcp <nick> <command> [text]` sends a CTCP request to a User,** and `/ping <nick>` shows how long the reply took. The request and its reply show in the Network's Timeline, and in the User's Direct Messages when those exist.
- **An invitation in the Network's Timeline has a button that joins the Channel,** as `/join` does. Nothing joins until it is pressed.

### Options

- **Changes Configuration as an option tree,** by `/set` and its kin or in the options view, which edits each option in place.
- **The options view gives each option two lines:** its name and value, then, dimmer, its description with its default at the end, as `default: 14`.
- **The options are under a heading for `ui`, each Network, and each of the Daemon's own roots,** such as `store`, in the order of their names. A heading stays at the top while its options scroll under it.
- **The arrows move from option to option,** across the headings.
- **A list's value wraps between its elements,** each kept whole where it fits.
- **An option whose kind lists its choices opens a menu of them under its value,** the one in force marked and focused. The arrows move, Enter chooses as `/set` does, and Escape lets it go.
- **Where an option with choices also takes text, its menu ends in "Custom…",** which opens the editor and marks a value that is none of the choices.
- **A Credential is given only in a password prompt.**
- **Shares the options under `ui` between devices,** and lets one override them with `-device`.
- **Lists and sets the Owner's options beyond `ui`,** under `store`, `uploads`, `previews`, and `away`, as it does any other. No device overrides them.
- **Another device's change of an option beyond `ui` shows** while the options or the Uploads show.
- **Removes a Network after asking,** from `/network remove` or its row's menu, in a dialog that asks whether its Timelines stay readable. They are kept unless the Owner chooses otherwise.
- **A Pane showing a kept Timeline says its Network was removed,** with a button that asks to drop them, and its Composer says nothing can be said there.
- **Adding a Network under a name still held by kept Timelines says why it cannot.**

### Themes and fonts

- **Draws in themes made from terminal palettes,** built in or imported from a theme file.
- **Under `system`, the page draws the theme for light or the one for dark,** and follows the device the moment it changes.
- **A theme highlighted in the Composer's list, or being imported, previews on the whole page.**
- **A theme file that takes more than a second to read is refused in words.** A browser that cannot start a Worker says so.
- **Draws text at `ui.font.size`,** from 10 to 24 pixels, 14 to start, and `ui.font.lineHeight`, a multiple of the size from 1 to 2, 1.45 to start.
- **`ui.font` is the device's own monospace or sans font, one of nine the page serves, or any family the device has, by name.**
- **A family the device lacks draws in its own monospace font,** and the options say it was not found on this device.
- **A font highlighted in the Composer's list previews on the whole page.** A change draws at once, a shared one before the Daemon has answered.

### The Tail

- **Shows the Tail in iirc's own view, labelled `iirc`,** in a Pane with nothing open, or in the focused Pane from `/logs`, the palette, or the Sidebar's `iirc` row.
- **A banner stands above the oldest line and scrolls with the lines:** `iirc` drawn in blocks in the monospace font, the Daemon's version under it, and, while no Network is configured, how to start.
- **The lines shown are those at the level `ui.logs` names and above,** Info unless set, oldest first.
- **Each line is its time as `ui.conversation.timeFormat` says, its words, its annotations as `name=value`, dimmer, and its cause,** a line of text for each of its lines.
- **A line at Warn and above is in the theme's colour for danger.**
- **Everything a line holds is drawn as text,** its controls as symbols, never as markup.
- **The view stays at the latest line while the Owner is there,** as a Timeline does.
- **At most 4096 lines are held,** followed while a Pane shows the Tail.
- **After the Daemon restarts, the view shows the new Tail from its start.**
- **A change of `ui.logs` on any device shows at once on every one,** a lower level showing the lines already held, each where its time puts it.

### The Uploads

- **Lists the Uploads in a view of their own,** opened by `/uploads` or its row in the Sidebar in the focused Pane, and shown in one Pane at most.
- **The Uploads are listed newest first, a page at a time with "More",** saying it is reading until the first page is.
- **A row lies on one line where the Pane is wide:** a thumbnail or an icon, its name, type, size, and when, where it was said, and its buttons.
- **A PNG, JPEG, GIF, WebP, or AVIF is a thumbnail,** fetched only near the screen. Any other type is an icon.
- **Where it was said is each Network and Target of a Message of ours that held its link,** newest first, which goes to that Message in its Timeline when pressed.
- **A row's buttons copy its link, rename it in place, and delete it.** Enter saves a rename and Escape cancels it. A delete asks first, in a dialog that says its link stops working at once and a copy already opened cannot be called back.
- **A rename or a delete that fails says why in its row.**
- **The link is made from `uploads.publicUrl` in force,** so a new public URL changes every link copied from then on. With none set, the view says there is no link to copy.
- **Another device's Upload, rename, or delete shows without a reload,** and where an Upload was said shows as soon as the Message is folded.
- **An Upload whose bytes the Daemon found gone from the Store shows an icon and `missing` in red,** and offers only rename and delete.
- **"Show deleted" lists the deleted and the expired too,** reading the list again from its first page. Each is muted, says `expired` or `deleted` and when, shows an icon, and has nothing to copy, rename, or delete.

### The page

- **Says across the top of the page when the Daemon stopped folding the Timelines:** that it hit a fatal error, that the Timelines stay behind until it restarts, and why. The notice goes once the Daemon, restarted, folds them again.
- **A screen 640px wide or less shows the focused Pane alone,** under one slim bar holding the Sidebar's button and the Panes' switcher, with the Sidebar as a drawer and the members as a sheet.
- **The browser's Back closes what Escape closes, the topmost first,** on any screen: the drawer, the sheet, the members over a narrow Pane, a Lookup card, a dialog, a Preview's larger view, or a menu. Each takes one entry in the history as it opens, with the same URL, and gives it back however it closes, so with nothing open Back leaves the page.
- **Where the pointer is coarse, every control is at least 44px and every field's text at least 16px,** so iOS Safari does not zoom into it.
- **Pinch zoom is never turned off.**
- **Installs as an app,** from its manifest, and opens on its own without the browser's bars. Installing needs a secure context, so a Daemon reached other than on `localhost` needs TLS in front of it. An app installed on iOS holds a Sign-in of its own, apart from Safari's.
- **The browser's bar, or an installed app's, is drawn in the theme's background,** light or dark as the device prefers until the theme is known.

## How it is built

| Folder | Holds |
| --- | --- |
| `src/app/` | The shell, the one Effect runtime, the Daemon's client, how intents are named, and whether the Daemon still folds the Timelines |
| `src/sign-in/` | The sign-in screen, Sign out, and their commands |
| `src/timelines/` | The Timelines' atoms, the changes stream, the layout kept, the Sidebar, closing a Timeline, saving one as text, and the Timeline view |
| `src/panes/` | The Pane tree, drawn with `react-resizable-panels`, and how wide each Pane is |
| `src/composer/` | The Composer, what carries out its intents, its list of completions, and uploading files through the `Uploader` port |
| `src/options/` | The options view, changing a Configuration, holding a Credential, removing a Network, the options under `ui`, `store`, `uploads`, and `previews`, the widths a drag holds and writes, and the Uploads view |
| `src/search/`, `src/channel/`, `src/lookup/`, `src/tail/` | Each of those views and its atoms |
| `src/keys/` | The keymap the page holds, and the one key listener |
| `src/nick/` | The menu on a nick, and its atoms |
| `src/previews/` | A Message's Previews and their atoms |
| `src/reading/`, `src/notifications/` | Marking read, the page's title, and the `Notifier` port |
| `src/page/` | Whether the Owner can see the page, what this device keeps, what lies over a compact screen, the history entries Back closes overlays by, and the Sidebar's width and whether it shows |
| `src/theme/` | The theme and the text's size and font drawn, the fonts, importing and removing themes, and the Worker a theme is read in |
| `src/ui/` | The theme's tokens, the one family of buttons with their tooltips, the icons, a password field that holds no value, the grip on a width the Owner drags, the modal overlay and popover every overlay is, and dates |
| `src/testing/` | The fake Daemon, the test ports for uploading, notifying, and downloading, and the history Back is pressed in |

### The runtime

- **One Effect runtime.** It provides `DaemonClient`, `HttpApiClient.make(DaemonApi)` over the browser's `fetch` with relative URLs, so every request goes to the origin that served the page and carries its cookie. A test replaces its Layer.
- **State lives in atoms, not components.** Each atom holds one of the core's states, and everything else is derived from it. Components read atoms and run commands, and none fetches.
- **The core decides what to do, and the runtime does it.** Loops mounted once in `src/main.tsx` run while the browser is signed in. Each does what the core asks for and folds the answer back in as an event:

  | Loop | Does |
  | --- | --- |
  | `sync` | Makes the reads `wanted` gives, follows the changes stream, and keeps the layout |
  | `uiSync` | Follows the options under `ui`, which the shell waits on after each sign-in, and forgets them on signing out |
  | `optionsSync` | Reads every Network's Configuration and the Credentials held each time the options come to show |
  | `ownerSync` | Follows the options beyond `ui` while the options or the Uploads show |
  | `uploadsSync` | Reads the Uploads while a Pane shows them, again when "Show deleted" is switched, follows their Changes, and which Uploads' bytes are missing |
  | `uploadsSignedOut` | Lets go of every upload, aborting its request, on signing out |
  | `channelSync` | Reads the head of each Channel the Sidebar lists, a Pane shows, or a Lookup card lists, and the members of each shown |
  | `marking` | Marks read what `markDue` says, after a second |
  | `previewsSync` | Follows the stream of Previews while any Timeline's mode asks, and makes each ask the core gives once it is followed |
  | `completer`, `chantypesSync` | Ask for the nicks and the `CHANTYPES` that completion needs |
  | `emojiLoader` | Loads the emoji names once completion first reaches an emoji |
  | `draftsCarried` | Carries what was typed under an unsent Direct Message to its Timeline's Composer once the Timeline exists |
  | `lookupSync` | Lets go of the Lookup cards of Panes that are gone |
  | `nickMenuSync` | Reads whether the User of the menu open on a nick is in its Channel, from the members route and `known` |
  | `watchPage`, `watchTheme`, called once as the page starts | Keep whether the page is seen and compact, the title, and the theme on the root |

- **A read that fails is asked again,** soon and then up to every 15 s. `Unauthorized` signs the page out. Every failure is decided from the API's structure, never a response's text.
- **One changes stream for the whole page.** It is followed from the place the core holds, and followed again when it ends or gives nothing for 45 s. A reload reads everything again.

### Saying and changing

- **Nothing is sent twice.** A Say, an Act, or a Lookup is made under an intent the runtime names, `web-` and a random UUID. After a failure the runtime asks `said` under that intent, and the Composer offers to send again only when the Daemon says it was not journaled. After no answer at all, it offers only to check again.
- **Submissions go one at a time,** in order, and a failure stops the intents after it. What only changes the page, such as opening a Timeline or starting a command, is done at once and never waits behind a Say.
- **Our own Message appears once, when the Daemon folds it,** never drawn ahead. What became of it is its item's delivery.
- **A change is made from the value in force, never the one shown.** A change of Configuration, of an option under `ui` or beyond it, or of the themes applies the core's edit to what was read and sends the whole with `ifSequence`.
- **A conflict is tried once more,** reading again and applying the same edit. A second conflict is said in words.
- **A Network's changes are made one at a time,** each once the one before it is answered, so an unset made while its set is unanswered reaches the Daemon.
- **`/msg` opens where the Daemon put its Message.** Once the changes say its step was folded, the runtime reads which Timeline it was placed in, and never matches a name itself.
- **A file is sent by `XMLHttpRequest` through the `Uploader` port,** each file in its own fiber, so cancelling one aborts its request alone. Its answer is read with the API's own Schemas, and a refused sign-in signs the page out.
- **A Credential's value goes straight from the password prompt to the Vault,** and the option is then pointed at it, or set to its name under `store`.
- **A Credential typed into the Composer is refused,** and the textarea cleared, as Enter is pressed.
- **A Lookup has one deadline,** two minutes from when the Owner asked. Until then a pending one is asked after by its intent.

### Drawing

- **One key listener for the page.** `Keys` listens on the document after every widget's own handlers, asks the core's `resolve`, and prevents a key's default only when a binding took it.
- **A key that types is taken before any widget sees it,** in the capture phase. The Composer's textarea takes the focus with its caret at the end, and the browser types the character, or pastes, into it.
- **The core owns the Panes, and `react-resizable-panels` only draws them.** Only a change the Owner made goes back to the core.
- **A split or a swap never draws a Pane's content afresh,** and the Timeline view puts back the scroll position a move loses.
- **A row's layout follows its Timeline's own width,** never the screen's. Nothing in a Timeline scrolls sideways: a row breaks what has no place to break, and the view clips what is left.
- **No width counts characters.** The time column, the Composer's prompt, and a Pane's choice in the switcher are sized from samples drawn in the font, and the nick column and the members' column in the font's own `0`, so every row lines up in any font.
- **The Timeline view is TanStack Virtual's,** with only the rows near the view in the page.
- **The first row whose top is in view stays still** as rows are added above, dropped, hidden by `ui.conversation.activity`, or wrapped again at a new width or text size, and a view at the latest stays there.
- **A window's held Previews are read before the window is drawn.** A held read that fails, or is not answered within `Waits.held`, is let go of, and the window is drawn all the same.
- **The view tells the core what the Owner has seen:** whether it is at the latest, and the last item in view.
- **Only a scroll the Owner made moves the view off the latest,** never one the view made itself or one the browser made as the log's box changed. So a Timeline opened at a search's result is not at the latest until the Owner goes there.
- **The theme, and the text's size and font, are custom properties on the root, set through the CSSOM.** `src/ui/theme.css` gives each colour as `light-dark()`, and the defaults' size and font, for the first paint.
- **A font is fetched only once text is drawn in it,** and only the files for the characters on the page. The device's own font fetches nothing.
- **Each font is a file of the page's own,** never inlined, which `font-src 'self'` would refuse.
- **While a font loads, if it never does, and for any glyph it lacks, text is in the device's own font of its kind,** monospace or sans.
- **Text a sender set in IRC's monospace formatting is in the font chosen when it is monospace,** and in the device's own monospace font beside a sans one.
- **A family typed into the options is set on this device alone,** and is drawn by name ahead of the device's own monospace font.
- **A family's name becomes CSS in one place, `familyCss`,** between double quotes, and the API's parse makes it exactly one family.
- **A family is found on the device by measuring text in a canvas,** in the family ahead of each generic family against that generic family alone.
- **A theme file is read in a Worker, never in the page.**
- **Styles are CSS Modules over the theme.** No module names a colour of its own, and each module's class names are declared beside it, so a class that does not exist fails to compile.
- **Every button is one of one family.** `Button`, `ToggleButton`, and `IconButton` come in four variants, bordered, primary, quiet, and as text, and two sizes, regular in a form and small in a bar.
- **A button's height is one line of its text, its padding, and its border,** never its container's, and its padding is in `em` and `ch`, so it keeps its shape at any text size. Only the topic and the tree's chevron are drawn otherwise.
- **An icon is a glyph in the UI's font, or a drawing in the text's colour,** named in `src/ui/icon.tsx`, drawn centred in a box as wide as two digits, and hidden from assistive technology. The icons drawn over media, `enlarge`, `close`, and `play`, are drawings, which sit the same in any font.
- **A button that shows only an icon is named,** and has a tooltip saying what it does and its key, where the keymap binds one.

### Nothing is drawn before it is known

Every view is held to three rules, and a review holds new work to them:

- **What a view needs is held before it can be opened.** What a view draws as it opens comes from what the page already holds, never from a read that opening it begins. A read as it opens may bring what is held up to date, never fill it for the first time. Until the shell has what it draws, the page draws a wait, in the theme's defaults.
- **A change the Owner makes shows at once.** It is derived in the core from what is in force and what is on its way, never kept as a second copy. Once the Daemon answers, what it holds wins, and a refusal draws what is in force again and says why. A Message is not such a change.
- **A wait that cannot be avoided is drawn as a wait.** What is not known yet draws as on its way, or as nothing only where nothing cannot be read as the answer, never as a default, an empty list, "none", or "not connected". In the core, not known is a case of its own.

### What this device keeps

Each is in `localStorage`, read once as the page starts and written as best it can be.

| Key                  | Holds                                                       |
| -------------------- | ----------------------------------------------------------- |
| `iirc.layout`        | The Panes, naming Timelines by id                           |
| `iirc.ui`            | This device's overrides of options under `ui`               |
| `iirc.notify`        | Whether this device notifies                                |
| `iirc.members`       | Whether the members' column shows beside a Pane wide enough |
| `iirc.sidebar`       | Whether the Sidebar is hidden, beside the Panes             |
| `iirc.sidebar-width` | How wide the Sidebar is, in CSS pixels                      |

Anything kept that cannot be read leaves the page starting as new.

The screen is compact at `(max-width: 640px)`. What is sized for touch is decided apart from it, by `(pointer: coarse)`.

## What it guarantees

- **The Frontend never stores a Key.** The Key field is a plain, uncontrolled `<input type="password">`, so the Key is never in React state or props. On submit the value is parsed straight to `Redacted` and the field emptied, and the `Redacted` is wiped once the Daemon answers. No Key is written to storage or to a cookie script can read.
- **The Key field is accessible, and a password manager may keep it.** It has a label, says its failure with `aria-describedby`, and its `autocomplete` is `current-password`.
- **Text a Network sent is only ever a text node.** There is no `innerHTML`, and no markup is built from strings. Each nick, name, and text sits in a `<bdi>`.
- **A link is one the core found,** and opens in a new tab with `rel="noopener noreferrer"`.
- **It runs under a strict Content Security Policy.** It loads nothing but its own files, with no inline script or style. `public/pressable.css` carries the rule React Aria would inject inline. On iOS WebKit alone, React Aria's scroll locking adds a `<style>` the policy refuses, and the page still works without that rule.
- **An instant out of a `Date`'s range never takes the page down.** Every time shown goes through `src/ui/dates.ts`, and one out of range shows as unavailable.
- **The Composer is no keyboard trap.** Tab is taken only when there is a word to complete, or while its list is open.
- **The Composer's list, and its formatting list, are a listbox its textarea controls,** which keeps the focus. `aria-controls` names the list while it is shown, `aria-activedescendant` the item highlighted, and a format's name says whether it is on.
- **The list shows exactly while it owns Tab, the arrows, and Escape,** and moving the caret without typing lets go of it.

### The fonts

Each is under the SIL Open Font License 1.1, and the build ships each package's licence as `licences/<font>.txt`. The versions are pinned in `package.json`.

| `ui.font`                    | Package                                           |
| ---------------------------- | ------------------------------------------------- |
| `jetbrains-mono`             | `@fontsource-variable/jetbrains-mono`             |
| `ibm-plex-mono`              | `@fontsource/ibm-plex-mono`, 400 and 700          |
| `source-code-pro`            | `@fontsource-variable/source-code-pro`            |
| `commit-mono`                | `@fontsource/commit-mono`, 400 and 700            |
| `atkinson-hyperlegible-mono` | `@fontsource-variable/atkinson-hyperlegible-mono` |
| `ibm-plex-sans`              | `@fontsource-variable/ibm-plex-sans`              |
| `atkinson-hyperlegible-next` | `@fontsource-variable/atkinson-hyperlegible-next` |
| `source-sans-3`              | `@fontsource-variable/source-sans-3`              |
| `inter`                      | `@fontsource-variable/inter`                      |

## Development

```sh
bun run dev          # in apps/web: Vite on localhost:5173
```

The dev server proxies `/api` to a Daemon on `127.0.0.1:7667`, so the browser sees one origin. The proxy passes the browser's `Host` and `Origin` through unchanged, and streams responses without buffering. A Daemon that is not running is answered `502`, which the Frontend reads as no answer.

## Tests

`bun run test` renders the Frontend in happy-dom against the fake Daemon in `src/testing/fake-daemon.ts`. The fake answers at the `fetch` level, so every test goes through the real `DaemonClient` and the API's own decoding. A test that turns on how long something lasted gives the runtime a clock it holds, and moves it. The browser itself runs end to end in `apps/iirc`'s `bun run e2e`, against the built frontend on a real `iirc daemon --web`.

## Not yet

- **A view of News.**
- **Splitting the bundle.** The page's code is one script, but for the emoji names and the theme reader's Worker.
- **Notifying per Network, or of words of the Owner's own.** Whether a device notifies is kept in its `localStorage`.
- **A sound, or a badge on an installed app's icon.**
- **A service worker.** Nothing is kept for use without the Daemon, and Android and an app installed on iOS show no notification.
- **Moving a Pane by dragging it.**
