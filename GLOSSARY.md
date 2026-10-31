# iirc

iirc is an always-on IRC client made of a library, a daemon, and frontends. IRC reuses words like "server", "client", and "message" for several things, so this glossary fixes what each one means here.

## Our system

**Daemon**: The headless program that stays on Networks on the Owner's behalf and exposes the API. _Avoid_: Server, client, bouncer, iircd

**Frontend**: Any program that uses the Daemon's API, including the web app, a script, or an agent. _Avoid_: Client, operator, consumer

**Owner**: The one human a deployment belongs to. _Avoid_: User, admin, operator

**Log**: The Daemon's ordered record of every Line in both directions. _Avoid_: History, scrollback, buffer

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

## What is exchanged

**Line**: Any single unit of the IRC protocol, in either direction. _Avoid_: Message, raw message

**Message**: Something a participant said, carried by a `PRIVMSG` or `NOTICE` Line. Every Message arrives as a Line, but most Lines are not Messages. _Avoid_: Line, event, chat

**Target**: The Channel or User a Message is addressed to. _Avoid_: Conversation, query, buffer

**Direct Message**: A Message whose Target is a User. Grouping these by the other participant is a Frontend's concern. _Avoid_: Query, private message, PM
