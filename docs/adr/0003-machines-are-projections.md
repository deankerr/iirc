# Machines are projections

**Superseded by [ADR 0009](0009-client-machines-are-reducers.md), 2026-11-09.** The machines stay reducers, as here, but timers are outputs the Client asks for, not Deadline Entries. [The XState spike](../notes/2026-11-09-xstate-spike.md) has the evidence.

A Network's lifecycle machine is a pure fold over Entries, written as a plain reducer, and it holds no timers. Running it as a live actor was the obvious choice, but an actor's state and timers would be a second truth beside the Journal, and could not be rebuilt after a crash or read at a past sequence. As a fold, status and `/state?at=` are the same computation, and a machine steps inside the append transaction.

## Consequences

Deadlines are absolute times in context, and the host waits on them. A deadline that expires with no trace on the wire becomes a Deadline Entry, so the Journal gains an Entry kind that exists only for this. `@xstate/effect` is not used, because it cannot record a timer before it applies, which recording before acting needs, so the host is ours to maintain. Nor are `after` and `enq.emit`, whose cost per step grew from about 150 µs to over 1 ms within thousands of steps. Nothing is spawned per Channel or Lookup, because those are small tables that an actor would only add replay state to.

The machine first ran on XState's `transition`. Used only as a pure step, XState gave the machine no actors, no timers, and no emitted events, yet it named Commands by function names that minification could take, which needed empty action stubs, a parser to read Commands back out of its effects, and a minified build test. It was also an alpha with renames between releases. The machine is now `(machine, event) => { commands, next }`, which an old Journal replays to the same results: before XState was removed, the two agreed on every Command, phase, deadline, and context over 180,000 random steps.
