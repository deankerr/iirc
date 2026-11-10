# Timelines are a projection the Client routes

A Timeline is derived from News and kept in a derived store the Daemon can delete and rebuild. Frontends read windows of it and follow its changes, and never fold News themselves. The Client decides which Timelines each Message and Activity belongs to, because that depends on the casemapping in force, Self's nick, and who shared which Channel at that moment, and only the Client knows those. If a projection worked this out again from News, it would be a second copy of the Client's knowledge that could drift from it.

## Consequences

- Message and Activity News carries `where`: the folded keys of the Timelines it touches. A `Quit` or a `NickChanged` lists every Channel the User shared with Self, and their Direct Message Timeline if there is one.
- The Daemon groups Direct Messages by the other participant, for every Frontend alike.
- A Timeline has an opaque id, given when it is first seen and stable across rebuilds. No name a Network chose becomes a key or a path, and a later Channel rename keeps the id.
- A Direct Message Timeline follows its partner's nick changes that Self can see, as WeeChat renames a private buffer. IRC's floor gives no better identity. Someone else who later takes the old nick starts a Timeline of their own.
- Items are ordered by position `(at, sequence, n)`, where `n` is the News's index within its step. Read Markers, search results, and links point at positions.
- The store is a separate file, `views.sqlite`, holding the last sequence it folded. A new projection version deletes it and rebuilds it from the Journal ([ADR 0002](0002-the-journal-holds-bytes.md)).
