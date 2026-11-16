# A Preview is a cache outside the Journal

A Preview is what the Daemon fetched of a link at some moment, and it is kept in a cache beside the Journal. It is not a Change and it is not derived from the Journal. [ADR 0002](0002-the-journal-holds-bytes.md) says everything else is derived from the Journal, so a reader will expect a Preview to be, but a Preview is derived from a page on the internet, which the Journal never held.

Journaling each page a stranger links would grow the Journal with things that never crossed IRC, one record for every link a Network happens to carry. A Preview can always be fetched again, so losing the cache loses nothing the Owner made. An Upload is different, as [ADR 0016](0016-uploads-are-changes-and-their-bytes-are-kept-outside.md) says: the Owner made it, so its record is a Change. A Timeline shows what the cache gives at the time it is read, and a page that has changed since shows as it is now.

## Consequences

- What a Preview needs to be shown again, such as its text and its failure, lives in the cache, keyed by the normalised link. Emptying the cache changes no Timeline, only what is fetched next.
- Which links a Message carries is still derived from the Journal, as the Message is. Only what the Daemon fetched of them is outside it.
- A Preview's media will be held in the Uploads store as references that may be evicted, never as Uploads. The store keeps one copy of each hash, and a Preview's reference does not keep it once the store needs room.
