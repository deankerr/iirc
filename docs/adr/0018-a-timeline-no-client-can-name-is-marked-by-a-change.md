# A Timeline no Client can name is marked by a Change

A Frontend marks read, or closes, a Timeline by its id as well as by a Target. When the id names a Timeline that a Network's Client can still name, the Client takes it as [ADR 0014](0014-read-markers-and-highlights-belong-to-the-client.md) says, given the Timeline as the projection holds it rather than a Target to parse. Two kinds of Timeline have no Client to take it: a detached Direct Message Timeline, which no name reaches, and a removed Network's kept Timelines, whose Client is gone. For those the Daemon journals a Change naming the Timeline's id, and the Timelines projection folds it as it folds a Read Marker or a close from a Client. We chose this over keeping every Read Marker outside the Client, which would give up ADR 0014's one source for a Read Marker and the place `draft/read-marker` will meet the Ircd's own. We also chose it over keeping a removed Network's Client to hold its markers, which would keep a Client with no Network.

## Consequences

- A Read Marker set by a Change moves only forward, as one set by a Client does.
- A closed detached Timeline never opens again, since nothing arrives in it. It is still found by search and by its id.
