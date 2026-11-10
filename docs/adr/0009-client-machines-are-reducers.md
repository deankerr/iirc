# The Client's machines are reducers, and their timers are outputs

Each machine inside the Client is a plain reducer over a discriminated union. That covers the Network and its Connection, Caps, Presence, Keepalive, and each Channel. A reducer takes the machine's state and an event, and returns its next state with what it said, which the Client turns into outputs and News. The statecharts in [the architecture](../architecture.md#machines) are the design, and each reducer's states and tests follow them. A timer is a `Wake` output computed from the input's `at`, and comes back as `Fired`, so the Journal needs no Entries for deadlines. Channels are a keyed `Map` of reducer states inside the Client's State.

Running the machines as live actors was the obvious choice, but an actor's state and timers would be a second truth beside the Journal, and could not be rebuilt after a crash or read at a past sequence. As reducers, the state now and the state at any sequence are the same fold.

We tried XState 5's pure `transition` behind `step`, and it fitted without changing the interface. It was dropped because in pure mode it gives up the parts a reducer cannot match, which are actors, the scheduler, and inspection. It still cost about 127 times as much per machine step: 12.7 µs against 0.1 µs, or 51 µs a step and 10 s for a month of one Network. Its live snapshot holds class instances and functions, so State had to hold a persisted copy and restore it on every step. Spawned children lose their entry actions, and the events sent to them, under pure `transition`. A child spawned without an id takes a process-wide counter into its snapshot.

## Consequences

- The Client keeps each timer's event and stale detection in its State. Timers are derived from state: each state names the timers it wants, and a step outputs a `Wake` for each difference. Leaving a state then cancels its timers in one place.
- `inspect` names states with the statecharts' dotted names, such as `Ready.Steady`, whichever way a machine is written.
- Model-based coverage comes from property tests that feed each reducer random event sequences and check its invariants.
- The keepalive must not write a `Wake` for every Received Line. One timer checks, when it fires, when we last heard something.
- At 1 to 2 µs a step, a year of one Network replays in seconds, without snapshots of State.
- XState v6 is worth measuring again if it makes `transition` cheap, its snapshots plain data, and its children work in pure mode. The benchmark is kept at the git tag `spike/xstate`.
