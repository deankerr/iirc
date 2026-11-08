# iirc

iirc is an always-on IRC client made of a library, a daemon, and frontends. IRC reuses words like "server", "client", and "message" for several things, so this glossary fixes what each one means here.

## Our system

**Daemon**: The headless program that stays on Networks on the Owner's behalf and exposes the API. _Avoid_: Server, client, bouncer, iircd

**Frontend**: Any program that uses the Daemon's API, including the web app, a script, or an agent. _Avoid_: Client, operator, consumer

**Owner**: The one human a deployment belongs to. _Avoid_: User, admin, operator

**Journal**: The Daemon's ordered record of everything that happened, as Entries: what it was told, and what it did. Everything else is derived from it. _Avoid_: Log (overloaded), history, scrollback, buffer

**Entry**: One numbered record in the Journal, such as a Line, a Connection opening or closing, or a Change. _Avoid_: Event, record, row

**Change**: Something the Owner altered, such as Configuration or a Read Marker. _Avoid_: Update, mutation

**Configuration**: What the Owner wants to be true, as opposed to what is true. _Avoid_: Settings, desired state

**Credential**: A secret the Owner gives the Daemon to use on their behalf, which it can use but never reveal. Nothing a Network sends is a Credential. _Avoid_: Password, secret

## The IRC side

**Network**: An IRC service the Owner belongs to, which is what gets configured and what history belongs to. It outlives any Ircd, Connection, or Session. _Avoid_: Server, IRC server

**Ircd**: A single IRC server process that a Connection reaches. One Network may be served by many. _Avoid_: Server, IRC server

**IRC client**: Any other software connected to an Ircd, such as irssi. Always the full phrase. _Avoid_: Client

**User**: Any participant on a Network, including our own presence there. _Avoid_: Client, person, peer

**Self**: Our own User on a Network. _Avoid_: Me, bot

**Channel**: A named place on a Network where Users exchange Messages. _Avoid_: Room, group

## Being connected

**Connection**: One transport to an Ircd, which may end before registration completes. _Avoid_: Link, socket

**Session**: The registered presence on a Network, lasting from welcome until its Connection ends. A reconnect is always a new Session. _Avoid_: Connection, login

**Gap**: A period when the Daemon was not on a Network, so anything said then is unknown. _Avoid_: Downtime, outage

## What is exchanged

**Line**: Any single unit of the IRC protocol, in either direction. _Avoid_: Message, raw message

**Message**: Something a participant said, carried by a `PRIVMSG` or `NOTICE` Line. Every Message arrives as a Line, but most Lines are not Messages. _Avoid_: Line, event, chat

**Target**: The Channel or User a Message is addressed to. _Avoid_: Conversation, query, buffer

**Direct Message**: A Message whose Target is a User. Grouping these by the other participant is a Frontend's concern. _Avoid_: Query, private message, PM

**Activity**: Something that changed on a Network rather than something said, such as a join, a quit, or a topic change. _Avoid_: Event, notice, status

**Lookup**: Asking a Network for information and collecting the reply, which may span many Lines. _Avoid_: Query, request

## What a Frontend sees

**Timeline**: The ordered Messages and Activity of one Channel, Direct Message partner, or Network. _Avoid_: Buffer, window, scrollback, conversation

**Read Marker**: How far through a Timeline the Owner has read, shared by every Frontend. _Avoid_: Unread pointer, last seen

**Highlight**: A Message that calls for the Owner's attention, such as one that mentions Self. _Avoid_: Mention, ping, alert
