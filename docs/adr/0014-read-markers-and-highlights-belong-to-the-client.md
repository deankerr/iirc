# Read Markers and Highlights belong to the Client

A Read Marker is how far through a Target the Owner has read, as an instant that only ever moves forward, and the Client keeps it. Marking read is an Owner input, `Read { target, at }`, journaled and stepped like any other. The Client keeps the latest instant per Target, folded with the casemapping the Network declared, and reports it as News with `where`, so a Read Marker is shared by every Frontend and rebuilt on replay. This is the shape IRCv3's `draft/read-marker` gives it, so a Feature can later send `MARKREAD` and accept the Ircd's own, and a Read Marker from another of the Owner's clients moves ours forward. The Client also decides which Messages are Highlights: one said live by someone else that names Self's current nick as a word, or matches one of the Owner's highlight words. Only the Client knows the nick in force and the casemapping, and every Frontend has to agree on which Messages called for the Owner.

## Consequences

- A Read Marker moves only forward. An earlier instant changes nothing, so two Frontends marking at once cannot move it back.
- A Direct Message Timeline's Read Marker follows its partner's nick, as the Timeline does.
- `NetworkConfiguration` gains `highlights`: words that make a Message a Highlight, matched case-insensitively as whole words, as the nick is.
- Message News carries `highlight`. A Message from history is never a Highlight, since it does not call for the Owner now.
- The Timelines projection keeps each Timeline's Read Marker and how much lies after it, by level as WeeChat ranks activity: Activity, Messages, Direct Messages, and Highlights. A Frontend reads the counts and never works them out.
- Marking read stays a Frontend's decision, such as when the Owner has seen the latest of an open Timeline. The Daemon only records it.
