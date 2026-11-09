# @iirc/client

The pure IRC client for one Network. It does no I/O and reads no clock. Every input carries its time, and every effect leaves as an output, so the same inputs always give the same states and outputs.

This README is the module's written interface. The types are in `src/`, and [the design note](../../docs/notes/2026-11-08-client-interface.md) says why it has this shape. There is no Client behind the interface yet. The XState spike decides its insides.

## Callers

| Caller | Uses | Imports |
| --- | --- | --- |
| The Runtime | `step` for each input, then carries out the outputs and journals both | `@iirc/client` |
| Views | `known` for what is known, and News for Timelines | `@iirc/client/known`, and News from `@iirc/client` |
| Scenario tests | inputs in, outputs and News out, with a fake clock | `@iirc/client/testing` |
| Agents and debugging | `inspect` for machine states, caps, Features, and timers | `@iirc/client` |

```ts
interface Client<State> {
  readonly initial: State;
  readonly step: (state: State, input: Input) => Step<State>; // { state, outputs, news }
  readonly known: (state: State) => Knowledge;
  readonly inspect: (state: State) => Inspection;
}
```

`State` is opaque. It must be serialisable, or rebuilt by replaying the Journal.

## Inputs

Each input carries `at`, the instant it happened as the Runtime saw it.

| Input | From | Meaning |
| --- | --- | --- |
| `Started` | Runtime | The Runtime has started. A Connection the Client believed open is over. |
| `Configured` | Owner | The Network's whole Configuration. Joining, parting, and quitting are changes to it. |
| `Say` | Owner | Say something to a Target, with an intent id from the Runtime. |
| `Retry` | Owner | Try connecting now, cutting a wait short. |
| `Opened` | Transport | A Connection the Client dialled is open. |
| `Received` | Transport | One Line's bytes, without its line ending. |
| `Closed` | Transport | A Connection is over, and how. |
| `Fired` | Clock | A timer the Client set is due, with the instant its `Wake` set. |
| `Unfilled` | Runtime | A `SendSecret` could not be filled, so nothing was sent: the Credential is `Missing`, or the Vault is `Unavailable`. |

## Outputs

| Output | Meaning |
| --- | --- |
| `Dial` | Open a Connection to an Ircd, numbered by the Client. While an STS policy holds for the host, the address is TLS on the policy's port, whatever Configuration says. |
| `Send` | Send an `OutboundLine`. It counts as sent once it is output. |
| `SendSecret` | Send a `SecretLine`. The Runtime fills in the Credential with `fillSecret` from `@iirc/protocol`. |
| `Hangup` | End a Connection. The Client still waits for its `Closed`. |
| `Wake` | Set a timer to an instant, or cancel it with `null`. The same id replaces the earlier one. |

The timer table is a projection of outputs: `timers(table, outputs)` keeps the last `Wake` for each id. The Runtime folds it while replaying, then sets every timer in it.

## News

News is what happened in one step, in order. It is derived, so replaying the Journal makes it again, and it is never journaled.

| News | Meaning |
| --- | --- |
| `Message` | Something said, with its time, id, client-only tags, and whether it is `live`. One we said carries `ours`: its intent id, and whether the Ircd will echo it. |
| `Confirmed` | The Ircd echoed back the Message for an intent, with its own time, id, and final text. |
| `Activity` | Something that changed, with its time, id, and whether it is `live`. |
| `SessionBegan`, `SessionEnded` | A Session's start and end, and why it ended. |
| `ConnectionFailed` | A Connection that ended before registration, and why. |
| `Refused` | An Owner intent that was not carried out, with its intent id: `Offline`, `Unsendable`, or `Rejected` by the Ircd's reply. |
| `Ignored` | An input that changed nothing, and why. |

Three rules for Timelines:

- **Our own Messages.** A Message we say appears as News when we send it. If `ours.echo` is set, a `Confirmed` for its intent follows when the Ircd echoes it, and the echo is not a second Message. With no echo, it stays unconfirmed: sent, with delivery unknown.
- **Order by time.** History arrives late, with `live` false. A Timeline orders by `at`, not by when the News came.
- **One per id.** A Message can arrive live and again from history. A Timeline keeps one per id. One with an unknown id is kept as it came.

## Knowledge

`known(state)` gives Channels, members, Users, Self, and where the Session is. Every fact is a `Fact<T>`:

| Case      | Means                                                        |
| --------- | ------------------------------------------------------------ |
| `Known`   | True as of `at`, from a source                               |
| `Partial` | A set with at least these members. Only sets can be partial. |
| `Stale`   | Was true, and is no longer kept up to date                   |
| `Unknown` | Nothing has told us                                          |

A fact's source is `ircd` (said as it happened), `replied` (said in reply to a Lookup), `receipt` (inferred from when a Line arrived), or `ours` (we said or set it). Nothing in Knowledge names a cap or a Feature. A View learns how a fact is known, never why, so a new Feature changes which case a fact lands in and not the View's code. `@iirc/client/known` imports nothing from the rest of the Client, and the lint fence holds it to that.

## Invariants

- **Pure.** `step` reads no clock and no randomness, and does no I/O. The lint fence keeps Bun, Node, and adapters out of `src/`, and allows only Effect's pure data modules and Schema, from an allowlist. `DateTime` is not among them, because its zoned constructors default to the machine's time zone.
- **Total.** `step` never throws, for any input in any state.
- **Exact replay.** Folding the Journal's inputs from `initial` gives the same states, outputs, and News. The Client never reads its outputs back.
- **Time comes from inputs.** Every `Wake` instant is computed from the `at` of the input being stepped. A `Fired` carries the `due` instant its `Wake` set, so a firing from an earlier setting of a timer that was reset or cancelled since is stale and ignored. The Runtime gives `due` back unchanged.
- **One Connection at a time.** The Client dials only after the previous Connection's `Closed`, or after `Started`.
- **Credentials appear only by name.** No input or output holds a Credential's value.
- **Never insecure under STS.** Once an Ircd has given a policy over TLS, the Client dials that host only over TLS until the policy expires, and never falls back to plaintext.
  - A policy is learnt only over TLS, from `duration`, on the port of the Connection it arrived on. A `port` key sent over TLS is ignored.
  - `duration=0` removes the policy at once. When a Connection closes, the expiry moves to the close plus the last `duration`.
  - It survives restarts because it is derived from journaled Lines, and is never ended by `CAP DEL`.
  - Over plaintext, only `port` counts: it ends the Connection with `Upgrading` and dials TLS on that port at once. A `duration` sent over plaintext is ignored.
- **Decisions come from structure.** Commands, numerics, tags, and parameters decide behaviour. An Ircd's free text never does, and it may appear in News only as data.
- **Bounded.** Everything the Client holds from Ircd input has a bound. A hostile Ircd can make facts unknown, but it cannot make the state grow without limit.

## What the caller must do

- Journal each input before stepping it. Step inputs one at a time, in Journal order.
- Journal each step's outputs with its input, then carry them out in order.
- On restart, fold the Journal from `initial`, keeping only the timer table from the outputs, then set those timers and step a `Started`.
- Send `Configured` first. Until then, every other input is ignored.

## Error modes

| Input | What happens |
| --- | --- |
| Bytes that do not parse | `Ignored` with `Unparseable`. The bytes stay in the Journal, and the Connection stays up. |
| A Line whose parameters do not fit its command | `Ignored` with `Malformed`. |
| A tag value that does not parse, such as `time=yesterday` | The fact keeps its default, such as the time of receipt. |
| Input from an old Connection | `Ignored` with `StaleConnection`. |
| `Fired` for a timer that was reset or cancelled | `Ignored` with `StaleTimer`. |
| An input that makes no sense now, such as `Opened` twice | `Ignored` with `NotNow`. |
| An Owner intent that cannot be carried out, such as `Say` while offline | `Refused` with the intent id. It is not queued. |
| `Unfilled` | SASL sends `AUTHENTICATE *` and counts as a failed login, so a required login abandons the Connection. A Channel whose key is unfilled is `Refused` until the next Session or a change of Configuration. Registration goes on without `PASS`, and the Ircd decides. |
| A Feature hook that throws | That Feature is off for the rest of the Connection, and `Ignored` with `FeatureFailed` records it. |

## The Feature seam

A Feature brings one IRCv3 cap or ISUPPORT token, or a tight group of them, to the Client. The seam is internal: it is not exported, and Features are tested only through `step`. The types are in `src/feature.ts`.

- **On and off.** A Feature is on while every cap in `needs` is enabled and every token is in ISUPPORT, unless the Owner declined it. The core works this out again on `CAP ACK`, `CAP NEW`, `CAP DEL`, ISUPPORT, and at the end of a Session.
- **Order.** Ingress runs `tags`, then `batch`, then `label`, then `meaning`. Egress runs `egress`. Within a stage, Features run in the order of one registry array in one file.
- **Refining, not branching.** A hook takes what the core derived and returns it refined, in the core's own vocabulary. The model reads the result and never asks which Feature produced it.
- **Effects.** A hook returns `{ value }`, with optional effects: its new `own` state, Lines to `send`, and a say over `registration`: `Hold` it open before `CAP END`, as SASL does, then `Continue`, or `Abandon` it with a reason, which ends the Connection.
- **Turning off.** When a Feature turns off, the core marks the facts it `keeps` stale. No Feature handles `CAP DEL` itself, and nothing is polled.
- **Deadlines.** Features set no timers. While any Feature holds registration, the core keeps one deadline, and when it passes it calls each holding Feature's `expired` hook to choose `Continue` or `Abandon`. SASL uses this to go on without login when login is optional, and to give up when it is required.
- **Encoding.** A Feature can say how bytes become text while it is on, as `UTF8ONLY` does.

- **Answers and history.** `label` can tie an Arrival to the intent it `answers`, and `batch` can mark it as not `live`. The core then confirms or rejects that intent, or treats the Line as history.

STS is not a Feature. Its policy outlives Connections and decides where to dial before any cap is negotiated, so the core keeps it. With no `sts` cap, nothing changes, so the floor does not depend on it.

Three Features, to show the shape:

```ts
// The floor shows only a member's highest prefix, so the core reads a NAMES listing
// as partial. With multi-prefix, every prefix is shown, so the listing is complete.
export const multiPrefix: Feature = {
  name: FeatureName.make("multi-prefix"),
  needs: { caps: [CapName.make("multi-prefix")] },
  own: undefined,
  meaning: (meant) => ({
    value: meant.map((m) =>
      m._tag === "Listed"
        ? {
            ...m,
            members: m.members.map((member) => ({
              ...member,
              prefixes: complete(member.prefixes),
            })),
          }
        : m
    ),
  }),
};

// A Message's time comes from the Ircd, not from when it arrived. A malformed time
// leaves the time of receipt in place.
export const serverTime: Feature = {
  name: FeatureName.make("server-time"),
  needs: { caps: [CapName.make("server-time")] },
  own: undefined,
  tags: (arrival) => {
    const time = parseTime(arrival.line.tags.get("time"));
    return {
      value:
        time === undefined
          ? arrival
          : { ...arrival, time: { _tag: "Known", value: time, from: "ircd", at: time } },
    };
  },
};

// The core already reads AWAY Lines. What this Feature changes is that away status is
// kept up to date, so when the cap is deleted, every away fact goes stale.
export const awayNotify: Feature = {
  name: FeatureName.make("away-notify"),
  needs: { caps: [CapName.make("away-notify")] },
  keeps: ["user.away"],
  own: undefined,
};
```

## The test kit

`@iirc/client/testing` holds `scripted(script)`, a Client that answers each expected input with set outputs and ignores anything else. It is for testing the Runtime without a real Client. The transcript test kit described in [the design note](../../docs/notes/2026-11-08-client-interface.md#the-transcript-test-kit) is built with the Client. Production code may not import `@iirc/client/testing`.
