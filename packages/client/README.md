# @iirc/client

The pure IRC client for one Network. It does no I/O and reads no clock. Every input carries its time, and every effect leaves as an output, so the same inputs always give the same states and outputs.

The Client is `client`, exported from `@iirc/client`. Its machines are reducers: the Network and its Connection, cap negotiation, Presence, the keepalive, and a keyed `Map` of Channels.

## Callers

| Caller | Uses | Imports |
| --- | --- | --- |
| The Runtime | `client.step` for each input, then carries out the outputs and journals both | `@iirc/client` |
| Views | `known` for what is known, `channel` for one Channel alone, and News for Timelines | `@iirc/client/known`, and News from `@iirc/client` |
| Scenario tests | inputs in, outputs and News out, with a fake clock | `@iirc/client/testing` |
| Agents and debugging | `inspect` for machine states, caps, Features, and timers | `@iirc/client` |

```ts
interface Client<State> {
  readonly initial: State;
  readonly step: (state: State, input: Input) => Step<State>; // { state, outputs, news }
  readonly known: (state: State) => Knowledge;
  readonly channel: (state: State, name: string) => ChannelView | undefined;
  readonly inspect: (state: State) => Inspection;
}
```

`State` is opaque. It is plain data, and is rebuilt by replaying the Journal.

### What the caller must do

- Journal each input before stepping it. Step inputs one at a time, in Journal order.
- Journal each step's outputs with its input, then carry them out in order.
- On restart, fold the Journal from `initial`, folding the timer table with `timers` as it goes, then set those timers and step a `Started`.
- Send `Configured` first. Until then, every other input but a `Look` is ignored.

## Inputs

Each input carries `at`, the instant it happened as the Runtime saw it.

| Input | From | Meaning |
| --- | --- | --- |
| `Started` | Runtime | The Runtime has started. A Connection the Client believed open is over. |
| `Configured` | Owner | The Network's whole Configuration. Joining, parting, and quitting are changes to it. |
| `Say` | Owner | Say something to a Target, with an intent id from the Runtime. |
| `Act` | Owner | Act on the Network, with an intent id: set a topic, kick, change modes, invite, change Self's nick, be away or back, or send a Line written as text. |
| `Look` | Owner | Look something up, with an intent id: `Whois { nick }` or `Whowas { nick }`. |
| `Retry` | Owner | Try connecting now, cutting a wait short. |
| `Read` | Owner | The Owner has read a Timeline up to an instant: a Target's, or the Network's own. |
| `Opened`, `Received`, `Closed` | Transport | A Connection opened, one Line's bytes arrived, or a Connection is over, and how. |
| `Fired` | Clock | A timer the Client set is due. It consumes the timer. |
| `Unfilled` | Runtime | A `SendSecret` could not be filled, so nothing was sent. |
| `Unsent` | Runtime | Lines that never left, because their Connection ended first. |
| `Stopping` | Runtime | The Runtime is shutting down. |

### Configuration

`NetworkConfiguration` is the Schema of what `Configured` carries. It is also exported alone from `@iirc/client/configuration`, as pure data a Frontend may import.

- **A Frontend derives every option from the Schema alone**. Each field has a description and says what a new Network starts with, and each Credential field is marked as one. A field added here is an option there with no other work.
- **A field added later decodes old Journals as its default,** so a Journal written before it still replays.

### When the Client dials

- A `Configured` or `Started` with the Network enabled dials at once. There is no backoff before a first dial.
- After a `Closed` it waits on the backoff, then dials the next Ircd in `ircds`, round and round. `Retry` cuts the wait short.
- Disabling the Network sends `QUIT`, hangs up, and waits for the `Closed`.
- A `Stopping` does the same, and then nothing is dialled and every `Say` is refused until the next `Started`.
- While an STS policy holds for a host, the dial is TLS on the policy's port, whatever Configuration says.

## Outputs

| Output | Meaning |
| --- | --- |
| `Dial` | Open a Connection to an Ircd, numbered by the Client from 1, never reused. |
| `Send` | Send an `OutboundLine`. It counts as sent unless an `Unsent` says otherwise. Every Line of a `Say` or an `Act` carries its intent. |
| `SendSecret` | Send a `SecretLine`. The Runtime fills in the Credential with `fillSecret` from `@iirc/protocol`. |
| `Hangup` | End a Connection. The Client still waits for its `Closed`. |
| `Wake` | Set a one-shot timer to an instant, or cancel it with `null`. The same id replaces the earlier one. |

The State holds no timer table. Each machine's state names the instants it waits for, and the table is derived from them. `timers(table, input, outputs)` folds one step of it, which the Runtime uses while replaying.

| Timer | Set while | When it fires |
| --- | --- | --- |
| `redial` | waiting after a `Closed` | dials the next Ircd |
| `register` | registering, 60 s from `Opened` | hangs up |
| `hold` | a Feature holds registration, 30 s | asks each holding Feature whether to go on |
| `keepalive` | in a Session | a `PING` after 60 s of silence, a hang-up after 90 s |
| `rejoin <channel>` | a Channel is refused or kicked | joins it again |
| `lookup <intent>` | a Lookup awaits its reply, 30 s | reports what it has |

## News

News is what happened in one step, in order. It is derived, so replaying the Journal makes it again, and it is never journaled.

| News | Meaning |
| --- | --- |
| `Message` | Something said, with its time, id, whether it is `live`, a `highlight`, or Self's, and `where` it belongs. One we said carries `ours`: its intent, and whether the Ircd will echo it. |
| `Confirmed` | The Ircd echoed back the Message for an intent, with its own time, id, and final text. |
| `Activity` | Something that changed, with its time, id, whether it is `live`, and `where` it belongs. |
| `SessionBegan`, `SessionEnded` | A Session's start and end, and why it ended. |
| `ConnectionFailed` | A Connection that ended before registration: why, the Ircd dialled, and whether it had opened. |
| `Refolded` | An Ircd declared another casemapping, so keys in `where` fold by it from here on. |
| `ReadMarker` | The Owner's Read Marker of a Timeline moved forward. |
| `Refused` | A `Say` or an `Act` that was not carried out: `Offline`, `Unsendable`, `Rejected` by the Ircd with its numeric or code, or `Unsent`. |
| `LookedUp` | A Lookup is over, with its result. Exactly one comes for each `Look`. |
| `Ignored` | An input that changed nothing, and why. |

`@iirc/timelines` folds News into Timelines by these rules:

- **Our own Messages appear when we send them.** With `ours.echo`, a `Confirmed` follows when the Ircd echoes it, and the echo is not a second Message. With no echo it stays unconfirmed. If its Line never left, a `Refused` `Unsent` follows.
- **Order by time.** History arrives late, with `live` false. A Timeline orders by `at`.
- **One per id.** A Message can arrive live and again from history.
- **Self's own count as nothing unread.** A Message is `self` when Self said it, from here or from another IRC client, and is never a `highlight`.

### Where News belongs

Each Message and Activity carries `where`: the Timelines it touches, never none. The Client works it out from what it knows as the step begins, so a projection folds News without knowing the casemapping, Self's nick, or who shares which Channel.

| `where` | The Timeline |
| --- | --- |
| `Network` | The Network's own. |
| `Channel { key, name }` | A Channel's. |
| `Direct { key, name, existing }` | A Direct Message partner's. With `existing`, it touches only a Timeline that already exists. |
| `DirectRenamed { key, name, to }` | A partner changed nick: the existing Timeline takes the item and is keyed and named by `to` from then on. |

Every rule is decided from commands, parameters, `CHANTYPES`, `PREFIX`, and `STATUSMSG`, never from text. Names are read by one parser, in `src/names.ts`, whichever way a Line goes.

- **A Channel's name** starts with a character of `CHANTYPES`. **A nick** holds no space, `,`, `*`, `?`, `!`, or `@`, and does not start with `$`, `:`, a `CHANTYPES` character, or a membership prefix. `fixtures/nicks` holds these rules as data, which the web frontend's tests run too.
- **A Message to a Channel** belongs to the Channel, after any `STATUSMSG` prefixes, so `@#iirc` belongs to `#iirc`.
- **A Direct Message** belongs to the other participant, whichever way it went.
- **Any other Message** belongs to the Network: one from a server, to a mask, or to someone other than Self.
- **`Joined`, `Parted`, `Kicked`, `TopicChanged`, and a Channel's `ModeChanged`** belong to their Channel.
- **Another User's `Quit` or `NickChanged`** belongs to every Channel they shared with Self, and to their Direct Messages if those exist. A live rename moves the Direct Message Timeline. One from history renames nothing, since the old nick may be someone else's by now.
- **Self's `NickChanged`, `Quit`, and `AwayChanged`** belong to the Network, the first two to every Channel Self is in as well.
- **A list of Targets is never one Timeline.** Each item is placed by itself, and a `Say` to a list is `Unsendable`.
- **History is placed as the present is,** by what is known as it arrives.

Keys fold by the casemapping the Network last declared, on any Connection, and `rfc1459` until one has. So a Timeline keeps its key across Connections. When an Ircd declares another, a `Refolded` reports it before any News keyed by it, and a projection folds its Timelines' names again.

A `Refused` for an `Act` names no Message, so it carries `action`: what was tried and the one Timeline it belongs to.

- **What was tried is the action's kind and the names the Owner gave it.** No topic, reason, away message, or mode parameter is in it, so a Channel key given with `+k` never is.
- **It belongs to the Channel the action was about,** when the Client held that Channel, and otherwise to the Network's own.

## Knowledge

`known(state)` gives Channels, members, Users, Self, and where the Session is.

- **Keys fold by the Connection's casemapping,** which starts from `rfc1459` on each Connection. When it changes, every key is folded again. `declared` gives the mapping `where` folds by, and `chantypes` the Session's `CHANTYPES`, so a Frontend compares and prefixes Channels' names as the Network does.
- **Users are those who share a Channel with Self, and Self.** What was seen of a User is forgotten once they share none.
- **Self's away status is as the Ircd confirmed it,** never as the Owner asked.
- **A Channel's `wanted` says whether the Owner wants Self in it.**

Every fact is a `Fact<T>`:

| Case      | Means                                      |
| --------- | ------------------------------------------ |
| `Known`   | True as of `at`, from a source             |
| `Partial` | A set with at least these members          |
| `Stale`   | Was true, and is no longer kept up to date |
| `Unknown` | Nothing has told us                        |

A fact's source is `ircd`, `replied`, `receipt`, or `ours`. Nothing in Knowledge names a cap or a Feature. A View learns how a fact is known, never why, so a new Feature changes which case a fact lands in and not the View's code.

`channel(state, name)` gives one Channel: its members as Users, and the Network's `PREFIX`, `CHANMODES`, and `CHANTYPES`, with the protocol's defaults until an Ircd says. It costs what the Channel holds, where `known` builds every Channel and User. A View that finds a Channel from its Timeline passes the Timeline's name, not its key, since the two may fold by different mappings early in a Connection.

## Inspection

`inspect(state)` gives what Views do not need: each machine's state, the Connection, the caps offered and enabled, ISUPPORT, the STS policies by host, the Features on, and the timer table.

| Machine | States |
| --- | --- |
| `network` | `Unconfigured`, `Idle`, `Waiting`, `Connection.Dialing`, `Connection.Open`, `Connection.Closing` |
| `caps` | `Listing`, `Requesting`, `Holding`, `Ready.Steady`, `Ready.Changing`, `None` |
| `presence` | `Registering`, `Session` |
| `keepalive` | `Listening`, `Pinged` |
| `channel <name>` | `Wanted`, `Joining`, `Joined.Syncing`, `Joined.Synced`, `Refused`, `Kicked` |

A machine that is not running is left out.

## Invariants

- **Pure.** `step` reads no clock, randomness, locale, or time zone, and does no I/O.
- **Plain data.** State holds only strings, numbers, booleans, arrays, plain objects, `Map`, and `Set`. It never holds a `HashMap` or `HashSet`, because Effect hashes by reference with `Math.random`, so their order could differ on replay.
- **Total.** `step` never throws, for any input in any state.
- **Exact replay.** Folding the Journal's inputs from `initial` gives the same states, outputs, and News.
- **Time comes from inputs.** Every `Wake` instant is computed from an input's `at`. A `Fired` from an earlier setting of a timer is stale and ignored.
- **Hardened, not tuned.** The Client accepts anything the protocol allows, from any Ircd. Ergo and ngircd show where Ircds differ and are never the cases to code for. What it cannot read is `Ignored`, never fatal.
- **Decisions come from structure.** Commands, numerics, tags, and parameters decide. An Ircd's free text never does.
- **One Connection at a time.** Once the Client has begun to hang up, it sends nothing more on that Connection.
- **Credentials appear only by name.** No input or output holds a Credential's value.
- **Never insecure under STS.** Once an Ircd has given a policy over TLS, the Client dials that host only over TLS until the policy expires, and never falls back to plaintext.
- **A required login is never skipped.** A Session begins only if the Configuration does not require a login, or a `903` arrived on this Connection. The core holds to this itself, whatever the Features do.
- **History does not change the present.** A Line that is not `live` is reported as News and changes nothing that is known now.
- **A step costs what its Line touches,** never every member of the Network. A Message costs the same in a Channel of ten as in one of 10,000. `bun run bench:scale` prints what each step costs.
- **Bounded.** Everything held from Ircd input has a bound, so a hostile Ircd can make facts unknown but cannot make the state grow without limit.

## Error modes

| Input | What happens |
| --- | --- |
| Bytes that do not parse | `Ignored` with `Unparseable`. The Connection stays up. |
| A Line whose parameters do not fit its command | `Ignored` with `Malformed`. |
| A tag value that does not parse | The fact keeps its default, such as the time of receipt. |
| Input from an old Connection, or a stale `Fired` | `Ignored` with `StaleConnection` or `StaleTimer`. |
| An input or a Line that makes no sense now, such as a second `001` | `Ignored` with `NotNow`. A Line the Client does not read is not an error. |
| An Owner intent that cannot be carried out | `Refused` with the intent id. It is not queued. |
| A `Read` whose Target names no one Timeline | `Ignored` with `NoTimeline`. |
| A Line a Feature refuses at egress | A `Say` is `Refused` with `Unsendable`. Any other is `Ignored`. Nothing is sent. |
| `Unsent` | A `Say` or an `Act` whose Line is among them is `Refused` with `Unsent`, once. |
| `Unfilled` | SASL counts it as a failed login. A Channel whose key is unfilled is refused. Registration goes on without `PASS`. |
| A Feature hook that throws | That Feature is off for the rest of the Connection, and `Ignored` with `FeatureFailed` records it. |

## The Feature seam

A Feature brings one IRCv3 cap or ISUPPORT token, or a tight group of them, to the Client. The seam is internal: Features are tested only through `step`. The types are in `src/feature.ts`, and `src/features/` holds the Features, of which `multi-prefix` and `server-time` are the shortest to read first.

- **On and off.** A Feature is on while every cap it `needs` is enabled and every token is in ISUPPORT, unless the Owner declined it.
- **Asking.** A Feature's caps are asked for together, and only when every one is offered.
- **Stages.** Ingress runs `tags`, then `batch`, then `label`, then `react`, then `meaning`. Egress runs `egress`. Within a stage, Features run in the order of the registry in `src/registry.ts`.
- **Refining, not branching.** A hook takes what the core derived and returns it refined, in the core's own vocabulary. The core never asks which Feature produced it.
- **Only `react` acts,** and only on a live Line. The other ingress hooks refine, and the core discards anything else they ask for. So nothing from history sends a Line or decides registration.
- **Effects are returned.** A hook may return its new state, Lines to send, caps to drop, and a say over registration: `Hold`, `Continue`, or `Abandon`.
- **Features set no timers.** The core keeps one deadline while any Feature holds registration, and asks each what to do when it passes.
- **Turning off marks stale the facts only that Feature kept,** such as away status without `away-notify`.
- **A hook reads a narrow, constant-time part of Knowledge,** so the Features cost a step the same however large the Network is.
- **The core places News.** No Feature works out `where`.

STS is not a Feature. Its policy outlives Connections and decides where to dial before any cap is negotiated, so the core keeps it, in `src/sts.ts`.

## Features

Each is built from the floor up: what it needs, what it changes, and its scenarios, which play strictly through `step` in `src/scenarios/`.

### The floor

These need nothing from the Ircd beyond RFC 1459 and 2812.

- **Connecting and redialling** (`connection.test.ts`). The backoff is 2 s doubling to 5 minutes, and starts again after a Session that lasted 5 minutes. It takes no randomness, since one Daemon serves one Owner and there is no herd to spread out.
- **Registration** (`registration.test.ts`). Sends `CAP LS 302`, `PASS` when configured, `NICK`, and `USER` at once. An Ircd with no cap negotiation answers `421` or goes straight to `001`. When a nick is taken, it offers the configured nicks in order, then the first with `_`, `2`, `3`, and on, within `NICKLEN`.
- **The Session and ISUPPORT** (`session.test.ts`). `001` begins a Session. ISUPPORT accumulates over every `005`, at most 256 tokens. Self's mask is never read from `001`, whose text is for people.
- **Keepalive** (`keepalive.test.ts`). Answers `PING` at once, byte for byte. After 60 s of silence it sends a `PING`, and after 90 s it hangs up.
- **Channels** (`channels.test.ts`). Each Channel the Owner wants is a machine. Wanted Channels share `JOIN` Lines as `TARGMAX` allows, and one with a key goes alone. A refused Channel, a kick, or a `PART` the Owner did not ask for is joined again on the backoff. A Channel Self was put in without asking is followed with `wanted` false and never joined again. Without `multi-prefix`, a member's prefixes are partial.
- **Messages and Activity** (`messages.test.ts`, `where.test.ts`). `PRIVMSG` and `NOTICE` are Messages, and a CTCP `ACTION` an action. Other CTCP is neither reported nor answered. `JOIN`, `PART`, `QUIT`, `NICK`, `KICK`, `TOPIC`, `MODE`, and `AWAY` are Activity. A `Say` that the Ircd would cut short relaying it is `Unsendable`, never truncated.
- **Read Markers** (`read.test.ts`). A `Read` moves one Timeline's Read Marker forward, never back, so two Frontends marking at once cannot undo each other. It needs no Session, and markers outlive Connections.
- **Highlights** (`highlight.test.ts`). A live Message from another User is a Highlight when it holds Self's nick, or one of the Configuration's `highlights`, as a whole word. Word boundaries use Unicode 17.0, pinned in `src/word-characters.ts`, so a Journal gives the same Highlights on every runtime. The search is linear in the text, however hostile.
- **What is ignored** (`ignored.test.ts`). Nothing unreadable ends the Connection.

### Acting

`acts.test.ts`. An `Act` sends what the Owner asks, built only through `@iirc/protocol`'s builders and checked first against what the Client knows of the Network. A Line that cannot be sent whole is `Unsendable`, never cut short.

- **`Topic`, `Kick`, `Invite`, and `Nick`** are checked against `TOPICLEN`, `KICKLEN`, `NICKLEN`, and `TARGMAX`.
- **`Mode`** gives each change a parameter exactly as `PREFIX` and `CHANMODES` say, and splits across Lines by `MODES`. A mode neither names is `Unsendable`.
- **`Away`** describes the Owner, so it outlives Sessions and is sent again as each begins. It is the one action that needs no Session.
- **`Raw`** sends a Line written as text. It may not be `CAP`, nor `PASS`, `AUTHENTICATE`, or `OPER`, which carry a Credential. A `JOIN` or `PART` of a Channel the Configuration wants is refused, since those are changes to the Configuration. The Client follows whatever the Ircd echoes back, as if another IRC client of the same account had sent it.
- **A refusal is tied to its action by structure.** With `labeled-response`, by label. On the floor, an error numeric is tied to the oldest Line of an action that names what the numeric names, such as `482` by its Channel.
- **Some refusals cannot be tied on the floor:** a numeric that names nothing the action named, such as `472`, and anything an Ircd says only in text.

### Lookups

`lookups.test.ts`. A `Look` asks the Network something and collects the reply, which may span many Lines, into one `LookedUp`.

- **Every `Look` gets exactly one result:** `Found`, `NotFound`, `Failed`, `Partial`, `Refused`, or `Unsent`.
- **A reply is collected by structure.** With `labeled-response`, by its label. On the floor, a numeric belongs to the oldest Lookup whose nick it names.
- **Only reply numerics are read.** A numeric the Client does not model is kept as it came, so nothing is lost. Nothing is read from free text but the one mode word of a `379`.
- **Bounded.** At most 8 await their replies on a Connection, at most 64 Lines of one are kept, and one with no end within 30 s reports what it has.
- **A `WHOIS` refreshes only what the Client already models,** and never undoes something said since. The Client never sends a Lookup itself, so nothing is polled.

### With caps

| Feature | Needs | Changes | Scenarios |
| --- | --- | --- | --- |
| Cap negotiation | caps from the Ircd | Asks for each Feature's caps, whole or not at all. Only what the Ircd acknowledges is enabled. `CAP NEW` and `CAP DEL` are followed for the rest of the Connection. | `caps.test.ts` |
| SASL | `sasl`, and a login in the Configuration | Logs in with `PLAIN`, holding registration until `903`. A failed login goes on when it is optional, and gives up the Connection with `LoginFailed` when it is required. | `sasl.test.ts`, `login.test.ts` |
| Message tags | `message-tags` | A Line's `msgid` is its Message's id. Client-only tags are reported with the Message. | `tags.test.ts` |
| Server time | `server-time` | A Line's `time` tag is when it happened. Without it, or when malformed, the time is when the Line arrived. | `tags.test.ts` |
| Batches | `batch` | Tracks open batches, nested or interleaved. Lines are read as they arrive, never held back. | `batch.test.ts` |
| Echoes | `echo-message`, `labeled-response`, and `batch`, only together | Each `Say` is labelled, and its echo is `Confirmed`. An error in its answer is `Rejected`. | `echo.test.ts` |
| Member prefixes | `multi-prefix` | A `NAMES` listing shows every prefix, so a member's prefixes are known, not partial. | `prefixes.test.ts` |
| Away status | `away-notify` | Away status is kept up to date, and goes stale when the cap is deleted. | `away.test.ts` |
| UTF-8 only | the ISUPPORT token `UTF8ONLY` | Bytes are read as UTF-8 with no fallback, and nothing leaves that is not UTF-8. | `utf8.test.ts` |

`seam.test.ts` drives each stage of the seam with Features of its own, and `laws.test.ts` runs the four laws over every Feature in the registry.

### Strict Transport Security

`sts.test.ts`. It needs the `sts` cap's value, which the core reads from every `CAP LS` and `CAP NEW`. The core never asks for the cap, since the spec forbids it.

- **Learning.** Over TLS, a `duration` stores a policy for the Connection's host, on this Connection's port. `duration=0` removes it.
- **Upgrading.** Over plaintext, a `port` ends the Connection and dials the same host over TLS on that port at once. If that TLS fails, it is never retried in plaintext.
- **Dialling.** While a policy holds for a host, every dial to it is TLS on the policy's port.
- **Hosts.** Policies are keyed by DNS name. An IP literal never gets one, since TLS sends no name for it.
- **Derived.** Policies come from journaled Lines, so replay rebuilds them across a restart. Only hosts in the Owner's `ircds` can have one.

### Recorded Ircds

The fixtures in `fixtures/transcripts` are real Sessions on Ergo and ngircd, and replay through the Client with nothing `Ignored`.

## The test kit

`@iirc/client/testing` holds the transcript test kit. A scenario is a transcript of IRC that `play` runs through a Client on a fake clock, failing with a transcript diff. After each, the kit replays the inputs and checks the invariants "Plain data" and "Exact replay". It also holds `scripted(script)`, a stand-in Client for testing the Runtime. Production code may not import it.
