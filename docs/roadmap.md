# Roadmap

What iirc plans to build next, grouped by what the Owner would notice, roughly in the order we expect to take it. Each item is built as a vertical slice: the contract, the Client or Daemon, and the web frontend together, reviewed until nothing blocking is left. Each module's README ends with what it does not do yet, in more detail than here, and [`known-issues.md`](known-issues.md) lists what is built but not yet right.

The order bends to what the Owner finds in daily use.

## Link previews

A Message's links shown as cards: a page's title and image, an image or video inline, a post from X.

- **The Daemon fetches, never the browser.** A browser fetching a link a stranger posted gives that stranger the Owner's IP address on every device. The Daemon fetches each link once, on demand, and serves the card and its media from its own origin, so the page's CSP keeps `img-src 'self'`.
- **Fetching is guarded against SSRF.** The Daemon resolves the name itself, refuses loopback, private, link-local and other special ranges, connects to the address it checked, follows redirects one at a time checking each, and caps size, time and content types. It keeps what it fetched, failures included, and serves media by its own hash, so it is never an open proxy.
- **Off until the Owner turns it on,** per Network or per Timeline as options under `ui`, and fetched only when a Message is shown, since fetching ahead tells a link's host when the Daemon saw it.
- **Providers in order:** OpenGraph and oEmbed for most pages, images and video by content type, YouTube as a click-to-load `youtube-nocookie` frame in a sandbox, and X through an adapter that falls back to OpenGraph. X's own embed script is never loaded.
- **Open question:** whether a preview belongs in the Journal or only in the Daemon's cache. A cache is enough to start.

## History and read state from the Ircd

- **`chathistory`:** when a Session begins after a Gap, ask the Ircd for what was said during it, and show it in place with `live` false. The Client routes Activity from history by the Network's state now, not then ([known issues](known-issues.md)), so a `chathistory` Feature must route by the batch's target instead.
- **`draft/read-marker`:** send `MARKREAD` when the Owner reads, and take the Ircd's own markers, so iirc and the Owner's other clients agree ([ADR 0014](adr/0014-read-markers-and-highlights-belong-to-the-client.md) already has the shape).
- **`netsplit` and `netjoin` batches,** shown as one Activity rather than hundreds of quits.

## Finding Channels and people

- **`LIST`** as a Lookup: a Channel directory, filtered on the Ircd with `ELIST` where it can, bounded and paged, with `/join` from a result.
- **`WHO` with `WHOX`,** once on joining, for accounts and away status of members.
- **`MONITOR`** for Direct Message partners: whether they are online, pushed by the Ircd rather than polled.

## Who a User is

The caps that sharpen facts the Client already keeps, each a Feature: `account-notify`, `extended-join` and `account-tag` for accounts; `chghost` and `userhost-in-names` for masks; `setname` for realnames; `bot-mode` for bots; `invite-notify` for an `Invited` Activity; and `standard-replies` for `FAIL`, `WARN` and `NOTE` by code.

## Messages

- **`draft/multiline`,** both ways, so a pasted block is one Message where the Ircd allows it.
- **`message-redaction`:** a redacted Message shown as such. Whether the Journal scrubs its bytes is a decision to make first.
- **`channel-rename`:** a Channel's Timeline renamed in place, keeping its id, as a Direct Message Timeline already follows a nick.
- **Replies and reactions** through client tags (`+draft/reply`, `+draft/react`), and **typing** through `TAGMSG`, once we decide how the Journal holds Lines that can arrive every few seconds.

## On a phone, and as an app

- **An installable web app,** with a manifest and an icon, served by the Daemon.
- **Web Push,** so a phone is notified of Highlights and Direct Messages with the page closed.
- **Touch, past the basics:** the phone layout tested on a real iPhone and Android phone, the keyboard on iOS Safari kept from hiding the bar, back closing the drawer and the sheet, a swipe to open the drawer, a member's actions without a long press, and dragging the dividers between Panes on a tablet.

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
- **Removing a Network,** not only disabling it.
- **Key scopes** (`read`, `chat`, `admin`, as [ADR 0006](adr/0006-proportionate-security.md) names them), managing keys through the API, and listing and ending sign-ins.
- **Pruning** what the Timelines keep, and snapshots so a News reader does not fold the Journal from its start.
- **Pacing per Network,** taking an Ircd's advertised limits, and a cost per Line where an Ircd charges more.
- **SASL `SCRAM-SHA-256` and `EXTERNAL`,** which need a decision on where a challenge's answer is worked out.
- **Builds for other platforms,** and a flag to trust extra TLS roots.
- **Browsers beyond Chromium:** Safari, Firefox and screen readers, checked by hand and, where Playwright can, in the end-to-end runs.
