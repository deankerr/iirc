# Machines are projections

A Network's lifecycle machine is a pure fold over Entries, run with XState's `transition`, and it holds no timers. Running it as a live actor was the obvious choice, but an actor's state and timers would be a second truth beside the Log, and could not be rebuilt after a crash or read at a past sequence. As a fold, status and `/state?at=` are the same computation, and a machine steps inside the append transaction.

## Consequences

Deadlines are absolute times in context, and the host waits on them. A deadline that expires with no trace on the wire becomes a Deadline Entry, so the Log gains an Entry kind that exists only for this. `@xstate/effect` is not used, because it cannot record a timer before it applies, which LOG-4 needs, so the host is ours to maintain. Nor are `after` and `enq.emit`, whose cost per step grew from about 150 µs to over 1 ms within thousands of steps. Nothing is spawned per Channel or Lookup, because those are small tables that an actor would only add replay state to. XState stays behind `step` and `fold`, and tests do not depend on it, so a plain reducer could replace it.
