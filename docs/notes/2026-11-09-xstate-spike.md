# XState spike: does `transition` earn its place inside `step`?

Status: spike result, 2026-11-09. It answers [the architecture proposal](2026-11-07-architecture-proposal.md)'s §6 and §8.1, and [ADR 0009](../adr/0009-client-machines-are-reducers.md), accepted the same day, records the decision.

## The answer

No. XState 5's pure `transition` works inside `step` without changing the Client's interface, and it is deterministic if we avoid one trap. But in pure mode it gives us almost nothing a reducer lacks. It costs about 127 times as much per machine step, and the Client's State cannot hold its snapshots. The parts of XState that a reducer cannot match are actors, the scheduler, and inspection, and those are exactly the parts the pure path switches off.

The machines should be plain reducers over discriminated unions, as ADR 0003 has them. Timers should be `Wake` outputs, as the substrate already says. Channels should be a keyed `Map` of reducer states. The statecharts stay as the design and as diagrams. The substrate needs no change.

## What was built

The code is on the branch `t3/xstate-client-spike`, in `packages/client/src/spike/`, kept to port from. Everything there is behind `Client<State>`, with tests through `step`:

| File | What it is |
| --- | --- |
| `network.ts` | Connection (Unconfigured, Idle, Waiting, Dialing, Open, Closing), with Presence and Keepalive as parallel regions of Open. One backoff. Nick offers on 432 and 433. |
| `caps-xstate.ts` | Caps on XState: `LS 302` over several Lines, REQ, ACK and NAK, `CAP END`, `CAP NEW` and `CAP DEL`, SASL PLAIN through `SendSecret`, 903, 904 to 908 with login optional or required, and the floor on `421` or `001`. |
| `caps-reducer.ts` | The same Caps machine as a reducer, the baseline. |
| `cap-data.ts` | The data both Caps machines share: reading cap lists, choosing what to ask for. |
| `channel.ts` | Wanted, Joining, Joined (Syncing, Synced), Kicked and Refused with a rejoin timer. |
| `names.ts` | The core's `NAMES` reading, and `multi-prefix` as a `Feature` through the seam in `feature.ts`. |
| `client.ts` | The glue: input to events, actions to outputs and News, the timer table, Knowledge, and Inspection. `makeClient(caps)` takes either Caps machine. |
| `traffic.ts`, `bench.ts` | A month of synthetic traffic, driven the way a Runtime would, and the benchmark. Run `bun src/spike/bench.ts`. |

The spike has 51 tests. The same Caps table runs against both implementations, and the whole Client gives the same outputs and News over either Caps.

## Replay cost

The month has 202,525 inputs: 201,380 Received Lines across three Channels, 915 timer firings, and 115 Connections, each ended by a silence or a reset. It was measured on a Ryzen 5 3600 with Bun 1.4.4, using XState's production build, one warm run each.

| What | µs per step | Steps per second | The month |
| --- | --: | --: | --: |
| The whole Client, XState Caps | 51.2 | 19,500 | 10.4 s |
| The whole Client, reducer Caps | 33.8 | 29,600 | 6.8 s |
| Caps alone, reducer | 0.10 | 10,000,000 | 0.02 s |
| Caps alone, XState, with State held persisted | 12.7 | 78,600 | 2.6 s |
| Caps alone, XState, with a live snapshot (not plain data) | 7.9 | 127,000 | 1.6 s |
| `transition` on an empty machine | 4.9 | 204,000 |  |
| `resolveState` and `getPersistedSnapshot` alone | 2.1 | 471,000 |  |
| Parsing a Line's bytes | 0.5 | 2,000,000 |  |

One Received Line costs about 45 µs. About 25 µs of that is the Network machine, 13 µs is Caps, and the rest is glue. Half of the Network machine's time is restoring and persisting its snapshot.

- **The floor is high.** Every `transition` call builds an actor and two actor systems in `createInertActorScope`, and that actor eagerly computes the machine's initial snapshot. That costs 4.9 µs before any of our logic runs, which is fifty reducer steps.
- **Cost does not grow.** Per 20,000 inputs, a step costs 44 to 48 µs from the first chunk to the last. ADR 0003 saw growth from 150 µs to over 1 ms, but that was a live actor with `after` and `emit`. In pure mode the scheduler never runs, and a persisted snapshot holds no history, so nothing accumulates.
- **A reducer Client would cost about 1 to 2 µs a step.** That is an estimate, not a measurement: Caps as a reducer costs 0.1 µs and parsing costs 0.5 µs. We did not write a whole reducer Client. At that cost a year of one Network replays in about a second, against about two minutes on XState.

## State as plain data

A live XState snapshot is not plain data. It holds `machine`, a `StateMachine` instance, `_nodes`, the `StateNode` instances, and the methods `matches`, `hasTag`, `can`, `getMeta`, and `toJSON`. A test proves this.

So the Client's State holds `getPersistedSnapshot` output, which is `{ status, value, historyValue, context, children }`. That is plain data as long as `context` is, and ours holds only strings, numbers, Maps, and Sets. Each step must then call `resolveState({ value, context })` before `transition`, and `getPersistedSnapshot` after it, for every machine it touches. That round trip costs 2.1 µs on Caps and about 12 µs on the Network machine. It is why the persisted Caps costs 12.7 µs against 7.9 µs live.

`resolveState` is enough only because these machines have no history states and no children. With either, the Client would need `restoreSnapshot`, which takes an actor scope and builds child actors.

## Determinism

XState's pure path reads no clock, no randomness, and no environment, with one exception:

- **Clean:** `transition` captures actions with `actionExecutor` and never calls the scheduler. `Date.now()` and `Math.random()` in `system.ts` sit in `scheduler.schedule`, which only a live actor reaches. Delayed events come back as data, and the `after` event ids are built from the delay's name and the state's id, such as `xstate.after.lag.network.Open.Keepalive.Listening`.
- **The leak:** `createInertActorScope` calls `createActor`, which takes its `sessionId` from `idCounter`, a counter in `system.ts` shared by the whole process. Our machines never persist a session id. But a child spawned without an explicit `id` gets `x:<counter>` as its id, and that id lands in the persisted snapshot. Its value then depends on how much XState ran before in the process. A test shows two identical spawns get different ids.
- **Test-only:** `xstate/graph` uses `createMockActorScope`, which takes a `sessionId` from `Math.random()` and logs with `console.log`. That is fine in tests, and must never reach `step`.

The replay test folds the first 3,059 inputs of the month and pins a digest of every output, News, Inspection, and Knowledge. Each `bun run test` is a fresh process, and the digest matched on every run, on Bun and on Node 24. A second test runs 500 unrelated `initialTransition`s first, then replays, and gets the same digest.

## Timers

Delays map cleanly onto `Wake` and `Fired`:

| XState | The Client |
| --- | --- |
| `after: { lag: … }` on entry, or `raise(e, { delay, id })` | A `raise` action with `delay` and `id`. The Client outputs `Wake{ timer, at: input.at + delay }` and keeps `{ due, event, owner }` in State. |
| Exiting a state with `after` | A `cancel` action with the same id. The Client outputs `Wake{ timer, at: null }`. |
| Re-entering (`reenter: true`) | A `cancel`, then a `raise` with the same id. The Client keeps only the last `Wake` per timer in a step, so one `Wake` remains. |
| `Fired{ timer, due }` | The Client looks the timer up. If `due` matches, it gives the stored event back to its owner. If not, it reports `Ignored` with `StaleTimer`. |
| A delay that depends on context | `delays: { backoff: ({ context }) => backoff(context.attempt) }` |

Two points were not obvious:

- **XState knows nothing about pending timers in pure mode.** `_scheduledEvents` lives on a live system, not on the snapshot. So the timer table, the stored event, and stale detection are all ours, which is as much code as a reducer's timers. What XState still gives is the automatic `cancel` on exit, which a reducer must write by hand. That is a real bug class, and the one thing here a reducer does worse.
- **Delays are relative.** A timer due at an absolute time, such as an STS expiry, needs a delay function that subtracts the event's `at`. Our events carry `at` for that reason.

Resetting the keepalive on every Line, in the idiomatic way with `reenter`, writes one `Wake` per Received Line: 202,869 `Wake` outputs in the month, more than every other output together. That is a design problem of its own, not XState's. The better shape is one timer that, when it fires, checks when we last heard something and sets itself again. It applies to reducers too.

## Actions to outputs

Each machine has one stub action, `say`, whose params are a `Said` value: `Send`, `SendSecret`, `Dial`, `Hangup`, `Report`, or `Abandon`. `transition` returns `{ type: "say", params }` as data, and the Client turns each one into an output or into News. Only two other actions ever come back, `xstate.raise` and `xstate.cancel`, and they become `Wake`. `assign` is applied inside `transition` and never returned. Nothing is executed.

Names are data, so the minification trouble ADR 0003 had is gone, and `setup()` checks every action and guard name at compile time. The stub is still needed, because `setup` types an action's params from its implementation. A machine that names a Line builds it through `outbound()` in the Client, so an unsafe Line becomes `Ignored` with `Malformed` and is never sent. News that needs a time is stamped by the Client from the input's `at`, so machines never handle time except as delays.

## Channel machines

The spike tried both ways the proposal names:

- **Spawned child actors do not work under pure `transition`.** `spawn` inside `assign` creates the child, but its entry actions run on an actor that is never started, so they are lost: a Channel's `JOIN` never comes back. `sendTo` a child comes back as an `xstate.sendTo` action for the caller to run, so the child never moves. To make it work, the Client would step each child's snapshot with `transition` and deliver `sendTo` itself, which is the keyed map with extra steps. A test shows all of this.
- **A keyed map of persisted child snapshots works.** The Client holds `channels: Map<name, Persisted<ChannelContext>>`, routes each event to a Channel by name, and steps it with `transition`. Timers are named `channel:<name>:<id>`, so a firing finds its owner.

We picked the keyed map. Under reducers it stays the same shape, only with a reducer state in place of a persisted snapshot.

## Model-based tests

`xstate/graph` is useful for Caps. Given 14 example events, `getShortestPaths` finds 58 paths in 22 ms, reaching all 8 states. `getSimplePaths` finds 513 paths, up to 14 steps long, in 0.7 s. The shortest path to Refused is:

```
init → opened → CAP LS :sasl cap-notify → CAP ACK :sasl cap-notify → 904
```

The tests replay every generated path through both Caps implementations and check that they agree on every `Said` and every final phase. They also check two invariants on every simple path: `CAP END` is sent at most once per Connection, and no `SendSecret` goes out before `sasl` is acknowledged.

There are three limits:

- **Events must be supplied, with real Lines.** The graph only knows event types, not their contents.
- **Wildcards are not expanded.** A state that listens on `irc.*` is sent `{ type: "irc.*" }` with no Line, so traversal stops there. Caps had to name `irc.CAP`, `irc.421`, and `irc.001` instead.
- **Map and Set in context need a custom `serializeState`.** The default `JSON.stringify` turns them into `{}`, so different states merge.

The useful part is generating paths through a statechart, not running it in production. A small hand-written model of Caps, or a property test over random event sequences, would give the same coverage against a reducer.

## Types and ergonomics

The good:

- `setup({ types })` types context and events, and checks every action, guard, and delay name. `irc.${string}` template-literal events work as keys, such as `"irc.433"`.
- Effect Schema types flow straight into context: `NetworkConfiguration`, branded `CredentialName`, and readonly arrays.

The awkward:

- **The typing idiom fights the lint fence.** XState asks for `types: { context: {} as X, events: {} as Y }`, which breaks `no-unsafe-type-assertion` once in every machine. The spike files carry file-level disables, which go away with the spike.
- **Guards and params do not narrow the event.** In a transition on `irc.001`, the event is still the whole union, so every guard and params function needs `"line" in event` or `event.type === …`. A reducer's `switch` narrows for free.
- **Hoisted pieces lose their types.** An `assign` or a transition object shared between states must be a named action in `setup`, or it fails to type-check with errors thirty lines long under `exactOptionalPropertyTypes`.
- **No grouping of events.** 904, 905, 906, 907, and 908 are five keys pointing at one shared transition. A reducer checks `saslFailed.has(command)`.
- **Descendants preempt ancestors.** Keepalive's `irc.*` would swallow Presence's `irc.PING`, so Keepalive had to become a parallel region. That is correct statechart semantics and needs care in a reducer too, but it is easy to miss.

## Caps, side by side

|  | XState | Reducer |
| --- | --- | --- |
| Lines of code (sharing `cap-data.ts`, 93 lines) | 286 | 197 |
| µs per step, as held in State | 12.7 | 0.10 |
| State is plain data | Only once persisted. Restored each step. | Yes, natively |
| Impossible states | Absent transitions | Absent union members: `Listing` holds no `enabled` it could misuse |
| Exhaustiveness | Unhandled events are silently dropped | `switch` over `_tag` must cover every state, or it fails to compile |
| Timers cancelled on exit | Automatic | By hand |
| Tests | The same 14-case table, and the same graph paths | The same |
| Diagram from code | Yes, with Stately's tools | No. The mermaid in the proposal is hand-kept |
| Dependency | `xstate`, 47 kB minified, 15 kB gzipped | None |

The reducer took less time to write. Its one bug, a spread that let the old `_tag` win over the new one, was caught at once by the shared tests. The XState version's bugs were type errors in hoisted pieces, and one behaviour bug: the `phaseOf` helper dropped the parent state's name.

## Recommendation

- **Use XState for none of the Client's machines.** Write Connection, Caps, Presence, Keepalive, and Channel as reducers over discriminated unions. Each takes its events and returns its next state with what it said, the shape `caps-reducer.ts` has.
- **Hold Channels as a keyed `Map` of reducer states**, routed by name, with timer ids that name their owner.
- **Keep the statecharts as the design.** The mermaid diagrams in the proposal stay the spec, and each reducer's tests walk them.
- **Get the one thing XState does better on purpose.** Make leaving a state cancel its timers in one place: each state's timers are a function of the state, and the Client compares the timers wanted before and after a step and outputs the `Wake`s for the difference. Timers are then derived, not synced.
- **Get model-based paths without XState.** A property test feeds random event sequences from a fixed generator to each reducer and checks the invariants above. Keep `xstate/graph` in mind for a machine that grows past what that covers.
- **Rework the keepalive** so a Received Line does not write a `Wake`: one timer, checked against when we last heard something.

The substrate needs no change. `Client<State>`, `Input`, `Output`, `Wake`, `Fired{ due }`, `Feature`, and `Inspection` all held: XState fitted behind them, and reducers fit behind them more easily. Two notes for whoever builds the Client:

- `Inspection.states` wants statechart names, such as `Ready.Steady`. A reducer should report the same dotted names, as the spike's `capsReducer.phase` does, so agents see one vocabulary.
- The Client's State must keep each timer's event or owner, because `Fired` carries only the timer id and `due`. The substrate already allows this, and it is worth writing down in the Client's README.

If XState v6 makes `transition` cheap, lets its snapshots be plain data, and runs spawned children in pure mode, this is worth measuring again. The benchmark is in the spike for that.
