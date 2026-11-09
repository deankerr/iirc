# @iirc/client

The pure IRC client for one Network. It does no I/O and reads no clock. Every input carries its time, and every effect leaves as an output, so the same inputs always give the same states and outputs.

This README is the module's written interface. The types are in `src/`, and [the design note](../../docs/notes/2026-11-08-client-interface.md) says why it has this shape. The Client is `client`, exported from `@iirc/client`. Its machines are reducers ([ADR 0009](../../docs/adr/0009-client-machines-are-reducers.md)): the Network and its Connection, cap negotiation, Presence, the keepalive, and a keyed `Map` of Channels, as the statecharts in [the architecture proposal](../../docs/notes/2026-11-07-architecture-proposal.md) §3 draw them. [Features](#features) lists what it does, from the floor up.

## Callers

| Caller | Uses | Imports |
| --- | --- | --- |
| The Runtime | `client.step` for each input, then carries out the outputs and journals both | `@iirc/client` |
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
| `Fired` | Clock | A timer the Client set is due, with the instant its `Wake` set. It consumes the timer. |
| `Unfilled` | Runtime | A `SendSecret` could not be filled, so nothing was sent: the Credential is `Missing`, the Vault is `Unavailable`, or the value is `Unsendable` in that Line, such as a password with a line break. |

When the Client dials:

- A `Configured` or `Started` with the Network enabled dials at once, if no Connection is open and none is waiting to be redialled. There is no backoff before a first dial.
- Backoff applies only to redialling after a `Closed`. A `Configured` while waiting keeps waiting, and `Retry` cuts the wait short.
- A `Configured` that disables the Network while a Connection is open sends `QUIT` if registration has begun, hangs up, and the Client waits for its `Closed`. Enabled again before that `Closed`, it dials as soon as the `Closed` arrives.
- A `Started` ends the Connection the Client believed open, with `Restarted`, and dials at once.
- Each dial takes the next Ircd in `ircds`, round and round.

## Outputs

| Output | Meaning |
| --- | --- |
| `Dial` | Open a Connection to an Ircd, numbered by the Client. While an STS policy holds for the host, the address is TLS on the policy's port, whatever Configuration says. |
| `Send` | Send an `OutboundLine`. It counts as sent once it is output. |
| `SendSecret` | Send a `SecretLine`. The Runtime fills in the Credential with `fillSecret` from `@iirc/protocol`. |
| `Hangup` | End a Connection. The Client still waits for its `Closed`. |
| `Wake` | Set a timer to an instant, or cancel it with `null`. The same id replaces the earlier one. |

Connection ids start at 1 and go up by 1 for each `Dial`. They are never reused, and replaying the Journal rebuilds them.

Timers are one-shot. The timer table is a projection of the Journal's inputs and outputs: `timers(table, input, outputs)` folds one step. A `Fired` whose `due` matches the table consumes its timer, and then the last `Wake` for each id sets it, so the Client re-arms a timer with a fresh `Wake` if it wants it again. A stale `Fired` changes nothing. The Runtime folds it over every step while replaying, then sets every timer in it.

The Client's timers, by id:

| Timer | Set while | When it fires |
| --- | --- | --- |
| `redial` | waiting after a `Closed` | dials the next Ircd |
| `register` | registering, 60 s from `Opened` | hangs up: the Connection ends `Silent` |
| `hold` | a Feature holds registration, 30 s from when it began | asks each holding Feature's `expired` |
| `keepalive` | in a Session | a lag `PING` after 60 s with nothing heard, and a hang-up after 90 s |
| `rejoin <channel>` | a Channel is refused or kicked, with its folded name | joins it again |

The State holds no timer table. Each machine's state names the instants it waits for, the table is derived from them, and `inspect` shows it.

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

`known(state)` gives Channels, members, Users, Self, and where the Session is. Channels and Users are keyed by name folded with the casemapping in force, named as `@iirc/protocol/casemapping` names it: `ascii`, `rfc1459`, `rfc1459-strict`, or `rfc8265`. Until the Ircd says, it is `rfc1459`, and a mapping the Client does not know folds as `ascii`. Each Connection starts from `rfc1459`, whatever the last Ircd said. When the casemapping changes, every key is folded again, and the Channels are reconciled with the Configuration: a wanted Channel the new mapping tells apart from another gets its own machine, and of Channels it merges, the first is kept. Users are those who share a Channel with Self, and Self: what was seen of a User is forgotten once they share none. A Channel's `wanted` says whether the Owner wants Self in it, which is false for one Self was put in without asking. Every fact is a `Fact<T>`:

| Case      | Means                                                        |
| --------- | ------------------------------------------------------------ |
| `Known`   | True as of `at`, from a source                               |
| `Partial` | A set with at least these members. Only sets can be partial. |
| `Stale`   | Was true, and is no longer kept up to date                   |
| `Unknown` | Nothing has told us                                          |

A fact's source is `ircd` (said as it happened), `replied` (said in reply to a Lookup), `receipt` (inferred from when a Line arrived), or `ours` (we said or set it). Nothing in Knowledge names a cap or a Feature. A View learns how a fact is known, never why, so a new Feature changes which case a fact lands in and not the View's code. `@iirc/client/known` imports nothing from the rest of the Client, and the lint fence holds it to that.

## Inspection

`inspect(state)` gives what Views do not need: each machine's state, the Connection, the caps offered and enabled, ISUPPORT, the Features on, and the timer table. `states` names each machine's state as the statecharts do:

| Machine | States |
| --- | --- |
| `network` | `Unconfigured`, `Idle`, `Waiting`, `Connection.Dialing`, `Connection.Open`, `Connection.Closing` |
| `caps` | `Listing`, `Requesting`, `Holding`, `Ready.Steady`, `Ready.Changing`, `None` |
| `presence` | `Registering`, `Session` |
| `keepalive` | `Listening`, `Pinged` |
| `channel <name>` | `Wanted`, `Joining`, `Joined.Syncing`, `Joined.Synced`, `Refused`, `Kicked` |

A machine that is not running, such as `caps` with no Connection open, is left out.

## Invariants

- **Pure.** `step` reads no clock, randomness, locale, or time zone, and does no I/O. So it uses no `DateTime`, whose zoned constructors default to the machine's time zone, nothing locale-aware such as `localeCompare`, and no Schema that parses a date in local time, such as `Schema.DateFromString`. The lint fence catches the obvious cases, such as `Date`, `Math.random`, Effect's `Clock` and `Effect`, and Bun or Node. Review catches the rest.
- **Plain data.** State holds only strings, numbers, booleans, arrays, plain objects, `Map`, and `Set`. It never holds a function, a class instance, or a `HashMap` or `HashSet`, because Effect hashes a value by reference with `Math.random`, so their order could differ on replay. Lint cannot see this. The transcript test kit checks it after every scenario, and `replayFresh` folds again in a fresh process, so that a hash seeded in one run cannot match the next.
- **Total.** `step` never throws, for any input in any state.
- **Hardened, not tuned.** The Client accepts anything the protocol allows, from any Ircd: a reply at any point it may legally come, tags and names in any order, and optional parts present or absent, such as a trailing colon or a `time` tag. The Ircds we record, such as Ergo and ngircd, show where Ircds differ. They are examples, never the cases to code for, so an Ircd we have never seen still works. What it cannot read is `Ignored`, never fatal.
- **Exact replay.** Folding the Journal's inputs from `initial` gives the same states, outputs, and News. The Client never reads its outputs back.
- **Time comes from inputs.** Every `Wake` instant is computed from the `at` of an input: the one being stepped, or, for the keepalive, the one that last brought a Line, which is never later. A `Fired` carries the `due` instant its `Wake` set, so a firing from an earlier setting of a timer that was reset or cancelled since is stale and ignored. Timers are one-shot: once the Client has stepped a `Fired` whose `due` matches, the timer is gone, and the Client sets it again with a fresh `Wake` if it still wants it. The Runtime gives `due` back unchanged. `Fired` names only the timer, so State keeps which machine each timer belongs to and what it means. Each machine's timers are derived from its state, and a step outputs a `Wake` for each difference, so leaving a state cancels its timers ([ADR 0009](../../docs/adr/0009-client-machines-are-reducers.md)).
- **One Connection at a time.** The Client dials only when no Connection is open: after the previous Connection's `Closed`, or after `Started`, which ends any it believed open. A `Configured` or `Started` with the Network enabled dials at once, unless a redial is pending: only a redial after a `Closed` waits for backoff, a `Configured` leaves that wait as it is, and `Started` or `Retry` cuts it short. A `Configured` that disables the Network while connected hangs up. Once the Client has begun to hang up, it sends nothing more on that Connection.
- **Credentials appear only by name.** No input or output holds a Credential's value.
- **Never insecure under STS.** This is stage 3's, and is not built yet: today `Dial` uses the configured address, and `policies` is empty. Once built: once an Ircd has given a policy over TLS, the Client dials that host only over TLS until the policy expires, and never falls back to plaintext.
  - A policy is learnt only over TLS, from `duration`, on the port of the Connection it arrived on. A `port` key sent over TLS is ignored.
  - `duration=0` removes the policy at once. When a Connection closes, the expiry moves to the close plus the last `duration`.
  - It survives restarts because it is derived from journaled Lines, and is never ended by `CAP DEL`.
  - Over plaintext, only `port` counts: it ends the Connection with `Upgrading` and dials TLS on that port at once. A `duration` sent over plaintext is ignored.
- **Decisions come from structure.** Commands, numerics, tags, and parameters decide behaviour. An Ircd's free text never does, and it may appear in News only as data.
- **Bounded.** Everything the Client holds from Ircd input has a bound. A hostile Ircd can make facts unknown, but it cannot make the state grow without limit.

## What the caller must do

- Journal each input before stepping it. Step inputs one at a time, in Journal order.
- Journal each step's outputs with its input, then carry them out in order.
- On restart, fold the Journal from `initial`, keeping only the timer table, folded with `timers` from each step's input and outputs, then set those timers and step a `Started`.
- Send `Configured` first. Until then, every other input is ignored.

## Error modes

| Input | What happens |
| --- | --- |
| Bytes that do not parse | `Ignored` with `Unparseable`. The bytes stay in the Journal, and the Connection stays up. |
| A Line whose parameters do not fit its command | `Ignored` with `Malformed`. |
| A tag value that does not parse, such as `time=yesterday` | The fact keeps its default, such as the time of receipt. |
| Input from an old Connection | `Ignored` with `StaleConnection`. |
| `Fired` for a timer that was reset or cancelled | `Ignored` with `StaleTimer`. |
| An input that makes no sense now, such as `Opened` twice | `Ignored` with `NotNow`. A Line that makes no sense now, such as a `CAP ACK` when nothing was asked or a second `001`, is `NotNow` with `Received`. A Line the Client does not read, such as most numerics, is not ignored: it changes nothing, and that is no error. |
| An Owner intent that cannot be carried out, such as `Say` while offline | `Refused` with the intent id. It is not queued. |
| `Unfilled` | SASL sends `AUTHENTICATE *` and counts as a failed login, so a required login abandons the Connection. A Channel whose key is unfilled is `Refused` until the next Session or the next `Configured`. Registration goes on without `PASS`, and the Ircd decides. On the floor, with no SASL Feature, an unfilled `AuthenticatePlain` is `NotNow`. |
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

## Features

Each feature is built from the floor up ([the architecture proposal](../../docs/notes/2026-11-07-architecture-proposal.md) §10): what it needs, what it changes, and where its scenarios are. A feature exists when its scenarios pass. Every scenario plays strictly through `step`, in `src/scenarios/`.

### Connecting and redialling

- Needs: nothing. The floor.
- Changes: dials the first Ircd at once on `Configured` or `Started`. After a `Closed`, it waits on the one backoff, 2 s doubling to at most 5 minutes, then dials the next Ircd in `ircds`. A Session that lasted 5 minutes starts the backoff again from 2 s. The backoff takes no randomness: one Daemon serves one Owner, so there is no herd to spread out. `Retry` dials at once while waiting. Disabling hangs up, and enabling dials. Connection ids start at 1, and only one Connection is open at a time. `ERROR` from the Ircd is why its Session ended.
- Scenarios: `connection.test.ts`

### Registration and cap negotiation

- Needs: nothing. An Ircd with no cap negotiation answers `CAP` with `421`, or ignores it and sends `001`.
- Changes: sends `CAP LS 302`, `PASS` as a `SendSecret` when configured, `NICK`, and `USER` at once. Reads `CAP LS` over as many Lines as it takes, requests the caps of the Features in the registry less those declined, and sends `CAP END` when nothing is awaited and no Feature holds registration. On `432`, `433`, `436`, or `437` at any point before `001`, it offers the next nick: the configured nicks in order, as the Owner wrote them, then `_` added to the first, then `2`, `3`, and on, the first cut to leave room for the suffix within `NICKLEN`, or RFC 2812's 9 until the Ircd announces it. A fallback is made only if it keeps at least the first nick's leading character, and that character may start a nick. Once a suffix leaves no room, as with `NICKLEN=1` or after `i9` with `NICKLEN=2`, the Client offers no more nicks, and the registration deadline ends the Connection. A nick that cannot be sent is skipped. Registration that takes more than 60 s ends the Connection. `CAP NEW` and `CAP DEL` change the caps for the rest of the Connection.
- Scenarios: `registration.test.ts`

### The Session and ISUPPORT

- Needs: nothing.
- Changes: `001` begins a Session, and Self's nick is its first parameter. Self's mask is never read from `001`, whose text is for people. It stays unknown until a structured source gives it, which on the floor is the echo of Self's own `JOIN`, and until then a `Say` keeps the conservative allowance for the source an Ircd adds when it relays. `900` and `901` give Self's account. ISUPPORT accumulates over every `005`, a negated token is taken back, and at most 256 tokens are kept. `CASEMAPPING`, `UTF8MAPPING`, `PREFIX`, `CHANTYPES`, `CHANMODES`, and `TARGMAX` are read with `@iirc/protocol/isupport` and `@iirc/protocol/casemapping`, with the protocol's defaults until they are sent. `SessionBegan` and `SessionEnded` report it.
- Scenarios: `session.test.ts`

### Keepalive

- Needs: nothing.
- Changes: answers the Ircd's `PING` at once, before or after `001`, echoing its first parameter byte for byte through `rawParams`, so a token that is not UTF-8 comes back exactly. One timer checks when a Line was last heard: after 60 s of silence it sends `PING iirc`, and after 90 s it hangs up, and the Session ends `Silent`. A Line heard changes only State, never a `Wake`.
- Scenarios: `keepalive.test.ts`

### Channels

- Needs: nothing. Without `multi-prefix`, a member's prefixes are partial.
- Changes: each Channel the Owner wants is a machine: Wanted, Joining, Joined (Syncing, then Synced at the end of `NAMES`), Refused, and Kicked. After `001`, and whenever the Configuration wants more, every Wanted Channel without a key shares `JOIN` Lines, as many to a Line as fit and as `TARGMAX` allows. One with a key goes alone as a `JoinWithKey`. Self is in a Channel on the echo of its `JOIN`. A `NAMES` listing over any number of `353`s replaces the members at its `366`, and a `JOIN`, `PART`, `QUIT`, `KICK`, `NICK`, or membership `MODE` that arrives while it is pending changes it too, so nothing is lost when it ends. A member listed with a prefix holds at least that one, and one listed with none holds none, since the floor shows only the highest. A leading symbol `PREFIX` does not name is a prefix that cannot be named, so what is known is partial. The topic comes from `332`, `333`, and `331`, as said on joining or replied later, and a join whose replies end with no topic has none. Modes come from `324` and follow `MODE`, with list and membership modes left out and a key shown only as set. `403`, `405`, `437`, `471`, `473`, `474`, `475`, `476`, `477`, and `489` refuse a Channel Self is joining, and a kick, or a `PART` the Owner did not ask for, removes Self: each is joined again on the one backoff, which starts again once joined. A Channel no longer wanted is parted. A Session ending returns every wanted Channel to Wanted. A key that cannot be filled refuses its Channel until the next Session or `Configured`. At most 100,000 members are kept for a Channel.

  A Channel Self is put in without asking, such as by an oper's `SAJOIN` or another session of the same account, is not undone. Its `JOIN` makes a machine, Joined and not wanted, that syncs and is modelled like any other, and Knowledge shows it with `wanted` false. It is never joined again: it is forgotten when Self leaves it or the Session ends. A Configuration that names it makes it wanted, and one that does not leaves it alone. Such Channels are counted within their `CHANLIMIT` group, so `#:1,&:1` keeps one of each and `#&:2` keeps two between them. A prefix in no group, or a group with no limit, is counted the same way against 64, and past that one is reported as Activity and `Ignored` with `NotNow`, and modelled no further.

- Scenarios: `channels.test.ts`

### Messages and Activity

- Needs: nothing. Without `server-time`, a time is when the Line arrived, and says so. Without `echo-message`, our own Messages are reported when we send them, and stay unconfirmed.
- Changes: `PRIVMSG` and `NOTICE` are a `Message` with sender, Target, and kind, and a CTCP `ACTION` is an `Action`. Other CTCP is a request between IRC clients, not something said, and is neither reported nor answered. A Line with no source names the Ircd as its sender. Client-only tags are kept as data. `JOIN`, `PART`, `QUIT`, `NICK` (Self's included), `KICK`, `TOPIC`, `MODE`, and `AWAY` are Activity, and fold into what is known of Channels, members, and Users. A `Say` is sent, and reported as a `Message` that is `ours`, at the time we said it. It is `Refused` with `Offline` outside a Session or while hanging up, and `Unsendable` when no Line can carry it, or when the Ircd would cut it short relaying it with our source.
- Scenarios: `messages.test.ts`

### What is ignored

- Needs: nothing.
- Changes: bytes that do not parse are `Unparseable`. A Line the Client reads whose parameters do not fit its command is `Malformed`. A Line that makes no sense in this state is `NotNow`. None of these ends the Connection, and nothing is decided from an Ircd's text.
- Scenarios: `ignored.test.ts`, and `properties.test.ts`, which folds random and hostile input from every state and checks the Invariants after every step.

### The Feature seam

- Needs: nothing. The registry in `src/registry.ts` is empty on the floor.
- Changes: the stages run on every Line as the seam above describes, and do nothing while no Feature is on. The core reads `PRIVMSG`, `NOTICE`, `JOIN`, `PART`, `KICK`, `QUIT`, `NICK`, `MODE`, `TOPIC`, `AWAY`, and `353` as `Meant`, through `meaning`. Every Line sent, the Owner's and the protocol's, goes through `egress`. Lines a hook asks to `send` do not go through `egress` again.
- Scenarios: `seam.test.ts`, which drives each stage through `step` with Features of its own, and `laws.test.ts`, which runs the four laws over the registry.

### Recorded Ircds

- The four fixtures in `fixtures/transcripts/` replay through the Client: it registers, joins, and follows the Session. The only `Ignored` is a `CAP ACK` for what the recorder asked and the floor Client did not. `fixtures.test.ts` also folds a long scenario, with reconnects and timers, again in a fresh process.

## The test kit

`@iirc/client/testing` holds the transcript test kit, whose written interface is [its README](src/testing/README.md). A scenario is a transcript of IRC that `play` runs through a Client on a fake clock, matching every Line it sends, every `Ignored`, and each News written, and failing with a transcript diff. `replay` feeds a recorded fixture and reports what the Client did. After either, the kit replays the inputs and checks the Invariants "Plain data" and "Exact replay", and `replayFresh` checks them again in a fresh process. Preludes write registration and joins, and the four laws run over every set of caps `across` gives. It also holds `scripted(script)`, a Client that answers each expected input with set outputs and ignores anything else, for testing the Runtime without a real Client. Production code may not import `@iirc/client/testing`.
