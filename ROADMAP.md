# Roadmap

What iirc plans to build next, grouped by what the Owner would notice, roughly in the order we expect to take it. This document says what is intended. The work itself is issues, each a vertical slice: the contract, the Client or Daemon, and the web frontend together, reviewed until nothing blocking is left.

The order bends to what the Owner finds in daily use. Refining what is built comes before anything under "Below the line", which waits until it is asked for.

## Look and feel

Options under `ui`, shared by every device and overridable on one, as `ui.size` and `ui.font` are.

- **Line height,** beside the text's size.
- **Any font,** not only a monospace one: a family the device has, by name, and a few sans fonts served beside the monospace ones. Nothing drawn may assume every character is as wide as the next.
- **How a line is laid out:** the nick in a column of its own, in the line, or above what was said, with a run of Messages from one User under one nick.
- **A widest line,** so text in a wide Pane does not run the width of the screen.
- **A 12-hour clock,** and how a day is written.
- **A theme for light and one for dark,** when `system` follows the device.
- **The Composer's habits:** whether Enter sends, spellcheck, and what follows a completed nick.
- **When a Timeline is marked read:** as it is shown, at its latest, or only when asked.
- **Styles of the Owner's own,** as CSS, for what no option covers.
- **The palette as part of the Composer,** opening above it rather than over the middle of the page: one list for commands, completions and Timelines. To be tried before it is decided.

## Media

IRC carries text, so a picture is always a link. Two features make a link feel like media, and both rest on one store in the Daemon: bytes kept by their hash beside the Journal, with what each is, served from an origin that runs no script. A Timeline shows an image, a video, or a sound from it in place, and larger on a press.

### Previews

A Message's links shown with more than their address: a page's title and image, or the media itself in place.

- **The Daemon fetches, never the browser.** A browser fetching a link a stranger posted gives that stranger the Owner's IP address on every device. The Daemon fetches each link once, on demand, and serves the Preview and its media from its own origin, so the page's CSP names no other host for an image.
- **Fetching is guarded against SSRF.** The Daemon resolves the name itself, refuses loopback, private, link-local and other special ranges, connects to the address it checked, follows redirects one at a time checking each, and caps size, time and content types. It keeps what it fetched, failures included, and serves media by its own hash, so it is never an open proxy.
- **Off until the Owner turns it on,** per Network or per Timeline as options under `ui`, and fetched only when a Message is shown, since fetching ahead tells a link's host when the Daemon saw it.
- **Any page, by what the page says of itself:** OpenGraph, Twitter card tags, and the oEmbed it points to. **A link to media itself** by its content type: an image, an animated image, a video, or a sound.
- **A player loads only on a press,** where a page's tags name one, in a sandboxed frame from a short list of hosts the CSP names. A service's script is never loaded into the page.
- **No service is coded for.** A plain fetch already gets a Preview from most of the services that matter: YouTube, X, GitHub, Bluesky, Mastodon, Giphy, Twitch, Vimeo, Streamable, Spotify, SoundCloud, Bandcamp and Wikipedia. A recorded page from each is a fixture, so we know the Preview it gives.
- **Open question:** whether a Preview belongs in the Journal or only in the Daemon's cache. A cache is enough to start.

### Uploads

IRC has no attachments, so the Daemon hosts what the Owner wants to show. It is optional, and off until the Owner says where its links are reached.

- **The Owner attaches a file in the Composer,** by paste, drop, a picker, or a phone's camera, several at once, each showing its progress. Its link goes into the draft where the cursor is, with a thumbnail, and is said when the Owner sends.
- **A link ends in the file's own name,** after a name nobody could guess, such as `/3f9c…/cat.png`. A reader in any IRC client sees what it is before opening it.
- **Every upload is recorded:** its name, type, size, when, and where it was said. The options list them, to view, copy a link, or delete. A deleted upload's link answers 404.
- **Uploading is the API's,** under a key or a sign-in like everything else, so a script or an agent can upload too.
- **Nothing uploaded can act.** Its type is read from the bytes, once, never from its name or the browser's word. Images, video, sound, text and PDF show in place, anything else downloads, an SVG among them, and every answer carries `nosniff` and a CSP that sandboxes it.
- **A photo loses its location.** The Daemon strips EXIF and other metadata from an image, keeping which way up it is and leaving its pixels as they were.
- **Bounded:** a limit on one file and on the whole store, and an expiry if the Owner sets one.
- **Where the bytes are kept is a port:** the Daemon's own disk, or an S3-compatible bucket.
- **Where a link points is a separate choice.** Either a second listener of the Daemon's, which answers a `GET` of an upload and nothing else, with no API, cookie, or listing, and which the Owner puts on the internet behind a proxy or a tunnel. Or the bucket's own public address, where the bucket serves each upload with the type and disposition the Daemon set on it.
- **A link to our own upload gets its Preview with no fetch.**
- **Open questions:** whether an upload and its deletion are Changes in the Journal with the bytes outside it, which is how everything else is kept; and whether an image is also resized.

## What an IRC client is expected to do

Small things, each independent of the rest.

- **Removing a Network,** not only disabling it. Its Configuration and Credentials go, and whether its Timelines stay readable is the Owner's choice as they remove it.
- **Closing a Timeline:** a Direct Message, or a Channel the Owner left, out of the Sidebar until something is said there again.
- **Ignoring a User,** by mask, as Configuration so every Frontend agrees. What they say is still journaled, and is neither shown, counted, nor notified.
- **CTCP.** `VERSION`, `PING`, `TIME` and `CLIENTINFO` answered, bounded so they cannot be used to flood Self off, with an option to answer nothing. Requests and replies are Activity, and `/ctcp` and `/ping` send them.
- **Logging in where there is no SASL:** a Credential said to a service as a Session begins, before its Channels are joined; `OPER` with a Credential; user modes to set; and Lines of the Owner's own to send then.
- **Taking a nick back.** When a configured nick was taken, Self takes it once its holder is seen to leave it.
- **A Channel's lists:** its bans, exceptions and invitation masks read as a Lookup, shown, and removed from. `/names` and `/who` beside them.
- **`LIST`** as a Lookup: a Channel directory, filtered on the Ircd with `ELIST` where it can, bounded and paged, with `/join` from a result.
- **Invitations:** an invite shown with an offer to join.
- **A menu on a nick,** wherever one is shown: look up, message, ignore, and op, voice, kick or ban where Self may.
- **Writing:** keys for bold, italic and colour, shown as they will look; emoji completed from `:name`; and aliases of the Owner's own.
- **Reading:** a line where the day changes; a run of joins, parts and quits folded into one line, with an option to hide those of Users who have not spoken; jumping to a date; and a Timeline exported as text.
- **The Sidebar in the Owner's order,** with Timelines pinned or muted.
- **Away by itself,** when no Frontend has been open for a time the Owner sets.

## IRCv3, by how widely it is offered

Ratified specifications only, ordered by how many Ircds and Networks offer each and how many IRC clients use it, as IRCv3's own support tables count them. Each is a Feature that sharpens what the Client already keeps.

1. **Accounts:** `account-tag`, `account-notify` and `extended-join`, so each User's account is known as they speak, log in, and join. `account-extban` beside them, so a ban can name an account.
2. **Masks and names:** `chghost`, `userhost-in-names` and `setname`.
3. **Bots and invitations:** bot mode, to mark a User that says it is one, and `invite-notify` for an `Invited` Activity.
4. **Presence:** `MONITOR` with `extended-monitor`, for Direct Message partners and for a nick to take back, pushed by the Ircd rather than polled. `WATCH` where an Ircd offers only that.
5. **`WHO` with `WHOX`,** once on joining, for the accounts and away status of members already there.
6. **Replies,** through the `reply` client tag: a Message shown with what it answers, and written from a Message's menu. `channel-context` beside it.
7. **`standard-replies`:** `FAIL`, `WARN` and `NOTE` read by code.
8. **`netsplit` and `netjoin` batches,** shown as one Activity rather than hundreds of quits.
9. **SASL `SCRAM-SHA-256` and `EXTERNAL`,** the latter with a client certificate, and logging in again when `sasl` is offered anew. Both need a decision on where a challenge's answer is worked out.
10. **Typing,** through `TAGMSG`, once we decide how the Journal holds Lines that can arrive every few seconds.

Not taken up: `no-implicit-names`, since the Client wants the names; IRC over WebSocket, since the Daemon dials TCP; and WebIRC, which is for gateways.

## On a phone, and as an app

- **An installable web app,** with a manifest and an icon, served by the Daemon.
- **Web Push,** so a phone is notified of Highlights and Direct Messages with the page closed.
- **Sharing to iirc** from a phone's share sheet, once there are uploads.
- **Touch, past the basics:** back closing the drawer and the sheet, a swipe to open the drawer, and dragging the dividers between Panes on a tablet.

## The Owner's own keys and rules

- **Keymap overrides** as `ui` options shared by every device, overridable per device. `keymapOf` already reads them.
- **Chords in sequence,** such as a leader key, if the Owner wants one.
- **Notification rules** per Network, per Timeline, and for words of the Owner's own.
- **The layout under `ui`,** shared by every device, rather than per device.
- **One Timeline in two Panes,** at two places, as WeeChat and tmux allow.

## Search

- Several terms that must all appear, or any, beyond one phrase.
- Activity: topics, and the reasons given for a part, quit or kick.

## The Daemon and its operation

- **`iirc config`, `iirc credential` and `iirc backup`,** as Frontends of the API, and **`iirc web`,** the web frontend alone as a proxy to a Daemon elsewhere.
- **Key scopes** (`read`, `chat`, `admin`, as ADR 0006 names them), managing keys through the API, and listing and ending sign-ins.
- **Pruning** what the Timelines keep, and snapshots so a News reader does not fold the Journal from its start.
- **Pacing per Network,** taking an Ircd's advertised limits, and a cost per Line where an Ircd charges more.
- **Dialling through a proxy,** such as SOCKS, and a flag to trust extra TLS roots.
- **Builds for other platforms.**

## Below the line

Nothing here is taken up until it is asked for. What we know of each is kept so it is not worked out twice.

### IRCv3 drafts

A draft waits until it is ratified, or until something above cannot be done well without it.

- **`chathistory`:** when a Session begins after a Gap, ask the Ircd for what was said during it, and show it in place with `live` false. It must route Activity by the batch's target, not by the Network's state now.
- **`read-marker`:** send `MARKREAD` when the Owner reads, and take the Ircd's own markers, so iirc and the Owner's other IRC clients agree (ADR 0014 has the shape).
- **`multiline`,** both ways, so a pasted block is one Message where the Ircd allows it.
- **`message-redaction`:** a redacted Message shown as such. Whether the Journal scrubs its bytes is a decision to make first.
- **`channel-rename`:** a Channel's Timeline renamed in place, keeping its id, as a Direct Message Timeline already follows a nick.
- **Reactions, `pre-away`, `extended-isupport`, account registration, metadata and a Network's icon:** nothing planned.

### Previews that need a service's API

A Preview richer than a page's own tags give, from an adapter written for one service: a pure function from a link to what to ask, and from the answer to a Preview.

- **X:** the post a post quotes, and a thread, which its page and its oEmbed leave out.
- **Reddit and TikTok:** their pages give a plain fetch nothing, and do not point at their oEmbed, which answers when asked directly.
- **GitHub:** the lines a permalink names, and an issue's or pull request's state.
- **Wikipedia:** an article's summary from its REST API.
- **Hacker News:** a story with its score. Its page carries no tags.
- **Instagram,** which gives little.
