# The Client's machines are reducers, and their timers are outputs

**Accepted, 2026-11-09.** Supersedes [ADR 0003](0003-machines-are-projections.md). The evidence is in [the XState spike](../notes/2026-11-09-xstate-spike.md).

Each machine inside the Client is a plain reducer over a discriminated union. That covers Connection, Caps, Presence, Keepalive, each Channel, and each Lookup. A reducer takes the machine's state and an event, and returns its next state with what it said, which the Client turns into outputs and News. The statecharts in the architecture proposal are the design, and each reducer's states and tests follow them. A timer is a `Wake` output computed from the input's `at`, and comes back as `Fired`, so the Journal needs no Deadline Entries. Channels are a keyed `Map` of reducer states inside the Client's State.

We tried XState 5's pure `transition` behind `step`, and it fitted without changing the interface. It was dropped because in pure mode it gives up the parts a reducer cannot match, which are actors, the scheduler, and inspection. It still costs about 127 times as much per machine step: 12.7 µs against 0.1 µs, or 51 µs a step and 10 s for a month of one Network. Its live snapshot holds class instances and functions, so State had to hold a persisted copy and restore it on every step. Spawned children lose their entry actions, and the events sent to them, under pure `transition`. A child spawned without an id takes a process-wide counter into its snapshot.

## Consequences

- The Client keeps the timer table, each timer's event, and stale detection in its State, as the spike's XState Client had to anyway. Timers are derived from state: each state names the timers it wants, and a step outputs a `Wake` for each difference. Leaving a state then cancels its timers in one place, which was the one thing XState did better.
- `Inspection.states` uses the statecharts' dotted names, such as `Ready.Steady`, whichever way a machine is written.
- Model-based coverage comes from property tests that feed each reducer random event sequences and check its invariants. `xstate/graph` generated useful Caps paths, and can come back as a test-only tool if a machine outgrows that.
- The keepalive must not write a `Wake` for every Received Line. One timer checks, when it fires, when we last heard something.
- By the spike's estimate of 1 to 2 µs a step, a year of one Network replays in seconds, without snapshots of State.
- XState v6 is worth measuring again if it makes `transition` cheap, its snapshots plain data, and its children work in pure mode. The spike's benchmark is kept for that.
