# Machines are projections

A Network's lifecycle machine is a pure fold over Entries, run with XState's `transition`, and it holds no timers. Running it as a live actor was the obvious choice, but an actor's state and timers would be a second truth beside the Log, and could not be rebuilt after a crash or read at a past sequence. As a fold, status and `/state?at=` are the same computation, and a machine steps inside the append transaction.

## Consequences

Deadlines are absolute times in context, and the host waits on them. A deadline that expires with no trace on the wire becomes a Deadline Entry, so the Log gains an Entry kind that exists only for this. `@xstate/effect`, `after`, and `enq.emit` are not used, and the host is ours to maintain. XState stays behind `step` and `fold`, and tests do not depend on it, so a plain reducer could replace it.
