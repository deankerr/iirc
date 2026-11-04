# @iirc/lifecycle

The Network machine: one Connection's progress from dial to close, as a pure fold over events. It holds no timers and does no I/O. Its Commands are data for a host to carry out.

- **Depends on:** `@iirc/protocol`, `xstate` (v6 alpha).
- **Used by:** `@iirc/session` (the host steps it inside each commit), `@iirc/api` (`Tuning` for its Schema), `@iirc/daemon`.
- [ADR 0003](../../docs/adr/0003-machines-are-projections.md) says why it is a fold and not an actor.

## Public surface

| Export | Role |
| --- | --- |
| `start(input)` | The first snapshot |
| `step(snapshot, event)` | The next snapshot, and the `Command`s for the host to run after commit |
| `fold(events, input)` | Replays events into a snapshot, discarding Commands |
| `phase(snapshot)` | `idle`, `connecting`, `registering`, `session`, `closing`, or `closed` (OBS-4) |
| `inspect(snapshot)` | A `ConnectionView`: how far registration got, how the login stands, and whether `JOIN`s may go out |
| `deadline(snapshot)` | The soonest deadline the host must wake for, if any |
| `closeReason(snapshot)` | Why the last Connection closed |
| `NetworkEvent` | `ATTEMPT`, `OPENED`, `LINE`, `PING`, `HEARD`, `LOGIN_SENT`, `CLOSING`, `LEAVING`, `CLOSED`, `DEADLINE` |
| `Command` | `sendLine`, `sendPong`, `closeConnection`, `burstComplete`, `loginSettled` |
| `./tuning`: `Tuning`, `defaultTuning` | Every number in LIVE, CONN, and SEND, in milliseconds or Lines, with the requirements' defaults |

## Usage

Drive it from any loop. No Effect is needed.

```ts
import { inspect, phase, start, step } from "@iirc/lifecycle";
import type { NetworkEvent } from "@iirc/lifecycle";
import { defaultTuning } from "@iirc/lifecycle/tuning";

const input = {
  loginLines: 0,
  realname: "iirc",
  services: [],
  tuning: defaultTuning,
  username: "iirc",
};
let snapshot = start(input);

const events: NetworkEvent[] = [
  { type: "ATTEMPT", at: 0, nicks: ["iirc", "iirc_"], ...input },
  { type: "OPENED", at: 10 }, // Commands: NICK iirc, USER iirc 0 * iirc
  { type: "LINE", at: 20, command: "433", params: ["*", "iirc", "taken"] }, // Command: NICK iirc_
  { type: "LINE", at: 30, command: "001", params: ["iirc_", "Welcome"] },
];

for (const event of events) {
  const { commands, next } = step(snapshot, event);
  snapshot = next;
  // carry out `commands` here, after recording `event`
}

phase(snapshot); // "session"
inspect(snapshot).registration; // { _tag: "Welcomed", at: 30, nick: "iirc_" }
```

## Key ideas

- **Events in, Commands out.** The only way into the machine is an event, and in the Daemon every event comes from an Entry. So status now and state at any past sequence are the same fold.
- **No timers.** Deadlines are absolute times in context, computed from the event's own `at`. The host waits on `deadline(snapshot)` and records a Deadline Entry when it passes.
- **Each `ATTEMPT` brings its own input:** nicks, Tuning, services, and how many login Lines there are. A replay of an old Connection makes the choices it made then.
- **It knows nothing of Entries.** Mapping an Entry to an event is `toEvent` in `@iirc/session`.
- **Nobody reads its context.** Outside this package, only `phase`, `inspect`, `deadline`, and `closeReason` look inside.

## Who decides what

| Behaviour | Here |
| --- | --- |
| Registration, `NICK` and `USER` (CONN-2) | Yes |
| Nick fallback through the candidates (CONN-4) | Yes, by index into the `ATTEMPT`'s list |
| Refusals (LIVE-5) | Yes, through `isRefusal`, recorded on `closeConnection` |
| `PONG` (LIVE-1), lag `PING` (LIVE-3), silence (LIVE-2) | Yes |
| The burst (CONN-7) and the login wait (CONN-6) | Yes |
| `QUIT` on a chosen close (LIVE-9) | Yes |
| Reconnect backoff (LIVE-4), rejoining (LIVE-7) | No: pure functions of `Standing` in `@iirc/session` |
| Enabled or disabled | No: a host setting |

## Traps

- **Action names must survive minification.** An effect's `.type` is its function's `name`, so each action is an inline function under its own key in `setup`. `commandsOf` throws on an action it cannot read rather than lose it. `lifecycle.minify.test.ts` builds a minified bundle to prove it.
- **`after` and `enq.emit` are not used.** Cost per step grew from about 150 µs to over 1 ms within thousands of steps.
- **`createEffectActor` cannot step inside a transaction,** because its `send` only queues. `transition` is synchronous, so it can.
- **XState v6 is alpha.** `lifecycle.soak.test.ts` steps the machine 220,000 times and fails if the cost per step grows. Run it, and the minify test, on every alpha bump.
- This package cannot be published until XState v6 is stable.

## Requirements

[Connecting](../../docs/requirements.md#connecting) and [Staying connected](../../docs/requirements.md#staying-connected), with OBS-4 from [Observability](../../docs/requirements.md#observability). `Tuning` holds the defaults for [Sending](../../docs/requirements.md#sending) too.
