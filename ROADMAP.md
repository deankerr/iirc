# Roadmap

What iirc plans to build next, grouped by what the Owner would notice, roughly in the order we expect to take it. Each item is built as a vertical slice: the contract, the Client or Daemon, and the web frontend together, reviewed until nothing blocking is left.

The order bends to what the Owner finds in daily use.

## Media

IRC carries text, so a picture is always a link. Two features make a link feel like media, and both rest on one store in the Daemon: bytes kept by their hash beside the Journal, with what each is, served from an origin that runs no script. A Timeline shows an image, a video, or a sound from it in place, and larger on a press.

### Link previews

A Message's links shown as cards: a page's title and image, media in place, a post from X.

- **The Daemon fetches, never the browser.** A browser fetching a link a stranger posted gives that stranger the Owner's IP address on every device. The Daemon fetches each link once, on demand, and serves the card and its media from its own origin, so the page's CSP keeps `img-src 'self'`.
- **Fetching is guarded against SSRF.** The Daemon resolves the name itself, refuses loopback, private, link-local and other special ranges, connects to the address it checked, follows redirects one at a time checking each, and caps size, time and content types. It keeps what it fetched, failures included, and serves media by its own hash, so it is never an open proxy.
- **Off until the Owner turns it on,** per Network or per Timeline as options under `ui`, and fetched only when a Message is shown, since fetching ahead tells a link's host when the Daemon saw it.
- **Any page** by OpenGraph, Twitter card tags and oEmbed, and **a link to media itself** by its content type: an image, an animated image, a video, or a sound.
- **A named service is an adapter:** a pure function from a link to what to fetch, and from the answer to a card, tested on recorded answers. A service's player loads only on a press, in a sandboxed frame, and its script is never loaded into the page.
- **Open questions:** whether a preview belongs in the Journal or only in the Daemon's cache, where a cache is enough to start; and whether X's unofficial syndication answer is worth relying on where its oEmbed gives too little.

The services, in the order we expect to add them:

| Service | The card shows | From |
| --- | --- | --- |
| YouTube | Title, channel, length and thumbnail, and the player from the link's time in a `youtube-nocookie` frame | oEmbed |
| X | A post's text, author and media, and the post it quotes | Its oEmbed, then OpenGraph |
| Bluesky, Mastodon | A post's text, author and media | Their open APIs |
| GitHub | A repository, issue, pull request, commit or gist, and the lines a permalink names | Its API, then OpenGraph |
| Reddit | A post or comment, with its community and media | oEmbed |
| Imgur, Giphy, Tenor | The image or video the page wraps | OpenGraph, then the media |
| Twitch, Vimeo, Streamable | A stream, clip or video, and its player | oEmbed |
| Wikipedia | An article's summary and image | Its REST API |
| Spotify, SoundCloud, Bandcamp | A track, album or playlist | oEmbed |
| Instagram, TikTok | What OpenGraph gives, where they answer at all | OpenGraph |
| Hacker News, Stack Overflow | A story or question, with its score | Their APIs |

### Uploads

IRC has no attachments, so the Daemon hosts what the Owner wants to show.

- **The Owner attaches a file in the Composer,** by paste, drop, a picker, or a phone's camera, and the Message that goes out carries its link. Everyone else sees a link, in any IRC client.
- **The link has to open for strangers, so uploads get an origin of their own.** A second listener answers a `GET` of an unguessable name and nothing else: no API, no cookie, no listing. The Owner puts that listener on the internet and tells the Daemon its public address as an option. Until then uploads are off.
- **Nothing uploaded can act.** Its type is read from the bytes, never from its name or the browser's word. Images, video, sound, text and PDF show in place, anything else downloads, and every answer carries `nosniff` and a CSP that sandboxes it.
- **A photo loses its location.** EXIF and other metadata are stripped from an image before it is kept, since a phone writes where a photo was taken.
- **The Owner's to keep or take back:** a limit on one file and on the whole store, an expiry if the Owner sets one, and a list in the options to delete from. A deleted upload's link answers 404.
- **The store is a port.** The Daemon's own disk is one adapter, and an S3-compatible bucket another, for an Owner who would rather not expose the Daemon.
- **A link to our own upload previews with no fetch,** and so does a draft before it is sent.
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
- **Touch, past the basics:** the phone layout tested on a real iPhone and Android phone, the keyboard on iOS Safari kept from hiding the bar, back closing the drawer and the sheet, a swipe to open the drawer, and dragging the dividers between Panes on a tablet.

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
- **Browsers beyond Chromium:** Safari, Firefox and screen readers, checked by hand and, where Playwright can, in the end-to-end runs.

## Drafts

An IRCv3 draft waits until it is ratified, or until something above cannot be done well without it. What we know of each:

- **`chathistory`:** when a Session begins after a Gap, ask the Ircd for what was said during it, and show it in place with `live` false. It must route Activity by the batch's target, not by the Network's state now.
- **`read-marker`:** send `MARKREAD` when the Owner reads, and take the Ircd's own markers, so iirc and the Owner's other IRC clients agree (ADR 0014 has the shape).
- **`multiline`,** both ways, so a pasted block is one Message where the Ircd allows it.
- **`message-redaction`:** a redacted Message shown as such. Whether the Journal scrubs its bytes is a decision to make first.
- **`channel-rename`:** a Channel's Timeline renamed in place, keeping its id, as a Direct Message Timeline already follows a nick.
- **Reactions, `pre-away`, `extended-isupport`, account registration, metadata and a Network's icon:** nothing planned.
