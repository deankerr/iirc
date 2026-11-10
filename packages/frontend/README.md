# @iirc/frontend

The pure core of the web frontend ([ADR 0010](../../docs/adr/0010-the-web-frontend-is-a-pure-core-under-react.md)). It holds what a Frontend shows as plain data and reducers, and React in [`apps/web`](../../apps/web/README.md) only renders it. It is pure, as `@iirc/client` is: it reads no clock, no randomness, no locale, and no time zone, does no I/O, uses no Effect service, and knows nothing of React or the DOM, which the lint fence enforces. It reads mIRC formatting and casemapping from `@iirc/protocol`, positions from `@iirc/timelines`, and the Configuration's Schema from `@iirc/client/configuration`, all pure, and takes the types of what the runtime parsed from `@iirc/api`, never its values.

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
reduceTimelines(state: Timelines, event: TimelinesEvent): Timelines
wanted(state): readonly Read[]                    // the reads to make now, none already in flight
followFrom(state): Place | null | undefined       // where to follow the changes from, once it can
sidebar(state): readonly SidebarNetwork[]         // Networks by id, each with its Timelines and connection
opened(state): Opened                             // the open Timeline: Closed, Vanished, Reading, or Shown
rowsOf(window): readonly Row[]                    // a window's items, with its collapsed Gaps among them
resolve(state, timeline): TimelineId              // the Timeline an id stands for, following merges

Read = Networks | List { network, after } | Status { network }
     | Latest { timeline, limit } | Older { timeline, before, limit }
     | Newer { timeline, after, limit }      // each with `attempt`, a window's with `generation`
```

| Event | From |
| --- | --- |
| `ReadStarted { read }` | The runtime took on a read `wanted` gave, so it is not asked for twice. It may wait before asking |
| `Requesting { read }` | The runtime is asking the Daemon now, after any wait, and again for each attempt after a failure |
| `NetworksRead`, `ListRead`, `StatusRead`, `WindowRead { read, window }` | What `GET /api/networks`, a page of a Network's Timelines, `known`, and a window answered. A window's answer names the read it answers, cursor and generation included |
| `Vanished`, `NetworkVanished` | A read answered `UnknownTimeline` or `UnknownNetwork` |
| `Changed { place, change }`, `Overflowed { place, overflow }`, `Reset { reset }` | The changes stream, with the place each event left it |
| `Opened { timeline }`, `OlderWanted { timeline }`, `NewerWanted { timeline }` | The Owner opened a Timeline, or scrolled near its top, or near its bottom with more beyond |
| `Located { timeline, navigation }` | The Daemon placed a Message the Owner said with `opens`, as `/msg` does, in this Timeline, read from the step that said it, with the `navigation` its Say was submitted at |
| `Following { timeline, following }` | The Owner is at the latest of the open Timeline, or left it |
| `OptionsShown { filter }`, `OptionsFiltered { filter }` | The Owner showed the options in the main view, by `/set` or the sidebar, or typed in their filter |

- **It holds, per Network, its Timelines and its connection, and per Timeline opened, a window:** its items in position order, its collapsed Gaps, whether more lie `earlier` and `later`, and the `version` and `through` it was read at.
- **It follows the stream after the smallest `through` it read.** The Network list and every Network's Timelines are read first, a page at a time, and only then does `followFrom` give a place: the smallest `through` of the pages, with their version. Then the Network list is read once more, so a Network configured while the pages were read is not missed. A window is read only once the stream is followed.
- **One rule decides whether an answer is current:** nothing that invalidates what it is of happened after its read began. That is a reset, or the stream forgetting what it gave since then, either of which leaves no record of what changed, or an overflow that touched it, whose changes never came: for the Network list, one that touched everything; for a Network's Timelines or its connection, one that touched that Network; for a window, one that touched its Network or named its Timeline. The Network list and `known` are checked from where the stream was when the Daemon was last asked for them, as `Requesting` marks, so what the stream gave while the runtime waited to ask again never makes an answer stale; a page of Timelines or a window is checked from its own `through`. An answer that is not current leaves what it is of stale, and is asked for again with a higher `attempt`.
- **No change is lost or applied twice.** A Timeline is kept by its id and an item by its position, and the one changed last wins, so a change that comes again changes nothing. A window skips the steps it already reflects. While any read is in flight, what the stream gives is kept, and a read that lands after the stream passed its `through` is brought up to date from it, overflows included. A read older than anything kept, or of another version, is dropped, and asked again with a higher `attempt`, for the runtime to wait longer.
- **A new item lands only where it belongs by position.** In place of the item at its position, when it changed later, as a delivery does. Between the items loaded, as late history does. Past an end with nothing more beyond it, as a live item does at the latest. Anywhere else it is outside what the window holds. Late history inside a collapsed Gap of several may split it, so that window is read again.
- **A Gap lands in the windows of its Network.** One that ends closes the collapsed Gap holding it. One that begins after the last item joins a collapsed Gap already there, with no item between, or begins one. One among the items means history changed under the window, which is read again. Older items read before the window bring their Gaps, and a collapsed Gap held that begins inside one of theirs is the same run, seen whole.
- **Older items are read before the first item held, and newer after the last,** with the run of Gaps up to the cursor, as the API gives it. The cursor splits a run that crosses it into a part on each side, and the window joins two Gaps with no item between them into one run again, so pages fitted together show each run once. A page is brought up to date with what the stream gave on its own before it joins the window, which already reflects it.
- **A window holds at most `windowCap` items, 1000.** While the Owner is at the latest, a live item past the end is kept, and past the cap the oldest go, with the Gaps that ended before the first item kept, and `earlier` says more lie before. Away from the latest, a live item past the end is not kept: `later` says more lie after, the Gaps that began after the last item go too, and they are read after the last item when the Owner scrolls down. A page read before the window drops the newest past the cap instead. `earlier` and `later` are true exactly when something lies beyond, so everything dropped can be read again. A trim through a collapsed Gap of several, which may hold Gaps on both sides of the first item kept, reads the window again.
- **An answer is taken only by the window it was read for.** Each window is a generation of its Timeline's, and a window dropped and read again is a new one. A read names the generation it was made for and, before or after the window, its cursor, and its answer names that read. An answer for a window dropped or replaced since is ignored, without touching the window there is now or its read in flight. A page for an edge the window no longer has, as when the oldest were dropped past the cap while it was read, merges nothing, and is asked for again from the edge there is now.
- **Only the open Timeline's window and those of the four closed most recently are kept.** Any other is dropped, and read again when opened. A Timeline opens on its latest: its window follows again, and one left behind the latest is read again.
- **A merged Timeline follows its tombstone.** It leaves its Network's list, its window goes, and the Timeline the Owner opened resolves to the one it went to, which is read. A window read of a merged id says where it went, which is kept too.
- **An overflow reads again what it touched:** every Network whose Timeline it named, with its Timelines, its connection, and every window of it, since a Gap is the whole Network's. One that names a Timeline not held, or none, touched everything, and the Network list is read again too.
- **A reset drops what is held:** every list and window, read again, the Network list too, since a Network configured while the stream was away may be in the state the reset reaches with its first step never given, and the stream follows from the reset's place. A read of the Network list started before the reset, at a place older than the reset's, is read again rather than taken as current, as every other read is. A Network's connection stays shown until `known` is read again.
- **What the main view shows is navigation, held here once:** `main` is `Timeline`, the open one, or `Options { filter }`. `Opened` shows the Timeline it opens, and so does a placement that opens one, so a `/msg` said while the options showed shows its Direct Message, with the composer under it. `OptionsShown` shows the options and, like opening a Timeline, bumps `navigation`, so a placement from before is let go. Nothing else says whether the options show.
- **The Timeline a Message said with `opens` was placed in opens by its id, never by its name.** The Daemon's routing chose it, so two Users whose nicks only another casemapping folds together, such as `[bob]` and `{bob}` under `ascii`, are never confused. It opens as soon as its Network lists it, at once when it already does, and only when it is a Direct Message Timeline that still follows its partner: a Message to a Channel opens nothing. Each `Opened` bumps `navigation`, which a placement captures as its Say is submitted, so a `Located` from before the Owner opened another Timeline is ignored, however late it lands, and opening another lets a pending one go.
- **A Network's connection is derived, not polled.** It comes from `known` once, and then from the Session items the changes carry, `SessionBegan`, `SessionEnded`, and `ConnectionFailed`, each applied only when it is later than what set the connection. `known` says what the Client knows now, connecting and registering included, which no item says, and the latest Session item may lie anywhere in the Network's Timeline, beyond any window. A `known` read is taken only if no Session item later than the stream's place when it started already said more, and is read again if it started before a reset or an overflow of its Network.

## Commands

`@iirc/frontend/commands`: the one registry of commands ([ADR 0010](../../docs/adr/0010-the-web-frontend-is-a-pure-core-under-react.md)), as data, behind the composer's `/commands`, the palette, the keymap, and, later, agents. A command never does anything: it gives intents, plain data the runtime carries out.

```ts
commands: readonly Command[]                      // in the order a list shows them
commandNamed(name): Command | undefined           // by name or alias, in any ASCII case
commandWithId(id): Command | undefined            // by id, as a keybinding names it
unmet(when, context): string | undefined          // the first condition that does not hold, in words
runIn(command, args, context): Parsed<readonly Intent[]>   // once its conditions hold
interpret(line, context): Parsed<readonly Intent[]>

typesCredential(line): boolean                    // a line that types a Credential's value after /set

Command = { id, name, aliases, usage, arguments: "None" | "Optional" | "Required", description, when: readonly Condition[], run(args, context) }
CommandContext = { focus: Focus | undefined, session: boolean, timelines: readonly TimelineId[], open: TimelineId | undefined }
// timelines: every one in the sidebar's order; open: the one opened, even while it is read
Focus = { network, timeline, kind: "Network" | "Channel" | "Direct", name, detached, key }   // key: as the Daemon folded it
Condition = Focused | Target | Session
Parsed<A> = Parsed { value: A } | Invalid { message }
Intent = Say { network, target, kind: "Privmsg" | "Notice" | "Action", text, opens }
       | OpenOptions { filter }                   // show the options view, filtered
       | Configure { network, edit: Edit }        // read, apply the edit, send it whole
       | AddNetwork { network, configuration }    // configure a Network that must not exist yet
       | PromptCredential { network, path }      // ask for a Credential option's value in a password prompt
       | Open { timeline }                        // open a Timeline in the main view
       | OpenPalette                              // open the command palette
       | FocusComposer { text }                   // focus the composer, starting an empty draft with text
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
| `/set` |  |  | `OpenOptions`, unfiltered |
| `/set <pattern>` |  |  | `OpenOptions`, filtered by the pattern |
| `/set <credential option>` |  |  | `PromptCredential`: the password prompt asks for its value |
| `/set <option> <value>` |  |  | `Configure` with `Set`, the value being the rest of the line, exactly, checked in its syntax first. Empty text, or an empty list, is a value. A Credential option is refused here |
| `/unset <option>` |  |  | `Configure` with `Unset` |
| `/network add <id> <host>[/port] [-tls] <nick>` |  |  | `AddNetwork`, enabled, with that Ircd and nick and every other field as a new Network starts |
| `/next` |  |  | `Open` of the Timeline after the open one in the sidebar's order, wrapping to the first, or the first when none is open. Nothing when it is the only one, and `Invalid` when there are none |
| `/previous` | `/prev` |  | `Open` of the Timeline before, wrapping to the last, or the last when none is open |
| `/palette` |  |  | `OpenPalette` |
| `/focus` |  |  | `FocusComposer`, its draft kept |

- **A line is read one way.** Plain text is `/say` to the open Timeline. `//text` says `/text`. `/name args` runs the command named, once its conditions hold. A bare `/`, or a name no command has, is `Invalid`, and nothing is sent.
- **Arguments are parsed, not validated.** A command's parser gives typed arguments or says why it cannot, in words that name its usage: no text, no Target, or a list of Targets, since a list is never one Timeline and the Client sends no `PRIVMSG` to one. The text after a Target is kept exactly, spaces included.
- **Each unmet condition says why.** Plain text in the Network's own Timeline has no Target to say it to, and the words say to open a Channel or a Direct Message, or use `/msg`. A detached Direct Message no longer follows its partner. A Network with no Session can be told nothing, though a command that needs none would still run.
- **A new command is one entry.** `/set`, `/join`, `/network add`, and `/next` are entries like the rest, and the palette and the keymap add none of their own: moving between Timelines and opening the palette are commands that `/` reaches too.
- **Each command says whether it takes arguments.** `None`, `Optional`, or `Required`, so the palette runs one that needs none, and starts one that does in the composer.
- **Configuration is changed by intents, never in place.** `/join`, `/part`, `/set`, and `/unset` name an edit, which the runtime applies to the Configuration it reads, so a change made while another Frontend changed the Network applies to what is there then.
- **A Credential's value never goes through the composer, nor any intent.** `/set <credential option>` alone asks for it in a password prompt, which gives it to the Vault itself. A value typed after it is refused, and the composer clears at once, below.

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
| `mod+,` | `options.set` | `!palette` | Show the options |
| `i` | `composer.focus` | `!editing && !palette` | Focus the composer, from outside a field |

- **A chord is parsed, not validated.** Its text is modifiers, each once, then one key, joined by `+`, in any ASCII case: `mod`, `ctrl`, `meta`, `alt`, and `shift`, with `cmd`, `command`, `control`, `opt`, and `option` read as theirs, and a named key, such as `arrowup`, `enter`, `escape`, `space`, `tab`, `f1` to `f12`, or `plus` for `+`, or one printable character. A `KeyName` exists only once parsed. `formatChord` writes a chord so that it parses back to the same one.
- **`mod` is Cmd on a Mac and Ctrl elsewhere,** as the runtime says. `ctrl` and `meta` name those keys on every platform, so `ctrl+k` elsewhere is `mod+k`. `showChord` writes a chord as the platform does: `Ctrl+Shift+P`, or `⇧⌘P` on a Mac.
- **A key event is the layout's character,** ASCII letters lower-cased, with no modifier or Shift alone, so an AZERTY `é` binds as `é`, not as the `2` its physical key is on QWERTY. The physical key, a letter or digit, names it only where that character says less: a dead key or a key with no character; with Alt, as Option and AltGr are, a character other than the physical key's; and with Ctrl or Cmd, a character outside ASCII. A key an input method is processing is no chord.
- **AltGr in a field is typing.** A key event says whether AltGr is held, as the browser's `getModifierState("AltGraph")` does, since some platforms report AltGr as Ctrl and Alt too. While editing, a printable character typed with AltGraph, such as German AltGr+Q for `@`, resolves to nothing and is typed. Ctrl+Alt without AltGraph is a chord, so a US `ctrl+alt+k` binding works in a field. Outside a field AltGr is a chord like any other.
- **A `when` is parsed into clauses,** each `editing` or `palette`, perhaps negated with `!`, joined by `&&`. A binding whose chord or `when` does not parse, or whose command the registry lacks, is dropped by `keymapOf`, so a keymap holds only bindings that can fire.
- **`resolve` takes the last binding that applies:** its chord is the key, its `when` holds, its command's own conditions hold, and its command gives intents for its arguments. Otherwise it looks at the binding before, and with none left the key is not the keymap's. A later binding overrides an earlier one, so overrides go after the defaults.
- **A binding fires while typing in a field only when its `when` allows it.** Most of the defaults do, as an IRC client keeps the caret in its input. `i` does not, so it is typed into a field. Ctrl+L and Cmd+L would focus the composer from anywhere, but browsers use them for the address bar, and a letter outside a field has no browser default.

## Palette

`@iirc/frontend/palette`: what the command palette lists for a query, ranked, and what choosing an entry asks for. It adds no action of its own: choosing gives the intents the registry does.

```ts
sections(listing: Listing, query, recent): readonly Section[]   // none empty
choose(entry, context): readonly Intent[]
initialPalette, reducePalette(state, event), remember(recent, key), recentCap: 20

Listing = { context: CommandContext, sidebar: readonly SidebarNetwork[], options: readonly Option[], keymap }
Section = { title: "Recent" | "Commands" | "Timelines" | "Options", entries: readonly Entry[] }
Entry = Command { key, id, name, usage, description, chords }
      | Timeline { key, timeline, network, kind, name }
      | Option { key, name, description, credential }
Palette = { open, query, recent: readonly string[] }   // recent: entries' keys, newest first
PaletteEvent = Opened | Closed | Queried { query } | Chosen { key }
```

- **It lists what can be done here:** each command whose conditions hold, with its usage, description, and the chords bound to it, but not `/palette`; every Timeline, in the sidebar's order; and every option read.
- **A query ranks entries in four tiers:** the query begins a name, it begins a word of a name, it begins a word of the description, or its characters appear in a name in order. Within a tier, a shorter name, an earlier word, or characters closer together come first, and then the section's own order. A word begins after anything that is not a letter or a digit, so `iirc` finds `#iirc` and `nick` finds `network.libera.nicks`. A command's names are its name and its aliases, the name ranked first, and a Timeline's are its name and its Network and name. A leading `/` is ignored. Sections are ordered by their best entry, and matching nothing lists nothing. Matching is ASCII case-insensitive and reads no locale. It is a small scorer of its own rather than uFuzzy, whose sort uses `Intl.Collator`, and whose own ranking would still need these tiers put over it, for lists of tens to hundreds.
- **With no query, the entries chosen recently come first,** newest first, in a section of their own, and each section follows without them. A choice is remembered once, at most `recentCap`, the oldest going first.
- **Choosing a command that needs no arguments runs it,** as typing its name alone does. One that needs them, or that cannot run with none, such as `/part` outside a Channel, starts in the composer as `/<name> `, with the caret after it. A Timeline opens. An option starts `/set <name> ` in the composer, and a Credential option asks for its value in the password prompt, as `/set <name>` alone does, since its value is never typed into the composer.
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
contextOf(timelines): CommandContext                   // the open Timeline, whether its Network has a Session, and every Timeline in order
started(state, place, text): Composers                // FocusComposer's text: put in an empty draft, never over one with text
refusal(reason, target), failed(failure, intent, intents)   // in words
```

| Event | From |
| --- | --- |
| `Edited { timeline, text }`, `Recalled { timeline, direction }`, `Dismissed { timeline }` | The Owner typed, pressed Up or Down, or pressed Escape |
| `Failed { timeline, intent, failure, intents }` | A Say failed, with it and the intents after it, none carried out after it |
| `Noticed { timeline, message }` | Another intent, such as a change of Configuration, did not go as asked, in words. Nothing after it was carried out |

A composer is at a `Place`: a Timeline's id, or `Nowhere`, under the main view while no Timeline is open, where commands that need none, such as `/network add`, are typed. A Timeline's id is hex and `-`, so it is never `Nowhere`.

- **Each Timeline has its own draft,** kept when the Owner opens another, and its own history of what was sent from it, newest first, at most `historyCap`, a repeat of the newest kept once. Up goes back through it, Down comes forward, and past the newest the draft as it was comes back. Typing leaves the history where it is.
- **A Credential's value typed here is let go of at once.** A submission with a line that types one after `/set` sends nothing, and clears the draft, what was kept while recalling, and what waited to be confirmed, saying to use `/set <option>` alone, which opens the prompt. None of it enters the history. Until it is submitted, though, the value is held as the draft's text, as anything typed is, and React may keep a past render's copy for a while: the prompt is the way to give one.
- **Submitting sends every non-empty line, in order, or nothing.** Each line with more than whitespace is read by `interpret`, and the first that cannot be sent says why, `Line 2: …` when there are several, with the text kept. Text holding a NUL is refused, since no Line can carry one. More than `confirmAbove` lines wait for the Owner to confirm them, as a state the view shows, and editing the text, recalling another, or Escape lets them go, so what is confirmed is always exactly what is shown.
- **A refusal is said in words under the composer it came from.** `say` answers `Refused` with `Offline` or `Unsendable` when the Client refused it in the step that took it, which is the `Refused` failure, and nothing after it is sent. `Rejected` and `Unsent` come later, as the item's delivery.
- **What failed says what is safe to do next, and never sends a Message twice.** `NotJournaled`, which only a `NetworkStopped` leads to, since then the append has settled, offers `SendAgain` with it and those after it, under the same intent, as the API allows. `Journaled` says it was journaled, that whether it reached the Ircd is unknown, since a restart never carries out a past step's outputs, and that it is not sent again on its own, its item showing its delivery, and offers only those after it, under new intents. `Unknown`, when the request got no answer, so it may still be appending and `said` answering `NotJournaled` proves nothing, offers only `CheckAgain`, which asks `said` again: `Journaled` settles it, and anything else leaves it unknown.
- **Plain data.** A state survives `structuredClone`.

## Options

`@iirc/frontend/options`: Configuration as an option tree ([ADR 0013](../../docs/adr/0013-configuration-is-an-option-tree.md)). Every option comes from the annotations on the Client's `NetworkConfiguration`, walked once from its AST, so nothing lists them by hand and a new field is a new option.

```ts
fields: readonly Field[]                          // { key, kind, description, optional, starts }, from the Schema
optionsOf(network, configuration, held): readonly Option[]
resolve(name): Parsed<{ network, path, field }>   // from the Schema alone
parseText(kind, text): Parsed<Json>, showText(kind, value): string
apply(network, configuration, edit): Parsed<Configuration>   // set, unset, and the rest are edits
set(network, configuration, path, text), unset(network, configuration, path)
starting(network, given): Parsed<Configuration>   // what a new Network starts with, the rest given
credentialFor(network, configuration, path): Parsed<string>  // the Credential an option names, or the one derived
matches(filter, name): boolean
initialOptions, reduceOptions(state, event), listed(state, filter): readonly Option[]

Option = { name, network, path, kind, description, value: Shown { text } | Unset | Credential { name, held }, starts, unsettable }
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
| `Ircds` | an array of `IrcdAddress` | a list, each `host/port`, TLS unless ` -tls` follows, as in `irc.libera.chat/6697,127.0.0.1/6667 -tls`. The port is the digits after the last `/`, so a host may hold anything, and is always shown. Typed without one, it is 6697 with TLS and 6667 without |
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

## Rendering

`@iirc/frontend/render`: what an item shows, as data for a view to draw. Nothing in it is markup: every string is text, for a text node.

```ts
formatted(text): readonly Inline[]                // mIRC formatting into runs, and links in them
lineOf(content): Line                             // Message { kind, nick, colour, text, delivery } | Description { tone, parts }
nickColour(nick, slots = nickSlots): number       // a stable colour slot, 0 to 15
contained(text): string                           // controls shown as symbols, bidi closed
endReason(reason): string                         // why a Session ended, in words

Inline = Text { text, style } | Link { text, href, style }
Part = Words { text } | Nick { nick, colour } | Name { text } | Said { inlines }
```

- **Formatting is data.** `@iirc/protocol/format` reads bold, italic, underline, strikethrough, monospace, reverse, and colours into styles, and a view draws them.
- **A link is one of `http`, `https`, `irc`, or `ircs`,** found within a run of one style, with sentence punctuation and an unopened closing bracket left off its end, each bracket counted once, so any number of them is trimmed in linear time, and its `href` as the URL parser writes it. Anything else, `javascript:` and `data:` included, stays text. A link ends at whitespace, a control character, or a bidirectional formatting character, so none is ever in one.
- **One of ours says its delivery in a few words:** `sending`, `unconfirmed`, `not sent`, or `refused:` with the Ircd's numeric or code, contained, and nothing once confirmed.
- **Hostile text is contained.** C0 controls and DEL show as their Control Pictures, C1 controls and lone surrogates as the replacement character, and the line and paragraph separators as the newline symbol. Every bidirectional embedding, override, or isolate a run opens is closed at its end, so it cannot reorder what follows it, and a view isolates each name and text besides. Everything over a Line's text is linear, however hostile: a pop with no isolate open skips the search, and each search drops what it passes over.
- **A nick's colour is a slot, not a colour:** an FNV-1a hash of the nick as RFC 1459 folds it, one of 16, so the same User has the same slot in any case, on every load, and a theme gives each slot its colour.
- **Activity and Sessions are a few words,** in which nicks, names, and reasons are parts of their own. One of our Messages says its delivery, and once the Ircd confirmed it, shows the Ircd's own text.

## Tests

`bun run test` runs eight files. `src/sign-in.test.ts` covers each transition, checking again after a failed check, keeping a failure until the next attempt, signing out failing while staying signed in, `Refused` from signed in and while signing out, ignoring an answer that does not belong, and two properties over any sequence of events: `SignedIn` is entered only after a check or a sign-in said so, and every state survives `structuredClone` unchanged.

`src/timelines.test.ts` plays a model Daemon: random steps folded into Timelines, items, late history, deliveries, Sessions and their Gaps, and a second Network configured later, sometimes never heard from again, read a page at a time and a window at a time as the API reads them, before and after a cursor included, and changes given as it gives them. The reducer and a runtime in miniature read what `wanted` asks, at fold points the Daemon has reached, answered later in any order, while the stream lags the Daemon, some steps come as overflows, naming what they touched or everything, the Daemon may take a new projection version, which the stream resets, every event may come twice, and the Owner opens Timelines, goes back to the one before, opens another while older items are read and comes back, has the Daemon fold steps that come as overflows touching everything while the Network list is read, scrolls up and down, and leaves and returns to the latest at random, with windows of at most 4 items, pages of 2, and no closed window kept, so windows are dropped and read again with answers for them still in flight, which the runtime may answer newest first. After every action, a current window holds every item the Daemon had folded by its `through` between its first and last items, so a page merged into the wrong window, which leaves a hole, is caught as it happens. Once everything settles, the Networks are exactly the Daemon's, and each Network's Timelines and connection are exactly its, a Network that only a reset reaches included, and every current window is exactly what a read now would give between its first and last items, Gaps included, with `earlier` and `later` true exactly when something lies beyond. No window ever holds more than the cap, nor is any window kept but the open one's. Every state survives `structuredClone`. Examples cover opening the Direct Message Timeline a Message was placed in, by id, at once or once listed, the right one of `[bob]` and `{bob}`, never a Channel's or a detached one, a placement from before the Owner opened another ignored, a placement made while the options showed showing its Timeline in their place, and one from before they were shown let go, following after the smallest `through`, each read asked once, sidebar order, a live item, late history, an update in place, an item outside a window, a merge followed and learnt from a window read, overflows, a reset, a read of another version dropped, a read brought up to date from what the stream gave, reading older items before the first with the Gaps up to it, a page that lands after its window was dropped and read again ignored, the Network list kept stale when an overflow that touched everything came while it was read, and current from where the stream was when it was asked, not when it was taken on, joining a run the cursor split, the Network list read again on a reset and a pre-reset read of it landing late, collapsing Gaps, and a connection from `known` then from Session items.

`src/commands.test.ts` covers each command's name and aliases, unique and in lower case, finding one in any case, `when` for each kind of Timeline and with no Session, plain text, `/me`, `/say`, `//`, `/msg` from the Network's Timeline opening the Direct Message, `/notice`, an unknown command and a bare `/`, missing arguments and a list of Targets, why plain text cannot go to the Network's own Timeline, `/next`, `/prev`, `/palette`, and `/focus`, and whether each command takes arguments.

`src/keymap.test.ts` checks, as a property, that any chord reads back from the text it formats as the same chord, and that text writes the same way again. It covers parsing in any case and with aliases, refusing text that is no chord, AZERTY's `é` and German's `ö` kept as typed and a binding of `é` resolving outside a field, Shift alone and Ctrl on the same key, German AltGr+Q, with AltGraph, typed in a field and a chord outside one, the same Ctrl+Alt without AltGraph a chord in a field, and a US Ctrl+Alt+K resolving in a field, and Alt+arrows still moving between Timelines on those layouts, showing chords as each platform does, chords from key events with Mod as Cmd or Ctrl, a Mac's Option and dead keys read from the physical key, a layout's own letter kept, and a key an input method holds; every default binding parsed, and one that does not parse dropped; `when`; and `resolve`: the palette from the composer but not while it is open, Cmd on a Mac and not Ctrl there, the next and previous Timeline wrapping and from none, nothing with no Timelines, `i` focusing the composer outside a field and typed inside one, `mod+,` opening the options, a bound command's own conditions, and a later binding winning.

`src/palette.test.ts` covers what is listed in a Channel and from no Timeline, never `/palette`, a command's chords beside it, ranking by prefix, then a word's start, then characters in order, an alias, a leading `/`, nothing for no match, sections ordered by their best entry, recent choices first and only once with no query, and ignored with one, and what choosing gives: a command run, or started in the composer when it needs arguments or cannot run with none, a Timeline opened, an option's `/set` started, and a Credential option's prompt; an empty or blank draft started, and one with text kept with a notice. As properties, no choice ever changes a draft with text in it, and `remember` keeps at most the cap, newest first, each once, for any choices, and the state survives `structuredClone`.

`src/composer.test.ts` covers a line sent and kept in the history, one Say per non-empty line in order, whitespace sending nothing, a NUL and a bad line refusing everything with the text kept, the confirmation threshold, confirming and dismissing, drafts kept per Timeline, and recall in order back to the draft. A property over any sends, draft, and number of Ups checks the history is bounded and newest first, Up that many times and Down as many returns to the draft, another Timeline's draft is untouched, and the state survives `structuredClone`. A recall while lines wait to be confirmed lets them go, and a property over any typing, recalls, submits, confirms, and dismissals checks that what waits to be confirmed is always exactly what is shown. It also covers a refusal in words, with nothing after it sent, its Target contained, what is offered after `NotJournaled` and `Journaled`, the latter promising no delivery, and only `CheckAgain` after no answer.

`src/options.test.ts` covers the fields derived from the Schema, one for each of the Configuration's, each described, with its kind; every option of a Configuration with a SASL login, a password, and a keyed Channel listed, each resolved by its name; each value and starting value in its syntax; Credential options showing only a name and whether it is held; a member's fields unset while another is in force; names with dotted Network ids and Channel names; Credential names derived, escaped, and kept; patterns and text matched. It checks, as properties, that each kind reads back what it shows, for any value the Schema admits, weighted towards quotes, commas, backslashes, spaces, and Unicode, that an Ircd list typed any way shows what it reads, and that any text set on any option gives a Configuration or says why. It covers setting each option to what it shows giving the same Configuration, setting and refusing values, a member put in force by one of its fields, keys kept as Channels are set again, unsetting each kind or refusing one that must be given, refusing to unset a SASL login's Credential, pointing a Credential option, joining and parting as the Network folds names and exactly while it says none, an ascii Network's `#[a]` and `#{a}` never merged or parted together, a name two entries fold to refused with both named, `PartTimeline` by the routed key, `%help` kept under `CHANTYPES=%`, a bare name prefixed with `&` on an `&`-only Network, and refused while `CHANTYPES` is unknown, the list syntax's escapes, edges, and empty elements, text set verbatim, the commands `/set`, `/unset`, `/network add`, `/join`, and `/part`, `/set` on a Credential opening the prompt and a value typed after it refused, the composer clearing such a line at once and keeping it nowhere, and the options view listing what it read, filtered, keeping the newest read.

`src/render.test.ts` covers formatting, the schemes linked and those not, a link's style and `href`, a link ended at a bidirectional character, controls shown, bidirectional formatting closed, a line of 70 000 characters, linear time over 64 000 closing brackets after a link and 30 000 nested embeddings closed by isolates' pops, and, for any text weighted towards hostile pieces, that it never throws, no run holds a control, every run closes its bidirectional formatting, and every link is of an allowed scheme. Nick colours are the same in any case and on every run, in range, and spread over every slot. Lines cover a Message, each delivery in words, a rejection's code contained, and the Ircd's confirmed text, a hostile nick, each Activity, and a Session's start and end.

## Not yet

- **The pane layout,** which [ADR 0010](../../docs/adr/0010-the-web-frontend-is-a-pure-core-under-react.md) and [ADR 0012](../../docs/adr/0012-the-web-frontend-builds-on-react-aria-and-resizable-panels.md) describe.
- **Options under `ui`,** for Frontends, such as the theme and overrides of the keymap, which [ADR 0013](../../docs/adr/0013-configuration-is-an-option-tree.md) puts in the same tree, and options of the Daemon's own. `keymapOf` is ready to read them, dropping what does not parse.
- **Chords in sequence,** such as `mod+k mod+o`. None of the defaults needs one, and `mod+k` alone opens the palette, so a sequence beginning with it would make the palette wait.
- **The next Timeline with something unread.** Each Timeline the API lists carries its Read Marker and what lies after it, by level, and nothing here reads them yet.
- **Removing a Network,** which the API cannot do yet. `/network add` only adds.
