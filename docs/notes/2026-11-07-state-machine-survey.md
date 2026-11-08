# State machine survey, 2026-11-07

A map of the state machines and timers in the code at the end of milestone 2 (`6c573a7`). It records the shape we have, as input to reformulating the architecture. It is not the shape we want.

## The one explicit machine

`packages/lifecycle/src/machine.ts`, a pure `(machine, event) => { commands, next }`.

- Phases: `idle → connecting → registering → session → closing → closed`.
- Deadlines: `registration`, `burst`, `silence`, `lag-check`, and `login`, each recorded as a `Deadline` Entry when it fires.
- Inside it, the login sequence (CONN-6): `Unasked → Waiting → Answered | TimedOut`, with a count of Lines seen.

## Implicit machines in the Standing fold

These are pure and derived from the Log, so a restart rebuilds them. All are in `packages/session/src/standing.ts` unless noted.

| Machine | States | Where its state lives |
| --- | --- | --- |
| Connection record | attempt → opened → closing (chosen or not) → closed, or killed by the next `Daemon started` | `connection`, `recent`, `attempt` |
| Gap | open → ended by the next `001` | `gap` |
| Reconnect backoff | never tried, deliberate, failing _n_, stable; a retry Change skips the wait | derived from `recent` by `nextAttempt` |
| Join, per Channel | wanted → asked _n_ → in, refused (retried, or held until reconnect), or kicked (rejoin or not, cleared by `since`) | Configuration's `since` and `rejoinOnKick`, `asked`, `joinFailures`, `kicked`, `irc.channels`; `joinPlan` rebuilds it on every call |
| Read, per Channel and kind | needed → asked _n_ → answered or failed → settled, or given up after 3; a `NAMES` debounce window | `ChannelReads`, `IrcState`'s `modesUncertain` and `membersUncertain`, `Channel.pending`; planned in `reads.ts` |
| CTCP reply | decided → sent, Dropped, or expired; per-User spacing and a Network window | `ctcp` (`ctcp.ts`) |
| Lag check | `PING` out → `PONG` → `lagMillis` | `lagChecks` |

## Implicit machines held only by the host

These are in `Ref`s, `let`s, and `Deferred`s that the Log never sees. All are in `packages/session/src` unless noted.

| Machine | States | Where |
| --- | --- | --- |
| Network host loop | disabled or missing a Credential → backoff wait → attempt → hosting → again | `network.ts`, `tryConnection` |
| Log fault | none → failing _n_ with a retry time; a second reconnect backoff with the same formula | `network.ts`, `logFault` |
| Stop | stop → after `quitWaitMillis` + 500 ms, hurry → after 500 ms more, interrupt | `network.ts`, `finish` |
| Connection stage | `Dialing → Open → Draining`, with rules for which close reason wins; runs alongside the machine's own `closing` | `connection.ts`, `Stage` and `drain` |
| Lane gate | `open → quitting → shut` | `lanes.ts`, `Gate` |
| Reported phase | machine phase, stage, gate, and the host's `stopped` and `unrecorded`, reconciled into one | `connection.ts`, `phaseOf` |
| Loose flags | `reconciling`, `seen`, `stopHandled`, `closingRecorded`, `pump`, `reader`, `unread` | `connection.ts`, `hostConnection` |
| Pump | the flood bucket, and over TLS a written Line waiting for the next write to confirm it | `lanes.ts`, `runPump` |
| Pending | `dropped`, `unrecorded`, `unwritten`, and `Hosted.unclosed`, which outlives the Connection | `pending.ts`, `connection.ts` |
| Framing | whether a Line is being cut, and the partial bytes | `receive.ts` |
| Reconciler | settle → plan → send one Line → wait for its outcome, or for a change or `lookAgainAt` | `reconcile.ts` |
| Daemon hosts | per Network: starting → running → leaving | `packages/daemon/src/daemon.ts` |
| Credential writer | waiting → settled or abandoned, plus overdue and adrift until restart | `packages/daemon/src/credentials.ts`, `owned` |
| Log reader Worker | starting → serving → busy and retried → closing → terminated | `packages/log/src/reader.ts` |

## Timers

They come in three kinds, each with its own mechanism and durability.

**Machine deadlines**, recorded as Entries and so part of the Log format:

| Timer        | Default                             |
| ------------ | ----------------------------------- |
| registration | 60 s                                |
| burst        | 10 s, ended early by `376` or `422` |
| silence      | 90 s, reset by any inbound Line     |
| lag check    | every 60 s                          |
| login wait   | 2 s                                 |

**Plan wake-ups**, worked out from Standing and slept on, never recorded:

| Timer          | Default                                                              |
| -------------- | -------------------------------------------------------------------- |
| reconnect      | 5 s doubling to 300 s, with jitter; a 300 s Session counts as stable |
| join retry     | 60 s, doubling, capped at the reconnect maximum                      |
| kick rejoin    | 10 s                                                                 |
| read retry     | 60 s, doubling, 3 asks (constants in `reads.ts`, not Tuning)         |
| `NAMES` settle | 2 s quiet, 10 s at most                                              |
| CTCP           | 10 s per User, 5 per 60 s per Network, expiry in the lane            |
| rejoin settle  | 1 s, a plain sleep when the reconciler starts                        |

**Host-only timers**, on the wall clock and invisible to the Log:

| Timer            | Default                               |
| ---------------- | ------------------------------------- |
| connect          | 15 s                                  |
| write            | 10 s                                  |
| drain            | 5 s                                   |
| quit wait        | 2 s, plus 500 ms twice                |
| API send wait    | 10 s                                  |
| Log fault        | as reconnect                          |
| flood            | a burst of 5, then 1 per 2 s          |
| Credential write | 10 s, with a 2 s probe                |
| Log reader       | 1 s budget + 1 s grace, 10 s to start |
| SQLite busy      | 50 ms                                 |

## What stands out

- **Three timer mechanisms:** recorded deadlines, plan wake-ups, and host timeouts. The planners do not use the machine's deadlines.
- **Four doubling backoffs:** reconnect, Log fault, join, and read. Each has its own state and cap.
- **A Connection's close is modelled three times:** the machine's `closing`, the host's `Draining`, and the lane gate. `phaseOf` and `drain` reconcile them.
- **Per-Channel state has no machine of its own.** Joining and reading are each spread over four to six maps and flags, and planned from scratch each time.
- **Guarantees cost code in specific places.** Defences against a clock set back (LOG-8) are in at least five places: `nextAttempt`, `attemptDue`, `sleepUntil`, the flood bucket, and `nextItem`. "No Line lost" costs the uninterruptible reader, the Pending buffers, `Hosted.unclosed`, TLS write confirmation, and the stop escalation.
- **The Log format holds the host's design:**
  - deadline names
  - the whole Tuning in every `attempt`
  - `cause` strings that decisions are made from, such as `identify`, `rejoin`, and `read`
  - Entry kinds that exist for the host, such as `Dropped`, and `closing` with `chosen`
- **Read and flood pacing are policy constants,** not properties of a model: one read in flight, the 1000-member `WHO` limit, the `NAMES` debounce, and the flood defaults. These are where ngircd's penalty shows up. Which values were tuned to it has not been traced.
